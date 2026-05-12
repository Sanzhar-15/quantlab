---
title: Megaudit cycle #3 — Phase 2A.7-.12 closure verification
date: 2026-05-12
head: 2487833540e
sources:
  - Codex (codex-cli 0.130.0) full-repo pass on commits bb519b9..2487833
  - Opus agent A — WS-1 (storage v2) + WS-2 (Excel-canon evaluator)
  - Opus agent B — WS-3 (fingerprint) + WS-4 (errors) + WS-5 (acceptance + tail)
  - Opus agent C — cross-cutting regressions + test quality + no-fallbacks + doc rot
status: report — NO fixes applied
---

# Megaudit cycle #3 — closure verification

Audit of the closure-cycle commits that implemented the first megaudit's fix plan:

```
bb519b945a2 W5-17 2A.7  megaudit quick-wins (6 HIGH + 2 MEDIUM + DOC)
02cb35a2a45 W5-18 2A.8  WS-1 qbook v2 + crash-safe save
a31fa80377e W5-19 2A.9  WS-2 Excel-canon evaluator parity
677a5414a11 W5-20 2A.10 WS-3 fingerprint determinism (SipHash24)
d01c2fbf7f8 W5-21 2A.11 WS-4 error type ergonomics (thiserror)
2487833540e W5-22 2A.12 WS-5 A6 NIST numacc3 + LOW/DOC tail
```

## Headline

Closure-cycle WORK is solid. Every closure commit's test quality is high. No Phase 0/1/2A.1-.6 invariants regressed. The defects are in **doc/memory rot from the closure cycle itself** and **a few real-but-narrow follow-ups** to the H/M items.

## Cross-agent corroboration

| Finding | Codex | Agent A | Agent B | Agent C |
|---------|:---:|:-:|:-:|:-:|
| Golden fingerprint table incomplete (only 3/13 operators, no Cells variant, no Array/Spill) |   | ✓ | ✓ |   |
| `BindError::NamedTargetIsError` Display leaks `DivZero` instead of `#DIV/0!` |   |   | ✓ |   |
| `.bak-<random>` recovery scans by filename prefix — could nuke user `book.qbook.bak-2025-review` | ✓ |   |   |   |
| `Workbook::put_formula` doesn't validate row/col — bypasses 2A.7 H1 guard | ✓ |   |   |   |
| `Workbook::read` still returns Blank for missing sheet — H6 fixed eval path, not read API |   |   |   | ✓ |
| v1→v2 `Error("#NULL!")+formula` migration corrupts legitimate `#NULL!` formula results |   | ✓ |   |   |
| `path.exists()` doesn't check `is_dir()` — file at target gets silently renamed to `.bak-` |   | ✓ |   |   |
| `0^-1` returns `#NUM!` instead of `#DIV/0!` (companion to M3) |   | ✓ |   |   |
| `SimdShape::DivScalar/DivArray` + `simd::div_array` dead post-H5; should delete or deprecate |   | ✓ |   |   |
| `scalar.rs` module header (lines 12, 27-28) still says "Phase 0 / W4-4 deferred" |   |   | ✓ |   |
| `docs/phase2/{exit-packet,entry-plan}.md` stale through 2A.6; ignore 2A.7-.12 entirely |   |   |   | ✓ |
| `current_work.md` memory still claims HEAD = `3717bc6b167` |   |   |   | ✓ |
| `eprintln!` should be `tracing::warn!` | ✓ |   |   |   |
| Concurrent loader race on same orphan backup | ✓ |   |   |   |
| Step-3 rollback failure underreports user-visible state | ✓ |   |   |   |
| Multi-orphan-deadlock from repeated step-4 cleanup failures |   | ✓ |   |   |
| ql-io missing `pub use` for `NamesSection`, `NamedEntry`, `NamedTargetWire` |   |   |   | ✓ |
| `MIN_SUPPORTED_SCHEMA_VERSION` const is private (`const`, not `pub const`) |   |   |   | ✓ |

---

## HIGH (5)

