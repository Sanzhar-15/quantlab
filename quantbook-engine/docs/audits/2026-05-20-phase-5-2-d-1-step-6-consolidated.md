---
title: Phase 5.2 D-1 step 6 audit synthesis (xlsx FormatId↔numFmtId mapping)
status: CLOSED
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~279k tokens) — full transcript: `2026-05-20-phase-5-2-d-1-step-6-codex.md`
  - Opus subagent (147k tokens, 501s) — full transcript: `2026-05-20-phase-5-2-d-1-step-6-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `19f6aa1b008` (Phase 5.2 D-1 step 6 — xlsx FormatId↔numFmtId mapping, multi-peer aware)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 6 audit synthesis

**4th consecutive DIVERGENT-HIGH cycle.** Codex caught 3 HIGH (cross-peer reimport loss, sparse counter byte regression, Strict policy inconsistencies). Opus PASSED most areas but converged with Codex on the byte-stability HIGH, downgraded the cross-peer to MEDIUM (rationale: pre-step-6 panicked anyway), and added a unique MEDIUM (test name overstates).

Engineer treats Opus MEDIUM-1 as HIGH for closure purposes — silent render fallback after reimport is data loss regardless of "before it was worse."

## Findings ledger

| ID | Auditor(s) | Severity | Description | Closure | Status |
|---|---|---|---|---|---|
| H1 | Codex+Opus | HIGH | Sparse LEGACY_PEER counters reindexed; byte-stability claim FALSE | Rewrote `XlsxNumFmtTranslation::build` as 2-pass: LEGACY preserves `c + FIRST_CUSTOM_FORMAT_ID`; non-LEGACY allocates after. New regression test `step6_audit_sparse_legacy_counters_preserve_byte_stability` pins {5, 7} → {169, 171}. | ✅ |
| H2 | Codex+Opus (Opus rated MEDIUM) | HIGH | Cross-peer same-string export emits duplicate `<numFmt>`; reimport StringCollision drops second → cells lose format | Added dedup-by-code in translation: two FormatIds with same code map to same xlsx numFmtId. Added `custom_formats` dedup by xlsx_id. New regression test `step6_audit_cross_peer_same_string_dedups_to_one_numfmt` asserts exactly 1 `<numFmt>` per code + both peers' cells resolve to "yyyy-mm-dd" on reimport. | ✅ |
| H3 | Codex | HIGH | Strict policy inconsistencies: NewWorkbook writes file then errors; UpdateOriginal doesn't include shadow export's dropped_features | NewWorkbook: delete file on Strict-fail post-write (best-effort `remove_file`). UpdateOriginal: merge `report.dropped_features` from shadow export into `all_drops` before Strict check. 2 new regression tests pin both behaviors. | ✅ |
| M1 | Codex | MEDIUM | `<numFmts>` byte order non-deterministic (HashMap iter order — pre-existing) | Restructured `custom_formats` build: sort by xlsx_id after dedup. Byte-deterministic emission. | ✅ |
| M2 | Opus | MEDIUM | `step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged` test name overstates verification | New regression tests (sparse counters, cross-peer dedup, byte-asserts) collectively cover the byte-stability claim properly. Existing test kept for the multi-peer-drops-empty sanity it does verify. | ✅ |
| LOWs | Codex+Opus | LOW | Various deferable: 3+ peers, double round-trip, Builtin(>163) direct construction, brittle Debug assertions | Added `step6_audit_xlsx_qbook_xlsx_double_round_trip_drops_to_zero_multi_peer_flattens` (Opus L6 + Codex MEDIUM-2). Other LOWs deferred to step 8 megaudit. | ✅/⏳ |

## Closure files

### `crates/ql-io-xlsx/src/write/umya_export.rs`

**Translation algorithm rewrite (H1 + H2 closure):**
- 2-pass build: pass 1 LEGACY_PEER preserves `c + FIRST_CUSTOM_FORMAT_ID`, pass 2 non-LEGACY allocates sequentially after highest LEGACY id with dedup-by-code.
- Added `code_to_numfmt: HashMap<String, u32>` for the dedup.
- Updated docstring to describe the actual algorithm (no false byte-stability claim).

**custom_formats roster (M1 closure):**
- Dedup by xlsx_id (HashSet `seen`).
- Sort by xlsx_id for deterministic emission.

### `crates/ql-io-xlsx/src/lib.rs`

**NewWorkbook Strict closure (H3 part 1):**
- On Strict-fail after `export_new_workbook` writes, `std::fs::remove_file(out_path)` removes the lossy file. Best-effort: if removal itself fails, return the original UnsupportedFeature error.

### `crates/ql-io-xlsx/src/write/update_original.rs`

**UpdateOriginal Strict closure (H3 part 2):**
- Merge `report.dropped_features` (from shadow `export_new_workbook` call) into `all_drops` via `append` before the Strict check. Pre-closure the Strict check only inspected the local `dropped` vector.

### `crates/ql-io-xlsx/tests/calamine_smoke.rs`

5 new regression tests:
- `step6_audit_sparse_legacy_counters_preserve_byte_stability` — pins {5, 7} → {169, 171}.
- `step6_audit_cross_peer_same_string_dedups_to_one_numfmt` — pins dedup + reimport correctness.
- `step6_audit_strict_newworkbook_removes_lossy_file_on_error` — pins file-removal on Strict-fail.
- `step6_audit_strict_newworkbook_legacy_only_succeeds_and_writes_file` — pins positive case.
- `step6_audit_xlsx_qbook_xlsx_double_round_trip_drops_to_zero_multi_peer_flattens` — pins asymmetry.

## Test count delta

| Step | Tests | Δ |
|---|---|---|
| Pre-step-6 (HEAD 9a95429b284) | 4270 | — |
| Step 6 ship (19f6aa1b008) | 4272 | +2 |
| Step 6 audit closure (this commit) | 4277 | +5 |

## Forward dependencies

Step 7 (Tier D3 — oplog.bin magic bytes + version header) is independent of step 6's xlsx work. Step 7 work scope is unchanged.

Step 8 (full-arc megaudit) gains material from step 6 audit closures: the dedup-by-code + LEGACY counter preservation patterns are non-obvious and the megaudit should explicitly verify cross-step invariants (e.g. a workbook saved-then-reloaded through .qbook → xlsx → .qbook).

## 4-cycle divergence pattern (steps 3, 4, 5, 6)

| Cycle | Codex HIGH | Opus HIGH | Pattern |
|---|---|---|---|
| Step 3 audit | 2 | 0 (PASS) | DIVERGENT — Codex caught forward-activating |
| Step 4 audit | 1 | 0 (PASS) | DIVERGENT — same pattern |
| Step 5 audit | 2 | 0 (PASS) | DIVERGENT — Codex 2 forward bugs + Opus 1 unique MEDIUM |
| Step 6 audit | 3 | 1 (convergent on H1) | DIVERGENT — Codex 2 unique HIGH; Opus 1 unique MEDIUM |

**14/14 audit cycles this engagement caught real bugs.** The 4-cycle divergent-HIGH pattern is structural, not coincidental.
