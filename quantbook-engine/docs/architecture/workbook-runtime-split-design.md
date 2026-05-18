---
title: WorkbookRuntime split design
status: DRAFT — design awaiting user sign-off
phase: Tier D1 (Phase 5 prep)
date: 2026-05-18
predecessor: docs/phase5/entry-plan.md § Tier D
backlog: docs/PHASE-4-V2-BACKLOG.md § D1
audit_source: Phase 4.12 megaudit Opus-C HIGH-2
---

# WorkbookRuntime split — design

## Current state

`crates/ql-exec/src/workbook_runtime.rs` is **12 725 LOC**: 3 585
LOC of implementation + 9 140 LOC of inline tests. The `impl<'a>
WorkbookRuntime<'a>` block holds **39 public + private methods**
covering 7 distinct concern areas. The test section runs **306
tests** in one flat module.

The monolith is the largest single file in the engine. It has
grown organically across Phases 1, 2A.*, 2B.*, 3.*, 4.5-4.8.
Phase 4.12 megaudit Opus-C HIGH-2 flagged it as a Phase 5 prep
blocker — adding CRDT-aware mutation paths in Phase 5 will
roughly double the call sites in cell-mutation methods, and a
13 000+ LOC file alongside single-writer paths is hard to review.

## Pain points (concrete)

1. **Reviewer load**: opening `workbook_runtime.rs` in any editor
   pages a 12 725-line file. Diff review for any mutation-method
   change wades through unrelated table / sheet / format code.
2. **Concern boundaries are implicit**: there's no module-level
   structure separating "cell mutation" from "table mutation"
   from "recompute pipeline" from "format API". A new
   contributor reading `set_formula` (lines 540–957, 417 LOC of
   one function) has no signpost telling them this is the
   cell-mutation surface, not the format surface.
3. **Test-file growth dominates**: 9 140 LOC of tests
   (~72 % of the file) means a 1-LOC impl change scrolls past
   thousands of test lines in `git blame`.
4. **Phase 5 prep**: Phase 5 will add CRDT-aware versions of
   the four cell-mutation hooks (`set_formula`, `set_value`,
   `clear_formula`, `transaction`) plus presence + undo group
   methods. Without a split, those land in the same file and
   push it past 15 000 LOC.

## Proposed split — submodules of `crate::workbook_runtime`

Move the file `src/workbook_runtime.rs` to `src/workbook_runtime/mod.rs`,
then move method groups into sibling submodules. The `WorkbookRuntime`
struct itself + its 4 constructors stay in `mod.rs`. Each submodule
declares an `impl<'a> WorkbookRuntime<'a> { ... }` block adding
methods to the same struct.

### Module layout

| Module | LOC est. | Contents |
|---|---|---|
| `mod.rs` (core) | ~200 | `WorkbookRuntime` struct, 4 constructors, `cache_stats`, struct docs |
| `error.rs` | ~270 | `RuntimeError`, `RecomputeFailure`, `RecomputeResult`, `is_complete`, `failed_count`, `From<LexError>`, `From<BindError>`, `validate_sheet` helper |
| `cells.rs` | ~1 060 | `set_formula`, `set_value`, `clear_formula`, `write_spill`, `write_anchor_error`, `reextract_spill_footprint_readers` |
| `names.rs` | ~140 | `set_name`, `set_sheet_scoped_name` |
| `tables.rs` | ~810 | `create_table`, `drop_table`, `rename_table`, `rename_column`, `resize_table`, `reextract_table_readers` |
| `sheets.rs` | ~165 | `add_sheet`, `rename_sheet` |
| `formats.rs` | ~150 | `intern_format`, `set_cell_format`, `read_display` |
| `config.rs` | ~40 | `set_reference_mode`, `set_locale` |
| `recompute.rs` | ~780 | `recompute_all`, `recompute_dirty`, `try_recompute_one_cached`, `try_recompute_with_aggregate_cache`, `try_recompute_with_simd_profile` |
| `validate.rs` | ~100 | `validate_formula`, `transaction` |

Total impl: ~3 715 LOC across 10 files. Average submodule size
~370 LOC — review-friendly.

### Tests

