/**
 * Машина состояний воспроизведения.
 *
 * Здесь нет ни React, ни аудиоэлемента: только чистые переходы. Правила из
 * спеки живут именно тут, поэтому их можно проверить целиком, не запуская
 * приложение и не слушая ушами.
 */

export type RepeatMode = "off" | "all" | "one";

/**
 * Откуда берётся порядок воспроизведения.
 *
 * Без контекста альбом играл бы «поверх» библиотечного порядка: пока хватает
 * очереди всё выглядит верно, а дальше перебор незаметно уходит в библиотеку.
 */
export type PlayContext = { kind: "library" } | { kind: "album"; id: number; title: string };

export type PlayerState = {
  /** Вся библиотека — к ней возвращаемся, выйдя из альбома. */
  libraryIds: number[];
  context: PlayContext;
  /** Идентификаторы текущего контекста в исходном порядке. */
  order: number[];
  /** Порядок воспроизведения: перемешанный либо равный order. */
  playOrder: number[];
  shuffle: boolean;
  repeat: RepeatMode;
  /** Что играет сейчас. */
  currentId: number | null;
  /**
   * Позиция в playOrder, от которой продолжится перебор.
   *
   * Может быть -1: так бывает после удаления играющего трека, и тогда
   * следующий переход выдаст нулевой элемент.
   */
  cursor: number;
  /** Ручная очередь «играть следующим». Шафл на неё не влияет. */
  queue: number[];
  /**
   * Растёт при каждом запуске трека с нуля.
   *
   * Это токен поколения: загрузка файла асинхронна, и без него трек,
   * пролистнутый две секунды назад, догрузился бы и заиграл поверх текущего.
   */
  generation: number;
  /** Список кончился, а повтор выключен. */
  atEnd: boolean;
};

export type Action =
  | { type: "library"; ids: number[] }
  | { type: "play"; id: number }
  | { type: "playContext"; context: PlayContext; ids: number[]; startId?: number }
  | { type: "next"; reason: "user" | "ended" }
  | { type: "prev"; position: number }
  | { type: "toggleShuffle" }
  | { type: "cycleRepeat" }
  | { type: "enqueue"; id: number }
  | { type: "dequeue"; index: number }
  | { type: "clearQueue" }
  | { type: "remove"; id: number };

/** Перемешиватель вынесен наружу, чтобы тесты были воспроизводимыми. */
export type Deps = { shuffle: (ids: number[]) => number[] };

/**
 * Порог кнопки «назад», в секундах.
 *
 * До него — предыдущий трек, после — начало текущего. Три секунды это
 * негласный стандарт: пользователь ждёт именно такого поведения.
 */
export const PREV_RESTART_THRESHOLD = 3;

/** Состояние пустого плеера. */
export function initialState(): PlayerState {
  return {
    libraryIds: [],
    context: { kind: "library" },
    order: [],
    playOrder: [],
    shuffle: false,
    repeat: "off",
    currentId: null,
    cursor: -1,
    queue: [],
    generation: 0,
    atEnd: false,
  };
}

/** Перемешивание Фишера — Йетса на копии массива. */
export function randomShuffle(ids: number[]): number[] {
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Собирает порядок воспроизведения, оставляя выбранный трек первым при шафле. */
function buildPlayOrder(
  ids: number[],
  shuffle: boolean,
  first: number | null,
  deps: Deps
): number[] {
  if (!shuffle) return ids;
  if (first === null || !ids.includes(first)) return deps.shuffle(ids);
  return [first, ...deps.shuffle(ids.filter((id) => id !== first))];
}

/** Запускает трек с нуля: меняет текущий и поднимает поколение. */
function start(state: PlayerState, id: number, cursor: number): PlayerState {
  return {
    ...state,
    currentId: id,
    cursor,
    generation: state.generation + 1,
    atEnd: false,
  };
}

/** Перезапускает текущий трек, не меняя позицию в списке. */
function restart(state: PlayerState): PlayerState {
  return { ...state, generation: state.generation + 1, atEnd: false };
}

/** Следующий цикл режима повтора. */
function nextRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}

/**
 * Переключает контекст и начинает воспроизведение с заданного трека.
 *
 * Очередь очищается: она означает «что играет дальше», а смена контекста
 * это как раз ответ на тот же вопрос, только целиком.
 */
function switchContext(
  state: PlayerState,
  context: PlayContext,
  ids: number[],
  startId: number | undefined,
  deps: Deps
): PlayerState {
  if (ids.length === 0) return state;

  const first = startId !== undefined && ids.includes(startId) ? startId : ids[0];
  const playOrder = buildPlayOrder(ids, state.shuffle, first, deps);

  return {
    ...start({ ...state, context, order: ids, playOrder, queue: [] }, first, playOrder.indexOf(first)),
  };
}

