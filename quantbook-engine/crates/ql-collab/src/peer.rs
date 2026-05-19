//! Per-peer identifier for Phase 5 collaboration.
//!
//! **Phase 5.2.a (2026-05-19):** `PeerId` is a thin newtype around
//! `u64` matching Loro's native peer-id type. Stable per-session;
//! the user-facing collaboration tooling decides how to assign IDs
//! (random vs user-derived vs server-allocated).
//!
//! Used by:
//! - [`crate::session::CollabSession`] — attached at session-create
//!   time AND passed through to `OpLog::set_peer_id` → Loro's
//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
//!   origin in the CRDT merge metadata (Phase 5.2.b 2026-05-19;
//!   5.2.a stored this as a label only).
//! - Phase 5.6 presence module — keys the `presence` `LoroMap`
//!   in 16-hex `Display` form so each peer's cursor position
//!   lives at its own slot (✅ shipped at `c677e244704`).
//! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
//!   variant will use this type for collision-free format-id
//!   allocation across peers.

/// Per-peer collaboration identifier.
///
/// Wraps a `u64` to match Loro's native peer-id type. Stable for
/// the lifetime of a `CollabSession`; the user-facing tooling
/// decides assignment policy. Two concurrent peers MUST have
/// distinct ids — duplicate peer ids corrupt the document via
/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
/// then closed by Phase 5.2.b wiring). Prefer per-process-random
/// allocation unless your server enforces uniqueness explicitly.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
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

#[cfg(test)]
mod tests {
    use super::PeerId;

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
}