### H1 — `.bak-<random>` recovery scans by filename prefix; can delete user-created siblings
**Codex finding.** `recover_from_crashed_save` (`qbook_format.rs:610`) iterates `<basename>.bak-*` siblings and either deletes them (target valid) or renames them over the target (target missing). A legitimate user-created backup like `book.qbook.bak-2025-review` next to `book.qbook` is treated as an orphan and either deleted or — worse — installed as the workbook.

**Fix**: write a recovery-marker file inside the temp dir at step 1 (e.g., `<temp>/.atomic-save-marker-<suffix>`). At recovery time, only recognize `.bak-<random>` siblings whose marker file matches the suffix. Filename prefix is not ownership.

### H2 — `Workbook::put_formula` accepts unbounded sheet/row/col; bypasses 2A.7 H1 row/col guard
**Codex finding.** `Workbook::put_formula` (`workbook.rs:293`) accepts any (sheet, row, col) without bounds checking. The 2A.7 H1 fix added `validate_cell` at the runtime/transaction layer, but a caller reaching directly into `Workbook::put_formula` (the qbook loader is the prod caller) bypasses it. Downstream `recompute_all`'s `put_at` would panic on bad coords.

**Fix**: make `Workbook::put_formula` return `Result<(), InvalidCell>` and validate row/col internally. Or document the invariant + assert at debug-build time. Loader already pre-validates row/col bounds (qbook_format.rs:911-924), so this is defense-in-depth + future-proofing.

### H3 — Golden fingerprint table covers only 3/13 Operator variants + no RangeRef::Cells
**Agents A + B both found.** Goldens pin: Plus, Mul, Minus. Missing: Div, Percent, Pow, Concat, Eq, Neq, Lt, Le, Gt, Ge (10 of 13). Also missing: RangeRef::Cells (the most field-heavy variant), Expr::Array, Expr::Spill, CellAddr with `Some(sheet)`. The M14 hardening's early-warning system is only triggered by Plus/Mul/Minus reorders.

**Fix**: extend the goldens array with one fixture per Operator variant (10 lines), one RangeRef::Cells, one CellAddr::Some, one each for Array/Spill. ~30 lines, mechanical. Doc already has the regen recipe.

