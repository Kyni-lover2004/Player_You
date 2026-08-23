//! Скачивание с YouTube: поиск бинарей, конвейер, фоновая очередь.
//!
//! Очередь однопоточная намеренно. Параллельные запуски yt-dlp на один и тот же
//! источник — верный способ получить ограничение по частоте запросов, а
//! выигрыш во времени на домашней коллекции незаметен.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// Сторона квадратной обложки.
///
/// Превью с YouTube — 1280×720, поэтому 720 это наибольший квадрат,
/// который получается без растягивания исходника.
const COVER_SIZE: u32 = 720;

/// Метка, которой помечены строки прогресса.
///
/// yt-dlp пишет и прогресс, и запрошенные поля в один поток, поэтому их
/// нужно как-то различать. Без метки разбор метаданных ломался бы о прогресс.
const PROGRESS_MARK: &str = "@P@";

/// Что yt-dlp сообщил о скачанном треке.
pub struct Downloaded {
    pub video_id: String,
    pub raw_title: String,
    pub duration_secs: Option<f64>,
    pub file_path: String,
    pub cover_path: Option<String>,
}

/// Стадия работы над одной ссылкой.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Waiting,
    Downloading,
    Converting,
    Done,
    Error,
}

/// Одна ссылка в очереди загрузок.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Job {
    pub id: u64,
    pub url: String,
    pub status: JobStatus,
    /// Процент скачивания, 0–100.
    pub percent: f64,
    /// Название трека, как только оно станет известно.
    pub title: Option<String>,
    /// Причина отказа, понятная человеку.
    pub error: Option<String>,
}

/// Очередь загрузок: общее состояние плюс признак работающего воркера.
pub struct Queue {
    jobs: Mutex<Vec<Job>>,
    running: AtomicBool,
    next_id: AtomicU64,
}

impl Default for Queue {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            running: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
        }
    }
}

