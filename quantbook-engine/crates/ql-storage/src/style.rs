//! Workbook-level cell-STYLE value type + interning table (FE-4 W4,
//! 2026-06-10).
//!
//! This is the cell-STYLE foundation: the visual-formatting overlay that
//! sits ALONGSIDE the number-format overlay ([`crate::format`]). Where a
//! [`crate::FormatId`] selects a number-format STRING ("0.00%",
//! "yyyy-mm-dd", ...) that decides how a value is TEXTUALLY rendered, a
//! [`StyleId`] selects a [`Style`] value — bold/italic/fill/alignment +
//! per-edge BORDERS — that decides how a cell is VISUALLY presented.
//!
//! ## Design: mirror [`crate::FormatTable`], with two deliberate divergences
//!
//! 1. **The interned value is a struct, not a string.** [`FormatTable`]
//!    interns `&str`; [`StyleTable`] interns whole [`Style`] values. The
//!    interner dedups by VALUE (`Style: Eq + Hash`), exactly as the format
//!    table dedups by string. Two cells set to the same bold-red-thin-border
//!    style share one [`StyleId`].
//!
//! 2. **No `Builtin` variant.** Excel number-formats reserve canonical
//!    built-in ids 0..=163; styles have NO such global registry. So
//!    [`StyleId`] is a single peer-allocated tuple
//!    `StyleId { peer, counter }` — the moral equivalent of
//!    `FormatId::Custom(peer, counter)` WITHOUT the `Builtin` short-circuit.
//!    This keeps the CRDT collision-freedom guarantee (Phase 5.1 audit-locked
//!    decision D-1): two concurrent peers each allocate from `counter = 0`
//!    but their full `StyleId`s differ in the `peer` component.
//!
//! Single-writer / pre-collab callers (the owning `WorkbookSession`) use
//! [`ql_types::LEGACY_PEER`] as the `local_peer`; a multi-peer session would
//! re-construct with its own `PeerId` at attach time (mirrors
//! `FormatTable::set_local_peer`).
//!
//! ## No fallbacks
//!
//! Per the No-Fallbacks rule, [`StyleTable::register_at`] surfaces id /
//! value collisions + counter overflow as recoverable [`StyleTableError`]s
//! (NOT panics), so user-controlled load paths (`.qbook` envelope + op-log
//! replay) fail LOUDLY at the ingestion point rather than corrupting state.

use std::collections::HashMap;

use ql_types::{PeerId, LEGACY_PEER};

/// A 24-bit RGB color (no alpha — cell fills + border colors are opaque in
/// the v1 schema). Flat, `Copy`, value-comparable so a whole [`Style`]
/// interns + dedups as one unit.
///
/// No `serde` derive: storage types stay dependency-clean (mirroring
/// [`crate::FormatId`], whose wire shapes live in `ql-oplog` /
/// `ql-io`). The op-log `StyleWire` + the `.qbook` `StyleEntry` carry the
/// serde shapes and convert losslessly.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// Construct from raw channels.
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }
}

/// Horizontal alignment of a cell's content.
///
/// `General` is the Excel default: numbers right-align, text left-aligns,
/// the renderer decides per value type. The other three are explicit
/// overrides. Default is [`HAlign::General`].
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]

pub enum HAlign {
    /// Excel default — value-type-driven (numbers right, text left).
    #[default]
    General,
    /// Force left alignment.
    Left,
    /// Force center alignment.
    Center,
    /// Force right alignment.
    Right,
}

/// The stroke style of a single cell-border edge.
///
/// [`BorderStyle::None`] means "no border on this edge" — the default. The
/// remaining variants mirror the OOXML / Excel border-style vocabulary the
/// FE-5 canvas renderer will draw. **FE-4 lands the engine schema only**;
/// the border RENDER (canvasGrid edge-drawing) is FE-5 (operator decision
/// #4: borders in the engine NOW so FE-5 only renders, never re-migrates).
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]

pub enum BorderStyle {
    /// No border drawn on this edge (the default).
    #[default]
    None,
    /// Thin solid line.
    Thin,
    /// Medium solid line.
    Medium,
    /// Thick solid line.
    Thick,
    /// Dashed line.
    Dashed,
    /// Dotted line.
    Dotted,
    /// Double line.
    Double,
}

