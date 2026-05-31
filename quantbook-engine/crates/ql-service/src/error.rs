//! Phase 6.2-0 (2026-06-01) -- `EngineError` -> HTTP `application/problem+json`.
//!
//! Mirrors the napi `throw_structured` own-property set (`code`, `class`,
//! `retryable`, `details` as a JSON string, `source`) so the service error body
//! carries the SAME structured fields every other binding surfaces -- then maps the
//! `ErrorClass` to an RFC-7807 HTTP status. No error is ever swallowed: every
//! `EngineError` becomes a loud problem+json with the real code (No-Fallbacks).

use http::StatusCode;
use serde::{Deserialize, Serialize};

use ql_session::{EngineError, ErrorClass};

/// The `application/problem+json` body. Field set mirrors the napi structured
/// error own-properties (contract section 5.1): stable machine `code`, snake_case
/// `class`, `retryable`, optional `details` (JSON string, present only when the
/// engine attached structured context), optional `source` cause. `message` is the
/// human-readable text (RFC-7807 `detail`-equivalent).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemJson {
    pub code: String,
    pub class: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
}

/// Stable snake_case wire string for an [`ErrorClass`] (mirrors napi `class_str`
/// and the `ErrorClass` `#[serde(rename_all = "snake_case")]`).
pub fn class_str(c: ErrorClass) -> &'static str {
    match c {
        ErrorClass::BadArgument => "bad_argument",
        ErrorClass::Lifecycle => "lifecycle",
        ErrorClass::NotFound => "not_found",
        ErrorClass::Conflict => "conflict",
        ErrorClass::Compute => "compute",
        ErrorClass::Persistence => "persistence",
        ErrorClass::Protocol => "protocol",
        ErrorClass::Canceled => "canceled",
        ErrorClass::Capability => "capability",
        ErrorClass::Internal => "internal",
    }
}

/// Map an [`ErrorClass`] to an RFC-7807 HTTP status.
///
/// - `BadArgument`/`Protocol`/`Compute` -> 400 (malformed / unprocessable request).
/// - `NotFound` -> 404.
/// - `Conflict`/`Lifecycle`/`Canceled` -> 409 (state/operation conflict).
/// - `Capability` -> 501 (not implemented in v1 core).
/// - `Persistence`/`Internal` -> 500.
pub fn status_for_class(c: ErrorClass) -> StatusCode {
    match c {
        ErrorClass::BadArgument | ErrorClass::Protocol | ErrorClass::Compute => {
            StatusCode::BAD_REQUEST
        }
        ErrorClass::NotFound => StatusCode::NOT_FOUND,
        ErrorClass::Conflict | ErrorClass::Lifecycle | ErrorClass::Canceled => StatusCode::CONFLICT,
        ErrorClass::Capability => StatusCode::NOT_IMPLEMENTED,
        ErrorClass::Persistence | ErrorClass::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Build the `(status, body)` pair for an [`EngineError`]. `details` is rendered
/// as a JSON string only when non-empty (mirror of napi `throw_structured`); a
/// serialize failure is itself surfaced loudly as the details text rather than
/// dropped.
pub fn engine_error_to_problem(e: &EngineError) -> (StatusCode, ProblemJson) {
    let details = if e.details.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&e.details)
                .unwrap_or_else(|err| format!("[details serialize failed: {err}]")),
        )
    };
    let body = ProblemJson {
        code: e.code.clone(),
        class: class_str(e.class).to_string(),
        message: e.message.clone(),
        retryable: e.retryable,
        details,
        source: e.source.clone(),
    };
    (status_for_class(e.class), body)
}
