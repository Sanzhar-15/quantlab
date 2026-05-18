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
//! 2A.3.a (2026-05-12) shipped the crate itself + tests. 2A.3.b wired
//! `WorkbookRuntime` / `WorkbookTransaction` to emit ops. 2A.3.c (this
//! commit) adds `oplog.bin` persistence alongside the `.qbook/` envelope
//! via [`persistence::save_workbook_with_oplog`] /
//! [`persistence::load_workbook_with_oplog`].
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. `Op` carries
//! `#[non_exhaustive]` because Phase 5 (CRDT collaboration) will
//! add new op variants for sheet-scoped names, table mutations,
//! presence, and undo grouping — downstream replayers must include
//! a `_` arm. Error enums (`OpLogError`, `PersistenceError`,
//! `ReplayError`, `FormatRejectedSource`) also carry the marker.
//! Wire enums (`ReferenceModeWire`, `LocaleWire`) are exhaustive by
//! design; variant additions are MAJOR-version events because the
//! wire format and producer/replay sites are updated in lockstep.

pub mod error;
pub mod log;
pub mod op;
pub mod persistence;
pub mod replay;

pub use error::OpLogError;
pub use log::OpLog;
pub use op::{LocaleWire, Op, ReferenceModeWire};
pub use persistence::{
    load_workbook_with_oplog, save_workbook_with_oplog, PersistenceError, OPLOG_FILENAME,
};
pub use replay::{replay_into, ReplayError};