**Phase 1 — split tests alongside their impl module.** Each
submodule gets its own `#[cfg(test)] mod tests`. Test partitions
already aligned with section banners in the current file (e.g.
"===== Phase 2A.3.b — op-log producer wiring =====" already
separates op-log tests; "===== W5-118 (Phase 4.8.H) — table
mutation API =====" already separates table tests).

Test categorization plan (preliminary mapping, refined during
the mechanical pass):

| Test cluster | LOC | Destination |
|---|---|---|
| set_formula | ~145 | `cells.rs::tests` |
| set_value | ~250 | `cells.rs::tests` |
| recompute_all | ~810 (12 sections) | `recompute.rs::tests` |
| Named-range resolution (Phase 2A.1) | ~210 | `names.rs::tests` |
| Op-log producer wiring (2A.3.b) | ~290 | `cells.rs::tests` (op-log integration tested via cells) |
| RecomputeResult contract (2B.2) | ~135 | `recompute.rs::tests` |
| Bind-plan cache (2B.3) | ~160 | `recompute.rs::tests` |
| Named-range aggregate prep (2B.4) | ~140 | `recompute.rs::tests` |
| Input validation + dry-run (2B.7) | ~560 | `cells.rs::tests` + `validate.rs::tests` |
| Op-log producer coverage (2B.5) | ~270 | `cells.rs::tests` |
| Calcgraph runtime integration (3.1) | ~1 540 | `recompute.rs::tests` + `cells.rs::tests` (mostly recompute hooks) |
| Format runtime wrappers (W5-82+) | ~410 | `formats.rs::tests` |
| Cross-sheet (W5-90) | ~85 | `cells.rs::tests` (cross-sheet refs in set_formula) |
| rename_sheet (W5-91) | ~100 | `sheets.rs::tests` |
| set_sheet_scoped_name (W5-92) | ~100 | `names.rs::tests` |
| Spill writeback (W5-103.*) | ~1 800 | `cells.rs::tests` |
| W5-103 megaudit closures | ~330 | `cells.rs::tests` |
| set_value spill invalidation (W5-104) | ~165 | `cells.rs::tests` |
| SEQUENCE / TRANSPOSE / FILTER / array shape (W5-106/107/N) | ~600 | `cells.rs::tests` |
| structured-ref through aggregate (W5-116) | ~145 | `tables.rs::tests` |
| create_table / drop_table (W5-118) | ~35 | `tables.rs::tests` |
| spill-anchor uniform check (W5-124) | ~100 | `cells.rs::tests` |
| footprint-bounds (W5-125) | ~340 | `cells.rs::tests` |
| rename_table / rename_column / resize_table (W5-119/121/122) | ~1 050 | `tables.rs::tests` |
| Tier C1 cycle detection (this session) | ~215 | `recompute.rs::tests` |

**Phase 2 (deferred)**: if any submodule's `tests` block exceeds
~2 000 LOC after the split, consider further sub-splitting per
test cluster.

### Submodule contract

Each submodule (`cells.rs`, `tables.rs`, etc.) imports nothing
new. The `impl<'a> WorkbookRuntime<'a>` block adds methods to
the same struct; access to private fields (`self.workbook`,
`self.oplog`, `self.plan_cache`, `self.graph`, `self.format_cache`)
is granted by sibling-module visibility within
`crate::workbook_runtime`.

Public API surface (`pub use workbook_runtime::WorkbookRuntime`
from `crates/ql-exec/src/lib.rs`) is unchanged. Existing callers
(test code, replay, loader, bindings) require zero edits.

## Migration plan

Mechanical, no behavior change. One PR per module to keep the
diff reviewable.

### Step 1 — extract `error.rs`

Move `RuntimeError`, `RecomputeFailure`, `RecomputeResult` +
their `impl` blocks + `From<LexError>` / `From<BindError>`. Re-
export from `mod.rs` so `pub use workbook_runtime::{RuntimeError,
RecomputeFailure, RecomputeResult}` continues to work.

Risk: low. Self-contained types.

Verification: `cargo test --workspace` green; no diff in
`cargo doc --workspace --no-deps` for the public surface.

### Step 2 — convert single file to module directory

Rename `src/workbook_runtime.rs` to `src/workbook_runtime/mod.rs`.
Tests stay inline in `mod.rs` initially. Verify build green.

Risk: low. Filesystem-level rename.

### Step 3 — extract submodules one at a time

Order, ranked by independence (least-coupled first):

1. **`formats.rs`** (~150 LOC, 3 methods). Touches only
   `self.workbook.formats()` + `self.format_cache`. Very
   contained.
2. **`config.rs`** (~40 LOC, 2 methods). Touches `self.workbook
   .set_reference_mode` + `set_locale`. Smallest.
3. **`sheets.rs`** (~165 LOC, 2 methods).
4. **`names.rs`** (~140 LOC, 2 methods).
5. **`tables.rs`** (~810 LOC, 6 methods). Larger but
   self-contained.
6. **`recompute.rs`** (~780 LOC, 5 methods). Touches plan_cache
   + graph hooks but is read-mostly w.r.t. workbook state
   (writes via `put_computed_at` + `clear_spill_if_present`).
7. **`cells.rs`** (~1 060 LOC, 6 methods). The cell-mutation
   core; largest and most-touched. Last so it absorbs the
   experience from prior moves.
8. **`validate.rs`** (~100 LOC, 2 methods). Final cleanup.

Each step:
1. Move method bodies + their `#[cfg(test)] mod` test cluster
   into the new submodule.
2. Add `mod <name>;` to `mod.rs`.
3. Run `cargo build --workspace` + `cargo test --workspace` —
   expect zero changes in pass / fail count.
4. Run `cargo fmt --all` + `cargo clippy --workspace
   --all-targets -- -D warnings`.
5. Commit. One commit per submodule move.

### Step 4 — final cleanup

After step 3:
1. `mod.rs` should be ~200 LOC (struct, constructors,
   `cache_stats`, module doc, sub-mod declarations).
2. Update `crates/ql-exec/src/lib.rs` `pub use` and any
   docstring references.
3. Update `crates/ql-exec/src/lib.rs` # Stability section to
   reference the new module structure.
4. Refresh `docs/MASTER-PLAN.md` § Phase 5 prep to mark D1 done.

## Risks + mitigations

- **R1 — Test-suite regression hidden by HashMap order.** Some
  recompute tests rely on incidental ordering. Mitigation:
  before each step, snapshot `cargo test --workspace 2>&1 |
  grep "test result"` output; verify per-test counts match
  exactly before and after each move.
- **R2 — Cross-module borrow-checker friction.** Splitting
  long methods that share private state (e.g.
  `set_formula → write_spill → reextract_spill_footprint_readers`)
  may surface borrow-checker issues that the single-file form
  hid. Mitigation: each submodule's `impl` adds methods to the
  same struct — no new visibility boundaries. If borrow issues
  arise, the fix is usually a `let _ = &mut self.field;`
  reborrow pattern.
- **R3 — Doc-comment links break.** Some `[`fn_name`]` doc
  links inside `workbook_runtime.rs` may break when the target
  moves to a sibling submodule. Mitigation: `cargo doc
  --workspace --no-deps` runs after each step; any warning
  surfaces the broken link.
- **R4 — Test-cluster mis-categorization.** A test that touches
  multiple concern areas (e.g. cell-mutation triggering a
  table-readers reextract) might fit two destinations. Default:
  keep with the method-under-test's submodule; cross-reference
  in a comment.

## Effort estimate

- Step 1 (error.rs): 1-2 hours.
- Step 2 (file → module dir): 30 minutes.
- Step 3 (8 submodule moves): 0.5-1 day each = 4-8 days total.
  Larger modules (`cells.rs`, `tables.rs`, `recompute.rs`) take
  the upper bound; smaller (`config.rs`, `formats.rs`,
  `sheets.rs`) the lower.
- Step 4 (final cleanup): 1 hour.

**Total: 5-10 days** of mechanical work + audit cycles.

## Acceptance

After D1 closure:
- `crates/ql-exec/src/workbook_runtime/mod.rs` is ≤ 250 LOC.
- No submodule exceeds ~1 200 LOC (impl + tests).
- `cargo test --workspace` passes exactly the same test count
  as pre-split (4 141 today).
- `cargo doc --workspace --no-deps` warning count unchanged.
- Public API surface byte-for-byte identical (verify with
  `cargo public-api` or equivalent if available).

## Audit checkpoint

Run a parallel Codex + separate-Opus audit AFTER step 3 (all
submodules moved). Focus areas:
- Did any test move land in the wrong submodule?
- Are there cross-module circular dependencies?
- Did borrow-checker fixes introduce subtle aliasing?
- Are the module-level doc comments coherent across the
  surface?

## Out of scope for D1

- Renaming `WorkbookRuntime` itself.
- Changing `WorkbookRuntime`'s public API.
- Adding new methods.
- Refactoring `set_formula`'s 417-LOC body internally (that's
  its own followup).
- Migrating off the lifetime-borrow pattern toward owned state.
  Phase 5.1 / 5.2 will revisit this.
- Replacing the inline test module with separate `tests/`
  integration tests (different concern, separate cycle).
