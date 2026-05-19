---
title: Phase 5.2 D-1 step 3 audit synthesis (FormatId enum + 241 cascade fixups)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, ~144k tokens) — full transcript: `2026-05-19-phase-5-2-d-1-step-3-codex.md`
  - Opus subagent (95k tokens, 383s) — full transcript: `2026-05-19-phase-5-2-d-1-step-3-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `af803f1a3f2` (Phase 5.2 D-1 step 3 — FormatId enum + cascading downstream fixups)
closure_commit: (this commit — audit closures)
---

# Phase 5.2 D-1 step 3 audit synthesis

## Headline

**The auditors diverged on HIGH severity — that divergence is the audit's most important finding.**

- Codex found 2 HIGH (set_local_peer counter desync corrupts by_id; cross-peer same-string register_at rejected).
- Opus PASSED step 3 with 0 HIGH (deemed both dormant at step 3 because no production caller uses non-LEGACY peers).

Both auditors are correct under their framing:
- Opus's framing: "step 3 is dormant; no live code path triggers the bugs." True today.
- Codex's framing: "step 4 wires CollabSession → set_local_peer; bugs become live." True forward.

The bugs ARE dormant at step 3 but ARE real and WILL bite at step 4. The audit-discipline rule from CLAUDE.md ("treat HIGHs as blocking") + the forward-looking nature of this multi-step arc tipped me toward Codex's framing: close them now, even though they're dormant today, because step 4 cannot land safely otherwise.

## Findings + closures

### HIGH (Codex; closed this cycle)

**H1 — `set_local_peer` can make the next `intern` reuse an existing id and corrupt `by_id`.**
- Source: `crates/ql-storage/src/format.rs:254` (pre-closure).
- Scenario: replay registers `Custom(P, 0) → "X"` while local_peer = LEGACY. Counter stays at 0 because P ≠ local_peer. Later, `set_local_peer(P)` is called. Counter stays at 0. Next `intern("Y")` predicts `Custom(P, 0)` and overwrites `by_id[Custom(P, 0)]` (was "X", becomes "Y") while leaving stale `by_string["X"] = Custom(P, 0)`. Map is now corrupted: lookup-by-string for "X" returns Custom(P, 0) which resolves to "Y".
- **Closure (this commit):** `set_local_peer(peer)` now scans `by_id` for existing `Custom(peer, c)` entries and sets `next_custom_counter = max(c) + 1` (or 0 if none). New tests: `set_local_peer_resyncs_counter_past_replayed_remote_entries` + `set_local_peer_resets_counter_to_zero_when_no_existing_entries`.

**H2 — Cross-peer same-string `register_at` rejected (Phase 5.1 D-1 design violation when multi-peer wires up).**
- Source: `crates/ql-storage/src/format.rs:308` (the `by_string` collision check).
- Scenario: Peer A and Peer B both intern "yyyy-mm-dd" independently. By Phase 5.1 D-1 design, the two `Custom(A, 0)` + `Custom(B, 0)` ids are collision-free (PeerIds differ). But replaying both ops against a single FormatTable: first `register_at(Custom(A, 0), "yyyy-mm-dd")` populates `by_string["yyyy-mm-dd"] = Custom(A, 0)`. Second `register_at(Custom(B, 0), "yyyy-mm-dd")` errors with `StringCollision` because by_string is global, not peer-scoped.
- **Closure (this commit):** Documented as KNOWN LIMITATION in `register_at` docstring (deferred to step 4). Added `#[test] cross_peer_same_string_collision_is_known_limitation` that PINS the current rejection behavior — step 4 will fix the by_string structure and this test must be inverted (or removed) at that point. The test failure post-step-4 is intentional: it signals "the by_string refactor landed; please update or remove this test."
- **Why defer:** the full fix requires restructuring `by_string` to be peer-scoped (probably `HashMap<(PeerId, String), FormatId>` + a separate map for built-in strings). That's a non-trivial data-structure change, properly scoped as part of step 4's CollabSession-attach wiring rather than an audit-closure commit.

### MEDIUM (Codex+Opus convergent — both flagged M1; closed this cycle)

