import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlayer } from "./player/usePlayer";
import { THEMES, type ThemeSeed, applyTheme, themeById } from "./theme/themes";
import "./App.css";

/** Трек в библиотеке. Поля повторяют структуру db::Track на Rust-стороне. */
type Track = {
  id: number;
  video_id: string;
  raw_title: string;
  artist: string | null;
  title: string;
  file_path: string;
  cover_path: string | null;
  duration_secs: number | null;
  added_at: number;
  missing: boolean;
  edited: boolean;
};

/** Альбом — сборник, собранный руками из треков коллекции. */
type Album = {
  id: number;
  title: string;
  created_at: number;
  track_count: number;
  cover_path: string | null;
};

/** Стадия работы над одной ссылкой. */
type JobStatus = "waiting" | "downloading" | "converting" | "done" | "error";

/** Ссылка в очереди загрузок. */
type Job = {
  id: number;
  url: string;
  status: JobStatus;
  percent: number;
  title: string | null;
  error: string | null;
};

type Status = { kind: "idle" } | { kind: "working" } | { kind: "error"; message: string };

/** Склоняет слово «трек» по числу: 1 трек, 2 трека, 5 треков. */
function plural(count: number): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return "треков";
  const ones = count % 10;
  if (ones === 1) return "трек";
  if (ones >= 2 && ones <= 4) return "трека";
  return "треков";
}

/** Превращает секунды в м:сс. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/** Обложка трека в списке либо заглушка, если её ещё нет. */
function Cover({ track }: { track: Track }) {
  if (!track.cover_path) {
    return <div className="cover cover-small cover-empty" aria-hidden />;
  }
  return (
    <img
      className="cover cover-small"
      src={convertFileSrc(track.cover_path)}
      alt=""
      loading="lazy"
    />
  );
}

/**
 * Кольцо: логотип Omen, ставший органом управления.
 *
 * Нажатие переключает воспроизведение, дуга показывает прогресс. Это
 * единственная громкая деталь на экране — всё остальное держится тише.
 */
function Ring({
  progress,
  playing,
  onClick,
}: {
  progress: number;
  playing: boolean;
  onClick: () => void;
}) {
  const size = 76;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <button
      className="ring"
      onClick={onClick}
      title={playing ? "Пауза" : "Играть"}
      aria-label={playing ? "Пауза" : "Играть"}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <defs>
          <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-end)" />
          </linearGradient>
        </defs>
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#ring-gradient)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress / 100)}
        />
      </svg>
      <span className="ring-glyph" style={{ paddingLeft: playing ? 0 : 3 }}>
        {playing ? "❚❚" : "▶"}
      </span>
    </button>
  );
}

