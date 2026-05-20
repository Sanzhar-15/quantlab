Reading prompt from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e45b3-7d80-7b63-9832-876d2cde10cf
--------
user
# Codex audit — Phase 5.3 step 3 (rename-repair pass, CORE 5.3 work) 2026-05-20

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: commit `e76a9ce5499` (step 3 ship) + `4222d11fe7b` (Cargo.lock update).
Predecessor chain: `f426683fee0` (step 2 audit closure) → `1ed2bbba78a` (step 2 ship) → step 1 chain.

**Workspace tests**: 4317 passing / 0 failed (+10 net from step 3) with `--test-threads=1`. fmt + clippy: clean.

This is the **CORE 5.3 work** — the rename-repair pass that closes the D-3 V1 limitation. Step 1 + 2 were prep; step 3 ships the actual user-visible improvement.

## What step 3 did

**NEW**: `ql_collab::repair_sheet_rename_chain(workbook, log) -> Result<RepairReport, OpLogError>`. Caller invokes it between `replay_into` and `recompute_all` to rewrite formula text referencing pre-rename sheet names.

**Algorithm (chain-based, NOT causality-aware — audit-locked design D-5.3-2)**:
1. Walk op log (including `BatchCommit`-nested), collect `Op::RenameSheet.old_name` per sheet id.
2. Build (canonical_historic → current_display_name) rules; skip pairs where canonical historic matches canonical current (no-op).
3. Walk all formulas via `Workbook::iter_formulas`, attempt rewrite via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr` helper.
4. Apply collected updates via `Workbook::put_formula`.

**Files**:
- `crates/ql-collab/src/repair.rs` (NEW, ~225 LOC) — the module.
- `crates/ql-collab/src/lib.rs` — re-exports.
- `crates/ql-collab/Cargo.toml` — added `ql-formula-syntax` + `ql-types` deps.
- `crates/ql-collab/tests/repair_renames.rs` (NEW, ~470 LOC, 10 tests).
- `crates/ql-exec/Cargo.toml` — added `ql-collab` as DEV-DEP.
- `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs` row 7 — pre-fix #NAME? assertion replaced with post-repair Value::Number(42.0) assertion.
- `docs/architecture/crdt-data-model.md` row 7 — marked step 3 shipped.

**Documented V1 limitations (in module docstring)**:
1. Cross-sheet historic-name ambiguity: if two sheets had the same canonical name at different chain points, the rewrite picks "later in iteration."
2. Concurrent-rename intermediate names lost: if step 2's last-wins forced a rename to apply "from" a name different than the wire's `old_name`, formulas referencing that intermediate may not be repaired.
3. RenameTable + RenameColumn not yet handled (step 4).

## What I want you to audit — ruthlessly adversarial

Previous 4 cycles were DIVERGENT-HIGH where Codex caught real bugs Opus PASSED on. This step is COMPLEX; I want sharp findings.

### Correctness / algorithm

1. **The "current display name" choice for rewrite target** — phase 2 of the algorithm reads `workbook.sheet(id).name()` AFTER replay. If the workbook went through step 2's auto-disambiguation (e.g. sheet 1 wanted "X" but ended up "X(2)"), the rewrite target is `X(2)` not the wire-`new_name` `X`. Is this correct? What if a formula referenced `X` expecting it to bind to sheet 0 (which IS named X)? My test `repair_handles_step2_auto_disambiguation_suffix` covers this — verify it pins the right semantic.

2. **The cross-sheet ambiguity limitation**: if two sheets had the same canonical name historically, the rules vec has 2 entries with the same `old_canonical` key. My loop applies all rules in iteration order. The second rule's rewrite would not match (text already rewritten by first). Is the "later in iteration wins" behavior I documented actually true, or does it depend on rule ordering?

3. **Idempotency**: `repair_handles_step2_auto_disambiguation_suffix` formula post-repair is `'X(2)'!B1` (single-quoted because of `(`). Run repair AGAIN on this: would the helper try to match `'X(2)'!B1` against historic `S3`? The lexer would tokenize `'X(2)'` as a quoted sheet ref; rewrite against `S3` would not match. So idempotent. But: what if a formula already has `X(2)!B1` (without quotes — invalid syntax) — would lex+parse fail and the helper return None? That's safe but should be verified.

4. **The `iter_formulas` borrow**: I collect into `to_update: Vec<(SheetId, RowId, ColId, String)>` before applying updates because `iter_formulas` borrows immutably. Is there a more idiomatic approach? Memory-wise, formulas are usually short; the collect should be fine.

5. **`put_formula` recompute interaction**: `Workbook::put_formula` updates `formula_cells` but does NOT trigger recompute. The caller does `recompute_all` AFTER repair. Is the cell's STALE value (from pre-repair recompute, if there was one) a concern? In normal flow: replay → repair → recompute. recompute then re-evaluates all formulas. So stale values are overwritten. Verify this flow is correct.

### Edge cases

6. **Empty `old_name`**: an op with `old_name: ""` (malformed) — does `Workbook::canonical_sheet_name("")` produce something sensible? Does the rewrite helper handle empty canonical correctly?

7. **A sheet renamed away from its initial name + renamed back, with peer C writing during the intermediate phase**: scenario like `repair_handles_rename_back_intermediate_reference` — should work because S2 is historic. But what if peer C writes WHILE the sheet was S2, peer A then renames back to S? Test covers; verify the assertion is right.

8. **`Op::SetCellFormat` referencing a renamed sheet** — no, SetCellFormat doesn't carry sheet name. Skip.

9. **Formula text that contains the historic name as a SUBSTRING but not a ref**: e.g., formula `="Sheet1 was renamed"` (a string literal containing "Sheet1"). Does the helper correctly skip text not parseable as a sheet ref? The lex+parse approach should handle this.

10. **Sheets renamed multiple times in the same `BatchCommit`**: my recursion into BatchCommit collects all old_names. If a BatchCommit contains `RenameSheet { id: 0, S → S2 }` and `RenameSheet { id: 0, S2 → S3 }`, both get collected. Historic = {S, S2}, current after replay = S3. Repair rewrites both S and S2 → S3. Correct?

### API / architecture

11. **`OpLogError` propagation**: the function returns `Result<RepairReport, OpLogError>`. The only error path is iterating the log. Is there a case where the rewrite itself could fail in a way that should surface as an error? My docstring says "formulas that fail to parse are skipped silently." Is silently-skipping a no-fallback violation per CLAUDE.md?

12. **`Cargo.lock` separate commit**: I committed Cargo.lock as a follow-up to the ship commit (rather than including it in the ship). Is this an issue for repo cleanliness?

13. **ql-collab as dev-dep of ql-exec**: I added this for the row 7 test. Confirm this doesn't introduce a Cargo cycle and is the right architectural call.

14. **Helper duplication**: `rewrite_formula_with_rename` in `crates/ql-collab/src/repair.rs` is a near-mirror of `rewrite_formula_text_for_sheet_rename` in `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Should one be extracted to `ql-formula-syntax` (where the underlying ast helper lives) and both call sites use the shared version? Or is the duplication acceptable?

### Tests

15. **The 10 new tests**: for each, ask "if a future regression broke the PROPERTY this test claims to pin, would the assertion catch it?" In particular: `repair_with_no_renames_is_noop`, `repair_leaves_unrelated_formulas_unchanged`, `repair_is_idempotent` — any way these pass while the underlying semantic is broken?

16. **`repair_converges_across_merge_directions`**: I assert formula text matches across A-merges-B vs B-merges-A. But the formula `S2!A1` is the canonical post-repair text REGARDLESS of merge direction (because both peers agree on current name = "S2"). Is this test actually testing something Loro-specific, or is it tautological under the chain-based algorithm?

17. **Row 7 modification**: I asserted Value::Number(42.0) for the post-repair case. Is the cell value 42.0 actually expected, or is there a recompute-evaluation interaction that could surface a different value?

## Report format

Standard discipline:
- VERDICT: PASS / PASS-WITH-FINDINGS / FAIL (severity bucketed HIGH/MEDIUM/LOW)
- For each finding: file/line + what + why it matters + suggested fix
- One-paragraph synthesis

Hard cap: 1800 words. Be concise. The 5-cycle divergent-HIGH pattern continues — find real issues.

codex
I’ll audit this as a code review against the target commits, starting with the repair implementation, call sites/tests, and dependency graph. I’m going to verify behavior from the actual code rather than relying on the step summary.
exec
/bin/zsh -lc "sed -n '1,220p' AGENTS.md && sed -n '1,260p' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).
# VS Code Copilot Instructions

## Project Overview

Visual Studio Code is built with a layered architecture using TypeScript, web APIs and Electron, combining web technologies with native app capabilities. The codebase is organized into key architectural layers:

### Root Folders
- `src/`: Main TypeScript source code with unit tests in `src/vs/*/test/` folders
- `build/`: Build scripts and CI/CD tools
- `extensions/`: Built-in extensions that ship with VS Code
- `test/`: Integration tests and test infrastructure
- `scripts/`: Development and build scripts
- `resources/`: Static resources (icons, themes, etc.)
- `out/`: Compiled JavaScript output (generated during build)

### Core Architecture (`src/` folder)
- `src/vs/base/` - Foundation utilities and cross-platform abstractions
- `src/vs/platform/` - Platform services and dependency injection infrastructure
- `src/vs/editor/` - Text editor implementation with language services, syntax highlighting, and editing features
- `src/vs/workbench/` - Main application workbench for web and desktop
  - `workbench/browser/` - Core workbench UI components (parts, layout, actions)
  - `workbench/services/` - Service implementations
  - `workbench/contrib/` - Feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` - Extension host and VS Code API implementation
- `src/vs/code/` - Electron main process specific implementation
- `src/vs/server/` - Server specific implementation

The core architecture follows these principles:
- **Layered architecture** - from `base`, `platform`, `editor`, to `workbench`
- **Dependency injection** - Services are injected through constructor parameters
- **Contribution model** - Features contribute to registries and extension points
- **Cross-platform compatibility** - Abstractions separate platform-specific code

### Built-in Extensions (`extensions/` folder)
The `extensions/` directory contains first-party extensions that ship with VS Code:
- **Language support** - `typescript-language-features/`, `html-language-features/`, `css-language-features/`, etc.
- **Core features** - `git/`, `debug-auto-launch/`, `emmet/`, `markdown-language-features/`
- **Themes** - `theme-*` folders for default color themes
- **Development tools** - `extension-editing/`, `vscode-api-tests/`

Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.

### Finding Related Code
1. **Semantic search first**: Use file search for general concepts
2. **Grep for exact strings**: Use grep for error messages or specific function names
3. **Follow imports**: Check what files import the problematic module
4. **Check test files**: Often reveal usage patterns and expected behavior

## Validating TypeScript changes

MANDATORY: Always check the `VS Code - Build` watch task output via #runTasks/getTaskOutput for compilation errors before running ANY script or declaring work complete, then fix all compilation errors before moving forward.

- NEVER run tests if there are compilation errors
- NEVER use `npm run compile` to compile TypeScript files but call #runTasks/getTaskOutput instead

### TypeScript compilation steps
- Monitor the `VS Code - Build` task outputs for real-time compilation errors as you make changes
- This task runs `Core - Build` and `Ext - Build` to incrementally compile VS Code TypeScript sources and built-in extensions
- Start the task if it's not already running in the background

### TypeScript validation steps
- Use the run test tool if you need to run tests. If that tool is not available, then you can use `scripts/test.sh` (or `scripts\test.bat` on Windows) for unit tests (add `--grep <pattern>` to filter tests) or `scripts/test-integration.sh` (or `scripts\test-integration.bat` on Windows) for integration tests (integration tests end with .integrationTest.ts or are in /extensions/).
- Use `npm run valid-layers-check` to check for layering issues

## Coding Guidelines

### Indentation

We use tabs, not spaces.

### Naming Conventions

- Use PascalCase for `type` names
- Use PascalCase for `enum` values
- Use camelCase for `function` and `method` names
- Use camelCase for `property` names and `local variables`
- Use whole words in names when possible

### Types

- Do not export `types` or `functions` unless you need to share it across multiple components
- Do not introduce new `types` or `values` to the global namespace

### Comments

- Use JSDoc style comments for `functions`, `interfaces`, `enums`, and `classes`

### Strings

- Use "double quotes" for strings shown to the user that need to be externalized (localized)
- Use 'single quotes' otherwise
- All strings visible to the user need to be externalized using the `vs/nls` module
- Externalized strings must not use string concatenation. Use placeholders instead (`{0}`).

### UI labels
- Use title-style capitalization for command labels, buttons and menu items (each word is capitalized).
- Don't capitalize prepositions of four or fewer letters unless it's the first or last word (e.g. "in", "with", "for").

### Style

- Use arrow functions `=>` over anonymous function expressions
- Only surround arrow function parameters when necessary. For example, `(x) => x + x` is wrong but the following are correct:

```typescript
x => x + x
(x, y) => x + y
<T>(x: T, y: T) => x === y
```

- Always surround loop and conditional bodies with curly braces
- Open curly braces always go on the same line as whatever necessitates them
- Parenthesized constructs should have no surrounding whitespace. A single space follows commas, colons, and semicolons in those constructs. For example:

```typescript
for (let i = 0, n = str.length; i < 10; i++) {
    if (x < 10) {
        foo();
    }
}
function f(x: number, y: string): void { }
```

- Whenever possible, use in top-level scopes `export function x(…) {…}` instead of `export const x = (…) => {…}`. One advantage of using the `function` keyword is that the stack-trace shows a good name when debugging.

### Code Quality

- All files must include Microsoft copyright header
- Prefer `async` and `await` over `Promise` and `then` calls
- All user facing messages must be localized using the applicable localization framework (for example `nls.localize()` method)
- Don't add tests to the wrong test suite (e.g., adding to end of file instead of inside relevant suite)
- Look for existing test patterns before creating new structures
- Use `describe` and `test` consistently with existing patterns
- Prefer regex capture groups with names over numbered capture groups.
- If you create any temporary new files, scripts, or helper files for iteration, clean up these files by removing them at the end of the task
- Never duplicate imports. Always reuse existing imports if they are present.
- Do not use `any` or `unknown` as the type for variables, parameters, or return values unless absolutely necessary. If they need type annotations, they should have proper types or interfaces defined.
- When adding file watching, prefer correlated file watchers (via fileService.createWatcher) to shared ones.
- When adding tooltips to UI elements, prefer the use of IHoverService service.

exec
/bin/zsh -lc 'git show --stat --oneline e76a9ce5499 && git show --stat --oneline 4222d11fe7b' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
e76a9ce5499 Phase 5.3 step 3 — rename-repair pass (CORE 5.3 work)
 quantbook-engine/crates/ql-collab/Cargo.toml       |  10 +
 quantbook-engine/crates/ql-collab/src/lib.rs       |   7 +
 quantbook-engine/crates/ql-collab/src/repair.rs    | 262 ++++++++++
 .../crates/ql-collab/tests/repair_renames.rs       | 581 +++++++++++++++++++++
 quantbook-engine/crates/ql-exec/Cargo.toml         |   6 +
 .../tests/phase_5_3_conflict_matrix_probe.rs       | 142 +++--
 .../docs/architecture/crdt-data-model.md           |   2 +-
 7 files changed, 965 insertions(+), 45 deletions(-)
4222d11fe7b chore(deps): lockfile update for Phase 5.3 step 3 dep additions
 quantbook-engine/Cargo.lock | 3 +++
 1 file changed, 3 insertions(+)

exec
/bin/zsh -lc 'pwd && git status --short && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 998ms:
?? .codex-phase-5-3-step-3-audit-prompt.md
?? .codex-phase-5-3-step-3-audit.out
?? 2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? node_modules
?? quantbook-engine/.codex/prompts/2026-05-14-AA-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-127-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-128-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-129-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-K-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-L-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-M-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-N-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.I-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? quantbook-engine/.plans/_archive/
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
feat/quantbook-engine
4222d11fe7b886f75966af369bb3b7a09c39655b

codex
The checkout is on `feat/quantbook-engine` at `4222d11fe7b`; the changed Rust crate lives under `quantbook-engine/` inside the current repo. The local tree also has unrelated untracked files, so I’ll ignore those unless they affect inspection.
exec
/bin/zsh -lc "sed -n '1,340p' quantbook-engine/crates/ql-collab/src/repair.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! `ql_collab::repair` — Phase 5.3 step 3 rename-repair pass
//! (CORE 5.3 work, 2026-05-20).
//!
//! ## Purpose
//!
//! After merging concurrent ops from peers, formulas authored against
//! pre-rename sheet names may reference names that no longer exist.
//! Pre-step-3 behavior (D-3 V1 limitation): such formulas surface as
//! `BindError::UnknownSheet` → `#NAME?` at recompute time. This module
//! ships the post-merge repair pass that rewrites the formula text
//! in-place via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr`
//! machinery (same one producer-side rename uses for single-writer flows).
//!
//! ## Caller contract
//!
//! `repair_sheet_rename_chain` is **caller-driven**, NOT hooked into
//! `merge_bytes`. Audit-locked design decision D-5.3-1 (see
//! `quantbook-engine/.plans/_active.md`). Typical call sequence:
//!
//! ```text
//! 1. CollabSession::merge_bytes(peer_b_bytes)   // pull peer's ops
//! 2. replay_into(log, &mut workbook, &registry) // apply ops to workbook
//! 3. ql_collab::repair_sheet_rename_chain(&mut workbook, &log)?  // <-- THIS module
//! 4. WorkbookRuntime::recompute_all(...)        // evaluate formulas
//! ```
//!
//! Step 3 is OPTIONAL (replay + recompute work without it), but skipping
//! it means concurrent-edit formulas referencing renamed sheets resolve
//! as `#NAME?`. Production callers in collaborative workflows SHOULD
//! invoke it before recompute; single-writer / qbook-load workflows
//! don't need it (no concurrent renames possible).
//!
//! ## Algorithm (chain-based, NOT causality-aware)
//!
//! Audit-locked design decision D-5.3-2.
//!
//! 1. Walk the op log; for each `Op::RenameSheet { id, old_name, .. }`
//!    (including ops nested in `BatchCommit`), record `old_name` as a
//!    historic name of `id`.
//!
//! 2. For each sheet, build the rewrite rule
//!    `(canonical_historic_name → current_display_name)`. Skip pairs
//!    where the canonical matches the sheet's CURRENT canonical
//!    (no-op). The "current" name is taken from the workbook post-replay
//!    — this captures step-2's auto-disambiguation suffixes (e.g.
//!    a sheet that wanted "X" but ended up "X(2)" rewrites historic
//!    references to "X(2)", not the intended "X").
//!
//! 3. Walk every formula in the workbook via `Workbook::iter_formulas`.
//!    For each, apply rewrites via [`rewrite_formula_with_rename`].
//!    Idempotent: the helper returns `None` when no change applies.
//!    Multiple rewrites may compose (transitive chain S1→S2→S3 produces
//!    rewrites for both S1 and S2 → final name).
//!
//! 4. Apply collected updates via `Workbook::put_formula`.
//!
//! ## Known limitations (V1)
//!
//! - **Cross-sheet historic-name ambiguity**: if two sheets HAD the
//!   same canonical name at different points in their respective
//!   chains (rare — requires a sheet to be renamed away from a name
//!   that another sheet was THEN renamed to), the rewrite picks the
//!   "later in iteration" rule. Document but don't resolve. Real
//!   workflows rarely hit this because D-2 auto-rename prevents
//!   concurrent identical names.
//!
//! - **Concurrent-rename intermediate names lost**: if peer A's chain
//!   is S1→S2→S3 with both ops applied in sequence, the intermediate
//!   name "S2" lives in `old_name` of the second op so it IS captured.
//!   But if a concurrent rename forced the second op to apply "from"
//!   a different name (step 2's last-wins policy), the old_name from
//!   the wire may not reflect what current was at apply-time. Formulas
//!   referencing that intermediate name may not be repaired. Mitigation
//!   for future: causality-aware tracking via Loro op-ids (deferred).
//!
//! - **Step 4 extension**: this V1 only handles sheet renames.
//!   `Op::RenameTable` + `Op::RenameColumn` need the same treatment;
//!   step 4 of the Phase 5.3 arc adds them.

use ql_oplog::{Op, OpLog, OpLogError};
use ql_storage::Workbook;
use ql_types::SheetId;
use std::collections::HashMap;
use std::sync::Arc;

/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
/// logging / diagnostics. Per the no-fallback rule (CLAUDE.md), this
/// surfaces *what was done* rather than silently absorbing the work.
#[derive(Debug, Clone, Default)]
pub struct RepairReport {
    /// Total number of formulas whose text was rewritten by the pass.
    pub formulas_rewritten: usize,

    /// Per-sheet rewrite summary: the sheet id, its final display name
    /// post-replay, and the historic canonical names whose references
    /// were rewritten. Empty if no sheet had a rename.
    pub sheet_rewrites: Vec<SheetRewriteSummary>,
}

/// Per-sheet summary line in [`RepairReport`].
#[derive(Debug, Clone)]
pub struct SheetRewriteSummary {
    pub sheet: SheetId,
    pub current_display_name: String,
    /// Historic canonical names from `Op::RenameSheet.old_name`. Sorted
    /// + deduped. Empty iff the sheet had no rename ops in the log.
    pub historic_canonicals: Vec<String>,
}

/// Walk the op log to build a chain of sheet renames, then rewrite
/// every formula in `workbook` whose text references a historic
/// (pre-rename) sheet name. See module docs for the algorithm.
///
/// Returns a [`RepairReport`] describing what was changed. The report
/// is informational; the workbook is mutated in place.
///
/// **Errors**: only propagates `OpLogError` from iterating the op log
/// (e.g., a corrupted Loro `LoroValue::String` that fails serde
/// decode). Formula rewrites that fail to parse are SKIPPED silently
/// (the helper returns `None` on parse failure, preserving the
/// pre-rewrite text). This matches the producer-side helper's
/// behavior and avoids the no-fallback violation that would fire if
/// we returned an error for unparseable formulas (those formulas
/// would already produce parse errors at recompute time — repair
/// doesn't worsen that).
///
/// **Caller-driven**: NOT auto-invoked by `merge_bytes`. See module
/// docs for the expected call sequence.
pub fn repair_sheet_rename_chain(
    workbook: &mut Workbook,
    log: &OpLog,
) -> Result<RepairReport, OpLogError> {
    // ===== Phase 1: walk op log; collect historic old_names per sheet.
    let mut historic_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();
    for op_result in log.iter() {
        let op = op_result?;
        collect_rename_old_names(&op, &mut historic_by_sheet);
    }

    // ===== Phase 2: build (canonical_historic → current_display_name) rules.
    // Skip pairs where canonical historic matches current canonical (no-op).
    // For deterministic iteration (and audit reproducibility), sort the rules.
    let mut rules: Vec<(String, Arc<str>, SheetId)> = Vec::new();
    let mut sheet_rewrites: Vec<SheetRewriteSummary> = Vec::new();
    let mut sheet_ids: Vec<SheetId> = historic_by_sheet.keys().copied().collect();
    sheet_ids.sort_unstable();
    for sheet_id in sheet_ids {
        let historic = historic_by_sheet
            .get(&sheet_id)
            .cloned()
            .unwrap_or_default();
        let Some(current) = workbook.sheet(sheet_id).map(|s| s.name().to_owned()) else {
            // Sheet ID is in the rename history but doesn't exist in the
            // current workbook. Should not happen for sheet renames (no
            // DropSheet op exists in V1). Defensive skip.
            continue;
        };
        let current_canonical = Workbook::canonical_sheet_name(&current);
        let current_arc: Arc<str> = Arc::from(current.as_str());

        // Dedupe historic canonicals; skip those matching current canonical.
        let mut historic_canonicals: Vec<String> = historic
            .iter()
            .map(|s| Workbook::canonical_sheet_name(s))
            .filter(|c| c != &current_canonical)
            .collect();
        historic_canonicals.sort();
        historic_canonicals.dedup();

        for hc in &historic_canonicals {
            rules.push((hc.clone(), Arc::clone(&current_arc), sheet_id));
        }

        sheet_rewrites.push(SheetRewriteSummary {
            sheet: sheet_id,
            current_display_name: current,
            historic_canonicals,
        });
    }

    // ===== Phase 3: walk formulas, collect updates.
    // Two-phase to avoid mut/immut borrow conflict on workbook.
    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
    for (sheet, row, col, text) in workbook.iter_formulas() {
        let mut current_text = text.to_string();
        let mut changed = false;
        for (old_canonical, new_name, _origin_sheet) in &rules {
            if let Some(rewritten) =
                rewrite_formula_with_rename(&current_text, old_canonical, new_name)
            {
                current_text = rewritten;
                changed = true;
            }
        }
        if changed {
            to_update.push((sheet, row, col, current_text));
        }
    }
    let rewrite_count = to_update.len();

    // ===== Phase 4: apply updates.
    for (sheet, row, col, new_text) in to_update {
        workbook.put_formula(sheet, row, col, new_text);
    }

    Ok(RepairReport {
        formulas_rewritten: rewrite_count,
        sheet_rewrites,
    })
}

/// Walk an `Op`, including ops nested in `BatchCommit`, and record
/// `RenameSheet.old_name` entries in `historic`. Other op kinds are
/// ignored.
fn collect_rename_old_names(op: &Op, historic: &mut HashMap<SheetId, Vec<String>>) {
    match op {
        Op::RenameSheet { id, old_name, .. } => {
            historic.entry(*id).or_default().push(old_name.clone());
        }
        Op::BatchCommit { ops } => {
            for inner in ops {
                collect_rename_old_names(inner, historic);
            }
        }
        _ => {}
    }
}

/// Rewrite `text` (formula source) substituting every reference to
/// `old_canonical` (a canonical-uppercase sheet name) with `new_name`
/// (the new display name).
///
/// Mirror of the producer-side helper at
/// `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Kept here
/// because ql-collab has no dep on ql-exec (direction: ql-collab is
/// below ql-exec). Both helpers route through
/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
///
/// Returns `None` when:
/// - The text doesn't lex/parse (formula is malformed — caller should
///   not surface this as an error; recompute will surface it).
/// - The parsed AST doesn't reference `old_canonical` (no rewrite).
fn rewrite_formula_with_rename(
    text: &str,
    old_canonical: &str,
    new_name: &Arc<str>,
) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = ql_formula_syntax::lex(stripped).ok()?;
    let expr = ql_formula_syntax::parse(tokens).ok()?;
    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
    if rewritten == expr {
        return None;
    }
    let printed = ql_formula_syntax::print(&rewritten);
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
}

exec
/bin/zsh -lc "sed -n '1,720p' quantbook-engine/crates/ql-collab/tests/repair_renames.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
//! integration tests. 2026-05-20.
//!
//! Covers the user-visible property step 3 ships: after merging
//! concurrent ops, formulas authored against pre-rename sheet names
//! get rewritten to the current name. The repair pass closes the V1
//! limitation documented at `crdt-data-model.md:615-648` (D-3 →
//! `#NAME?`).
//!
//! Test pattern follows Phase 5.3 step 2's `phase_5_3_step2_rename_concurrent.rs`:
//! 2-peer fork with stable peer-ids. Each test:
//!   1. Build shared base log.
//!   2. Fork peer A + peer B via `fork_with_peer`.
//!   3. Each peer appends its local op.
//!   4. Exchange via `export_bytes` + `merge_bytes`.
//!   5. Replay into fresh workbook.
//!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
//!   7. Assert formula text + (optionally) recomputed value.
//!
//! NOTE: these tests don't recompute (no ql-functions in ql-collab's
//! dev-deps). They assert the FORMULA TEXT after repair, which is the
//! load-bearing property. Recompute correctness is a downstream concern
//! pinned at the row-7 test in `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`.

use ql_collab::{repair_sheet_rename_chain, RepairReport};
use ql_oplog::{replay_into, Op, OpLog};
use ql_storage::Workbook;

const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    log.set_peer_id(peer_id)
        .expect("set_peer_id with non-zero id must succeed");
    log
}

fn base_with_sheet(name: &str) -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: name.to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log
}

/// Replay `log` into a fresh workbook. We use the registry from
/// ql-functions (already a ql-collab dep) since `replay_into` requires
/// it; we don't recompute (that's a downstream test concern).
fn replay_to_workbook(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = ql_functions::default_registry();
    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    wb
}

/// Helper: build a merged log from two peers + apply concurrent ops.
/// Mirrors the step-2 pattern; peer A is the merger.
fn merged_log_with_concurrent_ops(base: &[u8], op_a: Op, op_b: Op) -> OpLog {
    let mut peer_a = fork_with_peer(base, PEER_A_ID);
    peer_a.append(op_a).unwrap();
    let mut peer_b = fork_with_peer(base, PEER_B_ID);
    peer_b.append(op_b).unwrap();
    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    peer_a
}

// ===== Test 1: PRIMARY — concurrent rename + concurrent formula edit =====

/// **Step 3 PRIMARY property**: peer A renames sheet S → S2;
/// peer B (concurrent, no knowledge of rename) writes `=S!A1` at B1.
/// After merge + repair, the formula text is rewritten to `=S2!A1`.
///
/// This is the canonical bug case from `crdt-data-model.md` row 7:
/// pre-step-3 the formula would bind-fail (S no longer exists) and
/// recompute → #NAME?. Post-step-3 the formula references the current
/// sheet name and resolves correctly.
#[test]
fn repair_rewrites_concurrent_formula_referencing_old_name() {
    // Base: sheet S exists.
    let base = base_with_sheet("S").export_bytes().unwrap();

    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0, // B2... actually row 1, col 0 = A2
            text: "S!A1".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
    // Pre-repair: formula at (1,0) is "S!A1".
    assert_eq!(
        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S!A1".to_string()),
        "pre-repair formula text is the raw merge state (S!A1, referencing old name)"
    );

    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");

    // Post-repair: formula rewritten to reference current sheet name.
    assert_eq!(
        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string()),
        "post-repair formula text references current sheet name (S2)"
    );
    assert_eq!(
        report.formulas_rewritten, 1,
        "exactly 1 formula rewritten (B's =S!A1)"
    );
    assert_eq!(report.sheet_rewrites.len(), 1);
    assert_eq!(report.sheet_rewrites[0].sheet, 0);
    assert_eq!(report.sheet_rewrites[0].current_display_name, "S2");
    assert_eq!(report.sheet_rewrites[0].historic_canonicals, vec!["S"]);
}

// ===== Test 2: Transitive chain (sequential renames) =====

/// **Step 3:** sequential rename chain S → S2 → S3 (single peer
/// across multiple ops). Peer B (forked at base) writes `=S!A1`.
/// Repair should rewrite the formula to `=S3!A1` (the final name)
/// since "S" is no longer current.
#[test]
fn repair_handles_transitive_chain_to_final_name() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: chain S → S2 → S3.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S2".to_owned(),
            new_name: "S3".to_owned(),
        })
        .unwrap();

    // Peer B: concurrent formula referencing original name.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // Formula rewritten directly to the final name S3 (skipping S2).
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S3!A1".to_string()),
        "transitive chain: S → S2 → S3 rewrites S references directly to S3"
    );
}

// ===== Test 3: Rename-back (chain collapses) =====

/// **Step 3:** rename-back chain S → S2 → S. Peer B writes
/// `=S2!A1` (referencing the intermediate). After repair:
/// formula references S (the current name), because S2 is now a
/// historic name in the chain.
#[test]
fn repair_handles_rename_back_intermediate_reference() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: S → S2 → S (final = original).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S2".to_owned(),
            new_name: "S".to_owned(),
        })
        .unwrap();

    // Peer B references the INTERMEDIATE name S2.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S2!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    assert_eq!(wb.sheet(0).unwrap().name(), "S");

    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // S2 was historic; repair rewrites S2 → S (current name).
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S!A1".to_string()),
        "rename-back: S2 references rewritten to current name S"
    );
}

// ===== Test 4: No-op case — formula references unrenamed sheet =====

/// **Step 3:** formula references a sheet that was NEVER renamed.
/// Repair must be a no-op for that formula. Pins idempotency of the
/// helper's None-on-no-change return.
#[test]
fn repair_leaves_unrelated_formulas_unchanged() {
    // Base: two sheets S (id 0) + T (id 1).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::AddSheet {
            name: "T".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Peer A: rename S → S2 (id 0).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();

    // Peer B: formula on T referencing T (unrelated to rename).
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 1,
            row: 0,
            col: 0,
            text: "T!B1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // T!B1 untouched.
    assert_eq!(
        wb.formula_at(1, 0, 0).map(|s| s.to_string()),
        Some("T!B1".to_string()),
        "formula on unrenamed sheet must NOT be rewritten"
    );
    assert_eq!(
        report.formulas_rewritten, 0,
        "no formula references the renamed sheet's old name"
    );
}

// ===== Test 5: Idempotency =====

/// **Step 3:** running repair TWICE produces the same result as
/// running it once. Pins the no-op-on-no-change property — critical
/// for callers that might invoke repair multiple times during a
/// session.
#[test]
fn repair_is_idempotent() {
    let base = base_with_sheet("S").export_bytes().unwrap();
    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
    let after_first = wb.formula_at(0, 0, 0).map(|s| s.to_string());

    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
    let after_second = wb.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(first.formulas_rewritten, 1);
    assert_eq!(
        second.formulas_rewritten, 0,
        "second repair pass must be a no-op (helper returns None on no-change)"
    );
    assert_eq!(
        after_first, after_second,
        "formula text stable across repeated repair calls"
    );
}

// ===== Test 6: Empty log =====

/// **Step 3:** no rename ops in the log → repair is trivial no-op.
#[test]
fn repair_with_no_renames_is_noop() {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log.append(Op::PutFormula {
        sheet: 0,
        row: 0,
        col: 0,
        text: "S!A1".to_owned(),
    })
    .unwrap();

    let mut wb = replay_to_workbook(&log);
    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");

    assert_eq!(report.formulas_rewritten, 0);
    assert!(report.sheet_rewrites.is_empty());
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S!A1".to_string())
    );
}

// ===== Test 7: Step 2 auto-disambiguation chain =====

