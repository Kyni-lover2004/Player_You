/**
 * Разбор горячих клавиш.
 *
 * Чистая функция отдельно от привязки к окну: так поведение проверяется
 * тестами, а не пальцами по всем сочетаниям.
 */

export type ShortcutAction =
  | "toggle"
  | "seekBack"
  | "seekForward"
  | "prev"
  | "next"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "shuffle"
  | "repeat"
  | "search"
  | "help"
  | "escape";

/** Минимум, который нужен от события клавиатуры. */
export type KeyEventLike = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
};

/** Шаг перемотки стрелками, в секундах. */
export const SEEK_STEP = 5;

/** Шаг громкости стрелками, доля от единицы. */
export const VOLUME_STEP = 0.05;

/** Идёт ли ввод текста прямо сейчас. */
export function isTyping(target: KeyEventLike["target"]): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Переводит событие клавиатуры в действие плеера.
 *
 * Возвращает null, когда трогать ничего не надо: во время набора текста,
 * на незнакомых клавишах и на любых системных сочетаниях. Последнее важно
 * отдельно — перехватить Cmd+Q значило бы сломать выход из приложения.
 */
export function resolveShortcut(event: KeyEventLike): ShortcutAction | null {
  const { key, shiftKey = false, metaKey = false, ctrlKey = false, altKey = false } = event;

  // Escape работает и в полях ввода: им закрывают поиск и формы.
  if (key === "Escape") return "escape";
  if (isTyping(event.target)) return null;

  // Единственное разрешённое системное сочетание — поиск.
  if (metaKey || ctrlKey) {
    return key.toLowerCase() === "f" ? "search" : null;
  }
  if (altKey) return null;

  switch (key) {
    case " ":
    case "Spacebar":
      return "toggle";
    case "ArrowLeft":
      return shiftKey ? "prev" : "seekBack";
    case "ArrowRight":
      return shiftKey ? "next" : "seekForward";
    case "ArrowUp":
      return "volumeUp";
    case "ArrowDown":
      return "volumeDown";
    case "/":
      return "search";
    case "?":
      return "help";
    default:
      break;
  }

  // Буквы разбираются без учёта раскладки и регистра — русская «ы» стоит
  // там же, где латинская «s», и плеер не должен об этом знать.
  switch (key.toLowerCase()) {
    case "s":
    case "ы":
      return "shuffle";
    case "r":
    case "к":
      return "repeat";
    case "m":
    case "ь":
      return "mute";
    default:
      return null;
  }
}
