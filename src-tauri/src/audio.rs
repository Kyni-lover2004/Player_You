//! Резка треков: вырезание ненужных кусков и склейка остатка.
//!
//! Резать всегда нужно из нетронутого исходника, а не из уже порезанного
//! файла: иначе вторая правка кромсает результат первой, накапливая и потерю
//! качества, и смещение границ.

use std::path::{Path, PathBuf};

use crate::db::Cut;
use crate::downloads::{quiet_command, resolve_binary};

/// Кусок, который остаётся в треке.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Segment {
    pub start: f64,
    /// Конец куска. None означает «до конца записи».
    pub end: Option<f64>,
}

/// Вычисляет, что останется от трека после вырезок.
///
/// Ожидает вырезки уже упорядоченными и непересекающимися — этим занимается
/// `db::normalize_cuts`. Вынесено отдельной чистой функцией, потому что это
/// единственная часть резки, которую можно проверить без ffmpeg и без файлов.
pub fn kept_segments(cuts: &[Cut]) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut position = 0.0_f64;

    for cut in cuts {
        if cut.start > position {
            segments.push(Segment {
                start: position,
                end: Some(cut.start),
            });
        }
        position = position.max(cut.end);
    }

    // Хвост после последней вырезки. Границу не указываем: длительность
    // исходника тут не нужна, ffmpeg сам дойдёт до конца.
    segments.push(Segment {
        start: position,
        end: None,
    });

    segments
}

/// Собирает граф фильтров ffmpeg: нарезать куски и склеить подряд.
fn build_filter(segments: &[Segment]) -> String {
    let mut parts = Vec::new();

    for (index, segment) in segments.iter().enumerate() {
        let range = match segment.end {
            Some(end) => format!("start={:.3}:end={:.3}", segment.start, end),
            None => format!("start={:.3}", segment.start),
        };
        // asetpts выравнивает временные метки, иначе склеенные куски
        // сохранят исходные и плеер увидит рваную шкалу времени.
        parts.push(format!("[0:a]atrim={range},asetpts=N/SR/TB[s{index}]"));
    }

    let inputs: String = (0..segments.len()).map(|i| format!("[s{i}]")).collect();
    parts.push(format!("{inputs}concat=n={}:v=0:a=1[out]", segments.len()));

    parts.join(";")
}

/// Путь, по которому хранится нетронутый исходник трека.
pub fn original_path_for(file: &Path) -> PathBuf {
    let mut name = file.file_stem().unwrap_or_default().to_os_string();
    name.push(" (исходник).mp3");
    file.with_file_name(name)
}

/// Режет трек по списку вырезок и возвращает длительность результата.
///
/// Перекодирует, а не копирует поток. Копирование мгновенно и без потерь, но
/// mp3 режется только по границам кадров, и на каждом стыке слышен щелчок.
/// Вырезают обычно вставки посреди музыки, где щелчок недопустим.
pub fn apply_cuts(source: &Path, target: &Path, cuts: &[Cut]) -> Result<f64, String> {
    let ffmpeg = resolve_binary("ffmpeg")?;
    let segments = kept_segments(cuts);

    // Пишем рядом и подменяем в конце: прерванный ffmpeg не должен оставить
    // человека с половиной трека вместо трека.
    let temporary = target.with_extension("cutting.mp3");

    let output = quiet_command(&ffmpeg)
        .arg("-y")
        .args(["-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args(["-filter_complex", &build_filter(&segments)])
        .args(["-map", "[out]"])
        .args(["-b:a", "320k"])
        .arg(&temporary)
        .output()
        .map_err(|e| format!("не удалось запустить ffmpeg: {e}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог обрезать трек: {}", stderr.trim()));
    }

    std::fs::rename(&temporary, target)
        .map_err(|e| format!("не удалось заменить файл: {e}"))?;

    probe_duration(&ffmpeg, target)
}

/// Узнаёт длительность файла, спрашивая ffprobe рядом с ffmpeg.
fn probe_duration(ffmpeg: &Path, file: &Path) -> Result<f64, String> {
    let ffprobe = ffmpeg.with_file_name(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
    if !ffprobe.is_file() {
        return Err("ffprobe не найден рядом с ffmpeg".into());
    }

    let output = quiet_command(&ffprobe)
        .args(["-v", "error"])
        .args(["-show_entries", "format=duration"])
        .args(["-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(file)
        .output()
        .map_err(|e| format!("не удалось запустить ffprobe: {e}"))?;

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| "ffprobe не сообщил длительность".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(start: f64, end: f64) -> Cut {
        Cut { start, end }
    }

    #[test]
    fn without_cuts_the_whole_track_stays() {
        let segments = kept_segments(&[]);
        assert_eq!(segments, vec![Segment { start: 0.0, end: None }]);
    }

    #[test]
    fn a_cut_in_the_middle_splits_the_track_in_two() {
        // Ровно тот случай, ради которого всё затевалось: вставка посреди
        // записи, границами начала и конца её не убрать.
        let segments = kept_segments(&[cut(30.0, 45.0)]);
        assert_eq!(
            segments,
            vec![
                Segment { start: 0.0, end: Some(30.0) },
                Segment { start: 45.0, end: None },
            ]
        );
    }

    #[test]
    fn a_cut_at_the_very_start_leaves_no_empty_piece() {
        let segments = kept_segments(&[cut(0.0, 12.0)]);
        assert_eq!(segments, vec![Segment { start: 12.0, end: None }]);
    }

    #[test]
    fn several_cuts_leave_the_gaps_between_them() {
        let segments = kept_segments(&[cut(10.0, 20.0), cut(50.0, 60.0)]);
        assert_eq!(
            segments,
            vec![
                Segment { start: 0.0, end: Some(10.0) },
                Segment { start: 20.0, end: Some(50.0) },
                Segment { start: 60.0, end: None },
            ]
        );
    }

    #[test]
    fn filter_joins_every_piece() {
        let filter = build_filter(&kept_segments(&[cut(10.0, 20.0)]));
        assert!(filter.contains("atrim=start=0.000:end=10.000"));
        assert!(filter.contains("atrim=start=20.000"));
        assert!(filter.contains("concat=n=2:v=0:a=1[out]"));
    }

    #[test]
    fn original_is_stored_beside_the_track() {
        let path = original_path_for(Path::new("/tmp/Трек [abc].mp3"));
        assert_eq!(path.to_str().unwrap(), "/tmp/Трек [abc] (исходник).mp3");
    }
}
