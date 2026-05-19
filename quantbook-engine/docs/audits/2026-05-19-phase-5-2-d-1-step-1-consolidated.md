---
title: Phase 5.2 D-1 step 1 audit synthesis (PeerId move)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, ~107k tokens) — full transcript: `2026-05-19-phase-5-2-d-1-step-1-codex.md`
  - Opus subagent (67k tokens, 109s) — full transcript: `2026-05-19-phase-5-2-d-1-step-1-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `aaa54d32f4d` (Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer)
closure_commit: `1e383dc9eeb` (Phase 5.2 D-1 step 1.1)
---

# Phase 5.2 D-1 step 1 audit synthesis

## Headline

**2-way audit caught real load-bearing issues that step 1 missed.** Codex identified one HIGH (PeerId serde gap), one MEDIUM with architectural impact (Cargo cycle for step 3), one MEDIUM with planning-correctness impact (LEGACY_PEER deferral timing), plus 3 LOW doc-drift items. Opus passed step 1 with 3 LOW polish items — Opus and Codex DIVERGED on the LEGACY_PEER deferral question (Opus said defer was fine; Codex said fix now). The divergence was load-bearing: Codex's reading was correct because the migration helper is born in step 2, not step 5.

Without Codex's audit, step 2 would have failed to compile (PeerId serde) AND step 3 would have hit a Cargo cycle. Both auditors are doing necessary work that the other misses.

## Findings + closures

### HIGH (closed in 1e383dc9eeb)

**H1 — `PeerId` has no serde representation for `FormatIdWire` (Codex).**
- Source: `ql-oplog/src/peer.rs:36` (original location).
- Step 2 plans `FormatIdWire { Custom(PeerId, u32), ... }` with `#[derive(Serialize, Deserialize)]`. PeerId's existing derive list was `Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd` — no serde. Step 2 would have hit a compile error.
- **Closure (1e383dc9eeb):** added `#[derive(Serialize, Deserialize)] #[serde(transparent)]` to PeerId at its new home in `ql_types::peer`. Decision: serialize as plain `u64` (not wrapped tuple `[42]`) so `Custom(PeerId, u32)` JSON shape is `[42, 7]`. New test `serde_transparent_wire_shape_is_plain_u64` pins this.

### MEDIUM (closed in 1e383dc9eeb)

**M1 — `ql_collab::peer::PeerId` module path is broken despite "public surface unchanged" (Codex).**
- Source: `ql-collab/src/lib.rs:62` (step 1 commit).
- The step 1 Stability bullet claimed back-compat. True for `use ql_collab::PeerId;` (re-export preserved); FALSE for `use ql_collab::peer::PeerId;` (module path) — `pub mod peer` was removed by step 1.
- **Closure (1e383dc9eeb):** docstring rewritten to be honest. Workspace grep confirms no external caller used the module path; the claim "no callers broke in practice" survives. New text says module path is gone, re-export path works.

**M2 — `LEGACY_PEER` deferral to step 5 is too late (Codex; Opus disagreed and said defer was fine).**
- Source: `docs/phase5/d-1-starting-checklist.md:66`.
- Step 2's migration helper `FormatIdWire::from_u32_legacy(n)` is born in step 2 per the checklist's own step-2 description. It needs the sentinel before step 5 (qbook envelope). Deferring forces step 2 to inline an ad-hoc sentinel that step 5 then has to rename.
- **Disagreement resolution:** Codex correct. Opus saw the d-1-checklist's "step 5 home" framing for LEGACY_PEER and judged that as the natural defer point; Codex looked at the from_u32_legacy helper's birth location and worked back. Going forward, when auditors disagree on deferral, ship the constant — adding earlier is cheap (one const) and removing duplication later is expensive.
- **Closure (1e383dc9eeb):** added `pub const LEGACY_PEER: PeerId = PeerId::new(0);` to `ql_types::peer`. New test `legacy_peer_is_zero` pins the value. Sentinel choice rationale documented in the const's docstring.

**M3 — `ql-storage` cannot reference `ql_oplog::PeerId` for step 3's `FormatId::Custom(PeerId, _)` — Cargo cycle (Codex).**
- Source: `crates/ql-oplog/Cargo.toml:18`.
- `ql-oplog` already depends on `ql-storage`. If step 3 makes `ql_storage::FormatId::Custom(ql_oplog::PeerId, _)`, `ql-storage` would need `ql-oplog` dep → cycle. The d-1-checklist's earlier line "ql-oplog [...] currently doesn't" depend on ql-storage was incorrect (claim was checked against pre-Tier-D2 state).
- **Closure (1e383dc9eeb):** **PeerId moved to `ql_types::peer::PeerId`** — `ql-types` is the true dependency floor (no internal deps; everyone in this stack depends on ql-types). `ql-oplog` + `ql-collab` re-export `ql_types::PeerId` for back-compat. d-1-checklist updated to reflect the correct architectural decision.

