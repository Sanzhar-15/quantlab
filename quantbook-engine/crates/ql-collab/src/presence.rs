//! `Presence` — per-peer ephemeral cursor + selection state.
//!
//! **Phase 5.6 V1 (2026-05-19, ship):** implements the
//! audit-closed design at `docs/architecture/crdt-data-model.md`
//! § Presence container.
//!
//! Each peer's state lives in the `"presence"` LoroMap inside the
//! shared `LoroDoc`. Keys are the peer-id 16-hex `Display` form
//! (e.g. `"0000000000000001"`); values are JSON-serialized
//! [`PresenceState`] blobs. Loro's LoroMap merge is LWW per key,
//! which gives the desired "last position update wins per peer"
//! semantics.
//!
//! ## Persistence
//!
//! Presence updates DO survive `OpLog::export_bytes` /
//! `import_bytes` (they live in the same `LoroDoc`), but the
//! `.qbook` envelope (`ql_io::oplog_persistence`) writes the
//! whole snapshot, so cold-restart presence will land in the new
//! session. Phase 5.6 V2 may add envelope-level filtering if
//! "rejoin and see stale presence" turns out to be undesirable
//! UX; V1 keeps the data so the multi-peer round-trip test
//! pattern works.
//!
//! ## Concurrency
//!
//! Two peers updating their OWN keys never conflict — LoroMap is
//! per-key LWW and the keys are distinct by construction. Two
//! peers updating the SAME key (i.e. one peer impersonating
//! another by sharing the same `PeerId`) is undefined behavior
//! per the Loro duplicate-peer-id pitfall already documented at
//! `OpLog::set_peer_id` and `CollabSession::new`.
//!
//! ## Forward work (NOT in V1)
//!
//! - Phase 5.6 V2: presence-changed callback (Loro `subscribe`
//!   on the `"presence"` container). V1 callers poll via
//!   [`crate::CollabSession::peer_presence`].
//! - Phase 5.7: IDE wires per-peer color + name from a separate
//!   metadata layer (presence map only holds position state).

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::peer::PeerId;

/// Per-peer ephemeral state: cursor position + active selection +
/// typing indicator.
///
/// Coordinates are sheet-local (NOT global). `(sheet, row, col)`
/// is the cursor; `(selection_end_row, selection_end_col)`
/// together with the cursor defines a rectangular selection. When
/// no range is selected, set `selection_end_row = row` and
/// `selection_end_col = col` (the selection collapses to the
/// cursor cell).
///
/// `typing` is a soft hint for the IDE — true while the user is
/// mid-edit (formula bar focused or in-cell edit mode), false
/// otherwise. Consumers may use it to render a different cursor
/// style without relying on op-log signals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresenceState {
    /// 0-indexed sheet id.
    pub sheet: u16,
    /// 0-indexed row of the cursor cell.
    pub row: u32,
    /// 0-indexed column of the cursor cell.
    pub col: u32,
    /// 0-indexed row of the selection rectangle's opposite corner.
    /// Equals `row` when the selection collapses to a single cell.
    pub selection_end_row: u32,
    /// 0-indexed column of the selection rectangle's opposite corner.
    /// Equals `col` when the selection collapses to a single cell.
    pub selection_end_col: u32,
    /// True while the peer is actively editing (formula bar focused
    /// or in-cell edit mode).
    pub typing: bool,
}

impl PresenceState {
    /// Construct a `PresenceState` with a single-cell selection
    /// (selection_end_* = row/col) and `typing = false`.
    ///
    /// Convenient for "cursor moved to A1" updates that don't
    /// require building a full struct.
    pub const fn at_cell(sheet: u16, row: u32, col: u32) -> Self {
        Self {
            sheet,
            row,
            col,
            selection_end_row: row,
            selection_end_col: col,
            typing: false,
        }
    }

    /// True if the selection collapses to a single cell.
    pub fn is_single_cell(&self) -> bool {
        self.selection_end_row == self.row && self.selection_end_col == self.col
    }
}

/// Errors emitted by `Presence` operations.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PresenceError {
    /// JSON serialization of `PresenceState` failed. Should be
    /// unreachable for well-formed `PresenceState` (all fields
    /// are primitives).
    #[error("presence serialize error: {0}")]
    Serialize(#[source] serde_json::Error),

    /// JSON deserialization of a presence blob failed. Indicates a
    /// peer wrote an incompatible shape (version drift between
    /// peers, OR corrupted snapshot).
    #[error("presence deserialize error for peer {peer_key}: {source}")]
    Deserialize {
        peer_key: String,
        #[source]
        source: serde_json::Error,
    },

    /// Wrapped `OpLogError` — the underlying Loro container
    /// access (insert / get / delete) failed.
    #[error("presence op log error: {0}")]
    OpLog(#[from] ql_oplog::OpLogError),

    /// A peer key in the `"presence"` LoroMap could not be parsed
    /// back into a `PeerId`. Indicates that another producer wrote
    /// a non-16-hex-u64 key into the map — incompatible with this
    /// version's encoding.
    #[error("presence peer-key parse error: {peer_key:?} ({source})")]
    PeerKeyParse {
        peer_key: String,
        #[source]
        source: std::num::ParseIntError,
    },
}

/// Format a `PeerId` as its presence-map key.
///
/// Uses the 16-hex `Display` form (e.g. `"0000000000000001"`).
/// Matches the format used elsewhere in the engine (logs,
/// debug output) so a presence dump is greppable.
pub(crate) fn peer_key(peer: PeerId) -> String {
    format!("{peer}")
}

/// Parse a presence-map key back into a `PeerId`.
///
/// Inverse of [`peer_key`]. Returns [`PresenceError::PeerKeyParse`]
/// if the key isn't 16-hex-digit u64.
pub(crate) fn parse_peer_key(key: &str) -> Result<PeerId, PresenceError> {
    let raw = u64::from_str_radix(key, 16).map_err(|source| PresenceError::PeerKeyParse {
        peer_key: key.to_owned(),
        source,
    })?;
    Ok(PeerId::new(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_cell_collapses_selection() {
        let s = PresenceState::at_cell(0, 3, 4);
        assert_eq!(s.sheet, 0);
        assert_eq!(s.row, 3);
        assert_eq!(s.col, 4);
        assert!(s.is_single_cell());
        assert!(!s.typing);
    }

    #[test]
    fn range_selection_detected() {
        let s = PresenceState {
            sheet: 0,
            row: 0,
            col: 0,
            selection_end_row: 5,
            selection_end_col: 5,
            typing: false,
        };
        assert!(!s.is_single_cell());
    }

    #[test]
    fn serde_round_trip() {
        let s = PresenceState {
            sheet: 2,
            row: 100,
            col: 26,
            selection_end_row: 200,
            selection_end_col: 27,
            typing: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(s, parsed);
    }

    #[test]
    fn peer_key_round_trip() {
        let p = PeerId::new(0x1234_5678_9abc_def0);
        let key = peer_key(p);
        assert_eq!(key, "123456789abcdef0");
        let parsed = parse_peer_key(&key).unwrap();
        assert_eq!(parsed, p);
    }

    #[test]
    fn peer_key_parse_rejects_garbage() {
        let result = parse_peer_key("not-a-peer-id");
        assert!(matches!(result, Err(PresenceError::PeerKeyParse { .. })));
    }
}
