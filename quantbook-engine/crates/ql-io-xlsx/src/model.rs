//! Shared types: preservation handles, feature inventory.

use crate::error::UnsupportedFeatureKind;
use std::collections::HashMap;

/// Captured snapshot of the original xlsx package, used for
/// high-fidelity round-trip via `ExportMode::UpdateOriginal`.
///
/// When `XlsxImportOptions::preserve_package = true`, the importer
/// stashes the raw zip bytes here. On export, the `UpdateOriginal`
/// writer reloads the package and patches only the parts the engine
/// knows about — leaving everything else (CF, DV, comments,
/// drawings, theme, etc.) byte-identical to the original.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct XlsxPreservation {
    /// The original xlsx file bytes (the entire zip). Used as the
    /// starting point for `UpdateOriginal` mode.
    pub original_bytes: Vec<u8>,
}

impl XlsxPreservation {
    /// Construct a preservation handle from raw xlsx bytes. Use this
    /// instead of struct-literal construction — `XlsxPreservation`
    /// is `#[non_exhaustive]` so additional fields may be added
    /// without breaking callers.
    pub fn new(original_bytes: Vec<u8>) -> Self {
        Self { original_bytes }
    }
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
