# 6.1B inc.2 `WorkbookSession` — parallel audit synthesis (2026-05-27)

**Target:** `crates/ql-exec/src/session.rs` (`WorkbookSession impl EngineSession`),
the shipped inc.2a/2b/2c-1/2c-2 + tombstone-read audit-fix surface.
**Contract:** `docs/api/session-api.md` v2.
**Lanes:** Codex `gpt-5.5` xhigh read-only (`.codex-6-1b-inc2-session-audit.out`,
verdict: 4 HIGH / 5 MED) + Opus reviewer agent (2 MED / 3 LOW) + claude-self
synthesis (every finding re-verified at source before disposition).

The two lanes **converge** on the same defects; they differ only in severity
labelling. Every finding below was confirmed by opening the cited source.

---

## Consolidated findings (9 distinct; ordered by disposition)

### A. Resolved by the snapshot_delta design (inc.2c-3) — NOT a standalone patch

**F1 — Version token is not a state token.** *(Codex HIGH `session.rs:270`; Opus
"confirmed gating".)* `current_version()` = `{epoch, oplog.len()}`. `recompute_*`
write computed dependents via `put_computed_at` and append **no** ops
(`recompute.rs:168/344/445/610`), so a `snapshot()` before vs after `recalc_dirty`
stamps an **identical token onto different visible state**. VERIFIED. → Resolved by
introducing a monotonic `state_seq` (see Decision 1).

