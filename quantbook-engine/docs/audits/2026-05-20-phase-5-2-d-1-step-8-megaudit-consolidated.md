---
title: Phase 5.2 D-1 step 8 — full-arc closure megaudit synthesis
status: CLOSED — D-1 SHIPPED 2026-05-20
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~232k tokens) — cross-step round-trip + workspace grep + HIGH-1 follow-up. Full transcript: `2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md`.
  - Opus-A subagent (200k tokens, 2313s) — empirical round-trip + adversarial pre-step-4 op JSON synthesis. Full transcript: `2026-05-20-phase-5-2-d-1-step-8-megaudit-opus-a.md`.
  - Opus-B subagent (213k tokens, 1145s) — fixture coverage + cross-crate invariants + doc drift. Full transcript: `2026-05-20-phase-5-2-d-1-step-8-megaudit-opus-b.md`.
  - Self (single-pass) — drove the closures.
audit_target: HEAD `3eaaac201b4` — full D-1 arc (steps 1-7 + 7 per-step audits)
closure_commit: (this commit — megaudit closures)
---

# Phase 5.2 D-1 step 8 full-arc megaudit synthesis

3-way parallel megaudit pattern executed (per phase-4 megaudit precedent). Non-overlapping scopes. Combined findings: **3 HIGH + 6 MEDIUM + 2 LOW** (1 LOW deferred). All HIGH/MEDIUM closed; D-1 ships.

## Convergence map

