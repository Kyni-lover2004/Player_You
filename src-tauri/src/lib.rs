mod db;
mod downloads;
mod titles;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Соединение с библиотекой, живущее всё время работы приложения.
///
/// Mutex здесь не про многопоточность ради многопоточности: команды Tauri
/// приходят из разных потоков, а Connection у rusqlite не Sync.
struct Library(Mutex<rusqlite::Connection>);

/// Рассылает текущее состояние очереди загрузок во фронтенд.
///
/// Отправляется снимок целиком, а не отдельные изменения: список короткий,
/// а сверять частичные обновления на приёмной стороне — источник рассинхрона.
fn broadcast(app: &tauri::AppHandle) {
    let snapshot = app.state::<downloads::Queue>().snapshot();
    let _ = app.emit("downloads", snapshot);
}

/// Записывает скачанный трек в библиотеку и возвращает готовую запись.
fn store(app: &tauri::AppHandle, downloaded: downloads::Downloaded) -> Result<db::Track, String> {
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

/// Разбирает очередь, пока в ней есть ожидающие задания.
///
/// Воркер один: повторный вызов при уже работающем просто возвращается.
fn run_worker(app: tauri::AppHandle) {
    {
        let queue = app.state::<downloads::Queue>();
        if !queue.claim_worker() {
            return;
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        while let Some(job) = app.state::<downloads::Queue>().take_next() {
            broadcast(&app);

            let id = job.id;
            let progress_app = app.clone();
            let stage_app = app.clone();
            // Прогресс приходит десятками строк в секунду. Событие уходит
            // только при смене целого процента, иначе фронтенд захлебнётся.
            let mut last_whole = -1i64;

            let result = downloads::download(
                &job.url,
                |percent| {
                    let whole = percent as i64;
                    if whole == last_whole {
                        return;
                    }
                    last_whole = whole;
                    progress_app
                        .state::<downloads::Queue>()
                        .update(id, |job| job.percent = percent);
                    broadcast(&progress_app);
                },
                |stage| {
                    stage_app
                        .state::<downloads::Queue>()
                        .update(id, |job| job.status = stage);
                    broadcast(&stage_app);
                },
            );

            match result.and_then(|downloaded| store(&app, downloaded)) {
                Ok(track) => {
                    app.state::<downloads::Queue>().update(id, |job| {
                        job.status = downloads::JobStatus::Done;
                        job.percent = 100.0;
                        job.title = Some(track.title.clone());
                    });
                    let _ = app.emit("track-added", track);
                }
                Err(reason) => {
                    app.state::<downloads::Queue>().update(id, |job| {
                        job.status = downloads::JobStatus::Error;
                        job.error = Some(reason);
                    });
                }
            }

            broadcast(&app);
        }

        app.state::<downloads::Queue>().release_worker();
    });
}

// ── Загрузки ─────────────────────────────────────────────

/// Ставит ссылку в очередь и будит воркера.
#[tauri::command]
fn enqueue_download(app: tauri::AppHandle, url: String) -> Result<Vec<downloads::Job>, String> {
    app.state::<downloads::Queue>().push(url)?;
    let snapshot = app.state::<downloads::Queue>().snapshot();
    run_worker(app.clone());
    Ok(snapshot)
}

/// Текущее состояние очереди загрузок.
#[tauri::command]
fn downloads_state(state: tauri::State<'_, downloads::Queue>) -> Vec<downloads::Job> {
    state.snapshot()
}

/// Убирает из очереди завершённые и упавшие задания.
#[tauri::command]
fn clear_finished_downloads(app: tauri::AppHandle) -> Vec<downloads::Job> {
    app.state::<downloads::Queue>().clear_finished();
    let snapshot = app.state::<downloads::Queue>().snapshot();
    let _ = app.emit("downloads", snapshot.clone());
    snapshot
}

// ── Библиотека ───────────────────────────────────────────

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

/// Приводит поле формы к значению для базы: пустая строка означает «не задано».
fn normalize_field(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Сохраняет правку названия руками и защищает её от будущей авточистки.
#[tauri::command]
fn save_track_title(
    app: tauri::AppHandle,
    id: i64,
    artist: Option<String>,
    title: String,
) -> Result<db::Track, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("название не может быть пустым".into());
    }

    let state = app.state::<Library>();
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;

    db::set_edited_title(&conn, id, normalize_field(artist).as_deref(), &title)?;
    db::find_by_id(&conn, id)?.ok_or_else(|| "трек не найден".into())
}

/// Возвращает трек под авточистку и сразу переразбирает исходный заголовок.
#[tauri::command]
fn reset_track_title(app: tauri::AppHandle, id: i64) -> Result<db::Track, String> {
    let state = app.state::<Library>();
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;

    let track = db::find_by_id(&conn, id)?.ok_or("трек не найден")?;
    db::clear_edited(&conn, id)?;

    let parsed = titles::parse(&track.raw_title);
    db::update_parsed_title(&conn, id, parsed.artist.as_deref(), &parsed.title)?;

    db::find_by_id(&conn, id)?.ok_or_else(|| "трек не найден".into())
}

// ── Альбомы ──────────────────────────────────────────────
//
// Альбом здесь — сборник, собранный руками, а не запись из метаданных.
// YouTube про альбомы ничего не сообщает, и выдумывать их было бы враньём.

/// Возвращает все альбомы, свежие сверху.
#[tauri::command]
fn albums(state: tauri::State<'_, Library>) -> Result<Vec<db::Album>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::all_albums(&conn)
}

/// Возвращает треки альбома в заданном порядке.
#[tauri::command]
fn album_tracks(state: tauri::State<'_, Library>, album_id: i64) -> Result<Vec<db::Track>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::album_tracks(&conn, album_id)
}

/// Создаёт альбом и возвращает обновлённый список.
#[tauri::command]
fn create_album(state: tauri::State<'_, Library>, title: String) -> Result<Vec<db::Album>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::create_album(&conn, &title)?;
    db::all_albums(&conn)
}

/// Переименовывает альбом.
#[tauri::command]
fn rename_album(
    state: tauri::State<'_, Library>,
    id: i64,
    title: String,
) -> Result<Vec<db::Album>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::rename_album(&conn, id, &title)?;
    db::all_albums(&conn)
}

/// Удаляет альбом. Треки при этом остаются в коллекции.
#[tauri::command]
fn delete_album(state: tauri::State<'_, Library>, id: i64) -> Result<Vec<db::Album>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::delete_album(&conn, id)?;
    db::all_albums(&conn)
}

/// Кладёт трек в конец альбома. Повторное добавление ничего не меняет.
#[tauri::command]
fn add_to_album(
    state: tauri::State<'_, Library>,
    album_id: i64,
    track_id: i64,
) -> Result<Vec<db::Track>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::add_to_album(&conn, album_id, track_id)?;
    db::album_tracks(&conn, album_id)
}

/// Убирает трек из альбома. Сам трек остаётся в коллекции.
#[tauri::command]
fn remove_from_album(
    state: tauri::State<'_, Library>,
    album_id: i64,
    track_id: i64,
) -> Result<Vec<db::Track>, String> {
    let conn = state.0.lock().map_err(|_| "библиотека занята")?;
    db::remove_from_album(&conn, album_id, track_id)?;
    db::album_tracks(&conn, album_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(downloads::Queue::default())
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
        .invoke_handler(tauri::generate_handler![
            enqueue_download,
            downloads_state,
            clear_finished_downloads,
            library,
            save_track_title,
            reset_track_title,
            albums,
            album_tracks,
            create_album,
            rename_album,
            delete_album,
            add_to_album,
            remove_from_album
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