function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [openError, setOpenError] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftArtist, setDraftArtist] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  const [scrubbing, setScrubbing] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [view, setView] = useState<"collection" | "albums" | "queue" | "themes">("collection");
  const [albums, setAlbums] = useState<Album[]>([]);
  const [openAlbum, setOpenAlbum] = useState<Album | null>(null);
  const [albumTracks, setAlbumTracks] = useState<Track[]>([]);
  const [newAlbum, setNewAlbum] = useState("");
  const [pickingTracks, setPickingTracks] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<ThemeSeed>(() =>
    themeById(localStorage.getItem("omen.theme"))
  );

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  /** Путь до файла трека в виде, понятном вебвью. */
  const sourceFor = useCallback(
    (id: number) => {
      const track = byId.get(id);
      return track ? convertFileSrc(track.file_path) : "";
    },
    [byId]
  );

  const player = usePlayer(tracks, sourceFor);

  /**
   * Отфильтрованный список для показа.
   *
   * Порядок воспроизведения при этом не меняется: поиск — способ найти трек,
   * а не способ сузить то, что будет играть дальше.
   */
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) =>
      `${track.title} ${track.artist ?? ""}`.toLowerCase().includes(needle)
    );
  }, [tracks, search]);
  const current = player.currentId === null ? null : byId.get(player.currentId) ?? null;
  const progress = player.duration > 0 ? (player.position / player.duration) * 100 : 0;

  /** Перечитывает библиотеку из базы. */
  async function refresh() {
    try {
      setTracks(await invoke<Track[]>("library"));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Перечитывает список альбомов. */
  async function refreshAlbums() {
    try {
      setAlbums(await invoke<Album[]>("albums"));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  useEffect(() => {
    refresh();
    refreshAlbums();

    // Rust шлёт снимок очереди целиком: список короткий, а сверять частичные
    // обновления на приёмной стороне — верный источник рассинхрона.
    const unlistenQueue = listen<Job[]>("downloads", (event) => setJobs(event.payload));
    const unlistenTrack = listen<Track>("track-added", () => refresh());

    return () => {
      void unlistenQueue.then((off) => off());
      void unlistenTrack.then((off) => off());
    };
  }, []);

  /** Открывает альбом и подгружает его треки. */
  async function openAlbumDetail(album: Album) {
    setOpenAlbum(album);
    setPickingTracks(false);
    try {
      setAlbumTracks(await invoke<Track[]>("album_tracks", { albumId: album.id }));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Создаёт альбом с введённым названием. */
  async function handleCreateAlbum() {
    const title = newAlbum.trim();
    if (!title) return;
    try {
      setAlbums(await invoke<Album[]>("create_album", { title }));
      setNewAlbum("");
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Сохраняет новое название альбома. */
  async function handleRenameAlbum(id: number, title: string) {
    const trimmed = title.trim();
    setRenaming(null);
    if (!trimmed || trimmed === openAlbum?.title) return;
    try {
      const updated = await invoke<Album[]>("rename_album", { id, title: trimmed });
      setAlbums(updated);
      setOpenAlbum(updated.find((a) => a.id === id) ?? null);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Удаляет альбом. Треки при этом остаются в коллекции. */
  async function handleDeleteAlbum(id: number) {
    try {
      setAlbums(await invoke<Album[]>("delete_album", { id }));
      setOpenAlbum(null);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Кладёт трек в открытый альбом либо убирает его оттуда. */
  async function toggleInAlbum(trackId: number, inside: boolean) {
    if (!openAlbum) return;
    const command = inside ? "remove_from_album" : "add_to_album";
    try {
      setAlbumTracks(
        await invoke<Track[]>(command, { albumId: openAlbum.id, trackId })
      );
      await refreshAlbums();
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Ставит ссылку в очередь загрузок. Музыка при этом не прерывается. */
  async function handleDownload() {
    const link = url.trim();
    if (!link) return;
    setUrl("");
    try {
      setJobs(await invoke<Job[]>("enqueue_download", { url: link }));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Убирает из очереди завершённые и упавшие задания. */
  async function clearFinished() {
    setOpenError(null);
    try {
      setJobs(await invoke<Job[]>("clear_finished_downloads"));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Переключает тему и запоминает выбор до следующего запуска. */
  function chooseTheme(seed: ThemeSeed) {
    applyTheme(seed);
    localStorage.setItem("omen.theme", seed.id);
    setTheme(seed);
  }

  /** Открывает правку трека, заполняя форму текущими значениями. */
  function startEdit(track: Track) {
    setEditingId(track.id);
    setDraftArtist(track.artist ?? "");
    setDraftTitle(track.title);
  }

  /** Заменяет трек в списке. Плеер подхватит правку сам: он берёт трек по id. */
  function applyUpdate(updated: Track) {
    setTracks((previous) => previous.map((t) => (t.id === updated.id ? updated : t)));
  }

  /** Сохраняет правку: трек помечается как правленный и выпадает из авточистки. */
  async function saveEdit(id: number) {
    if (!draftTitle.trim()) return;
    try {
      applyUpdate(
        await invoke<Track>("save_track_title", {
          id,
          artist: draftArtist.trim() || null,
          title: draftTitle,
        })
      );
      setEditingId(null);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Возвращает трек под авточистку и сразу переразбирает исходный заголовок. */
  async function resetToAuto(id: number) {
    try {
      const updated = await invoke<Track>("reset_track_title", { id });
      applyUpdate(updated);
      setDraftArtist(updated.artist ?? "");
      setDraftTitle(updated.title);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Применяет перемотку и снимает режим перетаскивания. */
  function commitSeek(value: number) {
    setScrubbing(false);
    player.controls.seek(value);
  }

  const backdrop = current?.cover_path ? convertFileSrc(current.cover_path) : null;

  return (
    <div className={`app ${immersive ? "immersive" : ""}`}>
      <aside className="rail">
        <div className="rail-head">
          <h1 className="wordmark">
            <span>O</span>men
          </h1>
          <button
            className={`icon ${view === "themes" ? "on" : ""}`}
            onClick={() => setView((v) => (v === "themes" ? "collection" : "themes"))}
            title="Оформление"
          >
            ⚙
          </button>
        </div>

        {view !== "themes" && (
          <div className="tabs">
            <button
              className={`tab ${view === "collection" ? "on" : ""}`}
              onClick={() => setView("collection")}
            >
              Треки <b>{tracks.length}</b>
            </button>
            <button
              className={`tab ${view === "albums" ? "on" : ""}`}
              onClick={() => {
                setView("albums");
                setOpenAlbum(null);
              }}
            >
              Альбомы <b>{albums.length}</b>
            </button>
            <button
              className={`tab ${view === "queue" ? "on" : ""}`}
              onClick={() => setView("queue")}
            >
              Очередь <b>{player.queueLength}</b>
            </button>
          </div>
        )}

        {view === "collection" && (
          <>
            <div className="search-row">
              <input
                className="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                placeholder="Найти трек или исполнителя"
                spellCheck={false}
              />
              {search && (
                <button className="search-clear" onClick={() => setSearch("")} title="Очистить">
                  ✕
                </button>
              )}
            </div>

            <div className="collection">
              {tracks.length === 0 && (
                <p className="empty">
                  Пока пусто.
                  <br />
                  Вставь ссылку на видео внизу — заберу из него звук.
                </p>
              )}

              {tracks.length > 0 && visible.length === 0 && (
                <p className="empty">Ничего не нашлось по запросу «{search}».</p>
              )}

              {visible.map((track) =>
                editingId === track.id ? (
                  <div key={track.id} className="track editing">
                    <Cover track={track} />
                    <div className="edit-form">
                      <input
                        className="edit-input"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(track.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        placeholder="название"
                        autoFocus
                      />
                      <input
                        className="edit-input"
                        value={draftArtist}
                        onChange={(e) => setDraftArtist(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit(track.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        placeholder="исполнитель"
                      />
                      <div className="edit-raw" title={track.raw_title}>
                        было на YouTube: {track.raw_title}
                      </div>
                      <div className="edit-actions">
                        <button className="mini primary" onClick={() => saveEdit(track.id)}>
                          Сохранить
                        </button>
                        <button className="mini" onClick={() => setEditingId(null)}>
                          Отмена
                        </button>
                        {track.edited && (
                          <button className="mini ghost" onClick={() => resetToAuto(track.id)}>
                            Вернуть авточистку
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    key={track.id}
                    className={`track ${track.id === current?.id ? "active" : ""} ${
                      track.missing ? "missing" : ""
                    }`}
                  >
                    <button
                      className="track-main"
                      onClick={() => !track.missing && player.controls.play(track.id)}
                      disabled={track.missing}
                    >
                      <Cover track={track} />
                      <span className="track-text">
                        <span className="track-title">
                          {track.title}
                          {track.edited && <span className="edited-dot" title="правлено руками" />}
                        </span>
                        <span className="track-artist">
                          {track.missing
                            ? "файла нет на диске"
                            : track.artist ?? "исполнитель неизвестен"}
                        </span>
                      </span>
                    </button>
                    <button
                      className="track-act"
                      onClick={() => player.controls.enqueue(track.id)}
                      disabled={track.missing}
                      title="Играть следующим"
                    >
                      ↴
                    </button>
                    <button
                      className="track-act"
                      onClick={() => startEdit(track)}
                      title="Править название"
                    >
                      ✎
                    </button>
                  </div>
                )
              )}
            </div>
          </>
        )}

        {view === "albums" && !openAlbum && (
          <div className="collection">
            <div className="new-album">
              <input
                className="search"
                value={newAlbum}
                onChange={(e) => setNewAlbum(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateAlbum()}
                placeholder="Название нового альбома"
              />
              <button
                className="go"
                onClick={handleCreateAlbum}
                disabled={!newAlbum.trim()}
                title="Создать альбом"
              >
                +
              </button>
            </div>

            {albums.length === 0 && (
              <p className="empty">
                Альбомов пока нет.
                <br />
                Собери свой из треков коллекции.
              </p>
            )}

            {albums.map((album) => (
              <div key={album.id} className="track">
                <button className="track-main" onClick={() => openAlbumDetail(album)}>
                  {album.cover_path ? (
                    <img
                      className="cover cover-small"
                      src={convertFileSrc(album.cover_path)}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="cover cover-small cover-empty" aria-hidden />
                  )}
                  <span className="track-text">
                    <span className="track-title">{album.title}</span>
                    <span className="track-artist">
                      {album.track_count === 0
                        ? "пусто"
                        : `${album.track_count} ${plural(album.track_count)}`}
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}

        {view === "albums" && openAlbum && (
          <div className="collection">
            <div className="album-head">
              <button className="mini" onClick={() => setOpenAlbum(null)}>
                ← Альбомы
              </button>
              {renaming === null ? (
                <button
                  className="album-title"
                  onClick={() => setRenaming(openAlbum.title)}
                  title="Переименовать"
                >
                  {openAlbum.title}
                </button>
              ) : (
                <input
                  className="edit-input album-rename"
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                  onBlur={() => handleRenameAlbum(openAlbum.id, renaming)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameAlbum(openAlbum.id, renaming);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  autoFocus
                />
              )}
            </div>

            <div className="album-actions">
              <button
                className="mini primary"
                onClick={() =>
                  player.controls.playContext(
                    { kind: "album", id: openAlbum.id, title: openAlbum.title },
                    albumTracks.map((t) => t.id)
                  )
                }
                disabled={albumTracks.length === 0}
              >
                Включить
              </button>
              <button
                className={`mini ${pickingTracks ? "primary" : ""}`}
                onClick={() => setPickingTracks((on) => !on)}
              >
                {pickingTracks ? "Готово" : "Добавить треки"}
              </button>
              <button className="mini ghost" onClick={() => handleDeleteAlbum(openAlbum.id)}>
                Удалить альбом
              </button>
            </div>

            {pickingTracks ? (
              <>
                <p className="empty">
                  Отметь треки, которые войдут в альбом. Из коллекции они никуда не денутся.
                </p>
                {tracks.map((track) => {
                  const inside = albumTracks.some((t) => t.id === track.id);
                  return (
                    <div key={track.id} className={`track ${inside ? "active" : ""}`}>
                      <button
                        className="track-main"
                        onClick={() => toggleInAlbum(track.id, inside)}
                      >
                        <Cover track={track} />
                        <span className="track-text">
                          <span className="track-title">{track.title}</span>
                          <span className="track-artist">
                            {track.artist ?? "исполнитель неизвестен"}
                          </span>
                        </span>
                      </button>
                      <span className="pick-mark">{inside ? "✓" : "+"}</span>
                    </div>
                  );
                })}
              </>
            ) : albumTracks.length === 0 ? (
              <p className="empty">
                В альбоме пусто. Нажми «Добавить треки».
              </p>
            ) : (
              albumTracks.map((track) => (
                <div
                  key={track.id}
                  className={`track ${track.id === current?.id ? "active" : ""}`}
                >
                  <button
                    className="track-main"
                    onClick={() =>
                      player.controls.playContext(
                        { kind: "album", id: openAlbum.id, title: openAlbum.title },
                        albumTracks.map((t) => t.id),
                        track.id
                      )
                    }
                  >
                    <Cover track={track} />
                    <span className="track-text">
                      <span className="track-title">{track.title}</span>
                      <span className="track-artist">
                        {track.artist ?? "исполнитель неизвестен"}
                      </span>
                    </span>
                  </button>
                  <button
                    className="track-act"
                    onClick={() => toggleInAlbum(track.id, true)}
                    title="Убрать из альбома"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {view === "queue" && (
          <div className="collection">
            {player.queue.length === 0 ? (
              <p className="empty">
                Очередь пуста.
                <br />
                Нажми ↴ у трека, чтобы поставить его следующим.
              </p>
            ) : (
              <>
                <button className="mini ghost queue-clear" onClick={player.controls.clearQueue}>
                  Очистить очередь
                </button>

                {player.queue.map((id, index) => {
                  const track = byId.get(id);
                  if (!track) return null;
                  return (
                    <div key={`${id}-${index}`} className="track">
                      <button
                        className="track-main"
                        onClick={() => player.controls.play(id)}
                      >
                        <span className="queue-index">{index + 1}</span>
                        <Cover track={track} />
                        <span className="track-text">
                          <span className="track-title">{track.title}</span>
                          <span className="track-artist">
                            {track.artist ?? "исполнитель неизвестен"}
                          </span>
                        </span>
                      </button>
                      <button
                        className="track-act"
                        onClick={() => player.controls.dequeue(index)}
                        title="Убрать из очереди"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {view === "themes" && (
          <div className="themes">
            {THEMES.map((seed) => (
              <button
                key={seed.id}
                className={`theme ${seed.id === theme.id ? "active" : ""}`}
                onClick={() => chooseTheme(seed)}
              >
                <span
                  className="theme-swatch"
                  style={{ background: seed.bg, color: seed.accent }}
                />
                {seed.name}
              </button>
            ))}
          </div>
        )}

        <div className="add">
          {jobs.length > 0 && (
            <div className="jobs">
              {jobs.map((job) => (
                <div key={job.id} className={`job job-${job.status}`}>
                  <div className="job-row">
                    <span className="job-text">
                      {job.status === "error"
                        ? "Не вышло"
                        : job.status === "done"
                          ? job.title ?? "Готово"
                          : job.status === "converting"
                            ? "Перекодирую"
                            : job.status === "waiting"
                              ? "Жду очереди"
                              : "Качаю"}
                    </span>
                    <span className="job-side">
                      {job.status === "downloading" && `${Math.round(job.percent)}%`}
                      {job.status === "done" && "✓"}
                      {job.status === "error" && (
                        <button
                          className="job-why"
                          onClick={() => setOpenError(openError === job.id ? null : job.id)}
                        >
                          почему
                        </button>
                      )}
                    </span>
                  </div>

                  {(job.status === "downloading" || job.status === "converting") && (
                    <div className="job-bar">
                      <span
                        style={{
                          width: job.status === "converting" ? "100%" : `${job.percent}%`,
                        }}
                      />
                    </div>
                  )}

                  {openError === job.id && job.error && <code className="job-error">{job.error}</code>}
                </div>
              ))}

              {jobs.some((job) => job.status === "done" || job.status === "error") && (
                <button className="mini ghost" onClick={clearFinished}>
                  Убрать завершённые
                </button>
              )}
            </div>
          )}

          <div className="add-row">
            <input
              className="url-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleDownload()}
              placeholder="ссылка на видео"
              spellCheck={false}
            />
            <button
              className="go"
              onClick={handleDownload}
              disabled={!url.trim()}
              title="Поставить в очередь"
            >
              ↓
            </button>
          </div>
          {status.kind === "error" && (
            <p className="status error">
              Не вышло<code>{status.message}</code>
            </p>
          )}
        </div>
      </aside>

      <section className="stage">
        {backdrop && (
          <div className="backdrop" style={{ backgroundImage: `url("${backdrop}")` }} />
        )}

        <button
          className="icon stage-toggle"
          onClick={() => setImmersive((on) => !on)}
          title={immersive ? "Показать коллекцию" : "Скрыть коллекцию"}
        >
          {immersive ? "⤡" : "⤢"}
        </button>

        {current ? (
          <>
            {current.cover_path ? (
              <img className="art" src={convertFileSrc(current.cover_path)} alt="" />
            ) : (
              <div className="art-empty" aria-hidden />
            )}

            <div className="meta">
              {player.context.kind === "album" && (
                <p className="stage-context">Альбом · {player.context.title}</p>
              )}
              <h2 className="stage-title">{current.title}</h2>
              {current.artist && <p className="stage-artist">{current.artist}</p>}
            </div>

            <div className="transport">
              <button
                className={`icon ${player.shuffle ? "on" : ""}`}
                onClick={player.controls.toggleShuffle}
                title={player.shuffle ? "Шафл включён" : "Шафл выключен"}
              >
                ⇄
              </button>

              <button className="icon" onClick={player.controls.prev} title="Назад">
                ⏮
              </button>

              <Ring
                progress={progress}
                playing={player.playing}
                onClick={player.controls.toggle}
              />

              <button className="icon" onClick={player.controls.next} title="Вперёд">
                ⏭
              </button>

              <button
                className={`icon ${player.repeat !== "off" ? "on" : ""}`}
                onClick={player.controls.cycleRepeat}
                title={
                  player.repeat === "off"
                    ? "Повтор выключен"
                    : player.repeat === "all"
                      ? "Повтор всех"
                      : "Повтор одного"
                }
              >
                ↻{player.repeat === "one" && <sup>1</sup>}
              </button>
            </div>

            <div className="scrub">
              <span className="time">{formatTime(player.position)}</span>
              <input
                className="seek"
                style={{ "--progress": `${progress}%` } as React.CSSProperties}
                type="range"
                min={0}
                max={player.duration || 0}
                step={0.01}
                value={player.position}
                aria-label="Перемотка"
                onPointerDown={() => setScrubbing(true)}
                onChange={(e) => player.setPosition(Number(e.target.value))}
                onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
              />
              <span className="time">{formatTime(player.duration)}</span>
            </div>

            {(player.queueLength > 0 || player.atEnd) && (
              <p className="stage-hint">
                {player.atEnd
                  ? "Коллекция кончилась. Включи повтор, чтобы играть по кругу."
                  : `В очереди: ${player.queueLength}`}
              </p>
            )}

            {/* src задаётся связкой императивно: смена поколения — единственный
                сигнал начать трек с нуля, и React тут только мешал бы. */}
            <audio
              {...player.audioProps}
              onTimeUpdate={(e) => !scrubbing && player.setPosition(e.currentTarget.currentTime)}
            />
          </>
        ) : (
          <>
            <div className="art-empty" aria-hidden />
            <p className="stage-hint">
              Выбери трек слева
              <br />
              или добавь ссылку на видео
            </p>
          </>
        )}
      </section>
    </div>
  );
}

export default App;
