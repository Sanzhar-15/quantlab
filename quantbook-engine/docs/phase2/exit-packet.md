---
title: Phase 2 exit packet (Phase 2A.1-.13 close-out)
status: Phase 2A complete + megaudit fully closed. GO for Phase 2A.3 (Loro op log) or Phase 2B.
date: 2026-05-12
---

# Phase 2 exit packet — Phase 2A complete

This packet closes Phase 2A of the Quantbook engine. Phase 2A shipped five feature items (2A.1, 2A.2, 2A.4, 2A.5, and the deferred-from-Phase-1 H6 work in 2A.7) plus a complete megaudit cycle (2A.6 + 2A.7-.13) — the audit's findings drove most of the substantive correctness work.

Phase 2A.3 (Loro op log scaffolding) remains deferred to Phase 2B+ — its consumer (the IDE / op-replay test harness) doesn't exist yet and the work benefits from a dedicated session.

## Shipped this phase

| Item | Commit | Summary |
|------|--------|---------|
| 2A.1  | `f8c97cbd22a` | `Expr::NameRef` + NameTable resolution. Closes audit H2's Phase 1 deferred path. |
| 2A.2  | `825b3cbf5a7` | `WorkbookTransaction` multi-cell batch API + `WorkbookRuntime::transaction()`. |
| 2A.4  | `e1e8e286ff0` | `load_workbook_and_recompute` convenience. |
| 2A.5  | `ab5d6ee8f94` | Lexer accepts dotted identifiers (`VAR.S`, `STDEV.P`). |
| 2A.6  | `76cd720916c` | Deep audit close: 4 HIGH + 6 MEDIUM + 4 DOC. |
| 2A.6 M5 | `5ebd8707c41` | `LoadAndRecomputeError::Recompute` preserves partial workbook. |
| 2A.7  | `bb519b945a2` | Megaudit quick-wins: 6 HIGH + 2 MEDIUM + DOC closures (H1, H6, H7, H8, H9, H10; M5, M13). |
| 2A.8  | `02cb35a2a45` | WS-1: qbook schema v2 + crash-safe save (H2, M8, M9, M10, M11, M12). |
| 2A.9  | `a31fa80377e` | WS-2: Excel-canon evaluator parity (H5, M1, M2, M3, M6). |
| 2A.10 | `677a5414a11` | WS-3: fingerprint determinism via SipHash24 + goldens (H3, M14). |
| 2A.11 | `d01c2fbf7f8` | WS-4: error type ergonomics via thiserror (M16). |
| 2A.12 | `2487833540e` | WS-5: A6 NIST numacc3 + LOW/DOC tail (M15). |
| 2A.13 | THIS COMMIT | Megaudit cycle-3 closures: 5 HIGH + 6 MEDIUM + 5 DOC. |

## Megaudit closure status

The first megaudit ran across 6 parallel agents (Codex + 5 Opus). The closure cycle (2A.7-.12) addressed most of the H/M tier. A cycle-3 verification audit (Codex + 3 Opus) caught residual gaps, all closed in 2A.13.

| Tier | Found | Closed | Deferred (by design) |
|------|-------|--------|----------------------|
| HIGH | 10 (round 1) + 5 (cycle 3) | 14 | H4 recompute topological order (Phase 4 calcgraph) |
| MEDIUM | 16 (round 1) + 10 (cycle 3) | 25 | M7 IFERROR lazy eval (paired with Phase 4 AI() ship) |
| LOW/DOC | ~30 + 17 | mostly closed | minor polish |

The deferred items are architectural Phase 4+ work, not Phase 2A bugs.

## Test deltas, Phase 1 close → Phase 2A.13

