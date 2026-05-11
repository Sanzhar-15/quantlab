//! `ErrorValue` — the 14 error kinds the Quantbook engine surfaces, per spec Part V §2.
//!
//! Nine are Excel-equivalents (`#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NULL!`, `#NUM!`,
//! `#NAME?`, `#SPILL!`, `#CALC!`). Four are Quantbook-specific surfaces for kernel/connector
//! failures, and one is reserved for the AI cell function:
//! - `Disconnected` — terminal:// or external data source went away
//! - `Binding` — `qb.show(df)` BoundFrame coercion failed
//! - `Timeout` — UDF / connector exceeded its budget
//! - `Permission` — Workspace-Trust gate denied (kernel spawn / file read)
//! - `AINotAvailable` — parser-reserved error for `=AI(...)` until the v2 AI cell function ships
//!   (Round 7 CORR-06 / T4-D05; sigil `#AI_NOT_AVAILABLE_V1`)
//!
//! Phase 0 does NOT model `#NIMPL!`, `#CIRC!`, `#CANCEL!` — those come later (interpreter for
//! the first two; collab for the third).

use std::fmt;
use std::str::FromStr;

/// Excel + Quantbook error surface. Cheap (1 byte enum), `Copy`, structurally compared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorValue {
    /// `#REF!` — formula refers to a cell/range that no longer exists.
    Ref,
    /// `#VALUE!` — wrong-type argument (e.g. text where number expected, strict coercion).
    Value,
    /// `#N/A` — explicitly-not-available result (lookup miss).
    NA,
    /// `#DIV/0!` — division by zero / modulo zero.
    DivZero,
    /// `#NULL!` — intersection of two ranges is empty.
    Null,
    /// `#NUM!` — number out of range / NaN / infinity result.
    Num,
    /// `#NAME?` — unresolved name (named range, function, defined name).
    Name,
    /// `#SPILL!` — dynamic-array spill blocked (target region not empty, or merged cell).
    Spill,
    /// `#CALC!` — generic calculation error (LAMBDA recursion, empty array, etc.).
    Calc,
    /// `#DISCONNECTED!` — terminal:// or external data source unavailable. Quantbook-specific.
    Disconnected,
    /// `#BINDING!` — `qb.show(df)` round-trip coercion failed (df schema drift). Quantbook-specific.
    Binding,
    /// `#TIMEOUT!` — UDF or connector exceeded its budget. Quantbook-specific.
    Timeout,
    /// `#PERMISSION!` — Workspace-Trust gate denied an operation. Quantbook-specific.
    Permission,
    /// `#AI_NOT_AVAILABLE_V1` — `=AI(...)` is reserved keyword in Phase 0; the actual AI cell
    /// function ships in v2. Parser emits `Error(AINotAvailable)` on any `=AI(...)` formula
    /// entry. The `_V1` suffix marks this as a temporary error class — when v2 lands, callers
    /// can match-distinguish v1-era pre-AI formulas from real AI invocations.
    /// Round 7 CORR-06 / T4-D05.
    AINotAvailable,
}

impl ErrorValue {
    /// Excel-style sigil string, e.g. `"#REF!"`. Stable; safe to embed in serialized
    /// formats and to compare against in diagnostics.
    pub fn sigil(self) -> &'static str {
        match self {
            ErrorValue::Ref => "#REF!",
            ErrorValue::Value => "#VALUE!",
            ErrorValue::NA => "#N/A",
            ErrorValue::DivZero => "#DIV/0!",
            ErrorValue::Null => "#NULL!",
            ErrorValue::Num => "#NUM!",
            ErrorValue::Name => "#NAME?",
            ErrorValue::Spill => "#SPILL!",
            ErrorValue::Calc => "#CALC!",
            ErrorValue::Disconnected => "#DISCONNECTED!",
            ErrorValue::Binding => "#BINDING!",
            ErrorValue::Timeout => "#TIMEOUT!",
            ErrorValue::Permission => "#PERMISSION!",
            ErrorValue::AINotAvailable => "#AI_NOT_AVAILABLE_V1",
        }
    }

    /// All 14 variants in declaration order. Stable; used by exhaustiveness tests and the
    /// future error-surface UI.
    pub const ALL: [ErrorValue; 14] = [
        ErrorValue::Ref,
        ErrorValue::Value,
        ErrorValue::NA,
        ErrorValue::DivZero,
        ErrorValue::Null,
        ErrorValue::Num,
        ErrorValue::Name,
        ErrorValue::Spill,
        ErrorValue::Calc,
        ErrorValue::Disconnected,
        ErrorValue::Binding,
        ErrorValue::Timeout,
        ErrorValue::Permission,
        ErrorValue::AINotAvailable,
    ];
}

impl fmt::Display for ErrorValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.sigil())
    }
}

