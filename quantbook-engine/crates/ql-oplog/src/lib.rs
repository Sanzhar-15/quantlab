//! `ql-oplog` — Loro-backed operation log for the Quantbook engine.
//!
//! Phase 2A.3.a (2026-05-12): scaffolding. Per Round 7 architectural lock
//! T1-D05, Loro is reserved for the op log layer only — no other crate
//! depends on it. CRDT semantics (inter-peer merge) are reserved for Phase
//! 5+ multi-user work; Phase 2A.3 uses Loro as the persistence + future-
//! CRDT-merge substrate.
//!
//! ## Surface
//!
//! - [`Op`] — the engine's mutation vocabulary (one variant per recordable
//!   Workbook mutation).
//! - [`OpLog`] — append-only log with `append`, `iter`, `len`, `is_empty`,
//!   `export_bytes`, `import_bytes`.
//! - [`replay_into`] — applies a log against a [`ql_storage::Workbook`].
//! - [`OpLogError`], [`ReplayError`] — error surfaces (thiserror-derived).
//!
//! ## Scope
//!
//! 2A.3.a covers the crate itself + tests. Integration into
//! `WorkbookRuntime` / `WorkbookTransaction` lands in 2A.3.b; persistence
//! alongside the `.qbook/` envelope lands in 2A.3.c.

pub mod error;
pub mod log;
pub mod op;
pub mod replay;

pub use error::OpLogError;
pub use log::OpLog;
pub use op::Op;
pub use replay::{replay_into, ReplayError};
