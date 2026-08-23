import { describe, expect, it } from "vitest";
import { isTyping, resolveShortcut, type KeyEventLike } from "./shortcuts";

/** Событие с настройками по умолчанию: фокус не в поле ввода. */
function press(key: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, target: { tagName: "DIV" }, ...extra };
}

describe("основные клавиши", () => {
  it("пробел переключает воспроизведение", () => {
    expect(resolveShortcut(press(" "))).toBe("toggle");
  });

  it("стрелки влево и вправо перематывают", () => {
    expect(resolveShortcut(press("ArrowLeft"))).toBe("seekBack");
    expect(resolveShortcut(press("ArrowRight"))).toBe("seekForward");
  });

  it("с шифтом стрелки переключают треки", () => {
    expect(resolveShortcut(press("ArrowLeft", { shiftKey: true }))).toBe("prev");
    expect(resolveShortcut(press("ArrowRight", { shiftKey: true }))).toBe("next");
  });

  it("стрелки вверх и вниз меняют громкость", () => {
    expect(resolveShortcut(press("ArrowUp"))).toBe("volumeUp");
    expect(resolveShortcut(press("ArrowDown"))).toBe("volumeDown");
  });

  it("буквы включают режимы", () => {
    expect(resolveShortcut(press("s"))).toBe("shuffle");
    expect(resolveShortcut(press("r"))).toBe("repeat");
    expect(resolveShortcut(press("m"))).toBe("mute");
  });

  it("регистр не имеет значения", () => {
    expect(resolveShortcut(press("S"))).toBe("shuffle");
    expect(resolveShortcut(press("R"))).toBe("repeat");
  });

  it("русская раскладка работает наравне с латинской", () => {
    // «ы» стоит на той же клавише, что «s», и плеер не должен требовать
    // переключать язык, чтобы включить шафл.
    expect(resolveShortcut(press("ы"))).toBe("shuffle");
    expect(resolveShortcut(press("к"))).toBe("repeat");
    expect(resolveShortcut(press("ь"))).toBe("mute");
  });
});

describe("ввод текста", () => {
  const input = { tagName: "INPUT" };

  it("клавиши не срабатывают, пока набираешь текст", () => {
    // Иначе пробел в поле поиска ставил бы музыку на паузу.
    expect(resolveShortcut(press(" ", { target: input }))).toBeNull();
    expect(resolveShortcut(press("s", { target: input }))).toBeNull();
    expect(resolveShortcut(press("ArrowLeft", { target: input }))).toBeNull();
  });

  it("Escape работает и в поле ввода", () => {
    expect(resolveShortcut(press("Escape", { target: input }))).toBe("escape");
  });

  it("текстовая область и редактируемый блок считаются вводом", () => {
    expect(isTyping({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: "BUTTON" })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe("системные сочетания", () => {
  it("Cmd+F открывает поиск", () => {
    expect(resolveShortcut(press("f", { metaKey: true }))).toBe("search");
    expect(resolveShortcut(press("f", { ctrlKey: true }))).toBe("search");
  });

  it("прочие сочетания с Cmd не перехватываются", () => {
    // Перехватить Cmd+Q значило бы сломать выход из приложения.
    for (const key of ["q", "w", "a", "c", "v", "z", " "]) {
      expect(resolveShortcut(press(key, { metaKey: true }))).toBeNull();
    }
  });

  it("сочетания с Alt не перехватываются", () => {
    expect(resolveShortcut(press("s", { altKey: true }))).toBeNull();
  });

  it("незнакомая клавиша не даёт действия", () => {
    for (const key of ["F5", "Tab", "x", "1", "Enter"]) {
      expect(resolveShortcut(press(key))).toBeNull();
    }
  });
});
