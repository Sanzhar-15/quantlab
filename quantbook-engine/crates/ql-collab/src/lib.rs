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
//! - [`transport`] — `Transport` trait: the wire-byte channel
//!   abstraction (Phase 5.5 will add a WebSocket impl).
//! - [`presence`] — reserved name; Phase 5.6 populates with the
//!   ephemeral cursor + selection state map.
//! - [`undo`] — reserved name; Phase 5.4 populates with peer-local
//!   undo via Loro's `UndoManager`.
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

pub mod peer;
pub mod session;
pub mod transport;

pub use peer::PeerId;
pub use session::{CollabSession, CollabSessionError};
pub use transport::{NoopTransport, Transport, TransportError};
