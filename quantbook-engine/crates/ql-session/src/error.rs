//! Structured error taxonomy (contract §5 + Appendix A; acceptance API6-03).
//!
//! Replaces the per-binding `[<kind>]`-prefix-on-Display workaround
//! (`crates/ql-bindings-node/src/lib.rs:306-349`, forced because napi-rs's
//! `Error` `Status` is an enum with no custom string code). Here the `code` is
//! carried as **data**, mapped once, consumed by every binding.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Coarse source category for an [`EngineError`]. Bindings map these to
/// JS/Python/C/HTTP/gRPC error shapes; tooling branches on `code`, humans read
/// `message` (contract §5.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    /// FFI-boundary validation failure (NaN/Inf/oversize/coercion).
    BadArgument,
    /// Illegal command for the current lifecycle state (incl. `session_busy`,
    /// `invalid_state`).
    Lifecycle,
    /// Sheet / cell / name / function / format absent.
    NotFound,
    /// Op/structure conflict (duplicate name, out-of-range move, etc.).
    Conflict,
    /// Formula/eval error surfaced as an op failure (a formula that *evaluates*
    /// to an error is a [`crate::dto::CellValue::Error`], NOT an `EngineError`;
    /// contract §5.5).
    Compute,
    /// Save / load / `.qbook` I/O.
    Persistence,
    /// DTO / version / decoding mismatch (incl. `invalid_version_token`,
    /// `unsupported_schema_version`).
    Protocol,
    /// Operation canceled or deadline exceeded.
    Canceled,
    /// Feature not available (collab disabled, `AINotAvailable`, …).
    Capability,
    /// Bug / invariant violation (panic boundary). Never a swallowed fallback.
    Internal,
}

/// The structured engine error crossing the contract boundary (contract §5.1).
///
/// `code` strings are **stable across releases** (public contract). Adding a
/// code is backward-compatible; renaming/removing one is breaking and bumps
/// [`crate::SCHEMA_VERSION`]. No catch-all "unknown" code may leak to a caller —
/// an unmapped engine variant is an [`ErrorClass::Internal`] bug to fix (§5.3).
// NOTE: not `Eq` — `details` holds `serde_json::Value`, which is `PartialEq` but
// not `Eq` (it can contain floats).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineError {
    /// Stable, machine-matchable code (e.g. `"bad_argument"`, `"sheet_not_found"`).
    pub code: String,
    /// Coarse source category.
    pub class: ErrorClass,
    /// Human-readable message (the prior Display string is preserved here).
    pub message: String,
    /// Structured context (failing op index, address, limit, …).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, serde_json::Value>,
    /// Whether a naive retry is meaningful.
    pub retryable: bool,
    /// Optional upstream cause chain (debug).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl EngineError {
    /// Construct a minimal error (no details, not retryable, no source).
    pub fn new(class: ErrorClass, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            class,
            message: message.into(),
            details: BTreeMap::new(),
            retryable: false,
            source: None,
        }
    }

    /// Builder: attach a structured detail key.
    #[must_use]
    pub fn with_detail(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.details.insert(key.into(), value);
        self
    }

    /// Builder: mark retryable.
    #[must_use]
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// Builder: attach an upstream cause string.
    #[must_use]
    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    // --- Common constructors (codes are part of the stable contract) ---

    /// FFI-boundary validation failure.
    pub fn bad_argument(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::BadArgument, "bad_argument", message)
    }

    /// Command issued in an illegal lifecycle state.
    pub fn invalid_state(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Lifecycle, "invalid_state", message)
    }

    /// Mutating/recalc command issued while a long operation owns engine state.
    pub fn session_busy(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Lifecycle, "session_busy", message)
    }

    /// A version token failed to decode / used an unsupported schema
    /// (contract §4.3 / MED-2 — fail-loud, never a silent resync).
    pub fn invalid_version_token(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Protocol, "invalid_version_token", message)
    }

    /// A DTO carried an unknown schema version (contract §4.1).
    pub fn unsupported_schema_version(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Protocol, "unsupported_schema_version", message)
    }

    /// Operation canceled (cooperative or pre-start).
    pub fn canceled(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Canceled, "canceled", message).retryable()
    }

    /// A panic was caught at the FFI boundary (contract §8).
    pub fn panic(message: impl Into<String>) -> Self {
        Self::new(ErrorClass::Internal, "panic", message)
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

/// Convenience alias for fallible session operations.
pub type EngineResult<T> = Result<T, EngineError>;
