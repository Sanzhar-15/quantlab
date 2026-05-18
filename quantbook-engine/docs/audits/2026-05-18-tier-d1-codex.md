Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e3d21-d577-7f41-ba3e-abb84eb14726
--------
user
Audit the full Tier D1 WorkbookRuntime split at branch `feat/quantbook-engine` in repo `~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Commit range: `2e8566e35f0..118b4be1611` (10 commits — 1 design doc + 8 method extractions + 1 final cleanup).

## Context

The pre-split monolith was `crates/ql-exec/src/workbook_runtime.rs` at 12,725 LOC. Phase 4.12 megaudit Opus-C HIGH-2 flagged it as a Phase 5 prep blocker (CRDT-aware mutation paths in Phase 5 would roughly double the call sites in cell-mutation methods, making review impractical).

The split converted it to a module directory at `crates/ql-exec/src/workbook_runtime/` with 9 sibling submodules:
- `mod.rs` (299 LOC) — struct + 4 constructors + cache_stats + validate_sheet/validate_cell helpers
- `error.rs` (283 LOC) — RuntimeError + RecomputeFailure + RecomputeResult
- `cells.rs` (5,131 LOC) — set_formula + set_value + clear_formula + 3 spill helpers
- `recompute.rs` (3,152 LOC) — recompute_all + recompute_dirty + 3 helpers
- `tables.rs` (2,199 LOC) — 6 table methods + reextract_table_readers
- `validate.rs` (719 LOC) — validate_formula + transaction
- `names.rs` (495 LOC) — set_name + set_sheet_scoped_name
- `formats.rs` (424 LOC) — intern_format + set_cell_format + read_display
- `sheets.rs` (384 LOC) — add_sheet + rename_sheet + rewrite helper
- `config.rs` (143 LOC) — set_reference_mode + set_locale

Each submodule adds an `impl<'a> WorkbookRuntime<'a>` block via the sibling-module impl pattern. Public API surface unchanged.

## Files to read

- `docs/architecture/workbook-runtime-split-design.md` (the design)
- `crates/ql-exec/src/workbook_runtime/mod.rs` (post-split skeleton)
- All 9 sibling submodules in `crates/ql-exec/src/workbook_runtime/`
- `crates/ql-exec/src/lib.rs` (Module layout section)
- `docs/PHASE-4-V2-BACKLOG.md` § D1 (closure entry)

## Focus areas — list HIGH/MEDIUM/LOW findings with file:line

1. **Cross-module visibility correctness.** Are there private methods that should be `pub(super)`? The Step 3.7 commit raised `write_spill` to `pub(super)` because `recompute.rs::try_recompute_with_simd_profile` calls it. Are there other cases? Look for `fn ` (without `pub`) in each submodule and verify whether any are called from a sibling.

2. **Test partitioning correctness.** Every test that was in `workbook_runtime.rs::tests` should now live in EXACTLY ONE submodule's tests module. Are any tests duplicated? Missing? In the wrong submodule? Specifically check:
   - Phase 2B.7 input-validation tests in `validate.rs::tests` — some are actually `add_sheet` tests that would fit `sheets.rs::tests` better. Is this acceptable or should they re-partition?
   - W5-83 / W5-90 tests in `cells.rs::tests` — TEXT() formula integration + cross-sheet evaluation. Are they cell-mutation tests or formula-execution tests?

3. **Doc-comment integrity.** The split exposed two pre-existing misattached doc comments (rename_table doc → set_reference_mode; validate_cell doc → rewrite_formula_text helper). Are there others I missed? Look for `///` blocks that sit between two unrelated functions.

4. **Import minimality across submodules.** Each submodule should import only what it uses. Check for over-imports (clippy `-D warnings` says they're all clean, but check manually for redundancy across submodules).

5. **Test count drift.** `cargo test --workspace` reports 4141 across every commit. But what if some tests moved with a behavior change due to fixture differences? Look for: `make_runtime_workbook` helper is now defined in 8 different submodules (each with its own copy). Verify they all produce equivalent fixtures.

6. **`use crate::workbook_runtime::*` patterns in tests.** Each submodule's `mod tests` re-imports `RuntimeError`, `WorkbookRuntime` etc. Are these imports consistent? Any chance one submodule imports a different type by accident?

7. **`mod.rs` minimality.** The Step 4 acceptance target was ≤ 250 LOC; final is 299 LOC. What's the breakdown? Is anything in mod.rs that could move to a submodule?

8. **Anything else** that an experienced reviewer would flag — naming consistency, doc-comment style, comment cruft, etc.

Output: punch list with severity tag (H/M/L), file:line, problem, recommended fix. Be thorough — list every concern, not just the first few. This is the closure audit for a refactor that touched 12,000+ LOC across 10 commits; the user wants depth.
codex
I’ll treat this as a code-review audit, so I’m going to inspect the split as it exists on the target branch and compare it against the pre-split file from the commit range where needed. I’ll focus first on structural drift: moved tests, private/sibling calls, and comments/imports.
exec
/bin/zsh -lc "rg --files -g 'AGENTS.md' -g '.github/copilot-instructions.md' -g 'docs/architecture/workbook-runtime-split-design.md' -g 'docs/PHASE-4-V2-BACKLOG.md' -g 'crates/ql-exec/src/lib.rs' -g 'crates/ql-exec/src/workbook_runtime/*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
docs/architecture/workbook-runtime-split-design.md
docs/PHASE-4-V2-BACKLOG.md
crates/ql-exec/src/workbook_runtime/names.rs
crates/ql-exec/src/workbook_runtime/validate.rs
crates/ql-exec/src/workbook_runtime/tables.rs
crates/ql-exec/src/workbook_runtime/formats.rs
crates/ql-exec/src/workbook_runtime/recompute.rs
crates/ql-exec/src/workbook_runtime/cells.rs
crates/ql-exec/src/workbook_runtime/mod.rs
crates/ql-exec/src/workbook_runtime/sheets.rs
crates/ql-exec/src/workbook_runtime/config.rs
crates/ql-exec/src/workbook_runtime/error.rs
crates/ql-exec/src/lib.rs

exec
/bin/zsh -lc 'git log --oneline --decorate --max-count=15' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
118b4be1611 (HEAD -> feat/quantbook-engine) Tier D1 Step 4 — final cleanup (Phase 2A.1 partition + handoff updates)
69ede106a61 Tier D1 Step 3.8 — extract WorkbookRuntime validate + transaction API to validate.rs
de7f87c5334 Tier D1 Step 3.7 — extract WorkbookRuntime cell mutation API to cells.rs
c8d4cf95f70 Tier D1 Step 3.6 — extract WorkbookRuntime recompute pipeline to recompute.rs
aa6e37800ff Tier D1 Step 3.5 — extract WorkbookRuntime table API to tables.rs
a48e985c5ec Tier D1 Step 3.4 — extract WorkbookRuntime defined-name API to names.rs
c37c556dd0f Tier D1 Step 3.3 — extract WorkbookRuntime sheet API to sheets.rs
be154f4918d Tier D1 Step 3.2 — extract workbook config setters to config.rs
2761e1f88cf Tier D1 Step 3.1 — extract WorkbookRuntime format API to formats.rs
79c1ebeefa7 Tier D1 Step 1 — extract WorkbookRuntime error/result types to error.rs
2e8566e35f0 Tier D1 design — WorkbookRuntime split (12,725 LOC → 10 submodules)
8137697b5fc Tier C1 audit closures (Codex H-1/H-2 + Opus H-1 + L-1/L-2 polish)
3451d90a03f Tier C1 / Phase 5 prep — cycle detection in recompute_all (Opus-B H-2 closure)
98206ca51dc Tier A — mark SHIPPED in v2 backlog
40bb584a25b Tier A / Phase 5 prep — #[non_exhaustive] pass + deprecated removal + stability docs

exec
/bin/zsh -lc 'git status --short --branch' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 829ms:
## feat/quantbook-engine...origin/feat/quantbook-engine [ahead 271]
?? ../2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? ../2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? ../node_modules
?? .codex/prompts/2026-05-14-AA-design-review.md
?? .codex/prompts/2026-05-14-J-127-verify.md
?? .codex/prompts/2026-05-14-J-128-verify.md
?? .codex/prompts/2026-05-14-J-129-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? .codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? .codex/prompts/2026-05-14-K-verify.md
?? .codex/prompts/2026-05-14-L-verify.md
?? .codex/prompts/2026-05-14-M-verify.md
?? .codex/prompts/2026-05-14-N-verify.md
?? .codex/prompts/2026-05-14-O-closure-verify.md
?? .codex/prompts/2026-05-14-O-megaudit.md
?? .codex/prompts/2026-05-14-phase-4.7.I-review.md
?? .codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? .codex/prompts/2026-05-14-phase-4.7.J-review.md
?? .codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? .codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? .codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? .codex/prompts/2026-05-15-phase-4.9-design-review.md
?? .codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? .plans/
?? 2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
?? docs/audits/.codex-4.10-pre-review-prompt.md
?? docs/audits/.codex-4.8.G.3-megaudit-prompt.md
?? docs/audits/.codex-reference-tier-design-prompt.md
?? docs/audits/.codex-rt-step-1-prompt.md
?? docs/audits/.codex-rt-step-2-prompt.md
?? docs/audits/.codex-rt-step-3-prompt.md
?? docs/audits/.codex-rt-step-4-prompt.md
?? docs/audits/.codex-w5-d-1-prompt.md
?? docs/audits/.codex-w5155-prompt.md
?? docs/audits/.codex-w5170-megaudit-prompt.md
?? docs/audits/2026-05-14-phase-4.7.H-codex-review.txt
?? docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md
?? docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md
?? docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md
?? docs/audits/2026-05-15-phase-4.8-final-reverify-codex.md
?? docs/audits/2026-05-15-phase-4.9-design-review-codex.md
?? docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md
?? docs/audits/2026-05-15-w5155-audit-codex.md

codex
The working tree is on `feat/quantbook-engine` at `118b4be1611`; there are unrelated untracked files outside the target split, so I’ll ignore those and keep the audit read-only. Next I’m pulling the local instructions plus the split docs and module map so the review criteria match the project’s own conventions.
exec
/bin/zsh -lc "sed -n '1,220p' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 1 in 0ms:
sed: .github/copilot-instructions.md: No such file or directory

exec
/bin/zsh -lc "sed -n '1,260p' docs/architecture/workbook-runtime-split-design.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,220p' crates/ql-exec/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'rg -n "D1|WorkbookRuntime|Tier D1|workbook runtime|runtime split" docs/PHASE-4-V2-BACKLOG.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
//! `ql-exec` — Quantbook expression executor.
//!
//! Module map (Phase 0 → Phase 3.10 + Phase 4.3 V1):
//!
//! - `plan.rs` (Phase 0 W4-1; extended Phase 2A.1, 2A.6, 2B.4) — `ExprPlan` IR
//!   including the Phase 2B.4 `AggregateNameRef` variant; `bind` /
//!   `bind_with_names` resolvers with Phase 2B.4 context-aware binding
//!   (`BindContext` + `is_aggregate_function`); `NameLookup` trait;
//!   `BindError` variants including `UnresolvedName`,
//!   `NamedTargetIs{Blank,Error}`, `NamedRangeInScalarContext`,
//!   `NamedFormulaUnsupported`, `UnsupportedVariant`.
//! - `plan_cache.rs` (Phase 2B.3) — bind-plan cache V0 keyed by
//!   (formula text, sheet, NameTable generation); `PlanCache` lives on
//!   `WorkbookRuntime`; `PlanCacheStats` for ql-profile observability.
//! - `env.rs` (Phase 0; extended Phase 3.6 for `read_range`) —
//!   `CellEnv` trait + `WorkbookEnv` / `MapEnv` impls. Phase 3.6
//!   added `read_range(Range) -> Vec<Value>` with WorkbookEnv
//!   override that clamps to `Sheet::bounds` for whole-column
//!   safety. `NameLookup for NameTable` bridge.
//! - `scalar.rs` (Phase 0 W4-1; extended Phase 2A.9, 2B.4, 3.6) —
//!   `eval_scalar` per-cell evaluator with Excel-canon arithmetic,
//!   error propagation, coercion. Phase 3.6 added
//!   `eval_scalar_with_cache` entry point that routes aggregate-
//!   over-named-range calls through an `AggregateCache` for cache-
//!   hit short-circuit. `AggregateNameRef` outside a Function
//!   context returns `#CALC!` defensively (binder normally rejects).
//! - `aggregate_cache.rs` (Phase 3.6 W5-39) — `AggregateCache`
//!   trait + `InMemAggregateCache` (RefCell-backed for `&self`
//!   stores) + `NoAggregateCache` no-op default. Stats counters
//!   (hits, misses, invalidations). Used by `CalcgraphSession`.
//! - `simd.rs` (Phase 0 W4-2/W4-3) — `multiversion`-dispatched SIMD kernels;
//!   OG-02 25M-cell hot path.
//! - `lower.rs` (Phase 0) — `classify` + `dispatch` for the SIMD shape
//!   heuristic.
//! - `workbook_runtime.rs` (Phase 1 W5-10; extended Phase 2A.1, 2A.3.b,
//!   2A.6, 2B.2, 2B.3, 2B.5, 2B.7; Phase 3.4 W5-37 adds
//!   `recompute_dirty`) — `WorkbookRuntime` live-formula facade
//!   wrapping lex → parse → bind → eval → persist + recompute_all.
//!   `RecomputeResult` aggregation (no more short-circuit). Op-log
//!   producer wrappers (`set_name` / `add_sheet` / `clear_formula`)
//!   emit ops when an `OpLog` is attached. Phase 2B.7 added
//!   `validate_formula` for IDE on-keystroke validation and
//!   pre-validation guards on `add_sheet`. Phase 3.4 added
//!   `recompute_dirty()` — runs Tarjan SCC over the attached
//!   session's dirty set; cycled members get
//!   `Value::Error(ErrorValue::Circ)`. `RuntimeError` family includes
//!   `InvalidSheet`, `InvalidCell`, `ConflictingOps`, `OpLog`,
//!   `Name`, `InvalidChunkRows`, `TooManySheets`.
//! - `transaction.rs` (Phase 2A.2; hardened Phase 2A.6, 2A.3.b, 2B.7) —
//!   `WorkbookTransaction` multi-cell batch API with eager validation,
//!   conflict detection. Phase 2B.7 reordered commit to append-first
//!   (BatchCommit appended BEFORE workbook mutations) so a serialization
//!   failure can't leave the workbook divergent from the log.
//! - `loader.rs` (Phase 2A.4; reshaped Phase 2B.2) —
//!   `load_workbook_and_recompute(path, &reg) -> Result<(Workbook,
//!   RecomputeResult), QbookError>` convenience. Phase 2B.2 removed the
//!   `LoadAndRecomputeError` wrapper enum; recompute failures are now
//!   aggregated into the returned `RecomputeResult` instead.
//! - `calcgraph_session.rs` (Phase 3.1 W5-34 → 3.2 W5-35 → 3.3 W5-36
//!   → 3.4 W5-37) — `CalcgraphSession` owns the `ql_calcgraph::Graph`
//!   plus per-formula `FormulaDeps`, `cell_to_formulas` reverse
//!   index, `name_to_formulas` reverse index, `volatile_formulas`,
//!   and a `dirty: HashSet<NodeId>`. The 5 mutation hooks fan out
//!   via `Graph::dependents_for_cell` (stripe + precision for range
//!   deps) and `cell_to_formulas` (direct deps), with BFS for
//!   transitive cascading (Phase 3.4). Forward `add_edge`s for
//!   direct cell→cell deps are added at extract time (Phase 3.4) so
//!   the Phase 0 W3-3 iterative Tarjan in `topo::schedule` can order
//!   chain dependents correctly. `schedule_dirty()` + `take_dirty()`
//!   are the scheduler entry points; `cell_address_for(NodeId)` is
//!   the inverse of `cell_node_for` for the runtime's evaluation
//!   loop.
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. Error enums
//! (`BindError`, `RuntimeError`) and `SimdShape` carry
//! `#[non_exhaustive]` — downstream consumers must include a `_` arm
//! when matching across crate boundaries. `ExprPlan` (the plan IR),
//! `ResolvedName`, and `EvalResult` are exhaustive by design;
//! adding a variant is a MAJOR-version event because every scalar /
//! aggregate / spill evaluator dispatcher must gain a new arm.
//!
//! # Module layout (Tier D1 split, 2026-05-18)
//!
//! `workbook_runtime` is a module directory with 9 sibling
//! submodules — each adds an `impl<'a> WorkbookRuntime<'a>` block to
//! the same struct via the sibling-module impl pattern. See
//! `docs/architecture/workbook-runtime-split-design.md`.
//!
//! - `workbook_runtime::mod` — struct, 4 constructors, `cache_stats`,
//!   `validate_sheet` / `validate_cell` shared helpers.
//! - `workbook_runtime::error` — `RuntimeError` + `RecomputeFailure`
//!   + `RecomputeResult` (re-exported at module root).
//! - `workbook_runtime::cells` — `set_formula`, `set_value`,
//!   `clear_formula`, spill helpers.
//! - `workbook_runtime::recompute` — `recompute_all`, `recompute_dirty`,
//!   recompute orchestrators.
//! - `workbook_runtime::tables` — table mutation API.
//! - `workbook_runtime::sheets` — sheet mutation API.
//! - `workbook_runtime::names` — defined-name registration.
//! - `workbook_runtime::formats` — format intern + cell-format binding.
//! - `workbook_runtime::config` — workbook-scoped reference-mode + locale.
//! - `workbook_runtime::validate` — `validate_formula` + `transaction`.
//!
//! Public API is unchanged: every method stays on `WorkbookRuntime`
//! and `pub use error::*` re-exports the result types.

pub mod aggregate_cache;
pub mod calcgraph_session;
pub mod env;
pub mod eval_result;
pub mod loader;
pub mod lower;
pub mod plan;
pub mod plan_cache;
pub mod scalar;
pub mod simd;
pub mod transaction;
pub mod workbook_runtime;

pub use aggregate_cache::{
    AggregateCache, AggregateCacheStats, InMemAggregateCache, NoAggregateCache,
};
pub use calcgraph_session::{
    CalcgraphSession, FormulaDeps, HookCounts, RebuildFailure, RebuildResult,
};
pub use env::{CellEnv, MapEnv, WorkbookEnv};
pub use eval_result::EvalResult;
pub use loader::load_workbook_and_recompute;
pub use lower::{classify, dispatch, SimdShape};
pub use plan::{
    bind, bind_with_names, bind_with_names_and_sheets, bind_with_site, bind_with_site_no_tables,
    BindError, BindSite, ExprPlan, NameLookup, ResolvedName, SheetResolver, TableLookup,
};
pub use plan_cache::{PlanCache, PlanCacheKey, PlanCacheStats};
pub use scalar::{
    eval_at_cell_boundary, eval_scalar, eval_scalar_with_cache, eval_scalar_with_registry,
};
pub use simd::{
    // Phase 2A.13 audit cycle-3 M9: `div_array` removed (was dead code after
    // Phase 2A.9 H5 routed Operator::Div through scalar evaluator).
    add_array,
    add_scalar,
    mul_array,
    mul_scalar,
    scalar_sub,
    sub_array,
    sub_scalar,
};
pub use transaction::WorkbookTransaction;
pub use workbook_runtime::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};

/// Phase 2B.7 audit H3 (2026-05-12): compile-time proof that the two
/// engine state types the IDE binding will own are `Send + Sync`. If Loro
/// 1.x's `LoroDoc` (inside `OpLog`) loses `Sync` in a future version, or
/// if a Workbook field gains an `Rc`, this fails at build — at the right
/// time to fix it, not three days into Phase 6.3 binding work.
#[allow(dead_code)]
fn _assert_engine_state_is_send_sync() {
    fn check<T: Send + Sync>() {}
    check::<ql_storage::Workbook>();
    check::<ql_oplog::OpLog>();
}

 succeeded in 0ms:
201:### ~~D1.~~ `WorkbookRuntime` monolith split — ✅ SHIPPED 2026-05-18
224:- **Public API:** byte-for-byte identical. `WorkbookRuntime` and

exec
/bin/zsh -lc 'wc -l crates/ql-exec/src/workbook_runtime/*.rs crates/ql-exec/src/workbook_runtime/mod.rs docs/architecture/workbook-runtime-split-design.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    5131 crates/ql-exec/src/workbook_runtime/cells.rs
     143 crates/ql-exec/src/workbook_runtime/config.rs
     283 crates/ql-exec/src/workbook_runtime/error.rs
     424 crates/ql-exec/src/workbook_runtime/formats.rs
     299 crates/ql-exec/src/workbook_runtime/mod.rs
     495 crates/ql-exec/src/workbook_runtime/names.rs
    3152 crates/ql-exec/src/workbook_runtime/recompute.rs
     384 crates/ql-exec/src/workbook_runtime/sheets.rs
    2199 crates/ql-exec/src/workbook_runtime/tables.rs
     719 crates/ql-exec/src/workbook_runtime/validate.rs
     299 crates/ql-exec/src/workbook_runtime/mod.rs
     266 docs/architecture/workbook-runtime-split-design.md
   13794 total

exec
/bin/zsh -lc "sed -n '190,245p' docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
- **Scope:** `crates/ql-oplog/src/replay.rs` — explicit depth guard
  on `apply_op` for BatchCommit recursion.
- **Effort:** ~half a day.

---

## Tier D — PHASE 5 PREP (architectural refactors)

These are Phase 5 (CRDT collaboration) prerequisites that block
clean Phase 5 work if not done first.

### ~~D1.~~ `WorkbookRuntime` monolith split — ✅ SHIPPED 2026-05-18

- **Source:** Phase 4.12 Opus-C HIGH-2.
- **Design:** `docs/architecture/workbook-runtime-split-design.md`
  (committed `2e8566e35f0`).
- **Mechanical extractions (8 commits):**
  - Step 1 (`79c1ebeefa7`): `error.rs` (RuntimeError, RecomputeFailure, RecomputeResult).
  - Step 3.1 (`2761e1f88cf`): `formats.rs` (intern_format, set_cell_format, read_display).
  - Step 3.2 (`be154f4918d`): `config.rs` (set_reference_mode, set_locale).
  - Step 3.3 (`c37c556dd0f`): `sheets.rs` (add_sheet, rename_sheet, rewrite helper).
  - Step 3.4 (`a48e985c5ec`): `names.rs` (set_name, set_sheet_scoped_name).
  - Step 3.5 (`aa6e37800ff`): `tables.rs` (6 methods + reextract_table_readers).
  - Step 3.6 (`c8d4cf95f70`): `recompute.rs` (recompute_all + recompute_dirty + 3 helpers).
  - Step 3.7 (`de7f87c5334`): `cells.rs` (set_formula + set_value + clear_formula + 3 spill helpers).
  - Step 3.8 (`69ede106a61`): `validate.rs` (validate_formula + transaction).
- **Step 4 final cleanup:** Phase 2A.1 named-range tests partitioned
  to `names.rs::tests`; lib.rs `# Stability` section updated; this
  backlog entry marked done.
- **Result:** `mod.rs` trimmed from 12,725 → 299 LOC
  (**97.6% reduction**). 9 sibling submodules under
  `crate::workbook_runtime`, average ~1,484 LOC each (heavily
  skewed: cells.rs 5,131, recompute.rs 3,152, tables.rs 2,199;
  rest under 800 LOC each).
- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
  re-exported types resolve from `crate::workbook_runtime` as before.
- **Gates:** 4141 / 4141 tests passing across every commit (zero
  drift). cargo fmt + clippy `--workspace --all-targets -D warnings`
  + doc all clean.
- **Side-effect fixes:** two pre-existing doc-comment
  misattachments (rename_table doc → set_reference_mode in Step 3.2,
  validate_cell doc → rewrite_formula_text helper in Step 3.3)
  corrected by the moves.
- **Audit:** parallel Codex + separate-Opus pass per the engine
  audit-discipline rule — see `docs/audits/2026-05-18-tier-d1-*.md`.

### D2. `ql-oplog → ql-io` reverse dependency cleanup

- **Source:** Phase 4.12 Opus-C HIGH-3.
- **Scope:** `ql-oplog::Op` reaches into `ql-io::CellWireValue` for
  its mutation vocabulary — Phase 5 CRDT integration will want
  `ql-oplog` to be the dependency floor, not depend on I/O.
- **Effort:** 1-2 days. Define an intermediate type owned by
  `ql-oplog` (or `ql-storage`) that `ql-io::CellWireValue` converts
  to/from.


exec
/bin/zsh -lc 'rg -n "''^'"\\s*(pub(\\(["'^)]*'"\\))?\\s+)?fn\\s+|"'^'"\\s*pub\\s+fn\\s+|"'^'"\\s*pub\\(super\\)\\s+fn\\s+|"'^'"\\s*pub\\(crate\\)\\s+fn\\s+\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/names.rs:36:    pub fn set_name(
crates/ql-exec/src/workbook_runtime/names.rs:95:    pub fn set_sheet_scoped_name(
crates/ql-exec/src/workbook_runtime/names.rs:163:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/names.rs:172:    fn set_sheet_scoped_name_lands_on_sheet_table() {
crates/ql-exec/src/workbook_runtime/names.rs:189:    fn set_sheet_scoped_name_invalid_sheet_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:201:    fn set_sheet_scoped_name_reserved_name_rejected() {
crates/ql-exec/src/workbook_runtime/names.rs:216:    fn set_sheet_scoped_name_emits_op_with_scope() {
crates/ql-exec/src/workbook_runtime/names.rs:242:    fn formula_resolves_sheet_scoped_over_workbook_scoped() {
crates/ql-exec/src/workbook_runtime/names.rs:267:    fn set_sheet_scoped_name_invalidates_plan_cache() {
crates/ql-exec/src/workbook_runtime/names.rs:299:    fn set_formula_resolves_named_cell_target() {
crates/ql-exec/src/workbook_runtime/names.rs:318:    fn set_formula_resolves_named_number_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:333:    fn set_formula_resolves_named_boolean_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:349:    fn set_formula_resolves_named_text_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:363:    fn set_formula_unresolved_name_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:387:    fn runtime_error_bind_display_is_human_readable() {
crates/ql-exec/src/workbook_runtime/names.rs:408:    fn runtime_error_lex_display_is_human_readable() {
crates/ql-exec/src/workbook_runtime/names.rs:437:    fn set_formula_named_range_in_scalar_context_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:458:    fn recompute_all_resolves_named_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:480:    fn set_name_uppercases_for_canonical_lookup() {
crates/ql-exec/src/workbook_runtime/tables.rs:62:    pub fn create_table(
crates/ql-exec/src/workbook_runtime/tables.rs:225:    pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:280:    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:403:    pub fn rename_column(
crates/ql-exec/src/workbook_runtime/tables.rs:574:    pub fn resize_table(
crates/ql-exec/src/workbook_runtime/tables.rs:791:    fn reextract_table_readers(&mut self, table_canonical: &str) {
crates/ql-exec/src/workbook_runtime/tables.rs:870:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/tables.rs:889:    fn structured_ref_sum_qty_column_works_end_to_end() {
crates/ql-exec/src/workbook_runtime/tables.rs:935:    fn structured_ref_at_column_narrows_to_current_row() {
crates/ql-exec/src/workbook_runtime/tables.rs:988:    fn structured_ref_at_column_outside_table_returns_value_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1025:    fn create_table_happy_path_registers_and_emits_op() {
crates/ql-exec/src/workbook_runtime/tables.rs:1060:    fn rename_table_happy_path_rewrites_formula_text() {
crates/ql-exec/src/workbook_runtime/tables.rs:1105:    fn rename_table_target_collision_with_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1123:    fn rename_table_missing_source_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1135:    fn rename_table_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:1166:    fn rename_table_then_drop_new_name_emits_name_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1224:    fn rename_column_happy_path_rewrites_formula_text() {
crates/ql-exec/src/workbook_runtime/tables.rs:1274:    fn rename_column_combination_form_rewritten() {
crates/ql-exec/src/workbook_runtime/tables.rs:1316:    fn rename_column_this_row_form_rewritten() {
crates/ql-exec/src/workbook_runtime/tables.rs:1360:    fn rename_column_other_table_unaffected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1399:    fn rename_column_target_collision_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1425:    fn rename_column_missing_source_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1442:    fn rename_column_unknown_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1454:    fn rename_column_empty_target_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1470:    fn rename_column_same_canonical_is_noop() {
crates/ql-exec/src/workbook_runtime/tables.rs:1491:    fn rename_column_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:1526:    fn rename_column_fires_hook_and_keeps_value_consistent() {
crates/ql-exec/src/workbook_runtime/tables.rs:1582:    fn resize_table_grow_rows_extends_sum_range() {
crates/ql-exec/src/workbook_runtime/tables.rs:1629:    fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() {
crates/ql-exec/src/workbook_runtime/tables.rs:1692:    fn resize_table_shrink_rows_truncates_sum_range() {
crates/ql-exec/src/workbook_runtime/tables.rs:1731:    fn resize_table_add_column_appends_new_column() {
crates/ql-exec/src/workbook_runtime/tables.rs:1760:    fn resize_table_remove_last_column_drops_column() {
crates/ql-exec/src/workbook_runtime/tables.rs:1799:    fn resize_table_remove_referenced_column_emits_name_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1844:    fn resize_table_unknown_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1856:    fn resize_table_zero_dims_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1872:    fn resize_table_arithmetic_mismatch_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1891:    fn resize_table_removed_columns_not_trailing_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1920:    fn resize_table_overlap_with_other_table_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1944:    fn resize_table_added_column_duplicate_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1966:    fn resize_table_removed_columns_excess_count_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1990:    fn resize_table_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:2026:    fn resize_table_exact_noop_emits_nothing() {
crates/ql-exec/src/workbook_runtime/tables.rs:2063:    fn create_table_then_sum_column_works() {
crates/ql-exec/src/workbook_runtime/tables.rs:2080:    fn structured_ref_average_qty_column_works_end_to_end() {
crates/ql-exec/src/workbook_runtime/tables.rs:2122:    fn set_formula_canonicalizes_r1c1_input_to_a1() {
crates/ql-exec/src/workbook_runtime/tables.rs:2141:    fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() {
crates/ql-exec/src/workbook_runtime/tables.rs:2156:    fn set_formula_canonicalizes_de_locale_to_en() {
crates/ql-exec/src/workbook_runtime/tables.rs:2172:    fn set_formula_preserves_at_through_canonicalization() {
crates/ql-exec/src/workbook_runtime/tables.rs:2182:    fn set_reference_mode_op_round_trips_through_replay() {
crates/ql-exec/src/workbook_runtime/sheets.rs:37:fn rewrite_formula_text_for_sheet_rename(
crates/ql-exec/src/workbook_runtime/sheets.rs:74:    pub fn add_sheet(
crates/ql-exec/src/workbook_runtime/sheets.rs:146:    pub fn rename_sheet(
crates/ql-exec/src/workbook_runtime/sheets.rs:238:    fn rename_sheet_rewrites_formula_text_and_recomputes() {
crates/ql-exec/src/workbook_runtime/sheets.rs:268:    fn rename_sheet_leaves_unrelated_formulas_alone() {
crates/ql-exec/src/workbook_runtime/sheets.rs:296:    fn rename_sheet_duplicate_target_rejected_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:309:    fn rename_sheet_unknown_id_rejected_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:319:    fn rename_sheet_case_only_rename_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:343:    fn add_sheet_rejects_canonical_duplicate() {
crates/ql-exec/src/workbook_runtime/sheets.rs:357:    fn add_sheet_rejects_reserved_char() {
crates/ql-exec/src/workbook_runtime/sheets.rs:366:    fn add_sheet_with_bad_name_emits_no_oplog_entry() {
crates/ql-exec/src/workbook_runtime/recompute.rs:39:    pub fn recompute_all(&mut self) -> RecomputeResult {
crates/ql-exec/src/workbook_runtime/recompute.rs:216:    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
crates/ql-exec/src/workbook_runtime/recompute.rs:626:    fn try_recompute_one_cached(
crates/ql-exec/src/workbook_runtime/recompute.rs:651:    fn try_recompute_with_aggregate_cache(
crates/ql-exec/src/workbook_runtime/recompute.rs:670:    fn try_recompute_with_simd_profile(
crates/ql-exec/src/workbook_runtime/recompute.rs:824:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/recompute.rs:833:    fn recompute_all_on_empty_workbook_is_noop() {
crates/ql-exec/src/workbook_runtime/recompute.rs:845:    fn recompute_all_refreshes_formula_values() {
crates/ql-exec/src/workbook_runtime/recompute.rs:876:    fn recompute_all_handles_multiple_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:909:    fn save_load_recompute_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:970:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
crates/ql-exec/src/workbook_runtime/recompute.rs:996:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1026:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1054:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1079:    fn recompute_all_dependent_of_cycle_propagates_circ_error() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1112:    fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1183:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1213:    fn recompute_all_does_not_short_circuit_on_first_failure() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1248:    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1270:    fn recompute_all_eval_time_error_values_count_as_succeeded() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1291:    fn recompute_all_failed_cells_preserve_prior_state() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1315:    fn recompute_all_second_pass_is_all_cache_hits() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1346:    fn name_table_mutation_invalidates_bind_plan_cache() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1405:    fn cache_keys_are_stable_across_recompute_passes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1428:    fn cache_stats_flow_into_timings_struct() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1451:    fn set_formula_populates_cache_for_subsequent_recompute() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1479:    fn nag_01_named_constants_still_work_in_scalar_and_aggregate_contexts() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1504:    fn nag_02_named_cell_references_still_work() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1530:    fn nag_03_named_range_in_aggregate_function_binds_to_explicit_variant() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1556:    fn nag_04_named_range_in_scalar_positions_errors_precisely() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1594:    fn named_formula_surfaces_distinct_bind_error() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1620:    fn runtime_mutations_fire_calcgraph_hooks() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1664:    fn rebuild_then_edit_keeps_cell_index_in_sync() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1704:    fn runtime_without_graph_works_as_before() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1717:    fn runtime_with_oplog_and_graph_drives_both() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1750:    fn recompute_dirty_returns_none_when_no_graph_attached() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1761:    fn recompute_dirty_cascades_dependency_chain() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1811:    fn recompute_dirty_writes_circ_error_for_cycle_members() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1854:    fn recompute_dirty_skips_unrelated_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1902:    fn ovr_3_01_set_formula_writes_to_computed_overlay_not_user() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1934:    fn ovr_3_02_typing_over_formula_clears_formula_and_computed() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1966:    fn ovr_3_02b_clear_formula_promotes_value_to_user_lane() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1991:    fn ovr_3_03_save_load_preserves_layer() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2036:    fn ovr_3_04_read_cascade_consistent_across_lane_types() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2076:    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
crates/ql-exec/src/workbook_runtime/recompute.rs:2100:    fn agg_3_04_results_match_scalar_baseline() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2143:    fn agg_3_01_no_rescan_on_unrelated_writes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2189:    fn agg_3_02_intersecting_write_invalidates_cache() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2224:    fn agg_3_03_full_column_aggregate_remains_compressed() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2269:    fn vol_3_03_seeded_rng_produces_deterministic_rand_sequence() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2294:    fn vol_3_01_volatile_formulas_recompute_when_requested() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2322:    fn vol_3_02_nonvolatile_dependents_update_when_volatile_changes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2378:    fn veq_3_01_unchanged_upstream_suppresses_downstream_recompute() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2422:    fn veq_3_02_error_equality_suppresses_downstream() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2469:    fn veq_3_03_profile_records_skipped_vertices() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2517:    fn veq_does_not_skip_volatile_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2549:    fn simd_3_01_og02_pattern_classifies_to_mul_scalar() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2574:    fn simd_3_02_division_falls_back_to_scalar() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2605:    fn simd_3_03_profile_records_simd_eligible_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2666:    fn w5_53_sumif_named_range_numeric_criteria() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2686:    fn w5_53_sumif_comparator_criteria() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2704:    fn w5_53_countif_named_range() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2725:    fn w5_53_sumif_with_separate_sum_range() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2761:    fn w5_53_sumif_recomputes_on_range_cell_change() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2797:    fn w5_54_vlookup_exact_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2827:    fn w5_54_vlookup_approximate_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2857:    fn w5_54_hlookup_exact_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2885:    fn w5_54_index_match_pattern_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2920:    fn w5_54_choose_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2934:    fn w5_54_vlookup_not_found_returns_na_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2964:    fn w5_55_averageif_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2984:    fn w5_55_sumifs_two_conditions_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3025:    fn w5_55_countifs_single_condition_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3045:    fn w5_55_sumproduct_two_columns_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3073:    fn w5_55_averageifs_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3115:    fn mark_volatile_dirty_zero_when_no_volatile_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3132:    fn recompute_dirty_twice_in_a_row_is_idempotent() {
crates/ql-exec/src/workbook_runtime/validate.rs:42:    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
crates/ql-exec/src/workbook_runtime/validate.rs:89:    pub fn validate_formula(
crates/ql-exec/src/workbook_runtime/validate.rs:149:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/validate.rs:163:    fn add_sheet_rejects_zero_chunk_rows() {
crates/ql-exec/src/workbook_runtime/validate.rs:187:    fn clear_formula_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/validate.rs:205:    fn clear_formula_rejects_invalid_cell() {
crates/ql-exec/src/workbook_runtime/validate.rs:224:    fn validate_formula_returns_value_without_writing() {
crates/ql-exec/src/workbook_runtime/validate.rs:246:    fn validate_formula_surfaces_bind_errors() {
crates/ql-exec/src/workbook_runtime/validate.rs:263:    fn validate_formula_returns_anchor_value_for_top_level_array() {
crates/ql-exec/src/workbook_runtime/validate.rs:289:    fn validate_formula_does_not_pollute_plan_cache() {
crates/ql-exec/src/workbook_runtime/validate.rs:314:    fn is_aggregate_function_lists_only_registered_aggregates() {
crates/ql-exec/src/workbook_runtime/validate.rs:449:    fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:471:    fn w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:514:    fn w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:564:    fn w5_d_13_1_atan2_and_sumxmy2_via_source_text() {
crates/ql-exec/src/workbook_runtime/validate.rs:617:    fn every_range_aware_fn_is_admitted_to_is_aggregate_function() {
crates/ql-exec/src/workbook_runtime/validate.rs:654:    fn nag_05_nested_aggregates_with_named_range_bind_cleanly() {
crates/ql-exec/src/workbook_runtime/validate.rs:675:    fn nag_06_round_with_nested_sum_of_named_range_binds_cleanly() {
crates/ql-exec/src/workbook_runtime/validate.rs:699:    fn recompute_result_is_complete_is_single_source_of_truth() {
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:131:pub(crate) fn validate_cell(
crates/ql-exec/src/workbook_runtime/mod.rs:199:    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
crates/ql-exec/src/workbook_runtime/mod.rs:219:    pub fn with_oplog(
crates/ql-exec/src/workbook_runtime/mod.rs:241:    pub fn with_graph(
crates/ql-exec/src/workbook_runtime/mod.rs:262:    pub fn with_oplog_and_graph(
crates/ql-exec/src/workbook_runtime/mod.rs:281:    pub fn cache_stats(&self) -> PlanCacheStats {
crates/ql-exec/src/workbook_runtime/config.rs:30:    pub fn set_reference_mode(
crates/ql-exec/src/workbook_runtime/config.rs:56:    pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/config.rs:82:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/config.rs:93:    fn set_reference_mode_updates_workbook_and_emits_op() {
crates/ql-exec/src/workbook_runtime/config.rs:107:    fn set_reference_mode_noop_when_unchanged_emits_no_op() {
crates/ql-exec/src/workbook_runtime/config.rs:120:    fn set_locale_updates_workbook_and_emits_op() {
crates/ql-exec/src/workbook_runtime/config.rs:133:    fn set_locale_noop_when_unchanged_emits_no_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
crates/ql-exec/src/workbook_runtime/formats.rs:75:    pub fn set_cell_format(
crates/ql-exec/src/workbook_runtime/formats.rs:148:    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
crates/ql-exec/src/workbook_runtime/formats.rs:194:    fn intern_format_returns_existing_builtin_id_no_oplog_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:213:    fn intern_format_new_string_emits_register_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:234:    fn intern_format_duplicate_call_idempotent_no_second_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:249:    fn set_cell_format_emits_op_and_updates_overlay() {
crates/ql-exec/src/workbook_runtime/formats.rs:271:    fn set_cell_format_with_none_clears_overlay_and_emits_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:293:    fn set_cell_format_unknown_id_is_runtime_error() {
crates/ql-exec/src/workbook_runtime/formats.rs:307:    fn read_display_general_path_for_unbound_cell() {
crates/ql-exec/src/workbook_runtime/formats.rs:318:    fn read_display_with_built_in_date_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:333:    fn read_display_with_custom_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:346:    fn read_display_caches_parsed_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:368:    fn read_display_error_value_passes_sigil_through() {
crates/ql-exec/src/workbook_runtime/formats.rs:383:    fn read_display_text_value_through_at_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:397:    fn intern_and_set_cell_format_replay_round_trip() {
crates/ql-exec/src/workbook_runtime/error.rs:172:    fn from(e: LexError) -> Self {
crates/ql-exec/src/workbook_runtime/error.rs:178:    fn from(e: BindError) -> Self {
crates/ql-exec/src/workbook_runtime/error.rs:274:    pub fn is_complete(&self) -> bool {
crates/ql-exec/src/workbook_runtime/error.rs:280:    pub fn failed_count(&self) -> usize {
crates/ql-exec/src/workbook_runtime/cells.rs:51:    pub fn set_formula(
crates/ql-exec/src/workbook_runtime/cells.rs:468:    fn reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:624:    pub(super) fn write_spill(
crates/ql-exec/src/workbook_runtime/cells.rs:751:    fn write_anchor_error(
crates/ql-exec/src/workbook_runtime/cells.rs:770:    pub fn set_value(
crates/ql-exec/src/workbook_runtime/cells.rs:972:    pub fn clear_formula(
crates/ql-exec/src/workbook_runtime/cells.rs:1128:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/cells.rs:1137:    fn set_formula_literal_arithmetic() {
crates/ql-exec/src/workbook_runtime/cells.rs:1153:    fn set_formula_reads_existing_cell() {
crates/ql-exec/src/workbook_runtime/cells.rs:1165:    fn set_formula_with_function_call() {
crates/ql-exec/src/workbook_runtime/cells.rs:1179:    fn set_formula_propagates_div_by_zero() {
crates/ql-exec/src/workbook_runtime/cells.rs:1191:    fn set_formula_invalid_syntax_returns_parse_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:1208:    fn set_formula_trailing_tokens_returns_parse_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:1224:    fn set_formula_var_s_dotted_function_dispatches() {
crates/ql-exec/src/workbook_runtime/cells.rs:1234:    fn set_formula_stdev_p_dotted_function_dispatches() {
crates/ql-exec/src/workbook_runtime/cells.rs:1247:    fn set_formula_ai_returns_ai_not_available() {
crates/ql-exec/src/workbook_runtime/cells.rs:1259:    fn set_value_clears_existing_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:1281:    fn set_formula_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/cells.rs:1299:    fn set_formula_rejects_row_above_max() {
crates/ql-exec/src/workbook_runtime/cells.rs:1321:    fn set_formula_rejects_col_above_max() {
crates/ql-exec/src/workbook_runtime/cells.rs:1343:    fn set_value_rejects_invalid_cell() {
crates/ql-exec/src/workbook_runtime/cells.rs:1359:    fn set_formula_at_max_row_max_col_ok() {
crates/ql-exec/src/workbook_runtime/cells.rs:1370:    fn set_value_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/cells.rs:1389:    fn set_value_on_blank_cell_no_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:1407:    fn set_value_with_oplog_emits_put_value() {
crates/ql-exec/src/workbook_runtime/cells.rs:1431:    fn set_value_over_existing_formula_emits_batch_commit_pair() {
crates/ql-exec/src/workbook_runtime/cells.rs:1459:    fn set_value_blank_emits_nothing_when_cell_is_already_blank() {
crates/ql-exec/src/workbook_runtime/cells.rs:1478:    fn set_value_blank_over_formula_emits_clear_formula_only() {
crates/ql-exec/src/workbook_runtime/cells.rs:1496:    fn set_formula_with_oplog_emits_put_formula_text_only() {
crates/ql-exec/src/workbook_runtime/cells.rs:1529:    fn set_formula_into_spill_target_emits_put_formula_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1576:    fn set_formula_array_reshape_records_one_op_per_call() {
crates/ql-exec/src/workbook_runtime/cells.rs:1590:    fn set_formula_lex_error_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1610:    fn set_formula_parse_error_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1623:    fn set_formula_invalid_cell_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1636:    fn recompute_all_does_not_emit_ops() {
crates/ql-exec/src/workbook_runtime/cells.rs:1665:    fn runtime_without_oplog_set_value_and_set_formula_still_work() {
crates/ql-exec/src/workbook_runtime/cells.rs:1691:    fn runtime_set_name_emits_op_into_attached_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1731:    fn runtime_add_sheet_emits_op_into_attached_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1764:    fn runtime_clear_formula_emits_atomic_pair_when_formula_present() {
crates/ql-exec/src/workbook_runtime/cells.rs:1817:    fn runtime_set_name_add_sheet_clear_formula_work_without_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1848:    fn runtime_set_name_reserved_name_does_not_append_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1875:    fn opl_2b_02_full_op_vocabulary_producer_replay_equivalence() {
crates/ql-exec/src/workbook_runtime/cells.rs:1957:    fn text_formula_renders_through_recompute() {
crates/ql-exec/src/workbook_runtime/cells.rs:1974:    fn text_formula_with_number_format_returns_formatted_text() {
crates/ql-exec/src/workbook_runtime/cells.rs:1989:    fn text_formula_invalid_format_returns_value_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:2006:    fn cross_sheet_cellref_evaluates_after_recompute() {
crates/ql-exec/src/workbook_runtime/cells.rs:2029:    fn cross_sheet_quoted_name_with_space_evaluates() {
crates/ql-exec/src/workbook_runtime/cells.rs:2046:    fn cross_sheet_formula_with_unknown_sheet_surfaces_bind_error_at_set_time() {
crates/ql-exec/src/workbook_runtime/cells.rs:2063:    fn cross_sheet_three_sheet_chain_evaluates() {
crates/ql-exec/src/workbook_runtime/cells.rs:2107:    fn set_formula_array_literal_horizontal_spills_1x3() {
crates/ql-exec/src/workbook_runtime/cells.rs:2135:    fn set_formula_array_literal_vertical_spills_3x1() {
crates/ql-exec/src/workbook_runtime/cells.rs:2153:    fn set_formula_array_literal_2x2_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:2169:    fn set_formula_array_shrinks_clears_old_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2205:    fn set_formula_scalar_after_array_clears_spill_state() {
crates/ql-exec/src/workbook_runtime/cells.rs:2225:    fn set_formula_array_blocked_by_user_value_at_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2252:    fn set_formula_array_blocked_by_formula_at_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2276:    fn set_formula_array_out_of_bounds_returns_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2301:    fn set_formula_array_writeback_fires_on_set_value_for_each_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2321:    fn set_formula_array_2x2_fires_three_on_set_value() {
crates/ql-exec/src/workbook_runtime/cells.rs:2343:    fn set_formula_dissolving_spill_dirties_old_target_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:2381:    fn set_formula_array_reshape_fires_on_set_value_for_union() {
crates/ql-exec/src/workbook_runtime/cells.rs:2412:    fn set_formula_blocked_spill_does_not_fire_target_hooks() {
crates/ql-exec/src/workbook_runtime/cells.rs:2443:    fn set_formula_array_same_formula_twice_is_stable() {
crates/ql-exec/src/workbook_runtime/cells.rs:2480:    fn set_formula_reextract_aliases_pre_existing_reader_to_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:2521:    fn set_formula_reextract_unroutes_alias_after_spill_dissolves() {
crates/ql-exec/src/workbook_runtime/cells.rs:2561:    fn set_formula_reextract_dedupes_across_old_and_new_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2595:    fn set_formula_reextract_skipped_on_blocked_spill_with_no_old_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2631:    fn set_formula_at_spill_target_dissolves_host_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2672:    fn set_formula_at_anchor_does_not_double_clear_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2700:    fn set_formula_array_at_spill_target_dissolves_then_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:2729:    fn set_formula_at_non_spill_target_unchanged_behavior() {
crates/ql-exec/src/workbook_runtime/cells.rs:2769:    fn set_formula_into_host_target_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:2807:    fn set_formula_into_host_target_marks_host_anchor_dirty() {
crates/ql-exec/src/workbook_runtime/cells.rs:2836:    fn set_formula_into_host_target_dirties_readers_of_other_host_targets() {
crates/ql-exec/src/workbook_runtime/cells.rs:2886:    fn clear_formula_at_spill_anchor_dissolves_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2945:    fn clear_formula_at_non_anchor_cell_unchanged_behavior() {
crates/ql-exec/src/workbook_runtime/cells.rs:2978:    fn clear_formula_at_spill_anchor_emits_only_clear_formula_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:3013:    fn clear_formula_at_spill_anchor_fires_on_set_value_for_targets() {
crates/ql-exec/src/workbook_runtime/cells.rs:3048:    fn clear_formula_at_spill_anchor_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:3100:    fn recompute_all_materializes_spill_for_array_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:3132:    fn recompute_all_scalar_formula_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3152:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3174:    fn recompute_all_array_formula_idempotent_across_two_passes() {
crates/ql-exec/src/workbook_runtime/cells.rs:3201:    fn set_value_at_spill_target_dissolves_host_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3225:    fn set_value_at_spill_anchor_dissolves_own_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3247:    fn set_value_at_non_spill_cell_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3272:    fn set_value_at_spill_target_marks_host_anchor_dirty() {
crates/ql-exec/src/workbook_runtime/cells.rs:3298:    fn set_value_at_spill_target_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:3335:    fn set_value_over_spill_anchor_formula_emits_batch_commit() {
crates/ql-exec/src/workbook_runtime/cells.rs:3360:    fn set_formula_sequence_rows_only_spills_vertically() {
crates/ql-exec/src/workbook_runtime/cells.rs:3379:    fn set_formula_sequence_rows_cols_spills_2d() {
crates/ql-exec/src/workbook_runtime/cells.rs:3405:    fn set_formula_sequence_zero_rows_produces_num_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3419:    fn recompute_all_materializes_sequence_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3443:    fn set_formula_sequence_inside_binary_op_produces_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3457:    fn set_formula_transpose_row_literal_spills_as_column() {
crates/ql-exec/src/workbook_runtime/cells.rs:3474:    fn set_formula_transpose_column_literal_spills_as_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:3491:    fn set_formula_transpose_2x2() {
crates/ql-exec/src/workbook_runtime/cells.rs:3516:    fn set_formula_transpose_of_sequence_in_arg_position_is_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3536:    fn set_formula_filter_of_sequence_in_arg_position_is_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3555:    fn set_formula_sequence_of_sequence_in_arg_position_is_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3576:    fn set_formula_filter_row_keeps_truthy() {
crates/ql-exec/src/workbook_runtime/cells.rs:3594:    fn set_formula_filter_column_keeps_truthy() {
crates/ql-exec/src/workbook_runtime/cells.rs:3612:    fn set_formula_filter_all_false_no_if_empty_produces_calc() {
crates/ql-exec/src/workbook_runtime/cells.rs:3627:    fn set_formula_filter_all_false_with_if_empty_spills_singleton() {
crates/ql-exec/src/workbook_runtime/cells.rs:3656:    fn set_formula_transpose_with_named_range_arg_binds_and_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:3692:    fn set_formula_filter_with_named_range_args_binds_and_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:3734:    fn recompute_dirty_transpose_with_named_range_updates_on_value_change() {
crates/ql-exec/src/workbook_runtime/cells.rs:3786:    fn recompute_dirty_filter_with_named_ranges_grows_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3860:    fn recompute_dirty_sequence_grows_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3897:    fn recompute_dirty_sequence_shrinks_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3940:    fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3987:    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:4050:    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:4093:    fn create_table_rejected_when_footprint_contains_spill_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:4124:    fn create_table_succeeds_when_anchor_is_outside_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:4148:    fn resize_table_grow_rejected_when_new_cells_contain_spill_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:4173:    fn resize_table_grow_succeeds_when_anchor_is_outside_new_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:4195:    fn create_table_rejects_footprint_past_max_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4223:    fn create_table_rejects_footprint_past_max_column() {
crates/ql-exec/src/workbook_runtime/cells.rs:4251:    fn create_table_rejects_footprint_u32_overflow_on_rows() {
crates/ql-exec/src/workbook_runtime/cells.rs:4273:    fn resize_table_rejects_growing_past_max_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4305:    fn create_table_rejects_overlap() {
crates/ql-exec/src/workbook_runtime/cells.rs:4344:    fn create_table_rejects_duplicate_column_names_case_insensitive() {
crates/ql-exec/src/workbook_runtime/cells.rs:4370:    fn create_table_rejects_namespace_collision_with_defined_name() {
crates/ql-exec/src/workbook_runtime/cells.rs:4388:    fn drop_table_removes_metadata_and_emits_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:4405:    fn drop_table_missing_errors() {
crates/ql-exec/src/workbook_runtime/cells.rs:4427:    fn drop_table_fires_on_table_drop_hook_and_emits_name_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:4496:    fn drop_table_propagates_name_error_through_chain() {
crates/ql-exec/src/workbook_runtime/cells.rs:4556:    fn mixed_relativity_r1c1_range_rejected_at_set_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:4573:    fn structured_ref_at_inside_vs_outside_brackets_eval_identically() {
crates/ql-exec/src/workbook_runtime/cells.rs:4617:    fn at_whole_column_evals_to_anchor_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4633:    fn at_whole_row_evals_to_anchor_col() {
crates/ql-exec/src/workbook_runtime/cells.rs:4649:    fn sheet_qualified_at_ref_resolves_correctly() {
crates/ql-exec/src/workbook_runtime/cells.rs:4669:    fn r1c1_input_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4725:    fn de_locale_input_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4750:    fn at_operator_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4782:    fn reference_mode_change_leaves_stored_formula_text_canonical() {
crates/ql-exec/src/workbook_runtime/cells.rs:4806:    fn locale_change_leaves_stored_formula_text_canonical() {
crates/ql-exec/src/workbook_runtime/cells.rs:4827:    fn at_scalar_idempotent_through_eval() {
crates/ql-exec/src/workbook_runtime/cells.rs:4842:    fn at_function_with_scalar_return_passes_through() {
crates/ql-exec/src/workbook_runtime/cells.rs:4884:    fn coverage_matrix() -> Vec<MatrixCell> {
crates/ql-exec/src/workbook_runtime/cells.rs:5030:    fn coverage_matrix_mode_locale_at_presence_30_cells() {
crates/ql-exec/src/workbook_runtime/cells.rs:5067:    fn coverage_matrix_has_no_duplicates() {
crates/ql-exec/src/workbook_runtime/cells.rs:5089:    fn plan_cache_at_range_collision_across_cells_regression() {
crates/ql-exec/src/workbook_runtime/cells.rs:5120:    fn coverage_matrix_dimension_counts() {

exec
/bin/zsh -lc 'rg -n "''^'"\\s*///\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/names.rs:26:    /// Phase 2B.5 (2026-05-12): register a defined name through the runtime,
crates/ql-exec/src/workbook_runtime/names.rs:27:    /// emitting `Op::SetName` into the attached op log (if any). This is the
crates/ql-exec/src/workbook_runtime/names.rs:28:    /// op-log-recording wrapper for `Workbook::set_name`; product code SHOULD
crates/ql-exec/src/workbook_runtime/names.rs:29:    /// route through here so the mutation lands in the op log.
crates/ql-exec/src/workbook_runtime/names.rs:30:    ///
crates/ql-exec/src/workbook_runtime/names.rs:31:    /// Direct callers of `Workbook::set_name` bypass the op log silently —
crates/ql-exec/src/workbook_runtime/names.rs:32:    /// that path is documented as low-level and intended only for tests, the
crates/ql-exec/src/workbook_runtime/names.rs:33:    /// qbook loader (where the workbook is being constructed from disk and
crates/ql-exec/src/workbook_runtime/names.rs:34:    /// op-log history is loaded separately), and other engine-internal
crates/ql-exec/src/workbook_runtime/names.rs:35:    /// reconstruction code. See GAP-O-01 in `docs/known-gaps.md`.
crates/ql-exec/src/workbook_runtime/names.rs:81:    /// **W5-92 (Phase 4.6.D):** register a sheet-scoped defined name
crates/ql-exec/src/workbook_runtime/names.rs:82:    /// through the runtime, emitting `Op::SetName { scope: Some(sheet), .. }`
crates/ql-exec/src/workbook_runtime/names.rs:83:    /// into the attached op log (if any). Sheet-scoped names shadow
crates/ql-exec/src/workbook_runtime/names.rs:84:    /// workbook-scoped names with the same identifier when accessed
crates/ql-exec/src/workbook_runtime/names.rs:85:    /// from a formula on `sheet`, per Excel canon (XS-4-03).
crates/ql-exec/src/workbook_runtime/names.rs:86:    ///
crates/ql-exec/src/workbook_runtime/names.rs:87:    /// Validation matches `set_name`:
crates/ql-exec/src/workbook_runtime/names.rs:88:    /// - `Workbook::sheet(sheet)` must exist; otherwise
crates/ql-exec/src/workbook_runtime/names.rs:89:    ///   `RuntimeError::InvalidSheet`.
crates/ql-exec/src/workbook_runtime/names.rs:90:    /// - Reserved-name guard fires (currently `AI` per CORR-06); the
crates/ql-exec/src/workbook_runtime/names.rs:91:    ///   reserved set is workbook-global, so sheet-scoped names are
crates/ql-exec/src/workbook_runtime/names.rs:92:    ///   refused with the same rule.
crates/ql-exec/src/workbook_runtime/names.rs:93:    /// - Op-log append failure fails BEFORE the workbook mutation so
crates/ql-exec/src/workbook_runtime/names.rs:94:    ///   neither failure mode leaves engine state divergent.
crates/ql-exec/src/workbook_runtime/names.rs:160:    /// Tier D1 Step 4: shared with the appended Phase 2A.1 named-
crates/ql-exec/src/workbook_runtime/names.rs:161:    /// range tests. The W5-92 / W5-93 tests above use `Workbook::new()`
crates/ql-exec/src/workbook_runtime/names.rs:162:    /// directly; the Phase 2A.1 tests built on this helper.
crates/ql-exec/src/workbook_runtime/names.rs:381:    /// Phase 2A.11 audit M16: error Display strings are human-readable, not
crates/ql-exec/src/workbook_runtime/names.rs:382:    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
crates/ql-exec/src/workbook_runtime/names.rs:383:    /// Name("X"))` rendered via `{0:?}` and surfaced "bind error:
crates/ql-exec/src/workbook_runtime/names.rs:384:    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
crates/ql-exec/src/workbook_runtime/names.rs:385:    /// quote spelling. Now reads "bind error: unresolved name \"X\"".
crates/ql-exec/src/workbook_runtime/names.rs:431:    /// Phase 2B.4 (2026-05-12): named range in a bare scalar position now
crates/ql-exec/src/workbook_runtime/names.rs:432:    /// surfaces the precise `NamedRangeInScalarContext` instead of the
crates/ql-exec/src/workbook_runtime/names.rs:433:    /// generic `UnsupportedVariant`. Aggregate-context usage (e.g.
crates/ql-exec/src/workbook_runtime/names.rs:434:    /// `=SUM(Sales)`) is now accepted and binds to `ExprPlan::AggregateNameRef`.
crates/ql-exec/src/workbook_runtime/names.rs:435:    /// NAG-04 acceptance.
crates/ql-exec/src/workbook_runtime/mod.rs:103:/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
crates/ql-exec/src/workbook_runtime/mod.rs:104:/// before any work that would otherwise panic inside `Workbook::put_at`.
crates/ql-exec/src/workbook_runtime/mod.rs:105:/// `pub(crate)` so `WorkbookTransaction` can call the same validator at
crates/ql-exec/src/workbook_runtime/mod.rs:106:/// `put_value` / `put_formula` buffering time.
crates/ql-exec/src/workbook_runtime/mod.rs:118:/// Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
crates/ql-exec/src/workbook_runtime/mod.rs:119:/// row/col bounds checks so the runtime entry points refuse out-of-grid
crates/ql-exec/src/workbook_runtime/mod.rs:120:/// coordinates before any work that would otherwise panic inside
crates/ql-exec/src/workbook_runtime/mod.rs:121:/// `Sheet::put` (which asserts `row <= MAX_ROW && col <= MAX_COLUMN`). The
crates/ql-exec/src/workbook_runtime/mod.rs:122:/// Phase 2A.6 audit closed sheet-id panics but missed row/col — three
crates/ql-exec/src/workbook_runtime/mod.rs:123:/// independent megaudit agents flagged the gap. `pub(crate)` so
crates/ql-exec/src/workbook_runtime/mod.rs:124:/// `WorkbookTransaction` can call the same validator at buffer time.
crates/ql-exec/src/workbook_runtime/mod.rs:125:///
crates/ql-exec/src/workbook_runtime/mod.rs:126:/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
crates/ql-exec/src/workbook_runtime/mod.rs:127:/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
crates/ql-exec/src/workbook_runtime/mod.rs:128:/// helper that lived between this comment and `validate_cell`. The
crates/ql-exec/src/workbook_runtime/mod.rs:129:/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
crates/ql-exec/src/workbook_runtime/mod.rs:130:/// now reaches its intended target.
crates/ql-exec/src/workbook_runtime/mod.rs:160:/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
crates/ql-exec/src/workbook_runtime/mod.rs:161:///
crates/ql-exec/src/workbook_runtime/mod.rs:162:/// Construct one per session of cell edits. Re-creating per call is cheap (the
crates/ql-exec/src/workbook_runtime/mod.rs:163:/// struct holds borrows, no heap state of its own).
crates/ql-exec/src/workbook_runtime/mod.rs:164:///
crates/ql-exec/src/workbook_runtime/mod.rs:165:/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
crates/ql-exec/src/workbook_runtime/mod.rs:166:/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
crates/ql-exec/src/workbook_runtime/mod.rs:167:/// emit ops into the log in append-before-mutate order. `transaction()`
crates/ql-exec/src/workbook_runtime/mod.rs:168:/// re-borrows the op-log handle into the returned transaction so a single op
crates/ql-exec/src/workbook_runtime/mod.rs:169:/// log records both individual edits and batched commits cohesively.
crates/ql-exec/src/workbook_runtime/mod.rs:173:    /// Optional op-log sink. When `Some`, all producer methods append before
crates/ql-exec/src/workbook_runtime/mod.rs:174:    /// mutating the workbook so a failing append leaves the workbook
crates/ql-exec/src/workbook_runtime/mod.rs:175:    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
crates/ql-exec/src/workbook_runtime/mod.rs:177:    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
crates/ql-exec/src/workbook_runtime/mod.rs:178:    /// successive `set_formula` and `recompute_all` calls hit the cache
crates/ql-exec/src/workbook_runtime/mod.rs:179:    /// for unchanged formula text under the same NameTable generation.
crates/ql-exec/src/workbook_runtime/mod.rs:180:    /// See `crate::plan_cache` module docs for the invalidation contract.
crates/ql-exec/src/workbook_runtime/mod.rs:182:    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
crates/ql-exec/src/workbook_runtime/mod.rs:183:    /// every mutation method calls the corresponding hook on the
crates/ql-exec/src/workbook_runtime/mod.rs:184:    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
crates/ql-exec/src/workbook_runtime/mod.rs:185:    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
crates/ql-exec/src/workbook_runtime/mod.rs:186:    /// dirty propagation through the same surface. See
crates/ql-exec/src/workbook_runtime/mod.rs:187:    /// `crate::calcgraph_session` module docs for the ownership model.
crates/ql-exec/src/workbook_runtime/mod.rs:189:    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
crates/ql-exec/src/workbook_runtime/mod.rs:190:    /// by `FormatId`. `read_display` populates on-demand from
crates/ql-exec/src/workbook_runtime/mod.rs:191:    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
crates/ql-exec/src/workbook_runtime/mod.rs:192:    /// id→string mutations, so cache entries stay stable for the
crates/ql-exec/src/workbook_runtime/mod.rs:193:    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
crates/ql-exec/src/workbook_runtime/mod.rs:194:    /// new entry; no invalidation needed.
crates/ql-exec/src/workbook_runtime/mod.rs:210:    /// Phase 2A.3.b: construct a runtime that records every mutation to the
crates/ql-exec/src/workbook_runtime/mod.rs:211:    /// supplied `OpLog`. Producer-replay equivalence: replaying the resulting
crates/ql-exec/src/workbook_runtime/mod.rs:212:    /// log against a fresh workbook (then calling `recompute_all` to
crates/ql-exec/src/workbook_runtime/mod.rs:213:    /// materialize formula values) reproduces the same observable state.
crates/ql-exec/src/workbook_runtime/mod.rs:214:    ///
crates/ql-exec/src/workbook_runtime/mod.rs:215:    /// See module docs for the documented limitations: `set_value(Value::Blank)`
crates/ql-exec/src/workbook_runtime/mod.rs:216:    /// emits no `PutValue` (CellWireValue lacks a Blank variant in 2A.3.b);
crates/ql-exec/src/workbook_runtime/mod.rs:217:    /// NaN/Inf in number values fail serde_json serialization and surface as
crates/ql-exec/src/workbook_runtime/mod.rs:218:    /// `RuntimeError::OpLog`.
crates/ql-exec/src/workbook_runtime/mod.rs:234:    /// Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
crates/ql-exec/src/workbook_runtime/mod.rs:235:    /// mutation hooks on every producer method. Phase 3.1 hooks are
crates/ql-exec/src/workbook_runtime/mod.rs:236:    /// stubs (counter bumps + cell-index updates) — they accumulate
crates/ql-exec/src/workbook_runtime/mod.rs:237:    /// state that Phase 3.3 will turn into real dirty propagation and
crates/ql-exec/src/workbook_runtime/mod.rs:238:    /// edge updates. Today's recompute_all still walks formulas in
crates/ql-exec/src/workbook_runtime/mod.rs:239:    /// HashMap order; Phase 3.4 replaces it with a Tarjan-SCC-scheduled
crates/ql-exec/src/workbook_runtime/mod.rs:240:    /// graph walk.
crates/ql-exec/src/workbook_runtime/mod.rs:256:    /// Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
crates/ql-exec/src/workbook_runtime/mod.rs:257:    /// op log and an attached calcgraph session. The combined-attachment
crates/ql-exec/src/workbook_runtime/mod.rs:258:    /// constructor mirrors the IDE pattern (open file → load oplog +
crates/ql-exec/src/workbook_runtime/mod.rs:259:    /// rebuild graph → hand both to the runtime per edit). Order of
crates/ql-exec/src/workbook_runtime/mod.rs:260:    /// operations per mutation: lex+parse+bind → op-log append → workbook
crates/ql-exec/src/workbook_runtime/mod.rs:261:    /// mutation → graph hook.
crates/ql-exec/src/workbook_runtime/mod.rs:278:    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
crates/ql-exec/src/workbook_runtime/mod.rs:279:    /// since this runtime was constructed. Includes hit count, miss
crates/ql-exec/src/workbook_runtime/mod.rs:280:    /// count, entry count, and convenience hit-rate.
crates/ql-exec/src/workbook_runtime/sheets.rs:24:/// **W5-91 (Phase 4.6.C):** rewrite cross-sheet refs in a formula text
crates/ql-exec/src/workbook_runtime/sheets.rs:25:/// when a sheet is renamed. Round-trips `text → lex → parse → rewrite
crates/ql-exec/src/workbook_runtime/sheets.rs:26:/// → print` so substitution is tokenization-aware (string literals,
crates/ql-exec/src/workbook_runtime/sheets.rs:27:/// quoted-sheet escapes, function calls, etc. all get the right
crates/ql-exec/src/workbook_runtime/sheets.rs:28:/// treatment).
crates/ql-exec/src/workbook_runtime/sheets.rs:29:///
crates/ql-exec/src/workbook_runtime/sheets.rs:30:/// Returns `Some(new_text)` if the rewrite changed the formula,
crates/ql-exec/src/workbook_runtime/sheets.rs:31:/// `None` otherwise (so the caller can skip the storage write +
crates/ql-exec/src/workbook_runtime/sheets.rs:32:/// op-log entry when there's nothing to record).
crates/ql-exec/src/workbook_runtime/sheets.rs:33:///
crates/ql-exec/src/workbook_runtime/sheets.rs:34:/// Defensive: if `lex` or `parse` fails (corrupted historical text),
crates/ql-exec/src/workbook_runtime/sheets.rs:35:/// returns `None` rather than propagating an error — the rename
crates/ql-exec/src/workbook_runtime/sheets.rs:36:/// shouldn't break otherwise-recoverable workbooks.
crates/ql-exec/src/workbook_runtime/sheets.rs:63:    /// **W5-92 (Phase 4.6.D):** create a new sheet,
crates/ql-exec/src/workbook_runtime/sheets.rs:64:    /// emitting `Op::AddSheet` into the attached op log (if any). Returns
crates/ql-exec/src/workbook_runtime/sheets.rs:65:    /// the new sheet's `SheetId`. Wraps `Workbook::add_sheet_with_chunk_rows`.
crates/ql-exec/src/workbook_runtime/sheets.rs:66:    ///
crates/ql-exec/src/workbook_runtime/sheets.rs:67:    /// `chunk_rows` is the per-sheet chunk size. Pass `16_384` (the engine
crates/ql-exec/src/workbook_runtime/sheets.rs:68:    /// default) unless you have a specific reason — the qbook loader uses
crates/ql-exec/src/workbook_runtime/sheets.rs:69:    /// the saved chunk_rows so layouts round-trip.
crates/ql-exec/src/workbook_runtime/sheets.rs:70:    ///
crates/ql-exec/src/workbook_runtime/sheets.rs:71:    /// Direct callers of `Workbook::add_sheet` / `add_sheet_with_chunk_rows`
crates/ql-exec/src/workbook_runtime/sheets.rs:72:    /// bypass the op log silently — that path is documented as low-level.
crates/ql-exec/src/workbook_runtime/sheets.rs:73:    /// See GAP-O-02 in `docs/known-gaps.md`.
crates/ql-exec/src/workbook_runtime/sheets.rs:124:    /// **W5-91 (Phase 4.6.C):** rename a sheet by id. Walks every
crates/ql-exec/src/workbook_runtime/sheets.rs:125:    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
crates/ql-exec/src/workbook_runtime/sheets.rs:126:    /// entry, rewrites cross-sheet references to the new sheet name via
crates/ql-exec/src/workbook_runtime/sheets.rs:127:    /// `lex → parse → rewrite → print`, emits the rewritten text + the
crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
crates/ql-exec/src/workbook_runtime/sheets.rs:129:    /// the rewrites to storage, then swaps `Sheet::name`. Bumps the
crates/ql-exec/src/workbook_runtime/sheets.rs:130:    /// `PlanCache` generation so cached bound plans miss on the next
crates/ql-exec/src/workbook_runtime/sheets.rs:131:    /// recompute.
crates/ql-exec/src/workbook_runtime/sheets.rs:132:    ///
crates/ql-exec/src/workbook_runtime/sheets.rs:133:    /// Validation: rejects empty / Excel-reserved-char / canonical-
crates/ql-exec/src/workbook_runtime/sheets.rs:134:    /// duplicate new names via `Workbook::validate_sheet_name`.
crates/ql-exec/src/workbook_runtime/sheets.rs:135:    ///
crates/ql-exec/src/workbook_runtime/sheets.rs:136:    /// **Tokenization-aware:** the parse + rewrite + print round-trip
crates/ql-exec/src/workbook_runtime/sheets.rs:137:    /// catches every sheet-qualified ref in the AST, including those
crates/ql-exec/src/workbook_runtime/sheets.rs:138:    /// inside string literals' position (it doesn't actually substitute
crates/ql-exec/src/workbook_runtime/sheets.rs:139:    /// inside `"..."` because the parser keeps those as `Expr::String`).
crates/ql-exec/src/workbook_runtime/sheets.rs:140:    /// If a formula's text fails to lex/parse (corrupt input from a
crates/ql-exec/src/workbook_runtime/sheets.rs:141:    /// historical bug), the text is left UNCHANGED — defensive against
crates/ql-exec/src/workbook_runtime/sheets.rs:142:    /// breaking otherwise-recoverable workbooks at rename time.
crates/ql-exec/src/workbook_runtime/sheets.rs:143:    ///
crates/ql-exec/src/workbook_runtime/sheets.rs:144:    /// Direct callers of `Workbook::rename_sheet` bypass formula-text
crates/ql-exec/src/workbook_runtime/sheets.rs:145:    /// rewriting + op-log recording — that path is loader-only.
crates/ql-exec/src/workbook_runtime/validate.rs:31:    /// Begin a multi-cell transaction. The returned `WorkbookTransaction`
crates/ql-exec/src/workbook_runtime/validate.rs:32:    /// borrows the runtime's workbook + registry for its lifetime. Buffer
crates/ql-exec/src/workbook_runtime/validate.rs:33:    /// writes via `put_value`/`put_formula` then call `commit` to apply them
crates/ql-exec/src/workbook_runtime/validate.rs:34:    /// atomically. See `transaction::WorkbookTransaction` for full semantics.
crates/ql-exec/src/workbook_runtime/validate.rs:35:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:36:    /// Phase 2A.3.b (2026-05-12): if the runtime was constructed with
crates/ql-exec/src/workbook_runtime/validate.rs:37:    /// `with_oplog`, the transaction inherits the op-log handle via
crates/ql-exec/src/workbook_runtime/validate.rs:38:    /// `Option::as_deref_mut` (re-borrowed for the transaction's shorter
crates/ql-exec/src/workbook_runtime/validate.rs:39:    /// lifetime). The runtime is borrow-frozen while the transaction is
crates/ql-exec/src/workbook_runtime/validate.rs:40:    /// alive, so a single op log records both individual edits and batched
crates/ql-exec/src/workbook_runtime/validate.rs:41:    /// commits without aliasing.
crates/ql-exec/src/workbook_runtime/validate.rs:50:    /// Re-evaluate every formula in the workbook. Used after `load_workbook` to
crates/ql-exec/src/workbook_runtime/validate.rs:51:    /// refresh stale values (the qbook loader stores formula text + a sentinel
crates/ql-exec/src/workbook_runtime/validate.rs:52:    /// value; this method computes the real value).
crates/ql-exec/src/workbook_runtime/validate.rs:53:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:54:    /// Iteration order is HashMap-arbitrary, so cross-cell dependencies may
crates/ql-exec/src/workbook_runtime/validate.rs:55:    /// evaluate in a non-deterministic order. Engine Phase 3 calcgraph
crates/ql-exec/src/workbook_runtime/validate.rs:56:    /// integration will add topological scheduling for deterministic + correct
crates/ql-exec/src/workbook_runtime/validate.rs:57:    /// dependency resolution (see `docs/MASTER-PLAN.md` Phase 3.4; tracked as
crates/ql-exec/src/workbook_runtime/validate.rs:58:    /// GAP-R-01 in `docs/known-gaps.md`).
crates/ql-exec/src/workbook_runtime/validate.rs:59:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:60:    /// Phase 2B.2 (2026-05-12): signature changed from `Result<usize,
crates/ql-exec/src/workbook_runtime/validate.rs:61:    /// RuntimeError>` to `RecomputeResult` (always returns; no Result
crates/ql-exec/src/workbook_runtime/validate.rs:62:    /// wrapper). The prior shape short-circuited on first failure and
crates/ql-exec/src/workbook_runtime/validate.rs:63:    /// dropped per-cell context; the new shape continues past failures
crates/ql-exec/src/workbook_runtime/validate.rs:64:    /// and aggregates them. See [`RecomputeResult`] for the contract.
crates/ql-exec/src/workbook_runtime/validate.rs:65:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:66:    /// Cells that fail structurally (lex/parse/bind) keep their
crates/ql-exec/src/workbook_runtime/validate.rs:67:    /// pre-recompute values and formula text. Cells that succeed have
crates/ql-exec/src/workbook_runtime/validate.rs:68:    /// their value replaced. Cells whose evaluation produces an Excel-
crates/ql-exec/src/workbook_runtime/validate.rs:69:    /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
crates/ql-exec/src/workbook_runtime/validate.rs:70:    /// succeeded — those error values are normal cell contents per
crates/ql-exec/src/workbook_runtime/validate.rs:71:    /// Excel canon, not structural failures.
crates/ql-exec/src/workbook_runtime/validate.rs:72:    /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
crates/ql-exec/src/workbook_runtime/validate.rs:73:    /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
crates/ql-exec/src/workbook_runtime/validate.rs:74:    /// pipeline against the current workbook state, returns the would-be
crates/ql-exec/src/workbook_runtime/validate.rs:75:    /// evaluated value (or `RuntimeError`), but does NOT:
crates/ql-exec/src/workbook_runtime/validate.rs:76:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:77:    /// - write to the workbook,
crates/ql-exec/src/workbook_runtime/validate.rs:78:    /// - append to the op log,
crates/ql-exec/src/workbook_runtime/validate.rs:79:    /// - pollute the bind-plan cache (this avoids a transient cache entry
crates/ql-exec/src/workbook_runtime/validate.rs:80:    ///   keyed on a formula text the user hasn't actually committed —
crates/ql-exec/src/workbook_runtime/validate.rs:81:    ///   would inflate the cache miss count and waste a `name_gen` slot).
crates/ql-exec/src/workbook_runtime/validate.rs:82:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:83:    /// Use case: the IDE wants to highlight syntax errors as the user types
crates/ql-exec/src/workbook_runtime/validate.rs:84:    /// in the formula bar, without committing the formula until Enter.
crates/ql-exec/src/workbook_runtime/validate.rs:85:    /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
crates/ql-exec/src/workbook_runtime/validate.rs:86:    /// safely — N calls per keystroke add no engine state.
crates/ql-exec/src/workbook_runtime/validate.rs:87:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:88:    /// Closes GAP-I-04 from `docs/known-gaps.md`.
crates/ql-exec/src/workbook_runtime/validate.rs:157:    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
crates/ql-exec/src/workbook_runtime/validate.rs:158:    /// any op-log append. Without this check, the workbook gets a sheet
crates/ql-exec/src/workbook_runtime/validate.rs:159:    /// with `chunk_rows = 0` and the first cell write panics inside the
crates/ql-exec/src/workbook_runtime/validate.rs:160:    /// column store — and the op log has a phantom AddSheet entry that
crates/ql-exec/src/workbook_runtime/validate.rs:161:    /// would replay the same poison state on next load.
crates/ql-exec/src/workbook_runtime/validate.rs:184:    /// Phase 2B.7 audit (correctness L4): `clear_formula` propagates
crates/ql-exec/src/workbook_runtime/validate.rs:185:    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
crates/ql-exec/src/workbook_runtime/validate.rs:219:    /// Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
crates/ql-exec/src/workbook_runtime/validate.rs:220:    /// pipeline but doesn't mutate the workbook or the op log. The IDE
crates/ql-exec/src/workbook_runtime/validate.rs:221:    /// can call it on every keystroke to surface diagnostics without
crates/ql-exec/src/workbook_runtime/validate.rs:222:    /// committing the user's draft.
crates/ql-exec/src/workbook_runtime/validate.rs:243:    /// `validate_formula` surfaces bind errors the same way `set_formula`
crates/ql-exec/src/workbook_runtime/validate.rs:244:    /// does — the IDE renders the same Display strings.
crates/ql-exec/src/workbook_runtime/validate.rs:256:    /// **W5-103 megaudit MEDIUM-3 closure (#129):** `validate_formula`
crates/ql-exec/src/workbook_runtime/validate.rs:257:    /// on a top-level array literal must return the anchor value
crates/ql-exec/src/workbook_runtime/validate.rs:258:    /// (array.at(0,0)), NOT `#CALC!`. Pre-fix the scalar-context
crates/ql-exec/src/workbook_runtime/validate.rs:259:    /// `eval_scalar_with_registry` path gave #CALC! for arrays,
crates/ql-exec/src/workbook_runtime/validate.rs:260:    /// making the IDE preview inconsistent with `set_formula`'s
crates/ql-exec/src/workbook_runtime/validate.rs:261:    /// actual spill behavior.
crates/ql-exec/src/workbook_runtime/validate.rs:285:    /// `validate_formula` does NOT pollute the bind-plan cache. A
crates/ql-exec/src/workbook_runtime/validate.rs:286:    /// keystroke-driven validate of a half-typed formula must not insert
crates/ql-exec/src/workbook_runtime/validate.rs:287:    /// a cache entry that would mismatch when the user finally hits Enter.
crates/ql-exec/src/workbook_runtime/validate.rs:308:    /// Phase 2B.7 audit (correctness M1): `is_aggregate_function` must
crates/ql-exec/src/workbook_runtime/validate.rs:309:    /// only list functions actually registered. Cross-check against the
crates/ql-exec/src/workbook_runtime/validate.rs:310:    /// default registry; a mismatch means the binder will surface
crates/ql-exec/src/workbook_runtime/validate.rs:311:    /// `NamedRangeInScalarContext` for what looked like a valid aggregate
crates/ql-exec/src/workbook_runtime/validate.rs:312:    /// (or vice versa).
crates/ql-exec/src/workbook_runtime/validate.rs:436:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
crates/ql-exec/src/workbook_runtime/validate.rs:437:    /// Opus HIGH-1 / HIGH-3):** prove that the 28 range-aware fns
crates/ql-exec/src/workbook_runtime/validate.rs:438:    /// admitted to `is_aggregate_function` in this closure actually
crates/ql-exec/src/workbook_runtime/validate.rs:439:    /// route range args through `AggregateNameRef` end-to-end, not just
crates/ql-exec/src/workbook_runtime/validate.rs:440:    /// pass the registry-lookup smoke test. This is the e2e armor the
crates/ql-exec/src/workbook_runtime/validate.rs:441:    /// W5-D-12 SUBTOTAL closure should have had but didn't, scaled to
crates/ql-exec/src/workbook_runtime/validate.rs:442:    /// cover the systemic case.
crates/ql-exec/src/workbook_runtime/validate.rs:443:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:444:    /// Each test sets up a named range, then drives a formula through
crates/ql-exec/src/workbook_runtime/validate.rs:445:    /// `set_formula` (which exercises lex → parse → bind → eval). A
crates/ql-exec/src/workbook_runtime/validate.rs:446:    /// pre-W5-D-13.1 build would fail every one of these with
crates/ql-exec/src/workbook_runtime/validate.rs:447:    /// `Bind(NamedRangeInScalarContext("SALES"))`.
crates/ql-exec/src/workbook_runtime/validate.rs:597:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
crates/ql-exec/src/workbook_runtime/validate.rs:598:    /// / Opus MEDIUM-5):** the original
crates/ql-exec/src/workbook_runtime/validate.rs:599:    /// `is_aggregate_function_lists_only_registered_aggregates` invariant
crates/ql-exec/src/workbook_runtime/validate.rs:600:    /// pins only ONE direction (matcher → registry). The OPPOSITE
crates/ql-exec/src/workbook_runtime/validate.rs:601:    /// direction (registry → matcher) was NEVER enforced, which is
crates/ql-exec/src/workbook_runtime/validate.rs:602:    /// exactly why the W5-D-12 closure shipped a SUBTOTAL-only fix
crates/ql-exec/src/workbook_runtime/validate.rs:603:    /// without anyone noticing that 28 other range-aware fns had the
crates/ql-exec/src/workbook_runtime/validate.rs:604:    /// same admission gap.
crates/ql-exec/src/workbook_runtime/validate.rs:605:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:606:    /// This invariant fills the gap: every range-aware-registered fn
crates/ql-exec/src/workbook_runtime/validate.rs:607:    /// MUST be admitted by `is_aggregate_function`. Some range-aware
crates/ql-exec/src/workbook_runtime/validate.rs:608:    /// fns may legitimately NOT need range args (none currently), so
crates/ql-exec/src/workbook_runtime/validate.rs:609:    /// this is enforced as an allowlist of EXCEPTIONS — fns that are
crates/ql-exec/src/workbook_runtime/validate.rs:610:    /// range-aware-registered but deliberately not admitted.
crates/ql-exec/src/workbook_runtime/validate.rs:611:    ///
crates/ql-exec/src/workbook_runtime/validate.rs:612:    /// If a future range-aware fn is registered with scalar-only args
crates/ql-exec/src/workbook_runtime/validate.rs:613:    /// (no range args needed at all), it must be added to
crates/ql-exec/src/workbook_runtime/validate.rs:614:    /// `range_aware_fns_that_do_not_need_aggregate_admission` below
crates/ql-exec/src/workbook_runtime/validate.rs:615:    /// with a justification.
crates/ql-exec/src/workbook_runtime/validate.rs:648:    /// Phase 2B.7 audit closure (test gaps #5 and #6): the existing NAG
crates/ql-exec/src/workbook_runtime/validate.rs:649:    /// tests don't exercise nested aggregates with named ranges. Ensure
crates/ql-exec/src/workbook_runtime/validate.rs:650:    /// `SUM(AVERAGE(Sales))` (both aggregate; inner is the named-range arg)
crates/ql-exec/src/workbook_runtime/validate.rs:651:    /// and `ROUND(SUM(Sales), 2)` (outer scalar, inner aggregate with the
crates/ql-exec/src/workbook_runtime/validate.rs:652:    /// named range) both bind cleanly to the appropriate plan shapes.
crates/ql-exec/src/workbook_runtime/validate.rs:695:    /// Phase 2B.7 audit (cleanup): after dropping the redundant
crates/ql-exec/src/workbook_runtime/validate.rs:696:    /// `RecomputeResult.partial_state` pub field, `is_complete()` is the
crates/ql-exec/src/workbook_runtime/validate.rs:697:    /// single source of truth.
crates/ql-exec/src/workbook_runtime/config.rs:20:    /// **W5-146 (Phase 4.9.K):** set the workbook's reference mode
crates/ql-exec/src/workbook_runtime/config.rs:21:    /// (A1 or R1C1) and append `Op::SetReferenceMode` to the op-log.
crates/ql-exec/src/workbook_runtime/config.rs:22:    /// Idempotent — setting to the current value is a no-op that
crates/ql-exec/src/workbook_runtime/config.rs:23:    /// emits NO op (keeps the log compact).
crates/ql-exec/src/workbook_runtime/config.rs:24:    ///
crates/ql-exec/src/workbook_runtime/config.rs:25:    /// Per design § 4.4 storage canon, formula text is stored in
crates/ql-exec/src/workbook_runtime/config.rs:26:    /// canonical A1 form regardless of `mode`; this setting only
crates/ql-exec/src/workbook_runtime/config.rs:27:    /// affects how the IDE renders formulas to the user and how
crates/ql-exec/src/workbook_runtime/config.rs:28:    /// future calls to `set_formula(text)` interpret the input
crates/ql-exec/src/workbook_runtime/config.rs:29:    /// reference syntax.
crates/ql-exec/src/workbook_runtime/config.rs:46:    /// **W5-146 (Phase 4.9.K):** set the workbook's locale (EnUs /
crates/ql-exec/src/workbook_runtime/config.rs:47:    /// De / Fr) and append `Op::SetLocale` to the op-log.
crates/ql-exec/src/workbook_runtime/config.rs:48:    /// Idempotent — setting to the current value emits no op.
crates/ql-exec/src/workbook_runtime/config.rs:49:    ///
crates/ql-exec/src/workbook_runtime/config.rs:50:    /// Per design § 4.4 storage canon, formula text is stored in
crates/ql-exec/src/workbook_runtime/config.rs:51:    /// EN-locale form regardless of this setting; this setting only
crates/ql-exec/src/workbook_runtime/config.rs:52:    /// affects how the IDE renders formulas to the user (decimal
crates/ql-exec/src/workbook_runtime/config.rs:53:    /// separator, argument separator, array separators) and how
crates/ql-exec/src/workbook_runtime/config.rs:54:    /// future calls to `set_formula(text)` interpret input
crates/ql-exec/src/workbook_runtime/config.rs:55:    /// glyphs.
crates/ql-exec/src/workbook_runtime/formats.rs:29:    /// **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
crates/ql-exec/src/workbook_runtime/formats.rs:30:    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
crates/ql-exec/src/workbook_runtime/formats.rs:31:    /// op log if (and only if) the call allocated a NEW id. Returns the
crates/ql-exec/src/workbook_runtime/formats.rs:32:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
crates/ql-exec/src/workbook_runtime/formats.rs:33:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:34:    /// Idempotent on repeated calls with the same string — the second
crates/ql-exec/src/workbook_runtime/formats.rs:35:    /// call returns the same id without emitting a duplicate op. This
crates/ql-exec/src/workbook_runtime/formats.rs:36:    /// keeps the op log compact and replay deterministic.
crates/ql-exec/src/workbook_runtime/formats.rs:37:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:38:    /// Direct callers of `Workbook::formats_mut().intern()` bypass the
crates/ql-exec/src/workbook_runtime/formats.rs:39:    /// op log silently; that path is documented as low-level and intended
crates/ql-exec/src/workbook_runtime/formats.rs:40:    /// for the qbook loader + tests + engine-internal reconstruction.
crates/ql-exec/src/workbook_runtime/formats.rs:66:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
crates/ql-exec/src/workbook_runtime/formats.rs:67:    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
crates/ql-exec/src/workbook_runtime/formats.rs:68:    /// to the op log. Sheet/row/col are validated; `id = Some(...)` that
crates/ql-exec/src/workbook_runtime/formats.rs:69:    /// references an unknown id is REFUSED (matching replay's
crates/ql-exec/src/workbook_runtime/formats.rs:70:    /// `FormatNotRegistered` semantic — producer-side enforcement is
crates/ql-exec/src/workbook_runtime/formats.rs:71:    /// the cleaner spot for the check).
crates/ql-exec/src/workbook_runtime/formats.rs:72:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:73:    /// Direct callers of `Sheet::format_overlay_mut()` bypass the op
crates/ql-exec/src/workbook_runtime/formats.rs:74:    /// log silently; that path is documented as low-level.
crates/ql-exec/src/workbook_runtime/formats.rs:116:    /// **W5-82 (Phase 4.5.D part 6):** read a cell and render it through
crates/ql-exec/src/workbook_runtime/formats.rs:117:    /// its `FormatId` binding (or `General` if unbound). Returns the
crates/ql-exec/src/workbook_runtime/formats.rs:118:    /// final display string the IDE would show. The runtime's
crates/ql-exec/src/workbook_runtime/formats.rs:119:    /// `EvalContext` (date system, locale, now-provider) drives
crates/ql-exec/src/workbook_runtime/formats.rs:120:    /// date/time rendering.
crates/ql-exec/src/workbook_runtime/formats.rs:121:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:122:    /// Lookup chain per call:
crates/ql-exec/src/workbook_runtime/formats.rs:123:    ///   1. cell's raw `Value` (cheap; lives on the storage hot path)
crates/ql-exec/src/workbook_runtime/formats.rs:124:    ///   2. format id from sheet's `CellFormatOverlay` (None → General)
crates/ql-exec/src/workbook_runtime/formats.rs:125:    ///   3. parsed `FormatString` from `format_cache` (parse + insert on miss)
crates/ql-exec/src/workbook_runtime/formats.rs:126:    ///   4. `format::render(&value, &fmt, &ctx)` → `String`
crates/ql-exec/src/workbook_runtime/formats.rs:127:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:128:    /// If the cell's format references an id that's missing from the
crates/ql-exec/src/workbook_runtime/formats.rs:129:    /// `FormatTable` (corrupted state — should not happen in practice
crates/ql-exec/src/workbook_runtime/formats.rs:130:    /// because `set_cell_format` refuses unknown ids), falls back to
crates/ql-exec/src/workbook_runtime/formats.rs:131:    /// `General` rendering. If the format string fails to parse,
crates/ql-exec/src/workbook_runtime/formats.rs:132:    /// falls back to `General` and the renderer never errors.
crates/ql-exec/src/workbook_runtime/formats.rs:133:    ///
crates/ql-exec/src/workbook_runtime/formats.rs:134:    /// **W5-84 closure (Codex MEDIUM-2) cache-staleness caveat:** the
crates/ql-exec/src/workbook_runtime/formats.rs:135:    /// `format_cache` is keyed by `FormatId` and populated on first
crates/ql-exec/src/workbook_runtime/formats.rs:136:    /// `read_display` for that id. `FormatTable::register_at` rejects
crates/ql-exec/src/workbook_runtime/formats.rs:137:    /// id→string mutations, so cached entries stay correct for the
crates/ql-exec/src/workbook_runtime/formats.rs:138:    /// runtime's lifetime under the runtime's own append-only
crates/ql-exec/src/workbook_runtime/formats.rs:139:    /// `intern_format` path. HOWEVER, the low-level
crates/ql-exec/src/workbook_runtime/formats.rs:140:    /// `Workbook::formats_mut()` accessor (loader-only by convention but
crates/ql-exec/src/workbook_runtime/formats.rs:141:    /// `pub` for the qbook loader + tests) can register a new id AFTER
crates/ql-exec/src/workbook_runtime/formats.rs:142:    /// `read_display` has cached the General fallback for that id. In
crates/ql-exec/src/workbook_runtime/formats.rs:143:    /// that pathological sequence the cache will continue rendering
crates/ql-exec/src/workbook_runtime/formats.rs:144:    /// General until the runtime is rebuilt. Analogous to the
crates/ql-exec/src/workbook_runtime/formats.rs:145:    /// `WorkbookEnv` date-system caveat documented on
crates/ql-exec/src/workbook_runtime/formats.rs:146:    /// `Workbook::set_date_system`. Tracked as GAP-F-12 in
crates/ql-exec/src/workbook_runtime/formats.rs:147:    /// `docs/known-gaps.md`.
crates/ql-exec/src/workbook_runtime/tables.rs:40:    /// **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
crates/ql-exec/src/workbook_runtime/tables.rs:41:    /// emitting `Op::CreateTable` into the attached op log (if any).
crates/ql-exec/src/workbook_runtime/tables.rs:42:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:43:    /// Validation (op log append is BEFORE storage mutation per the
crates/ql-exec/src/workbook_runtime/tables.rs:44:    /// W5-103 atomicity pattern):
crates/ql-exec/src/workbook_runtime/tables.rs:45:    /// - Sheet exists.
crates/ql-exec/src/workbook_runtime/tables.rs:46:    /// - Footprint fits in the sheet (rows + cols > 0).
crates/ql-exec/src/workbook_runtime/tables.rs:47:    /// - No overlap with any existing table footprint.
crates/ql-exec/src/workbook_runtime/tables.rs:48:    /// - Name is unique against both `TableTable` AND `NameTable`
crates/ql-exec/src/workbook_runtime/tables.rs:49:    ///   (shared namespace per design § 4.3 / § 13 decision #3).
crates/ql-exec/src/workbook_runtime/tables.rs:50:    /// - Column count matches `column_names.len()`.
crates/ql-exec/src/workbook_runtime/tables.rs:51:    /// - Column names are non-empty and unique case-insensitively.
crates/ql-exec/src/workbook_runtime/tables.rs:52:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:53:    /// Each column is assigned a stable id from
crates/ql-exec/src/workbook_runtime/tables.rs:54:    /// `TableTable::allocate_column_id`. Header / totals rows are
crates/ql-exec/src/workbook_runtime/tables.rs:55:    /// metadata-only — this method does NOT write into the header row;
crates/ql-exec/src/workbook_runtime/tables.rs:56:    /// callers can pre-populate cells via `set_value`.
crates/ql-exec/src/workbook_runtime/tables.rs:57:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:58:    /// Direct callers of `Workbook::tables_mut().insert` bypass the op
crates/ql-exec/src/workbook_runtime/tables.rs:59:    /// log silently — that path is documented as low-level (qbook
crates/ql-exec/src/workbook_runtime/tables.rs:60:    /// loader + tests).
crates/ql-exec/src/workbook_runtime/tables.rs:203:    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
crates/ql-exec/src/workbook_runtime/tables.rs:204:    /// the table footprint are untouched. Formulas referencing the
crates/ql-exec/src/workbook_runtime/tables.rs:205:    /// dropped table re-bind to `BindError::UnknownTable` on next
crates/ql-exec/src/workbook_runtime/tables.rs:206:    /// recompute. Emits `Op::DropTable` to the attached op log (if any).
crates/ql-exec/src/workbook_runtime/tables.rs:207:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:208:    /// **W5-155 (Phase 4.8.G.3):** also fires the calcgraph's
crates/ql-exec/src/workbook_runtime/tables.rs:209:    /// `on_table_drop` hook (W5-154) so formulas previously
crates/ql-exec/src/workbook_runtime/tables.rs:210:    /// referencing this table get BFS-dirty-fanned. Pre-W5-155 the
crates/ql-exec/src/workbook_runtime/tables.rs:211:    /// drop completed without notifying the calcgraph — formulas
crates/ql-exec/src/workbook_runtime/tables.rs:212:    /// with cached `ExprPlan::StructuredRef` plans would continue
crates/ql-exec/src/workbook_runtime/tables.rs:213:    /// reading the (now-untyped) cell range until something else
crates/ql-exec/src/workbook_runtime/tables.rs:214:    /// invalidated them. Post-W5-155 the hook fires:
crates/ql-exec/src/workbook_runtime/tables.rs:215:    /// 1. `table_to_formulas[name]` enumerates the readers.
crates/ql-exec/src/workbook_runtime/tables.rs:216:    /// 2. Each reader marked dirty + BFS-fanout (W5-91 H2 pattern).
crates/ql-exec/src/workbook_runtime/tables.rs:217:    /// 3. Next recompute re-binds → `BindError::UnknownTable` →
crates/ql-exec/src/workbook_runtime/tables.rs:218:    ///    `Value::Error(#NAME?)` per the existing 4.8.F binder.
crates/ql-exec/src/workbook_runtime/tables.rs:219:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:220:    /// The hook fires AFTER the op-log append (atomic with the
crates/ql-exec/src/workbook_runtime/tables.rs:221:    /// mutation, per W5-103) and BEFORE `tables_mut().remove`
crates/ql-exec/src/workbook_runtime/tables.rs:222:    /// (graph fanout is read-only on workbook state; the order
crates/ql-exec/src/workbook_runtime/tables.rs:223:    /// is irrelevant for correctness but matches the pre-existing
crates/ql-exec/src/workbook_runtime/tables.rs:224:    /// rename/resize convention).
crates/ql-exec/src/workbook_runtime/tables.rs:259:    /// **W5-119 (Phase 4.8.I):** rename a table. Per design § 12.2 + HIGH-1
crates/ql-exec/src/workbook_runtime/tables.rs:260:    /// closure (Codex pass-1), this REWRITES STORED FORMULA TEXT — Excel
crates/ql-exec/src/workbook_runtime/tables.rs:261:    /// canon: the next bind sees the new name and binds successfully.
crates/ql-exec/src/workbook_runtime/tables.rs:262:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:263:    /// Process:
crates/ql-exec/src/workbook_runtime/tables.rs:264:    /// 1. Validate: source exists; target name available (TableTable +
crates/ql-exec/src/workbook_runtime/tables.rs:265:    ///    NameTable shared namespace); not a no-op (same canonical name).
crates/ql-exec/src/workbook_runtime/tables.rs:266:    /// 2. Op-log append `Op::RenameTable` (before any mutation).
crates/ql-exec/src/workbook_runtime/tables.rs:267:    /// 3. Walk every formula cell; parse the text; rewrite via
crates/ql-exec/src/workbook_runtime/tables.rs:268:    ///    `ast::rewrite_table_ref`; if the AST changed, print it back
crates/ql-exec/src/workbook_runtime/tables.rs:269:    ///    and emit `Op::PutFormula` + update storage.
crates/ql-exec/src/workbook_runtime/tables.rs:270:    /// 4. Re-key the `TableTable` entry from old canonical to new
crates/ql-exec/src/workbook_runtime/tables.rs:271:    ///    canonical; update display_name.
crates/ql-exec/src/workbook_runtime/tables.rs:272:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:273:    /// Returns the number of formula cells whose text was rewritten.
crates/ql-exec/src/workbook_runtime/tables.rs:274:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:275:    /// **Tier D1 Step 3.2 doc-attachment fix:** the doc block above
crates/ql-exec/src/workbook_runtime/tables.rs:276:    /// was previously misattached to `set_reference_mode` because
crates/ql-exec/src/workbook_runtime/tables.rs:277:    /// that fn was inserted between this comment and `rename_table`.
crates/ql-exec/src/workbook_runtime/tables.rs:278:    /// Step 3.2 moved the config setters to `config.rs`, so the doc
crates/ql-exec/src/workbook_runtime/tables.rs:279:    /// now reaches its intended target.
crates/ql-exec/src/workbook_runtime/tables.rs:379:    /// **W5-121 (Phase 4.8.I.2):** rename a column within an existing
crates/ql-exec/src/workbook_runtime/tables.rs:380:    /// table. Mirrors [`Self::rename_table`] semantics for column refs:
crates/ql-exec/src/workbook_runtime/tables.rs:381:    /// rewrites stored formula text in every cell whose StructuredRef
crates/ql-exec/src/workbook_runtime/tables.rs:382:    /// references the renamed column (Excel canon — the next bind sees
crates/ql-exec/src/workbook_runtime/tables.rs:383:    /// the new name).
crates/ql-exec/src/workbook_runtime/tables.rs:384:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:385:    /// Process:
crates/ql-exec/src/workbook_runtime/tables.rs:386:    /// 1. Validate: table exists; source column exists (case-insensitive);
crates/ql-exec/src/workbook_runtime/tables.rs:387:    ///    target name available within the table; non-empty; not a no-op
crates/ql-exec/src/workbook_runtime/tables.rs:388:    ///    (same lowercase canonical).
crates/ql-exec/src/workbook_runtime/tables.rs:389:    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
crates/ql-exec/src/workbook_runtime/tables.rs:390:    /// 3. Walk every formula cell; parse the text; rewrite via
crates/ql-exec/src/workbook_runtime/tables.rs:391:    ///    `ast::rewrite_column_ref` (scoped to refs matching the
crates/ql-exec/src/workbook_runtime/tables.rs:392:    ///    canonical table name); if the AST changed, print + emit
crates/ql-exec/src/workbook_runtime/tables.rs:393:    ///    `Op::PutFormula` + update storage.
crates/ql-exec/src/workbook_runtime/tables.rs:394:    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
crates/ql-exec/src/workbook_runtime/tables.rs:395:    ///    `name` and case-preserving `display`; bump TableTable
crates/ql-exec/src/workbook_runtime/tables.rs:396:    ///    generation so plan caches invalidate.
crates/ql-exec/src/workbook_runtime/tables.rs:397:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:398:    /// Returns the number of formula cells whose text was rewritten.
crates/ql-exec/src/workbook_runtime/tables.rs:399:    /// Cross-table isolation: structured refs to OTHER tables pass
crates/ql-exec/src/workbook_runtime/tables.rs:400:    /// through unchanged even when they mention a column with the same
crates/ql-exec/src/workbook_runtime/tables.rs:401:    /// name. Same-canonical rename returns `Ok(0)` without emitting an
crates/ql-exec/src/workbook_runtime/tables.rs:402:    /// op (mirrors [`Self::rename_table`]).
crates/ql-exec/src/workbook_runtime/tables.rs:527:    /// **W5-122 (Phase 4.8.J):** resize a table's footprint per
crates/ql-exec/src/workbook_runtime/tables.rs:528:    /// design § 12.3. Three scenarios are supported by a single op:
crates/ql-exec/src/workbook_runtime/tables.rs:529:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:530:    /// - **Grow / shrink rows:** common path. Pass `added_columns =
crates/ql-exec/src/workbook_runtime/tables.rs:531:    ///   removed_columns = []` and the new row count.
crates/ql-exec/src/workbook_runtime/tables.rs:532:    /// - **Append column(s) at the END:** list each new display name
crates/ql-exec/src/workbook_runtime/tables.rs:533:    ///   in `added_columns`; column ids are freshly allocated.
crates/ql-exec/src/workbook_runtime/tables.rs:534:    /// - **Truncate trailing column(s):** list each in
crates/ql-exec/src/workbook_runtime/tables.rs:535:    ///   `removed_columns` in their current left-to-right order
crates/ql-exec/src/workbook_runtime/tables.rs:536:    ///   (case-insensitive on display).
crates/ql-exec/src/workbook_runtime/tables.rs:537:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:538:    /// Inserting / removing a column in the MIDDLE is NOT supported in
crates/ql-exec/src/workbook_runtime/tables.rs:539:    /// 4.8 (Phase 5 structural edits — requires physical cell move).
crates/ql-exec/src/workbook_runtime/tables.rs:540:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:541:    /// Validation (all BEFORE op-log append per W5-103 atomicity):
crates/ql-exec/src/workbook_runtime/tables.rs:542:    /// - Table exists.
crates/ql-exec/src/workbook_runtime/tables.rs:543:    /// - `new_rows > 0` AND `new_cols > 0`.
crates/ql-exec/src/workbook_runtime/tables.rs:544:    /// - `removed_columns.len() <= old_cols`.
crates/ql-exec/src/workbook_runtime/tables.rs:545:    /// - Arithmetic: `new_cols == old_cols + added.len() - removed.len()`.
crates/ql-exec/src/workbook_runtime/tables.rs:546:    /// - `removed_columns` exactly match trailing columns (case-insensitive).
crates/ql-exec/src/workbook_runtime/tables.rs:547:    /// - `added_columns`: non-empty entries; final roster has unique
crates/ql-exec/src/workbook_runtime/tables.rs:548:    ///   canonical (lowercase) names.
crates/ql-exec/src/workbook_runtime/tables.rs:549:    /// - New footprint cells outside the OLD footprint don't overlap
crates/ql-exec/src/workbook_runtime/tables.rs:550:    ///   another table.
crates/ql-exec/src/workbook_runtime/tables.rs:551:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:552:    /// NOTE: a spill-anchor check inside the new footprint is
crates/ql-exec/src/workbook_runtime/tables.rs:553:    /// intentionally OMITTED to mirror `create_table`, which doesn't
crates/ql-exec/src/workbook_runtime/tables.rs:554:    /// check either. The runtime invariant § 4.3 #5 is enforced at
crates/ql-exec/src/workbook_runtime/tables.rs:555:    /// `write_spill` time today; closing this uniformly across
crates/ql-exec/src/workbook_runtime/tables.rs:556:    /// create+resize is a separate follow-up.
crates/ql-exec/src/workbook_runtime/tables.rs:557:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:558:    /// No formula-text rewriting: resize doesn't change column NAMES
crates/ql-exec/src/workbook_runtime/tables.rs:559:    /// of surviving columns, so existing references stay valid.
crates/ql-exec/src/workbook_runtime/tables.rs:560:    /// Re-binding picks up the new range/columns on next eval via the
crates/ql-exec/src/workbook_runtime/tables.rs:561:    /// cleared plan cache.
crates/ql-exec/src/workbook_runtime/tables.rs:562:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:563:    /// **W5-159 (Phase 4.8.G.3):** resize bumps `TableTable::generation`,
crates/ql-exec/src/workbook_runtime/tables.rs:564:    /// clears the plan cache, **re-extracts deps for every table reader**
crates/ql-exec/src/workbook_runtime/tables.rs:565:    /// (via [`Self::reextract_table_readers`] so range stripes reflect
crates/ql-exec/src/workbook_runtime/tables.rs:566:    /// the new range — critical: pre-W5-159 a write into the new growth
crates/ql-exec/src/workbook_runtime/tables.rs:567:    /// area silently missed the formula's stripe), and fires the
crates/ql-exec/src/workbook_runtime/tables.rs:568:    /// [`CalcgraphSession::on_table_resize`] hook to BFS-dirty-fan
crates/ql-exec/src/workbook_runtime/tables.rs:569:    /// downstream readers. Downstream evaluation via
crates/ql-exec/src/workbook_runtime/tables.rs:570:    /// [`Self::recompute_dirty`] then refreshes the `COMPUTED` overlay
crates/ql-exec/src/workbook_runtime/tables.rs:571:    /// against the new metadata. With no graph attached, the
crates/ql-exec/src/workbook_runtime/tables.rs:572:    /// `reextract_table_readers` step is a no-op and callers must use
crates/ql-exec/src/workbook_runtime/tables.rs:573:    /// [`Self::recompute_all`] to pick up post-resize changes.
crates/ql-exec/src/workbook_runtime/tables.rs:779:    /// **W5-159 (Phase 4.8.G.3):** re-bind every formula registered
crates/ql-exec/src/workbook_runtime/tables.rs:780:    /// against `table_canonical` and call `reextract_deps` so the
crates/ql-exec/src/workbook_runtime/tables.rs:781:    /// calcgraph's range-stripe state matches the new resolved range.
crates/ql-exec/src/workbook_runtime/tables.rs:782:    /// Used after `resize_table` mutates `TableMetadata.rows`/`.cols`.
crates/ql-exec/src/workbook_runtime/tables.rs:783:    ///
crates/ql-exec/src/workbook_runtime/tables.rs:784:    /// Pattern mirrors `reextract_spill_footprint_readers` (W5-103):
crates/ql-exec/src/workbook_runtime/tables.rs:785:    /// step 1 collects readers under an immutable graph borrow; step 2
crates/ql-exec/src/workbook_runtime/tables.rs:786:    /// re-binds + re-extracts under alternating immutable workbook /
crates/ql-exec/src/workbook_runtime/tables.rs:787:    /// mutable graph borrows. A bind failure (e.g., a column was
crates/ql-exec/src/workbook_runtime/tables.rs:788:    /// removed by the resize) marks the reader dirty so
crates/ql-exec/src/workbook_runtime/tables.rs:789:    /// `recompute_dirty`'s W5-156 bind-error mapping produces `#NAME?`
crates/ql-exec/src/workbook_runtime/tables.rs:790:    /// at the cell.
crates/ql-exec/src/workbook_runtime/tables.rs:878:    /// **First end-to-end test for Phase 4.8 structured refs.** Set up a
crates/ql-exec/src/workbook_runtime/tables.rs:879:    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert
crates/ql-exec/src/workbook_runtime/tables.rs:880:    /// the result matches a hand-summed value. Exercises:
crates/ql-exec/src/workbook_runtime/tables.rs:881:    /// - 4.8.A: TableMetadata + Workbook::tables_mut().insert.
crates/ql-exec/src/workbook_runtime/tables.rs:882:    /// - 4.8.B: lexer Token::StructuredRef.
crates/ql-exec/src/workbook_runtime/tables.rs:883:    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
crates/ql-exec/src/workbook_runtime/tables.rs:884:    /// - 4.8.E: BindSite plumbing (cell address carried).
crates/ql-exec/src/workbook_runtime/tables.rs:885:    /// - 4.8.F: TableLookup blanket impl + ExprPlan::StructuredRef
crates/ql-exec/src/workbook_runtime/tables.rs:886:    ///   resolution against TableTable.
crates/ql-exec/src/workbook_runtime/tables.rs:887:    /// - 4.8.G: eval-side StructuredRef arm in scalar.rs aggregate path.
crates/ql-exec/src/workbook_runtime/tables.rs:931:    /// **Phase 4.8.G.2 e2e:** `[@Qty]` shorthand inside a table data
crates/ql-exec/src/workbook_runtime/tables.rs:932:    /// cell resolves to the same-row's Qty value. Pins eval-time row
crates/ql-exec/src/workbook_runtime/tables.rs:933:    /// narrowing via `WorkbookEnv::with_formula_cell`.
crates/ql-exec/src/workbook_runtime/tables.rs:984:    /// **Phase 4.8.G.2 e2e:** `[@Qty]` typed OUTSIDE the table's data
crates/ql-exec/src/workbook_runtime/tables.rs:985:    /// rows → `#VALUE!` per Excel canon. Validates the
crates/ql-exec/src/workbook_runtime/tables.rs:986:    /// `narrow_structured_ref` out-of-range guard.
crates/ql-exec/src/workbook_runtime/tables.rs:1159:    /// **W5-157 (Phase 4.8.G.3):** `rename_table` fires
crates/ql-exec/src/workbook_runtime/tables.rs:1160:    /// `on_table_rename` so the calcgraph reverse index re-keys
crates/ql-exec/src/workbook_runtime/tables.rs:1161:    /// from OLD → NEW. A subsequent `drop_table(NEW)` must then
crates/ql-exec/src/workbook_runtime/tables.rs:1162:    /// produce `#NAME?` at the reader. Without the hook, the
crates/ql-exec/src/workbook_runtime/tables.rs:1163:    /// index stays under OLD and `drop_table(NEW)` would miss
crates/ql-exec/src/workbook_runtime/tables.rs:1164:    /// every previously-bound formula.
crates/ql-exec/src/workbook_runtime/tables.rs:1519:    /// **W5-158 (Phase 4.8.G.3):** `rename_column` fires the
crates/ql-exec/src/workbook_runtime/tables.rs:1520:    /// `on_column_rename` hook → readers are in the dirty set →
crates/ql-exec/src/workbook_runtime/tables.rs:1521:    /// `recompute_dirty` re-binds them against the new column
crates/ql-exec/src/workbook_runtime/tables.rs:1522:    /// name. The cell value is unchanged (same column index, same
crates/ql-exec/src/workbook_runtime/tables.rs:1523:    /// data range; VEQ suppresses the write) but the hook
crates/ql-exec/src/workbook_runtime/tables.rs:1524:    /// observability + dirty/clean state are correct.
crates/ql-exec/src/workbook_runtime/tables.rs:1617:    /// **W5-159 (Phase 4.8.G.3):** the correctness bug the hook +
crates/ql-exec/src/workbook_runtime/tables.rs:1618:    /// re-extract closes. After `resize_table` grows the data range,
crates/ql-exec/src/workbook_runtime/tables.rs:1619:    /// a cell write into the NEW row (outside the OLD range) must
crates/ql-exec/src/workbook_runtime/tables.rs:1620:    /// dirty the formula via the calcgraph's range stripe and
crates/ql-exec/src/workbook_runtime/tables.rs:1621:    /// `recompute_dirty` must pick it up. Pre-W5-159 the stripe
crates/ql-exec/src/workbook_runtime/tables.rs:1622:    /// stayed registered at the OLD range; the write silently missed;
crates/ql-exec/src/workbook_runtime/tables.rs:1623:    /// the formula kept its post-resize-but-pre-write value
crates/ql-exec/src/workbook_runtime/tables.rs:1624:    /// indefinitely (until something else dirtied it). The
crates/ql-exec/src/workbook_runtime/tables.rs:1625:    /// `recompute_all` path in the existing W5-122 test happened to
crates/ql-exec/src/workbook_runtime/tables.rs:1626:    /// work because full passes don't rely on stripes — so this gap
crates/ql-exec/src/workbook_runtime/tables.rs:1627:    /// only surfaces on the incremental path.
crates/ql-exec/src/workbook_runtime/tables.rs:1791:    /// **W5-159 / W5-156 (Phase 4.8.G.3 — Codex closing-megaudit LOW
crates/ql-exec/src/workbook_runtime/tables.rs:1792:    /// closure):** resize removing a column that a formula references
crates/ql-exec/src/workbook_runtime/tables.rs:1793:    /// must (a) reach the formula via `reextract_table_readers`
crates/ql-exec/src/workbook_runtime/tables.rs:1794:    /// (re-bind fails with UnknownTableColumn → mark_dirty), and
crates/ql-exec/src/workbook_runtime/tables.rs:1795:    /// (b) be mapped to `#NAME?` by recompute_dirty's W5-156 failure
crates/ql-exec/src/workbook_runtime/tables.rs:1796:    /// arm. End-to-end this proves the W5-156 + W5-159 mapping covers
crates/ql-exec/src/workbook_runtime/tables.rs:1797:    /// `UnknownTableColumn` in addition to `UnknownTable`.
crates/ql-exec/src/workbook_runtime/tables.rs:2020:    /// **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op resize
crates/ql-exec/src/workbook_runtime/tables.rs:2021:    /// (same dims, no column changes) returns `Ok(())` without
crates/ql-exec/src/workbook_runtime/tables.rs:2022:    /// emitting an `Op::ResizeTable`. Mirrors `rename_column`'s
crates/ql-exec/src/workbook_runtime/tables.rs:2023:    /// same-canonical no-op contract — caller-visible behavior is
crates/ql-exec/src/workbook_runtime/tables.rs:2024:    /// unchanged but the op log stays compact.
crates/ql-exec/src/workbook_runtime/tables.rs:2059:    /// **End-to-end with op log**: create_table emits Op::CreateTable;
crates/ql-exec/src/workbook_runtime/tables.rs:2060:    /// SUM(Sales[Qty]) using the just-created table works. Validates
crates/ql-exec/src/workbook_runtime/tables.rs:2061:    /// the runtime API end-to-end.
crates/ql-exec/src/workbook_runtime/tables.rs:2077:    /// AVERAGE through the same path — confirms the cache fast path
crates/ql-exec/src/workbook_runtime/tables.rs:2078:    /// works for StructuredRef single-arg (not just SUM).
crates/ql-exec/src/workbook_runtime/tables.rs:2118:    /// **R1C1 input canonicalizes to A1 in storage.** When the
crates/ql-exec/src/workbook_runtime/tables.rs:2119:    /// workbook is in R1C1 mode and user types `R1C1`, the stored
crates/ql-exec/src/workbook_runtime/tables.rs:2120:    /// formula text is `$A$1` (A1+EnUs canon).
crates/ql-exec/src/workbook_runtime/tables.rs:2137:    /// **Relative R1C1 canonicalizes using the formula's own cell
crates/ql-exec/src/workbook_runtime/tables.rs:2138:    /// as anchor.** `R[-1]C` at cell (1, 0) → `A1` (no `$` — relative
crates/ql-exec/src/workbook_runtime/tables.rs:2139:    /// R1C1 ↔ unprefixed A1).
crates/ql-exec/src/workbook_runtime/tables.rs:2153:    /// **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
crates/ql-exec/src/workbook_runtime/tables.rs:2154:    /// (DE — `,` decimal, `;` arg sep) → `SUM(2.5, 3.5)` (EN canon).
crates/ql-exec/src/workbook_runtime/tables.rs:2169:    /// **`@A1` (implicit intersection) survives canonicalization.**
crates/ql-exec/src/workbook_runtime/tables.rs:2170:    /// The `@` operator is mode + locale invariant per design § 3.3.
crates/ql-exec/src/workbook_runtime/error.rs:23:/// Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
crates/ql-exec/src/workbook_runtime/error.rs:24:/// Phase 2A.6 audit H1/L4 (2026-05-12) added `InvalidSheet` so callers that pass
crates/ql-exec/src/workbook_runtime/error.rs:25:/// a sheet id outside the workbook's range get a clean error instead of a panic
crates/ql-exec/src/workbook_runtime/error.rs:26:/// from `Workbook::put_at`. Phase 2A.6 audit H4 added `ConflictingOps` for
crates/ql-exec/src/workbook_runtime/error.rs:27:/// the `WorkbookTransaction` mixed-kind-on-same-cell case.
crates/ql-exec/src/workbook_runtime/error.rs:41:    /// **W5-147 (Phase 4.9.K):** the canonicalize step of `set_formula`
crates/ql-exec/src/workbook_runtime/error.rs:42:    /// (per design § 4.4) failed. This happens when the parsed AST
crates/ql-exec/src/workbook_runtime/error.rs:43:    /// contains an intermediate `Expr::R1C1Ref` with a relative axis
crates/ql-exec/src/workbook_runtime/error.rs:44:    /// that the printer can't resolve, or a malformed R1C1 axis. In
crates/ql-exec/src/workbook_runtime/error.rs:45:    /// practice the bind site always has a cell anchor, so the only
crates/ql-exec/src/workbook_runtime/error.rs:46:    /// reachable case is a hand-built AST with `AxisSpec::Abs(0)` —
crates/ql-exec/src/workbook_runtime/error.rs:47:    /// effectively impossible from `set_formula` since the lexer
crates/ql-exec/src/workbook_runtime/error.rs:48:    /// already rejects it as `MalformedR1C1`. Kept as a typed error
crates/ql-exec/src/workbook_runtime/error.rs:49:    /// for defense-in-depth.
crates/ql-exec/src/workbook_runtime/error.rs:59:    /// Phase 2A.7 audit H1: row/col outside the Excel grid (MAX_ROW = 1,048,575;
crates/ql-exec/src/workbook_runtime/error.rs:60:    /// MAX_COLUMN = 16,383). Surfaces at buffer time so `Sheet::put` doesn't
crates/ql-exec/src/workbook_runtime/error.rs:61:    /// panic mid-commit. `why` describes which bound was exceeded.
crates/ql-exec/src/workbook_runtime/error.rs:80:    /// Phase 2A.3.b (2026-05-12): the producer-side append into an attached
crates/ql-exec/src/workbook_runtime/error.rs:81:    /// op log failed (serde_json refused the wire value — e.g. NaN/Inf — or
crates/ql-exec/src/workbook_runtime/error.rs:82:    /// Loro surfaced an internal error). Producer order is append-then-mutate:
crates/ql-exec/src/workbook_runtime/error.rs:83:    /// when this fires, the workbook is unchanged. Callers attaching an op
crates/ql-exec/src/workbook_runtime/error.rs:84:    /// log handle the error; callers that don't attach one never see this
crates/ql-exec/src/workbook_runtime/error.rs:85:    /// variant.
crates/ql-exec/src/workbook_runtime/error.rs:89:    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
crates/ql-exec/src/workbook_runtime/error.rs:90:    /// the name in the workbook's `NameTable`. Currently the only
crates/ql-exec/src/workbook_runtime/error.rs:91:    /// `NameTableError` variant is `Reserved` (per CORR-06 the `AI` name is
crates/ql-exec/src/workbook_runtime/error.rs:92:    /// engine-reserved); see `ql_storage::NameTableError` for additional
crates/ql-exec/src/workbook_runtime/error.rs:93:    /// variants when they land.
crates/ql-exec/src/workbook_runtime/error.rs:97:    /// **W5-91 (Phase 4.6.C):** sheet-name validation refused — empty
crates/ql-exec/src/workbook_runtime/error.rs:98:    /// string, Excel-reserved character, or canonical duplicate.
crates/ql-exec/src/workbook_runtime/error.rs:99:    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
crates/ql-exec/src/workbook_runtime/error.rs:100:    /// `add_sheet` variants that validate).
crates/ql-exec/src/workbook_runtime/error.rs:104:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
crates/ql-exec/src/workbook_runtime/error.rs:105:    /// called with `chunk_rows == 0`. `Sheet::with_chunk_rows` accepts it
crates/ql-exec/src/workbook_runtime/error.rs:106:    /// silently, then the first cell write panics deep inside the column
crates/ql-exec/src/workbook_runtime/error.rs:107:    /// store. Pre-validating at the runtime entry refuses the value cleanly
crates/ql-exec/src/workbook_runtime/error.rs:108:    /// before any op-log append, so a bad input can't poison a workbook.
crates/ql-exec/src/workbook_runtime/error.rs:112:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
crates/ql-exec/src/workbook_runtime/error.rs:113:    /// called with the workbook already at `SheetId::MAX` (65,535) sheets.
crates/ql-exec/src/workbook_runtime/error.rs:114:    /// `Workbook::add_sheet_with_chunk_rows` panics in that case; the
crates/ql-exec/src/workbook_runtime/error.rs:115:    /// runtime now refuses before any op-log append.
crates/ql-exec/src/workbook_runtime/error.rs:119:    /// **W5-82 (Phase 4.5.D part 6):** `set_cell_format` was called with
crates/ql-exec/src/workbook_runtime/error.rs:120:    /// `Some(FormatId)` referencing an id that hasn't been registered
crates/ql-exec/src/workbook_runtime/error.rs:121:    /// in the workbook's `FormatTable`. Producer-side enforcement of the
crates/ql-exec/src/workbook_runtime/error.rs:122:    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
crates/ql-exec/src/workbook_runtime/error.rs:123:    /// `FormatNotRegistered`. Callers should obtain the id via
crates/ql-exec/src/workbook_runtime/error.rs:124:    /// `intern_format` (which handles registration automatically).
crates/ql-exec/src/workbook_runtime/error.rs:128:    /// **W5-106-AUDIT (Codex MEDIUM closure):** recompute_dirty's
crates/ql-exec/src/workbook_runtime/error.rs:129:    /// fixed-point loop hit its MAX_ITERATIONS bound with cells still
crates/ql-exec/src/workbook_runtime/error.rs:130:    /// dirty. Signals a runaway spill shape transition or workbook
crates/ql-exec/src/workbook_runtime/error.rs:131:    /// misconfiguration; the recompute result is partial.
crates/ql-exec/src/workbook_runtime/error.rs:135:    /// **W5-118 (Phase 4.8.H):** `create_table` was rejected by a
crates/ql-exec/src/workbook_runtime/error.rs:136:    /// validation rule. `reason` is a static string describing which
crates/ql-exec/src/workbook_runtime/error.rs:137:    /// invariant fired (uniqueness, overlap, empty column name, ...).
crates/ql-exec/src/workbook_runtime/error.rs:141:    /// **W5-118 (Phase 4.8.H):** `drop_table` was called on a name
crates/ql-exec/src/workbook_runtime/error.rs:142:    /// that doesn't exist.
crates/ql-exec/src/workbook_runtime/error.rs:146:    /// **W5-121 (Phase 4.8.I.2):** `rename_column` referenced a column
crates/ql-exec/src/workbook_runtime/error.rs:147:    /// name (case-insensitive) that does not exist in the target table.
crates/ql-exec/src/workbook_runtime/error.rs:151:    /// **W5-121 (Phase 4.8.I.2):** `rename_column` was rejected by a
crates/ql-exec/src/workbook_runtime/error.rs:152:    /// validation rule (target column name already in the table, empty,
crates/ql-exec/src/workbook_runtime/error.rs:153:    /// etc.). `reason` is a static string describing which invariant
crates/ql-exec/src/workbook_runtime/error.rs:154:    /// fired.
crates/ql-exec/src/workbook_runtime/error.rs:162:    /// **W5-122 (Phase 4.8.J):** `resize_table` was rejected by a
crates/ql-exec/src/workbook_runtime/error.rs:163:    /// validation rule (zero dims, arithmetic mismatch, trailing-
crates/ql-exec/src/workbook_runtime/error.rs:164:    /// columns mismatch, column-name collision, footprint overlap,
crates/ql-exec/src/workbook_runtime/error.rs:165:    /// etc.). `reason` is a static string describing which invariant
crates/ql-exec/src/workbook_runtime/error.rs:166:    /// fired.
crates/ql-exec/src/workbook_runtime/error.rs:183:/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:184:///
crates/ql-exec/src/workbook_runtime/error.rs:185:/// Phase 2B.2 (2026-05-12): part of the [`RecomputeResult`] aggregation
crates/ql-exec/src/workbook_runtime/error.rs:186:/// replacing the prior short-circuit `Result<usize, RuntimeError>` return
crates/ql-exec/src/workbook_runtime/error.rs:187:/// shape. Captures everything a caller needs to display the failure
crates/ql-exec/src/workbook_runtime/error.rs:188:/// without re-walking the workbook: the cell address, the formula text
crates/ql-exec/src/workbook_runtime/error.rs:189:/// that was tried, and the structural error from lex/parse/bind.
crates/ql-exec/src/workbook_runtime/error.rs:190:///
crates/ql-exec/src/workbook_runtime/error.rs:191:/// Evaluation-time errors that surface as `Value::Error(...)` (e.g. `=10/0`
crates/ql-exec/src/workbook_runtime/error.rs:192:/// → `#DIV/0!`) do NOT appear here — those are normal cell values per
crates/ql-exec/src/workbook_runtime/error.rs:193:/// Excel canon and get written to the workbook like any other recompute
crates/ql-exec/src/workbook_runtime/error.rs:194:/// success. `RecomputeFailure` is reserved for STRUCTURAL failures where
crates/ql-exec/src/workbook_runtime/error.rs:195:/// the formula cannot be evaluated at all.
crates/ql-exec/src/workbook_runtime/error.rs:196:///
crates/ql-exec/src/workbook_runtime/error.rs:197:/// Not `Clone` — `RuntimeError` contains `loro::LoroError` (via the
crates/ql-exec/src/workbook_runtime/error.rs:198:/// Phase 2A.3.b `OpLog` variant) which is not Clone. Pass by ownership
crates/ql-exec/src/workbook_runtime/error.rs:199:/// or borrow.
crates/ql-exec/src/workbook_runtime/error.rs:209:/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:210:///
crates/ql-exec/src/workbook_runtime/error.rs:211:/// Phase 2B.2 (2026-05-12): replaces the prior `Result<usize, RuntimeError>`
crates/ql-exec/src/workbook_runtime/error.rs:212:/// return shape. The previous signature short-circuited on first failure,
crates/ql-exec/src/workbook_runtime/error.rs:213:/// dropping per-cell context and forcing callers to re-walk the workbook
crates/ql-exec/src/workbook_runtime/error.rs:214:/// to find what went wrong. The new shape:
crates/ql-exec/src/workbook_runtime/error.rs:215:///
crates/ql-exec/src/workbook_runtime/error.rs:216:/// - `attempted` — total formula cells in the workbook snapshot at start.
crates/ql-exec/src/workbook_runtime/error.rs:217:/// - `succeeded` — formulas that lex/parse/bind/eval'd cleanly and were
crates/ql-exec/src/workbook_runtime/error.rs:218:///   written back to the workbook.
crates/ql-exec/src/workbook_runtime/error.rs:219:/// - `failures` — every formula that failed structurally, in iteration
crates/ql-exec/src/workbook_runtime/error.rs:220:///   order. Each entry carries cell address + formula text + error.
crates/ql-exec/src/workbook_runtime/error.rs:221:///
crates/ql-exec/src/workbook_runtime/error.rs:222:/// "Is this workbook now consistent?" is exposed via `is_complete()`
crates/ql-exec/src/workbook_runtime/error.rs:223:/// (= `failures.is_empty()`); see `failed_count()` for the count.
crates/ql-exec/src/workbook_runtime/error.rs:224:/// Phase 2B.7 audit (correctness M2) dropped a redundant `partial_state`
crates/ql-exec/src/workbook_runtime/error.rs:225:/// `pub` field that mirrored `!is_complete()` — having two sources of
crates/ql-exec/src/workbook_runtime/error.rs:226:/// truth created a soundness footgun (external constructors could lie).
crates/ql-exec/src/workbook_runtime/error.rs:227:///
crates/ql-exec/src/workbook_runtime/error.rs:228:/// No-fallback semantics: failures are NOT swallowed. The struct makes
crates/ql-exec/src/workbook_runtime/error.rs:229:/// every failure visible and aggregable. Callers that want short-circuit
crates/ql-exec/src/workbook_runtime/error.rs:230:/// semantics can check `is_complete()` and bail.
crates/ql-exec/src/workbook_runtime/error.rs:231:///
crates/ql-exec/src/workbook_runtime/error.rs:232:/// Cells past a failure point keep their pre-recompute (potentially stale)
crates/ql-exec/src/workbook_runtime/error.rs:233:/// values; their formula text is preserved either way (recompute never
crates/ql-exec/src/workbook_runtime/error.rs:234:/// clears formula on failure). Iteration order is `HashMap`-arbitrary
crates/ql-exec/src/workbook_runtime/error.rs:235:/// today (GAP-R-01); Engine Phase 3 calcgraph integration makes it
crates/ql-exec/src/workbook_runtime/error.rs:236:/// topological.
crates/ql-exec/src/workbook_runtime/error.rs:237:///
crates/ql-exec/src/workbook_runtime/error.rs:238:/// Not `Clone` for the same reason as `RecomputeFailure`.
crates/ql-exec/src/workbook_runtime/error.rs:239:///
crates/ql-exec/src/workbook_runtime/error.rs:240:/// Phase 3.8 (W5-41, 2026-05-12) adds the `skipped_value_equality` field
crates/ql-exec/src/workbook_runtime/error.rs:241:/// — VEQ-3-03's "profile records skipped downstream vertices." A dirty
crates/ql-exec/src/workbook_runtime/error.rs:242:/// formula whose direct cell deps all stayed at their prior values, and
crates/ql-exec/src/workbook_runtime/error.rs:243:/// which has no range deps or volatile flag, is skipped entirely during
crates/ql-exec/src/workbook_runtime/error.rs:244:/// `recompute_dirty`. The counter is `0` for `recompute_all` (which
crates/ql-exec/src/workbook_runtime/error.rs:245:/// always processes every formula in HashMap order — no VEQ logic).
crates/ql-exec/src/workbook_runtime/error.rs:246:///
crates/ql-exec/src/workbook_runtime/error.rs:247:/// Phase 3.9 (W5-42, 2026-05-12) adds `simd_classified` — SIMD-3-03's
crates/ql-exec/src/workbook_runtime/error.rs:248:/// "graph profile shows region execution." Counts how many of the dirty
crates/ql-exec/src/workbook_runtime/error.rs:249:/// formulas had plans that `lower::classify` says are SIMD-eligible
crates/ql-exec/src/workbook_runtime/error.rs:250:/// (`SimdShape != NotApplicable`). V1 of Phase 3.9 doesn't yet batch
crates/ql-exec/src/workbook_runtime/error.rs:251:/// these into bulk Arrow kernel calls (that's the Phase 4.7+ array-
crates/ql-exec/src/workbook_runtime/error.rs:252:/// formula / FormulaRegion binder work); the count is the observability
crates/ql-exec/src/workbook_runtime/error.rs:253:/// surface that proves the graph scheduler SEES region-eligible cells.
crates/ql-exec/src/workbook_runtime/error.rs:259:    /// Phase 3.8 (VEQ-3-03): count of formulas that were in the dirty
crates/ql-exec/src/workbook_runtime/error.rs:260:    /// set but skipped because no upstream value actually changed.
crates/ql-exec/src/workbook_runtime/error.rs:261:    /// Always `0` for the legacy `recompute_all` path.
crates/ql-exec/src/workbook_runtime/error.rs:263:    /// Phase 3.9 (SIMD-3-03): count of dirty formulas whose plan
crates/ql-exec/src/workbook_runtime/error.rs:264:    /// `lower::classify` recognized as SIMD-eligible (a recognized
crates/ql-exec/src/workbook_runtime/error.rs:265:    /// `SimdShape`). V1 ships observability only — the bulk SIMD
crates/ql-exec/src/workbook_runtime/error.rs:266:    /// dispatch via `simd::*` lives on the bench / FormulaRegion path
crates/ql-exec/src/workbook_runtime/error.rs:267:    /// (Phase 4.7+); this counter proves the graph scheduler is aware
crates/ql-exec/src/workbook_runtime/error.rs:268:    /// of region-eligible formulas. Always `0` for `recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:273:    /// True iff every formula recomputed without a structural failure.
crates/ql-exec/src/workbook_runtime/error.rs:278:    /// Number of structural failures (lex/parse/bind). Excludes evaluation
crates/ql-exec/src/workbook_runtime/error.rs:279:    /// errors like `#DIV/0!` which are normal cell values.
crates/ql-exec/src/workbook_runtime/recompute.rs:196:    /// **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
crates/ql-exec/src/workbook_runtime/recompute.rs:197:    /// point.** Recompute only the formulas the attached
crates/ql-exec/src/workbook_runtime/recompute.rs:198:    /// [`CalcgraphSession`] has marked dirty since the last call.
crates/ql-exec/src/workbook_runtime/recompute.rs:199:    /// The scheduler runs iterative Tarjan SCC over the dirty
crates/ql-exec/src/workbook_runtime/recompute.rs:200:    /// subset; nodes in non-trivial SCCs (or with self-loops) are
crates/ql-exec/src/workbook_runtime/recompute.rs:201:    /// written as `Value::Error(ErrorValue::Circ)`. Everything else
crates/ql-exec/src/workbook_runtime/recompute.rs:202:    /// is evaluated in topological order via the existing PlanCache
crates/ql-exec/src/workbook_runtime/recompute.rs:203:    /// pipeline.
crates/ql-exec/src/workbook_runtime/recompute.rs:204:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:205:    /// Returns `None` when no `CalcgraphSession` is attached (the
crates/ql-exec/src/workbook_runtime/recompute.rs:206:    /// runtime was constructed via `new` or `with_oplog`); the
crates/ql-exec/src/workbook_runtime/recompute.rs:207:    /// dirty-set lives on the session, so we can't do incremental
crates/ql-exec/src/workbook_runtime/recompute.rs:208:    /// recompute without it. Callers in that mode should use
crates/ql-exec/src/workbook_runtime/recompute.rs:209:    /// `recompute_all` for a full HashMap-order pass instead.
crates/ql-exec/src/workbook_runtime/recompute.rs:210:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:211:    /// Returns `Some(RecomputeResult)` otherwise, matching the
crates/ql-exec/src/workbook_runtime/recompute.rs:212:    /// aggregation shape of `recompute_all`: per-cell failures
crates/ql-exec/src/workbook_runtime/recompute.rs:213:    /// (parse / bind issues that have somehow surfaced post-bind,
crates/ql-exec/src/workbook_runtime/recompute.rs:214:    /// e.g. a name was deleted between extract and recompute) are
crates/ql-exec/src/workbook_runtime/recompute.rs:215:    /// collected, the rest succeed.
crates/ql-exec/src/workbook_runtime/recompute.rs:615:    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
crates/ql-exec/src/workbook_runtime/recompute.rs:616:    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
crates/ql-exec/src/workbook_runtime/recompute.rs:617:    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
crates/ql-exec/src/workbook_runtime/recompute.rs:618:    /// into a `RecomputeFailure`. Successful binds are cached so a
crates/ql-exec/src/workbook_runtime/recompute.rs:619:    /// subsequent recompute (or a `set_formula` editing a nearby cell
crates/ql-exec/src/workbook_runtime/recompute.rs:620:    /// with the same text) hits.
crates/ql-exec/src/workbook_runtime/recompute.rs:621:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:622:    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
crates/ql-exec/src/workbook_runtime/recompute.rs:623:    /// `recompute_dirty` path uses
crates/ql-exec/src/workbook_runtime/recompute.rs:624:    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
crates/ql-exec/src/workbook_runtime/recompute.rs:625:    /// session's aggregate cache through the evaluator.
crates/ql-exec/src/workbook_runtime/recompute.rs:642:    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
crates/ql-exec/src/workbook_runtime/recompute.rs:643:    /// threads an `AggregateCache` through the scalar evaluator so
crates/ql-exec/src/workbook_runtime/recompute.rs:644:    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
crates/ql-exec/src/workbook_runtime/recompute.rs:645:    /// cache. Used by `recompute_dirty` which owns a session-side
crates/ql-exec/src/workbook_runtime/recompute.rs:646:    /// `InMemAggregateCache`.
crates/ql-exec/src/workbook_runtime/recompute.rs:647:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:648:    /// **W5-103 (#128):** also takes `row, col` so the spill-writeback
crates/ql-exec/src/workbook_runtime/recompute.rs:649:    /// branch inside `try_recompute_with_simd_profile` can materialize
crates/ql-exec/src/workbook_runtime/recompute.rs:650:    /// arrays at the correct anchor cell.
crates/ql-exec/src/workbook_runtime/recompute.rs:663:    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
crates/ql-exec/src/workbook_runtime/recompute.rs:664:    /// but ALSO returns a `bool` for whether the formula's bound plan
crates/ql-exec/src/workbook_runtime/recompute.rs:665:    /// was SIMD-eligible per `crate::lower::classify`. The bool is
crates/ql-exec/src/workbook_runtime/recompute.rs:666:    /// pure observability — the actual SIMD dispatch via `simd::*`
crates/ql-exec/src/workbook_runtime/recompute.rs:667:    /// happens at the bench / FormulaRegion path. `recompute_dirty`
crates/ql-exec/src/workbook_runtime/recompute.rs:668:    /// uses this to populate `RecomputeResult.simd_classified` so the
crates/ql-exec/src/workbook_runtime/recompute.rs:669:    /// IDE profile can show where region optimization would help.
crates/ql-exec/src/workbook_runtime/recompute.rs:905:    /// End-to-end: save a workbook with formulas, load it, recompute, verify the
crates/ql-exec/src/workbook_runtime/recompute.rs:906:    /// values match. This is the full live-formula round-trip use case the IDE
crates/ql-exec/src/workbook_runtime/recompute.rs:907:    /// will exercise.
crates/ql-exec/src/workbook_runtime/recompute.rs:964:    /// `recompute_all` (no session attached — the `.qbook` load / replay
crates/ql-exec/src/workbook_runtime/recompute.rs:965:    /// path) must detect cycles and emit `#CIRC!` for cycled cells.
crates/ql-exec/src/workbook_runtime/recompute.rs:966:    /// Before this fix, a self-referential formula like `A1 = A1 + 1`
crates/ql-exec/src/workbook_runtime/recompute.rs:967:    /// silently produced 1, then 2, then 3, … on successive calls
crates/ql-exec/src/workbook_runtime/recompute.rs:968:    /// because HashMap-order evaluation just re-read the prior value.
crates/ql-exec/src/workbook_runtime/recompute.rs:992:    /// 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
crates/ql-exec/src/workbook_runtime/recompute.rs:993:    /// resolve to `#CIRC!`. Mirrors the existing `recompute_dirty`
crates/ql-exec/src/workbook_runtime/recompute.rs:994:    /// reference test (`recompute_dirty_writes_circ_error_for_cycle_members`).
crates/ql-exec/src/workbook_runtime/recompute.rs:1021:    /// Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
crates/ql-exec/src/workbook_runtime/recompute.rs:1022:    /// (self-referential). A1 and B1 evaluate normally; C1 emits
crates/ql-exec/src/workbook_runtime/recompute.rs:1023:    /// `#CIRC!`. Verifies cycle detection doesn't pollute the
crates/ql-exec/src/workbook_runtime/recompute.rs:1024:    /// acyclic remainder.
crates/ql-exec/src/workbook_runtime/recompute.rs:1050:    /// Cycle value must be stable across repeated `recompute_all`
crates/ql-exec/src/workbook_runtime/recompute.rs:1051:    /// calls — no drift between iterations. Before this fix, A1 in
crates/ql-exec/src/workbook_runtime/recompute.rs:1052:    /// `A1 = A1 + 1` returned 1, 2, 3, … instead of #CIRC! each time.
crates/ql-exec/src/workbook_runtime/recompute.rs:1071:    /// **Tier C1 audit Codex H-1 closure:** a non-cycled dependent
crates/ql-exec/src/workbook_runtime/recompute.rs:1072:    /// of a cycled cell must propagate `#CIRC!`, not read the
crates/ql-exec/src/workbook_runtime/recompute.rs:1073:    /// cycled cell's stale prior value. Before the pre-pass fix,
crates/ql-exec/src/workbook_runtime/recompute.rs:1074:    /// HashMap-order could evaluate B1 (=A1+1) before A1's `#CIRC!`
crates/ql-exec/src/workbook_runtime/recompute.rs:1075:    /// was written, so B1 would compute `prior(A1) + 1`. With the
crates/ql-exec/src/workbook_runtime/recompute.rs:1076:    /// pre-pass, A1 is `#CIRC!` before any non-cycled eval runs,
crates/ql-exec/src/workbook_runtime/recompute.rs:1077:    /// so B1 sees the error sigil and propagates it.
crates/ql-exec/src/workbook_runtime/recompute.rs:1107:    /// **Tier C1 audit Codex H-2 closure:** if a previously-spilling
crates/ql-exec/src/workbook_runtime/recompute.rs:1108:    /// anchor (e.g. `A1 = SEQUENCE(3)`) gets overwritten with a
crates/ql-exec/src/workbook_runtime/recompute.rs:1109:    /// circular formula, the old spill must be cleared so stale
crates/ql-exec/src/workbook_runtime/recompute.rs:1110:    /// targets A2/A3 don't survive next to the `#CIRC!` anchor.
crates/ql-exec/src/workbook_runtime/recompute.rs:1179:    /// R2B-01: a structural failure surfaces with the exact cell address +
crates/ql-exec/src/workbook_runtime/recompute.rs:1180:    /// formula text + underlying RuntimeError. No information is lost going
crates/ql-exec/src/workbook_runtime/recompute.rs:1181:    /// from "failed cell" to "RecomputeFailure entry".
crates/ql-exec/src/workbook_runtime/recompute.rs:1209:    /// R2B-02: a failure does not short-circuit. Cells whose formulas DO
crates/ql-exec/src/workbook_runtime/recompute.rs:1210:    /// parse cleanly get re-evaluated and counted as succeeded, regardless
crates/ql-exec/src/workbook_runtime/recompute.rs:1211:    /// of iteration order.
crates/ql-exec/src/workbook_runtime/recompute.rs:1244:    /// R2B-03: invalid persisted formulas do NOT panic the runtime. Every
crates/ql-exec/src/workbook_runtime/recompute.rs:1245:    /// kind of structural failure (lex / parse / bind) surfaces as a
crates/ql-exec/src/workbook_runtime/recompute.rs:1246:    /// `RecomputeFailure` entry; the runtime stays alive.
crates/ql-exec/src/workbook_runtime/recompute.rs:1265:    /// Evaluation-time errors (Value::Error variants like #DIV/0!) count as
crates/ql-exec/src/workbook_runtime/recompute.rs:1266:    /// SUCCEEDED, not failed. Recompute writes the error value to the cell
crates/ql-exec/src/workbook_runtime/recompute.rs:1267:    /// per Excel canon. Only structural failures (lex/parse/bind) populate
crates/ql-exec/src/workbook_runtime/recompute.rs:1268:    /// `RecomputeResult::failures`.
crates/ql-exec/src/workbook_runtime/recompute.rs:1288:    /// Failed cells keep their pre-recompute values; their formula text is
crates/ql-exec/src/workbook_runtime/recompute.rs:1289:    /// preserved (recompute never clears formula on failure).
crates/ql-exec/src/workbook_runtime/recompute.rs:1311:    /// BPC-01: repeated `recompute_all` against the same workbook does NOT
crates/ql-exec/src/workbook_runtime/recompute.rs:1312:    /// re-lex / re-parse / re-bind unchanged formulas. The second pass
crates/ql-exec/src/workbook_runtime/recompute.rs:1313:    /// hits the cache for every formula.
crates/ql-exec/src/workbook_runtime/recompute.rs:1342:    /// BPC-02: a NameTable mutation between recompute_all calls invalidates
crates/ql-exec/src/workbook_runtime/recompute.rs:1343:    /// every cached plan (because the cache key includes the generation).
crates/ql-exec/src/workbook_runtime/recompute.rs:1344:    /// The next recompute_all is all misses.
crates/ql-exec/src/workbook_runtime/recompute.rs:1400:    /// BPC-03: cache keys are stable across recompute_all calls — same
crates/ql-exec/src/workbook_runtime/recompute.rs:1401:    /// formula text + same sheet + same name_gen always hashes to the
crates/ql-exec/src/workbook_runtime/recompute.rs:1402:    /// same key, so hits are reliable. This is structural (Hash/Eq on
crates/ql-exec/src/workbook_runtime/recompute.rs:1403:    /// PlanCacheKey) but we exercise it end-to-end through the runtime.
crates/ql-exec/src/workbook_runtime/recompute.rs:1423:    /// BPC-04: cache hit/miss counters are visible (via `cache_stats()`)
crates/ql-exec/src/workbook_runtime/recompute.rs:1424:    /// in a form that ql-profile can lift into `Timings`. The
crates/ql-exec/src/workbook_runtime/recompute.rs:1425:    /// counterpart `Timings::bind_plan_cache_hits/misses` fields exist
crates/ql-exec/src/workbook_runtime/recompute.rs:1426:    /// and accept these numbers verbatim.
crates/ql-exec/src/workbook_runtime/recompute.rs:1448:    /// `set_formula` pre-warms the cache. A subsequent `recompute_all`
crates/ql-exec/src/workbook_runtime/recompute.rs:1449:    /// of the same cell hits the cache (no re-bind work).
crates/ql-exec/src/workbook_runtime/recompute.rs:1473:    /// NAG-01: named CONSTANTS continue to work after the binder grows
crates/ql-exec/src/workbook_runtime/recompute.rs:1474:    /// context-awareness. Regression guard against accidentally breaking
crates/ql-exec/src/workbook_runtime/recompute.rs:1475:    /// the existing Constant resolution path. Uses a long unambiguous name
crates/ql-exec/src/workbook_runtime/recompute.rs:1476:    /// to avoid the parser's column-letter heuristic (short names like
crates/ql-exec/src/workbook_runtime/recompute.rs:1477:    /// `Pi` collide with column-pair syntax).
crates/ql-exec/src/workbook_runtime/recompute.rs:1501:    /// NAG-02: named CELL REFERENCES continue to work after the binder
crates/ql-exec/src/workbook_runtime/recompute.rs:1502:    /// grows context-awareness.
crates/ql-exec/src/workbook_runtime/recompute.rs:1524:    /// NAG-03: a named RANGE inside an aggregate function binds to the
crates/ql-exec/src/workbook_runtime/recompute.rs:1525:    /// explicit `ExprPlan::AggregateNameRef` variant (rather than producing
crates/ql-exec/src/workbook_runtime/recompute.rs:1526:    /// a bind error). Phase 3.6 (W5-39, 2026-05-12) wired aggregate-range
crates/ql-exec/src/workbook_runtime/recompute.rs:1527:    /// eval, so the cell value is now the actual SUM (not `#CALC!`). The
crates/ql-exec/src/workbook_runtime/recompute.rs:1528:    /// range here covers A2:A11 (no values populated) → SUM = 0.
crates/ql-exec/src/workbook_runtime/recompute.rs:1551:    /// NAG-04: a named RANGE in scalar context produces the precise
crates/ql-exec/src/workbook_runtime/recompute.rs:1552:    /// `NamedRangeInScalarContext` error, not the generic `UnsupportedVariant`.
crates/ql-exec/src/workbook_runtime/recompute.rs:1553:    /// (The pre-existing `set_formula_named_range_in_scalar_context_errors`
crates/ql-exec/src/workbook_runtime/recompute.rs:1554:    /// test covers a single shape; this one exercises a few more positions.)
crates/ql-exec/src/workbook_runtime/recompute.rs:1590:    /// Named formulas (NamedTarget::Formula) surface a distinct
crates/ql-exec/src/workbook_runtime/recompute.rs:1591:    /// `NamedFormulaUnsupported` error rather than the generic
crates/ql-exec/src/workbook_runtime/recompute.rs:1592:    /// `UnsupportedVariant`. Engine Phase 4 will implement them.
crates/ql-exec/src/workbook_runtime/recompute.rs:1616:    /// G3-02 / hook-coverage test: each runtime mutation calls the
crates/ql-exec/src/workbook_runtime/recompute.rs:1617:    /// corresponding calcgraph hook. Attach a `CalcgraphSession`, drive
crates/ql-exec/src/workbook_runtime/recompute.rs:1618:    /// the runtime through all 5 mutation kinds, verify counters.
crates/ql-exec/src/workbook_runtime/recompute.rs:1659:    /// G3-01 + integration: rebuild a graph from an existing workbook,
crates/ql-exec/src/workbook_runtime/recompute.rs:1660:    /// then continue editing through the runtime — new mutations
crates/ql-exec/src/workbook_runtime/recompute.rs:1661:    /// register on the same graph, and the cell index reflects every
crates/ql-exec/src/workbook_runtime/recompute.rs:1662:    /// formula cell.
crates/ql-exec/src/workbook_runtime/recompute.rs:1701:    /// Without an attached graph, the runtime behaves identically to
crates/ql-exec/src/workbook_runtime/recompute.rs:1702:    /// pre-3.1. Regression guard.
crates/ql-exec/src/workbook_runtime/recompute.rs:1714:    /// Combined `with_oplog_and_graph` constructor: both op log AND
crates/ql-exec/src/workbook_runtime/recompute.rs:1715:    /// graph receive their respective updates.
crates/ql-exec/src/workbook_runtime/recompute.rs:1746:    /// Phase 3.4: with no graph attached, `recompute_dirty` returns
crates/ql-exec/src/workbook_runtime/recompute.rs:1747:    /// None — the dirty set lives on the session, so without one
crates/ql-exec/src/workbook_runtime/recompute.rs:1748:    /// there's nothing to drive.
crates/ql-exec/src/workbook_runtime/recompute.rs:1757:    /// SCH-3-01 end-to-end: edit a chain head, recompute_dirty
crates/ql-exec/src/workbook_runtime/recompute.rs:1758:    /// cascades through the chain. A1=1; B1=A1+1; C1=B1+1. After
crates/ql-exec/src/workbook_runtime/recompute.rs:1759:    /// set_value(A1, 10), B1 and C1 should both update to 11 and 12.
crates/ql-exec/src/workbook_runtime/recompute.rs:1799:    /// SCH-3-02 end-to-end: cycles get `#CIRC!`. Build A1 = B1 + 1
crates/ql-exec/src/workbook_runtime/recompute.rs:1800:    /// and B1 = A1 + 1 (a 2-cycle), then trigger a recompute. Every
crates/ql-exec/src/workbook_runtime/recompute.rs:1801:    /// cell in the SCC must be `Value::Error(ErrorValue::Circ)`.
crates/ql-exec/src/workbook_runtime/recompute.rs:1802:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:1803:    /// Note: we build the cycle directly via the workbook's low-level
crates/ql-exec/src/workbook_runtime/recompute.rs:1804:    /// `put_formula` API and rebuild the session. Going through
crates/ql-exec/src/workbook_runtime/recompute.rs:1805:    /// `WorkbookRuntime::set_formula` for the second cycle member
crates/ql-exec/src/workbook_runtime/recompute.rs:1806:    /// would re-evaluate A1 mid-cycle and write a non-cycle value,
crates/ql-exec/src/workbook_runtime/recompute.rs:1807:    /// which is fine — but it complicates the test setup. The
crates/ql-exec/src/workbook_runtime/recompute.rs:1808:    /// rebuild path is the canonical "load existing workbook" entry
crates/ql-exec/src/workbook_runtime/recompute.rs:1809:    /// the IDE uses and is the cleanest way to set up the test.
crates/ql-exec/src/workbook_runtime/recompute.rs:1851:    /// SCH-3-04 end-to-end: an edit to A1 cascades through its
crates/ql-exec/src/workbook_runtime/recompute.rs:1852:    /// chain, but an UNRELATED formula `=Z1+1` at E1 stays untouched.
crates/ql-exec/src/workbook_runtime/recompute.rs:1898:    /// OVR-3-01: `set_formula` writes the evaluated value to the COMPUTED
crates/ql-exec/src/workbook_runtime/recompute.rs:1899:    /// overlay, not the user lane. Inspect each overlay directly via the
crates/ql-exec/src/workbook_runtime/recompute.rs:1900:    /// column store to verify lane-routing.
crates/ql-exec/src/workbook_runtime/recompute.rs:1930:    /// OVR-3-02: typing a literal value over a formula cell clears both
crates/ql-exec/src/workbook_runtime/recompute.rs:1931:    /// the formula text AND the computed-overlay entry. Excel canon:
crates/ql-exec/src/workbook_runtime/recompute.rs:1932:    /// "user types over a formula → formula gone, cell becomes literal."
crates/ql-exec/src/workbook_runtime/recompute.rs:1961:    /// OVR-3-02 sister: explicit `clear_formula` (Excel "strip formula,
crates/ql-exec/src/workbook_runtime/recompute.rs:1962:    /// keep value") MOVES the formula's last evaluated value into the
crates/ql-exec/src/workbook_runtime/recompute.rs:1963:    /// user lane so the visible value persists. The op log records the
crates/ql-exec/src/workbook_runtime/recompute.rs:1964:    /// PutValue + ClearFormula pair so replay produces the same state.
crates/ql-exec/src/workbook_runtime/recompute.rs:1986:    /// OVR-3-03: save+load round-trip preserves lane assignment. A
crates/ql-exec/src/workbook_runtime/recompute.rs:1987:    /// workbook with a user-typed cell + a formula cell with computed
crates/ql-exec/src/workbook_runtime/recompute.rs:1988:    /// output, after `save_workbook` + `load_workbook`, has the same
crates/ql-exec/src/workbook_runtime/recompute.rs:1989:    /// lane layout (verified by inspecting overlays after load).
crates/ql-exec/src/workbook_runtime/recompute.rs:2032:    /// OVR-3-04: reads through the cascade see the right value in every
crates/ql-exec/src/workbook_runtime/recompute.rs:2033:    /// scenario — user-only cell, formula-only cell, base-only cell.
crates/ql-exec/src/workbook_runtime/recompute.rs:2034:    /// The runtime's public `Workbook::read` is the cascade entry point.
crates/ql-exec/src/workbook_runtime/recompute.rs:2073:    /// Helper: build a workbook with a named range `BigRange` over A1:A`size`
crates/ql-exec/src/workbook_runtime/recompute.rs:2074:    /// pre-populated with values 1..=size, and a SUM(BigRange) formula at B1.
crates/ql-exec/src/workbook_runtime/recompute.rs:2075:    /// Returns (wb, session) after rebuild — session has 0 cached aggregates.
crates/ql-exec/src/workbook_runtime/recompute.rs:2095:    /// AGG-3-04 (correctness baseline): SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT
crates/ql-exec/src/workbook_runtime/recompute.rs:2096:    /// over a named range produce the same result as the scalar baseline.
crates/ql-exec/src/workbook_runtime/recompute.rs:2097:    /// Sales = A1:A5 = [1, 2, 3, 4, 5]: SUM = 15, AVERAGE = 3, MIN = 1,
crates/ql-exec/src/workbook_runtime/recompute.rs:2098:    /// MAX = 5, COUNT = 5, PRODUCT = 120.
crates/ql-exec/src/workbook_runtime/recompute.rs:2138:    /// AGG-3-01: `SUM(BigRange)` does NOT rescan the range on an unrelated
crates/ql-exec/src/workbook_runtime/recompute.rs:2139:    /// write. We use a 1000-row range to make the cost asymmetric; a write
crates/ql-exec/src/workbook_runtime/recompute.rs:2140:    /// to a cell OUTSIDE the range, followed by `recompute_dirty`, should
crates/ql-exec/src/workbook_runtime/recompute.rs:2141:    /// produce a cache HIT (the SUM result is reused).
crates/ql-exec/src/workbook_runtime/recompute.rs:2186:    /// AGG-3-02: a write INSIDE BigRange invalidates the cache. After the
crates/ql-exec/src/workbook_runtime/recompute.rs:2187:    /// invalidation, the next eval is a miss + fresh computation.
crates/ql-exec/src/workbook_runtime/recompute.rs:2218:    /// AGG-3-03: full-column aggregate remains compressed. We register a
crates/ql-exec/src/workbook_runtime/recompute.rs:2219:    /// `SUM(WholeCol)` where WholeCol is start_row=0, end_row=RowId::MAX
crates/ql-exec/src/workbook_runtime/recompute.rs:2220:    /// — the stripe should still be ONE entry (per DIR-3-04). Phase 3.6
crates/ql-exec/src/workbook_runtime/recompute.rs:2221:    /// re-verifies in the aggregate-eval context: the eval doesn't blow
crates/ql-exec/src/workbook_runtime/recompute.rs:2222:    /// up trying to iterate 4 billion rows; it clamps via Sheet::bounds.
crates/ql-exec/src/workbook_runtime/recompute.rs:2265:    /// VOL-3-03: deterministic RNG test fixture exists. The
crates/ql-exec/src/workbook_runtime/recompute.rs:2266:    /// `ql_functions::set_test_rng_seed` helper produces a fixed RAND()
crates/ql-exec/src/workbook_runtime/recompute.rs:2267:    /// sequence; re-seeding reproduces the same first value.
crates/ql-exec/src/workbook_runtime/recompute.rs:2290:    /// VOL-3-01: marking volatile dirty + recompute_dirty re-evaluates
crates/ql-exec/src/workbook_runtime/recompute.rs:2291:    /// the volatile formula. With the seeded RNG, the value advances
crates/ql-exec/src/workbook_runtime/recompute.rs:2292:    /// to the next position in the deterministic sequence.
crates/ql-exec/src/workbook_runtime/recompute.rs:2319:    /// VOL-3-02: a non-volatile formula `=A1 + 1` (where A1 = RAND())
crates/ql-exec/src/workbook_runtime/recompute.rs:2320:    /// recomputes when A1's volatile tick fires.
crates/ql-exec/src/workbook_runtime/recompute.rs:2365:    /// VEQ-3-01: when an upstream's recomputed value equals its prior
crates/ql-exec/src/workbook_runtime/recompute.rs:2366:    /// value, downstream formulas that depend only on it are SKIPPED.
crates/ql-exec/src/workbook_runtime/recompute.rs:2367:    /// Setup: A1 = 1 literal; B1 = A1 + 1 (= 2); C1 = B1 + 1 (= 3).
crates/ql-exec/src/workbook_runtime/recompute.rs:2368:    /// Trigger: edit A1 to 1 (same value). Both B1 and C1 are marked
crates/ql-exec/src/workbook_runtime/recompute.rs:2369:    /// dirty via the Phase 3.3 BFS. After recompute_dirty:
crates/ql-exec/src/workbook_runtime/recompute.rs:2370:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:2371:    /// - B1 re-evaluates (top-level dirty); value unchanged → suppress.
crates/ql-exec/src/workbook_runtime/recompute.rs:2372:    /// - C1 skipped entirely (its only changed-upstream candidate, B1,
crates/ql-exec/src/workbook_runtime/recompute.rs:2373:    ///   stayed unchanged).
crates/ql-exec/src/workbook_runtime/recompute.rs:2374:    ///
crates/ql-exec/src/workbook_runtime/recompute.rs:2375:    /// Observable: `skipped_value_equality` ≥ 1, and no extra writes
crates/ql-exec/src/workbook_runtime/recompute.rs:2376:    /// to B1/C1.
crates/ql-exec/src/workbook_runtime/recompute.rs:2416:    /// VEQ-3-02: error equality is correct. A formula that re-evaluates
crates/ql-exec/src/workbook_runtime/recompute.rs:2417:    /// to the same `#DIV/0!` error should be treated as equal — no
crates/ql-exec/src/workbook_runtime/recompute.rs:2418:    /// write, downstream skipped. Setup: A1 = 10 / 0 (→ #DIV/0!);
crates/ql-exec/src/workbook_runtime/recompute.rs:2419:    /// B1 = A1 + 1 (→ #DIV/0!, error propagation).
crates/ql-exec/src/workbook_runtime/recompute.rs:2420:    /// Edit A1's formula to the same text → still #DIV/0!. B1 skipped.
crates/ql-exec/src/workbook_runtime/recompute.rs:2463:    /// VEQ-3-03: the `skipped_value_equality` counter on
crates/ql-exec/src/workbook_runtime/recompute.rs:2464:    /// `RecomputeResult` is the public profile surface for value-
crates/ql-exec/src/workbook_runtime/recompute.rs:2465:    /// equality short-circuit. This test asserts the field exists,
crates/ql-exec/src/workbook_runtime/recompute.rs:2466:    /// is non-zero when skips occur, and stays 0 when every dirty
crates/ql-exec/src/workbook_runtime/recompute.rs:2467:    /// formula actually changed.
crates/ql-exec/src/workbook_runtime/recompute.rs:2511:    /// VEQ regression: a volatile formula (RAND) is NEVER skipped on
crates/ql-exec/src/workbook_runtime/recompute.rs:2512:    /// value-equality — its value can change between calls without
crates/ql-exec/src/workbook_runtime/recompute.rs:2513:    /// any cell edit. The Phase 3.7 mark_volatile_dirty path triggers
crates/ql-exec/src/workbook_runtime/recompute.rs:2514:    /// the recompute; even if the seeded RAND happened to produce the
crates/ql-exec/src/workbook_runtime/recompute.rs:2515:    /// same value twice in a row, the formula must still re-evaluate.
crates/ql-exec/src/workbook_runtime/recompute.rs:2541:    /// SIMD-3-01: the bench-side multiversion-clone path (the OG-02
crates/ql-exec/src/workbook_runtime/recompute.rs:2542:    /// `=A*2` 25M-cell kernel) still binds to a recognized
crates/ql-exec/src/workbook_runtime/recompute.rs:2543:    /// `SimdShape::MulScalar`. The `bash scripts/check-multiversion-
crates/ql-exec/src/workbook_runtime/recompute.rs:2544:    /// clones.sh` gate verifies the binary disassembly; this unit
crates/ql-exec/src/workbook_runtime/recompute.rs:2545:    /// test verifies the upstream `lower::classify` still produces
crates/ql-exec/src/workbook_runtime/recompute.rs:2546:    /// the expected shape, so the graph scheduler and the bench
crates/ql-exec/src/workbook_runtime/recompute.rs:2547:    /// agree on which plans are SIMD-eligible.
crates/ql-exec/src/workbook_runtime/recompute.rs:2568:    /// SIMD-3-02: scalar fallback for division. `lower::classify`
crates/ql-exec/src/workbook_runtime/recompute.rs:2569:    /// MUST return `NotApplicable` for `=A1 / 2` so the Excel-canon
crates/ql-exec/src/workbook_runtime/recompute.rs:2570:    /// `#DIV/0!` error class is preserved (a SIMD reciprocal-mul
crates/ql-exec/src/workbook_runtime/recompute.rs:2571:    /// path would produce `+Inf` and surface as `#NUM!` — wrong).
crates/ql-exec/src/workbook_runtime/recompute.rs:2572:    /// This is the Phase 2A.9 H5 fix; Phase 3.9 re-affirms.
crates/ql-exec/src/workbook_runtime/recompute.rs:2598:    /// SIMD-3-03: graph profile shows region execution.
crates/ql-exec/src/workbook_runtime/recompute.rs:2599:    /// `RecomputeResult.simd_classified` counts how many dirty
crates/ql-exec/src/workbook_runtime/recompute.rs:2600:    /// formulas had plans that `classify()` recognized as SIMD-
crates/ql-exec/src/workbook_runtime/recompute.rs:2601:    /// eligible. A workbook with a mix of `=A*2` (SIMD-eligible)
crates/ql-exec/src/workbook_runtime/recompute.rs:2602:    /// and `=SUM(Sales)` (not SIMD-eligible aggregate) edits then
crates/ql-exec/src/workbook_runtime/recompute.rs:2603:    /// recomputes; the counter reflects the eligibility split.
crates/ql-exec/src/workbook_runtime/recompute.rs:2662:    /// SUMIF over a named range with numeric criteria.
crates/ql-exec/src/workbook_runtime/recompute.rs:2663:    /// `Sales = A1:A5 = [1, 5, 5, 10, 5]`. `=SUMIF(Sales, 5)` should
crates/ql-exec/src/workbook_runtime/recompute.rs:2664:    /// match the three 5's → 15.
crates/ql-exec/src/workbook_runtime/recompute.rs:2683:    /// SUMIF with a comparator criteria string.
crates/ql-exec/src/workbook_runtime/recompute.rs:2684:    /// `=SUMIF(Sales, ">5")` → sum of cells > 5 → 10.
crates/ql-exec/src/workbook_runtime/recompute.rs:2702:    /// COUNTIF over a named range. `=COUNTIF(Sales, ">=5")` → 4 cells.
crates/ql-exec/src/workbook_runtime/recompute.rs:2721:    /// SUMIF with a 3-arg call: separate `sum_range`. Criteria range
crates/ql-exec/src/workbook_runtime/recompute.rs:2722:    /// holds labels; sum range holds the values. Demonstrates the
crates/ql-exec/src/workbook_runtime/recompute.rs:2723:    /// per-arg range distinction the W5-53 infra was built for.
crates/ql-exec/src/workbook_runtime/recompute.rs:2755:    /// SUMIF interacts correctly with the recompute path (Phase 3.6
crates/ql-exec/src/workbook_runtime/recompute.rs:2756:    /// aggregate cache is BYPASSED for range-aware functions — they
crates/ql-exec/src/workbook_runtime/recompute.rs:2757:    /// are NOT in `is_aggregate_function`'s set, so they recompute
crates/ql-exec/src/workbook_runtime/recompute.rs:2758:    /// on every edit). When a cell in the criteria range changes,
crates/ql-exec/src/workbook_runtime/recompute.rs:2759:    /// the SUMIF formula must re-evaluate.
crates/ql-exec/src/workbook_runtime/recompute.rs:2795:    /// VLOOKUP with exact match against a 2-column table.
crates/ql-exec/src/workbook_runtime/recompute.rs:2824:    /// VLOOKUP with approximate match (default range_lookup=TRUE) on
crates/ql-exec/src/workbook_runtime/recompute.rs:2825:    /// an ascending-sorted first column.
crates/ql-exec/src/workbook_runtime/recompute.rs:2855:    /// HLOOKUP with exact match on a 2-row × 3-col table.
crates/ql-exec/src/workbook_runtime/recompute.rs:2881:    /// MATCH exact + INDEX combination — the canonical replacement
crates/ql-exec/src/workbook_runtime/recompute.rs:2882:    /// for VLOOKUP. Demonstrates both functions plus the
crates/ql-exec/src/workbook_runtime/recompute.rs:2883:    /// scalar-argument result feeding into another formula.
crates/ql-exec/src/workbook_runtime/recompute.rs:2918:    /// CHOOSE picks from scalar args.
crates/ql-exec/src/workbook_runtime/recompute.rs:2931:    /// VLOOKUP not-found returns #N/A. Verifies the error
crates/ql-exec/src/workbook_runtime/recompute.rs:2932:    /// classification is end-to-end correct (not stuck at #VALUE!).
crates/ql-exec/src/workbook_runtime/recompute.rs:2961:    /// AVERAGEIF: range [1, 2, 3, 4, 5], criteria ">2" → matches 3, 4,
crates/ql-exec/src/workbook_runtime/recompute.rs:2962:    /// 5 → avg 4.
crates/ql-exec/src/workbook_runtime/recompute.rs:2981:    /// SUMIFS: two label columns + value column. Sum of values where
crates/ql-exec/src/workbook_runtime/recompute.rs:2982:    /// labels1="a" AND labels2="y".
crates/ql-exec/src/workbook_runtime/recompute.rs:3023:    /// COUNTIFS: same shape, count where labels1="a".
crates/ql-exec/src/workbook_runtime/recompute.rs:3043:    /// SUMPRODUCT: dot-product of two columns.
crates/ql-exec/src/workbook_runtime/recompute.rs:3071:    /// AVERAGEIFS with two conditions.
crates/ql-exec/src/workbook_runtime/recompute.rs:3112:    /// Phase 3.7 extra: `mark_volatile_dirty` on a workbook with zero
crates/ql-exec/src/workbook_runtime/recompute.rs:3113:    /// volatile formulas returns 0 and leaves the dirty set empty.
crates/ql-exec/src/workbook_runtime/recompute.rs:3129:    /// Phase 3.4: empty dirty (e.g. recompute_dirty called twice in a
crates/ql-exec/src/workbook_runtime/recompute.rs:3130:    /// row with no edits between) returns an empty result.
crates/ql-exec/src/workbook_runtime/cells.rs:43:    /// Set a cell to a formula. Pipeline: lex → parse → bind (against `sheet`) →
crates/ql-exec/src/workbook_runtime/cells.rs:44:    /// eval against the current workbook → put_at the result + put_formula the text.
crates/ql-exec/src/workbook_runtime/cells.rs:45:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:46:    /// Returns the evaluated value, or a `RuntimeError` if any pipeline stage fails.
crates/ql-exec/src/workbook_runtime/cells.rs:47:    /// On error, the workbook is unchanged (no partial writes).
crates/ql-exec/src/workbook_runtime/cells.rs:48:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:49:    /// `formula_text` is the formula body without the leading `=`. The Sheet must
crates/ql-exec/src/workbook_runtime/cells.rs:50:    /// already exist.
crates/ql-exec/src/workbook_runtime/cells.rs:450:    /// **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** — re-extract
crates/ql-exec/src/workbook_runtime/cells.rs:451:    /// deps for every formula whose `cell_to_formulas` index points at
crates/ql-exec/src/workbook_runtime/cells.rs:452:    /// any cell in the UNION of the OLD and NEW spill footprints
crates/ql-exec/src/workbook_runtime/cells.rs:453:    /// anchored at `(sheet, row, col)`. Excludes the anchor cell itself
crates/ql-exec/src/workbook_runtime/cells.rs:454:    /// (its own deps were already (re-)extracted by `on_set_formula`).
crates/ql-exec/src/workbook_runtime/cells.rs:455:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:456:    /// Re-extraction means: re-bind the reader's formula text (via the
crates/ql-exec/src/workbook_runtime/cells.rs:457:    /// PlanCache, so a cached miss is the only cost when the surrounding
crates/ql-exec/src/workbook_runtime/cells.rs:458:    /// `name_gen` is stable) and re-run `extract_and_register_deps`. The
crates/ql-exec/src/workbook_runtime/cells.rs:459:    /// producer-alias rewrite inside `extract_and_register_deps` then
crates/ql-exec/src/workbook_runtime/cells.rs:460:    /// sees the now-current spill table and routes target-cell CellRefs
crates/ql-exec/src/workbook_runtime/cells.rs:461:    /// to the anchor (or unroutes them if the spill dissolved).
crates/ql-exec/src/workbook_runtime/cells.rs:462:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:463:    /// Defensive on bind failure: a reader whose formula text no longer
crates/ql-exec/src/workbook_runtime/cells.rs:464:    /// parses (e.g. it was bound under a different name-gen state) is
crates/ql-exec/src/workbook_runtime/cells.rs:465:    /// skipped. Its broken state surfaces at its own next recompute —
crates/ql-exec/src/workbook_runtime/cells.rs:466:    /// we don't want to fail the surrounding `set_formula` call because
crates/ql-exec/src/workbook_runtime/cells.rs:467:    /// of an unrelated reader.
crates/ql-exec/src/workbook_runtime/cells.rs:600:    /// **W5-103 (Phase 4.7.J.2 / 4.7.J.3)** — spill writeback path.
crates/ql-exec/src/workbook_runtime/cells.rs:601:    /// Called from `set_formula` when `eval_at_cell_boundary` returns
crates/ql-exec/src/workbook_runtime/cells.rs:602:    /// `EvalResult::Array`. Performs (per design § 8.1):
crates/ql-exec/src/workbook_runtime/cells.rs:603:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:604:    /// 1. Degenerate check (`rows == 0 || cols == 0` → `#CALC!`).
crates/ql-exec/src/workbook_runtime/cells.rs:605:    /// 2. Bounds check (anchor + shape fits within grid → `#SPILL!`).
crates/ql-exec/src/workbook_runtime/cells.rs:606:    /// 3. Blocking check (any non-anchor target cell occupied → `#SPILL!`).
crates/ql-exec/src/workbook_runtime/cells.rs:607:    /// 4. Happy path: `register_spill` then `put_computed_at` for every
crates/ql-exec/src/workbook_runtime/cells.rs:608:    ///    cell in the rectangle.
crates/ql-exec/src/workbook_runtime/cells.rs:609:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:610:    /// Anchor cell ALWAYS gets a formula association (`put_formula`).
crates/ql-exec/src/workbook_runtime/cells.rs:611:    /// Non-anchor targets are formula-less per design § 8.2.
crates/ql-exec/src/workbook_runtime/cells.rs:612:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:613:    /// Returns `(anchor_value, Option<SpillShape>)`. `Some(shape)` only
crates/ql-exec/src/workbook_runtime/cells.rs:614:    /// on the happy path (step 4); degenerate/bounds/blocked outcomes
crates/ql-exec/src/workbook_runtime/cells.rs:615:    /// return `None` so the caller knows no new spill footprint exists.
crates/ql-exec/src/workbook_runtime/cells.rs:616:    /// The caller uses the shape to drive Phase 4.7.J.3's target-cell
crates/ql-exec/src/workbook_runtime/cells.rs:617:    /// calcgraph invalidation hook.
crates/ql-exec/src/workbook_runtime/cells.rs:618:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:619:    /// **Tier D1 Step 3.7:** visibility raised to `pub(super)` so
crates/ql-exec/src/workbook_runtime/cells.rs:620:    /// `recompute.rs::try_recompute_with_simd_profile` (sibling
crates/ql-exec/src/workbook_runtime/cells.rs:621:    /// submodule) can call it directly. Pre-split this was a
crates/ql-exec/src/workbook_runtime/cells.rs:622:    /// same-module private fn; after the split, sibling-submodule
crates/ql-exec/src/workbook_runtime/cells.rs:623:    /// access requires explicit visibility.
crates/ql-exec/src/workbook_runtime/cells.rs:744:    /// **W5-103 megaudit LOW (Codex pass 2 finding):** anchor-error
crates/ql-exec/src/workbook_runtime/cells.rs:745:    /// write helper. The three blocked-spill arms in `write_spill`
crates/ql-exec/src/workbook_runtime/cells.rs:746:    /// (degenerate → `#CALC!`, bounds → `#SPILL!`, blocking →
crates/ql-exec/src/workbook_runtime/cells.rs:747:    /// `#SPILL!`) all do the same five lines: clear user, write error
crates/ql-exec/src/workbook_runtime/cells.rs:748:    /// to computed, persist formula text, return `(err, None)`.
crates/ql-exec/src/workbook_runtime/cells.rs:749:    /// Factor into one helper so a future fix can't update one arm
crates/ql-exec/src/workbook_runtime/cells.rs:750:    /// and miss another.
crates/ql-exec/src/workbook_runtime/cells.rs:766:    /// Set a cell to a literal value (no formula). Clears any existing formula
crates/ql-exec/src/workbook_runtime/cells.rs:767:    /// association at the cell — typing a value over a formula cell deletes the
crates/ql-exec/src/workbook_runtime/cells.rs:768:    /// formula per Excel canon. Phase 2A.7 audit H1: validates sheet + row/col
crates/ql-exec/src/workbook_runtime/cells.rs:769:    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
crates/ql-exec/src/workbook_runtime/cells.rs:960:    /// Phase 2B.5 (2026-05-12): clear a cell's formula association through
crates/ql-exec/src/workbook_runtime/cells.rs:961:    /// the runtime, emitting `Op::ClearFormula` into the attached op log (if
crates/ql-exec/src/workbook_runtime/cells.rs:962:    /// any). Idempotent: clearing a cell with no formula is a no-op for the
crates/ql-exec/src/workbook_runtime/cells.rs:963:    /// workbook AND for the op log (no entry emitted) — avoiding spurious
crates/ql-exec/src/workbook_runtime/cells.rs:964:    /// "removed nothing" entries.
crates/ql-exec/src/workbook_runtime/cells.rs:965:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:966:    /// Note: `set_value` already emits `ClearFormula` automatically when it
crates/ql-exec/src/workbook_runtime/cells.rs:967:    /// overwrites a formula cell. This method is for callers that want to
crates/ql-exec/src/workbook_runtime/cells.rs:968:    /// explicitly strip a formula without changing the cell's value.
crates/ql-exec/src/workbook_runtime/cells.rs:969:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:970:    /// Direct callers of `Workbook::clear_formula` bypass the op log
crates/ql-exec/src/workbook_runtime/cells.rs:971:    /// silently. See GAP-O-03 in `docs/known-gaps.md`.
crates/ql-exec/src/workbook_runtime/cells.rs:1219:    /// Phase 2A.5 (2026-05-12): `=VAR.S(1, 2, 3)` end-to-end — lexer accepts the
crates/ql-exec/src/workbook_runtime/cells.rs:1220:    /// dotted identifier, parser builds Expr::Function { name: "VAR.S" }, binder
crates/ql-exec/src/workbook_runtime/cells.rs:1221:    /// produces ExprPlan::Function, scalar evaluator dispatches via the registry
crates/ql-exec/src/workbook_runtime/cells.rs:1222:    /// to the variance kernel. Sample variance of {1,2,3} is 1.0.
crates/ql-exec/src/workbook_runtime/cells.rs:1278:    /// Phase 2A.6 audit H1/L4 (2026-05-12): invalid sheet ids surface as
crates/ql-exec/src/workbook_runtime/cells.rs:1279:    /// `RuntimeError::InvalidSheet` instead of panicking inside `Workbook::put_at`.
crates/ql-exec/src/workbook_runtime/cells.rs:1296:    /// Phase 2A.7 audit H1 (2026-05-12): out-of-grid row or col now surfaces as
crates/ql-exec/src/workbook_runtime/cells.rs:1297:    /// `RuntimeError::InvalidCell` instead of panicking inside `Sheet::put`.
crates/ql-exec/src/workbook_runtime/cells.rs:1522:    /// **W5-103 megaudit HIGH-3 closure** — oplog must record the
crates/ql-exec/src/workbook_runtime/cells.rs:1523:    /// PutFormula even when set_formula triggers J.5 host-spill
crates/ql-exec/src/workbook_runtime/cells.rs:1524:    /// dissolution. The new ordering (op-log append BEFORE clear_spill)
crates/ql-exec/src/workbook_runtime/cells.rs:1525:    /// is what guarantees workbook/log consistency on failure; the
crates/ql-exec/src/workbook_runtime/cells.rs:1526:    /// happy path here pins that the op IS recorded for the spill-target
crates/ql-exec/src/workbook_runtime/cells.rs:1527:    /// case.
crates/ql-exec/src/workbook_runtime/cells.rs:1570:    /// **W5-103 megaudit HIGH-3 closure** — re-setting an array formula
crates/ql-exec/src/workbook_runtime/cells.rs:1571:    /// at the same anchor (J.2 clear-old path) records exactly ONE
crates/ql-exec/src/workbook_runtime/cells.rs:1572:    /// PutFormula per call. The op-log emission happens BEFORE the
crates/ql-exec/src/workbook_runtime/cells.rs:1573:    /// clear-old mutation; the clear is a workbook-internal side
crates/ql-exec/src/workbook_runtime/cells.rs:1574:    /// effect that does NOT show up as a separate op.
crates/ql-exec/src/workbook_runtime/cells.rs:1686:    /// OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
crates/ql-exec/src/workbook_runtime/cells.rs:1687:    /// in the attached op log AND registers the name in the workbook's
crates/ql-exec/src/workbook_runtime/cells.rs:1688:    /// NameTable. Without an op log, behavior is identical to
crates/ql-exec/src/workbook_runtime/cells.rs:1689:    /// `Workbook::set_name` (no recording).
crates/ql-exec/src/workbook_runtime/cells.rs:1727:    /// OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
crates/ql-exec/src/workbook_runtime/cells.rs:1728:    /// in the attached op log AND adds the sheet to the workbook. Returns
crates/ql-exec/src/workbook_runtime/cells.rs:1729:    /// the new SheetId.
crates/ql-exec/src/workbook_runtime/cells.rs:1756:    /// OPL-2B-01 (part 3): `WorkbookRuntime::clear_formula` records a
crates/ql-exec/src/workbook_runtime/cells.rs:1757:    /// single `Op::BatchCommit { ops: [PutValue(current), ClearFormula] }`
crates/ql-exec/src/workbook_runtime/cells.rs:1758:    /// when there was a formula to clear (so replay preserves the cell
crates/ql-exec/src/workbook_runtime/cells.rs:1759:    /// value, matching the "strip formula, keep value" semantic of
crates/ql-exec/src/workbook_runtime/cells.rs:1760:    /// `Workbook::clear_formula`). Phase 2B.7 audit H2 wraps the pair so
crates/ql-exec/src/workbook_runtime/cells.rs:1761:    /// partial-pair op-log failure is impossible. Clearing a non-formula
crates/ql-exec/src/workbook_runtime/cells.rs:1762:    /// cell is a no-op for both the workbook and the log.
crates/ql-exec/src/workbook_runtime/cells.rs:1813:    /// OPL-2B-01 (regression): without an attached op log, the new
crates/ql-exec/src/workbook_runtime/cells.rs:1814:    /// runtime methods behave identically to the underlying Workbook
crates/ql-exec/src/workbook_runtime/cells.rs:1815:    /// methods (no panics, no errors, no recording).
crates/ql-exec/src/workbook_runtime/cells.rs:1842:    /// OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
crates/ql-exec/src/workbook_runtime/cells.rs:1843:    /// `NameTableError::Reserved` (per CORR-06, "AI" is reserved) AND
crates/ql-exec/src/workbook_runtime/cells.rs:1844:    /// leaves the op log untouched. The runtime uses mutate-first ordering
crates/ql-exec/src/workbook_runtime/cells.rs:1845:    /// for set_name specifically because NameTable::set has its own failure
crates/ql-exec/src/workbook_runtime/cells.rs:1846:    /// mode beyond op-log append.
crates/ql-exec/src/workbook_runtime/cells.rs:1870:    /// OPL-2B-02: producer/replay equivalence across the full op vocabulary
crates/ql-exec/src/workbook_runtime/cells.rs:1871:    /// (PutValue, PutFormula, ClearFormula, SetName, AddSheet, BatchCommit).
crates/ql-exec/src/workbook_runtime/cells.rs:1872:    /// Producer uses the runtime; replay against fresh workbook + recompute
crates/ql-exec/src/workbook_runtime/cells.rs:1873:    /// yields the same observable state, including names + extra sheet.
crates/ql-exec/src/workbook_runtime/cells.rs:2104:    /// Phase 4.7.J.2 — happy path: `={1,2,3}` at A1 spills 1×3 across
crates/ql-exec/src/workbook_runtime/cells.rs:2105:    /// A1, B1, C1. Return value is array.at(0,0) = 1.
crates/ql-exec/src/workbook_runtime/cells.rs:2132:    /// Phase 4.7.J.2 — happy path: `={1;2;3}` at A1 spills 3×1 down
crates/ql-exec/src/workbook_runtime/cells.rs:2133:    /// (vertical: semicolons are row separators per design § 3.1).
crates/ql-exec/src/workbook_runtime/cells.rs:2151:    /// Phase 4.7.J.2 — happy path: 2×2. `{1,2;3,4}` → A1=1, B1=2, A2=3, B2=4.
crates/ql-exec/src/workbook_runtime/cells.rs:2165:    /// Phase 4.7.J.2 — clear-old: re-setting an array formula at the
crates/ql-exec/src/workbook_runtime/cells.rs:2166:    /// same anchor with a SMALLER shape leaves no orphan cells from
crates/ql-exec/src/workbook_runtime/cells.rs:2167:    /// the prior footprint. Per design § 8.3.
crates/ql-exec/src/workbook_runtime/cells.rs:2202:    /// Phase 4.7.J.2 — scalar-after-array: re-setting an anchor cell
crates/ql-exec/src/workbook_runtime/cells.rs:2203:    /// with a SCALAR formula dissolves the prior spill entirely.
crates/ql-exec/src/workbook_runtime/cells.rs:2221:    /// Phase 4.7.J.2 — blocking: B1 has a user value `=5`. Setting
crates/ql-exec/src/workbook_runtime/cells.rs:2222:    /// `={1,2}` at A1 (1×2 spill A1:B1) sees B1 occupied → anchor gets
crates/ql-exec/src/workbook_runtime/cells.rs:2223:    /// #SPILL!, no targets registered, no targets overwritten.
crates/ql-exec/src/workbook_runtime/cells.rs:2248:    /// Phase 4.7.J.2 — blocking: B1 has its own formula (computed
crates/ql-exec/src/workbook_runtime/cells.rs:2249:    /// output `=10+10`). Setting `={1,2}` at A1 sees B1 occupied →
crates/ql-exec/src/workbook_runtime/cells.rs:2250:    /// anchor #SPILL!, B1's formula untouched.
crates/ql-exec/src/workbook_runtime/cells.rs:2273:    /// Phase 4.7.J.2 — out-of-bounds spill: anchor at MAX_ROW with a
crates/ql-exec/src/workbook_runtime/cells.rs:2274:    /// 3-row vertical array → end_row exceeds grid → anchor #SPILL!.
crates/ql-exec/src/workbook_runtime/cells.rs:2293:    /// Phase 4.7.J.3 — happy path: writeback fires `on_set_value` once
crates/ql-exec/src/workbook_runtime/cells.rs:2294:    /// per NON-ANCHOR target cell. A 1×3 spill at A1 fires for B1 and
crates/ql-exec/src/workbook_runtime/cells.rs:2295:    /// C1, NOT for A1 (anchor is covered by on_set_formula's internal
crates/ql-exec/src/workbook_runtime/cells.rs:2296:    /// `mark_dirty_from_cell_write`).
crates/ql-exec/src/workbook_runtime/cells.rs:2297:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:2298:    /// Verified by hook counters: set_value fires twice (B1, C1) on
crates/ql-exec/src/workbook_runtime/cells.rs:2299:    /// top of whatever set_value counter was at before the spill.
crates/ql-exec/src/workbook_runtime/cells.rs:2318:    /// Phase 4.7.J.3 — 2x2 spill fires `on_set_value` three times
crates/ql-exec/src/workbook_runtime/cells.rs:2319:    /// (A1=anchor, B1, A2, B2 — three non-anchor cells).
crates/ql-exec/src/workbook_runtime/cells.rs:2337:    /// Phase 4.7.J.3 — pre-existing reader of an OLD target dirties
crates/ql-exec/src/workbook_runtime/cells.rs:2338:    /// when the spill DISSOLVES (anchor changes from array to scalar).
crates/ql-exec/src/workbook_runtime/cells.rs:2339:    /// This is the OLD-footprint case: clearing the spill at A1 must
crates/ql-exec/src/workbook_runtime/cells.rs:2340:    /// fire `on_set_value` for A2, A3 so a B1=A2 reader notices that
crates/ql-exec/src/workbook_runtime/cells.rs:2341:    /// A2 is now Blank and re-evaluates.
crates/ql-exec/src/workbook_runtime/cells.rs:2376:    /// Phase 4.7.J.3 — a re-spill of DIFFERENT shape fires
crates/ql-exec/src/workbook_runtime/cells.rs:2377:    /// `on_set_value` for the UNION of old and new footprints
crates/ql-exec/src/workbook_runtime/cells.rs:2378:    /// (excluding the anchor), each cell only ONCE. Tests the
crates/ql-exec/src/workbook_runtime/cells.rs:2379:    /// HashSet-based dedupe.
crates/ql-exec/src/workbook_runtime/cells.rs:2407:    /// Phase 4.7.J.3 — blocked spill DOES NOT fire `on_set_value` at
crates/ql-exec/src/workbook_runtime/cells.rs:2408:    /// non-existent target cells (because no new footprint is
crates/ql-exec/src/workbook_runtime/cells.rs:2409:    /// registered). The OLD footprint cells still fire if there was
crates/ql-exec/src/workbook_runtime/cells.rs:2410:    /// a prior spill at this anchor.
crates/ql-exec/src/workbook_runtime/cells.rs:2439:    /// Phase 4.7.J.2 — clear-old idempotency: setting the SAME array
crates/ql-exec/src/workbook_runtime/cells.rs:2440:    /// twice at the same anchor produces stable state (no infinite
crates/ql-exec/src/workbook_runtime/cells.rs:2441:    /// re-spill, no self-blocking).
crates/ql-exec/src/workbook_runtime/cells.rs:2469:    /// Phase 4.7.J.4 — the canonical HIGH-1 scenario:
crates/ql-exec/src/workbook_runtime/cells.rs:2470:    /// 1. Bind reader B1 = A2 (no spill yet at A1; B1's dep is (0,1,0)).
crates/ql-exec/src/workbook_runtime/cells.rs:2471:    /// 2. Set A1 = `{1, 2, 3}` (spills to A1, B1, C1).
crates/ql-exec/src/workbook_runtime/cells.rs:2472:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:2473:    /// Wait — A1's spill goes HORIZONTAL across A1, B1, C1, not vertical.
crates/ql-exec/src/workbook_runtime/cells.rs:2474:    /// To put a target at A2, we need a VERTICAL spill: A1 = `{1;2;3}`
crates/ql-exec/src/workbook_runtime/cells.rs:2475:    /// spills to A1, A2, A3. Then B1 = A2 reads target A2.
crates/ql-exec/src/workbook_runtime/cells.rs:2476:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:2477:    /// After the spill registers, B1's dep MUST be (0,0,0) (the anchor)
crates/ql-exec/src/workbook_runtime/cells.rs:2478:    /// and the graph MUST have a B1 → A1 edge.
crates/ql-exec/src/workbook_runtime/cells.rs:2517:    /// Phase 4.7.J.4 — dissolution case: a reader bound AFTER the spill
crates/ql-exec/src/workbook_runtime/cells.rs:2518:    /// gets aliased to the anchor. When the spill dissolves, the alias
crates/ql-exec/src/workbook_runtime/cells.rs:2519:    /// must be re-routed back to the underlying target cell.
crates/ql-exec/src/workbook_runtime/cells.rs:2553:    /// Phase 4.7.J.4 — dedupe across the union: a reader at (0,0,4)
crates/ql-exec/src/workbook_runtime/cells.rs:2554:    /// whose dep is in BOTH old (B1, prior shape 1×3) and new (B1, new
crates/ql-exec/src/workbook_runtime/cells.rs:2555:    /// shape 1×4) footprints should be re-extracted ONCE, not twice.
crates/ql-exec/src/workbook_runtime/cells.rs:2556:    /// We assert via the formula_deps content + a hook counter check
crates/ql-exec/src/workbook_runtime/cells.rs:2557:    /// would be ideal but extract_and_register_deps doesn't have a
crates/ql-exec/src/workbook_runtime/cells.rs:2558:    /// dedicated counter; we instead verify the final dep state is
crates/ql-exec/src/workbook_runtime/cells.rs:2559:    /// correct.
crates/ql-exec/src/workbook_runtime/cells.rs:2589:    /// Phase 4.7.J.4 — blocked spill case: when a writeback returns
crates/ql-exec/src/workbook_runtime/cells.rs:2590:    /// #SPILL! (no new footprint registered), no NEW-footprint readers
crates/ql-exec/src/workbook_runtime/cells.rs:2591:    /// need re-extraction (only OLD-footprint, if any). Verify by
crates/ql-exec/src/workbook_runtime/cells.rs:2592:    /// blocking a spill that has no prior footprint AND a pre-existing
crates/ql-exec/src/workbook_runtime/cells.rs:2593:    /// reader at the would-be target.
crates/ql-exec/src/workbook_runtime/cells.rs:2625:    /// Phase 4.7.J.5 — happy path: A1 anchors a 1×3 spill (A1, B1, C1).
crates/ql-exec/src/workbook_runtime/cells.rs:2626:    /// Then set a scalar formula at B1. Result: host spill dissolved
crates/ql-exec/src/workbook_runtime/cells.rs:2627:    /// (B1's value is the new formula; A2/A3 — wait this is horizontal,
crates/ql-exec/src/workbook_runtime/cells.rs:2628:    /// so A1=1, B1=2, C1=3 originally. After dissolving + setting B1=99:
crates/ql-exec/src/workbook_runtime/cells.rs:2629:    /// host spill gone, A1 still has formula text, B1 = 99, C1 = Blank.
crates/ql-exec/src/workbook_runtime/cells.rs:2665:    /// Phase 4.7.J.5 — anchor cell is NOT treated as a "target" by the
crates/ql-exec/src/workbook_runtime/cells.rs:2666:    /// dissolution check. Setting a formula at the anchor follows the
crates/ql-exec/src/workbook_runtime/cells.rs:2667:    /// existing clear-old path (4.7.J.2 MEDIUM-4 closure), not the new
crates/ql-exec/src/workbook_runtime/cells.rs:2668:    /// MEDIUM-3 dissolution path. Verifies that writing a NEW array at
crates/ql-exec/src/workbook_runtime/cells.rs:2669:    /// the same anchor reshapes correctly without spuriously calling
crates/ql-exec/src/workbook_runtime/cells.rs:2670:    /// clear_spill_at twice (which would error the second time).
crates/ql-exec/src/workbook_runtime/cells.rs:2696:    /// Phase 4.7.J.5 — array formula INTO a spill target also dissolves
crates/ql-exec/src/workbook_runtime/cells.rs:2697:    /// the host AND can register a NEW spill rooted at the target cell.
crates/ql-exec/src/workbook_runtime/cells.rs:2698:    /// (Excel canon: typing IS allowed, dissolution propagates.)
crates/ql-exec/src/workbook_runtime/cells.rs:2725:    /// Phase 4.7.J.5 — non-target write is unaffected by the
crates/ql-exec/src/workbook_runtime/cells.rs:2726:    /// dissolution check (negative control: no spurious clear when
crates/ql-exec/src/workbook_runtime/cells.rs:2727:    /// the target cell isn't part of any spill).
crates/ql-exec/src/workbook_runtime/cells.rs:2763:    /// Host A1 spills A1..C1. Reader D1 = C1 (aliased to A1 by 4.7.I).
crates/ql-exec/src/workbook_runtime/cells.rs:2764:    /// User sets B1 = 99 (scalar formula) → J.5 dissolves A1's spill.
crates/ql-exec/src/workbook_runtime/cells.rs:2765:    /// After dissolution, D1's dep must be RE-EXTRACTED (no longer
crates/ql-exec/src/workbook_runtime/cells.rs:2766:    /// aliased — A1 isn't a spill anchor anymore; D1 should reference
crates/ql-exec/src/workbook_runtime/cells.rs:2767:    /// C1 literally).
crates/ql-exec/src/workbook_runtime/cells.rs:2801:    /// Host A1 spills A1..C1. User sets B1 = 5 — J.5 dissolves A1.
crates/ql-exec/src/workbook_runtime/cells.rs:2802:    /// The host anchor A1's NodeId must be in the dirty set so the
crates/ql-exec/src/workbook_runtime/cells.rs:2803:    /// next recompute_dirty re-evaluates A1's formula and produces
crates/ql-exec/src/workbook_runtime/cells.rs:2804:    /// #SPILL!. Without this, A1 stays stale indefinitely in
crates/ql-exec/src/workbook_runtime/cells.rs:2805:    /// incremental mode.
crates/ql-exec/src/workbook_runtime/cells.rs:2831:    /// Host A1 spills A1..C1. Reader X1 = B1 (also aliased to A1).
crates/ql-exec/src/workbook_runtime/cells.rs:2832:    /// User sets C1 = 5 — J.5 dissolves A1. X1 (a reader of a
crates/ql-exec/src/workbook_runtime/cells.rs:2833:    /// DIFFERENT host-target cell) must dirty too, because B1's
crates/ql-exec/src/workbook_runtime/cells.rs:2834:    /// spilled value is gone.
crates/ql-exec/src/workbook_runtime/cells.rs:2882:    /// Closes the design § 10.3 gap: clear_formula at A1 (spill anchor)
crates/ql-exec/src/workbook_runtime/cells.rs:2883:    /// must dissolve A1's 1×3 spill, clearing B1/C1 computed overlays
crates/ql-exec/src/workbook_runtime/cells.rs:2884:    /// and removing the anchor + target entries.
crates/ql-exec/src/workbook_runtime/cells.rs:2942:    /// Clear at a non-anchor cell (no spill anchored there) — original
crates/ql-exec/src/workbook_runtime/cells.rs:2943:    /// clear_formula behavior preserved. Negative control.
crates/ql-exec/src/workbook_runtime/cells.rs:2972:    /// **Sonnet megaudit follow-up** — clear_formula at a spill anchor
crates/ql-exec/src/workbook_runtime/cells.rs:2973:    /// must emit exactly ONE op (ClearFormula), no spurious PutValue
crates/ql-exec/src/workbook_runtime/cells.rs:2974:    /// for the array.at(0,0) value. Pins the spill-anchor branch's
crates/ql-exec/src/workbook_runtime/cells.rs:2975:    /// op-log payload AND verifies the new atomicity ordering (op-log
crates/ql-exec/src/workbook_runtime/cells.rs:2976:    /// append happens BEFORE clear_spill_at).
crates/ql-exec/src/workbook_runtime/cells.rs:3008:    /// Closes design § 10.3 dirty-propagation: clear_formula at an
crates/ql-exec/src/workbook_runtime/cells.rs:3009:    /// anchor must fire on_set_value for each non-anchor cell in the
crates/ql-exec/src/workbook_runtime/cells.rs:3010:    /// dissolved footprint, so readers indexed under those addresses
crates/ql-exec/src/workbook_runtime/cells.rs:3011:    /// dirty for next recompute.
crates/ql-exec/src/workbook_runtime/cells.rs:3036:    /// **W5-108 (Phase 4.7.O) — Codex HIGH BLOCKER closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3037:    /// `clear_formula` at a spill anchor must re-extract producer-
crates/ql-exec/src/workbook_runtime/cells.rs:3038:    /// aliased readers so their deps re-route back to literal cell
crates/ql-exec/src/workbook_runtime/cells.rs:3039:    /// addresses. Mirrors `set_value_at_spill_target_reextracts_aliased_readers`
crates/ql-exec/src/workbook_runtime/cells.rs:3040:    /// but drives via `clear_formula(anchor)` instead.
crates/ql-exec/src/workbook_runtime/cells.rs:3041:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:3042:    /// Pre-fix: clear_formula fired `on_set_value` for old targets but
crates/ql-exec/src/workbook_runtime/cells.rs:3043:    /// skipped `reextract_spill_footprint_readers`. A reader `X1=B1`
crates/ql-exec/src/workbook_runtime/cells.rs:3044:    /// (where B1 was a spill target of A1) kept its dep on A1 — a
crates/ql-exec/src/workbook_runtime/cells.rs:3045:    /// later `set_value(B1, 5)` would NOT dirty X1 because X1's graph
crates/ql-exec/src/workbook_runtime/cells.rs:3046:    /// dep no longer matched B1.
crates/ql-exec/src/workbook_runtime/cells.rs:3094:    /// HIGH-2 acceptance: op-log replay of `PutFormula { text:
crates/ql-exec/src/workbook_runtime/cells.rs:3095:    /// "{1, 2, 3}" }` followed by `recompute_all` MUST produce the
crates/ql-exec/src/workbook_runtime/cells.rs:3096:    /// spill, not `#CALC!`. This is the canonical persistence
crates/ql-exec/src/workbook_runtime/cells.rs:3097:    /// round-trip — the design § 7.3 / § 12.3 "load → recompute
crates/ql-exec/src/workbook_runtime/cells.rs:3098:    /// re-derives spills" contract.
crates/ql-exec/src/workbook_runtime/cells.rs:3127:    /// recompute_all on a SCALAR formula keeps its existing behavior
crates/ql-exec/src/workbook_runtime/cells.rs:3128:    /// — pre-fix this case used `eval_scalar_with_cache` directly,
crates/ql-exec/src/workbook_runtime/cells.rs:3129:    /// which is what the refactor preserves for non-Array results.
crates/ql-exec/src/workbook_runtime/cells.rs:3130:    /// Regression check.
crates/ql-exec/src/workbook_runtime/cells.rs:3147:    /// recompute_all on an array formula that would spill out of
crates/ql-exec/src/workbook_runtime/cells.rs:3148:    /// bounds writes #SPILL! at the anchor — same as set_formula's
crates/ql-exec/src/workbook_runtime/cells.rs:3149:    /// bounds-check arm. Pre-fix this case produced #CALC! too
crates/ql-exec/src/workbook_runtime/cells.rs:3150:    /// (silent corruption); post-fix it produces #SPILL!.
crates/ql-exec/src/workbook_runtime/cells.rs:3168:    /// Re-run of recompute_all on an already-spilled formula must
crates/ql-exec/src/workbook_runtime/cells.rs:3169:    /// be idempotent: the spill stays registered with the same
crates/ql-exec/src/workbook_runtime/cells.rs:3170:    /// shape, the target values match. Validates that
crates/ql-exec/src/workbook_runtime/cells.rs:3171:    /// `clear_spill_if_present` inside the recompute path correctly
crates/ql-exec/src/workbook_runtime/cells.rs:3172:    /// dissolves the old footprint before re-spilling.
crates/ql-exec/src/workbook_runtime/cells.rs:3196:    /// set_value at a spill TARGET cell dissolves the host spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3197:    /// A1 spills A1..C1; user types `5` at B1. After: host spill
crates/ql-exec/src/workbook_runtime/cells.rs:3198:    /// gone, B1 = 5, C1 = Blank, A1 still has formula text "{1,2,3}"
crates/ql-exec/src/workbook_runtime/cells.rs:3199:    /// (re-eval at next recompute emits #SPILL!).
crates/ql-exec/src/workbook_runtime/cells.rs:3220:    /// set_value at a spill ANCHOR cell dissolves its own spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3221:    /// A1 spills A1..C1; user types `99` at A1. After: spill gone,
crates/ql-exec/src/workbook_runtime/cells.rs:3222:    /// A1 = 99 (user lane), B1 = Blank, C1 = Blank, A1 has no
crates/ql-exec/src/workbook_runtime/cells.rs:3223:    /// formula text anymore.
crates/ql-exec/src/workbook_runtime/cells.rs:3244:    /// Negative control: set_value at a cell that isn't part of any
crates/ql-exec/src/workbook_runtime/cells.rs:3245:    /// spill behaves exactly as before this commit.
crates/ql-exec/src/workbook_runtime/cells.rs:3268:    /// set_value at spill target marks the host anchor's NodeId dirty
crates/ql-exec/src/workbook_runtime/cells.rs:3269:    /// so recompute_dirty re-evaluates and produces #SPILL!. Mirrors
crates/ql-exec/src/workbook_runtime/cells.rs:3270:    /// 4.7.J #127 host-anchor-dirty test.
crates/ql-exec/src/workbook_runtime/cells.rs:3293:    /// set_value at spill target re-extracts readers aliased to the
crates/ql-exec/src/workbook_runtime/cells.rs:3294:    /// host anchor. X1 = C1 was aliased to A1 via 4.7.I; after
crates/ql-exec/src/workbook_runtime/cells.rs:3295:    /// set_value at B1 dissolves A1's spill, X1's dep should be
crates/ql-exec/src/workbook_runtime/cells.rs:3296:    /// re-extracted to literal (0,0,2) and X1 should be dirty.
crates/ql-exec/src/workbook_runtime/cells.rs:3331:    /// set_value over an existing formula at a spill anchor — fires
crates/ql-exec/src/workbook_runtime/cells.rs:3332:    /// BOTH the spill dissolution AND the formula-clearing path. The
crates/ql-exec/src/workbook_runtime/cells.rs:3333:    /// op-log should record PutValue + ClearFormula in a BatchCommit.
crates/ql-exec/src/workbook_runtime/cells.rs:3358:    /// `=SEQUENCE(3)` at A1 spills 3×1 vertically (A1, A2, A3).
crates/ql-exec/src/workbook_runtime/cells.rs:3377:    /// `=SEQUENCE(2, 3)` at A1 spills 2×3 (A1..C2).
crates/ql-exec/src/workbook_runtime/cells.rs:3400:    /// `=SEQUENCE(0)` → scalar `#NUM!` per design § 13.1 (W5-108 /
crates/ql-exec/src/workbook_runtime/cells.rs:3401:    /// Phase 4.7.O Codex M2 closure). Pre-fix returned a degenerate
crates/ql-exec/src/workbook_runtime/cells.rs:3402:    /// ArrayValue which write_spill mapped to `#CALC!`; design says
crates/ql-exec/src/workbook_runtime/cells.rs:3403:    /// Excel canon is `#NUM!` for `rows < 1`.
crates/ql-exec/src/workbook_runtime/cells.rs:3415:    /// `=SEQUENCE(3)` after replay + recompute_all re-derives the spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3416:    /// This is THE 4.7.J #128 acceptance — recompute_all dispatches
crates/ql-exec/src/workbook_runtime/cells.rs:3417:    /// the SEQUENCE function as Array.
crates/ql-exec/src/workbook_runtime/cells.rs:3438:    /// `=SEQUENCE(3) + 1` (scalar context, not at cell boundary) → #CALC!
crates/ql-exec/src/workbook_runtime/cells.rs:3439:    /// The outer `+ 1` makes SEQUENCE evaluate in scalar-sub-expression
crates/ql-exec/src/workbook_runtime/cells.rs:3440:    /// context; the FunctionReturn::Array routes to #CALC! per design
crates/ql-exec/src/workbook_runtime/cells.rs:3441:    /// § 6.3. End-to-end through set_formula.
crates/ql-exec/src/workbook_runtime/cells.rs:3455:    /// `=TRANSPOSE({1, 2, 3})` at A1 spills 3×1 vertically.
crates/ql-exec/src/workbook_runtime/cells.rs:3472:    /// `=TRANSPOSE({1; 2; 3})` at A1 spills 1×3 horizontally.
crates/ql-exec/src/workbook_runtime/cells.rs:3489:    /// `=TRANSPOSE({1, 2; 3, 4})` swaps a 2×2 matrix's off-diagonal.
crates/ql-exec/src/workbook_runtime/cells.rs:3509:    /// TRANSPOSE composed with SEQUENCE: `=TRANSPOSE(SEQUENCE(3))` —
crates/ql-exec/src/workbook_runtime/cells.rs:3510:    /// outer is TRANSPOSE, inner is SEQUENCE. Args evaluate via
crates/ql-exec/src/workbook_runtime/cells.rs:3511:    /// `eval_scalar_with_cache` which for an Array-returning Unified
crates/ql-exec/src/workbook_runtime/cells.rs:3512:    /// function in scalar context returns #CALC!. So TRANSPOSE
crates/ql-exec/src/workbook_runtime/cells.rs:3513:    /// receives FunctionArg::Scalar(#CALC!) and propagates the error.
crates/ql-exec/src/workbook_runtime/cells.rs:3514:    /// Pins design § 6.3 (no nested array composition in v1).
crates/ql-exec/src/workbook_runtime/cells.rs:3529:    /// **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3530:    /// FILTER composed with SEQUENCE — outer FILTER, inner SEQUENCE.
crates/ql-exec/src/workbook_runtime/cells.rs:3531:    /// Same v1 limitation as TRANSPOSE(SEQUENCE(...)): the inner
crates/ql-exec/src/workbook_runtime/cells.rs:3532:    /// Array-returning function in scalar context collapses to #CALC!.
crates/ql-exec/src/workbook_runtime/cells.rs:3533:    /// Pins design § 6.3 uniformly across the three array-returning
crates/ql-exec/src/workbook_runtime/cells.rs:3534:    /// functions.
crates/ql-exec/src/workbook_runtime/cells.rs:3548:    /// **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3549:    /// SEQUENCE composed with SEQUENCE — outer SEQUENCE expects a
crates/ql-exec/src/workbook_runtime/cells.rs:3550:    /// scalar `rows` arg; the inner SEQUENCE in scalar context
crates/ql-exec/src/workbook_runtime/cells.rs:3551:    /// returns #CALC!. Coerces to the outer's #VALUE! path via the
crates/ql-exec/src/workbook_runtime/cells.rs:3552:    /// number-coercion fallback (or propagates the error). Either way
crates/ql-exec/src/workbook_runtime/cells.rs:3553:    /// the result is a scalar error, NOT a spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3573:    /// `=FILTER({1,2,3,4}, {TRUE,FALSE,TRUE,FALSE})` spills 1×2 with
crates/ql-exec/src/workbook_runtime/cells.rs:3574:    /// kept values 1 and 3.
crates/ql-exec/src/workbook_runtime/cells.rs:3591:    /// `=FILTER({1;2;3;4}, {TRUE;FALSE;TRUE;FALSE})` spills 2×1
crates/ql-exec/src/workbook_runtime/cells.rs:3592:    /// preserving column orientation.
crates/ql-exec/src/workbook_runtime/cells.rs:3609:    /// `=FILTER({1,2,3}, {FALSE,FALSE,FALSE})` with no if_empty →
crates/ql-exec/src/workbook_runtime/cells.rs:3610:    /// degenerate result → #CALC! at anchor, no spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3624:    /// `=FILTER({1,2,3}, {FALSE,FALSE,FALSE}, "none")` with if_empty
crates/ql-exec/src/workbook_runtime/cells.rs:3625:    /// → singleton spill of "none".
crates/ql-exec/src/workbook_runtime/cells.rs:3651:    /// Codex HIGH closure: `=TRANSPOSE(MyRange)` with `MyRange` a named
crates/ql-exec/src/workbook_runtime/cells.rs:3652:    /// range must bind cleanly — `is_aggregate_function` claims TRANSPOSE
crates/ql-exec/src/workbook_runtime/cells.rs:3653:    /// so the binder routes the named-range arg through Range context.
crates/ql-exec/src/workbook_runtime/cells.rs:3654:    /// Before the audit fix, this surfaced `NamedRangeInScalarContext`.
crates/ql-exec/src/workbook_runtime/cells.rs:3688:    /// Codex HIGH closure: `=FILTER(Data, Mask)` with both args as named
crates/ql-exec/src/workbook_runtime/cells.rs:3689:    /// ranges must bind. The binder previously rejected this with
crates/ql-exec/src/workbook_runtime/cells.rs:3690:    /// `NamedRangeInScalarContext`.
crates/ql-exec/src/workbook_runtime/cells.rs:3729:    /// Sonnet LOW closure: TRANSPOSE referencing live cells via a named
crates/ql-exec/src/workbook_runtime/cells.rs:3730:    /// range must update through recompute_dirty when the source cells
crates/ql-exec/src/workbook_runtime/cells.rs:3731:    /// change. Pins that the producer-alias rewrite + spill-footprint
crates/ql-exec/src/workbook_runtime/cells.rs:3732:    /// hooks work for TRANSPOSE the same as they do for SEQUENCE.
crates/ql-exec/src/workbook_runtime/cells.rs:3779:    /// Sonnet MEDIUM closure: FILTER shape transition through
crates/ql-exec/src/workbook_runtime/cells.rs:3780:    /// recompute_dirty. Pre: include mask keeps 2 of 4 → 1×2 spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3781:    /// Mutate the mask so 3 of 4 are kept → 1×3 spill. Pins that:
crates/ql-exec/src/workbook_runtime/cells.rs:3782:    /// (a) the spill-footprint hooks fire on FILTER's recompute_dirty
crates/ql-exec/src/workbook_runtime/cells.rs:3783:    /// path, (b) the fixed-point loop catches the mid-pass shape
crates/ql-exec/src/workbook_runtime/cells.rs:3784:    /// transition, (c) old footprint cells are cleared.
crates/ql-exec/src/workbook_runtime/cells.rs:3855:    /// Shape transition through recompute_dirty: A1 = 3, B1 = SEQUENCE(A1)
crates/ql-exec/src/workbook_runtime/cells.rs:3856:    /// (spills B1..B3). Change A1 to 5; recompute_dirty re-evaluates B1
crates/ql-exec/src/workbook_runtime/cells.rs:3857:    /// → write_spill clears old 3x1 footprint, registers new 5x1, writes
crates/ql-exec/src/workbook_runtime/cells.rs:3858:    /// B1..B5. Pins that the shape transition itself works.
crates/ql-exec/src/workbook_runtime/cells.rs:3894:    /// Shape transition shrinkage: A1 = 5, B1 = SEQUENCE(A1) (5x1).
crates/ql-exec/src/workbook_runtime/cells.rs:3895:    /// Change A1 to 2; expect B1 to spill 2x1, B3..B5 to become Blank.
crates/ql-exec/src/workbook_runtime/cells.rs:3930:    /// **Codex audit HIGH-1**: aliased readers don't re-eval when
crates/ql-exec/src/workbook_runtime/cells.rs:3931:    /// target values change but anchor value is unchanged.
crates/ql-exec/src/workbook_runtime/cells.rs:3932:    /// C1=SEQUENCE(3,1,1,A1), D1=C3. The anchor's value (start=1) is
crates/ql-exec/src/workbook_runtime/cells.rs:3933:    /// invariant across A1 changes; only C2 and C3 change.
crates/ql-exec/src/workbook_runtime/cells.rs:3934:    /// D1 is producer-aliased to C1 (4.7.I); D1 indexed at C1's
crates/ql-exec/src/workbook_runtime/cells.rs:3935:    /// address. Without the fix, recompute_dirty leaves D1 stale.
crates/ql-exec/src/workbook_runtime/cells.rs:3936:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:3937:    /// Closed by: hook pass ALSO fires on_set_value at the anchor
crates/ql-exec/src/workbook_runtime/cells.rs:3938:    /// cell, so aliased readers (cell_to_formulas[anchor]) get dirtied.
crates/ql-exec/src/workbook_runtime/cells.rs:3976:    /// **Codex audit HIGH-2**: after recompute-time spill dissolution,
crates/ql-exec/src/workbook_runtime/cells.rs:3977:    /// aliased readers don't get re-extracted. Subsequent user writes
crates/ql-exec/src/workbook_runtime/cells.rs:3978:    /// to the (now-free) target cells don't dirty the readers.
crates/ql-exec/src/workbook_runtime/cells.rs:3979:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:3980:    /// A1=3, B1=SEQUENCE(A1) (spill B1..B3). X1=B2 (aliased to B1).
crates/ql-exec/src/workbook_runtime/cells.rs:3981:    /// A1=0 → B1=#CALC!, spill dissolved.
crates/ql-exec/src/workbook_runtime/cells.rs:3982:    /// User set_value(B2, 99). X1 should see B2=99.
crates/ql-exec/src/workbook_runtime/cells.rs:3983:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:3984:    /// Closed by: recompute_dirty calls reextract_spill_footprint_readers
crates/ql-exec/src/workbook_runtime/cells.rs:3985:    /// for the (old, new) footprints, mirroring set_formula 4.7.J.4.
crates/ql-exec/src/workbook_runtime/cells.rs:4039:    /// **#136 closure**: A1 = 3, B1 = SEQUENCE(A1) (spills B1..B3),
crates/ql-exec/src/workbook_runtime/cells.rs:4040:    /// D1 = B5 (currently Blank — references a cell OUTSIDE the spill
crates/ql-exec/src/workbook_runtime/cells.rs:4041:    /// footprint). Change A1 to 5; B1 now spills B1..B5. D1 should see
crates/ql-exec/src/workbook_runtime/cells.rs:4042:    /// B5 = 5 and update.
crates/ql-exec/src/workbook_runtime/cells.rs:4043:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:4044:    /// Closed by: (a) `try_recompute_with_simd_profile` now fires
crates/ql-exec/src/workbook_runtime/cells.rs:4045:    /// on_set_value for non-anchor cells in (old ∪ new) spill footprint
crates/ql-exec/src/workbook_runtime/cells.rs:4046:    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
crates/ql-exec/src/workbook_runtime/cells.rs:4047:    /// a fixed-point loop so mid-pass dirties (D1 dirtied by B1's
crates/ql-exec/src/workbook_runtime/cells.rs:4048:    /// recompute writing B5) get picked up in a follow-up iteration.
crates/ql-exec/src/workbook_runtime/cells.rs:4416:    /// **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
crates/ql-exec/src/workbook_runtime/cells.rs:4417:    /// must (a) invoke the calcgraph `on_table_drop` hook so any
crates/ql-exec/src/workbook_runtime/cells.rs:4418:    /// formula referencing the dropped table is BFS-dirtied, (b)
crates/ql-exec/src/workbook_runtime/cells.rs:4419:    /// invalidate the plan cache so the next bind doesn't HIT a stale
crates/ql-exec/src/workbook_runtime/cells.rs:4420:    /// `ExprPlan::StructuredRef`, and (c) write `#NAME?` to those
crates/ql-exec/src/workbook_runtime/cells.rs:4421:    /// cells on the next `recompute_dirty`. W5-155 shipped (a) but not
crates/ql-exec/src/workbook_runtime/cells.rs:4422:    /// (b) or (c), leaving the hook functionally inert (the cache hit
crates/ql-exec/src/workbook_runtime/cells.rs:4423:    /// served the pre-drop range and eval read the same data cells).
crates/ql-exec/src/workbook_runtime/cells.rs:4424:    /// W5-156 closes HIGH-1 (cache flush in `drop_table`) + HIGH-2
crates/ql-exec/src/workbook_runtime/cells.rs:4425:    /// (bind-error → cell-value mapping at recompute_dirty:3266).
crates/ql-exec/src/workbook_runtime/cells.rs:4490:    /// **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):** transitive BFS
crates/ql-exec/src/workbook_runtime/cells.rs:4491:    /// fanout. C1 = B1 + 1 depends on B1 = SUM(Sales[Qty]). Dropping
crates/ql-exec/src/workbook_runtime/cells.rs:4492:    /// Sales must dirty BOTH B1 (direct reader) AND C1 (transitive via
crates/ql-exec/src/workbook_runtime/cells.rs:4493:    /// the W5-91 H2 BFS pattern from `mark_dirty_from_cell_write`);
crates/ql-exec/src/workbook_runtime/cells.rs:4494:    /// recompute then propagates #NAME? through the chain.
crates/ql-exec/src/workbook_runtime/cells.rs:4551:    /// **Mixed-relativity R1C1 range REJECTED at parse time.**
crates/ql-exec/src/workbook_runtime/cells.rs:4552:    /// `R1C1:R[10]C5` mixes absolute + relative on the row axis →
crates/ql-exec/src/workbook_runtime/cells.rs:4553:    /// `ParseError::R1C1MixedRelativity` (W5-139). The runtime
crates/ql-exec/src/workbook_runtime/cells.rs:4554:    /// surfaces this as `RuntimeError::Parse(_)`.
crates/ql-exec/src/workbook_runtime/cells.rs:4565:    /// **`Sales[@Col]` vs `@Sales[Qty]` AST disambiguation.**
crates/ql-exec/src/workbook_runtime/cells.rs:4566:    /// Both produce structured-ref evaluation narrowed to the
crates/ql-exec/src/workbook_runtime/cells.rs:4567:    /// formula's row, but the parser path differs (in-bracket `@`
crates/ql-exec/src/workbook_runtime/cells.rs:4568:    /// stays in StructuredRef.bracket_content; outside-bracket `@`
crates/ql-exec/src/workbook_runtime/cells.rs:4569:    /// is `Token::At`). After W5-144's binder patch they
crates/ql-exec/src/workbook_runtime/cells.rs:4570:    /// canonicalize to ExprPlan::StructuredRef with
crates/ql-exec/src/workbook_runtime/cells.rs:4571:    /// `is_this_row: true`, so the OUTPUT VALUE is identical.
crates/ql-exec/src/workbook_runtime/cells.rs:4614:    /// **`@A:A` (whole-column inside `@`) evals at formula's row.**
crates/ql-exec/src/workbook_runtime/cells.rs:4615:    /// `@A:A` at cell (3, 1) → reads A4 (row 3, col 0).
crates/ql-exec/src/workbook_runtime/cells.rs:4630:    /// **`@1:1` (whole-row inside `@`) evals at formula's col.**
crates/ql-exec/src/workbook_runtime/cells.rs:4631:    /// `@1:1` at cell (3, 2) → reads C1 (row 0, col 2).
crates/ql-exec/src/workbook_runtime/cells.rs:4645:    /// **`Sheet1!@A1` resolves with sheet prefix + `@` wrapping.**
crates/ql-exec/src/workbook_runtime/cells.rs:4646:    /// The sheet binds to the inner CellRef (W5-143
crates/ql-exec/src/workbook_runtime/cells.rs:4647:    /// `apply_sheet_to_term` recurses INTO the wrapper).
crates/ql-exec/src/workbook_runtime/cells.rs:4664:    /// **R1C1 input + EN locale + same anchor → A1 canonical
crates/ql-exec/src/workbook_runtime/cells.rs:4665:    /// stored.** Round-trip: write `R1C1+R2C2` in R1C1 mode,
crates/ql-exec/src/workbook_runtime/cells.rs:4666:    /// reload (replay), the stored canonical text re-binds and
crates/ql-exec/src/workbook_runtime/cells.rs:4667:    /// evaluates identically.
crates/ql-exec/src/workbook_runtime/cells.rs:4721:    /// **DE locale input round-trips through oplog replay.**
crates/ql-exec/src/workbook_runtime/cells.rs:4722:    /// `SUM(2,5; 3,5)` in DE locale → canonical `SUM(2.5, 3.5)` in
crates/ql-exec/src/workbook_runtime/cells.rs:4723:    /// op-log → replay against fresh workbook → identical result.
crates/ql-exec/src/workbook_runtime/cells.rs:4747:    /// **`@` survives op-log replay.** `@A1` in producer → `@A1` in
crates/ql-exec/src/workbook_runtime/cells.rs:4748:    /// replayed workbook (mode/locale-invariant).
crates/ql-exec/src/workbook_runtime/cells.rs:4776:    /// **Switching reference_mode does NOT mutate stored formula
crates/ql-exec/src/workbook_runtime/cells.rs:4777:    /// text.** Per design § 4.4 storage canon, the stored text is
crates/ql-exec/src/workbook_runtime/cells.rs:4778:    /// always A1+EnUs regardless of the current workbook display
crates/ql-exec/src/workbook_runtime/cells.rs:4779:    /// mode. Verifies the canonical contract: changing the
crates/ql-exec/src/workbook_runtime/cells.rs:4780:    /// reference_mode is a display-only preference.
crates/ql-exec/src/workbook_runtime/cells.rs:4803:    /// **DE locale change does NOT mutate stored formula text.**
crates/ql-exec/src/workbook_runtime/cells.rs:4804:    /// Same canonical contract — locale switch is display-only.
crates/ql-exec/src/workbook_runtime/cells.rs:4824:    /// **`@scalar` is idempotent: `@5` evaluates to `5`.**
crates/ql-exec/src/workbook_runtime/cells.rs:4825:    /// Design § 3.3 rule 1 — scalar inputs pass through unchanged.
crates/ql-exec/src/workbook_runtime/cells.rs:4835:    /// **`@SUM(scalar args)` evaluates identically to `SUM(scalar args)`.**
crates/ql-exec/src/workbook_runtime/cells.rs:4836:    /// Design § 3.3 rule 8 — function inner with scalar return. SUM
crates/ql-exec/src/workbook_runtime/cells.rs:4837:    /// of scalar args returns scalar so the `@` wrap is a no-op.
crates/ql-exec/src/workbook_runtime/cells.rs:4838:    /// (Literal `SUM(A1:A3)` over a Range needs aggregate-arg binding
crates/ql-exec/src/workbook_runtime/cells.rs:4839:    /// which v1 routes via named ranges only; using scalar args here
crates/ql-exec/src/workbook_runtime/cells.rs:4840:    /// keeps the test focused on the `@` semantics.)
crates/ql-exec/src/workbook_runtime/cells.rs:4874:    /// **Coverage matrix cell.** Anchor is always `(0, 0, 0)` so the
crates/ql-exec/src/workbook_runtime/cells.rs:4875:    /// expected canonical column can hardcode A1 letters.
crates/ql-exec/src/workbook_runtime/cells.rs:4883:    /// Build the full 30-cell matrix.
crates/ql-exec/src/workbook_runtime/cells.rs:5025:    /// **Coverage matrix driver.** Walks all 30 cells; for each,
crates/ql-exec/src/workbook_runtime/cells.rs:5026:    /// constructs a workbook in the cell's (mode, locale) state,
crates/ql-exec/src/workbook_runtime/cells.rs:5027:    /// calls `set_formula(0, 0, 0, input)`, and asserts the stored
crates/ql-exec/src/workbook_runtime/cells.rs:5028:    /// text equals `expected_canonical`.
crates/ql-exec/src/workbook_runtime/cells.rs:5063:    /// **Coverage matrix has no duplicate cells.** Every
crates/ql-exec/src/workbook_runtime/cells.rs:5064:    /// (mode, locale, input) triple is unique — sanity that the
crates/ql-exec/src/workbook_runtime/cells.rs:5065:    /// matrix builder didn't accidentally repeat a row.
crates/ql-exec/src/workbook_runtime/cells.rs:5077:    /// **4.9.O audit verification:** plan cache collision when
crates/ql-exec/src/workbook_runtime/cells.rs:5078:    /// `@<range>` is used at multiple cells in the same runtime
crates/ql-exec/src/workbook_runtime/cells.rs:5079:    /// session. The W5-144 binder narrows `@A:A` at bind time using
crates/ql-exec/src/workbook_runtime/cells.rs:5080:    /// site.cell, producing a cell-specific `ExprPlan::CellRef`.
crates/ql-exec/src/workbook_runtime/cells.rs:5081:    /// But `PlanCacheKey` is `(canonical_text, sheet, name_gen)` —
crates/ql-exec/src/workbook_runtime/cells.rs:5082:    /// no cell coords. Two cells in the same sheet with the same
crates/ql-exec/src/workbook_runtime/cells.rs:5083:    /// canonical text `@A:A` would hit the cache and get the FIRST
crates/ql-exec/src/workbook_runtime/cells.rs:5084:    /// call's narrowed plan, reading the wrong row.
crates/ql-exec/src/workbook_runtime/cells.rs:5085:    ///
crates/ql-exec/src/workbook_runtime/cells.rs:5086:    /// This test must PASS for the engine to be correct under the
crates/ql-exec/src/workbook_runtime/cells.rs:5087:    /// "same `@<range>` formula at multiple cells" workload.
crates/ql-exec/src/workbook_runtime/cells.rs:5115:    /// **Coverage matrix axis dimensions.** Sanity-pin that the
crates/ql-exec/src/workbook_runtime/cells.rs:5116:    /// matrix has exactly the documented per-axis counts (so a
crates/ql-exec/src/workbook_runtime/cells.rs:5117:    /// future cell-addition forces the axis-count assertion to
crates/ql-exec/src/workbook_runtime/cells.rs:5118:    /// trip until the doc is updated).

exec
/bin/zsh -lc 'rg -n "make_runtime_workbook|fn make_|fn workbook|WorkbookRuntime|RuntimeError|use crate::workbook_runtime|super::" crates/ql-exec/src/workbook_runtime/*.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/sheets.rs:1://! Sheet mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/sheets.rs:10://! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
crates/ql-exec/src/workbook_runtime/sheets.rs:12://! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
crates/ql-exec/src/workbook_runtime/sheets.rs:22:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/sheets.rs:62:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/sheets.rs:78:    ) -> Result<SheetId, RuntimeError> {
crates/ql-exec/src/workbook_runtime/sheets.rs:84:            return Err(RuntimeError::InvalidChunkRows(chunk_rows));
crates/ql-exec/src/workbook_runtime/sheets.rs:88:            return Err(RuntimeError::TooManySheets {
crates/ql-exec/src/workbook_runtime/sheets.rs:102:            .map_err(RuntimeError::SheetName)?;
crates/ql-exec/src/workbook_runtime/sheets.rs:150:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/sheets.rs:155:            RuntimeError::InvalidSheet {
crates/ql-exec/src/workbook_runtime/sheets.rs:233:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/sheets.rs:247:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:276:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:284:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:301:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:303:        assert!(matches!(err, RuntimeError::SheetName(_)));
crates/ql-exec/src/workbook_runtime/sheets.rs:313:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:315:        assert!(matches!(err, RuntimeError::InvalidSheet { .. }));
crates/ql-exec/src/workbook_runtime/sheets.rs:324:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:344:        // Codex HIGH-1: WorkbookRuntime::add_sheet must pre-validate.
crates/ql-exec/src/workbook_runtime/sheets.rs:348:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:350:        assert!(matches!(err, RuntimeError::SheetName(_)));
crates/ql-exec/src/workbook_runtime/sheets.rs:360:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/sheets.rs:362:        assert!(matches!(err, RuntimeError::SheetName(_)));
crates/ql-exec/src/workbook_runtime/sheets.rs:374:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/validate.rs:1://! Validation + transaction API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/validate.rs:11://! - [`WorkbookRuntime::transaction`] (Phase 2A.2 / 2A.3.b) — begin
crates/ql-exec/src/workbook_runtime/validate.rs:15://! - [`WorkbookRuntime::validate_formula`] (Phase 2B.7, GAP-I-04
crates/ql-exec/src/workbook_runtime/validate.rs:19://!   would-be evaluated value or a typed `RuntimeError`.
crates/ql-exec/src/workbook_runtime/validate.rs:28:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/validate.rs:30:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/validate.rs:61:    /// RuntimeError>` to `RecomputeResult` (always returns; no Result
crates/ql-exec/src/workbook_runtime/validate.rs:75:    /// evaluated value (or `RuntimeError`), but does NOT:
crates/ql-exec/src/workbook_runtime/validate.rs:95:    ) -> Result<Value, RuntimeError> {
crates/ql-exec/src/workbook_runtime/validate.rs:147:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/validate.rs:149:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/validate.rs:169:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/validate.rs:173:            Err(RuntimeError::InvalidChunkRows(0)) => {}
crates/ql-exec/src/workbook_runtime/validate.rs:185:    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
crates/ql-exec/src/workbook_runtime/validate.rs:188:        let mut wb = make_runtime_workbook(); // 1 sheet
crates/ql-exec/src/workbook_runtime/validate.rs:190:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:195:                Err(RuntimeError::InvalidSheet {
crates/ql-exec/src/workbook_runtime/validate.rs:206:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:208:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:213:                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
crates/ql-exec/src/workbook_runtime/validate.rs:225:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:230:        let rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/validate.rs:247:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:249:        let rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:251:        assert!(matches!(result, Err(RuntimeError::Parse(_))));
crates/ql-exec/src/workbook_runtime/validate.rs:264:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:266:        let rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:290:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:293:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:453:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:460:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:475:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:482:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:518:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:532:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:572:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:582:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:657:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:661:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:678:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:682:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/validate.rs:700:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/validate.rs:706:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1://! Table mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/tables.rs:9://! - [`WorkbookRuntime::create_table`] (W5-118) — register a new
crates/ql-exec/src/workbook_runtime/tables.rs:12://! - [`WorkbookRuntime::drop_table`] (W5-118) — drop a table,
crates/ql-exec/src/workbook_runtime/tables.rs:15://! - [`WorkbookRuntime::rename_table`] (W5-119) — rename + rewrite
crates/ql-exec/src/workbook_runtime/tables.rs:18://! - [`WorkbookRuntime::rename_column`] (W5-121) — rename a column
crates/ql-exec/src/workbook_runtime/tables.rs:20://! - [`WorkbookRuntime::resize_table`] (W5-122) — change a table's
crates/ql-exec/src/workbook_runtime/tables.rs:35:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/tables.rs:37:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/tables.rs:73:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:78:            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
crates/ql-exec/src/workbook_runtime/tables.rs:81:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:93:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:99:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:105:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:116:                    return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:125:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:131:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:147:                    return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:153:                    return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:225:    pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:228:            return Err(RuntimeError::TableNotFound(name.to_owned()));
crates/ql-exec/src/workbook_runtime/tables.rs:280:    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:284:            return Err(RuntimeError::TableNotFound(old_name.to_owned()));
crates/ql-exec/src/workbook_runtime/tables.rs:293:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:299:            return Err(RuntimeError::TableCreateRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:408:    ) -> Result<usize, RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:415:            .ok_or_else(|| RuntimeError::TableNotFound(table_name.to_owned()))?;
crates/ql-exec/src/workbook_runtime/tables.rs:418:            return Err(RuntimeError::TableColumnNotFound {
crates/ql-exec/src/workbook_runtime/tables.rs:425:            return Err(RuntimeError::TableColumnRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:441:            return Err(RuntimeError::TableColumnRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:581:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:590:                .ok_or_else(|| RuntimeError::TableNotFound(name.to_owned()))?;
crates/ql-exec/src/workbook_runtime/tables.rs:619:            return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:632:            return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:640:            return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:646:            return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:657:                return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:664:            return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:684:                    return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:709:                        return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:716:                    return Err(RuntimeError::TableResizeRejected {
crates/ql-exec/src/workbook_runtime/tables.rs:825:                .get_or_insert::<_, RuntimeError>(cache_key, || {
crates/ql-exec/src/workbook_runtime/tables.rs:868:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/tables.rs:870:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/tables.rs:891:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:924:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:937:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:973:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:990:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1012:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1026:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1030:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:1061:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1064:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1072:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1078:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1097:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1106:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1108:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1115:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1124:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1126:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1129:            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
crates/ql-exec/src/workbook_runtime/tables.rs:1136:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1140:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:1168:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1172:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1184:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1204:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1225:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1228:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1235:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1240:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1266:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1275:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1278:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1295:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1303:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1317:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1320:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1338:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1343:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1352:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1361:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1364:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1376:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1381:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1400:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1402:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1417:            RuntimeError::TableColumnRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1426:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1428:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1433:            RuntimeError::TableColumnNotFound { table, column } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1443:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1445:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1448:            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
crates/ql-exec/src/workbook_runtime/tables.rs:1455:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1457:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1462:            RuntimeError::TableColumnRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1474:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1478:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:1492:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1496:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:1528:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1532:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1548:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1564:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1583:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1586:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1594:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1602:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1631:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1636:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1648:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1665:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1679:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1693:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1696:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1706:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1712:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1732:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1735:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1741:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1761:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1764:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1780:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1801:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1805:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1826:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/tables.rs:1845:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1847:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1850:            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
crates/ql-exec/src/workbook_runtime/tables.rs:1857:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1859:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1864:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1873:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1875:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1883:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1892:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1894:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1912:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1921:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1924:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1933:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1936:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1945:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1947:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1955:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1967:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1969:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:1979:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/tables.rs:1991:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:1995:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:2027:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2031:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:2064:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2066:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2072:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2082:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2105:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2123:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2126:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2142:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2146:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2157:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2160:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2173:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2175:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/tables.rs:2184:        let mut producer_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/tables.rs:2188:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/tables.rs:2194:        let mut replay_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1://! Recompute pipeline for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/recompute.rs:10://! - [`WorkbookRuntime::recompute_all`] — HashMap-order full pass
crates/ql-exec/src/workbook_runtime/recompute.rs:13://! - [`WorkbookRuntime::recompute_dirty`] — incremental graph-
crates/ql-exec/src/workbook_runtime/recompute.rs:36:use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/recompute.rs:38:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/recompute.rs:157:                    if let RuntimeError::Bind(
crates/ql-exec/src/workbook_runtime/recompute.rs:506:                                    match self.plan_cache.get_or_insert::<_, RuntimeError>(
crates/ql-exec/src/workbook_runtime/recompute.rs:557:                        if let RuntimeError::Bind(
crates/ql-exec/src/workbook_runtime/recompute.rs:601:                error: RuntimeError::RecomputeIterationCap,
crates/ql-exec/src/workbook_runtime/recompute.rs:617:    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
crates/ql-exec/src/workbook_runtime/recompute.rs:632:    ) -> Result<Value, RuntimeError> {
crates/ql-exec/src/workbook_runtime/recompute.rs:658:    ) -> Result<Value, RuntimeError> {
crates/ql-exec/src/workbook_runtime/recompute.rs:677:    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
crates/ql-exec/src/workbook_runtime/recompute.rs:703:                .get_or_insert::<_, RuntimeError>(cache_key, || {
crates/ql-exec/src/workbook_runtime/recompute.rs:822:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/recompute.rs:824:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/recompute.rs:834:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:836:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:846:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:862:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:877:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:889:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:920:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:953:        let mut rt = WorkbookRuntime::new(&mut loaded, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:971:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:975:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:997:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1002:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1027:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1033:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1055:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1059:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1084:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1090:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1113:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1117:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1148:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1180:    /// formula text + underlying RuntimeError. No information is lost going
crates/ql-exec/src/workbook_runtime/recompute.rs:1184:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1192:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1203:            matches!(failure.error, RuntimeError::Parse(_)),
crates/ql-exec/src/workbook_runtime/recompute.rs:1214:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1225:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1249:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1255:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1271:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1276:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1292:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1297:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1316:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1323:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1348:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1358:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1372:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1387:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1406:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1411:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1430:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1435:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1452:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1456:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1481:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1488:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1507:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1512:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1533:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1537:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1559:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1563:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1567:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1575:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1583:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1596:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1604:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1607:            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1623:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1627:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1666:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1670:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1694:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1705:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1707:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1720:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1726:                WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1742:    // Phase 3.4 integration: WorkbookRuntime::recompute_dirty drives
crates/ql-exec/src/workbook_runtime/recompute.rs:1751:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1753:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1763:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1768:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1778:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1805:    /// `WorkbookRuntime::set_formula` for the second cycle member
crates/ql-exec/src/workbook_runtime/recompute.rs:1813:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1831:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1856:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1860:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1873:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:1903:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1906:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1935:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1938:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1967:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1970:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:1996:            let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:1999:                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2037:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2040:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2079:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2103:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2110:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2148:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2160:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2174:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2194:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2202:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2212:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2227:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2246:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2271:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2273:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2278:        let mut wb2 = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2279:        let mut rt2 = WorkbookRuntime::new(&mut wb2, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2296:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2300:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2308:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2324:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2328:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2342:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2379:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2383:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2395:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2423:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2427:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2443:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2470:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2474:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2481:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2489:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2503:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2519:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2523:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2528:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2591:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2593:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2608:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2617:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2628:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2642:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2669:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2678:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2689:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2697:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2707:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2716:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2729:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2747:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2764:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2773:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2779:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:2800:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2817:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2830:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2849:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2860:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2874:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2888:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2905:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2922:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2924:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2937:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2948:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2966:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:2976:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:2987:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3015:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:3028:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3038:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:3047:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3063:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:3076:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3105:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/recompute.rs:3116:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3120:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:3134:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/recompute.rs:3138:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/recompute.rs:3142:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/names.rs:1://! Defined-name API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/names.rs:10://! - [`WorkbookRuntime::set_name`] (Phase 2B.5) — register a
crates/ql-exec/src/workbook_runtime/names.rs:14://! - [`WorkbookRuntime::set_sheet_scoped_name`] (W5-92) — register
crates/ql-exec/src/workbook_runtime/names.rs:23:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/names.rs:25:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/names.rs:40:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/names.rs:89:    ///   `RuntimeError::InvalidSheet`.
crates/ql-exec/src/workbook_runtime/names.rs:100:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/names.rs:104:            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
crates/ql-exec/src/workbook_runtime/names.rs:158:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/names.rs:163:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/names.rs:176:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:193:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:197:        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
crates/ql-exec/src/workbook_runtime/names.rs:205:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:209:        assert!(matches!(err, RuntimeError::Name(_)));
crates/ql-exec/src/workbook_runtime/names.rs:221:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/names.rs:257:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:278:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:303:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:309:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:321:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:326:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:336:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:340:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:352:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:356:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:364:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:366:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:368:        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
crates/ql-exec/src/workbook_runtime/names.rs:371:            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
crates/ql-exec/src/workbook_runtime/names.rs:382:    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
crates/ql-exec/src/workbook_runtime/names.rs:388:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:390:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:409:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:411:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:441:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:445:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:449:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
crates/ql-exec/src/workbook_runtime/names.rs:461:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:469:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/names.rs:483:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/names.rs:489:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/config.rs:1://! Workbook-level config setters for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/config.rs:10://! - [`WorkbookRuntime::set_reference_mode`] — switch between A1
crates/ql-exec/src/workbook_runtime/config.rs:12://! - [`WorkbookRuntime::set_locale`] — switch between EnUs / De /
crates/ql-exec/src/workbook_runtime/config.rs:17:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/config.rs:19:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/config.rs:33:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/config.rs:56:    pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/config.rs:76:    use crate::workbook_runtime::WorkbookRuntime;
crates/ql-exec/src/workbook_runtime/config.rs:78:    // Mirror of `super::super::tests::make_runtime_workbook` — the
crates/ql-exec/src/workbook_runtime/config.rs:82:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/config.rs:94:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/config.rs:98:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/config.rs:108:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/config.rs:112:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/config.rs:121:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/config.rs:125:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/config.rs:134:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/config.rs:138:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/formats.rs:1://! Format API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/formats.rs:10://! - [`WorkbookRuntime::intern_format`] — register a format string
crates/ql-exec/src/workbook_runtime/formats.rs:13://! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
crates/ql-exec/src/workbook_runtime/formats.rs:15://!   (`RuntimeError::UnknownFormatId`).
crates/ql-exec/src/workbook_runtime/formats.rs:16://! - [`WorkbookRuntime::read_display`] — read a cell and render it
crates/ql-exec/src/workbook_runtime/formats.rs:19://!   `WorkbookRuntime::format_cache`.
crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:28:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
crates/ql-exec/src/workbook_runtime/formats.rs:81:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/formats.rs:88:                return Err(RuntimeError::UnknownFormatId(fid.0));
crates/ql-exec/src/workbook_runtime/formats.rs:189:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:199:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/formats.rs:218:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/formats.rs:239:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/formats.rs:255:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/formats.rs:282:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/formats.rs:297:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:301:        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
crates/ql-exec/src/workbook_runtime/formats.rs:312:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:328:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:338:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:357:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:378:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:392:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/formats.rs:404:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
crates/ql-exec/src/workbook_runtime/mod.rs:1://! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
crates/ql-exec/src/workbook_runtime/mod.rs:49:// `impl<'a> WorkbookRuntime<'a> { ... }` block to extend the struct
crates/ql-exec/src/workbook_runtime/mod.rs:55://   `RuntimeError` / `RecomputeFailure` / `RecomputeResult` from
crates/ql-exec/src/workbook_runtime/mod.rs:59://   stay on `WorkbookRuntime`).
crates/ql-exec/src/workbook_runtime/mod.rs:101:pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:110:        return Err(RuntimeError::InvalidSheet {
crates/ql-exec/src/workbook_runtime/mod.rs:136:) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:139:        return Err(RuntimeError::InvalidCell {
crates/ql-exec/src/workbook_runtime/mod.rs:147:        return Err(RuntimeError::InvalidCell {
crates/ql-exec/src/workbook_runtime/mod.rs:166:/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
crates/ql-exec/src/workbook_runtime/mod.rs:170:pub struct WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/mod.rs:198:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/mod.rs:218:    /// `RuntimeError::OpLog`.
crates/ql-exec/src/workbook_runtime/error.rs:1://! `WorkbookRuntime` error + result types.
crates/ql-exec/src/workbook_runtime/error.rs:5://! - [`RuntimeError`] — top-level error enum for the runtime pipeline.
crates/ql-exec/src/workbook_runtime/error.rs:30:pub enum RuntimeError {
crates/ql-exec/src/workbook_runtime/error.rs:89:    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
crates/ql-exec/src/workbook_runtime/error.rs:99:    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
crates/ql-exec/src/workbook_runtime/error.rs:104:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
crates/ql-exec/src/workbook_runtime/error.rs:112:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
crates/ql-exec/src/workbook_runtime/error.rs:171:impl From<LexError> for RuntimeError {
crates/ql-exec/src/workbook_runtime/error.rs:177:impl From<BindError> for RuntimeError {
crates/ql-exec/src/workbook_runtime/error.rs:183:/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:186:/// replacing the prior short-circuit `Result<usize, RuntimeError>` return
crates/ql-exec/src/workbook_runtime/error.rs:197:/// Not `Clone` — `RuntimeError` contains `loro::LoroError` (via the
crates/ql-exec/src/workbook_runtime/error.rs:206:    pub error: RuntimeError,
crates/ql-exec/src/workbook_runtime/error.rs:209:/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:211:/// Phase 2B.2 (2026-05-12): replaces the prior `Result<usize, RuntimeError>`
crates/ql-exec/src/workbook_runtime/cells.rs:1://! Cell mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/cells.rs:10://! - [`WorkbookRuntime::set_formula`] — lex → parse → bind → eval →
crates/ql-exec/src/workbook_runtime/cells.rs:14://! - [`WorkbookRuntime::set_value`] — literal write with op-log
crates/ql-exec/src/workbook_runtime/cells.rs:16://! - [`WorkbookRuntime::clear_formula`] — strip a cell's formula
crates/ql-exec/src/workbook_runtime/cells.rs:40:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:42:impl<'a> WorkbookRuntime<'a> {
crates/ql-exec/src/workbook_runtime/cells.rs:46:    /// Returns the evaluated value, or a `RuntimeError` if any pipeline stage fails.
crates/ql-exec/src/workbook_runtime/cells.rs:57:    ) -> Result<Value, RuntimeError> {
crates/ql-exec/src/workbook_runtime/cells.rs:130:                .get_or_insert::<_, RuntimeError>(cache_key, || {
crates/ql-exec/src/workbook_runtime/cells.rs:148:        // because replay re-derives it via `WorkbookRuntime::recompute_all`
crates/ql-exec/src/workbook_runtime/cells.rs:537:                .get_or_insert::<_, RuntimeError>(cache_key, || {
crates/ql-exec/src/workbook_runtime/cells.rs:769:    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
crates/ql-exec/src/workbook_runtime/cells.rs:776:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/cells.rs:977:    ) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/cells.rs:1126:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:1128:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/cells.rs:1138:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1140:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1154:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1157:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1166:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1171:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1180:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1182:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1192:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1194:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1199:            matches!(result, Err(RuntimeError::Parse(_))),
crates/ql-exec/src/workbook_runtime/cells.rs:1209:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1211:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1214:        assert!(matches!(result, Err(RuntimeError::Parse(_))));
crates/ql-exec/src/workbook_runtime/cells.rs:1225:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1227:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1235:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1237:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1248:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1250:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1260:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1262:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1269:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1279:    /// `RuntimeError::InvalidSheet` instead of panicking inside `Workbook::put_at`.
crates/ql-exec/src/workbook_runtime/cells.rs:1282:        let mut wb = make_runtime_workbook(); // 1 sheet
crates/ql-exec/src/workbook_runtime/cells.rs:1284:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1288:            Err(RuntimeError::InvalidSheet { sheet, sheet_count }) => {
crates/ql-exec/src/workbook_runtime/cells.rs:1297:    /// `RuntimeError::InvalidCell` instead of panicking inside `Sheet::put`.
crates/ql-exec/src/workbook_runtime/cells.rs:1300:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1302:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1307:            Err(RuntimeError::InvalidCell {
crates/ql-exec/src/workbook_runtime/cells.rs:1322:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1324:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1329:            Err(RuntimeError::InvalidCell {
crates/ql-exec/src/workbook_runtime/cells.rs:1344:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1346:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1352:                Err(RuntimeError::InvalidCell { row: 9_999_999, .. })
crates/ql-exec/src/workbook_runtime/cells.rs:1361:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1363:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1371:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1373:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1379:                Err(RuntimeError::InvalidSheet {
crates/ql-exec/src/workbook_runtime/cells.rs:1390:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1392:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1408:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1411:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1432:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1437:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1460:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1464:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1479:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1487:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1497:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1502:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1530:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1534:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1577:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1581:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1591:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1595:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1600:            assert!(matches!(result, Err(RuntimeError::Lex(_))));
crates/ql-exec/src/workbook_runtime/cells.rs:1611:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1615:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1617:            assert!(matches!(result, Err(RuntimeError::Parse(_))));
crates/ql-exec/src/workbook_runtime/cells.rs:1624:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1628:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1630:            assert!(matches!(result, Err(RuntimeError::InvalidSheet { .. })));
crates/ql-exec/src/workbook_runtime/cells.rs:1640:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1646:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1652:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1667:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1669:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1686:    /// OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
crates/ql-exec/src/workbook_runtime/cells.rs:1694:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1698:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1727:    /// OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
crates/ql-exec/src/workbook_runtime/cells.rs:1739:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1756:    /// OPL-2B-01 (part 3): `WorkbookRuntime::clear_formula` records a
crates/ql-exec/src/workbook_runtime/cells.rs:1766:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1770:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1819:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1821:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1842:    /// OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
crates/ql-exec/src/workbook_runtime/cells.rs:1851:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:1855:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1860:            Err(RuntimeError::Name(ql_storage::NameTableError::Reserved(_)))
crates/ql-exec/src/workbook_runtime/cells.rs:1883:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:1914:            let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1964:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1979:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:1993:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2013:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2036:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2052:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2055:            RuntimeError::Bind(crate::plan::BindError::UnknownSheet(name)) => {
crates/ql-exec/src/workbook_runtime/cells.rs:2058:            other => panic!("expected RuntimeError::Bind(UnknownSheet), got {other:?}"),
crates/ql-exec/src/workbook_runtime/cells.rs:2072:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2108:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2110:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2136:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2138:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2154:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2156:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2170:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2172:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2206:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2208:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2226:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2228:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2253:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2255:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2277:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2279:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2303:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2307:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2323:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2327:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2345:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2349:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2361:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2383:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2387:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2394:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2414:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2419:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2425:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2444:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2446:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2482:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2486:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2500:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2523:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2528:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2542:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2563:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2567:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2579:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2597:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2601:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2632:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2634:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2673:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2675:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2701:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2703:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2730:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2732:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2771:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2775:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2791:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2809:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2813:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2821:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2838:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2842:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2852:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:2887:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2889:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2946:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2948:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:2979:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:2983:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:3015:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3019:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3024:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3050:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3054:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3068:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3101:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3108:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3133:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3137:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3153:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3157:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3175:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3178:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3202:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3204:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3226:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3228:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3248:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3250:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3274:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3278:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3284:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3300:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3304:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3316:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3336:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3340:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:3361:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3363:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3380:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3382:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3406:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3408:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3420:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3423:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3444:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3446:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3458:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3460:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3475:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3477:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3492:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3494:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3517:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3519:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3537:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3539:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3556:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3558:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3577:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3579:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3595:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3597:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3613:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3615:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3628:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3630:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3659:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3666:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3695:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3711:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:3738:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3750:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3763:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3790:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3798:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3827:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3862:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3866:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3879:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3899:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3903:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3913:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3942:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3946:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3959:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:3989:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:3993:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4012:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4027:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4052:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4056:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4070:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4095:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4100:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4116:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4126:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4131:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4150:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4153:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4162:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4165:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4175:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4178:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4185:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4197:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4199:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4215:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4225:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4227:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4243:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4252:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4254:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4262:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4275:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4278:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4294:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4297:            RuntimeError::TableResizeRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4306:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4308:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4336:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4345:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4347:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4362:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4371:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4375:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4380:            RuntimeError::TableCreateRejected { reason, .. } => {
crates/ql-exec/src/workbook_runtime/cells.rs:4389:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4393:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:4406:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4408:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4411:            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
crates/ql-exec/src/workbook_runtime/cells.rs:4416:    /// **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
crates/ql-exec/src/workbook_runtime/cells.rs:4429:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4435:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4456:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4474:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4498:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4502:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4515:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
crates/ql-exec/src/workbook_runtime/cells.rs:4554:    /// surfaces this as `RuntimeError::Parse(_)`.
crates/ql-exec/src/workbook_runtime/cells.rs:4557:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4560:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4562:        assert!(matches!(err, RuntimeError::Parse(_)));
crates/ql-exec/src/workbook_runtime/cells.rs:4575:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4604:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4618:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4625:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4634:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4640:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4658:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4673:        let mut producer_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4685:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:4693:        let mut replay_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4712:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4726:        let mut producer_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4730:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:4738:        let mut replay_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4751:        let mut producer_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4759:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
crates/ql-exec/src/workbook_runtime/cells.rs:4764:        let mut replay_wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4783:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4786:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4792:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4807:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4810:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4815:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4828:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4830:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:4843:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:4845:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:5039:            let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:5043:                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
crates/ql-exec/src/workbook_runtime/cells.rs:5090:        let mut wb = make_runtime_workbook();
crates/ql-exec/src/workbook_runtime/cells.rs:5100:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

exec
/bin/zsh -lc "rg -n \"#\\[test\\]|fn [a-zA-Z0-9_]+\\(\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/sheets.rs:37:fn rewrite_formula_text_for_sheet_rename(
crates/ql-exec/src/workbook_runtime/sheets.rs:74:    pub fn add_sheet(
crates/ql-exec/src/workbook_runtime/sheets.rs:146:    pub fn rename_sheet(
crates/ql-exec/src/workbook_runtime/sheets.rs:237:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:238:    fn rename_sheet_rewrites_formula_text_and_recomputes() {
crates/ql-exec/src/workbook_runtime/sheets.rs:267:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:268:    fn rename_sheet_leaves_unrelated_formulas_alone() {
crates/ql-exec/src/workbook_runtime/sheets.rs:295:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:296:    fn rename_sheet_duplicate_target_rejected_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:308:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:309:    fn rename_sheet_unknown_id_rejected_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:318:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:319:    fn rename_sheet_case_only_rename_runtime() {
crates/ql-exec/src/workbook_runtime/sheets.rs:342:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:343:    fn add_sheet_rejects_canonical_duplicate() {
crates/ql-exec/src/workbook_runtime/sheets.rs:356:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:357:    fn add_sheet_rejects_reserved_char() {
crates/ql-exec/src/workbook_runtime/sheets.rs:365:    #[test]
crates/ql-exec/src/workbook_runtime/sheets.rs:366:    fn add_sheet_with_bad_name_emits_no_oplog_entry() {
crates/ql-exec/src/workbook_runtime/validate.rs:42:    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
crates/ql-exec/src/workbook_runtime/validate.rs:89:    pub fn validate_formula(
crates/ql-exec/src/workbook_runtime/validate.rs:149:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/validate.rs:162:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:163:    fn add_sheet_rejects_zero_chunk_rows() {
crates/ql-exec/src/workbook_runtime/validate.rs:186:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:187:    fn clear_formula_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/validate.rs:204:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:205:    fn clear_formula_rejects_invalid_cell() {
crates/ql-exec/src/workbook_runtime/validate.rs:223:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:224:    fn validate_formula_returns_value_without_writing() {
crates/ql-exec/src/workbook_runtime/validate.rs:245:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:246:    fn validate_formula_surfaces_bind_errors() {
crates/ql-exec/src/workbook_runtime/validate.rs:262:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:263:    fn validate_formula_returns_anchor_value_for_top_level_array() {
crates/ql-exec/src/workbook_runtime/validate.rs:288:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:289:    fn validate_formula_does_not_pollute_plan_cache() {
crates/ql-exec/src/workbook_runtime/validate.rs:313:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:314:    fn is_aggregate_function_lists_only_registered_aggregates() {
crates/ql-exec/src/workbook_runtime/validate.rs:448:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:449:    fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:470:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:471:    fn w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:513:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:514:    fn w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates() {
crates/ql-exec/src/workbook_runtime/validate.rs:563:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:564:    fn w5_d_13_1_atan2_and_sumxmy2_via_source_text() {
crates/ql-exec/src/workbook_runtime/validate.rs:616:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:617:    fn every_range_aware_fn_is_admitted_to_is_aggregate_function() {
crates/ql-exec/src/workbook_runtime/validate.rs:653:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:654:    fn nag_05_nested_aggregates_with_named_range_bind_cleanly() {
crates/ql-exec/src/workbook_runtime/validate.rs:674:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:675:    fn nag_06_round_with_nested_sum_of_named_range_binds_cleanly() {
crates/ql-exec/src/workbook_runtime/validate.rs:698:    #[test]
crates/ql-exec/src/workbook_runtime/validate.rs:699:    fn recompute_result_is_complete_is_single_source_of_truth() {
crates/ql-exec/src/workbook_runtime/names.rs:36:    pub fn set_name(
crates/ql-exec/src/workbook_runtime/names.rs:95:    pub fn set_sheet_scoped_name(
crates/ql-exec/src/workbook_runtime/names.rs:163:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/names.rs:171:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:172:    fn set_sheet_scoped_name_lands_on_sheet_table() {
crates/ql-exec/src/workbook_runtime/names.rs:188:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:189:    fn set_sheet_scoped_name_invalid_sheet_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:200:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:201:    fn set_sheet_scoped_name_reserved_name_rejected() {
crates/ql-exec/src/workbook_runtime/names.rs:215:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:216:    fn set_sheet_scoped_name_emits_op_with_scope() {
crates/ql-exec/src/workbook_runtime/names.rs:241:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:242:    fn formula_resolves_sheet_scoped_over_workbook_scoped() {
crates/ql-exec/src/workbook_runtime/names.rs:266:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:267:    fn set_sheet_scoped_name_invalidates_plan_cache() {
crates/ql-exec/src/workbook_runtime/names.rs:298:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:299:    fn set_formula_resolves_named_cell_target() {
crates/ql-exec/src/workbook_runtime/names.rs:317:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:318:    fn set_formula_resolves_named_number_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:332:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:333:    fn set_formula_resolves_named_boolean_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:348:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:349:    fn set_formula_resolves_named_text_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:362:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:363:    fn set_formula_unresolved_name_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:386:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:387:    fn runtime_error_bind_display_is_human_readable() {
crates/ql-exec/src/workbook_runtime/names.rs:407:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:408:    fn runtime_error_lex_display_is_human_readable() {
crates/ql-exec/src/workbook_runtime/names.rs:436:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:437:    fn set_formula_named_range_in_scalar_context_errors() {
crates/ql-exec/src/workbook_runtime/names.rs:457:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:458:    fn recompute_all_resolves_named_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:479:    #[test]
crates/ql-exec/src/workbook_runtime/names.rs:480:    fn set_name_uppercases_for_canonical_lookup() {
crates/ql-exec/src/workbook_runtime/tables.rs:62:    pub fn create_table(
crates/ql-exec/src/workbook_runtime/tables.rs:225:    pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:280:    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
crates/ql-exec/src/workbook_runtime/tables.rs:403:    pub fn rename_column(
crates/ql-exec/src/workbook_runtime/tables.rs:574:    pub fn resize_table(
crates/ql-exec/src/workbook_runtime/tables.rs:791:    fn reextract_table_readers(&mut self, table_canonical: &str) {
crates/ql-exec/src/workbook_runtime/tables.rs:870:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/tables.rs:888:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:889:    fn structured_ref_sum_qty_column_works_end_to_end() {
crates/ql-exec/src/workbook_runtime/tables.rs:934:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:935:    fn structured_ref_at_column_narrows_to_current_row() {
crates/ql-exec/src/workbook_runtime/tables.rs:987:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:988:    fn structured_ref_at_column_outside_table_returns_value_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1024:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1025:    fn create_table_happy_path_registers_and_emits_op() {
crates/ql-exec/src/workbook_runtime/tables.rs:1059:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1060:    fn rename_table_happy_path_rewrites_formula_text() {
crates/ql-exec/src/workbook_runtime/tables.rs:1104:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1105:    fn rename_table_target_collision_with_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1122:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1123:    fn rename_table_missing_source_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1134:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1135:    fn rename_table_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:1165:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1166:    fn rename_table_then_drop_new_name_emits_name_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1223:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1224:    fn rename_column_happy_path_rewrites_formula_text() {
crates/ql-exec/src/workbook_runtime/tables.rs:1273:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1274:    fn rename_column_combination_form_rewritten() {
crates/ql-exec/src/workbook_runtime/tables.rs:1315:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1316:    fn rename_column_this_row_form_rewritten() {
crates/ql-exec/src/workbook_runtime/tables.rs:1359:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1360:    fn rename_column_other_table_unaffected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1398:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1399:    fn rename_column_target_collision_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1424:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1425:    fn rename_column_missing_source_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1441:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1442:    fn rename_column_unknown_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1453:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1454:    fn rename_column_empty_target_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1469:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1470:    fn rename_column_same_canonical_is_noop() {
crates/ql-exec/src/workbook_runtime/tables.rs:1490:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1491:    fn rename_column_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:1525:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1526:    fn rename_column_fires_hook_and_keeps_value_consistent() {
crates/ql-exec/src/workbook_runtime/tables.rs:1581:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1582:    fn resize_table_grow_rows_extends_sum_range() {
crates/ql-exec/src/workbook_runtime/tables.rs:1628:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1629:    fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() {
crates/ql-exec/src/workbook_runtime/tables.rs:1691:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1692:    fn resize_table_shrink_rows_truncates_sum_range() {
crates/ql-exec/src/workbook_runtime/tables.rs:1730:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1731:    fn resize_table_add_column_appends_new_column() {
crates/ql-exec/src/workbook_runtime/tables.rs:1759:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1760:    fn resize_table_remove_last_column_drops_column() {
crates/ql-exec/src/workbook_runtime/tables.rs:1798:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1799:    fn resize_table_remove_referenced_column_emits_name_error() {
crates/ql-exec/src/workbook_runtime/tables.rs:1843:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1844:    fn resize_table_unknown_table_errors() {
crates/ql-exec/src/workbook_runtime/tables.rs:1855:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1856:    fn resize_table_zero_dims_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1871:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1872:    fn resize_table_arithmetic_mismatch_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1890:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1891:    fn resize_table_removed_columns_not_trailing_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1919:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1920:    fn resize_table_overlap_with_other_table_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1943:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1944:    fn resize_table_added_column_duplicate_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1965:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1966:    fn resize_table_removed_columns_excess_count_rejected() {
crates/ql-exec/src/workbook_runtime/tables.rs:1989:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:1990:    fn resize_table_emits_ops() {
crates/ql-exec/src/workbook_runtime/tables.rs:2025:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2026:    fn resize_table_exact_noop_emits_nothing() {
crates/ql-exec/src/workbook_runtime/tables.rs:2062:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2063:    fn create_table_then_sum_column_works() {
crates/ql-exec/src/workbook_runtime/tables.rs:2079:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2080:    fn structured_ref_average_qty_column_works_end_to_end() {
crates/ql-exec/src/workbook_runtime/tables.rs:2121:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2122:    fn set_formula_canonicalizes_r1c1_input_to_a1() {
crates/ql-exec/src/workbook_runtime/tables.rs:2140:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2141:    fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() {
crates/ql-exec/src/workbook_runtime/tables.rs:2155:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2156:    fn set_formula_canonicalizes_de_locale_to_en() {
crates/ql-exec/src/workbook_runtime/tables.rs:2171:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2172:    fn set_formula_preserves_at_through_canonicalization() {
crates/ql-exec/src/workbook_runtime/tables.rs:2181:    #[test]
crates/ql-exec/src/workbook_runtime/tables.rs:2182:    fn set_reference_mode_op_round_trips_through_replay() {
crates/ql-exec/src/workbook_runtime/recompute.rs:39:    pub fn recompute_all(&mut self) -> RecomputeResult {
crates/ql-exec/src/workbook_runtime/recompute.rs:216:    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
crates/ql-exec/src/workbook_runtime/recompute.rs:626:    fn try_recompute_one_cached(
crates/ql-exec/src/workbook_runtime/recompute.rs:651:    fn try_recompute_with_aggregate_cache(
crates/ql-exec/src/workbook_runtime/recompute.rs:670:    fn try_recompute_with_simd_profile(
crates/ql-exec/src/workbook_runtime/recompute.rs:824:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/recompute.rs:832:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:833:    fn recompute_all_on_empty_workbook_is_noop() {
crates/ql-exec/src/workbook_runtime/recompute.rs:844:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:845:    fn recompute_all_refreshes_formula_values() {
crates/ql-exec/src/workbook_runtime/recompute.rs:875:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:876:    fn recompute_all_handles_multiple_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:908:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:909:    fn save_load_recompute_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:969:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:970:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
crates/ql-exec/src/workbook_runtime/recompute.rs:995:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:996:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1025:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1026:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1053:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1054:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1078:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1079:    fn recompute_all_dependent_of_cycle_propagates_circ_error() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1111:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1112:    fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1182:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1183:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1212:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1213:    fn recompute_all_does_not_short_circuit_on_first_failure() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1247:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1248:    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1269:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1270:    fn recompute_all_eval_time_error_values_count_as_succeeded() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1290:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1291:    fn recompute_all_failed_cells_preserve_prior_state() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1314:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1315:    fn recompute_all_second_pass_is_all_cache_hits() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1345:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1346:    fn name_table_mutation_invalidates_bind_plan_cache() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1404:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1405:    fn cache_keys_are_stable_across_recompute_passes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1427:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1428:    fn cache_stats_flow_into_timings_struct() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1450:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1451:    fn set_formula_populates_cache_for_subsequent_recompute() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1478:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1479:    fn nag_01_named_constants_still_work_in_scalar_and_aggregate_contexts() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1503:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1504:    fn nag_02_named_cell_references_still_work() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1529:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1530:    fn nag_03_named_range_in_aggregate_function_binds_to_explicit_variant() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1555:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1556:    fn nag_04_named_range_in_scalar_positions_errors_precisely() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1593:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1594:    fn named_formula_surfaces_distinct_bind_error() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1619:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1620:    fn runtime_mutations_fire_calcgraph_hooks() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1663:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1664:    fn rebuild_then_edit_keeps_cell_index_in_sync() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1703:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1704:    fn runtime_without_graph_works_as_before() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1716:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1717:    fn runtime_with_oplog_and_graph_drives_both() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1749:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1750:    fn recompute_dirty_returns_none_when_no_graph_attached() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1760:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1761:    fn recompute_dirty_cascades_dependency_chain() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1810:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1811:    fn recompute_dirty_writes_circ_error_for_cycle_members() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1853:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1854:    fn recompute_dirty_skips_unrelated_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1901:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1902:    fn ovr_3_01_set_formula_writes_to_computed_overlay_not_user() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1933:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1934:    fn ovr_3_02_typing_over_formula_clears_formula_and_computed() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1965:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1966:    fn ovr_3_02b_clear_formula_promotes_value_to_user_lane() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1990:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:1991:    fn ovr_3_03_save_load_preserves_layer() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2035:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2036:    fn ovr_3_04_read_cascade_consistent_across_lane_types() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2076:    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
crates/ql-exec/src/workbook_runtime/recompute.rs:2099:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2100:    fn agg_3_04_results_match_scalar_baseline() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2142:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2143:    fn agg_3_01_no_rescan_on_unrelated_writes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2188:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2189:    fn agg_3_02_intersecting_write_invalidates_cache() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2223:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2224:    fn agg_3_03_full_column_aggregate_remains_compressed() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2268:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2269:    fn vol_3_03_seeded_rng_produces_deterministic_rand_sequence() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2293:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2294:    fn vol_3_01_volatile_formulas_recompute_when_requested() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2321:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2322:    fn vol_3_02_nonvolatile_dependents_update_when_volatile_changes() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2377:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2378:    fn veq_3_01_unchanged_upstream_suppresses_downstream_recompute() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2421:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2422:    fn veq_3_02_error_equality_suppresses_downstream() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2468:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2469:    fn veq_3_03_profile_records_skipped_vertices() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2516:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2517:    fn veq_does_not_skip_volatile_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2548:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2549:    fn simd_3_01_og02_pattern_classifies_to_mul_scalar() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2573:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2574:    fn simd_3_02_division_falls_back_to_scalar() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2604:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2605:    fn simd_3_03_profile_records_simd_eligible_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2665:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2666:    fn w5_53_sumif_named_range_numeric_criteria() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2685:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2686:    fn w5_53_sumif_comparator_criteria() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2703:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2704:    fn w5_53_countif_named_range() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2724:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2725:    fn w5_53_sumif_with_separate_sum_range() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2760:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2761:    fn w5_53_sumif_recomputes_on_range_cell_change() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2796:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2797:    fn w5_54_vlookup_exact_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2826:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2827:    fn w5_54_vlookup_approximate_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2856:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2857:    fn w5_54_hlookup_exact_match_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2884:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2885:    fn w5_54_index_match_pattern_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2919:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2920:    fn w5_54_choose_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2933:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2934:    fn w5_54_vlookup_not_found_returns_na_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2963:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2964:    fn w5_55_averageif_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:2983:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:2984:    fn w5_55_sumifs_two_conditions_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3024:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:3025:    fn w5_55_countifs_single_condition_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3044:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:3045:    fn w5_55_sumproduct_two_columns_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3072:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:3073:    fn w5_55_averageifs_e2e() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3114:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:3115:    fn mark_volatile_dirty_zero_when_no_volatile_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:3131:    #[test]
crates/ql-exec/src/workbook_runtime/recompute.rs:3132:    fn recompute_dirty_twice_in_a_row_is_idempotent() {
crates/ql-exec/src/workbook_runtime/error.rs:172:    fn from(e: LexError) -> Self {
crates/ql-exec/src/workbook_runtime/error.rs:178:    fn from(e: BindError) -> Self {
crates/ql-exec/src/workbook_runtime/error.rs:274:    pub fn is_complete(&self) -> bool {
crates/ql-exec/src/workbook_runtime/error.rs:280:    pub fn failed_count(&self) -> usize {
crates/ql-exec/src/workbook_runtime/config.rs:30:    pub fn set_reference_mode(
crates/ql-exec/src/workbook_runtime/config.rs:56:    pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/config.rs:82:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/config.rs:92:    #[test]
crates/ql-exec/src/workbook_runtime/config.rs:93:    fn set_reference_mode_updates_workbook_and_emits_op() {
crates/ql-exec/src/workbook_runtime/config.rs:106:    #[test]
crates/ql-exec/src/workbook_runtime/config.rs:107:    fn set_reference_mode_noop_when_unchanged_emits_no_op() {
crates/ql-exec/src/workbook_runtime/config.rs:119:    #[test]
crates/ql-exec/src/workbook_runtime/config.rs:120:    fn set_locale_updates_workbook_and_emits_op() {
crates/ql-exec/src/workbook_runtime/config.rs:132:    #[test]
crates/ql-exec/src/workbook_runtime/config.rs:133:    fn set_locale_noop_when_unchanged_emits_no_op() {
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:131:pub(crate) fn validate_cell(
crates/ql-exec/src/workbook_runtime/mod.rs:199:    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
crates/ql-exec/src/workbook_runtime/mod.rs:219:    pub fn with_oplog(
crates/ql-exec/src/workbook_runtime/mod.rs:241:    pub fn with_graph(
crates/ql-exec/src/workbook_runtime/mod.rs:262:    pub fn with_oplog_and_graph(
crates/ql-exec/src/workbook_runtime/mod.rs:281:    pub fn cache_stats(&self) -> PlanCacheStats {
crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
crates/ql-exec/src/workbook_runtime/formats.rs:75:    pub fn set_cell_format(
crates/ql-exec/src/workbook_runtime/formats.rs:148:    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
crates/ql-exec/src/workbook_runtime/formats.rs:193:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:194:    fn intern_format_returns_existing_builtin_id_no_oplog_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:212:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:213:    fn intern_format_new_string_emits_register_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:233:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:234:    fn intern_format_duplicate_call_idempotent_no_second_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:248:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:249:    fn set_cell_format_emits_op_and_updates_overlay() {
crates/ql-exec/src/workbook_runtime/formats.rs:270:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:271:    fn set_cell_format_with_none_clears_overlay_and_emits_op() {
crates/ql-exec/src/workbook_runtime/formats.rs:292:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:293:    fn set_cell_format_unknown_id_is_runtime_error() {
crates/ql-exec/src/workbook_runtime/formats.rs:306:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:307:    fn read_display_general_path_for_unbound_cell() {
crates/ql-exec/src/workbook_runtime/formats.rs:317:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:318:    fn read_display_with_built_in_date_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:332:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:333:    fn read_display_with_custom_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:345:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:346:    fn read_display_caches_parsed_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:367:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:368:    fn read_display_error_value_passes_sigil_through() {
crates/ql-exec/src/workbook_runtime/formats.rs:382:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:383:    fn read_display_text_value_through_at_format() {
crates/ql-exec/src/workbook_runtime/formats.rs:396:    #[test]
crates/ql-exec/src/workbook_runtime/formats.rs:397:    fn intern_and_set_cell_format_replay_round_trip() {
crates/ql-exec/src/workbook_runtime/cells.rs:51:    pub fn set_formula(
crates/ql-exec/src/workbook_runtime/cells.rs:468:    fn reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:624:    pub(super) fn write_spill(
crates/ql-exec/src/workbook_runtime/cells.rs:751:    fn write_anchor_error(
crates/ql-exec/src/workbook_runtime/cells.rs:770:    pub fn set_value(
crates/ql-exec/src/workbook_runtime/cells.rs:972:    pub fn clear_formula(
crates/ql-exec/src/workbook_runtime/cells.rs:1128:    fn make_runtime_workbook() -> Workbook {
crates/ql-exec/src/workbook_runtime/cells.rs:1136:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1137:    fn set_formula_literal_arithmetic() {
crates/ql-exec/src/workbook_runtime/cells.rs:1152:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1153:    fn set_formula_reads_existing_cell() {
crates/ql-exec/src/workbook_runtime/cells.rs:1164:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1165:    fn set_formula_with_function_call() {
crates/ql-exec/src/workbook_runtime/cells.rs:1178:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1179:    fn set_formula_propagates_div_by_zero() {
crates/ql-exec/src/workbook_runtime/cells.rs:1190:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1191:    fn set_formula_invalid_syntax_returns_parse_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:1207:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1208:    fn set_formula_trailing_tokens_returns_parse_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:1223:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1224:    fn set_formula_var_s_dotted_function_dispatches() {
crates/ql-exec/src/workbook_runtime/cells.rs:1233:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1234:    fn set_formula_stdev_p_dotted_function_dispatches() {
crates/ql-exec/src/workbook_runtime/cells.rs:1246:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1247:    fn set_formula_ai_returns_ai_not_available() {
crates/ql-exec/src/workbook_runtime/cells.rs:1258:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1259:    fn set_value_clears_existing_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:1280:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1281:    fn set_formula_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/cells.rs:1298:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1299:    fn set_formula_rejects_row_above_max() {
crates/ql-exec/src/workbook_runtime/cells.rs:1320:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1321:    fn set_formula_rejects_col_above_max() {
crates/ql-exec/src/workbook_runtime/cells.rs:1342:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1343:    fn set_value_rejects_invalid_cell() {
crates/ql-exec/src/workbook_runtime/cells.rs:1358:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1359:    fn set_formula_at_max_row_max_col_ok() {
crates/ql-exec/src/workbook_runtime/cells.rs:1369:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1370:    fn set_value_rejects_invalid_sheet() {
crates/ql-exec/src/workbook_runtime/cells.rs:1388:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1389:    fn set_value_on_blank_cell_no_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:1406:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1407:    fn set_value_with_oplog_emits_put_value() {
crates/ql-exec/src/workbook_runtime/cells.rs:1430:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1431:    fn set_value_over_existing_formula_emits_batch_commit_pair() {
crates/ql-exec/src/workbook_runtime/cells.rs:1458:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1459:    fn set_value_blank_emits_nothing_when_cell_is_already_blank() {
crates/ql-exec/src/workbook_runtime/cells.rs:1477:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1478:    fn set_value_blank_over_formula_emits_clear_formula_only() {
crates/ql-exec/src/workbook_runtime/cells.rs:1495:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1496:    fn set_formula_with_oplog_emits_put_formula_text_only() {
crates/ql-exec/src/workbook_runtime/cells.rs:1528:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1529:    fn set_formula_into_spill_target_emits_put_formula_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1575:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1576:    fn set_formula_array_reshape_records_one_op_per_call() {
crates/ql-exec/src/workbook_runtime/cells.rs:1589:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1590:    fn set_formula_lex_error_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1609:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1610:    fn set_formula_parse_error_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1622:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1623:    fn set_formula_invalid_cell_does_not_emit_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1635:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1636:    fn recompute_all_does_not_emit_ops() {
crates/ql-exec/src/workbook_runtime/cells.rs:1664:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1665:    fn runtime_without_oplog_set_value_and_set_formula_still_work() {
crates/ql-exec/src/workbook_runtime/cells.rs:1690:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1691:    fn runtime_set_name_emits_op_into_attached_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1730:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1731:    fn runtime_add_sheet_emits_op_into_attached_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1763:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1764:    fn runtime_clear_formula_emits_atomic_pair_when_formula_present() {
crates/ql-exec/src/workbook_runtime/cells.rs:1816:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1817:    fn runtime_set_name_add_sheet_clear_formula_work_without_oplog() {
crates/ql-exec/src/workbook_runtime/cells.rs:1847:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1848:    fn runtime_set_name_reserved_name_does_not_append_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:1874:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1875:    fn opl_2b_02_full_op_vocabulary_producer_replay_equivalence() {
crates/ql-exec/src/workbook_runtime/cells.rs:1956:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1957:    fn text_formula_renders_through_recompute() {
crates/ql-exec/src/workbook_runtime/cells.rs:1973:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1974:    fn text_formula_with_number_format_returns_formatted_text() {
crates/ql-exec/src/workbook_runtime/cells.rs:1988:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:1989:    fn text_formula_invalid_format_returns_value_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:2005:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2006:    fn cross_sheet_cellref_evaluates_after_recompute() {
crates/ql-exec/src/workbook_runtime/cells.rs:2028:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2029:    fn cross_sheet_quoted_name_with_space_evaluates() {
crates/ql-exec/src/workbook_runtime/cells.rs:2045:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2046:    fn cross_sheet_formula_with_unknown_sheet_surfaces_bind_error_at_set_time() {
crates/ql-exec/src/workbook_runtime/cells.rs:2062:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2063:    fn cross_sheet_three_sheet_chain_evaluates() {
crates/ql-exec/src/workbook_runtime/cells.rs:2106:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2107:    fn set_formula_array_literal_horizontal_spills_1x3() {
crates/ql-exec/src/workbook_runtime/cells.rs:2134:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2135:    fn set_formula_array_literal_vertical_spills_3x1() {
crates/ql-exec/src/workbook_runtime/cells.rs:2152:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2153:    fn set_formula_array_literal_2x2_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:2168:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2169:    fn set_formula_array_shrinks_clears_old_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2204:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2205:    fn set_formula_scalar_after_array_clears_spill_state() {
crates/ql-exec/src/workbook_runtime/cells.rs:2224:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2225:    fn set_formula_array_blocked_by_user_value_at_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2251:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2252:    fn set_formula_array_blocked_by_formula_at_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2275:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2276:    fn set_formula_array_out_of_bounds_returns_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2300:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2301:    fn set_formula_array_writeback_fires_on_set_value_for_each_target() {
crates/ql-exec/src/workbook_runtime/cells.rs:2320:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2321:    fn set_formula_array_2x2_fires_three_on_set_value() {
crates/ql-exec/src/workbook_runtime/cells.rs:2342:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2343:    fn set_formula_dissolving_spill_dirties_old_target_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:2380:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2381:    fn set_formula_array_reshape_fires_on_set_value_for_union() {
crates/ql-exec/src/workbook_runtime/cells.rs:2411:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2412:    fn set_formula_blocked_spill_does_not_fire_target_hooks() {
crates/ql-exec/src/workbook_runtime/cells.rs:2442:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2443:    fn set_formula_array_same_formula_twice_is_stable() {
crates/ql-exec/src/workbook_runtime/cells.rs:2479:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2480:    fn set_formula_reextract_aliases_pre_existing_reader_to_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:2520:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2521:    fn set_formula_reextract_unroutes_alias_after_spill_dissolves() {
crates/ql-exec/src/workbook_runtime/cells.rs:2560:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2561:    fn set_formula_reextract_dedupes_across_old_and_new_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2594:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2595:    fn set_formula_reextract_skipped_on_blocked_spill_with_no_old_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:2630:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2631:    fn set_formula_at_spill_target_dissolves_host_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2671:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2672:    fn set_formula_at_anchor_does_not_double_clear_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2699:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2700:    fn set_formula_array_at_spill_target_dissolves_then_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:2728:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2729:    fn set_formula_at_non_spill_target_unchanged_behavior() {
crates/ql-exec/src/workbook_runtime/cells.rs:2768:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2769:    fn set_formula_into_host_target_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:2806:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2807:    fn set_formula_into_host_target_marks_host_anchor_dirty() {
crates/ql-exec/src/workbook_runtime/cells.rs:2835:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2836:    fn set_formula_into_host_target_dirties_readers_of_other_host_targets() {
crates/ql-exec/src/workbook_runtime/cells.rs:2885:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2886:    fn clear_formula_at_spill_anchor_dissolves_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:2944:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2945:    fn clear_formula_at_non_anchor_cell_unchanged_behavior() {
crates/ql-exec/src/workbook_runtime/cells.rs:2977:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:2978:    fn clear_formula_at_spill_anchor_emits_only_clear_formula_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:3012:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3013:    fn clear_formula_at_spill_anchor_fires_on_set_value_for_targets() {
crates/ql-exec/src/workbook_runtime/cells.rs:3047:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3048:    fn clear_formula_at_spill_anchor_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:3099:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3100:    fn recompute_all_materializes_spill_for_array_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:3131:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3132:    fn recompute_all_scalar_formula_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3151:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3152:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3173:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3174:    fn recompute_all_array_formula_idempotent_across_two_passes() {
crates/ql-exec/src/workbook_runtime/cells.rs:3200:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3201:    fn set_value_at_spill_target_dissolves_host_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3224:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3225:    fn set_value_at_spill_anchor_dissolves_own_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3246:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3247:    fn set_value_at_non_spill_cell_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3271:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3272:    fn set_value_at_spill_target_marks_host_anchor_dirty() {
crates/ql-exec/src/workbook_runtime/cells.rs:3297:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3298:    fn set_value_at_spill_target_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:3334:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3335:    fn set_value_over_spill_anchor_formula_emits_batch_commit() {
crates/ql-exec/src/workbook_runtime/cells.rs:3359:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3360:    fn set_formula_sequence_rows_only_spills_vertically() {
crates/ql-exec/src/workbook_runtime/cells.rs:3378:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3379:    fn set_formula_sequence_rows_cols_spills_2d() {
crates/ql-exec/src/workbook_runtime/cells.rs:3404:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3405:    fn set_formula_sequence_zero_rows_produces_num_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3418:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3419:    fn recompute_all_materializes_sequence_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3442:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3443:    fn set_formula_sequence_inside_binary_op_produces_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3456:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3457:    fn set_formula_transpose_row_literal_spills_as_column() {
crates/ql-exec/src/workbook_runtime/cells.rs:3473:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3474:    fn set_formula_transpose_column_literal_spills_as_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:3490:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3491:    fn set_formula_transpose_2x2() {
crates/ql-exec/src/workbook_runtime/cells.rs:3515:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3516:    fn set_formula_transpose_of_sequence_in_arg_position_is_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3535:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3536:    fn set_formula_filter_of_sequence_in_arg_position_is_calc_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3554:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3555:    fn set_formula_sequence_of_sequence_in_arg_position_is_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3575:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3576:    fn set_formula_filter_row_keeps_truthy() {
crates/ql-exec/src/workbook_runtime/cells.rs:3593:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3594:    fn set_formula_filter_column_keeps_truthy() {
crates/ql-exec/src/workbook_runtime/cells.rs:3611:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3612:    fn set_formula_filter_all_false_no_if_empty_produces_calc() {
crates/ql-exec/src/workbook_runtime/cells.rs:3626:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3627:    fn set_formula_filter_all_false_with_if_empty_spills_singleton() {
crates/ql-exec/src/workbook_runtime/cells.rs:3655:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3656:    fn set_formula_transpose_with_named_range_arg_binds_and_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:3691:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3692:    fn set_formula_filter_with_named_range_args_binds_and_spills() {
crates/ql-exec/src/workbook_runtime/cells.rs:3733:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3734:    fn recompute_dirty_transpose_with_named_range_updates_on_value_change() {
crates/ql-exec/src/workbook_runtime/cells.rs:3785:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3786:    fn recompute_dirty_filter_with_named_ranges_grows_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3859:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3860:    fn recompute_dirty_sequence_grows_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3896:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3897:    fn recompute_dirty_sequence_shrinks_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:3939:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3940:    fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3986:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:3987:    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:4049:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4050:    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
crates/ql-exec/src/workbook_runtime/cells.rs:4092:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4093:    fn create_table_rejected_when_footprint_contains_spill_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:4123:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4124:    fn create_table_succeeds_when_anchor_is_outside_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:4147:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4148:    fn resize_table_grow_rejected_when_new_cells_contain_spill_anchor() {
crates/ql-exec/src/workbook_runtime/cells.rs:4172:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4173:    fn resize_table_grow_succeeds_when_anchor_is_outside_new_footprint() {
crates/ql-exec/src/workbook_runtime/cells.rs:4194:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4195:    fn create_table_rejects_footprint_past_max_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4222:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4223:    fn create_table_rejects_footprint_past_max_column() {
crates/ql-exec/src/workbook_runtime/cells.rs:4250:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4251:    fn create_table_rejects_footprint_u32_overflow_on_rows() {
crates/ql-exec/src/workbook_runtime/cells.rs:4272:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4273:    fn resize_table_rejects_growing_past_max_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4304:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4305:    fn create_table_rejects_overlap() {
crates/ql-exec/src/workbook_runtime/cells.rs:4343:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4344:    fn create_table_rejects_duplicate_column_names_case_insensitive() {
crates/ql-exec/src/workbook_runtime/cells.rs:4369:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4370:    fn create_table_rejects_namespace_collision_with_defined_name() {
crates/ql-exec/src/workbook_runtime/cells.rs:4387:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4388:    fn drop_table_removes_metadata_and_emits_op() {
crates/ql-exec/src/workbook_runtime/cells.rs:4404:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4405:    fn drop_table_missing_errors() {
crates/ql-exec/src/workbook_runtime/cells.rs:4426:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4427:    fn drop_table_fires_on_table_drop_hook_and_emits_name_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:4495:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4496:    fn drop_table_propagates_name_error_through_chain() {
crates/ql-exec/src/workbook_runtime/cells.rs:4555:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4556:    fn mixed_relativity_r1c1_range_rejected_at_set_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:4572:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4573:    fn structured_ref_at_inside_vs_outside_brackets_eval_identically() {
crates/ql-exec/src/workbook_runtime/cells.rs:4616:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4617:    fn at_whole_column_evals_to_anchor_row() {
crates/ql-exec/src/workbook_runtime/cells.rs:4632:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4633:    fn at_whole_row_evals_to_anchor_col() {
crates/ql-exec/src/workbook_runtime/cells.rs:4648:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4649:    fn sheet_qualified_at_ref_resolves_correctly() {
crates/ql-exec/src/workbook_runtime/cells.rs:4668:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4669:    fn r1c1_input_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4724:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4725:    fn de_locale_input_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4749:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4750:    fn at_operator_round_trips_through_oplog_replay() {
crates/ql-exec/src/workbook_runtime/cells.rs:4781:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4782:    fn reference_mode_change_leaves_stored_formula_text_canonical() {
crates/ql-exec/src/workbook_runtime/cells.rs:4805:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4806:    fn locale_change_leaves_stored_formula_text_canonical() {
crates/ql-exec/src/workbook_runtime/cells.rs:4826:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4827:    fn at_scalar_idempotent_through_eval() {
crates/ql-exec/src/workbook_runtime/cells.rs:4841:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:4842:    fn at_function_with_scalar_return_passes_through() {
crates/ql-exec/src/workbook_runtime/cells.rs:4884:    fn coverage_matrix() -> Vec<MatrixCell> {
crates/ql-exec/src/workbook_runtime/cells.rs:5029:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:5030:    fn coverage_matrix_mode_locale_at_presence_30_cells() {
crates/ql-exec/src/workbook_runtime/cells.rs:5066:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:5067:    fn coverage_matrix_has_no_duplicates() {
crates/ql-exec/src/workbook_runtime/cells.rs:5088:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:5089:    fn plan_cache_at_range_collision_across_cells_regression() {
crates/ql-exec/src/workbook_runtime/cells.rs:5119:    #[test]
crates/ql-exec/src/workbook_runtime/cells.rs:5120:    fn coverage_matrix_dimension_counts() {

codex
The design’s acceptance target was more ambitious than the final state: `mod.rs` is 299 LOC and the big implementation/test files remain large, especially `cells.rs`, `recompute.rs`, and `tables.rs`. I’m now checking whether that is just a documented tradeoff or whether it left concrete cleanup items.
exec
/bin/zsh -lc 'rg -n "''^mod |''^pub use|''^use |''^pub'"\\(crate\\) fn|"'^pub'"\\(super\\)|"'^pub mod|''^mod [a-z_]" crates/ql-exec/src/workbook_runtime/mod.rs crates/ql-exec/src/workbook_runtime/*.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/validate.rs:21:use ql_formula_syntax::{lex, parse};
crates/ql-exec/src/workbook_runtime/validate.rs:22:use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};
crates/ql-exec/src/workbook_runtime/validate.rs:24:use crate::env::WorkbookEnv;
crates/ql-exec/src/workbook_runtime/validate.rs:25:use crate::plan::{bind_with_site, BindSite};
crates/ql-exec/src/workbook_runtime/validate.rs:26:use crate::transaction::WorkbookTransaction;
crates/ql-exec/src/workbook_runtime/validate.rs:28:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/validate.rs:142:mod tests {
crates/ql-exec/src/workbook_runtime/tables.rs:26:use std::sync::Arc;
crates/ql-exec/src/workbook_runtime/tables.rs:28:use ql_formula_syntax::{lex, lex_with, parse};
crates/ql-exec/src/workbook_runtime/tables.rs:29:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/tables.rs:30:use ql_types::{ColId, RowId, SheetId};
crates/ql-exec/src/workbook_runtime/tables.rs:32:use crate::plan::{bind_with_site, BindSite};
crates/ql-exec/src/workbook_runtime/tables.rs:33:use crate::plan_cache::PlanCacheKey;
crates/ql-exec/src/workbook_runtime/tables.rs:35:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/tables.rs:860:mod tests {
crates/ql-exec/src/workbook_runtime/mod.rs:39:use ql_functions::format::FormatString;
crates/ql-exec/src/workbook_runtime/mod.rs:40:use ql_functions::FunctionRegistry;
crates/ql-exec/src/workbook_runtime/mod.rs:41:use ql_oplog::OpLog;
crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
crates/ql-exec/src/workbook_runtime/mod.rs:43:use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};
crates/ql-exec/src/workbook_runtime/mod.rs:45:use crate::plan_cache::{PlanCache, PlanCacheStats};
crates/ql-exec/src/workbook_runtime/mod.rs:92:mod cells;
crates/ql-exec/src/workbook_runtime/mod.rs:93:mod config;
crates/ql-exec/src/workbook_runtime/mod.rs:94:mod error;
crates/ql-exec/src/workbook_runtime/mod.rs:95:mod formats;
crates/ql-exec/src/workbook_runtime/mod.rs:96:mod names;
crates/ql-exec/src/workbook_runtime/mod.rs:97:mod recompute;
crates/ql-exec/src/workbook_runtime/mod.rs:98:mod sheets;
crates/ql-exec/src/workbook_runtime/mod.rs:99:mod tables;
crates/ql-exec/src/workbook_runtime/mod.rs:100:mod validate;
crates/ql-exec/src/workbook_runtime/mod.rs:101:pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:131:pub(crate) fn validate_cell(
crates/ql-exec/src/workbook_runtime/formats.rs:21:use ql_functions::format;
crates/ql-exec/src/workbook_runtime/formats.rs:22:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/formats.rs:23:use ql_storage::FormatId;
crates/ql-exec/src/workbook_runtime/formats.rs:24:use ql_types::{ColId, EvalContext, RowId, SheetId};
crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:183:mod tests {
crates/ql-exec/src/workbook_runtime/error.rs:16:use std::sync::Arc;
crates/ql-exec/src/workbook_runtime/error.rs:18:use ql_formula_syntax::{LexError, ParseError, PrintError};
crates/ql-exec/src/workbook_runtime/error.rs:19:use ql_types::{ColId, RowId, SheetId};
crates/ql-exec/src/workbook_runtime/error.rs:21:use crate::plan::BindError;
crates/ql-exec/src/workbook_runtime/names.rs:20:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/names.rs:21:use ql_types::SheetId;
crates/ql-exec/src/workbook_runtime/names.rs:23:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/names.rs:151:mod tests {
crates/ql-exec/src/workbook_runtime/sheets.rs:17:use std::sync::Arc;
crates/ql-exec/src/workbook_runtime/sheets.rs:19:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/sheets.rs:20:use ql_types::{ColId, RowId, SheetId};
crates/ql-exec/src/workbook_runtime/sheets.rs:22:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/sheets.rs:228:mod tests {
crates/ql-exec/src/workbook_runtime/config.rs:15:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/config.rs:17:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/config.rs:71:mod tests {
crates/ql-exec/src/workbook_runtime/mod.rs:39:use ql_functions::format::FormatString;
crates/ql-exec/src/workbook_runtime/mod.rs:40:use ql_functions::FunctionRegistry;
crates/ql-exec/src/workbook_runtime/mod.rs:41:use ql_oplog::OpLog;
crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
crates/ql-exec/src/workbook_runtime/mod.rs:43:use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};
crates/ql-exec/src/workbook_runtime/mod.rs:45:use crate::plan_cache::{PlanCache, PlanCacheStats};
crates/ql-exec/src/workbook_runtime/mod.rs:92:mod cells;
crates/ql-exec/src/workbook_runtime/mod.rs:93:mod config;
crates/ql-exec/src/workbook_runtime/mod.rs:94:mod error;
crates/ql-exec/src/workbook_runtime/mod.rs:95:mod formats;
crates/ql-exec/src/workbook_runtime/mod.rs:96:mod names;
crates/ql-exec/src/workbook_runtime/mod.rs:97:mod recompute;
crates/ql-exec/src/workbook_runtime/mod.rs:98:mod sheets;
crates/ql-exec/src/workbook_runtime/mod.rs:99:mod tables;
crates/ql-exec/src/workbook_runtime/mod.rs:100:mod validate;
crates/ql-exec/src/workbook_runtime/mod.rs:101:pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:131:pub(crate) fn validate_cell(
crates/ql-exec/src/workbook_runtime/recompute.rs:26:use std::sync::Arc;
crates/ql-exec/src/workbook_runtime/recompute.rs:28:use ql_formula_syntax::{lex, lex_with, parse};
crates/ql-exec/src/workbook_runtime/recompute.rs:29:use ql_storage::{SpillShape, Workbook};
crates/ql-exec/src/workbook_runtime/recompute.rs:30:use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};
crates/ql-exec/src/workbook_runtime/recompute.rs:32:use crate::env::WorkbookEnv;
crates/ql-exec/src/workbook_runtime/recompute.rs:33:use crate::plan::{bind_with_site, BindError, BindSite};
crates/ql-exec/src/workbook_runtime/recompute.rs:34:use crate::plan_cache::PlanCacheKey;
crates/ql-exec/src/workbook_runtime/recompute.rs:36:use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/recompute.rs:816:mod tests {
crates/ql-exec/src/workbook_runtime/cells.rs:27:use std::sync::Arc;
crates/ql-exec/src/workbook_runtime/cells.rs:29:use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
crates/ql-exec/src/workbook_runtime/cells.rs:30:use ql_io::CellWireValue;
crates/ql-exec/src/workbook_runtime/cells.rs:31:use ql_oplog::Op;
crates/ql-exec/src/workbook_runtime/cells.rs:32:use ql_storage::SpillShape;
crates/ql-exec/src/workbook_runtime/cells.rs:33:use ql_types::{ArrayValue, ColId, ErrorValue, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
crates/ql-exec/src/workbook_runtime/cells.rs:35:use crate::env::WorkbookEnv;
crates/ql-exec/src/workbook_runtime/cells.rs:36:use crate::eval_result::EvalResult;
crates/ql-exec/src/workbook_runtime/cells.rs:37:use crate::plan::{bind_with_site, BindSite};
crates/ql-exec/src/workbook_runtime/cells.rs:38:use crate::plan_cache::PlanCacheKey;
crates/ql-exec/src/workbook_runtime/cells.rs:40:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:1117:mod tests {

exec
/bin/zsh -lc "git ls-tree --name-only 8137697b5fc:crates/ql-exec/src | rg '"'^workbook_runtime'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 1 in 0ms:
fatal: Not a valid object name 8137697b5fc:crates/ql-exec/src

exec
/bin/zsh -lc 'git show 8137697b5fc:crates/ql-exec/src/workbook_runtime.rs | wc -l' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
fatal: path 'quantbook-engine/crates/ql-exec/src/workbook_runtime.rs' exists, but not 'crates/ql-exec/src/workbook_runtime.rs'
hint: Did you mean '8137697b5fc:quantbook-engine/crates/ql-exec/src/workbook_runtime.rs' aka '8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs'?
       0

exec
/bin/zsh -lc 'git show --stat --oneline 2e8566e35f0..118b4be1611 -- crates/ql-exec/src/workbook_runtime docs/architecture/workbook-runtime-split-design.md crates/ql-exec/src/lib.rs docs/PHASE-4-V2-BACKLOG.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
118b4be1611 Tier D1 Step 4 — final cleanup (Phase 2A.1 partition + handoff updates)
 quantbook-engine/crates/ql-exec/src/lib.rs         |  25 +++
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 233 +--------------------
 .../crates/ql-exec/src/workbook_runtime/names.rs   | 210 +++++++++++++++++++
 quantbook-engine/docs/PHASE-4-V2-BACKLOG.md        |  41 +++-
 4 files changed, 277 insertions(+), 232 deletions(-)
69ede106a61 Tier D1 Step 3.8 — extract WorkbookRuntime validate + transaction API to validate.rs
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 695 +-------------------
 .../ql-exec/src/workbook_runtime/validate.rs       | 719 +++++++++++++++++++++
 2 files changed, 733 insertions(+), 681 deletions(-)
de7f87c5334 Tier D1 Step 3.7 — extract WorkbookRuntime cell mutation API to cells.rs
 .../crates/ql-exec/src/workbook_runtime/cells.rs   | 5131 +++++++++++++++++++
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 5271 +-------------------
 2 files changed, 5239 insertions(+), 5163 deletions(-)
c8d4cf95f70 Tier D1 Step 3.6 — extract WorkbookRuntime recompute pipeline to recompute.rs
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 3359 +-------------------
 .../ql-exec/src/workbook_runtime/recompute.rs      | 3152 ++++++++++++++++++
 2 files changed, 3294 insertions(+), 3217 deletions(-)
aa6e37800ff Tier D1 Step 3.5 — extract WorkbookRuntime table API to tables.rs
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 2167 +------------------
 .../crates/ql-exec/src/workbook_runtime/tables.rs  | 2199 ++++++++++++++++++++
 2 files changed, 2222 insertions(+), 2144 deletions(-)
a48e985c5ec Tier D1 Step 3.4 — extract WorkbookRuntime defined-name API to names.rs
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 307 +--------------------
 .../crates/ql-exec/src/workbook_runtime/names.rs   | 285 +++++++++++++++++++
 .../crates/ql-exec/src/workbook_runtime/sheets.rs  |  49 ++++
 3 files changed, 343 insertions(+), 298 deletions(-)
c37c556dd0f Tier D1 Step 3.3 — extract WorkbookRuntime sheet API to sheets.rs
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 311 +------------------
 .../crates/ql-exec/src/workbook_runtime/sheets.rs  | 335 +++++++++++++++++++++
 2 files changed, 347 insertions(+), 299 deletions(-)
be154f4918d Tier D1 Step 3.2 — extract workbook config setters to config.rs
 .../crates/ql-exec/src/workbook_runtime/config.rs  | 143 +++++++++++++++++++++
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 116 ++---------------
 2 files changed, 155 insertions(+), 104 deletions(-)
2761e1f88cf Tier D1 Step 3.1 — extract WorkbookRuntime format API to formats.rs
 .../crates/ql-exec/src/workbook_runtime/formats.rs | 424 +++++++++++++++++++++
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 413 +-------------------
 2 files changed, 443 insertions(+), 394 deletions(-)
79c1ebeefa7 Tier D1 Step 1 — extract WorkbookRuntime error/result types to error.rs
 .../crates/ql-exec/src/workbook_runtime/error.rs   |   283 +
 .../crates/ql-exec/src/workbook_runtime/mod.rs     | 12473 +++++++++++++++++++
 2 files changed, 12756 insertions(+)

exec
/bin/zsh -lc 'git rev-parse --show-toplevel --show-prefix' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/

exec
/bin/zsh -lc 'git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | wc -l' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'git show 118b4be1611:./crates/ql-exec/src/workbook_runtime/mod.rs | wc -l' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
   12725

 succeeded in 0ms:
     299

exec
/bin/zsh -lc 'git diff --name-status 2e8566e35f0..118b4be1611 -- crates/ql-exec/src/workbook_runtime docs/architecture/workbook-runtime-split-design.md crates/ql-exec/src/lib.rs docs/PHASE-4-V2-BACKLOG.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
M	quantbook-engine/crates/ql-exec/src/lib.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs
A	quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs
M	quantbook-engine/docs/PHASE-4-V2-BACKLOG.md

exec
/bin/bash -lc "comm -23 <(perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' <(git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs) | sort) <(perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' crates/ql-exec/src/workbook_runtime/*.rs | sort)" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
exec
/bin/bash -lc "perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' <(git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs) | sort | uniq -c | awk '{print "'$1, $2}'"' | sort -nr | head -20" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/bash -lc "perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' crates/ql-exec/src/workbook_runtime/*.rs | sort | uniq -c | awk '{print "'$1, $2}'"' | sort -nr | head -30" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
1 w5_d_13_1_subtotal_named_range_binds_and_evaluates
1 w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates
1 w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates
1 w5_d_13_1_atan2_and_sumxmy2_via_source_text
1 w5_55_sumproduct_two_columns_e2e
1 w5_55_sumifs_two_conditions_e2e
1 w5_55_countifs_single_condition_e2e
1 w5_55_averageifs_e2e
1 w5_55_averageif_e2e
1 w5_54_vlookup_not_found_returns_na_e2e
1 w5_54_vlookup_exact_match_e2e
1 w5_54_vlookup_approximate_match_e2e
1 w5_54_index_match_pattern_e2e
1 w5_54_hlookup_exact_match_e2e
1 w5_54_choose_e2e
1 w5_53_sumif_with_separate_sum_range
1 w5_53_sumif_recomputes_on_range_cell_change
1 w5_53_sumif_named_range_numeric_criteria
1 w5_53_sumif_comparator_criteria
1 w5_53_countif_named_range

 succeeded in 0ms:
1 w5_d_13_1_subtotal_named_range_binds_and_evaluates
1 w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates
1 w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates
1 w5_d_13_1_atan2_and_sumxmy2_via_source_text
1 w5_55_sumproduct_two_columns_e2e
1 w5_55_sumifs_two_conditions_e2e
1 w5_55_countifs_single_condition_e2e
1 w5_55_averageifs_e2e
1 w5_55_averageif_e2e
1 w5_54_vlookup_not_found_returns_na_e2e
1 w5_54_vlookup_exact_match_e2e
1 w5_54_vlookup_approximate_match_e2e
1 w5_54_index_match_pattern_e2e
1 w5_54_hlookup_exact_match_e2e
1 w5_54_choose_e2e
1 w5_53_sumif_with_separate_sum_range
1 w5_53_sumif_recomputes_on_range_cell_change
1 w5_53_sumif_named_range_numeric_criteria
1 w5_53_sumif_comparator_criteria
1 w5_53_countif_named_range
1 vol_3_03_seeded_rng_produces_deterministic_rand_sequence
1 vol_3_02_nonvolatile_dependents_update_when_volatile_changes
1 vol_3_01_volatile_formulas_recompute_when_requested
1 veq_does_not_skip_volatile_formulas
1 veq_3_03_profile_records_skipped_vertices
1 veq_3_02_error_equality_suppresses_downstream
1 veq_3_01_unchanged_upstream_suppresses_downstream_recompute
1 validate_formula_surfaces_bind_errors
1 validate_formula_returns_value_without_writing
1 validate_formula_returns_anchor_value_for_top_level_array

exec
/bin/bash -lc "comm -13 <(perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' <(git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs) | sort) <(perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){print \""'$1'"\\n\"}' crates/ql-exec/src/workbook_runtime/*.rs | sort)" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/bash -lc "printf 'old '; perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){"'$n++} END{print "$n'"\\n\"}' <(git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs); printf 'new '; perl -0777 -ne 'while(/#\\[test\\]\\s*fn\\s+([A-Za-z_][A-Za-z0-9_]*)/g){"'$n++} END{print "$n'"\\n\"}' crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
 succeeded in 0ms:
old 306
new 306

codex
The old and new `workbook_runtime` test names match exactly: 306 before, 306 after, with no missing or extra names by `#[test] fn`. That rules out name-level drift; I’m drilling into placement, fixture equivalence, and whether module-specific helpers changed semantics.
exec
/bin/zsh -lc "sed -n '1117,1145p' crates/ql-exec/src/workbook_runtime/cells.rs && sed -n '815,842p' crates/ql-exec/src/workbook_runtime/recompute.rs && sed -n '860,879p' crates/ql-exec/src/workbook_runtime/tables.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '70,91p' crates/ql-exec/src/workbook_runtime/config.rs && sed -n '183,193p' crates/ql-exec/src/workbook_runtime/formats.rs && sed -n '151,170p' crates/ql-exec/src/workbook_runtime/names.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::OpLog;
    use ql_storage::Workbook;

    use crate::workbook_runtime::WorkbookRuntime;

    // Mirror of `super::super::tests::make_runtime_workbook` — the
    // helper is `pub(super)` inside mod.rs's `tests` module and not
    // visible across sibling submodules. Trivial local helper keeps
    // the move self-contained.
    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===================================================================
    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
    // ===================================================================

mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{FormatId, Workbook};
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    // ===== W5-82 / Phase 4.5.D part 6 — format runtime wrappers =====

    #[test]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::Value;

    use crate::plan::BindError;
    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    /// Tier D1 Step 4: shared with the appended Phase 2A.1 named-
    /// range tests. The W5-92 / W5-93 tests above use `Workbook::new()`
    /// directly; the Phase 2A.1 tests built on this helper.
    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== W5-92 (Phase 4.6.D) set_sheet_scoped_name =====


 succeeded in 0ms:
mod tests {
    use std::sync::Arc;

    use ql_functions::default_registry;
    use ql_io::CellWireValue;
    use ql_oplog::{Op, OpLog};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value, MAX_ROW};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== set_formula =====

    #[test]
    fn set_formula_literal_arithmetic() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "1 + 2 * 3").unwrap();
        assert_eq!(v, Value::Number(7.0));
        // Persisted: both the formula and the value.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Number(7.0));
#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::plan::BindError;
    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== recompute_all =====

    #[test]
    fn recompute_all_on_empty_workbook_is_noop() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.recompute_all();
        assert_eq!(result.attempted, 0);
        assert_eq!(result.succeeded, 0);
        assert!(result.is_complete());
    }
mod tests {
    use std::sync::Arc;

    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== W5-116 (Phase 4.8.G) — structured-ref eval through aggregate =====

    /// **First end-to-end test for Phase 4.8 structured refs.** Set up a
    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert

exec
/bin/zsh -lc "sed -n '228,236p' crates/ql-exec/src/workbook_runtime/sheets.rs && sed -n '142,158p' crates/ql-exec/src/workbook_runtime/validate.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
mod tests {
    use ql_functions::default_registry;
    use ql_storage::Workbook;
    use ql_types::Value;

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    // ===== W5-91 (Phase 4.6.C) rename_sheet =====

mod tests {
    use ql_functions::default_registry;
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== Phase 2B.7 — audit closure: input validation + dry-run + cleanup =====

    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
    /// any op-log append. Without this check, the workbook gets a sheet

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '4400,4435p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/bash -lc "for f in crates/ql-exec/src/workbook_runtime/*.rs; do rg -n \"fn make_runtime_workbook\\(\\)|fn build_aggregate_workbook\\(|fn coverage_matrix\\(\" \""'$f"; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
            Op::PutValue {
                sheet,
                row,
                col,
                value,
            } => {
                assert_eq!((*sheet, *row, *col), (0, 2, 3));
                assert_eq!(value, &CellWireValue::Number(42.0));
            }
            other => panic!("expected PutValue, got {other:?}"),
        }
    }

    #[test]
    fn set_value_over_existing_formula_emits_batch_commit_pair() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Seed a formula at (0, 0) via the runtime so the op log captures it.
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_formula(0, 0, 0, "1 + 1").unwrap();
            rt.set_value(0, 0, 0, Value::Number(99.0)).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Phase 2B.7 audit H2: the PutValue + ClearFormula pair now lands
        // as one atomic `Op::BatchCommit` so partial-pair op-log failure is
        // impossible. Expect 2 ops total: PutFormula → BatchCommit{PutValue,
        // ClearFormula}.
        assert_eq!(ops.len(), 2, "ops were: {ops:?}");
        assert!(matches!(ops[0], Op::PutFormula { .. }));
        match &ops[1] {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2);
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::ClearFormula { .. }));

 succeeded in 0ms:
1128:    fn make_runtime_workbook() -> Workbook {
4884:    fn coverage_matrix() -> Vec<MatrixCell> {
82:    fn make_runtime_workbook() -> Workbook {
163:    fn make_runtime_workbook() -> Workbook {
824:    fn make_runtime_workbook() -> Workbook {
2076:    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
870:    fn make_runtime_workbook() -> Workbook {
149:    fn make_runtime_workbook() -> Workbook {

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '3520,3545p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | rg -n "fn make_runtime_workbook|fn build_aggregate_workbook|fn coverage_matrix"' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
3781:    fn make_runtime_workbook() -> Workbook {
6604:    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
12478:    fn coverage_matrix() -> Vec<MatrixCell> {
12624:    fn coverage_matrix_mode_locale_at_presence_30_cells() {
12661:    fn coverage_matrix_has_no_duplicates() {
12714:    fn coverage_matrix_dimension_counts() {

 succeeded in 0ms:
                        {
                            let v = Value::Error(ErrorValue::Name);
                            let prior_val = prior.get(&(sheet, row, col));
                            if prior_val == Some(&v) {
                                skipped_value_equality += 1;
                            } else {
                                self.workbook.put_computed_at(sheet, row, col, v);
                                changed.insert((sheet, row, col));
                            }
                            succeeded += 1;
                        } else {
                            failures.push(RecomputeFailure {
                                sheet,
                                row,
                                col,
                                formula_text: text,
                                error,
                            });
                        }
                    }
                }
            }
        } // end MAX_ITERATIONS loop

        // **Codex audit MEDIUM closure**: if we hit MAX_ITERATIONS
        // AND session.dirty() is still non-empty, the fixed point

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '10215,10240p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    /// Closed by: recompute_dirty calls reextract_spill_footprint_readers
    /// for the (old, new) footprints, mirroring set_formula 4.7.J.4.
    #[test]
    fn recompute_dirty_dissolution_reextracts_aliased_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
            rt.set_formula(0, 0, 4, "B2").unwrap(); // X1 = B2, aliased to B1.
        }
        let x1 = graph.cell_node_for(0, 0, 4).unwrap();
        assert_eq!(
            graph.formula_deps(x1).unwrap().cells,
            vec![(0, 0, 1)],
            "X1 starts aliased to B1"
        );

        // Change A1 to 0 — SEQUENCE(0) → #NUM! per design § 13.1
        // (W5-108 / Phase 4.7.O Codex M2 closure). The recompute
        // surfaces a scalar error at B1, the spill dissolves, and
        // host dissolution still triggers the re-extraction we're
        // pinning here. Whether B1 ends as #NUM! or #CALC! is

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '12020,12055p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
        }
        assert_eq!(oplog.len(), 0);
    }

    #[test]
    fn set_locale_updates_workbook_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_locale(ql_types::Locale::De).unwrap();
        }
        assert_eq!(wb.locale(), ql_types::Locale::De);
        assert_eq!(oplog.len(), 1);
    }

    #[test]
    fn set_locale_noop_when_unchanged_emits_no_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_locale(ql_types::Locale::EnUs).unwrap();
        }
        assert_eq!(oplog.len(), 0);
    }

    // -------------------------------------------------------------
    // W5-147 (Phase 4.9.K) — set_formula canonical-storage tests.
    // -------------------------------------------------------------

    /// **R1C1 input canonicalizes to A1 in storage.** When the
    /// workbook is in R1C1 mode and user types `R1C1`, the stored
    /// formula text is `$A$1` (A1+EnUs canon).

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '6596,6625p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '3768,3792p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
            simd_eligible,
            old_spill_shape,
            new_spill_shape,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_types::ErrorValue;

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== set_formula =====

    #[test]
    fn set_formula_literal_arithmetic() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();

 succeeded in 0ms:

    // ----------------------------------------------------------------
    // Phase 3.6 (W5-39) — AGG-3-01..04 acceptance tests (CORR-25 follow-up).
    // ----------------------------------------------------------------

    /// Helper: build a workbook with a named range `BigRange` over A1:A`size`
    /// pre-populated with values 1..=size, and a SUM(BigRange) formula at B1.
    /// Returns (wb, session) after rebuild — session has 0 cached aggregates.
    fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) {
        use ql_storage::NamedTarget;
        use ql_types::Range;
        let mut wb = make_runtime_workbook();
        for r in 0..size {
            wb.put_at(0, r, 0, Value::Number((r + 1) as f64));
        }
        wb.set_name(
            "BigRange",
            NamedTarget::Range(Range::new(0, 0, 0, size - 1, 0)),
        )
        .unwrap();
        wb.put_at(0, 0, 1, Value::Blank);
        wb.put_formula(0, 0, 1, "SUM(BigRange)");
        let rebuild = crate::CalcgraphSession::rebuild_from_workbook(&wb);
        assert!(rebuild.is_complete());
        (wb, rebuild.session)
    }

    /// AGG-3-04 (correctness baseline): SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT
    /// over a named range produce the same result as the scalar baseline.
    /// Sales = A1:A5 = [1, 2, 3, 4, 5]: SUM = 15, AVERAGE = 3, MIN = 1,

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '12466,12496p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    // ===================================================================

    /// **Coverage matrix cell.** Anchor is always `(0, 0, 0)` so the
    /// expected canonical column can hardcode A1 letters.
    struct MatrixCell {
        mode: ql_types::ReferenceMode,
        locale: ql_types::Locale,
        input: &'static str,
        expected_canonical: &'static str,
    }

    /// Build the full 30-cell matrix.
    fn coverage_matrix() -> Vec<MatrixCell> {
        use ql_types::{Locale, ReferenceMode};
        let mut cells = Vec::with_capacity(30);

        // ----- @-presence = none -----
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::A1,
                locale,
                input: "A1",
                expected_canonical: "A1",
            });
        }
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            cells.push(MatrixCell {
                mode: ReferenceMode::R1C1,
                locale,
                input: "R1C1",
                expected_canonical: "$A$1",

exec
/bin/zsh -lc "sed -n '1,150p' crates/ql-exec/src/workbook_runtime/validate.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
//! Validation + transaction API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.8 (2026-05-18, final method-extraction step):
//! extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side methods covering IDE on-keystroke validation
//! and multi-cell transaction batching. Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::transaction`] (Phase 2A.2 / 2A.3.b) — begin
//!   a multi-cell transaction. The returned `WorkbookTransaction`
//!   borrows the runtime's workbook + registry + (optional) op
//!   log for its lifetime; commits land atomically.
//! - [`WorkbookRuntime::validate_formula`] (Phase 2B.7, GAP-I-04
//!   closure) — dry-run the full lex → parse → bind → eval
//!   pipeline against current workbook state without writing.
//!   Used by the IDE for on-keystroke diagnostics. Returns the
//!   would-be evaluated value or a typed `RuntimeError`.

use ql_formula_syntax::{lex, parse};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_site, BindSite};
use crate::transaction::WorkbookTransaction;

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// Begin a multi-cell transaction. The returned `WorkbookTransaction`
    /// borrows the runtime's workbook + registry for its lifetime. Buffer
    /// writes via `put_value`/`put_formula` then call `commit` to apply them
    /// atomically. See `transaction::WorkbookTransaction` for full semantics.
    ///
    /// Phase 2A.3.b (2026-05-12): if the runtime was constructed with
    /// `with_oplog`, the transaction inherits the op-log handle via
    /// `Option::as_deref_mut` (re-borrowed for the transaction's shorter
    /// lifetime). The runtime is borrow-frozen while the transaction is
    /// alive, so a single op log records both individual edits and batched
    /// commits without aliasing.
    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
        WorkbookTransaction::with_optional_oplog(
            self.workbook,
            self.registry,
            self.oplog.as_deref_mut(),
        )
    }

    /// Re-evaluate every formula in the workbook. Used after `load_workbook` to
    /// refresh stale values (the qbook loader stores formula text + a sentinel
    /// value; this method computes the real value).
    ///
    /// Iteration order is HashMap-arbitrary, so cross-cell dependencies may
    /// evaluate in a non-deterministic order. Engine Phase 3 calcgraph
    /// integration will add topological scheduling for deterministic + correct
    /// dependency resolution (see `docs/MASTER-PLAN.md` Phase 3.4; tracked as
    /// GAP-R-01 in `docs/known-gaps.md`).
    ///
    /// Phase 2B.2 (2026-05-12): signature changed from `Result<usize,
    /// RuntimeError>` to `RecomputeResult` (always returns; no Result
    /// wrapper). The prior shape short-circuited on first failure and
    /// dropped per-cell context; the new shape continues past failures
    /// and aggregates them. See [`RecomputeResult`] for the contract.
    ///
    /// Cells that fail structurally (lex/parse/bind) keep their
    /// pre-recompute values and formula text. Cells that succeed have
    /// their value replaced. Cells whose evaluation produces an Excel-
    /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
    /// succeeded — those error values are normal cell contents per
    /// Excel canon, not structural failures.
    /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
    /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
    /// pipeline against the current workbook state, returns the would-be
    /// evaluated value (or `RuntimeError`), but does NOT:
    ///
    /// - write to the workbook,
    /// - append to the op log,
    /// - pollute the bind-plan cache (this avoids a transient cache entry
    ///   keyed on a formula text the user hasn't actually committed —
    ///   would inflate the cache miss count and waste a `name_gen` slot).
    ///
    /// Use case: the IDE wants to highlight syntax errors as the user types
    /// in the formula bar, without committing the formula until Enter.
    /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
    /// safely — N calls per keystroke add no engine state.
    ///
    /// Closes GAP-I-04 from `docs/known-gaps.md`.
    pub fn validate_formula(
        &self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &str,
    ) -> Result<Value, RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        let tokens = lex(formula_text)?;
        let expr = parse(tokens)?;
        // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the
        // two-tier sheet-then-workbook scope chain fires.
        // **W5-114 (Phase 4.8.E):** carry the (proposed) cell address so
        // structured-ref `[@Col]` validation works.
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
            self.workbook,
            self.workbook,
            self.workbook,
        )?;
        // **W5-117 (Phase 4.8.G.2):** carry cell for `[@Col]` narrowing.
        let env =
            WorkbookEnv::with_formula_cell(self.workbook, ql_types::Address::new(sheet, row, col));
        // **W5-103 megaudit MEDIUM-3 closure (#129):** route through
        // `eval_at_cell_boundary` so a top-level array literal like
        // `{1, 2, 3}` returns the anchor value (array.at(0,0)) instead
        // of `#CALC!` (which is what `eval_scalar_with_registry` would
        // give per the scalar-context contract at scalar.rs:95).
        //
        // Previously the validate path used scalar eval directly, which
        // made the IDE preview inconsistent with `set_formula`'s actual
        // spill behavior. With this change, validate and set_formula
        // produce equivalent anchor-value previews. The IDE doesn't get
        // the SHAPE of the spill from validate; that would need a
        // dedicated `ValidationResult` enum (deferred — see GAP-I-04).
        let nc = crate::aggregate_cache::NoAggregateCache;
        let result = crate::scalar::eval_at_cell_boundary(&plan, &env, self.registry, &nc);
        Ok(match result {
            crate::eval_result::EvalResult::Scalar(v) => v,
            // Anchor cell preview = array.at(0,0). Degenerate arrays
            // surface as `#CALC!` per the existing scalar-context
            // contract (preserved via `into_scalar_for_test`-style
            // logic inlined here to avoid the cfg(test) gate).
            crate::eval_result::EvalResult::Array(a) if a.is_degenerate() => {
                Value::Error(ErrorValue::Calc)
            }
            crate::eval_result::EvalResult::Array(a) => a.at(0, 0).clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();

exec
/bin/zsh -lc "sed -n '1,150p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
//! Recompute pipeline for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.6 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Five
//! methods covering the formula-recompute surface (full pass +
//! incremental + per-cell helpers). Pure code move; no behavior
//! change.
//!
//! Methods:
//! - [`WorkbookRuntime::recompute_all`] — HashMap-order full pass
//!   with the Tier C1 cycle-detection pre-pass (2026-05-18,
//!   commit 3451d90a03f). Used by `.qbook` load + replay.
//! - [`WorkbookRuntime::recompute_dirty`] — incremental graph-
//!   driven recompute via Tarjan SCC over the attached
//!   `CalcgraphSession`'s dirty set; cycled members get `#CIRC!`.
//!   The performance path with session-attached callers (IDE).
//! - `try_recompute_one_cached` (private) — lex+parse+bind+eval
//!   one formula via the `PlanCache`.
//! - `try_recompute_with_aggregate_cache` (private) — same path
//!   with `AggregateCache` for `SUM(NamedRange)`-style cache
//!   hits (Phase 3.6 AGG-3-01).
//! - `try_recompute_with_simd_profile` (private) — recompute
//!   with the SIMD-classification + spill-management orchestrator
//!   used by `recompute_dirty`'s sorted-node loop.

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse};
use ql_storage::{SpillShape, Workbook};
use ql_types::{ColId, ErrorValue, RowId, SheetId, Value};

use crate::env::WorkbookEnv;
use crate::plan::{bind_with_site, BindError, BindSite};
use crate::plan_cache::PlanCacheKey;

use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    pub fn recompute_all(&mut self) -> RecomputeResult {
        // **Tier C1 (2026-05-18 — Phase 4.12 Opus-B H-2 closure):**
        // cycle detection. `recompute_all` is the no-session-attached
        // fallback used by `.qbook` load + replay. Before this fix,
        // cyclic formulas like `=A1+1` in A1 silently produced
        // wrong values on each call (1, then 2, then 3, …) because
        // HashMap-order evaluation just re-read the prior value.
        //
        // Strategy: build an ephemeral `CalcgraphSession` from the
        // current workbook, mark every formula dirty, run Tarjan
        // SCC via `schedule_dirty`, and write `#CIRC!` for every
        // cell in a cycle BEFORE the HashMap-order eval loop runs.
        // The acyclic remainder evaluates through the existing
        // HashMap-order loop; any cell that reads from a cycled
        // cell sees the freshly-written `#CIRC!` and propagates it
        // via standard error semantics.
        //
        // `rebuild_from_workbook` parses every formula a second
        // time (the existing loop below also parses each via
        // `try_recompute_one_cached`). Acceptable cost for the
        // load/replay path; `recompute_dirty` is the performance
        // path with session-attached callers.
        //
        // **Post-audit closures (2026-05-18 Tier C1 audit):**
        //
        // - *Codex H-1*: cycled cells are now written in a pre-pass
        //   below, not lazily inside the eval loop. This matches
        //   `recompute_dirty`'s cycle-first ordering (see line 3160+
        //   below). Without the pre-pass, HashMap-order could
        //   evaluate a non-cycled dependent (`B1 = A1+1`) before the
        //   cycled cell (`A1 = A1+1`) was overwritten, and B1 would
        //   read A1's stale prior value.
        //
        // - *Codex H-2*: cycled-cell pre-pass also clears any
        //   pre-existing spill anchor at the same address before
        //   writing `#CIRC!`. Without this, an old `SEQUENCE(3)`
        //   spill anchor that gets overwritten with a circular
        //   formula leaves stale spill target overlays in A2/A3.
        //
        // - *Opus H-1*: bind-failed formula nodes (those whose
        //   parse/bind errored inside `rebuild_from_workbook`) are
        //   inserted into the session's cell index but registered
        //   with zero outgoing edges. Tarjan therefore cannot place
        //   them in a non-trivial SCC nor mark them as self-loops,
        //   so the `cycled` set correctly excludes them. They flow
        //   into the existing HashMap-order eval loop and the
        //   parse/bind error surfaces via the normal `failures`
        //   pathway.
        let cycled_cells: std::collections::HashSet<(SheetId, RowId, ColId)> = {
            use crate::calcgraph_session::CalcgraphSession;
            let mut session = CalcgraphSession::rebuild_from_workbook(self.workbook).session;
            let formula_addrs: Vec<(SheetId, RowId, ColId)> = self
                .workbook
                .iter_formulas()
                .map(|(s, r, c, _)| (s, r, c))
                .collect();
            for (s, r, c) in &formula_addrs {
                if let Some(node) = session.cell_node_for(*s, *r, *c) {
                    session.mark_dirty(node);
                }
            }
            let sched = session.schedule_dirty();
            sched
                .cycled
                .into_iter()
                .filter_map(|n| session.cell_address_for(n))
                .collect()
        };

        // **Codex H-1 / H-2 closure pre-pass:** write `#CIRC!` to
        // every cycled cell BEFORE running the HashMap-order eval
        // loop, and clear any spill anchor that previously lived at
        // the same address. Order matters: writing `#CIRC!` before
        // the loop guarantees a non-cycled dependent that reads
        // from a cycled cell sees the error sigil and propagates
        // it, instead of reading a stale prior value.
        for &(sheet, row, col) in &cycled_cells {
            self.workbook.clear_spill_if_present((sheet, row, col));
            self.workbook
                .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
        }

        // Snapshot the formula list so we don't hold a borrow during eval.
        let entries: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, f)| (s, r, c, Arc::clone(f)))
            .collect();
        let attempted = entries.len();
        let mut succeeded = 0;
        let mut failures: Vec<RecomputeFailure> = Vec::new();

        for (sheet, row, col, formula_text) in entries {
            // Tier C1: cycled cells were already written to `#CIRC!`
            // in the pre-pass above and any stale spill cleared.
            // Match `recompute_dirty`'s cycled-cell accounting:
            // cycled cells contribute to `attempted` but NOT to
            // `succeeded` (the VEQ short-circuit logic that
            // `recompute_dirty` runs in addition does not apply
            // here — `recompute_all` is the legacy full-pass path).
            if cycled_cells.contains(&(sheet, row, col)) {
                continue;
            }
            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
                Ok(value) => {
                    // Phase 3.5 (CORR-25): formula outputs route to the
                    // COMPUTED overlay, never the user lane.
                    self.workbook.put_computed_at(sheet, row, col, value);
                    succeeded += 1;
                }
                Err(error) => {
                    // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**

exec
/bin/zsh -lc "sed -n '1,210p' crates/ql-exec/src/workbook_runtime/mod.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
//! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
//!
//! Ties the lex → parse → bind → eval → put pipeline together so callers (IDE,
//! tests, future REPL) get one method that does the right thing for a user-typed
//! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
//! the workbook — used after loading a `.qbook/` directory where formula values
//! were left as `#NULL!` sentinels.
//!
//! Phase 1 W5-10 scope:
//! - `set_formula(sheet, row, col, text)` — parse + eval + persist formula text +
//!   evaluated value. Phase 3.5: routes the evaluated value to the COMPUTED
//!   overlay; clears any stale user-overlay entry at the cell first.
//! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
//!   formula association. Phase 3.5: `clear_formula` cascades to drop the
//!   computed-overlay entry too.
//! - `recompute_all()` — HashMap-order full pass. Tier C1 (2026-05-18,
//!   Phase 4.12 Opus-B H-2 closure) added an ephemeral
//!   `CalcgraphSession`-based cycle-detection pre-pass: cycled cells
//!   short-circuit to `#CIRC!` before the eval loop runs. Acyclic
//!   formulas still evaluate in HashMap order (GAP-R-01 stale-
//!   intermediate caveat unchanged).
//! - `recompute_dirty()` (Phase 3.4 W5-37) — incremental graph-driven recompute.
//!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
//!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
//!   through the session's `InMemAggregateCache`; Phase 3.8 applies value-
//!   equality short-circuit; Phase 3.9 V1 tallies SIMD-eligible formulas in
//!   `RecomputeResult.simd_classified`.
//! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
//!   without mutation; IDE on-keystroke validation entry.
//!
//! Phase 4+ deferred (per Phase 3.10 megaudit + W5-48 Codex deep-audit):
//! - GAP-G-01 / GAP-G-03 — append-only graph rebind staleness + range-deps-
//!   not-scheduler-edges. Architectural decision needed before Phase 4.3 V2.
//! - GAP-G-02 — bulk SIMD region dispatch from graph scheduler (V1 is
//!   observability only).
//! - FN4-03 — lazy IF/IFERROR (needs scalar.rs Function-branch refactor).
//! - Cross-sheet formula references via NameTable resolution (Phase 4.6).

use ql_functions::format::FormatString;
use ql_functions::FunctionRegistry;
use ql_oplog::OpLog;
use ql_storage::{FormatId, Workbook};
use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};

use crate::plan_cache::{PlanCache, PlanCacheStats};

// **Tier D1 (2026-05-18 — Phase 5 prep, monolith split):** sibling
// submodules under `crate::workbook_runtime`. Each submodule adds an
// `impl<'a> WorkbookRuntime<'a> { ... }` block to extend the struct
// without changing its public API surface. See
// `docs/architecture/workbook-runtime-split-design.md`.
//
// Step 1 (2026-05-18, commit 79c1ebeefa7): error/result types →
//   `error.rs`. Re-exported here so callers continue to import
//   `RuntimeError` / `RecomputeFailure` / `RecomputeResult` from
//   `crate::workbook_runtime` unchanged.
// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
//   read_display) → `formats.rs`. No public re-export needed (methods
//   stay on `WorkbookRuntime`).
// Step 3.2 (2026-05-18): workbook config setters (set_reference_mode,
//   set_locale) → `config.rs`. As a side effect, the rename_table doc
//   that was previously misattached to set_reference_mode now correctly
//   attaches to pub fn rename_table.
// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
//   private `rewrite_formula_text_for_sheet_rename` helper → `sheets.rs`.
// Step 3.4 (2026-05-18): defined-name API (set_name,
//   set_sheet_scoped_name) → `names.rs`. Folded-in cleanup: 3
//   misplaced add_sheet W5-93 tests that should have moved with
//   Step 3.3 now live in sheets.rs::tests.
// Step 3.5 (2026-05-18): table mutation API (create_table, drop_table,
//   rename_table, rename_column, resize_table, reextract_table_readers
//   private helper) → `tables.rs`. Biggest single step: ~819 LOC impl
//   + ~1,380 LOC tests (W5-116/118/119/121/122 clusters).
// Step 3.6 (2026-05-18): recompute pipeline (recompute_all,
//   recompute_dirty, try_recompute_one_cached,
//   try_recompute_with_aggregate_cache, try_recompute_with_simd_profile)
//   → `recompute.rs`. Test clusters: recompute_all, Tier C1, 2B.2, 2B.3,
//   2B.4, Phase 3.1 calcgraph integration.
// Step 3.7 (2026-05-18): cell mutation API (set_formula, set_value,
//   clear_formula, write_spill, write_anchor_error,
//   reextract_spill_footprint_readers) → `cells.rs`. Largest method-
//   LOC step: set_formula alone is 417 LOC. Test clusters: set_formula
//   + set_value + Phase 2A.3.b + Phase 2B.5 + W5-83/90/103-107/124/
//   125/148/149.
// Step 3.8 (2026-05-18, FINAL method-extraction step): validation +
//   transaction API (transaction, validate_formula) → `validate.rs`.
//   Phase 2B.7 input-validation test cluster (~564 LOC) moved with
//   it. mod.rs is now down to <600 LOC — close to the ≤ 250 Step 4
//   final-cleanup target (remaining is constructors + validate_sheet
//   / validate_cell helpers + Phase 2A.1 named-range tests still in
//   the inline test module).
mod cells;
mod config;
mod error;
mod formats;
mod names;
mod recompute;
mod sheets;
mod tables;
mod validate;
pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};

/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
/// before any work that would otherwise panic inside `Workbook::put_at`.
/// `pub(crate)` so `WorkbookTransaction` can call the same validator at
/// `put_value` / `put_formula` buffering time.
pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
    let count = workbook.sheet_count();
    if (sheet as usize) >= count {
        return Err(RuntimeError::InvalidSheet {
            sheet,
            sheet_count: count,
        });
    }
    Ok(())
}

/// Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
/// row/col bounds checks so the runtime entry points refuse out-of-grid
/// coordinates before any work that would otherwise panic inside
/// `Sheet::put` (which asserts `row <= MAX_ROW && col <= MAX_COLUMN`). The
/// Phase 2A.6 audit closed sheet-id panics but missed row/col — three
/// independent megaudit agents flagged the gap. `pub(crate)` so
/// `WorkbookTransaction` can call the same validator at buffer time.
///
/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
/// helper that lived between this comment and `validate_cell`. The
/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
/// now reaches its intended target.
pub(crate) fn validate_cell(
    workbook: &Workbook,
    sheet: SheetId,
    row: RowId,
    col: ColId,
) -> Result<(), RuntimeError> {
    validate_sheet(workbook, sheet)?;
    if row > MAX_ROW {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "row exceeds MAX_ROW (1,048,575)",
        });
    }
    if col > MAX_COLUMN {
        return Err(RuntimeError::InvalidCell {
            sheet,
            row,
            col,
            why: "col exceeds MAX_COLUMN (16,383)",
        });
    }
    Ok(())
}

// (Tier D1 Step 1: error/result types moved to error.rs above —
//  see the mod declaration + pub use at the top of this file.)

/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
///
/// Construct one per session of cell edits. Re-creating per call is cheap (the
/// struct holds borrows, no heap state of its own).
///
/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
/// emit ops into the log in append-before-mutate order. `transaction()`
/// re-borrows the op-log handle into the returned transaction so a single op
/// log records both individual edits and batched commits cohesively.
pub struct WorkbookRuntime<'a> {
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    /// Optional op-log sink. When `Some`, all producer methods append before
    /// mutating the workbook so a failing append leaves the workbook
    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
    oplog: Option<&'a mut OpLog>,
    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
    /// successive `set_formula` and `recompute_all` calls hit the cache
    /// for unchanged formula text under the same NameTable generation.
    /// See `crate::plan_cache` module docs for the invalidation contract.
    plan_cache: PlanCache,
    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
    /// every mutation method calls the corresponding hook on the
    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
    /// dirty propagation through the same surface. See
    /// `crate::calcgraph_session` module docs for the ownership model.
    graph: Option<&'a mut crate::CalcgraphSession>,
    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
    /// by `FormatId`. `read_display` populates on-demand from
    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
    /// id→string mutations, so cache entries stay stable for the
    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
    /// new entry; no invalidation needed.
    format_cache: std::collections::HashMap<FormatId, FormatString>,
}

impl<'a> WorkbookRuntime<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            oplog: None,
            plan_cache: PlanCache::new(),
            format_cache: std::collections::HashMap::new(),
            graph: None,
        }
    }

    /// Phase 2A.3.b: construct a runtime that records every mutation to the

exec
/bin/zsh -lc "sed -n '1,120p' crates/ql-exec/src/workbook_runtime/config.rs && sed -n '1,110p' crates/ql-exec/src/workbook_runtime/formats.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
//! Workbook-level config setters for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.2 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side methods that update workbook-scoped IDE
//! preferences (reference-mode + locale). Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::set_reference_mode`] — switch between A1
//!   and R1C1 input/display modes. Idempotent.
//! - [`WorkbookRuntime::set_locale`] — switch between EnUs / De /
//!   Fr formula input/display locales. Idempotent.

use ql_oplog::Op;

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **W5-146 (Phase 4.9.K):** set the workbook's reference mode
    /// (A1 or R1C1) and append `Op::SetReferenceMode` to the op-log.
    /// Idempotent — setting to the current value is a no-op that
    /// emits NO op (keeps the log compact).
    ///
    /// Per design § 4.4 storage canon, formula text is stored in
    /// canonical A1 form regardless of `mode`; this setting only
    /// affects how the IDE renders formulas to the user and how
    /// future calls to `set_formula(text)` interpret the input
    /// reference syntax.
    pub fn set_reference_mode(
        &mut self,
        mode: ql_types::ReferenceMode,
    ) -> Result<(), RuntimeError> {
        if self.workbook.reference_mode() == mode {
            return Ok(());
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetReferenceMode {
                mode: ql_oplog::ReferenceModeWire::from_runtime(mode),
            })?;
        }
        self.workbook.set_reference_mode(mode);
        Ok(())
    }

    /// **W5-146 (Phase 4.9.K):** set the workbook's locale (EnUs /
    /// De / Fr) and append `Op::SetLocale` to the op-log.
    /// Idempotent — setting to the current value emits no op.
    ///
    /// Per design § 4.4 storage canon, formula text is stored in
    /// EN-locale form regardless of this setting; this setting only
    /// affects how the IDE renders formulas to the user (decimal
    /// separator, argument separator, array separators) and how
    /// future calls to `set_formula(text)` interpret input
    /// glyphs.
    pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> {
        if self.workbook.locale() == locale {
            return Ok(());
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetLocale {
                locale: ql_oplog::LocaleWire::from_runtime(locale),
            })?;
        }
        self.workbook.set_locale(locale);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::OpLog;
    use ql_storage::Workbook;

    use crate::workbook_runtime::WorkbookRuntime;

    // Mirror of `super::super::tests::make_runtime_workbook` — the
    // helper is `pub(super)` inside mod.rs's `tests` module and not
    // visible across sibling submodules. Trivial local helper keeps
    // the move self-contained.
    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===================================================================
    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
    // ===================================================================

    #[test]
    fn set_reference_mode_updates_workbook_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
        }
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(oplog.len(), 1);
    }

    #[test]
    fn set_reference_mode_noop_when_unchanged_emits_no_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // default is A1; setting A1 again is a no-op.
            rt.set_reference_mode(ql_types::ReferenceMode::A1).unwrap();
        }
        assert_eq!(oplog.len(), 0);
    }

    #[test]
    fn set_locale_updates_workbook_and_emits_op() {
//! Format API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.1 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Three
//! methods covering the producer-side format surface — table
//! interning, per-cell binding, and display rendering. Pure code
//! move; no behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::intern_format`] — register a format string
//!   in the workbook's `FormatTable` and emit `Op::RegisterFormat`
//!   if (and only if) a new id was allocated. Idempotent.
//! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
//!   `FormatId` (or clear via `None`). Refuses unknown ids
//!   (`RuntimeError::UnknownFormatId`).
//! - [`WorkbookRuntime::read_display`] — read a cell and render it
//!   through its `FormatId` binding (or General if unbound).
//!   Memoizes parsed `FormatString` per id in
//!   `WorkbookRuntime::format_cache`.

use ql_functions::format;
use ql_oplog::Op;
use ql_storage::FormatId;
use ql_types::{ColId, EvalContext, RowId, SheetId};

use super::{validate_cell, RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
    /// op log if (and only if) the call allocated a NEW id. Returns the
    /// `FormatId`, which the caller can pass to [`set_cell_format`].
    ///
    /// Idempotent on repeated calls with the same string — the second
    /// call returns the same id without emitting a duplicate op. This
    /// keeps the op log compact and replay deterministic.
    ///
    /// Direct callers of `Workbook::formats_mut().intern()` bypass the
    /// op log silently; that path is documented as low-level and intended
    /// for the qbook loader + tests + engine-internal reconstruction.
    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
        // Check whether the table already knows this string. If so, no
        // new id is allocated and we MUST NOT emit `RegisterFormat`
        // (idempotent path).
        if let Some(existing) = self.workbook.formats().iter().find(|(_, t)| *t == s) {
            return Ok(existing.0);
        }
        // New string — predict the id the table will allocate so we can
        // emit the op BEFORE mutating (append-before-mutate ordering,
        // matching set_name / set_value).
        let id = FormatId(self.workbook.formats().next_custom_id());
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RegisterFormat {
                id: id.0,
                string: s.to_owned(),
            })?;
        }
        let allocated = self.workbook.formats_mut().intern(s);
        debug_assert_eq!(
            allocated, id,
            "FormatTable::intern allocated a different id than next_custom_id predicted"
        );
        Ok(allocated)
    }

    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
    /// to the op log. Sheet/row/col are validated; `id = Some(...)` that
    /// references an unknown id is REFUSED (matching replay's
    /// `FormatNotRegistered` semantic — producer-side enforcement is
    /// the cleaner spot for the check).
    ///
    /// Direct callers of `Sheet::format_overlay_mut()` bypass the op
    /// log silently; that path is documented as low-level.
    pub fn set_cell_format(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        id: Option<FormatId>,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        // Producer-side gatekeeping: refuse `Some(id)` referencing an
        // unregistered format. Replay does the same check (W5-80) so
        // an op log that ever reaches the wire is well-formed.
        if let Some(fid) = id {
            if self.workbook.formats().lookup(fid).is_none() {
                return Err(RuntimeError::UnknownFormatId(fid.0));
            }
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetCellFormat {
                sheet,
                row,
                col,
                id: id.map(|f| f.0),
            })?;
        }
        // Apply the mutation. After append-success this cannot fail.
        let overlay = self
            .workbook
            .sheet_mut(sheet)
            .expect("validate_cell guards sheet bounds")
            .format_overlay_mut();
        match id {
            Some(fid) => {
                overlay.set(row, col, fid);
            }
            None => {
                overlay.clear(row, col);

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '1550,1630p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | rg -n "Re-evaluate every formula|validate_formula|Begin a multi-cell transaction|pub fn recompute_all"' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
        //    at edit rate (matches the rename pattern); per-sheet
        //    generation counters are design § 10.5 future polish.
        self.plan_cache.clear();

        Ok(())
    }

    // ===== W5-118 (Phase 4.8.H) — table mutation API =====

    /// **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
    /// emitting `Op::CreateTable` into the attached op log (if any).
    ///
    /// Validation (op log append is BEFORE storage mutation per the
    /// W5-103 atomicity pattern):
    /// - Sheet exists.
    /// - Footprint fits in the sheet (rows + cols > 0).
    /// - No overlap with any existing table footprint.
    /// - Name is unique against both `TableTable` AND `NameTable`
    ///   (shared namespace per design § 4.3 / § 13 decision #3).
    /// - Column count matches `column_names.len()`.
    /// - Column names are non-empty and unique case-insensitively.
    ///
    /// Each column is assigned a stable id from
    /// `TableTable::allocate_column_id`. Header / totals rows are
    /// metadata-only — this method does NOT write into the header row;
    /// callers can pre-populate cells via `set_value`.
    ///
    /// Direct callers of `Workbook::tables_mut().insert` bypass the op
    /// log silently — that path is documented as low-level (qbook
    /// loader + tests).
    #[allow(clippy::too_many_arguments)]
    pub fn create_table(
        &mut self,
        name: &str,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    ) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        // ----- Validation (all checks BEFORE op-log append) -----
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        if rows == 0 || cols == 0 {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table rows and cols must both be > 0",
            });
        }
        // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
        // upper bound fits within MAX_ROW / MAX_COLUMN. Closes the gap
        // where `for r in top_row..top_row + rows` either ran beyond
        // the addressable grid or u32-overflowed silently.
        if let Err(reason) =
            ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, rows, cols)
        {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason,
            });
        }
        if column_names.len() != cols as usize {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "column_names length does not match cols",
            });
        }
        if column_names.iter().any(|s| s.is_empty()) {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table column names cannot be empty",
            });
        }
        // Column-name uniqueness (case-insensitive).
        {

 succeeded in 0ms:
28://! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
2890:    /// Begin a multi-cell transaction. The returned `WorkbookTransaction`
2909:    /// Re-evaluate every formula in the workbook. Used after `load_workbook` to
2944:    /// Each keystroke can call `validate_formula(sheet, row, col, draft)`
2948:    pub fn validate_formula(
2999:    pub fn recompute_all(&mut self) -> RecomputeResult {
5375:    /// Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
5380:    fn validate_formula_returns_value_without_writing() {
5388:        let v = rt.validate_formula(0, 1, 0, "A1 * 5").unwrap();
5399:    /// `validate_formula` surfaces bind errors the same way `set_formula`
5402:    fn validate_formula_surfaces_bind_errors() {
5406:        let result = rt.validate_formula(0, 0, 0, "(1 + 2");
5412:    /// **W5-103 megaudit MEDIUM-3 closure (#129):** `validate_formula`
5419:    fn validate_formula_returns_anchor_value_for_top_level_array() {
5424:        let v = rt.validate_formula(0, 0, 0, "{1, 2, 3}").unwrap();
5428:            "validate_formula on array literal must give anchor value"
5431:        let v = rt.validate_formula(0, 0, 0, "{7; 8}").unwrap();
5434:        let v = rt.validate_formula(0, 0, 0, "{1, 2; 3, 4}").unwrap();
5441:    /// `validate_formula` does NOT pollute the bind-plan cache. A
5445:    fn validate_formula_does_not_pollute_plan_cache() {
5452:        let _ = rt.validate_formula(0, 1, 0, "A1 + 1").unwrap();
5453:        let _ = rt.validate_formula(0, 1, 0, "A1 + 2").unwrap();
5454:        let _ = rt.validate_formula(0, 1, 0, "A1 + 3").unwrap();

exec
/bin/zsh -lc "git show 8137697b5fc:./crates/ql-exec/src/workbook_runtime.rs | sed -n '3580,3665p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    /// with the same text) hits.
    ///
    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
    /// `recompute_dirty` path uses
    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
    /// session's aggregate cache through the evaluator.
    fn try_recompute_one_cached(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_aggregate_cache(
            sheet,
            row,
            col,
            formula_text,
            &crate::aggregate_cache::NoAggregateCache,
        )
    }

    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
    /// threads an `AggregateCache` through the scalar evaluator so
    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
    /// cache. Used by `recompute_dirty` which owns a session-side
    /// `InMemAggregateCache`.
    ///
    /// **W5-103 (#128):** also takes `row, col` so the spill-writeback
    /// branch inside `try_recompute_with_simd_profile` can materialize
    /// arrays at the correct anchor cell.
    fn try_recompute_with_aggregate_cache(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_simd_profile(sheet, row, col, formula_text, agg_cache)
            .map(|(v, _, _, _)| v)
    }

    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
    /// but ALSO returns a `bool` for whether the formula's bound plan
    /// was SIMD-eligible per `crate::lower::classify`. The bool is
    /// pure observability — the actual SIMD dispatch via `simd::*`
    /// happens at the bench / FormulaRegion path. `recompute_dirty`
    /// uses this to populate `RecomputeResult.simd_classified` so the
    /// IDE profile can show where region optimization would help.
    fn try_recompute_with_simd_profile(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
        let name_gen = self.workbook.names().generation();
        // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
        // is present in the stored formula text. This is the
        // recompute path — same canonical text at different cells
        // would otherwise share the cell-specific `@`-narrowed
        // plan from the first bind, leaking the wrong cell ref.
        let cell_anchor = if formula_text.contains('@') {
            Some((row, col))
        } else {
            None
        };
        let cache_key = PlanCacheKey {
            text: Arc::clone(formula_text),
            sheet,
            name_gen,
            cell_anchor,
        };
        // Borrow split: we need an immutable view of the workbook
        // (for `names()` inside the closure) while holding a mutable
        // borrow on `self.plan_cache`. Re-borrow the workbook reference
        // by name so Rust's borrow checker can split them — both fields
        // are disjoint subfields of `self`.
        let workbook: &Workbook = self.workbook;
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // **W5-147 (Phase 4.9.K):** formula_text here is the
                    // CANONICAL (A1+EnUs) text stored at set_formula

exec
/bin/zsh -lc "python3 - <<'PY'
from pathlib import Path
for path in sorted(Path('crates/ql-exec/src/workbook_runtime').glob('*.rs')):
    lines=path.read_text().splitlines()
    i=0
    while i<len(lines):
        if lines[i].lstrip().startswith('///'):
            start=i+1
            block=[]
            while i<len(lines) and lines[i].lstrip().startswith('///'):
                block.append(lines[i].strip().lstrip('/').strip())
                i+=1
            j=i
            while j<len(lines) and (not lines[j].strip() or lines[j].strip().startswith('#[') or lines[j].strip().startswith('//')):
                j+=1
            target=lines[j].strip() if j<len(lines) else '<eof>'
            if 'fn ' in target or target.startswith('pub struct') or target.startswith('pub enum') or target.startswith('pub(crate) fn') or target.startswith('pub fn') or target.startswith('struct '):
                first=next((b for b in block if b), '')
                print(f'{path}:{start}: -> {target[:100]} :: {first[:120]}')
            i=j
        else:
            i+=1
PY" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/cells.rs:43: -> pub fn set_formula( :: Set a cell to a formula. Pipeline: lex → parse → bind (against `sheet`) →
crates/ql-exec/src/workbook_runtime/cells.rs:450: -> fn reextract_spill_footprint_readers( :: **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** — re-extract
crates/ql-exec/src/workbook_runtime/cells.rs:600: -> pub(super) fn write_spill( :: **W5-103 (Phase 4.7.J.2 / 4.7.J.3)** — spill writeback path.
crates/ql-exec/src/workbook_runtime/cells.rs:744: -> fn write_anchor_error( :: **W5-103 megaudit LOW (Codex pass 2 finding):** anchor-error
crates/ql-exec/src/workbook_runtime/cells.rs:766: -> pub fn set_value( :: Set a cell to a literal value (no formula). Clears any existing formula
crates/ql-exec/src/workbook_runtime/cells.rs:960: -> pub fn clear_formula( :: Phase 2B.5 (2026-05-12): clear a cell's formula association through
crates/ql-exec/src/workbook_runtime/cells.rs:1219: -> fn set_formula_var_s_dotted_function_dispatches() { :: Phase 2A.5 (2026-05-12): `=VAR.S(1, 2, 3)` end-to-end — lexer accepts the
crates/ql-exec/src/workbook_runtime/cells.rs:1278: -> fn set_formula_rejects_invalid_sheet() { :: Phase 2A.6 audit H1/L4 (2026-05-12): invalid sheet ids surface as
crates/ql-exec/src/workbook_runtime/cells.rs:1296: -> fn set_formula_rejects_row_above_max() { :: Phase 2A.7 audit H1 (2026-05-12): out-of-grid row or col now surfaces as
crates/ql-exec/src/workbook_runtime/cells.rs:1522: -> fn set_formula_into_spill_target_emits_put_formula_op() { :: **W5-103 megaudit HIGH-3 closure** — oplog must record the
crates/ql-exec/src/workbook_runtime/cells.rs:1570: -> fn set_formula_array_reshape_records_one_op_per_call() { :: **W5-103 megaudit HIGH-3 closure** — re-setting an array formula
crates/ql-exec/src/workbook_runtime/cells.rs:1686: -> fn runtime_set_name_emits_op_into_attached_oplog() { :: OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
crates/ql-exec/src/workbook_runtime/cells.rs:1727: -> fn runtime_add_sheet_emits_op_into_attached_oplog() { :: OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
crates/ql-exec/src/workbook_runtime/cells.rs:1756: -> fn runtime_clear_formula_emits_atomic_pair_when_formula_present() { :: OPL-2B-01 (part 3): `WorkbookRuntime::clear_formula` records a
crates/ql-exec/src/workbook_runtime/cells.rs:1813: -> fn runtime_set_name_add_sheet_clear_formula_work_without_oplog() { :: OPL-2B-01 (regression): without an attached op log, the new
crates/ql-exec/src/workbook_runtime/cells.rs:1842: -> fn runtime_set_name_reserved_name_does_not_append_op() { :: OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
crates/ql-exec/src/workbook_runtime/cells.rs:1870: -> fn opl_2b_02_full_op_vocabulary_producer_replay_equivalence() { :: OPL-2B-02: producer/replay equivalence across the full op vocabulary
crates/ql-exec/src/workbook_runtime/cells.rs:2104: -> fn set_formula_array_literal_horizontal_spills_1x3() { :: Phase 4.7.J.2 — happy path: `={1,2,3}` at A1 spills 1×3 across
crates/ql-exec/src/workbook_runtime/cells.rs:2132: -> fn set_formula_array_literal_vertical_spills_3x1() { :: Phase 4.7.J.2 — happy path: `={1;2;3}` at A1 spills 3×1 down
crates/ql-exec/src/workbook_runtime/cells.rs:2151: -> fn set_formula_array_literal_2x2_spills() { :: Phase 4.7.J.2 — happy path: 2×2. `{1,2;3,4}` → A1=1, B1=2, A2=3, B2=4.
crates/ql-exec/src/workbook_runtime/cells.rs:2165: -> fn set_formula_array_shrinks_clears_old_footprint() { :: Phase 4.7.J.2 — clear-old: re-setting an array formula at the
crates/ql-exec/src/workbook_runtime/cells.rs:2202: -> fn set_formula_scalar_after_array_clears_spill_state() { :: Phase 4.7.J.2 — scalar-after-array: re-setting an anchor cell
crates/ql-exec/src/workbook_runtime/cells.rs:2221: -> fn set_formula_array_blocked_by_user_value_at_target() { :: Phase 4.7.J.2 — blocking: B1 has a user value `=5`. Setting
crates/ql-exec/src/workbook_runtime/cells.rs:2248: -> fn set_formula_array_blocked_by_formula_at_target() { :: Phase 4.7.J.2 — blocking: B1 has its own formula (computed
crates/ql-exec/src/workbook_runtime/cells.rs:2273: -> fn set_formula_array_out_of_bounds_returns_spill() { :: Phase 4.7.J.2 — out-of-bounds spill: anchor at MAX_ROW with a
crates/ql-exec/src/workbook_runtime/cells.rs:2293: -> fn set_formula_array_writeback_fires_on_set_value_for_each_target() { :: Phase 4.7.J.3 — happy path: writeback fires `on_set_value` once
crates/ql-exec/src/workbook_runtime/cells.rs:2318: -> fn set_formula_array_2x2_fires_three_on_set_value() { :: Phase 4.7.J.3 — 2x2 spill fires `on_set_value` three times
crates/ql-exec/src/workbook_runtime/cells.rs:2337: -> fn set_formula_dissolving_spill_dirties_old_target_readers() { :: Phase 4.7.J.3 — pre-existing reader of an OLD target dirties
crates/ql-exec/src/workbook_runtime/cells.rs:2376: -> fn set_formula_array_reshape_fires_on_set_value_for_union() { :: Phase 4.7.J.3 — a re-spill of DIFFERENT shape fires
crates/ql-exec/src/workbook_runtime/cells.rs:2407: -> fn set_formula_blocked_spill_does_not_fire_target_hooks() { :: Phase 4.7.J.3 — blocked spill DOES NOT fire `on_set_value` at
crates/ql-exec/src/workbook_runtime/cells.rs:2439: -> fn set_formula_array_same_formula_twice_is_stable() { :: Phase 4.7.J.2 — clear-old idempotency: setting the SAME array
crates/ql-exec/src/workbook_runtime/cells.rs:2469: -> fn set_formula_reextract_aliases_pre_existing_reader_to_anchor() { :: Phase 4.7.J.4 — the canonical HIGH-1 scenario:
crates/ql-exec/src/workbook_runtime/cells.rs:2517: -> fn set_formula_reextract_unroutes_alias_after_spill_dissolves() { :: Phase 4.7.J.4 — dissolution case: a reader bound AFTER the spill
crates/ql-exec/src/workbook_runtime/cells.rs:2553: -> fn set_formula_reextract_dedupes_across_old_and_new_footprint() { :: Phase 4.7.J.4 — dedupe across the union: a reader at (0,0,4)
crates/ql-exec/src/workbook_runtime/cells.rs:2589: -> fn set_formula_reextract_skipped_on_blocked_spill_with_no_old_footprint() { :: Phase 4.7.J.4 — blocked spill case: when a writeback returns
crates/ql-exec/src/workbook_runtime/cells.rs:2625: -> fn set_formula_at_spill_target_dissolves_host_spill() { :: Phase 4.7.J.5 — happy path: A1 anchors a 1×3 spill (A1, B1, C1).
crates/ql-exec/src/workbook_runtime/cells.rs:2665: -> fn set_formula_at_anchor_does_not_double_clear_spill() { :: Phase 4.7.J.5 — anchor cell is NOT treated as a "target" by the
crates/ql-exec/src/workbook_runtime/cells.rs:2696: -> fn set_formula_array_at_spill_target_dissolves_then_spills() { :: Phase 4.7.J.5 — array formula INTO a spill target also dissolves
crates/ql-exec/src/workbook_runtime/cells.rs:2725: -> fn set_formula_at_non_spill_target_unchanged_behavior() { :: Phase 4.7.J.5 — non-target write is unaffected by the
crates/ql-exec/src/workbook_runtime/cells.rs:2763: -> fn set_formula_into_host_target_reextracts_aliased_readers() { :: Host A1 spills A1..C1. Reader D1 = C1 (aliased to A1 by 4.7.I).
crates/ql-exec/src/workbook_runtime/cells.rs:2801: -> fn set_formula_into_host_target_marks_host_anchor_dirty() { :: Host A1 spills A1..C1. User sets B1 = 5 — J.5 dissolves A1.
crates/ql-exec/src/workbook_runtime/cells.rs:2831: -> fn set_formula_into_host_target_dirties_readers_of_other_host_targets() { :: Host A1 spills A1..C1. Reader X1 = B1 (also aliased to A1).
crates/ql-exec/src/workbook_runtime/cells.rs:2882: -> fn clear_formula_at_spill_anchor_dissolves_spill() { :: Closes the design § 10.3 gap: clear_formula at A1 (spill anchor)
crates/ql-exec/src/workbook_runtime/cells.rs:2942: -> fn clear_formula_at_non_anchor_cell_unchanged_behavior() { :: Clear at a non-anchor cell (no spill anchored there) — original
crates/ql-exec/src/workbook_runtime/cells.rs:2972: -> fn clear_formula_at_spill_anchor_emits_only_clear_formula_op() { :: **Sonnet megaudit follow-up** — clear_formula at a spill anchor
crates/ql-exec/src/workbook_runtime/cells.rs:3008: -> fn clear_formula_at_spill_anchor_fires_on_set_value_for_targets() { :: Closes design § 10.3 dirty-propagation: clear_formula at an
crates/ql-exec/src/workbook_runtime/cells.rs:3036: -> fn clear_formula_at_spill_anchor_reextracts_aliased_readers() { :: **W5-108 (Phase 4.7.O) — Codex HIGH BLOCKER closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3094: -> fn recompute_all_materializes_spill_for_array_formula() { :: HIGH-2 acceptance: op-log replay of `PutFormula { text:
crates/ql-exec/src/workbook_runtime/cells.rs:3127: -> fn recompute_all_scalar_formula_unchanged() { :: recompute_all on a SCALAR formula keeps its existing behavior
crates/ql-exec/src/workbook_runtime/cells.rs:3147: -> fn recompute_all_out_of_bounds_spill_writes_spill_error() { :: recompute_all on an array formula that would spill out of
crates/ql-exec/src/workbook_runtime/cells.rs:3168: -> fn recompute_all_array_formula_idempotent_across_two_passes() { :: Re-run of recompute_all on an already-spilled formula must
crates/ql-exec/src/workbook_runtime/cells.rs:3196: -> fn set_value_at_spill_target_dissolves_host_spill() { :: set_value at a spill TARGET cell dissolves the host spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3220: -> fn set_value_at_spill_anchor_dissolves_own_spill() { :: set_value at a spill ANCHOR cell dissolves its own spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3244: -> fn set_value_at_non_spill_cell_unchanged() { :: Negative control: set_value at a cell that isn't part of any
crates/ql-exec/src/workbook_runtime/cells.rs:3268: -> fn set_value_at_spill_target_marks_host_anchor_dirty() { :: set_value at spill target marks the host anchor's NodeId dirty
crates/ql-exec/src/workbook_runtime/cells.rs:3293: -> fn set_value_at_spill_target_reextracts_aliased_readers() { :: set_value at spill target re-extracts readers aliased to the
crates/ql-exec/src/workbook_runtime/cells.rs:3331: -> fn set_value_over_spill_anchor_formula_emits_batch_commit() { :: set_value over an existing formula at a spill anchor — fires
crates/ql-exec/src/workbook_runtime/cells.rs:3358: -> fn set_formula_sequence_rows_only_spills_vertically() { :: `=SEQUENCE(3)` at A1 spills 3×1 vertically (A1, A2, A3).
crates/ql-exec/src/workbook_runtime/cells.rs:3377: -> fn set_formula_sequence_rows_cols_spills_2d() { :: `=SEQUENCE(2, 3)` at A1 spills 2×3 (A1..C2).
crates/ql-exec/src/workbook_runtime/cells.rs:3400: -> fn set_formula_sequence_zero_rows_produces_num_error() { :: `=SEQUENCE(0)` → scalar `#NUM!` per design § 13.1 (W5-108 /
crates/ql-exec/src/workbook_runtime/cells.rs:3415: -> fn recompute_all_materializes_sequence_spill() { :: `=SEQUENCE(3)` after replay + recompute_all re-derives the spill.
crates/ql-exec/src/workbook_runtime/cells.rs:3438: -> fn set_formula_sequence_inside_binary_op_produces_calc_error() { :: `=SEQUENCE(3) + 1` (scalar context, not at cell boundary) → #CALC!
crates/ql-exec/src/workbook_runtime/cells.rs:3455: -> fn set_formula_transpose_row_literal_spills_as_column() { :: `=TRANSPOSE({1, 2, 3})` at A1 spills 3×1 vertically.
crates/ql-exec/src/workbook_runtime/cells.rs:3472: -> fn set_formula_transpose_column_literal_spills_as_row() { :: `=TRANSPOSE({1; 2; 3})` at A1 spills 1×3 horizontally.
crates/ql-exec/src/workbook_runtime/cells.rs:3489: -> fn set_formula_transpose_2x2() { :: `=TRANSPOSE({1, 2; 3, 4})` swaps a 2×2 matrix's off-diagonal.
crates/ql-exec/src/workbook_runtime/cells.rs:3509: -> fn set_formula_transpose_of_sequence_in_arg_position_is_calc_error() { :: TRANSPOSE composed with SEQUENCE: `=TRANSPOSE(SEQUENCE(3))` —
crates/ql-exec/src/workbook_runtime/cells.rs:3529: -> fn set_formula_filter_of_sequence_in_arg_position_is_calc_error() { :: **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3548: -> fn set_formula_sequence_of_sequence_in_arg_position_is_error() { :: **W5-108 (Phase 4.7.O) — Sonnet L1 / Codex L1 closure**:
crates/ql-exec/src/workbook_runtime/cells.rs:3573: -> fn set_formula_filter_row_keeps_truthy() { :: `=FILTER({1,2,3,4}, {TRUE,FALSE,TRUE,FALSE})` spills 1×2 with
crates/ql-exec/src/workbook_runtime/cells.rs:3591: -> fn set_formula_filter_column_keeps_truthy() { :: `=FILTER({1;2;3;4}, {TRUE;FALSE;TRUE;FALSE})` spills 2×1
crates/ql-exec/src/workbook_runtime/cells.rs:3609: -> fn set_formula_filter_all_false_no_if_empty_produces_calc() { :: `=FILTER({1,2,3}, {FALSE,FALSE,FALSE})` with no if_empty →
crates/ql-exec/src/workbook_runtime/cells.rs:3624: -> fn set_formula_filter_all_false_with_if_empty_spills_singleton() { :: `=FILTER({1,2,3}, {FALSE,FALSE,FALSE}, "none")` with if_empty
crates/ql-exec/src/workbook_runtime/cells.rs:3651: -> fn set_formula_transpose_with_named_range_arg_binds_and_spills() { :: Codex HIGH closure: `=TRANSPOSE(MyRange)` with `MyRange` a named
crates/ql-exec/src/workbook_runtime/cells.rs:3688: -> fn set_formula_filter_with_named_range_args_binds_and_spills() { :: Codex HIGH closure: `=FILTER(Data, Mask)` with both args as named
crates/ql-exec/src/workbook_runtime/cells.rs:3729: -> fn recompute_dirty_transpose_with_named_range_updates_on_value_change() { :: Sonnet LOW closure: TRANSPOSE referencing live cells via a named
crates/ql-exec/src/workbook_runtime/cells.rs:3779: -> fn recompute_dirty_filter_with_named_ranges_grows_footprint() { :: Sonnet MEDIUM closure: FILTER shape transition through
crates/ql-exec/src/workbook_runtime/cells.rs:3855: -> fn recompute_dirty_sequence_grows_footprint() { :: Shape transition through recompute_dirty: A1 = 3, B1 = SEQUENCE(A1)
crates/ql-exec/src/workbook_runtime/cells.rs:3894: -> fn recompute_dirty_sequence_shrinks_footprint() { :: Shape transition shrinkage: A1 = 5, B1 = SEQUENCE(A1) (5x1).
crates/ql-exec/src/workbook_runtime/cells.rs:3930: -> fn recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged() { :: **Codex audit HIGH-1**: aliased readers don't re-eval when
crates/ql-exec/src/workbook_runtime/cells.rs:3976: -> fn recompute_dirty_dissolution_reextracts_aliased_readers() { :: **Codex audit HIGH-2**: after recompute-time spill dissolution,
crates/ql-exec/src/workbook_runtime/cells.rs:4039: -> fn recompute_dirty_sequence_grows_dirties_new_target_readers() { :: **#136 closure**: A1 = 3, B1 = SEQUENCE(A1) (spills B1..B3),
crates/ql-exec/src/workbook_runtime/cells.rs:4416: -> fn drop_table_fires_on_table_drop_hook_and_emits_name_error() { :: **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
crates/ql-exec/src/workbook_runtime/cells.rs:4490: -> fn drop_table_propagates_name_error_through_chain() { :: **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):** transitive BFS
crates/ql-exec/src/workbook_runtime/cells.rs:4551: -> fn mixed_relativity_r1c1_range_rejected_at_set_formula() { :: **Mixed-relativity R1C1 range REJECTED at parse time.**
crates/ql-exec/src/workbook_runtime/cells.rs:4565: -> fn structured_ref_at_inside_vs_outside_brackets_eval_identically() { :: **`Sales[@Col]` vs `@Sales[Qty]` AST disambiguation.**
crates/ql-exec/src/workbook_runtime/cells.rs:4614: -> fn at_whole_column_evals_to_anchor_row() { :: **`@A:A` (whole-column inside `@`) evals at formula's row.**
crates/ql-exec/src/workbook_runtime/cells.rs:4630: -> fn at_whole_row_evals_to_anchor_col() { :: **`@1:1` (whole-row inside `@`) evals at formula's col.**
crates/ql-exec/src/workbook_runtime/cells.rs:4645: -> fn sheet_qualified_at_ref_resolves_correctly() { :: **`Sheet1!@A1` resolves with sheet prefix + `@` wrapping.**
crates/ql-exec/src/workbook_runtime/cells.rs:4664: -> fn r1c1_input_round_trips_through_oplog_replay() { :: **R1C1 input + EN locale + same anchor → A1 canonical
crates/ql-exec/src/workbook_runtime/cells.rs:4721: -> fn de_locale_input_round_trips_through_oplog_replay() { :: **DE locale input round-trips through oplog replay.**
crates/ql-exec/src/workbook_runtime/cells.rs:4747: -> fn at_operator_round_trips_through_oplog_replay() { :: **`@` survives op-log replay.** `@A1` in producer → `@A1` in
crates/ql-exec/src/workbook_runtime/cells.rs:4776: -> fn reference_mode_change_leaves_stored_formula_text_canonical() { :: **Switching reference_mode does NOT mutate stored formula
crates/ql-exec/src/workbook_runtime/cells.rs:4803: -> fn locale_change_leaves_stored_formula_text_canonical() { :: **DE locale change does NOT mutate stored formula text.**
crates/ql-exec/src/workbook_runtime/cells.rs:4824: -> fn at_scalar_idempotent_through_eval() { :: **`@scalar` is idempotent: `@5` evaluates to `5`.**
crates/ql-exec/src/workbook_runtime/cells.rs:4835: -> fn at_function_with_scalar_return_passes_through() { :: **`@SUM(scalar args)` evaluates identically to `SUM(scalar args)`.**
crates/ql-exec/src/workbook_runtime/cells.rs:4874: -> struct MatrixCell { :: **Coverage matrix cell.** Anchor is always `(0, 0, 0)` so the
crates/ql-exec/src/workbook_runtime/cells.rs:4883: -> fn coverage_matrix() -> Vec<MatrixCell> { :: Build the full 30-cell matrix.
crates/ql-exec/src/workbook_runtime/cells.rs:5025: -> fn coverage_matrix_mode_locale_at_presence_30_cells() { :: **Coverage matrix driver.** Walks all 30 cells; for each,
crates/ql-exec/src/workbook_runtime/cells.rs:5063: -> fn coverage_matrix_has_no_duplicates() { :: **Coverage matrix has no duplicate cells.** Every
crates/ql-exec/src/workbook_runtime/cells.rs:5077: -> fn plan_cache_at_range_collision_across_cells_regression() { :: **4.9.O audit verification:** plan cache collision when
crates/ql-exec/src/workbook_runtime/cells.rs:5115: -> fn coverage_matrix_dimension_counts() { :: **Coverage matrix axis dimensions.** Sanity-pin that the
crates/ql-exec/src/workbook_runtime/config.rs:20: -> pub fn set_reference_mode( :: **W5-146 (Phase 4.9.K):** set the workbook's reference mode
crates/ql-exec/src/workbook_runtime/config.rs:46: -> pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> { :: **W5-146 (Phase 4.9.K):** set the workbook's locale (EnUs /
crates/ql-exec/src/workbook_runtime/error.rs:23: -> pub enum RuntimeError { :: Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
crates/ql-exec/src/workbook_runtime/error.rs:183: -> pub struct RecomputeFailure { :: Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:209: -> pub struct RecomputeResult { :: Aggregate outcome of `WorkbookRuntime::recompute_all`.
crates/ql-exec/src/workbook_runtime/error.rs:273: -> pub fn is_complete(&self) -> bool { :: True iff every formula recomputed without a structural failure.
crates/ql-exec/src/workbook_runtime/error.rs:278: -> pub fn failed_count(&self) -> usize { :: Number of structural failures (lex/parse/bind). Excludes evaluation
crates/ql-exec/src/workbook_runtime/formats.rs:29: -> pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> { :: **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
crates/ql-exec/src/workbook_runtime/formats.rs:66: -> pub fn set_cell_format( :: **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
crates/ql-exec/src/workbook_runtime/formats.rs:116: -> pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String { :: **W5-82 (Phase 4.5.D part 6):** read a cell and render it through
crates/ql-exec/src/workbook_runtime/mod.rs:103: -> pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> { :: Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
crates/ql-exec/src/workbook_runtime/mod.rs:118: -> pub(crate) fn validate_cell( :: Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
crates/ql-exec/src/workbook_runtime/mod.rs:160: -> pub struct WorkbookRuntime<'a> { :: Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
crates/ql-exec/src/workbook_runtime/mod.rs:210: -> pub fn with_oplog( :: Phase 2A.3.b: construct a runtime that records every mutation to the
crates/ql-exec/src/workbook_runtime/mod.rs:234: -> pub fn with_graph( :: Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
crates/ql-exec/src/workbook_runtime/mod.rs:256: -> pub fn with_oplog_and_graph( :: Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
crates/ql-exec/src/workbook_runtime/mod.rs:278: -> pub fn cache_stats(&self) -> PlanCacheStats { :: Phase 2B.3: snapshot of cumulative bind-plan-cache observability
crates/ql-exec/src/workbook_runtime/names.rs:26: -> pub fn set_name( :: Phase 2B.5 (2026-05-12): register a defined name through the runtime,
crates/ql-exec/src/workbook_runtime/names.rs:81: -> pub fn set_sheet_scoped_name( :: **W5-92 (Phase 4.6.D):** register a sheet-scoped defined name
crates/ql-exec/src/workbook_runtime/names.rs:160: -> fn make_runtime_workbook() -> Workbook { :: Tier D1 Step 4: shared with the appended Phase 2A.1 named-
crates/ql-exec/src/workbook_runtime/names.rs:381: -> fn runtime_error_bind_display_is_human_readable() { :: Phase 2A.11 audit M16: error Display strings are human-readable, not
crates/ql-exec/src/workbook_runtime/names.rs:431: -> fn set_formula_named_range_in_scalar_context_errors() { :: Phase 2B.4 (2026-05-12): named range in a bare scalar position now
crates/ql-exec/src/workbook_runtime/recompute.rs:196: -> pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> { :: **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
crates/ql-exec/src/workbook_runtime/recompute.rs:615: -> fn try_recompute_one_cached( :: Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
crates/ql-exec/src/workbook_runtime/recompute.rs:642: -> fn try_recompute_with_aggregate_cache( :: Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
crates/ql-exec/src/workbook_runtime/recompute.rs:663: -> fn try_recompute_with_simd_profile( :: Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
crates/ql-exec/src/workbook_runtime/recompute.rs:905: -> fn save_load_recompute_e2e() { :: End-to-end: save a workbook with formulas, load it, recompute, verify the
crates/ql-exec/src/workbook_runtime/recompute.rs:964: -> fn recompute_all_emits_circ_for_self_referential_a1_plus_one() { :: `recompute_all` (no session attached — the `.qbook` load / replay
crates/ql-exec/src/workbook_runtime/recompute.rs:992: -> fn recompute_all_emits_circ_for_two_cycle_a1_b1() { :: 2-cycle: A1 = B1 + 1, B1 = A1 - 1. Both cells in the SCC must
crates/ql-exec/src/workbook_runtime/recompute.rs:1021: -> fn recompute_all_isolates_cycle_from_acyclic_formulas() { :: Acyclic mix with a cycle: A1 = 5, B1 = A1 * 2, C1 = C1 + 1
crates/ql-exec/src/workbook_runtime/recompute.rs:1050: -> fn recompute_all_repeated_calls_are_idempotent_on_cycle() { :: Cycle value must be stable across repeated `recompute_all`
crates/ql-exec/src/workbook_runtime/recompute.rs:1071: -> fn recompute_all_dependent_of_cycle_propagates_circ_error() { :: **Tier C1 audit Codex H-1 closure:** a non-cycled dependent
crates/ql-exec/src/workbook_runtime/recompute.rs:1107: -> fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() { :: **Tier C1 audit Codex H-2 closure:** if a previously-spilling
crates/ql-exec/src/workbook_runtime/recompute.rs:1179: -> fn recompute_all_failure_carries_exact_cell_and_formula_text() { :: R2B-01: a structural failure surfaces with the exact cell address +
crates/ql-exec/src/workbook_runtime/recompute.rs:1209: -> fn recompute_all_does_not_short_circuit_on_first_failure() { :: R2B-02: a failure does not short-circuit. Cells whose formulas DO
crates/ql-exec/src/workbook_runtime/recompute.rs:1244: -> fn recompute_all_does_not_panic_on_invalid_persisted_formulas() { :: R2B-03: invalid persisted formulas do NOT panic the runtime. Every
crates/ql-exec/src/workbook_runtime/recompute.rs:1265: -> fn recompute_all_eval_time_error_values_count_as_succeeded() { :: Evaluation-time errors (Value::Error variants like #DIV/0!) count as
crates/ql-exec/src/workbook_runtime/recompute.rs:1288: -> fn recompute_all_failed_cells_preserve_prior_state() { :: Failed cells keep their pre-recompute values; their formula text is
crates/ql-exec/src/workbook_runtime/recompute.rs:1311: -> fn recompute_all_second_pass_is_all_cache_hits() { :: BPC-01: repeated `recompute_all` against the same workbook does NOT
crates/ql-exec/src/workbook_runtime/recompute.rs:1342: -> fn name_table_mutation_invalidates_bind_plan_cache() { :: BPC-02: a NameTable mutation between recompute_all calls invalidates
crates/ql-exec/src/workbook_runtime/recompute.rs:1400: -> fn cache_keys_are_stable_across_recompute_passes() { :: BPC-03: cache keys are stable across recompute_all calls — same
crates/ql-exec/src/workbook_runtime/recompute.rs:1423: -> fn cache_stats_flow_into_timings_struct() { :: BPC-04: cache hit/miss counters are visible (via `cache_stats()`)
crates/ql-exec/src/workbook_runtime/recompute.rs:1448: -> fn set_formula_populates_cache_for_subsequent_recompute() { :: `set_formula` pre-warms the cache. A subsequent `recompute_all`
crates/ql-exec/src/workbook_runtime/recompute.rs:1473: -> fn nag_01_named_constants_still_work_in_scalar_and_aggregate_contexts() { :: NAG-01: named CONSTANTS continue to work after the binder grows
crates/ql-exec/src/workbook_runtime/recompute.rs:1501: -> fn nag_02_named_cell_references_still_work() { :: NAG-02: named CELL REFERENCES continue to work after the binder
crates/ql-exec/src/workbook_runtime/recompute.rs:1524: -> fn nag_03_named_range_in_aggregate_function_binds_to_explicit_variant() { :: NAG-03: a named RANGE inside an aggregate function binds to the
crates/ql-exec/src/workbook_runtime/recompute.rs:1551: -> fn nag_04_named_range_in_scalar_positions_errors_precisely() { :: NAG-04: a named RANGE in scalar context produces the precise
crates/ql-exec/src/workbook_runtime/recompute.rs:1590: -> fn named_formula_surfaces_distinct_bind_error() { :: Named formulas (NamedTarget::Formula) surface a distinct
crates/ql-exec/src/workbook_runtime/recompute.rs:1616: -> fn runtime_mutations_fire_calcgraph_hooks() { :: G3-02 / hook-coverage test: each runtime mutation calls the
crates/ql-exec/src/workbook_runtime/recompute.rs:1659: -> fn rebuild_then_edit_keeps_cell_index_in_sync() { :: G3-01 + integration: rebuild a graph from an existing workbook,
crates/ql-exec/src/workbook_runtime/recompute.rs:1701: -> fn runtime_without_graph_works_as_before() { :: Without an attached graph, the runtime behaves identically to
crates/ql-exec/src/workbook_runtime/recompute.rs:1714: -> fn runtime_with_oplog_and_graph_drives_both() { :: Combined `with_oplog_and_graph` constructor: both op log AND
crates/ql-exec/src/workbook_runtime/recompute.rs:1746: -> fn recompute_dirty_returns_none_when_no_graph_attached() { :: Phase 3.4: with no graph attached, `recompute_dirty` returns
crates/ql-exec/src/workbook_runtime/recompute.rs:1757: -> fn recompute_dirty_cascades_dependency_chain() { :: SCH-3-01 end-to-end: edit a chain head, recompute_dirty
crates/ql-exec/src/workbook_runtime/recompute.rs:1799: -> fn recompute_dirty_writes_circ_error_for_cycle_members() { :: SCH-3-02 end-to-end: cycles get `#CIRC!`. Build A1 = B1 + 1
crates/ql-exec/src/workbook_runtime/recompute.rs:1851: -> fn recompute_dirty_skips_unrelated_formulas() { :: SCH-3-04 end-to-end: an edit to A1 cascades through its
crates/ql-exec/src/workbook_runtime/recompute.rs:1898: -> fn ovr_3_01_set_formula_writes_to_computed_overlay_not_user() { :: OVR-3-01: `set_formula` writes the evaluated value to the COMPUTED
crates/ql-exec/src/workbook_runtime/recompute.rs:1930: -> fn ovr_3_02_typing_over_formula_clears_formula_and_computed() { :: OVR-3-02: typing a literal value over a formula cell clears both
crates/ql-exec/src/workbook_runtime/recompute.rs:1961: -> fn ovr_3_02b_clear_formula_promotes_value_to_user_lane() { :: OVR-3-02 sister: explicit `clear_formula` (Excel "strip formula,
crates/ql-exec/src/workbook_runtime/recompute.rs:1986: -> fn ovr_3_03_save_load_preserves_layer() { :: OVR-3-03: save+load round-trip preserves lane assignment. A
crates/ql-exec/src/workbook_runtime/recompute.rs:2032: -> fn ovr_3_04_read_cascade_consistent_across_lane_types() { :: OVR-3-04: reads through the cascade see the right value in every
crates/ql-exec/src/workbook_runtime/recompute.rs:2073: -> fn build_aggregate_workbook(size: u32) -> (Workbook, crate::CalcgraphSession) { :: Helper: build a workbook with a named range `BigRange` over A1:A`size`
crates/ql-exec/src/workbook_runtime/recompute.rs:2095: -> fn agg_3_04_results_match_scalar_baseline() { :: AGG-3-04 (correctness baseline): SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT
crates/ql-exec/src/workbook_runtime/recompute.rs:2138: -> fn agg_3_01_no_rescan_on_unrelated_writes() { :: AGG-3-01: `SUM(BigRange)` does NOT rescan the range on an unrelated
crates/ql-exec/src/workbook_runtime/recompute.rs:2186: -> fn agg_3_02_intersecting_write_invalidates_cache() { :: AGG-3-02: a write INSIDE BigRange invalidates the cache. After the
crates/ql-exec/src/workbook_runtime/recompute.rs:2218: -> fn agg_3_03_full_column_aggregate_remains_compressed() { :: AGG-3-03: full-column aggregate remains compressed. We register a
crates/ql-exec/src/workbook_runtime/recompute.rs:2265: -> fn vol_3_03_seeded_rng_produces_deterministic_rand_sequence() { :: VOL-3-03: deterministic RNG test fixture exists. The
crates/ql-exec/src/workbook_runtime/recompute.rs:2290: -> fn vol_3_01_volatile_formulas_recompute_when_requested() { :: VOL-3-01: marking volatile dirty + recompute_dirty re-evaluates
crates/ql-exec/src/workbook_runtime/recompute.rs:2319: -> fn vol_3_02_nonvolatile_dependents_update_when_volatile_changes() { :: VOL-3-02: a non-volatile formula `=A1 + 1` (where A1 = RAND())
crates/ql-exec/src/workbook_runtime/recompute.rs:2365: -> fn veq_3_01_unchanged_upstream_suppresses_downstream_recompute() { :: VEQ-3-01: when an upstream's recomputed value equals its prior
crates/ql-exec/src/workbook_runtime/recompute.rs:2416: -> fn veq_3_02_error_equality_suppresses_downstream() { :: VEQ-3-02: error equality is correct. A formula that re-evaluates
crates/ql-exec/src/workbook_runtime/recompute.rs:2463: -> fn veq_3_03_profile_records_skipped_vertices() { :: VEQ-3-03: the `skipped_value_equality` counter on
crates/ql-exec/src/workbook_runtime/recompute.rs:2511: -> fn veq_does_not_skip_volatile_formulas() { :: VEQ regression: a volatile formula (RAND) is NEVER skipped on
crates/ql-exec/src/workbook_runtime/recompute.rs:2541: -> fn simd_3_01_og02_pattern_classifies_to_mul_scalar() { :: SIMD-3-01: the bench-side multiversion-clone path (the OG-02
crates/ql-exec/src/workbook_runtime/recompute.rs:2568: -> fn simd_3_02_division_falls_back_to_scalar() { :: SIMD-3-02: scalar fallback for division. `lower::classify`
crates/ql-exec/src/workbook_runtime/recompute.rs:2598: -> fn simd_3_03_profile_records_simd_eligible_formulas() { :: SIMD-3-03: graph profile shows region execution.
crates/ql-exec/src/workbook_runtime/recompute.rs:2662: -> fn w5_53_sumif_named_range_numeric_criteria() { :: SUMIF over a named range with numeric criteria.
crates/ql-exec/src/workbook_runtime/recompute.rs:2683: -> fn w5_53_sumif_comparator_criteria() { :: SUMIF with a comparator criteria string.
crates/ql-exec/src/workbook_runtime/recompute.rs:2702: -> fn w5_53_countif_named_range() { :: COUNTIF over a named range. `=COUNTIF(Sales, ">=5")` → 4 cells.
crates/ql-exec/src/workbook_runtime/recompute.rs:2721: -> fn w5_53_sumif_with_separate_sum_range() { :: SUMIF with a 3-arg call: separate `sum_range`. Criteria range
crates/ql-exec/src/workbook_runtime/recompute.rs:2755: -> fn w5_53_sumif_recomputes_on_range_cell_change() { :: SUMIF interacts correctly with the recompute path (Phase 3.6
crates/ql-exec/src/workbook_runtime/recompute.rs:2795: -> fn w5_54_vlookup_exact_match_e2e() { :: VLOOKUP with exact match against a 2-column table.
crates/ql-exec/src/workbook_runtime/recompute.rs:2824: -> fn w5_54_vlookup_approximate_match_e2e() { :: VLOOKUP with approximate match (default range_lookup=TRUE) on
crates/ql-exec/src/workbook_runtime/recompute.rs:2855: -> fn w5_54_hlookup_exact_match_e2e() { :: HLOOKUP with exact match on a 2-row × 3-col table.
crates/ql-exec/src/workbook_runtime/recompute.rs:2881: -> fn w5_54_index_match_pattern_e2e() { :: MATCH exact + INDEX combination — the canonical replacement
crates/ql-exec/src/workbook_runtime/recompute.rs:2918: -> fn w5_54_choose_e2e() { :: CHOOSE picks from scalar args.
crates/ql-exec/src/workbook_runtime/recompute.rs:2931: -> fn w5_54_vlookup_not_found_returns_na_e2e() { :: VLOOKUP not-found returns #N/A. Verifies the error
crates/ql-exec/src/workbook_runtime/recompute.rs:2961: -> fn w5_55_averageif_e2e() { :: AVERAGEIF: range [1, 2, 3, 4, 5], criteria ">2" → matches 3, 4,
crates/ql-exec/src/workbook_runtime/recompute.rs:2981: -> fn w5_55_sumifs_two_conditions_e2e() { :: SUMIFS: two label columns + value column. Sum of values where
crates/ql-exec/src/workbook_runtime/recompute.rs:3023: -> fn w5_55_countifs_single_condition_e2e() { :: COUNTIFS: same shape, count where labels1="a".
crates/ql-exec/src/workbook_runtime/recompute.rs:3043: -> fn w5_55_sumproduct_two_columns_e2e() { :: SUMPRODUCT: dot-product of two columns.
crates/ql-exec/src/workbook_runtime/recompute.rs:3071: -> fn w5_55_averageifs_e2e() { :: AVERAGEIFS with two conditions.
crates/ql-exec/src/workbook_runtime/recompute.rs:3112: -> fn mark_volatile_dirty_zero_when_no_volatile_formulas() { :: Phase 3.7 extra: `mark_volatile_dirty` on a workbook with zero
crates/ql-exec/src/workbook_runtime/recompute.rs:3129: -> fn recompute_dirty_twice_in_a_row_is_idempotent() { :: Phase 3.4: empty dirty (e.g. recompute_dirty called twice in a
crates/ql-exec/src/workbook_runtime/sheets.rs:24: -> fn rewrite_formula_text_for_sheet_rename( :: **W5-91 (Phase 4.6.C):** rewrite cross-sheet refs in a formula text
crates/ql-exec/src/workbook_runtime/sheets.rs:63: -> pub fn add_sheet( :: **W5-92 (Phase 4.6.D):** create a new sheet,
crates/ql-exec/src/workbook_runtime/sheets.rs:124: -> pub fn rename_sheet( :: **W5-91 (Phase 4.6.C):** rename a sheet by id. Walks every
crates/ql-exec/src/workbook_runtime/tables.rs:40: -> pub fn create_table( :: **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
crates/ql-exec/src/workbook_runtime/tables.rs:203: -> pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> { :: **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
crates/ql-exec/src/workbook_runtime/tables.rs:259: -> pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> { :: **W5-119 (Phase 4.8.I):** rename a table. Per design § 12.2 + HIGH-1
crates/ql-exec/src/workbook_runtime/tables.rs:379: -> pub fn rename_column( :: **W5-121 (Phase 4.8.I.2):** rename a column within an existing
crates/ql-exec/src/workbook_runtime/tables.rs:527: -> pub fn resize_table( :: **W5-122 (Phase 4.8.J):** resize a table's footprint per
crates/ql-exec/src/workbook_runtime/tables.rs:779: -> fn reextract_table_readers(&mut self, table_canonical: &str) { :: **W5-159 (Phase 4.8.G.3):** re-bind every formula registered
crates/ql-exec/src/workbook_runtime/tables.rs:878: -> fn structured_ref_sum_qty_column_works_end_to_end() { :: **First end-to-end test for Phase 4.8 structured refs.** Set up a
crates/ql-exec/src/workbook_runtime/tables.rs:931: -> fn structured_ref_at_column_narrows_to_current_row() { :: **Phase 4.8.G.2 e2e:** `[@Qty]` shorthand inside a table data
crates/ql-exec/src/workbook_runtime/tables.rs:984: -> fn structured_ref_at_column_outside_table_returns_value_error() { :: **Phase 4.8.G.2 e2e:** `[@Qty]` typed OUTSIDE the table's data
crates/ql-exec/src/workbook_runtime/tables.rs:1159: -> fn rename_table_then_drop_new_name_emits_name_error() { :: **W5-157 (Phase 4.8.G.3):** `rename_table` fires
crates/ql-exec/src/workbook_runtime/tables.rs:1519: -> fn rename_column_fires_hook_and_keeps_value_consistent() { :: **W5-158 (Phase 4.8.G.3):** `rename_column` fires the
crates/ql-exec/src/workbook_runtime/tables.rs:1617: -> fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() { :: **W5-159 (Phase 4.8.G.3):** the correctness bug the hook +
crates/ql-exec/src/workbook_runtime/tables.rs:1791: -> fn resize_table_remove_referenced_column_emits_name_error() { :: **W5-159 / W5-156 (Phase 4.8.G.3 — Codex closing-megaudit LOW
crates/ql-exec/src/workbook_runtime/tables.rs:2020: -> fn resize_table_exact_noop_emits_nothing() { :: **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op resize
crates/ql-exec/src/workbook_runtime/tables.rs:2059: -> fn create_table_then_sum_column_works() { :: **End-to-end with op log**: create_table emits Op::CreateTable;
crates/ql-exec/src/workbook_runtime/tables.rs:2077: -> fn structured_ref_average_qty_column_works_end_to_end() { :: AVERAGE through the same path — confirms the cache fast path
crates/ql-exec/src/workbook_runtime/tables.rs:2118: -> fn set_formula_canonicalizes_r1c1_input_to_a1() { :: **R1C1 input canonicalizes to A1 in storage.** When the
crates/ql-exec/src/workbook_runtime/tables.rs:2137: -> fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() { :: **Relative R1C1 canonicalizes using the formula's own cell
crates/ql-exec/src/workbook_runtime/tables.rs:2153: -> fn set_formula_canonicalizes_de_locale_to_en() { :: **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
crates/ql-exec/src/workbook_runtime/tables.rs:2169: -> fn set_formula_preserves_at_through_canonicalization() { :: **`@A1` (implicit intersection) survives canonicalization.**
crates/ql-exec/src/workbook_runtime/validate.rs:31: -> pub fn transaction(&mut self) -> WorkbookTransaction<'_> { :: Begin a multi-cell transaction. The returned `WorkbookTransaction`
crates/ql-exec/src/workbook_runtime/validate.rs:50: -> pub fn validate_formula( :: Re-evaluate every formula in the workbook. Used after `load_workbook` to
crates/ql-exec/src/workbook_runtime/validate.rs:157: -> fn add_sheet_rejects_zero_chunk_rows() { :: Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
crates/ql-exec/src/workbook_runtime/validate.rs:184: -> fn clear_formula_rejects_invalid_sheet() { :: Phase 2B.7 audit (correctness L4): `clear_formula` propagates
crates/ql-exec/src/workbook_runtime/validate.rs:219: -> fn validate_formula_returns_value_without_writing() { :: Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
crates/ql-exec/src/workbook_runtime/validate.rs:243: -> fn validate_formula_surfaces_bind_errors() { :: `validate_formula` surfaces bind errors the same way `set_formula`
crates/ql-exec/src/workbook_runtime/validate.rs:256: -> fn validate_formula_returns_anchor_value_for_top_level_array() { :: **W5-103 megaudit MEDIUM-3 closure (#129):** `validate_formula`
crates/ql-exec/src/workbook_runtime/validate.rs:285: -> fn validate_formula_does_not_pollute_plan_cache() { :: `validate_formula` does NOT pollute the bind-plan cache. A
crates/ql-exec/src/workbook_runtime/validate.rs:308: -> fn is_aggregate_function_lists_only_registered_aggregates() { :: Phase 2B.7 audit (correctness M1): `is_aggregate_function` must
crates/ql-exec/src/workbook_runtime/validate.rs:436: -> fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() { :: **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
crates/ql-exec/src/workbook_runtime/validate.rs:597: -> fn every_range_aware_fn_is_admitted_to_is_aggregate_function() { :: **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
crates/ql-exec/src/workbook_runtime/validate.rs:648: -> fn nag_05_nested_aggregates_with_named_range_bind_cleanly() { :: Phase 2B.7 audit closure (test gaps #5 and #6): the existing NAG
crates/ql-exec/src/workbook_runtime/validate.rs:695: -> fn recompute_result_is_complete_is_single_source_of_truth() { :: Phase 2B.7 audit (cleanup): after dropping the redundant

exec
/bin/zsh -lc "sed -n '430,790p' crates/ql-exec/src/workbook_runtime/cells.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '760,850p' crates/ql-exec/src/workbook_runtime/tables.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
        // clear is correct, just coarser. Dirty propagation is
        // handled below via `reextract_table_readers` + the W5-159
        // `on_table_resize` hook.
        self.plan_cache.clear();
        // **W5-159 (Phase 4.8.G.3):** the resolved range each reader
        // bound against is now stale (rows or cols changed). Re-extract
        // deps for every reader so the calcgraph's range stripes
        // reflect the new range — without this, cell writes inside
        // the NEW range but OUTSIDE the OLD range would silently miss
        // the formula's stripe and never dirty it. Must run BEFORE
        // the hook fires (which dirty-fans via BFS through the
        // freshly-registered stripes).
        self.reextract_table_readers(&canonical);
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_resize(&canonical);
        }
        Ok(())
    }

    /// **W5-159 (Phase 4.8.G.3):** re-bind every formula registered
    /// against `table_canonical` and call `reextract_deps` so the
    /// calcgraph's range-stripe state matches the new resolved range.
    /// Used after `resize_table` mutates `TableMetadata.rows`/`.cols`.
    ///
    /// Pattern mirrors `reextract_spill_footprint_readers` (W5-103):
    /// step 1 collects readers under an immutable graph borrow; step 2
    /// re-binds + re-extracts under alternating immutable workbook /
    /// mutable graph borrows. A bind failure (e.g., a column was
    /// removed by the resize) marks the reader dirty so
    /// `recompute_dirty`'s W5-156 bind-error mapping produces `#NAME?`
    /// at the cell.
    fn reextract_table_readers(&mut self, table_canonical: &str) {
        // Step 1: collect (node, sheet, row, col, text) under an
        // immutable borrow of the graph + workbook.
        let reader_info: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> = {
            let g = match self.graph.as_deref() {
                Some(g) => g,
                None => return,
            };
            g.dependents_for_table(table_canonical)
                .into_iter()
                .filter_map(|n| {
                    let (s, r, c) = g.cell_address_for(n)?;
                    let text = self.workbook.formula_at(s, r, c).cloned()?;
                    Some((n, s, r, c, text))
                })
                .collect()
        };

        // Step 2: re-bind + re-extract.
        for (node, sheet, row, col, text) in reader_info {
            let name_gen = self.workbook.names().generation();
            let cell_anchor = if text.contains('@') {
                Some((row, col))
            } else {
                None
            };
            let cache_key = PlanCacheKey {
                text: Arc::clone(&text),
                sheet,
                name_gen,
                cell_anchor,
            };
            let plan: Arc<crate::plan::ExprPlan> = match self
                .plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // W5-147: stored text is canonical A1+EnUs.
                    let tokens = lex_with(
                        text.as_ref(),
                        ql_types::ReferenceMode::A1,
                        ql_types::Locale::EnUs,
                    )?;
                    let expr = parse(tokens)?;
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                }) {
                Ok(p) => p,
                Err(_) => {
                    // Bind broken by the resize (e.g., column removed).
                    // Mark dirty; recompute_dirty's W5-156 mapping at
                    // workbook_runtime.rs:3266 will produce #NAME?.
                    if let Some(g) = self.graph.as_deref_mut() {
                        g.mark_dirty(node);
                    }
                    continue;
                }

 succeeded in 0ms:
                new_spill_shape,
            );
        }
        if let Some((host_anchor, host_shape)) = dissolved_host {
            // Re-extract readers in the dissolved host footprint. The
            // host anchor itself is excluded inside
            // `reextract_spill_footprint_readers` (it's the function's
            // anchor parameter — its own deps aren't touched).
            self.reextract_spill_footprint_readers(
                host_anchor.0,
                host_anchor.1,
                host_anchor.2,
                Some(host_shape),
                None,
            );
        }

        Ok(anchor_value)
    }

    /// **W5-103 (Phase 4.7.J.4 / Codex W5-102 HIGH-1)** — re-extract
    /// deps for every formula whose `cell_to_formulas` index points at
    /// any cell in the UNION of the OLD and NEW spill footprints
    /// anchored at `(sheet, row, col)`. Excludes the anchor cell itself
    /// (its own deps were already (re-)extracted by `on_set_formula`).
    ///
    /// Re-extraction means: re-bind the reader's formula text (via the
    /// PlanCache, so a cached miss is the only cost when the surrounding
    /// `name_gen` is stable) and re-run `extract_and_register_deps`. The
    /// producer-alias rewrite inside `extract_and_register_deps` then
    /// sees the now-current spill table and routes target-cell CellRefs
    /// to the anchor (or unroutes them if the spill dissolved).
    ///
    /// Defensive on bind failure: a reader whose formula text no longer
    /// parses (e.g. it was bound under a different name-gen state) is
    /// skipped. Its broken state surfaces at its own next recompute —
    /// we don't want to fail the surrounding `set_formula` call because
    /// of an unrelated reader.
    fn reextract_spill_footprint_readers(
        &mut self,
        anchor_sheet: SheetId,
        anchor_row: RowId,
        anchor_col: ColId,
        old_shape: Option<SpillShape>,
        new_shape: Option<SpillShape>,
    ) {
        // Step 1: collect reader info under an immutable borrow of the
        // graph. The HashSet dedupes across the old+new union, AND
        // dedupes the anchor cell out (its own deps were handled by
        // on_set_formula above).
        let reader_info: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> = {
            let g = match self.graph.as_deref() {
                Some(g) => g,
                None => return, // No graph attached — nothing to re-extract.
            };
            use std::collections::HashSet;
            let mut seen: HashSet<ql_calcgraph::NodeId> = HashSet::new();
            let mut result: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> =
                Vec::new();
            for shape in [old_shape, new_shape].into_iter().flatten() {
                for node in
                    g.readers_in_rect(anchor_sheet, anchor_row, anchor_col, shape.rows, shape.cols)
                {
                    if !seen.insert(node) {
                        continue;
                    }
                    // Skip the anchor — its own deps were just (re-)bound
                    // by on_set_formula. Resolve address + formula text
                    // in a single pass.
                    let Some((s, r, c)) = g.cell_address_for(node) else {
                        continue;
                    };
                    if (s, r, c) == (anchor_sheet, anchor_row, anchor_col) {
                        continue;
                    }
                    // A reader without a formula text means
                    // cell_to_formulas has a stale entry — defensive skip.
                    let Some(text) = self.workbook.formula_at(s, r, c).cloned() else {
                        continue;
                    };
                    result.push((node, s, r, c, text));
                }
            }
            result
        };

        // Step 2: re-bind + re-extract for each reader. The borrow of
        // `g` from step 1 is released; we now alternate immutable workbook
        // reads (inside the PlanCache miss closure) with mutable graph
        // mutations (reextract_deps).
        for (node, reader_sheet, reader_row, reader_col, text) in reader_info {
            let name_gen = self.workbook.names().generation();
            // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
            // is present (see set_formula for rationale).
            let cell_anchor = if text.contains('@') {
                Some((reader_row, reader_col))
            } else {
                None
            };
            let cache_key = PlanCacheKey {
                text: Arc::clone(&text),
                sheet: reader_sheet,
                name_gen,
                cell_anchor,
            };
            let plan: Arc<crate::plan::ExprPlan> = match self
                .plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    let tokens = lex(text.as_ref())?;
                    let expr = parse(tokens)?;
                    // **W5-114 (Phase 4.8.E):** carry reader cell address.
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(
                            reader_sheet,
                            reader_row,
                            reader_col,
                        )),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                }) {
                Ok(p) => p,
                Err(_e) => {
                    // **Codex audit pass-1 MEDIUM-2 closure (#129):**
                    // the reader's formula no longer binds (workbook
                    // state shifted in a way that broke its plan —
                    // e.g. a referenced name was removed). Per
                    // CLAUDE.md no-fallbacks, silently `continue` is
                    // not acceptable — that preserves stale
                    // `cell_to_formulas` + graph-edge state and the
                    // failure becomes invisible to the user.
                    //
                    // We can't bubble up: the user's set_formula on
                    // the ANCHOR succeeded; failing it because some
                    // UNRELATED reader's bind broke would be punitive.
                    //
                    // Compromise: mark the reader's NodeId dirty so
                    // the next recompute re-attempts evaluation. The
                    // recompute path will produce a visible error at
                    // the reader's cell. The stale graph state for
                    // this reader survives until then — accepted as
                    // a known limitation; a full fix needs a
                    // structured diagnostics channel (deferred).
                    if let Some(g) = self.graph.as_deref_mut() {
                        g.mark_dirty(node);
                    }
                    continue;
                }
            };
            if let Some(g) = self.graph.as_deref_mut() {
                g.reextract_deps(node, plan.as_ref(), self.workbook);
                // **megaudit HIGH-1 closure (#127)**: dirty the
                // re-extracted reader. on_set_value at the OLD/NEW
                // footprint addresses (fired before this loop) used
                // the PRE-rewrite cell_to_formulas index. After
                // reextract_deps moves the reader's index entry, a
                // reader that USED to be at an old address but NOW
                // points to a different address would not have been
                // dirtied by the earlier on_set_value pass (its old
                // index entry was empty by the time the new index
                // landed). Marking the reader dirty here ensures the
                // next recompute_dirty re-evaluates it against the
                // post-dissolution / post-reshape workbook state.
                g.mark_dirty(node);
            }
        }
    }

    /// **W5-103 (Phase 4.7.J.2 / 4.7.J.3)** — spill writeback path.
    /// Called from `set_formula` when `eval_at_cell_boundary` returns
    /// `EvalResult::Array`. Performs (per design § 8.1):
    ///
    /// 1. Degenerate check (`rows == 0 || cols == 0` → `#CALC!`).
    /// 2. Bounds check (anchor + shape fits within grid → `#SPILL!`).
    /// 3. Blocking check (any non-anchor target cell occupied → `#SPILL!`).
    /// 4. Happy path: `register_spill` then `put_computed_at` for every
    ///    cell in the rectangle.
    ///
    /// Anchor cell ALWAYS gets a formula association (`put_formula`).
    /// Non-anchor targets are formula-less per design § 8.2.
    ///
    /// Returns `(anchor_value, Option<SpillShape>)`. `Some(shape)` only
    /// on the happy path (step 4); degenerate/bounds/blocked outcomes
    /// return `None` so the caller knows no new spill footprint exists.
    /// The caller uses the shape to drive Phase 4.7.J.3's target-cell
    /// calcgraph invalidation hook.
    ///
    /// **Tier D1 Step 3.7:** visibility raised to `pub(super)` so
    /// `recompute.rs::try_recompute_with_simd_profile` (sibling
    /// submodule) can call it directly. Pre-split this was a
    /// same-module private fn; after the split, sibling-submodule
    /// access requires explicit visibility.
    pub(super) fn write_spill(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        array: ArrayValue,
        formula_text: Arc<str>,
    ) -> (Value, Option<SpillShape>) {
        // **Sheet validation invariant** (megaudit MEDIUM-5 + Codex
        // verify follow-up). `set_formula` validates `sheet < sheet_count()`
        // at entry; single-threaded code with no Drop hooks means the
        // sheet cannot disappear mid-function. Per CLAUDE.md "no
        // fallbacks — errors must be visible," check the invariant
        // ONCE at the top of `write_spill` so it fires uniformly even
        // for 1×1 spills (which skip the per-target blocking loop) or
        // bounds/degenerate exits (which would otherwise miss the
        // check). The bound is unused on the degenerate path but
        // present even there so a future code change can't accidentally
        // bypass the assertion.
        let _sheet_invariant = self
            .workbook
            .sheet(sheet)
            .expect("write_spill: sheet validated at set_formula entry");

        // Degenerate-array origin is a function-eval contract (e.g.
        // FILTER with all-false mask without if_empty). Surface as
        // #CALC!, NOT #SPILL!. Design § 8.1 step c.
        if array.is_degenerate() {
            return self.write_anchor_error(sheet, row, col, ErrorValue::Calc, formula_text);
        }

        // Bounds check. `array.rows() / cols()` are `>= 1` (degenerate
        // path above caught zero). The last cell sits at
        // `(row + rows - 1, col + cols - 1)` — both must satisfy
        // `<= MAX_ROW / MAX_COLUMN`.
        let last_row_offset = array.rows() - 1;
        let last_col_offset = array.cols() - 1;
        let end_row = row.checked_add(last_row_offset);
        let end_col = col.checked_add(last_col_offset);
        let out_of_bounds =
            !matches!((end_row, end_col), (Some(r), Some(c)) if r <= MAX_ROW && c <= MAX_COLUMN);
        if out_of_bounds {
            return self.write_anchor_error(sheet, row, col, ErrorValue::Spill, formula_text);
        }

        // Blocking check. For every NON-ANCHOR cell in the spill
        // rectangle, the cell must be "spill-empty": no formula, no
        // value (user or computed), no other spill anchor. The clear-old
        // step at the top of `set_formula` already removed THIS anchor's
        // prior footprint, so any remaining non-blank computed entry
        // here came from elsewhere.
        for dr in 0..array.rows() {
            for dc in 0..array.cols() {
                if dr == 0 && dc == 0 {
                    continue;
                }
                let r = row + dr;
                let c = col + dc;
                // Sheet existence is asserted at the top of `write_spill`;
                // re-asserting here would be redundant. The `expect` at
                // function entry guarantees this lookup succeeds.
                let sheet_ref = self
                    .workbook
                    .sheet(sheet)
                    .expect("write_spill: sheet asserted at function entry");
                // **Codex audit pass-1 MEDIUM-1 closure (#129):**
                // include `spill_target_anchor` in the predicate so a
                // cell that is a TARGET of another active spill blocks
                // us even when its materialized value happens to be
                // `Value::Blank` (possible once SEQUENCE/FILTER land
                // and an `ArrayValue` carries a Blank slot — the
                // `Sheet::read != Blank` check alone would miss it,
                // letting register_spill panic at a collision later).
                let occupied = self.workbook.spill_anchor_at(sheet, r, c).is_some()
                    || self.workbook.spill_target_anchor(sheet, r, c).is_some()
                    || self.workbook.formula_at(sheet, r, c).is_some()
                    || sheet_ref.read(r, c) != Value::Blank;
                if occupied {
                    return self.write_anchor_error(
                        sheet,
                        row,
                        col,
                        ErrorValue::Spill,
                        formula_text,
                    );
                }
            }
        }

        // Happy path. Register the spill THEN materialize cells.
        // `register_spill` enforces invariants (no anchor collision,
        // no target/anchor footprint overlap with OTHER spills, bounds).
        // The blocking check above proved no value/formula collision.
        let shape = SpillShape::new(array.rows(), array.cols());
        match self.workbook.register_spill((sheet, row, col), shape) {
            Ok(()) => {}
            Err(e) => panic!(
                "W5-103: register_spill failed after blocker check passed — \
                 the blocker check is incomplete or SpillAnchorTable has \
                 a hidden invariant. error: {:?}",
                e
            ),
        }

        // Write each target cell to computed overlay. Anchor gets the
        // (0,0) value; the rest follow row-major order.
        self.workbook.clear_user_at(sheet, row, col);
        for dr in 0..array.rows() {
            for dc in 0..array.cols() {
                let v = array.at(dr, dc).clone();
                self.workbook.put_computed_at(sheet, row + dr, col + dc, v);
            }
        }
        self.workbook.put_formula(sheet, row, col, formula_text);

        // Excel's anchor return value = the (0,0) cell of the array.
        // Callers (formula bar UI, op-log replay) see this.
        (array.at(0, 0).clone(), Some(shape))
    }

    /// **W5-103 megaudit LOW (Codex pass 2 finding):** anchor-error
    /// write helper. The three blocked-spill arms in `write_spill`
    /// (degenerate → `#CALC!`, bounds → `#SPILL!`, blocking →
    /// `#SPILL!`) all do the same five lines: clear user, write error
    /// to computed, persist formula text, return `(err, None)`.
    /// Factor into one helper so a future fix can't update one arm
    /// and miss another.
    fn write_anchor_error(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        error: ErrorValue,
        formula_text: Arc<str>,
    ) -> (Value, Option<SpillShape>) {
        let err = Value::Error(error);
        self.workbook.clear_user_at(sheet, row, col);
        self.workbook.put_computed_at(sheet, row, col, err.clone());
        self.workbook.put_formula(sheet, row, col, formula_text);
        (err, None)
    }

    /// Set a cell to a literal value (no formula). Clears any existing formula
    /// association at the cell — typing a value over a formula cell deletes the
    /// formula per Excel canon. Phase 2A.7 audit H1: validates sheet + row/col
    /// bounds; returns `RuntimeError` instead of panicking on out-of-grid input.
    pub fn set_value(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;

        // Phase 2A.3.b: emit ops BEFORE mutating, so a serialization failure
        // (NaN/Inf) leaves the workbook unchanged. `CellWireValue::from_value`
        // returns None for `Value::Blank`; we skip the `PutValue` in that case
        // (documented limitation — replaying a Blank write won't reset a
        // prior non-Blank value; rare enough that the wire-format expansion
        // is deferred to Phase 5+). The `ClearFormula` still fires below if
        // the cell had a formula, so the produced log captures the formula
        // removal even when the literal value is Blank.
        //
        // Phase 2B.7 audit H2 (2026-05-12): when BOTH PutValue and
        // ClearFormula need to land, wrap them in a single `Op::BatchCommit`
        // so the pair is atomic at the Loro level — partial-pair failure

exec
/bin/zsh -lc "rg -n \"\\b(reextract_spill_footprint_readers|write_spill|write_anchor_error|reextract_table_readers|try_recompute_one_cached|try_recompute_with_aggregate_cache|try_recompute_with_simd_profile|rewrite_formula_text_for_sheet_rename)\\b\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/sheets.rs:37:fn rewrite_formula_text_for_sheet_rename(
crates/ql-exec/src/workbook_runtime/sheets.rs:174:                rewrite_formula_text_for_sheet_rename(text.as_ref(), &old_canonical, &new_name_arc)
crates/ql-exec/src/workbook_runtime/tables.rs:22://! - `reextract_table_readers` (private helper) — re-extract calc
crates/ql-exec/src/workbook_runtime/tables.rs:139:        // Previously enforced only at `write_spill` time (the write-side
crates/ql-exec/src/workbook_runtime/tables.rs:555:    /// `write_spill` time today; closing this uniformly across
crates/ql-exec/src/workbook_runtime/tables.rs:565:    /// (via [`Self::reextract_table_readers`] so range stripes reflect
crates/ql-exec/src/workbook_runtime/tables.rs:572:    /// `reextract_table_readers` step is a no-op and callers must use
crates/ql-exec/src/workbook_runtime/tables.rs:761:        // handled below via `reextract_table_readers` + the W5-159
crates/ql-exec/src/workbook_runtime/tables.rs:772:        self.reextract_table_readers(&canonical);
crates/ql-exec/src/workbook_runtime/tables.rs:784:    /// Pattern mirrors `reextract_spill_footprint_readers` (W5-103):
crates/ql-exec/src/workbook_runtime/tables.rs:791:    fn reextract_table_readers(&mut self, table_canonical: &str) {
crates/ql-exec/src/workbook_runtime/tables.rs:1793:    /// must (a) reach the formula via `reextract_table_readers`
crates/ql-exec/src/workbook_runtime/mod.rs:65://   private `rewrite_formula_text_for_sheet_rename` helper → `sheets.rs`.
crates/ql-exec/src/workbook_runtime/mod.rs:71://   rename_table, rename_column, resize_table, reextract_table_readers
crates/ql-exec/src/workbook_runtime/mod.rs:75://   recompute_dirty, try_recompute_one_cached,
crates/ql-exec/src/workbook_runtime/mod.rs:76://   try_recompute_with_aggregate_cache, try_recompute_with_simd_profile)
crates/ql-exec/src/workbook_runtime/mod.rs:80://   clear_formula, write_spill, write_anchor_error,
crates/ql-exec/src/workbook_runtime/mod.rs:81://   reextract_spill_footprint_readers) → `cells.rs`. Largest method-
crates/ql-exec/src/workbook_runtime/mod.rs:127:/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
crates/ql-exec/src/workbook_runtime/cells.rs:18://! - `write_spill` (private) — write the spill body for array-
crates/ql-exec/src/workbook_runtime/cells.rs:21://! - `write_anchor_error` (private) — write `#SPILL!` (or other
crates/ql-exec/src/workbook_runtime/cells.rs:23://! - `reextract_spill_footprint_readers` (private) — re-extract
crates/ql-exec/src/workbook_runtime/cells.rs:96:        // **W5-147:** downstream code (put_formula, write_spill, the
crates/ql-exec/src/workbook_runtime/cells.rs:198:        //     `write_spill`'s blocking check doesn't see it as occupied.
crates/ql-exec/src/workbook_runtime/cells.rs:295:            EvalResult::Array(array) => self.write_spill(sheet, row, col, array, formula_text),
crates/ql-exec/src/workbook_runtime/cells.rs:425:            self.reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:436:            // `reextract_spill_footprint_readers` (it's the function's
crates/ql-exec/src/workbook_runtime/cells.rs:438:            self.reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:468:    fn reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:620:    /// `recompute.rs::try_recompute_with_simd_profile` (sibling
crates/ql-exec/src/workbook_runtime/cells.rs:624:    pub(super) fn write_spill(
crates/ql-exec/src/workbook_runtime/cells.rs:637:        // ONCE at the top of `write_spill` so it fires uniformly even
crates/ql-exec/src/workbook_runtime/cells.rs:646:            .expect("write_spill: sheet validated at set_formula entry");
crates/ql-exec/src/workbook_runtime/cells.rs:652:            return self.write_anchor_error(sheet, row, col, ErrorValue::Calc, formula_text);
crates/ql-exec/src/workbook_runtime/cells.rs:666:            return self.write_anchor_error(sheet, row, col, ErrorValue::Spill, formula_text);
crates/ql-exec/src/workbook_runtime/cells.rs:682:                // Sheet existence is asserted at the top of `write_spill`;
crates/ql-exec/src/workbook_runtime/cells.rs:688:                    .expect("write_spill: sheet asserted at function entry");
crates/ql-exec/src/workbook_runtime/cells.rs:702:                    return self.write_anchor_error(
crates/ql-exec/src/workbook_runtime/cells.rs:745:    /// write helper. The three blocked-spill arms in `write_spill`
crates/ql-exec/src/workbook_runtime/cells.rs:751:    fn write_anchor_error(
crates/ql-exec/src/workbook_runtime/cells.rs:935:                self.reextract_spill_footprint_readers(sheet, row, col, Some(shape), None);
crates/ql-exec/src/workbook_runtime/cells.rs:938:                self.reextract_spill_footprint_readers(
crates/ql-exec/src/workbook_runtime/cells.rs:1003:        // `reextract_spill_footprint_readers` call after the
crates/ql-exec/src/workbook_runtime/cells.rs:1109:            self.reextract_spill_footprint_readers(sheet, row, col, Some(shape), None);
crates/ql-exec/src/workbook_runtime/cells.rs:3043:    /// skipped `reextract_spill_footprint_readers`. A reader `X1=B1`
crates/ql-exec/src/workbook_runtime/cells.rs:3091:    // dispatches Array results through `write_spill`, materializing
crates/ql-exec/src/workbook_runtime/cells.rs:3402:    /// ArrayValue which write_spill mapped to `#CALC!`; design says
crates/ql-exec/src/workbook_runtime/cells.rs:3857:    /// → write_spill clears old 3x1 footprint, registers new 5x1, writes
crates/ql-exec/src/workbook_runtime/cells.rs:3984:    /// Closed by: recompute_dirty calls reextract_spill_footprint_readers
crates/ql-exec/src/workbook_runtime/cells.rs:4044:    /// Closed by: (a) `try_recompute_with_simd_profile` now fires
crates/ql-exec/src/workbook_runtime/cells.rs:4046:    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
crates/ql-exec/src/workbook_runtime/recompute.rs:17://! - `try_recompute_one_cached` (private) — lex+parse+bind+eval
crates/ql-exec/src/workbook_runtime/recompute.rs:19://! - `try_recompute_with_aggregate_cache` (private) — same path
crates/ql-exec/src/workbook_runtime/recompute.rs:22://! - `try_recompute_with_simd_profile` (private) — recompute
crates/ql-exec/src/workbook_runtime/recompute.rs:58:        // `try_recompute_one_cached`). Acceptable cost for the
crates/ql-exec/src/workbook_runtime/recompute.rs:142:            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
crates/ql-exec/src/workbook_runtime/recompute.rs:232:        //   4. if write_spill fired during the sorted loop, it called
crates/ql-exec/src/workbook_runtime/recompute.rs:395:                match self.try_recompute_with_simd_profile(sheet, row, col, &text, agg_cache) {
crates/ql-exec/src/workbook_runtime/recompute.rs:458:                            // Inlined (can't call self.reextract_spill_footprint_readers
crates/ql-exec/src/workbook_runtime/recompute.rs:624:    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
crates/ql-exec/src/workbook_runtime/recompute.rs:626:    fn try_recompute_one_cached(
crates/ql-exec/src/workbook_runtime/recompute.rs:633:        self.try_recompute_with_aggregate_cache(
crates/ql-exec/src/workbook_runtime/recompute.rs:642:    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
crates/ql-exec/src/workbook_runtime/recompute.rs:649:    /// branch inside `try_recompute_with_simd_profile` can materialize
crates/ql-exec/src/workbook_runtime/recompute.rs:651:    fn try_recompute_with_aggregate_cache(
crates/ql-exec/src/workbook_runtime/recompute.rs:659:        self.try_recompute_with_simd_profile(sheet, row, col, formula_text, agg_cache)
crates/ql-exec/src/workbook_runtime/recompute.rs:663:    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
crates/ql-exec/src/workbook_runtime/recompute.rs:670:    fn try_recompute_with_simd_profile(
crates/ql-exec/src/workbook_runtime/recompute.rs:736:        // materializes via `write_spill` — instead of collapsing to
crates/ql-exec/src/workbook_runtime/recompute.rs:746:        // The clear-old + write_spill sequence mirrors set_formula's
crates/ql-exec/src/workbook_runtime/recompute.rs:767:        // dissolved footprint after eval+write_spill complete.
crates/ql-exec/src/workbook_runtime/recompute.rs:782:        // writes the anchor via `write_spill`; the caller also
crates/ql-exec/src/workbook_runtime/recompute.rs:787:        // NEW shape via write_spill's return. We DON'T fire
crates/ql-exec/src/workbook_runtime/recompute.rs:802:                self.write_spill(sheet, row, col, array, formula_text_arc)

exec
/bin/zsh -lc "sed -n '610,720p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
            skipped_value_equality,
            simd_classified,
        })
    }

    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
    /// before doing lex/parse/bind work, then evaluate. Failures (lex /
    /// parse / bind) propagate as `RuntimeError`; the caller bundles them
    /// into a `RecomputeFailure`. Successful binds are cached so a
    /// subsequent recompute (or a `set_formula` editing a nearby cell
    /// with the same text) hits.
    ///
    /// Phase 3.6 (W5-39): this is the no-aggregate-cache wrapper. The
    /// `recompute_dirty` path uses
    /// [`Self::try_recompute_with_aggregate_cache`] which threads the
    /// session's aggregate cache through the evaluator.
    fn try_recompute_one_cached(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_aggregate_cache(
            sheet,
            row,
            col,
            formula_text,
            &crate::aggregate_cache::NoAggregateCache,
        )
    }

    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
    /// threads an `AggregateCache` through the scalar evaluator so
    /// `SUM(Sales)` / `AVERAGE(Sales)` calls consult + populate the
    /// cache. Used by `recompute_dirty` which owns a session-side
    /// `InMemAggregateCache`.
    ///
    /// **W5-103 (#128):** also takes `row, col` so the spill-writeback
    /// branch inside `try_recompute_with_simd_profile` can materialize
    /// arrays at the correct anchor cell.
    fn try_recompute_with_aggregate_cache(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<Value, RuntimeError> {
        self.try_recompute_with_simd_profile(sheet, row, col, formula_text, agg_cache)
            .map(|(v, _, _, _)| v)
    }

    /// Phase 3.9 (W5-42): like `try_recompute_with_aggregate_cache`
    /// but ALSO returns a `bool` for whether the formula's bound plan
    /// was SIMD-eligible per `crate::lower::classify`. The bool is
    /// pure observability — the actual SIMD dispatch via `simd::*`
    /// happens at the bench / FormulaRegion path. `recompute_dirty`
    /// uses this to populate `RecomputeResult.simd_classified` so the
    /// IDE profile can show where region optimization would help.
    fn try_recompute_with_simd_profile(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: &Arc<str>,
        agg_cache: &dyn crate::aggregate_cache::AggregateCache,
    ) -> Result<(Value, bool, Option<SpillShape>, Option<SpillShape>), RuntimeError> {
        let name_gen = self.workbook.names().generation();
        // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
        // is present in the stored formula text. This is the
        // recompute path — same canonical text at different cells
        // would otherwise share the cell-specific `@`-narrowed
        // plan from the first bind, leaking the wrong cell ref.
        let cell_anchor = if formula_text.contains('@') {
            Some((row, col))
        } else {
            None
        };
        let cache_key = PlanCacheKey {
            text: Arc::clone(formula_text),
            sheet,
            name_gen,
            cell_anchor,
        };
        // Borrow split: we need an immutable view of the workbook
        // (for `names()` inside the closure) while holding a mutable
        // borrow on `self.plan_cache`. Re-borrow the workbook reference
        // by name so Rust's borrow checker can split them — both fields
        // are disjoint subfields of `self`.
        let workbook: &Workbook = self.workbook;
        let plan: Arc<crate::plan::ExprPlan> =
            self.plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // **W5-147 (Phase 4.9.K):** formula_text here is the
                    // CANONICAL (A1+EnUs) text stored at set_formula
                    // time. Lex with the canonical mode/locale —
                    // regardless of the workbook's current
                    // reference_mode + locale settings, the stored text
                    // is always A1+EnUs per design § 4.4.
                    let tokens = lex_with(
                        formula_text.as_ref(),
                        ql_types::ReferenceMode::A1,
                        ql_types::Locale::EnUs,
                    )?;
                    let expr = parse(tokens)?;
                    // W5-92 (Phase 4.6.D): pass `workbook` for names so
                    // the two-tier sheet-then-workbook scope chain fires.
                    // **W5-114 (Phase 4.8.E):** carry recomputed cell address.
                    Ok(bind_with_site(
                        &expr,

exec
/bin/zsh -lc "sed -n '440,525p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
                                    }
                                }
                            }
                            for (s, r, c) in affected {
                                session.on_set_value(s, r, c);
                            }
                            // Anchor cell — dirties aliased readers.
                            session.on_set_value(sheet, row, col);

                            // **Codex audit HIGH-2 closure**: re-extract
                            // readers in the (old, new) footprint. Mirrors
                            // set_formula's 4.7.J.4 pattern. Required for
                            // dissolution-via-recompute: aliased readers'
                            // deps stay pointing at the dissolved anchor;
                            // future writes to actually-read cells (e.g.
                            // user typing into a now-free target) miss
                            // the reader without re-extraction.
                            //
                            // Inlined (can't call self.reextract_spill_footprint_readers
                            // because it accesses self.graph which is None
                            // during recompute_dirty's session_slot window).
                            let mut seen: HashSet<ql_calcgraph::NodeId> = HashSet::new();
                            let mut readers: Vec<(
                                ql_calcgraph::NodeId,
                                SheetId,
                                RowId,
                                ColId,
                                Arc<str>,
                            )> = Vec::new();
                            for shape in [old_spill_shape, new_spill_shape].into_iter().flatten() {
                                for n in
                                    session.readers_in_rect(sheet, row, col, shape.rows, shape.cols)
                                {
                                    if !seen.insert(n) {
                                        continue;
                                    }
                                    let Some((s, r, c)) = session.cell_address_for(n) else {
                                        continue;
                                    };
                                    if (s, r, c) == (sheet, row, col) {
                                        continue;
                                    }
                                    let Some(text) = self.workbook.formula_at(s, r, c).cloned()
                                    else {
                                        continue;
                                    };
                                    readers.push((n, s, r, c, text));
                                }
                            }
                            for (rn, reader_sheet, reader_row, reader_col, reader_text) in readers {
                                let name_gen = self.workbook.names().generation();
                                // **W5-150 (Phase 4.9.O HIGH-1):** cell-aware key when `@`
                                // is present.
                                let cell_anchor = if reader_text.contains('@') {
                                    Some((reader_row, reader_col))
                                } else {
                                    None
                                };
                                let cache_key = PlanCacheKey {
                                    text: Arc::clone(&reader_text),
                                    sheet: reader_sheet,
                                    name_gen,
                                    cell_anchor,
                                };
                                let workbook: &Workbook = self.workbook;
                                let plan: Arc<crate::plan::ExprPlan> =
                                    match self.plan_cache.get_or_insert::<_, RuntimeError>(
                                        cache_key,
                                        || {
                                            let tokens = lex(reader_text.as_ref())?;
                                            let expr = parse(tokens)?;
                                            // **W5-114 (Phase 4.8.E):** reader cell addr.
                                            Ok(bind_with_site(
                                                &expr,
                                                BindSite::at_cell(ql_types::Address::new(
                                                    reader_sheet,
                                                    reader_row,
                                                    reader_col,
                                                )),
                                                workbook,
                                                workbook,
                                                workbook,
                                            )?)
                                        },
                                    ) {
                                        Ok(p) => p,

exec
/bin/zsh -lc "sed -n '525,610p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
                                        Ok(p) => p,
                                        Err(_) => {
                                            // No-fallbacks rule: bind failure
                                            // here mirrors set_formula path's
                                            // mark_dirty handling — surface at
                                            // reader's own recompute next time.
                                            session.mark_dirty(rn);
                                            continue;
                                        }
                                    };
                                session.reextract_deps(rn, plan.as_ref(), self.workbook);
                                session.mark_dirty(rn);
                            }
                        }
                        succeeded += 1;
                    }
                    Err(error) => {
                        // **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):**
                        // table-related bind failures during recompute
                        // emit `#NAME?` per design § 12.4 ("re-bind to
                        // BindError::UnknownTable → emit #NAME?") and
                        // the `plan.rs:260` UnknownTable docstring.
                        // Typical trigger: `drop_table` invalidates the
                        // plan cache (W5-156 HIGH-1 fix), the on_table_drop
                        // hook marks the reader dirty, recompute re-binds
                        // and discovers the table is gone. Without this
                        // mapping the cell would keep its pre-drop value
                        // (failures collection only surfaces the error
                        // to the caller; the cell overlay stays stale).
                        // Counts as `succeeded` because the formula
                        // evaluated to a well-defined error value, not
                        // a structural recompute failure.
                        if let RuntimeError::Bind(
                            BindError::UnknownTable(_) | BindError::UnknownTableColumn { .. },
                        ) = &error
                        {
                            let v = Value::Error(ErrorValue::Name);
                            let prior_val = prior.get(&(sheet, row, col));
                            if prior_val == Some(&v) {
                                skipped_value_equality += 1;
                            } else {
                                self.workbook.put_computed_at(sheet, row, col, v);
                                changed.insert((sheet, row, col));
                            }
                            succeeded += 1;
                        } else {
                            failures.push(RecomputeFailure {
                                sheet,
                                row,
                                col,
                                formula_text: text,
                                error,
                            });
                        }
                    }
                }
            }
        } // end MAX_ITERATIONS loop

        // **Codex audit MEDIUM closure**: if we hit MAX_ITERATIONS
        // AND session.dirty() is still non-empty, the fixed point
        // wasn't reached. Surface as a synthetic RecomputeFailure
        // so the caller's is_complete() check signals the problem
        // instead of silently returning what looks like a clean
        // recompute. Per CLAUDE.md no-fallbacks rule.
        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
            failures.push(RecomputeFailure {
                sheet: 0,
                row: 0,
                col: 0,
                formula_text: Arc::from(format!(
                    "recompute_dirty hit MAX_ITERATIONS={MAX_ITERATIONS} \
                     with {} cells still dirty — possible runaway spill \
                     shape transition or workbook misconfiguration",
                    session.dirty_formulas().len()
                )),
                error: RuntimeError::RecomputeIterationCap,
            });
        }

        self.graph = session_slot;
        Some(RecomputeResult {
            attempted,
            succeeded,
            failures,
            skipped_value_equality,

exec
/bin/zsh -lc "sed -n '155,230p' crates/ql-exec/src/workbook_runtime/validate.rs && sed -n '1948,2075p' crates/ql-exec/src/workbook_runtime/cells.rs && sed -n '2110,2190p' crates/ql-exec/src/workbook_runtime/tables.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    // ===== Phase 2B.7 — audit closure: input validation + dry-run + cleanup =====

    /// Phase 2B.7 audit H1: `add_sheet` rejects `chunk_rows == 0` BEFORE
    /// any op-log append. Without this check, the workbook gets a sheet
    /// with `chunk_rows = 0` and the first cell write panics inside the
    /// column store — and the op log has a phantom AddSheet entry that
    /// would replay the same poison state on next load.
    #[test]
    fn add_sheet_rejects_zero_chunk_rows() {
        use ql_oplog::OpLog;
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        let result = {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.add_sheet("Bad", 0)
        };
        match result {
            Err(RuntimeError::InvalidChunkRows(0)) => {}
            other => panic!("expected InvalidChunkRows(0), got {other:?}"),
        }
        // No sheet added; no op-log entry.
        assert_eq!(wb.sheet_count(), 0);
        assert!(
            oplog.is_empty(),
            "op log must stay empty on validation failure"
        );
    }

    /// Phase 2B.7 audit (correctness L4): `clear_formula` propagates
    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
    #[test]
    fn clear_formula_rejects_invalid_sheet() {
        let mut wb = make_runtime_workbook(); // 1 sheet
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(99, 0, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 99,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    #[test]
    fn clear_formula_rejects_invalid_cell() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.clear_formula(0, 1_048_576, 0);
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
    }

    /// Phase 2B.7 (closes GAP-I-04): `validate_formula` runs the full
    /// pipeline but doesn't mutate the workbook or the op log. The IDE
    /// can call it on every keystroke to surface diagnostics without
    /// committing the user's draft.
    #[test]
    fn validate_formula_returns_value_without_writing() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        use ql_oplog::OpLog;
        let mut oplog = OpLog::new();
        let rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            Value::Number(999.0)
        );
    }

    // (Tier D1 Step 3.6: Phase 3.1 calcgraph runtime integration tests moved.)

    // ===== W5-83 / Phase 4.5.E — TEXT() formula integration =====

    #[test]
    fn text_formula_renders_through_recompute() {
        // End-to-end: a `TEXT(serial, "yyyy-mm-dd")` formula evaluates
        // to a Text value with the rendered string.
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(45477.0)); // 2024-07-04
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s, 1, 0, "TEXT(A1, \"yyyy-mm-dd\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::text("2024-07-04")
        );
    }

    #[test]
    fn text_formula_with_number_format_returns_formatted_text() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s, 1, 0, "TEXT(A1, \"#,##0.00\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 1, 0)),
            Value::text("1,234.50")
        );
    }

    #[test]
    fn text_formula_invalid_format_returns_value_error() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // `[Red]0` is V2-deferred → parser refuses → TEXT returns #VALUE!
        rt.set_formula(s, 0, 0, "TEXT(1, \"[Red]0\")").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s, 0, 0)),
            Value::Error(ErrorValue::Value)
        );
    }

    // ===== W5-90 / Phase 4.6.B — cross-sheet end-to-end evaluation =====

    #[test]
    fn cross_sheet_cellref_evaluates_after_recompute() {
        // `Sheet2!A1 + 1` on Sheet1, where Sheet2!A1 = 41 → 42.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Sheet1");
        let s2 = wb.add_sheet("Sheet2");
        wb.put_at(s2, 0, 0, Value::Number(41.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 0, "Sheet2!A1 + 1").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s1, 0, 0)),
            Value::Number(42.0)
        );
    }

    // NOTE: `SUM(Sheet2!A1:A3)` (range literal as function arg) is a
    // Phase 4.7 feature — the binder currently rejects `Expr::RangeRef`
    // outside a Function context, and only NameRef→Range pairs reach
    // the AggregateNameRef path. Cross-sheet ranges through named
    // ranges DO work; verified by the named-target tests below.

    #[test]
    fn cross_sheet_quoted_name_with_space_evaluates() {
        // Quoted-sheet-name path: `'Q3 2025'!A1 + 100`.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("Main");
        let s2 = wb.add_sheet("Q3 2025");
        wb.put_at(s2, 0, 0, Value::Number(7.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s1, 0, 0, "'Q3 2025'!A1 + 100").unwrap();
        let _ = rt.recompute_all();
        assert_eq!(
            wb.read(ql_types::Address::new(s1, 0, 0)),
            Value::Number(107.0)
        );
    }

    #[test]
    fn cross_sheet_formula_with_unknown_sheet_surfaces_bind_error_at_set_time() {
        // `set_formula` binds eagerly so the IDE can surface syntax-time
        // errors. An unknown-sheet ref fails at bind, not at recompute.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.set_formula(s1, 0, 0, "Phantom!A1 + 1").unwrap_err();
        match err {
            RuntimeError::Bind(crate::plan::BindError::UnknownSheet(name)) => {
                assert_eq!(name.as_ref(), "Phantom");
            }
            other => panic!("expected RuntimeError::Bind(UnknownSheet), got {other:?}"),
        }
    }

    #[test]
    fn cross_sheet_three_sheet_chain_evaluates() {
        // Sheet3 reads from Sheet2 reads from Sheet1. Tests that
        // cross-sheet deps work through the calcgraph + recompute path.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        let s3 = wb.add_sheet("S3");
        wb.put_at(s1, 0, 0, Value::Number(10.0)); // S1!A1 = 10
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s2, 0, 0, "S1!A1 * 2").unwrap(); // S2!A1 = 20
        rt.set_formula(s3, 0, 0, "S2!A1 + 5").unwrap(); // S3!A1 = 25
        let _ = rt.recompute_all();

    // (Tier D1 Step 3.2: W5-146 config tests moved to
    //  config.rs::tests.)

    // -------------------------------------------------------------
    // W5-147 (Phase 4.9.K) — set_formula canonical-storage tests.
    // -------------------------------------------------------------

    /// **R1C1 input canonicalizes to A1 in storage.** When the
    /// workbook is in R1C1 mode and user types `R1C1`, the stored
    /// formula text is `$A$1` (A1+EnUs canon).
    #[test]
    fn set_formula_canonicalizes_r1c1_input_to_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "R1C1+R2C2").unwrap();
        drop(rt);
        // Stored text uses A1 + absolute markers ($) since the source
        // R1C1Ref `Abs(1),Abs(1)` becomes A1's `$A$1`.
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("$A$1 + $B$2")
        );
    }

    /// **Relative R1C1 canonicalizes using the formula's own cell
    /// as anchor.** `R[-1]C` at cell (1, 0) → `A1` (no `$` — relative
    /// R1C1 ↔ unprefixed A1).
    #[test]
    fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        wb.put_at(0, 0, 0, ql_types::Value::Number(7.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // At cell (1, 0), R[-1]C means "row above, same column" = A1.
        rt.set_formula(0, 1, 0, "R[-1]C").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 1, 0).map(|s| s.as_ref()), Some("A1"));
    }

    /// **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
    /// (DE — `,` decimal, `;` arg sep) → `SUM(2.5, 3.5)` (EN canon).
    #[test]
    fn set_formula_canonicalizes_de_locale_to_en() {
        let mut wb = make_runtime_workbook();
        wb.set_locale(ql_types::Locale::De);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap();
        drop(rt);
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("SUM(2.5, 3.5)")
        );
    }

    /// **`@A1` (implicit intersection) survives canonicalization.**
    /// The `@` operator is mode + locale invariant per design § 3.3.
    #[test]
    fn set_formula_preserves_at_through_canonicalization() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "@A1").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("@A1"));
    }

    #[test]
    fn set_reference_mode_op_round_trips_through_replay() {
        // Producer side: append Op::SetReferenceMode + Op::SetLocale.
        let mut producer_wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();

exec
/bin/zsh -lc "sed -n '4088,4525p' crates/ql-exec/src/workbook_runtime/cells.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    //  to tables.rs::tests.)

    // ===== W5-124 (Phase 4.8.J.2) — spill-anchor uniform check =====

    #[test]
    fn create_table_rejected_when_footprint_contains_spill_anchor() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Register a spill anchor at (0, 2, 1) covering 3 rows x 1 col.
        wb.register_spill((0, 2, 1), SpillShape::new(3, 1))
            .expect("register_spill must succeed on empty workbook");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Try to create a table whose footprint covers the anchor.
        let err = rt
            .create_table(
                "T",
                0,
                0,
                0,
                5,
                3,
                true,
                false,
                vec!["a".into(), "b".into(), "c".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("spill anchor"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_succeeds_when_anchor_is_outside_footprint() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Anchor at column 10 — outside the table footprint at cols 0-2.
        wb.register_spill((0, 0, 10), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "T",
            0,
            0,
            0,
            3,
            3,
            true,
            false,
            vec!["a".into(), "b".into(), "c".into()],
        )
        .expect("non-overlapping anchor must not block create_table");
        assert!(wb.lookup_table("T").is_some());
    }

    #[test]
    fn resize_table_grow_rejected_when_new_cells_contain_spill_anchor() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Initial table covers rows 0-2, col 0.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Spill anchor BELOW the table at row 5.
        wb.register_spill((0, 5, 0), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        // Grow the table to row 10 — would now cover the anchor at row 5.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("spill anchor"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_grow_succeeds_when_anchor_is_outside_new_footprint() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Anchor at row 20 — outside the resized footprint (max row 4).
        wb.register_spill((0, 20, 0), SpillShape::new(2, 1))
            .expect("register_spill must succeed");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.resize_table("Sales", 5, 1, vec![], vec![])
            .expect("anchor outside new footprint must not block");
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 5);
    }

    // ===== W5-125 (Phase 4.8.O.1) — footprint-bounds upper-limit check =====

    #[test]
    fn create_table_rejects_footprint_past_max_row() {
        use ql_types::MAX_ROW;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_row = MAX_ROW - 1, rows = 3 → last row = MAX_ROW + 1 > MAX_ROW.
        let err = rt
            .create_table(
                "Far",
                0,
                MAX_ROW - 1,
                0,
                3,
                1,
                true,
                false,
                vec!["Qty".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("MAX_ROW"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_footprint_past_max_column() {
        use ql_types::MAX_COLUMN;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_col = MAX_COLUMN, cols = 2 → last col = MAX_COLUMN + 1 > MAX_COLUMN.
        let err = rt
            .create_table(
                "Wide",
                0,
                0,
                MAX_COLUMN,
                1,
                2,
                true,
                false,
                vec!["A".into(), "B".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("MAX_COLUMN"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_footprint_u32_overflow_on_rows() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // top_row = u32::MAX, rows = 2 → top_row + rows wraps. Pre-W5-125 the
        // footprint loop `for r in u32::MAX..u32::MAX+2 (wrapped to 1)` was
        // empty and downstream overlap / spill-anchor checks silently skipped.
        let err = rt
            .create_table("Wrap", 0, u32::MAX, 0, 2, 1, true, false, vec!["X".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(
                    reason.contains("u32 overflow") || reason.contains("addressable"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_rejects_growing_past_max_row() {
        use ql_types::MAX_ROW;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Create a table near (but inside) MAX_ROW.
            rt.create_table(
                "Sales",
                0,
                MAX_ROW - 4,
                0,
                3,
                1,
                true,
                false,
                vec!["Qty".into()],
            )
            .unwrap();
        }
        // Grow to 10 rows → last_row = MAX_ROW - 4 + 9 = MAX_ROW + 5 > MAX_ROW.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("MAX_ROW"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_overlap() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "A",
            0,
            0,
            0,
            5,
            2,
            true,
            false,
            vec!["x".into(), "y".into()],
        )
        .unwrap();
        // Overlapping footprint should reject.
        let err = rt
            .create_table(
                "B",
                0,
                2,
                1,
                3,
                2,
                true,
                false,
                vec!["p".into(), "q".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("overlap"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_duplicate_column_names_case_insensitive() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .create_table(
                "T",
                0,
                0,
                0,
                2,
                2,
                true,
                false,
                vec!["Qty".into(), "qty".into()],
            )
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("unique"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn create_table_rejects_namespace_collision_with_defined_name() {
        let mut wb = make_runtime_workbook();
        wb.set_name("FOO", ql_storage::NamedTarget::Constant(Value::Number(1.0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .create_table("Foo", 0, 0, 0, 2, 1, true, false, vec!["x".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("defined-name"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn drop_table_removes_metadata_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.drop_table("Sales").unwrap();
        }
        assert!(wb.lookup_table("Sales").is_none());
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2);
        assert!(matches!(&ops[1], Op::DropTable { name } if name == "SALES"));
    }

    #[test]
    fn drop_table_missing_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.drop_table("Nope").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    /// **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
    /// must (a) invoke the calcgraph `on_table_drop` hook so any
    /// formula referencing the dropped table is BFS-dirtied, (b)
    /// invalidate the plan cache so the next bind doesn't HIT a stale
    /// `ExprPlan::StructuredRef`, and (c) write `#NAME?` to those
    /// cells on the next `recompute_dirty`. W5-155 shipped (a) but not
    /// (b) or (c), leaving the hook functionally inert (the cache hit
    /// served the pre-drop range and eval read the same data cells).
    /// W5-156 closes HIGH-1 (cache flush in `drop_table`) + HIGH-2
    /// (bind-error → cell-value mapping at recompute_dirty:3266).
    #[test]
    fn drop_table_fires_on_table_drop_hook_and_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // Build: Sales table at A1:A3 (header + 2 data rows) with
        // column Qty, values 10/20, and B1 = SUM(Sales[Qty]).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            // Drain dirty so the post-drop assertion is unambiguous.
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let formula_node = graph
            .cell_node_for(0, 0, 1)
            .expect("B1 formula node registered");
        assert!(
            !graph.is_dirty(formula_node),
            "after recompute_dirty B1 should be clean"
        );
        let before = graph.hook_counts().table_drop;

        // Drop the table — the hook must fire and dirty B1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Sales").unwrap();
        }
        assert_eq!(
            graph.hook_counts().table_drop,
            before + 1,
            "drop_table must call on_table_drop exactly once"
        );
        assert!(
            graph.is_dirty(formula_node),
            "B1 = SUM(Sales[Qty]) must be dirty after Sales is dropped"
        );

        // **W5-156 HIGH-2 closure:** recompute must produce `#NAME?`
        // at B1, not preserve the pre-drop `Number(30.0)`. Tests both
        // the cache-flush (HIGH-1) and the bind-error → cell-value
        // mapping (HIGH-2) end-to-end.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "table-related bind errors should map to #NAME? cells, \
                 not RecomputeFailure entries — got: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "B1 = SUM(Sales[Qty]) must produce #NAME? after Sales is dropped"
        );
    }

    /// **W5-156 (Phase 4.8.G.3 — HIGH-2 closure):** transitive BFS
    /// fanout. C1 = B1 + 1 depends on B1 = SUM(Sales[Qty]). Dropping
    /// Sales must dirty BOTH B1 (direct reader) AND C1 (transitive via
    /// the W5-91 H2 BFS pattern from `mark_dirty_from_cell_write`);
    /// recompute then propagates #NAME? through the chain.
    #[test]
    fn drop_table_propagates_name_error_through_chain() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap(); // B1 = 30
            rt.set_formula(0, 0, 2, "B1 + 1").unwrap(); // C1 = 31
            assert_eq!(
                wb.read(ql_types::Address::new(0, 0, 2)),
                Value::Number(31.0)
            );
        }
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Sales").unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty(), "no structural failures");
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "B1: direct reader of dropped table → #NAME?"
        );
        assert_eq!(

exec
/bin/zsh -lc "sed -n '4040,4108p' crates/ql-exec/src/workbook_runtime/cells.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    /// D1 = B5 (currently Blank — references a cell OUTSIDE the spill
    /// footprint). Change A1 to 5; B1 now spills B1..B5. D1 should see
    /// B5 = 5 and update.
    ///
    /// Closed by: (a) `try_recompute_with_simd_profile` now fires
    /// on_set_value for non-anchor cells in (old ∪ new) spill footprint
    /// after write_spill; (b) `recompute_dirty` wraps schedule+eval in
    /// a fixed-point loop so mid-pass dirties (D1 dirtied by B1's
    /// recompute writing B5) get picked up in a follow-up iteration.
    #[test]
    fn recompute_dirty_sequence_grows_dirties_new_target_readers() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(3.0)).unwrap();
            rt.set_formula(0, 0, 1, "SEQUENCE(A1)").unwrap();
            // D1 = B5 — currently Blank (outside the 3x1 spill).
            rt.set_formula(0, 0, 3, "B5").unwrap();
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Blank,
            "D1 = B5 evaluates to Blank initially (B5 outside footprint)"
        );

        // Grow the spill.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 0, 0, Value::Number(5.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.is_complete(), "recompute failures: {result:?}");
        }

        // After recompute_dirty: D1 should see B5 = 5.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Number(5.0),
            "D1 must update to B5's new value after spill grows"
        );
    }

    // (Tier D1 Step 3.5: W5-116 structured-ref tests moved
    //  to tables.rs::tests.)

    // (Tier D1 Step 3.5: W5-118 create/drop tests moved
    //  to tables.rs::tests.)

    // ===== W5-124 (Phase 4.8.J.2) — spill-anchor uniform check =====

    #[test]
    fn create_table_rejected_when_footprint_contains_spill_anchor() {
        use ql_storage::SpillShape;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        // Register a spill anchor at (0, 2, 1) covering 3 rows x 1 col.
        wb.register_spill((0, 2, 1), SpillShape::new(3, 1))
            .expect("register_spill must succeed on empty workbook");
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Try to create a table whose footprint covers the anchor.
        let err = rt
            .create_table(
                "T",
                0,
                0,
                0,
                5,

exec
/bin/zsh -lc "sed -n '360,420p' crates/ql-exec/src/workbook_runtime/names.rs && sed -n '1,300p' crates/ql-exec/src/workbook_runtime/error.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    }

    #[test]
    fn set_formula_unresolved_name_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
        let result = rt.set_formula(0, 0, 0, "UnknownName + 1");
        match result {
            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
                assert_eq!(name.as_ref(), "UNKNOWNNAME");
            }
            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
        }
        // No partial write on bind failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.11 audit M16: error Display strings are human-readable, not
    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
    /// Name("X"))` rendered via `{0:?}` and surfaced "bind error:
    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
    /// quote spelling. Now reads "bind error: unresolved name \"X\"".
    #[test]
    fn runtime_error_bind_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_formula(0, 0, 0, "UnknownName + 1")
            .expect_err("expected an error");
        let display = err.to_string();
        // The display contains the user-facing canonical name; no Rust
        // debug-syntax markers like `UnresolvedName(...)`.
        assert!(
            display.contains("UNKNOWNNAME"),
            "Display lost the name: {display:?}"
        );
        assert!(
            !display.contains("UnresolvedName"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    #[test]
    fn runtime_error_lex_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // **W5-143 (Phase 4.9.G):** `@` is now the implicit-intersection
        // operator, so it's no longer a lex error. Use backtick (`)
        // which has no Excel-formula lexical role and stays
        // unrepresentable.
        let err = rt
            .set_formula(0, 0, 0, "`foo")
            .expect_err("expected an error");
        let display = err.to_string();
        assert!(
//! `WorkbookRuntime` error + result types.
//!
//! Extracted from `workbook_runtime.rs` as **Tier D1 Step 1** per
//! `docs/architecture/workbook-runtime-split-design.md`. Contains:
//! - [`RuntimeError`] — top-level error enum for the runtime pipeline.
//! - [`RecomputeFailure`] — per-cell structural failure during a
//!   recompute pass.
//! - [`RecomputeResult`] — aggregate outcome of `recompute_all` /
//!   `recompute_dirty`.
//!
//! No behavior changes — pure code move. The types remain in the
//! `crate::workbook_runtime` module path via `pub use` in
//! `crate::workbook_runtime::mod` so all existing callers compile
//! unchanged.

use std::sync::Arc;

use ql_formula_syntax::{LexError, ParseError, PrintError};
use ql_types::{ColId, RowId, SheetId};

use crate::plan::BindError;

/// Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
/// Phase 2A.6 audit H1/L4 (2026-05-12) added `InvalidSheet` so callers that pass
/// a sheet id outside the workbook's range get a clean error instead of a panic
/// from `Workbook::put_at`. Phase 2A.6 audit H4 added `ConflictingOps` for
/// the `WorkbookTransaction` mixed-kind-on-same-cell case.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RuntimeError {
    // Phase 2A.11 audit M16: switched from `{0:?}` debug formatters to `{0}`
    // Display now that LexError + BindError implement thiserror::Error with
    // user-facing strings. IDE error display reads cleanly: "lex error:
    // unexpected character: '@'" instead of "lex error: UnexpectedChar('@')".
    #[error("lex error: {0}")]
    Lex(LexError),

    #[error("parse error: {0}")]
    Parse(#[from] ParseError),

    /// **W5-147 (Phase 4.9.K):** the canonicalize step of `set_formula`
    /// (per design § 4.4) failed. This happens when the parsed AST
    /// contains an intermediate `Expr::R1C1Ref` with a relative axis
    /// that the printer can't resolve, or a malformed R1C1 axis. In
    /// practice the bind site always has a cell anchor, so the only
    /// reachable case is a hand-built AST with `AxisSpec::Abs(0)` —
    /// effectively impossible from `set_formula` since the lexer
    /// already rejects it as `MalformedR1C1`. Kept as a typed error
    /// for defense-in-depth.
    #[error("print error: {0}")]
    Print(#[from] PrintError),

    #[error("bind error: {0}")]
    Bind(BindError),

    #[error("invalid sheet {sheet}: workbook has {sheet_count} sheets")]
    InvalidSheet { sheet: SheetId, sheet_count: usize },

    /// Phase 2A.7 audit H1: row/col outside the Excel grid (MAX_ROW = 1,048,575;
    /// MAX_COLUMN = 16,383). Surfaces at buffer time so `Sheet::put` doesn't
    /// panic mid-commit. `why` describes which bound was exceeded.
    #[error("invalid cell (sheet={sheet}, row={row}, col={col}): {why}")]
    InvalidCell {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        why: &'static str,
    },

    #[error(
        "conflicting transaction ops on cell (sheet={sheet}, row={row}, col={col}): \
         a value and a formula were both buffered for this cell in the same transaction"
    )]
    ConflictingOps {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Phase 2A.3.b (2026-05-12): the producer-side append into an attached
    /// op log failed (serde_json refused the wire value — e.g. NaN/Inf — or
    /// Loro surfaced an internal error). Producer order is append-then-mutate:
    /// when this fires, the workbook is unchanged. Callers attaching an op
    /// log handle the error; callers that don't attach one never see this
    /// variant.
    #[error("op log error: {0}")]
    OpLog(#[from] ql_oplog::OpLogError),

    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
    /// the name in the workbook's `NameTable`. Currently the only
    /// `NameTableError` variant is `Reserved` (per CORR-06 the `AI` name is
    /// engine-reserved); see `ql_storage::NameTableError` for additional
    /// variants when they land.
    #[error("name table error: {0}")]
    Name(#[from] ql_storage::NameTableError),

    /// **W5-91 (Phase 4.6.C):** sheet-name validation refused — empty
    /// string, Excel-reserved character, or canonical duplicate.
    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
    /// `add_sheet` variants that validate).
    #[error("sheet name rejected: {0}")]
    SheetName(#[from] ql_storage::SheetNameError),

    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
    /// called with `chunk_rows == 0`. `Sheet::with_chunk_rows` accepts it
    /// silently, then the first cell write panics deep inside the column
    /// store. Pre-validating at the runtime entry refuses the value cleanly
    /// before any op-log append, so a bad input can't poison a workbook.
    #[error("invalid chunk_rows {0}: must be > 0 (engine default is 16384)")]
    InvalidChunkRows(u32),

    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
    /// called with the workbook already at `SheetId::MAX` (65,535) sheets.
    /// `Workbook::add_sheet_with_chunk_rows` panics in that case; the
    /// runtime now refuses before any op-log append.
    #[error("workbook has {current} sheets; cannot add another (limit {max})")]
    TooManySheets { current: u32, max: u32 },

    /// **W5-82 (Phase 4.5.D part 6):** `set_cell_format` was called with
    /// `Some(FormatId)` referencing an id that hasn't been registered
    /// in the workbook's `FormatTable`. Producer-side enforcement of the
    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
    /// `FormatNotRegistered`. Callers should obtain the id via
    /// `intern_format` (which handles registration automatically).
    #[error("format id {0} is not registered in the workbook FormatTable")]
    UnknownFormatId(u32),

    /// **W5-106-AUDIT (Codex MEDIUM closure):** recompute_dirty's
    /// fixed-point loop hit its MAX_ITERATIONS bound with cells still
    /// dirty. Signals a runaway spill shape transition or workbook
    /// misconfiguration; the recompute result is partial.
    #[error("recompute_dirty hit iteration cap with cells still dirty")]
    RecomputeIterationCap,

    /// **W5-118 (Phase 4.8.H):** `create_table` was rejected by a
    /// validation rule. `reason` is a static string describing which
    /// invariant fired (uniqueness, overlap, empty column name, ...).
    #[error("table {name:?} create rejected: {reason}")]
    TableCreateRejected { name: String, reason: &'static str },

    /// **W5-118 (Phase 4.8.H):** `drop_table` was called on a name
    /// that doesn't exist.
    #[error("table {0:?} not found")]
    TableNotFound(String),

    /// **W5-121 (Phase 4.8.I.2):** `rename_column` referenced a column
    /// name (case-insensitive) that does not exist in the target table.
    #[error("table {table:?} has no column {column:?}")]
    TableColumnNotFound { table: String, column: String },

    /// **W5-121 (Phase 4.8.I.2):** `rename_column` was rejected by a
    /// validation rule (target column name already in the table, empty,
    /// etc.). `reason` is a static string describing which invariant
    /// fired.
    #[error("table {table:?} column {column:?} rejected: {reason}")]
    TableColumnRejected {
        table: String,
        column: String,
        reason: &'static str,
    },

    /// **W5-122 (Phase 4.8.J):** `resize_table` was rejected by a
    /// validation rule (zero dims, arithmetic mismatch, trailing-
    /// columns mismatch, column-name collision, footprint overlap,
    /// etc.). `reason` is a static string describing which invariant
    /// fired.
    #[error("table {name:?} resize rejected: {reason}")]
    TableResizeRejected { name: String, reason: &'static str },
}

impl From<LexError> for RuntimeError {
    fn from(e: LexError) -> Self {
        Self::Lex(e)
    }
}

impl From<BindError> for RuntimeError {
    fn from(e: BindError) -> Self {
        Self::Bind(e)
    }
}

/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): part of the [`RecomputeResult`] aggregation
/// replacing the prior short-circuit `Result<usize, RuntimeError>` return
/// shape. Captures everything a caller needs to display the failure
/// without re-walking the workbook: the cell address, the formula text
/// that was tried, and the structural error from lex/parse/bind.
///
/// Evaluation-time errors that surface as `Value::Error(...)` (e.g. `=10/0`
/// → `#DIV/0!`) do NOT appear here — those are normal cell values per
/// Excel canon and get written to the workbook like any other recompute
/// success. `RecomputeFailure` is reserved for STRUCTURAL failures where
/// the formula cannot be evaluated at all.
///
/// Not `Clone` — `RuntimeError` contains `loro::LoroError` (via the
/// Phase 2A.3.b `OpLog` variant) which is not Clone. Pass by ownership
/// or borrow.
#[derive(Debug)]
pub struct RecomputeFailure {
    pub sheet: SheetId,
    pub row: RowId,
    pub col: ColId,
    pub formula_text: Arc<str>,
    pub error: RuntimeError,
}

/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
///
/// Phase 2B.2 (2026-05-12): replaces the prior `Result<usize, RuntimeError>`
/// return shape. The previous signature short-circuited on first failure,
/// dropping per-cell context and forcing callers to re-walk the workbook
/// to find what went wrong. The new shape:
///
/// - `attempted` — total formula cells in the workbook snapshot at start.
/// - `succeeded` — formulas that lex/parse/bind/eval'd cleanly and were
///   written back to the workbook.
/// - `failures` — every formula that failed structurally, in iteration
///   order. Each entry carries cell address + formula text + error.
///
/// "Is this workbook now consistent?" is exposed via `is_complete()`
/// (= `failures.is_empty()`); see `failed_count()` for the count.
/// Phase 2B.7 audit (correctness M2) dropped a redundant `partial_state`
/// `pub` field that mirrored `!is_complete()` — having two sources of
/// truth created a soundness footgun (external constructors could lie).
///
/// No-fallback semantics: failures are NOT swallowed. The struct makes
/// every failure visible and aggregable. Callers that want short-circuit
/// semantics can check `is_complete()` and bail.
///
/// Cells past a failure point keep their pre-recompute (potentially stale)
/// values; their formula text is preserved either way (recompute never
/// clears formula on failure). Iteration order is `HashMap`-arbitrary
/// today (GAP-R-01); Engine Phase 3 calcgraph integration makes it
/// topological.
///
/// Not `Clone` for the same reason as `RecomputeFailure`.
///
/// Phase 3.8 (W5-41, 2026-05-12) adds the `skipped_value_equality` field
/// — VEQ-3-03's "profile records skipped downstream vertices." A dirty
/// formula whose direct cell deps all stayed at their prior values, and
/// which has no range deps or volatile flag, is skipped entirely during
/// `recompute_dirty`. The counter is `0` for `recompute_all` (which
/// always processes every formula in HashMap order — no VEQ logic).
///
/// Phase 3.9 (W5-42, 2026-05-12) adds `simd_classified` — SIMD-3-03's
/// "graph profile shows region execution." Counts how many of the dirty
/// formulas had plans that `lower::classify` says are SIMD-eligible
/// (`SimdShape != NotApplicable`). V1 of Phase 3.9 doesn't yet batch
/// these into bulk Arrow kernel calls (that's the Phase 4.7+ array-
/// formula / FormulaRegion binder work); the count is the observability
/// surface that proves the graph scheduler SEES region-eligible cells.
#[derive(Debug)]
pub struct RecomputeResult {
    pub attempted: usize,
    pub succeeded: usize,
    pub failures: Vec<RecomputeFailure>,
    /// Phase 3.8 (VEQ-3-03): count of formulas that were in the dirty
    /// set but skipped because no upstream value actually changed.
    /// Always `0` for the legacy `recompute_all` path.
    pub skipped_value_equality: usize,
    /// Phase 3.9 (SIMD-3-03): count of dirty formulas whose plan
    /// `lower::classify` recognized as SIMD-eligible (a recognized
    /// `SimdShape`). V1 ships observability only — the bulk SIMD
    /// dispatch via `simd::*` lives on the bench / FormulaRegion path
    /// (Phase 4.7+); this counter proves the graph scheduler is aware
    /// of region-eligible formulas. Always `0` for `recompute_all`.
    pub simd_classified: usize,
}

impl RecomputeResult {
    /// True iff every formula recomputed without a structural failure.
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty()
    }

    /// Number of structural failures (lex/parse/bind). Excludes evaluation
    /// errors like `#DIV/0!` which are normal cell values.
    pub fn failed_count(&self) -> usize {
        self.failures.len()
    }
}

exec
/bin/zsh -lc "nl -ba crates/ql-exec/src/workbook_runtime/mod.rs | sed -n '1,320p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
     1	//! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
     2	//!
     3	//! Ties the lex → parse → bind → eval → put pipeline together so callers (IDE,
     4	//! tests, future REPL) get one method that does the right thing for a user-typed
     5	//! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
     6	//! the workbook — used after loading a `.qbook/` directory where formula values
     7	//! were left as `#NULL!` sentinels.
     8	//!
     9	//! Phase 1 W5-10 scope:
    10	//! - `set_formula(sheet, row, col, text)` — parse + eval + persist formula text +
    11	//!   evaluated value. Phase 3.5: routes the evaluated value to the COMPUTED
    12	//!   overlay; clears any stale user-overlay entry at the cell first.
    13	//! - `set_value(sheet, row, col, value)` — literal-only write; clears any existing
    14	//!   formula association. Phase 3.5: `clear_formula` cascades to drop the
    15	//!   computed-overlay entry too.
    16	//! - `recompute_all()` — HashMap-order full pass. Tier C1 (2026-05-18,
    17	//!   Phase 4.12 Opus-B H-2 closure) added an ephemeral
    18	//!   `CalcgraphSession`-based cycle-detection pre-pass: cycled cells
    19	//!   short-circuit to `#CIRC!` before the eval loop runs. Acyclic
    20	//!   formulas still evaluate in HashMap order (GAP-R-01 stale-
    21	//!   intermediate caveat unchanged).
    22	//! - `recompute_dirty()` (Phase 3.4 W5-37) — incremental graph-driven recompute.
    23	//!   Runs Tarjan SCC over the attached `CalcgraphSession`'s dirty set; cycled
    24	//!   members get `Value::Error(ErrorValue::Circ)`. Phase 3.6 routes aggregates
    25	//!   through the session's `InMemAggregateCache`; Phase 3.8 applies value-
    26	//!   equality short-circuit; Phase 3.9 V1 tallies SIMD-eligible formulas in
    27	//!   `RecomputeResult.simd_classified`.
    28	//! - `validate_formula(sheet, row, col, text)` (Phase 2B.7) — full pipeline
    29	//!   without mutation; IDE on-keystroke validation entry.
    30	//!
    31	//! Phase 4+ deferred (per Phase 3.10 megaudit + W5-48 Codex deep-audit):
    32	//! - GAP-G-01 / GAP-G-03 — append-only graph rebind staleness + range-deps-
    33	//!   not-scheduler-edges. Architectural decision needed before Phase 4.3 V2.
    34	//! - GAP-G-02 — bulk SIMD region dispatch from graph scheduler (V1 is
    35	//!   observability only).
    36	//! - FN4-03 — lazy IF/IFERROR (needs scalar.rs Function-branch refactor).
    37	//! - Cross-sheet formula references via NameTable resolution (Phase 4.6).
    38	
    39	use ql_functions::format::FormatString;
    40	use ql_functions::FunctionRegistry;
    41	use ql_oplog::OpLog;
    42	use ql_storage::{FormatId, Workbook};
    43	use ql_types::{ColId, RowId, SheetId, MAX_COLUMN, MAX_ROW};
    44	
    45	use crate::plan_cache::{PlanCache, PlanCacheStats};
    46	
    47	// **Tier D1 (2026-05-18 — Phase 5 prep, monolith split):** sibling
    48	// submodules under `crate::workbook_runtime`. Each submodule adds an
    49	// `impl<'a> WorkbookRuntime<'a> { ... }` block to extend the struct
    50	// without changing its public API surface. See
    51	// `docs/architecture/workbook-runtime-split-design.md`.
    52	//
    53	// Step 1 (2026-05-18, commit 79c1ebeefa7): error/result types →
    54	//   `error.rs`. Re-exported here so callers continue to import
    55	//   `RuntimeError` / `RecomputeFailure` / `RecomputeResult` from
    56	//   `crate::workbook_runtime` unchanged.
    57	// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
    58	//   read_display) → `formats.rs`. No public re-export needed (methods
    59	//   stay on `WorkbookRuntime`).
    60	// Step 3.2 (2026-05-18): workbook config setters (set_reference_mode,
    61	//   set_locale) → `config.rs`. As a side effect, the rename_table doc
    62	//   that was previously misattached to set_reference_mode now correctly
    63	//   attaches to pub fn rename_table.
    64	// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
    65	//   private `rewrite_formula_text_for_sheet_rename` helper → `sheets.rs`.
    66	// Step 3.4 (2026-05-18): defined-name API (set_name,
    67	//   set_sheet_scoped_name) → `names.rs`. Folded-in cleanup: 3
    68	//   misplaced add_sheet W5-93 tests that should have moved with
    69	//   Step 3.3 now live in sheets.rs::tests.
    70	// Step 3.5 (2026-05-18): table mutation API (create_table, drop_table,
    71	//   rename_table, rename_column, resize_table, reextract_table_readers
    72	//   private helper) → `tables.rs`. Biggest single step: ~819 LOC impl
    73	//   + ~1,380 LOC tests (W5-116/118/119/121/122 clusters).
    74	// Step 3.6 (2026-05-18): recompute pipeline (recompute_all,
    75	//   recompute_dirty, try_recompute_one_cached,
    76	//   try_recompute_with_aggregate_cache, try_recompute_with_simd_profile)
    77	//   → `recompute.rs`. Test clusters: recompute_all, Tier C1, 2B.2, 2B.3,
    78	//   2B.4, Phase 3.1 calcgraph integration.
    79	// Step 3.7 (2026-05-18): cell mutation API (set_formula, set_value,
    80	//   clear_formula, write_spill, write_anchor_error,
    81	//   reextract_spill_footprint_readers) → `cells.rs`. Largest method-
    82	//   LOC step: set_formula alone is 417 LOC. Test clusters: set_formula
    83	//   + set_value + Phase 2A.3.b + Phase 2B.5 + W5-83/90/103-107/124/
    84	//   125/148/149.
    85	// Step 3.8 (2026-05-18, FINAL method-extraction step): validation +
    86	//   transaction API (transaction, validate_formula) → `validate.rs`.
    87	//   Phase 2B.7 input-validation test cluster (~564 LOC) moved with
    88	//   it. mod.rs is now down to <600 LOC — close to the ≤ 250 Step 4
    89	//   final-cleanup target (remaining is constructors + validate_sheet
    90	//   / validate_cell helpers + Phase 2A.1 named-range tests still in
    91	//   the inline test module).
    92	mod cells;
    93	mod config;
    94	mod error;
    95	mod formats;
    96	mod names;
    97	mod recompute;
    98	mod sheets;
    99	mod tables;
   100	mod validate;
   101	pub use error::{RecomputeFailure, RecomputeResult, RuntimeError};
   102	
   103	/// Phase 2A.6 audit H1/L4 (2026-05-12) helper. Confirms `sheet` is in range
   104	/// before any work that would otherwise panic inside `Workbook::put_at`.
   105	/// `pub(crate)` so `WorkbookTransaction` can call the same validator at
   106	/// `put_value` / `put_formula` buffering time.
   107	pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
   108	    let count = workbook.sheet_count();
   109	    if (sheet as usize) >= count {
   110	        return Err(RuntimeError::InvalidSheet {
   111	            sheet,
   112	            sheet_count: count,
   113	        });
   114	    }
   115	    Ok(())
   116	}
   117	
   118	/// Phase 2A.7 audit H1 (2026-05-12) helper. Combines sheet validation with
   119	/// row/col bounds checks so the runtime entry points refuse out-of-grid
   120	/// coordinates before any work that would otherwise panic inside
   121	/// `Sheet::put` (which asserts `row <= MAX_ROW && col <= MAX_COLUMN`). The
   122	/// Phase 2A.6 audit closed sheet-id panics but missed row/col — three
   123	/// independent megaudit agents flagged the gap. `pub(crate)` so
   124	/// `WorkbookTransaction` can call the same validator at buffer time.
   125	///
   126	/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
   127	/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
   128	/// helper that lived between this comment and `validate_cell`. The
   129	/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
   130	/// now reaches its intended target.
   131	pub(crate) fn validate_cell(
   132	    workbook: &Workbook,
   133	    sheet: SheetId,
   134	    row: RowId,
   135	    col: ColId,
   136	) -> Result<(), RuntimeError> {
   137	    validate_sheet(workbook, sheet)?;
   138	    if row > MAX_ROW {
   139	        return Err(RuntimeError::InvalidCell {
   140	            sheet,
   141	            row,
   142	            col,
   143	            why: "row exceeds MAX_ROW (1,048,575)",
   144	        });
   145	    }
   146	    if col > MAX_COLUMN {
   147	        return Err(RuntimeError::InvalidCell {
   148	            sheet,
   149	            row,
   150	            col,
   151	            why: "col exceeds MAX_COLUMN (16,383)",
   152	        });
   153	    }
   154	    Ok(())
   155	}
   156	
   157	// (Tier D1 Step 1: error/result types moved to error.rs above —
   158	//  see the mod declaration + pub use at the top of this file.)
   159	
   160	/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
   161	///
   162	/// Construct one per session of cell edits. Re-creating per call is cheap (the
   163	/// struct holds borrows, no heap state of its own).
   164	///
   165	/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
   166	/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
   167	/// emit ops into the log in append-before-mutate order. `transaction()`
   168	/// re-borrows the op-log handle into the returned transaction so a single op
   169	/// log records both individual edits and batched commits cohesively.
   170	pub struct WorkbookRuntime<'a> {
   171	    workbook: &'a mut Workbook,
   172	    registry: &'a FunctionRegistry,
   173	    /// Optional op-log sink. When `Some`, all producer methods append before
   174	    /// mutating the workbook so a failing append leaves the workbook
   175	    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
   176	    oplog: Option<&'a mut OpLog>,
   177	    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
   178	    /// successive `set_formula` and `recompute_all` calls hit the cache
   179	    /// for unchanged formula text under the same NameTable generation.
   180	    /// See `crate::plan_cache` module docs for the invalidation contract.
   181	    plan_cache: PlanCache,
   182	    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
   183	    /// every mutation method calls the corresponding hook on the
   184	    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
   185	    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
   186	    /// dirty propagation through the same surface. See
   187	    /// `crate::calcgraph_session` module docs for the ownership model.
   188	    graph: Option<&'a mut crate::CalcgraphSession>,
   189	    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
   190	    /// by `FormatId`. `read_display` populates on-demand from
   191	    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
   192	    /// id→string mutations, so cache entries stay stable for the
   193	    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
   194	    /// new entry; no invalidation needed.
   195	    format_cache: std::collections::HashMap<FormatId, FormatString>,
   196	}
   197	
   198	impl<'a> WorkbookRuntime<'a> {
   199	    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
   200	        Self {
   201	            workbook,
   202	            registry,
   203	            oplog: None,
   204	            plan_cache: PlanCache::new(),
   205	            format_cache: std::collections::HashMap::new(),
   206	            graph: None,
   207	        }
   208	    }
   209	
   210	    /// Phase 2A.3.b: construct a runtime that records every mutation to the
   211	    /// supplied `OpLog`. Producer-replay equivalence: replaying the resulting
   212	    /// log against a fresh workbook (then calling `recompute_all` to
   213	    /// materialize formula values) reproduces the same observable state.
   214	    ///
   215	    /// See module docs for the documented limitations: `set_value(Value::Blank)`
   216	    /// emits no `PutValue` (CellWireValue lacks a Blank variant in 2A.3.b);
   217	    /// NaN/Inf in number values fail serde_json serialization and surface as
   218	    /// `RuntimeError::OpLog`.
   219	    pub fn with_oplog(
   220	        workbook: &'a mut Workbook,
   221	        registry: &'a FunctionRegistry,
   222	        oplog: &'a mut OpLog,
   223	    ) -> Self {
   224	        Self {
   225	            workbook,
   226	            registry,
   227	            oplog: Some(oplog),
   228	            plan_cache: PlanCache::new(),
   229	            format_cache: std::collections::HashMap::new(),
   230	            graph: None,
   231	        }
   232	    }
   233	
   234	    /// Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
   235	    /// mutation hooks on every producer method. Phase 3.1 hooks are
   236	    /// stubs (counter bumps + cell-index updates) — they accumulate
   237	    /// state that Phase 3.3 will turn into real dirty propagation and
   238	    /// edge updates. Today's recompute_all still walks formulas in
   239	    /// HashMap order; Phase 3.4 replaces it with a Tarjan-SCC-scheduled
   240	    /// graph walk.
   241	    pub fn with_graph(
   242	        workbook: &'a mut Workbook,
   243	        registry: &'a FunctionRegistry,
   244	        graph: &'a mut crate::CalcgraphSession,
   245	    ) -> Self {
   246	        Self {
   247	            workbook,
   248	            registry,
   249	            oplog: None,
   250	            plan_cache: PlanCache::new(),
   251	            format_cache: std::collections::HashMap::new(),
   252	            graph: Some(graph),
   253	        }
   254	    }
   255	
   256	    /// Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
   257	    /// op log and an attached calcgraph session. The combined-attachment
   258	    /// constructor mirrors the IDE pattern (open file → load oplog +
   259	    /// rebuild graph → hand both to the runtime per edit). Order of
   260	    /// operations per mutation: lex+parse+bind → op-log append → workbook
   261	    /// mutation → graph hook.
   262	    pub fn with_oplog_and_graph(
   263	        workbook: &'a mut Workbook,
   264	        registry: &'a FunctionRegistry,
   265	        oplog: &'a mut OpLog,
   266	        graph: &'a mut crate::CalcgraphSession,
   267	    ) -> Self {
   268	        Self {
   269	            workbook,
   270	            registry,
   271	            oplog: Some(oplog),
   272	            plan_cache: PlanCache::new(),
   273	            format_cache: std::collections::HashMap::new(),
   274	            graph: Some(graph),
   275	        }
   276	    }
   277	
   278	    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
   279	    /// since this runtime was constructed. Includes hit count, miss
   280	    /// count, entry count, and convenience hit-rate.
   281	    pub fn cache_stats(&self) -> PlanCacheStats {
   282	        self.plan_cache.stats()
   283	    }
   284	
   285	    // (Tier D1 Step 3.7: 6 cell methods + spill helpers moved
   286	    //  to cells.rs sibling submodule.)
   287	
   288	    // **Tier D1 Step 3.7 + 3.8:** all cell-mutation, recompute,
   289	    // validation, and transaction methods have been moved to sibling
   290	    // submodules. See the `mod <name>;` block at the top of this
   291	    // file. mod.rs now holds only the struct decl, constructors,
   292	    // `cache_stats`, and `validate_sheet` / `validate_cell` shared
   293	    // helpers.
   294	}
   295	
   296	// **Tier D1 Step 4:** every method test cluster has been partitioned
   297	// to the sibling submodule that owns the methods. The inline `mod
   298	// tests` block previously here is gone; submodule-level tests run
   299	// alongside their methods.

exec
/bin/zsh -lc "nl -ba crates/ql-exec/src/lib.rs | sed -n '38,120p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    38	//!   wrapping lex → parse → bind → eval → persist + recompute_all.
    39	//!   `RecomputeResult` aggregation (no more short-circuit). Op-log
    40	//!   producer wrappers (`set_name` / `add_sheet` / `clear_formula`)
    41	//!   emit ops when an `OpLog` is attached. Phase 2B.7 added
    42	//!   `validate_formula` for IDE on-keystroke validation and
    43	//!   pre-validation guards on `add_sheet`. Phase 3.4 added
    44	//!   `recompute_dirty()` — runs Tarjan SCC over the attached
    45	//!   session's dirty set; cycled members get
    46	//!   `Value::Error(ErrorValue::Circ)`. `RuntimeError` family includes
    47	//!   `InvalidSheet`, `InvalidCell`, `ConflictingOps`, `OpLog`,
    48	//!   `Name`, `InvalidChunkRows`, `TooManySheets`.
    49	//! - `transaction.rs` (Phase 2A.2; hardened Phase 2A.6, 2A.3.b, 2B.7) —
    50	//!   `WorkbookTransaction` multi-cell batch API with eager validation,
    51	//!   conflict detection. Phase 2B.7 reordered commit to append-first
    52	//!   (BatchCommit appended BEFORE workbook mutations) so a serialization
    53	//!   failure can't leave the workbook divergent from the log.
    54	//! - `loader.rs` (Phase 2A.4; reshaped Phase 2B.2) —
    55	//!   `load_workbook_and_recompute(path, &reg) -> Result<(Workbook,
    56	//!   RecomputeResult), QbookError>` convenience. Phase 2B.2 removed the
    57	//!   `LoadAndRecomputeError` wrapper enum; recompute failures are now
    58	//!   aggregated into the returned `RecomputeResult` instead.
    59	//! - `calcgraph_session.rs` (Phase 3.1 W5-34 → 3.2 W5-35 → 3.3 W5-36
    60	//!   → 3.4 W5-37) — `CalcgraphSession` owns the `ql_calcgraph::Graph`
    61	//!   plus per-formula `FormulaDeps`, `cell_to_formulas` reverse
    62	//!   index, `name_to_formulas` reverse index, `volatile_formulas`,
    63	//!   and a `dirty: HashSet<NodeId>`. The 5 mutation hooks fan out
    64	//!   via `Graph::dependents_for_cell` (stripe + precision for range
    65	//!   deps) and `cell_to_formulas` (direct deps), with BFS for
    66	//!   transitive cascading (Phase 3.4). Forward `add_edge`s for
    67	//!   direct cell→cell deps are added at extract time (Phase 3.4) so
    68	//!   the Phase 0 W3-3 iterative Tarjan in `topo::schedule` can order
    69	//!   chain dependents correctly. `schedule_dirty()` + `take_dirty()`
    70	//!   are the scheduler entry points; `cell_address_for(NodeId)` is
    71	//!   the inverse of `cell_node_for` for the runtime's evaluation
    72	//!   loop.
    73	//!
    74	//! # Stability
    75	//!
    76	//! Pre-0.2.0 the public API surface is in flux. Error enums
    77	//! (`BindError`, `RuntimeError`) and `SimdShape` carry
    78	//! `#[non_exhaustive]` — downstream consumers must include a `_` arm
    79	//! when matching across crate boundaries. `ExprPlan` (the plan IR),
    80	//! `ResolvedName`, and `EvalResult` are exhaustive by design;
    81	//! adding a variant is a MAJOR-version event because every scalar /
    82	//! aggregate / spill evaluator dispatcher must gain a new arm.
    83	//!
    84	//! # Module layout (Tier D1 split, 2026-05-18)
    85	//!
    86	//! `workbook_runtime` is a module directory with 9 sibling
    87	//! submodules — each adds an `impl<'a> WorkbookRuntime<'a>` block to
    88	//! the same struct via the sibling-module impl pattern. See
    89	//! `docs/architecture/workbook-runtime-split-design.md`.
    90	//!
    91	//! - `workbook_runtime::mod` — struct, 4 constructors, `cache_stats`,
    92	//!   `validate_sheet` / `validate_cell` shared helpers.
    93	//! - `workbook_runtime::error` — `RuntimeError` + `RecomputeFailure`
    94	//!   + `RecomputeResult` (re-exported at module root).
    95	//! - `workbook_runtime::cells` — `set_formula`, `set_value`,
    96	//!   `clear_formula`, spill helpers.
    97	//! - `workbook_runtime::recompute` — `recompute_all`, `recompute_dirty`,
    98	//!   recompute orchestrators.
    99	//! - `workbook_runtime::tables` — table mutation API.
   100	//! - `workbook_runtime::sheets` — sheet mutation API.
   101	//! - `workbook_runtime::names` — defined-name registration.
   102	//! - `workbook_runtime::formats` — format intern + cell-format binding.
   103	//! - `workbook_runtime::config` — workbook-scoped reference-mode + locale.
   104	//! - `workbook_runtime::validate` — `validate_formula` + `transaction`.
   105	//!
   106	//! Public API is unchanged: every method stays on `WorkbookRuntime`
   107	//! and `pub use error::*` re-exports the result types.
   108	
   109	pub mod aggregate_cache;
   110	pub mod calcgraph_session;
   111	pub mod env;
   112	pub mod eval_result;
   113	pub mod loader;
   114	pub mod lower;
   115	pub mod plan;
   116	pub mod plan_cache;
   117	pub mod scalar;
   118	pub mod simd;
   119	pub mod transaction;
   120	pub mod workbook_runtime;

exec
/bin/zsh -lc "nl -ba crates/ql-exec/src/lib.rs | sed -n '1,50p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
     1	//! `ql-exec` — Quantbook expression executor.
     2	//!
     3	//! Module map (Phase 0 → Phase 3.10 + Phase 4.3 V1):
     4	//!
     5	//! - `plan.rs` (Phase 0 W4-1; extended Phase 2A.1, 2A.6, 2B.4) — `ExprPlan` IR
     6	//!   including the Phase 2B.4 `AggregateNameRef` variant; `bind` /
     7	//!   `bind_with_names` resolvers with Phase 2B.4 context-aware binding
     8	//!   (`BindContext` + `is_aggregate_function`); `NameLookup` trait;
     9	//!   `BindError` variants including `UnresolvedName`,
    10	//!   `NamedTargetIs{Blank,Error}`, `NamedRangeInScalarContext`,
    11	//!   `NamedFormulaUnsupported`, `UnsupportedVariant`.
    12	//! - `plan_cache.rs` (Phase 2B.3) — bind-plan cache V0 keyed by
    13	//!   (formula text, sheet, NameTable generation); `PlanCache` lives on
    14	//!   `WorkbookRuntime`; `PlanCacheStats` for ql-profile observability.
    15	//! - `env.rs` (Phase 0; extended Phase 3.6 for `read_range`) —
    16	//!   `CellEnv` trait + `WorkbookEnv` / `MapEnv` impls. Phase 3.6
    17	//!   added `read_range(Range) -> Vec<Value>` with WorkbookEnv
    18	//!   override that clamps to `Sheet::bounds` for whole-column
    19	//!   safety. `NameLookup for NameTable` bridge.
    20	//! - `scalar.rs` (Phase 0 W4-1; extended Phase 2A.9, 2B.4, 3.6) —
    21	//!   `eval_scalar` per-cell evaluator with Excel-canon arithmetic,
    22	//!   error propagation, coercion. Phase 3.6 added
    23	//!   `eval_scalar_with_cache` entry point that routes aggregate-
    24	//!   over-named-range calls through an `AggregateCache` for cache-
    25	//!   hit short-circuit. `AggregateNameRef` outside a Function
    26	//!   context returns `#CALC!` defensively (binder normally rejects).
    27	//! - `aggregate_cache.rs` (Phase 3.6 W5-39) — `AggregateCache`
    28	//!   trait + `InMemAggregateCache` (RefCell-backed for `&self`
    29	//!   stores) + `NoAggregateCache` no-op default. Stats counters
    30	//!   (hits, misses, invalidations). Used by `CalcgraphSession`.
    31	//! - `simd.rs` (Phase 0 W4-2/W4-3) — `multiversion`-dispatched SIMD kernels;
    32	//!   OG-02 25M-cell hot path.
    33	//! - `lower.rs` (Phase 0) — `classify` + `dispatch` for the SIMD shape
    34	//!   heuristic.
    35	//! - `workbook_runtime.rs` (Phase 1 W5-10; extended Phase 2A.1, 2A.3.b,
    36	//!   2A.6, 2B.2, 2B.3, 2B.5, 2B.7; Phase 3.4 W5-37 adds
    37	//!   `recompute_dirty`) — `WorkbookRuntime` live-formula facade
    38	//!   wrapping lex → parse → bind → eval → persist + recompute_all.
    39	//!   `RecomputeResult` aggregation (no more short-circuit). Op-log
    40	//!   producer wrappers (`set_name` / `add_sheet` / `clear_formula`)
    41	//!   emit ops when an `OpLog` is attached. Phase 2B.7 added
    42	//!   `validate_formula` for IDE on-keystroke validation and
    43	//!   pre-validation guards on `add_sheet`. Phase 3.4 added
    44	//!   `recompute_dirty()` — runs Tarjan SCC over the attached
    45	//!   session's dirty set; cycled members get
    46	//!   `Value::Error(ErrorValue::Circ)`. `RuntimeError` family includes
    47	//!   `InvalidSheet`, `InvalidCell`, `ConflictingOps`, `OpLog`,
    48	//!   `Name`, `InvalidChunkRows`, `TooManySheets`.
    49	//! - `transaction.rs` (Phase 2A.2; hardened Phase 2A.6, 2A.3.b, 2B.7) —
    50	//!   `WorkbookTransaction` multi-cell batch API with eager validation,

exec
/bin/zsh -lc "rg --files docs/audits | rg '2026-05-18-tier-d1'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 1 in 0ms:
exec
/bin/zsh -lc "nl -ba docs/PHASE-4-V2-BACKLOG.md | sed -n '201,245p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
   201	### ~~D1.~~ `WorkbookRuntime` monolith split — ✅ SHIPPED 2026-05-18
   202	
   203	- **Source:** Phase 4.12 Opus-C HIGH-2.
   204	- **Design:** `docs/architecture/workbook-runtime-split-design.md`
   205	  (committed `2e8566e35f0`).
   206	- **Mechanical extractions (8 commits):**
   207	  - Step 1 (`79c1ebeefa7`): `error.rs` (RuntimeError, RecomputeFailure, RecomputeResult).
   208	  - Step 3.1 (`2761e1f88cf`): `formats.rs` (intern_format, set_cell_format, read_display).
   209	  - Step 3.2 (`be154f4918d`): `config.rs` (set_reference_mode, set_locale).
   210	  - Step 3.3 (`c37c556dd0f`): `sheets.rs` (add_sheet, rename_sheet, rewrite helper).
   211	  - Step 3.4 (`a48e985c5ec`): `names.rs` (set_name, set_sheet_scoped_name).
   212	  - Step 3.5 (`aa6e37800ff`): `tables.rs` (6 methods + reextract_table_readers).
   213	  - Step 3.6 (`c8d4cf95f70`): `recompute.rs` (recompute_all + recompute_dirty + 3 helpers).
   214	  - Step 3.7 (`de7f87c5334`): `cells.rs` (set_formula + set_value + clear_formula + 3 spill helpers).
   215	  - Step 3.8 (`69ede106a61`): `validate.rs` (validate_formula + transaction).
   216	- **Step 4 final cleanup:** Phase 2A.1 named-range tests partitioned
   217	  to `names.rs::tests`; lib.rs `# Stability` section updated; this
   218	  backlog entry marked done.
   219	- **Result:** `mod.rs` trimmed from 12,725 → 299 LOC
   220	  (**97.6% reduction**). 9 sibling submodules under
   221	  `crate::workbook_runtime`, average ~1,484 LOC each (heavily
   222	  skewed: cells.rs 5,131, recompute.rs 3,152, tables.rs 2,199;
   223	  rest under 800 LOC each).
   224	- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
   225	  re-exported types resolve from `crate::workbook_runtime` as before.
   226	- **Gates:** 4141 / 4141 tests passing across every commit (zero
   227	  drift). cargo fmt + clippy `--workspace --all-targets -D warnings`
   228	  + doc all clean.
   229	- **Side-effect fixes:** two pre-existing doc-comment
   230	  misattachments (rename_table doc → set_reference_mode in Step 3.2,
   231	  validate_cell doc → rewrite_formula_text helper in Step 3.3)
   232	  corrected by the moves.
   233	- **Audit:** parallel Codex + separate-Opus pass per the engine
   234	  audit-discipline rule — see `docs/audits/2026-05-18-tier-d1-*.md`.
   235	
   236	### D2. `ql-oplog → ql-io` reverse dependency cleanup
   237	
   238	- **Source:** Phase 4.12 Opus-C HIGH-3.
   239	- **Scope:** `ql-oplog::Op` reaches into `ql-io::CellWireValue` for
   240	  its mutation vocabulary — Phase 5 CRDT integration will want
   241	  `ql-oplog` to be the dependency floor, not depend on I/O.
   242	- **Effort:** 1-2 days. Define an intermediate type owned by
   243	  `ql-oplog` (or `ql-storage`) that `ql-io::CellWireValue` converts
   244	  to/from.
   245	

exec
/bin/zsh -lc "nl -ba docs/architecture/workbook-runtime-split-design.md | sed -n '1,40p;205,255p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
     1	---
     2	title: WorkbookRuntime split design
     3	status: DRAFT — design awaiting user sign-off
     4	phase: Tier D1 (Phase 5 prep)
     5	date: 2026-05-18
     6	predecessor: docs/phase5/entry-plan.md § Tier D
     7	backlog: docs/PHASE-4-V2-BACKLOG.md § D1
     8	audit_source: Phase 4.12 megaudit Opus-C HIGH-2
     9	---
    10	
    11	# WorkbookRuntime split — design
    12	
    13	## Current state
    14	
    15	`crates/ql-exec/src/workbook_runtime.rs` is **12 725 LOC**: 3 585
    16	LOC of implementation + 9 140 LOC of inline tests. The `impl<'a>
    17	WorkbookRuntime<'a>` block holds **39 public + private methods**
    18	covering 7 distinct concern areas. The test section runs **306
    19	tests** in one flat module.
    20	
    21	The monolith is the largest single file in the engine. It has
    22	grown organically across Phases 1, 2A.*, 2B.*, 3.*, 4.5-4.8.
    23	Phase 4.12 megaudit Opus-C HIGH-2 flagged it as a Phase 5 prep
    24	blocker — adding CRDT-aware mutation paths in Phase 5 will
    25	roughly double the call sites in cell-mutation methods, and a
    26	13 000+ LOC file alongside single-writer paths is hard to review.
    27	
    28	## Pain points (concrete)
    29	
    30	1. **Reviewer load**: opening `workbook_runtime.rs` in any editor
    31	   pages a 12 725-line file. Diff review for any mutation-method
    32	   change wades through unrelated table / sheet / format code.
    33	2. **Concern boundaries are implicit**: there's no module-level
    34	   structure separating "cell mutation" from "table mutation"
    35	   from "recompute pipeline" from "format API". A new
    36	   contributor reading `set_formula` (lines 540–957, 417 LOC of
    37	   one function) has no signpost telling them this is the
    38	   cell-mutation surface, not the format surface.
    39	3. **Test-file growth dominates**: 9 140 LOC of tests
    40	   (~72 % of the file) means a 1-LOC impl change scrolls past
   205	  long methods that share private state (e.g.
   206	  `set_formula → write_spill → reextract_spill_footprint_readers`)
   207	  may surface borrow-checker issues that the single-file form
   208	  hid. Mitigation: each submodule's `impl` adds methods to the
   209	  same struct — no new visibility boundaries. If borrow issues
   210	  arise, the fix is usually a `let _ = &mut self.field;`
   211	  reborrow pattern.
   212	- **R3 — Doc-comment links break.** Some `[`fn_name`]` doc
   213	  links inside `workbook_runtime.rs` may break when the target
   214	  moves to a sibling submodule. Mitigation: `cargo doc
   215	  --workspace --no-deps` runs after each step; any warning
   216	  surfaces the broken link.
   217	- **R4 — Test-cluster mis-categorization.** A test that touches
   218	  multiple concern areas (e.g. cell-mutation triggering a
   219	  table-readers reextract) might fit two destinations. Default:
   220	  keep with the method-under-test's submodule; cross-reference
   221	  in a comment.
   222	
   223	## Effort estimate
   224	
   225	- Step 1 (error.rs): 1-2 hours.
   226	- Step 2 (file → module dir): 30 minutes.
   227	- Step 3 (8 submodule moves): 0.5-1 day each = 4-8 days total.
   228	  Larger modules (`cells.rs`, `tables.rs`, `recompute.rs`) take
   229	  the upper bound; smaller (`config.rs`, `formats.rs`,
   230	  `sheets.rs`) the lower.
   231	- Step 4 (final cleanup): 1 hour.
   232	
   233	**Total: 5-10 days** of mechanical work + audit cycles.
   234	
   235	## Acceptance
   236	
   237	After D1 closure:
   238	- `crates/ql-exec/src/workbook_runtime/mod.rs` is ≤ 250 LOC.
   239	- No submodule exceeds ~1 200 LOC (impl + tests).
   240	- `cargo test --workspace` passes exactly the same test count
   241	  as pre-split (4 141 today).
   242	- `cargo doc --workspace --no-deps` warning count unchanged.
   243	- Public API surface byte-for-byte identical (verify with
   244	  `cargo public-api` or equivalent if available).
   245	
   246	## Audit checkpoint
   247	
   248	Run a parallel Codex + separate-Opus audit AFTER step 3 (all
   249	submodules moved). Focus areas:
   250	- Did any test move land in the wrong submodule?
   251	- Are there cross-module circular dependencies?
   252	- Did borrow-checker fixes introduce subtle aliasing?
   253	- Are the module-level doc comments coherent across the
   254	  surface?
   255	

exec
/bin/zsh -lc "nl -ba docs/architecture/workbook-runtime-split-design.md | sed -n '50,130p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
    50	Move the file `src/workbook_runtime.rs` to `src/workbook_runtime/mod.rs`,
    51	then move method groups into sibling submodules. The `WorkbookRuntime`
    52	struct itself + its 4 constructors stay in `mod.rs`. Each submodule
    53	declares an `impl<'a> WorkbookRuntime<'a> { ... }` block adding
    54	methods to the same struct.
    55	
    56	### Module layout
    57	
    58	| Module | LOC est. | Contents |
    59	|---|---|---|
    60	| `mod.rs` (core) | ~200 | `WorkbookRuntime` struct, 4 constructors, `cache_stats`, struct docs |
    61	| `error.rs` | ~270 | `RuntimeError`, `RecomputeFailure`, `RecomputeResult`, `is_complete`, `failed_count`, `From<LexError>`, `From<BindError>`, `validate_sheet` helper |
    62	| `cells.rs` | ~1 060 | `set_formula`, `set_value`, `clear_formula`, `write_spill`, `write_anchor_error`, `reextract_spill_footprint_readers` |
    63	| `names.rs` | ~140 | `set_name`, `set_sheet_scoped_name` |
    64	| `tables.rs` | ~810 | `create_table`, `drop_table`, `rename_table`, `rename_column`, `resize_table`, `reextract_table_readers` |
    65	| `sheets.rs` | ~165 | `add_sheet`, `rename_sheet` |
    66	| `formats.rs` | ~150 | `intern_format`, `set_cell_format`, `read_display` |
    67	| `config.rs` | ~40 | `set_reference_mode`, `set_locale` |
    68	| `recompute.rs` | ~780 | `recompute_all`, `recompute_dirty`, `try_recompute_one_cached`, `try_recompute_with_aggregate_cache`, `try_recompute_with_simd_profile` |
    69	| `validate.rs` | ~100 | `validate_formula`, `transaction` |
    70	
    71	Total impl: ~3 715 LOC across 10 files. Average submodule size
    72	~370 LOC — review-friendly.
    73	
    74	### Tests
    75	
    76	**Phase 1 — split tests alongside their impl module.** Each
    77	submodule gets its own `#[cfg(test)] mod tests`. Test partitions
    78	already aligned with section banners in the current file (e.g.
    79	"===== Phase 2A.3.b — op-log producer wiring =====" already
    80	separates op-log tests; "===== W5-118 (Phase 4.8.H) — table
    81	mutation API =====" already separates table tests).
    82	
    83	Test categorization plan (preliminary mapping, refined during
    84	the mechanical pass):
    85	
    86	| Test cluster | LOC | Destination |
    87	|---|---|---|
    88	| set_formula | ~145 | `cells.rs::tests` |
    89	| set_value | ~250 | `cells.rs::tests` |
    90	| recompute_all | ~810 (12 sections) | `recompute.rs::tests` |
    91	| Named-range resolution (Phase 2A.1) | ~210 | `names.rs::tests` |
    92	| Op-log producer wiring (2A.3.b) | ~290 | `cells.rs::tests` (op-log integration tested via cells) |
    93	| RecomputeResult contract (2B.2) | ~135 | `recompute.rs::tests` |
    94	| Bind-plan cache (2B.3) | ~160 | `recompute.rs::tests` |
    95	| Named-range aggregate prep (2B.4) | ~140 | `recompute.rs::tests` |
    96	| Input validation + dry-run (2B.7) | ~560 | `cells.rs::tests` + `validate.rs::tests` |
    97	| Op-log producer coverage (2B.5) | ~270 | `cells.rs::tests` |
    98	| Calcgraph runtime integration (3.1) | ~1 540 | `recompute.rs::tests` + `cells.rs::tests` (mostly recompute hooks) |
    99	| Format runtime wrappers (W5-82+) | ~410 | `formats.rs::tests` |
   100	| Cross-sheet (W5-90) | ~85 | `cells.rs::tests` (cross-sheet refs in set_formula) |
   101	| rename_sheet (W5-91) | ~100 | `sheets.rs::tests` |
   102	| set_sheet_scoped_name (W5-92) | ~100 | `names.rs::tests` |
   103	| Spill writeback (W5-103.*) | ~1 800 | `cells.rs::tests` |
   104	| W5-103 megaudit closures | ~330 | `cells.rs::tests` |
   105	| set_value spill invalidation (W5-104) | ~165 | `cells.rs::tests` |
   106	| SEQUENCE / TRANSPOSE / FILTER / array shape (W5-106/107/N) | ~600 | `cells.rs::tests` |
   107	| structured-ref through aggregate (W5-116) | ~145 | `tables.rs::tests` |
   108	| create_table / drop_table (W5-118) | ~35 | `tables.rs::tests` |
   109	| spill-anchor uniform check (W5-124) | ~100 | `cells.rs::tests` |
   110	| footprint-bounds (W5-125) | ~340 | `cells.rs::tests` |
   111	| rename_table / rename_column / resize_table (W5-119/121/122) | ~1 050 | `tables.rs::tests` |
   112	| Tier C1 cycle detection (this session) | ~215 | `recompute.rs::tests` |
   113	
   114	**Phase 2 (deferred)**: if any submodule's `tests` block exceeds
   115	~2 000 LOC after the split, consider further sub-splitting per
   116	test cluster.
   117	
   118	### Submodule contract
   119	
   120	Each submodule (`cells.rs`, `tables.rs`, etc.) imports nothing
   121	new. The `impl<'a> WorkbookRuntime<'a>` block adds methods to
   122	the same struct; access to private fields (`self.workbook`,
   123	`self.oplog`, `self.plan_cache`, `self.graph`, `self.format_cache`)
   124	is granted by sibling-module visibility within
   125	`crate::workbook_runtime`.
   126	
   127	Public API surface (`pub use workbook_runtime::WorkbookRuntime`
   128	from `crates/ql-exec/src/lib.rs`) is unchanged. Existing callers
   129	(test code, replay, loader, bindings) require zero edits.
   130	

exec
/bin/zsh -lc "rg -n \"use crate::workbook_runtime::\\*|use crate::workbook_runtime::\\{|use super::\\{|use super::\\*\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/validate.rs:28:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/validate.rs:147:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/tables.rs:35:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/tables.rs:868:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/config.rs:17:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/names.rs:23:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/names.rs:158:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/sheets.rs:22:use super::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/sheets.rs:233:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:189:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/recompute.rs:36:use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/recompute.rs:822:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:40:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:1126:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

exec
/bin/zsh -lc "rg -n \"workbook_runtime\\.rs|workbook_runtime::mod|DRAFT|≤ 250|No submodule exceeds|tests block exceeds|2026-05-18-tier-d1\" docs/architecture/workbook-runtime-split-design.md docs/PHASE-4-V2-BACKLOG.md crates/ql-exec/src/lib.rs crates/ql-exec/src/workbook_runtime/mod.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/lib.rs:35://! - `workbook_runtime.rs` (Phase 1 W5-10; extended Phase 2A.1, 2A.3.b,
crates/ql-exec/src/lib.rs:91://! - `workbook_runtime::mod` — struct, 4 constructors, `cache_stats`,
crates/ql-exec/src/workbook_runtime/mod.rs:88://   it. mod.rs is now down to <600 LOC — close to the ≤ 250 Step 4
docs/PHASE-4-V2-BACKLOG.md:131:- **Regression tests:** 6 in `crates/ql-exec/src/workbook_runtime.rs::tests`:
docs/PHASE-4-V2-BACKLOG.md:170:  `crates/ql-exec/src/workbook_runtime.rs::tests`.
docs/PHASE-4-V2-BACKLOG.md:234:  audit-discipline rule — see `docs/audits/2026-05-18-tier-d1-*.md`.
docs/architecture/workbook-runtime-split-design.md:3:status: DRAFT — design awaiting user sign-off
docs/architecture/workbook-runtime-split-design.md:15:`crates/ql-exec/src/workbook_runtime.rs` is **12 725 LOC**: 3 585
docs/architecture/workbook-runtime-split-design.md:30:1. **Reviewer load**: opening `workbook_runtime.rs` in any editor
docs/architecture/workbook-runtime-split-design.md:50:Move the file `src/workbook_runtime.rs` to `src/workbook_runtime/mod.rs`,
docs/architecture/workbook-runtime-split-design.md:150:Rename `src/workbook_runtime.rs` to `src/workbook_runtime/mod.rs`.
docs/architecture/workbook-runtime-split-design.md:213:  links inside `workbook_runtime.rs` may break when the target
docs/architecture/workbook-runtime-split-design.md:238:- `crates/ql-exec/src/workbook_runtime/mod.rs` is ≤ 250 LOC.
docs/architecture/workbook-runtime-split-design.md:239:- No submodule exceeds ~1 200 LOC (impl + tests).

exec
/bin/zsh -lc "rg -n \"TODO|FIXME|HACK|workbook_runtime\\.rs:|super::super::tests|inline test module|moved to|can't call self\\.reextract\" crates/ql-exec/src/workbook_runtime/*.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/tables.rs:845:                    // workbook_runtime.rs:3266 will produce #NAME?.
crates/ql-exec/src/workbook_runtime/tables.rs:2111:    // (Tier D1 Step 3.2: W5-146 config tests moved to
crates/ql-exec/src/workbook_runtime/mod.rs:91://   the inline test module).
crates/ql-exec/src/workbook_runtime/mod.rs:129:/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
crates/ql-exec/src/workbook_runtime/mod.rs:157:// (Tier D1 Step 1: error/result types moved to error.rs above —
crates/ql-exec/src/workbook_runtime/mod.rs:289:    // validation, and transaction methods have been moved to sibling
crates/ql-exec/src/workbook_runtime/recompute.rs:458:                            // Inlined (can't call self.reextract_spill_footprint_readers
crates/ql-exec/src/workbook_runtime/recompute.rs:1976:        // Value moved to user lane.
crates/ql-exec/src/workbook_runtime/recompute.rs:3151:    // (Tier D1 Step 3.1: W5-82 format tests moved to formats.rs::tests.)
crates/ql-exec/src/workbook_runtime/config.rs:78:    // Mirror of `super::super::tests::make_runtime_workbook` — the
crates/ql-exec/src/workbook_runtime/cells.rs:957:    // (Tier D1 Step 3.3: add_sheet / rename_sheet moved to
crates/ql-exec/src/workbook_runtime/cells.rs:2086:    // (Tier D1 Step 3.3: W5-91 rename_sheet tests moved to
crates/ql-exec/src/workbook_runtime/cells.rs:2090:    //  moved to names.rs / sheets.rs sibling submodules.)

exec
/bin/bash -lc "for f in crates/ql-exec/src/workbook_runtime/*.rs; do printf '%s ' \""'$f"; rg -c "#'"\\[test\\]\" \""'$f"; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/cells.rs 137
crates/ql-exec/src/workbook_runtime/config.rs 4
crates/ql-exec/src/workbook_runtime/error.rs crates/ql-exec/src/workbook_runtime/formats.rs 13
crates/ql-exec/src/workbook_runtime/mod.rs crates/ql-exec/src/workbook_runtime/names.rs 16
crates/ql-exec/src/workbook_runtime/recompute.rs 70
crates/ql-exec/src/workbook_runtime/sheets.rs 8
crates/ql-exec/src/workbook_runtime/tables.rs 42
crates/ql-exec/src/workbook_runtime/validate.rs 16

exec
/bin/zsh -lc "rg -n \"workbook_runtime\\.rs:[0-9]+|:[0-9]{3,}|line [0-9]{3,}|lines [0-9]\" crates/ql-exec/src/workbook_runtime/*.rs crates/ql-exec/src/lib.rs docs/architecture/workbook-runtime-split-design.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
docs/architecture/workbook-runtime-split-design.md:36:   contributor reading `set_formula` (lines 540–957, 417 LOC of
crates/ql-exec/src/workbook_runtime/tables.rs:845:                    // workbook_runtime.rs:3266 will produce #NAME?.
docs/PHASE-4-V2-BACKLOG.md:77:  just `ReferenceArg`). Touches `plan.rs:768-777`.
docs/PHASE-4-V2-BACKLOG.md:92:- **Scope:** parser `crates/ql-formula-syntax/src/parser.rs:512-516`
crates/ql-exec/src/workbook_runtime/cells.rs:1107:            // The comment at line 1632 marked this as Phase 4.7.K
crates/ql-exec/src/workbook_runtime/cells.rs:4425:    /// (bind-error → cell-value mapping at recompute_dirty:3266).
crates/ql-exec/src/workbook_runtime/recompute.rs:66:        //   `recompute_dirty`'s cycle-first ordering (see line 3160+
crates/ql-exec/src/workbook_runtime/recompute.rs:546:                        // the `plan.rs:260` UnknownTable docstring.
crates/ql-exec/src/workbook_runtime/recompute.rs:756:        // identical ordering at line 621. Pre-fix ordering was

exec
/bin/zsh -lc "sed -n '1088,1115p' crates/ql-exec/src/workbook_runtime/cells.rs && sed -n '736,762p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
        if let Some(shape) = dissolved_shape {
            if let Some(g) = self.graph.as_deref_mut() {
                for dr in 0..shape.rows {
                    for dc in 0..shape.cols {
                        if dr == 0 && dc == 0 {
                            continue;
                        }
                        g.on_set_value(sheet, row + dr, col + dc);
                    }
                }
            }
            // **W5-108 (Phase 4.7.O) — Codex HIGH BLOCKER closure**:
            // re-extract readers indexed under the dissolved footprint
            // so producer-alias deps re-route back to literal cell
            // addresses. Mirrors `set_value`'s parallel call at the
            // dissolved-self path. Without this, a reader `D1=B1`
            // (where B1 was a spill target of cleared anchor A1)
            // keeps a dep on A1 — a future `set_value(B1, 5)` would
            // NOT dirty D1, since D1's graph dep no longer matches B1.
            // The comment at line 1632 marked this as Phase 4.7.K
            // work; 4.7.O closes it.
            self.reextract_spill_footprint_readers(sheet, row, col, Some(shape), None);
        }

        Ok(())
    }
}

        // materializes via `write_spill` — instead of collapsing to
        // `#CALC!` (which `eval_scalar_with_cache` returns per the
        // scalar-context contract at scalar.rs:95).
        //
        // Without this, op-log replay of `PutFormula { text: "{1,2,3}" }`
        // followed by `recompute_all` would write #CALC! at the
        // anchor instead of spilling — design § 7.3/§ 12.3
        // "load → recompute re-derives spills" contract broken,
        // persistence layer (4.7.L) hard-blocked.
        //
        // The clear-old + write_spill sequence mirrors set_formula's
        // 4.7.J.2 pattern. Unlike set_formula, we DO NOT fire
        // on_set_formula / on_set_value / re-extract hooks: recompute
        // doesn't change a formula's identity, only its computed
        // value. Downstream readers were already dirtied by whatever
        // made THIS formula dirty in the first place.
        //
        // **W5-108 (Phase 4.7.O) — Codex MEDIUM-5 closure**: clear
        // the OLD spill footprint BEFORE eval, matching design § 10.3
        // step 4 ("clear-old-before-eval") and `set_formula`'s
        // identical ordering at line 621. Pre-fix ordering was
        // eval → clear → write, which let a formula's eval observe
        // its own OLD spill-target computed overlays through indirect
        // reads (named ranges, aggregates). Direct self-reads create
        // a producer-alias self-loop (Tarjan → #CIRC!) so the gap was
        // narrow, but the design contract is "clear-before-eval" and
        // bringing the code into alignment removes a latent

exec
/bin/zsh -lc 'rg -n "validate_cell|validate_sheet" crates/ql-exec/src/transaction.rs crates/ql-exec/src/workbook_runtime/*.rs crates/ql-exec/src/*.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
crates/ql-exec/src/workbook_runtime/sheets.rs:101:            .validate_sheet_name(&name)
crates/ql-exec/src/workbook_runtime/sheets.rs:134:    /// duplicate new names via `Workbook::validate_sheet_name`.
crates/ql-exec/src/workbook_runtime/sheets.rs:166:            self.workbook.validate_sheet_name(&new_name)?;
crates/ql-exec/src/workbook_runtime/validate.rs:28:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/validate.rs:96:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/validate.rs:185:    /// `RuntimeError::InvalidSheet` / `InvalidCell` from `validate_cell`.
crates/ql-exec/src/lib.rs:92://!   `validate_sheet` / `validate_cell` shared helpers.
crates/ql-exec/src/transaction.rs:45:use crate::workbook_runtime::{validate_cell, RuntimeError};
crates/ql-exec/src/transaction.rs:165:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/transaction.rs:203:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/mod.rs:89://   final-cleanup target (remaining is constructors + validate_sheet
crates/ql-exec/src/workbook_runtime/mod.rs:90://   / validate_cell helpers + Phase 2A.1 named-range tests still in
crates/ql-exec/src/workbook_runtime/mod.rs:107:pub(crate) fn validate_sheet(workbook: &Workbook, sheet: SheetId) -> Result<(), RuntimeError> {
crates/ql-exec/src/workbook_runtime/mod.rs:128:/// helper that lived between this comment and `validate_cell`. The
crates/ql-exec/src/workbook_runtime/mod.rs:131:pub(crate) fn validate_cell(
crates/ql-exec/src/workbook_runtime/mod.rs:137:    validate_sheet(workbook, sheet)?;
crates/ql-exec/src/workbook_runtime/mod.rs:292:    // `cache_stats`, and `validate_sheet` / `validate_cell` shared
crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/formats.rs:82:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/formats.rs:103:            .expect("validate_cell guards sheet bounds")
crates/ql-exec/src/transaction.rs:45:use crate::workbook_runtime::{validate_cell, RuntimeError};
crates/ql-exec/src/transaction.rs:165:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/transaction.rs:203:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/cells.rs:40:use super::{validate_cell, RuntimeError, WorkbookRuntime};
crates/ql-exec/src/workbook_runtime/cells.rs:62:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/cells.rs:777:        validate_cell(self.workbook, sheet, row, col)?;
crates/ql-exec/src/workbook_runtime/cells.rs:978:        validate_cell(self.workbook, sheet, row, col)?;

exec
/bin/zsh -lc "nl -ba crates/ql-exec/src/workbook_runtime/cells.rs | sed -n '1,30p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 0ms:
     1	//! Cell mutation API for `WorkbookRuntime`.
     2	//!
     3	//! Tier D1 Step 3.7 (2026-05-18): extracted from `mod.rs` per
     4	//! `docs/architecture/workbook-runtime-split-design.md`. Six
     5	//! producer-side cell-mutation methods + 3 private spill helpers.
     6	//! Largest method-LOC submodule: `set_formula` alone is 417 LOC.
     7	//! Pure code move; no behavior change.
     8	//!
     9	//! Methods:
    10	//! - [`WorkbookRuntime::set_formula`] — lex → parse → bind → eval →
    11	//!   put_at + put_formula. Phase 1 W5-10 + many follow-up
    12	//!   refinements (W5-103 spill writeback, W5-106 SEQUENCE,
    13	//!   W5-107 TRANSPOSE/FILTER, W5-147 canonicalization).
    14	//! - [`WorkbookRuntime::set_value`] — literal write with op-log
    15	//!   emission and spill invalidation (W5-104).
    16	//! - [`WorkbookRuntime::clear_formula`] — strip a cell's formula
    17	//!   association; Phase 2B.5 op-log producer with idempotency.
    18	//! - `write_spill` (private) — write the spill body for array-
    19	//!   returning formulas; runs `clear_spill_if_present` first to
    20	//!   dissolve any pre-existing spill at the anchor.
    21	//! - `write_anchor_error` (private) — write `#SPILL!` (or other
    22	//!   error sigil) at an anchor when spill cannot proceed.
    23	//! - `reextract_spill_footprint_readers` (private) — re-extract
    24	//!   calc-graph deps for every formula reading cells inside a
    25	//!   dissolved or transitioned spill footprint.
    26	
    27	use std::sync::Arc;
    28	
    29	use ql_formula_syntax::{lex, lex_with, parse, print_with, FormulaSite};
    30	use ql_io::CellWireValue;

codex
No HIGH findings. I found no missing `pub(super)` cases: `write_spill` is the only private-to-sibling call site, and it is already raised. Test names also match exactly: 306 old vs 306 new, no missing/extra/duplicate `#[test] fn` names.

**Punch List**
- **M** [validate.rs:50](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:50): `validate_formula` has the old `recompute_all` doc block attached above it. This also leaves [recompute.rs:39](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:39) without its public method doc. Move lines 50-70 to `recompute_all`; keep only the Phase 2B.7 dry-run docs on `validate_formula`.

- **M** [mod.rs:47](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:47): `mod.rs` misses the ≤250 LOC acceptance target mostly because of a 45-line extraction-history block plus stale tail comments. Remove/move this history to the design/backlog; that alone likely gets `mod.rs` under target. If code must move too, `validate_sheet`/`validate_cell` can move to `validate.rs` with a `pub(crate) use`.

- **L** [mod.rs:107](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:107): `validate_sheet` is `pub(crate)` but is only called by `validate_cell`; the comment says `WorkbookTransaction` needs it, but transaction imports `validate_cell`. Make `validate_sheet` private or move it with `validate_cell`.

- **L** [validate.rs:163](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:163): `add_sheet_rejects_zero_chunk_rows` belongs with `sheets.rs::tests`, not `validate.rs::tests`.

- **L** [validate.rs:187](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:187): `clear_formula_rejects_invalid_sheet` / `clear_formula_rejects_invalid_cell` are `clear_formula` owner tests; move them to `cells.rs::tests`.

- **L** [tables.rs:2122](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2122): W5-147 `set_formula` canonicalization tests live in `tables.rs`. Move them to `cells.rs`; move [tables.rs:2182](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2182) `set_reference_mode_op_round_trips_through_replay` to `config.rs`.

- **L** [cells.rs:4388](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4388): pure table API tests (`drop_table_removes_metadata...`, `drop_table_missing_errors`) remain in `cells.rs`; move to `tables.rs`. The spill/table boundary tests around [cells.rs:4093](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4093) are acceptable only if intentionally kept as spill integration tests.

- **L** [names.rs:387](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:387): `RuntimeError` display tests belong in `error.rs::tests`; same for [validate.rs:699](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:699) `RecomputeResult` contract.

- **L** [cells.rs:18](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:18): module docs still call `write_spill` private, but it is `pub(super)` at [cells.rs:624](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:624). Update the doc.

- **L** [lib.rs:35](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs:35): module map still says `workbook_runtime.rs`; update to `workbook_runtime/`. Also [lib.rs:91](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs:91) says `workbook_runtime::mod`, which is not an actual public path.

- **L** [tables.rs:845](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:845), [cells.rs:4425](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4425): comments still cite old `workbook_runtime.rs:3266` line numbers. Replace with `recompute_dirty` / bind-error mapping references.

- **L** [config.rs:78](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:78): test helper comment references the old `super::super::tests::make_runtime_workbook`; that module is gone. Rewrite as “local copy of the old shared fixture.”

- **L** [docs/architecture/workbook-runtime-split-design.md:3](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/workbook-runtime-split-design.md:3): design still says DRAFT and has unmet acceptance at lines 237-239 (`mod.rs ≤250`, no submodule >1200). Update status or document accepted deviations.

- **L** [docs/PHASE-4-V2-BACKLOG.md:233](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:233): references `docs/audits/2026-05-18-tier-d1-*.md`, but no matching files exist. Add the audit artifacts or remove/adjust the link.

Other checks: imports are minimal under clippy and manual scan; no wildcard `use crate::workbook_runtime::*` patterns are present. The duplicated `make_runtime_workbook` helpers I found are semantically identical to the old helper (`Workbook::new(); add_sheet("S")`).
tokens used
176,238
No HIGH findings. I found no missing `pub(super)` cases: `write_spill` is the only private-to-sibling call site, and it is already raised. Test names also match exactly: 306 old vs 306 new, no missing/extra/duplicate `#[test] fn` names.

**Punch List**
- **M** [validate.rs:50](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:50): `validate_formula` has the old `recompute_all` doc block attached above it. This also leaves [recompute.rs:39](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:39) without its public method doc. Move lines 50-70 to `recompute_all`; keep only the Phase 2B.7 dry-run docs on `validate_formula`.

- **M** [mod.rs:47](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:47): `mod.rs` misses the ≤250 LOC acceptance target mostly because of a 45-line extraction-history block plus stale tail comments. Remove/move this history to the design/backlog; that alone likely gets `mod.rs` under target. If code must move too, `validate_sheet`/`validate_cell` can move to `validate.rs` with a `pub(crate) use`.

- **L** [mod.rs:107](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:107): `validate_sheet` is `pub(crate)` but is only called by `validate_cell`; the comment says `WorkbookTransaction` needs it, but transaction imports `validate_cell`. Make `validate_sheet` private or move it with `validate_cell`.

- **L** [validate.rs:163](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:163): `add_sheet_rejects_zero_chunk_rows` belongs with `sheets.rs::tests`, not `validate.rs::tests`.

- **L** [validate.rs:187](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:187): `clear_formula_rejects_invalid_sheet` / `clear_formula_rejects_invalid_cell` are `clear_formula` owner tests; move them to `cells.rs::tests`.

- **L** [tables.rs:2122](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2122): W5-147 `set_formula` canonicalization tests live in `tables.rs`. Move them to `cells.rs`; move [tables.rs:2182](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2182) `set_reference_mode_op_round_trips_through_replay` to `config.rs`.

- **L** [cells.rs:4388](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4388): pure table API tests (`drop_table_removes_metadata...`, `drop_table_missing_errors`) remain in `cells.rs`; move to `tables.rs`. The spill/table boundary tests around [cells.rs:4093](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4093) are acceptable only if intentionally kept as spill integration tests.

- **L** [names.rs:387](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:387): `RuntimeError` display tests belong in `error.rs::tests`; same for [validate.rs:699](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:699) `RecomputeResult` contract.

- **L** [cells.rs:18](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:18): module docs still call `write_spill` private, but it is `pub(super)` at [cells.rs:624](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:624). Update the doc.

- **L** [lib.rs:35](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs:35): module map still says `workbook_runtime.rs`; update to `workbook_runtime/`. Also [lib.rs:91](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs:91) says `workbook_runtime::mod`, which is not an actual public path.

- **L** [tables.rs:845](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:845), [cells.rs:4425](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4425): comments still cite old `workbook_runtime.rs:3266` line numbers. Replace with `recompute_dirty` / bind-error mapping references.

- **L** [config.rs:78](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:78): test helper comment references the old `super::super::tests::make_runtime_workbook`; that module is gone. Rewrite as “local copy of the old shared fixture.”

- **L** [docs/architecture/workbook-runtime-split-design.md:3](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/workbook-runtime-split-design.md:3): design still says DRAFT and has unmet acceptance at lines 237-239 (`mod.rs ≤250`, no submodule >1200). Update status or document accepted deviations.

- **L** [docs/PHASE-4-V2-BACKLOG.md:233](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:233): references `docs/audits/2026-05-18-tier-d1-*.md`, but no matching files exist. Add the audit artifacts or remove/adjust the link.

Other checks: imports are minimal under clippy and manual scan; no wildcard `use crate::workbook_runtime::*` patterns are present. The duplicated `make_runtime_workbook` helpers I found are semantically identical to the old helper (`Workbook::new(); add_sheet("S")`).
