import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "./App.css";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

/** Точность последней перемотки: куда просили и куда встали на самом деле. */
type SeekCheck = { requested: number; actual: number };

/** Превращает секунды в м:сс. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Достаёт имя файла из полного пути. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [tracks, setTracks] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [seekCheck, setSeekCheck] = useState<SeekCheck | null>(null);
  const pendingSeek = useRef<number | null>(null);

  const busy = status.kind === "working";

  /** Перечитывает каталог загрузок и обновляет список треков. */
  async function refreshTracks() {
    try {
      setTracks(await invoke<string[]>("list_tracks"));
    } catch (error) {
      console.error("не удалось прочитать каталог загрузок", error);
    }
  }

  useEffect(() => {
    refreshTracks();
  }, []);

  /** Отправляет ссылку в Rust, затем обновляет список и выбирает новый трек. */
  async function handleDownload() {
    if (!url.trim() || busy) return;
    setStatus({ kind: "working" });
    try {
      const path = await invoke<string>("download_track", { url });
      setStatus({ kind: "done", path });
      await refreshTracks();
      setCurrent(path);
    } catch (error) {
      setStatus({ kind: "error", message: String(error) });
    }
  }

  /** Ставит трек текущим и сбрасывает позицию. */
  function selectTrack(path: string) {
    setCurrent(path);
    setPosition(0);
    setDuration(0);
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
        {status.kind === "working" && (
          <p className="status working">yt-dlp работает. Окно при этом не должно замирать.</p>
        )}
        {status.kind === "error" && (
          <p className="status error">
            Не вышло<br />
            <code>{status.message}</code>
          </p>
        )}
      </header>

      <section className="library">
        {tracks.length === 0 && <p className="empty">Пока пусто. Вставь ссылку выше.</p>}
        {tracks.map((path) => (
          <button
            key={path}
            className={`track ${path === current ? "active" : ""}`}
            onClick={() => selectTrack(path)}
          >
            {basename(path)}
          </button>
        ))}
      </section>

      {current && (
        <footer className="player">
          <div className="now">{basename(current)}</div>

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
            src={convertFileSrc(current)}
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
            onError={(e) => {
              const err = e.currentTarget.error;
              setStatus({
                kind: "error",
                message: `аудио не загрузилось (код ${err?.code ?? "?"}). Проверь область asset-протокола.`,
              });
            }}
          />
        </footer>
      )}
    </main>
  );
}

export default App;