/// A single border edge: its stroke style + color.
///
/// An edge with `style == BorderStyle::None` is "no border"; `color` is
/// then irrelevant (kept at `Rgb::default()` = black so the value
/// canonicalizes — two no-border edges intern identically regardless of
/// the never-rendered color). The [`Default`] is a no-border black edge.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BorderEdge {
    /// The stroke style. `None` ⇒ no border drawn on this edge.
    pub style: BorderStyle,
    /// The stroke color. Ignored when `style == BorderStyle::None`.
    pub color: Rgb,
}

impl BorderEdge {
    /// A no-border edge (the default).
    pub const NONE: BorderEdge = BorderEdge {
        style: BorderStyle::None,
        color: Rgb { r: 0, g: 0, b: 0 },
    };

    /// True iff this edge draws nothing.
    pub const fn is_none(self) -> bool {
        matches!(self.style, BorderStyle::None)
    }
}

/// The four per-edge borders of a cell.
///
/// Each edge is an independent [`BorderEdge`]; the default is all-none
/// (no borders). Operator decision #4 (2026-06-10): per-edge borders are
/// in the v1 ENGINE schema so the FE-5 renderer only draws, never
/// re-migrates the overlay.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Borders {
    pub top: BorderEdge,
    pub bottom: BorderEdge,
    pub left: BorderEdge,
    pub right: BorderEdge,
}

impl Borders {
    /// True iff no edge draws anything.
    pub const fn is_none(self) -> bool {
        self.top.is_none() && self.bottom.is_none() && self.left.is_none() && self.right.is_none()
    }
}

/// A cell's VISUAL style — the interned value behind a [`StyleId`].
///
/// Flat, `Copy`, value-comparable so the whole struct interns + dedups as
/// one unit in [`StyleTable`] (the cell-style analog of a format STRING in
/// [`crate::FormatTable`]).
///
/// Fields (operator decision #4 schema + FE-7 font attrs):
/// - `bold` / `italic`: font weight / slant toggles.
/// - `underline` / `strike`: font underline / strikethrough toggles (FE-7 —
///   exact clones of `bold` / `italic`).
/// - `fill`: optional background fill color (`None` = no fill).
/// - `text_color`: optional font color (`None` = default/inherited color).
///   FE-7 — exact clone of `fill`'s `Option<Rgb>` shape + plumbing.
/// - `align`: horizontal alignment ([`HAlign::General`] = value-driven default).
/// - `borders`: the four per-edge [`BorderEdge`]s.
///
/// [`Style::default()`] is the "no styling" value — every cell ABSENT from
/// the [`crate::CellStyleOverlay`] renders as if it carried `Style::default()`.
/// A [`StyleTable`] will happily intern `Style::default()` if a producer
/// explicitly sets it, but the runtime's `set_cell_style(None)` clears the
/// overlay entry rather than interning a default (mirrors
/// `set_cell_format(None)`).
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    /// Underline toggle (FE-7 — clone of `bold`).
    pub underline: bool,
    /// Strikethrough toggle (FE-7 — clone of `italic`).
    pub strike: bool,
    /// Background fill color; `None` = no fill.
    pub fill: Option<Rgb>,
    /// Font color; `None` = default/inherited color (FE-7 — clone of `fill`).
    pub text_color: Option<Rgb>,
    pub align: HAlign,
    pub borders: Borders,
}

impl Style {
    /// True iff this is the empty (no-styling) value — identical to
    /// [`Style::default()`]. Useful for callers deciding whether a set is a
    /// real style or a clear-in-disguise.
    pub fn is_empty(&self) -> bool {
        *self == Style::default()
    }
}

/// A cell-style id — a peer-allocated `(peer, counter)` tuple.
///
/// Unlike [`crate::FormatId`] there is NO `Builtin` variant (styles have no
/// Excel-canonical global registry). Collision-freedom across concurrent
/// peers is by construction: two peers allocating `counter = 0` produce
/// distinct ids because `peer` differs (Phase 5.1 audit-locked D-1).
///
/// Mirrors `ql_oplog::wire::StyleIdWire` (the op-log payload type) and the
/// `.qbook` envelope's `StyleEntryId`. All three carry the same
/// `(peer, counter)` and convert losslessly.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct StyleId {
    pub peer: PeerId,
    pub counter: u32,
}

impl StyleId {
    /// Construct a `StyleId` from its parts.
    pub const fn new(peer: PeerId, counter: u32) -> Self {
        Self { peer, counter }
    }
}

