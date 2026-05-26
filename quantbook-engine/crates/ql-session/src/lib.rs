//! `ql-session` — the binding-neutral **engine session contract** (Phase 6.1B).
//!
//! This crate is the Rust realization of `docs/api/session-api.md` (the 6.1A
//! contract, Codex-validated v2). It defines the single [`EngineSession`] trait
//! and the versioned DTOs / error taxonomy / operation-lifecycle types that
//! **all** product surfaces bind to:
//!
//! - bindings (`ql-bindings-node`, `ql-bindings-wasm`, `ql-bindings-c`,
//!   `quantbook-py`) are thin adapters that marshal these DTOs and map
//!   [`EngineError`] — they do NOT invent their own command/error/event shapes;
//! - the service (`ql-service`) exposes the same contract over a wire.
//!
//! ## Status (6.1B increment 1)
//!
//! This is the **type-level skeleton**: the trait signatures + DTOs + error +
//! operation/lifecycle types. It compiles with no implementation. The owning
//! `WorkbookSession` that *implements* [`EngineSession`] (wrapping `WorkbookRuntime`,
//! `OpLog`, `CalcgraphSession`, `PlanCache`, and `FunctionRegistry`), the
//! session-owned `PlanCache` refactor, and the Node-smoke-path migration are
//! later 6.1B increments (see `docs/api/session-api.md` §12 + `.plans/_active.md`).
//!
//! ## Scope discipline
//!
//! This is the **single-writer product session**. The collaborative layer
//! (`ql-collab` CRDT merge / transport / presence) is v1.5-deferred and rides on
//! top of the same op-log — it is NOT part of this trait (contract §3.10).
//!
//! Nothing here panics across a call: every fallible operation returns
//! `Result<_, EngineError>` (project No-Fallbacks rule; contract §1.5/§5).

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod dto;
pub mod error;
pub mod function_meta;
pub mod operation;
pub mod session;

pub use dto::*;
pub use error::{EngineError, ErrorClass};
pub use function_meta::{
    ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata, Volatility,
};
pub use operation::{LifecycleState, OperationId, OperationState};
pub use session::EngineSession;

/// Contract schema version. Bumped on a breaking DTO/error/command change.
/// A DTO carrying an unknown `schema_version` is rejected fail-loud with
/// [`ErrorClass::Protocol`] (`unsupported_schema_version`) — never coerced
/// (contract §4.1).
pub const SCHEMA_VERSION: u16 = 1;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{CellValue, FullRebuildReason};

    #[test]
    fn cell_value_is_a_tagged_discriminated_union() {
        // The contract requires `kind` to discriminate exactly one payload (§4.2).
        let v = CellValue::Number { number: 1.5 };
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, r#"{"kind":"number","number":1.5}"#);
        assert_eq!(serde_json::from_str::<CellValue>(&json).unwrap(), v);

        let p = CellValue::Pending;
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"kind":"pending"}"#);
    }

    #[test]
    fn engine_error_carries_code_as_data_and_displays_bracketed() {
        let e = EngineError::bad_argument("row must be a non-negative integer")
            .with_detail("row", serde_json::json!(-1));
        assert_eq!(e.class, ErrorClass::BadArgument);
        assert_eq!(e.code, "bad_argument");
        assert!(!e.retryable);
        // Display preserves the legacy "[code] message" readability.
        assert_eq!(
            e.to_string(),
            "[bad_argument] row must be a non-negative integer"
        );
        // Round-trips as structured data (not a parsed string).
        let round: EngineError = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(round, e);
    }

    #[test]
    fn malformed_token_is_fail_loud_not_a_full_rebuild() {
        // No-Fallbacks (contract §4.3 / MED-2): a malformed token is an error,
        // NOT a silent full-rebuild. The full-rebuild reasons are an enumerated,
        // designed set that does NOT include "malformed".
        let e = EngineError::invalid_version_token("loro decode failed");
        assert_eq!(e.class, ErrorClass::Protocol);
        assert_eq!(e.code, "invalid_version_token");
        // The legitimate full-rebuild reasons:
        for r in [
            FullRebuildReason::NoPriorVersion,
            FullRebuildReason::CacheCleared,
            FullRebuildReason::StaleHorizon,
            FullRebuildReason::EpochMismatch,
        ] {
            // each serializes to snake_case and round-trips
            let j = serde_json::to_string(&r).unwrap();
            assert_eq!(serde_json::from_str::<FullRebuildReason>(&j).unwrap(), r);
        }
    }

    #[test]
    fn table_spec_round_trips() {
        use crate::dto::TableSpec;
        let spec = TableSpec {
            name: "SALES".into(),
            sheet: 0,
            top_row: 1,
            top_col: 2,
            rows: 10,
            cols: 3,
            has_header: true,
            has_totals: false,
            column_names: vec!["Region".into(), "Q1".into(), "Q2".into()],
        };
        let json = serde_json::to_string(&spec).unwrap();
        assert_eq!(serde_json::from_str::<TableSpec>(&json).unwrap(), spec);
    }

    #[test]
    fn schema_version_is_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }
}
