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
///
/// **Builtin(n) range invariant (step 3 audit Codex+Opus MEDIUM-1):**
/// `FormatId::Builtin(n)` is contractually valid ONLY for
/// `n <= FIRST_XLSX_BUILTIN_MAX` (= 163). The enum's tuple variant
/// can't enforce this at the type level (Rust syntax limitation), so
/// the invariant is documentary. **Callers MUST use
/// [`FormatId::legacy_from_u32`] for u32 values that may exceed
/// 163** — that helper routes 164+ to `Custom(LEGACY_PEER, n - 164)`.
/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
/// `legacy_from_u32` round-trip (becomes asymmetric in the
/// storage→u32→storage direction).
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
    /// `string → Builtin(n)`. Built-in format strings are global —
    /// "General" must always resolve to `Builtin(0)` regardless of
    /// peer. Used by `intern` for built-in lookup (Excel-canonical
    /// strings short-circuit before peer-namespaced lookup).
    ///
    /// Phase 5.2 D-1 step 4 restructure (Codex audit HIGH-2 closure):
    /// was previously a single global `HashMap<String, FormatId>`
    /// that rejected cross-peer same-string allocations. Now split
    /// into separate built-in vs peer-namespaced maps.
    by_builtin_string: HashMap<String, FormatId>,
    /// `(peer, string) → Custom(peer, _)`. Used by `intern` for
    /// per-peer dedup. Two peers interning the same string produce
    /// distinct `Custom` ids with distinct counters — Phase 5.1 D-1
    /// audit-locked design.
    ///
    /// Phase 5.2 D-1 step 4 restructure (Codex audit HIGH-2 closure):
    /// see above.
    by_custom_string: HashMap<(PeerId, String), FormatId>,
    /// Next `Custom(local_peer, _)` counter to hand out. Each peer's
    /// counter is independent; concurrent peers can't collide because
    /// the `PeerId` differs. Starts at `0` (post-5.2; pre-5.2 used
    /// `FIRST_CUSTOM_FORMAT_ID = 164` in the bare-u32 encoding).
    next_custom_counter: u32,
    /// Peer id used when allocating `Custom` ids via `intern`.
    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
    /// for backward compat with pre-collab single-writer mode.
    /// `CollabSession::attach` (step 7 IDE work) updates this via
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
            by_builtin_string: HashMap::new(),
            by_custom_string: HashMap::new(),
            next_custom_counter: 0,
            local_peer: peer,
        };
        for (id, s) in BUILTIN_FORMATS {
            let fid = FormatId::Builtin(*id);
            t.by_id.insert(fid, (*s).to_string());
            t.by_builtin_string.insert((*s).to_string(), fid);
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
    /// **Counter resync (step 3 audit Codex HIGH-1 closure):** scans
    /// `by_id` for existing `Custom(peer, _)` entries and sets
    /// `next_custom_counter` to `max(c) + 1` so the new peer's
    /// allocator doesn't overwrite entries already registered for it
    /// (e.g. via replay of a remote peer's `Op::RegisterFormat`).
    /// Without this scan, a sequence like:
    ///
    /// 1. `register_at(Custom(P, 0), "X")` (replay; local peer ≠ P)
    /// 2. `set_local_peer(P)`
    /// 3. `intern("Y")`
    ///
    /// would overwrite the entry at `Custom(P, 0)` (was "X", becomes
    /// "Y") because the counter wasn't reset.
    ///
    /// Step 4 will call this from `CollabSession::attach` when a
    /// multi-peer session takes over from the default
    /// `LEGACY_PEER`-tagged construction.
    pub fn set_local_peer(&mut self, peer: PeerId) {
        self.local_peer = peer;
        // Resync counter to max(existing Custom(peer, c).c) + 1, or 0
        // if no such entry exists. This guarantees subsequent `intern`
        // calls allocate fresh counters past anything replayed for
        // this peer.
        let max_existing = self
            .by_id
            .keys()
            .filter_map(|fid| match fid {
                FormatId::Custom(p, c) if *p == peer => Some(*c),
                _ => None,
            })
            .max();
        // Step-4 audit Codex MEDIUM-1: use checked_add to catch
        // u32::MAX counter overflow (which would wrap to 0 in release
        // and overwrite Custom(peer, 0)). With u32::MAX peer-local
        // custom formats this fires loudly rather than corrupting.
        self.next_custom_counter = max_existing
            .map(|c| {
                c.checked_add(1).expect(
                    "FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)",
                )
            })
            .unwrap_or(0);
    }

    /// Look up the format string for `id`. Returns `None` if the id has
    /// never been registered (which includes most reserved 0-163 ids that
    /// weren't pre-populated by V1 — those land via xlsx import).
    pub fn lookup(&self, id: FormatId) -> Option<&str> {
        self.by_id.get(&id).map(|s| s.as_str())
    }

    /// **Phase 5.2 D-1 step 4 audit Codex HIGH-1 closure:** lookup a
    /// format-string and return the id this peer's `intern(s)` would
    /// return WITHOUT allocating. Mirrors `intern`'s lookup order:
    ///
    /// 1. `by_builtin_string` (Excel canonical strings short-circuit
    ///    globally — same answer for every peer).
    /// 2. `by_custom_string[(local_peer, s)]` (THIS peer's Custom
    ///    dedup; intentionally does NOT find OTHER peers' Customs
    ///    with the same string).
    /// 3. Returns `None` if no existing id — caller `intern_format`
    ///    knows it must emit `Op::RegisterFormat` for the new allocation.
    ///
    /// Used by `WorkbookRuntime::intern_format` to dedupe correctly
    /// under multi-peer semantics. The pre-step-4 producer used
    /// `FormatTable::iter().find(|(_, t)| *t == s)` which returned
    /// ANY id with that string, including remote peers' Customs —
    /// that broke producer/replay symmetry once multi-peer replay
    /// populated `by_id` with other peers' entries.
    pub fn lookup_string(&self, s: &str) -> Option<FormatId> {
        if let Some(id) = self.by_builtin_string.get(s) {
            return Some(*id);
        }
        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
            return Some(*id);
        }
        None
    }

    /// Intern `s`. Returns the existing id if `s` is already present;
    /// otherwise allocates a new `FormatId::Custom(local_peer, counter)`
    /// and stores both directions.
    ///
    /// **Lookup order (Phase 5.2 D-1 step 4 restructure):**
    /// 1. `by_builtin_string` first — Excel built-ins are global; e.g.
    ///    `intern("General")` always returns `Builtin(0)` regardless of
    ///    `local_peer`.
    /// 2. `by_custom_string[(local_peer, s)]` — this peer's own custom
    ///    dedup map. A remote peer's `Custom(other_peer, _)` with the
    ///    same string does NOT short-circuit our allocation.
    /// 3. Allocate fresh `Custom(local_peer, counter)`.
    ///
    /// **Replay determinism:** the allocator is monotonic in insertion
    /// order WITHIN A PEER. As long as the op-log replays
    /// `Op::RegisterFormat` events in the same order they were
    /// originally written, custom ids reconstruct identically. Across
    /// peers, the `peer` component of each `Custom` keeps ids distinct
    /// even when counter values collide.
    pub fn intern(&mut self, s: &str) -> FormatId {
        if let Some(id) = self.by_builtin_string.get(s) {
            return *id;
        }
        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
            return *id;
        }
        let id = FormatId::Custom(self.local_peer, self.next_custom_counter);
        // Step-4 audit Codex MEDIUM-1: checked_add to catch overflow.
        self.next_custom_counter = self
            .next_custom_counter
            .checked_add(1)
            .expect("FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)");
        self.by_id.insert(id, s.to_string());
        self.by_custom_string
            .insert((self.local_peer, s.to_string()), id);
        id
    }

    /// Register `s` at a specific id (typically an Excel built-in or a
    /// replay path). Returns `Err` if the id is already taken with a
    /// different string — that would break round-trip determinism.
    ///
    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
    /// this to reproduce the original allocator state — including ids
    /// allocated by OTHER peers.
    ///
    /// For ids tagged with `self.local_peer`, advances the local
    /// counter past the registered counter so subsequent `intern`
    /// calls don't collide.
    ///
    /// **Step 4 by_string restructure (Codex step-3 audit HIGH-2
    /// closure):** Custom and Builtin variants use SEPARATE dedup
    /// maps. Two peers can register the same string under their own
    /// `Custom(peer, _)` ids without collision (Phase 5.1 D-1
    /// audit-locked design). Cross-variant string collisions are
    /// allowed too — e.g. LibreOffice writes `<numFmt numFmtId="164"
    /// formatCode="General"/>` (Custom variant) while "General" also
    /// lives at `Builtin(0)`; both coexist.
    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
        // Step 1: id-side dedup. If `id` is already present, must map
        // to the same string (else IdCollision — a real corruption).
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
        // Step 2: string-side dedup, routed by variant.
        match id {
            FormatId::Builtin(_) => {
                if let Some(existing_id) = self.by_builtin_string.get(s) {
                    if *existing_id == id {
                        return Ok(());
                    }
                    return Err(FormatTableError::StringCollision {
                        string: s.to_string(),
                        existing_id: *existing_id,
                        attempted_id: id,
                    });
                }
            }
            FormatId::Custom(peer, _) => {
                if let Some(existing_id) = self.by_custom_string.get(&(peer, s.to_string())) {
                    if *existing_id == id {
                        return Ok(());
                    }
                    return Err(FormatTableError::StringCollision {
                        string: s.to_string(),
                        existing_id: *existing_id,
                        attempted_id: id,
                    });
                }
            }
        }
        // Step 3: insert into by_id + the appropriate string map.
        self.by_id.insert(id, s.to_string());
        match id {
            FormatId::Builtin(_) => {
                self.by_builtin_string.insert(s.to_string(), id);
            }
            FormatId::Custom(peer, _) => {
                self.by_custom_string.insert((peer, s.to_string()), id);
            }
        }
        // Step 4: if `id` is a Custom-variant for OUR peer, advance
        // the local counter so subsequent `intern` calls allocate
        // fresh counters past any replayed ones.
        if let FormatId::Custom(peer, counter) = id {
            if peer == self.local_peer && counter >= self.next_custom_counter {
                // Step-4 audit Codex MEDIUM-1: checked_add to catch
                // overflow. Replaying a remote op with counter ==
                // u32::MAX targeting our own peer would otherwise
                // wrap to 0 in release builds.
                self.next_custom_counter = counter.checked_add(1).expect(
                    "FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)",
                );
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
        // Step 3 audit Codex+Opus MEDIUM-1 closure: id 200 in legacy
        // u32 encoding is `Custom(LEGACY_PEER, 36)` per legacy_from_u32
        // (NOT `Builtin(200)` — Builtin invariant is 0..=163 per
        // docstring). Test now uses the migration helper to construct
        // the id, matching how real replay would resolve it.
        let id_200 = FormatId::legacy_from_u32(200);
        t.register_at(id_200, "REPLAY").unwrap();
        assert_eq!(t.lookup(id_200), Some("REPLAY"));
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

    /// Step 4 audit Codex HIGH-1 closure: pin that `lookup_string`
    /// is peer-scoped — a remote peer's `Custom(other_peer, _)` for
    /// the same string MUST NOT short-circuit our local lookup.
    /// Without this discipline, `WorkbookRuntime::intern_format`
    /// would return remote peer ids without emitting RegisterFormat,
    /// breaking producer/replay symmetry under multi-peer replay.
    #[test]
    fn lookup_string_is_peer_scoped_for_custom_variant() {
        let mut t = FormatTable::with_peer(PeerId::new(0xa));
        let remote_peer = PeerId::new(0xb);
        // Replay scenario: remote peer's Op::RegisterFormat registers
        // their Custom(B, 0) → "yyyy-mm-dd".
        t.register_at(FormatId::Custom(remote_peer, 0), "yyyy-mm-dd")
            .unwrap();
        // Local peer's lookup MUST return None (the remote peer's
        // entry doesn't belong to our namespace).
        assert_eq!(
            t.lookup_string("yyyy-mm-dd"),
            None,
            "lookup_string must NOT find remote peer's Custom"
        );
        // After local peer interns the same string, lookup returns
        // OUR Custom (not the remote peer's).
        let local_id = t.intern("yyyy-mm-dd");
        assert_eq!(local_id, FormatId::Custom(PeerId::new(0xa), 0));
        assert_eq!(t.lookup_string("yyyy-mm-dd"), Some(local_id));
    }

    /// Step 4 audit Codex HIGH-1: pin that `lookup_string` returns
    /// the Built-in id for canonical strings, regardless of any
    /// Custom variant with the same string. Built-in lookup is global.
    #[test]
    fn lookup_string_returns_builtin_even_when_custom_variant_exists() {
        let mut t = FormatTable::new();
        // Pre-populate Custom(LEGACY_PEER, 0) → "General" via
        // register_at (mirrors the LibreOffice import quirk).
        t.register_at(FormatId::Custom(LEGACY_PEER, 0), "General")
            .unwrap();
        // intern_format would call lookup_string first; must return
        // Builtin(0), NOT the Custom variant.
        assert_eq!(t.lookup_string("General"), Some(FormatId::Builtin(0)));
    }

    /// Step 4 audit Opus L5 closure: pin that Builtin-vs-Builtin
    /// same-string-different-id is still rejected as StringCollision.
    /// The pre-step-4 test exercised this implicitly via the
    /// "General" cross-variant case; post-step-4 cross-variant is
    /// allowed, so this case needs its own test.
    #[test]
    fn register_at_builtin_vs_builtin_same_string_collision_rejects() {
        let mut t = FormatTable::new();
        // "General" is pre-loaded at Builtin(0). Registering it at
        // Builtin(99) must error with StringCollision (within the
        // built-in namespace).
        let err = t.register_at(FormatId::Builtin(99), "General").unwrap_err();
        assert!(matches!(err, FormatTableError::StringCollision { .. }));
    }

    #[test]
    fn register_at_string_collision_errors_same_variant_namespace() {
        // Step 4 by_string restructure: collision is detected
        // WITHIN-variant only (Builtin vs Builtin; same-peer Custom
        // vs same-peer Custom). Cross-variant collisions (e.g. Custom
        // attempting "General" while Builtin(0) owns it) are ALLOWED —
        // see `cross_peer_same_string_now_succeeds_after_step4_restructure`
        // and the LibreOffice "redundant General-at-custom-id" pattern
        // in xlsx import.
        //
        // This test pins WITHIN-namespace collision: same-peer trying
        // to register the same string at two different Custom counters
        // is producer corruption.
        let mut t = FormatTable::with_peer(PeerId::new(0xa));
        t.register_at(FormatId::Custom(PeerId::new(0xa), 0), "MY_FMT")
            .unwrap();
        let err = t
            .register_at(FormatId::Custom(PeerId::new(0xa), 1), "MY_FMT")
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
        // Step 3 audit Codex LOW (closure): added u32::MAX edge to pin
        // checked arithmetic. counter = u32::MAX - 164 = 4_294_967_131
        // fits in u32; reverse adds 164 back without overflow.
        for n in [
            0_u32,
            1,
            14,
            163,
            164,
            165,
            999,
            10_000,
            u32::MAX - 1,
            u32::MAX,
        ] {
            let id = FormatId::legacy_from_u32(n);
            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
        }
    }

    // ===== Step 3 audit closure tests (2026-05-19) =====

    /// **Codex HIGH-1 closure:** verify `set_local_peer` resyncs the
    /// counter past any existing `Custom(peer, _)` entries so a
    /// subsequent `intern` doesn't overwrite a replayed entry.
    ///
    /// Pre-fix scenario: replay registers `Custom(P, 0)` → "X" while
    /// local_peer = LEGACY. Then `set_local_peer(P)`; intern("Y")
    /// would allocate `Custom(P, 0)` (counter unchanged at 0) and
    /// CORRUPT the existing entry. Post-fix: set_local_peer scans
    /// by_id, finds Custom(P, 0), bumps counter to 1; intern("Y")
    /// allocates Custom(P, 1).
    #[test]
    fn set_local_peer_resyncs_counter_past_replayed_remote_entries() {
        let mut t = FormatTable::with_peer(LEGACY_PEER);
        // Simulate replay of a remote peer's Op::RegisterFormat.
        let remote_peer = PeerId::new(0xa1);
        t.register_at(FormatId::Custom(remote_peer, 0), "X")
            .unwrap();
        t.register_at(FormatId::Custom(remote_peer, 1), "Y")
            .unwrap();
        t.register_at(FormatId::Custom(remote_peer, 3), "Z")
            .unwrap();
        // Counter still 0 because remote_peer ≠ local_peer.
        assert_eq!(t.next_custom_counter(), 0);

        // Now take over as remote_peer.
        t.set_local_peer(remote_peer);
        // Counter must have advanced past the max(0, 1, 3) = 3 → 4.
        assert_eq!(
            t.next_custom_counter(),
            4,
            "set_local_peer must scan + reset counter past existing Custom(new_peer, _) entries"
        );

        // intern("NEW") allocates Custom(remote_peer, 4) — does NOT
        // overwrite any of the replayed entries.
        let new_id = t.intern("NEW");
        assert_eq!(new_id, FormatId::Custom(remote_peer, 4));
        // Replayed entries survive.
        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 0)), Some("X"));
        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 1)), Some("Y"));
        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 3)), Some("Z"));
        assert_eq!(t.lookup(new_id), Some("NEW"));
    }

    #[test]
    fn set_local_peer_resets_counter_to_zero_when_no_existing_entries() {
        // If the new peer has no Custom(new_peer, _) entries yet,
        // counter resets to 0 (fresh allocator namespace).
        let mut t = FormatTable::with_peer(LEGACY_PEER);
        let _ = t.intern("A"); // Custom(LEGACY, 0)
        let _ = t.intern("B"); // Custom(LEGACY, 1)
        assert_eq!(t.next_custom_counter(), 2);

        t.set_local_peer(PeerId::new(0xb2));
        // No Custom(0xb2, _) entries → counter resets to 0.
        assert_eq!(t.next_custom_counter(), 0);
        let next = t.intern("C");
        assert_eq!(next, FormatId::Custom(PeerId::new(0xb2), 0));
    }

    /// **Step 4 closure of step-3 audit Codex HIGH-2:** two peers
    /// independently interning the same format string produces
    /// collision-free `Custom(A, 0)` + `Custom(B, 0)` `FormatId`s per
    /// Phase 5.1 D-1 audit-locked design. Step 4 restructured
    /// `by_string` into separate `by_builtin_string` + `by_custom_string`
    /// maps, the latter keyed by `(PeerId, String)`. This test now
    /// ASSERTS the cross-peer same-string registration SUCCEEDS (was
    /// pinned-as-rejection in cycle 4 step-3 audit; inverted in cycle
    /// 5 step 4 ship).
    #[test]
    fn cross_peer_same_string_now_succeeds_after_step4_restructure() {
        let mut t = FormatTable::with_peer(LEGACY_PEER);
        let peer_a = PeerId::new(0xa);
        let peer_b = PeerId::new(0xb);

        // Replay peer A's op.
        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
            .unwrap();
        // Replay peer B's op for the SAME string. Step 4 by_string
        // restructure: both succeed; ids coexist in by_id.
        t.register_at(FormatId::Custom(peer_b, 0), "yyyy-mm-dd")
            .unwrap();
        // Both ids resolve back to the same string.
        assert_eq!(t.lookup(FormatId::Custom(peer_a, 0)), Some("yyyy-mm-dd"));
        assert_eq!(t.lookup(FormatId::Custom(peer_b, 0)), Some("yyyy-mm-dd"));
        // Same-peer same-string is still idempotent.
        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
            .unwrap();
        // Same-peer DIFFERENT-counter same-string is StringCollision
        // (would produce two distinct Custom(A, _) ids for one string
        // — that IS a producer bug).
        let err = t
            .register_at(FormatId::Custom(peer_a, 1), "yyyy-mm-dd")
            .unwrap_err();
        assert!(matches!(err, FormatTableError::StringCollision { .. }));
    }

    /// Step 4 by_string restructure: built-in strings remain global.
    /// `intern("General")` always returns `Builtin(0)` regardless of
    /// `local_peer` — built-ins are not peer-scoped.
    #[test]
    fn builtin_string_intern_is_global_across_peers() {
        let mut t = FormatTable::with_peer(PeerId::new(0xa));
        let id = t.intern("General");
        assert_eq!(id, FormatId::GENERAL);
        // Switch peers; "General" still resolves to Builtin(0).
        t.set_local_peer(PeerId::new(0xb));
        assert_eq!(t.intern("General"), FormatId::GENERAL);
    }

    /// Step 4 by_string restructure: two peers calling intern() for
    /// the same NON-built-in string each get their own Custom id.
    /// (Validates the producer-side dedup is peer-scoped.)
    #[test]
    fn intern_same_custom_string_under_distinct_peers_allocates_distinct_ids() {
        let mut t_a = FormatTable::with_peer(PeerId::new(0xa));
        let mut t_b = FormatTable::with_peer(PeerId::new(0xb));
        let id_a = t_a.intern("yyyy-mm-dd");
        let id_b = t_b.intern("yyyy-mm-dd");
        // Each peer allocates its own Custom(peer, 0).
        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
        // Cross-peer same-string SAME table also works (audit-closure
        // scenario): register A's id into B's table, then intern same
        // string locally — local peer gets its own Custom.
        let mut t_mixed = FormatTable::with_peer(PeerId::new(0xa));
        t_mixed
            .register_at(FormatId::Custom(PeerId::new(0xb), 0), "yyyy-mm-dd")
            .unwrap();
        let local_id = t_mixed.intern("yyyy-mm-dd");
        assert_eq!(
            local_id,
            FormatId::Custom(PeerId::new(0xa), 0),
            "intern under local peer must NOT short-circuit to a remote peer's Custom"
        );
    }

    /// **Opus L4 closure:** pin that `Builtin(0)` and
    /// `Custom(LEGACY_PEER, 0)` (which would round-trip to legacy
    /// u32=164) hash + compare as DIFFERENT FormatIds. The
    /// derive(Eq) and derive(Hash) on enum variants guarantee this,
    /// but a regression test documents the invariant.
    #[test]
    fn builtin_and_custom_with_same_inner_zero_are_distinct() {
        use std::collections::HashMap;
        let b = FormatId::Builtin(0);
        let c = FormatId::Custom(LEGACY_PEER, 0);
        assert_ne!(b, c, "Eq must distinguish variants with same inner value");
        let mut map: HashMap<FormatId, &str> = HashMap::new();
        map.insert(b, "builtin");
        map.insert(c, "custom");
        assert_eq!(map.len(), 2, "Hash must distinguish variants");
        assert_eq!(map.get(&b), Some(&"builtin"));
        assert_eq!(map.get(&c), Some(&"custom"));
    }

    /// **Opus M2 closure:** pin that `register_at(Builtin(N), s)` does
    /// NOT advance the local counter. The counter advancement logic
    /// is only triggered by `Custom(local_peer, c)` ids.
    #[test]
    fn register_at_builtin_does_not_advance_counter() {
        let mut t = FormatTable::with_peer(LEGACY_PEER);
        let baseline = t.next_custom_counter();
        // Register a built-in that wasn't pre-loaded (V2-deferred ids
        // like 12, 38, 46).
        t.register_at(FormatId::Builtin(12), "# ?/?").unwrap();
        t.register_at(FormatId::Builtin(38), "[Red]0").unwrap();
        assert_eq!(
            t.next_custom_counter(),
            baseline,
            "register_at(Builtin(_)) must not advance the custom counter"
        );
    }
}
