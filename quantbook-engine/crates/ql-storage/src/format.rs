//! Workbook-level format-string interning table (Phase 4.5.D part 3,
//! W5-79).
//!
//! `FormatTable` reserves Excel built-in format IDs 0-163 (`Builtin`
//! variant) and allocates custom IDs as `Custom(peer, counter)` tuples
//! (Phase 5.2 D-1 step 3 — was a bare `u32` pre-step-3). Pre-populates
//! the parser-relevant subset of built-ins (mini-spec § 10) so cells
//! with the most common formats resolve without any registration calls.
//!
//! ## Phase 5.2 D-1 step 3 (2026-05-19) — tagged-tuple FormatId
//!
//! `FormatId` changed from `pub struct FormatId(pub u32)` to a tagged
//! enum to support multi-peer CRDT collaboration:
//!
//! ```ignore
//! pub enum FormatId {
//!     Builtin(u32),                  // Excel-canonical ids 0..=163
//!     Custom(PeerId, u32),           // peer-allocated, per-peer counter
//! }
//! ```
//!
//! `FormatTable` carries a `local_peer: PeerId` (set at construction)
//! used by [`FormatTable::intern`] when allocating new custom ids.
//! Single-writer / pre-collab callers use [`LEGACY_PEER`] as the
//! `local_peer`. Multi-peer sessions set their own `PeerId` at attach
//! time (Phase 5.2 D-1 step 4 wiring).
//!
//! Migration helper [`FormatId::legacy_from_u32`] converts pre-5.2
//! bare-u32 ids back to the enum shape for backward-compat loading
//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
//!
//! See:
//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
//! - `docs/phase5/d-1-starting-checklist.md` for the multi-step plan.
//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for
//!   the format-string parser.
//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
//!   the parser-relevant built-in subset.

use std::collections::HashMap;

use ql_types::{PeerId, LEGACY_PEER};

/// Workbook format id — tagged tuple (Phase 5.2 D-1 step 3 ship).
///
/// Two variants:
/// - `Builtin(u32)` — Excel-canonical ids `0..=163` (stable across
///   peers; no merge collisions possible by construction).
/// - `Custom(PeerId, u32)` — peer-allocated. Each peer's allocator
///   increments its own `counter`; concurrent peers can't collide
///   because the `PeerId` differs (Phase 5.1 audit-locked decision
///   D-1).
///
/// Use [`FormatId::GENERAL`] for the "no custom format" case (= built-in id 0).
///
/// Mirrors `ql_oplog::wire::FormatIdWire`; the wire type is the
/// `Op::RegisterFormat` / `Op::SetCellFormat` payload (step 4).
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum FormatId {
    /// Excel-canonical built-in format id (`0..=163`).
    Builtin(u32),
    /// Peer-allocated custom format id. The `(peer, counter)` pair
    /// is collision-free across concurrent peers because `peer`
    /// differs (Phase 5.1 audit D-1).
    Custom(PeerId, u32),
}

impl Default for FormatId {
    fn default() -> Self {
        FormatId::GENERAL
    }
}

impl FormatId {
    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    pub const GENERAL: FormatId = FormatId::Builtin(0);

    /// True iff this is a built-in (Excel-canonical) format id.
    pub const fn is_builtin(self) -> bool {
        matches!(self, FormatId::Builtin(_))
    }

    /// True iff this is a peer-allocated custom format id.
    pub const fn is_custom(self) -> bool {
        matches!(self, FormatId::Custom(_, _))
    }

    /// **Phase 5.2 D-1 step 3 migration helper:** map a pre-5.2 bare
    /// `u32` `FormatId` encoding to the new tagged-tuple form.
    ///
    /// Pre-5.2 encoding: `FormatId(pub u32)`. Values `0..=163` are
    /// Excel built-ins. Values `>=164` were allocated by the pre-5.2
    /// single-writer counter starting at `FIRST_CUSTOM_FORMAT_ID = 164`.
    ///
    /// Mapping:
    /// - `n <= 163` → `Builtin(n)`.
    /// - `n >= 164` → `Custom(LEGACY_PEER, n - 164)`.
    ///
    /// Cross-references `ql_oplog::wire::FormatIdWire::from_u32_legacy`
    /// (the wire-side counterpart shipped at step 2). Both helpers
    /// must agree on the 164 boundary; step 8 megaudit verifies.
    ///
    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
    /// `ql_io_xlsx` import paths (step 6).
    pub fn legacy_from_u32(n: u32) -> Self {
        if n <= FIRST_XLSX_BUILTIN_MAX {
            FormatId::Builtin(n)
        } else {
            FormatId::Custom(LEGACY_PEER, n - FIRST_CUSTOM_FORMAT_ID)
        }
    }

