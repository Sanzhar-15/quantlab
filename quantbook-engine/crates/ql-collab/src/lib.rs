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
//! - [`peer`] — `PeerId` type. Stable per-session identifier used
//!   to attribute ops + presence state. Wraps Loro's `u64` peer id.
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
//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`
//!   (Phase 5.4 V1 ship 2026-05-19). `CollabSession` wires the
//!   manager + auto-excludes presence-origin commits.
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

pub mod peer;
pub mod presence;
pub mod session;
pub mod transport;
pub mod undo;

pub use peer::PeerId;
pub use presence::{PresenceError, PresenceState};
pub use session::{CollabSession, CollabSessionError};
pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
pub use undo::UndoManager;
