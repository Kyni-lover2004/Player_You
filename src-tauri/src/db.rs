//! Слой SQLite: библиотека треков.
//!
//! По спеке база — источник правды, а файлы на диске лишь содержимое.
//! Ключ уникальности — идентификатор видео на YouTube: один и тот же
//! трек, скачанный дважды, должен занять одну строку, а не две.

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Схема библиотеки. Выполняется при каждом открытии, поэтому идемпотентна.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS tracks (
    id             INTEGER PRIMARY KEY,
    video_id       TEXT    NOT NULL UNIQUE,
    raw_title      TEXT    NOT NULL,
    artist         TEXT,
    title          TEXT    NOT NULL,
    file_path      TEXT    NOT NULL,
    cover_path     TEXT,
    duration_secs  REAL,
    added_at       INTEGER NOT NULL,
    missing        INTEGER NOT NULL DEFAULT 0,
    edited         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at DESC);
";

/// Трек в библиотеке.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Track {
    pub id: i64,
    /// Идентификатор видео на YouTube — ключ дедупликации.
    pub video_id: String,
    /// Заголовок как его отдал YouTube, до всякой чистки.
    pub raw_title: String,
    pub artist: Option<String>,
    /// Название после авточистки либо после правки руками.
    pub title: String,
    pub file_path: String,
    pub cover_path: Option<String>,
    pub duration_secs: Option<f64>,
    /// Unix-время добавления в библиотеку, в секундах.
    pub added_at: i64,
    /// Файла нет на диске: удалён мимо приложения. Строку при этом не теряем.
    pub missing: bool,
    /// Название правили руками — авточистка такую строку больше не трогает.
    pub edited: bool,
}

/// Данные для добавления трека: всё то же, но без идентификатора и служебных полей.
#[derive(Debug, Clone)]
pub struct NewTrack {
    pub video_id: String,
    pub raw_title: String,
    pub artist: Option<String>,
    pub title: String,
    pub file_path: String,
    pub cover_path: Option<String>,
    pub duration_secs: Option<f64>,
}

/// Открывает базу по указанному пути и накатывает схему.
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("не удалось создать {}: {e}", parent.display()))?;
    }

    let conn = Connection::open(path).map_err(|e| format!("не удалось открыть базу: {e}"))?;

    // WAL возвращает строку результата, поэтому идёт через query_row, а не execute.
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .map_err(|e| format!("не удалось включить WAL: {e}"))?;

    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("не удалось создать схему: {e}"))?;

    ensure_column(&conn, "tracks", "edited", "INTEGER NOT NULL DEFAULT 0")?;

    Ok(conn)
}

/// Добавляет колонку, если её ещё нет.
///
/// CREATE TABLE IF NOT EXISTS не достраивает существующую таблицу, поэтому
/// базы, созданные предыдущей версией, нужно доводить руками.
fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("не удалось прочитать схему {table}: {e}"))?;

    let existing: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("не удалось перечислить колонки: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("не удалось разобрать колонки: {e}"))?;

    if !existing.iter().any(|name| name == column) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))
            .map_err(|e| format!("не удалось добавить колонку {column}: {e}"))?;
    }

    Ok(())
}

/// Текущее время в секундах Unix.
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Собирает трек из строки выборки. Порядок колонок задан запросами ниже.
fn row_to_track(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        video_id: row.get("video_id")?,
        raw_title: row.get("raw_title")?,
        artist: row.get("artist")?,
        title: row.get("title")?,
        file_path: row.get("file_path")?,
        cover_path: row.get("cover_path")?,
        duration_secs: row.get("duration_secs")?,
        added_at: row.get("added_at")?,
        missing: row.get::<_, i64>("missing")? != 0,
        edited: row.get::<_, i64>("edited")? != 0,
    })
}

/// Добавляет трек либо обновляет существующий с тем же идентификатором видео.
///
/// Повторное скачивание не создаёт дубль: обновляются путь, обложка и
/// длительность, а `added_at` и правки названия руками сохраняются.
pub fn upsert_track(conn: &Connection, track: &NewTrack) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO tracks
            (video_id, raw_title, artist, title, file_path, cover_path, duration_secs, added_at, missing)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
         ON CONFLICT(video_id) DO UPDATE SET
            file_path     = excluded.file_path,
            cover_path    = COALESCE(excluded.cover_path, tracks.cover_path),
            duration_secs = COALESCE(excluded.duration_secs, tracks.duration_secs),
            missing       = 0",
        rusqlite::params![
            track.video_id,
            track.raw_title,
            track.artist,
            track.title,
            track.file_path,
            track.cover_path,
            track.duration_secs,
            now_secs(),
        ],
    )
    .map_err(|e| format!("не удалось записать трек: {e}"))?;

    conn.query_row(
        "SELECT id FROM tracks WHERE video_id = ?1",
        [&track.video_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("не удалось получить id трека: {e}"))
}

/// Ищет трек по идентификатору видео.
pub fn find_by_video_id(conn: &Connection, video_id: &str) -> Result<Option<Track>, String> {
    conn.query_row(
        "SELECT * FROM tracks WHERE video_id = ?1",
        [video_id],
        row_to_track,
    )
    .optional()
    .map_err(|e| format!("не удалось найти трек: {e}"))
}

/// Возвращает всю библиотеку, свежие сверху.
pub fn all_tracks(conn: &Connection) -> Result<Vec<Track>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM tracks ORDER BY added_at DESC, id DESC")
        .map_err(|e| format!("не удалось подготовить запрос: {e}"))?;

    let rows = stmt
        .query_map([], row_to_track)
        .map_err(|e| format!("не удалось прочитать библиотеку: {e}"))?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("не удалось разобрать строку библиотеки: {e}"))
}

