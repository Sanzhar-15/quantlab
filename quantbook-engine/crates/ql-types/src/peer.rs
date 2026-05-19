//! Per-peer identifier for Phase 5 multi-user collaboration.
//!
//! **History:**
//! - **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
//! - **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
//!   so the op-log layer (where ops are tagged with peer-of-origin)
//!   could reference it without a reverse `ql-oplog → ql-collab` dep.
//! - **Phase 5.2 D-1 step 1.1 (2026-05-19):** moved AGAIN to
//!   `ql_types::PeerId` after the step-1 audit (Codex MEDIUM-3) caught
//!   a forthcoming Cargo cycle: `ql-storage::FormatId::Custom(PeerId, _)`
//!   (step 3) cannot reference a type living in `ql-oplog`, because
//!   `ql-oplog` already depends on `ql-storage`. `ql-types` is the true
//!   dependency floor — both `ql-storage` and `ql-oplog` depend on it.
//!   `ql-oplog` and `ql-collab` re-export `ql_types::PeerId` for
//!   back-compat; external callers using `ql_oplog::PeerId` or
//!   `ql_collab::PeerId` keep working.
//!
//! `PeerId` is a thin newtype around `u64` matching Loro's native peer-id
//! type. Stable per-session; the user-facing collaboration tooling
//! decides how to assign IDs (random vs user-derived vs server-allocated).
//!
//! ## Wire format
//!
//! `serde` derives are `transparent`, so a `PeerId` serializes as a
//! plain `u64` in JSON / CBOR / etc. — matches the on-the-wire
//! convention for Loro peer ids and avoids a wrapped form like `[42]`.
//!
//! ## Consumers
//!
//! - `ql_storage::FormatId::Custom(PeerId, u32)` (Phase 5.2 D-1 step 3).
//! - `ql_oplog::wire::FormatIdWire` + `Op::RegisterFormat/SetCellFormat`
//!   (Phase 5.2 D-1 step 2 + step 4).
//! - `ql_oplog::OpLog::set_peer_id` — wires through to Loro's
//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
//!   origin in the CRDT merge metadata (Phase 5.2.b).
//! - `ql_collab::CollabSession` + `ql_collab::presence` (Phase 5.2.a
//!   onward).

use serde::{Deserialize, Serialize};

/// Per-peer collaboration identifier.
///
/// Wraps a `u64` to match Loro's native peer-id type. Stable for
/// the lifetime of a `CollabSession`; the user-facing tooling
/// decides assignment policy. Two concurrent peers MUST have
/// distinct ids — duplicate peer ids corrupt the document via
/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
/// then closed by Phase 5.2.b wiring). Prefer per-process-random
/// allocation unless your server enforces uniqueness explicitly.
///
/// Serde shape is `#[serde(transparent)]` — wire format is a plain
/// `u64`, not a wrapped tuple.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PeerId(pub u64);

impl PeerId {
    /// Construct a `PeerId` from the raw u64.
    pub const fn new(id: u64) -> Self {
        Self(id)
    }

    /// Unwrap to the raw `u64`. Used at the Loro boundary
    /// (`LoroDoc::set_peer_id` takes `u64`).
    pub const fn as_u64(self) -> u64 {
        self.0
    }
}

impl From<u64> for PeerId {
    fn from(id: u64) -> Self {
        Self(id)
    }
}

impl From<PeerId> for u64 {
    fn from(p: PeerId) -> Self {
        p.0
    }
}

impl std::fmt::Display for PeerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 16-hex-char form keeps display compact and easy to spot in logs.
        write!(f, "{:016x}", self.0)
    }
}

/// **Phase 5.2 D-1 step 1.1 (2026-05-19):** sentinel peer-id used by
/// the `.qbook` envelope's legacy-u32 → tagged-tuple `FormatId`
/// migration (Phase 5.2 D-1 step 5).
///
/// Old `.qbook` files encoded `FormatId` as a bare `u32`. On load,
/// values `≤ 163` map to `FormatId::Builtin(n)`; values `> 163` map
/// to `FormatId::Custom(LEGACY_PEER, n - 164)`. After the migration
/// runs, the workbook resaves with the new tagged-tuple schema and
/// `LEGACY_PEER` only appears in custom format ids inherited from
/// pre-Phase-5.2 saves.
///
/// **Choice of `0`:** PeerId(0) is accepted by Loro as a valid
/// peer-id but is documented (Phase 5.2.b) as something production
/// callers MUST avoid (Loro requires distinct concurrent peer ids).
/// LegacyPeer claiming `0` is therefore safe — no live peer should
/// collide. Alternative `u64::MAX - 1` was considered but `0` is the
/// more obvious sentinel (matches Unix `uid=0=root` convention).
///
/// Cross-ref: `docs/phase5/d-1-starting-checklist.md` § "Step 5".
pub const LEGACY_PEER: PeerId = PeerId::new(0);

#[cfg(test)]
mod tests {
    use super::{PeerId, LEGACY_PEER};

    #[test]
    fn round_trips_through_u64() {
        let p = PeerId::new(0xdead_beef_cafe_babe);
        assert_eq!(p.as_u64(), 0xdead_beef_cafe_babe);
        assert_eq!(u64::from(p), 0xdead_beef_cafe_babe);
        assert_eq!(PeerId::from(0xdead_beef_cafe_babe_u64), p);
    }

    #[test]
    fn display_is_16_hex_chars() {
        let p = PeerId::new(0x1234);
        assert_eq!(format!("{p}"), "0000000000001234");
    }

    #[test]
    fn equality_and_hash_consistent() {
        use std::collections::HashSet;
        let a = PeerId::new(42);
        let b = PeerId::new(42);
        let c = PeerId::new(43);
        assert_eq!(a, b);
        assert_ne!(a, c);
        let mut set: HashSet<PeerId> = HashSet::new();
        set.insert(a);
        assert!(set.contains(&b));
        assert!(!set.contains(&c));
    }

    #[test]
    fn serde_transparent_wire_shape_is_plain_u64() {
        // Phase 5.2 D-1 step 2 readiness: PeerId must serialize as
        // a bare u64 so that `FormatIdWire::Custom(PeerId, u32)` ends
        // up as `{"Custom": [42, 7]}` in JSON — not the wrapped
        // `{"Custom": [[42], 7]}` form that would result from a
        // non-transparent derive.
        let p = PeerId::new(42);
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(json, "42");
        let back: PeerId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn legacy_peer_is_zero() {
        assert_eq!(LEGACY_PEER.as_u64(), 0);
        assert_eq!(LEGACY_PEER, PeerId::new(0));
    }
}
