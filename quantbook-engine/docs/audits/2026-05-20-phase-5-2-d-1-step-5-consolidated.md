---
title: Phase 5.2 D-1 step 5 audit synthesis (qbook envelope schema bump v7→v8 + legacy loader)
status: CLOSED
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~144k tokens) — full transcript: `2026-05-20-phase-5-2-d-1-step-5-codex.md`
  - Opus subagent (135k tokens, 968s) — full transcript: `2026-05-20-phase-5-2-d-1-step-5-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `2ae5bfcab28` (Phase 5.2 D-1 step 5 — qbook envelope schema bump v7→v8 + legacy loader)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 5 audit synthesis

3rd consecutive **DIVERGENT-HIGH cycle**: Codex caught 2 HIGH + 1 MEDIUM (forward-activating panic paths reachable from user input); Opus PASSED structurally but caught 1 MEDIUM (doc-vs-behavior drift) + 2 LOW. Both auditors offered non-overlapping coverage — neither alone would have found the full set.

## Findings ledger

| ID | Auditor | Severity | Description | Closure | Status |
|---|---|---|---|---|---|
| H1 | Codex | HIGH | `Custom(LEGACY_PEER, u32::MAX)` panics `register_at` on load | New `FormatTableError::CounterOverflow` + pre-validate in register_at + 2 ql-storage tests + 1 qbook regression test | ✅ |
| H2 | Codex | HIGH | `Builtin(>=164)` loads but resave drops it; reload fails | New `FormatTableError::BuiltinOutOfRange` + pre-validate in register_at + 1 ql-storage test + 1 qbook regression test | ✅ |
| M1 | Codex | MEDIUM | `schema_version=7` envelopes accept v8 wire-shaped ids | Post-deserialize loader guard rejecting `FormatEntryId::Wire(_)` in v<8 envelopes + 2 regression tests (formats + overlay paths) | ✅ |
| M2 | Opus | MEDIUM | Docstring + commit claim inline TOML shape; reality is section-header | Updated docstring + commit to describe section-header form honestly; flagged 2x size impact; defer toml_edit inline emission to step 6+ | ✅ |
| L1 | Opus | LOW | `v8_envelope_serializes_tagged_tuple_shape_on_disk` assertion is weak (AND of unrelated substrings) | Strengthened to pin section-header path + negative inline-emission pin | ✅ |
| L2 | Opus | LOW | Test coverage gaps (two-peer, cross-peer same-string, sort determinism, v6 fixtures, MalformedFormat Custom) | Added two-peer round-trip + sort-determinism test (covers gaps 1+2+5); gaps 3-4 deferred (covered indirectly) | ✅ |

## Closure files

### `crates/ql-storage/src/format.rs`

1. Added `FormatTableError::CounterOverflow { peer }` + `FormatTableError::BuiltinOutOfRange { id }`.
2. Pre-validate in `register_at` (Step 0, before any state mutation):
   - `Builtin(n)` with `n > FIRST_XLSX_BUILTIN_MAX` (= 163) → `BuiltinOutOfRange`.
   - `Custom(local_peer, counter)` where `counter == u32::MAX` would advance counter → `CounterOverflow`.
3. Counter-advance `expect(...)` now documents "pre-validated at register_at entry" — not a real panic path.
4. New tests: `register_at_counter_overflow_returns_error_not_panic`, `register_at_counter_overflow_check_only_fires_for_local_peer`, `register_at_builtin_out_of_range_returns_error`.

### `crates/ql-oplog/src/replay.rs`

1. Added `FormatRejectedSource::CounterOverflow` + `BuiltinOutOfRange` variants.
2. Extended `From<FormatTableError>` to map both new variants.

### `crates/ql-io/src/qbook_format.rs`

1. Post-deserialize MEDIUM-1 guard: for `schema_version < 8`, walk `envelope.formats` + each sheet's `format_overlay` and reject any `FormatEntryId::Wire(_)` with `ForwardCompatFieldOnOldVersion`.
2. Updated docstring to describe section-header form honestly (not inline-table).
3. Strengthened `v8_envelope_serializes_tagged_tuple_shape_on_disk` to pin section-header paths + negative inline pin.
4. New regression tests: `v8_envelope_counter_overflow_load_surfaces_malformed_format_not_panic`, `v8_envelope_builtin_out_of_range_load_surfaces_malformed_format`, `v7_envelope_with_v8_wire_id_in_formats_rejected`, `v7_envelope_with_v8_wire_id_in_overlay_rejected`, `v8_envelope_two_peer_round_trip_and_sort_determinism`.

## Test count delta

| Step | Tests | Δ |
|---|---|---|
| Pre-step-5 (HEAD d5c6b2ae11c) | 4257 | — |
| Step 5 ship (2ae5bfcab28) | 4262 | +5 |
| Step 5 audit closure (this commit) | 4270 | +8 |

## Forward dependencies

Step 6 (xlsx export/import flatten) builds on step 5's envelope. Specifically:
- Step 6 calls `FormatTable::iter().filter(|(id, _)| id.is_custom())` to dump custom formats to xlsx `numFmtId`. Step 5's `BuiltinOutOfRange` guard ensures no `Builtin(>163)` entries can exist in the table to confuse step 6.
- Step 6 must decide how to flatten `Custom(non-LEGACY peer, _)` to a single-namespace `numFmtId` (xlsx has no peer-id concept). Step 5's lossless round-trip through `.qbook` doesn't address this; step 6's design decision.

## Divergence pattern

Three consecutive divergent-HIGH cycles (steps 3, 4, 5). Pattern: Codex catches forward-activating bugs (panic paths reachable from user input, structural concerns that bite at the next step); Opus catches design smells + behavior-vs-doc drift + missing coverage that Codex's tactical scan misses.

Neither auditor alone would have closed both H1 + H2 (Codex caught) and M2 (Opus caught) in step 5. The discipline rule of mandatory parallel 2-way audit is reaffirmed.

| Cycle | Codex HIGH | Opus HIGH | Pattern |
|---|---|---|---|
| Step 3 audit | 2 | 0 (PASS) | DIVERGENT — Codex caught forward-activating |
| Step 4 audit | 1 | 0 (PASS) | DIVERGENT — same pattern |
| Step 5 audit | 2 | 0 (PASS) | DIVERGENT — same pattern + Opus M2 unique |

**13/13 audit cycles this engagement caught real bugs.**
