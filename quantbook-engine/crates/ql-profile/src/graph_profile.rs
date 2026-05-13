//! `graph-profile.json` export — Phase 0 OG-06 acceptance gate.
//!
//! Per spec Part V §1 OG-06 ("human-readable; senior engineer attributes time-spent
//! within 10 min"). The shape is locked in W3-7; Week 4 ql-exec adds recompute-time
//! fields as it lands. No new fields land in Phase 0 beyond the structural ones.
//!
//! ## Output shape (schema v2 — W5-5)
//!
//! ```json
//! {
//!   "schema_version": 2,
//!   "graph": {
//!     "revision": 7,
//!     "node_count": 6,
//!     "node_counts": {
//!       "cell": 5, "range": 1, "formula_region": 0, "spill": 0
//!     },
//!     "edge_count": 3,
//!     "stripe_count": 1,
//!     "range_dependency_count": 1
//!   },
//!   "stats": {
//!     "stripe_inserts": 1,
//!     "dependents_scan_fallback": 0,
//!     "chunked_reduce_chunks_processed": 0
//!   },
//!   "dirty": {
//!     "present": true,
//!     "chunk_count": 2,
//!     "chunk_rows": 16384
//!   },
//!   "timings": {                           // Optional — present only when supplied
//!     "last_eval_duration_us": 3400,
//!     "recompute_us_by_node_type": {
//!       "cell_us": 600, "range_us": 0,
//!       "formula_region_us": 2800, "spill_us": 0
//!     },
//!     "fingerprint_cache_hits": 10,
//!     "fingerprint_cache_misses": 2,
//!     "simd_dispatch_count": 1,
//!     "scalar_dispatch_count": 0
//!   }
//! }
//! ```
//!
//! OG-06 acceptance fully closed in W5-5 with the `timings` section. Earlier W3-7
//! shipped graph/stats/dirty (shape-only); W5-5 adds time-spent attribution so a
//! senior engineer reads the JSON + identifies the hot path within 10 min per the
//! spec criterion.

use ql_calcgraph::{ChunkDirtySet, Graph, NodeCountsByVariant};
use serde::Serialize;

use crate::timings::Timings;

/// Stable schema version for the profile output. Bump on incompatible changes.
/// - v1: W3-7 initial shape (graph + stats + dirty).
/// - v2: W5-5 added `timings` section (OG-06 acceptance fully closed).
const SCHEMA_VERSION: u32 = 2;

