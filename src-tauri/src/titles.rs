//! Чистка ютубных заголовков.
//!
//! Заголовок на YouTube — это не метаданные, а рекламная строка:
//! `ROCKET − Инкассатор (prod. by FRESCO)`, `Artist - Song (Official Video) [4K]`.
//! Задача модуля — вытащить из неё исполнителя и название, ничего не сломав.

/// Разобранный заголовок.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ParsedTitle {
    pub artist: Option<String>,
    pub title: String,
}

/// Символы, которыми на YouTube отделяют исполнителя от названия.
///
/// Их правда много: обычный дефис, минус U+2212 (именно он попался в первом
/// же скачанном треке), короткое и длинное тире, а также два редких собрата.
const DASHES: [char; 6] = ['-', '–', '—', '−', '‒', '―'];

/// Пометки, которые целиком выбрасываются вместе со своими скобками.
///
/// Сравнение точное, а не по вхождению: иначе `(Live at Wembley)` или
/// `(Acoustic)` погибли бы вместе с мусором, а их терять нельзя.
const NOISE: &[&str] = &[
    "official video",
    "official music video",
    "official audio",
    "official lyric video",
    "official visualizer",
    "official",
    "lyric video",
    "lyrics",
    "lyric",
    "audio",
    "video",
    "visualizer",
    "mv",
    "m/v",
    "hd",
    "hq",
    "full hd",
    "4k",
    "8k",
    "remaster",
    "remastered",
    "clip",
    "клип",
    "официальный клип",
    "премьера",
    "премьера клипа",
    "текст песни",
    "аудио",
    "видео",
    "официальное видео",
    "официальное аудио",
    "слова",
    "live audio",
    "subs",
    "eng subs",
    "eng sub",
    "rus sub",
    "subtitles",
    "субтитры",
    "перевод",
];

/// Похоже ли слово на отдельно стоящий год: 1900–2099.
fn is_year(word: &str) -> bool {
    let bare = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    bare.len() == 4
        && bare.chars().all(|c| c.is_ascii_digit())
        && bare
            .parse::<u32>()
            .map(|year| (1900..=2099).contains(&year))
            .unwrap_or(false)
}

/// Приводит содержимое скобок к виду, пригодному для сравнения с пометками.
///
/// Год выбрасывается: каналы пишут `[аудио 2024]`, `(Official Video 2019)`,
/// и без этого шага точное сравнение промахивается мимо каждого такого случая.
fn normalize_marker(inner: &str) -> String {
    inner
        .to_lowercase()
        .split_whitespace()
        .filter(|word| !is_year(word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Распознаёт содержимое скобок как мусор.
fn is_noise(inner: &str) -> bool {
    let lower = normalize_marker(inner);
    // Пустота после нормализации: скобки содержали только год либо ничего.
    if lower.is_empty() {
        return true;
    }
    // Продюсерский кредит: (prod. by FRESCO), (produced by ...).
    if lower.starts_with("prod.") || lower.starts_with("prod ") || lower.starts_with("produced by")
    {
        return true;
    }

    // Целиком — до разбиения: иначе "m/v" развалилось бы на "m" и "v"
    // и перестало бы распознаваться.
    if NOISE.contains(&lower.as_str()) {
        return true;
    }

    // Составные пометки: "Lyrics + Eng Subs", "Audio / Video".
    // Группа считается мусором, только если мусор — каждая её часть.
    let parts: Vec<&str> = lower
        .split(['+', '/', '|', ','])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    parts.len() > 1 && parts.iter().all(|part| NOISE.contains(part))
}

/// Возвращает парную закрывающую скобку.
fn closing_for(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        _ => None,
    }
}

/// Вырезает скобочные группы, содержимое которых распознано как мусор.
///
/// Вложенность учитывается, незакрытая скобка не считается группой —
/// иначе заголовок вида `Song (unfinished` потерял бы хвост.
fn strip_noise_brackets(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        let open = chars[i];
        let Some(close) = closing_for(open) else {
            out.push(open);
            i += 1;
            continue;
        };

        let mut depth = 1;
        let mut j = i + 1;
        while j < chars.len() && depth > 0 {
            if chars[j] == open {
                depth += 1;
            } else if chars[j] == close {
                depth -= 1;
            }
            j += 1;
        }

        if depth != 0 {
            // Пары нет — это обычный символ, а не группа.
            out.push(open);
            i += 1;
            continue;
        }

        let inner: String = chars[i + 1..j - 1].iter().collect();
        if !is_noise(&inner) {
            out.push(open);
            out.push_str(&inner);
            out.push(close);
        }
        i = j;
    }

    out
}

/// Убирает мусорные слова, стоящие в хвосте без скобок: `Song HD`, `Song 4K`.
fn strip_trailing_noise(input: &str) -> String {
    let mut words: Vec<&str> = input.split_whitespace().collect();
    while let Some(last) = words.last() {
        let lower = last.to_lowercase();
        let bare = lower.trim_matches(|c: char| !c.is_alphanumeric() && c != '/');
        if NOISE.contains(&bare) {
            words.pop();
        } else {
            break;
        }
    }
    words.join(" ")
}

/// Схлопывает повторные пробелы и обрезает висящие разделители по краям.
fn tidy(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| DASHES.contains(&c) || c.is_whitespace())
        .to_string()
}

/// Находит позицию первого разделителя, окружённого пробелами.
///
/// Пробелы обязательны: без них `Nu-Metal Band` развалилось бы на
/// исполнителя `Nu` и название `Metal Band`.
fn split_position(chars: &[char]) -> Option<usize> {
    (1..chars.len().saturating_sub(1)).find(|&i| {
        DASHES.contains(&chars[i]) && chars[i - 1].is_whitespace() && chars[i + 1].is_whitespace()
    })
}

