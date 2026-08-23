/**
 * Машина состояний воспроизведения.
 *
 * Здесь нет ни React, ни аудиоэлемента: только чистые переходы. Восемь правил
 * из спеки живут именно тут, поэтому их можно проверить целиком, не запуская
 * приложение и не слушая ушами.
 */

export type RepeatMode = "off" | "all" | "one";

export type PlayerState = {
  /** Порядок библиотеки — исходный, как в списке на экране. */
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
  | { type: "next"; reason: "user" | "ended" }
  | { type: "prev"; position: number }
  | { type: "toggleShuffle" }
  | { type: "cycleRepeat" }
  | { type: "enqueue"; id: number }
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
    // по исходному порядку списка.
    const cursor = state.currentId === null ? -1 : state.order.indexOf(state.currentId);
    return { ...state, shuffle, playOrder: state.order, cursor };
  }

  // Включение: текущий остаётся играть и встаёт в начало нового порядка,
  // перемешивается всё остальное.
  const rest = state.order.filter((id) => id !== state.currentId);
  const shuffled = deps.shuffle(rest);
  const playOrder = state.currentId === null ? shuffled : [state.currentId, ...shuffled];

  return { ...state, shuffle, playOrder, cursor: state.currentId === null ? -1 : 0 };
}

/** Убирает трек из библиотеки, не обрывая его, если он играет. */
function removeTrack(state: PlayerState, id: number): PlayerState {
  const removedAt = state.playOrder.indexOf(id);

  const order = state.order.filter((x) => x !== id);
  const playOrder = state.playOrder.filter((x) => x !== id);
  const queue = state.queue.filter((x) => x !== id);

  let cursor = state.cursor;
  if (id === state.currentId) {
    // Трек доигрывает, но из списка уже исчез. Курсор встаёт перед тем,
    // что шло следом, чтобы следующий переход выдал именно его.
    cursor = removedAt - 1;
  } else if (removedAt !== -1 && removedAt < state.cursor) {
    cursor -= 1;
  }

  return { ...state, order, playOrder, queue, cursor };
}

/** Обновляет библиотеку, сохраняя текущий трек и очередь. */
function setLibrary(state: PlayerState, ids: number[], deps: Deps): PlayerState {
  const playOrder = state.shuffle ? deps.shuffle(ids) : ids;

  // Текущий трек не сбрасывается, даже если он выпал из библиотеки:
  // играющее не обрывается — то же правило, что и при удалении.
  return {
    ...state,
    order: ids,
    playOrder,
    cursor: state.currentId === null ? -1 : playOrder.indexOf(state.currentId),
    queue: state.queue.filter((id) => ids.includes(id)),
  };
}

/** Единственная точка перехода состояния. */
export function reduce(state: PlayerState, action: Action, deps: Deps): PlayerState {
  switch (action.type) {
    case "library":
      return setLibrary(state, action.ids, deps);
    case "play":
      return start(state, action.id, state.playOrder.indexOf(action.id));
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
    case "remove":
      return removeTrack(state, action.id);
  }
}