/// Workbook-level cell-style interning + dedup table.
///
/// Cells reference a [`StyleId`] (via the per-sheet
/// [`crate::CellStyleOverlay`]); the table resolves the id back to the
/// [`Style`] value the renderer applies. Mirrors [`crate::FormatTable`]:
/// peer-aware allocation, append-before-mutate replay symmetry, fail-loud
/// `register_at` collisions.
#[derive(Clone, Debug)]
pub struct StyleTable {
    /// `id → Style`. Sparse (only registered ids).
    by_id: HashMap<StyleId, Style>,
    /// `(peer, Style) → StyleId`. Per-peer dedup map: two peers interning
    /// the same `Style` produce distinct ids (the `peer` component differs),
    /// mirroring `FormatTable::by_custom_string`. Two DIFFERENT peers'
    /// identical-value styles are intentionally NOT deduped against each
    /// other (CRDT D-1: producer/replay symmetry).
    by_style: HashMap<(PeerId, Style), StyleId>,
    /// Next `StyleId { peer: local_peer, counter }` to hand out. Per-peer;
    /// starts at 0.
    next_counter: u32,
    /// Peer id used when allocating ids via [`Self::intern`]. Defaults to
    /// [`LEGACY_PEER`] for single-writer mode.
    local_peer: PeerId,
}

impl Default for StyleTable {
    fn default() -> Self {
        Self::with_peer(LEGACY_PEER)
    }
}

impl StyleTable {
    /// Fresh empty table allocating under [`LEGACY_PEER`] (single-writer).
    pub fn new() -> Self {
        Self::default()
    }

    /// Fresh empty table allocating under `peer`. Future
    /// [`Self::intern`] calls produce `StyleId { peer, counter }`.
    pub fn with_peer(peer: PeerId) -> Self {
        Self {
            by_id: HashMap::new(),
            by_style: HashMap::new(),
            next_counter: 0,
            local_peer: peer,
        }
    }

    /// The peer id used for future allocations.
    pub fn local_peer(&self) -> PeerId {
        self.local_peer
    }

    /// Change the peer id used for future allocations, resyncing the counter
    /// past any existing `StyleId { peer, _ }` entries so a subsequent
    /// `intern` doesn't overwrite a replayed entry. Mirrors
    /// `FormatTable::set_local_peer` exactly.
    pub fn set_local_peer(&mut self, peer: PeerId) {
        self.local_peer = peer;
        let max_existing = self
            .by_id
            .keys()
            .filter_map(|sid| {
                if sid.peer == peer {
                    Some(sid.counter)
                } else {
                    None
                }
            })
            .max();
        self.next_counter = max_existing
            .map(|c| {
                c.checked_add(1)
                    .expect("StyleTable: custom counter exhausted (u32::MAX per-peer styles)")
            })
            .unwrap_or(0);
    }

    /// Look up the [`Style`] for `id`. `None` if never registered.
    pub fn lookup(&self, id: StyleId) -> Option<Style> {
        self.by_id.get(&id).copied()
    }

    /// Look up the id THIS peer's `intern(style)` would return WITHOUT
    /// allocating. Peer-scoped — a remote peer's identical-value style does
    /// NOT short-circuit our lookup (mirrors `FormatTable::lookup_string`,
    /// which keeps producer/replay symmetry under multi-peer replay).
    pub fn lookup_style(&self, style: &Style) -> Option<StyleId> {
        self.by_style.get(&(self.local_peer, *style)).copied()
    }

    /// Intern `style`. Returns the existing id if THIS peer already interned
    /// an identical value; otherwise allocates a fresh
    /// `StyleId { peer: local_peer, counter }` and stores both directions.
    ///
    /// **Replay determinism:** monotonic in insertion order WITHIN a peer.
    /// Across peers the `peer` component keeps ids distinct.
    pub fn intern(&mut self, style: Style) -> StyleId {
        if let Some(id) = self.by_style.get(&(self.local_peer, style)) {
            return *id;
        }
        let id = StyleId {
            peer: self.local_peer,
            counter: self.next_counter,
        };
        self.next_counter = self
            .next_counter
            .checked_add(1)
            .expect("StyleTable: custom counter exhausted (u32::MAX per-peer styles)");
        self.by_id.insert(id, style);
        self.by_style.insert((self.local_peer, style), id);
        id
    }

