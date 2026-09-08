import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlayer } from "./player/usePlayer";
import { useShortcuts } from "./player/useShortcuts";
import { SEEK_STEP, VOLUME_STEP } from "./player/shortcuts";
import {
  THEMES,
  type ThemeSeed,
  applyTheme,
  isCustom,
  loadCustomThemes,
  newThemeId,
  saveCustomThemes,
  themeById,
} from "./theme/themes";
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
  cuts: Cut[];
  original_path: string | null;
};

/** Отрезок, вырезанный из трека. */
type Cut = { start: number; end: number };

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

/**
 * Превращает секунды в мм:сс.
 *
 * Минуты с ведущим нулём: односимвольные выглядят обрубленными, а ещё от
 * них дёргается вся строка на переходе с 9:59 на 10:00.
 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "00:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const rest = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
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

/**
 * Значок громкости.
 *
 * Нарисован, а не взят из эмодзи: системные эмодзи цветные и трёхмерные,
 * а рядом стоят однотонные типографские знаки — вместе они выглядят как
 * два разных интерфейса. Этот наследует цвет темы через currentColor.
 *
 * Дуг столько же, сколько уровня: тише — меньше, при заглушении вместо
 * них крестик.
 */
function VolumeIcon({ level, muted }: { level: number; muted: boolean }) {
  const silent = muted || level === 0;

  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.6 6.1h2.5L8.5 3.2a.5.5 0 0 1 .8.4v8.8a.5.5 0 0 1-.8.4L5.1 9.9H2.6a.6.6 0 0 1-.6-.6V6.7a.6.6 0 0 1 .6-.6Z"
        fill="currentColor"
      />

      {!silent && (
        <path
          d="M11.2 6.3a2.4 2.4 0 0 1 0 3.4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}

      {!silent && level >= 0.5 && (
        <path
          d="M13.2 4.5a5 5 0 0 1 0 7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}

      {silent && (
        <path
          d="m11.3 6.3 3.2 3.4m0-3.4-3.2 3.4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [openError, setOpenError] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [cutting, setCutting] = useState(false);
  const [cutFrom, setCutFrom] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
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
  const [customThemes, setCustomThemes] = useState<ThemeSeed[]>(() => loadCustomThemes());
  const [theme, setTheme] = useState<ThemeSeed>(() =>
    themeById(localStorage.getItem("omen.theme"))
  );
  const [draft, setDraft] = useState<ThemeSeed | null>(null);

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

  /**
   * Ставит ссылку в очередь загрузок.
   *
   * Ссылка с хвостом плейлиста скачивает одно видео, на которое указывает:
   * за это отвечает --no-playlist в вызове yt-dlp.
   */
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

  /** Начинает новую тему от текущей: так виднее, что именно меняешь. */
  function startNewTheme() {
    setDraft({ ...theme, id: newThemeId(), name: "Моя тема" });
  }

  /** Меняет черновик и сразу показывает результат на всём окне. */
  function editDraft(change: Partial<ThemeSeed>) {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...change };
      applyTheme(next);
      return next;
    });
  }

  /** Сохраняет черновик и делает его текущей темой. */
  function saveDraft() {
    if (!draft) return;
    const name = draft.name.trim() || "Моя тема";
    const seed = { ...draft, name };

    const next = customThemes.some((t) => t.id === seed.id)
      ? customThemes.map((t) => (t.id === seed.id ? seed : t))
      : [...customThemes, seed];

    setCustomThemes(next);
    saveCustomThemes(next);
    setDraft(null);
    chooseTheme(seed);
  }

  /** Закрывает редактор, возвращая окну прежнюю тему. */
  function cancelDraft() {
    applyTheme(theme);
    setDraft(null);
  }

  /** Удаляет свою тему. Если она была включена, окно вернётся к «Аметисту». */
  function deleteTheme(id: string) {
    const next = customThemes.filter((t) => t.id !== id);
    setCustomThemes(next);
    saveCustomThemes(next);
    setDraft(null);
    if (theme.id === id) chooseTheme(THEMES[0]);
  }

  /** Сохраняет список вырезок трека. */
  async function saveCuts(id: number, cuts: Cut[]) {
    try {
      applyUpdate(await invoke<Track>("set_track_cuts", { id, cuts }));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Отмечает конец вырезки и добавляет её к списку. */
  function finishCut(track: Track) {
    if (cutFrom === null) return;
    const [start, end] = [cutFrom, player.position].sort((a, b) => a - b);
    setCutFrom(null);
    void saveCuts(track.id, [...track.cuts, { start, end }]);
  }

  /** Режет файл по отмеченному. */
  async function applyCuts(id: number) {
    setApplying(true);
    try {
      applyUpdate(await invoke<Track>("apply_track_cuts", { id }));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    } finally {
      setApplying(false);
    }
  }

  /** Возвращает трек к скачанному состоянию. */
  async function resetCuts(id: number) {
    setApplying(true);
    try {
      applyUpdate(await invoke<Track>("reset_track_cuts", { id }));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    } finally {
      setApplying(false);
    }
  }

  /**
   * Полностью удаляет трек: запись, файл и обложку.
   *
   * Сначала машина состояний узнаёт об удалении, потом обновляется список.
   * Обратный порядок сбил бы правило «удалённый доигрывает, дальше сосед».
   */
  async function handleDelete(id: number) {
    setConfirmDelete(null);
    player.controls.remove(id);
    try {
      setTracks(await invoke<Track[]>("delete_track", { id }));
      await refreshAlbums();
      if (openAlbum) {
        setAlbumTracks(await invoke<Track[]>("album_tracks", { albumId: openAlbum.id }));
      }
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
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

  useShortcuts({
    toggle: player.controls.toggle,
    seekBack: () => player.controls.nudge(-SEEK_STEP),
    seekForward: () => player.controls.nudge(SEEK_STEP),
    prev: player.controls.prev,
    next: player.controls.next,
    volumeUp: () => player.controls.setVolume(player.volume + VOLUME_STEP),
    volumeDown: () => player.controls.setVolume(player.volume - VOLUME_STEP),
    mute: player.controls.toggleMute,
    shuffle: player.controls.toggleShuffle,
    repeat: player.controls.cycleRepeat,
    search: () => {
      setView("collection");
      // Фокус ставим после перерисовки: до неё поля ещё нет в разметке.
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    help: () => setHelpOpen((open) => !open),
    escape: () => {
      if (helpOpen) return setHelpOpen(false);
      if (confirmDelete !== null) return setConfirmDelete(null);
      if (editingId !== null) return setEditingId(null);
      if (search) return setSearch("");
      if (immersive) setImmersive(false);
    },
  });

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
                ref={searchRef}
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
                confirmDelete === track.id ? (
                  <div key={track.id} className="track confirming">
                    <Cover track={track} />
                    <div className="confirm-body">
                      <span className="confirm-text">
                        Удалить «{track.title}»? Файл уйдёт в Корзину.
                      </span>
                      <div className="edit-actions">
                        <button className="mini danger" onClick={() => handleDelete(track.id)}>
                          Удалить
                        </button>
                        <button className="mini" onClick={() => setConfirmDelete(null)}>
                          Отмена
                        </button>
                      </div>
                    </div>
                  </div>
                ) : editingId === track.id ? (
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
                    <button
                      className="track-act track-act-danger"
                      onClick={() => setConfirmDelete(track.id)}
                      title="Удалить трек"
                    >
                      ✕
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
            {draft ? (
              <div className="editor">
                <input
                  className="edit-input"
                  value={draft.name}
                  onChange={(e) => editDraft({ name: e.target.value })}
                  placeholder="название темы"
                  autoFocus
                />

                <label className="field">
                  <span>Фон</span>
                  <input
                    type="color"
                    value={draft.bg}
                    onChange={(e) => editDraft({ bg: e.target.value })}
                  />
                </label>

                <label className="field">
                  <span>Акцент</span>
                  <input
                    type="color"
                    value={draft.accent}
                    onChange={(e) => editDraft({ accent: e.target.value })}
                  />
                </label>

                <label className="field">
                  <span>Конец градиента</span>
                  <input
                    type="color"
                    value={draft.accentEnd}
                    onChange={(e) => editDraft({ accentEnd: e.target.value })}
                  />
                </label>

                <p className="editor-note">
                  Цвета текста, поверхностей и рамок задавать не нужно — они
                  выводятся из фона так, чтобы контраст держался. Нечитаемую тему
                  собрать нельзя.
                </p>

                <div className="edit-actions">
                  <button className="mini primary" onClick={saveDraft}>
                    Сохранить
                  </button>
                  <button className="mini" onClick={cancelDraft}>
                    Отмена
                  </button>
                  {customThemes.some((t) => t.id === draft.id) && (
                    <button className="mini ghost" onClick={() => deleteTheme(draft.id)}>
                      Удалить
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {[...THEMES, ...customThemes].map((seed) => (
                  <div key={seed.id} className={`theme-row ${seed.id === theme.id ? "active" : ""}`}>
                    <button className="theme" onClick={() => chooseTheme(seed)}>
                      <span
                        className="theme-swatch"
                        style={{ background: seed.bg, color: seed.accent }}
                      />
                      {seed.name}
                    </button>
                    {isCustom(seed) && (
                      <button
                        className="track-act"
                        onClick={() => {
                          setDraft(seed);
                          applyTheme(seed);
                        }}
                        title="Править тему"
                      >
                        ✎
                      </button>
                    )}
                  </div>
                ))}

                <button className="mini new-theme" onClick={startNewTheme}>
                  + Своя тема
                </button>
              </>
            )}
          </div>
        )}

        <div className="add">
          {jobs.length > 0 && (
            <div className="jobs">
              {jobs.map((job) => (
                <div key={job.id} className={`job job-${job.status}`}>
                  {/* Пока трек качается, слов не нужно: полоса и процент
                      говорят всё сами. Название появляется, когда становится
                      известно, то есть в самом конце. */}
                  {job.status === "done" || job.status === "error" ? (
                    <div className="job-row">
                      <span className="job-text">
                        {job.status === "error" ? "Не вышло" : job.title ?? "Готово"}
                      </span>
                      <span className="job-side">
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
                  ) : (
                    <div className="job-row">
                      <div className="job-bar">
                        <span
                          style={{
                            width: job.status === "downloading" ? `${job.percent}%` : "100%",
                          }}
                        />
                      </div>
                      {job.status === "downloading" && (
                        <span className="job-side">{Math.round(job.percent)}%</span>
                      )}
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
          className={`icon stage-cut ${cutting ? "on" : ""}`}
          onClick={() => {
            setCutting((on) => !on);
            setCutFrom(null);
          }}
          title="Вырезать лишнее"
        >
          ✂
        </button>

        <button
          className="icon stage-help"
          onClick={() => setHelpOpen(true)}
          title="Клавиши"
        >
          ?
        </button>

        <button
          className="icon stage-toggle"
          onClick={() => setImmersive((on) => !on)}
          title={immersive ? "Показать коллекцию" : "Скрыть коллекцию"}
        >
          {immersive ? "⤡" : "⤢"}
        </button>

        {helpOpen && (
          <div className="help" onClick={() => setHelpOpen(false)}>
            <div className="help-card" onClick={(e) => e.stopPropagation()}>
              <h3 className="help-title">Клавиши</h3>
              <dl className="help-list">
                {[
                  ["Пробел", "Играть и пауза"],
                  ["← →", `Перемотка на ${SEEK_STEP} секунд`],
                  ["⇧ ← →", "Предыдущий и следующий трек"],
                  ["↑ ↓", "Громкость"],
                  ["M", "Заглушить"],
                  ["S", "Шафл"],
                  ["R", "Повтор"],
                  ["⌘F или /", "Поиск"],
                  ["Esc", "Закрыть и отменить"],
                  ["?", "Эта подсказка"],
                ].map(([keys, what]) => (
                  <div key={keys} className="help-row">
                    <dt>{keys}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
              <p className="help-note">Буквы работают в любой раскладке.</p>
            </div>
          </div>
        )}

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
              <span className="seek-wrap">
                {player.duration > 0 &&
                  current.cuts.map((cut, index) => (
                    <span
                      key={index}
                      className="seek-cut"
                      style={{
                        left: `${(cut.start / player.duration) * 100}%`,
                        width: `${((cut.end - cut.start) / player.duration) * 100}%`,
                      }}
                    />
                  ))}
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
              </span>
              <span className="time">{formatTime(player.duration)}</span>

              <button
                className="icon volume-icon"
                onClick={player.controls.toggleMute}
                title={player.muted ? "Включить звук" : "Заглушить"}
              >
                <VolumeIcon level={player.volume} muted={player.muted} />
              </button>

              <input
                className="volume"
                style={
                  {
                    "--vol": `${(player.muted ? 0 : player.volume) * 100}%`,
                  } as React.CSSProperties
                }
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={player.muted ? 0 : player.volume}
                aria-label="Громкость"
                onChange={(e) => player.controls.setVolume(Number(e.target.value))}
              />
            </div>


            {!cutting && current.cuts.length > 0 && (
              <div className="pending-cuts">
                <span>
                  Отмечено к вырезке: {current.cuts.length}. Пока только помечено — файл цел.
                </span>
                <button
                  className="mini primary"
                  onClick={() => applyCuts(current.id)}
                  disabled={applying}
                >
                  {applying ? "Режу…" : "Применить"}
                </button>
                <button className="mini" onClick={() => setCutting(true)}>
                  Править
                </button>
              </div>
            )}

            {cutting && (
              <div className="cutter">
                <div className="cutter-row">
                  {cutFrom === null ? (
                    <button className="mini" onClick={() => setCutFrom(player.position)}>
                      Начало вырезки
                    </button>
                  ) : (
                    <>
                      <span className="cutter-from">с {formatTime(cutFrom)}</span>
                      <button className="mini primary" onClick={() => finishCut(current)}>
                        Конец здесь
                      </button>
                      <button className="mini" onClick={() => setCutFrom(null)}>
                        Отмена
                      </button>
                    </>
                  )}
                </div>

                {current.cuts.length > 0 && (
                  <div className="cutter-list">
                    {current.cuts.map((cut, index) => (
                      <span key={index} className="cutter-item">
                        {formatTime(cut.start)} — {formatTime(cut.end)}
                        <button
                          className="cutter-drop"
                          title="Убрать отметку"
                          onClick={() =>
                            saveCuts(
                              current.id,
                              current.cuts.filter((_, i) => i !== index)
                            )
                          }
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <p className="cutter-note">
                  {current.cuts.length > 0
                    ? "Отмеченное уже пропускается при проигрывании. Послушай — и применяй."
                    : "Доведи ползунок до начала лишнего куска и отметь. Файл до применения не меняется."}
                </p>

                <div className="cutter-row">
                  <button
                    className="mini primary"
                    onClick={() => applyCuts(current.id)}
                    disabled={applying || current.cuts.length === 0}
                  >
                    {applying ? "Режу…" : "Применить к файлу"}
                  </button>
                  {current.original_path && (
                    <button
                      className="mini ghost"
                      onClick={() => resetCuts(current.id)}
                      disabled={applying}
                    >
                      Вернуть скачанное
                    </button>
                  )}
                </div>
              </div>
            )}

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
              onTimeUpdate={(e) => {
                const audio = e.currentTarget;
                // Отмеченное перепрыгивается на лету: результат слышен до
                // того, как файл будет тронут.
                const inside = current?.cuts.find(
                  (cut) => audio.currentTime >= cut.start && audio.currentTime < cut.end - 0.05
                );
                if (inside) {
                  audio.currentTime = inside.end;
                  return;
                }
                if (!scrubbing) player.setPosition(audio.currentTime);
              }}
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
