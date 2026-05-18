//! `ql-profile` — observability + graph profiling.
//!
//! Phase 0 surface (W3-7): `graph-profile.json` export. The OG-06 acceptance gate is
//! "human-readable; senior engineer attributes time-spent within 10 min." Phase 0 ships
//! the JSON shape; Week 4 ql-exec wires recompute-time fields as it lands.
//!
//! See `_QUANTBOOK-v1-SPECIFICATION.md` Part V §1 OG-06.
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. `NodeKind` mirrors
//! `ql_calcgraph::Node` and is exhaustive by design — variant
//! additions are MAJOR-version events that ship in lockstep with
//! calcgraph node-kind additions.

pub mod graph_profile;
pub mod timings;

pub use graph_profile::{build_profile, export_graph_profile, GraphProfile};
pub use timings::{NodeKind, NodeTypeTimings, Timings};
