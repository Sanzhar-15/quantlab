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
//! ## Unicode case-expansion divergence (W5-62 Codex audit M1)
//!
//! Rust's `to_uppercase()` can expand one Unicode scalar into MULTIPLE
//! chars (e.g. German `ß` → `SS`). Our matcher uppercases the entire
//! text and pattern before comparing, which means:
//!
//! 1. `?` (AnyOne) no longer maps to "exactly one ORIGINAL Unicode
//!    scalar" — it maps to "exactly one char of the uppercased
//!    buffer." A `?` consuming the second char of an expanded `ß → SS`
//!    leaves the first `S` unmatched, which is semantically odd.
//! 2. `WildcardPattern::search_in` returns positions in the
//!    UPPERCASED buffer. For chars that expand on uppercasing, the
//!    returned 1-based position drifts from the original-string
//!    position the caller expected.
//!
//! These are documented divergences from Excel's canon, pinned at
//! Phase 4.9 (Unicode/UTF-16 work). Same divergence class as the
//! existing UPPER/LOWER and LEN char-count notes.
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
///
/// **W5-62 audit closure (Sonnet HIGH H2 / Codex LOW L2):** The
/// prior recursive implementation backtracked exponentially on
/// pathological patterns like `a*a*a*a*a*a*a*a*a*a*b` over short
/// inputs. Sonnet measured 3.61s for a 30-char input. Switched to
/// the classic iterative two-pointer glob algorithm: track the
/// last-seen `*` position in pattern and the corresponding position
/// in text; on mismatch, roll back to (last star + 1, text idx + 1).
/// Worst case is O(n · m), with O(n + m) on typical inputs.
fn match_parts(text: &[char], parts: &[Part]) -> bool {
    iterative_glob(text, parts, /* prefix_ok = */ false)
}

/// Prefix match: pattern must match a prefix of the input (rest is
/// ignored). Used for substring search via SEARCH. Same iterative
/// algorithm with `prefix_ok = true` so reaching end-of-pattern with
/// leftover text counts as a match.
fn match_prefix(text: &[char], parts: &[Part]) -> bool {
    iterative_glob(text, parts, /* prefix_ok = */ true)
}

/// Iterative glob matcher with O(n·m) worst case (no exponential
/// backtracking). Handles `Literal`, `AnyOne`, and `Star` parts.
///
/// Algorithm: walk text and pattern in lockstep. When we hit a
/// `Star`, remember the pattern position (`star_pi`) and text
/// position (`star_ti`). On mismatch later, roll back to the slot
/// after the star, advancing text by one (i.e., star consumed one
/// more char). The check for pattern-completion happens at the top
/// of every loop iteration, so a successful end-match returns true
/// before any spurious backtrack.
fn iterative_glob(text: &[char], parts: &[Part], prefix_ok: bool) -> bool {
    let n = text.len();
    let m = parts.len();
    let mut ti = 0usize;
    let mut pi = 0usize;
    let mut star_pi: Option<usize> = None;
    let mut star_ti: usize = 0;

    loop {
        // Pattern done? Check for completion before doing anything
        // else. This is the critical fix vs the prior trace bug
        // where a successful match could fall into a backtrack.
        if pi == m {
            if prefix_ok || ti == n {
                return true;
            }
            // Whole-match wants ti == n but we have leftover text.
            // Try backtracking to last star to consume more.
            if let Some(sp) = star_pi {
                if star_ti < n {
                    pi = sp + 1;
                    star_ti += 1;
                    ti = star_ti;
                    continue;
                }
            }
            return false;
        }

        // Try to advance the current pattern part.
        let advanced = match &parts[pi] {
            Part::Literal(lit) => {
                let lit_chars: Vec<char> = lit.chars().collect();
                let lit_len = lit_chars.len();
                if ti + lit_len <= n && text[ti..ti + lit_len] == lit_chars[..] {
                    ti += lit_len;
                    pi += 1;
                    true
                } else {
                    false
                }
            }
            Part::AnyOne => {
                if ti < n {
                    ti += 1;
                    pi += 1;
                    true
                } else {
                    false
                }
            }
            Part::Star => {
                star_pi = Some(pi);
                star_ti = ti;
                pi += 1;
                true
            }
        };

        if advanced {
            continue;
        }

        // Mismatch — backtrack to last star (have it consume one
        // more char) and retry.
        if let Some(sp) = star_pi {
            if star_ti < n {
                pi = sp + 1;
                star_ti += 1;
                ti = star_ti;
                continue;
            }
        }
        return false;
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

    // W5-62: pathological-pattern perf regression test (Sonnet HIGH
    // H2). Pre-W5-62 recursive matcher took ~3.6s for the 30-char
    // input. The iterative algorithm should complete in <100ms.
    #[test]
    fn pathological_star_pattern_completes_quickly() {
        let pat = "a*a*a*a*a*a*a*a*a*a*b";
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 30 'a', no 'b'
        let p = WildcardPattern::compile(pat);
        let start = std::time::Instant::now();
        // No match (no 'b' in text).
        assert!(!p.matches(text));
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "pathological pattern took {elapsed:?}, expected <100ms; \
             check for backtracking regression in iterative_glob"
        );
    }

    #[test]
    fn trailing_star_after_match() {
        // Regression for the trace bug: "*c" against "abc" should
        // match (end-of-pattern check must precede backtrack).
        let p = WildcardPattern::compile("*c");
        assert!(p.matches("abc"));
        assert!(p.matches("c"));
        assert!(!p.matches("ab"));
    }

    #[test]
    fn multi_star_with_partial_literal() {
        // "a*b*c" against various inputs.
        let p = WildcardPattern::compile("a*b*c");
        assert!(p.matches("abc"));
        assert!(p.matches("a_b_c"));
        assert!(p.matches("aXXXbYYYc"));
        assert!(p.matches("abbc")); // a, then '' covered by *, then 'b', '', 'c'.
        assert!(!p.matches("a")); // need 'b' and 'c' after.
        assert!(!p.matches("ac")); // no 'b'.
    }
}