/** Переход к следующему треку. */
function advance(state: PlayerState, reason: "user" | "ended", deps: Deps): PlayerState {
  // Повтор одного действует только на естественное окончание трека.
  // Нажатие «вперёд» — явная воля, она сильнее режима, и режим не сбрасывается.
  if (reason === "ended" && state.repeat === "one" && state.currentId !== null) {
    return restart(state);
  }

  // Ручная очередь имеет приоритет над любым порядком, включая перемешанный.
  if (state.queue.length > 0) {
    const [next, ...rest] = state.queue;
    return { ...start(state, next, state.cursor), queue: rest };
  }

  const next = state.cursor + 1;
  if (next < state.playOrder.length) {
    return start(state, state.playOrder[next], next);
  }

  if (state.repeat === "all" && state.order.length > 0) {
    // Перемешиваем заново: второй круг по тому же случайному порядку
    // случайным уже не ощущается.
    const playOrder = state.shuffle ? deps.shuffle(state.order) : state.order;
    return { ...start(state, playOrder[0], 0), playOrder };
  }

  return { ...state, atEnd: true };
}

/** Переход к предыдущему треку либо к началу текущего. */
function goBack(state: PlayerState, position: number): PlayerState {
  if (position >= PREV_RESTART_THRESHOLD) {
    return restart(state);
  }

  const previous = state.cursor - 1;
  if (previous >= 0 && previous < state.playOrder.length) {
    return start(state, state.playOrder[previous], previous);
  }

  // Отступать некуда — начинаем текущий заново.
  return restart(state);
}

/** Пересобирает порядок воспроизведения при включении и выключении шафла. */
function applyShuffle(state: PlayerState, deps: Deps): PlayerState {
  const shuffle = !state.shuffle;

  if (!shuffle) {
    // Выключение: текущий трек доигрывает, следующим станет сосед
    // по исходному порядку контекста.
    const cursor = state.currentId === null ? -1 : state.order.indexOf(state.currentId);
    return { ...state, shuffle, playOrder: state.order, cursor };
  }

  // Включение: текущий остаётся играть и встаёт в начало нового порядка.
  const playOrder = buildPlayOrder(state.order, true, state.currentId, deps);
  return {
    ...state,
    shuffle,
    playOrder,
    cursor: state.currentId === null ? -1 : playOrder.indexOf(state.currentId),
  };
}

/** Убирает трек отовсюду, не обрывая его, если он играет. */
function removeTrack(state: PlayerState, id: number): PlayerState {
  const removedAt = state.playOrder.indexOf(id);

  const without = (ids: number[]) => ids.filter((x) => x !== id);

  let cursor = state.cursor;
  if (id === state.currentId) {
    // Трек доигрывает, но из списка уже исчез. Курсор встаёт перед тем,
    // что шло следом, чтобы следующий переход выдал именно его.
    cursor = removedAt - 1;
  } else if (removedAt !== -1 && removedAt < state.cursor) {
    cursor -= 1;
  }

  return {
    ...state,
    libraryIds: without(state.libraryIds),
    order: without(state.order),
    playOrder: without(state.playOrder),
    queue: without(state.queue),
    cursor,
  };
}

/**
 * Обновляет библиотеку.
 *
 * Пока играет альбом, его порядок не трогается: скачанный трек не должен
 * вклиниваться в середину сборника, который ты слушаешь.
 */
function setLibrary(state: PlayerState, ids: number[], deps: Deps): PlayerState {
  const queue = state.queue.filter((id) => ids.includes(id));

  if (state.context.kind !== "library") {
    return { ...state, libraryIds: ids, queue };
  }

  const playOrder = buildPlayOrder(ids, state.shuffle, state.currentId, deps);

  return {
    ...state,
    libraryIds: ids,
    order: ids,
    playOrder,
    cursor: state.currentId === null ? -1 : playOrder.indexOf(state.currentId),
    queue,
  };
}

/** Единственная точка перехода состояния. */
export function reduce(state: PlayerState, action: Action, deps: Deps): PlayerState {
  switch (action.type) {
    case "library":
      return setLibrary(state, action.ids, deps);
    case "play":
      // Выбор трека в коллекции возвращает плеер к библиотечному порядку:
      // иначе он продолжил бы перебирать альбом, который ты уже покинул.
      return switchContext(state, { kind: "library" }, state.libraryIds, action.id, deps);
    case "playContext":
      return switchContext(state, action.context, action.ids, action.startId, deps);
    case "next":
      return advance(state, action.reason, deps);
    case "prev":
      return goBack(state, action.position);
    case "toggleShuffle":
      return applyShuffle(state, deps);
    case "cycleRepeat":
      return { ...state, repeat: nextRepeat(state.repeat) };
    case "enqueue":
      return { ...state, queue: [...state.queue, action.id] };
    case "dequeue":
      // Убираем по позиции, а не по идентификатору: один и тот же трек
      // можно поставить в очередь дважды, и вынуть надо именно один.
      return {
        ...state,
        queue: state.queue.filter((_, index) => index !== action.index),
      };
    case "clearQueue":
      return { ...state, queue: [] };
    case "remove":
      return removeTrack(state, action.id);
  }
}