/// Записывает результат авточистки, не трогая строки, правленные руками.
///
/// Возвращает true, если строка действительно изменилась.
pub fn update_parsed_title(
    conn: &Connection,
    id: i64,
    artist: Option<&str>,
    title: &str,
) -> Result<bool, String> {
    let affected = conn
        .execute(
            "UPDATE tracks SET artist = ?1, title = ?2
             WHERE id = ?3 AND edited = 0 AND (artist IS NOT ?1 OR title IS NOT ?2)",
            rusqlite::params![artist, title, id],
        )
        .map_err(|e| format!("не удалось обновить название: {e}"))?;

    Ok(affected > 0)
}

/// Помечает название как правленное руками и сохраняет правку.
pub fn set_edited_title(
    conn: &Connection,
    id: i64,
    artist: Option<&str>,
    title: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tracks SET artist = ?1, title = ?2, edited = 1 WHERE id = ?3",
        rusqlite::params![artist, title, id],
    )
    .map_err(|e| format!("не удалось сохранить правку: {e}"))?;
    Ok(())
}

/// Сверяет базу с диском и помечает пропавшие файлы.
///
/// Спека требует, чтобы удалённый мимо приложения файл не исчезал молча:
/// строка остаётся, но получает пометку. Возвращает число изменённых записей.
pub fn reconcile_with_disk(conn: &Connection) -> Result<usize, String> {
    let tracks = all_tracks(conn)?;
    let mut changed = 0;

    for track in tracks {
        let exists = Path::new(&track.file_path).is_file();
        if exists == track.missing {
            // Состояние на диске разошлось с записью — приводим в соответствие.
            conn.execute(
                "UPDATE tracks SET missing = ?1 WHERE id = ?2",
                rusqlite::params![i64::from(!exists), track.id],
            )
            .map_err(|e| format!("не удалось обновить пометку: {e}"))?;
            changed += 1;
        }
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// База в памяти со схемой — для тестов.
    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn sample(video_id: &str, path: &str) -> NewTrack {
        NewTrack {
            video_id: video_id.into(),
            raw_title: "ROCKET − Инкассатор (prod. by FRESCO)".into(),
            artist: Some("ROCKET".into()),
            title: "Инкассатор".into(),
            file_path: path.into(),
            cover_path: None,
            duration_secs: Some(152.17),
        }
    }

    #[test]
    fn upsert_creates_then_finds() {
        let conn = memory_db();
        let id = upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/a.mp3")).unwrap();

        let found = find_by_video_id(&conn, "BFSpI9aJ4As").unwrap().unwrap();
        assert_eq!(found.id, id);
        assert_eq!(found.artist.as_deref(), Some("ROCKET"));
        assert!(!found.missing);
    }

    #[test]
    fn same_video_id_does_not_duplicate() {
        let conn = memory_db();
        upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/a.mp3")).unwrap();
        upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/b.mp3")).unwrap();

        let all = all_tracks(&conn).unwrap();
        assert_eq!(all.len(), 1, "один и тот же трек занял две строки");
        assert_eq!(all[0].file_path, "/tmp/b.mp3", "путь должен обновиться");
    }

    #[test]
    fn different_video_ids_are_separate_rows() {
        let conn = memory_db();
        upsert_track(&conn, &sample("aaaaaaaaaaa", "/tmp/a.mp3")).unwrap();
        upsert_track(&conn, &sample("bbbbbbbbbbb", "/tmp/b.mp3")).unwrap();
        assert_eq!(all_tracks(&conn).unwrap().len(), 2);
    }

    #[test]
    fn reparse_updates_untouched_title() {
        let conn = memory_db();
        let id = upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/a.mp3")).unwrap();

        assert!(update_parsed_title(&conn, id, Some("ROCKET"), "Другое").unwrap());
        assert_eq!(find_by_video_id(&conn, "BFSpI9aJ4As").unwrap().unwrap().title, "Другое");
    }

    #[test]
    fn reparse_does_not_touch_manual_edit() {
        let conn = memory_db();
        let id = upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/a.mp3")).unwrap();
        set_edited_title(&conn, id, Some("Моё"), "Моё название").unwrap();

        assert!(!update_parsed_title(&conn, id, Some("ROCKET"), "Инкассатор").unwrap());
        let track = find_by_video_id(&conn, "BFSpI9aJ4As").unwrap().unwrap();
        assert_eq!(track.title, "Моё название", "авточистка затёрла ручную правку");
        assert!(track.edited);
    }

    #[test]
    fn reparse_reports_no_change_when_nothing_differs() {
        let conn = memory_db();
        let id = upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/a.mp3")).unwrap();
        assert!(!update_parsed_title(&conn, id, Some("ROCKET"), "Инкассатор").unwrap());
    }

    #[test]
    fn reconcile_marks_absent_file_as_missing() {
        let conn = memory_db();
        upsert_track(&conn, &sample("BFSpI9aJ4As", "/tmp/нет-такого-файла.mp3")).unwrap();

        let changed = reconcile_with_disk(&conn).unwrap();
        assert_eq!(changed, 1);
        assert!(all_tracks(&conn).unwrap()[0].missing);
    }

    #[test]
    fn reconcile_clears_flag_when_file_returns() {
        let conn = memory_db();
        let file = std::env::temp_dir().join("omen-тест-возврат.mp3");
        std::fs::write(&file, b"x").unwrap();

        upsert_track(&conn, &sample("BFSpI9aJ4As", file.to_str().unwrap())).unwrap();
        conn.execute("UPDATE tracks SET missing = 1", []).unwrap();

        assert_eq!(reconcile_with_disk(&conn).unwrap(), 1);
        assert!(!all_tracks(&conn).unwrap()[0].missing);

        std::fs::remove_file(&file).ok();
    }
}
