---
title: Phase 5.2 D-1 step 7 audit synthesis (Tier D3 oplog.bin magic bytes + version header)
status: CLOSED
date: 2026-05-20
auditors:
  - Codex (Mac CLI, ~212k tokens) — full transcript: `2026-05-20-phase-5-2-d-1-step-7-codex.md`
  - Opus subagent (103k tokens, 605s) — full transcript: `2026-05-20-phase-5-2-d-1-step-7-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `0ccc859958f` (Phase 5.2 D-1 step 7 — Tier D3 oplog.bin magic bytes + version header)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 7 audit synthesis

**5th consecutive DIVERGENT-HIGH cycle.** Codex caught HIGH-1 (legacy backward-compat path is incomplete — pre-step-4 raw Loro files load as Loro docs but fail at op iter() with `OpLogError::Deserialize`). Opus PASSED structurally on that area, caught a unique MEDIUM-3 (module docstring overstates migration story). Convergent on doc drift across collab + oplog crates + version 0 acceptance.

## Findings ledger

| ID | Auditor(s) | Severity | Description | Closure | Status |
|---|---|---|---|---|---|
| H1 | Codex | HIGH | Legacy path: pre-step-4 raw Loro files load OK at framing level, fail at `iter()` op-deserialize. Docstring's "backward compat with pre-Tier-D3 files" claim overstates scope. | Documented limitation prominently in module + helper docstrings. Added `legacy_path_with_corrupt_loro_body_fails_loudly` regression test pinning the loud-failure contract. Synthesizing actual pre-step-4 op JSON deferred to step 8 megaudit (requires bypassing current Op enum serde shape). | ✅ |
| M1 (Codex M2 / Opus M1, convergent) | Codex+Opus | MEDIUM | Doc drift in 4 sites: collab session.rs:248 + 596, presence.rs:19, oplog log.rs:18 + crdt-data-model.md:437 — all imply oplog.bin is "raw Loro snapshot" post-Tier-D3. | Updated all 5 sites to reflect post-Tier-D3 file-vs-transport contract. Transport bytes (export_bytes) are raw Loro; file bytes (save_workbook_with_oplog) add Quantlab header. | ✅ |
| M2 (Opus, Codex L1) | Opus (MEDIUM) / Codex (LOW) | MEDIUM | Version 0 silently accepted. No MIN_SUPPORTED gate. Asymmetric with qbook_format's pattern. | Added `pub const OPLOG_MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1`. Loader now rejects `version < MIN \|\| version > MAX`. Error variant carries both bounds. New regression test `tier_d3_version_zero_rejected_as_unsupported`. | ✅ |
| M3 | Opus | MEDIUM | Module docstring claims "future v2 reader can apply a migration" — actual code only rejects unknown versions. Aspirational vs implemented. | Reworded module docstring: "Forward-rejection versioning" instead of "migration trigger." Honest about what the version field enables today. | ✅ |
| L1 | Opus | LOW | Constants not re-exported at `ql_io::*`. `OPLOG_FILENAME` is; others aren't. | Added re-exports for `OPLOG_MAGIC` / `OPLOG_SCHEMA_VERSION` / `OPLOG_MIN_SUPPORTED_SCHEMA_VERSION` / `OPLOG_HEADER_LEN` at `ql_io::*`. Also promoted `OPLOG_HEADER_LEN` to `pub const` (was private). | ✅ |
| L2 | Opus | LOW | `bytes[..MAGIC.len()] == MAGIC` vs idiomatic `bytes.starts_with(&MAGIC)`. Cosmetic. | Replaced with `starts_with`. | ✅ |

## Closure files

### `crates/ql-io/src/oplog_persistence.rs`

- Module docstring rewritten: "Forward-rejection versioning" + explicit file-vs-transport contract section + scope limitation for legacy path (pre-step-4 op shapes fail at iter, not import).
- `OPLOG_SCHEMA_VERSION` docstring corrected: forward-rejection vs migration trigger.
- New pub `OPLOG_MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1`.
- `OPLOG_HEADER_LEN` promoted to `pub const`.
- `PersistenceError::OplogUnsupportedVersion` adds `min` field; error message updated.
- `decode_oplog_bytes`: gates `version < MIN || version > MAX` (was `> MAX` only). Uses `starts_with(&OPLOG_MAGIC)` (was slice index). Legacy-path branch docstring expanded to document the iter-time failure mode for unknown op shapes.
- New tests: `tier_d3_version_zero_rejected_as_unsupported`, `legacy_path_with_corrupt_loro_body_fails_loudly`. Existing `tier_d3_future_schema_version_rejected` updated for the new 3-field error shape.

### `crates/ql-io/src/lib.rs`

- Re-export `OPLOG_HEADER_LEN`, `OPLOG_MAGIC`, `OPLOG_MIN_SUPPORTED_SCHEMA_VERSION`, `OPLOG_SCHEMA_VERSION` at `ql_io::*`.

### `crates/ql-collab/src/session.rs`

- `CollabSession::export_bytes` docstring: reframed as transport-only with explicit "NOT directly suitable as oplog.bin file contents" warning.
- `sweep_presence` docstring: clarified "LoroDoc whose snapshot is wrapped into the post-Tier-D3 oplog.bin file format."

### `crates/ql-collab/src/presence.rs`

- Module persistence-limitation docstring: clarified post-Tier-D3 framing.

### `crates/ql-oplog/src/log.rs`

- Module persistence docstring: split file-vs-transport responsibility, explicit "do NOT write export_bytes() output directly to oplog.bin."

### `docs/architecture/crdt-data-model.md`

- Section near line 437: `.qbook/oplog.bin` "carries the same Loro snapshot blob, now wrapped in a Quantlab Tier D3 header" (was "remains the same Loro snapshot blob").

## Test count delta

| Step | Tests | Δ |
|---|---|---|
| Pre-step-7 (HEAD 9c748474c66) | 4277 | — |
| Step 7 ship (0ccc859958f) | 4282 | +5 |
| Step 7 audit closure (this commit) | 4284 | +2 |

## Forward dependencies

Step 8 (full-arc megaudit) gains material from step 7 audit:
1. Pre-step-4 op shape migration is the unfinished item from HIGH-1. Megaudit should grep for any pre-step-4 fixture files OR construct an adversarial test that synthesizes pre-step-4 op JSON via direct LoroList manipulation. If neither yields findings, the documented limitation is the closure.
2. Cross-step invariants: `.qbook` → `.qbook` round-trip with multi-peer FormatTable should preserve everything.
3. Workspace-wide grep for remaining `to_legacy_u32().expect()` / pre-D-1 patterns: largely done in steps 5+6 closures; verify.

## 5-cycle divergent-HIGH pattern (steps 3, 4, 5, 6, 7)

| Cycle | Codex HIGH | Opus HIGH | Pattern |
|---|---|---|---|
| Step 3 audit | 2 | 0 (PASS) | DIVERGENT |
| Step 4 audit | 1 | 0 (PASS) | DIVERGENT |
| Step 5 audit | 2 | 0 (PASS) | DIVERGENT |
| Step 6 audit | 3 | 1 (convergent on byte-stability) | DIVERGENT |
| Step 7 audit | 1 | 0 (PASS) + 1 unique MEDIUM | DIVERGENT |

**15/15 audit cycles this engagement caught real bugs.** The 5-cycle divergent-HIGH pattern is structural, not coincidental. Codex's tactical adversarial framing surfaces production-reachable bugs (op-shape mismatches, panic paths, byte regressions, data-loss paths, Strict-policy inconsistencies, version-0 acceptance). Opus's holistic analysis surfaces design smells + doc-vs-code drift + test gaps + missing API symmetry.

Step 8 is the final D-1 work (full-arc megaudit). After 5 consecutive proof-of-value cycles, the discipline is at peak applicability.