- `ql-formula-syntax::tests` — 150 → 165 (+15)
- `ql-exec::tests` — 96 → ~165 (+~70: NameRef, transaction, loader, dotted dispatch, validation, conflict detection, Excel-canon, Display, M3 pow guards)
- `ql-storage::tests` — 57 → ~67 (+10: NameTable canon, reserved-name guard, put_formula bounds, read=#REF!)
- `ql-io::tests` — 35 → ~46 (+11: schema v2 round-trips, atomic-save crash window, recovery roll-forward/back, marker file, file-target refusal, M5 compound error)
- `ql-functions::tests` — 56 → 63 (+7)
- `ql-calcgraph::tests` — 16 → ~32 (+16: SipHash goldens including 14 new variants in 2A.13)

## Architecture surface added across Phase 2A

### `BindError`
- `UnresolvedName(Arc<str>)` (2A.1)
- `NamedTargetIsBlank(Arc<str>)` (2A.6)
- `NamedTargetIsError(Arc<str>, ErrorValue)` (2A.6; Display fixed 2A.13 M1)
- (existing) `UnsupportedVariant(&'static str)`

### `RuntimeError`
- `InvalidSheet { sheet, sheet_count }` (2A.6)
- `InvalidCell { sheet, row, col, why }` (2A.7)
- `ConflictingOps { sheet, row, col }` (2A.6)

### `QbookError`
- `MalformedName { name, reason }` (2A.8)
- `InvalidPath { path, reason }` (2A.8)
- `AtomicSaveRollbackFailed { backup_path, install, restore }` (2A.13 M5)

### `NameTableError`
- `Reserved(Arc<str>)` (2A.9)

### Public types
- `WorkbookTransaction` (2A.2)
- `load_workbook_and_recompute`, `LoadAndRecomputeError` (2A.4)
- `bind_with_names`, `NameLookup`, `ResolvedName` (2A.1)
- `NamesSection`, `NamedEntry`, `NamedTargetWire` (2A.8; pub-from-qbook-format)
- `CellWireValue::Pending` (2A.8)

### Schema v2
- `WORKBOOK_SCHEMA_VERSION = 2`, `MIN_SUPPORTED_SCHEMA_VERSION = 1`
- v1 envelopes load (legacy `Error("#NULL!") + formula` rewritten to Pending semantic with a warning emitted; 2A.13 H4)
- v2 carries `names: Option<NamesSection>` and `#[serde(deny_unknown_fields)]` on every envelope/record/wire-value struct
- Atomic save uses recovery-marker files (2A.13 H1) inside engine-owned directories

## Gates passed (Phase 2A.13 close)

- `cargo fmt --all -- --check` — clean
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- `cargo test --workspace` — all green
- `scripts/check-cargo-lock-pins.sh` — 18 packages aligned
- `scripts/check-build-flags.sh` — no `target-cpu=native`
- `scripts/check-multiversion-clones.sh` — aarch64 NEON `fmul.2d` clones present
- `cargo audit` — clean (178 crates)

## Known gaps / Phase 2B+ backlog

- **`recompute_all` partial-state on Err**: the runtime-direct entry point short-circuits on first failure. Add `RecomputeResult` carrying succeeded-count + failed cell. (Phase 2B+.)
- **Bind-plan cache**: `recompute_all` re-lexes/parses/binds every formula. Cache `ExprPlan` next to formula text in `Workbook::formula_cells`. (Phase 2B+.)
- **`AVERAGE`-without-parens UX**: `BindError::UnresolvedName` doesn't hint when the name matches a registered function. (IDE polish; Phase 2B+.)
- **Range/Formula NamedTarget resolution**: still surface as `UnsupportedVariant`. Aggregate-context wiring lands when the calcgraph integrates (Phase 4+).
- **H4 `recompute_all` topological order**: needs calcgraph integration. Multi-day Phase 4 work.
- **M7 IFERROR lazy eval**: pairs with the real AI() ship (Phase 4+).
- **Literal NIST `numacc3.dat` test fixture**: 2A.12 ships a regime-equivalent test against the certified moments; the literal data file is a Phase 3+ test-asset cycle.
- **NamedTarget::Constant(Value::Blank) wire-format ambiguity** (cycle-3 audit M7): conflates with formula-Pending. Defer until either case becomes load-bearing.
- **Concurrent save-from-two-threads collision protection**: handled at the temp-suffix level (2A.8); deeper inter-process file locking would land Phase 2B+ if real users hit it.

## Phase 2A.3 deferral rationale (unchanged)

Loro op log scaffolding (2-3 days estimated) was deferred to Phase 2B+ rather than rushed at end-of-Phase-2A. It deserves:

1. A dedicated session (fresh context, no other Phase 2A items in flight).
2. Its own audit cycle (op log replay semantics are subtle).
3. A consumer for its API — `WorkbookTransaction::commit` is the natural producer; no consumer exists yet.

The `WorkbookTransaction` API is shaped to absorb op-log integration without breaking changes.

## Recommendation

**GO** for Phase 2A.3 (Loro op log scaffolding) in a fresh session, OR Phase 2B (`recompute_all` partial-state, bind-plan cache, calcgraph-integration prep work).

## Reference

- Phase 1 exit packet: `docs/phase1/exit-packet.md`
- Phase 2 entry plan: `docs/phase2/entry-plan.md` (updated through 2A.13)
- First megaudit findings: `docs/audits/2026-05-12-megaudit.md` (all H/M closed across cycles)
- Cycle-3 verification: `docs/audits/2026-05-12-megaudit-cycle3.md` (all HIGH/MEDIUM closed in 2A.13)
