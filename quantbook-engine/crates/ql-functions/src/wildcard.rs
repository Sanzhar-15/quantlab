//! Excel wildcard pattern matching (W5-61, Phase 4.3 polish).
//!
//! Excel supports two wildcards in criteria text:
//! - `?` — matches exactly one character
//! - `*` — matches zero or more characters
//!
//! The escape character is `~`:
//! - `~?` matches a literal `?`
//! - `~*` matches a literal `*`
//! - `~~` matches a literal `~`
//! - `~<anything else>` is treated as a literal `~` followed by the
//!   character (Excel's lenient handling)
//!
//! Matching is **case-insensitive** by Excel canon.
//!
//! Used by:
//! - `range_fns::build_predicate` — when SUMIF/COUNTIF/SUMIFS/AVERAGEIF
//!   criteria text contains unescaped wildcards.
//! - `scalar_fns::search` — wildcards in the find_text arg.
//!
//! NOT used by FIND (Excel canon: FIND is exact, no wildcard support).

/// A compiled wildcard pattern. Pre-normalized to uppercase so matching
/// is a single comparison per literal segment.
#[derive(Clone, Debug)]
pub struct WildcardPattern {
    parts: Vec<Part>,
}

#[derive(Clone, Debug)]
enum Part {
    /// Literal text (already uppercased).
    Literal(String),
    /// `?` — exactly one char.
    AnyOne,
    /// `*` — zero or more chars.
    Star,
}

impl WildcardPattern {
    /// Compile a criteria string into a wildcard pattern. Always
    /// succeeds (an empty pattern matches only the empty string).
    pub fn compile(s: &str) -> Self {
        let mut parts = Vec::new();
        let mut buf = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '~' => {
                    // Escape: peek at next. If it's ?, *, or ~, consume
                    // and append as literal. Otherwise treat ~ as
                    // literal (Excel's lenient handling).
                    match chars.peek() {
                        Some(&next) if next == '?' || next == '*' || next == '~' => {
                            buf.push(next);
                            chars.next();
                        }
                        _ => buf.push('~'),
                    }
                }
                '*' => {
                    if !buf.is_empty() {
                        parts.push(Part::Literal(std::mem::take(&mut buf).to_uppercase()));
                    }
                    // Collapse consecutive stars.
                    if !matches!(parts.last(), Some(Part::Star)) {
                        parts.push(Part::Star);
                    }
                }
                '?' => {
                    if !buf.is_empty() {
                        parts.push(Part::Literal(std::mem::take(&mut buf).to_uppercase()));
                    }
                    parts.push(Part::AnyOne);
                }
                other => buf.push(other),
            }
        }
        if !buf.is_empty() {
            parts.push(Part::Literal(buf.to_uppercase()));
        }
        WildcardPattern { parts }
    }

    /// Test whether `text` matches this pattern (case-insensitive,
    /// whole-string match).
    pub fn matches(&self, text: &str) -> bool {
        let upper = text.to_uppercase();
        let chars: Vec<char> = upper.chars().collect();
        match_parts(&chars, &self.parts)
    }

    /// Find the 1-based position of the first match of this pattern
    /// inside `haystack`, starting search at `start_idx_chars`
    /// (0-based char index). Returns None if no match found.
    ///
    /// Used by SEARCH. The pattern is anchored at each position; the
    /// match terminates greedily for `*` but the position of the match
    /// START is what's reported.
    pub fn search_in(&self, haystack: &str, start_idx_chars: usize) -> Option<usize> {
        let upper: Vec<char> = haystack.to_uppercase().chars().collect();
        if start_idx_chars > upper.len() {
            return None;
        }
        for i in start_idx_chars..=upper.len() {
            if match_prefix(&upper[i..], &self.parts) {
                return Some(i);
            }
        }
        None
    }
}

/// Whole-string match: pattern must consume entire input.
fn match_parts(text: &[char], parts: &[Part]) -> bool {
    match parts.split_first() {
        None => text.is_empty(),
        Some((Part::Literal(lit), rest)) => {
            let lit_chars: Vec<char> = lit.chars().collect();
            if text.len() < lit_chars.len() {
                return false;
            }
            if text[..lit_chars.len()] != lit_chars[..] {
                return false;
            }
            match_parts(&text[lit_chars.len()..], rest)
        }
        Some((Part::AnyOne, rest)) => {
            if text.is_empty() {
                return false;
            }
            match_parts(&text[1..], rest)
        }
        Some((Part::Star, rest)) => {
            // Try each suffix of `text` against `rest`.
            for i in 0..=text.len() {
                if match_parts(&text[i..], rest) {
                    return true;
                }
            }
            false
        }
    }
}

/// Prefix match: pattern must match a prefix of the input (rest is
/// ignored). Used for substring search via SEARCH.
fn match_prefix(text: &[char], parts: &[Part]) -> bool {
    match parts.split_first() {
        None => true, // Empty pattern matches the empty prefix.
        Some((Part::Literal(lit), rest)) => {
            let lit_chars: Vec<char> = lit.chars().collect();
            if text.len() < lit_chars.len() {
                return false;
            }
            if text[..lit_chars.len()] != lit_chars[..] {
                return false;
            }
            match_prefix(&text[lit_chars.len()..], rest)
        }
        Some((Part::AnyOne, rest)) => {
            if text.is_empty() {
                return false;
            }
            match_prefix(&text[1..], rest)
        }
        Some((Part::Star, rest)) => {
            for i in 0..=text.len() {
                if match_prefix(&text[i..], rest) {
                    return true;
                }
            }
            false
        }
    }
}