/// Top-level profile envelope. Serializable; `export_graph_profile` returns this as a
/// `serde_json::Value` for callers that want to merge it into a larger envelope.
///
/// `timings` is `None` (omitted from JSON via serde skip) when no eval has run; once
/// the runtime layer (Week 4+ `ql-exec` integration) wires it, the field will be
/// populated with the most recent eval's data.
#[derive(Clone, Debug, Serialize)]
pub struct GraphProfile {
    pub schema_version: u32,
    pub graph: GraphSection,
    pub stats: StatsSection,
    pub dirty: DirtySection,
    /// Timing snapshot from the most recent eval. `None` if no eval has run yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timings: Option<Timings>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphSection {
    pub revision: u64,
    pub node_count: usize,
    pub node_counts: NodeCountsSection,
    pub edge_count: usize,
    pub stripe_count: usize,
    pub range_dependency_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct NodeCountsSection {
    pub cell: u64,
    pub range: u64,
    pub formula_region: u64,
    pub spill: u64,
}

impl From<NodeCountsByVariant> for NodeCountsSection {
    fn from(n: NodeCountsByVariant) -> Self {
        Self {
            cell: n.cell,
            range: n.range,
            formula_region: n.formula_region,
            spill: n.spill,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StatsSection {
    pub stripe_inserts: u64,
    pub dependents_scan_fallback: u64,
    pub chunked_reduce_chunks_processed: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DirtySection {
    pub present: bool,
    pub chunk_count: usize,
    pub chunk_rows: u32,
}

/// Build the `GraphProfile` struct from a graph + optional dirty set + optional
/// timing snapshot. `None` for `dirty` means "no dirty propagation has happened yet";
/// `None` for `timings` means "no evaluation has run yet."
pub fn build_profile(
    graph: &Graph,
    dirty: Option<&ChunkDirtySet>,
    timings: Option<Timings>,
) -> GraphProfile {
    let node_counts: NodeCountsSection = graph.node_counts_by_variant().into();
    let stats = graph.stats();
    GraphProfile {
        schema_version: SCHEMA_VERSION,
        graph: GraphSection {
            revision: graph.revision(),
            node_count: graph.node_count(),
            node_counts,
            edge_count: graph.edge_count(),
            stripe_count: graph.stripe_index().stripe_count(),
            range_dependency_count: graph.range_dependency_count(),
        },
        stats: StatsSection {
            stripe_inserts: stats.stripe_inserts,
            dependents_scan_fallback: stats.dependents_scan_fallback,
            chunked_reduce_chunks_processed: stats.chunked_reduce_chunks_processed,
        },
        dirty: match dirty {
            Some(d) => DirtySection {
                present: true,
                chunk_count: d.chunk_count(),
                chunk_rows: d.chunk_rows(),
            },
            None => DirtySection::default(),
        },
        timings,
    }
}

/// Export the profile as a `serde_json::Value`. Used by ql-exec for the OG-06 deliverable
/// + by integration tests that want to assert against the JSON shape directly.
///
/// For a pretty-printed JSON string, call `serde_json::to_string_pretty(&value)`.
pub fn export_graph_profile(
    graph: &Graph,
    dirty: Option<&ChunkDirtySet>,
    timings: Option<Timings>,
) -> serde_json::Value {
    let profile = build_profile(graph, dirty, timings);
    serde_json::to_value(&profile).expect("GraphProfile must serialize cleanly")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_calcgraph::{FormulaRegionNode, Graph as GraphAlias, RangeNode, RangeRef, SheetRef};

    fn make_sample_graph() -> GraphAlias {
        let mut g = Graph::new();
        // 3 cell nodes, 1 range, 1 formula region.
        let a1 = g.add_cell_node(0, 0, 0);
        let _a2 = g.add_cell_node(0, 1, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let _range = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
        });
        let _frn = g.add_formula_region_node(FormulaRegionNode {
            sheet: 0,
            target_start_row: 0,
            target_start_col: 1,
            target_end_row: 99,
            target_end_col: 1,
            formula_fingerprint: 1,
            chunk_count: 1,
        });
        g.add_edge(b1, a1);
        // Register one range dependency.
        g.register_range_dependency(
            b1,
            RangeRef::WholeColumn {
                sheet: SheetRef::Current,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        // Simulate a Week 4 chunk-reduce.
        g.record_chunked_reduce(3);
        let _ = a1; // ID used in setup above; bind to suppress unused-var warning.
        g
    }

    #[test]
    fn schema_version_locked() {
        let g = Graph::new();
        let p = build_profile(&g, None, None);
        assert_eq!(p.schema_version, 2);
    }

    #[test]
    fn empty_graph_profile_zero_everything() {
        let g = Graph::new();
        let p = build_profile(&g, None, None);
        assert_eq!(p.graph.node_count, 0);
        assert_eq!(p.graph.edge_count, 0);
        assert_eq!(p.graph.stripe_count, 0);
        assert_eq!(p.graph.range_dependency_count, 0);
        assert_eq!(p.graph.node_counts.cell, 0);
        assert_eq!(p.graph.node_counts.range, 0);
        assert_eq!(p.graph.node_counts.formula_region, 0);
        assert_eq!(p.graph.node_counts.spill, 0);
        assert_eq!(p.stats.stripe_inserts, 0);
        assert_eq!(p.stats.dependents_scan_fallback, 0);
        assert_eq!(p.stats.chunked_reduce_chunks_processed, 0);
        assert!(!p.dirty.present);
        assert_eq!(p.dirty.chunk_count, 0);
        assert_eq!(p.timings, None);
    }

    #[test]
    fn sample_graph_profile_node_counts() {
        let g = make_sample_graph();
        let p = build_profile(&g, None, None);
        assert_eq!(p.graph.node_counts.cell, 3);
        assert_eq!(p.graph.node_counts.range, 1);
        assert_eq!(p.graph.node_counts.formula_region, 1);
        assert_eq!(p.graph.node_counts.spill, 0);
        assert_eq!(p.graph.node_count, 5);
    }

    #[test]
    fn sample_graph_profile_stats() {
        let g = make_sample_graph();
        let p = build_profile(&g, None, None);
        assert_eq!(p.stats.stripe_inserts, 1);
        assert_eq!(p.stats.chunked_reduce_chunks_processed, 3);
        assert_eq!(p.stats.dependents_scan_fallback, 0);
    }

    #[test]
    fn dirty_section_populated_when_set_provided() {
        let g = make_sample_graph();
        let mut dirty = ChunkDirtySet::new(16384);
        dirty.mark_cell(0, 0, 0);
        dirty.mark_cell(0, 16384, 0); // different chunk in same column
        let p = build_profile(&g, Some(&dirty), None);
        assert!(p.dirty.present);
        assert_eq!(p.dirty.chunk_count, 2);
        assert_eq!(p.dirty.chunk_rows, 16384);
    }

    #[test]
    fn export_graph_profile_yields_valid_json() {
        let g = make_sample_graph();
        let v = export_graph_profile(&g, None, None);
        assert!(v.is_object());
        // Schema version present and correct (v2 since W5-5).
        assert_eq!(v["schema_version"], 2);
        // Top-level keys.
        for k in &["graph", "stats", "dirty"] {
            assert!(v.get(*k).is_some(), "missing top-level key: {k}");
        }
        // Timings absent when None (serde skip_serializing_if).
        assert!(v.get("timings").is_none());
        // Spot-check nested fields.
        assert_eq!(v["graph"]["node_counts"]["cell"], 3);
        assert_eq!(v["graph"]["stripe_count"], 1);
        assert_eq!(v["stats"]["chunked_reduce_chunks_processed"], 3);
    }

    // ===== W5-5: timings section (OG-06 fully closed) =====

    #[test]
    fn timings_section_present_when_supplied() {
        use crate::timings::{NodeKind, Timings};
        let g = make_sample_graph();
        let mut t = Timings::new();
        t.last_eval_duration_us = 3_400; // 3.4 ms — OG-02 baseline
        t.record_simd_dispatch();
        t.record_node_eval(NodeKind::FormulaRegion, 2_800);
        t.record_node_eval(NodeKind::Cell, 600);
        t.fingerprint_cache_hits = 10;
        t.fingerprint_cache_misses = 2;

        let p = build_profile(&g, None, Some(t));
        let timings = p.timings.expect("timings should be present");
        assert_eq!(timings.last_eval_duration_us, 3_400);
        assert_eq!(timings.simd_dispatch_count, 1);
        assert_eq!(timings.recompute_us_by_node_type.cell_us, 600);
        assert_eq!(timings.recompute_us_by_node_type.formula_region_us, 2_800);
        assert_eq!(timings.fingerprint_cache_hit_rate(), Some(10.0 / 12.0));
    }

    #[test]
    fn timings_section_in_json_output() {
        use crate::timings::{NodeKind, Timings};
        let g = make_sample_graph();
        let mut t = Timings::new();
        t.last_eval_duration_us = 3_400;
        t.record_simd_dispatch();
        t.record_simd_dispatch();
        t.record_node_eval(NodeKind::FormulaRegion, 2_800);

        let v = export_graph_profile(&g, None, Some(t));
        assert!(v.get("timings").is_some(), "timings key present in JSON");
        assert_eq!(v["timings"]["last_eval_duration_us"], 3_400);
        assert_eq!(v["timings"]["simd_dispatch_count"], 2);
        assert_eq!(
            v["timings"]["recompute_us_by_node_type"]["formula_region_us"],
            2_800
        );
    }

    #[test]
    fn timings_section_skipped_when_none() {
        let g = make_sample_graph();
        let v = export_graph_profile(&g, None, None);
        assert!(v.get("timings").is_none(), "no timings key when None");
        // Pretty-printed JSON also shouldn't contain "timings".
        let pretty = serde_json::to_string_pretty(&v).expect("pretty-print");
        assert!(!pretty.contains("\"timings\""));
    }

    /// Audit M4 (2026-05-12): the previous version of this test only asserted the
    /// pretty-printed JSON contained the field-name strings — trivially true by construction
    /// since `serde::Serialize` derives them from the struct field names. Now: assert each
    /// nested numeric value parses, the total node count matches, and counter sums are
    /// internally consistent. Without these checks, a regression that broke the Serialize
    /// derives or shuffled field meanings would pass the test silently.
    #[test]
    fn pretty_printed_json_is_structurally_consistent() {
        let g = make_sample_graph();
        let mut dirty = ChunkDirtySet::new(16384);
        dirty.mark_cell(0, 5, 0);
        let v = export_graph_profile(&g, Some(&dirty), None);
        let pretty = serde_json::to_string_pretty(&v).expect("pretty-print works");

        // Round-trip the pretty form back through serde to a Value to verify it parses
        // cleanly (catches encoding glitches).
        let round_tripped: serde_json::Value =
            serde_json::from_str(&pretty).expect("round-trip parse");
        assert_eq!(round_tripped, v);

        // Internal consistency: node_count == sum of node_counts by variant.
        let nc = &v["graph"]["node_counts"];
        let total_by_variant = nc["cell"].as_u64().unwrap()
            + nc["range"].as_u64().unwrap()
            + nc["formula_region"].as_u64().unwrap()
            + nc["spill"].as_u64().unwrap();
        assert_eq!(
            v["graph"]["node_count"].as_u64().unwrap(),
            total_by_variant,
            "graph.node_count must equal sum of node_counts"
        );

        // dirty.present <=> chunk_count > 0 (chunk_count should be >0 since we marked a cell).
        assert_eq!(v["dirty"]["present"], serde_json::Value::Bool(true));
        assert!(v["dirty"]["chunk_count"].as_u64().unwrap() > 0);

        // The output is a stable shape; print for posterity (cargo test --nocapture).
        println!("---\ngraph-profile.json sample:\n{pretty}\n---");
    }
}
