mod db;
mod titles;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

/// Соединение с библиотекой, живущее всё время работы приложения.
///
/// Mutex здесь не про многопоточность ради многопоточности: команды Tauri
/// приходят из разных потоков, а Connection у rusqlite не Sync.
struct Library(Mutex<rusqlite::Connection>);

/// Что yt-dlp сообщил о скачанном треке.
struct Downloaded {
    video_id: String,
    raw_title: String,
    duration_secs: Option<f64>,
    file_path: String,
    cover_path: Option<String>,
}

/// Ищет исполняемый файл среди каталогов переменной PATH.
fn which_from_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Находит внешний бинарь (yt-dlp, ffmpeg) по известным путям, затем по PATH.
///
/// Порядок именно такой, потому что GUI-приложения на macOS не наследуют PATH
/// из шелла: в собранном .app поиск только по PATH молча провалится.
fn resolve_binary(name: &str) -> Result<PathBuf, String> {
    const WELL_KNOWN: [&str; 4] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

    for dir in WELL_KNOWN {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    which_from_path(name).ok_or_else(|| format!("{name} не найден. Установи его: brew install {name}"))
}

/// Возвращает каталог для скачанных треков (~/Music/Omen), создавая его при необходимости.
fn output_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("не удалось определить домашний каталог")?;
    let dir = PathBuf::from(home).join("Music").join("Omen");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("не удалось создать {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Каталог обложек внутри каталога загрузок.
fn covers_dir() -> Result<PathBuf, String> {
    let dir = output_dir()?.join("covers");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("не удалось создать {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Сторона квадратной обложки.
///
/// Превью с YouTube — 1280×720, поэтому 720 это наибольший квадрат,
/// который получается без растягивания исходника.
const COVER_SIZE: u32 = 720;

/// Делает из превью квадратную обложку и кладёт в каталог обложек.
///
/// Превью всегда 16:9, а обложка квадратная. Центральный кроп выбрасывал бы
/// 44% ширины вместе с текстом, поэтому картинка вписывается целиком, а поля
/// заполняются ею же в блюре с затемнением — тем же приёмом, что и фон
/// полноэкранного вида. Делает ffmpeg, а не отдельный крейт: он и так
/// обязателен для перекодирования.
fn make_square_cover(ffmpeg: &Path, source: &Path, video_id: &str) -> Result<String, String> {
    let target = covers_dir()?.join(format!("{video_id}.jpg"));
    let size = COVER_SIZE;

    // Фон: превью растянуто до заполнения квадрата, обрезано и размыто.
    // Передний план: то же превью, вписанное целиком. Сверху overlay.
    // Затемнения тут намеренно нет: это свойство показа, а не файла —
    // полноэкранный вид кладёт поверх фона тинт темы, там ему и место.
    let filter = format!(
        "[0:v]scale={size}:{size}:force_original_aspect_ratio=increase,\
crop={size}:{size},boxblur=24:3[bg];\
[0:v]scale={size}:{size}:force_original_aspect_ratio=decrease[fg];\
[bg][fg]overlay=(W-w)/2:(H-h)/2"
    );

    let output = Command::new(ffmpeg)
        .arg("-y")
        .args(["-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args(["-filter_complex", &filter])
        .args(["-q:v", "2"])
        .arg(&target)
        .output()
        .map_err(|e| format!("не удалось запустить ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог собрать обложку: {}", stderr.trim()));
    }

    target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "путь обложки содержит недопустимые символы".to_string())
}

/// Разбирает значение длительности от yt-dlp: число либо "NA".
fn parse_duration(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok().filter(|d| *d > 0.0)
}

/// Скачивает аудио одного видео и возвращает файл вместе с метаданными.
///
/// Битрейт задан через --audio-quality 320K, что превращается в ffmpeg-ключ
/// `-b:a 320k`, то есть в постоянный битрейт. CBR здесь не вкусовщина: в mp3
/// нет индекса, и точная перемотка возможна только когда позицию можно
/// посчитать байтовой арифметикой.
fn download_blocking(url: &str) -> Result<Downloaded, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("пустая ссылка".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("это не похоже на ссылку".into());
    }

    let ytdlp = resolve_binary("yt-dlp")?;
    let ffmpeg = resolve_binary("ffmpeg")?;
    let ffmpeg_dir = ffmpeg.parent().ok_or("не удалось определить каталог ffmpeg")?;
    let dir = output_dir()?;

    // Идентификатор видео в имени файла — ключ дедупликации из спеки.
    let template = dir.join("%(title)s [%(id)s].%(ext)s");

    let output = Command::new(&ytdlp)
        .arg("--extract-audio")
        .args(["--audio-format", "mp3"])
        .args(["--audio-quality", "320K"])
        .arg("--no-playlist")
        .arg("--write-thumbnail")
        .args(["--convert-thumbnail", "jpg"])
        .arg("--ffmpeg-location")
        .arg(ffmpeg_dir)
        .arg("--output")
        .arg(&template)
        // Четыре отдельных --print дают четыре строки в заданном порядке.
        // Один шаблон с разделителем был бы короче, но сломался бы на
        // заголовке, содержащем этот разделитель.
        .args(["--print", "after_move:id"])
        .args(["--print", "after_move:title"])
        .args(["--print", "after_move:duration"])
        .args(["--print", "after_move:filepath"])
        .arg("--no-simulate")
        .arg("--quiet")
        .arg("--no-warnings")
        .arg(url)
        .output()
        .map_err(|e| format!("не удалось запустить yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.trim();
        return Err(if reason.is_empty() {
            format!("yt-dlp завершился с кодом {}", output.status)
        } else {
            reason.to_string()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();

    // Ровно четыре строки. Иначе заголовок содержал перевод строки и
    // разбор поехал — лучше честно сказать, чем записать мусор в базу.
    let [id, title, duration, path] = lines.as_slice() else {
        return Err(format!(
            "yt-dlp вернул {} строк вместо четырёх — разбор метаданных ненадёжен",
            lines.len()
        ));
    };

    if path.trim().is_empty() {
        return Err("yt-dlp отработал, но не сообщил путь до файла".into());
    }

    let audio_path = PathBuf::from(path.trim());

    // Превью yt-dlp кладёт рядом с аудио под тем же именем.
    let thumbnail = audio_path.with_extension("jpg");
    let cover_path = if thumbnail.is_file() {
        match make_square_cover(&ffmpeg, &thumbnail, id.trim()) {
            Ok(cover) => {
                // Исходное 16:9 больше не нужно и только мусорит в папке с музыкой.
                let _ = std::fs::remove_file(&thumbnail);
                Some(cover)
            }
            // Неудача с обложкой не отменяет скачанный трек: музыка важнее картинки.
            Err(reason) => {
                eprintln!("обложка не обработана: {reason}");
                None
            }
        }
    } else {
        None
    };

    Ok(Downloaded {
        video_id: id.trim().to_string(),
        raw_title: title.trim().to_string(),
        duration_secs: parse_duration(duration),
        file_path: path.trim().to_string(),
        cover_path,
    })
}

/// Скачивает трек, чистит заголовок и заносит результат в библиотеку.
///
/// Скачивание уходит в блокирующий пул: оно идёт минутами, и держать на нём
/// поток рантайма — значит заморозить окно.
#[tauri::command]
async fn download_track(app: tauri::AppHandle, url: String) -> Result<db::Track, String> {
    let downloaded = tauri::async_runtime::spawn_blocking(move || download_blocking(&url))
        .await
        .map_err(|e| format!("задача скачивания прервалась: {e}"))??;

    let parsed = titles::parse(&downloaded.raw_title);

    let new_track = db::NewTrack {
        video_id: downloaded.video_id.clone(),
        raw_title: downloaded.raw_title,
        artist: parsed.artist,
        title: parsed.title,
        file_path: downloaded.file_path,
        cover_path: downloaded.cover_path,
        duration_secs: downloaded.duration_secs,
    };

    let state = app.state::<Library>();
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::upsert_track(&conn, &new_track)?;

    db::find_by_video_id(&conn, &downloaded.video_id)?
        .ok_or_else(|| "трек записан, но не читается обратно".into())
}

/// Перечищает названия по текущим правилам, пропуская правленные руками.
///
/// Правила чистки со временем улучшаются, а `raw_title` хранится именно ради
/// этого: исходный заголовок позволяет переразобрать трек, не скачивая заново.
fn reparse_titles(conn: &rusqlite::Connection) -> Result<usize, String> {
    let mut changed = 0;

    for track in db::all_tracks(conn)? {
        if track.edited {
            continue;
        }
        let parsed = titles::parse(&track.raw_title);
        if db::update_parsed_title(conn, track.id, parsed.artist.as_deref(), &parsed.title)? {
            changed += 1;
        }
    }

    Ok(changed)
}

/// Возвращает всю библиотеку из базы, свежие сверху.
#[tauri::command]
fn library(state: tauri::State<'_, Library>) -> Result<Vec<db::Track>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::all_tracks(&conn)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("omen.db");
            let conn = db::open(&path)?;

            // Спека: файл, удалённый мимо приложения, не должен пропадать молча.
            let changed = db::reconcile_with_disk(&conn)?;
            if changed > 0 {
                eprintln!("сверка с диском: обновлено записей — {changed}");
            }

            let reparsed = reparse_titles(&conn)?;
            if reparsed > 0 {
                eprintln!("перечистка названий: обновлено записей — {reparsed}");
            }

            app.manage(Library(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![download_track, library])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
