import { describe, expect, it } from "vitest";
import { THEMES, contrast, deriveTokens, luminance, mix, themeById } from "./themes";

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
