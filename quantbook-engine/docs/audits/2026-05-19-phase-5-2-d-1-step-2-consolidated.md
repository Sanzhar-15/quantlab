---
title: Phase 5.2 D-1 step 2 audit synthesis (FormatIdWire)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, ~154k tokens) — full transcript: `2026-05-19-phase-5-2-d-1-step-2-codex.md`
  - Opus subagent (77k tokens, 223s) — full transcript: `2026-05-19-phase-5-2-d-1-step-2-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `135bbb99f75` (Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 2 audit synthesis

## Headline

**2-way audit converged on the load-bearing finding.** Both Codex AND Opus independently identified M1 (`deny_unknown_fields` missing on `FormatIdWire`) as the same MEDIUM-severity issue. Opus added M2 (misleading test name `round_trips_through_loro_value_bincode` — the test uses serde_json, not bincode or LoroValue). Codex added LOW (stale "Commit: pending" line in d-1-checklist). Both auditors PASS on the core wire shape, `from_u32_legacy` boundary correctness, collision-freedom guarantee at the type level, and step 3 / 4 / 5 readiness.

This is the cleanest 2-way audit result of the session so far — convergent MEDIUM (real bug, both saw it) + asymmetric LOW catches (each found something the other missed) + identical PASS verdicts on the 10+ readiness items each checked.

## Findings + closures

### HIGH

None.

### MEDIUM (closed this cycle)

**M1 — `#[serde(deny_unknown_fields)]` missing on `FormatIdWire` (both auditors).**
- Source: `crates/ql-oplog/src/wire.rs:281` (the `#[derive]` + `#[serde(...)]` line on the enum).
- The "no fallbacks — errors must be visible" rule from global CLAUDE.md (and the project's no-fallbacks doctrine) requires that producer drift (extra/misnamed field) fail loudly rather than silently drop data. `qbook_format.rs:561, 571` already uses `#[serde(deny_unknown_fields)]` on its serde structs as established precedent. Empirically verified: `{"kind":"builtin","id":14,"extra":1}` was deserializing silently to `Builtin { id: 14 }`.
- Step 4 will put `FormatIdWire` on the actual wire inside `Op::RegisterFormat` / `Op::SetCellFormat`. Silent acceptance of extra fields would mask a real producer bug shipping to user `.qbook` files.
- **Closure (this commit):** added `deny_unknown_fields` to the `#[serde]` attribute. 4 new rejection tests pin the contract:
  - `rejects_unknown_field_in_builtin_variant`
  - `rejects_unknown_field_in_custom_variant`
  - `rejects_arbitrary_top_level_extra_field`
  - `rejects_unknown_kind_tag` (a future `{"kind":"tombstoned"}` variant must error, not silently fall through)

**M2 — Test name `round_trips_through_loro_value_bincode` misleading (Opus).**
- Source: `crates/ql-oplog/src/wire.rs:471` (the test body).
- Test name claimed "loro_value_bincode" path; body uses `serde_json::to_string` / `from_str`. Actual `Op` serialization path is `serde_json::to_string` into Loro's LoroList values (verified at `log.rs:94, 129`) — JSON, not bincode or Loro's native binary `LoroValue`.
- **Closure (this commit):** renamed to `round_trips_worst_case_through_serde_json`. Test body unchanged (the worst-case `peer ≈ u64::MAX, counter = u32::MAX` round-trip remains pinned). Comment added explaining the rename + linking the actual wire path.

### LOW (closed this cycle)

**L1 (Codex) — `Commit: pending` doc line stale.**
- Source: `docs/phase5/d-1-starting-checklist.md:110`.
- D-1 checklist marked step 2 ✅ but the commit reference still said `pending`. Closure updated to point at `135bbb99f75` + reference this audit closure commit.

### LOW (deferred with rationale)

**L1 (Opus) — `FIRST_XLSX_BUILTIN_MAX` not `pub`.** Defer to step 5/6 when consumers materialize. Either a pub re-export from `ql_oplog::wire` or duplication-then-audit-then is acceptable; the decision needs a real use site, not speculative shape.

**L2 (Opus) — Missing `is_builtin` / `is_custom` / `peer` / `counter` accessors.** Defer to step 3. Storage `FormatId` (step 3) will mirror this shape and own those accessors — adding them at the wire layer pre-step-3 violates "don't add features beyond what the task requires."

**L3 (Opus) — `#[non_exhaustive]` not on `FormatIdWire`.** Defer to step 8 (megaudit). Consistency with `CellWireValue`/`NamedTargetWire` (neither has it) wins over premature open-set marking. Phase 5 V1's Stability doctrine treats wire-enum variant additions as schema-bump events (oplog.bin magic header per step 7) — that's the structural guard, not `#[non_exhaustive]`.

**L4 (Opus) — `LEGACY_PEER` collision-freedom needs runtime enforcement at `OpLog::set_peer_id`.** Defer to step 4 (where set_peer_id is touched anyway). `debug_assert_ne!(peer_id.as_u64(), 0)` belongs in the OpLog API, not at the wire-type level.

### Disagreement / divergence

None. Codex and Opus converged on M1 (the only load-bearing finding) and disagreed only on the small set of L items each prioritized — neither auditor surfaced anything the other contradicted.

## Gates re-verified post-closure

- `cargo test -p ql-oplog format_id_wire`: **13** passed (was 9 + 4 rejection tests).
- `cargo test --workspace`: **4237** passed / 0 failed (was 4233 + 4 rejection tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- HEAD blob = disk for wire.rs (post-closure commit) — verified after commit.

## Discipline meta-note

**10th-cycle data point.** Both Codex AND Opus caught the SAME MEDIUM (M1) — first time this session that both auditors landed on the same finding as the highest-priority item rather than each catching different load-bearing issues. Both also agreed on PASS for the wire shape, boundary correctness, collision-freedom, and forward step 3/4/5 readiness.

The 2-way audit pattern remains load-bearing not because the auditors always disagree (sometimes they converge, like here) but because each independently verifies the same surface — convergent findings are stronger evidence than either auditor alone could provide. M1 (deny_unknown_fields) would have been easy to dismiss as "premature hardening" from a single auditor; with both surfacing it independently against the no-fallbacks doctrine, the close-now decision is straightforward.

## Forward note

Step 3 (`ql_storage::FormatId` enum) starts from a clean substrate. The wire type is locked: tagged-struct serde, `deny_unknown_fields`, `from_u32_legacy` migration helper. Step 3's storage `FormatId` should mirror the variant shape but does NOT need to mirror the wire serde attributes (storage isn't directly serialized as JSON; the wire-to-storage conversion happens at the `FormatIdWire ↔ FormatId` boundary inside `Op::RegisterFormat` replay in step 4).