/// **Step 3 + step-2-audit interaction**: two peers concurrently
/// rename DIFFERENT sheets to the SAME target. Step 2's auto-
/// disambiguation suffixes the second to `X(2)`. Peer C writes
/// `=S3!A1` referencing sheet 1's original name. After merge +
/// repair, the formula should rewrite to the current name of
/// sheet 1, which is `X(2)`.
#[test]
fn repair_handles_step2_auto_disambiguation_suffix() {
    // Base: 2 sheets (S1 = id 0, S3 = id 1).
    let mut base_log = OpLog::new();
    base_log
        .append(Op::AddSheet {
            name: "S1".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    base_log
        .append(Op::AddSheet {
            name: "S3".to_owned(),
            chunk_rows: 16384,
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Peer A: rename sheet 0 (S1) → X.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S1".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
    // triggers step 2 auto-rename to X(2)). Also writes a formula
    // referencing the OLD name S3.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::RenameSheet {
            id: 1,
            old_name: "S3".to_owned(),
            new_name: "X".to_owned(),
        })
        .unwrap();
    peer_b
        .append(Op::PutFormula {
            sheet: 1,
            row: 0,
            col: 0,
            text: "S3!B1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    // Sheet 0 = "X" (peer A's rename), sheet 1 = "X(2)" (auto-disambig).
    assert_eq!(wb.sheet(0).unwrap().name(), "X");
    assert_eq!(wb.sheet(1).unwrap().name(), "X(2)");

    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");

    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
    // Formula syntax requires quoting sheet names containing `(` or `)`,
    // so the printer emits `'X(2)'!B1` (single-quoted), NOT `X(2)!B1`.
    // This is correct canonical form for the formula language.
    let formula_text = wb.formula_at(1, 0, 0).map(|s| s.to_string());
    assert_eq!(
        formula_text,
        Some("'X(2)'!B1".to_string()),
        "repair must rewrite to the auto-disambiguated current name X(2) \
         (single-quoted because '(' requires quoting in formula syntax)"
    );
}

// ===== Test 8: BatchCommit-wrapped rename =====

/// **Step 3:** the producer-side rename emits in a `BatchCommit`
/// (rename + formula rewrites together). Our repair must traverse
/// BatchCommits to find nested `Op::RenameSheet`.
#[test]
fn repair_walks_batchcommit_nested_renames() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A: rename via BatchCommit (mirrors producer pattern).
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a
        .append(Op::BatchCommit {
            ops: vec![Op::RenameSheet {
                id: 0,
                old_name: "S".to_owned(),
                new_name: "Renamed".to_owned(),
            }],
        })
        .unwrap();

    // Peer B: concurrent formula referencing old name.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();

    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    let mut wb = replay_to_workbook(&peer_a);

    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
    assert_eq!(
        report.formulas_rewritten, 1,
        "BatchCommit-nested RenameSheet must be discovered by the chain walker"
    );
    assert_eq!(
        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("Renamed!A1".to_string())
    );
}

// ===== Test 9: Bidirectional merge convergence =====

/// **Step 3:** repair must be deterministic across merge directions.
/// Both peers, after merging each other's bytes + running repair,
/// must observe identical formula text.
#[test]
fn repair_converges_across_merge_directions() {
    let base = base_with_sheet("S").export_bytes().unwrap();

    // Peer A's view: rename + put_value (for cell to reference).
    // Peer B's view: formula referencing S.
    let op_a = Op::RenameSheet {
        id: 0,
        old_name: "S".to_owned(),
        new_name: "S2".to_owned(),
    };
    let op_b = Op::PutFormula {
        sheet: 0,
        row: 0,
        col: 0,
        text: "S!A1".to_owned(),
    };

    // Direction 1: A merges B.
    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    peer_a.append(op_a.clone()).unwrap();
    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    peer_b_for_a.append(op_b.clone()).unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();
    let mut wb_a = replay_to_workbook(&peer_a);
    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();

    // Direction 2: B merges A.
    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    peer_b.append(op_b).unwrap();
    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
    peer_a_for_b.append(op_a).unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();
    let mut wb_b = replay_to_workbook(&peer_b);
    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();

    assert_eq!(
        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
        wb_b.formula_at(0, 0, 0).map(|s| s.to_string()),
        "bidirectional convergence: formula text matches across merge directions"
    );
    assert_eq!(
        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string())
    );
}

// ===== Test 10: RepairReport structure =====

/// **Step 3:** verify the report's structure carries useful diagnostic
/// information for callers (no-fallback rule — surface what was done).
#[test]
fn repair_report_carries_diagnostic_information() {
    let base = base_with_sheet("Sheet1").export_bytes().unwrap();

    let log = merged_log_with_concurrent_ops(
        &base,
        Op::RenameSheet {
            id: 0,
            old_name: "Sheet1".to_owned(),
            new_name: "Calculations".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "Sheet1!A1+Sheet1!B2".to_owned(),
        },
    );

    let mut wb = replay_to_workbook(&log);
    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();

    assert_eq!(report.formulas_rewritten, 1);
    assert_eq!(report.sheet_rewrites.len(), 1);
    let summary = &report.sheet_rewrites[0];
    assert_eq!(summary.sheet, 0);
    assert_eq!(summary.current_display_name, "Calculations");
    // historic_canonicals contains "SHEET1" (canonical uppercase).
    assert_eq!(summary.historic_canonicals, vec!["SHEET1"]);

    // Verify the formula now references "Calculations" (both occurrences).
    let f = wb.formula_at(0, 0, 0).unwrap();
    assert!(f.contains("Calculations"), "got: {f}");
    assert!(!f.contains("Sheet1"), "got: {f}");
}

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
//! § Conflict resolution semantics (Phase 5.3 preview).
//!
//! Most rows in the matrix are correct by Loro's underlying CRDT
//! merge (Fugue/origin-based with peer-id tiebreaker). These tests
//! make that load-bearing — any future regression in either Loro's
//! semantics OR our op-replay path trips a test.
//!
//! Pattern: D-4's `phase_5_2_d4_spill_2peer_probe.rs` template.
//! Each test:
//!   1. Build a shared base log (common causal ancestor).
//!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
//!   3. Each peer appends its local op.
//!   4. Exchange via `export_bytes` + `merge_bytes` — in BOTH
//!      directions when the test verifies convergence.
//!   5. Replay + recompute via `replay_and_recompute`.
//!   6. Assert final workbook state.
//!
//! Coverage of the 8-row matrix at `crdt-data-model.md:320-329`:
//! - Row 1: PutValue × PutValue same address — pinned here
//! - Row 2: PutFormula × PutFormula same address — pinned here
//! - Row 3: PutValue × PutFormula same address — pinned here
//! - Row 4: ClearFormula × PutFormula same address — pinned here
//! - Row 5: SetName concurrent same name — pinned here
//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename) — pinned here
//! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
//!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
//!   step 3 ships the rename-repair pass which will MODIFY this test
//!   to assert the post-fix behavior (formula text rewritten,
//!   correct value resolves).
//! - Row 8: DropTable × concurrent edit referencing T — pinned here
//!   (D-3 → #NAME?; no repair planned — drop is destructive)
//!
//! "Last-in-causal-order wins" means the CRDT picks ONE value
//! deterministically; both merge directions converge to the same
//! state. The tests verify CONVERGENCE (both peers see the same
//! final state) — they don't predict WHICH op wins (that depends
//! on Loro's internal peer-id tiebreaker, which we don't pin).
//!
//! Audit-discipline NOTE (step 1 audit closure, both Codex HIGH
//! and Opus HIGH-1): value-only assertions are NOT load-bearing.
//! A test that checks `Value::Number(7.0)` after concurrent
//! literal-7 and formula-3+4 cannot distinguish which op won
//! (both produce 7.0) AND would pass even if structural state
//! diverges (e.g. peer A has formula_at=None, peer B has
//! formula_at=Some). Convergence tests at the same address MUST
//! additionally assert `formula_at` convergence to pin structural
//! state, and SHOULD use distinct observable values (literal=7
//! and formula="99-50"=49).

use ql_exec::WorkbookRuntime;
use ql_functions::default_registry;
use ql_oplog::{replay_into, CellWireValue, NamedTargetWire, Op, OpLog};
use ql_storage::Workbook;
use ql_types::{Address, ErrorValue, Value};

/// Build a base op log carrying `AddSheet("S")`. Most tests fork
/// from this; the AddSheet × AddSheet test bypasses it (since it
/// needs to test sheet-name collision directly).
fn base_with_sheet() -> OpLog {
    let mut log = OpLog::new();
    log.append(Op::AddSheet {
        name: "S".to_owned(),
        chunk_rows: 16384,
    })
    .unwrap();
    log
}

/// Build a base op log with sheet "S" + a `CreateTable("T")`
/// covering A1:B3 with header row. Used by the DropTable conflict
/// test (row 7).
fn base_with_sheet_and_table() -> OpLog {
    let mut log = base_with_sheet();
    log.append(Op::CreateTable {
        name: "T".to_owned(),
        sheet: 0,
        top_row: 0,
        top_col: 0,
        rows: 3,
        cols: 2,
        has_header: true,
        has_totals: false,
        column_names: vec!["X".to_owned(), "Y".to_owned()],
    })
    .unwrap();
    log
}

/// Replay log into a fresh workbook + recompute. Mirror of D-4's
/// helper.
fn replay_and_recompute(log: &OpLog) -> Workbook {
    let mut wb = Workbook::new();
    let reg = default_registry();
    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    {
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.recompute_all();
    }
    wb
}

/// Stable peer ids for the two-peer fork. Loro's CRDT tiebreaker
/// picks deterministic order ONLY when peer-ids are stable across
/// the merge — if both directions use random `LoroDoc::new()` ids,
/// the (peer-id pair) differs across directions and convergence
/// breaks. PEER_A_ID < PEER_B_ID makes the order observable.
///
/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
/// asserts post-step-8 audit closure).
const PEER_A_ID: u64 = 1;
const PEER_B_ID: u64 = 2;

/// Build a freshly-forked `OpLog` carrying `base_bytes` and a fixed
/// peer-id. New ops appended to this log carry `peer_id` in their
/// Loro op-ids; the imported base ops retain their original peer-id
/// (Loro semantic — import preserves origin).
fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    log.set_peer_id(peer_id)
        .expect("set_peer_id with non-zero id must succeed");
    log
}

/// Fork two peers from `base_bytes` with STABLE peer-ids, apply
/// `op_a` on peer A (id = `PEER_A_ID`) and `op_b` on peer B
/// (id = `PEER_B_ID`), then merge bidirectionally. Returns the two
/// replayed+recomputed workbooks `(wb_after_a_merges_b,
/// wb_after_b_merges_a)`. The convergence property asserts these
/// produce identical observable state.
fn fork_apply_merge_both_directions(base_bytes: &[u8], op_a: Op, op_b: Op) -> (Workbook, Workbook) {
    // Peer A's view: id=1, appends op_a, merges peer B's bytes.
    let mut peer_a = fork_with_peer(base_bytes, PEER_A_ID);
    peer_a.append(op_a.clone()).unwrap();

    let mut peer_b_for_a = fork_with_peer(base_bytes, PEER_B_ID);
    peer_b_for_a.append(op_b.clone()).unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Peer B's view: id=2, appends op_b, merges peer A's bytes.
    let mut peer_b = fork_with_peer(base_bytes, PEER_B_ID);
    peer_b.append(op_b).unwrap();

    let mut peer_a_for_b = fork_with_peer(base_bytes, PEER_A_ID);
    peer_a_for_b.append(op_a).unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();

    (replay_and_recompute(&peer_a), replay_and_recompute(&peer_b))
}

// ===== Row 1: PutValue × PutValue same address =====

/// **Conflict-matrix row 1:** two peers each write a literal at A1.
/// Loro's Fugue/origin-based merge picks one deterministically; both
/// merge directions converge to the same final value.
#[test]
fn row1_putvalue_concurrent_same_address_converges() {
    let base = base_with_sheet().export_bytes().unwrap();
    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(1.0),
        },
        Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(2.0),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(
        a1_a, a1_b,
        "convergence: both merge directions must produce the same A1 value"
    );
    // The winner is one of {1.0, 2.0}; we don't predict which.
    assert!(
        matches!(a1_a, Value::Number(n) if n == 1.0 || n == 2.0),
        "A1 must be one of the concurrently-written values; got {a1_a:?}"
    );
}

// ===== Row 2: PutFormula × PutFormula same address =====

/// **Conflict-matrix row 2:** two peers each write a formula at A1.
/// Last-in-causal-order wins; convergent across merge directions.
///
/// **Audit closure (Codex MEDIUM-2):** strengthened with `formula_at`
/// convergence so a regression that breaks structural state (e.g.,
/// peer A keeps "1+1" while peer B keeps "2+2") trips the test even
/// if both happen to evaluate to the same value.
#[test]
fn row2_putformula_concurrent_same_address_converges() {
    let base = base_with_sheet().export_bytes().unwrap();
    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "1+1".to_owned(),
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "2+2".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));
    let f_a = wb_a.formula_at(0, 0, 0).map(|s| s.to_string());
    let f_b = wb_b.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(a1_a, a1_b, "convergence on A1 value");
    assert_eq!(
        f_a, f_b,
        "convergence on A1 formula text (both peers must agree on which formula won)"
    );
    // Formula evaluates: =1+1 → 2.0 or =2+2 → 4.0.
    assert!(
        matches!(a1_a, Value::Number(n) if n == 2.0 || n == 4.0),
        "A1 must be 2.0 (from 1+1) or 4.0 (from 2+2); got {a1_a:?}"
    );
    // Structural: formula_at must be Some(winner-text) — both peers
    // agree on which formula won and store the same text.
    let f_text = f_a.expect("PutFormula winner must leave formula_at = Some(text)");
    assert!(
        f_text == "1+1" || f_text == "2+2",
        "formula_at must be one of the two raced texts; got {f_text:?}"
    );
}

// ===== Row 3: PutValue × PutFormula same address =====

/// **Conflict-matrix row 3:** peer A writes literal at A1, peer B
/// writes formula at A1. The design-doc claim: "replay applies both
/// and recompute observes final state."
///
/// **Audit closure (Codex HIGH + Opus HIGH-1):** the original test
/// used literal=7.0 + formula="3+4" — both collapsed to Value::Number(7.0)
/// so the assertion couldn't distinguish winners. WORSE, replay
/// `PutValue` does NOT clear `formula_cells` (workbook.rs put_at
/// preserves formula text by design), so the cell can have BOTH
/// user_overlay=7.0 AND formula_at=Some("3+4") regardless of causal
/// order. Recompute then resolves based on read-cascade priority,
/// hiding structural divergence behind the same observable value.
///

exec
/bin/zsh -lc "sed -n '1,120p' quantbook-engine/crates/ql-collab/src/lib.rs && sed -n '1,180p' quantbook-engine/crates/ql-collab/Cargo.toml && sed -n '1,160p' quantbook-engine/crates/ql-exec/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
//!
//! **Phase 5.2.a (2026-05-19, scaffold ship):** establishes the
//! module shape per the audit-closed design at
//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
//! A (preserve op-log shape on top of Loro `LoroList`); this crate
//! is the layer above ql-oplog that orchestrates multi-peer
//! collaboration.
//!
//! ## Module layout
//!
//! - `PeerId` — re-exported from [`ql_types::PeerId`] (Phase 5.2 D-1
//!   step 1.1, 2026-05-19; originally `ql_collab::peer::PeerId` at
//!   5.2.a, briefly relocated to `ql_oplog::PeerId` at step 1, finally
//!   at `ql_types::PeerId` after the step-1 Codex audit caught a
//!   forthcoming Cargo cycle). Stable per-session identifier; wraps
//!   Loro's `u64`.
//! - [`session`] — `CollabSession`: per-peer state holder that
//!   wraps an `OpLog`, manages local appends, and exposes
//!   `merge_bytes` + `export_bytes` for transport integration.
//! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
//!   (test stub) and `LoopbackTransport` (Phase 5.5 V1 ship
//!   2026-05-19 — in-process paired endpoints for 2-peer
//!   round-trip tests). Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05`)
//!   added `CollabSession` typed transport methods
//!   (attach/detach/flush/poll). Phase 5.5 V2 V2 / V3 pending —
//!   auto-flush + version-vector deltas + WebSocket impl.
//! - [`presence`] — per-peer ephemeral cursor + selection state
//!   (Phase 5.6 V1 ship 2026-05-19). `PresenceState` JSON-encoded
//!   into the shared `LoroDoc`'s `"presence"` LoroMap (LWW per key).
//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`.
//!   V1 ship 2026-05-19 (`89c02b9d83e`): 7 undo/redo methods.
//!   V2 V1 (`6138a7203f6` + `e199a5fda5a`): atomic grouping +
//!   merge-interval. V2 V1.1: RAII `start_undo_group_scoped`
//!   returning `UndoGroupGuard`. V2 V2 pending — push/pop
//!   listeners.
//!
//! ## Stability
//!
//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
//! will populate the reserved modules and may shift trait shapes.
//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
//! megaudit per the engine audit-discipline rule.
//!
//! ### Pre-stability API changes (logged)
//!
//! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
//!   return type changed from `Self` to
//!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
//!   fallible (`u64::MAX` is reserved), so the constructor must
//!   propagate the error. Internal-only at the time of the change;
//!   no external callers.
//! - **Phase 5.4 V1 (2026-05-19, `89c02b9d83e` + audit closure):**
//!   `CollabSessionError::Undo(loro::LoroError)` variant added.
//!   Exposes `loro::LoroError` in the public error surface — pre-0.2.0
//!   this couples consumers to the loro crate version; a stable API
//!   would wrap it in a ql-collab-owned error. Will be re-typed
//!   before 0.2.0.
//! - **Phase 5.4 V1 audit closure (2026-05-19):**
//!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
//!   to `&mut self`. Prevents accidental peer-id changes through
//!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
//!   an attached `UndoManager`'s stacks per Loro's internal
//!   subscription behavior (`loro-internal::undo:654-662`).
//! - **Phase 5.2 D-1 step 1 (2026-05-19, `aaa54d32f4d`):** `PeerId`
//!   moved from `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId`.
//!   Brief intermediate placement; superseded same-day by step 1.1.
//! - **Phase 5.2 D-1 step 1.1 (2026-05-19):** Codex audit on step 1
//!   caught (a) PeerId lacked `Serialize`/`Deserialize` (blocks step
//!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
//!   in step 3 would form a Cargo cycle (`ql-oplog -> ql-storage` exists;
//!   making `ql-storage -> ql-oplog` for PeerId would loop). Step 1.1
//!   moved PeerId to `ql_types::PeerId` (the true dependency floor —
//!   `ql-storage`, `ql-oplog`, and `ql-collab` all depend on it),
//!   added `#[serde(transparent)]` derives, and shipped the
//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
//!   migration. `ql_collab::PeerId` now re-exports `ql_types::PeerId`.
//!
//!   **Back-compat surface:** `use ql_collab::PeerId;` keeps working
//!   unchanged (both step 1 and step 1.1 preserve the re-export).
//!   `use ql_collab::peer::PeerId;` (the old module path) was broken
//!   by step 1 and stays broken — `pub mod peer` is gone. Workspace
//!   grep confirms no such caller existed; external consumers were
//!   already using `ql_collab::PeerId` (the re-export).

pub mod presence;
// Phase 5.3 step 3 (2026-05-20) — rename-repair pass. Caller-driven
// post-merge cleanup that rewrites formula text referencing pre-rename
// sheet names. See `repair.rs` module docs + `docs/architecture/crdt-data-model.md`
// § "Conflict resolution semantics" rows for the RenameSheet × concurrent
// edit closure that this module ships.
pub mod repair;
pub mod session;
pub mod transport;
pub mod undo;

// PeerId actually lives in `ql_types` post step 1.1, but ql-collab
// re-exports via `ql_oplog::PeerId` (itself a re-export) to avoid
// adding a new direct `ql-types` Cargo dep on ql-collab. External
// callers using `use ql_collab::PeerId;` resolve identically.
pub use ql_oplog::PeerId;

pub use presence::{PresenceError, PresenceState};
pub use repair::{repair_sheet_rename_chain, RepairReport, SheetRewriteSummary};
pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
pub use undo::UndoManager;
[package]
name = "ql-collab"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lib]
path = "src/lib.rs"

[dependencies]
# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
# closed design at `docs/architecture/crdt-data-model.md`,
# ql-collab is the Phase 5 collaboration crate. Depends on
# ql-oplog (the dependency floor post Tier D2) for OpLog + Op +
# merge_bytes. ql-storage gives us Workbook for replay
# integration; ql-functions provides the registry needed by replay.
ql-oplog     = { path = "../ql-oplog" }
ql-storage   = { path = "../ql-storage" }
ql-functions = { path = "../ql-functions" }
thiserror    = { workspace = true }
# Phase 5.6 (2026-05-19) — presence state serde + JSON encoding for
# Loro's `presence` LoroMap (per-peer ephemeral cursor / selection).
serde        = { workspace = true }
serde_json   = { workspace = true }
# Phase 5.4 V1 (2026-05-19) — direct dep on `loro::UndoManager`
# wrapped by `CollabSession` for peer-local undo/redo.
loro         = { workspace = true }
# Phase 5.3 step 3 (2026-05-20) — rename-repair pass uses
# `ql_formula_syntax::{lex, parse, print, rewrite_sheet_name_in_expr}`
# to rewrite formula text post-merge when peers concurrently rename
# sheets. Same machinery the producer-side rename in ql-exec uses;
# see `crates/ql-collab/src/repair.rs`.
ql-formula-syntax = { path = "../ql-formula-syntax" }
# ql-types provides Address/SheetId/RowId/ColId — already a transitive
# dep via ql-storage but pulled in explicitly for the repair module's
# return-type construction.
ql-types     = { path = "../ql-types" }
[package]
name = "ql-exec"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lib]
path = "src/lib.rs"

[dependencies]
ql-types          = { path = "../ql-types" }
ql-formula-syntax = { path = "../ql-formula-syntax" }
ql-calcgraph      = { path = "../ql-calcgraph" }
ql-storage        = { path = "../ql-storage" }
ql-functions      = { path = "../ql-functions" }
# Phase 2A.4 (2026-05-12): promoted from dev-dependency. `loader.rs` needs
# `ql_io::load_workbook` at runtime for the `load_workbook_and_recompute`
# convenience. No new transitive risk — ql-io was already linked through
# dev-deps in the same crate.
ql-io             = { path = "../ql-io" }
# Phase 2A.3.b (2026-05-12): opt-in op-log attachment for WorkbookRuntime +
# WorkbookTransaction. CellWireValue conversion happens via ql-io (already
# present); Op + OpLog types come from ql-oplog.
ql-oplog          = { path = "../ql-oplog" }
arrow-array       = { workspace = true }
multiversion      = { workspace = true }
thiserror         = { workspace = true }
# `pulp` is in workspace.dependencies for Phase 4+ kernels that need explicit lane ops
# (Welford reduction with custom lanes, SUMIF masking). W4 SIMD relies on multiversion
# attributes + LLVM auto-vectorization — pulp not yet needed. Adding pulp would pull in
# the unmaintained `paste` transitive (RUSTSEC-2024-0436) which fails cargo-audit.
# Re-add when actually used.

[dev-dependencies]
proptest  = { workspace = true }
criterion = { workspace = true }
tempfile  = { workspace = true }
# Phase 2B.3: BPC-04 test wires bind-plan-cache stats into Timings to prove
# the visibility contract.
ql-profile = { path = "../ql-profile" }
# Phase 5.3 step 3 (2026-05-20) — row 7 of the conflict-matrix probe
# test (`phase_5_3_conflict_matrix_probe.rs`) asserts the post-repair
# state of formulas authored against concurrently-renamed sheet names.
# Direction: dev-only; ql-collab → ql-exec has no Cargo cycle since
# ql-collab does not depend on ql-exec (they are siblings).
ql-collab  = { path = "../ql-collab" }

# Phase 0 OG-02 hot path bench (Week 4 acceptance run).
[[bench]]
name = "og02_mul2"
harness = false

# Phase 0 OG-04 1M scalar baseline bench.
[[bench]]
name = "og04_scalar_1m"
harness = false

# Phase 0 A7 chunk-size sweep over the OG-02 mul2 hot path.
[[bench]]
name = "og02_chunk_sweep"
harness = false

# Phase 3.10 megaudit A3-03: 10k-formula dirty recompute benchmark.
# Cold edit + idempotent edit (the latter measures the Phase 3.8 VEQ
# short-circuit gain). Regression detection — guards against future
# changes that re-introduce O(n) eval on idempotent edits.
[[bench]]
name = "a3_10k_dirty_recompute"
harness = false

exec
/bin/zsh -lc "sed -n '300,560p' quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    // Now disambiguate: distinct values let us reason about which won.
    // - Literal wins → A1 read = 7.0
    // - Formula wins → A1 read = 49.0
    match a1_a {
        Value::Number(7.0) => {
            // Literal-wins case. NOTE: `formula_at` may STILL be
            // Some("99-50") because put_at doesn't clear formula text
            // (workbook.rs:809-814 — intentional, supports formula+value
            // coexistence). The read-cascade prefers user_overlay over
            // computed-overlay when both are present. This is structural
            // "accumulation" not "divergence" — both peers see the same
            // accumulation.
        }
        Value::Number(49.0) => {
            // Formula-wins case. formula_at MUST be Some("99-50").
            assert_eq!(
                f_a.as_deref(),
                Some("99-50"),
                "formula-wins case requires formula_at=Some(\"99-50\"); got {f_a:?}"
            );
        }
        other => panic!(
            "A1 must be Number(7.0) (literal wins) or Number(49.0) (formula wins); got {other:?}"
        ),
    }
}

// ===== Row 4: ClearFormula × PutFormula same address =====

/// **Conflict-matrix row 4:** peer A writes formula at A1 then
/// clears it; peer B writes a different formula at A1 concurrently.
/// Last-in-causal-order wins. After convergence, A1 is either Blank
/// (cleared) or the peer-B formula's evaluation.
///
/// Note: ClearFormula needs a prior PutFormula to clear. We bake
/// the prior PutFormula into the BASE log (both peers see it as
/// causal ancestor), then peer A clears + peer B overwrites
/// concurrently.
#[test]
fn row4_clearformula_vs_putformula_same_address_converges() {
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "1+1".to_owned(),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::ClearFormula {
            sheet: 0,
            row: 0,
            col: 0,
        },
        Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "10+10".to_owned(),
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));
    let f_a = wb_a.formula_at(0, 0, 0).map(|s| s.to_string());
    let f_b = wb_b.formula_at(0, 0, 0).map(|s| s.to_string());

    assert_eq!(a1_a, a1_b, "convergence on A1 value");
    // Audit closure (Codex MEDIUM-2): also pin structural convergence
    // — peers must agree on whether the formula was cleared.
    assert_eq!(
        f_a, f_b,
        "convergence on A1 formula_at (peers must agree on whether the formula \
         was cleared or overwritten)"
    );

    // Disambiguate structurally:
    // - ClearFormula wins → formula_at == None, value == Blank
    // - PutFormula wins → formula_at == Some("10+10"), value == 20.0
    match (a1_a.clone(), f_a.as_deref()) {
        (Value::Blank, None) => { /* ClearFormula won */ }
        (Value::Number(20.0), Some("10+10")) => { /* PutFormula won */ }
        (val, ftext) => panic!(
            "A1 must be (Blank, None) for ClearFormula-wins OR \
             (Number(20.0), Some(\"10+10\")) for PutFormula-wins; \
             got ({val:?}, {ftext:?})"
        ),
    }
}

// ===== Row 5: SetName concurrent same name =====

/// **Conflict-matrix row 5:** two peers concurrently SetName the
/// same name "TaxRate" with different constant values. Last-in-
/// causal-order wins; convergent across merge directions.
///
/// **Audit closure (Codex LOW-2 + Opus MEDIUM-3):** the original
/// test bundled SetName + PutFormula per peer in a BatchCommit,
/// which changes the Loro conflict unit. The cleaner pattern (and
/// what the matrix row LITERALLY describes) is racing only the
/// SetName ops — the PutFormula `=TaxRate` lives in the BASE log
/// as a shared causal ancestor.
#[test]
fn row5_setname_concurrent_same_name_converges() {
    // Bake the `=TaxRate` reference at A1 into the base log so the
    // formula text is identical across peers and only the SetName
    // ops race.
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutFormula {
            sheet: 0,
            row: 0,
            col: 0,
            text: "TaxRate".to_owned(),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::SetName {
            scope: None,
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.21),
            },
        },
        Op::SetName {
            scope: None,
            name: "TaxRate".to_owned(),
            target: NamedTargetWire::Constant {
                value: CellWireValue::Number(0.42),
            },
        },
    );

    let a1_a = wb_a.read(Address::new(0, 0, 0));
    let a1_b = wb_b.read(Address::new(0, 0, 0));

    assert_eq!(a1_a, a1_b, "convergence on TaxRate value");
    assert!(
        matches!(a1_a, Value::Number(n) if (n - 0.21).abs() < 1e-9 || (n - 0.42).abs() < 1e-9),
        "TaxRate resolves to 0.21 or 0.42; got {a1_a:?}"
    );
}

// ===== Row 6: AddSheet × AddSheet same name (D-2 auto-rename) =====

/// **Conflict-matrix row 6:** two peers each AddSheet with the
/// same name. Phase 5.2 D-2 (`1ca19e2fa37`) shipped the auto-
/// rename behavior — the second add in causal order becomes
/// `<name>(2)`. This test pins it: after merge, BOTH sheets exist
/// (no rejection); the second carries `(2)` suffix.
#[test]
fn row6_addsheet_same_name_auto_renames_via_d2() {
    // Empty base — no AddSheet here; both peers contribute one.
    let base = OpLog::new().export_bytes().unwrap();

    let (wb_a, wb_b) = fork_apply_merge_both_directions(
        &base,
        Op::AddSheet {
            name: "Calc".to_owned(),
            chunk_rows: 16384,
        },
        Op::AddSheet {
            name: "Calc".to_owned(),
            chunk_rows: 16384,
        },
    );

    // **Audit closure (Codex LOW-1):** assert exact convergence on
    // the name set + ordering, not just "both names present in each
    // peer's view." A regression that left peers with different
    // sheet-id → name mappings would pass the looser check.
    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
        .collect();
    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())
        .collect();

    assert_eq!(
        names_a, names_b,
        "convergence: both peers' sheet-id → name mappings must match exactly"
    );
    // After D-2 auto-rename, exact result is {Calc, Calc(2)} in
    // sheet-id order. Loro's causal merge picks the same first-wins
    // outcome for both peers (we don't predict WHICH peer became
    // Calc(2), but both peers agree).
    assert_eq!(
        names_a,
        vec!["Calc".to_string(), "Calc(2)".to_string()],
        "D-2 auto-rename: sheets must be [Calc, Calc(2)] in id order; got {names_a:?}"
    );
}

// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====

/// **Conflict-matrix row 7 (Phase 5.3 step 3 — REPAIR PASS APPLIED):**
/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
/// formula at A2 referencing "S!A1" (the old name). After merge +
/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
/// literal at S2!A1, originally at S!A1 before rename).
///
/// **Pre-step-3 behavior** (kept here as historical context):
/// without the repair pass, the formula bind-failed at recompute →
/// `Value::Error(ErrorValue::Name)` per the D-3 V1 limitation. Step
/// 3's rename-repair pass closes that limitation.
///
/// **Test is intentionally bidirectional via `fork_apply_merge_both_directions`**
/// — both peers, after merge + repair, must converge to the same
/// formula text + resolved value.
#[test]
fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
    // Base: sheet S with a literal at S!A1 = 42.0.
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Use the bidirectional helper to fork the two peers + apply
    // their concurrent ops + cross-merge — but we have to interpose
    // the repair pass between replay and recompute. The fork helper
    // doesn't know about repair (it's a step-2-and-earlier helper),
    // so we duplicate its logic inline here for the step 3 case.
    let mut peer_a = OpLog::import_bytes(&base).unwrap();
    peer_a.set_peer_id(1).unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
    peer_b_for_a.set_peer_id(2).unwrap();
    peer_b_for_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Symmetric peer B view.
    let mut peer_b = OpLog::import_bytes(&base).unwrap();

