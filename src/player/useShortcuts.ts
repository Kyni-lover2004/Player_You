import { useEffect, useRef } from "react";
import { resolveShortcut, type ShortcutAction } from "./shortcuts";

/** Что делать по каждому распознанному действию. */
export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

/**
 * Привязывает горячие клавиши к окну.
 *
 * Вся логика разбора живёт в resolveShortcut и покрыта тестами; здесь
 * остаётся только подписка и отмена стандартного поведения.
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  // Объект обработчиков создаётся заново на каждой перерисовке, а их во время
  // проигрывания десятки в секунду. Через ссылку подписка живёт одна на всё
  // время работы окна.
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = resolveShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target as HTMLElement | null,
      });

      const handler = action && latest.current[action];
      if (!handler) return;

      // Пробел иначе прокрутит список, а стрелки уведут фокус.
      event.preventDefault();
      handler();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
