import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { usePlayer } from "./player/usePlayer";
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

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "error"; message: string };

/** Точность последней перемотки: куда просили и куда встали на самом деле. */
type SeekCheck = { requested: number; actual: number };

/** Превращает секунды в м:сс. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/** Квадратная обложка трека либо заглушка, если её ещё нет. */
function Cover({ track, size }: { track: Track; size: "small" | "large" }) {
  const className = `cover cover-${size}`;
  if (!track.cover_path) {
    return <div className={`${className} cover-empty`} aria-hidden />;
  }
  return (
    <img className={className} src={convertFileSrc(track.cover_path)} alt="" loading="lazy" />
  );
}

function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [tracks, setTracks] = useState<Track[]>([]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftArtist, setDraftArtist] = useState("");
  const [draftTitle, setDraftTitle] = useState("");

  const [scrubbing, setScrubbing] = useState(false);
  const [seekCheck, setSeekCheck] = useState<SeekCheck | null>(null);
  const pendingSeek = useRef<number | null>(null);

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
  const current = player.currentId === null ? null : byId.get(player.currentId) ?? null;

  const busy = status.kind === "working";

  /** Перечитывает библиотеку из базы. */
  async function refresh() {
    try {
      setTracks(await invoke<Track[]>("library"));
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  /** Скачивает трек по ссылке, затем обновляет библиотеку и выбирает новинку. */
  async function handleDownload() {
    if (!url.trim() || busy) return;
    setStatus({ kind: "working" });
    try {
      const track = await invoke<Track>("download_track", { url });
      setStatus({ kind: "idle" });
      setUrl("");
      await refresh();
      selectTrack(track);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Ставит трек текущим и запускает его. */
  function selectTrack(track: Track) {
    setSeekCheck(null);
    player.controls.play(track.id);
  }

  /** Открывает правку трека, заполняя форму текущими значениями. */
  function startEdit(track: Track) {
    setEditingId(track.id);
    setDraftArtist(track.artist ?? "");
    setDraftTitle(track.title);
  }

  /** Закрывает форму, ничего не сохраняя. */
  function cancelEdit() {
    setEditingId(null);
  }

  /** Заменяет трек в списке. Плеер подхватит правку сам: он берёт трек по id. */
  function applyUpdate(updated: Track) {
    setTracks((previous) => previous.map((t) => (t.id === updated.id ? updated : t)));
  }

  /** Сохраняет правку: трек помечается как правленный и выпадает из авточистки. */
  async function saveEdit(id: number) {
    if (!draftTitle.trim()) return;
    try {
      const updated = await invoke<Track>("save_track_title", {
        id,
        artist: draftArtist.trim() || null,
        title: draftTitle,
      });
      applyUpdate(updated);
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

  /**
   * Применяет перемотку и запоминает запрошенную позицию,
   * чтобы после события seeked сравнить её с фактической.
   */
  function commitSeek(value: number) {
    setScrubbing(false);
    pendingSeek.current = value;
    player.controls.seek(value);
  }

  const driftMs = seekCheck
    ? Math.abs(seekCheck.actual - seekCheck.requested) * 1000
    : null;

  return (
    <main className="shell">
      <header className="head">
        <h1 className="wordmark">Omen</h1>
        <div className="row">
          <input
            className="url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDownload()}
            placeholder="https://www.youtube.com/watch?v=..."
            spellCheck={false}
            disabled={busy}
          />
          <button className="go" onClick={handleDownload} disabled={busy || !url.trim()}>
            {busy ? "Качаю…" : "Скачать"}
          </button>
        </div>
        {busy && <p className="status working">yt-dlp работает. Окно при этом не замирает.</p>}
        {status.kind === "error" && (
          <p className="status error">
            Не вышло<br />
            <code>{status.message}</code>
          </p>
        )}
      </header>

      <section className="library">
        {tracks.length === 0 && <p className="empty">Пока пусто. Вставь ссылку выше.</p>}

        {tracks.map((track) =>
          editingId === track.id ? (
            <div key={track.id} className="track editing">
              <Cover track={track} size="small" />
              <div className="edit-form">
                <input
                  className="edit-input"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit(track.id);
                    if (e.key === "Escape") cancelEdit();
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
                    if (e.key === "Escape") cancelEdit();
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
                  <button className="mini" onClick={cancelEdit}>
                    Отмена
                  </button>
                  {track.edited && (
                    <button
                      className="mini ghost"
                      onClick={() => resetToAuto(track.id)}
                      title="Разобрать исходный заголовок заново"
                    >
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
                onClick={() => !track.missing && selectTrack(track)}
                disabled={track.missing}
              >
                <Cover track={track} size="small" />
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
                className="track-edit"
                onClick={() => player.controls.enqueue(track.id)}
                disabled={track.missing}
                title="Играть следующим"
              >
                ↴
              </button>
              <button className="track-edit" onClick={() => startEdit(track)} title="Править">
                ✎
              </button>
            </div>
          )
        )}
      </section>

      {current && (
        <footer className="player">
          <div className="now">
            <Cover track={current} size="large" />
            <span className="now-text">
              <strong>{current.title}</strong>
              {current.artist && <span className="now-artist">{current.artist}</span>}
            </span>
            {player.queueLength > 0 && (
              <span className="queue-badge" title="Треков в очереди">
                в очереди: {player.queueLength}
              </span>
            )}
          </div>

          <div className="controls">
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

            <button className="play" onClick={player.controls.toggle}>
              {player.playing ? "❚❚" : "▶"}
            </button>

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

          <div className="timeline">
            <span className="time">{formatTime(player.position)}</span>

            <input
              className="seek"
              type="range"
              min={0}
              max={player.duration || 0}
              step={0.01}
              value={player.position}
              onPointerDown={() => setScrubbing(true)}
              onChange={(e) => player.setPosition(Number(e.target.value))}
              onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
            />

            <span className="time">{formatTime(player.duration)}</span>
          </div>

          {player.atEnd && <div className="drift">список кончился, повтор выключен</div>}

          {driftMs !== null && (
            <div className={`drift ${driftMs < 100 ? "good" : "bad"}`}>
              перемотка: просили {seekCheck!.requested.toFixed(2)} с, встали на{" "}
              {seekCheck!.actual.toFixed(2)} с — расхождение {driftMs.toFixed(0)} мс
            </div>
          )}

          {/* src задаётся связкой императивно: смена поколения — единственный
              сигнал начать трек с нуля, и React тут только мешал бы. */}
          <audio
            {...player.audioProps}
            onTimeUpdate={(e) => !scrubbing && player.setPosition(e.currentTarget.currentTime)}
            onSeeked={(e) => {
              if (pendingSeek.current === null) return;
              setSeekCheck({
                requested: pendingSeek.current,
                actual: e.currentTarget.currentTime,
              });
              pendingSeek.current = null;
            }}
          />
        </footer>
      )}

    </main>
  );
}

export default App;
