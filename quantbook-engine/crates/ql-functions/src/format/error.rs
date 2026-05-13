//! Format-parse error categories.
//!
//! See `docs/architecture/2026-05-13-format-string-grammar.md` § 7 for the
//! authoritative variant list + diagnostic policy.

use std::fmt;

/// Specific V2-deferred token that surfaced in a V1 parse. The parser
/// emits one of these instead of silently accepting; V2 expansion in
/// Phase 4.10 or later flips them to real AST nodes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum V2Token {
    /// `[Red]`, `[Color 5]` etc.
    ColorCodes,
    /// `[>100]`, `[<=0]` etc.
    Conditional,
    /// `# ?/?` fraction format.
    Fraction,
    /// `[h]`, `[mm]`, `[ss]`, `[hh]`, `[mm]` elapsed-time placeholders.
    ElapsedTime,
}

impl fmt::Display for V2Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            V2Token::ColorCodes => "color codes ([Red]/[Color N])",
            V2Token::Conditional => "conditional sections ([>N]/[<=N])",
            V2Token::Fraction => "fraction format (# ?/?)",
            V2Token::ElapsedTime => "elapsed-time placeholders ([h]/[mm]/[ss])",
        };
        f.write_str(s)
    }
}

/// All ways `format::parse` can refuse an input string. Each variant
/// carries enough position info to surface a single-line diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FormatParseError {
    /// Empty input.
    Empty,
    /// More than 4 `;`-separated sections.
    TooManySections(usize),
    /// `"..."` block was not closed before end of input.
    UnterminatedQuotedText { position: usize },
    /// `\` appeared at end of string with nothing to escape.
    TrailingBackslash { position: usize },
    /// `_` or `*` at end of string with no following character.
    TrailingSpacerOrGhost { position: usize },
    /// `[...]` block we couldn't classify (not currency / color / condition).
    UnknownBracketBlock { position: usize, content: String },
    /// A token V2 will support but V1 does not.
    UnsupportedV2 { kind: V2Token, position: usize },
    /// Anything else; refined into specific variants as test fixtures find them.
    Other { position: usize, message: String },
}

impl fmt::Display for FormatParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatParseError::Empty => f.write_str("format string is empty"),
            FormatParseError::TooManySections(n) => {
                write!(f, "too many sections ({n}); Excel allows at most 4")
            }
            FormatParseError::UnterminatedQuotedText { position } => {
                write!(
                    f,
                    "unterminated \"...\" literal starting at position {position}"
                )
            }
            FormatParseError::TrailingBackslash { position } => {
                write!(f, "backslash at position {position} has nothing to escape")
            }
            FormatParseError::TrailingSpacerOrGhost { position } => {
                write!(
                    f,
                    "'_' or '*' at position {position} has no following character"
                )
            }
            FormatParseError::UnknownBracketBlock { position, content } => {
                write!(f, "unrecognized '[{content}]' block at position {position}")
            }
            FormatParseError::UnsupportedV2 { kind, position } => {
                write!(f, "V2-deferred token ({kind}) at position {position}")
            }
            FormatParseError::Other { position, message } => {
                write!(f, "parse error at position {position}: {message}")
            }
        }
    }
}

impl std::error::Error for FormatParseError {}