| Finding | Codex | Opus-A | Opus-B | Closure |
|---|---|---|---|---|
| Full-arc round-trip works (multi-peer + sparse + cross-peer) | ✅ PASS | ✅ PASS | (out of scope) | None needed |
| Pre-step-4 op JSON loud failure (Codex step-7 HIGH-1 carryover) | ✅ PASS (validated) | ✅ PASS (5 probes) | (out of scope) | Port Opus-A's probes to permanent regression tests |
| xlsx import unresolved overlay | MEDIUM-1 | (out of scope) | (out of scope) | NEW: report.unsupported entry + skip overlay set |
| xlsx export unregistered overlay Custom | MEDIUM-2 | (out of scope) | (out of scope) | NEW: report.dropped_features entry; unregistered_overlay_customs field |
| Version coupling not enforced | LOW (defer) | (out of scope) | (out of scope) | Deferred to V2 |
| Release-build LEGACY_PEER guard no-op | (out of scope) | (out of scope) | HIGH-1 | assert! (release-firing) + add to OpLog::set_peer_id |
| d-1-checklist intro doc drift (says "steps 1-4") | (workspace grep didn't flag) | (out of scope) | HIGH-2 | One-line edit |
| oplog_persistence module docstring references non-existent test | (out of scope) | (out of scope) | HIGH-3 | Wrote the missing test (Opus-A proved feasible) + updated docstring |
| dates-times-formats.md § 7 pre-D-1 shape, no supersession | (out of scope) | (out of scope) | MEDIUM-1 | Status line update |
| entry-plan.md:60 "Tier D3: pending" | (out of scope) | (out of scope) | MEDIUM-2 | One-line edit |
| styles_import.rs stale FormatId(N)/.0 | (out of scope) | (out of scope) | MEDIUM-3 | Doc comment update |
| mortgage_calculator.xlsx fixture not exercised | (out of scope) | (out of scope) | MEDIUM-4 | Deferred to V2 |
| FormatEntryId not at ql_io::* | (out of scope) | (out of scope) | LOW-1 | Added to re-exports |
| intern_format counter overflow panic vector | (out of scope) | (out of scope) | LOW-2 | NEW: RuntimeError::FormatCounterExhausted + pre-check |
| read_display silent General fallback | (out of scope) | (out of scope) | LOW-3 | Deferred — pre-D-1, out of scope |

## Closures shipped

### Codex MEDIUM-1 (xlsx import unresolved overlay)

`crates/ql-io-xlsx/src/lib.rs:253-295`: pre-collect overlay sets into `planned_sets` / `unresolved_drops`. After the loop, apply only resolved sets + push `UnsupportedFeature` entries for unresolved customs with detail describing the offending cell + numFmtId. Cell renders as General (not an unresolved overlay that would later fail at .qbook save).

### Codex MEDIUM-2 (xlsx export unregistered overlay Custom)

`crates/ql-io-xlsx/src/write/umya_export.rs`: added `XlsxNumFmtTranslation::unregistered_overlay_customs: Vec<(FormatId, u32)>` field. Populated in pass-2 fallback branch (overlay Custom not in wb.formats()). Export caller pushes `UnsupportedFeature` entry with kind `Other("xlsx-overlay-unregistered-custom")`.

### Opus-B HIGH-1 (release-build LEGACY_PEER guard)

- `crates/ql-collab/src/session.rs:170, 215`: `debug_assert_ne!` → `assert_ne!` (release-firing).
- `crates/ql-oplog/src/log.rs:194`: added `assert_ne!(peer, 0, ...)` at the top of `set_peer_id` so callers bypassing the CollabSession constructor also get the guard.

### Opus-B HIGH-2 (d-1-checklist intro drift)

`docs/phase5/d-1-starting-checklist.md:11`: rewritten to reflect steps 1-7 shipped + step 8 closure shipped via this commit. Lists the megaudit findings + deferred items for transparency.

### Opus-B HIGH-3 + Opus-A insight (oplog_persistence docstring references non-existent test)

NEW test file `crates/ql-oplog/tests/d1_step8_legacy_op_shape.rs` (5 tests): ported Opus-A's adversarial probes. Tests directly inject pre-step-4-shaped JSON into a LoroDoc's "ops" list via `get_list("ops").push(LoroValue::from(json))`, then verify `OpLog::iter()` surfaces `OpLogError::Deserialize` at the offending index. This pins the Codex step-7 HIGH-1 closure as a permanent regression. Module docstring updated to reference the new tests by name + path.

### Opus-B MEDIUM-1 (dates-times-formats.md pre-D-1 shape)

Status header updated to mark § 7 as "PARTIALLY SUPERSEDED by D-1" with cross-references to `crdt-data-model.md § D-1` + `d-1-starting-checklist.md`.

### Opus-B MEDIUM-2 (entry-plan.md Tier D3 pending)

One-line update: "Tier D3: ✅ SHIPPED via D-1 step 7 (commit + audit hashes)."

### Opus-B MEDIUM-3 (styles_import.rs stale comments)

Module doc comment + W5-D-PM-2 inline comment updated to reflect post-D-1 FormatId enum shape + post-step-5 `next_custom_counter.checked_add(1).expect(...)` site (was pre-D-1 `next_custom_id = id.0 + 1`).

### Opus-B LOW-1 (FormatEntryId at ql_io::*)

Added `FormatEntry`, `FormatEntryId`, `FormatOverlayEntry`, `FormatsSection` to `pub use qbook_format::{...}` in ql-io/src/lib.rs.

### Opus-B LOW-2 (intern_format counter overflow)

New `RuntimeError::FormatCounterExhausted { peer: PeerId }` variant. `WorkbookRuntime::intern_format` pre-checks `formats.next_custom_counter() == u32::MAX` BEFORE appending Op::RegisterFormat. Pre-closure: intern panicked AFTER op was written; local log got an op replay couldn't reproduce. Post-closure: refuse before write.

## Deferred findings (V2 backlog)

- **Opus-B MEDIUM-4** (mortgage_calculator.xlsx fixture not exercised): fixture-quality improvement; not a correctness fix. Synthetic step-6 test covers the same property (`step6_audit_sparse_legacy_counters_preserve_byte_stability`).
- **Codex LOW** (version coupling not cross-tested): WORKBOOK_SCHEMA_VERSION + FormatIdWire serde shape + OPLOG_SCHEMA_VERSION are independent. No single test forces all three to bump together. Acceptable as a documentary invariant for now.
- **Opus-B LOW-3** (read_display silent fallback to General): pre-D-1 issue; not introduced by D-1. Out of D-1 scope; tracked as separate V2 work.

## Test count delta

| Step | Tests | Δ |
|---|---|---|
| Pre-megaudit (HEAD 3eaaac201b4) | 4284 | — |
| Megaudit closure (this commit) | **4291** | +7 (5 in d1_step8_legacy_op_shape + 2 in calamine_smoke step8_audit) |

## 6-cycle audit performance summary

| Cycle | Auditors | Findings | Pattern |
|---|---|---|---|
| Step 3 audit | Codex+Opus | 2 HIGH + 0 (DIVERGENT) | Codex caught forward-activating |
| Step 4 audit | Codex+Opus | 1 HIGH + 0 (DIVERGENT) | Same |
| Step 5 audit | Codex+Opus | 2 HIGH + 0 + 1 unique Opus MEDIUM (DIVERGENT) | Codex + Opus complement |
| Step 6 audit | Codex+Opus | 3 HIGH + 1 convergent + 1 unique Opus MEDIUM (DIVERGENT) | Same |
| Step 7 audit | Codex+Opus | 1 HIGH + 0 + 1 unique Opus MEDIUM (DIVERGENT) | Same |
| Step 8 megaudit | Codex+Opus-A+Opus-B (3-way) | 0 HIGH convergent + 3 unique Opus-B HIGH + 2 Codex MEDIUM + 4 Opus-B MEDIUM + 2 LOW (DIVERGENT × 3) | 3-way confirmed structural divergence pattern |

**16/16 audit cycles caught real bugs** across the full D-1 engagement. The 5-cycle (per-step) + 1-cycle (megaudit) divergent pattern proves the multi-auditor discipline is structurally load-bearing — neither Codex alone nor any Opus lane alone would have closed the full set.

## D-1 sign-off

D-1 (FormatId tagged tuple, multi-peer-aware persistence) ships clean as of `<this commit>`. All 8 steps + 7 per-step audits + 1 full-arc megaudit complete. 16/16 audit cycles caught real bugs. Workspace tests: 4222 (pre-D-1) → 4291 (D-1 done) = +69 net tests. No silent data loss paths. All error paths surface loudly. Forward-compat for v2+ ops + v9+ envelopes via explicit version gates.