    /// **Phase 5.2 D-1 step 3:** map this `FormatId` back to the
    /// pre-5.2 bare-`u32` shape, if expressible.
    ///
    /// - `Builtin(n)` → `Some(n)`.
    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
    ///   pre-5.2 saves).
    /// - `Custom(non-legacy-peer, _)` → `None` (a peer other than
    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
    ///   represent it). Step 6's xlsx export decides what to do
    ///   (e.g. flatten by allocation order).
    pub fn to_legacy_u32(self) -> Option<u32> {
        match self {
            FormatId::Builtin(n) => Some(n),
            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
            FormatId::Custom(_, _) => None,
        }
    }
}

/// Lower-bound of Excel's built-in format-id range (inclusive).
/// `FormatId::Builtin(n)` is valid for `n <= FIRST_XLSX_BUILTIN_MAX`;
/// values above this were custom ids in the pre-5.2 single-writer
/// encoding. Mirrors `ql_oplog::wire::wire::FIRST_XLSX_BUILTIN_MAX`.
const FIRST_XLSX_BUILTIN_MAX: u32 = 163;

/// First custom (non-built-in) format id in the pre-5.2 bare-u32
/// encoding. Kept as a public constant because xlsx import / export
/// + qbook envelope migration use this boundary explicitly.
///
/// Post-5.2: custom ids live in `FormatId::Custom(peer, counter)`;
/// `counter` starts at `0`, not 164. This constant remains for
/// `to_legacy_u32` / `legacy_from_u32` conversions only.
pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164;

/// Excel built-in format strings ship in this table at construction time.
/// Per mini-spec § 10, V1 ships the parser-relevant subset; remaining IDs
/// in the 0-163 range can be added lazily when xlsx import (Phase 4.11)
/// surfaces them.
const BUILTIN_FORMATS: &[(u32, &str)] = &[
    (0, "General"),
    (1, "0"),
    (2, "0.00"),
    (3, "#,##0"),
    (4, "#,##0.00"),
    (9, "0%"),
    (10, "0.00%"),
    (11, "0.00E+00"),
    // id 12 (`"# ?/?"`) — V2 fraction, parser refuses; not pre-registered.
    (14, "m/d/yyyy"),
    (15, "d-mmm-yy"),
    (16, "d-mmm"),
    (17, "mmm-yy"),
    (18, "h:mm AM/PM"),
    (19, "h:mm:ss AM/PM"),
    (20, "h:mm"),
    (21, "h:mm:ss"),
    (22, "m/d/yyyy h:mm"),
    (37, "#,##0 ;(#,##0)"),
    // id 38 — V2 color; parser refuses.
    (45, "mm:ss"),
    // id 46 — V2 elapsed; parser refuses.
    (49, "@"),
];

/// Workbook-level format-string interning + dedup table.
///
/// Cells reference a `FormatId`; the table resolves the id back to a
/// format string the renderer can parse.
///
/// Phase 5.2 D-1 step 3: `FormatTable` now carries a `local_peer`
/// (`PeerId`) used when allocating new `Custom` format ids in
/// [`Self::intern`]. Single-writer / pre-collab construction (e.g.
/// `FormatTable::new()`) uses [`LEGACY_PEER`]; multi-peer
/// `CollabSession` callers re-construct with their session's peer
/// at attach time (step 4 wiring).
#[derive(Clone, Debug)]
pub struct FormatTable {
    /// `id → string`. Sparse (only entries that exist).
    by_id: HashMap<FormatId, String>,
    /// `string → id`. Used by `intern` for dedup.
    by_string: HashMap<String, FormatId>,
    /// Next `Custom(local_peer, _)` counter to hand out. Each peer's
    /// counter is independent; concurrent peers can't collide because
    /// the `PeerId` differs. Starts at `0` (post-5.2; pre-5.2 used
    /// `FIRST_CUSTOM_FORMAT_ID = 164` in the bare-u32 encoding).
    next_custom_counter: u32,
    /// Peer id used when allocating `Custom` ids via `intern`.
    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
    /// for backward compat with pre-collab single-writer mode.
    /// `CollabSession::attach` (step 4) updates this via
    /// [`Self::set_local_peer`] when a multi-peer session takes over.
    local_peer: PeerId,
}

