import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
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
  const [current, setCurrent] = useState<Track | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [seekCheck, setSeekCheck] = useState<SeekCheck | null>(null);
  const pendingSeek = useRef<number | null>(null);

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

  /** Ставит трек текущим и сбрасывает состояние проигрывания. */
  function selectTrack(track: Track) {
    setCurrent(track);
    setPosition(0);
    setDuration(track.duration_secs ?? 0);
    setSeekCheck(null);
  }

  /** Переключает воспроизведение и паузу. */
  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  /**
   * Применяет перемотку и запоминает запрошенную позицию,
   * чтобы после события seeked сравнить её с фактической.
   */
  function commitSeek(value: number) {
    const audio = audioRef.current;
    setScrubbing(false);
    if (!audio) return;
    pendingSeek.current = value;
    audio.currentTime = value;
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
        {tracks.map((track) => (
          <button
            key={track.id}
            className={`track ${track.id === current?.id ? "active" : ""} ${track.missing ? "missing" : ""}`}
            onClick={() => selectTrack(track)}
            disabled={track.missing}
          >
            <Cover track={track} size="small" />
            <span className="track-text">
              <span className="track-title">{track.title}</span>
              <span className="track-artist">
                {track.missing ? "файла нет на диске" : track.artist ?? "исполнитель неизвестен"}
              </span>
            </span>
          </button>
        ))}
      </section>

      {current && (
        <footer className="player">
          <div className="now">
            <Cover track={current} size="large" />
            <span className="now-text">
              <strong>{current.title}</strong>
              {current.artist && <span className="now-artist">{current.artist}</span>}
            </span>
          </div>

          <div className="controls">
            <button className="play" onClick={togglePlay}>
              {playing ? "❚❚" : "▶"}
            </button>

            <span className="time">{formatTime(position)}</span>

            <input
              className="seek"
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={position}
              onPointerDown={() => setScrubbing(true)}
              onChange={(e) => setPosition(Number(e.target.value))}
              onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
            />

            <span className="time">{formatTime(duration)}</span>
          </div>

          {driftMs !== null && (
            <div className={`drift ${driftMs < 100 ? "good" : "bad"}`}>
              перемотка: просили {seekCheck!.requested.toFixed(2)} с, встали на{" "}
              {seekCheck!.actual.toFixed(2)} с — расхождение {driftMs.toFixed(0)} мс
            </div>
          )}

          <audio
            ref={audioRef}
            src={convertFileSrc(current.file_path)}
            preload="metadata"
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onTimeUpdate={(e) => !scrubbing && setPosition(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
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