    /// Register `style` at a specific `id` (the replay / loader path).
    /// Returns `Err` if `id` is already taken with a DIFFERENT style
    /// ([`StyleTableError::IdCollision`]), if `style` is already mapped to a
    /// different id WITHIN this peer's namespace
    /// ([`StyleTableError::StyleCollision`]), or if advancing the local
    /// counter past `u32::MAX` would overflow
    /// ([`StyleTableError::CounterOverflow`]). Mirrors
    /// `FormatTable::register_at`'s fail-loud, pre-validate-before-mutate
    /// discipline.
    ///
    /// For ids tagged with `self.local_peer`, advances the local counter
    /// past the registered counter so subsequent `intern` calls don't
    /// collide.
    pub fn register_at(&mut self, id: StyleId, style: Style) -> Result<(), StyleTableError> {
        // Step 0: pre-validate counter-overflow BEFORE any state mutation
        // (mirrors FormatTable::register_at step 0). A malformed envelope /
        // replay op carrying `StyleId { local_peer, u32::MAX }` would
        // otherwise panic the post-insert counter-advance — refuse loudly.
        if id.peer == self.local_peer
            && id.counter >= self.next_counter
            && id.counter.checked_add(1).is_none()
        {
            return Err(StyleTableError::CounterOverflow { peer: id.peer });
        }
        // Step 1: id-side dedup. Existing id must map to the same style.
        if let Some(existing) = self.by_id.get(&id) {
            if *existing == style {
                return Ok(());
            }
            return Err(StyleTableError::IdCollision {
                id,
                existing: Box::new(*existing),
                attempted: Box::new(style),
            });
        }
        // Step 2: style-side dedup within the id's peer namespace.
        if let Some(existing_id) = self.by_style.get(&(id.peer, style)) {
            if *existing_id == id {
                return Ok(());
            }
            return Err(StyleTableError::StyleCollision {
                existing_id: *existing_id,
                attempted_id: id,
            });
        }
        // Step 3: insert both directions.
        self.by_id.insert(id, style);
        self.by_style.insert((id.peer, style), id);
        // Step 4: advance the local counter for our-peer ids so subsequent
        // `intern` calls allocate past any replayed ones.
        if id.peer == self.local_peer && id.counter >= self.next_counter {
            self.next_counter = id
                .counter
                .checked_add(1)
                .expect("counter overflow was pre-validated at register_at entry");
        }
        Ok(())
    }

    /// Total entries.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// True iff the table has no entries.
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// The counter `intern` will use for the next allocation.
    pub fn next_counter(&self) -> u32 {
        self.next_counter
    }

    /// Iterate `(StyleId, Style)` in arbitrary order. Persistence consumers
    /// sort by id for wire-stable order.
    pub fn iter(&self) -> impl Iterator<Item = (StyleId, Style)> + '_ {
        self.by_id.iter().map(|(id, style)| (*id, *style))
    }
}

/// Errors from [`StyleTable::register_at`] collisions / overflow. Mirrors
/// [`crate::FormatTableError`].
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum StyleTableError {
    /// An id is already taken with a different style. (Box keeps the error
    /// enum small — `Style` is multi-word.)
    IdCollision {
        id: StyleId,
        existing: Box<Style>,
        attempted: Box<Style>,
    },
    /// A style is already mapped to a different id within a peer's namespace.
    StyleCollision {
        existing_id: StyleId,
        attempted_id: StyleId,
    },
    /// Registering would overflow the local peer's `u32` counter.
    CounterOverflow { peer: PeerId },
}

impl std::fmt::Display for StyleTableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StyleTableError::IdCollision { id, .. } => {
                write!(f, "StyleTable: id {id:?} already registered with a different style")
            }
            StyleTableError::StyleCollision {
                existing_id,
                attempted_id,
            } => write!(
                f,
                "StyleTable: style already registered at {existing_id:?}, refused re-registration at {attempted_id:?}"
            ),
            StyleTableError::CounterOverflow { peer } => {
                write!(f, "StyleTable: custom counter exhausted for peer {peer:?}")
            }
        }
    }
}

