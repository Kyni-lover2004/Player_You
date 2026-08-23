import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  type Action,
  type Deps,
  type PlayerState,
  type RepeatMode,
  initialState,
  randomShuffle,
  reduce,
} from "./machine";

/** Минимум, который связке нужно знать о треке. */
export type PlayableTrack = { id: number; missing: boolean };

const deps: Deps = { shuffle: randomShuffle };

/**
 * Связывает машину состояний с аудиоэлементом.
 *
 * Машина решает, что играть; связка решает, как это озвучить, и защищает
 * от гонок: загрузка файла асинхронна, а нажатия — нет.
 */
export function usePlayer(tracks: PlayableTrack[], sourceFor: (id: number) => string) {
  const [state, rawDispatch] = useReducer(
    (current: PlayerState, action: Action) => reduce(current, action, deps),
    undefined,
    initialState
  );

  const audioRef = useRef<HTMLAudioElement>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  /** Должен ли следующий запуск сразу заиграть. */
  const autoplay = useRef(false);
  /** Поколение, которое связка считает актуальным. */
  const liveGeneration = useRef(state.generation);

  liveGeneration.current = state.generation;

  const playableIds = useMemo(
    () => tracks.filter((track) => !track.missing).map((track) => track.id),
    [tracks]
  );

  useEffect(() => {
    rawDispatch({ type: "library", ids: playableIds });
  }, [playableIds]);

  /** Действие, после которого музыка должна звучать. */
  const dispatch = useCallback((action: Action) => {
    autoplay.current = true;
    rawDispatch(action);
  }, []);

  /** Действие, не меняющее факт звучания: режимы, очередь, библиотека. */
  const dispatchQuiet = useCallback((action: Action) => rawDispatch(action), []);

  // Смена поколения — единственный сигнал «начать трек с нуля».
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || state.currentId === null) return;

    const generation = state.generation;
    const source = sourceFor(state.currentId);

    if (audio.src !== source) {
      audio.src = source;
    }
    audio.currentTime = 0;
    setPosition(0);

    if (!autoplay.current) return;

    void audio.play().catch(() => {
      // Прерванная загрузка — нормальный исход быстрого перелистывания.
      // Реагировать на неё нельзя: актуальным остаётся последнее поколение.
      if (liveGeneration.current !== generation) return;
      setPlaying(false);
    });
    // sourceFor намеренно не в зависимостях: перерисовка родителя не должна
    // перезапускать трек. Триггером служит только поколение.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.generation, state.currentId]);

  // Список кончился, повтор выключен — останавливаемся.
  useEffect(() => {
    if (!state.atEnd) return;
    audioRef.current?.pause();
    autoplay.current = false;
  }, [state.atEnd]);

  const controls = {
    /** Ставит трек текущим и запускает его. */
    play: (id: number) => dispatch({ type: "play", id }),

    /** Включает альбом: первый трек играет, остальные встают в очередь. */
    playAll: (ids: number[]) => dispatch({ type: "playAll", ids }),

    /** Пауза и снятие с паузы. Перемотку это не затрагивает. */
    toggle: () => {
      const audio = audioRef.current;
      if (!audio || state.currentId === null) return;
      if (audio.paused) {
        autoplay.current = true;
        void audio.play().catch(() => setPlaying(false));
      } else {
        autoplay.current = false;
        audio.pause();
      }
    },

    next: () => dispatch({ type: "next", reason: "user" }),

    /** Порог в три секунды живёт в машине, сюда приходит только позиция. */
    prev: () => dispatch({ type: "prev", position: audioRef.current?.currentTime ?? 0 }),

    toggleShuffle: () => dispatchQuiet({ type: "toggleShuffle" }),
    cycleRepeat: () => dispatchQuiet({ type: "cycleRepeat" }),
    enqueue: (id: number) => dispatchQuiet({ type: "enqueue", id }),
    dequeue: (index: number) => dispatchQuiet({ type: "dequeue", index }),
    clearQueue: () => dispatchQuiet({ type: "clearQueue" }),

    /**
     * Перемотка. Позицию задаём напрямую аудиоэлементу: он сам сохраняет
     * паузу, если был на паузе, и не начинает играть от одного лишь seek.
     */
    seek: (seconds: number) => {
      const audio = audioRef.current;
      if (audio) audio.currentTime = seconds;
    },
  };

  /** Обработчики, которые вешаются на сам элемент audio. */
  const audioProps = {
    ref: audioRef,
    preload: "metadata" as const,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) =>
      setDuration(e.currentTarget.duration),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLAudioElement>) =>
      setPosition(e.currentTarget.currentTime),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    // Автопереход вешается только на настоящее окончание трека и ни на какую
    // арифметику по позиции: иначе перемотка в конец давала бы ложный переход.
    onEnded: () => dispatch({ type: "next", reason: "ended" }),
  };

  return {
    currentId: state.currentId,
    shuffle: state.shuffle,
    repeat: state.repeat as RepeatMode,
    queue: state.queue,
    queueLength: state.queue.length,
    atEnd: state.atEnd,
    playing,
    position,
    duration,
    setPosition,
    controls,
    audioProps,
  };
}