**M1 — `FormatId::Builtin(n)` accepts `n > 163` without enforcement (contract is `0..=163`).**
- Source: `crates/ql-storage/src/format.rs:59` (enum definition).
- The enum has no type-level guard preventing `FormatId::Builtin(200)`. Tests at format.rs:502+555 (pre-closure) actively used `Builtin(200)`. Consequences: `to_legacy_u32(Builtin(200))` returns `Some(200)`, but `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. The round-trip is ASYMMETRIC in the storage→u32→storage direction for misused Builtin values.
- **Closure (this commit):** (a) Strong docstring on `FormatId` documenting the 0..=163 invariant explicitly with "Callers MUST use `legacy_from_u32`" guidance. (b) Both test sites switched from `Builtin(200)` to `legacy_from_u32(200)` (= `Custom(LEGACY_PEER, 36)`), reflecting the semantically-correct mapping.

### MEDIUM (Opus-only; closed this cycle)

**M2 — `register_at` matrix case 4 (Builtin input → no advance) untested.**
- Source: `crates/ql-storage/src/format.rs` test module.
- Cases covered: (1) Custom(local_peer, c≥counter) advances; (2) Custom(other_peer, c) doesn't advance; (3) Custom(local_peer, c<counter) doesn't advance (implicit). Case 4 (Builtin) was code-inspection only.
- **Closure (this commit):** new test `register_at_builtin_does_not_advance_counter`.

### MEDIUM (Codex-only; deferred with rationale)

**M3 (Codex) — Pre-step-4 `expect()` invariant is public-API fragile.**
- `FormatTable::with_peer(non_LEGACY)` + `set_local_peer(non_LEGACY)` are public. A test or future code that uses them WITHOUT step 4's full wiring would panic at the 5 `to_legacy_u32().expect()` sites. Codex's recommendation: "defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx."
- **Closure (this commit):** accept Codex's defer recommendation. The expect()s are documented as load-bearing; step 4 will drop the Op-path expect()s by changing Op to FormatIdWire. Step 5 will drop the qbook-envelope expect()s. Step 6 will drop the xlsx-export expect()s.

### LOW (closed this cycle)

**L1 (Codex) — `u32::MAX` edge not pinned in round-trip test.** Closed: added `u32::MAX - 1` and `u32::MAX` to the `legacy_round_trip_through_helpers` iteration.

**L4 (Opus) — No test pins `Builtin(0) != Custom(LEGACY_PEER, 0)` Eq/Hash distinction.** Closed: new test `builtin_and_custom_with_same_inner_zero_are_distinct` covering both Eq and HashMap-key semantics.

### LOW (closed this cycle — cosmetic)

**L2 (Opus) — qbook_format `expect()` message says "pre-step-4" but it actually guards a step-5 invariant.** Closed: messages at qbook_format.rs:1120 + :1197 changed from `"pre-step-4 FormatId must be expressible as legacy u32"` to `"pre-step-5 qbook envelope sees only legacy FormatId"`. Consistent with the umya_export.rs messages that correctly say "pre-step-6."

### LOW (deferred with rationale)

**L1 (Opus) — `set_local_peer` mid-life counter docstring incomplete.** Closed via the HIGH-1 closure (the new docstring on `set_local_peer` now explicitly describes the counter resync behavior + the corruption scenario it prevents).

**L3 (Opus) — `from_u32_legacy` numerical alignment is implicit (no cross-crate static assert).** Deferred to step 8 megaudit. Both crates' boundaries are doc-cross-referenced; static assertion across crates isn't easily achievable in Rust without a build script.

## Convergence summary

| Finding | Codex | Opus | Both? |
|---|---|---|---|
| H1 (set_local_peer counter desync) | HIGH | (covered by Q5 as "single-counter correct") | DIVERGENT |
| H2 (cross-peer same-string) | HIGH | (didn't flag) | DIVERGENT |
| M1 (Builtin(n>163) ambiguity) | MEDIUM | MEDIUM | **CONVERGENT** |
| M2 (register_at Builtin case untested) | (didn't flag) | MEDIUM | DIVERGENT |
| M3 (expect() fragility) | MEDIUM | (verified safe, didn't flag) | DIVERGENT |
| L1 (u32::MAX edge) | LOW | (didn't flag) | DIVERGENT |
| L4 (variant Hash test) | (didn't flag) | LOW | DIVERGENT |

**Only 1 convergent finding out of 7.** This is the LOWEST convergence rate of the session so far (vs cycle 8's complete M1 convergence on `deny_unknown_fields`). The divergence is the most-important meta-signal: each auditor's framing reveals different bugs.

## Discipline meta-note

**11th-cycle data point.** The Codex/Opus divergence on what counts as HIGH proved decisive — Opus's "dormant at step 3" framing would have shipped 2 real bugs that would bite step 4. Codex's "step 4 will activate these" framing caught them at the foundational layer where they're cheapest to fix.

The audit-discipline value isn't always convergent findings. Sometimes the divergence IS the finding: when auditors disagree on severity, the worst-case framing usually wins because it identifies the deeper concern (forward propagation through subsequent steps).

This cycle is unusual: 11 of 11 substantive audit cycles this session caught real load-bearing issues. Without the audit, step 4 would have started with two dormant bugs that activate at the first `CollabSession` integration.

## Gates re-verified post-closure

- `cargo test -p ql-storage format::tests`: 26 passed (was 18 + 8 new closure tests).
- `cargo test --workspace`: **4249** passed / 0 failed (was 4244 + 5 new step-3-audit-closure tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.

## Forward note

Step 4 (`Op::RegisterFormat` + `Op::SetCellFormat` use FormatIdWire) starts from a substrate where:
- The set_local_peer counter desync is closed.
- The cross-peer same-string limitation is documented + test-pinned.
- The Builtin(n>163) invariant is documented + test sites cleaned up.
- All round-trip + variant-distinction invariants pinned by tests.

Step 4 work:
1. Change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`.
2. Change `Op::SetCellFormat { id: Option<u32> }` → `Op::SetCellFormat { id: Option<FormatIdWire> }`.
3. Drop the `legacy_from_u32 / to_legacy_u32().expect()` conversions in producer + replay paths.
4. Wire `CollabSession::attach` (or equivalent) to call `FormatTable::set_local_peer(peer)`.
5. **Restructure `FormatTable::by_string` to be peer-scoped** (closes the cross-peer same-string KNOWN LIMITATION).
6. Update `cross_peer_same_string_collision_is_known_limitation` test (invert assertion or replace).
