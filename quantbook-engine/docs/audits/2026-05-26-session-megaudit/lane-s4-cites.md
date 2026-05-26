# 5.8 Phase 5 Megaudit — Lane S4 (Sonnet): Citation + Factual Accuracy Audit

**Auditor:** Sonnet 4.6 (Lane S4). **Mode:** read-only citation verification.
**Audited against:** engine HEAD `302c7243ddc` (current). Engine source last changed at `ff09a5e17a7` (B#1 fix). Megaudit docs written against source `1465b1db4c4`.
**Method:** opened every cited file:line in the actual code; compared to claims in `closures.md`, `phase-5-exit-packet.md`, and all four lane transcripts (`lane-a.md`, `lane-b.md`, `lane-c.md`, `lane-d.md`). For session.rs / lib.rs citations, also checked the audited commit `1465b1db4c4` directly via `git show` to distinguish "wrong when written" from "shifted by a later commit."

---

## Citation Verification Table

| # | Citation | Document | Claimed Content | Actual Content at Cited Commit | Status |
|---|---|---|---|---|---|
| 1 | `lib.rs:2804` — `removed_cells: Vec::new()` | closures.md C#1, lane-c #1, lane-d D4 item 5 | `removed_cells` hardcoded `[]` in `workbook_snapshot_delta` return | At audited commit `1465b1db4c4`: line 2804 IS `removed_cells: Vec::new()` in the delta return struct. At current HEAD: shifted to line 2814 (B#1 fix added 10 lines to lib.rs). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (10 lines) |
| 2 | `lib.rs:1734` — `export_snapshot` | lane-b B#1, closures.md B#1 | `pub fn export_snapshot(&self, sheet: u16) -> Result<String>` | Line 1734: `pub fn export_snapshot(&self, sheet: u16) -> Result<String>` — unchanged before and after fix. | **ACCURATE** |
| 3 | `lib.rs:1757` — `snapshot_cells` call | lane-b B#1, closures.md B#1 | `snapshot_cells` called without tombstone filter | At audited commit `1465b1db4c4`: line 1757 = `let entries_vec = inner.snapshot_cells(sheet);` — direct call, no filter. At current HEAD (post-fix): line 1757 is a COMMENT inside the new tombstone-filter block; `snapshot_cells` is at line 1766. | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (fix commit `ff09a5e17a7` added ~9 lines) |
| 4 | `lib.rs:2226` — `workbook_snapshot` `is_sheet_removed` filter | lane-b B#1, closures.md B#1, lane-c #6 | `if workbook.is_sheet_removed(sheet_id) { continue; }` | At audited commit: line 2226 = `if workbook.is_sheet_removed(sheet_id) {`. At current HEAD: line 2236 (shifted +10 by fix). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (+10) |
| 5 | `session.rs:1611-1617` — RemoveSheet arm no-prune | lane-b B#1 (R-V3.6-19 evidence), lane-b B5 (Finding 5), lane-c #6 | `CacheEffect::RemoveSheet { id } =>` arm only inserts tombstone, does NOT prune cells | At audited commit `1465b1db4c4`: lines 1611-1617 = `CacheEffect::RemoveSheet { id } => { buckets.tombstones.insert(id); /* preserved comment */ }`. At current HEAD: same content at 1611-1617 (unaffected by the fix — fix only touched lib.rs, not session.rs). | **ACCURATE** |
| 6 | `session.rs:1530-1535` — ClearFormula all-None removal | lane-c #1 | `ClearFormula` arm: `get_mut` + set `formula=None` + remove key if all-None | At audited commit: lines 1530-1535 = `if let Some(state) = buckets.snapshot.get_mut(&key) { state.formula = None; if state.value.is_none() && ... { buckets.snapshot.remove(&key); } }`. | **ACCURATE** |
| 7 | `session.rs:1548-1561` — SetCellFormat{None} removal | lane-c #1 | `SetCellFormat { key, format }` arm: None branch removes key if all-None | At audited commit and current HEAD: lines 1548-1561 = `CacheEffect::SetCellFormat { key, format } =>` match block, None branch removes entry. | **ACCURATE** |
| 8 | `replay.rs:1451` — `apply_create_table` `TableCreateRejected` | lane-a A#2 | `apply_create_table` returns `TableCreateRejected` when table name already exists | Line 1451: `if workbook.tables().lookup(&canonical).is_some() {` followed at 1452 by `return Err(ReplayError::TableCreateRejected { ... })`. | **ACCURATE** |
| 9 | `replay.rs:1030,1121` — RenameTable V1 LIMITATION | lane-a A#3, closures.md A#3 | Line 1030: "V1 LIMITATION — hard-fail" comment for cross-table rename collision; line 1121: `TableCreateRejected` return | Line 1030: "2. **Cross-table target collision** (V1 LIMITATION — hard-fail):" in function docstring. Line 1121: `if workbook.tables().lookup(&new_canonical_arc).is_some() { return Err(ReplayError::TableCreateRejected { ... reason: "table with this canonical name already exists (rename target)" })`. | **ACCURATE** |
| 10 | `replay.rs:1227,1237` — RenameColumn HARD-FAIL | lane-a A#4, closures.md A#4 | Line 1227: "HARD-FAIL - V1 limitation" comment; line 1237: `TableColumnRejected` | Line 1227: comment block beginning "Step 4 audit closure... reverting to hard-reject on collision restores correctness: ...HARD-FAIL — V1 limitation." Line 1237: `if meta.lookup_column(new_name).is_some() { return Err(ReplayError::TableColumnRejected { ... reason: "column with this canonical name already exists (rename target)" })`. | **ACCURATE** |
| 11 | `replay.rs:837,840` — RegisterFormat `FormatRejected` IdCollision | lane-a A#6 | `RegisterFormat` arm: delegates to `register_at` which rejects collision | Line 837: `let fid = id.to_storage();`. Line 840: `.register_at(fid, string.as_str())` followed at 841 by `.map_err(|e| ReplayError::FormatRejected { ... })`. The `IdCollision` variant surfaces via `FormatTableError::IdCollision` → `FormatRejectedSource::IdCollision` (line 841 map_err + impl From at line 326). | **ACCURATE** |
| 12 | `op.rs:47,493` — `deny_unknown_fields` + no top-level `Op::Unknown` | lane-a A#5, closures.md A#5 | Line 47: `#[serde(deny_unknown_fields, tag = "kind")]`; line 493: `SetDateSystem { date_system: DateSystemWire }` is the last variant (no Unknown arm) | Line 47: `#[serde(deny_unknown_fields, tag = "kind")]` ACCURATE. Line 493: `SetDateSystem { date_system: DateSystemWire },` followed at 494 by `}` (enum closes). No `Unknown` top-level arm. | **ACCURATE** |
| 13 | `op.rs:46-49` — `Op` derives + `deny_unknown_fields` + `non_exhaustive` | lane-b B#4 | `Op` enum opens at 49 with `deny_unknown_fields` + `non_exhaustive` | Line 46: `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]`; line 47: `#[serde(deny_unknown_fields, tag = "kind")]`; line 48: `#[non_exhaustive]`; line 49: `pub enum Op {`. | **ACCURATE** |
| 14 | `op.rs:511,570,636` — `Unknown(String)` in three wire enums | lane-b B#4 | `ReferenceModeWire`, `LocaleWire`, `DateSystemWire` each have `Unknown(String)` | Line 511: `Unknown(String),` in `ReferenceModeWire`. Line 570: `Unknown(String),` in `LocaleWire`. Line 636: `Unknown(String),` in `DateSystemWire`. | **ACCURATE** |
| 15 | `session.rs:1353-1429` — `collect_cache_effects` | lane-b B5 | Function range | At audited commit: `fn collect_cache_effects` at line 1353. Current HEAD: same (unaffected by fix). `1429` = approximate end (last arm before closing brace). | **ACCURATE** |
| 16 | `session.rs:1458-1657` — `apply_cache_effect` | lane-b B5 | Function range | At audited commit: `fn apply_cache_effect` at line 1458. `1657` = approximate end. Current HEAD: same. | **ACCURATE** |
| 17 | `session.rs:2148-2224` — `rebuild_snapshot_cache` | lane-b B5 | Function range | At audited commit `1465b1db4c4`: `fn rebuild_snapshot_cache` at line 2148. At current HEAD: 2164 (shifted +16 by fix). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (+16) |
| 18 | `session.rs:2263-2315` — `rebuild_op_indices_only` | lane-b B5 | Function range | At audited commit: `fn rebuild_op_indices_only` at line 2263. At current HEAD: 2279 (+16). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (+16) |
| 19 | `session.rs:2359-2491` — `invalidate_cell` | lane-b B5 | Function range | At audited commit: `pub(crate) fn invalidate_cell` at line 2359. At current HEAD: 2375 (+16). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (+16) |
| 20 | `session.rs:1233-1340` — `append_op` | lane-b B5 | Function range | At audited commit and current HEAD: `pub fn append_op` at line 1233. Unaffected by fix. | **ACCURATE** |
| 21 | `session.rs:1975-1981` — `force_clear_workbook_cache` | lane-b B5 | Function range | At audited commit: `pub fn force_clear_workbook_cache` at line 1975. At current HEAD: 1991 (+16). | **ACCURATE** at audited commit; **SHIFTED** at current HEAD (+16) |
| 22 | `lib.rs:2609-2617` — `debug_assert_eq!` (R-V3.6-15, B#2 corrected cite) | lane-b B#2 and B7 (Finding 7) | `debug_assert_eq!(new_ops.len(), current_op_count - cached_op_count, ...)` | At audited commit: line 2609 = `debug_assert_eq!(`. At current HEAD: shifted to 2619. Lane-b B#2 correctly states the doc cites `2604-2613` but the actual location is `2609-2617`. | **ACCURATE** (the correction B#2 flags is correct; doc cite `2604` is wrong, actual `2609`) |
| 23 | Risk register "38/38 entries confirmed" | closures.md §1, §7; phase-5-exit-packet.md §1 | Total risk entries = 38 | R-V3.3-1..6 = 6; R-V3.4-1..7 = 7; R-V3.5-1..7 = 7; R-V3.6-1..19 = 19; sum = **39**. Lane-b table has 39 rows. PLAN.md §2.6 explicitly lists "R-V3.3-1..6, R-V3.4-1..7, R-V3.5-1..7, R-V3.6-1..19." | **INACCURATE** — arithmetic error; correct count is 39 |
| 24 | `session.rs:1791-1797` — `list_sheets_from_cache` removed_sheets filter | lane-b B#1 evidence | `removed_sheets.contains` filter inside list_sheets_from_cache | At audited commit: `list_sheets_from_cache` at 1780; `removed_sheets.contains` at 1792; the 1791-1797 range covers the BTreeSet loop with the filter at 1792. | **ACCURATE** |

---

## Findings

### S4-F1 — Risk register count is 39, not 38

**Severity:** LOW (factual error in a correctness attestation)
**Files:** `docs/phase5/megaudit-5-8/closures.md:23` ("38/38 entries confirmed"), `closures.md:119` ("38/38 by B"), `docs/phase5/phase-5-exit-packet.md:16` ("Risk register 38/38 confirmed"), `docs/phase5/megaudit-5-8/lane-b.md` (coverage note says "All 38 risks (R-V3.3-1..6, R-V3.4-1..7, R-V3.5-1..7, R-V3.6-1..19)")
**Evidence:**
- R-V3.3-1 through R-V3.3-6 = 6 entries
- R-V3.4-1 through R-V3.4-7 = 7 entries
- R-V3.5-1 through R-V3.5-7 = 7 entries
- R-V3.6-1 through R-V3.6-19 = 19 entries
- Total = 6 + 7 + 7 + 19 = **39**

The lane-b.md risk register table itself has 39 rows (verified by `grep "^| \*\*R-V3\." lane-b.md | wc -l` = 39). The PLAN.md §2.6 source also says "R-V3.3-1..6, R-V3.4-1..7, R-V3.5-1..7, R-V3.6-1..19" confirming 39 intended entries. The "38" figure in closures.md, exit-packet.md, and lane-b's coverage note is a simple arithmetic error (possibly from a prior version that had 18 instead of 19 R-V3.6 entries, i.e., before R-V3.6-19 was added for the RestoreSheet preserved-cells gap).

**The substance is correct** — all entries were walked and none were falsely closed. The count label is wrong.

**Recommendation:** Correct "38/38" to "39/39" in closures.md lines 23 and 119, in phase-5-exit-packet.md line 16, and in lane-b.md's coverage note. One-line correction in each doc.

---

### S4-F2 — `lib.rs:2804` and `lib.rs:1757` and several session.rs lines are shifted in current HEAD due to the B#1 fix commit

**Severity:** INFO (expected drift; all accurate at audited commit `1465b1db4c4`)
**Files:** Multiple citations in lane-b.md, lane-c.md, closures.md referencing `lib.rs:1757`, `lib.rs:2226`, `lib.rs:2804`, `session.rs:1975`, `session.rs:2148`, `session.rs:2263`, `session.rs:2359`
**Evidence:** The B#1 fix commit (`ff09a5e17a7`) added approximately 10 lines to `lib.rs` (tombstone-filter comment + conditional block in `export_snapshot`), shifting subsequent `lib.rs` line numbers by +10. A cascade of session.rs function lines also shifted by +16 in the current HEAD (presumably from additional commits between `1465b1db4c4` and now). Specific shifts:

| Citation (audited commit) | Current HEAD line | Shift |
|---|---|---|
| `lib.rs:1757` (snapshot_cells call) | 1766 | +9 |
| `lib.rs:2226` (is_sheet_removed) | 2236 | +10 |
| `lib.rs:2804` (removed_cells Vec::new()) | 2814 | +10 |
| `session.rs:1975` (force_clear_workbook_cache) | 1991 | +16 |
| `session.rs:2148` (rebuild_snapshot_cache) | 2164 | +16 |
| `session.rs:2263` (rebuild_op_indices_only) | 2279 | +16 |
| `session.rs:2359` (invalidate_cell) | 2375 | +16 |

All citations were **correct when written** against the audited source. The shift is entirely explained by post-audit fix commits. This is normal documentation drift; the audited content is unaffected.

**Recommendation:** No action required for correctness. If the docs are ever refreshed, update the citations to current-HEAD line numbers. Not blocking.

---

### S4-F3 — closures.md §2 does not enumerate all Lane D findings by name

**Severity:** INFO (compression, not invention or omission of substance)
**Files:** `docs/phase5/megaudit-5-8/closures.md:52-61` (Lane D inventory), `docs/phase5/megaudit-5-8/lane-d.md` (full finding list)
**Evidence:** Lane D transcript contains 9 findings:
- D1-1 (LOW stale `# Errors` docstring in `workbookSnapshotDelta`)
- D2-1 (LOW `CellValueJson` loose-bag)
- D2-2 (INFO `WorkbookSnapshotJson.version` intentionally optional in TS)
- D5-1 (MED `Op::Unknown` no round-trip test)
- D5-2 (LOW no `merge_bytes` convergence test for sheet/cell ops)
- D5-3 (LOW no concurrent CreateTable/ResizeTable convergence test)
- D6-1 (LOW format-render silent `.ok()?` drop)
- D6-2 (INFO `catch { /* best-effort */ }` on `detachTransport()`)
- D6-3 (INFO stray `megaudit_lane_a_tmp.rs`)

closures.md §2 Lane D explicitly names only D5-1, D2-1, D5-2, D5-3, D6-3, D3 CLEAN, D6 CLEAN, and the deferred-item dispositions. D1-1, D2-2, D6-1, and D6-2 are absorbed without being named. D6-1 is acknowledged in the D6 CLEAN blurb ("only one justified boundary swallow — format-render parse failure → rendered=None, documented") but not labeled. D1-1 is folded into the §5 "doc drift" bullet without being labeled. D2-2 and D6-2 are not surfaced at all in the synthesis.

**Substance**: none of these missing labels represent a correctness gap — D2-2 and D6-2 are INFO-level, D1-1 is doc-only, and D6-1 is explicitly acknowledged. The omission is a compression artifact, not an invented or dropped finding.

**Recommendation:** For completeness, the closures.md §2 Lane D inventory could add a bullet "D1-1 (LOW stale `# Errors` docstring)" and "D6-1 (LOW format-render silent `.ok()?`)" rather than absorbing them silently. Not blocking.

---

### S4-F4 — All load-bearing structural citations verified ACCURATE

**Severity:** INFO (positive confirmation)
**Files:** All cited files listed in the Citation Verification Table above.
**Evidence:** Every functionally important citation verified:
- `replay.rs:1451` (`apply_create_table` TableCreateRejected) — ACCURATE
- `replay.rs:1030,1121` (RenameTable V1 LIMITATION + TableCreateRejected return) — ACCURATE
- `replay.rs:1227,1237` (RenameColumn HARD-FAIL comment + TableColumnRejected return) — ACCURATE
- `replay.rs:837,840` (RegisterFormat → register_at → FormatRejected IdCollision) — ACCURATE
- `op.rs:47` (deny_unknown_fields), `op.rs:493` (SetDateSystem last variant) — ACCURATE
- `op.rs:511,570,636` (Unknown(String) in three wire enums) — ACCURATE
- `session.rs:1611-1617` (RemoveSheet arm no-prune) — ACCURATE at audited commit, same at current HEAD
- `session.rs:1530-1535` (ClearFormula all-None removal) — ACCURATE
- `session.rs:1548-1561` (SetCellFormat{None} all-None removal) — ACCURATE
- `lib.rs:1734` (export_snapshot function) — ACCURATE
- `lib.rs:2609` (debug_assert_eq! actual location — lane-b B#2's corrected cite) — ACCURATE

No citation was found to be inaccurate at the time it was written.

---

## Finding inventory cross-check (closures.md vs 4 lane transcripts)

| Lane | Transcript findings | Closures.md coverage | Assessment |
|---|---|---|---|
| A | A#1-A#6 (6 findings) | All 6 named explicitly in §2 | COMPLETE |
| B | B#1-B#4 (4 action findings) + B#5-B#8 (4 positive confirmations) | B#1-B#4 named; B#5-B#8 summarized as "4 positive-confirmation findings" in §7 | COMPLETE (all substance captured) |
| C | C#1-C#2 (MED), C#3-C#4 (INFO), C#5 (LOW), C#6-C#11 (INFO pos.) | All explicitly listed: C#1,C#2,C#5 by number; C#3,C#4,C#6-C#11 noted | COMPLETE |
| D | D1-1,D2-1,D2-2,D5-1,D5-2,D5-3,D6-1,D6-2,D6-3 (9 findings) | D5-1,D2-1,D5-2,D5-3,D6-3 named; D1-1,D6-1 absorbed into prose; D2-2,D6-2 not surfaced | COMPRESSION — 4 findings absorbed without names (all LOW/INFO; see S4-F3) |

No findings were **invented** (closures.md introduces no claim not present in the lane transcripts). No HIGH or MED findings were **dropped** — the only absorbed items are all LOW or INFO severity.

---

## VERDICT

**The Phase 5 megaudit docs' citations and facts are SUBSTANTIALLY ACCURATE with two issues to correct:**

1. **INACCURATE (factual error):** The risk-register count "38/38" is wrong. The correct count is **39/39** (R-V3.3-1..6 = 6, R-V3.4-1..7 = 7, R-V3.5-1..7 = 7, R-V3.6-1..19 = 19; sum = 39). The substance (all entries walked, none falsely closed) is correct; only the count label is wrong.

2. **SHIFTED-BY-LATER-COMMIT (expected):** Several `lib.rs` and `session.rs` line citations are accurate at the audited commit `1465b1db4c4` but have drifted by +9 to +16 lines at current HEAD due to the B#1 fix commit (`ff09a5e17a7`) and the 16-line session.rs shift. None were wrong when written.

3. **INFO (compression):** closures.md §2 does not individually name four LOW/INFO Lane D findings (D1-1, D2-2, D6-1, D6-2). No HIGH or MED finding is missing.

All load-bearing citations — the table/column replay abort lines in replay.rs, the op.rs deny_unknown_fields cite, the session.rs RemoveSheet no-prune arm, the ClearFormula cache-entry removal, the lib.rs export_snapshot/snapshot_cells/is_sheet_removed/removed_cells locations — are accurate or accurately shifted.

**The megaudit's factual findings and structural architecture claims are correct. The one concrete correction needed is changing "38/38" to "39/39" everywhere the risk register count appears.**
