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

/** Встроенные темы. Свои живут в хранилище и добавляются к ним. */
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
 * Наибольший контраст, достижимый на данном фоне.
 *
 * Величина не абстрактная: на фоне средней яркости ни белый, ни чёрный не
 * дают семи к одному, и требовать AAA от такой темы бессмысленно. В худшей
 * точке предел равен примерно 4.58 — то есть хуже AA не станет никогда.
 */
export function maxContrast(bg: string): number {
  return Math.max(contrast("#ffffff", bg), contrast("#000000", bg));
}

/**
 * Переломная яркость: по одну сторону от неё выигрывает белый текст,
 * по другую — чёрный. Ровно в точке оба дают около 4.58.
 */
const PIVOT = 0.179;

/**
 * Строит приподнятую поверхность, не переводя её через переломную яркость.
 *
 * Обычное правило простое: тёмной теме поверхности светлее, светлой темнее.
 * Но у фона, стоящего вплотную к перелому, осветление уводит поверхность на
 * другую сторону — и тогда фон требует одного цвета текста, а карточка
 * противоположного. Читаемым не будет ни то, ни другое, поэтому в таких
 * случаях поверхность уходит в обратную сторону.
 */
function elevate(bg: string, accent: string, step: number, accentPart: number): string {
  const below = luminance(bg) < PIVOT;
  const build = (toward: string) => mix(mix(bg, toward, step), accent, accentPart);

  const usual = build(below ? "#ffffff" : "#000000");
  if (luminance(usual) < PIVOT === below) return usual;

  const flipped = build(below ? "#000000" : "#ffffff");
  return luminance(flipped) < PIVOT === below ? flipped : usual;
}

/**
 * Подбирает цвет текста, читаемый на всех основаниях сразу.
 *
 * Оснований несколько не для красоты: текст лежит и на фоне, и на
 * приподнятых поверхностях. Ровно семь к одному на фоне означает меньше
 * семи на поверхности, которая светлее, — поэтому цель проверяется по
 * худшему основанию, а не по первому.
 *
 * Направление выбирается по фактическому контрасту, а не по порогу яркости:
 * на среднем фоне белый и чёрный меняются местами, и порог тут врёт.
 */
function readable(grounds: string[], minContrast: number): string {
  const base = grounds[0];

  /** Худший контраст, который даст крайность на всех основаниях сразу. */
  const reach = (toward: string) => Math.min(...grounds.map((ground) => contrast(toward, ground)));

  // Направление выбирается по худшему основанию, а не по фону: поверхность
  // с подмешанным акцентом может оказаться по другую сторону от переломной
  // яркости, и тогда выбор «по фону» уводит не туда.
  const toward = reach("#ffffff") >= reach("#000000") ? "#ffffff" : "#000000";

  // Цель не выше достижимого: требовать AAA там, где предел ниже,
  // означало бы крутить цикл до крайности впустую.
  const target = Math.min(minContrast, reach(toward));

  let t = 0.4;
  let color = mix(base, toward, t);

  while (grounds.some((ground) => contrast(color, ground) < target) && t < 1) {
    t = Math.min(1, t + 0.02);
    color = mix(base, toward, t);
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

  /** Приподнятая поверхность с каплей акцента: без неё фон везде был бы серым. */
  const surface = (step: number, accentPart: number) =>
    elevate(seed.bg, seed.accent, step, accentPart);

  const surface1 = surface(dark ? 0.06 : 0.04, 0.05);
  const surface2 = surface(dark ? 0.12 : 0.08, 0.07);

  // Текст лежит на всех трёх основаниях, поэтому проверяется по всем трём.
  const grounds = [seed.bg, surface1, surface2];
  const ceiling = Math.min(
    ...grounds.map((ground) => Math.max(contrast("#ffffff", ground), contrast("#000000", ground)))
  );

  return {
    "--bg": seed.bg,
    "--surface": surface1,
    "--surface-2": surface2,
    "--border": surface(dark ? 0.18 : 0.14, 0.08),
    // AAA для основного текста, AA для приглушённого — если фон это позволяет.
    // Приглушённый цепляется за долю доступного предела, иначе на среднем
    // фоне он слился бы с основным текстом: обоим досталось бы по максимуму.
    "--text": readable(grounds, 7),
    "--muted": readable(grounds, Math.min(4.5, ceiling * 0.72)),
    "--accent": seed.accent,
    "--accent-end": seed.accentEnd,
    "--accent-ink": inkFor(seed.accent),
    "--accent-gradient": `linear-gradient(135deg, ${seed.accent}, ${seed.accentEnd})`,
    "--ok": dark ? "#4ade80" : "#15803d",
    "--bad": dark ? "#f87171" : "#b91c1c",
  };
}

// ── Свои темы ────────────────────────────────────────────

const STORAGE_KEY = "omen.themes.custom";

/**
 * Хранилище тем.
 *
 * Вынесено параметром, чтобы логику можно было проверить без браузера:
 * тянуть ради этого целое окружение DOM в тесты было бы несоразмерно.
 */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ThemeStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Проверяет, что строка похожа на #rrggbb. */
function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Отбрасывает всё, что не похоже на тему: хранилище правят и руками. */
function sanitize(value: unknown): ThemeSeed | null {
  if (typeof value !== "object" || value === null) return null;
  const seed = value as Partial<ThemeSeed>;

  if (typeof seed.id !== "string" || !seed.id) return null;
  if (typeof seed.name !== "string" || !seed.name.trim()) return null;
  if (!isHex(seed.bg) || !isHex(seed.accent) || !isHex(seed.accentEnd)) return null;

  return { id: seed.id, name: seed.name.trim(), bg: seed.bg, accent: seed.accent, accentEnd: seed.accentEnd };
}

/** Читает свои темы из хранилища. Повреждённая запись не роняет приложение. */
export function loadCustomThemes(storage: ThemeStorage | null = defaultStorage()): ThemeSeed[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitize).filter((theme): theme is ThemeSeed => theme !== null);
  } catch {
    return [];
  }
}

/** Записывает свои темы в хранилище. */
export function saveCustomThemes(
  themes: ThemeSeed[],
  storage: ThemeStorage | null = defaultStorage()
): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(themes));
}

/** Свежий идентификатор для своей темы. */
export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Отличает свою тему от встроенной. */
export function isCustom(theme: ThemeSeed): boolean {
  return theme.id.startsWith("custom-");
}

/** Находит тему по идентификатору, откатываясь к теме по умолчанию. */
export function themeById(id: string | null, custom: ThemeSeed[] = loadCustomThemes()): ThemeSeed {
  return [...THEMES, ...custom].find((theme) => theme.id === id) ?? THEMES[0];
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