impl Queue {
    /// Ставит ссылку в очередь и возвращает идентификатор задания.
    pub fn push(&self, url: String) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut jobs = self.jobs.lock().map_err(|_| "очередь занята")?;
        jobs.push(Job {
            id,
            url,
            status: JobStatus::Waiting,
            percent: 0.0,
            title: None,
            error: None,
        });
        Ok(id)
    }

    /// Копия очереди для показа.
    pub fn snapshot(&self) -> Vec<Job> {
        self.jobs.lock().map(|jobs| jobs.clone()).unwrap_or_default()
    }

    /// Меняет одно задание на месте.
    pub(crate) fn update(&self, id: u64, change: impl FnOnce(&mut Job)) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|job| job.id == id) {
                change(job);
            }
        }
    }

    /// Забирает следующее задание в работу.
    pub(crate) fn take_next(&self) -> Option<Job> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = jobs.iter_mut().find(|job| job.status == JobStatus::Waiting)?;
        job.status = JobStatus::Downloading;
        Some(job.clone())
    }

    /// Убирает завершённые задания из показа.
    pub fn clear_finished(&self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.retain(|job| !matches!(job.status, JobStatus::Done | JobStatus::Error));
        }
    }

    /// Пытается стать единственным воркером. Ложь означает, что кто-то уже работает.
    pub(crate) fn claim_worker(&self) -> bool {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Освобождает место воркера.
    pub(crate) fn release_worker(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
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
pub fn resolve_binary(name: &str) -> Result<PathBuf, String> {
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
pub fn output_dir() -> Result<PathBuf, String> {
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

/// Делает из превью квадратную обложку и кладёт в каталог обложек.
///
/// Превью всегда 16:9, а обложка квадратная. Центральный кроп выбрасывал бы
/// 44% ширины вместе с текстом, поэтому картинка вписывается целиком, а поля
/// заполняются ею же в блюре. Затемнения тут намеренно нет: это свойство
/// показа, а не файла — полноэкранный вид кладёт поверх свой тинт темы.
fn make_square_cover(ffmpeg: &Path, source: &Path, video_id: &str) -> Result<String, String> {
    let target = covers_dir()?.join(format!("{video_id}.jpg"));
    let size = COVER_SIZE;

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

/// Вытаскивает процент из строки прогресса вида `@P@ 42.3%`.
fn parse_percent(line: &str) -> Option<f64> {
    line.strip_prefix(PROGRESS_MARK)?
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<f64>()
        .ok()
}

/// Переводит жалобу yt-dlp в человеческую формулировку.
///
/// Сырой текст остаётся доступным, но первой строкой человек должен видеть
/// причину, а не стек чужой программы.
pub fn explain(stderr: &str) -> String {
    let lower = stderr.to_lowercase();

    let hint = if lower.contains("video unavailable") || lower.contains("video is unavailable") {
        "Видео недоступно — возможно, удалено или закрыто для твоей страны."
    } else if lower.contains("private video") {
        "Видео приватное, скачать его нельзя."
    } else if lower.contains("sign in to confirm your age") || lower.contains("age-restricted") {
        "На видео возрастное ограничение: YouTube требует вход в аккаунт."
    } else if lower.contains("sign in to confirm") || lower.contains("not a bot") {
        "YouTube требует подтверждения, что запрос не от робота."
    } else if lower.contains("is live") || lower.contains("live event will begin") {
        "Это прямой эфир — качать нечего, пока он не закончится."
    } else if lower.contains("unable to download") && lower.contains("http error 429") {
        "YouTube временно ограничил частоту запросов. Подожди и попробуй снова."
    } else if lower.contains("nsig extraction failed") || lower.contains("unable to extract") {
        "YouTube поменял формат страницы. Обнови yt-dlp: brew upgrade yt-dlp"
    } else if lower.contains("no such file") || lower.contains("not found") {
        "Не найден yt-dlp или ffmpeg."
    } else if lower.contains("network") || lower.contains("resolve host") {
        "Нет связи с YouTube — проверь интернет."
    } else {
        return stderr.trim().to_string();
    };

    format!("{hint}\n\n{}", stderr.trim())
}

/// Скачивает аудио одного видео, сообщая о прогрессе.
///
/// Битрейт задан через --audio-quality 320K, что превращается в ffmpeg-ключ
/// `-b:a 320k`, то есть в постоянный битрейт. CBR здесь не вкусовщина: в mp3
/// нет индекса, и точная перемотка возможна только когда позицию можно
/// посчитать байтовой арифметикой.
pub fn download(
    url: &str,
    mut on_progress: impl FnMut(f64),
    mut on_stage: impl FnMut(JobStatus),
) -> Result<Downloaded, String> {
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

    let mut child = Command::new(&ytdlp)
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
        .arg("--newline")
        .args(["--progress-template", &format!("{PROGRESS_MARK}%(progress._percent_str)s")])
        .arg("--no-warnings")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("не удалось запустить yt-dlp: {e}"))?;

    let stdout = child.stdout.take().ok_or("не удалось прочитать вывод yt-dlp")?;
    let mut fields: Vec<String> = Vec::new();

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(percent) = parse_percent(&line) {
            on_progress(percent);
            // Скачивание дошло до конца — дальше ffmpeg, а он молчит.
            if percent >= 99.9 {
                on_stage(JobStatus::Converting);
            }
            continue;
        }
        if !line.trim().is_empty() {
            fields.push(line.trim().to_string());
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("не удалось дождаться yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.trim();
        return Err(if reason.is_empty() {
            format!("yt-dlp завершился с кодом {}", output.status)
        } else {
            explain(reason)
        });
    }

    // Ровно четыре строки. Иначе заголовок содержал перевод строки и разбор
    // поехал — лучше честно сказать, чем записать мусор в базу.
    let [id, title, duration, path] = fields.as_slice() else {
        return Err(format!(
            "yt-dlp вернул {} полей вместо четырёх — разбор метаданных ненадёжен",
            fields.len()
        ));
    };

    if path.is_empty() {
        return Err("yt-dlp отработал, но не сообщил путь до файла".into());
    }

    let audio_path = PathBuf::from(path);

    // Превью yt-dlp кладёт рядом с аудио под тем же именем.
    let thumbnail = audio_path.with_extension("jpg");
    let cover_path = if thumbnail.is_file() {
        match make_square_cover(&ffmpeg, &thumbnail, id) {
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
        video_id: id.clone(),
        raw_title: title.clone(),
        duration_secs: parse_duration(duration),
        file_path: path.clone(),
        cover_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_parsed_from_marked_line() {
        assert_eq!(parse_percent("@P@ 42.3%"), Some(42.3));
        assert_eq!(parse_percent("@P@100.0%"), Some(100.0));
    }

    #[test]
    fn ordinary_output_is_not_mistaken_for_progress() {
        // Поля метаданных приходят в тот же поток и не должны съедаться разбором.
        assert_eq!(parse_percent("BFSpI9aJ4As"), None);
        assert_eq!(parse_percent("ROCKET − Инкассатор"), None);
        assert_eq!(parse_percent("152.17"), None);
    }

    #[test]
    fn duration_na_becomes_none() {
        assert_eq!(parse_duration("NA"), None);
        assert_eq!(parse_duration("0"), None);
        assert_eq!(parse_duration("152.17"), Some(152.17));
    }

    #[test]
    fn known_failures_get_a_human_first_line() {
        let explained = explain("ERROR: [youtube] abc: Private video. Sign in if you've been granted access");
        assert!(explained.starts_with("Видео приватное"), "получено: {explained}");
        // Сырой текст остаётся: он нужен, когда подсказка не угадала.
        assert!(explained.contains("Private video"));
    }

    #[test]
    fn unknown_failure_is_passed_through_untouched() {
        let raw = "ERROR: что-то совершенно новое";
        assert_eq!(explain(raw), raw);
    }

    #[test]
    fn stale_ytdlp_suggests_an_upgrade() {
        let explained = explain("ERROR: unable to extract player response");
        assert!(explained.contains("brew upgrade yt-dlp"));
    }
}
