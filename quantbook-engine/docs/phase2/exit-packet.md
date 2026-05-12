---
title: Phase 2 exit packet (Phase 2A close-out)
status: GO for Phase 2A.3 / Phase 2B
date: 2026-05-12
---

# Phase 2 exit packet — Phase 2A complete

This packet closes Phase 2A of the Quantbook engine. Phase 2A shipped four feature items (2A.1, 2A.2, 2A.4, 2A.5) plus a deep audit close (2A.6). Phase 2A.3 (Loro op log scaffolding) is deferred to Phase 2B+ — too large for end-of-session and benefits from a dedicated audit cycle of its own.

## Shipped this phase

| Item    | Commit         | Summary                                                                                          |
|---------|----------------|--------------------------------------------------------------------------------------------------|
| 2A.1    | `f8c97cbd22a`  | `Expr::NameRef` + NameTable resolution. Closes audit H2's Phase 1 deferred path.                 |
| 2A.2    | `825b3cbf5a7`  | `WorkbookTransaction` multi-cell batch API + `WorkbookRuntime::transaction()` convenience.       |
| 2A.4    | `e1e8e286ff0`  | `load_workbook_and_recompute` convenience. Surfaced `.qbook` NameTable persistence gap.          |
| 2A.5    | `ab5d6ee8f94`  | Lexer accepts dotted identifiers (`VAR.S`, `STDEV.P`). Removes Phase 1 `VAR` alias workaround.   |
| 2A.6    | `76cd720916c`  | Deep audit close: 4 HIGH + 6 MEDIUM + 4 DOC fixes. All HIGH paths now error loudly.              |

## Test deltas, Phase 1 close → Phase 2A close

- `ql-formula-syntax::tests` — 150 → 165 (+15: 12 dotted-ident lex/parse, 1 leading-dot regression, 2 dotted printer roundtrips)
- `ql-exec::tests` — 96 → 135 (+39: NameRef resolution, transaction, loader, dotted runtime dispatch, audit-fix sheet validation + conflict detection + named-blank/error)
- `ql-storage::tests` — 57 → 58 (+1: NameTable canonicalization)
- Total Phase 2A test growth: **+55 tests** across the engine.

## Acceptance posture (Phase 2A items)

| Item    | Acceptance | Notes |
|---------|------------|-------|
| 2A.1    | ✅ LOCKED   | Closes audit H2's deferred path. Range/Formula NamedTarget variants still error as `UnsupportedVariant` — Phase 2B+. |
| 2A.2    | ✅ LOCKED   | Two-pass commit semantics pinned by paste-block test. Conflict detection added in 2A.6. |
| 2A.4    | ✅ LOCKED   | Surfaced gap: `.qbook` doesn't persist NameTable (pinned by test; fix in Phase 2B ql-io schema bump). |
| 2A.5    | ✅ LOCKED   | End-to-end verified: `=VAR.S(1, 2, 3) → 1.0`, `=STDEV.P(2,4,4,4,5,5,7,9) → 2.0`. |
| 2A.6    | ✅ LOCKED   | All HIGH + audit-priority MEDIUM + DOC items closed. Low-severity items tracked below. |

## Gates passed (Phase 2A close)

- `cargo fmt --all -- --check` — clean
- `cargo clippy --locked --workspace --all-targets -- -D warnings` — clean
- `cargo test --locked --workspace` — all green
- `scripts/check-cargo-lock-pins.sh` — 18 packages aligned
- `scripts/check-build-flags.sh` — no `target-cpu=native`
- `scripts/check-multiversion-clones.sh` — aarch64 NEON `fmul.2d` clones present
- `cargo audit` — clean (no advisories)

## Architecture notes — new surface in Phase 2A

### Bind-time errors (`BindError`)
- `UnsupportedVariant(&'static str)` (Phase 0; widened scope through Phase 2)
- `UnresolvedName(Arc<str>)` (Phase 2A.1)
- `NamedTargetIsBlank(Arc<str>)` (Phase 2A.6) — was silent Excel coercion to `Text("")`
- `NamedTargetIsError(Arc<str>, ErrorValue)` (Phase 2A.6) — was wrong-error-class fallback

### Runtime-pipeline errors (`RuntimeError`)
- `Lex`, `Parse`, `Bind` (Phase 1)
- `InvalidSheet { sheet, sheet_count }` (Phase 2A.6) — was a panic from `Workbook::put_at`
- `ConflictingOps { sheet, row, col }` (Phase 2A.6) — was permitted-but-surprising tx behavior

### New types / re-exports from `ql_exec`
- `WorkbookTransaction` (Phase 2A.2)
- `load_workbook_and_recompute`, `LoadAndRecomputeError` (Phase 2A.4)
- `bind_with_names`, `NameLookup`, `ResolvedName` (Phase 2A.1)

## Known gaps / Phase 2B+ backlog

Deferred from 2A.6 audit (all LOW or non-blocking MEDIUM):

- **`.qbook` NameTable persistence**: the schema doesn't serialize defined names. Pinned by `loader.rs::named_range_formula_round_trips_through_load_and_recompute`. Fix lives in `ql-io::qbook_format` with a schema-version bump.
- **`recompute_all` partial-state on Err** (audit M4): short-circuits on the first failing formula; caller has no way to know how far it got. Add `RecomputeResult` carrying succeeded-count + failed cell.
- **`load_workbook_and_recompute` partial workbook drop** (audit M5): on `Err`, the partially recomputed workbook is dropped. Consider `LoadAndRecomputeError::Recompute { workbook, error }`.
- **Bind-plan cache** (audit L3): `recompute_all` re-lexes/parses/binds every formula on every call. Cache `ExprPlan` next to formula text in `Workbook::formula_cells` so recompute is bind-cache hit + eval.
- **AVERAGE-without-parens UX** (audit L10): `BindError::UnresolvedName` doesn't hint when the name matches a registered function. IDE polish.
- **10k-op transaction stress test** (audit L6): no perf floor established.
- **Range/Formula NamedTarget resolution** (Phase 2A.1 + 2A.6): both still return `UnsupportedVariant`. Aggregate-context wiring lands Phase 2B+ when the calcgraph integrates.

## Phase 2A.3 deferral rationale

Loro op log scaffolding (2-3 days estimated) was deferred to Phase 2B+ rather than rushed at the end of this session. It deserves:

1. A dedicated session start (fresh context, no other Phase 2A items in flight).
2. Its own audit cycle (op log replay semantics are subtle; the existing audit pattern works best when scoped to one large change).
3. A consumer for its API: `WorkbookTransaction::commit` is the natural producer (one op per commit), but no consumer exists yet. Pair with the IDE wiring or a CRDT-replication test harness.

The `WorkbookTransaction` API (Phase 2A.2) is shaped to absorb op-log integration without breaking changes — `commit` can append an op record before applying writes, with no signature change.

## Recommendation

**GO** for Phase 2A.3 (Loro op log scaffolding) in a fresh session, or Phase 2B (which would start with the `.qbook` NameTable persistence and the `recompute_all` partial-state diagnostics).

The engine is at a clean checkpoint: all Phase 2A acceptance items LOCKED, audit fully closed, gates green.

## Reference

- Phase 1 exit packet: `docs/phase1/exit-packet.md`
- Phase 2 entry plan: `docs/phase2/entry-plan.md` (updated through 2A.6)
- Phase 2A audit findings (severity rubric + per-item details): the audit was run as a deep-analysis agent on commits `f8c97cb..ab5d6ee` on 2026-05-12; the full report is captured in commit `76cd720916c`'s message and in the in-line `Phase 2A.6 audit …` doc comments on each fixed location.
