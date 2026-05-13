//! Workbook-level format-string interning table (Phase 4.5.D part 3,
//! W5-79).
//!
//! `FormatTable` reserves Excel built-in format IDs 0-163 and allocates
//! custom IDs from 164 upward. Pre-populates the parser-relevant subset
//! of built-ins (mini-spec § 10) so cells with the most common formats
//! resolve without any registration calls.
//!
//! See:
//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for the
//!   design.
//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
//!   the parser-relevant built-in subset.

use std::collections::HashMap;

/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
/// for the "no custom format" case (built-in id 0).
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FormatId(pub u32);

impl FormatId {
    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    pub const GENERAL: FormatId = FormatId(0);
}

/// First custom (non-built-in) format id. IDs 0-163 are reserved for
/// Excel's built-in table per OOXML / mini-spec § 10.
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
#[derive(Clone, Debug)]
pub struct FormatTable {
    /// `id → string`. Sparse (only entries that exist).
    by_id: HashMap<FormatId, String>,
    /// `string → id`. Used by `intern` for dedup.
    by_string: HashMap<String, FormatId>,
    /// Next custom id to hand out. Always >= [`FIRST_CUSTOM_FORMAT_ID`].
    next_custom_id: u32,
}

impl Default for FormatTable {
    fn default() -> Self {
        let mut t = Self {
            by_id: HashMap::new(),
            by_string: HashMap::new(),
            next_custom_id: FIRST_CUSTOM_FORMAT_ID,
        };
        for (id, s) in BUILTIN_FORMATS {
            let fid = FormatId(*id);
            t.by_id.insert(fid, (*s).to_string());
            t.by_string.insert((*s).to_string(), fid);
        }
        t
    }
}

impl FormatTable {
    /// Fresh table with Excel built-ins (mini-spec § 10 subset) pre-loaded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up the format string for `id`. Returns `None` if the id has
    /// never been registered (which includes most reserved 0-163 ids that
    /// weren't pre-populated by V1 — those land via xlsx import).
    pub fn lookup(&self, id: FormatId) -> Option<&str> {
        self.by_id.get(&id).map(|s| s.as_str())
    }

    /// Intern `s`. Returns the existing id if `s` is already present;
    /// otherwise allocates a new custom id (≥ [`FIRST_CUSTOM_FORMAT_ID`])
    /// and stores both directions.
    ///
    /// **Replay determinism:** the allocator is monotonic in insertion
    /// order. As long as the op-log replays `Op::RegisterFormat` events
    /// in the same order they were originally written, custom ids
    /// reconstruct identically.
    pub fn intern(&mut self, s: &str) -> FormatId {
        if let Some(id) = self.by_string.get(s) {
            return *id;
        }
        let id = FormatId(self.next_custom_id);
        self.next_custom_id += 1;
        self.by_id.insert(id, s.to_string());
        self.by_string.insert(s.to_string(), id);
        id
    }

    /// Register `s` at a specific id (typically an Excel built-in or a
    /// replay path). Returns `Err` if the id is already taken with a
    /// different string — that would break round-trip determinism.
    ///
    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
    /// this to reproduce the original allocator state.
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
        if id.0 >= self.next_custom_id {
            self.next_custom_id = id.0 + 1;
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

    /// The id `intern` will allocate on its next miss. Exposed for tests
    /// + replay state-check.
    pub fn next_custom_id(&self) -> u32 {
        self.next_custom_id
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
        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
        assert_eq!(t.lookup(FormatId(49)), Some("@"));
    }

    #[test]
    fn unregistered_builtin_returns_none() {
        // id 12 (fraction) is V2-deferred and NOT pre-populated.
        let t = FormatTable::new();
        assert_eq!(t.lookup(FormatId(12)), None);
    }

    #[test]
    fn intern_existing_returns_same_id() {
        let mut t = FormatTable::new();
        let id = t.intern("0.00");
        assert_eq!(id, FormatId(2));
        // Re-intern same string returns same id.
        assert_eq!(t.intern("0.00"), id);
    }

    #[test]
    fn intern_new_allocates_custom_id() {
        let mut t = FormatTable::new();
        let id = t.intern("\"€\" #,##0.00");
        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
        // Stored both directions.
        assert_eq!(t.lookup(id), Some("\"€\" #,##0.00"));
        assert_eq!(t.intern("\"€\" #,##0.00"), id);
    }

    #[test]
    fn intern_two_distinct_strings_get_sequential_ids() {
        let mut t = FormatTable::new();
        let a = t.intern("CUSTOM_A");
        let b = t.intern("CUSTOM_B");
        assert_eq!(b.0, a.0 + 1);
    }

    #[test]
    fn next_custom_id_advances_on_intern() {
        let mut t = FormatTable::new();
        assert_eq!(t.next_custom_id(), FIRST_CUSTOM_FORMAT_ID);
        let _ = t.intern("CUSTOM");
        assert_eq!(t.next_custom_id(), FIRST_CUSTOM_FORMAT_ID + 1);
    }

    #[test]
    fn register_at_replays_known_id() {
        let mut t = FormatTable::new();
        t.register_at(FormatId(200), "REPLAY").unwrap();
        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
        // Next intern should land at 201 (past the manual registration).
        let next = t.intern("ANOTHER");
        assert_eq!(next, FormatId(201));
    }

    #[test]
    fn register_at_same_id_same_string_is_idempotent() {
        let mut t = FormatTable::new();
        t.register_at(FormatId(0), "General").unwrap();
        assert!(t.register_at(FormatId(0), "General").is_ok());
    }

    #[test]
    fn register_at_id_collision_errors() {
        let mut t = FormatTable::new();
        let err = t.register_at(FormatId(0), "DIFFERENT").unwrap_err();
        assert!(matches!(err, FormatTableError::IdCollision { .. }));
    }

    #[test]
    fn register_at_string_collision_errors() {
        let mut t = FormatTable::new();
        // "General" is already at id 0; registering it at a different id errors.
        let err = t.register_at(FormatId(200), "General").unwrap_err();
        assert!(matches!(err, FormatTableError::StringCollision { .. }));
    }

    #[test]
    fn intern_does_not_advance_for_repeats() {
        let mut t = FormatTable::new();
        let _ = t.intern("once");
        let n1 = t.next_custom_id();
        let _ = t.intern("once");
        assert_eq!(
            t.next_custom_id(),
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
    fn general_is_id_zero() {
        assert_eq!(FormatId::GENERAL, FormatId(0));
    }
}
