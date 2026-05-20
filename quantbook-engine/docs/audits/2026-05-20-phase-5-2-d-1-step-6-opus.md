# Opus audit — Phase 5.2 D-1 step 6 (xlsx FormatId↔numFmtId mapping) 2026-05-20

Auditor: Opus subagent (independent of the engineer who shipped `19f6aa1b008`).
HEAD audited: `19f6aa1b008`.
Total: 147,391 tokens / 51 tool uses / 501s wall.

## Verdict: 1 HIGH + 1 MEDIUM + 1 MEDIUM + 6 LOW (not a clean PASS)

## HIGH (blocks step 7)

### H1 — Byte-stability claim is FALSE under non-contiguous LEGACY_PEER counters

**Empirically verified** by Opus via a probe test (then removed): a workbook with `Custom(LEGACY_PEER, 0) → "yyyy-mm-dd"` and `Custom(LEGACY_PEER, 5) → "0.0000%"` exports as `numFmtId="164"` and `numFmtId="165"` — sequential reindexing. Pre-step-6 the same workbook exported `164` and `169` (counter + 164).

This is reachable from on-disk input: any xlsx file with non-contiguous custom numFmtIds (gaps in the ≥164 range) feeds non-contiguous LEGACY_PEER counters into the FormatTable via `legacy_from_u32`. Real-world example confirmed in `.references/ironcalc/xlsx/tests/calc_tests/COMBIN_COMBINA.xlsx` (declares 164 and 166).

The functional impact is internal-consistency-preserving (per-cell binding still works), but the bytes change. The commit message + docstring claim byte-stability that doesn't hold.

**Convergent with Codex HIGH-2.**

## MEDIUM

### M1 — Cross-peer same-string flatten silently loses second peer's cells on reimport

**Same finding as Codex HIGH-1** but Opus rates MEDIUM because pre-step-6 panicked anyway (strictly better post-step-6). Practical impact: peer42 + peer99 both intern "yyyy-mm-dd" → export emits two `<numFmt>` entries with same code → reimport StringCollision drops second → peer99's cells render as General.

**Engineer treats as HIGH for closure** (data loss on round-trip qualifies as HIGH regardless of "before it was worse").

### M2 — Test name `step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged` overstates verification

Test body only checks `multi_peer_drops.is_empty()` and re-import correctness; does NOT compare bytes or exercise non-contiguous counters. Given HIGH-1 exists, the test passes despite the byte regression.

## LOW (informational; auditor verified PASS)

- L1 — Translation completeness: PASS (3 consumers verified to query subsets of build-time union).
- L2 — `next` starts at FIRST_CUSTOM_FORMAT_ID always: PASS.
- L3 — Sort-order determinism: PASS (BTreeSet + derived Ord).
- L4 — `info_lost` value matches `custom_map` value: PASS (same xlsx_id used).
- L5 — Tag uniqueness for `Other("multi-peer-format-id-flatten")`: PASS (no collisions).
- L6 — Test coverage gaps beyond H1/M1: 5 deferrable scenarios listed (3+ peers, double round-trip, rebuild determinism, brittle Debug-format assertion, Builtin(>163) direct construction).
- L7 — `Builtin(n>163)` indirect path closed by step 5 audit.
- L8 — Strict policy interaction: PASS as behavior-change note (post-step-6 returns structured Err vs pre-step-6 panic).

## Convergence with Codex

3 of Codex's HIGHs:
- Codex HIGH-1 (cross-peer reimport loss) ↔ Opus MEDIUM-1 (severity disagreement).
- Codex HIGH-2 (byte-stability sparse counters) ↔ **Opus HIGH-1 (convergent on this one).**
- Codex HIGH-3 (Strict policy inconsistencies) — Opus rated as L8 informational, did not flag NewWorkbook write-then-error or UpdateOriginal merge gap.

Opus added M2 (test name overstates) that Codex did not surface.

## 4th consecutive divergent-HIGH cycle

Codex caught 3 forward-activating HIGHs (cross-peer reimport loss, sparse counter byte regression, Strict policy inconsistencies). Opus caught 1 HIGH (convergent on byte-stability) + 1 unique MEDIUM (test name).

Pattern continues: Codex's tactical adversarial framing surfaces production-reachable bugs; Opus's holistic analysis surfaces doc-vs-behavior drift + test gaps. Both are non-overlapping coverage. Neither alone would have closed all findings.

## Files Opus referenced

- `crates/ql-io-xlsx/src/write/umya_export.rs` (translation 85-193; consumers 230-265, 422-430, 470-480, 510-519)
- `crates/ql-io-xlsx/src/read/styles_import.rs` lines 65-103 (silent-skip-on-StringCollision policy — key to understanding the reimport-loss path)
- `crates/ql-io-xlsx/src/lib.rs` lines 273-281 (xlsx import uses legacy_from_u32)
- `crates/ql-storage/src/format.rs` lines 99-141, 416-514
- `crates/ql-io-xlsx/tests/calamine_smoke.rs` lines 1769-1958 (step 6 tests)
- `crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs` lines 60-129
- Real-world non-contiguous fixture: `.references/ironcalc/xlsx/tests/calc_tests/COMBIN_COMBINA.xlsx`
