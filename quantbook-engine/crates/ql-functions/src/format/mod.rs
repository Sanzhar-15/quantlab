//! Excel number-format-string parser (Phase 4.5.D, W5-77b).
//!
//! Parses Excel format strings (e.g. `"#,##0.00"`, `"yyyy-mm-dd"`, `"@"`,
//! `"0;-0;\"zero\";@"`) into an AST suitable for a future renderer.
//!
//! Scope: parser only. Renderer + `FormatTable` + sparse cell overlay +
//! op-log shape land in subsequent Phase 4.5.D commits (≥W5-78). See
//! `docs/architecture/2026-05-13-format-string-grammar.md` for the
//! authoritative grammar and `docs/architecture/2026-05-13-dates-times-formats.md`
//! § 6 for the parent design.

pub mod ast;
pub mod error;
pub mod lexer;
pub mod parser;

pub use ast::{
    DigitKind, FormatString, MonthNameLen, MonthRole, NumberState, Section, SectionKind,
    SectionToken,
};
pub use error::{FormatParseError, V2Token};
pub use lexer::{tokenize, Token};
pub use parser::parse;