### H4 — v1→v2 migration rule silently corrupts legitimate `Error("#NULL!") + formula` cells into Blank
**Agent A finding.** `qbook_format.rs:929-947`: the rule `is_v1 && rec.formula.is_some() && rec.value == Error("#NULL!")` matches BOTH:
- (intended) v1 engine's encoding of formula-bearing Blank cells.
- (unintended) v1 files where the formula legitimately evaluated to `#NULL!` (Excel's intersection-of-disjoint-ranges error, e.g., `=SUM(A1 B1)` with a space).

Both encode identically in v1. The migration silently rewrites the second case to `Value::Blank`, losing the user's actual error result.

**Fix**: at minimum, `eprintln!` a one-line note per migrated cell ("loaded N legacy formula+null cells as Pending; verify user formulas don't intentionally produce #NULL!"). Better: extend `LoadAndRecomputeError` or add a `Workbook::loaded_legacy_pending_count` accessor. Per CLAUDE.md no-fallbacks rule, the silent corruption is the bigger sin.

### H5 — `path.exists()` doesn't check `is_dir()`; regular file at target silently renamed to `.bak-`
**Agent A finding.** `save_workbook` (`qbook_format.rs:485-487`) calls `fs::rename(path, &paths.backup)` when `path.exists()`. If `path` is a regular file (no enforcement of `.qbook` suffix being a directory), the rename succeeds, the file becomes `.bak-<random>`, recovery on next load tries `remove_dir_all` on it (errors cleanly via `eprintln!`), and the user's pre-existing regular file ends up orphaned.

**Fix**: pre-check `if path.exists() && !path.is_dir() { return Err(QbookError::InvalidPath { ... }); }` at the top of save_workbook. ~3 lines + 1 test.

---

## MEDIUM (10)

### M1 — `BindError::NamedTargetIsError` Display still uses `{1:?}` for ErrorValue
**Agent B finding.** `plan.rs:92` reads `#[error("named constant {0:?} holds an error value: {1:?}")]`. `ErrorValue` already implements `Display` (renders `#DIV/0!` etc.). The 2A.11 WS-4 migration missed this variant. User-facing string today: `"...holds an error value: DivZero"` instead of `"...holds an error value: #DIV/0!"`.

**Fix**: `{1:?}` → `{1}`. One character.

### M2 — `Workbook::read` returns `Blank` for missing sheet; inconsistent with `WorkbookEnv::read_cell`'s `#REF!`
**Agent C finding.** H6 was closed at the evaluator layer (`env.rs:38-51`). But `Workbook::read` (`workbook.rs:260-265`) — the public storage read API — still maps missing-sheet to `Blank`. Production formula eval correctly returns `#REF!`; direct public read returns the silent fallback.

**Fix**: align `Workbook::read` with `WorkbookEnv::read_cell` (return `Value::Error(ErrorValue::Ref)` for missing sheet). Or add a `// CAUTION` doc that the storage API is "trusted callers only."

### M3 — `0^-n` returns `#NUM!`, should be `#DIV/0!` (companion to M3 closure)
**Agent A finding.** `eval_arithmetic` Pow arm catches `0^0`. But `0^-1` produces Rust `+Inf` → `sanitize_f64` → `#NUM!`. Excel canon: `=0^-1 = #DIV/0!` (because `0^-n = 1/0^n`).

**Fix**: add `if lhs_num == 0.0 && rhs_num < 0.0 { return Error(DivZero); }` before the `0^0` check.

### M4 — Concurrent loader race: two simultaneous loads, one orphan → second load fails with `Io(NotFound)`
**Codex finding.** Two loaders see one `.bak-*` orphan, both attempt `rename(bak, target)` in rollback. One wins, the other fails with `Io(NotFound)` at line 655 — even though the rollback succeeded.

**Fix**: after `rename` failure in rollback, re-check `target_envelope_is_valid(target)`; if valid and bak is gone, proceed.

### M5 — Step-3 save rollback failure: backup-restore failure only `eprintln!`s; returned error is the original temp-rename error
**Codex finding.** If step-3 `rename(temp, path)` fails AND the rollback `rename(bak, path)` also fails, the user gets the temp-rename error, with a stderr warning about the bak left orphaned. The "your workbook is now unavailable" fact is buried in stderr.

**Fix**: add `QbookError::AtomicSaveRollbackFailed { install: Error, restore: Error, backup: PathBuf }`. The user sees the compound failure mode.

### M6 — Multi-orphan deadlock: legitimate retries of step-4-failed saves accumulate `.bak-*` siblings, eventually refusing all loads
**Agent A finding.** If step 4 cleanup fails silently (transient permission glitch, virus scanner, network mount flake), the user retries save → new suffix → new `.bak-` orphan. Two orphans → recovery refuses to load via `InvalidPath`. Permanent deadlock.

**Fix**: on save success at step 4, also clean up ANY other `.bak-*` siblings (target is valid, so they MUST be stale). Or: relax "rule of recency" — when multiple orphans + valid target, clean all.

### M7 — `NamedTargetWire::Constant { value: Pending }` conflates "named-Blank constant" with "formula-pending"
**Agent A finding.** Save path emits `Pending` for `NamedTarget::Constant(Value::Blank)` (via `from_value` returning None → unwrap_or Pending). Load round-trips Pending back to Blank correctly today, but the wire format provides no semantic distinction between "intentionally Blank named constant" and "formula-bearing cell not yet evaluated." Any future change to Pending semantics breaks the named-constant case.

**Fix**: add `CellWireValue::Blank` as a distinct wire variant, OR refuse to serialize `NamedTarget::Constant(Blank)` outright (degenerate case).

### M8 — `lower.rs` Phase-marker rewrite is incomplete: `(Div, Number, CellRef)` falls into catch-all but doc claims "Div is intentionally NOT lowered"
**Agent B finding.** classify has explicit `(Div, CellRef, Number)` and `(Div, CellRef, CellRef)` arms returning NotApplicable, but `(Div, Number, CellRef)` (e.g., `=2/A`) falls into the catch-all. Functionally correct; doc-wise asymmetric.

**Fix**: either add the `(Div, Number, CellRef) => NotApplicable` arm for symmetry, OR update the doc to mention the catch-all is where `=2/A` lands.

### M9 — `SimdShape::DivScalar` + `DivArray` + `simd::div_array` are dead code post-H5
**Agent A finding.** classify no longer emits Div shapes. The kernel is reachable only via direct `dispatch(&SimdShape::DivScalar, ...)` calls in tests. The `multiversion` codegen path instantiates the kernel anyway — extra binary size for no benefit.

**Fix**: delete `SimdShape::DivScalar`, `DivArray`, and `simd::div_array`. Update the one remaining test that constructs them directly.

### M10 — `Workbook::put_formula` invariant undocumented re: sheet-id validity over time
**Agent A finding.** `recompute_all`'s direct `put_at` bypasses `validate_cell`. Sheet IDs in `formula_cells` are populated via `put_formula`, which doesn't validate. In practice safe today (no `remove_sheet` API), but the assumption is undocumented.

**Fix**: document the "sheets are append-only at storage layer; formula_cells sheet IDs stay valid for the workbook's lifetime" invariant on `Workbook`. Or: add `validate_cell` to the `recompute_all` loop as defense-in-depth.

---

## LOW (6)

- **L1**: `eprintln!` should be `tracing::warn!` for library-level recovery/save anomalies (Codex). Wait for `tracing` to be wired into the engine; current `eprintln!` is acceptable for now.
- **L2**: SipHash24 seed `(0, 0)` is fine for fingerprint use; doc-improve to named domain constants `QL_FORMULA_FP_V1_K0/K1` for future cache-migration clarity (Codex + Agent A).
- **L3**: `siphasher` and `thiserror` not in `scripts/check-cargo-lock-pins.sh` watch list (Agent B).
- **L4**: `siphasher` pinned at `=1.0.1`; latest is `1.0.3`. Bump or document why pinning at 1.0.1 (Agent B).
- **L5**: `Workbook::read` storage-layer doc should carry `// CAUTION` comment noting H6 layering (Agent A).
- **L6**: `compare_values_excel` missing `Blank vs Bool` test (Agent A + B). One test, ~5 lines.
- **L7**: `save_session_suffix_is_distinct_per_call` test relies on `sleep(1ns)` which is platform-dependent; minor flake risk on coarse-clock OSes (Agent C).
- **L8**: `load_rejects_unknown_envelope_field` only tests envelope-level; not SheetEnvelope/CellRecord/NamedEntry rejection. Add 3 sibling tests (Agent C).
- **L9**: ql-io missing `pub use` for `NamesSection`, `NamedEntry`, `NamedTargetWire`. `MIN_SUPPORTED_SCHEMA_VERSION` not `pub` (Agent C).
- **L10**: `RuntimeError` inconsistent `From` impls (Parse via `#[from]`, Lex/Bind via manual `impl From`) (Agent C).
- **L11**: A6 numacc3 test is partly circular — constructs synthetic data whose moments are by construction. Should be renamed (Agent C). Three agents agree.

---

## DOC (4)

- **D1**: `scalar.rs` module header (lines 12, 27-28) still says "Phase 0 just handles same-type Number comparisons; mixed-type lands in W4-4" — WS-2 already shipped Excel-canon `compare_values_excel`. **Stale.** (Agent B)
- **D2**: `docs/phase2/exit-packet.md` lists already-closed items as still-open: NameTable persistence (CLOSED 2A.8/M12), 10k-op stress (CLOSED 2A.12/L6). Status still says "GO for Phase 2A.3" even though 2A.7-.12 shipped after. **Stale across 5 commits.** (Agent C)
- **D3**: `docs/phase2/entry-plan.md` still claims HEAD = `3717bc6b167`, 659 tests, last shipped item is 2A.6. **Stale across 6 commits.** (Agent C)
- **D4**: Memory file `current_work.md` still claims HEAD = `3717bc6b167`. Lists 2A.6 as latest item. **Stale across 7 commits.** (Agent C)
- **D5**: `simd.rs:114-118` `div_array` doc claims "production caller post-sanitizes via sanitize_f64" — no longer true after H5 routed Div to scalar (Agent A + C).
- **D6**: Megaudit doc `2026-05-12-megaudit.md` doesn't have a closing-summary section with the close-state of every H/M item. Easy to scan inline but no top-line "12/16 closed" sentinel (Agent C).

---

## Categories clean

- **No new fallback patterns** introduced in closure-cycle code. Every `unwrap_or` / `.ok()` traced is legitimate.
- **No new tests pinning buggy behavior**. `div_array_passes_through_inf_for_div_by_zero` is a kernel-level test, kernel now unreachable from production.
- **Phase 0 A2/A4/A5/A7 + OG-02/OG-04 hot paths**: unchanged. `mul_scalar` still has `multiversion` aarch64+neon, `classify` still routes `=A*2` to `MulScalar`.
- **CORR-23 iterative Tarjan**: no recursion introduced. 2A.7 `.expect(...)` swap was fallback removal.
- **OG-05/OG-06 formula persistence**: schema v2 bumped, v1 fixtures still load.
- **AI() reservation (CORR-06)**: function-call sentinel intact, NameRef path now refuses registration.
- **API surface ergonomics** for the new public types: mostly fine; CC-M1/L9 (ql-io re-exports) is the only active gap.

---

## Fix sequencing recommendation

Three categories. Sequence within each by impact, across categories by priority.

### Category A — Real bugs (HIGH/MEDIUM correctness)

1. **H4** v1→v2 `#NULL!` corruption — `eprintln!` migration count. ~5 min. Real user-data risk.
2. **H2** `Workbook::put_formula` row/col validation. ~15 min. Defense-in-depth.
3. **H1** recovery marker file. ~30 min. Prevents nuking user-created backups.
4. **H5** `path.exists() && !path.is_dir()` pre-check. ~5 min.
5. **H3** golden fingerprint coverage extension. ~30 min mechanical.
6. **M1** `{1:?}` → `{1}` on ErrorValue. 1 character.
7. **M3** `0^-n` → #DIV/0! companion. ~5 min.
8. **M2** `Workbook::read` align with WorkbookEnv. ~15 min OR doc CAUTION.
9. **M5** `AtomicSaveRollbackFailed` compound error. ~10 min.
10. **M4** Concurrent rollback re-check. ~10 min.
11. **M6** Multi-orphan cleanup on save success. ~10 min.
12. **M9** Delete dead `DivScalar`/`DivArray` kernels. ~15 min.

### Category B — Documentation / memory hygiene

These are P0 for next-session handoff per CLAUDE.md global instructions.

13. **D4** Rewrite `current_work.md` to reflect HEAD `2487833540e`. ~10 min.
14. **D2 + D3** Update `docs/phase2/{exit-packet,entry-plan}.md` to reflect 2A.7-.12 closure. ~30 min combined.
15. **D1** Sync `scalar.rs` module header with shipped Excel-canon. ~5 min.
16. **D5** Update `simd.rs` `div_array` doc. ~5 min.
17. **D6** Megaudit doc closing summary. ~10 min.

### Category C — LOW polish

The L1-L11 items can ship as a single LOW/DOC cleanup commit. ~1 hour total.

**Total Category A + B**: ~3 hours focused work. Right size for a single Phase 2A.13 commit.

---

## Phase 2A status post-cycle-3

- **Closed across 2A.7-.12 + cycle-3 reverification**: H1, H2, H3, H5, H6 (mostly), M1, M2, M3, M6, M11, M12, M13, M14, M15 (with caveat), M16 — 14 of 16 megaudit H/M items.
- **Still deferred (by design, Phase 4+)**: H4 (recompute topological order), M7 (IFERROR lazy).
- **Net-new from cycle 3 audit**: 5 HIGH + 10 MEDIUM + 11 LOW + 6 DOC items.

Phase 2A is NOT done. The closure-cycle work was substantive but the audit doc / exit packet / memory file were never re-synced, the storage-layer/eval-layer H6 split was not fully closed, golden test coverage is half-armed, and the v1→v2 migration has a real user-data corruption risk.

**Recommendation**: ship Category A + B as Phase 2A.13 (~3 hours), then declare Phase 2A done and open Phase 2B with the calcgraph-integration items (H4, the deferred backlog).