**F2 — `set_value(addr, Blank)` mutates without advancing the token.** *(Codex HIGH
`cells.rs:779`; Opus LOW-2.)* `CellValue::Blank → Value::Blank`; `CellWireValue::
from_value(Blank) → None` (`wire.rs:103`), so a Blank write to a **non-formula**
cell appends no op (`cells.rs:807`, `len()==0` arm) yet `put_at`+`clear_formula`
mutate (`cells.rs:864-865`). VERIFIED. Two halves:
  - **Token half** → resolved by `state_seq` + explicit change-log recording (the
    log records the edited coord directly, not via op-walk).
  - **Durability half** (replay can't reproduce the clear) is the explicitly
    *pre-existing*, documented Phase-2A.3.b runtime limitation (`cells.rs:781-786`;
    wire-format Blank expansion deferred to "Phase 5+"). It becomes user-visible
    only once persistence (save/load) lands → **tracked to the persistence
    increment** (emit a value-clear op or wire-encode Blank). Documented loudly,
    not silently masked.

### B. FIX NOW — in-scope `session.rs` audit closures (this session's audit-fix commit)

**F3 — `with_runtime`/`run_recalc` not panic-safe for session integrity.** *(Codex
HIGH `session.rs:164`; Opus MED-1.)* `with_runtime` `mem::take`s the plan cache,
runs the closure, restores it only on the normal return path (`:165/:174`). A panic
in a recalc closure leaves `state == Busy` **forever** (`:289` set, `:311` never
reached) and the op stuck `Running`; the cache is also lost. Contract §8 says a
mutating-command panic → `Faulted` (in the binding shim, not yet wired). Recompute
kernels have reachable `.expect`/`panic!` (`recompute.rs:845`, `cells.rs:844`). Not
memory-unsound, but state-integrity-unsound. **Fix:** a drop-guard in `run_recalc`/
`with_runtime` that, on unwind, transitions the session to `Faulted` (never silently
`Ready`) before the panic propagates. VERIFIED.

**F4 — Read paths accept bad-but-type-valid coordinates (overflow + Excel bounds).**
*(Codex MED `session.rs:656`.)* `query_range` validates only ordering, then computes
`end_row - start_row + 1` in `u32` — `end_row = u32::MAX` overflows (debug panic /
release wrap) **before** the `MAX_CELLS` cap. None of `query_range`/`cell`/
`validate_formula` reject coordinates past `MAX_ROW=1_048_575` / `MAX_COLUMN=16_383`
(`ql-types/address.rs:20-31`); `Sheet::read` returns `Blank` OOB. Contract §8 =
validate at the boundary. **Fix:** shared `validate_range`/`validate_addr` with
checked arithmetic + Excel-bound checks → `BadArgument`. VERIFIED (the overflow is a
real §8 panic-on-bad-input path).

**F5 — Tombstone no-ops still append ops and advance the token.** *(Codex MED
`session.rs:508`; Opus LOW-1.)* `delete_sheet` on an already-tombstoned (but known)
id passes `require_sheet_exists`, appends a **spurious** `Op::RemoveSheet`, advances
the token, while `workbook.remove_sheet` no-ops. Same for `restore_sheet` on a live
sheet (`Op::RestoreSheet`) and `move_sheet` to the same index. The `:511` docstring
("idempotent no-op") is false at the op-log/token level. **Fix:** pre-check
`is_sheet_removed`: delete only a live sheet, restore only a tombstoned one — true
no-op (no append, no token advance) otherwise. VERIFIED.

**F6 — Deleted sheets remain structurally editable (rename + table ops).** *(Codex
MED `session.rs:502`; Opus MED-2.)* `rename_sheet` and `create_table` (and the
sheet-targeting table ops) do **not** gate on `require_live_sheet`. `create_table`'s
only check is `workbook.sheet(sheet).is_some()` (`tables.rs:77`), and a tombstoned
sheet still returns `Some` — so you can rename or create a table on a deleted sheet,
re-opening the exact inconsistency `require_live_sheet` was added to close. **Fix:**
`require_live_sheet` in `rename_sheet` + `create_table`. VERIFIED.

**F7 — `query_range` silently ignores requested include options.** *(Codex MED
`session.rs:656`.)* `RangeQueryOptions{include_formulas,include_formats,
include_rendered}` exist (`dto.rs:306-315`) and the contract says inclusion is
option-driven (§4.2), but the impl names the param `_options` and always returns
values-only. Silently serving a narrower result than requested **is a silent
fallback** (No-Fallbacks). **Fix:** if any `include_*` flag is set, return
`Capability/not_implemented_in_v1_core` (honest "not yet"). VERIFIED.

### C. DOCUMENT / amend (no behavior change)

**F8 — Error mapping is exhaustive but not Appendix-A-accurate.** *(Codex MED
`session.rs:1026`; Opus LOW-3.)* `map_runtime_err` is compile-exhaustive (good), but:
(a) `InvalidSheet → NotFound/sheet_not_found` uniformly, vs Appendix A's
NotFound-vs-BadArgument split — but `RuntimeError::InvalidSheet{sheet,sheet_count}`
carries **no producer context**, and the "FFI arg coercion → BadArgument" case is
caught at the binding boundary and never produces this variant, so the uniform
NotFound is correct at this layer; (b) `TableCreateRejected → Conflict` uniformly vs
dup-name-vs-bad-spec split — the variant carries only a `reason: &'static str`;
(c) `map_oplog_err` has a `_ => unmapped_oplog_error` wildcard, but `OpLogError` is
`#[non_exhaustive]` (foreign) so a wildcard is *required* by Rust, and it maps to a
**coded** `Internal` (not a generic `qbook_unknown`) — No-Fallbacks-compliant.
**Disposition:** amend Appendix A to record these honest constraints; optionally
split `TableCreateRejected` (zero-dim → `BadArgument/bad_table_spec`; dup-name →
`Conflict/table_exists`) since that one is user-visible and classifiable. VERIFIED.

**F9 — Formula bind/eval still sees tombstoned sheets.** *(Codex MED `session.rs:502`
part c.)* Storage keeps tombstoned sheets reachable; sheet-name resolution + eval
env do not filter tombstones (`workbook.rs:500-507`, `env.rs:168-181/408-410`), so a
formula referencing a deleted sheet still reads its preserved cells (no `#REF!`).
This is the **locked V3.5.0.3b decision** (`Op::RemoveSheet` doc: "formula text left
intact, no #REF! substitution; V3.6+ may add it") and matches the v1.5 `#REF!`
backlog (D7). **Disposition:** document as deliberate v1 product semantics (deleted
sheets remain formula-readable until `#REF!` lands in v1.5). No change. VERIFIED.

### D. PRE-EXISTING runtime defect, outside session.rs — DECISION NEEDED (see Decision 2)

**F10 — Table rename/rename_column ops are not append-before-mutate atomic.** *(Codex
HIGH `tables.rs:307`.)* `rename_table` appends `RenameTable`, then **interleaves**
`oplog.append(PutFormula)` (`:335`) with `put_formula` mutation (`:345`) inside the
rewrite loop, so a mid-loop append failure leaves a partial log + partially-rewritten
workbook — contradicting the `:304-306` "no workbook state has changed yet" comment.
`rename_column` has the same shape (`:446-482`). VERIFIED. **Reachability is
near-zero**: `PutFormula` serializes a `String` (no NaN/Inf serde failure path); only
a Loro-internal failure (OOM/corruption) triggers it. It is **pre-existing** (Phase
4.8 / W5-103 / V2-H1), in the wrapped runtime, not introduced by inc.2; the session
correctly surfaces the error to the caller. **Fix** = collect all rewrite ops first,
emit one `Op::BatchCommit` before any `put_formula` (mirroring `rename_sheet`,
`sheets.rs:175-205`). → Decision 2 (fold in now vs track as a follow-up).

---

## Confirmed sound (both lanes, verified)
- `query_range`'s `.expect` after `require_live_sheet` is unreachable on bad input —
  sheet ids are dense (`workbook.rs:713-734`: `id < sheet_count() ⇒ sheet(id).is_some()`).
- `set_value` clears a prior formula (`cells.rs:864-865`; storage clears computed at
  `workbook.rs:1050-1066`). Contract §3.2 ✓.
- `map_runtime_err` exhaustive over all 20 named `RuntimeError` variants + `OpLog`
  delegation, no wildcard → new variant = compile error (§5.3 ✓).
- `run_recalc` pushes `CellDiagnostic` events **before** `OperationCompleted` (§9
  ordering ✓). `ops`/`events` unbounded growth is the documented v1 limitation only.
- `mark_volatiles_dirty` correctly outside Busy/op-registry (marks graph dirty, no
  cell mutation / recompute).
- `snapshot`/`populated_coords` complete for every inc.2-constructible session (writes
  go through overlays; Arrow base chunks are import-only).
- Lifecycle gating (`ensure_ready`/`ensure_readable`), unknown-op-id `NotFound`,
  cursor-past-end, and all deferred methods returning loud `Capability` errors — sound.

**Net:** no reachable memory-unsoundness. The substantive items are F1/F2 (token →
the snapshot_delta design) and F3 (panic→Faulted). F4-F7 are bounded in-scope
hardening. F8/F9 are doc amendments. F10 is a pre-existing, near-unreachable runtime
atomicity gap pending a fold-in-vs-track decision.