exec
/bin/zsh -lc "rg -n \"row7|repair_sheet|RenameSheet|#NAME|42\\.0|ql_collab\" quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
27://! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
28://!   PRE-FIX behavior** (#NAME? per D-3 V1 limitation). Phase 5.3
33://!   (D-3 → #NAME?; no repair planned — drop is destructive)
500:// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====
505:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
506:/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
518:fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
519:    // Base: sheet S with a literal at S!A1 = 42.0.
526:            value: CellWireValue::Number(42.0),
539:        .append(Op::RenameSheet {
573:        .append(Op::RenameSheet {
590:        // this call, recompute would surface #NAME? (D-3 V1 limitation).
591:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
592:            .expect("repair_sheet_rename_chain must succeed");
612:    // cell at S2!A1 is the literal 42.0 from the base log.
615:        Value::Number(42.0),
617:         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
634:/// `#NAME?` (D-3 mapping `e71312d4bcd` shipped).
638:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
646:/// no longer contains T) regardless of causal order → #NAME? is
672:    // fails → #NAME? per D-3.
676:        "A5 must emit #NAME? (D-3: BindError::UnknownTable → ErrorValue::Name); got {a5_a:?}"

exec
/bin/zsh -lc 'rg -n "rewrite_formula_text_for_sheet_rename|rewrite_sheet_name_in_expr|canonical_sheet_name|iter_formulas|put_formula|rename" quantbook-engine/crates/ql-exec/src quantbook-engine/crates/ql-storage/src quantbook-engine/crates/ql-formula-syntax/src quantbook-engine/crates/ql-oplog/src | head -200' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/sheet.rs:116:    /// is the caller's responsibility (see `Workbook::rename_sheet` and
quantbook-engine/crates/ql-storage/src/tables.rs:9://! rename / resize / drop) lands in 4.8.H + 4.8.I + 4.8.J via the
quantbook-engine/crates/ql-storage/src/tables.rs:26:/// Stable across renames within the table; never reused. Future phases (4.10
quantbook-engine/crates/ql-storage/src/tables.rs:285:    /// invalidation keys can include this so column renames / resizes
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:157:        // a cell rename anywhere can affect the result.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:166:/// **W5-RT-1 (RT-V1-01) — Step 1.1 / S1-HIGH-D rename:** reference-aware
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:367:        // hooks fire (table rename / drop / column rename / resize).
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:397:///   rename / retarget invalidates this formula, but do NOT push to
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:421:        // Structural-dep only: rename / retarget invalidates this
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:474:    /// hooks (drop / rename / column rename / resize) to BFS-fan
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:478:    /// Consumed by `on_table_drop` (W5-154/W5-155), `on_table_rename`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:479:    /// (W5-157), `on_column_rename` (W5-158), and `on_table_resize`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:523:    /// invocations. Sister counters below (`table_rename`,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:524:    /// `column_rename`, `table_resize`) cover the other shipped
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:528:    /// **W5-157 (Phase 4.8.G.3):** counts of `on_table_rename`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:530:    pub table_rename: u64,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:531:    /// **W5-158 (Phase 4.8.G.3):** counts of `on_column_rename`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:533:    pub column_rename: u64,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:798:        // `on_table_*` hooks (drop today; rename/column/resize in
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:877:            .iter_formulas()
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1132:        // present (covers tables renamed under a different case
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1154:    /// `WorkbookRuntime::rename_table`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1156:    /// `ast::rewrite_table_ref` + `put_formula` (storage layer —
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1172:    /// table name. The resolved Range is unchanged by rename (same
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1178:    /// `rename_table`'s `to_ascii_uppercase()` normalization). The
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1180:    pub fn on_table_rename(&mut self, old_name: &str, new_name: &str) {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1181:        self.hook_counts.table_rename = self.hook_counts.table_rename.saturating_add(1);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1245:    /// `WorkbookRuntime::rename_column`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1247:    /// via `ast::rewrite_column_ref` + `put_formula` (storage layer
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1253:    /// Unlike `on_table_rename`, the table NAME is unchanged so
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1256:    /// without dirty-fan, `recompute_dirty` skips the renamed
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1257:    /// formulas and the post-rename plan cache never repopulates.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1268:    /// those whose AST referenced the renamed column. The reverse
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1278:    /// the column didn't yet exist): a subsequent `rename_column`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1288:    pub fn on_column_rename(&mut self, table_name: &str, _old_col: &str, _new_col: &str) {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1289:        self.hook_counts.column_rename = self.hook_counts.column_rename.saturating_add(1);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1325:    /// Like `on_column_rename`, the fanout is coarse — every
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1770:            wb.put_formula(*sheet, *row, *col, *text);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1961:        wb.put_formula(0, 0, 5, "SUM(Block)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2006:        wb.put_formula(0, 0, 5, "SUM(Sales)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2007:        wb.put_formula(0, 1, 5, "AVERAGE(Sales) + SUM(Sales)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2128:        wb.put_formula(0, 0, 5, "SUM(MyRange) + NOW()");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2226:        wb.put_formula(0, 0, 1, "SUM(Sales)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2227:        wb.put_formula(0, 0, 2, "B1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2335:        wb.put_formula(0, formula_cell.0, formula_cell.1, "SUM(MyRange)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2445:        wb.put_formula(0, 0, 10, "SUM(WholeColumnA)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2446:        wb.put_formula(0, 1, 10, "SUM(WholeRowFive)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2447:        wb.put_formula(0, 2, 10, "SUM(BoundedRect)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2525:        wb.put_formula(0, 0, 1, "SUM(ColA)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2559:        wb.put_formula(0, 0, 2, "A1 + B1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2602:        wb.put_formula(0, 0, 5, "SUM(Discount)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2603:        wb.put_formula(0, 1, 5, "AVERAGE(Discount)");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2605:        wb.put_formula(0, 2, 5, "1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2632:        wb.put_formula(0, 0, 2, "A1 + B1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2633:        wb.put_formula(0, 0, 3, "C1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3493:        wb.put_formula(0, 0, 1, "A1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3494:        wb.put_formula(0, 0, 2, "B1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3549:        wb.put_formula(0, 0, 0, "B1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3550:        wb.put_formula(0, 0, 1, "A1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3552:        wb.put_formula(0, 0, 3, "D1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3615:        wb.put_formula(0, 0, 1, "A1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3616:        wb.put_formula(0, 0, 2, "B1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3620:        wb.put_formula(0, 0, 4, "Z1 + 1");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:3755:    /// (Per Codex W5-102 LOW-2: renamed to clarify this is two-readers,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4122:    // W5-157 (Phase 4.8.G.3) — on_table_rename hook tests.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4124:    /// **W5-157:** `on_table_rename` re-keys `table_to_formulas` so a
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4128:    fn on_table_rename_rekeys_index_and_dirties_readers() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4144:        s.on_table_rename("SALES", "ORDERS");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4145:        // Drain the rename's own dirty fanout so the next take_dirty()
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4154:            "after rename, dropping the OLD name must not dirty the reader"
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4162:            "after rename, dropping the NEW name must dirty the reader"
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4167:    /// later drop / drop-after-rename behavior).
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4169:    fn on_table_rename_dirties_readers_directly() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4185:        s.on_table_rename("SALES", "ORDERS");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4189:            "on_table_rename must dirty the reader directly"
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4197:    fn on_table_rename_updates_formula_deps_tables_in_place() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4212:        s.on_table_rename("SALES", "ORDERS");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4217:            "deps.tables must contain ORDERS after rename — got {:?}",
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4222:            "deps.tables must not retain SALES after rename — got {:?}",
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4227:    /// **W5-157:** `HookCounts.table_rename` bumps per invocation.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4229:    fn on_table_rename_bumps_hook_count() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4231:        assert_eq!(s.hook_counts().table_rename, 0);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4232:        s.on_table_rename("Foo", "Bar");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4233:        assert_eq!(s.hook_counts().table_rename, 1);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4234:        s.on_table_rename("Bar", "Baz");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4235:        assert_eq!(s.hook_counts().table_rename, 2);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4238:    // W5-158 (Phase 4.8.G.3) — on_column_rename hook tests.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4240:    /// **W5-158:** `on_column_rename` dirty-fans every reader of the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4244:    fn on_column_rename_dirties_all_table_readers() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4271:        s.on_column_rename("SALES", "Qty", "Quantity");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4274:        // Coarse: F2 (Price reader, untouched by the rename) also dirties.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4282:    /// **W5-158:** `on_column_rename` does NOT touch
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4285:    /// copying the on_table_rename Arc-rewrite logic.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4287:    fn on_column_rename_leaves_deps_tables_unchanged() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4302:        s.on_column_rename("SALES", "Qty", "Quantity");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4308:            "deps.tables unchanged by column rename"
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4312:    /// **W5-158:** `HookCounts.column_rename` bumps per invocation.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4314:    fn on_column_rename_bumps_hook_count() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4316:        assert_eq!(s.hook_counts().column_rename, 0);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4317:        s.on_column_rename("T", "a", "b");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4318:        assert_eq!(s.hook_counts().column_rename, 1);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4319:        s.on_column_rename("T", "b", "c");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4320:        assert_eq!(s.hook_counts().column_rename, 2);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4390:    /// **W5-158:** `on_column_rename` case-insensitive table-name
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4393:    fn on_column_rename_case_insensitive_table_lookup() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4409:        s.on_column_rename("SALES", "Qty", "Quantity");
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4420:    fn on_table_rename_case_insensitive_fallback() {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4437:        s.on_table_rename("SALES", "ORDERS");
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:276:/// `WorkbookRuntime::rename_sheet` to update stored formula text
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:277:/// after a sheet rename, via a parse → rewrite → print round trip.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:282:pub fn rewrite_sheet_name_in_expr(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:299:            lhs: Box::new(rewrite_sheet_name_in_expr(lhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:300:            rhs: Box::new(rewrite_sheet_name_in_expr(rhs, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:304:            operand: Box::new(rewrite_sheet_name_in_expr(operand, old_canonical, new_name)),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:310:                .map(|a| rewrite_sheet_name_in_expr(a, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:317:                        .map(|cell| rewrite_sheet_name_in_expr(cell, old_canonical, new_name))
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:322:        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_sheet_name_in_expr(
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:349:            rewrite_sheet_name_in_expr(inner, old_canonical, new_name),
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:356:/// Mirrors [`rewrite_sheet_name_in_expr`] in spirit but for tables.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:358:/// Used by `WorkbookRuntime::rename_table` to update formula text
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:359:/// (Excel canon: renames cascade through stored formula text, so
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:435:/// `WorkbookRuntime::rename_column`.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:929:    // W5-91 (Phase 4.6.C) — rewrite_sheet_name_in_expr coverage.
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:942:    fn rewrite_renames_matching_cellref_sheet_name() {
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:945:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:960:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:963:        // SheetRef::Id passes through untouched (rename hits AST by name,
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:964:        // not by id — Id-bound refs survive across renames by design).
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:966:        let out_id = rewrite_sheet_name_in_expr(&expr_id, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:974:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:991:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1030:        let out = rewrite_sheet_name_in_expr(&rng, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1045:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1058:    // the `oplog_e2e` `rename_column_op_log_replay_reconstructs_rename`
quantbook-engine/crates/ql-formula-syntax/src/ast.rs:1136:        // `Sales[[Qty]:[Price]]` with rename Qty→Quantity — only c1
quantbook-engine/crates/ql-oplog/src/replay.rs:15://! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
quantbook-engine/crates/ql-oplog/src/replay.rs:31://! are — `put_at` / `put_formula` / `clear_formula` / `set_name` /
quantbook-engine/crates/ql-oplog/src/replay.rs:139:    /// Under CRDT merge of concurrent renames, current name may
quantbook-engine/crates/ql-oplog/src/replay.rs:141:    /// the rename to the current sheet (last-in-causal-order wins
quantbook-engine/crates/ql-oplog/src/replay.rs:148:        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
quantbook-engine/crates/ql-oplog/src/replay.rs:151:        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
quantbook-engine/crates/ql-oplog/src/replay.rs:161:    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
quantbook-engine/crates/ql-oplog/src/replay.rs:164:        "replay rename-sheet rejected at op index {index}: sheet {id} \
quantbook-engine/crates/ql-oplog/src/replay.rs:209:    /// the source column was already dropped/renamed before this op, or
quantbook-engine/crates/ql-oplog/src/replay.rs:212:        "replay rename-column at op index {index}: table {table:?} \
quantbook-engine/crates/ql-oplog/src/replay.rs:224:    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
quantbook-engine/crates/ql-oplog/src/replay.rs:390:            workbook.put_formula(*sheet, *row, *col, text.as_str());
quantbook-engine/crates/ql-oplog/src/replay.rs:451:            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
quantbook-engine/crates/ql-oplog/src/replay.rs:459:            // Sheets, which auto-renames to S(2)). Now we walk
quantbook-engine/crates/ql-oplog/src/replay.rs:461:            // `Empty` + `ReservedCharacter` still reject — auto-rename
quantbook-engine/crates/ql-oplog/src/replay.rs:504:            // + CRDT concurrent-rename policy.
quantbook-engine/crates/ql-oplog/src/replay.rs:514:            //      silently dropped case-only renames (e.g. "Sheet1" →
quantbook-engine/crates/ql-oplog/src/replay.rs:515:            //      "SHEET1"). Storage permits case-only renames and
quantbook-engine/crates/ql-oplog/src/replay.rs:518:            //   2. Otherwise → apply the rename. Subsumes:
quantbook-engine/crates/ql-oplog/src/replay.rs:519:            //      - pre-step-2 case 2 (current == old_name; fresh rename).
quantbook-engine/crates/ql-oplog/src/replay.rs:525:            //      - case-only rename (canonical equal, display differs).
quantbook-engine/crates/ql-oplog/src/replay.rs:527:            // **HIGH-1 audit closure (Codex + Opus convergent):** rename
quantbook-engine/crates/ql-oplog/src/replay.rs:536:            // D-2 (AddSheet auto-rename) set the precedent at
quantbook-engine/crates/ql-oplog/src/replay.rs:539:            // still reject — auto-rename only resolves collisions.
quantbook-engine/crates/ql-oplog/src/replay.rs:546:            //     `WorkbookRuntime::rename_sheet` validates, but a
quantbook-engine/crates/ql-oplog/src/replay.rs:564:            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
quantbook-engine/crates/ql-oplog/src/replay.rs:569:                match workbook.rename_sheet(*id, chosen.clone()) {
quantbook-engine/crates/ql-oplog/src/replay.rs:693:            apply_rename_table(workbook, index, old_name, new_name)
quantbook-engine/crates/ql-oplog/src/replay.rs:699:        } => apply_rename_column(workbook, index, table, old_name, new_name),
quantbook-engine/crates/ql-oplog/src/replay.rs:745:fn apply_rename_table(
quantbook-engine/crates/ql-oplog/src/replay.rs:768:                reason: "table with this canonical name already exists (rename target)",
quantbook-engine/crates/ql-oplog/src/replay.rs:775:                reason: "defined-name with this canonical name already exists (rename target)",
quantbook-engine/crates/ql-oplog/src/replay.rs:795:/// invalidate. Same-canonical column renames are rejected — the producer
quantbook-engine/crates/ql-oplog/src/replay.rs:798:fn apply_rename_column(
quantbook-engine/crates/ql-oplog/src/replay.rs:835:            reason: "rename to same canonical column name (producer should not emit)",
quantbook-engine/crates/ql-oplog/src/replay.rs:843:            reason: "column with this canonical name already exists (rename target)",
quantbook-engine/crates/ql-oplog/src/replay.rs:1241:    fn replay_put_formula_persists_text_only() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1643:    fn replay_rename_sheet_basic() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1665:    fn replay_rename_sheet_already_renamed_is_noop() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1688:    /// Post-step-2 that case applies the rename to the current
quantbook-engine/crates/ql-oplog/src/replay.rs:1692:    /// The renamed test reflects the new property: replay applies
quantbook-engine/crates/ql-oplog/src/replay.rs:1693:    /// the rename even when current ≠ old_name.
quantbook-engine/crates/ql-oplog/src/replay.rs:1695:    fn replay_rename_sheet_current_neither_old_nor_new_applies_rename() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1697:        // Phase 5.3 step 2, this is the canonical concurrent-rename
quantbook-engine/crates/ql-oplog/src/replay.rs:1698:        // scenario: another peer's rename already changed the sheet
quantbook-engine/crates/ql-oplog/src/replay.rs:1700:        // peer thought was current," and replay applies the rename
quantbook-engine/crates/ql-oplog/src/replay.rs:1713:        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
quantbook-engine/crates/ql-oplog/src/replay.rs:1717:            "Phase 5.3 step 2: 'last-in-causal-order wins' — rename applies to current sheet"
quantbook-engine/crates/ql-oplog/src/replay.rs:1722:    fn replay_rename_sheet_invalid_id_errors() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1738:    /// test name + assertion inverted by the D-2-compatible auto-rename
quantbook-engine/crates/ql-oplog/src/replay.rs:1742:    /// mirrors D-2's AddSheet auto-rename. The merged log is no longer
quantbook-engine/crates/ql-oplog/src/replay.rs:1743:    /// un-replayable; both peers' rename intents are preserved (with
quantbook-engine/crates/ql-oplog/src/replay.rs:1746:    fn replay_rename_sheet_duplicate_target_auto_disambiguates() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1771:        // Sheet 0 was renamed; "Sheet2" was already taken by sheet 1, so
quantbook-engine/crates/ql-oplog/src/replay.rs:1772:        // auto-rename suffixes to "Sheet2(2)".
quantbook-engine/crates/ql-oplog/src/replay.rs:1778:    fn replay_rename_inside_batchcommit() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1779:        // Producer pattern: rewrite-then-rename batched as a single
quantbook-engine/crates/ql-oplog/src/replay.rs:1928:    fn replay_add_sheet_canonical_duplicate_auto_renames() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1929:        // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename replaces
quantbook-engine/crates/ql-oplog/src/replay.rs:1935:        // second auto-renames to `Sheet1(2)` rather than rejecting.
quantbook-engine/crates/ql-oplog/src/replay.rs:1954:        replay_into(&log, &mut wb, &reg).expect("auto-rename succeeds");
quantbook-engine/crates/ql-oplog/src/replay.rs:1958:        // Second sheet auto-renamed (original was "SHEET1" which is
quantbook-engine/crates/ql-oplog/src/replay.rs:1964:    fn replay_add_sheet_auto_rename_walks_suffix_until_free() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1986:    fn replay_add_sheet_auto_rename_skips_already_taken_suffix() {
quantbook-engine/crates/ql-oplog/src/replay.rs:2016:            "auto-rename must skip already-taken (2) and land on (3)"

exec
/bin/zsh -lc "cargo metadata --manifest-path quantbook-engine/Cargo.toml --format-version 1 --no-deps >/tmp/qb-metadata.json && jq '.packages[] | select(.name==\"ql-exec\" or .name==\"ql-collab\") | {name, dependencies: [.dependencies[] | {name, kind, path}]}' /tmp/qb-metadata.json" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 344ms:
{
  "name": "ql-collab",
  "dependencies": [
    {
      "name": "loro",
      "kind": null,
      "path": null
    },
    {
      "name": "ql-formula-syntax",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax"
    },
    {
      "name": "ql-functions",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"
    },
    {
      "name": "ql-oplog",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"
    },
    {
      "name": "ql-storage",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"
    },
    {
      "name": "ql-types",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"
    },
    {
      "name": "serde",
      "kind": null,
      "path": null
    },
    {
      "name": "serde_json",
      "kind": null,
      "path": null
    },
    {
      "name": "thiserror",
      "kind": null,
      "path": null
    }
  ]
}
{
  "name": "ql-exec",
  "dependencies": [
    {
      "name": "arrow-array",
      "kind": null,
      "path": null
    },
    {
      "name": "multiversion",
      "kind": null,
      "path": null
    },
    {
      "name": "ql-calcgraph",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph"
    },
    {
      "name": "ql-formula-syntax",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax"
    },
    {
      "name": "ql-functions",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"
    },
    {
      "name": "ql-io",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io"
    },
    {
      "name": "ql-oplog",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"
    },
    {
      "name": "ql-storage",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"
    },
    {
      "name": "ql-types",
      "kind": null,
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"
    },
    {
      "name": "thiserror",
      "kind": null,
      "path": null
    },
    {
      "name": "criterion",
      "kind": "dev",
      "path": null
    },
    {
      "name": "proptest",
      "kind": "dev",
      "path": null
    },
    {
      "name": "ql-collab",
      "kind": "dev",
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab"
    },
    {
      "name": "ql-profile",
      "kind": "dev",
      "path": "/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile"
    },
    {
      "name": "tempfile",
      "kind": "dev",
      "path": null
    }
  ]
}

exec
/bin/zsh -lc "sed -n '520,640p' quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    let mut base_log = base_with_sheet();
    base_log
        .append(Op::PutValue {
            sheet: 0,
            row: 0,
            col: 0,
            value: CellWireValue::Number(42.0),
        })
        .unwrap();
    let base = base_log.export_bytes().unwrap();

    // Use the bidirectional helper to fork the two peers + apply
    // their concurrent ops + cross-merge — but we have to interpose
    // the repair pass between replay and recompute. The fork helper
    // doesn't know about repair (it's a step-2-and-earlier helper),
    // so we duplicate its logic inline here for the step 3 case.
    let mut peer_a = OpLog::import_bytes(&base).unwrap();
    peer_a.set_peer_id(1).unwrap();
    peer_a
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
    peer_b_for_a.set_peer_id(2).unwrap();
    peer_b_for_a
        .append(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    peer_a
        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
        .unwrap();

    // Symmetric peer B view.
    let mut peer_b = OpLog::import_bytes(&base).unwrap();
    peer_b.set_peer_id(2).unwrap();
    peer_b
        .append(Op::PutFormula {
            sheet: 0,
            row: 1,
            col: 0,
            text: "S!A1".to_owned(),
        })
        .unwrap();
    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
    peer_a_for_b.set_peer_id(1).unwrap();
    peer_a_for_b
        .append(Op::RenameSheet {
            id: 0,
            old_name: "S".to_owned(),
            new_name: "S2".to_owned(),
        })
        .unwrap();
    peer_b
        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
        .unwrap();

    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
    let replay_repair_recompute = |log: &OpLog| -> Workbook {
        let mut wb = Workbook::new();
        let reg = default_registry();
        replay_into(log, &mut wb, &reg).expect("replay must succeed");
        // **Step 3 closure point**: the repair pass rewrites concurrent
        // formula text referencing pre-rename sheet names. Without
        // this call, recompute would surface #NAME? (D-3 V1 limitation).
        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
            .expect("repair_sheet_rename_chain must succeed");
        assert_eq!(
            report.formulas_rewritten, 1,
            "exactly 1 formula (peer B's =S!A1) must be rewritten"
        );
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.recompute_all();
        }
        wb
    };

    let wb_a = replay_repair_recompute(&peer_a);
    let wb_b = replay_repair_recompute(&peer_b);

    let a2_a = wb_a.read(Address::new(0, 1, 0));
    let a2_b = wb_b.read(Address::new(0, 1, 0));

    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
    // cell at S2!A1 is the literal 42.0 from the base log.
    assert_eq!(
        a2_a,
        Value::Number(42.0),
        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
    );

    // Pin the formula text directly to confirm the repair did its job.
    assert_eq!(
        wb_a.formula_at(0, 1, 0).map(|s| s.to_string()),
        Some("S2!A1".to_string()),
        "formula text post-repair must reference current sheet name (S2)"
    );
}

// ===== Row 8: DropTable × concurrent edit referencing T =====

/// **Conflict-matrix row 8:** peer A drops table T; peer B
/// concurrently writes a formula referencing T at A5 (outside the
/// table footprint). After merge: T is dropped + formula's
/// `T[X]` reference binds to UnknownTable → recompute emits
/// `#NAME?` (D-3 mapping `e71312d4bcd` shipped).
///
/// **Audit closure (Codex finding on row 7→8 numbering)**: this
/// test was originally labeled "row 7" but the design doc has
/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
/// Renumbered to match the design doc.
///

exec
/bin/zsh -lc "sed -n '260,380p' quantbook-engine/crates/ql-formula-syntax/src/ast.rs && sed -n '929,1075p' quantbook-engine/crates/ql-formula-syntax/src/ast.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    /// **W5-87 (Phase 4.6.A part 1):** if already resolved to an id,
    /// return it; if `Current`, return None (caller decides what
    /// default to use). Used by code paths that DON'T have an owning-
    /// sheet context handy.
    pub fn id(&self) -> Option<SheetId> {
        match self {
            SheetRef::Current => None,
            SheetRef::Id(s) => Some(*s),
            SheetRef::Name(_) => None,
        }
    }
}

/// **W5-91 (Phase 4.6.C):** recursively rewrite every `SheetRef::Name`
/// in `expr` whose canonical form (ASCII uppercase) matches
/// `old_canonical` to `SheetRef::Name(new_name)`. Used by
/// `WorkbookRuntime::rename_sheet` to update stored formula text
/// after a sheet rename, via a parse → rewrite → print round trip.
///
/// Returns a new Expr; the input is not mutated. `Current` and `Id`
/// sheet refs pass through unchanged. Non-matching `Name` entries
/// also pass through.
pub fn rewrite_sheet_name_in_expr(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => Expr::CellRef(CellAddr {
            sheet: rewrite_sheet_ref(&addr.sheet, old_canonical, new_name),
            col: addr.col,
            row: addr.row,
            abs_col: addr.abs_col,
            abs_row: addr.abs_row,
        }),
        Expr::RangeRef(r) => Expr::RangeRef(rewrite_range_ref(r, old_canonical, new_name)),
        Expr::Binary { op, lhs, rhs } => Expr::Binary {
            op: *op,
            lhs: Box::new(rewrite_sheet_name_in_expr(lhs, old_canonical, new_name)),
            rhs: Box::new(rewrite_sheet_name_in_expr(rhs, old_canonical, new_name)),
        },
        Expr::Unary { op, operand } => Expr::Unary {
            op: *op,
            operand: Box::new(rewrite_sheet_name_in_expr(operand, old_canonical, new_name)),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| rewrite_sheet_name_in_expr(a, old_canonical, new_name))
                .collect(),
        },
        Expr::Array(rows) => Expr::Array(
            rows.iter()
                .map(|row| {
                    row.iter()
                        .map(|cell| rewrite_sheet_name_in_expr(cell, old_canonical, new_name))
                        .collect()
                })
                .collect(),
        ),
        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_sheet_name_in_expr(
            inner,
            old_canonical,
            new_name,
        ))),
        // **W5-139 (Phase 4.9.C):** intermediate R1C1 ref carries a
        // SheetRef just like CellRef — rewrite identically. Axis
        // values are sheet-agnostic and clone through.
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => Expr::R1C1Ref {
            sheet: rewrite_sheet_ref(sheet, old_canonical, new_name),
            row_axis: *row_axis,
            col_axis: *col_axis,
        },
        // W5-112 (Phase 4.8.C): structured refs have no SheetRef
        // (table names are workbook-scoped). Clone through.
        Expr::StructuredRef { table_name, spec } => Expr::StructuredRef {
            table_name: table_name.clone(),
            spec: spec.clone(),
        },
        // **W5-143 (Phase 4.9.G):** implicit-intersection — recurse
        // into inner. Sheet ref lives on the wrapped expr (per
        // `apply_sheet_to_term` placing the sheet INSIDE `@`).
        Expr::ImplicitIntersection(inner) => Expr::ImplicitIntersection(Box::new(
            rewrite_sheet_name_in_expr(inner, old_canonical, new_name),
        )),
    }
}

/// **W5-119 (Phase 4.8.I):** rewrite every `Expr::StructuredRef`
/// referencing `old_canonical` (case-insensitive) to the new name.
/// Mirrors [`rewrite_sheet_name_in_expr`] in spirit but for tables.
///
/// Used by `WorkbookRuntime::rename_table` to update formula text
/// (Excel canon: renames cascade through stored formula text, so
/// the next bind sees the new name and binds successfully).
pub fn rewrite_table_ref(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
    match expr {
        Expr::Number(n) => Expr::Number(*n),
        Expr::String(s) => Expr::String(s.clone()),
        Expr::Bool(b) => Expr::Bool(*b),
        Expr::NameRef(n) => Expr::NameRef(n.clone()),
        Expr::Error(ev) => Expr::Error(*ev),
        Expr::CellRef(addr) => Expr::CellRef(addr.clone()),
        Expr::RangeRef(r) => Expr::RangeRef(r.clone()),
        Expr::Binary { op, lhs, rhs } => Expr::Binary {
            op: *op,
            lhs: Box::new(rewrite_table_ref(lhs, old_canonical, new_name)),
            rhs: Box::new(rewrite_table_ref(rhs, old_canonical, new_name)),
        },
        Expr::Unary { op, operand } => Expr::Unary {
            op: *op,
            operand: Box::new(rewrite_table_ref(operand, old_canonical, new_name)),
        },
        Expr::Function { name, args } => Expr::Function {
            name: name.clone(),
    // W5-91 (Phase 4.6.C) — rewrite_sheet_name_in_expr coverage.

    fn cell(sheet: SheetRef, col: u32, row: u32) -> Expr {
        Expr::CellRef(CellAddr {
            sheet,
            col,
            row,
            abs_col: false,
            abs_row: false,
        })
    }

    #[test]
    fn rewrite_renames_matching_cellref_sheet_name() {
        let expr = cell(SheetRef::Name(Arc::from("OldSheet")), 0, 0);
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
        match out {
            Expr::CellRef(addr) => match addr.sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_skips_current_and_id_sheet_refs() {
        // SheetRef::Current passes through untouched.
        let expr = cell(SheetRef::Current, 0, 0);
        let new_name: Arc<str> = Arc::from("New");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        assert_eq!(out, expr);

        // SheetRef::Id passes through untouched (rename hits AST by name,
        // not by id — Id-bound refs survive across renames by design).
        let expr_id = cell(SheetRef::Id(7), 0, 0);
        let out_id = rewrite_sheet_name_in_expr(&expr_id, "OLD", &new_name);
        assert_eq!(out_id, expr_id);
    }

    #[test]
    fn rewrite_non_matching_name_passes_through() {
        let expr = cell(SheetRef::Name(Arc::from("Other")), 0, 0);
        let new_name: Arc<str> = Arc::from("New");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        assert_eq!(out, expr);
    }

    #[test]
    fn rewrite_recurses_into_binary_and_function() {
        let lhs = cell(SheetRef::Name(Arc::from("Old")), 0, 0);
        let rhs_inner = cell(SheetRef::Name(Arc::from("Old")), 1, 0);
        let expr = Expr::Binary {
            op: crate::token::Operator::Plus,
            lhs: Box::new(lhs),
            rhs: Box::new(Expr::Function {
                name: Arc::from("SUM"),
                args: vec![rhs_inner],
            }),
        };
        let new_name: Arc<str> = Arc::from("Renamed");
        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
        match out {
            Expr::Binary { lhs, rhs, .. } => {
                match *lhs {
                    Expr::CellRef(addr) => match addr.sheet {
                        SheetRef::Name(n) => assert_eq!(&*n, "Renamed"),
                        other => panic!("expected SheetRef::Name, got {other:?}"),
                    },
                    other => panic!("expected CellRef in lhs, got {other:?}"),
                }
                match *rhs {
                    Expr::Function { args, .. } => match &args[0] {
                        Expr::CellRef(addr) => match &addr.sheet {
                            SheetRef::Name(n) => assert_eq!(&**n, "Renamed"),
                            other => panic!("expected SheetRef::Name, got {other:?}"),
                        },
                        other => panic!("expected CellRef arg, got {other:?}"),
                    },
                    other => panic!("expected Function in rhs, got {other:?}"),
                }
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_recurses_into_rangeref_cells() {
        let rng = Expr::RangeRef(RangeRef::Cells {
            sheet: SheetRef::Name(Arc::from("OldSheet")),
            start_col: 0,
            start_row: 0,
            end_col: 2,
            end_row: 4,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        });
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&rng, "OLDSHEET", &new_name);
        match out {
            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => match sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected RangeRef::Cells, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_is_case_insensitive_on_match() {
        // Stored ref is "oldsheet" lower; canonical comparison key is uppercase.
        let expr = cell(SheetRef::Name(Arc::from("oldsheet")), 0, 0);
        let new_name: Arc<str> = Arc::from("NewSheet");
        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
        match out {
            Expr::CellRef(addr) => match addr.sheet {
                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
                other => panic!("expected SheetRef::Name, got {other:?}"),
            },
            other => panic!("expected CellRef, got {other:?}"),
        }
    }

    // ===== W5-129 (Phase 4.8.O.5 — Sonnet cross-validation LOW-NEW-1) =====
    //
    // `rewrite_column_ref` was previously tested only transitively via
    // the `oplog_e2e` `rename_column_op_log_replay_reconstructs_rename`
    // end-to-end test. Sonnet's W5-128 cross-validation pass confirmed
    // the code is correct but flagged the missing unit-level pins.
    // These 5 tests target each non-Combination spec variant + the
    // string-literal immunity property + the cross-table isolation guard.

    fn sref(table_name: &str, spec: TableSpecSubtree) -> Expr {
        Expr::StructuredRef {
            table_name: Arc::from(table_name),
            spec,
        }
    }

    #[test]
    fn rewrite_column_ref_string_literal_is_immune() {
        // `="The Qty column"` — the string literal contains "Qty" but
        // it's `Expr::String`, not a StructuredRef. The walker must
        // pass it through unchanged.

exec
/bin/zsh -lc "sed -n '1,110p' quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs && sed -n '500,590p' quantbook-engine/crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Sheet mutation API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.3 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side sheet methods + a tokenization-aware formula-text
//! rewriter helper used by rename_sheet. Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
//!   validate name + chunk_rows, emit `Op::AddSheet`.
//! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
//!   rewrite cross-sheet refs in stored formula text via
//!   lex→parse→rewrite→print, emit `BatchCommit` containing every
//!   `PutFormula` rewrite + the `RenameSheet` op.

use std::sync::Arc;

use ql_oplog::Op;
use ql_types::{ColId, RowId, SheetId};

use super::{RuntimeError, WorkbookRuntime};

/// **W5-91 (Phase 4.6.C):** rewrite cross-sheet refs in a formula text
/// when a sheet is renamed. Round-trips `text → lex → parse → rewrite
/// → print` so substitution is tokenization-aware (string literals,
/// quoted-sheet escapes, function calls, etc. all get the right
/// treatment).
///
/// Returns `Some(new_text)` if the rewrite changed the formula,
/// `None` otherwise (so the caller can skip the storage write +
/// op-log entry when there's nothing to record).
///
/// Defensive: if `lex` or `parse` fails (corrupted historical text),
/// returns `None` rather than propagating an error — the rename
/// shouldn't break otherwise-recoverable workbooks.
fn rewrite_formula_text_for_sheet_rename(
    text: &str,
    old_canonical: &str,
    new_name: &Arc<str>,
) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = ql_formula_syntax::lex(stripped).ok()?;
    let expr = ql_formula_syntax::parse(tokens).ok()?;
    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
    if rewritten == expr {
        // Nothing changed; preserve the original text (avoids spurious
        // op-log entries and skips the round-trip-printing's canonical-
        // form rewrites for formulas that have no sheet references).
        return None;
    }
    let printed = ql_formula_syntax::print(&rewritten);
    // Preserve a leading `=` if the original had one.
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
}

impl<'a> WorkbookRuntime<'a> {
    /// **W5-92 (Phase 4.6.D):** create a new sheet,
    /// emitting `Op::AddSheet` into the attached op log (if any). Returns
    /// the new sheet's `SheetId`. Wraps `Workbook::add_sheet_with_chunk_rows`.
    ///
    /// `chunk_rows` is the per-sheet chunk size. Pass `16_384` (the engine
    /// default) unless you have a specific reason — the qbook loader uses
    /// the saved chunk_rows so layouts round-trip.
    ///
    /// Direct callers of `Workbook::add_sheet` / `add_sheet_with_chunk_rows`
    /// bypass the op log silently — that path is documented as low-level.
    /// See GAP-O-02 in `docs/known-gaps.md`.
    pub fn add_sheet(
        &mut self,
        name: impl Into<String>,
        chunk_rows: u32,
    ) -> Result<SheetId, RuntimeError> {
        // Phase 2B.7 audit H1: pre-validate inputs BEFORE the op-log append
        // so a bad value can't leave a phantom AddSheet in the log followed
        // by a process-killing panic from `ColumnStore::with_chunk_rows` or
        // `Workbook::add_sheet_with_chunk_rows` (assert on `id >= SheetId::MAX`).
        if chunk_rows == 0 {
            return Err(RuntimeError::InvalidChunkRows(chunk_rows));
        }
        let current_sheet_count = self.workbook.sheet_count() as u32;
        if current_sheet_count >= SheetId::MAX as u32 {
            return Err(RuntimeError::TooManySheets {
                current: current_sheet_count,
                max: SheetId::MAX as u32,
            });
        }

        let name: String = name.into();
        // **W5-93 (Phase 4.6.E closure):** pre-validate the name BEFORE
        // appending to the op log so a duplicate or reserved-char name
        // can't leave a phantom `AddSheet` entry followed by a failed
        // mutation. Codex HIGH-1 flagged that the prior path silently
        // accepted any name at the storage boundary.
        self.workbook
            .validate_sheet_name(&name)
            .map_err(RuntimeError::SheetName)?;
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::AddSheet {
                name: name.clone(),
                chunk_rows,
            })?;
        }
        // Now infallible: validation already passed, so the storage call
        // can't return an error. Routes through the panicking convenience
            new_name,
        } => {
            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 + step-2 audit
            // closure (2026-05-20):** snapshot-vs-replay reconciliation
            // + CRDT concurrent-rename policy.
            //
            // Two cases (post-step-2-audit-closure):
            //
            //   1. Current display name == new_name (EXACT equality, not
            //      canonical) → idempotent. Replay-on-top-of-snapshot OR
            //      concurrent peers picked the same target. No-op.
            //
            //      **MEDIUM-1 audit closure (Codex):** pre-closure the
            //      idempotency check used canonical equality, which
            //      silently dropped case-only renames (e.g. "Sheet1" →
            //      "SHEET1"). Storage permits case-only renames and
            //      updates the display field; replay must do the same.
            //
            //   2. Otherwise → apply the rename. Subsumes:
            //      - pre-step-2 case 2 (current == old_name; fresh rename).
            //      - pre-step-2 case 3 (current ∈ neither; **Phase 5.3
            //        step 2 policy**, audit-locked: last-in-causal-order
            //        wins under CRDT merge — apply to current sheet name.
            //        Matches `crdt-data-model.md` § 311-334 last-wins
            //        rule for SetName + same-cell writes).
            //      - case-only rename (canonical equal, display differs).
            //
            // **HIGH-1 audit closure (Codex + Opus convergent):** rename
            // target collision (`new_name` already used by a different
            // sheet) auto-disambiguates via D-2-style suffix walk
            // (`<name>(2)`, `<name>(3)`, …). Pre-closure this propagated
            // `SheetRenameRejected` and hard-failed replay — same blast
            // radius as the original pre-step-2 bug, just shifted to a
            // different concurrent scenario (peer A: sheet0 S1→X, peer
            // B: sheet1 S3→X, both valid locally, second errors on merge).
            //
            // D-2 (AddSheet auto-rename) set the precedent at
            // `replay.rs:458-490`; RenameSheet now follows the same
            // pattern for consistency. `Empty` + `ReservedCharacter`
            // still reject — auto-rename only resolves collisions.
            //
            // Edge cases:
            //   - Sheet doesn't exist at id → `InvalidSheet` (unchanged).
            //   - `new_name` is empty → `SheetRenameRejected { source:
            //     SheetNameError::Empty }` propagated from storage. The
            //     wire op format does not enforce non-empty; producer-side
            //     `WorkbookRuntime::rename_sheet` validates, but a
            //     malformed log can still bypass that path. HIGH-2 audit
            //     closure (Opus): documented here.
            //   - Reserved-character in `new_name` → `SheetRenameRejected
            //     { source: ReservedCharacter(_) }`. Same caveat as Empty.
            const AUTO_RENAME_CEILING: u32 = 10_000;

            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
                ReplayError::InvalidSheet {
                    index,
                    sheet: *id,
                    sheet_count: workbook.sheet_count(),
                },
            )?;
            if current == *new_name {
                // Case 1: already at exact target display. No-op.
                return Ok(());
            }
            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
            // pattern. Empty + ReservedCharacter still reject.
            let mut chosen = new_name.clone();
            let mut suffix = 2u32;
            loop {
                match workbook.rename_sheet(*id, chosen.clone()) {
                    Ok(_) => return Ok(()),
                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
                        chosen = format!("{new_name}({suffix})");
                        suffix += 1;
                        if suffix > AUTO_RENAME_CEILING {
                            return Err(ReplayError::SheetRenameRejected {
                                index,
                                id: *id,
                                old_name: old_name.clone(),
                                new_name: new_name.clone(),
                                source: ql_storage::SheetNameError::Duplicate {
                                    name: new_name.clone(),
                                },
                            });
                        }
                    }
                    Err(other) => {
                        return Err(ReplayError::SheetRenameRejected {
                            index,
                            id: *id,
                            old_name: old_name.clone(),

exec
/bin/zsh -lc 'rg -n "pub fn canonical_sheet_name|fn canonical_sheet_name|pub fn iter_formulas|pub fn put_formula|pub fn rename_sheet|struct Workbook|formula_at" quantbook-engine/crates/ql-storage/src -n' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/workbook.rs:296:pub struct Workbook {
quantbook-engine/crates/ql-storage/src/workbook.rs:441:    pub fn canonical_sheet_name(name: &str) -> String {
quantbook-engine/crates/ql-storage/src/workbook.rs:478:    pub fn rename_sheet(
quantbook-engine/crates/ql-storage/src/workbook.rs:876:    pub fn put_formula(
quantbook-engine/crates/ql-storage/src/workbook.rs:920:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
quantbook-engine/crates/ql-storage/src/workbook.rs:931:    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
quantbook-engine/crates/ql-storage/src/workbook.rs:1082:    fn put_formula_at_max_row_max_col_ok() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1087:            wb.formula_at(0, 1_048_575, 16_383).map(|s| s.as_ref()),
quantbook-engine/crates/ql-storage/src/workbook.rs:1129:        assert!(wb.formula_at(0, 0, 0).is_none());
quantbook-engine/crates/ql-storage/src/workbook.rs:1138:        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("A1 + B1"));
quantbook-engine/crates/ql-storage/src/workbook.rs:1139:        assert!(wb.formula_at(s, 0, 1).is_none());
quantbook-engine/crates/ql-storage/src/workbook.rs:1149:        assert!(wb.formula_at(s, 0, 0).is_none());
quantbook-engine/crates/ql-storage/src/workbook.rs:1168:        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("B1 * 2"));
quantbook-engine/crates/ql-storage/src/workbook.rs:1203:        assert_eq!(wb.formula_at(s, 0, 0).map(|s| s.as_ref()), Some("A1 + 1"));
quantbook-engine/crates/ql-storage/src/workbook.rs:1245:    fn canonical_sheet_name_uppercases_ascii() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1252:    fn canonical_sheet_name_passes_non_ascii_through() {

codex
I’ve confirmed the repair pass uses final workbook names as targets, not the wire `new_name`, and that ql-exec’s row 7 explicitly interposes repair before recompute. I’m now checking the formula syntax behavior and replay edge cases where rule ordering or stale overlays could hide a bug.
exec
/bin/zsh -lc "rg -n \"BatchCommit|enum Op|RenameSheet|PutFormula|serde\" quantbook-engine/crates/ql-oplog/src -g'*.rs' | head -160" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"fn print|pub fn print|quote|SheetRef::Name|needs.*quote|sheet\" quantbook-engine/crates/ql-formula-syntax/src -g'*.rs' | head -120" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '120,190p' quantbook-engine/crates/ql-oplog/src/replay.rs && sed -n '360,410p' quantbook-engine/crates/ql-oplog/src/replay.rs && sed -n '590,625p' quantbook-engine/crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '420,520p' quantbook-engine/crates/ql-storage/src/workbook.rs && sed -n '850,950p' quantbook-engine/crates/ql-storage/src/workbook.rs && sed -n '1240,1265p' quantbook-engine/crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:15://! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
quantbook-engine/crates/ql-oplog/src/replay.rs:22://! - `BatchCommit` → recurse on each inner op. Index reporting flattens:
quantbook-engine/crates/ql-oplog/src/replay.rs:23://!   a failure inside a BatchCommit reports the inner op's overall
quantbook-engine/crates/ql-oplog/src/replay.rs:134:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/crates/ql-oplog/src/replay.rs:148:        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
quantbook-engine/crates/ql-oplog/src/replay.rs:298:    /// type level so a malformed op can smuggle the bad shape past serde
quantbook-engine/crates/ql-oplog/src/replay.rs:366:/// the synthetic position of the enclosing BatchCommit for nested ops —
quantbook-engine/crates/ql-oplog/src/replay.rs:383:        Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:497:        Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:537:            // `replay.rs:458-490`; RenameSheet now follows the same
quantbook-engine/crates/ql-oplog/src/replay.rs:649:        Op::BatchCommit { ops } => {
quantbook-engine/crates/ql-oplog/src/replay.rs:743:/// arrive as accompanying `Op::PutFormula` ops; this arm doesn't
quantbook-engine/crates/ql-oplog/src/replay.rs:1243:        log.append(Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:1263:        log.append(Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:1330:        log.append(Op::BatchCommit {
quantbook-engine/crates/ql-oplog/src/replay.rs:1338:                Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:1640:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/crates/ql-oplog/src/replay.rs:1644:        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/crates/ql-oplog/src/replay.rs:1651:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1669:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1703:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1724:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1760:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1780:        // BatchCommit. Verify the batch replays atomically.
quantbook-engine/crates/ql-oplog/src/replay.rs:1792:        log.append(Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:1799:        log.append(Op::BatchCommit {
quantbook-engine/crates/ql-oplog/src/replay.rs:1801:                Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/replay.rs:1807:                Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/op.rs:13://! | `PutFormula`       | `Workbook::put_formula`                          |
quantbook-engine/crates/ql-oplog/src/op.rs:19://! | `BatchCommit`      | (recursive — applies each inner op in order)     |
quantbook-engine/crates/ql-oplog/src/op.rs:23://! - `Arc<str>` is NOT used in wire fields. `serde` without the `rc`
quantbook-engine/crates/ql-oplog/src/op.rs:34:use serde::{Deserialize, Serialize};
quantbook-engine/crates/ql-oplog/src/op.rs:41:#[serde(deny_unknown_fields, tag = "kind")]
quantbook-engine/crates/ql-oplog/src/op.rs:43:pub enum Op {
quantbook-engine/crates/ql-oplog/src/op.rs:55:    PutFormula {
quantbook-engine/crates/ql-oplog/src/op.rs:76:    /// Wire compat: `#[serde(default, skip_serializing_if = "Option::is_none")]`
quantbook-engine/crates/ql-oplog/src/op.rs:87:        #[serde(default, skip_serializing_if = "Option::is_none")]
quantbook-engine/crates/ql-oplog/src/op.rs:102:    /// (and emits `Op::PutFormula` ops for each rewritten cell in the
quantbook-engine/crates/ql-oplog/src/op.rs:103:    /// same `BatchCommit`), so replay-on-top-of-snapshot OR replay-from-
quantbook-engine/crates/ql-oplog/src/op.rs:127:    RenameSheet {
quantbook-engine/crates/ql-oplog/src/op.rs:171:    /// index relative to the BatchCommit's parent index. No implicit
quantbook-engine/crates/ql-oplog/src/op.rs:174:    /// Nested BatchCommits are permitted by the schema but produced
quantbook-engine/crates/ql-oplog/src/op.rs:176:    BatchCommit { ops: Vec<Op> },
quantbook-engine/crates/ql-oplog/src/op.rs:212:    /// rewrites land as accompanying `Op::PutFormula` entries in the
quantbook-engine/crates/ql-oplog/src/op.rs:213:    /// same op-log sequence (no `BatchCommit` wrapper today; relies on
quantbook-engine/crates/ql-oplog/src/op.rs:230:    /// accompanying `Op::PutFormula` entries in the same op-log sequence.
quantbook-engine/crates/ql-oplog/src/op.rs:284:    /// per design § 4.9.J. The serde representation rejects unknowns at
quantbook-engine/crates/ql-oplog/src/op.rs:334:impl serde::Serialize for ReferenceModeWire {
quantbook-engine/crates/ql-oplog/src/op.rs:335:    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
quantbook-engine/crates/ql-oplog/src/op.rs:347:impl<'de> serde::Deserialize<'de> for ReferenceModeWire {
quantbook-engine/crates/ql-oplog/src/op.rs:348:    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
quantbook-engine/crates/ql-oplog/src/op.rs:392:impl serde::Serialize for LocaleWire {
quantbook-engine/crates/ql-oplog/src/op.rs:393:    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
quantbook-engine/crates/ql-oplog/src/op.rs:404:impl<'de> serde::Deserialize<'de> for LocaleWire {
quantbook-engine/crates/ql-oplog/src/op.rs:405:    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
quantbook-engine/crates/ql-oplog/src/wire.rs:33:use serde::{Deserialize, Serialize};
quantbook-engine/crates/ql-oplog/src/wire.rs:138:#[serde(tag = "kind", rename_all = "lowercase")]
quantbook-engine/crates/ql-oplog/src/wire.rs:266:/// Serde shape is `#[serde(tag = "kind", rename_all = "lowercase")]`,
quantbook-engine/crates/ql-oplog/src/wire.rs:269:/// (`PeerId` is `#[serde(transparent)]`).
quantbook-engine/crates/ql-oplog/src/wire.rs:282:#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
quantbook-engine/crates/ql-oplog/src/wire.rs:386:    //!   over future Loro/serde upgrades).
quantbook-engine/crates/ql-oplog/src/wire.rs:396:        let json = serde_json::to_string(&original).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:398:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:408:        let json = serde_json::to_string(&original).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:409:        // `peer` is serde-transparent, so it appears as a bare u64.
quantbook-engine/crates/ql-oplog/src/wire.rs:411:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:495:    fn round_trips_worst_case_through_serde_json() {
quantbook-engine/crates/ql-oplog/src/wire.rs:497:        // Opus D-1 step 2 audit M2 — the test uses serde_json (which
quantbook-engine/crates/ql-oplog/src/wire.rs:499:        // serde_json::to_string into Loro's LoroList values), not
quantbook-engine/crates/ql-oplog/src/wire.rs:509:        let json = serde_json::to_string(&original).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:510:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:516:    // `#[serde(deny_unknown_fields)]` rejects payloads carrying fields
quantbook-engine/crates/ql-oplog/src/wire.rs:521:    // a future serde upgrade or accidental attribute removal can't
quantbook-engine/crates/ql-oplog/src/wire.rs:529:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:540:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:553:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:565:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/log.rs:96:    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
quantbook-engine/crates/ql-oplog/src/log.rs:100:        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
quantbook-engine/crates/ql-oplog/src/log.rs:135:            serde_json::from_str::<Op>(&s)
quantbook-engine/crates/ql-oplog/src/log.rs:398:            Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/log.rs:420:            Op::BatchCommit {
quantbook-engine/crates/ql-oplog/src/log.rs:423:                    Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/log.rs:448:            Op::PutFormula {
quantbook-engine/crates/ql-oplog/src/error.rs:15:pub enum OpLogError {
quantbook-engine/crates/ql-oplog/src/error.rs:19:    Serialize(#[source] serde_json::Error),
quantbook-engine/crates/ql-oplog/src/error.rs:28:        source: serde_json::Error,

 succeeded in 0ms:

    /// `Op::SetCellFormat` referenced a format id that hasn't been
    /// registered yet. The producer SHOULD always emit `RegisterFormat`
    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
    /// **W5-80.**
    ///
    /// **Phase 5.2 D-1 step 4:** `id` changed from `u32` to
    /// `ql_storage::FormatId` (the converted-from-wire shape).
    #[error("replay set-cell-format references unregistered format id {id:?} at op index {index}")]
    FormatNotRegistered {
        index: usize,
        id: ql_storage::FormatId,
    },

    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
    /// whose current name matches neither `old_name` nor `new_name`
    /// (i.e. the replay state has diverged from what the op recorded).
    ///
    /// **Phase 5.3 step 2 (2026-05-20) — VARIANT NO LONGER EMITTED.**
    /// Under CRDT merge of concurrent renames, current name may
    /// legitimately match neither. The replay handler now applies
    /// the rename to the current sheet (last-in-causal-order wins
    /// policy). Variant kept for ABI compat — external callers that
    /// match against it will simply never see it. Marked
    /// `#[deprecated]` for IDE discoverability (Codex step-2 audit
    /// LOW closure). May be removed in a future major version.
    #[deprecated(
        since = "0.1.0",
        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
    )]
    #[error(
        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
         expected current name {expected:?}, found {found:?}"
    )]
    SheetRenameNameMismatch {
        index: usize,
        id: SheetId,
        expected: String,
        found: String,
    },

    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
    /// new name (duplicate, reserved character, empty).
    #[error(
        "replay rename-sheet rejected at op index {index}: sheet {id} \
         from {old_name:?} to {new_name:?} ({source})"
    )]
    SheetRenameRejected {
        index: usize,
        id: SheetId,
        old_name: String,
        new_name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
    /// under canonical comparison, or an Excel-reserved character.
    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
    /// accepted any name, so an op log produced against a buggy
    /// storage path could let conflicting sheets enter replay state.
    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
    SheetNameRejected {
        index: usize,
        name: String,
        #[source]
        source: ql_storage::SheetNameError,
    },

    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
        count += 1;
    }
    Ok(count)
}

/// Recursive helper. `index` is the op's position in the outer log (or
/// the synthetic position of the enclosing BatchCommit for nested ops —
/// 2A.3.a flattens by reporting the parent's index for nested failures).
fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
    match op {
        Op::PutValue {
            sheet,
            row,
            col,
            value,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            let v: Value = value
                .to_value()
                .map_err(|source| ReplayError::ValueDecode { index, source })?;
            workbook.put_at(*sheet, *row, *col, v);
            Ok(())
        }
        Op::PutFormula {
            sheet,
            row,
            col,
            text,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;
            workbook.put_formula(*sheet, *row, *col, text.as_str());
            Ok(())
        }
        Op::ClearFormula { sheet, row, col } => {
            // clear_formula is idempotent on missing entries; we still
            // validate bounds so a corrupted op-log can't sneak past.
            validate_cell(workbook, *sheet, *row, *col, index)?;
            workbook.clear_formula(*sheet, *row, *col);
            Ok(())
        }
        Op::SetName {
            scope,
            name,
            target,
        } => {
            let target = target
                .to_target(name)
                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
            match scope {
                None => {
                    // Workbook-scoped (historical path).
                            old_name: old_name.clone(),
                            new_name: new_name.clone(),
                            source: other,
                        });
                    }
                }
            }
        }
        Op::RegisterFormat { id, string } => {
            // **W5-80:** route through `FormatTable::register_at` so
            // collisions surface as `FormatRejected` (rather than the
            // panic-on-duplicate behavior `intern` would have via the
            // by_string fast path; `register_at` is the explicit-id form).
            //
            // Phase 5.2 D-1 step 4: `Op::RegisterFormat.id` is now
            // `FormatIdWire`. Convert to `ql_storage::FormatId` via
            // `to_storage()`. The pre-step-4 `legacy_from_u32` migration
            // helper is no longer needed for the wire-replay path; it's
            // reserved for envelope-load migration in step 5.
            let fid = id.to_storage();
            workbook
                .formats_mut()
                .register_at(fid, string.as_str())
                .map_err(|e| ReplayError::FormatRejected {
                    index,
                    source: e.into(),
                })?;
            Ok(())
        }
        Op::SetCellFormat {
            sheet,
            row,
            col,
            id,
        } => {
            validate_cell(workbook, *sheet, *row, *col, index)?;

 succeeded in 0ms:
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:70:    #[error("dangling sheet qualifier — '{name}!' must be followed by a cell or range reference")]
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:74:    /// sheet qualifiers. Cross-sheet refs in Excel are flat; only ONE
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:76:    #[error("double sheet qualifier — only one 'Sheet!' is allowed per reference")]
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:80:    /// mixed-sheet endpoint range. Excel canon: the prefix applies to
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:82:    /// sheets is invalid.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:83:    #[error("mixed-sheet range endpoints — both endpoints must reference the same sheet")]
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:87:    /// sheet qualifier — e.g. `Sheet1!SUM` (Function), `Sheet1!"x"`
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:89:    #[error("sheet qualifier must be followed by a cell or range reference, got {got}")]
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:336:                        sheet: SheetRef::Current,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:366:                        sheet: SheetRef::Current,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:378:                sheet: SheetRef::Current,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:393:            // - Composes with sheet prefix via `apply_sheet_to_term`
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:395:            //   → `@<CellRef with sheet>`).
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:414:                sheet: SheetRef::Current,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:451:            // **W5-89 (Phase 4.6.A part 3):** sheet-qualified reference.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:452:            // Cross-sheet syntax `Sheet!Ref` and `'Sheet name'!Ref`.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:467:                            context: "after sheet name",
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:487:                Ok(apply_sheet_to_term(inner, name)?)
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:490:            // Bare `!` without a preceding sheet name. The lexer doesn't
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:491:            // emit `Token::Bang` outside the sheet-prefix sequence (it's
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:492:            // only emitted via `try_lex_sheet_name_prefix` /
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:493:            // `lex_quoted_sheet_name`), so reaching this arm means the
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:681:        // **W5-89 (Phase 4.6.A part 3):** merge sheet refs across the
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:682:        // range endpoints. Same-sheet, redundant-explicit, and prefix-
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:683:        // on-LHS-only cases collapse to a single SheetRef; mixed-sheet
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:684:        // endpoints reject. See `merge_sheet_refs` for the policy.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:685:        let merged_sheet = merge_sheet_refs(&sheet_of_term(&lhs), &sheet_of_term(&rhs))?;
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:700:                    sheet: merged_sheet.clone(),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:742:                    sheet: merged_sheet.clone(),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:779:                    sheet: merged_sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:797:                    sheet: a_sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:802:                    sheet: _b_sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:816:                // happens post-bind. `merged_sheet` already
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:817:                // collapses sheet refs via `merge_sheet_refs`.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:818:                let _ = a_sheet; // sheet info captured in merged_sheet
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:820:                    sheet: merged_sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:846:/// **W5-89 (Phase 4.6.A part 3):** attach a sheet name from `Sheet!Ref`
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:849:/// error. If the inner reference already has a non-`Current` sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:851:fn apply_sheet_to_term(expr: Expr, name: Arc<str>) -> Result<Expr, ParseError> {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:855:    // sheet prefix attaches to the resulting `WholeRow` singleton (and
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:865:            if !matches!(addr.sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:869:                sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:876:                    sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:886:                    if !matches!(sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:890:                        sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:902:                    sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:908:                    if !matches!(sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:912:                        sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:920:                    sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:926:                    if !matches!(sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:930:                        sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:939:                // qualifier, otherwise stamp the sheet name in.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:941:                    sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:947:                    if !matches!(sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:951:                        sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:964:            sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:968:            if !matches!(sheet, SheetRef::Current) {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:972:                sheet: SheetRef::Name(name),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:977:        // **W5-143 (Phase 4.9.G):** `Sheet1!@A1` — sheet prefix
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:980:        // gets the sheet name stamped in. If `apply_sheet_to_term`
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:985:            let inner_with_sheet = apply_sheet_to_term(*inner, name)?;
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:986:            Ok(Expr::ImplicitIntersection(Box::new(inner_with_sheet)))
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:997:/// - `(Current, Current)` → `Current` (same-sheet range).
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1006:fn merge_sheet_refs(lhs: &SheetRef, rhs: &SheetRef) -> Result<SheetRef, ParseError> {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1009:        (SheetRef::Name(n), SheetRef::Current) => Ok(SheetRef::Name(n.clone())),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1011:        (SheetRef::Current, SheetRef::Name(_) | SheetRef::Id(_)) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1014:        (SheetRef::Name(a), SheetRef::Name(b)) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1016:                Ok(SheetRef::Name(a.clone()))
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1031:fn sheet_of_term(expr: &Expr) -> SheetRef {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1033:        Expr::CellRef(addr) => addr.sheet.clone(),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1034:        Expr::RangeRef(RangeRef::Cells { sheet, .. })
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1035:        | Expr::RangeRef(RangeRef::WholeColumn { sheet, .. })
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1036:        | Expr::RangeRef(RangeRef::WholeRow { sheet, .. })
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1037:        | Expr::RangeRef(RangeRef::R1C1Cells { sheet, .. }) => sheet.clone(),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1039:        Expr::R1C1Ref { sheet, .. } => sheet.clone(),
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:1057:            sheet: SheetRef::Current,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2162:    // ===== W5-89 / Phase 4.6.A part 3 — cross-sheet parser =====
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2175:    fn parse_sheet_qualified_cellref_unquoted() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2179:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2188:    fn parse_sheet_qualified_cellref_quoted() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2192:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Q3 2025")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2201:    fn parse_sheet_qualified_quoted_with_escape() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2205:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Ben's Sheet")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2212:    fn parse_sheet_qualified_range_single_prefix() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2217:                sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2224:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2232:    fn parse_sheet_qualified_range_redundant_explicit_form_normalizes() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2234:        // resolve to the same sheet; result normalizes to single-prefix.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2237:            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2238:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2245:    fn parse_sheet_qualified_redundant_form_case_insensitive() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2246:        // `Sheet1!A1:sheet1!B2` — same canonical name, different case.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2248:        let expr = parse_ok("Sheet1!A1:sheet1!B2");
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2250:            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2251:                assert!(matches!(sheet, SheetRef::Name(_)));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2258:    fn parse_sheet_qualified_whole_column() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2261:            Expr::RangeRef(RangeRef::WholeColumn { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2262:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2269:    fn parse_sheet_qualified_whole_row() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2272:            Expr::RangeRef(RangeRef::WholeRow { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2273:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2280:    fn parse_double_sheet_qualifier_rejected() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2286:    fn parse_mixed_sheet_range_endpoints_rejected() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2301:    fn parse_sheet_qualified_inside_binary_op() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2309:                        assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet2")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2320:    fn parse_sheet_qualified_inside_function_arg() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2321:        // `SUM(Sheet1!A1:A10)` — function arg is a cross-sheet range.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2328:                    Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2329:                        assert_eq!(sheet, &SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2340:        // Regression guard: same-sheet ranges still parse to SheetRef::Current.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2343:            Expr::RangeRef(RangeRef::Cells { sheet, .. }) => {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2344:                assert_eq!(sheet, SheetRef::Current);
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2351:    fn parse_sheet_qualified_absolute_ref() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2352:        // `Sheet1!$A$1` — absolute markers preserved alongside sheet prefix.
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2356:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2365:    fn parse_dotted_sheet_name() {
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2369:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Data.2024")));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2925:                sheet,
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2929:                assert!(matches!(sheet, SheetRef::Current));
quantbook-engine/crates/ql-formula-syntax/src/parser.rs:2971:                sheet,

 succeeded in 0ms:
        self.sheets.len()
    }

    // ===== Phase 4.6.AA (W5-86): sheet registry + canonicalizer =====

    /// **Phase 4.6.AA (W5-86):** canonicalize a sheet name for
    /// case-insensitive comparison. ASCII uppercase per the parent
    /// design doc § 7.3 (consistency with `NameTable::set`'s rule;
    /// Unicode casefolding deferred to a follow-up gap).
    ///
    /// Excel canonical: sheet names compare case-insensitively (so
    /// `"Sheet1"` and `"SHEET1"` are the same sheet) but the DISPLAY
    /// form preserves user-supplied case. This function returns the
    /// canonical form used for lookup / duplicate-detection ONLY;
    /// display goes through `Sheet::name()`.
    ///
    /// V1 simplification: ASCII-only uppercase. `"Café"` and `"café"`
    /// canonicalize to different forms (the non-ASCII `é` is not
    /// folded). Excel itself uses Unicode casefolding here; if a real
    /// workbook with non-ASCII sheet names surfaces a collision, this
    /// gets revisited.
    pub fn canonical_sheet_name(name: &str) -> String {
        name.to_ascii_uppercase()
    }

    /// **Phase 4.6.AA (W5-86):** find a sheet by name (case-insensitive
    /// per `canonical_sheet_name`). Returns the first match in id order.
    ///
    /// Lookup cost: O(sheet_count). Acceptable for typical workbooks
    /// (low double-digits of sheets). If profiling shows pain, a
    /// canonical-name → id index can be added without changing this
    /// API surface.
    pub fn sheet_id_by_name(&self, name: &str) -> Option<SheetId> {
        let canonical = Self::canonical_sheet_name(name);
        for (idx, sheet) in self.sheets.iter().enumerate() {
            if Self::canonical_sheet_name(sheet.name()) == canonical {
                return Some(idx as SheetId);
            }
        }
        None
    }

    /// **Phase 4.6.C (W5-91):** rename a sheet by id. Validates the new
    /// name via [`validate_sheet_name`] (rejects empty, Excel-reserved
    /// chars, canonical duplicates) and swaps the sheet's display name.
    ///
    /// **DOES NOT touch formula text.** Stored formulas in
    /// `formula_cells` and `NamedTarget::Formula` entries continue to
    /// reference the OLD sheet name. The runtime wrapper
    /// `WorkbookRuntime::rename_sheet` (`ql-exec`) owns the
    /// tokenization-aware text rewrite + op-log recording per the
    /// parent design doc § 3.1. Direct callers of this method (loader,
    /// tests, op-log replay) get bare name swap only.
    ///
    /// **Phase 4.6 design doc § 3 (Codex HIGH-1 closure):** the swap is
    /// fast (O(1) on the sheet's `name` field); the expensive text
    /// rewrite is the caller's responsibility and is bounded by the
    /// workbook's total formula text size.
    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        new_name: impl Into<String>,
    ) -> Result<(), SheetNameError> {
        let new_name: String = new_name.into();
        // Validate first. If the new name canonically matches the CURRENT
        // sheet name, that's a no-op rename (case-only change is allowed
        // as a display update; duplicate check rejects all other matches).
        let current_canonical = self
            .sheet(id)
            .map(|s| Self::canonical_sheet_name(s.name()))
            .ok_or_else(|| SheetNameError::Duplicate {
                name: format!("<sheet id {id} not found>"),
            })?;
        let new_canonical = Self::canonical_sheet_name(&new_name);
        if new_canonical != current_canonical {
            // Full validation only when canonical name actually changes.
            self.validate_sheet_name(&new_name)?;
        } else if new_name.is_empty() {
            return Err(SheetNameError::Empty);
        }
        // Swap the name. `Sheet::set_name` is private; mutate through
        // sheet_mut + a new accessor.
        if let Some(sheet) = self.sheets.get_mut(id as usize) {
            sheet.set_name(new_name);
        }
        Ok(())
    }

    /// **Phase 4.6.AA (W5-86):** validate a sheet name for use with
    /// `add_sheet` / `rename_sheet`. Rejects:
    /// - empty string (Excel canon)
    /// - canonical duplicate of an existing sheet name
    /// - Excel-reserved characters `:`, `\`, `/`, `?`, `*`, `[`, `]`
    ///   (also xlsx round-trip prerequisite for Phase 4.11)
    ///
    /// Per the parent design's named-divergence catalog: V1 matches
    /// Excel's rejection set exactly. Length limit (Excel's 31-char
    /// max) is NOT enforced in V1 — that's a UX hint, not a correctness
    /// boundary; tracked for follow-up if xlsx import surfaces it.
    pub fn validate_sheet_name(&self, name: &str) -> Result<(), SheetNameError> {
        if name.is_empty() {
    /// the cell has no user entry or the sheet is out of bounds. Called by the runtime's
    /// `set_formula` to clear a stale user value before writing the new computed
    /// formula output.
    pub fn clear_user_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        if let Some(s) = self.sheet_mut(sheet) {
            s.clear_user(row, col);
        }
    }

    /// Phase 1 W5-9: record formula source text for a cell. The caller is responsible
    /// for evaluating the formula and storing the result via `put`/`put_at` — this
    /// method just persists the formula association. Pass an empty string or omit the
    /// call to mark a cell as literal-only.
    ///
    /// `formula` is the formula body WITHOUT the leading `=` (matching Excel's
    /// canonical AST representation).
    ///
    /// Phase 2A.13 audit cycle-3 H2: panics if `sheet >= sheet_count()`, `row >
    /// MAX_ROW`, or `col > MAX_COLUMN`. The prior implementation accepted any
    /// (sheet, row, col), making `validate_cell` at the runtime/transaction layer
    /// bypassable: a `formula_cells` entry with an out-of-bounds coord would
    /// later panic deep inside `Sheet::put` during `recompute_all`'s
    /// `put_at`. Matching the storage-layer convention from `Sheet::put` and
    /// `Workbook::put_at` (which also panic on invariant violation), the
    /// in-process programmer-error path stays loud. Trust-boundary callers
    /// (ql-io loader, IDE host) MUST validate before reaching here.
    pub fn put_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula: impl Into<Arc<str>>,
    ) {
        assert!(
            (sheet as usize) < self.sheets.len(),
            "Workbook::put_formula: sheet {sheet} does not exist (have {})",
            self.sheets.len()
        );
        assert!(
            row <= ql_types::MAX_ROW,
            "Workbook::put_formula: row {row} exceeds MAX_ROW {}",
            ql_types::MAX_ROW
        );
        assert!(
            col <= ql_types::MAX_COLUMN,
            "Workbook::put_formula: col {col} exceeds MAX_COLUMN {}",
            ql_types::MAX_COLUMN
        );
        self.formula_cells.insert((sheet, row, col), formula.into());
    }

    /// Remove any formula association for a cell. Used when a formula cell becomes a
    /// literal (e.g. user types over the formula with a value). Idempotent: removing
    /// a non-existent entry is a no-op.
    ///
    /// Phase 3.5 (CORR-25): ALSO drops any computed-overlay entry at this cell. A
    /// cell without a formula text has no business carrying a formula output; the
    /// invariant the rest of the engine relies on is "computed overlay populated ⇒
    /// formula text present", and `clear_formula` is the only path that breaks the
    /// formula→computed pair, so the storage layer enforces both sides here.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
    /// `ql_exec::WorkbookRuntime::clear_formula` to record `Op::ClearFormula`
    /// in an attached log. GAP-O-03.
    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        self.formula_cells.remove(&(sheet, row, col));
        self.clear_computed_at(sheet, row, col);
    }

    /// Borrow the formula source for a cell, if it has one.
    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
        self.formula_cells.get(&(sheet, row, col))
    }

    /// Count of formula cells across the workbook.
    pub fn formula_count(&self) -> usize {
        self.formula_cells.len()
    }

    /// Iterate every formula cell as `(sheet, row, col, formula)`. Iteration order is
    /// HashMap-arbitrary; callers that need determinism (qbook save) should sort first.
    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
        self.formula_cells
            .iter()
            .map(|((s, r, c), f)| (*s, *r, *c, f))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::ErrorValue;

    #[test]
    fn empty_workbook_has_no_sheets() {
        let wb = Workbook::new();
        assert_eq!(wb.sheet_count(), 0);
        assert!(wb.sheet(0).is_none());
        // Phase 2A.13 audit cycle-3 M2: read out-of-bounds sheet → #REF!
        // (was: Blank). Aligns the storage-layer public read API with
        // `WorkbookEnv::read_cell` per Excel canon.
    }

    // ===== W5-86 / Phase 4.6.AA — sheet registry + canonicalizer =====

    #[test]
    fn canonical_sheet_name_uppercases_ascii() {
        assert_eq!(Workbook::canonical_sheet_name("Sheet1"), "SHEET1");
        assert_eq!(Workbook::canonical_sheet_name("sheet1"), "SHEET1");
        assert_eq!(Workbook::canonical_sheet_name("SHEET1"), "SHEET1");
    }

    #[test]
    fn canonical_sheet_name_passes_non_ascii_through() {
        // V1 simplification: ASCII-only uppercasing; non-ASCII letters
        // stay as-is. `Café` and `café` canonicalize to different forms.
        // Documented as a known V1 simplification.
        assert_eq!(Workbook::canonical_sheet_name("Café"), "CAFé");
    }

    #[test]
    fn sheet_id_by_name_finds_case_insensitive() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("Inventory");
        let s1 = wb.add_sheet("Q3 2025");
        assert_eq!(wb.sheet_id_by_name("Inventory"), Some(s0));
        assert_eq!(wb.sheet_id_by_name("inventory"), Some(s0));

exec
/bin/zsh -lc "sed -n '110,250p' quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
        // can't return an error. Routes through the panicking convenience
        // wrapper.
        let new_id = self.workbook.add_sheet_with_chunk_rows(name, chunk_rows);

        // Phase 3.1: notify calcgraph. Today a counter-bump; Phase 4.6
        // will use this to track per-sheet structure generations for
        // cross-sheet reference invalidation.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_add_sheet(new_id);
        }

        Ok(new_id)
    }

    /// **W5-91 (Phase 4.6.C):** rename a sheet by id. Walks every
    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
    /// entry, rewrites cross-sheet references to the new sheet name via
    /// `lex → parse → rewrite → print`, emits the rewritten text + the
    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
    /// the rewrites to storage, then swaps `Sheet::name`. Bumps the
    /// `PlanCache` generation so cached bound plans miss on the next
    /// recompute.
    ///
    /// Validation: rejects empty / Excel-reserved-char / canonical-
    /// duplicate new names via `Workbook::validate_sheet_name`.
    ///
    /// **Tokenization-aware:** the parse + rewrite + print round-trip
    /// catches every sheet-qualified ref in the AST, including those
    /// inside string literals' position (it doesn't actually substitute
    /// inside `"..."` because the parser keeps those as `Expr::String`).
    /// If a formula's text fails to lex/parse (corrupt input from a
    /// historical bug), the text is left UNCHANGED — defensive against
    /// breaking otherwise-recoverable workbooks at rename time.
    ///
    /// Direct callers of `Workbook::rename_sheet` bypass formula-text
    /// rewriting + op-log recording — that path is loader-only.
    pub fn rename_sheet(
        &mut self,
        id: SheetId,
        new_name: impl Into<String>,
    ) -> Result<(), RuntimeError> {
        let new_name: String = new_name.into();
        // Capture old name BEFORE any mutation (defensive — if anything
        // below errors, the workbook stays as-is).
        let old_name = self.workbook.sheet(id).map(|s| s.name().to_owned()).ok_or(
            RuntimeError::InvalidSheet {
                sheet: id,
                sheet_count: self.workbook.sheet_count(),
            },
        )?;
        // Validate new name. Skip the validation if canonical name is
        // unchanged (case-only rename is allowed); `Workbook::rename_sheet`
        // will apply the display update.
        let old_canonical = ql_storage::Workbook::canonical_sheet_name(&old_name);
        let new_canonical = ql_storage::Workbook::canonical_sheet_name(&new_name);
        if new_canonical != old_canonical {
            self.workbook.validate_sheet_name(&new_name)?;
        }
        // Rewrite stored formula text. Collect rewrites into a batch so
        // the op log records them alongside the rename atomically.
        let new_name_arc: Arc<str> = Arc::from(new_name.as_str());
        let mut rewritten_cells: Vec<(SheetId, RowId, ColId, String)> = Vec::new();
        for (sheet, row, col, text) in self.workbook.iter_formulas() {
            if let Some(new_text) =
                rewrite_formula_text_for_sheet_rename(text.as_ref(), &old_canonical, &new_name_arc)
            {
                rewritten_cells.push((sheet, row, col, new_text));
            }
        }
        // (Phase 4.6.D / future): walk NamedTarget::Formula entries for
        // the same rewrite. Today named formulas are deferred so
        // formula_cells is the only text-bearing surface to rewrite.

        // Append-before-mutate: emit the BatchCommit op first so a
        // failing append leaves storage unchanged. The batch carries:
        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let mut ops: Vec<Op> = Vec::with_capacity(rewritten_cells.len() + 1);
            for (s, r, c, ref new_text) in &rewritten_cells {
                ops.push(Op::PutFormula {
                    sheet: *s,
                    row: *r,
                    col: *c,
                    text: new_text.clone(),
                });
            }
            ops.push(Op::RenameSheet {
                id,
                old_name: old_name.clone(),
                new_name: new_name.clone(),
            });
            oplog.append(Op::BatchCommit { ops })?;
        }
        // Apply mutations. Rewrites go in first so the storage layer
        // never sees a state where the sheet name is new but formula
        // text still references the old name. (Order matters only for
        // observers that race — single-threaded mutation doesn't care,
        // but the invariant is cleaner.)
        for (s, r, c, new_text) in rewritten_cells {
            self.workbook.put_formula(s, r, c, new_text.as_str());
        }
        // Swap the name. Cannot fail here — validation already passed.
        self.workbook
            .rename_sheet(id, new_name)
            .expect("rename_sheet validation already passed");
        // Wipe the PlanCache so cached bound plans (which baked in the
        // old SheetId via SheetRef::Name resolution) miss on next
        // recompute and rebind against the new sheet name. Sheet
        // rename is edit-rate, not recompute-rate; a full cache flush
        // is acceptable per design § 10.5 / Codex MEDIUM-7. (A
        // finer-grained `sheet_gen` counter could be wired in a follow-
        // up — filed as a future polish item.)
        self.plan_cache.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_storage::Workbook;
    use ql_types::Value;

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    // ===== W5-91 (Phase 4.6.C) rename_sheet =====

    #[test]
    fn rename_sheet_rewrites_formula_text_and_recomputes() {
        // S1!A1 = 10 ; S2!A1 = S1!A1 * 2 = 20.
        // Rename S1 → SheetX. Stored formula on S2!A1 must read
        // "SheetX!A1 ..."; recompute must still produce 20.
        let mut wb = Workbook::new();
        let s1 = wb.add_sheet("S1");
        let s2 = wb.add_sheet("S2");
        wb.put_at(s1, 0, 0, Value::Number(10.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(s2, 0, 0, "S1!A1 * 2").unwrap();
        rt.rename_sheet(s1, "SheetX").unwrap();
        let _ = rt.recompute_all();

exec
/bin/zsh -lc "rg -n \"NamedTarget|SetName|Formula|NameTable|iter.*name|names\" quantbook-engine/crates/ql-storage/src quantbook-engine/crates/ql-exec/src -g'*.rs' | head -220" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/src/lower.rs:10://! Recognized shapes (matched on the patterns FormulaRegionNode binding
quantbook-engine/crates/ql-exec/src/lower.rs:38://! The binder (Phase 4+ FormulaRegion lowering) is responsible for producing
quantbook-engine/crates/ql-exec/src/lower.rs:42://! row-alignment assertion in the FormulaRegion binder.
quantbook-engine/crates/ql-exec/src/loader.rs:108:        // Formula text preserved.
quantbook-engine/crates/ql-exec/src/loader.rs:183:    /// ranges now round-trip through save/load via the schema-v2 `names`
quantbook-engine/crates/ql-exec/src/loader.rs:188:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/loader.rs:192:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/loader.rs:205:        // Formula text canonicalized through set_formula's
quantbook-engine/crates/ql-exec/src/loader.rs:213:        // Name is still in the loaded workbook's NameTable.
quantbook-engine/crates/ql-exec/src/loader.rs:215:            loaded.names().lookup("TAXRATE"),
quantbook-engine/crates/ql-exec/src/loader.rs:216:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
quantbook-engine/crates/ql-exec/src/loader.rs:386:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/loader.rs:393:        wb.set_name("MyRow", NamedTarget::Range(Range::new(s, 0, 0, 0, 2)))
quantbook-engine/crates/ql-exec/src/loader.rs:424:        assert!(loaded.names().lookup_ci("MYROW").is_some());
quantbook-engine/crates/ql-storage/src/sheet.rs:11:use crate::workbook::{NameTable, NameTableError, NamedTarget};
quantbook-engine/crates/ql-storage/src/sheet.rs:36:    /// **W5-92 (Phase 4.6.D):** sheet-scoped defined names. Lookup
quantbook-engine/crates/ql-storage/src/sheet.rs:37:    /// resolves sheet-scoped names first, then falls back to the
quantbook-engine/crates/ql-storage/src/sheet.rs:41:    /// the workbook-scoped `NameTable` (ASCII-uppercase canonical).
quantbook-engine/crates/ql-storage/src/sheet.rs:42:    scoped_names: NameTable,
quantbook-engine/crates/ql-storage/src/sheet.rs:59:            scoped_names: NameTable::new(),
quantbook-engine/crates/ql-storage/src/sheet.rs:85:    pub fn scoped_names(&self) -> &NameTable {
quantbook-engine/crates/ql-storage/src/sheet.rs:86:        &self.scoped_names
quantbook-engine/crates/ql-storage/src/sheet.rs:92:    /// `Op::SetName { scope: Some(_), .. }`).
quantbook-engine/crates/ql-storage/src/sheet.rs:93:    pub fn scoped_names_mut(&mut self) -> &mut NameTable {
quantbook-engine/crates/ql-storage/src/sheet.rs:94:        &mut self.scoped_names
quantbook-engine/crates/ql-storage/src/sheet.rs:100:    /// `NameTableError::Reserved` for those.
quantbook-engine/crates/ql-storage/src/sheet.rs:104:        target: NamedTarget,
quantbook-engine/crates/ql-storage/src/sheet.rs:105:    ) -> Result<(), NameTableError> {
quantbook-engine/crates/ql-storage/src/sheet.rs:106:        self.scoped_names.set(name, target)
quantbook-engine/crates/ql-storage/src/sheet.rs:110:    /// (no-op for unknown names).
quantbook-engine/crates/ql-storage/src/sheet.rs:112:        self.scoped_names.clear(name);
quantbook-engine/crates/ql-storage/src/sheet.rs:119:    /// names, or any cache; the runtime wrapper owns those concerns.
quantbook-engine/crates/ql-storage/src/sheet.rs:373:    // W5-92 (Phase 4.6.D) — sheet-scoped names.
quantbook-engine/crates/ql-storage/src/sheet.rs:376:    fn scoped_names_empty_by_default() {
quantbook-engine/crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/crates/ql-storage/src/sheet.rs:384:        s.set_scoped_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-storage/src/sheet.rs:387:        // NameTable behavior.
quantbook-engine/crates/ql-storage/src/sheet.rs:389:            s.scoped_names().lookup_ci("taxrate"),
quantbook-engine/crates/ql-storage/src/sheet.rs:390:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
quantbook-engine/crates/ql-storage/src/sheet.rs:392:        assert_eq!(s.scoped_names().len(), 1);
quantbook-engine/crates/ql-storage/src/sheet.rs:398:        s.set_scoped_name("X", NamedTarget::Constant(Value::Number(1.0)))
quantbook-engine/crates/ql-storage/src/sheet.rs:400:        assert_eq!(s.scoped_names().len(), 1);
quantbook-engine/crates/ql-storage/src/sheet.rs:402:        assert_eq!(s.scoped_names().len(), 0);
quantbook-engine/crates/ql-storage/src/sheet.rs:403:        assert!(s.scoped_names().lookup_ci("X").is_none());
quantbook-engine/crates/ql-storage/src/sheet.rs:410:            .set_scoped_name("AI", NamedTarget::Constant(Value::Number(42.0)))
quantbook-engine/crates/ql-storage/src/sheet.rs:413:        assert!(matches!(err, crate::workbook::NameTableError::Reserved(_)));
quantbook-engine/crates/ql-storage/src/sheet.rs:417:    fn scoped_names_independent_across_sheets() {
quantbook-engine/crates/ql-storage/src/sheet.rs:420:        s1.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-storage/src/sheet.rs:422:        s2.set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.10)))
quantbook-engine/crates/ql-storage/src/sheet.rs:425:        let r1 = s1.scoped_names().lookup_ci("Rate");
quantbook-engine/crates/ql-storage/src/sheet.rs:426:        let r2 = s2.scoped_names().lookup_ci("Rate");
quantbook-engine/crates/ql-storage/src/sheet.rs:427:        assert!(matches!(r1, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21));
quantbook-engine/crates/ql-storage/src/sheet.rs:428:        assert!(matches!(r2, Some(NamedTarget::Constant(Value::Number(n))) if n == 0.10));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:16://! mirrors how `NameTable` lives on the workbook (a flat map that scales
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4://! dependency tracking (cells / ranges / volatile / names). It lives
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:23://!   producing a `FormulaDeps` collection of (a) direct cell refs,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:24://!   (b) named-range refs (from `AggregateNameRef`), (c) names
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:51://!   such names invalidate via the PlanCache's `name_gen` counter
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:209:/// `cells`, `named_ranges`, and `names` are deduplicated by the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:213:pub struct FormulaDeps {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:221:    /// Names referenced by the formula. Currently only names that
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:223:    /// module docs for the limitation around scalar-resolved names.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:224:    pub names: Vec<Arc<str>>,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:225:    /// **W5-154 (Phase 4.8.G.3 foundation):** table names referenced by
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:236:impl FormulaDeps {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:252:pub(crate) fn walk_plan_for_deps(plan: &ExprPlan, deps: &mut FormulaDeps) {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:317:            deps.names.push(Arc::clone(name));
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:338:        // `__rt_literal_range__` into `named_ranges` here, which leaked
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:339:        // a private marker through the public `FormulaDeps.named_ranges`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:417:fn walk_plan_for_address_only_deps(plan: &ExprPlan, deps: &mut FormulaDeps) {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:424:            deps.names.push(Arc::clone(name));
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:458:    formula_deps: HashMap<NodeId, FormulaDeps>,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:621:    pub fn formula_deps(&self, node: NodeId) -> Option<&FormulaDeps> {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:690:        let mut deps = FormulaDeps::default();
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:736:        let mut seen_names: HashSet<Arc<str>> = HashSet::new();
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:737:        deps.names.retain(|n| seen_names.insert(Arc::clone(n)));
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:789:        for name in &deps.names {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:824:            for name in &prior.names {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:945:    /// workbook's NameTable. Used by `rebuild_from_workbook` and by
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:955:        // W5-92 (Phase 4.6.D): pass `wb` for names so the two-tier
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:956:        // sheet-then-workbook scope chain fires; was `wb.names()`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1129:        // Table names are stored in `deps.tables` as the parser's
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1277:    /// `Op::PutFormula` followed by W5-156 `#NAME?` mapping when
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1916:    /// `FormulaDeps::cells` exactly once each, even when the formula
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1937:    /// HyperFormula-style range-as-single-edge optimization that lets
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1950:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1959:        // Formula that uses the name in aggregate context.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1995:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2023:        // Lookup is case-insensitive (matches NameTable canonicalization).
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2033:    /// `FormulaDeps::is_volatile`. Phase 3.7 reads this set every
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2111:        // Note (Phase 3.2): names like `Foo`/`Pi` collide with the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2118:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2175:        // FormulaDeps when there's at least one dep or a volatile bit).
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2215:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2248:    /// plan with two fresh `FormulaDeps` produces equal collections.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2266:        let mut a = FormulaDeps::default();
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2267:        let mut b = FormulaDeps::default();
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2293:        // canonicalizes function names to uppercase before binding, so
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2325:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2352:        // Write to A500 — inside the range. Formula should dirty.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2394:    /// Naming note: short names like "ColA" / "Row5" collide with the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2409:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2421:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2433:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2515:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:2590:            ql_storage::NamedTarget::Range(Range {
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4006:        // Formula F1 at (0, 5, 5) references Sales[Qty].
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:4031:    /// Formula registers under `"Sales"` (parser case-preserves);
quantbook-engine/crates/ql-storage/src/tables.rs:3://! Mirrors the [`crate::NameTable`] pattern (Phase 2A.1). Tables are
quantbook-engine/crates/ql-storage/src/tables.rs:26:/// Stable across renames within the table; never reused. Future phases (4.10
quantbook-engine/crates/ql-storage/src/tables.rs:28:/// columns even when names collide ephemerally.
quantbook-engine/crates/ql-storage/src/tables.rs:83:/// invariants (overlap rules, namespace sharing with `NameTable`, etc.).
quantbook-engine/crates/ql-storage/src/tables.rs:86:    /// Canonical name (uppercase). Mirrors `NameTable`'s canonicalization.
quantbook-engine/crates/ql-storage/src/tables.rs:271:/// Mirrors [`crate::NameTable`]: HashMap-backed storage keyed by
quantbook-engine/crates/ql-storage/src/tables.rs:285:    /// invalidation keys can include this so column renames / resizes
quantbook-engine/crates/ql-storage/src/tables.rs:299:    /// Bind-plan cache invalidation counter (see [`NameTable::generation`]
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:11://!   workbook-scoped name, emit `Op::SetName { scope: None, .. }`,
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:15://!   a sheet-scoped name, emit `Op::SetName { scope: Some(sheet),
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:27:    /// emitting `Op::SetName` into the attached op log (if any). This is the
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:39:        target: ql_storage::NamedTarget,
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:44:        //   1. Reserved-name rejection: caught by `NameTable::would_accept`
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:55:        // `NameTable::set`'s on-write canonicalization, so the recorded
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:57:        self.workbook.names().would_accept(name)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:59:            let target_wire = ql_io::NamedTargetWire::from_target(&target);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:60:            oplog.append(Op::SetName {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:68:        // NameTableError variants; expect them to be pre-checkable via
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:82:    /// through the runtime, emitting `Op::SetName { scope: Some(sheet), .. }`
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:83:    /// into the attached op log (if any). Sheet-scoped names shadow
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:84:    /// workbook-scoped names with the same identifier when accessed
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:91:    ///   reserved set is workbook-global, so sheet-scoped names are
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:99:        target: ql_storage::NamedTarget,
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:108:        //    `NameTable::would_accept` since the reserved-name set
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:110:        self.workbook.names().would_accept(name)?;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:113:            let target_wire = ql_io::NamedTargetWire::from_target(&target);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:114:            oplog.append(Op::SetName {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:137:        //    workbook-scoped `NameTable::generation()` — a sheet-scoped
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:154:    use ql_storage::{NamedTarget, Workbook};
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:177:        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:181:            wb.sheet(s0).unwrap().scoped_names().lookup_ci("R"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:182:            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:185:        assert!(wb.names().is_empty());
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:195:            .set_sheet_scoped_name(42, "R", NamedTarget::Constant(Value::Number(1.0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:207:            .set_sheet_scoped_name(s0, "AI", NamedTarget::Constant(Value::Number(42.0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:212:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:222:        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:228:            Op::SetName {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:235:                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:237:            other => panic!("expected SetName, got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:249:        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:253:            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:271:        // workbook NameTable generation, so the cached plan would
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:275:        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:283:        rt.set_sheet_scoped_name(s0, "Rate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:300:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:306:        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:319:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:323:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:334:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:337:        wb.set_name("UseFancy", NamedTarget::Constant(Value::Boolean(true)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:350:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:353:        wb.set_name("Greeting", NamedTarget::Constant(Value::text("hello")))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:438:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:442:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:459:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:462:        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:481:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:486:        wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(5.0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:77:        // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:235:        // registry. Hardcoded names (mirror the matcher in plan.rs).
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:246:        // aware names are also in is_aggregate_function but live in
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:368:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:375:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:390:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:397:        wb.set_name("Data", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:433:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:443:        // patterns (e.g. `Ys` lexes as BareColumn col=668). Use names
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:445:        wb.set_name("XValues", NamedTarget::Range(Range::new(0, 0, 0, 3, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:447:        wb.set_name("YValues", NamedTarget::Range(Range::new(0, 0, 1, 3, 1)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:487:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:495:        wb.set_name("XData", NamedTarget::Range(Range::new(0, 0, 0, 2, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:497:        wb.set_name("YData", NamedTarget::Range(Range::new(0, 0, 1, 2, 1)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:546:        for &name in reg.range_aware_names() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:573:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:576:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:594:        use ql_storage::NamedTarget;
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:597:        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
quantbook-engine/crates/ql-storage/src/workbook.rs:5://! - `names: NameTable` — workbook-level defined names. Phase 2A.1 (2026-05-12)
quantbook-engine/crates/ql-storage/src/workbook.rs:7://!   binder in `ql-exec` resolves names against this table at bind time.
quantbook-engine/crates/ql-storage/src/workbook.rs:8://!   Sheet-scope names land Phase 3+ with `ql-formula-semantics`.
quantbook-engine/crates/ql-storage/src/workbook.rs:25:/// added real storage for `Cell` and `Constant` variants; the `Range` and `Formula`
quantbook-engine/crates/ql-storage/src/workbook.rs:30:pub enum NamedTarget {
quantbook-engine/crates/ql-storage/src/workbook.rs:39:    Formula(std::sync::Arc<str>),
quantbook-engine/crates/ql-storage/src/workbook.rs:42:/// Defined-names table.
quantbook-engine/crates/ql-storage/src/workbook.rs:50:/// canonicalization. Sheet-scope names (Excel's `Sheet1!Local`) are deferred to
quantbook-engine/crates/ql-storage/src/workbook.rs:60:pub struct NameTable {
quantbook-engine/crates/ql-storage/src/workbook.rs:61:    entries: HashMap<Arc<str>, NamedTarget>,
quantbook-engine/crates/ql-storage/src/workbook.rs:68:/// Errors emitted by `NameTable::set` when a registration is refused.
quantbook-engine/crates/ql-storage/src/workbook.rs:71:/// previous `NameTable::set` returned `()` and silently accepted any name,
quantbook-engine/crates/ql-storage/src/workbook.rs:73:/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
quantbook-engine/crates/ql-storage/src/workbook.rs:79:pub enum NameTableError {
quantbook-engine/crates/ql-storage/src/workbook.rs:88:/// `NameTableError` because the validation rules differ (sheet names
quantbook-engine/crates/ql-storage/src/workbook.rs:89:/// allow reserved-name-table entries like `AI`; sheet names reject
quantbook-engine/crates/ql-storage/src/workbook.rs:110:/// here cannot be registered via `NameTable::set` or `Workbook::set_name`.
quantbook-engine/crates/ql-storage/src/workbook.rs:126:/// will reject these names at the producer once the binder's
quantbook-engine/crates/ql-storage/src/workbook.rs:128:/// current code path doesn't call this — see `NameTable::set` for
quantbook-engine/crates/ql-storage/src/workbook.rs:155:impl NameTable {
quantbook-engine/crates/ql-storage/src/workbook.rs:168:    /// with `NameTableError::Reserved`. The return type is now `Result` —
quantbook-engine/crates/ql-storage/src/workbook.rs:174:        target: NamedTarget,
quantbook-engine/crates/ql-storage/src/workbook.rs:175:    ) -> Result<(), NameTableError> {
quantbook-engine/crates/ql-storage/src/workbook.rs:178:            return Err(NameTableError::Reserved(upper));
quantbook-engine/crates/ql-storage/src/workbook.rs:181:        // Initial closure attempted to reject cell-ref-shaped names
quantbook-engine/crates/ql-storage/src/workbook.rs:184:        // single-letter names like `R` and the binder resolves them
quantbook-engine/crates/ql-storage/src/workbook.rs:225:    /// `Err(NameTableError::Reserved(...))` otherwise. Pure: no
quantbook-engine/crates/ql-storage/src/workbook.rs:227:    pub fn would_accept(&self, name: &str) -> Result<(), NameTableError> {
quantbook-engine/crates/ql-storage/src/workbook.rs:230:            return Err(NameTableError::Reserved(upper));
quantbook-engine/crates/ql-storage/src/workbook.rs:239:    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
quantbook-engine/crates/ql-storage/src/workbook.rs:244:    /// Phase 2A.6 audit H2: the `NameLookup for NameTable` impl uses this so
quantbook-engine/crates/ql-storage/src/workbook.rs:246:    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
quantbook-engine/crates/ql-storage/src/workbook.rs:260:    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
quantbook-engine/crates/ql-storage/src/workbook.rs:298:    names: NameTable,

exec
/bin/zsh -lc "rg -n \"fn rename_sheet|rename_sheet\\(\" quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs quantbook-engine/crates/ql-exec/src -g'*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:146:    pub fn rename_sheet(
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:213:            .rename_sheet(id, new_name)
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:238:    fn rename_sheet_rewrites_formula_text_and_recomputes() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:249:        rt.rename_sheet(s1, "SheetX").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:268:    fn rename_sheet_leaves_unrelated_formulas_alone() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:285:        rt.rename_sheet(s2, "SheetX").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:296:    fn rename_sheet_duplicate_target_rejected_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:302:        let err = rt.rename_sheet(s1, "s2").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:309:    fn rename_sheet_unknown_id_rejected_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:314:        let err = rt.rename_sheet(42, "X").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:319:    fn rename_sheet_case_only_rename_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:326:        rt.rename_sheet(s1, "SHEET1").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:146:    pub fn rename_sheet(
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:213:            .rename_sheet(id, new_name)
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:238:    fn rename_sheet_rewrites_formula_text_and_recomputes() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:249:        rt.rename_sheet(s1, "SheetX").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:268:    fn rename_sheet_leaves_unrelated_formulas_alone() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:285:        rt.rename_sheet(s2, "SheetX").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:296:    fn rename_sheet_duplicate_target_rejected_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:302:        let err = rt.rename_sheet(s1, "s2").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:309:    fn rename_sheet_unknown_id_rejected_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:314:        let err = rt.rename_sheet(42, "X").unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:319:    fn rename_sheet_case_only_rename_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:326:        rt.rename_sheet(s1, "SHEET1").unwrap();

codex
One risk is emerging: the pass mines the whole historical log every time, so an old sheet name can remain a rewrite trigger long after that name becomes valid again for another sheet. I’m going to sanity-check the existing tests, then I’ll pin down whether that is only a documented ambiguity or an actual corruption path.
exec
/bin/zsh -lc 'cargo test -p ql-collab --test repair_renames -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'cargo test -p ql-exec --test phase_5_3_conflict_matrix_probe row7_rename_sheet_concurrent_edit_resolves_via_repair_pass -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/repair.rs | sed -n '1,260p' && nl -ba crates/ql-collab/tests/repair_renames.rs | sed -n '1,680p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '500,625p' && nl -ba crates/ql-exec/Cargo.toml | sed -n '1,90p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 258ms:
   500	// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====
   501	
   502	/// **Conflict-matrix row 7 (Phase 5.3 step 3 — REPAIR PASS APPLIED):**
   503	/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
   504	/// formula at A2 referencing "S!A1" (the old name). After merge +
   505	/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
   506	/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
   507	/// literal at S2!A1, originally at S!A1 before rename).
   508	///
   509	/// **Pre-step-3 behavior** (kept here as historical context):
   510	/// without the repair pass, the formula bind-failed at recompute →
   511	/// `Value::Error(ErrorValue::Name)` per the D-3 V1 limitation. Step
   512	/// 3's rename-repair pass closes that limitation.
   513	///
   514	/// **Test is intentionally bidirectional via `fork_apply_merge_both_directions`**
   515	/// — both peers, after merge + repair, must converge to the same
   516	/// formula text + resolved value.
   517	#[test]
   518	fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
   519	    // Base: sheet S with a literal at S!A1 = 42.0.
   520	    let mut base_log = base_with_sheet();
   521	    base_log
   522	        .append(Op::PutValue {
   523	            sheet: 0,
   524	            row: 0,
   525	            col: 0,
   526	            value: CellWireValue::Number(42.0),
   527	        })
   528	        .unwrap();
   529	    let base = base_log.export_bytes().unwrap();
   530	
   531	    // Use the bidirectional helper to fork the two peers + apply
   532	    // their concurrent ops + cross-merge — but we have to interpose
   533	    // the repair pass between replay and recompute. The fork helper
   534	    // doesn't know about repair (it's a step-2-and-earlier helper),
   535	    // so we duplicate its logic inline here for the step 3 case.
   536	    let mut peer_a = OpLog::import_bytes(&base).unwrap();
   537	    peer_a.set_peer_id(1).unwrap();
   538	    peer_a
   539	        .append(Op::RenameSheet {
   540	            id: 0,
   541	            old_name: "S".to_owned(),
   542	            new_name: "S2".to_owned(),
   543	        })
   544	        .unwrap();
   545	    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
   546	    peer_b_for_a.set_peer_id(2).unwrap();
   547	    peer_b_for_a
   548	        .append(Op::PutFormula {
   549	            sheet: 0,
   550	            row: 1,
   551	            col: 0,
   552	            text: "S!A1".to_owned(),
   553	        })
   554	        .unwrap();
   555	    peer_a
   556	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   557	        .unwrap();
   558	
   559	    // Symmetric peer B view.
   560	    let mut peer_b = OpLog::import_bytes(&base).unwrap();
   561	    peer_b.set_peer_id(2).unwrap();
   562	    peer_b
   563	        .append(Op::PutFormula {
   564	            sheet: 0,
   565	            row: 1,
   566	            col: 0,
   567	            text: "S!A1".to_owned(),
   568	        })
   569	        .unwrap();
   570	    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
   571	    peer_a_for_b.set_peer_id(1).unwrap();
   572	    peer_a_for_b
   573	        .append(Op::RenameSheet {
   574	            id: 0,
   575	            old_name: "S".to_owned(),
   576	            new_name: "S2".to_owned(),
   577	        })
   578	        .unwrap();
   579	    peer_b
   580	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   581	        .unwrap();
   582	
   583	    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
   584	    let replay_repair_recompute = |log: &OpLog| -> Workbook {
   585	        let mut wb = Workbook::new();
   586	        let reg = default_registry();
   587	        replay_into(log, &mut wb, &reg).expect("replay must succeed");
   588	        // **Step 3 closure point**: the repair pass rewrites concurrent
   589	        // formula text referencing pre-rename sheet names. Without
   590	        // this call, recompute would surface #NAME? (D-3 V1 limitation).
   591	        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
   592	            .expect("repair_sheet_rename_chain must succeed");
   593	        assert_eq!(
   594	            report.formulas_rewritten, 1,
   595	            "exactly 1 formula (peer B's =S!A1) must be rewritten"
   596	        );
   597	        {
   598	            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   599	            rt.recompute_all();
   600	        }
   601	        wb
   602	    };
   603	
   604	    let wb_a = replay_repair_recompute(&peer_a);
   605	    let wb_b = replay_repair_recompute(&peer_b);
   606	
   607	    let a2_a = wb_a.read(Address::new(0, 1, 0));
   608	    let a2_b = wb_b.read(Address::new(0, 1, 0));
   609	
   610	    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
   611	    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
   612	    // cell at S2!A1 is the literal 42.0 from the base log.
   613	    assert_eq!(
   614	        a2_a,
   615	        Value::Number(42.0),
   616	        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
   617	         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
   618	    );
   619	
   620	    // Pin the formula text directly to confirm the repair did its job.
   621	    assert_eq!(
   622	        wb_a.formula_at(0, 1, 0).map(|s| s.to_string()),
   623	        Some("S2!A1".to_string()),
   624	        "formula text post-repair must reference current sheet name (S2)"
   625	    );
     1	[package]
     2	name = "ql-exec"
     3	version.workspace = true
     4	edition.workspace = true
     5	rust-version.workspace = true
     6	license.workspace = true
     7	publish.workspace = true
     8	
     9	[lib]
    10	path = "src/lib.rs"
    11	
    12	[dependencies]
    13	ql-types          = { path = "../ql-types" }
    14	ql-formula-syntax = { path = "../ql-formula-syntax" }
    15	ql-calcgraph      = { path = "../ql-calcgraph" }
    16	ql-storage        = { path = "../ql-storage" }
    17	ql-functions      = { path = "../ql-functions" }
    18	# Phase 2A.4 (2026-05-12): promoted from dev-dependency. `loader.rs` needs
    19	# `ql_io::load_workbook` at runtime for the `load_workbook_and_recompute`
    20	# convenience. No new transitive risk — ql-io was already linked through
    21	# dev-deps in the same crate.
    22	ql-io             = { path = "../ql-io" }
    23	# Phase 2A.3.b (2026-05-12): opt-in op-log attachment for WorkbookRuntime +
    24	# WorkbookTransaction. CellWireValue conversion happens via ql-io (already
    25	# present); Op + OpLog types come from ql-oplog.
    26	ql-oplog          = { path = "../ql-oplog" }
    27	arrow-array       = { workspace = true }
    28	multiversion      = { workspace = true }
    29	thiserror         = { workspace = true }
    30	# `pulp` is in workspace.dependencies for Phase 4+ kernels that need explicit lane ops
    31	# (Welford reduction with custom lanes, SUMIF masking). W4 SIMD relies on multiversion
    32	# attributes + LLVM auto-vectorization — pulp not yet needed. Adding pulp would pull in
    33	# the unmaintained `paste` transitive (RUSTSEC-2024-0436) which fails cargo-audit.
    34	# Re-add when actually used.
    35	
    36	[dev-dependencies]
    37	proptest  = { workspace = true }
    38	criterion = { workspace = true }
    39	tempfile  = { workspace = true }
    40	# Phase 2B.3: BPC-04 test wires bind-plan-cache stats into Timings to prove
    41	# the visibility contract.
    42	ql-profile = { path = "../ql-profile" }
    43	# Phase 5.3 step 3 (2026-05-20) — row 7 of the conflict-matrix probe
    44	# test (`phase_5_3_conflict_matrix_probe.rs`) asserts the post-repair
    45	# state of formulas authored against concurrently-renamed sheet names.
    46	# Direction: dev-only; ql-collab → ql-exec has no Cargo cycle since
    47	# ql-collab does not depend on ql-exec (they are siblings).
    48	ql-collab  = { path = "../ql-collab" }
    49	
    50	# Phase 0 OG-02 hot path bench (Week 4 acceptance run).
    51	[[bench]]
    52	name = "og02_mul2"
    53	harness = false
    54	
    55	# Phase 0 OG-04 1M scalar baseline bench.
    56	[[bench]]
    57	name = "og04_scalar_1m"
    58	harness = false
    59	
    60	# Phase 0 A7 chunk-size sweep over the OG-02 mul2 hot path.
    61	[[bench]]
    62	name = "og02_chunk_sweep"
    63	harness = false
    64	
    65	# Phase 3.10 megaudit A3-03: 10k-formula dirty recompute benchmark.
    66	# Cold edit + idempotent edit (the latter measures the Phase 3.8 VEQ
    67	# short-circuit gain). Regression detection — guards against future
    68	# changes that re-introduce O(n) eval on idempotent edits.
    69	[[bench]]
    70	name = "a3_10k_dirty_recompute"
    71	harness = false

 succeeded in 260ms:
     1	//! `ql_collab::repair` — Phase 5.3 step 3 rename-repair pass
     2	//! (CORE 5.3 work, 2026-05-20).
     3	//!
     4	//! ## Purpose
     5	//!
     6	//! After merging concurrent ops from peers, formulas authored against
     7	//! pre-rename sheet names may reference names that no longer exist.
     8	//! Pre-step-3 behavior (D-3 V1 limitation): such formulas surface as
     9	//! `BindError::UnknownSheet` → `#NAME?` at recompute time. This module
    10	//! ships the post-merge repair pass that rewrites the formula text
    11	//! in-place via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr`
    12	//! machinery (same one producer-side rename uses for single-writer flows).
    13	//!
    14	//! ## Caller contract
    15	//!
    16	//! `repair_sheet_rename_chain` is **caller-driven**, NOT hooked into
    17	//! `merge_bytes`. Audit-locked design decision D-5.3-1 (see
    18	//! `quantbook-engine/.plans/_active.md`). Typical call sequence:
    19	//!
    20	//! ```text
    21	//! 1. CollabSession::merge_bytes(peer_b_bytes)   // pull peer's ops
    22	//! 2. replay_into(log, &mut workbook, &registry) // apply ops to workbook
    23	//! 3. ql_collab::repair_sheet_rename_chain(&mut workbook, &log)?  // <-- THIS module
    24	//! 4. WorkbookRuntime::recompute_all(...)        // evaluate formulas
    25	//! ```
    26	//!
    27	//! Step 3 is OPTIONAL (replay + recompute work without it), but skipping
    28	//! it means concurrent-edit formulas referencing renamed sheets resolve
    29	//! as `#NAME?`. Production callers in collaborative workflows SHOULD
    30	//! invoke it before recompute; single-writer / qbook-load workflows
    31	//! don't need it (no concurrent renames possible).
    32	//!
    33	//! ## Algorithm (chain-based, NOT causality-aware)
    34	//!
    35	//! Audit-locked design decision D-5.3-2.
    36	//!
    37	//! 1. Walk the op log; for each `Op::RenameSheet { id, old_name, .. }`
    38	//!    (including ops nested in `BatchCommit`), record `old_name` as a
    39	//!    historic name of `id`.
    40	//!
    41	//! 2. For each sheet, build the rewrite rule
    42	//!    `(canonical_historic_name → current_display_name)`. Skip pairs
    43	//!    where the canonical matches the sheet's CURRENT canonical
    44	//!    (no-op). The "current" name is taken from the workbook post-replay
    45	//!    — this captures step-2's auto-disambiguation suffixes (e.g.
    46	//!    a sheet that wanted "X" but ended up "X(2)" rewrites historic
    47	//!    references to "X(2)", not the intended "X").
    48	//!
    49	//! 3. Walk every formula in the workbook via `Workbook::iter_formulas`.
    50	//!    For each, apply rewrites via [`rewrite_formula_with_rename`].
    51	//!    Idempotent: the helper returns `None` when no change applies.
    52	//!    Multiple rewrites may compose (transitive chain S1→S2→S3 produces
    53	//!    rewrites for both S1 and S2 → final name).
    54	//!
    55	//! 4. Apply collected updates via `Workbook::put_formula`.
    56	//!
    57	//! ## Known limitations (V1)
    58	//!
    59	//! - **Cross-sheet historic-name ambiguity**: if two sheets HAD the
    60	//!   same canonical name at different points in their respective
    61	//!   chains (rare — requires a sheet to be renamed away from a name
    62	//!   that another sheet was THEN renamed to), the rewrite picks the
    63	//!   "later in iteration" rule. Document but don't resolve. Real
    64	//!   workflows rarely hit this because D-2 auto-rename prevents
    65	//!   concurrent identical names.
    66	//!
    67	//! - **Concurrent-rename intermediate names lost**: if peer A's chain
    68	//!   is S1→S2→S3 with both ops applied in sequence, the intermediate
    69	//!   name "S2" lives in `old_name` of the second op so it IS captured.
    70	//!   But if a concurrent rename forced the second op to apply "from"
    71	//!   a different name (step 2's last-wins policy), the old_name from
    72	//!   the wire may not reflect what current was at apply-time. Formulas
    73	//!   referencing that intermediate name may not be repaired. Mitigation
    74	//!   for future: causality-aware tracking via Loro op-ids (deferred).
    75	//!
    76	//! - **Step 4 extension**: this V1 only handles sheet renames.
    77	//!   `Op::RenameTable` + `Op::RenameColumn` need the same treatment;
    78	//!   step 4 of the Phase 5.3 arc adds them.
    79	
    80	use ql_oplog::{Op, OpLog, OpLogError};
    81	use ql_storage::Workbook;
    82	use ql_types::SheetId;
    83	use std::collections::HashMap;
    84	use std::sync::Arc;
    85	
    86	/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
    87	/// logging / diagnostics. Per the no-fallback rule (CLAUDE.md), this
    88	/// surfaces *what was done* rather than silently absorbing the work.
    89	#[derive(Debug, Clone, Default)]
    90	pub struct RepairReport {
    91	    /// Total number of formulas whose text was rewritten by the pass.
    92	    pub formulas_rewritten: usize,
    93	
    94	    /// Per-sheet rewrite summary: the sheet id, its final display name
    95	    /// post-replay, and the historic canonical names whose references
    96	    /// were rewritten. Empty if no sheet had a rename.
    97	    pub sheet_rewrites: Vec<SheetRewriteSummary>,
    98	}
    99	
   100	/// Per-sheet summary line in [`RepairReport`].
   101	#[derive(Debug, Clone)]
   102	pub struct SheetRewriteSummary {
   103	    pub sheet: SheetId,
   104	    pub current_display_name: String,
   105	    /// Historic canonical names from `Op::RenameSheet.old_name`. Sorted
   106	    /// + deduped. Empty iff the sheet had no rename ops in the log.
   107	    pub historic_canonicals: Vec<String>,
   108	}
   109	
   110	/// Walk the op log to build a chain of sheet renames, then rewrite
   111	/// every formula in `workbook` whose text references a historic
   112	/// (pre-rename) sheet name. See module docs for the algorithm.
   113	///
   114	/// Returns a [`RepairReport`] describing what was changed. The report
   115	/// is informational; the workbook is mutated in place.
   116	///
   117	/// **Errors**: only propagates `OpLogError` from iterating the op log
   118	/// (e.g., a corrupted Loro `LoroValue::String` that fails serde
   119	/// decode). Formula rewrites that fail to parse are SKIPPED silently
   120	/// (the helper returns `None` on parse failure, preserving the
   121	/// pre-rewrite text). This matches the producer-side helper's
   122	/// behavior and avoids the no-fallback violation that would fire if
   123	/// we returned an error for unparseable formulas (those formulas
   124	/// would already produce parse errors at recompute time — repair
   125	/// doesn't worsen that).
   126	///
   127	/// **Caller-driven**: NOT auto-invoked by `merge_bytes`. See module
   128	/// docs for the expected call sequence.
   129	pub fn repair_sheet_rename_chain(
   130	    workbook: &mut Workbook,
   131	    log: &OpLog,
   132	) -> Result<RepairReport, OpLogError> {
   133	    // ===== Phase 1: walk op log; collect historic old_names per sheet.
   134	    let mut historic_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();
   135	    for op_result in log.iter() {
   136	        let op = op_result?;
   137	        collect_rename_old_names(&op, &mut historic_by_sheet);
   138	    }
   139	
   140	    // ===== Phase 2: build (canonical_historic → current_display_name) rules.
   141	    // Skip pairs where canonical historic matches current canonical (no-op).
   142	    // For deterministic iteration (and audit reproducibility), sort the rules.
   143	    let mut rules: Vec<(String, Arc<str>, SheetId)> = Vec::new();
   144	    let mut sheet_rewrites: Vec<SheetRewriteSummary> = Vec::new();
   145	    let mut sheet_ids: Vec<SheetId> = historic_by_sheet.keys().copied().collect();
   146	    sheet_ids.sort_unstable();
   147	    for sheet_id in sheet_ids {
   148	        let historic = historic_by_sheet
   149	            .get(&sheet_id)
   150	            .cloned()
   151	            .unwrap_or_default();
   152	        let Some(current) = workbook.sheet(sheet_id).map(|s| s.name().to_owned()) else {
   153	            // Sheet ID is in the rename history but doesn't exist in the
   154	            // current workbook. Should not happen for sheet renames (no
   155	            // DropSheet op exists in V1). Defensive skip.
   156	            continue;
   157	        };
   158	        let current_canonical = Workbook::canonical_sheet_name(&current);
   159	        let current_arc: Arc<str> = Arc::from(current.as_str());
   160	
   161	        // Dedupe historic canonicals; skip those matching current canonical.
   162	        let mut historic_canonicals: Vec<String> = historic
   163	            .iter()
   164	            .map(|s| Workbook::canonical_sheet_name(s))
   165	            .filter(|c| c != &current_canonical)
   166	            .collect();
   167	        historic_canonicals.sort();
   168	        historic_canonicals.dedup();
   169	
   170	        for hc in &historic_canonicals {
   171	            rules.push((hc.clone(), Arc::clone(&current_arc), sheet_id));
   172	        }
   173	
   174	        sheet_rewrites.push(SheetRewriteSummary {
   175	            sheet: sheet_id,
   176	            current_display_name: current,
   177	            historic_canonicals,
   178	        });
   179	    }
   180	
   181	    // ===== Phase 3: walk formulas, collect updates.
   182	    // Two-phase to avoid mut/immut borrow conflict on workbook.
   183	    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
   184	    for (sheet, row, col, text) in workbook.iter_formulas() {
   185	        let mut current_text = text.to_string();
   186	        let mut changed = false;
   187	        for (old_canonical, new_name, _origin_sheet) in &rules {
   188	            if let Some(rewritten) =
   189	                rewrite_formula_with_rename(&current_text, old_canonical, new_name)
   190	            {
   191	                current_text = rewritten;
   192	                changed = true;
   193	            }
   194	        }
   195	        if changed {
   196	            to_update.push((sheet, row, col, current_text));
   197	        }
   198	    }
   199	    let rewrite_count = to_update.len();
   200	
   201	    // ===== Phase 4: apply updates.
   202	    for (sheet, row, col, new_text) in to_update {
   203	        workbook.put_formula(sheet, row, col, new_text);
   204	    }
   205	
   206	    Ok(RepairReport {
   207	        formulas_rewritten: rewrite_count,
   208	        sheet_rewrites,
   209	    })
   210	}
   211	
   212	/// Walk an `Op`, including ops nested in `BatchCommit`, and record
   213	/// `RenameSheet.old_name` entries in `historic`. Other op kinds are
   214	/// ignored.
   215	fn collect_rename_old_names(op: &Op, historic: &mut HashMap<SheetId, Vec<String>>) {
   216	    match op {
   217	        Op::RenameSheet { id, old_name, .. } => {
   218	            historic.entry(*id).or_default().push(old_name.clone());
   219	        }
   220	        Op::BatchCommit { ops } => {
   221	            for inner in ops {
   222	                collect_rename_old_names(inner, historic);
   223	            }
   224	        }
   225	        _ => {}
   226	    }
   227	}
   228	
   229	/// Rewrite `text` (formula source) substituting every reference to
   230	/// `old_canonical` (a canonical-uppercase sheet name) with `new_name`
   231	/// (the new display name).
   232	///
   233	/// Mirror of the producer-side helper at
   234	/// `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Kept here
   235	/// because ql-collab has no dep on ql-exec (direction: ql-collab is
   236	/// below ql-exec). Both helpers route through
   237	/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
   238	///
   239	/// Returns `None` when:
   240	/// - The text doesn't lex/parse (formula is malformed — caller should
   241	///   not surface this as an error; recompute will surface it).
   242	/// - The parsed AST doesn't reference `old_canonical` (no rewrite).
   243	fn rewrite_formula_with_rename(
   244	    text: &str,
   245	    old_canonical: &str,
   246	    new_name: &Arc<str>,
   247	) -> Option<String> {
   248	    let stripped = text.strip_prefix('=').unwrap_or(text);
   249	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
   250	    let expr = ql_formula_syntax::parse(tokens).ok()?;
   251	    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
   252	    if rewritten == expr {
   253	        return None;
   254	    }
   255	    let printed = ql_formula_syntax::print(&rewritten);
   256	    let with_eq = if text.starts_with('=') {
   257	        format!("={printed}")
   258	    } else {
   259	        printed
   260	    };
     1	//! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
     2	//! integration tests. 2026-05-20.
     3	//!
     4	//! Covers the user-visible property step 3 ships: after merging
     5	//! concurrent ops, formulas authored against pre-rename sheet names
     6	//! get rewritten to the current name. The repair pass closes the V1
     7	//! limitation documented at `crdt-data-model.md:615-648` (D-3 →
     8	//! `#NAME?`).
     9	//!
    10	//! Test pattern follows Phase 5.3 step 2's `phase_5_3_step2_rename_concurrent.rs`:
    11	//! 2-peer fork with stable peer-ids. Each test:
    12	//!   1. Build shared base log.
    13	//!   2. Fork peer A + peer B via `fork_with_peer`.
    14	//!   3. Each peer appends its local op.
    15	//!   4. Exchange via `export_bytes` + `merge_bytes`.
    16	//!   5. Replay into fresh workbook.
    17	//!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
    18	//!   7. Assert formula text + (optionally) recomputed value.
    19	//!
    20	//! NOTE: these tests don't recompute (no ql-functions in ql-collab's
    21	//! dev-deps). They assert the FORMULA TEXT after repair, which is the
    22	//! load-bearing property. Recompute correctness is a downstream concern
    23	//! pinned at the row-7 test in `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs`.
    24	
    25	use ql_collab::{repair_sheet_rename_chain, RepairReport};
    26	use ql_oplog::{replay_into, Op, OpLog};
    27	use ql_storage::Workbook;
    28	
    29	const PEER_A_ID: u64 = 1;
    30	const PEER_B_ID: u64 = 2;
    31	
    32	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    33	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    34	    log.set_peer_id(peer_id)
    35	        .expect("set_peer_id with non-zero id must succeed");
    36	    log
    37	}
    38	
    39	fn base_with_sheet(name: &str) -> OpLog {
    40	    let mut log = OpLog::new();
    41	    log.append(Op::AddSheet {
    42	        name: name.to_owned(),
    43	        chunk_rows: 16384,
    44	    })
    45	    .unwrap();
    46	    log
    47	}
    48	
    49	/// Replay `log` into a fresh workbook. We use the registry from
    50	/// ql-functions (already a ql-collab dep) since `replay_into` requires
    51	/// it; we don't recompute (that's a downstream test concern).
    52	fn replay_to_workbook(log: &OpLog) -> Workbook {
    53	    let mut wb = Workbook::new();
    54	    let reg = ql_functions::default_registry();
    55	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    56	    wb
    57	}
    58	
    59	/// Helper: build a merged log from two peers + apply concurrent ops.
    60	/// Mirrors the step-2 pattern; peer A is the merger.
    61	fn merged_log_with_concurrent_ops(base: &[u8], op_a: Op, op_b: Op) -> OpLog {
    62	    let mut peer_a = fork_with_peer(base, PEER_A_ID);
    63	    peer_a.append(op_a).unwrap();
    64	    let mut peer_b = fork_with_peer(base, PEER_B_ID);
    65	    peer_b.append(op_b).unwrap();
    66	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    67	    peer_a
    68	}
    69	
    70	// ===== Test 1: PRIMARY — concurrent rename + concurrent formula edit =====
    71	
    72	/// **Step 3 PRIMARY property**: peer A renames sheet S → S2;
    73	/// peer B (concurrent, no knowledge of rename) writes `=S!A1` at B1.
    74	/// After merge + repair, the formula text is rewritten to `=S2!A1`.
    75	///
    76	/// This is the canonical bug case from `crdt-data-model.md` row 7:
    77	/// pre-step-3 the formula would bind-fail (S no longer exists) and
    78	/// recompute → #NAME?. Post-step-3 the formula references the current
    79	/// sheet name and resolves correctly.
    80	#[test]
    81	fn repair_rewrites_concurrent_formula_referencing_old_name() {
    82	    // Base: sheet S exists.
    83	    let base = base_with_sheet("S").export_bytes().unwrap();
    84	
    85	    let log = merged_log_with_concurrent_ops(
    86	        &base,
    87	        Op::RenameSheet {
    88	            id: 0,
    89	            old_name: "S".to_owned(),
    90	            new_name: "S2".to_owned(),
    91	        },
    92	        Op::PutFormula {
    93	            sheet: 0,
    94	            row: 1,
    95	            col: 0, // B2... actually row 1, col 0 = A2
    96	            text: "S!A1".to_owned(),
    97	        },
    98	    );
    99	
   100	    let mut wb = replay_to_workbook(&log);
   101	    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
   102	    // Pre-repair: formula at (1,0) is "S!A1".
   103	    assert_eq!(
   104	        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
   105	        Some("S!A1".to_string()),
   106	        "pre-repair formula text is the raw merge state (S!A1, referencing old name)"
   107	    );
   108	
   109	    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");
   110	
   111	    // Post-repair: formula rewritten to reference current sheet name.
   112	    assert_eq!(
   113	        wb.formula_at(0, 1, 0).map(|s| s.to_string()),
   114	        Some("S2!A1".to_string()),
   115	        "post-repair formula text references current sheet name (S2)"
   116	    );
   117	    assert_eq!(
   118	        report.formulas_rewritten, 1,
   119	        "exactly 1 formula rewritten (B's =S!A1)"
   120	    );
   121	    assert_eq!(report.sheet_rewrites.len(), 1);
   122	    assert_eq!(report.sheet_rewrites[0].sheet, 0);
   123	    assert_eq!(report.sheet_rewrites[0].current_display_name, "S2");
   124	    assert_eq!(report.sheet_rewrites[0].historic_canonicals, vec!["S"]);
   125	}
   126	
   127	// ===== Test 2: Transitive chain (sequential renames) =====
   128	
   129	/// **Step 3:** sequential rename chain S → S2 → S3 (single peer
   130	/// across multiple ops). Peer B (forked at base) writes `=S!A1`.
   131	/// Repair should rewrite the formula to `=S3!A1` (the final name)
   132	/// since "S" is no longer current.
   133	#[test]
   134	fn repair_handles_transitive_chain_to_final_name() {
   135	    let base = base_with_sheet("S").export_bytes().unwrap();
   136	
   137	    // Peer A: chain S → S2 → S3.
   138	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   139	    peer_a
   140	        .append(Op::RenameSheet {
   141	            id: 0,
   142	            old_name: "S".to_owned(),
   143	            new_name: "S2".to_owned(),
   144	        })
   145	        .unwrap();
   146	    peer_a
   147	        .append(Op::RenameSheet {
   148	            id: 0,
   149	            old_name: "S2".to_owned(),
   150	            new_name: "S3".to_owned(),
   151	        })
   152	        .unwrap();
   153	
   154	    // Peer B: concurrent formula referencing original name.
   155	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   156	    peer_b
   157	        .append(Op::PutFormula {
   158	            sheet: 0,
   159	            row: 0,
   160	            col: 0,
   161	            text: "S!A1".to_owned(),
   162	        })
   163	        .unwrap();
   164	
   165	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   166	    let mut wb = replay_to_workbook(&peer_a);
   167	
   168	    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   169	
   170	    // Formula rewritten directly to the final name S3 (skipping S2).
   171	    assert_eq!(
   172	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   173	        Some("S3!A1".to_string()),
   174	        "transitive chain: S → S2 → S3 rewrites S references directly to S3"
   175	    );
   176	}
   177	
   178	// ===== Test 3: Rename-back (chain collapses) =====
   179	
   180	/// **Step 3:** rename-back chain S → S2 → S. Peer B writes
   181	/// `=S2!A1` (referencing the intermediate). After repair:
   182	/// formula references S (the current name), because S2 is now a
   183	/// historic name in the chain.
   184	#[test]
   185	fn repair_handles_rename_back_intermediate_reference() {
   186	    let base = base_with_sheet("S").export_bytes().unwrap();
   187	
   188	    // Peer A: S → S2 → S (final = original).
   189	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   190	    peer_a
   191	        .append(Op::RenameSheet {
   192	            id: 0,
   193	            old_name: "S".to_owned(),
   194	            new_name: "S2".to_owned(),
   195	        })
   196	        .unwrap();
   197	    peer_a
   198	        .append(Op::RenameSheet {
   199	            id: 0,
   200	            old_name: "S2".to_owned(),
   201	            new_name: "S".to_owned(),
   202	        })
   203	        .unwrap();
   204	
   205	    // Peer B references the INTERMEDIATE name S2.
   206	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   207	    peer_b
   208	        .append(Op::PutFormula {
   209	            sheet: 0,
   210	            row: 0,
   211	            col: 0,
   212	            text: "S2!A1".to_owned(),
   213	        })
   214	        .unwrap();
   215	
   216	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   217	    let mut wb = replay_to_workbook(&peer_a);
   218	
   219	    assert_eq!(wb.sheet(0).unwrap().name(), "S");
   220	
   221	    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   222	
   223	    // S2 was historic; repair rewrites S2 → S (current name).
   224	    assert_eq!(
   225	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   226	        Some("S!A1".to_string()),
   227	        "rename-back: S2 references rewritten to current name S"
   228	    );
   229	}
   230	
   231	// ===== Test 4: No-op case — formula references unrenamed sheet =====
   232	
   233	/// **Step 3:** formula references a sheet that was NEVER renamed.
   234	/// Repair must be a no-op for that formula. Pins idempotency of the
   235	/// helper's None-on-no-change return.
   236	#[test]
   237	fn repair_leaves_unrelated_formulas_unchanged() {
   238	    // Base: two sheets S (id 0) + T (id 1).
   239	    let mut base_log = OpLog::new();
   240	    base_log
   241	        .append(Op::AddSheet {
   242	            name: "S".to_owned(),
   243	            chunk_rows: 16384,
   244	        })
   245	        .unwrap();
   246	    base_log
   247	        .append(Op::AddSheet {
   248	            name: "T".to_owned(),
   249	            chunk_rows: 16384,
   250	        })
   251	        .unwrap();
   252	    let base = base_log.export_bytes().unwrap();
   253	
   254	    // Peer A: rename S → S2 (id 0).
   255	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   256	    peer_a
   257	        .append(Op::RenameSheet {
   258	            id: 0,
   259	            old_name: "S".to_owned(),
   260	            new_name: "S2".to_owned(),
   261	        })
   262	        .unwrap();
   263	
   264	    // Peer B: formula on T referencing T (unrelated to rename).
   265	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   266	    peer_b
   267	        .append(Op::PutFormula {
   268	            sheet: 1,
   269	            row: 0,
   270	            col: 0,
   271	            text: "T!B1".to_owned(),
   272	        })
   273	        .unwrap();
   274	
   275	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   276	    let mut wb = replay_to_workbook(&peer_a);
   277	
   278	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   279	
   280	    // T!B1 untouched.
   281	    assert_eq!(
   282	        wb.formula_at(1, 0, 0).map(|s| s.to_string()),
   283	        Some("T!B1".to_string()),
   284	        "formula on unrenamed sheet must NOT be rewritten"
   285	    );
   286	    assert_eq!(
   287	        report.formulas_rewritten, 0,
   288	        "no formula references the renamed sheet's old name"
   289	    );
   290	}
   291	
   292	// ===== Test 5: Idempotency =====
   293	
   294	/// **Step 3:** running repair TWICE produces the same result as
   295	/// running it once. Pins the no-op-on-no-change property — critical
   296	/// for callers that might invoke repair multiple times during a
   297	/// session.
   298	#[test]
   299	fn repair_is_idempotent() {
   300	    let base = base_with_sheet("S").export_bytes().unwrap();
   301	    let log = merged_log_with_concurrent_ops(
   302	        &base,
   303	        Op::RenameSheet {
   304	            id: 0,
   305	            old_name: "S".to_owned(),
   306	            new_name: "S2".to_owned(),
   307	        },
   308	        Op::PutFormula {
   309	            sheet: 0,
   310	            row: 0,
   311	            col: 0,
   312	            text: "S!A1".to_owned(),
   313	        },
   314	    );
   315	
   316	    let mut wb = replay_to_workbook(&log);
   317	    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   318	    let after_first = wb.formula_at(0, 0, 0).map(|s| s.to_string());
   319	
   320	    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   321	    let after_second = wb.formula_at(0, 0, 0).map(|s| s.to_string());
   322	
   323	    assert_eq!(first.formulas_rewritten, 1);
   324	    assert_eq!(
   325	        second.formulas_rewritten, 0,
   326	        "second repair pass must be a no-op (helper returns None on no-change)"
   327	    );
   328	    assert_eq!(
   329	        after_first, after_second,
   330	        "formula text stable across repeated repair calls"
   331	    );
   332	}
   333	
   334	// ===== Test 6: Empty log =====
   335	
   336	/// **Step 3:** no rename ops in the log → repair is trivial no-op.
   337	#[test]
   338	fn repair_with_no_renames_is_noop() {
   339	    let mut log = OpLog::new();
   340	    log.append(Op::AddSheet {
   341	        name: "S".to_owned(),
   342	        chunk_rows: 16384,
   343	    })
   344	    .unwrap();
   345	    log.append(Op::PutFormula {
   346	        sheet: 0,
   347	        row: 0,
   348	        col: 0,
   349	        text: "S!A1".to_owned(),
   350	    })
   351	    .unwrap();
   352	
   353	    let mut wb = replay_to_workbook(&log);
   354	    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");
   355	
   356	    assert_eq!(report.formulas_rewritten, 0);
   357	    assert!(report.sheet_rewrites.is_empty());
   358	    assert_eq!(
   359	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   360	        Some("S!A1".to_string())
   361	    );
   362	}
   363	
   364	// ===== Test 7: Step 2 auto-disambiguation chain =====
   365	
   366	/// **Step 3 + step-2-audit interaction**: two peers concurrently
   367	/// rename DIFFERENT sheets to the SAME target. Step 2's auto-
   368	/// disambiguation suffixes the second to `X(2)`. Peer C writes
   369	/// `=S3!A1` referencing sheet 1's original name. After merge +
   370	/// repair, the formula should rewrite to the current name of
   371	/// sheet 1, which is `X(2)`.
   372	#[test]
   373	fn repair_handles_step2_auto_disambiguation_suffix() {
   374	    // Base: 2 sheets (S1 = id 0, S3 = id 1).
   375	    let mut base_log = OpLog::new();
   376	    base_log
   377	        .append(Op::AddSheet {
   378	            name: "S1".to_owned(),
   379	            chunk_rows: 16384,
   380	        })
   381	        .unwrap();
   382	    base_log
   383	        .append(Op::AddSheet {
   384	            name: "S3".to_owned(),
   385	            chunk_rows: 16384,
   386	        })
   387	        .unwrap();
   388	    let base = base_log.export_bytes().unwrap();
   389	
   390	    // Peer A: rename sheet 0 (S1) → X.
   391	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   392	    peer_a
   393	        .append(Op::RenameSheet {
   394	            id: 0,
   395	            old_name: "S1".to_owned(),
   396	            new_name: "X".to_owned(),
   397	        })
   398	        .unwrap();
   399	    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
   400	    // triggers step 2 auto-rename to X(2)). Also writes a formula
   401	    // referencing the OLD name S3.
   402	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   403	    peer_b
   404	        .append(Op::RenameSheet {
   405	            id: 1,
   406	            old_name: "S3".to_owned(),
   407	            new_name: "X".to_owned(),
   408	        })
   409	        .unwrap();
   410	    peer_b
   411	        .append(Op::PutFormula {
   412	            sheet: 1,
   413	            row: 0,
   414	            col: 0,
   415	            text: "S3!B1".to_owned(),
   416	        })
   417	        .unwrap();
   418	
   419	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   420	    let mut wb = replay_to_workbook(&peer_a);
   421	
   422	    // Sheet 0 = "X" (peer A's rename), sheet 1 = "X(2)" (auto-disambig).
   423	    assert_eq!(wb.sheet(0).unwrap().name(), "X");
   424	    assert_eq!(wb.sheet(1).unwrap().name(), "X(2)");
   425	
   426	    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   427	
   428	    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
   429	    // Formula syntax requires quoting sheet names containing `(` or `)`,
   430	    // so the printer emits `'X(2)'!B1` (single-quoted), NOT `X(2)!B1`.
   431	    // This is correct canonical form for the formula language.
   432	    let formula_text = wb.formula_at(1, 0, 0).map(|s| s.to_string());
   433	    assert_eq!(
   434	        formula_text,
   435	        Some("'X(2)'!B1".to_string()),
   436	        "repair must rewrite to the auto-disambiguated current name X(2) \
   437	         (single-quoted because '(' requires quoting in formula syntax)"
   438	    );
   439	}
   440	
   441	// ===== Test 8: BatchCommit-wrapped rename =====
   442	
   443	/// **Step 3:** the producer-side rename emits in a `BatchCommit`
   444	/// (rename + formula rewrites together). Our repair must traverse
   445	/// BatchCommits to find nested `Op::RenameSheet`.
   446	#[test]
   447	fn repair_walks_batchcommit_nested_renames() {
   448	    let base = base_with_sheet("S").export_bytes().unwrap();
   449	
   450	    // Peer A: rename via BatchCommit (mirrors producer pattern).
   451	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   452	    peer_a
   453	        .append(Op::BatchCommit {
   454	            ops: vec![Op::RenameSheet {
   455	                id: 0,
   456	                old_name: "S".to_owned(),
   457	                new_name: "Renamed".to_owned(),
   458	            }],
   459	        })
   460	        .unwrap();
   461	
   462	    // Peer B: concurrent formula referencing old name.
   463	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   464	    peer_b
   465	        .append(Op::PutFormula {
   466	            sheet: 0,
   467	            row: 0,
   468	            col: 0,
   469	            text: "S!A1".to_owned(),
   470	        })
   471	        .unwrap();
   472	
   473	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   474	    let mut wb = replay_to_workbook(&peer_a);
   475	
   476	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
   477	    assert_eq!(
   478	        report.formulas_rewritten, 1,
   479	        "BatchCommit-nested RenameSheet must be discovered by the chain walker"
   480	    );
   481	    assert_eq!(
   482	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   483	        Some("Renamed!A1".to_string())
   484	    );
   485	}
   486	
   487	// ===== Test 9: Bidirectional merge convergence =====
   488	
   489	/// **Step 3:** repair must be deterministic across merge directions.
   490	/// Both peers, after merging each other's bytes + running repair,
   491	/// must observe identical formula text.
   492	#[test]
   493	fn repair_converges_across_merge_directions() {
   494	    let base = base_with_sheet("S").export_bytes().unwrap();
   495	
   496	    // Peer A's view: rename + put_value (for cell to reference).
   497	    // Peer B's view: formula referencing S.
   498	    let op_a = Op::RenameSheet {
   499	        id: 0,
   500	        old_name: "S".to_owned(),
   501	        new_name: "S2".to_owned(),
   502	    };
   503	    let op_b = Op::PutFormula {
   504	        sheet: 0,
   505	        row: 0,
   506	        col: 0,
   507	        text: "S!A1".to_owned(),
   508	    };
   509	
   510	    // Direction 1: A merges B.
   511	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   512	    peer_a.append(op_a.clone()).unwrap();
   513	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
   514	    peer_b_for_a.append(op_b.clone()).unwrap();
   515	    peer_a
   516	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   517	        .unwrap();
   518	    let mut wb_a = replay_to_workbook(&peer_a);
   519	    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();
   520	
   521	    // Direction 2: B merges A.
   522	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   523	    peer_b.append(op_b).unwrap();
   524	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   525	    peer_a_for_b.append(op_a).unwrap();
   526	    peer_b
   527	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   528	        .unwrap();
   529	    let mut wb_b = replay_to_workbook(&peer_b);
   530	    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();
   531	
   532	    assert_eq!(
   533	        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
   534	        wb_b.formula_at(0, 0, 0).map(|s| s.to_string()),
   535	        "bidirectional convergence: formula text matches across merge directions"
   536	    );
   537	    assert_eq!(
   538	        wb_a.formula_at(0, 0, 0).map(|s| s.to_string()),
   539	        Some("S2!A1".to_string())
   540	    );
   541	}
   542	
   543	// ===== Test 10: RepairReport structure =====
   544	
   545	/// **Step 3:** verify the report's structure carries useful diagnostic
   546	/// information for callers (no-fallback rule — surface what was done).
   547	#[test]
   548	fn repair_report_carries_diagnostic_information() {
   549	    let base = base_with_sheet("Sheet1").export_bytes().unwrap();
   550	
   551	    let log = merged_log_with_concurrent_ops(
   552	        &base,
   553	        Op::RenameSheet {
   554	            id: 0,
   555	            old_name: "Sheet1".to_owned(),
   556	            new_name: "Calculations".to_owned(),
   557	        },
   558	        Op::PutFormula {
   559	            sheet: 0,
   560	            row: 0,
   561	            col: 0,
   562	            text: "Sheet1!A1+Sheet1!B2".to_owned(),
   563	        },
   564	    );
   565	
   566	    let mut wb = replay_to_workbook(&log);
   567	    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   568	
   569	    assert_eq!(report.formulas_rewritten, 1);
   570	    assert_eq!(report.sheet_rewrites.len(), 1);
   571	    let summary = &report.sheet_rewrites[0];
   572	    assert_eq!(summary.sheet, 0);
   573	    assert_eq!(summary.current_display_name, "Calculations");
   574	    // historic_canonicals contains "SHEET1" (canonical uppercase).
   575	    assert_eq!(summary.historic_canonicals, vec!["SHEET1"]);
   576	
   577	    // Verify the formula now references "Calculations" (both occurrences).
   578	    let f = wb.formula_at(0, 0, 0).unwrap();
   579	    assert!(f.contains("Calculations"), "got: {f}");
   580	    assert!(!f.contains("Sheet1"), "got: {f}");
   581	}

exec
/bin/zsh -lc "rg -n \"pub fn print|fn print_expr|SheetRef::Name|quote_sheet|quoted|needs_quote|sheet_name\" crates/ql-formula-syntax/src -g'*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,240p' crates/ql-formula-syntax/src/printer.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,280p' crates/ql-oplog/src/op.rs && sed -n '90,160p' crates/ql-oplog/src/log.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,80p' crates/ql-storage/src/workbook.rs && sed -n '155,270p' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 271ms:
//! AST printer — produces an A1-canonical string from an `Expr`.
//!
//! Phase B per CORR-20 deliverable: round-trip property `parse(print(parse(src))) ==
//! parse(src)`. The printed form is NOT byte-identical to the source — operator
//! spacing, parenthesization, and function-name casing normalize. The semantic
//! equivalence is what matters (and what the round-trip property captures).
//!
//! ## Parenthesization
//!
//! The printer parenthesizes `Binary` and `Unary` subexpressions whenever the parent's
//! operator binding power would cause re-parsing to misorder the result. The rule:
//!
//! - For a child binary expression with op `c_op`, parenthesize if `bp(c_op).lbp <
//!   parent_min_bp`.
//! - For a power right-operand: parenthesize if `bp(c_op).rbp <= parent_rbp` (since `^`
//!   is right-associative).
//!
//! This produces canonical output: `=1 + 2 * 3` (no parens), `=(1 + 2) * 3` (parens
//! around the addition).
//!
//! ## Round-trip semantics
//!
//! `Number::Number(0.5)` doesn't round-trip to the source `50%` — the lexer normalized
//! percent at lex time. Other normalizations:
//! - Function names → uppercase (`sum(...)` → `SUM(...)`).
//! - Range corners → sorted (`A2:A1` → `A1:A2`).
//! - Whitespace → eliminated except inside string literals.
//!
//! These are intentional canonical-form rewrites, not bugs. The round-trip property
//! checks that `parse(printed) == parse(original)`, NOT that the strings match.

use crate::ast::{CellAddr, Expr, RangeRef, SheetRef};
use crate::token::{AxisSpec, Operator};
use ql_types::{Locale, ReferenceMode, MAX_COLUMN, MAX_ROW};

/// **W5-141 (Phase 4.9.D):** printer-side anchor cell. Required for
/// emitting `R[<offset>]C[<offset>]` from relative `Expr::R1C1Ref` or
/// from non-absolute `Expr::CellRef` when `mode == R1C1`.
///
/// Parallels `ql-exec::plan::BindSite::at_cell` on the bind side — see
/// design § 4.3. The bind-time site carries sheet + cell; the
/// printer-time site only needs the cell coords because the printer
/// is mode-only (sheet IDs are already resolved or `Current`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormulaSite {
    pub cell: ql_types::Address,
}

impl FormulaSite {
    pub fn at_cell(cell: ql_types::Address) -> Self {
        Self { cell }
    }
}

/// **W5-141 (Phase 4.9.D):** printer error surface. Today's only
/// variant fires when `print_with(.., R1C1, _, None)` is called on an
/// AST containing a reference whose emission requires an anchor
/// (either an `Expr::CellRef` with at least one non-absolute axis, or
/// an `Expr::R1C1Ref` with at least one `AxisSpec::Rel(_)`).
///
/// Per design § 4.3, NO fallback — production storage canon always
/// supplies a `FormulaSite`; only synthetic / test paths can surface
/// this error.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum PrintError {
    /// Anchor cell required for R1C1-mode emission of a relative ref.
    #[error("R1C1 emission requires a FormulaSite anchor (mode is R1C1 and a relative reference was encountered)")]
    R1C1RequiresAnchor,

    /// **W5-141:** the R1C1 axis resolution overflowed the i64 we use
    /// for offset arithmetic, OR an `AxisSpec::Abs(0)` slipped through.
    /// Defense-in-depth — both lexer + binder reject these earlier; this
    /// arm catches direct AST construction.
    #[error("R1C1 axis out of range: {context}")]
    R1C1AxisOutOfRange { context: &'static str },
}

/// **W5-141 (Phase 4.9.D):** internal printer context. Threads
/// `(mode, locale, site)` through the recursion. Not exposed in the
/// public API; callers configure via `print_with(...)` args.
#[derive(Clone, Copy)]
struct PrintCtx {
    mode: ReferenceMode,
    /// **W5-142 (Phase 4.9.F):** drives decimal separator in
    /// `print_number_with_locale`, function arg separator, and array
    /// row/col separators. Lookup via `crate::locale::locale_data`.
    locale: Locale,
    site: Option<FormulaSite>,
}

/// Print an `Expr` to its A1-canonical string form.
///
/// **W5-141 (Phase 4.9.D):** this is now a back-compat shim over
/// [`print_with`]. The shim is infallible because A1+EnUs+no-site is
/// guaranteed to succeed for every AST that originates from an A1
/// parse. The single exception — `Expr::R1C1Ref` with at least one
/// `Rel(_)` axis — surfaces as a panic via `.expect`. Callers that
/// might handle R1C1 forms should call [`print_with`] directly to
/// get a `Result`.
pub fn print(expr: &Expr) -> String {
    print_with(expr, ReferenceMode::A1, Locale::EnUs, None).expect(
        "print(): A1+EnUs with no FormulaSite cannot emit relative R1C1 references; \
         call print_with(.., R1C1, _, Some(site)) instead",
    )
}

/// **W5-141 (Phase 4.9.D):** mode- and locale-aware printer.
///
/// - `mode == A1`: emits canonical A1 source text (existing behavior,
///   matches today's `print()` exactly when `locale == EnUs`).
/// - `mode == R1C1`: emits canonical R1C1 source text. Absolute axes
///   emit as `R<n>` / `C<n>` (1-indexed source form). Relative axes
///   require `site`: emits `R[<offset>]` / `C[<offset>]`, OR bare
///   `R` / `C` when offset == 0 (Excel R1C1 canon).
/// - `site == None` + `mode == R1C1` + any relative ref →
///   `Err(PrintError::R1C1RequiresAnchor)`.
///
/// **Locale**: parameter is accepted today for signature stability
/// per design § 4.3; locale-aware decimal / separators on the print
/// side ship in 4.9.F.
pub fn print_with(
    expr: &Expr,
    mode: ReferenceMode,
    locale: Locale,
    site: Option<FormulaSite>,
) -> Result<String, PrintError> {
    let ctx = PrintCtx { mode, locale, site };
    let mut out = String::new();
    print_expr_ctx(expr, &ctx, &mut out, 0)?;
    Ok(out)
}

/// Convert a 0-indexed column number to Excel letters (A, B, ..., Z, AA, AB, ...).
fn column_index_to_letters(mut col: u32) -> String {
    let mut letters = String::new();
    // Excel column letters are base-26 with A=1 (not base-26 with A=0). The conversion:
    // 0 → A, 25 → Z, 26 → AA, 27 → AB, ..., 701 → ZZ, 702 → AAA.
    loop {
        let digit = (col % 26) as u8;
        letters.insert(0, (b'A' + digit) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    letters
}

/// **W5-141 (Phase 4.9.D):** emit a `CellAddr` in either A1 or R1C1
/// form, driven by `ctx.mode`. The sheet prefix is mode-agnostic
/// (same `Sheet1!` glyph in both modes per Excel canon).
fn print_cell_addr_ctx(
    addr: &CellAddr,
    ctx: &PrintCtx,
    out: &mut String,
) -> Result<(), PrintError> {
    print_sheet_prefix(&addr.sheet, out);
    match ctx.mode {
        ReferenceMode::A1 => {
            if addr.abs_col {
                out.push('$');
            }
            out.push_str(&column_index_to_letters(addr.col));
            if addr.abs_row {
                out.push('$');
            }
            out.push_str(&(addr.row + 1).to_string());
            Ok(())
        }
        ReferenceMode::R1C1 => {
            // Emit `R<row-axis>C<col-axis>`. Row first; col second.
            // For each axis, abs → 1-indexed integer; rel → bracketed
            // signed offset from anchor (or bare letter if offset = 0).
            emit_r1c1_axis(
                addr.abs_row,
                addr.row,
                ctx.site.map(|s| s.cell.row),
                'R',
                out,
            )?;
            emit_r1c1_axis(
                addr.abs_col,
                addr.col,
                ctx.site.map(|s| s.cell.col),
                'C',
                out,
            )?;
            Ok(())
        }
    }
}

/// **W5-141 (Phase 4.9.D):** emit one R1C1 axis of an absolute-form
/// `CellAddr`. `is_abs` selects between absolute (`R<n>`) and relative
/// (`R[<offset>]` or bare `R`); `anchor` is needed for the relative
/// path, and missing-anchor surfaces `PrintError::R1C1RequiresAnchor`.
fn emit_r1c1_axis(
    is_abs: bool,
    coord: u32,
    anchor: Option<u32>,
    letter: char,
    out: &mut String,
) -> Result<(), PrintError> {
    if is_abs {
        out.push(letter);
        // 1-indexed source form. `coord` is `u32` with documented
        // max `MAX_ROW` / `MAX_COLUMN`, so `coord + 1` cannot overflow
        // (max is 1_048_576 / 16_384 — well below u32::MAX).
        out.push_str(&(coord + 1).to_string());
        return Ok(());
    }
    // Relative form: needs an anchor.
    let Some(anchor) = anchor else {
        return Err(PrintError::R1C1RequiresAnchor);
    };
    // `coord - anchor` may be negative; compute in i64 to avoid wrap.
    // Both operands fit easily in i64 (max ≈ 1M), so this can't
    // overflow under any well-formed CellAddr.
    let offset = coord as i64 - anchor as i64;
    out.push(letter);
    if offset != 0 {
        out.push('[');
        out.push_str(&offset.to_string());
        out.push(']');
    }
    // offset == 0 → bare letter (Excel canon: `R[0]C[0]` and `RC` are
    // semantically identical; canonical form is `RC`).
    Ok(())
}

/// **W5-141 (Phase 4.9.D):** emit one R1C1 axis from an `AxisSpec`
/// (used when the AST carries `Expr::R1C1Ref` / `RangeRef::R1C1Cells`
/// directly, i.e. parser-intermediate forms that bypass the
/// post-bind absolute-CellRef shape).
///
/// - `AxisSpec::Abs(n)` → `R<n>` / `C<n>` (n is already 1-indexed
///   in the AST per the lexer's spec).
/// - `AxisSpec::Rel(offset)` → `R[<offset>]` / `C[<offset>]`, or
///   bare `R` / `C` when `offset == 0`.

 succeeded in 267ms:
//! `Workbook` — top-level container; holds the sheet list + the name table.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `sheets: Vec<Sheet>` indexed by `SheetId` (u16).
//! - `names: NameTable` — workbook-level defined names. Phase 2A.1 (2026-05-12)
//!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
//!   binder in `ql-exec` resolves names against this table at bind time.
//!   Sheet-scope names land Phase 3+ with `ql-formula-semantics`.

use std::collections::HashMap;
use std::sync::Arc;

use ql_types::{Address, ColId, ErrorValue, Range, RowId, SheetId, Value};

use crate::sheet::Sheet;

/// What a defined name resolves to.
///
/// Per codex r13 N9 + opus arch F5: the prior `lookup -> Option<Address>` couldn't represent
/// the common Excel defined-name targets (range, constant, formula). The shape was a wrong
/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
///
/// Phase 0 shipped all variants for forward compatibility. Phase 2A.1 (2026-05-12)
/// added real storage for `Cell` and `Constant` variants; the `Range` and `Formula`
/// variants are still resolution-deferred (the binder returns
/// `BindError::UnsupportedVariant` for them — Phase 2B+ aggregate-context wiring
/// closes that gap).
#[derive(Clone, Debug, PartialEq)]
pub enum NamedTarget {
    /// Named single cell (`SalesRow1 = $A$1`).
    Cell(Address),
    /// Named range (`Sales = $A$2:$A$1000`).
    Range(Range),
    /// Named constant (`TaxRate = 0.21`).
    Constant(Value),
    /// Named formula (`Profit = Revenue - Costs`). Stored as the raw formula source; the
    /// binder re-parses + evaluates in the use-site context. Phase 3+ feature.
    Formula(std::sync::Arc<str>),
}

/// Defined-names table.
///
/// Phase 2A.1 (2026-05-12): real workbook-scope storage. Phase 2A.6 audit fix
/// (H2/M6/D5): canonicalization is enforced at the **insert** boundary — `set`
/// uppercases the key on write, so every entry lives at its canonical
/// upper-case form. `lookup` is case-sensitive on canonical form (fast path for
/// the parser, which already canonicalizes); `lookup_ci` exists as a
/// belt-and-suspenders entry point for callers that bypass the parser
/// canonicalization. Sheet-scope names (Excel's `Sheet1!Local`) are deferred to
/// Phase 3+ ql-formula-semantics.
///
/// ## Generation counter (Phase 2B.3)
///
/// `generation` is bumped on every successful `set` / `clear`. Bind-plan
/// caches in `ql-exec` key cached plans by `(formula_text, sheet,
/// generation)` so a name registration / rename invalidates affected plans
/// without an explicit cache-flush call — the next lookup just misses.
#[derive(Clone, Debug, Default)]
pub struct NameTable {
    entries: HashMap<Arc<str>, NamedTarget>,
    /// Monotonic counter bumped on every successful mutation. See struct
    /// docs for the cache-invalidation contract. Wraps at u64::MAX (4×10^18
    /// mutations — not a realistic concern).
    generation: u64,
}

/// Errors emitted by `NameTable::set` when a registration is refused.
///
/// Phase 2A.9 audit M6 (2026-05-12): closes the AI() reservation hole. The
/// previous `NameTable::set` returned `()` and silently accepted any name,
/// including ones reserved by the engine. A user calling
/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
/// the CORR-06 AI sentinel because `=AI` (no parens) goes through the binder's
/// NameRef path instead of the function-call path. Now the registration
/// itself is refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum NameTableError {
    /// The name is reserved by the engine. Per CORR-06: `AI`. Future
impl NameTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a name → target binding. The key is uppercased before insertion
    /// so the table always stores entries in canonical Excel case.
    ///
    /// Phase 2A.6 audit M6/D5 added the on-write canonicalization (was: stored
    /// as-is, creating a disagreement with `lookup` that uppercased queries).
    ///
    /// Phase 2A.9 audit M6 added the reserved-name guard. Names returned `true`
    /// from `is_reserved_name` (currently just `AI` per CORR-06) are refused
    /// with `NameTableError::Reserved`. The return type is now `Result` —
    /// callers that previously expected `()` need to handle the error or
    /// `.expect(...)` it.
    pub fn set(
        &mut self,
        name: impl AsRef<str>,
        target: NamedTarget,
    ) -> Result<(), NameTableError> {
        let upper: Arc<str> = Arc::from(name.as_ref().to_ascii_uppercase().as_str());
        if is_reserved_name(&upper) {
            return Err(NameTableError::Reserved(upper));
        }
        // **W5-D-PM12-2 megaudit Opus-A HIGH-4 — DEFERRED.**
        // Initial closure attempted to reject cell-ref-shaped names
        // (`K`, `XFC`, `A1`) at the producer, but existing tests
        // (env.rs:530+, 555, 592 etc.) intentionally register
        // single-letter names like `R` and the binder resolves them
        // correctly when used in non-product context. The Opus-A
        // failure case is `K*A1` where the binder treats `K` as a
        // column→range and `A1` as a cell → `RangeRef × CellRef`
        // which the AggregateArg gate rejects. The root cause is
        // shared with HIGH-1 (literal RangeRef in non-Function
        // context). Closing HIGH-1 likely closes HIGH-4 too.
        // Deferred until HIGH-1 lands or a separate
        // name-precedence-over-column-letter binder pass.
        self.entries.insert(upper, target);
        self.generation = self.generation.wrapping_add(1);
        Ok(())
    }

    /// Remove a name binding. Uppercases the query so callers don't have to
    /// match the on-write canonicalization. Idempotent.
    pub fn clear(&mut self, name: &str) {
        let upper = name.to_ascii_uppercase();
        // Only bump generation if a binding was actually removed — idempotent
        // no-op clears don't invalidate any cache.
        if self.entries.remove(upper.as_str()).is_some() {
            self.generation = self.generation.wrapping_add(1);
        }
    }

    /// Phase 2B.3 (2026-05-12): monotonic generation counter, bumped on every
    /// successful `set` / `clear`. Bind-plan caches in `ql-exec` key cached
    /// plans by `(formula_text, sheet, generation)` so a name mutation
    /// invalidates affected plans on next lookup without an explicit flush.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Phase 2B.7 audit H3 (2026-05-12): pre-check whether `set(name, _)`
    /// would succeed without doing the mutation. Lets the `ql-exec`
    /// `WorkbookRuntime::set_name` wrapper run validate-then-append-then-
    /// mutate so a reserved-name rejection doesn't leave the workbook
    /// either (a) modified with no op log entry, or (b) un-modified but
    /// with an orphan op log entry.
    ///
    /// Returns `Ok(())` if a future `set(name, _)` will succeed,
    /// `Err(NameTableError::Reserved(...))` otherwise. Pure: no
    /// mutation, no generation bump.
    pub fn would_accept(&self, name: &str) -> Result<(), NameTableError> {
        let upper: Arc<str> = Arc::from(name.to_ascii_uppercase().as_str());
        if is_reserved_name(&upper) {
            return Err(NameTableError::Reserved(upper));
        }
        Ok(())
    }

    /// Look up a name. Case-sensitive on the canonical-uppercase form — used
    /// by the parser-internal path where the query is already canonicalized.
    /// External callers should prefer `lookup_ci` unless they've already
    /// uppercased the query.
    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
        self.entries.get(name).cloned()
    }

    /// Case-insensitive lookup: uppercases the query before searching.
    /// Phase 2A.6 audit H2: the `NameLookup for NameTable` impl uses this so
    /// the binder is robust against future callers who forget to canonicalize.
    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
        let upper = name.to_ascii_uppercase();
        self.entries.get(upper.as_str()).cloned()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Iterate all `(name, target)` bindings. Order is HashMap-arbitrary.
    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
        self.entries.iter()
    }
}

/// Top-level Quantbook container.
///
/// Phase 1 W5-9 adds `formula_cells`: a HashMap keyed by `(sheet, row, col)` mapping
/// formula-bearing cells to their formula source text (e.g. `"A1 + B1"`). The cell's
/// EVALUATED result still lives in the Sheet's columnar storage as a Value; this map
/// records that the value was *produced by a formula* (so it can be recomputed and so

 succeeded in 270ms:
//! The `Op` enum — the engine's mutation vocabulary for the op log.
//!
//! Phase 2A.3.a (2026-05-12): minimum producer set covering everything
//! `WorkbookRuntime` and `WorkbookTransaction` can mutate through their
//! public API. Future variants (sheet renames, sheet deletes, formatting
//! changes) land alongside the API additions that produce them.
//!
//! Each variant mirrors a `Workbook` mutation method one-to-one:
//!
//! | `Op` variant       | Replays to                                       |
//! |--------------------|--------------------------------------------------|
//! | `PutValue`         | `Workbook::put_at`                               |
//! | `PutFormula`       | `Workbook::put_formula`                          |
//! | `ClearFormula`     | `Workbook::clear_formula`                        |
//! | `SetName`          | `Workbook::set_name`                             |
//! | `AddSheet`         | `Workbook::add_sheet_with_chunk_rows`            |
//! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
//! | `SetCellFormat`    | `CellFormatOverlay::set` / `::clear` (W5-80)     |
//! | `BatchCommit`      | (recursive — applies each inner op in order)     |
//!
//! ## Wire format choices
//!
//! - `Arc<str>` is NOT used in wire fields. `serde` without the `rc`
//!   feature can't deserialize `Arc<str>` directly. We store `String` on
//!   the wire and convert at the replay boundary. Cleaner separation: the
//!   wire format owns its strings; the runtime types share via Arc once
//!   inside the workbook.
//! - `ValueWire` and `NamedTargetWire` are reused from
//!   `ql_io::qbook_format` (Phase 2A.8 shipped them). Sharing the
//!   serialization vocabulary across the engine's three persistence
//!   surfaces (qbook envelope, qbook JSONL, op log) prevents wire-format
//!   drift.

use serde::{Deserialize, Serialize};

use crate::wire::{CellWireValue, NamedTargetWire};
use ql_types::{ColId, RowId, SheetId};

/// A mutation operation recordable in the op log.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
#[non_exhaustive]
pub enum Op {
    /// Single literal cell write. Mirrors `WorkbookRuntime::set_value`.
    PutValue {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: CellWireValue,
    },

    /// Single formula write (text only — replay re-evaluates via the
    /// caller's `WorkbookRuntime::recompute_all`, not via replay itself).
    /// Mirrors `WorkbookRuntime::set_formula` for the persistence side.
    PutFormula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        text: String,
    },

    /// Remove formula association at a cell (cell becomes literal-only).
    /// Mirrors `Workbook::clear_formula`.
    ClearFormula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
    },

    /// Register a defined name. Mirrors `Workbook::set_name` when
    /// `scope` is `None`, and `Sheet::set_scoped_name` when `scope` is
    /// `Some(sheet_id)`. **W5-92 (Phase 4.6.D)** added the optional
    /// `scope` field per design doc § 8.2 / Codex MEDIUM-4: a single
    /// op variant covers both scopes rather than two separate ops.
    ///
    /// Wire compat: `#[serde(default, skip_serializing_if = "Option::is_none")]`
    /// keeps v3+old ops deserializing unchanged (missing field → `None`
    /// = workbook scope, the historical behavior). Sheet-scoped names
    /// emit the field; workbook-scoped names omit it.
    ///
    /// Replay: routes to `Workbook::set_name` (scope `None`) or
    /// `Sheet::set_scoped_name` (scope `Some`); reserved-name refusal
    /// surfaces as `ReplayError::NameRejected` in either path. A
    /// `scope: Some(id)` referencing an unknown sheet surfaces as
    /// `ReplayError::InvalidSheet`.
    SetName {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<SheetId>,
        name: String,
        target: NamedTargetWire,
    },

    /// Create a new sheet. Mirrors `Workbook::add_sheet_with_chunk_rows`.
    /// Sheet IDs are deterministic (the workbook assigns them in append
    /// order); the producer doesn't pin the ID in the op, since replay
    /// against an empty workbook produces the same sequence.
    AddSheet { name: String, chunk_rows: u32 },

    /// **W5-91 (Phase 4.6.C):** rename an existing sheet by id. Mirrors
    /// `Workbook::rename_sheet`. Per design doc § 3.1, the producer-side
    /// runtime rewrites all stored formula text BEFORE emitting this op
    /// (and emits `Op::PutFormula` ops for each rewritten cell in the
    /// same `BatchCommit`), so replay-on-top-of-snapshot OR replay-from-
    /// empty both produce correct state.
    ///
    /// **Phase 5.3 step 2 audit closure (Codex MEDIUM-2, 2026-05-20):**
    /// `old_name` is now ADVISORY at replay time, not validated. Pre-
    /// step-2 the replay handler rejected ops whose `old_name` didn't
    /// match the current sheet name (`SheetRenameNameMismatch`); under
    /// CRDT merge of concurrent renames the second op's `old_name`
    /// legitimately fails to match, so the validation was wrong. Post-
    /// step-2 the replay handler unconditionally renames the sheet at
    /// `id` to `new_name` (with D-2-style auto-disambiguation on
    /// duplicate targets). `old_name` is retained on the wire for:
    ///   - diagnostics in `ReplayError::SheetRenameRejected.old_name`
    ///   - producer-side single-writer log debuggability (the op records
    ///     what the producer's local state was at write time)
    ///   - future re-introduction of strict-mode replay if needed
    ///
    /// **Trade-off**: single-writer malformed logs (`old="Wrong",
    /// new="X"` against current "S") now silently rename "S" → "X"
    /// rather than erroring. The CRDT use case requires this; we
    /// accept the single-writer trade-off because the producer-side
    /// `WorkbookRuntime::rename_sheet` validates locally before
    /// emitting, so a malformed op indicates corruption or a custom
    /// op-log producer that bypassed the runtime.
    RenameSheet {
        id: SheetId,
        old_name: String,
        new_name: String,
    },

    /// Register a format string at a specific id. Mirrors
    /// `FormatTable::register_at`. Emitted when
    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
    /// on replay (re-registering an existing id with the same string
    /// is a no-op). Re-registering at the same id with a DIFFERENT
    /// string fails at `FormatTable::register_at` and surfaces as
    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
    ///
    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from `u32`
    /// to [`crate::wire::FormatIdWire`] (tagged tuple `Builtin(u32)` /
    /// `Custom(PeerId, u32)`). The `from_u32_legacy` migration helper
    /// converts pre-5.2 saves to the new shape at envelope-load time
    /// (step 5).
    RegisterFormat {
        id: crate::wire::FormatIdWire,
        string: String,
    },

    /// Set or clear a cell's format id. Mirrors
    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
    /// (when `id` is `None`). The id MUST resolve in the workbook's
    /// `FormatTable` at replay time; an unknown id surfaces as
    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
    ///
    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from
    /// `Option<u32>` to `Option<FormatIdWire>`.
    SetCellFormat {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        /// `None` ⇒ clear the overlay entry (cell falls back to General).
        /// `Some(id)` ⇒ bind the cell to that format id.
        id: Option<crate::wire::FormatIdWire>,
    },

    /// One transaction's ops applied atomically at replay time. Produced
    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
    /// inner op in order; on failure, replay reports the inner op's
    /// index relative to the BatchCommit's parent index. No implicit
    /// rollback at replay (commits are committed).
    ///
    /// Nested BatchCommits are permitted by the schema but produced
    /// nowhere in production; replay handles them via recursion.
    BatchCommit { ops: Vec<Op> },

    /// **W5-118 (Phase 4.8.H):** create a workbook-scoped table.
    /// Mirrors `WorkbookRuntime::create_table`. Replay inserts the
    /// table into `Workbook::tables_mut()` after validating the same
    /// invariants as the producer-side (non-overlapping footprint,
    /// non-empty unique column names, table-name uniqueness against
    /// both `TableTable` and `NameTable`).
    ///
    /// Column ids are NOT serialized — replay allocates fresh ids from
    /// the workbook's `next_column_id` counter, matching producer-side
    /// allocation order (deterministic if the op log is replayed in
    /// order).
    CreateTable {
        name: String,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    },

    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
    /// the table footprint are untouched. Formulas referencing the
    /// dropped table re-bind to `BindError::UnknownTable` on next
    /// recompute. Mirrors `WorkbookRuntime::drop_table`.
    DropTable { name: String },

    /// **W5-119 (Phase 4.8.I):** rename a table.
    ///
    /// Producer side ALSO rewrites stored formula text (Excel canon —
    /// per design § 12.2). The op carries `old_name` so replay can
    /// re-key the `TableTable` entry; producer-side formula-text
    /// rewrites land as accompanying `Op::PutFormula` entries in the
    /// same op-log sequence (no `BatchCommit` wrapper today; relies on
    /// replay-order determinism).
    ///
    /// Replay validates: target name available (NameTable + TableTable),
    /// source name exists. Sheet-scoped names use the workbook's
    /// shared canonical namespace.
    RenameTable { old_name: String, new_name: String },

    /// **W5-121 (Phase 4.8.I.2):** rename a single column within a table.
    ///
    /// Producer side ALSO rewrites stored formula text in every cell
    /// referencing the renamed column (Excel canon — same semantic as
    /// `RenameTable`). The op carries `table` (canonical uppercase) so
    /// replay can locate the table; `old_name` and `new_name` are case-
    /// preserving identifiers (replay matches `old_name` case-
    /// insensitively against `TableColumn::name`, which is stored
    /// lowercase-canonical). Producer-side formula-text rewrites land as
    /// accompanying `Op::PutFormula` entries in the same op-log sequence.
    ///
    /// Replay validates: target table exists, source column exists,
    /// target column name available within the table (case-insensitive).
    /// Same-canonical rename is rejected at producer side (returns
    /// `Ok(0)` no-op without emitting); replay treats receipt of a
    /// same-canonical op as a divergence and rejects.
    RenameColumn {
        table: String,
        old_name: String,
        new_name: String,
    },

    /// **W5-122 (Phase 4.8.J):** resize a table's footprint.
    ///
    /// Three scenarios (per design § 12.3):
    /// - Grow/shrink rows: change `new_rows`; `added_columns` and
    ///   `removed_columns` both empty.
    /// - Append column(s) at the END: list each in `added_columns`.
    /// - Truncate trailing column(s): list each in `removed_columns`
    ///   in current left-to-right order.
    ///
    /// Inserting / removing a column in the MIDDLE is NOT supported in
    /// 4.8 (Phase 5 structural edits — requires physical cell move).
    ///
    /// **Arithmetic invariant**: `new_cols == old_cols +
    /// added_columns.len() - removed_columns.len()`. Producer + replay
    /// both validate.
    ///
    /// **Column ids are NOT serialized** (same pattern as `CreateTable`)
    /// — replay allocates fresh ids from the workbook's
    /// `next_column_id` counter for each entry in `added_columns`,
    /// matching producer-side allocation order.
    ///
    /// Replay validates: target table exists; arithmetic matches;
    /// `removed_columns` exactly match trailing columns case-
    /// insensitively; final column roster has unique canonical names;
    /// new footprint cells outside the old footprint don't overlap
    /// other tables.
    ResizeTable {
        name: String,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    },

    /// **W5-146 (Phase 4.9.J):** workbook-scope reference-mode change.
    /// Serialized as a string `"A1"` or `"R1C1"`. The runtime appends
    /// this op via `WorkbookRuntime::set_reference_mode`; replay calls
    /// `Workbook::set_reference_mode(mode)` (a pure metadata update —
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    /// underlying Loro doc.
    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
        list.push(LoroValue::from(json.as_str()))?;
        self.doc.commit();
        Ok(())
    }

    /// Iterate the log in append order. Each yielded item is a
    /// `Result<Op, OpLogError>` — a deserialization failure yields
    /// `Err(OpLogError::Deserialize { index, source })` and iteration
    /// continues (no short-circuit). Callers wanting fail-fast can use
    /// `iter().collect::<Result<Vec<_>, _>>()`.
    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
        let len = list.len();
        (0..len).map(move |index| {
            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
                "ops LoroList lost an entry between len() and get()",
            ))?;
            let value = match entry {
                ValueOrContainer::Value(v) => v,
                ValueOrContainer::Container(_) => {
                    return Err(OpLogError::SchemaMismatch(
                        "ops LoroList holds a container; expected JSON-string values",
                    ));
                }
            };
            let s = match value {
                LoroValue::String(s) => s,
                _ => {
                    return Err(OpLogError::SchemaMismatch(
                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
                    ));
                }
            };
            serde_json::from_str::<Op>(&s)
                .map_err(|source| OpLogError::Deserialize { index, source })
        })
    }

    /// Number of ops currently visible in the `"ops"` LoroList.
    ///
    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
    /// (was a cached `usize` field through 5.6). Codex 5.4 V1 audit
    /// HIGH found the cache became stale after `loro::UndoManager`
    /// retracted ops from the visible list. Returning Loro's
    /// authoritative count is correct by construction; per-call
    /// cost is one container handle lookup + a length read.
    pub fn len(&self) -> usize {
        self.doc.get_list(OPS_CONTAINER).len()
    }

    /// True iff `len() == 0`.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
    ///
    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
    /// to wire its stable `PeerId` through to Loro so concurrent

 succeeded in 277ms:
crates/ql-formula-syntax/src/parser.rs:492:            // only emitted via `try_lex_sheet_name_prefix` /
crates/ql-formula-syntax/src/parser.rs:493:            // `lex_quoted_sheet_name`), so reaching this arm means the
crates/ql-formula-syntax/src/parser.rs:869:                sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:890:                        sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:912:                        sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:930:                        sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:951:                        sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:972:                sheet: SheetRef::Name(name),
crates/ql-formula-syntax/src/parser.rs:1009:        (SheetRef::Name(n), SheetRef::Current) => Ok(SheetRef::Name(n.clone())),
crates/ql-formula-syntax/src/parser.rs:1011:        (SheetRef::Current, SheetRef::Name(_) | SheetRef::Id(_)) => {
crates/ql-formula-syntax/src/parser.rs:1014:        (SheetRef::Name(a), SheetRef::Name(b)) => {
crates/ql-formula-syntax/src/parser.rs:1016:                Ok(SheetRef::Name(a.clone()))
crates/ql-formula-syntax/src/parser.rs:2175:    fn parse_sheet_qualified_cellref_unquoted() {
crates/ql-formula-syntax/src/parser.rs:2179:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2188:    fn parse_sheet_qualified_cellref_quoted() {
crates/ql-formula-syntax/src/parser.rs:2192:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Q3 2025")));
crates/ql-formula-syntax/src/parser.rs:2201:    fn parse_sheet_qualified_quoted_with_escape() {
crates/ql-formula-syntax/src/parser.rs:2205:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Ben's Sheet")));
crates/ql-formula-syntax/src/parser.rs:2224:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2238:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2251:                assert!(matches!(sheet, SheetRef::Name(_)));
crates/ql-formula-syntax/src/parser.rs:2262:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2273:                assert_eq!(sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2309:                        assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet2")));
crates/ql-formula-syntax/src/parser.rs:2329:                        assert_eq!(sheet, &SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2356:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Sheet1")));
crates/ql-formula-syntax/src/parser.rs:2365:    fn parse_dotted_sheet_name() {
crates/ql-formula-syntax/src/parser.rs:2369:                assert_eq!(addr.sheet, SheetRef::Name(Arc::from("Data.2024")));
crates/ql-formula-syntax/src/parser.rs:3081:    /// with `SheetRef::Name("Sheet1")`.
crates/ql-formula-syntax/src/parser.rs:3091:                    SheetRef::Name(n) => assert_eq!(n.as_ref(), "Sheet1"),
crates/ql-formula-syntax/src/parser.rs:3092:                    other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/parser.rs:3108:                SheetRef::Name(n) => assert_eq!(n.as_ref(), "Sheet1"),
crates/ql-formula-syntax/src/parser.rs:3109:                other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/parser.rs:3306:                    SheetRef::Name(n) => assert_eq!(n.as_ref(), "Sheet1"),
crates/ql-formula-syntax/src/parser.rs:3307:                    other => panic!("expected SheetRef::Name on inner, got {other:?}"),
crates/ql-formula-syntax/src/lexer.rs:57:    /// **W5-88 (Phase 4.6.A part 2):** a `'...'`-style quoted sheet name
crates/ql-formula-syntax/src/lexer.rs:59:    #[error("unterminated quoted sheet name")]
crates/ql-formula-syntax/src/lexer.rs:63:    /// followed by `!`. Bare quoted strings have no other lexical role
crates/ql-formula-syntax/src/lexer.rs:65:    #[error("quoted string not followed by '!' — only valid as a sheet-name prefix")]
crates/ql-formula-syntax/src/lexer.rs:328:            // **W5-88 (Phase 4.6.A part 2):** quoted sheet name `'...'`.
crates/ql-formula-syntax/src/lexer.rs:333:                lex_quoted_sheet_name(&mut chars, &mut out)?;
crates/ql-formula-syntax/src/lexer.rs:335:            // **W5-88 (Phase 4.6.A part 2):** unquoted sheet-name prefix
crates/ql-formula-syntax/src/lexer.rs:341:            'A'..='Z' | 'a'..='z' | '_' if try_lex_sheet_name_prefix(&mut chars, &mut out)? => {
crates/ql-formula-syntax/src/lexer.rs:342:                // Token(s) emitted by try_lex_sheet_name_prefix when it
crates/ql-formula-syntax/src/lexer.rs:929:/// Scan an unquoted sheet-name candidate at `chars` and peek ahead for
crates/ql-formula-syntax/src/lexer.rs:943:fn try_lex_sheet_name_prefix(
crates/ql-formula-syntax/src/lexer.rs:1156:/// Lex a quoted-sheet-name prefix `'...'!`. The caller has just peeked
crates/ql-formula-syntax/src/lexer.rs:1161:fn lex_quoted_sheet_name(
crates/ql-formula-syntax/src/lexer.rs:2299:    fn unquoted_sheet_prefix_emits_sheet_name_bang_then_cellref() {
crates/ql-formula-syntax/src/lexer.rs:2311:    fn unquoted_sheet_prefix_with_range() {
crates/ql-formula-syntax/src/lexer.rs:2372:    fn dotted_sheet_name_supported() {
crates/ql-formula-syntax/src/lexer.rs:2393:    fn quoted_sheet_name_with_space() {
crates/ql-formula-syntax/src/lexer.rs:2404:    fn quoted_sheet_name_with_escaped_quote() {
crates/ql-formula-syntax/src/lexer.rs:2405:        // Excel canon: `''` inside a quoted sheet name decodes to a single `'`.
crates/ql-formula-syntax/src/lexer.rs:2414:    fn unterminated_quoted_sheet_name_errors() {
crates/ql-formula-syntax/src/lexer.rs:2422:    fn dangling_quoted_string_without_bang_errors() {
crates/ql-formula-syntax/src/lexer.rs:2424:        // Excel formulas — distinct error from a quoted sheet name.
crates/ql-formula-syntax/src/lexer.rs:2432:    fn quoted_sheet_with_whitespace_before_bang() {
crates/ql-formula-syntax/src/lexer.rs:2467:    fn quoted_string_after_quote_uses_quoted_sheet_name_path() {
crates/ql-formula-syntax/src/lexer.rs:2468:        // Lexer's `'` arm is dedicated to quoted sheet names. A bare
crates/ql-formula-syntax/src/ast.rs:123:    /// `apply_sheet_to_term` rewrites to `SheetRef::Name` when a
crates/ql-formula-syntax/src/ast.rs:245:    /// `SheetRef::Name`: that variant is parser-only, and any post-
crates/ql-formula-syntax/src/ast.rs:253:            SheetRef::Name(name) => panic!(
crates/ql-formula-syntax/src/ast.rs:254:                "unresolved SheetRef::Name({name:?}) at a layer that requires \
crates/ql-formula-syntax/src/ast.rs:268:            SheetRef::Name(_) => None,
crates/ql-formula-syntax/src/ast.rs:273:/// **W5-91 (Phase 4.6.C):** recursively rewrite every `SheetRef::Name`
crates/ql-formula-syntax/src/ast.rs:275:/// `old_canonical` to `SheetRef::Name(new_name)`. Used by
crates/ql-formula-syntax/src/ast.rs:282:pub fn rewrite_sheet_name_in_expr(expr: &Expr, old_canonical: &str, new_name: &Arc<str>) -> Expr {
crates/ql-formula-syntax/src/ast.rs:299:            lhs: Box::new(rewrite_sheet_name_in_expr(lhs, old_canonical, new_name)),
crates/ql-formula-syntax/src/ast.rs:300:            rhs: Box::new(rewrite_sheet_name_in_expr(rhs, old_canonical, new_name)),
crates/ql-formula-syntax/src/ast.rs:304:            operand: Box::new(rewrite_sheet_name_in_expr(operand, old_canonical, new_name)),
crates/ql-formula-syntax/src/ast.rs:310:                .map(|a| rewrite_sheet_name_in_expr(a, old_canonical, new_name))
crates/ql-formula-syntax/src/ast.rs:317:                        .map(|cell| rewrite_sheet_name_in_expr(cell, old_canonical, new_name))
crates/ql-formula-syntax/src/ast.rs:322:        Expr::Spill(inner) => Expr::Spill(Box::new(rewrite_sheet_name_in_expr(
crates/ql-formula-syntax/src/ast.rs:349:            rewrite_sheet_name_in_expr(inner, old_canonical, new_name),
crates/ql-formula-syntax/src/ast.rs:356:/// Mirrors [`rewrite_sheet_name_in_expr`] in spirit but for tables.
crates/ql-formula-syntax/src/ast.rs:611:        SheetRef::Name(n) if n.eq_ignore_ascii_case(old_canonical) => {
crates/ql-formula-syntax/src/ast.rs:612:            SheetRef::Name(new_name.clone())
crates/ql-formula-syntax/src/ast.rs:688:/// `SheetRef::Name(name)` until the binder resolves to `SheetRef::Id`.
crates/ql-formula-syntax/src/ast.rs:929:    // W5-91 (Phase 4.6.C) — rewrite_sheet_name_in_expr coverage.
crates/ql-formula-syntax/src/ast.rs:942:    fn rewrite_renames_matching_cellref_sheet_name() {
crates/ql-formula-syntax/src/ast.rs:943:        let expr = cell(SheetRef::Name(Arc::from("OldSheet")), 0, 0);
crates/ql-formula-syntax/src/ast.rs:945:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
crates/ql-formula-syntax/src/ast.rs:948:                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
crates/ql-formula-syntax/src/ast.rs:949:                other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/ast.rs:960:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
crates/ql-formula-syntax/src/ast.rs:966:        let out_id = rewrite_sheet_name_in_expr(&expr_id, "OLD", &new_name);
crates/ql-formula-syntax/src/ast.rs:972:        let expr = cell(SheetRef::Name(Arc::from("Other")), 0, 0);
crates/ql-formula-syntax/src/ast.rs:974:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
crates/ql-formula-syntax/src/ast.rs:980:        let lhs = cell(SheetRef::Name(Arc::from("Old")), 0, 0);
crates/ql-formula-syntax/src/ast.rs:981:        let rhs_inner = cell(SheetRef::Name(Arc::from("Old")), 1, 0);
crates/ql-formula-syntax/src/ast.rs:991:        let out = rewrite_sheet_name_in_expr(&expr, "OLD", &new_name);
crates/ql-formula-syntax/src/ast.rs:996:                        SheetRef::Name(n) => assert_eq!(&*n, "Renamed"),
crates/ql-formula-syntax/src/ast.rs:997:                        other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/ast.rs:1004:                            SheetRef::Name(n) => assert_eq!(&**n, "Renamed"),
crates/ql-formula-syntax/src/ast.rs:1005:                            other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/ast.rs:1019:            sheet: SheetRef::Name(Arc::from("OldSheet")),
crates/ql-formula-syntax/src/ast.rs:1030:        let out = rewrite_sheet_name_in_expr(&rng, "OLDSHEET", &new_name);
crates/ql-formula-syntax/src/ast.rs:1033:                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
crates/ql-formula-syntax/src/ast.rs:1034:                other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/ast.rs:1043:        let expr = cell(SheetRef::Name(Arc::from("oldsheet")), 0, 0);
crates/ql-formula-syntax/src/ast.rs:1045:        let out = rewrite_sheet_name_in_expr(&expr, "OLDSHEET", &new_name);
crates/ql-formula-syntax/src/ast.rs:1048:                SheetRef::Name(n) => assert_eq!(&*n, "NewSheet"),
crates/ql-formula-syntax/src/ast.rs:1049:                other => panic!("expected SheetRef::Name, got {other:?}"),
crates/ql-formula-syntax/src/printer.rs:101:pub fn print(expr: &Expr) -> String {
crates/ql-formula-syntax/src/printer.rs:122:pub fn print_with(
crates/ql-formula-syntax/src/printer.rs:317:/// - `SheetRef::Name(_)` — the parser's output for a sheet-qualified
crates/ql-formula-syntax/src/printer.rs:330:/// The current `rewrite_sheet_name_in_expr` path walks pre-bind
crates/ql-formula-syntax/src/printer.rs:336:        SheetRef::Name(name) => {
crates/ql-formula-syntax/src/printer.rs:337:            print_sheet_name(name, out);
crates/ql-formula-syntax/src/printer.rs:357:fn print_sheet_name(name: &str, out: &mut String) {
crates/ql-formula-syntax/src/printer.rs:616:fn print_expr_ctx(
crates/ql-formula-syntax/src/printer.rs:1306:    fn print_unquoted_sheet_prefix_cellref() {
crates/ql-formula-syntax/src/printer.rs:1311:    fn print_dotted_sheet_name_unquoted() {
crates/ql-formula-syntax/src/printer.rs:1316:    fn print_quoted_sheet_name_with_space() {
crates/ql-formula-syntax/src/printer.rs:1321:    fn print_quoted_sheet_name_with_escape() {
crates/ql-formula-syntax/src/printer.rs:1364:    fn print_sheet_name_with_special_char_is_quoted() {
crates/ql-formula-syntax/src/printer.rs:1370:            sheet: SheetRef::Name(Arc::from("Sales-Q1")),
crates/ql-formula-syntax/src/printer.rs:1380:    fn print_sheet_name_starting_with_digit_is_quoted() {
crates/ql-formula-syntax/src/printer.rs:1382:            sheet: SheetRef::Name(Arc::from("2024")),
crates/ql-formula-syntax/src/lib.rs:47:    rewrite_column_ref, rewrite_sheet_name_in_expr, rewrite_table_ref, CellAddr, Expr, RangeRef,
crates/ql-formula-syntax/src/token.rs:113:    /// **W5-88 (Phase 4.6.A part 2):** unquoted sheet name preceding `!`.
crates/ql-formula-syntax/src/token.rs:121:    /// **W5-88 (Phase 4.6.A part 2):** quoted sheet name `'...'` with

exec
/bin/zsh -lc "sed -n '310,370p' crates/ql-formula-syntax/src/printer.rs && sed -n '604,618p' crates/ql-formula-syntax/src/ast.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '930,990p' crates/ql-formula-syntax/src/lexer.rs && sed -n '1156,1215p' crates/ql-formula-syntax/src/lexer.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"fn recompute_all|recompute_all\\(|clear_computed|put_at\\(|clear_user|formula_count|iter_formulas\" crates/ql-exec/src crates/ql-storage/src -g'*.rs' | head -200" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 254ms:
/// `!`. If a `Sheet!` prefix is recognized, emit `SheetName + Bang` and
/// return `Ok(true)`. If not (the leading run is actually an Ident /
/// CellRef / etc.), leave `chars` untouched and return `Ok(false)` —
/// the caller falls through to the existing dispatch.
///
/// Multi-char lookahead via `Chars::clone()`: cheap (just a `&str` +
/// cursor) and doesn't disturb the real iterator.
///
/// Per design doc § 4.1: name shape `[A-Za-z_][A-Za-z0-9_.]*`. Per
/// § 4.3 / Codex MEDIUM-1: this routine MUST run before the A1/
/// function/name classifier so `A1!B1` lexes sheet `A1`, not cell
/// `A1`. Edge cases (whitespace around `!`, dotted names, etc.) are
/// pinned in the test corpus.
fn try_lex_sheet_name_prefix(
    chars: &mut Peekable<Chars>,
    out: &mut Vec<Token>,
) -> Result<bool, LexError> {
    // Peek into a clone to scan the candidate name + lookahead.
    let mut peek = chars.clone();
    let mut name = String::new();

    // First char: `[A-Za-z_]` (caller's match arm already verified).
    let first = peek.next().expect("caller guaranteed at least one char");
    debug_assert!(first.is_ascii_alphabetic() || first == '_');
    name.push(first);

    // Trailing chars: `[A-Za-z0-9_.]`.
    while let Some(&c) = peek.peek() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            name.push(c);
            peek.next();
        } else {
            break;
        }
    }

    // Skip whitespace between name and `!` per design § 4.3.
    while let Some(&c) = peek.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            peek.next();
        } else {
            break;
        }
    }

    // Decision: is the next char `!`?
    let is_sheet_prefix = peek.peek() == Some(&'!');
    if !is_sheet_prefix {
        // Not a sheet prefix — leave `chars` untouched; caller falls
        // through to the existing identifier dispatch.
        return Ok(false);
    }

    // Commit: consume from the real `chars` iterator to match what we
    // scanned in the clone, then emit SheetName + Bang.
    for _ in 0..name.chars().count() {
        chars.next();
    }
    // Skip whitespace between name and `!`.
    while let Some(&c) = chars.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
/// Lex a quoted-sheet-name prefix `'...'!`. The caller has just peeked
/// the opening `'`. The body allows any char except `'`; `''` decodes
/// to a single `'`. After the closing `'`, whitespace is skipped and
/// `!` is required — bare `'...'` without `!` produces
/// `LexError::DanglingQuotedString`.
fn lex_quoted_sheet_name(
    chars: &mut Peekable<Chars>,
    out: &mut Vec<Token>,
) -> Result<(), LexError> {
    // Consume opening quote.
    chars.next();
    let mut name = String::new();
    loop {
        match chars.next() {
            None => return Err(LexError::UnterminatedQuotedSheetName),
            Some('\'') => {
                // `''` is the embedded-quote escape; otherwise this is
                // the closing quote.
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    name.push('\'');
                } else {
                    break;
                }
            }
            Some(c) => name.push(c),
        }
    }
    // Skip whitespace before required `!`.
    while let Some(&c) = chars.peek() {
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            chars.next();
        } else {
            break;
        }
    }
    if chars.peek() != Some(&'!') {
        return Err(LexError::DanglingQuotedString);
    }
    chars.next();

    out.push(Token::QuotedSheetName(Arc::from(name)));
    out.push(Token::Bang);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex_ok(s: &str) -> Vec<Token> {
        lex(s).unwrap_or_else(|e| panic!("lex({s:?}) failed: {e}"))
    }

    // -- whitespace + empty ----------------------------------------------------

    #[test]
    fn empty_input_yields_empty_tokens() {
        assert_eq!(lex_ok(""), vec![]);
    }

 succeeded in 257ms:
}

/// **W5-89 (Phase 4.6.A part 3):** emit `Sheet!` or `'Sheet name'!`
/// prefix for non-`Current` sheet refs.
///
/// **Contract:** `print` is pre-bind-only. The expected inputs are:
/// - `SheetRef::Current` — no prefix.
/// - `SheetRef::Name(_)` — the parser's output for a sheet-qualified
///   ref; emits `Sheet!` or `'Sheet name'!`.
///
/// `SheetRef::Id(_)` would require resolving the id back to a name,
/// which means threading workbook context through the printer. That
/// resolver-aware variant is a Phase 4.6.E follow-up polish item
/// tracked in `docs/known-gaps.md` (GAP-X-01). Until then, calling
/// `print` on a post-bind AST is a programmer error and panics with
/// the specific id so the call site is obvious.
///
/// **W5-93 (Phase 4.6.E closure):** Codex MEDIUM and Sonnet MEDIUM
/// converged on this finding. Closure stance: keep the panic (no-
/// fallbacks rule), improve the message, document the contract.
/// The current `rewrite_sheet_name_in_expr` path walks pre-bind
/// ASTs only, so the panic isn't reachable through any production
/// code path today.
fn print_sheet_prefix(sheet: &SheetRef, out: &mut String) {
    match sheet {
        SheetRef::Current => {}
        SheetRef::Name(name) => {
            print_sheet_name(name, out);
            out.push('!');
        }
        SheetRef::Id(id) => panic!(
            "ql_formula_syntax::print: SheetRef::Id({id}) reached the printer, \
             but print() is pre-bind-only by contract (see fn doc comment). \
             The bound id has no associated name string at the AST level; a \
             resolver-aware print_with_resolver(expr, &workbook) API is \
             tracked as Phase 4.6.E follow-up. If you're trying to round-trip \
             a bound expression, re-parse from text instead — the binder \
             does NOT round-trip back through the printer."
        ),
    }
}

/// **W5-89 (Phase 4.6.A part 3):** emit a sheet name in its canonical
/// source form. Quotes the name if it contains any character outside
/// `[A-Za-z0-9_.]`, starts with a digit (would lex as a number/row),
/// or is empty (defensive — empty names are rejected at registry time
/// anyway). Embedded `'` is escaped as `''`.
fn print_sheet_name(name: &str, out: &mut String) {
    let needs_quoting = name.is_empty()
        || name.starts_with(|c: char| c.is_ascii_digit())
        || name
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'));
    if needs_quoting {
        out.push('\'');
        for c in name.chars() {
            if c == '\'' {
                out.push('\'');
                out.push('\'');
            } else {
                out.push(c);
            TableSpecItem::ColumnRange(nc1, nc2)
        }
    }
}

fn rewrite_sheet_ref(sheet: &SheetRef, old_canonical: &str, new_name: &Arc<str>) -> SheetRef {
    match sheet {
        SheetRef::Name(n) if n.eq_ignore_ascii_case(old_canonical) => {
            SheetRef::Name(new_name.clone())
        }
        other => other.clone(),
    }
}

fn rewrite_range_ref(r: &RangeRef, old_canonical: &str, new_name: &Arc<str>) -> RangeRef {

 succeeded in 241ms:
crates/ql-storage/src/sheet.rs:224:    pub fn clear_computed(&mut self, row: RowId, col: ColId) {
crates/ql-storage/src/sheet.rs:226:            c.clear_computed(row);
crates/ql-storage/src/sheet.rs:234:    pub fn clear_user(&mut self, row: RowId, col: ColId) {
crates/ql-storage/src/sheet.rs:236:            c.clear_user(row);
crates/ql-exec/src/loader.rs:10://! 3. `let _ = rt.recompute_all();`
crates/ql-exec/src/loader.rs:63:        runtime.recompute_all()
crates/ql-exec/src/loader.rs:92:        wb.put_at(s, 0, 0, Value::Number(10.0));
crates/ql-exec/src/loader.rs:100:        wb.put_at(s, 0, 0, Value::Number(100.0));
crates/ql-exec/src/loader.rs:120:        wb.put_at(s, 0, 0, Value::Number(42.0));
crates/ql-exec/src/loader.rs:121:        wb.put_at(s, 0, 1, Value::text("hello"));
crates/ql-exec/src/loader.rs:161:        wb.put_at(s, 0, 0, Value::Number(7.0));
crates/ql-exec/src/loader.rs:170:        wb.put_at(s, 0, 0, Value::Number(5.0));
crates/ql-exec/src/loader.rs:241:        wb.put_at(s, 0, 0, Value::Number(42.0));
crates/ql-storage/src/column.rs:24://! - `clear_computed(row)` — drop the computed entry. Called by `clear_formula` (the
crates/ql-storage/src/column.rs:252:    pub fn clear_computed(&mut self, row: RowId) {
crates/ql-storage/src/column.rs:263:    pub fn clear_user(&mut self, row: RowId) {
crates/ql-storage/src/column.rs:842:    /// `clear_computed` removes the computed entry without touching user.
crates/ql-storage/src/column.rs:844:    fn clear_computed_drops_only_computed_lane() {
crates/ql-storage/src/column.rs:848:        c.clear_computed(2);
crates/ql-exec/src/calcgraph_session.rs:877:            .iter_formulas()
crates/ql-exec/src/calcgraph_session.rs:1769:            wb.put_at(*sheet, *row, *col, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:1945:            wb.put_at(0, r, 0, Value::Number(r as f64));
crates/ql-exec/src/calcgraph_session.rs:1960:        wb.put_at(0, 0, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:1991:            wb.put_at(0, r, 0, Value::Number(r as f64));
crates/ql-exec/src/calcgraph_session.rs:2004:        wb.put_at(0, 0, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2005:        wb.put_at(0, 1, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2115:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/calcgraph_session.rs:2127:        wb.put_at(0, 0, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2211:            wb.put_at(0, r, 0, Value::Number((r + 1) as f64));
crates/ql-exec/src/calcgraph_session.rs:2224:        wb.put_at(0, 0, 1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2225:        wb.put_at(0, 0, 2, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2334:        wb.put_at(0, formula_cell.0, formula_cell.1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2442:        wb.put_at(0, 0, 10, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2443:        wb.put_at(0, 1, 10, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2444:        wb.put_at(0, 2, 10, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2524:        wb.put_at(0, 0, 1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2556:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/calcgraph_session.rs:2557:        wb.put_at(0, 0, 1, Value::Number(2.0));
crates/ql-exec/src/calcgraph_session.rs:2558:        wb.put_at(0, 0, 2, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2599:        wb.put_at(0, 0, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2600:        wb.put_at(0, 1, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2601:        wb.put_at(0, 2, 5, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2628:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/calcgraph_session.rs:2629:        wb.put_at(0, 0, 1, Value::Number(2.0));
crates/ql-exec/src/calcgraph_session.rs:2630:        wb.put_at(0, 0, 2, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:2631:        wb.put_at(0, 0, 3, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3490:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/calcgraph_session.rs:3491:        wb.put_at(0, 0, 1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3492:        wb.put_at(0, 0, 2, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3546:        wb.put_at(0, 0, 0, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3547:        wb.put_at(0, 0, 1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3548:        wb.put_at(0, 0, 3, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3612:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/calcgraph_session.rs:3613:        wb.put_at(0, 0, 1, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3614:        wb.put_at(0, 0, 2, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3618:        wb.put_at(0, 0, 4, Value::Blank);
crates/ql-exec/src/calcgraph_session.rs:3619:        wb.put_at(0, 0, 25, Value::Number(7.0));
crates/ql-storage/src/workbook.rs:752:                    sheet.clear_computed(arow + dr, acol + dc);
crates/ql-storage/src/workbook.rs:816:    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
crates/ql-storage/src/workbook.rs:828:    /// "formula", the caller (the runtime) MUST first call `clear_user_at` so the
crates/ql-storage/src/workbook.rs:843:    pub fn clear_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-storage/src/workbook.rs:845:            s.clear_computed(row, col);
crates/ql-storage/src/workbook.rs:853:    pub fn clear_user_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
crates/ql-storage/src/workbook.rs:855:            s.clear_user(row, col);
crates/ql-storage/src/workbook.rs:916:        self.clear_computed_at(sheet, row, col);
crates/ql-storage/src/workbook.rs:925:    pub fn formula_count(&self) -> usize {
crates/ql-storage/src/workbook.rs:931:    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
crates/ql-storage/src/workbook.rs:974:        wb.put_at(s0, 0, 0, Value::Number(1.0));
crates/ql-storage/src/workbook.rs:975:        wb.put_at(s1, 0, 0, Value::Number(99.0));
crates/ql-storage/src/workbook.rs:986:        wb.put_at(a, 5, 3, Value::Number(50.0));
crates/ql-storage/src/workbook.rs:1052:        wb.put_at(5, 0, 0, Value::Number(1.0));
crates/ql-storage/src/workbook.rs:1107:            wb.put_at(s, r as u32, 0, v);
crates/ql-storage/src/workbook.rs:1128:        assert_eq!(wb.formula_count(), 0);
crates/ql-storage/src/workbook.rs:1137:        assert_eq!(wb.formula_count(), 1);
crates/ql-storage/src/workbook.rs:1148:        assert_eq!(wb.formula_count(), 0);
crates/ql-storage/src/workbook.rs:1158:        assert_eq!(wb.formula_count(), 0);
crates/ql-storage/src/workbook.rs:1167:        assert_eq!(wb.formula_count(), 1);
crates/ql-storage/src/workbook.rs:1172:    fn iter_formulas_yields_all() {
crates/ql-storage/src/workbook.rs:1179:            .iter_formulas()
crates/ql-storage/src/workbook.rs:1199:        wb.put_at(s, 0, 0, Value::Number(42.0));
crates/ql-storage/src/workbook.rs:1562:        wb.put_at(0, 1, 0, Value::Number(99.0));
crates/ql-storage/src/spill.rs:44://! `Sheet::clear_computed` calls because the workbook owns sheet
crates/ql-exec/src/transaction.rs:353:                    workbook.put_at(*sheet, *row, *col, value.clone());
crates/ql-exec/src/transaction.rs:368:                    workbook.clear_user_at(*sheet, *row, *col);
crates/ql-exec/src/transaction.rs:536:        wb.put_at(0, 0, 0, Value::Number(5.0));
crates/ql-exec/src/transaction.rs:931:        wb.put_at(0, 0, 0, Value::Number(5.0));
crates/ql-exec/src/transaction.rs:1011:        wb.put_at(0, 0, 0, Value::Number(50.0));
crates/ql-exec/src/workbook_runtime/names.rs:287:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/names.rs:305:        wb.put_at(0, 0, 0, Value::Number(42.0));
crates/ql-exec/src/workbook_runtime/names.rs:458:    fn recompute_all_resolves_named_constant() {
crates/ql-exec/src/workbook_runtime/names.rs:465:        wb.put_at(0, 0, 0, Value::Number(0.0));
crates/ql-exec/src/workbook_runtime/names.rs:470:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/sheets.rs:172:        for (sheet, row, col, text) in self.workbook.iter_formulas() {
crates/ql-exec/src/workbook_runtime/sheets.rs:245:        wb.put_at(s1, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/sheets.rs:250:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/sheets.rs:274:        wb.put_at(s1, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/sheets.rs:322:        wb.put_at(s1, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/sheets.rs:327:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/validate.rs:144:        wb.put_at(0, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/validate.rs:209:        wb.put_at(0, 0, 0, Value::Number(2.0));
crates/ql-exec/src/workbook_runtime/validate.rs:372:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/workbook_runtime/validate.rs:373:        wb.put_at(0, 1, 0, Value::Number(2.0));
crates/ql-exec/src/workbook_runtime/validate.rs:374:        wb.put_at(0, 2, 0, Value::Number(3.0));
crates/ql-exec/src/workbook_runtime/validate.rs:395:            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
crates/ql-exec/src/workbook_runtime/validate.rs:439:            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
crates/ql-exec/src/workbook_runtime/validate.rs:440:            wb.put_at(0, i as u32, 1, Value::Number(((i + 1) * 2) as f64));
crates/ql-exec/src/workbook_runtime/validate.rs:492:            wb.put_at(0, i as u32, 0, Value::Number((i + 1) as f64));
crates/ql-exec/src/workbook_runtime/validate.rs:493:            wb.put_at(0, i as u32, 1, Value::Number((i + 1) as f64));
crates/ql-exec/src/workbook_runtime/validate.rs:619:        wb.put_at(0, 0, 0, Value::Number(1.0));
crates/ql-exec/src/workbook_runtime/validate.rs:625:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/tables.rs:318:            .iter_formulas()
crates/ql-exec/src/workbook_runtime/tables.rs:462:            .iter_formulas()
crates/ql-exec/src/workbook_runtime/tables.rs:1131:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/tables.rs:1300:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/tables.rs:1386:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/tables.rs:1637:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/tables.rs:1747:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/formats.rs:368:        wb.put_at(s, 0, 0, Value::Number(42.0));
crates/ql-exec/src/workbook_runtime/formats.rs:380:        wb.put_at(s, 0, 0, Value::Number(45477.0));
crates/ql-exec/src/workbook_runtime/formats.rs:394:        wb.put_at(s, 0, 0, Value::Number(1234.5));
crates/ql-exec/src/workbook_runtime/formats.rs:412:        wb.put_at(s, 0, 0, Value::Number(42.0));
crates/ql-exec/src/workbook_runtime/formats.rs:413:        wb.put_at(s, 0, 1, Value::Number(7.5));
crates/ql-exec/src/workbook_runtime/formats.rs:429:        wb.put_at(s, 0, 0, Value::Error(ErrorValue::DivZero));
crates/ql-exec/src/workbook_runtime/formats.rs:444:        wb.put_at(s, 0, 0, Value::text("hello"));
crates/ql-exec/src/workbook_runtime/cells.rs:290:                self.workbook.clear_user_at(sheet, row, col);
crates/ql-exec/src/workbook_runtime/cells.rs:730:        self.workbook.clear_user_at(sheet, row, col);
crates/ql-exec/src/workbook_runtime/cells.rs:760:        self.workbook.clear_user_at(sheet, row, col);
crates/ql-exec/src/workbook_runtime/cells.rs:864:        self.workbook.put_at(sheet, row, col, value);
crates/ql-exec/src/workbook_runtime/cells.rs:1070:            self.workbook.put_at(sheet, row, col, current_value);
crates/ql-exec/src/workbook_runtime/cells.rs:1155:        wb.put_at(0, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1167:        wb.put_at(0, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1168:        wb.put_at(0, 1, 0, Value::Number(20.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1169:        wb.put_at(0, 2, 0, Value::Number(30.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1523:        wb.put_at(0, 0, 0, Value::Number(5.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1538:        wb.put_at(0, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/cells.rs:1676:    fn recompute_all_does_not_emit_ops() {
crates/ql-exec/src/workbook_runtime/cells.rs:1693:            let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:1955:            assert!(rt.recompute_all().is_complete());
crates/ql-exec/src/workbook_runtime/cells.rs:2002:        wb.put_at(s, 0, 0, Value::Number(45477.0)); // 2024-07-04
crates/ql-exec/src/workbook_runtime/cells.rs:2006:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:2017:        wb.put_at(s, 0, 0, Value::Number(1234.5));
crates/ql-exec/src/workbook_runtime/cells.rs:2021:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:2036:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:2051:        wb.put_at(s2, 0, 0, Value::Number(41.0));
crates/ql-exec/src/workbook_runtime/cells.rs:2055:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:2074:        wb.put_at(s2, 0, 0, Value::Number(7.0));
crates/ql-exec/src/workbook_runtime/cells.rs:2078:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:2110:        wb.put_at(s1, 0, 0, Value::Number(10.0)); // S1!A1 = 10
crates/ql-exec/src/workbook_runtime/cells.rs:2115:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3140:    fn recompute_all_materializes_spill_for_array_formula() {
crates/ql-exec/src/workbook_runtime/cells.rs:3150:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3172:    fn recompute_all_scalar_formula_unchanged() {
crates/ql-exec/src/workbook_runtime/cells.rs:3174:        wb.put_at(0, 0, 0, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/cells.rs:3178:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3192:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
crates/ql-exec/src/workbook_runtime/cells.rs:3198:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3214:    fn recompute_all_array_formula_idempotent_across_two_passes() {
crates/ql-exec/src/workbook_runtime/cells.rs:3219:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3220:        rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:3459:    fn recompute_all_materializes_sequence_spill() {
crates/ql-exec/src/workbook_runtime/cells.rs:3464:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:4729:        let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/cells.rs:5181:        wb.put_at(0, 0, 0, ql_types::Value::Number(7.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:61:    pub fn recompute_all(&mut self) -> RecomputeResult {
crates/ql-exec/src/workbook_runtime/recompute.rs:114:                .iter_formulas()
crates/ql-exec/src/workbook_runtime/recompute.rs:146:            .iter_formulas()
crates/ql-exec/src/workbook_runtime/recompute.rs:877:    fn recompute_all_on_empty_workbook_is_noop() {
crates/ql-exec/src/workbook_runtime/recompute.rs:882:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:889:    fn recompute_all_refreshes_formula_values() {
crates/ql-exec/src/workbook_runtime/recompute.rs:893:        wb.put_at(0, 0, 0, Value::Number(5.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:894:        wb.put_at(0, 0, 1, Value::Number(10.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:898:        wb.put_at(0, 0, 0, Value::Number(100.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:907:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:920:    fn recompute_all_handles_multiple_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:922:        wb.put_at(0, 0, 0, Value::Number(2.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:925:        wb.put_at(0, 1, 0, Value::Number(0.0)); // stale
crates/ql-exec/src/workbook_runtime/recompute.rs:927:        wb.put_at(0, 2, 0, Value::Number(0.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:929:        wb.put_at(0, 3, 0, Value::Number(0.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:934:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:961:        wb.put_at(s, 0, 0, Value::Number(7.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:989:        loaded.put_at(s, 0, 0, Value::Number(100.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:998:        let result = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1014:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1020:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1022:            let _ = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1040:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1047:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1070:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1073:        wb.put_at(0, 0, 0, Value::Number(5.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:1078:            let r = rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1098:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1105:                rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1123:    fn recompute_all_dependent_of_cycle_propagates_circ_error() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1130:        wb.put_at(0, 0, 0, Value::Number(42.0));
crates/ql-exec/src/workbook_runtime/recompute.rs:1135:            rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1156:    fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1162:            rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1193:            rt.recompute_all();
crates/ql-exec/src/workbook_runtime/recompute.rs:1227:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
crates/ql-exec/src/workbook_runtime/recompute.rs:1237:        let result = rt.recompute_all();

exec
/bin/zsh -lc "sed -n '55,175p' crates/ql-exec/src/workbook_runtime/recompute.rs && sed -n '800,845p' crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '875,940p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1340,1388p' crates/ql-formula-syntax/src/printer.rs && sed -n '2390,2440p' crates/ql-formula-syntax/src/lexer.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 261ms:

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

    #[test]
    fn recompute_all_refreshes_formula_values() {
        let mut wb = make_runtime_workbook();

        // Set up scenario: A1 = 5; B1 has formula =A1 * 2 evaluated as 10.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_at(0, 0, 1, Value::Number(10.0));
        wb.put_formula(0, 0, 1, "A1 * 2");

        // Change A1 to 100 (simulating a user edit that didn't auto-recompute).
        wb.put_at(0, 0, 0, Value::Number(100.0));
        // B1 still shows 10 (stale).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(10.0)
        );

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.attempted, 1);
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());

        // B1 now shows 200 (refreshed).
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(200.0)
        );
    }

    #[test]
    fn recompute_all_handles_multiple_formulas() {
        let mut wb = make_runtime_workbook();
        wb.put_at(0, 0, 0, Value::Number(2.0));

        // Add 3 formula cells all referring to A1.
        wb.put_at(0, 1, 0, Value::Number(0.0)); // stale
        wb.put_formula(0, 1, 0, "A1 + 1");
        wb.put_at(0, 2, 0, Value::Number(0.0));
        wb.put_formula(0, 2, 0, "A1 * 10");
        wb.put_at(0, 3, 0, Value::Number(0.0));
        wb.put_formula(0, 3, 0, "A1 - 100");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 3);
        assert!(result.is_complete());

        assert_eq!(wb.read(ql_types::Address::new(0, 1, 0)), Value::Number(3.0));
        assert_eq!(
            wb.read(ql_types::Address::new(0, 2, 0)),

 succeeded in 258ms:
    #[test]
    fn print_redundant_explicit_form_normalizes_to_single_prefix() {
        // `Sheet1!A1:Sheet1!B2` parses + normalizes; print emits single-prefix form.
        let e = parse(lex("Sheet1!A1:Sheet1!B2").expect("lex")).expect("parse");
        assert_eq!(print(&e), "Sheet1!A1:B2");
    }

    #[test]
    fn print_sheet_prefix_in_binary_expression() {
        // Printer adds canonical spaces around binary operators.
        round_trip("Sheet2!A1+1", "Sheet2!A1 + 1");
    }

    #[test]
    fn print_sheet_prefix_in_function_arg() {
        round_trip("SUM(Sheet1!A1:A10)", "SUM(Sheet1!A1:A10)");
    }

    #[test]
    fn print_sheet_prefix_preserves_absolute_markers() {
        round_trip("Sheet1!$A$1", "Sheet1!$A$1");
    }

    #[test]
    fn print_sheet_name_with_special_char_is_quoted() {
        // A sheet name containing `-` would normally need quoting because `-`
        // is not in `[A-Za-z0-9_.]`. Tested via direct AST construction
        // (the parser/lexer wouldn't produce this without quoting at the
        // source).
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("Sales-Q1")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'Sales-Q1'!A1");
    }

    #[test]
    fn print_sheet_name_starting_with_digit_is_quoted() {
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("2024")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'2024'!A1");
    }

    #[test]
    fn quoted_sheet_name_with_space() {
        let toks = lex_ok("'Q3 2025'!A1");
        assert_eq!(toks.len(), 3);
        match &toks[0] {
            Token::QuotedSheetName(n) => assert_eq!(n.as_ref(), "Q3 2025"),
            other => panic!("expected QuotedSheetName, got {other:?}"),
        }
        assert_eq!(toks[1], Token::Bang);
    }

    #[test]
    fn quoted_sheet_name_with_escaped_quote() {
        // Excel canon: `''` inside a quoted sheet name decodes to a single `'`.
        let toks = lex_ok("'Ben''s Sheet'!A1");
        match &toks[0] {
            Token::QuotedSheetName(n) => assert_eq!(n.as_ref(), "Ben's Sheet"),
            other => panic!("expected QuotedSheetName, got {other:?}"),
        }
    }

    #[test]
    fn unterminated_quoted_sheet_name_errors() {
        match lex("'unterminated") {
            Err(LexError::UnterminatedQuotedSheetName) => {}
            other => panic!("expected UnterminatedQuotedSheetName, got {other:?}"),
        }
    }

    #[test]
    fn dangling_quoted_string_without_bang_errors() {
        // A `'...'` block without a trailing `!` has no other role in
        // Excel formulas — distinct error from a quoted sheet name.
        match lex("'no bang'") {
            Err(LexError::DanglingQuotedString) => {}
            other => panic!("expected DanglingQuotedString, got {other:?}"),
        }
    }

    #[test]
    fn quoted_sheet_with_whitespace_before_bang() {
        let toks = lex_ok("'Sheet One'  !  A1");
        assert!(matches!(toks[0], Token::QuotedSheetName(_)));
        assert_eq!(toks[1], Token::Bang);
        assert!(matches!(toks[2], Token::CellRef { .. }));
    }

    #[test]
    fn double_sheet_qualifier_lexes_but_parser_will_reject() {

 succeeded in 262ms:
    /// Cells that fail structurally (lex/parse/bind) keep their
    /// pre-recompute values and formula text. Cells that succeed have
    /// their value replaced. Cells whose evaluation produces an Excel-
    /// canon error value (`#DIV/0!`, `#VALUE!`, etc.) are counted as
    /// succeeded — those error values are normal cell contents per
    /// Excel canon, not structural failures.
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
                    // mirror `recompute_dirty`'s table-bind-error
                    // mapping so the recompute_all path (used by
                    // replay + headless callers) also honors
            ),
        }
    }

    /// Convenience: write a literal row,col,value tuple without constructing an Address.
    /// Phase 3.5: this is the USER-edit path — routes to `Sheet::put` →
    /// `ColumnStore::put` which writes the user overlay AND clears any stale computed
    /// entry at the same cell.
    ///
    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log AND the
    /// runtime's bind-plan cache; does NOT clear any pre-existing formula
    /// at the cell (use `clear_formula` separately if needed). Product code
    /// should route through `ql_exec::WorkbookRuntime::set_value`, which
    /// records `Op::PutValue` + an optional `Op::ClearFormula`. Direct
    /// `put_at` is for the qbook loader, the op-log replay path, runtime-
    /// internal pass 2 of formula recompute, and tests. GAP-O-03.
    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        self.put(Address::new(sheet, row, col), value);
    }

    /// **Phase 3.5 (2026-05-12) — CORR-25.** Write a FORMULA-OUTPUT value at
    /// `(sheet, row, col)`. Routes to the computed-overlay lane (NOT the user lane).
    /// Used by `WorkbookRuntime::set_formula` (with the freshly-evaluated result of
    /// the formula text) and by `recompute_all` / `recompute_dirty` for every
    /// formula cell in their pass.
    ///
    /// Panics if `sheet` is out of bounds — same contract as `put_at`. Does NOT touch
    /// the user overlay; if a cell is transitioning from "user-typed value" to
    /// "formula", the caller (the runtime) MUST first call `clear_user_at` so the
    /// stale user value doesn't mask the new computed value via the read cascade.
    pub fn put_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
        let total = self.sheet_count();
        match self.sheet_mut(sheet) {
            Some(s) => s.put_computed(row, col, value),
            None => {
                panic!("Workbook::put_computed_at: sheet {sheet} does not exist (have {total})")
            }
        }
    }

    /// **Phase 3.5.** Drop the computed-overlay entry at `(sheet, row, col)`. No-op if
    /// the cell has no computed entry or the sheet is out of bounds. Called by
    /// `clear_formula` (the formula text is gone → its output is stale).
    pub fn clear_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
        if let Some(s) = self.sheet_mut(sheet) {
            s.clear_computed(row, col);

 succeeded in 49783ms:
   Compiling ql-collab v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 22.52s
     Running tests/repair_renames.rs (target/debug/deps/repair_renames-d49d1897e5645d2f)

running 10 tests
test repair_converges_across_merge_directions ... ok
test repair_handles_rename_back_intermediate_reference ... ok
test repair_handles_step2_auto_disambiguation_suffix ... ok
test repair_handles_transitive_chain_to_final_name ... ok
test repair_is_idempotent ... ok
test repair_leaves_unrelated_formulas_unchanged ... ok
test repair_report_carries_diagnostic_information ... ok
test repair_rewrites_concurrent_formula_referencing_old_name ... ok
test repair_walks_batchcommit_nested_renames ... ok
test repair_with_no_renames_is_noop ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s


exec
/bin/zsh -lc "sed -n '135,230p' crates/ql-exec/src/workbook_runtime/recompute.rs && sed -n '230,330p' crates/ql-exec/src/workbook_runtime/recompute.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"try_recompute_one_cached|BindError|UnknownSheet|ErrorValue::Name|put_computed_at\" crates/ql-exec/src/workbook_runtime/recompute.rs crates/ql-exec/src -g'*.rs' | head -120" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 239ms:
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
                    // mirror `recompute_dirty`'s table-bind-error
                    // mapping so the recompute_all path (used by
                    // replay + headless callers) also honors
                    // design § 12.4 — dropped-table refs emit
                    // `#NAME?`, not a recompute failure with a
                    // stale cell value.
                    //
                    // **Phase 5.2 D-3 closure (2026-05-19):** also map
                    // `BindError::UnknownSheet` to `#NAME?`. Surfaces
                    // in Phase 5 multi-peer collaboration: peer A
                    // renames sheet `S → X`; peer B concurrently
                    // writes `=S!A1+1`; merged log → B's formula
                    // references the now-missing sheet `S`. Phase
                    // 5.1 audit (Codex V5) verified the pre-fix
                    // behavior was to leave the cell with its stale
                    // pre-recompute value AND emit a
                    // RecomputeFailure — worse than `#NAME?` from
                    // the user's perspective. This maps it cleanly.
                    if let RuntimeError::Bind(
                        BindError::UnknownTable(_)
                        | BindError::UnknownTableColumn { .. }
                        | BindError::UnknownSheet(_),
                    ) = &error
                    {
                        self.workbook.put_computed_at(
                            sheet,
                            row,
                            col,
                            Value::Error(ErrorValue::Name),
                        );
                        succeeded += 1;
                    } else {
                        failures.push(RecomputeFailure {
                            sheet,
                            row,
                            col,
                            formula_text,
                            error,
                        });
                    }
                }
            }
        }

        RecomputeResult {
            attempted,
            succeeded,
            failures,
            // Phase 3.8: `recompute_all` doesn't run the VEQ check —
            // it's the HashMap-order legacy path that always
            // re-evaluates everything. `recompute_dirty` is the path
            // that benefits from value-equality short-circuit.
            skipped_value_equality: 0,
            // Phase 3.9: SIMD-eligibility profile is recompute_dirty-
            // only. `recompute_all` is the legacy full-pass path.
            simd_classified: 0,
        }
    }
    }

    /// **Engine Phase 3.4 (2026-05-12) — W5-37 SCH-3-01..04 entry
    /// point.** Recompute only the formulas the attached
    /// [`CalcgraphSession`] has marked dirty since the last call.
    /// The scheduler runs iterative Tarjan SCC over the dirty
    /// subset; nodes in non-trivial SCCs (or with self-loops) are
    /// written as `Value::Error(ErrorValue::Circ)`. Everything else
    /// is evaluated in topological order via the existing PlanCache
    /// pipeline.
    ///
    /// Returns `None` when no `CalcgraphSession` is attached (the
    /// runtime was constructed via `new` or `with_oplog`); the
    /// dirty-set lives on the session, so we can't do incremental
    /// recompute without it. Callers in that mode should use
    /// `recompute_all` for a full HashMap-order pass instead.
    ///
    /// Returns `Some(RecomputeResult)` otherwise, matching the
    /// aggregation shape of `recompute_all`: per-cell failures
    /// (parse / bind issues that have somehow surfaced post-bind,
    /// e.g. a name was deleted between extract and recompute) are
    /// collected, the rest succeed.
    pub fn recompute_dirty(&mut self) -> Option<RecomputeResult> {
        // The session lives behind an `Option<&'a mut CalcgraphSession>`
        // — take it out for the duration of this call so we can borrow
        // both the workbook and the session simultaneously. Reattach
        // before returning.
        let mut session_slot = self.graph.take();
        let session = session_slot.as_deref_mut()?;

        // **W5-106 (Phase 4.7.M / task #136 closure)**: fixed-point
        // loop. Each iteration:
        //   1. claim + schedule the current dirty set.
        //   2. snapshot prior + originally_dirty for newly-seen nodes
        //      (carry across iterations so VEQ short-circuit still
        //      works on second-iter D1's that depend on iter-1
        //      formulas).
        //   3. evaluate cycled + sorted.
        //   4. if write_spill fired during the sorted loop, it called
        //      on_set_value at spill-footprint cells, adding to dirty.
        //   5. loop until session.dirty is empty.
        //
        // Bounded by `MAX_ITERATIONS` to prevent runaway in pathological
        // cases (a workbook configuration that would not terminate).
        // 100 is generous — any single set_value edit normally needs
        // ≤ 2 iterations (one for the initial dirty set, one for spill
        // shape-transition follow-ups).
        const MAX_ITERATIONS: usize = 100;
        let mut attempted: usize = 0;
        let mut succeeded = 0;
        let mut failures: Vec<RecomputeFailure> = Vec::new();
        let mut skipped_value_equality: usize = 0;
        // Phase 3.9 (W5-42): SIMD-eligibility profile. V1 observability
        // only.
        let mut simd_classified: usize = 0;

        // Phase 3.8 (W5-41, VEQ-3-01..03) — value-equality short-
        // circuit. State accumulates across fixed-point iterations:
        //   - `prior`: workbook value at each first-seen node, captured
        //     BEFORE that iteration's evaluation. Carries across iters
        //     so VEQ comparisons stay anchored to the pre-recompute
        //     value, not intermediate spill-write values.
        //   - `originally_dirty`: NodeIds claimed by ANY iteration's
        //     schedule. Used to distinguish "top-level dirty" from
        //     "downstream dirty" for the VEQ decision.
        //   - `changed`: addresses whose value differs from `prior`
        //     after any iteration's write. Built up across iters.
        use std::collections::{HashMap, HashSet};
        let mut prior: HashMap<(SheetId, RowId, ColId), Value> = HashMap::new();
        let mut originally_dirty: HashSet<ql_calcgraph::NodeId> = HashSet::new();
        let mut changed: HashSet<(SheetId, RowId, ColId)> = HashSet::new();
        // **Codex audit MEDIUM closure**: surface iteration-cap hits
        // instead of silently breaking. After the loop, if `iter_count`
        // reached MAX_ITERATIONS AND session.dirty() is still non-empty,
        // surface a synthetic failure so the caller's `is_complete()`
        // check (which inspects `failures.is_empty()`) signals the
        // problem.
        let mut iter_count: usize = 0;

        for _iter in 0..MAX_ITERATIONS {
            iter_count += 1;
            // Phase 3.4: claim dirty + topo-sort. Edges in the graph
            // model the dep direction (`outgoing(F) = what F depends on`).
            // Tarjan emits SCCs in reverse-topo of the condensation
            // which, for our edge orientation, is dependency-first order.
            let sched = session.schedule_dirty();
            if sched.total_count() == 0 {
                break; // Fixed point reached.
            }
            attempted += sched.total_count();

            // Snapshot prior + originally_dirty for newly-seen nodes.
            for n in sched.sorted.iter().chain(sched.cycled.iter()) {
                originally_dirty.insert(*n);
                if let Some(addr) = session.cell_address_for(*n) {
                    prior.entry(addr).or_insert_with(|| {
                        self.workbook
                            .read(ql_types::Address::new(addr.0, addr.1, addr.2))
                    });
                }
            }

 succeeded in 245ms:
crates/ql-exec/src/workbook_runtime/recompute.rs:17://! - `try_recompute_one_cached` (private) — lex+parse+bind+eval
crates/ql-exec/src/workbook_runtime/recompute.rs:33:use crate::plan::{bind_with_site, BindError, BindSite};
crates/ql-exec/src/workbook_runtime/recompute.rs:80:        // `try_recompute_one_cached`). Acceptable cost for the
crates/ql-exec/src/workbook_runtime/recompute.rs:140:                .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
crates/ql-exec/src/workbook_runtime/recompute.rs:164:            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
crates/ql-exec/src/workbook_runtime/recompute.rs:168:                    self.workbook.put_computed_at(sheet, row, col, value);
crates/ql-exec/src/workbook_runtime/recompute.rs:181:                    // `BindError::UnknownSheet` to `#NAME?`. Surfaces
crates/ql-exec/src/workbook_runtime/recompute.rs:192:                        BindError::UnknownTable(_)
crates/ql-exec/src/workbook_runtime/recompute.rs:193:                        | BindError::UnknownTableColumn { .. }
crates/ql-exec/src/workbook_runtime/recompute.rs:194:                        | BindError::UnknownSheet(_),
crates/ql-exec/src/workbook_runtime/recompute.rs:197:                        self.workbook.put_computed_at(
crates/ql-exec/src/workbook_runtime/recompute.rs:201:                            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/recompute.rs:344:                    self.workbook.put_computed_at(sheet, row, col, circ.clone());
crates/ql-exec/src/workbook_runtime/recompute.rs:445:                            self.workbook.put_computed_at(sheet, row, col, value);
crates/ql-exec/src/workbook_runtime/recompute.rs:581:                        // BindError::UnknownTable → emit #NAME?") and
crates/ql-exec/src/workbook_runtime/recompute.rs:595:                        // map `BindError::UnknownSheet` here. Mirror of
crates/ql-exec/src/workbook_runtime/recompute.rs:600:                            BindError::UnknownTable(_)
crates/ql-exec/src/workbook_runtime/recompute.rs:601:                            | BindError::UnknownTableColumn { .. }
crates/ql-exec/src/workbook_runtime/recompute.rs:602:                            | BindError::UnknownSheet(_),
crates/ql-exec/src/workbook_runtime/recompute.rs:605:                            let v = Value::Error(ErrorValue::Name);
crates/ql-exec/src/workbook_runtime/recompute.rs:610:                                self.workbook.put_computed_at(sheet, row, col, v);
crates/ql-exec/src/workbook_runtime/recompute.rs:670:    fn try_recompute_one_cached(
crates/ql-exec/src/workbook_runtime/recompute.rs:686:    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
crates/ql-exec/src/workbook_runtime/recompute.rs:827:        // `put_computed_at(anchor, anchor_value)` — a no-op duplicate
crates/ql-exec/src/workbook_runtime/recompute.rs:865:    use crate::plan::BindError;
crates/ql-exec/src/workbook_runtime/recompute.rs:1611:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1619:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1627:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1651:            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:3199:    // BindError::UnknownSheet → #NAME? mapping in recompute_all +
crates/ql-exec/src/workbook_runtime/recompute.rs:3251:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/recompute.rs:3302:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/calcgraph_session.rs:1117:    /// 2. Re-bind it (table is gone → `BindError::UnknownTable` →
crates/ql-exec/src/calcgraph_session.rs:1726:    use crate::plan::BindError;
crates/ql-exec/src/calcgraph_session.rs:2194:                RuntimeError::Bind(BindError::UnresolvedName(_))
crates/ql-exec/src/workbook_runtime/names.rs:157:    use crate::plan::BindError;
crates/ql-exec/src/workbook_runtime/names.rs:371:            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
crates/ql-exec/src/workbook_runtime/names.rs:382:    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
crates/ql-exec/src/workbook_runtime/names.rs:449:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
crates/ql-exec/src/workbook_runtime/tables.rs:13://!   surface a dropped-table BindError on next recompute of any
crates/ql-exec/src/workbook_runtime/tables.rs:205:    /// dropped table re-bind to `BindError::UnknownTable` on next
crates/ql-exec/src/workbook_runtime/tables.rs:217:    /// 3. Next recompute re-binds → `BindError::UnknownTable` →
crates/ql-exec/src/workbook_runtime/tables.rs:250:        // BindError::UnknownTable → emit #NAME?"). Matches the
crates/ql-exec/src/workbook_runtime/tables.rs:1248:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/tables.rs:1871:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/recompute.rs:17://! - `try_recompute_one_cached` (private) — lex+parse+bind+eval
crates/ql-exec/src/workbook_runtime/recompute.rs:33:use crate::plan::{bind_with_site, BindError, BindSite};
crates/ql-exec/src/workbook_runtime/recompute.rs:80:        // `try_recompute_one_cached`). Acceptable cost for the
crates/ql-exec/src/workbook_runtime/recompute.rs:140:                .put_computed_at(sheet, row, col, Value::Error(ErrorValue::Circ));
crates/ql-exec/src/workbook_runtime/recompute.rs:164:            match self.try_recompute_one_cached(sheet, row, col, &formula_text) {
crates/ql-exec/src/workbook_runtime/recompute.rs:168:                    self.workbook.put_computed_at(sheet, row, col, value);
crates/ql-exec/src/workbook_runtime/recompute.rs:181:                    // `BindError::UnknownSheet` to `#NAME?`. Surfaces
crates/ql-exec/src/workbook_runtime/recompute.rs:192:                        BindError::UnknownTable(_)
crates/ql-exec/src/workbook_runtime/recompute.rs:193:                        | BindError::UnknownTableColumn { .. }
crates/ql-exec/src/workbook_runtime/recompute.rs:194:                        | BindError::UnknownSheet(_),
crates/ql-exec/src/workbook_runtime/recompute.rs:197:                        self.workbook.put_computed_at(
crates/ql-exec/src/workbook_runtime/recompute.rs:201:                            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/recompute.rs:344:                    self.workbook.put_computed_at(sheet, row, col, circ.clone());
crates/ql-exec/src/workbook_runtime/recompute.rs:445:                            self.workbook.put_computed_at(sheet, row, col, value);
crates/ql-exec/src/workbook_runtime/recompute.rs:581:                        // BindError::UnknownTable → emit #NAME?") and
crates/ql-exec/src/workbook_runtime/recompute.rs:595:                        // map `BindError::UnknownSheet` here. Mirror of
crates/ql-exec/src/workbook_runtime/recompute.rs:600:                            BindError::UnknownTable(_)
crates/ql-exec/src/workbook_runtime/recompute.rs:601:                            | BindError::UnknownTableColumn { .. }
crates/ql-exec/src/workbook_runtime/recompute.rs:602:                            | BindError::UnknownSheet(_),
crates/ql-exec/src/workbook_runtime/recompute.rs:605:                            let v = Value::Error(ErrorValue::Name);
crates/ql-exec/src/workbook_runtime/recompute.rs:610:                                self.workbook.put_computed_at(sheet, row, col, v);
crates/ql-exec/src/workbook_runtime/recompute.rs:670:    fn try_recompute_one_cached(
crates/ql-exec/src/workbook_runtime/recompute.rs:686:    /// Phase 3.6 (W5-39): variant of `try_recompute_one_cached` that
crates/ql-exec/src/workbook_runtime/recompute.rs:827:        // `put_computed_at(anchor, anchor_value)` — a no-op duplicate
crates/ql-exec/src/workbook_runtime/recompute.rs:865:    use crate::plan::BindError;
crates/ql-exec/src/workbook_runtime/recompute.rs:1611:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1619:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1627:            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:1651:            Err(RuntimeError::Bind(BindError::NamedFormulaUnsupported(n))) => {
crates/ql-exec/src/workbook_runtime/recompute.rs:3199:    // BindError::UnknownSheet → #NAME? mapping in recompute_all +
crates/ql-exec/src/workbook_runtime/recompute.rs:3251:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/recompute.rs:3302:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/lib.rs:9://!   `BindError` variants including `UnresolvedName`,
crates/ql-exec/src/lib.rs:77://! (`BindError`, `RuntimeError`) and `SimdShape` carry
crates/ql-exec/src/lib.rs:134:    BindError, BindSite, ExprPlan, NameLookup, ResolvedName, SheetResolver, TableLookup,
crates/ql-exec/src/workbook_runtime/error.rs:21:use crate::plan::BindError;
crates/ql-exec/src/workbook_runtime/error.rs:32:    // Display now that LexError + BindError implement thiserror::Error with
crates/ql-exec/src/workbook_runtime/error.rs:54:    Bind(BindError),
crates/ql-exec/src/workbook_runtime/error.rs:195:impl From<BindError> for RuntimeError {
crates/ql-exec/src/workbook_runtime/error.rs:196:    fn from(e: BindError) -> Self {
crates/ql-exec/src/workbook_runtime/cells.rs:291:                self.workbook.put_computed_at(sheet, row, col, v.clone());
crates/ql-exec/src/workbook_runtime/cells.rs:607:    /// 4. Happy path: `register_spill` then `put_computed_at` for every
crates/ql-exec/src/workbook_runtime/cells.rs:734:                self.workbook.put_computed_at(sheet, row + dr, col + dc, v);
crates/ql-exec/src/workbook_runtime/cells.rs:761:        self.workbook.put_computed_at(sheet, row, col, err.clone());
crates/ql-exec/src/workbook_runtime/cells.rs:2095:            RuntimeError::Bind(crate::plan::BindError::UnknownSheet(name)) => {
crates/ql-exec/src/workbook_runtime/cells.rs:2098:            other => panic!("expected RuntimeError::Bind(UnknownSheet), got {other:?}"),
crates/ql-exec/src/workbook_runtime/cells.rs:4501:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/cells.rs:4538:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/workbook_runtime/cells.rs:4543:            Value::Error(ErrorValue::Name),
crates/ql-exec/src/scalar.rs:53:/// `Function` variants return `#NAME?` (`ErrorValue::Name`). To dispatch through a
crates/ql-exec/src/scalar.rs:72:        ExprPlan::Function { .. } => Value::Error(ErrorValue::Name),
crates/ql-exec/src/scalar.rs:463:                None => Value::Error(ErrorValue::Name),
crates/ql-exec/src/scalar.rs:467:        // supposed to surface `BindError::NamedRangeInScalarContext`
crates/ql-exec/src/scalar.rs:589:            // time (`BindError::UnknownSheet`); the runtime-stale-sheet
crates/ql-exec/src/scalar.rs:717:/// `ExprPlan::Array(vec![])` (`BindError::EmptyArrayLiteral`) and
crates/ql-exec/src/scalar.rs:719:/// (`BindError::ArrayRowArityMismatch`). So when we reach this code,
crates/ql-exec/src/scalar.rs:1418:        assert_eq!(eval_scalar(&plan, &env), Value::Error(ErrorValue::Name));
crates/ql-exec/src/scalar.rs:1429:        assert_eq!(eval_reg(&expr, &env, &reg), Value::Error(ErrorValue::Name));
crates/ql-exec/src/env.rs:427:/// `ResolvedName` variants (the binder converts them to specific `BindError`
crates/ql-exec/src/transaction.rs:391:                workbook.put_computed_at(*sheet, *row, *col, value);
crates/ql-exec/src/transaction.rs:522:                Err(RuntimeError::Bind(crate::plan::BindError::UnresolvedName(
crates/ql-exec/src/transaction.rs:795:        use crate::plan::BindError;
crates/ql-exec/src/transaction.rs:804:            Err(RuntimeError::Bind(BindError::NamedTargetIsBlank(name))) => {
crates/ql-exec/src/transaction.rs:814:        use crate::plan::BindError;
crates/ql-exec/src/transaction.rs:826:            Err(RuntimeError::Bind(BindError::NamedTargetIsError(name, err))) => {
crates/ql-exec/src/plan.rs:80:    /// [`BindError::NamedRangeInScalarContext`] instead of binding to this
crates/ql-exec/src/plan.rs:93:    /// this (`BindError::ArrayRowArityMismatch`) on every public input AND
crates/ql-exec/src/plan.rs:170:pub enum BindError {
crates/ql-exec/src/plan.rs:238:    UnknownSheet(Arc<str>),
crates/ql-exec/src/plan.rs:358:/// (aggregate-arg) or surfaces as `BindError::NamedRangeInScalarContext`
crates/ql-exec/src/plan.rs:382:    /// `SUM(A1:B3)` work — currently a `BindError::UnsupportedVariant`)
crates/ql-exec/src/plan.rs:575:/// `BindError::UnresolvedName`; any cross-sheet ref (`SheetRef::Name`)
crates/ql-exec/src/plan.rs:576:/// produces `BindError::UnknownSheet`.
crates/ql-exec/src/plan.rs:579:pub fn bind(expr: &Expr, owning_sheet: SheetId) -> Result<ExprPlan, BindError> {
crates/ql-exec/src/plan.rs:585:/// `BindError::UnknownSheet`. Callers that need cross-sheet support

 succeeded in 70938ms:
    Blocking waiting for file lock on artifact directory
   Compiling ql-collab v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab)
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 35.52s
     Running tests/phase_5_3_conflict_matrix_probe.rs (target/debug/deps/phase_5_3_conflict_matrix_probe-a7d4507d25a58877)

running 1 test
test row7_rename_sheet_concurrent_edit_resolves_via_repair_pass ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.01s


codex
VERDICT: FAIL (HIGH)

**Findings**

- HIGH [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:183): cross-sheet rewrite rules can cascade into the wrong sheet. The loop rewrites `current_text` repeatedly across all rules. Valid case: base sheets `A` and `B`; peer A renames `B -> C`, then `A -> B`; peer B writes `A!A1`. Rules become `A -> B` and `B -> C`, so `A!A1` repairs to `C!A1`, not sheet 0’s final name `B!A1`. This is user-visible formula corruption. Fix by parsing once and rewriting each original sheet ref against a rule map without feeding generated target names back through later rules.

- HIGH [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:161): historic names remain active forever, even after another current sheet legitimately owns that name. Example: sheet `S` is renamed to `T`; later a new sheet named `S` is added and a formula references `S!A1`. Because the whole log still contains old `S`, repair rewrites the valid current reference to `T!A1`. At minimum, skip/report ambiguous rules where `old_canonical` is currently owned by a different sheet; the real fix is causality or sheet-id-aware repair.

- LOW [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:59): the documented “later in iteration wins” ambiguity is not accurate. Duplicate old keys normally make the first rule win because the second no longer matches after the first rewrite. “Later wins” only happens accidentally in cascade cases like the HIGH above. Update the limitation text and add a regression pin once policy is chosen.

**Other Checks**

The auto-disambiguation target `X(2)` is correct: rewriting to wire `X` would bind the wrong sheet. Row 7’s `42.0` assertion is correct under replay → repair → recompute. `put_formula`’s stale value concern is fine for the intended flow because recompute overwrites computed overlay after repair. `ql-exec`’s dev-dep on `ql-collab` does not create a Cargo cycle. Separate `Cargo.lock` commit is repo-hygiene weak for bisect/`--locked` CI on the ship commit, but final head is fine.

Tests run:
`cargo test -p ql-collab --test repair_renames -- --test-threads=1`
`cargo test -p ql-exec --test phase_5_3_conflict_matrix_probe row7_rename_sheet_concurrent_edit_resolves_via_repair_pass -- --test-threads=1`

Synthesis: the happy path shipped, but the repair pass is too global: it rewrites by historical display name, repeatedly, across the whole log. That closes the simple `#NAME?` case while opening formula-corruption cases when sheet names are reused or swapped.
tokens used
135,224
VERDICT: FAIL (HIGH)

**Findings**

- HIGH [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:183): cross-sheet rewrite rules can cascade into the wrong sheet. The loop rewrites `current_text` repeatedly across all rules. Valid case: base sheets `A` and `B`; peer A renames `B -> C`, then `A -> B`; peer B writes `A!A1`. Rules become `A -> B` and `B -> C`, so `A!A1` repairs to `C!A1`, not sheet 0’s final name `B!A1`. This is user-visible formula corruption. Fix by parsing once and rewriting each original sheet ref against a rule map without feeding generated target names back through later rules.

- HIGH [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:161): historic names remain active forever, even after another current sheet legitimately owns that name. Example: sheet `S` is renamed to `T`; later a new sheet named `S` is added and a formula references `S!A1`. Because the whole log still contains old `S`, repair rewrites the valid current reference to `T!A1`. At minimum, skip/report ambiguous rules where `old_canonical` is currently owned by a different sheet; the real fix is causality or sheet-id-aware repair.

- LOW [repair.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:59): the documented “later in iteration wins” ambiguity is not accurate. Duplicate old keys normally make the first rule win because the second no longer matches after the first rewrite. “Later wins” only happens accidentally in cascade cases like the HIGH above. Update the limitation text and add a regression pin once policy is chosen.

**Other Checks**

The auto-disambiguation target `X(2)` is correct: rewriting to wire `X` would bind the wrong sheet. Row 7’s `42.0` assertion is correct under replay → repair → recompute. `put_formula`’s stale value concern is fine for the intended flow because recompute overwrites computed overlay after repair. `ql-exec`’s dev-dep on `ql-collab` does not create a Cargo cycle. Separate `Cargo.lock` commit is repo-hygiene weak for bisect/`--locked` CI on the ship commit, but final head is fine.

Tests run:
`cargo test -p ql-collab --test repair_renames -- --test-threads=1`
`cargo test -p ql-exec --test phase_5_3_conflict_matrix_probe row7_rename_sheet_concurrent_edit_resolves_via_repair_pass -- --test-threads=1`

Synthesis: the happy path shipped, but the repair pass is too global: it rewrites by historical display name, repeatedly, across the whole log. That closes the simple `#NAME?` case while opening formula-corruption cases when sheet names are reused or swapped.