### LOW (closed in 1e383dc9eeb)

**L1 (Codex) — d-1-checklist stale dependency text.** `ql-oplog → ql-storage` exists. Old text said "Option B currently doesn't." Updated to correct state + revised the recommendation rationale.

**L2 (Codex) — crdt-data-model.md stale `pub mod peer` snippet.** The doc was written when PeerId lived in `ql-collab`. Updated to show `pub use ql_oplog::PeerId;` shape post step 1.1.

**L3 (Codex) — op.rs stale doc references `ql_io::qbook_format`.** **DEFERRED to step 2** (op.rs gets edited there anyway; doc cleanup folds naturally).

**L1, L2, L3 (Opus) — rustdoc intra-doc link nits + module-doc-title drift in peer.rs.**
- L1: `[`PeerId::Display`](crate::PeerId)` label points at a trait impl, not an associated item — rustdoc won't resolve as hyperlink. Pre-existing nit (same form in pre-move text). Defer to a later doc-polish pass.
- L2: `[`crate::OpLog::set_peer_id`]` intra-doc link should work via re-export; `cargo doc --no-deps -p ql-oplog` would confirm. Defer-noted.
- L3: Module-level doc title at peer.rs:1 said "Per-peer identifier for Phase 5 collaboration." With step 1.1's move to ql-types, the docstring was rewritten anyway to describe the move history — this drift was resolved as a side effect.

### PASS items preserved across step 1.1

- Dep direction held (Tier D2 lock): ql-oplog has no ql-collab dep; ql-types has no ql-oplog dep.
- No external callers broke (workspace grep clean).
- 3 original peer-module tests survived both moves; 2 new tests added in step 1.1 → 5 total in `ql_types::peer::tests`.
- Back-compat re-export chain works: `ql_collab::PeerId` → `ql_oplog::PeerId` → `ql_types::PeerId`.
- Stability docstring honesty preserved (step 1.1 made it MORE honest).
- Git rename detection: step 1 rendered as a rename (similarity 67%); step 1.1 rendered as delete+add (peer.rs rewrote substantially with serde + LEGACY_PEER + 2 tests).
- Forward-readiness for step 2: peer.rs has `Serialize`/`Deserialize`; ql_types is in ql-storage + ql-oplog's dep graph already (no Cargo edits needed there); `WireDecodeError` is `#[non_exhaustive]` so step 2 can add a `FormatIdDecode` variant cleanly.

## Discipline meta-note

**8th-cycle data point validating 2-way audit.** Codex caught an architecturally load-bearing issue (Cargo cycle for step 3) that Opus didn't surface — Opus did a thorough mechanical check of the step 1 commit but didn't simulate step 3's Cargo graph. Opus caught doc-link polish that Codex didn't list. Without either auditor, real issues would have shipped:
- Codex-only would have missed the rustdoc nits + the module-doc-title drift.
- Opus-only would have missed PeerId-serde-gap, the Cargo cycle, and the LEGACY_PEER deferral timing.

The Codex+Opus DIVERGENCE on LEGACY_PEER (defer vs ship-now) was the highest-signal finding of the cycle — both auditors looked at the same facts and reached opposite conclusions. My judgment call (ship now per Codex's reading of step 2's needs) was load-bearing.

## Gates re-verified post step 1.1

- `cargo build --workspace`: clean.
- `cargo test --workspace`: 4224 passed / 0 failed (baseline was 4222; +2 from step 1.1's `serde_transparent_wire_shape_is_plain_u64` + `legacy_peer_is_zero`).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- HEAD blob = disk for all step-1.1 files (peer.rs 161/161, ql-collab/lib.rs 100/100, ql-oplog/lib.rs 69/69, ql-types/lib.rs 66/66). No truncation race this cycle.

## Forward note

Step 2 (FormatIdWire in ql-oplog::wire) starts from a clean substrate. The d-1-checklist updated to reflect step 1 + 1.1 both shipped; step 2's plan is unchanged but now references `ql_types::PeerId` instead of `ql_oplog::PeerId`.
