import { describe, expect, it } from "vitest";
import {
  THEMES,
  contrast,
  deriveTokens,
  isCustom,
  loadCustomThemes,
  luminance,
  mix,
  newThemeId,
  saveCustomThemes,
  themeById,
  maxContrast,
} from "./themes";

describe("работа с цветом", () => {
  it("смешивание на краях даёт исходные цвета", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("середина между чёрным и белым — серый", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("яркость чёрного и белого известна точно", () => {
    expect(luminance("#000000")).toBeCloseTo(0, 5);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("контраст чёрного с белым — максимальные 21", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });
});

describe("все встроенные темы читаемы", () => {
  // Это и есть проверка обещания из спеки: текст не задаётся руками, он
  // выводится из фона, поэтому нечитаемой темы не может появиться в принципе.
  it.each(THEMES)("$name: основной текст держит контраст AAA", (theme) => {
    const tokens = deriveTokens(theme);
    expect(contrast(tokens["--text"], tokens["--bg"])).toBeGreaterThanOrEqual(7);
  });

  it.each(THEMES)("$name: приглушённый текст держит контраст AA", (theme) => {
    const tokens = deriveTokens(theme);
    expect(contrast(tokens["--muted"], tokens["--bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("$name: текст поверх акцента читается", (theme) => {
    const tokens = deriveTokens(theme);
    expect(contrast(tokens["--accent-ink"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("$name: поверхности отличаются от фона, но не спорят с текстом", (theme) => {
    const tokens = deriveTokens(theme);
    expect(tokens["--surface"]).not.toBe(tokens["--bg"]);
    expect(contrast(tokens["--text"], tokens["--surface"])).toBeGreaterThanOrEqual(6);
  });
});

describe("выбор темы", () => {
  it("неизвестный идентификатор откатывается к теме по умолчанию", () => {
    expect(themeById("такой-темы-нет").id).toBe(THEMES[0].id);
    expect(themeById(null).id).toBe(THEMES[0].id);
  });

  it("идентификаторы тем уникальны", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it("тем ровно десять", () => {
    expect(THEMES).toHaveLength(10);
  });
});

describe("свои темы", () => {
  /** Хранилище в памяти: логика проверяется без браузера. */
  function fakeStorage(initial?: string) {
    let value = initial ?? null;
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
      read: () => value,
    };
  }

  const seed = {
    id: "custom-abc",
    name: "Своя",
    bg: "#101820",
    accent: "#ffcc00",
    accentEnd: "#ff6600",
  };

  it("тема переживает запись и чтение", () => {
    const storage = fakeStorage();
    saveCustomThemes([seed], storage);
    expect(loadCustomThemes(storage)).toEqual([seed]);
  });

  it("пустое хранилище даёт пустой список", () => {
    expect(loadCustomThemes(fakeStorage())).toEqual([]);
  });

  it("испорченная запись не роняет приложение", () => {
    expect(loadCustomThemes(fakeStorage("{это не json"))).toEqual([]);
    expect(loadCustomThemes(fakeStorage('{"не":"массив"}'))).toEqual([]);
  });

  it("записи с негодными цветами отбрасываются", () => {
    // Хранилище правят и руками, так что доверять ему нельзя.
    const broken = JSON.stringify([
      seed,
      { ...seed, id: "custom-bad", bg: "красный" },
      { ...seed, id: "custom-bad2", accent: "#xyz" },
      { ...seed, id: "custom-bad3", name: "   " },
      "вообще строка",
      null,
    ]);
    expect(loadCustomThemes(fakeStorage(broken))).toEqual([seed]);
  });

  it("своя тема находится по идентификатору", () => {
    expect(themeById("custom-abc", [seed]).name).toBe("Своя");
  });

  it("идентификаторы своих тем не повторяются", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newThemeId()));
    expect(ids.size).toBe(200);
  });

  it("своя тема отличается от встроенной", () => {
    expect(isCustom(seed)).toBe(true);
    expect(isCustom(THEMES[0])).toBe(false);
  });
});

describe("обещание читаемости держится на любых цветах", () => {
  /**
   * Перебор по сетке вместо случайных цветов: тест должен падать
   * воспроизводимо, а не через раз.
   */
  const samples: string[] = [];
  for (let r = 0; r < 256; r += 51) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 85) {
        samples.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }

  const tokensFor = (bg: string, accent = "#888888") =>
    deriveTokens({ id: "x", name: "x", bg, accent, accentEnd: accent });

  it(`перебирает ${samples.length} вариантов цвета`, () => {
    expect(samples.length).toBeGreaterThan(100);
  });

  it("предел контраста ни на одном фоне не опускается ниже AA", () => {
    // Арифметический факт, на котором держится всё обещание: даже в худшей
    // точке белый или чёрный дают около 4.58.
    for (const bg of samples) {
      expect(maxContrast(bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("основной текст читается на фоне и на всех поверхностях", () => {
    // Обещание формулируется так, как его почувствует человек: текст виден
    // везде, где лежит, — а не «функция достигла своей цели».
    for (const bg of samples) {
      const tokens = tokensFor(bg);
      for (const ground of ["--bg", "--surface", "--surface-2"]) {
        expect(contrast(tokens["--text"], tokens[ground])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("приглушённый текст остаётся различимым на любом основании", () => {
    for (const bg of samples) {
      const tokens = tokensFor(bg);
      for (const ground of ["--bg", "--surface", "--surface-2"]) {
        expect(contrast(tokens["--muted"], tokens[ground])).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("приглушённый текст не сливается с основным там, где есть запас", () => {
    for (const bg of samples) {
      if (maxContrast(bg) < 6) continue;
      const tokens = tokensFor(bg);
      expect(tokens["--muted"]).not.toBe(tokens["--text"]);
    }
  });

  it("текст поверх любого акцента читается", () => {
    for (const accent of samples) {
      const tokens = tokensFor("#0c0a11", accent);
      expect(contrast(tokens["--accent-ink"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
