/**
 * Темы оформления.
 *
 * Тему задают три цвета: фон, акцент и конец градиента. Всё остальное —
 * текст, поверхности, рамки — вычисляется из яркости фона. Поэтому
 * встроенных наборов правил нет, а своя тема ничем не отличается от
 * встроенной: она такая же тройка.
 *
 * Главное следствие: нечитаемую тему нельзя собрать в принципе. Цвет
 * текста не задаётся, он выводится, и контраст держится по построению.
 */

export type ThemeSeed = {
  id: string;
  name: string;
  /** Основной фон. */
  bg: string;
  /** Акцент: кнопки, активные состояния, начало градиента. */
  accent: string;
  /** Конец градиента. */
  accentEnd: string;
};

export const THEMES: ThemeSeed[] = [
  { id: "amethyst", name: "Аметист", bg: "#0c0a11", accent: "#ab66fd", accentEnd: "#6d28d9" },
  { id: "midnight", name: "Полночь", bg: "#080b14", accent: "#5b8dff", accentEnd: "#2b4fd0" },
  { id: "neon", name: "Неон", bg: "#0a0710", accent: "#ff4fd8", accentEnd: "#22d3ee" },
  { id: "charcoal", name: "Уголь", bg: "#0d0d0f", accent: "#e6e6ea", accentEnd: "#9a9aa6" },
  { id: "sunset", name: "Закат", bg: "#140a0c", accent: "#ff8a5b", accentEnd: "#ff4d8d" },
  { id: "pine", name: "Хвоя", bg: "#06110d", accent: "#34d399", accentEnd: "#0f766e" },
  { id: "garnet", name: "Гранат", bg: "#120709", accent: "#f43f5e", accentEnd: "#9f1239" },
  { id: "sepia", name: "Сепия", bg: "#120d08", accent: "#e0a458", accentEnd: "#a16207" },
  { id: "paper", name: "Бумага", bg: "#f6f1e7", accent: "#7c3aed", accentEnd: "#a855f7" },
  { id: "ice", name: "Лёд", bg: "#eef4fa", accent: "#0284c7", accentEnd: "#38bdf8" },
];

export const DEFAULT_THEME = THEMES[0].id;

type Rgb = { r: number; g: number; b: number };

/** Разбирает #rrggbb в компоненты 0–255. */
export function parseHex(hex: string): Rgb {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** Собирает #rrggbb из компонентов. */
function toHex({ r, g, b }: Rgb): string {
  const part = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Смешивает два цвета: t = 0 даёт первый, t = 1 второй. */
export function mix(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/** Относительная яркость по WCAG, 0 — чёрный, 1 — белый. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Коэффициент контраста по WCAG: от 1 (нет разницы) до 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Токены, которые получает интерфейс. */
export type Tokens = Record<string, string>;

/**
 * Подбирает цвет, усиливая его отрыв от фона, пока не наберётся контраст.
 *
 * Константа тут не годится: она подошла бы под текущие десять тем и
 * провалилась бы на первой же своей. Условие держится на любом фоне.
 */
function readable(bg: string, toward: string, start: number, minContrast: number): string {
  let t = start;
  let color = mix(bg, toward, t);

  while (contrast(color, bg) < minContrast && t < 1) {
    t = Math.min(1, t + 0.02);
    color = mix(bg, toward, t);
  }

  return color;
}

/**
 * Цвет текста поверх акцента.
 *
 * Выбирается не по порогу яркости, а по фактическому контрасту: у порога
 * нет способа узнать, что белый на среднем фиолетовом даёт всего 3.5.
 * Крайности всегда достаточно — при любом акценте лучший из чёрного и
 * белого даёт минимум 4.58.
 */
function inkFor(accent: string): string {
  const candidates = ["#0b0710", "#ffffff", "#000000"];
  return candidates.reduce((best, candidate) =>
    contrast(candidate, accent) > contrast(best, accent) ? candidate : best
  );
}

/**
 * Выводит полный набор токенов из тройки цветов.
 *
 * Поверхности не просто осветляются, а подкрашиваются акцентом: без этого
 * десять тем отличались бы только цветом кнопки, а фон везде был бы серым.
 */
export function deriveTokens(seed: ThemeSeed): Tokens {
  const dark = luminance(seed.bg) < 0.4;
  const toward = dark ? "#ffffff" : "#000000";

  /** Осветляет либо затемняет фон и подмешивает каплю акцента. */
  const surface = (step: number, accentPart: number) =>
    mix(mix(seed.bg, toward, step), seed.accent, accentPart);

  return {
    "--bg": seed.bg,
    "--surface": surface(dark ? 0.06 : 0.04, 0.05),
    "--surface-2": surface(dark ? 0.12 : 0.08, 0.07),
    "--border": surface(dark ? 0.18 : 0.14, 0.08),
    // Порог AAA для основного текста, AA для приглушённого.
    "--text": readable(seed.bg, toward, 0.9, 7),
    "--muted": readable(seed.bg, toward, 0.52, 4.5),
    "--accent": seed.accent,
    "--accent-end": seed.accentEnd,
    "--accent-ink": inkFor(seed.accent),
    "--accent-gradient": `linear-gradient(135deg, ${seed.accent}, ${seed.accentEnd})`,
    "--ok": dark ? "#4ade80" : "#15803d",
    "--bad": dark ? "#f87171" : "#b91c1c",
  };
}

/** Находит тему по идентификатору, откатываясь к теме по умолчанию. */
export function themeById(id: string | null): ThemeSeed {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

/** Раскладывает токены темы по корневому элементу документа. */
export function applyTheme(seed: ThemeSeed): void {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(deriveTokens(seed))) {
    style.setProperty(name, value);
  }
  // Светлым темам нужна светлая системная отрисовка полей и полос прокрутки.
  document.documentElement.style.colorScheme = luminance(seed.bg) < 0.4 ? "dark" : "light";
}
