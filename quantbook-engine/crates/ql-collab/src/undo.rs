//! `undo` — peer-local undo/redo over the shared op log.
//!
//! **Phase 5.4 V1 (2026-05-19, ship):** wraps Loro 1.12.0's
//! `UndoManager` and exposes it through `CollabSession`. Per
//! Loro's docs (`lib.rs:3708`):
//!
//! > Local-only: undo/redo affects only local operations from
//! > the bound peer; it does not revert remote edits.
//!
//! That matches the design at
//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
//! 5.4 preview): each peer has its own undo stack tracking
//! THEIR appends only.
//!
//! ## Surface (V1 + V2 V1)
//!
//! [`crate::CollabSession`] exposes:
//! - `undo()` / `redo()` — perform the action; returns `bool`
//!   indicating whether a stack item was consumed.
//! - `can_undo()` / `can_redo()` — peek without consuming.
//! - `undo_count()` / `redo_count()` — how many stack items.
//! - `clear_undo_stack()` — reset both stacks.
//! - `start_undo_group()` / `end_undo_group()` — atomic
//!   multi-op grouping (Phase 5.4 V2 V1 ship `6138a7203f6`).
//! - `set_undo_merge_interval(ms)` — auto-merge consecutive
//!   changes within the window (Phase 5.4 V2 V1).
//! - `start_undo_group_scoped()` — RAII variant returning
//!   `UndoGroupGuard<'_>`; `Drop` auto-closes the group on
//!   scope exit, including on panic-unwind and `?` propagation
//!   (Phase 5.4 V2 V1.1).
//!
//! V2 V2 follow-up: push/pop listeners (`UndoManager::set_on_push`
//! / `set_on_pop`).
//!
//! ## Presence-exclude
//!
//! Phase 5.6 V1 presence writes commit with origin
//! `PRESENCE_COMMIT_ORIGIN`. `CollabSession::new` and
//! `from_snapshot` automatically register that prefix with
//! `UndoManager::add_exclude_origin_prefix` so cursor movements
//! don't pollute the undo stack. Without this, every keystroke
//! that moved the cursor would push a no-op undo item.
//!
//! ## Important V1 semantics
//!
//! - Undo retracts originals from the visible `"ops"` LoroList
//!   (Phase 5.4 V1 audit closure made `OpLog::len()` query Loro
//!   directly rather than cache; visible count shrinks on undo
//!   and grows on redo). See test
//!   `undo_retracts_visible_op_from_op_log_len`.
//! - Undo on peer A's manager only affects A's appends. Peer B's
//!   ops are untouched even after A undoes. This is Loro's
//!   "local-only" guarantee.
//! - The manager is bound to the doc's peer id at construction.
//!   Don't change peer id while it's alive (5.2.b's
//!   `OpLog::set_peer_id` is callable but doing so mid-stream
//!   breaks undo grouping per Loro's pitfall warning).
//!
//! No new types in this module yet — the V1 wrapper lives
//! directly on `CollabSession` and `loro::UndoManager` is
//! re-exported for callers that want raw access.

pub use loro::UndoManager;
