//! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** establishes the
//! module shape per the audit-closed design at
//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
//! A (preserve op-log shape on top of Loro `LoroList`); this crate
//! is the layer above ql-oplog that orchestrates multi-peer
//! collaboration.
//!
//! ## Module layout
//!
//! - `PeerId` — re-exported from [`ql_types::PeerId`] (Phase 5.2 D-1
//!   step 1.1, 2026-05-19; originally `ql_collab::peer::PeerId` at
//!   5.2.a, briefly relocated to `ql_oplog::PeerId` at step 1, finally
//!   at `ql_types::PeerId` after the step-1 Codex audit caught a
//!   forthcoming Cargo cycle). Stable per-session identifier; wraps
//!   Loro's `u64`.
//! - [`session`] — `CollabSession`: per-peer state holder that
//!   wraps an `OpLog`, manages local appends, and exposes
//!   `merge_bytes` + `export_bytes` for transport integration.
//! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
//!   (test stub) and `LoopbackTransport` (Phase 5.5 V1 ship
//!   2026-05-19 — in-process paired endpoints for 2-peer
//!   round-trip tests). Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05`)
//!   added `CollabSession` typed transport methods
//!   (attach/detach/flush/poll). Phase 5.5 V2 V2 / V3 pending —
//!   auto-flush + version-vector deltas + WebSocket impl.
//! - [`presence`] — per-peer ephemeral cursor + selection state
//!   (Phase 5.6 V1 ship 2026-05-19). `PresenceState` JSON-encoded
//!   into the shared `LoroDoc`'s `"presence"` LoroMap (LWW per key).
//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`.
//!   V1 ship 2026-05-19 (`89c02b9d83e`): 7 undo/redo methods.
//!   V2 V1 (`6138a7203f6` + `e199a5fda5a`): atomic grouping +
//!   merge-interval. V2 V1.1: RAII `start_undo_group_scoped`
//!   returning `UndoGroupGuard`. V2 V2 pending — push/pop
//!   listeners.
//!
//! ## Stability
//!
//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
//! will populate the reserved modules and may shift trait shapes.
//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
//! megaudit per the engine audit-discipline rule.
//!
//! ### Pre-stability API changes (logged)
//!
//! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
//!   return type changed from `Self` to
//!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
//!   fallible (`u64::MAX` is reserved), so the constructor must
//!   propagate the error. Internal-only at the time of the change;
//!   no external callers.
//! - **Phase 5.4 V1 (2026-05-19, `89c02b9d83e` + audit closure):**
//!   `CollabSessionError::Undo(loro::LoroError)` variant added.
//!   Exposes `loro::LoroError` in the public error surface — pre-0.2.0
//!   this couples consumers to the loro crate version; a stable API
//!   would wrap it in a ql-collab-owned error. Will be re-typed
//!   before 0.2.0.
//! - **Phase 5.4 V1 audit closure (2026-05-19):**
//!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
//!   to `&mut self`. Prevents accidental peer-id changes through
//!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
//!   an attached `UndoManager`'s stacks per Loro's internal
//!   subscription behavior (`loro-internal::undo:654-662`).
//! - **Phase 5.2 D-1 step 1 (2026-05-19, `aaa54d32f4d`):** `PeerId`
//!   moved from `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId`.
//!   Brief intermediate placement; superseded same-day by step 1.1.
//! - **Phase 5.2 D-1 step 1.1 (2026-05-19):** Codex audit on step 1
//!   caught (a) PeerId lacked `Serialize`/`Deserialize` (blocks step
//!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
//!   in step 3 would form a Cargo cycle (`ql-oplog -> ql-storage` exists;
//!   making `ql-storage -> ql-oplog` for PeerId would loop). Step 1.1
//!   moved PeerId to `ql_types::PeerId` (the true dependency floor —
//!   `ql-storage`, `ql-oplog`, and `ql-collab` all depend on it),
//!   added `#[serde(transparent)]` derives, and shipped the
//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
//!   migration. `ql_collab::PeerId` now re-exports `ql_types::PeerId`.
//!
//!   **Back-compat surface:** `use ql_collab::PeerId;` keeps working
//!   unchanged (both step 1 and step 1.1 preserve the re-export).
//!   `use ql_collab::peer::PeerId;` (the old module path) was broken
//!   by step 1 and stays broken — `pub mod peer` is gone. Workspace
//!   grep confirms no such caller existed; external consumers were
//!   already using `ql_collab::PeerId` (the re-export).

pub mod presence;
// Phase 5.3 step 3 (2026-05-20) — rename-repair pass. Caller-driven
// post-merge cleanup that rewrites formula text referencing pre-rename
// sheet names. See `repair.rs` module docs + `docs/architecture/crdt-data-model.md`
// § "Conflict resolution semantics" rows for the RenameSheet × concurrent
// edit closure that this module ships.
pub mod repair;
pub mod session;
pub mod transport;
pub mod undo;

// PeerId actually lives in `ql_types` post step 1.1, but ql-collab
// re-exports via `ql_oplog::PeerId` (itself a re-export) to avoid
// adding a new direct `ql-types` Cargo dep on ql-collab. External
// callers using `use ql_collab::PeerId;` resolve identically.
pub use ql_oplog::PeerId;

pub use presence::{PresenceError, PresenceState};
pub use repair::{repair_sheet_rename_chain, AmbiguousSkip, RepairReport, SheetRewriteSummary};
pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
pub use undo::UndoManager;
