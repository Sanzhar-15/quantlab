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
pub mod replay;
pub mod wire;

pub use error::OpLogError;
pub use log::{OpLog, PRESENCE_COMMIT_ORIGIN};
pub use op::{DateSystemWire, LocaleWire, Op, ReferenceModeWire};
pub use replay::{apply_ops_in_range, replay_into, ReplayError};

// **Phase 5.7 V3.6.0.8.3 D6 (2026-05-25)** -- re-export Loro
// `VersionVector` so downstream crates (`ql-bindings-node`,
// `ql-collab`) can refer to it without a direct `loro` dep.  The type
// flows through napi as opaque bytes (encode/decode) so the
// re-export is purely an ergonomics + dep-graph hygiene choice.
pub use loro::VersionVector;
pub use wire::{
    BorderEdgeWire, BorderStyleWire, CellWireValue, FormatIdWire, HAlignWire, NamedTargetWire,
    RgbWire, StyleIdWire, StyleWire, WireDecodeError,
};

// Phase 5.2 D-1 step 1.1 (2026-05-19) — re-export `ql_types::PeerId`
// for ergonomics. PeerId lived briefly at `ql_oplog::PeerId` in step 1
// (commit aaa54d32f4d) but the step-1 audit caught a forthcoming Cargo
// cycle: `ql_storage::FormatId::Custom(PeerId, _)` (step 3) cannot
// reference a type living in `ql-oplog` because `ql-oplog` already
// depends on `ql-storage`. PeerId moved to `ql_types` (the true
// dependency floor); `ql-oplog` re-exports for back-compat so callers
// like `ql_collab::CollabSession` (which already imports from
// ql-oplog for `Op` + `OpLog`) can keep using a single import line.
pub use ql_types::PeerId;

// **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure**: the
// `persistence` module (save_workbook_with_oplog / load_workbook_with_oplog
// / PersistenceError) moved to `ql-io::oplog_persistence`. The move
// inverts the prior `ql-oplog → ql-io` dependency so Phase 5 CRDT
// integration sees `ql-oplog` as a dependency floor.
//
// External callers that previously imported `ql_oplog::save_workbook_with_oplog`
// (etc.) now import from `ql_io` instead. The on-disk file shape is
// unchanged: `oplog.bin` sidecar inside `.qbook/` directories.