/// Detect whether `s` contains an unescaped wildcard character. Used
/// to decide whether to build a `WildcardPattern` vs a plain
/// `Predicate::Text`.
pub fn has_wildcards(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '~' {
            // Skip the escaped char (if any).
            chars.next();
            continue;
        }
        if c == '*' || c == '?' {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn star_matches_zero_or_more() {
        let p = WildcardPattern::compile("a*c");
        assert!(p.matches("ac"));
        assert!(p.matches("abc"));
        assert!(p.matches("abbbc"));
        assert!(!p.matches("ab"));
        assert!(!p.matches(""));
    }

    #[test]
    fn question_matches_exactly_one() {
        let p = WildcardPattern::compile("a?c");
        assert!(p.matches("abc"));
        assert!(p.matches("aXc"));
        assert!(!p.matches("ac"));
        assert!(!p.matches("abbc"));
    }

    #[test]
    fn case_insensitive_matching() {
        let p = WildcardPattern::compile("hello*");
        assert!(p.matches("Hello World"));
        assert!(p.matches("HELLO"));
        assert!(p.matches("hello"));
    }

    #[test]
    fn no_wildcards_acts_as_exact_match() {
        let p = WildcardPattern::compile("foo");
        assert!(p.matches("foo"));
        assert!(p.matches("FOO"));
        assert!(!p.matches("foobar"));
        assert!(!p.matches(""));
    }

    #[test]
    fn empty_pattern_matches_only_empty() {
        let p = WildcardPattern::compile("");
        assert!(p.matches(""));
        assert!(!p.matches("x"));
    }

    #[test]
    fn just_star_matches_anything() {
        let p = WildcardPattern::compile("*");
        assert!(p.matches(""));
        assert!(p.matches("x"));
        assert!(p.matches("hello world"));
    }

    #[test]
    fn escaped_question_is_literal() {
        let p = WildcardPattern::compile("a~?c");
        assert!(p.matches("a?c"));
        assert!(!p.matches("abc"));
    }

    #[test]
    fn escaped_star_is_literal() {
        let p = WildcardPattern::compile("a~*c");
        assert!(p.matches("a*c"));
        assert!(!p.matches("abc"));
    }

    #[test]
    fn escaped_tilde_is_literal() {
        let p = WildcardPattern::compile("a~~c");
        assert!(p.matches("a~c"));
    }

    #[test]
    fn consecutive_stars_collapse() {
        // `**foo**` should behave like `*foo*`.
        let p = WildcardPattern::compile("**foo**");
        assert!(p.matches("foo"));
        assert!(p.matches("XfooY"));
        assert!(p.matches("XXXXfooYYYY"));
    }

    #[test]
    fn star_in_middle() {
        let p = WildcardPattern::compile("a*b*c");
        assert!(p.matches("abc"));
        assert!(p.matches("axbyc"));
        assert!(p.matches("aXXXbYYYc"));
        assert!(!p.matches("ab"));
        assert!(!p.matches("ac"));
    }

    #[test]
    fn star_then_question() {
        let p = WildcardPattern::compile("*?");
        // At least one char.
        assert!(p.matches("x"));
        assert!(p.matches("hello"));
        assert!(!p.matches(""));
    }

    #[test]
    fn has_wildcards_detects_unescaped() {
        assert!(!has_wildcards("hello"));
        assert!(has_wildcards("hel*lo"));
        assert!(has_wildcards("hel?lo"));
        assert!(has_wildcards("*"));
        assert!(has_wildcards("?"));
    }

    #[test]
    fn has_wildcards_ignores_escaped() {
        assert!(!has_wildcards("hel~*lo"));
        assert!(!has_wildcards("hel~?lo"));
        assert!(!has_wildcards("~?~*~~"));
        // Mixed: one escaped + one unescaped → still wildcards.
        assert!(has_wildcards("hel~*lo*"));
    }

    #[test]
    fn search_in_finds_substring() {
        let p = WildcardPattern::compile("foo*");
        // "abcfoobar" — "foo*" starts at index 3 (0-based).
        assert_eq!(p.search_in("abcfoobar", 0), Some(3));
    }

    #[test]
    fn search_in_respects_start_index() {
        let p = WildcardPattern::compile("foo*");
        // Two "foo" — first at 0, second at 5.
        assert_eq!(p.search_in("foo_foobar", 0), Some(0));
        assert_eq!(p.search_in("foo_foobar", 1), Some(4));
    }

    #[test]
    fn search_in_no_match_returns_none() {
        let p = WildcardPattern::compile("zzz");
        assert_eq!(p.search_in("abcdef", 0), None);
    }

    #[test]
    fn search_in_question_pattern() {
        // "?o" matches any single char + "o".
        let p = WildcardPattern::compile("?o");
        // "fool" — "fo" matches at index 0.
        assert_eq!(p.search_in("fool", 0), Some(0));
    }
}
