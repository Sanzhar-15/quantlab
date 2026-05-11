//! `graph-profile.json` export — Phase 0 OG-06 acceptance gate.
//!
//! Per spec Part V §1 OG-06 ("human-readable; senior engineer attributes time-spent
//! within 10 min"). The shape is locked in W3-7; Week 4 ql-exec adds recompute-time
//! fields as it lands. No new fields land in Phase 0 beyond the structural ones.
//!
//! ## Output shape
//!
//! ```json
//! {
//!   "schema_version": 1,
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
//!   }
//! }
//! ```
//!
//! ## What's missing (Week 4)
//!
//! `recompute_time_ms_by_node_type`, `fingerprint_cache_hit_rate`, `last_eval_duration_ms`.
//! These need a `Timings` struct that lives in ql-exec.

use ql_calcgraph::{ChunkDirtySet, Graph, NodeCountsByVariant};
use serde::Serialize;

/// Stable schema version for the profile output. Bump on incompatible changes.
const SCHEMA_VERSION: u32 = 1;

/// Top-level profile envelope. Serializable; `export_graph_profile` returns this as a
/// `serde_json::Value` for callers that want to merge it into a larger envelope.
#[derive(Clone, Debug, Serialize)]
pub struct GraphProfile {
    pub schema_version: u32,
    pub graph: GraphSection,
    pub stats: StatsSection,
    pub dirty: DirtySection,
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

/// Build the `GraphProfile` struct from a graph + optional dirty set. Pass `None` for
/// the dirty set when profiling a graph mid-construction (before any dirty propagation
/// has happened).
pub fn build_profile(graph: &Graph, dirty: Option<&ChunkDirtySet>) -> GraphProfile {
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
    }
}

/// Export the profile as a `serde_json::Value`. Used by ql-exec for the OG-06 deliverable
/// + by integration tests that want to assert against the JSON shape directly.
///
/// For a pretty-printed JSON string, call `serde_json::to_string_pretty(&value)`.
pub fn export_graph_profile(graph: &Graph, dirty: Option<&ChunkDirtySet>) -> serde_json::Value {
    let profile = build_profile(graph, dirty);
    serde_json::to_value(&profile).expect("GraphProfile must serialize cleanly")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_calcgraph::{FormulaRegionNode, Graph as GraphAlias, NodeId, RangeNode, RangeRef};

    fn make_sample_graph() -> GraphAlias {
        let mut g = Graph::new();
        // 3 cell nodes, 1 range, 1 formula region.
        let a1 = g.add_cell_node(0, 0, 0);
        let _a2 = g.add_cell_node(0, 1, 0);
        let b1 = g.add_cell_node(0, 0, 1);
        let _range = g.add_range_node(RangeNode {
            sheet: 0,
            range: RangeRef::WholeColumn {
                sheet: None,
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
                sheet: None,
                start_col: 0,
                end_col: 0,
                abs_start: false,
                abs_end: false,
            },
            0,
        );
        // Simulate a Week 4 chunk-reduce.
        g.record_chunked_reduce(3);
        let _ = NodeId(a1.0); // suppress unused-import worry in tests
        g
    }

    #[test]
    fn schema_version_locked() {
        let g = Graph::new();
        let p = build_profile(&g, None);
        assert_eq!(p.schema_version, 1);
    }

    #[test]
    fn empty_graph_profile_zero_everything() {
        let g = Graph::new();
        let p = build_profile(&g, None);
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
    }

    #[test]
    fn sample_graph_profile_node_counts() {
        let g = make_sample_graph();
        let p = build_profile(&g, None);
        assert_eq!(p.graph.node_counts.cell, 3);
        assert_eq!(p.graph.node_counts.range, 1);
        assert_eq!(p.graph.node_counts.formula_region, 1);
        assert_eq!(p.graph.node_counts.spill, 0);
        assert_eq!(p.graph.node_count, 5);
    }

    #[test]
    fn sample_graph_profile_stats() {
        let g = make_sample_graph();
        let p = build_profile(&g, None);
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
        let p = build_profile(&g, Some(&dirty));
        assert!(p.dirty.present);
        assert_eq!(p.dirty.chunk_count, 2);
        assert_eq!(p.dirty.chunk_rows, 16384);
    }

    #[test]
    fn export_graph_profile_yields_valid_json() {
        let g = make_sample_graph();
        let v = export_graph_profile(&g, None);
        assert!(v.is_object());
        // Schema version present and correct.
        assert_eq!(v["schema_version"], 1);
        // Top-level keys.
        for k in &["graph", "stats", "dirty"] {
            assert!(v.get(*k).is_some(), "missing top-level key: {k}");
        }
        // Spot-check nested fields.
        assert_eq!(v["graph"]["node_counts"]["cell"], 3);
        assert_eq!(v["graph"]["stripe_count"], 1);
        assert_eq!(v["stats"]["chunked_reduce_chunks_processed"], 3);
    }

    #[test]
    fn pretty_printed_json_is_readable() {
        // OG-06 acceptance is semi-formal: a senior engineer reads the JSON + identifies
        // the hot path within 10 min. This test prints a sample so a reviewer can eyeball.
        let g = make_sample_graph();
        let mut dirty = ChunkDirtySet::new(16384);
        dirty.mark_cell(0, 5, 0);
        let v = export_graph_profile(&g, Some(&dirty));
        let pretty = serde_json::to_string_pretty(&v).expect("pretty-print works");
        // Sanity: contains all top-level sections.
        assert!(pretty.contains("\"schema_version\""));
        assert!(pretty.contains("\"graph\""));
        assert!(pretty.contains("\"stats\""));
        assert!(pretty.contains("\"dirty\""));
        // The output is a stable shape; print for posterity (cargo test --nocapture).
        println!("---\ngraph-profile.json sample:\n{pretty}\n---");
    }
}
