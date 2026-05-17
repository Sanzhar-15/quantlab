//! Shared types: preservation handles, feature inventory.

use crate::error::UnsupportedFeatureKind;
use std::collections::HashMap;

/// Captured snapshot of the original xlsx package, used for
/// high-fidelity round-trip via `ExportMode::UpdateOriginal`.
///
/// When `XlsxImportOptions::preserve_package = true`, the importer
/// stashes the raw zip bytes plus the part index here. On export, the
/// `UpdateOriginal` writer reloads the package and patches only the
/// parts the engine knows about — leaving everything else (CF, DV,
/// comments, drawings, theme, etc.) byte-identical to the original.
///
/// **W5-D-14**: this is a placeholder shape; the actual fields are
/// filled in by the W5-D-14 implementation. The point is to lock the
/// type into the public API so callers can pattern-match
/// `ExportMode::UpdateOriginal { source }` from day one.
#[derive(Debug, Clone)]
pub struct XlsxPreservation {
    /// The original xlsx file bytes (the entire zip). Used as the
    /// starting point for `UpdateOriginal` mode.
    pub original_bytes: Vec<u8>,

    /// Map from OOXML part path → content for parts the importer
    /// recognized. The exporter patches these; unknown parts stay
    /// as-is in `original_bytes`.
    pub known_parts: HashMap<String, Vec<u8>>,
}

/// Tally of OOXML features detected during import.
///
/// Even when the engine doesn't model a feature, the importer counts
/// it so the user knows what they have. Drives the
/// `UnsupportedPolicy::Strict` decision.
#[derive(Debug, Clone, Default)]
pub struct FeatureInventory {
    /// Per-feature occurrence count. Empty inventory = clean import.
    pub counts: HashMap<UnsupportedFeatureKind, usize>,
}

impl FeatureInventory {
    /// Record one occurrence of a feature.
    pub fn record(&mut self, kind: UnsupportedFeatureKind) {
        *self.counts.entry(kind).or_insert(0) += 1;
    }

    /// `true` when no unsupported features were detected.
    pub fn is_clean(&self) -> bool {
        self.counts.is_empty()
    }
}