/// Parse from the Excel sigil (`#REF!`, `#VALUE!`, …) or the Quantbook-specific sigils.
/// Comparison is ASCII case-insensitive on the sigil (Excel itself preserves case in source
/// but is case-insensitive on parse).
impl FromStr for ErrorValue {
    type Err = ParseErrorValueError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // Search ALL — cheap (13 entries) and avoids hand-mapping mistakes.
        for e in ErrorValue::ALL {
            if s.eq_ignore_ascii_case(e.sigil()) {
                return Ok(e);
            }
        }
        Err(ParseErrorValueError {
            input: s.to_owned(),
        })
    }
}

/// Returned by `<ErrorValue as FromStr>::from_str` when the input isn't a known sigil.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseErrorValueError {
    pub input: String,
}

impl fmt::Display for ParseErrorValueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a recognized error sigil: {:?}", self.input)
    }
}

impl std::error::Error for ParseErrorValueError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_contains_fourteen_distinct_variants() {
        assert_eq!(ErrorValue::ALL.len(), 14);
        // Distinctness: convert to a set-shaped Vec of sigils and check.
        let mut sigils: Vec<&str> = ErrorValue::ALL.iter().map(|e| e.sigil()).collect();
        sigils.sort();
        sigils.dedup();
        assert_eq!(sigils.len(), 14);
    }

    #[test]
    fn sigil_excel_set_matches_excel_canonical_forms() {
        assert_eq!(ErrorValue::Ref.sigil(), "#REF!");
        assert_eq!(ErrorValue::Value.sigil(), "#VALUE!");
        assert_eq!(ErrorValue::NA.sigil(), "#N/A");
        assert_eq!(ErrorValue::DivZero.sigil(), "#DIV/0!");
        assert_eq!(ErrorValue::Null.sigil(), "#NULL!");
        assert_eq!(ErrorValue::Num.sigil(), "#NUM!");
        assert_eq!(ErrorValue::Name.sigil(), "#NAME?");
        assert_eq!(ErrorValue::Spill.sigil(), "#SPILL!");
        assert_eq!(ErrorValue::Calc.sigil(), "#CALC!");
    }

    #[test]
    fn sigil_quantbook_specific() {
        assert_eq!(ErrorValue::Disconnected.sigil(), "#DISCONNECTED!");
        assert_eq!(ErrorValue::Binding.sigil(), "#BINDING!");
        assert_eq!(ErrorValue::Timeout.sigil(), "#TIMEOUT!");
        assert_eq!(ErrorValue::Permission.sigil(), "#PERMISSION!");
        assert_eq!(ErrorValue::AINotAvailable.sigil(), "#AI_NOT_AVAILABLE_V1");
    }

    #[test]
    fn ai_not_available_parses_with_v1_suffix() {
        // CORR-06 / T4-D05: the parser-emitted sigil must round-trip identically.
        assert_eq!(
            "#AI_NOT_AVAILABLE_V1".parse::<ErrorValue>().unwrap(),
            ErrorValue::AINotAvailable
        );
        // ASCII case-insensitive (consistent with the other variants).
        assert_eq!(
            "#ai_not_available_v1".parse::<ErrorValue>().unwrap(),
            ErrorValue::AINotAvailable
        );
    }

    #[test]
    fn display_matches_sigil() {
        for e in ErrorValue::ALL {
            assert_eq!(format!("{e}"), e.sigil());
        }
    }

    #[test]
    fn from_str_roundtrips_all_variants() {
        for e in ErrorValue::ALL {
            assert_eq!(e.sigil().parse::<ErrorValue>().unwrap(), e);
        }
    }

    #[test]
    fn from_str_case_insensitive() {
        assert_eq!("#ref!".parse::<ErrorValue>().unwrap(), ErrorValue::Ref);
        assert_eq!("#Value!".parse::<ErrorValue>().unwrap(), ErrorValue::Value);
        assert_eq!("#n/A".parse::<ErrorValue>().unwrap(), ErrorValue::NA);
        assert_eq!(
            "#disconnected!".parse::<ErrorValue>().unwrap(),
            ErrorValue::Disconnected
        );
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert!("#NOTAREAL!".parse::<ErrorValue>().is_err());
        assert!("".parse::<ErrorValue>().is_err());
        assert!("REF".parse::<ErrorValue>().is_err());
        assert!("garbage".parse::<ErrorValue>().is_err());
    }

    #[test]
    fn parse_error_carries_input() {
        let e = "#NOPE".parse::<ErrorValue>().unwrap_err();
        assert_eq!(e.input, "#NOPE");
    }

    #[test]
    fn copy_is_actually_copy() {
        // Compile-time guard: ErrorValue is Copy. If someone adds a heap-bearing variant
        // this test refuses to compile.
        fn assert_copy<T: Copy>() {}
        assert_copy::<ErrorValue>();
        let a = ErrorValue::Ref;
        let b = a; // move-out-of-Copy is ok
        assert_eq!(a, b);
    }

    #[test]
    fn equality_is_structural() {
        assert_eq!(ErrorValue::DivZero, ErrorValue::DivZero);
        assert_ne!(ErrorValue::DivZero, ErrorValue::Num);
    }
}