/// Разбирает ютубный заголовок на исполнителя и название.
///
/// Если разделителя нет, исполнитель остаётся неизвестным, а весь
/// очищенный заголовок становится названием — выдумывать не будем.
pub fn parse(raw: &str) -> ParsedTitle {
    let cleaned = tidy(&strip_trailing_noise(&strip_noise_brackets(raw)));

    // Чистка съела всё — значит заголовок состоял из одних пометок.
    if cleaned.is_empty() {
        return ParsedTitle {
            artist: None,
            title: tidy(raw),
        };
    }

    let chars: Vec<char> = cleaned.chars().collect();
    let Some(pos) = split_position(&chars) else {
        return ParsedTitle {
            artist: None,
            title: cleaned,
        };
    };

    let artist = tidy(&chars[..pos].iter().collect::<String>());
    let title = tidy(&chars[pos + 1..].iter().collect::<String>());

    // Однобокий разбор хуже честного «не знаю».
    if artist.is_empty() || title.is_empty() {
        return ParsedTitle {
            artist: None,
            title: cleaned,
        };
    }

    ParsedTitle {
        artist: Some(artist),
        title,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(raw: &str) -> (Option<String>, String) {
        let p = parse(raw);
        (p.artist, p.title)
    }

    #[test]
    fn real_track_from_first_download() {
        // Здесь именно U+2212, тот самый минус из имени скачанного файла.
        let (artist, title) = parsed("ROCKET − Инкассатор (prod. by FRESCO)");
        assert_eq!(artist.as_deref(), Some("ROCKET"));
        assert_eq!(title, "Инкассатор");
    }

    #[test]
    fn strips_official_video_marker() {
        let (artist, title) = parsed("Artist - Song (Official Video)");
        assert_eq!(artist.as_deref(), Some("Artist"));
        assert_eq!(title, "Song");
    }

    #[test]
    fn strips_bracketed_and_trailing_noise() {
        let (artist, title) = parsed("Artist – Song [4K] HD");
        assert_eq!(artist.as_deref(), Some("Artist"));
        assert_eq!(title, "Song");
    }

    #[test]
    fn hyphen_inside_word_is_not_a_separator() {
        let (artist, title) = parsed("Nu-Metal Band - Song");
        assert_eq!(artist.as_deref(), Some("Nu-Metal Band"));
        assert_eq!(title, "Song");
    }

    #[test]
    fn keeps_meaningful_brackets() {
        let (artist, title) = parsed("Artist — Song (Live at Wembley)");
        assert_eq!(artist.as_deref(), Some("Artist"));
        assert_eq!(title, "Song (Live at Wembley)");
    }

    #[test]
    fn keeps_featuring() {
        let (_, title) = parsed("Artist - Song (feat. Someone)");
        assert_eq!(title, "Song (feat. Someone)");
    }

    #[test]
    fn no_separator_means_unknown_artist() {
        let (artist, title) = parsed("Просто название трека");
        assert_eq!(artist, None);
        assert_eq!(title, "Просто название трека");
    }

    #[test]
    fn splits_on_first_separator_only() {
        let (artist, title) = parsed("Artist - Song - Part Two");
        assert_eq!(artist.as_deref(), Some("Artist"));
        assert_eq!(title, "Song - Part Two");
    }

    #[test]
    fn collapses_extra_whitespace() {
        let (artist, title) = parsed("  Artist    -    Song   ");
        assert_eq!(artist.as_deref(), Some("Artist"));
        assert_eq!(title, "Song");
    }

    #[test]
    fn unclosed_bracket_survives() {
        let (_, title) = parsed("Song (unfinished");
        assert_eq!(title, "Song (unfinished");
    }

    #[test]
    fn title_made_of_noise_falls_back_to_raw() {
        let (artist, title) = parsed("(Official Video)");
        assert_eq!(artist, None);
        assert_eq!(title, "(Official Video)");
    }

    #[test]
    fn real_track_scriptonite_with_russian_marker() {
        // Настоящий заголовок со второго скачанного трека.
        let (artist, title) = parsed("Скриптонит - не расслабляйся [аудио 2024]");
        assert_eq!(artist.as_deref(), Some("Скриптонит"));
        assert_eq!(title, "не расслабляйся");
    }

    #[test]
    fn year_alone_in_brackets_is_noise() {
        let (_, title) = parsed("Artist - Song (2024)");
        assert_eq!(title, "Song");
    }

    #[test]
    fn year_does_not_make_meaningful_brackets_noise() {
        // «live» пометкой не считается, поэтому скобки должны уцелеть.
        let (_, title) = parsed("Artist - Song (Live 2024)");
        assert_eq!(title, "Song (Live 2024)");
    }

    #[test]
    fn english_marker_with_year_is_noise() {
        let (_, title) = parsed("Artist - Song (Official Video 2019)");
        assert_eq!(title, "Song");
    }

    #[test]
    fn compound_marker_is_noise() {
        // Настоящий заголовок с третьего скачанного трека.
        let (_, title) = parsed("TATU (Lyrics + Eng Subs)");
        assert_eq!(title, "TATU");
    }

    #[test]
    fn compound_group_survives_if_any_part_is_meaningful() {
        let (_, title) = parsed("Song (Lyrics + Live at Wembley)");
        assert_eq!(title, "Song (Lyrics + Live at Wembley)");
    }

    #[test]
    fn slash_marker_still_recognised() {
        // Проверка порядка: "m/v" должно ловиться целиком, до разбиения.
        let (_, title) = parsed("Artist - Song (M/V)");
        assert_eq!(title, "Song");
    }

    #[test]
    fn nested_brackets_are_handled() {
        let (_, title) = parsed("Song (Official Video (4K))");
        assert_eq!(title, "Song");
    }
}