impl Default for FormatTable {
    fn default() -> Self {
        Self::with_peer(LEGACY_PEER)
    }
}

impl FormatTable {
    /// Fresh table with Excel built-ins (mini-spec § 10 subset) pre-loaded.
    /// Custom ids allocated by this instance carry [`LEGACY_PEER`] —
    /// matching the pre-5.2 single-writer semantics.
    pub fn new() -> Self {
        Self::default()
    }

    /// Phase 5.2 D-1 step 3: fresh table with `peer` set as the
    /// allocator's `local_peer`. Future custom-id allocations via
    /// [`Self::intern`] produce `FormatId::Custom(peer, counter)`
    /// with monotonic per-peer counter.
    pub fn with_peer(peer: PeerId) -> Self {
        let mut t = Self {
            by_id: HashMap::new(),
            by_string: HashMap::new(),
            next_custom_counter: 0,
            local_peer: peer,
        };
        for (id, s) in BUILTIN_FORMATS {
            let fid = FormatId::Builtin(*id);
            t.by_id.insert(fid, (*s).to_string());
            t.by_string.insert((*s).to_string(), fid);
        }
        t
    }

    /// Phase 5.2 D-1 step 3: peer id used for future custom-id
    /// allocations. Read by `Op::RegisterFormat` producers and by
    /// tests verifying peer-aware allocation.
    pub fn local_peer(&self) -> PeerId {
        self.local_peer
    }

    /// Phase 5.2 D-1 step 3: change the peer id used for future
    /// allocations. Existing entries are NOT relabeled — they keep
    /// the peer they were originally allocated under.
    ///
    /// Step 4 will call this from `CollabSession::attach` when a
    /// multi-peer session takes over from the default
    /// `LEGACY_PEER`-tagged construction.
    pub fn set_local_peer(&mut self, peer: PeerId) {
        self.local_peer = peer;
    }

    /// Look up the format string for `id`. Returns `None` if the id has
    /// never been registered (which includes most reserved 0-163 ids that
    /// weren't pre-populated by V1 — those land via xlsx import).
    pub fn lookup(&self, id: FormatId) -> Option<&str> {
        self.by_id.get(&id).map(|s| s.as_str())
    }

    /// Intern `s`. Returns the existing id if `s` is already present;
    /// otherwise allocates a new `FormatId::Custom(local_peer, counter)`
    /// and stores both directions.
    ///
    /// **Replay determinism:** the allocator is monotonic in insertion
    /// order WITHIN A PEER. As long as the op-log replays
    /// `Op::RegisterFormat` events in the same order they were
    /// originally written, custom ids reconstruct identically. Across
    /// peers, the `peer` component of each `Custom` keeps ids distinct
    /// even when counter values collide.
    pub fn intern(&mut self, s: &str) -> FormatId {
        if let Some(id) = self.by_string.get(s) {
            return *id;
        }
        let id = FormatId::Custom(self.local_peer, self.next_custom_counter);
        self.next_custom_counter += 1;
        self.by_id.insert(id, s.to_string());
        self.by_string.insert(s.to_string(), id);
        id
    }

    /// Register `s` at a specific id (typically an Excel built-in or a
    /// replay path). Returns `Err` if the id is already taken with a
    /// different string — that would break round-trip determinism.
    ///
    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
    /// this to reproduce the original allocator state — including ids
    /// allocated by OTHER peers (post-step-3).
    ///
    /// For ids tagged with `self.local_peer`, advances the local
    /// counter past the registered counter so subsequent `intern`
    /// calls don't collide.
    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
        if let Some(existing) = self.by_id.get(&id) {
            if existing == s {
                return Ok(());
            }
            return Err(FormatTableError::IdCollision {
                id,
                existing: existing.clone(),
                attempted: s.to_string(),
            });
        }
        if let Some(existing_id) = self.by_string.get(s) {
            if *existing_id == id {
                return Ok(());
            }
            return Err(FormatTableError::StringCollision {
                string: s.to_string(),
                existing_id: *existing_id,
                attempted_id: id,
            });
        }
        self.by_id.insert(id, s.to_string());
        self.by_string.insert(s.to_string(), id);
        // If `id` is a Custom-variant for OUR peer, advance the local
        // counter so subsequent `intern` calls allocate fresh counters
        // past any replayed ones.
        if let FormatId::Custom(peer, counter) = id {
            if peer == self.local_peer && counter >= self.next_custom_counter {
                self.next_custom_counter = counter + 1;
            }
        }
        Ok(())
    }

    /// Total entries — useful for sanity checks, not for hot paths.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// True iff the table has no entries (should only be possible if a
    /// caller clears it; default construction loads built-ins).
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// The counter `intern` will use for the next allocation (the
    /// `counter` component of the resulting `FormatId::Custom(local_peer,
    /// counter)`). Exposed for tests + replay state-check.
    ///
    /// Phase 5.2 D-1 step 3 rename: was `next_custom_id() -> u32` and
    /// returned the full pre-5.2 u32 id. Now returns just the counter
    /// (which is per-peer); the full FormatId is built as
    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
    pub fn next_custom_counter(&self) -> u32 {
        self.next_custom_counter
    }

    /// Iterate `(id, &str)` in arbitrary order. Persistence + op-log
    /// snapshotting consumers must sort by id when wire-stable order
    /// matters.
    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
        self.by_id.iter().map(|(id, s)| (*id, s.as_str()))
    }
}

