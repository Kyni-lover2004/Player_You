use std::path::PathBuf;
use std::process::Command;

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

    which_from_path(name).ok_or_else(|| {
        format!("{name} не найден. Установи его: brew install {name}")
    })
}

/// Возвращает каталог для скачанных треков (~/Music/Omen), создавая его при необходимости.
fn output_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("не удалось определить домашний каталог")?;
    let dir = PathBuf::from(home).join("Music").join("Omen");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("не удалось создать {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Синхронная часть скачивания: запускает yt-dlp и возвращает путь готового mp3.
///
/// Битрейт задан через --audio-quality 320K, что превращается в ffmpeg-ключ `-b:a 320k`,
/// то есть в постоянный битрейт. CBR здесь не вкусовщина: в mp3 нет индекса, и точная
/// перемотка возможна только когда позицию можно посчитать байтовой арифметикой.
fn download_track_blocking(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("пустая ссылка".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("это не похоже на ссылку".into());
    }

    let ytdlp = resolve_binary("yt-dlp")?;
    let ffmpeg = resolve_binary("ffmpeg")?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or("не удалось определить каталог ffmpeg")?;
    let dir = output_dir()?;

    // Идентификатор видео в имени файла — будущий ключ дедупликации из спеки.
    let template = dir.join("%(title)s [%(id)s].%(ext)s");

    let output = Command::new(&ytdlp)
        .arg("--extract-audio")
        .args(["--audio-format", "mp3"])
        .args(["--audio-quality", "320K"])
        .arg("--no-playlist")
        .arg("--ffmpeg-location")
        .arg(ffmpeg_dir)
        .arg("--output")
        .arg(&template)
        // Печатает итоговый путь уже после всех перекодирований и переименований.
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

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("yt-dlp отработал, но не сообщил путь до файла".into());
    }
    Ok(path)
}

/// Скачивает аудио одного видео с YouTube в mp3 320 CBR и возвращает путь до файла.
///
/// Работа уходит в блокирующий пул: скачивание идёт минутами, и держать
/// на нём поток рантайма — значит заморозить окно.
#[tauri::command]
async fn download_track(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_track_blocking(&url))
        .await
        .map_err(|e| format!("задача скачивания прервалась: {e}"))?
}

/// Возвращает пути ко всем mp3 в каталоге загрузок, отсортированные по имени.
///
/// Срез 0c: нужен, чтобы играть уже скачанное, не качая заново.
/// Полноценная библиотека приедет на срезе 1 вместе с SQLite.
#[tauri::command]
fn list_tracks() -> Result<Vec<String>, String> {
    let dir = output_dir()?;
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("не удалось прочитать {}: {e}", dir.display()))?;

    let mut paths: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "mp3"))
        .filter_map(|path| path.to_str().map(str::to_owned))
        .collect();

    paths.sort();
    Ok(paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![download_track, list_tracks])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