impl std::error::Error for StyleTableError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn bold() -> Style {
        Style {
            bold: true,
            ..Style::default()
        }
    }

    fn red_fill() -> Style {
        Style {
            fill: Some(Rgb::new(0xff, 0, 0)),
            ..Style::default()
        }
    }

    fn blue_text() -> Style {
        Style {
            text_color: Some(Rgb::new(0, 0, 0xff)),
            ..Style::default()
        }
    }

    fn underline_strike() -> Style {
        Style {
            underline: true,
            strike: true,
            ..Style::default()
        }
    }

    fn all_borders() -> Style {
        let edge = BorderEdge {
            style: BorderStyle::Thin,
            color: Rgb::new(0x33, 0x44, 0x55),
        };
        Style {
            borders: Borders {
                top: edge,
                bottom: edge,
                left: edge,
                right: edge,
            },
            ..Style::default()
        }
    }

    #[test]
    fn default_is_empty() {
        let t = StyleTable::new();
        assert!(t.is_empty());
        assert_eq!(t.len(), 0);
        assert_eq!(t.local_peer(), LEGACY_PEER);
        assert!(Style::default().is_empty());
        // FE-7: the new font attrs default to off / no-color.
        assert!(!Style::default().underline);
        assert!(!Style::default().strike);
        assert_eq!(Style::default().text_color, None);
    }

    #[test]
    fn font_attrs_intern_distinctly_and_round_trip() {
        // FE-7: text_color (clone of fill), underline (clone of bold),
        // strike (clone of italic) each intern distinctly + round-trip.
        let mut t = StyleTable::new();
        let plain = t.intern(Style::default());
        let text = t.intern(blue_text());
        let us = t.intern(underline_strike());
        assert_ne!(plain, text);
        assert_ne!(plain, us);
        assert_ne!(text, us);
        let got_text = t.lookup(text).unwrap();
        assert_eq!(got_text.text_color, Some(Rgb::new(0, 0, 0xff)));
        let got_us = t.lookup(us).unwrap();
        assert!(got_us.underline);
        assert!(got_us.strike);
    }

    #[test]
    fn intern_allocates_and_round_trips() {
        let mut t = StyleTable::new();
        let id = t.intern(bold());
        assert_eq!(id, StyleId::new(LEGACY_PEER, 0));
        assert_eq!(t.lookup(id), Some(bold()));
        // Re-intern same value → same id, no new allocation.
        assert_eq!(t.intern(bold()), id);
        assert_eq!(t.next_counter(), 1);
    }

    #[test]
    fn intern_distinct_values_get_sequential_counters() {
        let mut t = StyleTable::new();
        let a = t.intern(bold());
        let b = t.intern(red_fill());
        assert_eq!(a, StyleId::new(LEGACY_PEER, 0));
        assert_eq!(b, StyleId::new(LEGACY_PEER, 1));
        assert_ne!(a, b);
    }

    #[test]
    fn distinct_peers_same_style_do_not_collide() {
        let mut pa = StyleTable::with_peer(PeerId::new(0xa));
        let mut pb = StyleTable::with_peer(PeerId::new(0xb));
        let ia = pa.intern(bold());
        let ib = pb.intern(bold());
        assert_ne!(ia, ib);
        assert_eq!(ia, StyleId::new(PeerId::new(0xa), 0));
        assert_eq!(ib, StyleId::new(PeerId::new(0xb), 0));
    }

    #[test]
    fn lookup_style_is_peer_scoped() {
        let mut t = StyleTable::with_peer(PeerId::new(0xa));
        // Replay a remote peer's style.
        t.register_at(StyleId::new(PeerId::new(0xb), 0), bold())
            .unwrap();
        // Local lookup must NOT find the remote peer's entry.
        assert_eq!(t.lookup_style(&bold()), None);
        let local = t.intern(bold());
        assert_eq!(local, StyleId::new(PeerId::new(0xa), 0));
        assert_eq!(t.lookup_style(&bold()), Some(local));
    }

    #[test]
    fn register_at_replays_and_advances_local_counter() {
        let mut t = StyleTable::with_peer(PeerId::new(7));
        t.register_at(StyleId::new(PeerId::new(7), 5), bold())
            .unwrap();
        // Next intern allocates at counter 6, not 0.
        let next = t.intern(red_fill());
        assert_eq!(next, StyleId::new(PeerId::new(7), 6));
    }

    #[test]
    fn register_at_other_peer_does_not_advance_local_counter() {
        let mut t = StyleTable::with_peer(PeerId::new(7));
        let baseline = t.next_counter();
        t.register_at(StyleId::new(PeerId::new(99), 5), bold())
            .unwrap();
        assert_eq!(t.next_counter(), baseline);
    }

    #[test]
    fn register_at_same_id_same_style_idempotent() {
        let mut t = StyleTable::new();
        t.register_at(StyleId::new(LEGACY_PEER, 0), bold()).unwrap();
        assert!(t.register_at(StyleId::new(LEGACY_PEER, 0), bold()).is_ok());
    }

    #[test]
    fn register_at_id_collision_errors() {
        let mut t = StyleTable::new();
        t.register_at(StyleId::new(LEGACY_PEER, 0), bold()).unwrap();
        let err = t
            .register_at(StyleId::new(LEGACY_PEER, 0), red_fill())
            .unwrap_err();
        assert!(matches!(err, StyleTableError::IdCollision { .. }));
    }

    #[test]
    fn register_at_style_collision_errors_same_peer() {
        let mut t = StyleTable::with_peer(PeerId::new(0xa));
        t.register_at(StyleId::new(PeerId::new(0xa), 0), bold())
            .unwrap();
        let err = t
            .register_at(StyleId::new(PeerId::new(0xa), 1), bold())
            .unwrap_err();
        assert!(matches!(err, StyleTableError::StyleCollision { .. }));
    }

    #[test]
    fn register_at_counter_overflow_returns_error_not_panic() {
        let mut t = StyleTable::with_peer(LEGACY_PEER);
        let result = t.register_at(StyleId::new(LEGACY_PEER, u32::MAX), bold());
        assert!(matches!(
            result,
            Err(StyleTableError::CounterOverflow { peer }) if peer == LEGACY_PEER
        ));
        // State unchanged — no partial insert.
        assert_eq!(t.next_counter(), 0);
        assert!(t.lookup(StyleId::new(LEGACY_PEER, u32::MAX)).is_none());
    }

    #[test]
    fn register_at_remote_peer_max_counter_is_fine() {
        let mut t = StyleTable::with_peer(LEGACY_PEER);
        t.register_at(StyleId::new(PeerId::new(0xb), u32::MAX), bold())
            .expect("remote peer's max-counter id must register cleanly");
        assert_eq!(
            t.lookup(StyleId::new(PeerId::new(0xb), u32::MAX)),
            Some(bold())
        );
        assert_eq!(t.next_counter(), 0);
    }

    #[test]
    fn set_local_peer_resyncs_counter() {
        let mut t = StyleTable::with_peer(LEGACY_PEER);
        let remote = PeerId::new(0xa1);
        t.register_at(StyleId::new(remote, 0), bold()).unwrap();
        t.register_at(StyleId::new(remote, 3), red_fill()).unwrap();
        assert_eq!(t.next_counter(), 0);
        t.set_local_peer(remote);
        assert_eq!(t.next_counter(), 4);
        let new_id = t.intern(all_borders());
        assert_eq!(new_id, StyleId::new(remote, 4));
        // Replayed entries survive.
        assert_eq!(t.lookup(StyleId::new(remote, 0)), Some(bold()));
        assert_eq!(t.lookup(StyleId::new(remote, 3)), Some(red_fill()));
    }

    #[test]
    fn borders_intern_distinctly_from_borderless() {
        // Acceptance #11 storage half: a fully-bordered style interns
        // distinctly from a borderless one and round-trips every edge.
        let mut t = StyleTable::new();
        let borderless = t.intern(Style::default());
        let bordered = t.intern(all_borders());
        assert_ne!(borderless, bordered);
        let got = t.lookup(bordered).unwrap();
        assert!(!got.borders.is_none());
        assert_eq!(got.borders.top.style, BorderStyle::Thin);
        assert_eq!(got.borders.top.color, Rgb::new(0x33, 0x44, 0x55));
        assert_eq!(got.borders.bottom, got.borders.top);
        assert_eq!(got.borders.left, got.borders.top);
        assert_eq!(got.borders.right, got.borders.top);
    }

    #[test]
    fn iter_returns_all_entries() {
        let mut t = StyleTable::new();
        let _ = t.intern(bold());
        let _ = t.intern(red_fill());
        assert_eq!(t.iter().count(), t.len());
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn style_hash_eq_distinguishes_fields() {
        use std::collections::HashSet;
        let mut set: HashSet<Style> = HashSet::new();
        set.insert(bold());
        set.insert(red_fill());
        set.insert(all_borders());
        set.insert(blue_text());
        set.insert(underline_strike());
        set.insert(bold()); // dup
        assert_eq!(set.len(), 5);
    }
}