/// Errors from `register_at` collisions.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum FormatTableError {
    /// An id is already taken with a different string.
    IdCollision {
        id: FormatId,
        existing: String,
        attempted: String,
    },
    /// A string is already mapped to a different id.
    StringCollision {
        string: String,
        existing_id: FormatId,
        attempted_id: FormatId,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pre_populates_builtins() {
        let t = FormatTable::new();
        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
        assert_eq!(t.lookup(FormatId::Builtin(14)), Some("m/d/yyyy"));
        assert_eq!(t.lookup(FormatId::Builtin(49)), Some("@"));
    }

    #[test]
    fn unregistered_builtin_returns_none() {
        // id 12 (fraction) is V2-deferred and NOT pre-populated.
        let t = FormatTable::new();
        assert_eq!(t.lookup(FormatId::Builtin(12)), None);
    }

    #[test]
    fn intern_existing_returns_same_id() {
        let mut t = FormatTable::new();
        let id = t.intern("0.00");
        // "0.00" pre-loaded as Builtin(2).
        assert_eq!(id, FormatId::Builtin(2));
        // Re-intern same string returns same id.
        assert_eq!(t.intern("0.00"), id);
    }

    #[test]
    fn intern_new_allocates_custom_id_for_local_peer() {
        let mut t = FormatTable::new();
        let id = t.intern("\"€\" #,##0.00");
        // Step 3: custom ids are Custom(local_peer, counter). Default
        // FormatTable uses LEGACY_PEER; counter starts at 0.
        assert_eq!(id, FormatId::Custom(LEGACY_PEER, 0));
        // Stored both directions.
        assert_eq!(t.lookup(id), Some("\"€\" #,##0.00"));
        assert_eq!(t.intern("\"€\" #,##0.00"), id);
    }

    #[test]
    fn intern_two_distinct_strings_get_sequential_counters() {
        let mut t = FormatTable::new();
        let a = t.intern("CUSTOM_A");
        let b = t.intern("CUSTOM_B");
        match (a, b) {
            (FormatId::Custom(pa, ca), FormatId::Custom(pb, cb)) => {
                assert_eq!(pa, pb, "same FormatTable allocates under same peer");
                assert_eq!(cb, ca + 1, "counters monotonic");
            }
            other => panic!("expected two Custom ids, got {other:?}"),
        }
    }

    #[test]
    fn intern_with_distinct_peers_does_not_collide() {
        // Phase 5.1 audit-locked D-1: two peers allocating from
        // counter=0 produce distinct FormatIds because peer differs.
        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
        let id_a = peer_a.intern("SAME_STRING");
        let id_b = peer_b.intern("SAME_STRING");
        // Same string, same counter, distinct peers — still distinct FormatIds.
        assert_ne!(id_a, id_b);
        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
    }

    #[test]
    fn next_custom_counter_advances_on_intern() {
        let mut t = FormatTable::new();
        assert_eq!(t.next_custom_counter(), 0);
        let _ = t.intern("CUSTOM");
        assert_eq!(t.next_custom_counter(), 1);
    }

    #[test]
    fn register_at_replays_known_id() {
        let mut t = FormatTable::new();
        // Step 3: ids land as Builtin or Custom variants; register_at
        // accepts either.
        t.register_at(FormatId::Builtin(200), "REPLAY").unwrap();
        assert_eq!(t.lookup(FormatId::Builtin(200)), Some("REPLAY"));
    }

    #[test]
    fn register_at_advances_local_counter_for_own_peer() {
        // Replaying an Op::RegisterFormat that allocated under OUR
        // peer must advance our counter so subsequent intern calls
        // don't collide.
        let mut t = FormatTable::with_peer(PeerId::new(7));
        t.register_at(FormatId::Custom(PeerId::new(7), 5), "REPLAY")
            .unwrap();
        // Counter should now be 6 — next intern allocates at counter=6.
        let next = t.intern("AFTER");
        assert_eq!(next, FormatId::Custom(PeerId::new(7), 6));
    }

    #[test]
    fn register_at_other_peer_does_not_advance_local_counter() {
        // A remote peer's Op::RegisterFormat registers an id under
        // THEIR peer; our local counter is unaffected.
        let mut t = FormatTable::with_peer(PeerId::new(7));
        let baseline = t.next_custom_counter();
        t.register_at(FormatId::Custom(PeerId::new(99), 5), "FROM_OTHER")
            .unwrap();
        assert_eq!(
            t.next_custom_counter(),
            baseline,
            "remote peer's allocation must not advance our counter"
        );
    }

    #[test]
    fn register_at_same_id_same_string_is_idempotent() {
        let mut t = FormatTable::new();
        t.register_at(FormatId::Builtin(0), "General").unwrap();
        assert!(t.register_at(FormatId::Builtin(0), "General").is_ok());
    }

    #[test]
    fn register_at_id_collision_errors() {
        let mut t = FormatTable::new();
        let err = t
            .register_at(FormatId::Builtin(0), "DIFFERENT")
            .unwrap_err();
        assert!(matches!(err, FormatTableError::IdCollision { .. }));
    }

    #[test]
    fn register_at_string_collision_errors() {
        let mut t = FormatTable::new();
        // "General" is already at Builtin(0); registering it at a different id errors.
        let err = t
            .register_at(FormatId::Builtin(200), "General")
            .unwrap_err();
        assert!(matches!(err, FormatTableError::StringCollision { .. }));
    }

    #[test]
    fn intern_does_not_advance_for_repeats() {
        let mut t = FormatTable::new();
        let _ = t.intern("once");
        let n1 = t.next_custom_counter();
        let _ = t.intern("once");
        assert_eq!(
            t.next_custom_counter(),
            n1,
            "repeat intern must not advance counter"
        );
    }

    #[test]
    fn first_custom_id_is_past_builtins() {
        const _: () = assert!(FIRST_CUSTOM_FORMAT_ID > 163);
    }

    #[test]
    fn iter_returns_all_entries() {
        let mut t = FormatTable::new();
        let _ = t.intern("CUSTOM");
        let mut count = 0;
        for (id, s) in t.iter() {
            assert!(!s.is_empty(), "id {id:?} has empty string");
            count += 1;
        }
        assert_eq!(count, t.len());
    }

    #[test]
    fn general_is_builtin_zero() {
        assert_eq!(FormatId::GENERAL, FormatId::Builtin(0));
        assert!(FormatId::GENERAL.is_builtin());
        assert!(!FormatId::GENERAL.is_custom());
    }

    #[test]
    fn legacy_from_u32_maps_builtins_and_customs() {
        // Mirrors `FormatIdWire::from_u32_legacy` (step 2 ship).
        assert_eq!(FormatId::legacy_from_u32(0), FormatId::Builtin(0));
        assert_eq!(FormatId::legacy_from_u32(163), FormatId::Builtin(163));
        assert_eq!(
            FormatId::legacy_from_u32(164),
            FormatId::Custom(LEGACY_PEER, 0)
        );
        assert_eq!(
            FormatId::legacy_from_u32(999),
            FormatId::Custom(LEGACY_PEER, 999 - 164)
        );
    }

    #[test]
    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
        assert_eq!(
            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
            Some(264)
        );
    }

    #[test]
    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
        // A Custom id tagged with a non-LEGACY peer can't be
        // expressed in the pre-5.2 bare-u32 envelope. xlsx export
        // (step 6) decides what to do.
        let id = FormatId::Custom(PeerId::new(42), 7);
        assert_eq!(id.to_legacy_u32(), None);
    }

    #[test]
    fn legacy_round_trip_through_helpers() {
        for n in [0_u32, 1, 14, 163, 164, 165, 999, 10_000] {
            let id = FormatId::legacy_from_u32(n);
            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
        }
    }
}
