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
//! ## V1 surface
//!
//! [`crate::CollabSession`] exposes:
//! - `undo()` / `redo()` — perform the action; returns `bool`
//!   indicating whether a stack item was consumed.
//! - `can_undo()` / `can_redo()` — peek without consuming.
//! - `undo_count()` / `redo_count()` — how many stack items.
//! - `clear_undo_stack()` — reset both stacks.
//!
//! V1 does NOT yet expose grouping (`group_start` /
//! `group_end`), merge-interval tuning, or push/pop listeners.
//! Those are 5.4 V2 work — the design doc lists them as
//! follow-ups.
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
//! - Undo creates INVERSE OPS rather than physically removing
//!   the original. `OpLog::len()` therefore counts both forward
//!   and inverse ops; "how many user-perceived ops survived"
//!   needs different bookkeeping (5.4 V2 may add an undoable-op
//!   counter).
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
