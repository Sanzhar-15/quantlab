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
session id: 019e4566-95d6-76b3-826e-04e860496e3c
--------
user
# Codex audit — Phase 5.3 step 2 (concurrent RenameSheet replay fix) 2026-05-20

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: commit `1ed2bbba78a` (Phase 5.3 step 2 ship).
Predecessor chain: `03408fa17bd` (step 1 audit closure) → `a6babc65b51` (step 1 fmt) → `5595d8dcfb0` (step 1 ship) → `6289c4f3d4a` (D-1 doc closure).

**Workspace tests at HEAD**: 4305 passing / 0 failed (+5 from step 2) with `--test-threads=1`. fmt + clippy: clean.
The 3 calamine_smoke failures under parallel test runs are the pre-existing temp_dir race documented in D-1 step 8 megaudit (Opus MEDIUM) — unrelated to step 2.

## What step 2 did

Closed the pre-step-2 replay hard-fail at `crates/ql-oplog/src/replay.rs:486-532` (specifically case 3, `SheetRenameNameMismatch`). Discovered during step 1 code survey: under CRDT merge of concurrent renames (peer A: S→S2 + peer B: S→S3 concurrent), the second rename op's `old_name="S"` no longer matches current ("S2") → replay erred → unrecoverable.

**Audit-locked policy (user-confirmed via AskUserQuestion at session start)**: last-in-causal-order wins; second rename targets the current sheet. The op's `old_name` is interpreted as "what the peer thought was current at write time"; if reality has moved on, apply rename to whatever the sheet currently is.

Implementation:
- Cases 2 + 3 unified: BOTH apply `Workbook::rename_sheet(id, new_name)`. Pre-step-2 case 2 was the only branch that applied; case 3 erred.
- Case 1 (`current == new_name`) → idempotent no-op (unchanged).
- `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat; zero emit sites post-step-2; docstring marks "VARIANT NO LONGER EMITTED."

5 new tests at `crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs`:
- `step2_concurrent_rename_different_targets_converges` (PRIMARY — the canonical bug case)
- `step2_concurrent_rename_identical_targets_is_idempotent` (both peers pick same target)
- `step2_sequential_rename_across_peers_converges` (regression baseline: non-concurrent path still works)
- `step2_concurrent_rename_plus_literal_write_both_apply` (mixed op types)
- `step2_three_peer_concurrent_rename_converges` (transitivity beyond 2 peers)

Plus: 1 existing test renamed + inverted (`replay_rename_sheet_name_mismatch_errors` → `replay_rename_sheet_current_neither_old_nor_new_applies_rename`).

## What I want you to audit — be ruthlessly adversarial

The previous 3 D-1 + step 1 cycles were DIVERGENT-HIGH (Codex caught real bugs Opus PASSED on). I want the same here.

### Correctness / edge cases

1. **The case unification might be wrong.** Pre-step-2 case 2 was `current == old_name` (apply). Case 3 was `current == neither` (error). I unified them under "else" (everything that isn't case 1 idempotency). What edge case did case 3's explicit error catch that's now silently absorbed?
   - Specifically: what happens if a peer issues `RenameSheet { id: 0, old: "Wrong", new: "X" }` against a workbook whose sheet 0 is currently named "S"? Pre-step-2: errored. Post-step-2: renames "S" → "X" silently. Is that desirable? It's the CRDT semantic ("what the peer thought was current"), but for SINGLE-WRITER scenarios this is now silently wrong.
   - Should there be a distinction between "CRDT-merged log" and "single-writer log" for this policy? If yes, how does replay know which it's seeing?

2. **Sheet collision under last-wins.** Peer A renames S1→S2; peer B concurrently renames S3→S2 (different source, SAME target). After merge with last-wins:
   - First rename: S1→S2 applies (S2 exists alongside original S3).
   - Second rename: current at sheet B's id is S3 (unchanged), but new_name="S2" is now taken → `SheetRenameRejected` from `Workbook::rename_sheet`. **Is this the right outcome?** Both peers wanted to name some sheet "S2"; second peer's rename is rejected. Is that what we want, or should the rejected peer's rename auto-disambiguate (like D-2 AddSheet collision)?

3. **The `_ = old_name` discard.** I write `let _ = old_name;` to mark `old_name` as intentionally unused post-step-2. Is this idiomatic? Should I keep `old_name` in the error variant for diagnostics?

4. **Verify the 3-peer test (step2_three_peer_concurrent_rename_converges) actually tests transitivity.** The star-merge pattern (every peer pulls every other peer's bytes) creates 6 merges total. Is convergence guaranteed by Loro's CRDT or could the test pass by accident?

### Coverage gaps

5. **What about RenameSheet × DropSheet concurrent?** The Op enum has no `DropSheet` variant (I checked earlier) — so this is out of scope. Verify.

6. **RenameTable + RenameColumn** have IDENTICAL bug shape at `replay.rs:691 + 749` (Opus step 1 MEDIUM-2). Step 2 does NOT touch them. Is this acceptable for the step boundary, OR should step 2 also fix them?
   - I'm deferring to step 4 per the audit-locked plan, but flagging in case the audit thinks step 2 should extend.

### Documentation / discoverability

7. **`ReplayError::SheetRenameNameMismatch` dead variant.** Should it be `#[deprecated]`? Removed entirely? Kept silently? Pick the right call.

8. **`crdt-data-model.md` § 311-334** has the conflict matrix table. Row 7 (RenameSheet × concurrent edit) still describes `BindError::UnknownSheet → #NAME?` as the current behavior + "Phase 5.3 adds the causality-aware rename-repair pass." Step 2 changes the REPLAY behavior (no longer hard-fails) but not the rename-repair (step 3). Is the doc still correct, or does it need a step-2-specific update?

### Sanity

9. **Did I break any pre-existing rename test?** The producer_replay_equivalence.rs test at lines 182-195 emits RenameSheet ops. Run through the logic and verify these still work post-step-2.

10. **What's the worst case if step 2 is wrong?** If the audit finds a HIGH bug, what's the blast radius? Data corruption? Replay-deadlock? Recoverable?

## Report format

Standard discipline:
- VERDICT: PASS / PASS-WITH-FINDINGS / FAIL (severity bucketed HIGH/MEDIUM/LOW)
- For each finding: file/line + what + why it matters + suggested fix
- One-paragraph synthesis

Hard cap: 1500 words. Concision matters. Previous 3 cycles caught real HIGHs; I want the same level of rigor.

codex
I’ll audit this as a review, starting from the exact commit diff and then tracing replay semantics around rename ordering, collisions, and diagnostics. After that I’ll spot-check the relevant tests and docs against the behavior the patch actually ships.
exec
/bin/zsh -lc "sed -n '1,220p' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
/bin/zsh -lc 'git show --stat --oneline --decorate --find-renames 1ed2bbba78a && git show --find-renames --format=fuller --name-only 1ed2bbba78a' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
1ed2bbba78a (HEAD -> feat/quantbook-engine) Phase 5.3 step 2 — concurrent RenameSheet replay fix (last-in-causal-order wins)
 quantbook-engine/crates/ql-oplog/src/replay.rs     | 108 +++++--
 .../tests/phase_5_3_step2_rename_concurrent.rs     | 324 +++++++++++++++++++++
 2 files changed, 408 insertions(+), 24 deletions(-)
commit 1ed2bbba78a661ac4bc31a1a0e9bffca0db016b3
Author:     steppen0mad <nurtaymergaliyev@gmail.com>
AuthorDate: Wed May 20 13:39:17 2026 +0100
Commit:     steppen0mad <nurtaymergaliyev@gmail.com>
CommitDate: Wed May 20 13:39:17 2026 +0100

    Phase 5.3 step 2 — concurrent RenameSheet replay fix (last-in-causal-order wins)
    
    Closes the pre-step-2 replay hard-fail at `replay.rs:524-531` (case 3,
    `SheetRenameNameMismatch`). Discovered during Phase 5.3 step 1 code survey
    (Opus-A finding): two peers concurrently renaming the same sheet (peer A:
    S→S2; peer B: S→S3) produced a merged log whose second rename's old_name
    no longer matched current → replay errored → unrecoverable state.
    
    Audit-locked policy (user-confirmed AskUserQuestion 2026-05-20):
    **last-in-causal-order wins; second rename targets the current sheet.**
    The op's `old_name` is interpreted as "what the peer thought was current
    at write time"; if reality has moved on (another peer's rename landed
    first), apply this rename to whatever the sheet currently is. Final name
    converges deterministically because Loro's causal order is deterministic
    across peers. Matches the SetName + same-cell-write rule from the
    crdt-data-model.md conflict matrix.
    
    Implementation (`crates/ql-oplog/src/replay.rs`):
    - Case 1 (`current == new_name`) → idempotent no-op (unchanged from
      W5-91 snapshot reconciliation).
    - Cases 2 + 3 merged: BOTH apply `Workbook::rename_sheet(id, new_name)`.
      Pre-step-2 case 2 was the only branch that did this; case 3 erred.
      Post-step-2 the case distinction is documentation-only.
    - `ReplayError::SheetRenameNameMismatch` variant kept for ABI compat
      (docstring updated: "VARIANT NO LONGER EMITTED"); zero emit sites
      post-step-2. May be removed in a future major version.
    
    Test updates:
    - Existing test `replay_rename_sheet_name_mismatch_errors` renamed to
      `replay_rename_sheet_current_neither_old_nor_new_applies_rename` and
      assertion inverted: rename APPLIES (not errors) when current ∉
      {old, new}.
    - NEW: `crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs`
      (5 tests) — full 2-peer probe coverage:
      - step2_concurrent_rename_different_targets_converges (PRIMARY)
      - step2_concurrent_rename_identical_targets_is_idempotent
      - step2_sequential_rename_across_peers_converges
      - step2_concurrent_rename_plus_literal_write_both_apply
      - step2_three_peer_concurrent_rename_converges (transitivity)
    
    Pre-step-2 conflict matrix row 7 (RenameSheet × concurrent edit) still
    pins #NAME? behavior — step 3's rename-repair pass changes that.
    
    Edge cases covered (per replay docstring):
    - Sheet doesn't exist at id → `InvalidSheet` (unchanged path).
    - Rename target collision (new_name already taken) → `SheetRenameRejected`
      propagated from Workbook::rename_sheet (unchanged).
    
    Workspace tests: 4300 → 4305 (+5) with --test-threads=1. fmt + clippy
    clean. The 3 calamine_smoke failures under parallel test runs are the
    pre-existing temp_dir race documented in D-1 step 8 megaudit (Opus
    MEDIUM) — unrelated to step 2.
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

quantbook-engine/crates/ql-oplog/src/replay.rs
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs

exec
/bin/zsh -lc 'git status --short && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 1057ms:
?? .codex-phase-5-3-step-2-audit-prompt.md
?? .codex-phase-5-3-step-2-audit.out
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
1ed2bbba78a661ac4bc31a1a0e9bffca0db016b3

codex
The workspace has unrelated untracked files; I’m leaving them alone. HEAD is the target commit on `feat/quantbook-engine`, so I’m reviewing the shipped state plus the patch relative to `03408fa17bd`.
exec
/bin/zsh -lc 'git diff --find-renames 03408fa17bd..1ed2bbba78a -- quantbook-engine/crates/ql-oplog/src/replay.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '430,570p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-oplog/src/replay.rs b/quantbook-engine/crates/ql-oplog/src/replay.rs
index 8b0f6e65d0f..f66482e4526 100644
--- a/quantbook-engine/crates/ql-oplog/src/replay.rs
+++ b/quantbook-engine/crates/ql-oplog/src/replay.rs
@@ -134,8 +134,14 @@ pub enum ReplayError {
     /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
     /// whose current name matches neither `old_name` nor `new_name`
     /// (i.e. the replay state has diverged from what the op recorded).
-    /// Surfaces a clean error rather than silently renaming a different
-    /// sheet.
+    ///
+    /// **Phase 5.3 step 2 (2026-05-20) — VARIANT NO LONGER EMITTED.**
+    /// Under CRDT merge of concurrent renames, current name may
+    /// legitimately match neither. The replay handler now applies
+    /// the rename to the current sheet (last-in-causal-order wins
+    /// policy). Variant kept for ABI compat — external callers that
+    /// match against it will simply never see it. May be removed in
+    /// a future major version after a deprecation cycle.
     #[error(
         "replay rename-sheet name mismatch at op index {index}: sheet {id} \
          expected current name {expected:?}, found {found:?}"
@@ -488,14 +494,52 @@ fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), Replay
             old_name,
             new_name,
         } => {
-            // **W5-91 (Phase 4.6.C):** snapshot-vs-replay reconciliation
-            // per design § 3.3. Three cases:
-            //   1. Current sheet name == old_name → fresh rename; apply.
-            //   2. Current sheet name == new_name → already-renamed (likely
-            //      replay-on-top-of-snapshot where the snapshot captured
-            //      the post-rename state). No-op; success.
-            //   3. Current sheet name == neither → divergent state; treat as
-            //      InvalidSheet for the op-log's safety contract.
+            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 (2026-05-20):**
+            // snapshot-vs-replay reconciliation + CRDT concurrent-rename
+            // policy. Three cases the replay handler sees:
+            //
+            //   1. Current sheet name == new_name → already-renamed.
+            //      Idempotent path (replay-on-top-of-snapshot OR concurrent
+            //      peers picked the same target). No-op; success.
+            //
+            //   2. Current sheet name == old_name → fresh rename. Apply.
+            //
+            //   3. Current sheet name == neither → either:
+            //      (a) Pre-Phase-5.3: divergent state, treated as
+            //          `SheetRenameNameMismatch` (replay hard-failed).
+            //      (b) **Phase 5.3 step 2 policy (audit-locked)**: under
+            //          CRDT merge of concurrent renames, current name may
+            //          legitimately match neither. E.g. peer A renames
+            //          S1→S2 (applied first in causal order); peer B
+            //          concurrently issues `RenameSheet { old: "S1",
+            //          new: "S3" }`. By the time B's op replays, current
+            //          is "S2" — neither "S1" nor "S3".
+            //
+            //          Policy: **last-in-causal-order wins; apply the
+            //          rename to the current sheet name.** The op's
+            //          `old_name` is interpreted as "what the peer thought
+            //          was current at write time"; if reality has moved on
+            //          (another peer's rename landed first), apply this
+            //          rename to whatever the sheet currently is. Final
+            //          name converges deterministically because Loro's
+            //          causal order is deterministic across peers.
+            //
+            //          Matches the "last-in-causal-order wins" semantic
+            //          documented for SetName + same-cell writes in
+            //          `crdt-data-model.md` § 311-334.
+            //
+            // Cases 2 and 3 share identical code — both apply the rename
+            // via `workbook.rename_sheet(id, new_name)`. The case
+            // distinction is documentation-only after step 2.
+            //
+            // Edge cases (post-step-2):
+            //   - Sheet doesn't exist at id → `InvalidSheet` (existing,
+            //     unchanged). Loro's causal order should not produce this
+            //     under normal multi-peer flows; it would indicate a
+            //     genuine corruption.
+            //   - Rename target collision (new_name already used by a
+            //     different sheet) → `SheetRenameRejected` propagated
+            //     from `Workbook::rename_sheet`.
             let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
                 ReplayError::InvalidSheet {
                     index,
@@ -505,12 +549,15 @@ fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), Replay
             )?;
             let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
             let cur_c = canonical(&current);
-            let old_c = canonical(old_name);
             let new_c = canonical(new_name);
             if cur_c == new_c {
-                // Already renamed (snapshot-authoritative path). No-op.
+                // Case 1: idempotent — current already at target. No-op.
                 Ok(())
-            } else if cur_c == old_c {
+            } else {
+                // Case 2 (current == old_name, fresh rename) OR
+                // Case 3 (Phase 5.3 step 2: concurrent-rename last-wins).
+                // Both apply `current → new_name`.
+                let _ = old_name; // kept on the wire for diagnostics; not validated post-step-2
                 workbook
                     .rename_sheet(*id, new_name.clone())
                     .map_err(|source| ReplayError::SheetRenameRejected {
@@ -521,13 +568,6 @@ fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), Replay
                         source,
                     })?;
                 Ok(())
-            } else {
-                Err(ReplayError::SheetRenameNameMismatch {
-                    index,
-                    id: *id,
-                    expected: old_name.clone(),
-                    found: current,
-                })
             }
         }
         Op::RegisterFormat { id, string } => {
@@ -1615,9 +1655,25 @@ mod tests {
         assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
     }
 
+    /// **Phase 5.3 step 2 (2026-05-20):** test name + assertion
+    /// inverted by the audit-locked CRDT policy change. Pre-step-2
+    /// this asserted `SheetRenameNameMismatch` fired when the
+    /// current sheet name matched neither old nor new (e.g. a
+    /// snapshot whose state diverged from the op's `old_name`).
+    /// Post-step-2 that case applies the rename to the current
+    /// sheet ("last-in-causal-order wins" policy) — current name
+    /// after replay is `new_name`.
+    ///
+    /// The renamed test reflects the new property: replay applies
+    /// the rename even when current ≠ old_name.
     #[test]
-    fn replay_rename_sheet_name_mismatch_errors() {
-        // Snapshot has a name that's neither old nor new ⇒ divergent state.
+    fn replay_rename_sheet_current_neither_old_nor_new_applies_rename() {
+        // Snapshot has a name that's neither old nor new ⇒ under
+        // Phase 5.3 step 2, this is the canonical concurrent-rename
+        // scenario: another peer's rename already changed the sheet
+        // name; this op's `old_name` is interpreted as "what the
+        // peer thought was current," and replay applies the rename
+        // to whatever the sheet currently is.
         let mut log = OpLog::new();
         log.append(Op::RenameSheet {
             id: 0,
@@ -1629,8 +1685,12 @@ mod tests {
         let mut wb = Workbook::new();
         wb.add_sheet("Something Else");
         let reg = default_registry();
-        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
-        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
+        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
+        assert_eq!(
+            wb.sheet(0).unwrap().name(),
+            "Renamed",
+            "Phase 5.3 step 2: 'last-in-causal-order wins' — rename applies to current sheet"
+        );
     }
 
     #[test]

 succeeded in 0ms:
   430	                            name: name.clone(),
   431	                            source,
   432	                        }
   433	                    })?;
   434	                }
   435	            }
   436	            Ok(())
   437	        }
   438	        Op::AddSheet { name, chunk_rows } => {
   439	            // **W5-93 (Phase 4.6.E closure):** route through the fallible
   440	            // `try_add_sheet_with_chunk_rows` and surface a clean
   441	            // `ReplayError::SheetNameRejected` on validation failure.
   442	            // Codex HIGH-1 flagged that the prior infallible path
   443	            // silently accepted duplicate-canonical names + reserved
   444	            // characters at the replay boundary too.
   445	            //
   446	            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
   447	            // duplicate-canonical-name. Phase 5 multi-peer scenario:
   448	            // peer A and peer B both call `add_sheet("S")` locally;
   449	            // each producer-side validates against its own snapshot
   450	            // (no collision visible); both emit
   451	            // `Op::AddSheet { name: "S", ... }`; merged log has both.
   452	            // First replay succeeds; second hits the duplicate guard.
   453	            // Pre-D-2 we rejected the second op (worse UX than Google
   454	            // Sheets, which auto-renames to S(2)). Now we walk
   455	            // `<name>(2)`, `<name>(3)`, … until we find a free name.
   456	            // `Empty` + `ReservedCharacter` still reject — auto-rename
   457	            // only resolves the collaboration-collision case.
   458	            let mut chosen = name.clone();
   459	            let mut suffix = 2u32;
   460	            const AUTO_RENAME_CEILING: u32 = 10_000;
   461	            loop {
   462	                match workbook.try_add_sheet_with_chunk_rows(chosen.clone(), *chunk_rows) {
   463	                    Ok(_) => return Ok(()),
   464	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   465	                        chosen = format!("{name}({suffix})");
   466	                        suffix += 1;
   467	                        if suffix > AUTO_RENAME_CEILING {
   468	                            // Pathological: more than 10k sheets all
   469	                            // share the same base name (impossible in
   470	                            // realistic workbooks; max sheets per
   471	                            // workbook is 65,535). Surface a clean
   472	                            // error rather than loop forever.
   473	                            return Err(ReplayError::SheetNameRejected {
   474	                                index,
   475	                                name: name.clone(),
   476	                                source: ql_storage::SheetNameError::Duplicate {
   477	                                    name: name.clone(),
   478	                                },
   479	                            });
   480	                        }
   481	                    }
   482	                    Err(other) => {
   483	                        return Err(ReplayError::SheetNameRejected {
   484	                            index,
   485	                            name: name.clone(),
   486	                            source: other,
   487	                        });
   488	                    }
   489	                }
   490	            }
   491	        }
   492	        Op::RenameSheet {
   493	            id,
   494	            old_name,
   495	            new_name,
   496	        } => {
   497	            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 (2026-05-20):**
   498	            // snapshot-vs-replay reconciliation + CRDT concurrent-rename
   499	            // policy. Three cases the replay handler sees:
   500	            //
   501	            //   1. Current sheet name == new_name → already-renamed.
   502	            //      Idempotent path (replay-on-top-of-snapshot OR concurrent
   503	            //      peers picked the same target). No-op; success.
   504	            //
   505	            //   2. Current sheet name == old_name → fresh rename. Apply.
   506	            //
   507	            //   3. Current sheet name == neither → either:
   508	            //      (a) Pre-Phase-5.3: divergent state, treated as
   509	            //          `SheetRenameNameMismatch` (replay hard-failed).
   510	            //      (b) **Phase 5.3 step 2 policy (audit-locked)**: under
   511	            //          CRDT merge of concurrent renames, current name may
   512	            //          legitimately match neither. E.g. peer A renames
   513	            //          S1→S2 (applied first in causal order); peer B
   514	            //          concurrently issues `RenameSheet { old: "S1",
   515	            //          new: "S3" }`. By the time B's op replays, current
   516	            //          is "S2" — neither "S1" nor "S3".
   517	            //
   518	            //          Policy: **last-in-causal-order wins; apply the
   519	            //          rename to the current sheet name.** The op's
   520	            //          `old_name` is interpreted as "what the peer thought
   521	            //          was current at write time"; if reality has moved on
   522	            //          (another peer's rename landed first), apply this
   523	            //          rename to whatever the sheet currently is. Final
   524	            //          name converges deterministically because Loro's
   525	            //          causal order is deterministic across peers.
   526	            //
   527	            //          Matches the "last-in-causal-order wins" semantic
   528	            //          documented for SetName + same-cell writes in
   529	            //          `crdt-data-model.md` § 311-334.
   530	            //
   531	            // Cases 2 and 3 share identical code — both apply the rename
   532	            // via `workbook.rename_sheet(id, new_name)`. The case
   533	            // distinction is documentation-only after step 2.
   534	            //
   535	            // Edge cases (post-step-2):
   536	            //   - Sheet doesn't exist at id → `InvalidSheet` (existing,
   537	            //     unchanged). Loro's causal order should not produce this
   538	            //     under normal multi-peer flows; it would indicate a
   539	            //     genuine corruption.
   540	            //   - Rename target collision (new_name already used by a
   541	            //     different sheet) → `SheetRenameRejected` propagated
   542	            //     from `Workbook::rename_sheet`.
   543	            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
   544	                ReplayError::InvalidSheet {
   545	                    index,
   546	                    sheet: *id,
   547	                    sheet_count: workbook.sheet_count(),
   548	                },
   549	            )?;
   550	            let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
   551	            let cur_c = canonical(&current);
   552	            let new_c = canonical(new_name);
   553	            if cur_c == new_c {
   554	                // Case 1: idempotent — current already at target. No-op.
   555	                Ok(())
   556	            } else {
   557	                // Case 2 (current == old_name, fresh rename) OR
   558	                // Case 3 (Phase 5.3 step 2: concurrent-rename last-wins).
   559	                // Both apply `current → new_name`.
   560	                let _ = old_name; // kept on the wire for diagnostics; not validated post-step-2
   561	                workbook
   562	                    .rename_sheet(*id, new_name.clone())
   563	                    .map_err(|source| ReplayError::SheetRenameRejected {
   564	                        index,
   565	                        id: *id,
   566	                        old_name: old_name.clone(),
   567	                        new_name: new_name.clone(),
   568	                        source,
   569	                    })?;
   570	                Ok(())

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Replay an `OpLog` against a `Workbook`.
     2	//!
     3	//! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
     4	//! Workbook, &FunctionRegistry) -> Result<usize, ReplayError>`. Returns the
     5	//! count of ops successfully applied; on failure, returns
     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
     7	//! op and the underlying failure. The workbook is left in a partial state
     8	//! on failure (callers decide whether to discard, recover, or recompute).
     9	//!
    10	//! ## Replay semantics
    11	//!
    12	//! Each `Op` variant maps to one `Workbook` mutation:
    13	//!
    14	//! - `PutValue` → `Workbook::put_at` (after row/col bounds check).
    15	//! - `PutFormula` → `Workbook::put_formula` (text only; replay does NOT
    16	//!   re-evaluate — that's a separate step the caller drives via
    17	//!   `WorkbookRuntime::recompute_all`).
    18	//! - `ClearFormula` → `Workbook::clear_formula`.
    19	//! - `SetName` → `Workbook::set_name`. Reserved names (e.g. `AI`) surface
    20	//!   as `ReplayError::NameRejected`.
    21	//! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
    22	//! - `BatchCommit` → recurse on each inner op. Index reporting flattens:
    23	//!   a failure inside a BatchCommit reports the inner op's overall
    24	//!   position (current outer index + offset).
    25	//!
    26	//! ## Idempotence
    27	//!
    28	//! `replay_into` is idempotent only in the trivial sense: replaying twice
    29	//! against the same starting workbook produces the same final state IFF
    30	//! the underlying mutation methods are themselves idempotent (and they
    31	//! are — `put_at` / `put_formula` / `clear_formula` / `set_name` /
    32	//! `add_sheet` all are). Callers wanting at-most-once semantics across
    33	//! sessions track replay state themselves (Phase 5+ work).
    34	//!
    35	//! ## `registry` parameter
    36	//!
    37	//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
    38	//! 2A.3.a's replay doesn't use it (formula evaluation is deferred to a
    39	//! separate `recompute_all` call), but keeping the parameter stable here
    40	//! avoids a breaking signature change in 2A.3.b/c when the eval path
    41	//! could land inside replay.
    42	
    43	use ql_functions::FunctionRegistry;
    44	use ql_storage::Workbook;
    45	use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
    46	use thiserror::Error;
    47	
    48	use crate::log::OpLog;
    49	use crate::op::Op;
    50	
    51	/// Errors emitted by `replay_into`.
    52	#[derive(Debug, Error)]
    53	#[non_exhaustive]
    54	pub enum ReplayError {
    55	    /// An op-log entry failed to deserialize (corrupted log data).
    56	    #[error("replay deserialize error at op index {0}: {1}")]
    57	    Deserialize(usize, #[source] crate::error::OpLogError),
    58	
    59	    /// The op referenced an out-of-range sheet id.
    60	    #[error(
    61	        "replay invalid sheet at op index {index}: sheet {sheet} (workbook has {sheet_count})"
    62	    )]
    63	    InvalidSheet {
    64	        index: usize,
    65	        sheet: SheetId,
    66	        sheet_count: usize,
    67	    },
    68	
    69	    /// The op carried out-of-range row/col coordinates.
    70	    #[error("replay invalid cell at op index {index}: row={row} col={col} ({why})")]
    71	    InvalidCell {
    72	        index: usize,
    73	        row: RowId,
    74	        col: ColId,
    75	        why: &'static str,
    76	    },
    77	
    78	    /// Decoding the on-wire `CellWireValue` failed (e.g., unknown error sigil).
    79	    ///
    80	    /// **Tier D2 (2026-05-19):** source type changed from
    81	    /// `ql_io::QbookError` to `crate::wire::WireDecodeError` so replay
    82	    /// doesn't depend on `ql-io`. The on-wire variant set is identical;
    83	    /// only the wrapping error type changed.
    84	    #[error("replay value-decode error at op index {index}: {source}")]
    85	    ValueDecode {
    86	        index: usize,
    87	        #[source]
    88	        source: crate::wire::WireDecodeError,
    89	    },
    90	
    91	    /// Decoding the on-wire `NamedTargetWire` failed.
    92	    ///
    93	    /// **Tier D2 (2026-05-19):** source type changed from
    94	    /// `ql_io::QbookError` to `crate::wire::WireDecodeError`.
    95	    #[error("replay named-target decode error at op index {index}: {source}")]
    96	    NamedTargetDecode {
    97	        index: usize,
    98	        #[source]
    99	        source: crate::wire::WireDecodeError,
   100	    },
   101	
   102	    /// `Workbook::set_name` refused the name (reserved per CORR-06).
   103	    #[error("replay name rejected at op index {index}: {name:?} ({source})")]
   104	    NameRejected {
   105	        index: usize,
   106	        name: String,
   107	        #[source]
   108	        source: ql_storage::NameTableError,
   109	    },
   110	
   111	    /// `FormatTable::register_at` refused the registration — the id is
   112	    /// already taken with a different string, or the string is already
   113	    /// at a different id. **W5-80 (Phase 4.5.D part 4).**
   114	    #[error("replay format rejected at op index {index}: {source:?}")]
   115	    FormatRejected {
   116	        index: usize,
   117	        #[source]
   118	        source: FormatRejectedSource,
   119	    },
   120	
   121	    /// `Op::SetCellFormat` referenced a format id that hasn't been
   122	    /// registered yet. The producer SHOULD always emit `RegisterFormat`
   123	    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
   124	    /// **W5-80.**
   125	    ///
   126	    /// **Phase 5.2 D-1 step 4:** `id` changed from `u32` to
   127	    /// `ql_storage::FormatId` (the converted-from-wire shape).
   128	    #[error("replay set-cell-format references unregistered format id {id:?} at op index {index}")]
   129	    FormatNotRegistered {
   130	        index: usize,
   131	        id: ql_storage::FormatId,
   132	    },
   133	
   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
   135	    /// whose current name matches neither `old_name` nor `new_name`
   136	    /// (i.e. the replay state has diverged from what the op recorded).
   137	    ///
   138	    /// **Phase 5.3 step 2 (2026-05-20) — VARIANT NO LONGER EMITTED.**
   139	    /// Under CRDT merge of concurrent renames, current name may
   140	    /// legitimately match neither. The replay handler now applies

exec
/bin/zsh -lc 'git diff --find-renames 03408fa17bd..1ed2bbba78a -- quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs b/quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs
new file mode 100644
index 00000000000..87f10a2d1fa
--- /dev/null
+++ b/quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs
@@ -0,0 +1,324 @@
+//! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
+//!
+//! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
+//! had three cases. Case 3 ("current name matches neither old nor
+//! new") returned `ReplayError::SheetRenameNameMismatch`, which
+//! **hard-failed replay** under CRDT merge of concurrent renames.
+//! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
+//! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
+//! After Loro's causal merge, whichever rename replays SECOND finds
+//! `current != "S"` (already renamed by the first) and `current !=
+//! its own new_name` — case 3 — replay errored.
+//!
+//! Post-step-2: case 3 applies the rename to whatever the sheet
+//! currently is. The audit-locked policy from `crdt-data-model.md`
+//! § 311-334 — "last-in-causal-order wins" — produces deterministic
+//! convergence: both peers, after merging each other's ops, observe
+//! the same final sheet name (the winner's new_name).
+//!
+//! These probes pin the property via the D-4 / step-1 test pattern.
+//! `fork_with_peer(base, peer_id)` inlined here because it lives in
+//! a different test target (ql-exec); the helper is small enough to
+//! duplicate, and keeping these tests in ql-oplog avoids pulling in
+//! ql-exec for a replay-layer concern.
+//!
+//! Convergence still requires stable non-zero peer-ids per
+//! `crdt-data-model.md` § "Peer-id stability is a precondition for
+//! CRDT convergence" (added by Phase 5.3 step 1 audit closure).
+
+use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
+use ql_storage::Workbook;
+use ql_types::Address;
+
+const PEER_A_ID: u64 = 1;
+const PEER_B_ID: u64 = 2;
+
+fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
+    let mut log = OpLog::import_bytes(base_bytes).unwrap();
+    log.set_peer_id(peer_id)
+        .expect("set_peer_id with non-zero id must succeed");
+    log
+}
+
+fn base_with_sheet(name: &str) -> OpLog {
+    let mut log = OpLog::new();
+    log.append(Op::AddSheet {
+        name: name.to_owned(),
+        chunk_rows: 16384,
+    })
+    .unwrap();
+    log
+}
+
+/// Replay log into a fresh workbook. NOTE: unlike the step 1 probes
+/// in `phase_5_3_conflict_matrix_probe.rs`, these tests don't need
+/// recompute (we're checking the sheet-name layer, not formula
+/// evaluation). So we use `replay_into` directly without pulling in
+/// `WorkbookRuntime` / ql-exec.
+fn replay_into_fresh(log: &OpLog) -> Workbook {
+    let mut wb = Workbook::new();
+    // default_registry would require ql-functions; pass an empty
+    // registry — replay doesn't call into the function registry
+    // anyway (it stores formulas as text, recomputes on demand).
+    let reg = ql_functions::default_registry();
+    replay_into(log, &mut wb, &reg).expect("replay must succeed");
+    wb
+}
+
+/// **Step 2 PRIMARY property:** two peers concurrently rename the
+/// same sheet to DIFFERENT targets. Replay must NOT hard-fail. The
+/// merged log's final sheet name converges across merge directions.
+#[test]
+fn step2_concurrent_rename_different_targets_converges() {
+    let base = base_with_sheet("S").export_bytes().unwrap();
+
+    // Peer A's view: id=1 renames S → S2, then merges peer B's bytes.
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S2".to_owned(),
+        })
+        .unwrap();
+    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
+    peer_b_for_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S3".to_owned(),
+        })
+        .unwrap();
+    peer_a
+        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
+        .expect("merge_bytes must succeed");
+
+    // Peer B's view: symmetric — id=2 renames S → S3, then merges A.
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S3".to_owned(),
+        })
+        .unwrap();
+    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
+    peer_a_for_b
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S2".to_owned(),
+        })
+        .unwrap();
+    peer_b
+        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
+        .expect("merge_bytes must succeed (reverse direction)");
+
+    // **The critical assertion**: replay must succeed (no
+    // SheetRenameNameMismatch hard-fail).
+    let wb_a = replay_into_fresh(&peer_a);
+    let wb_b = replay_into_fresh(&peer_b);
+
+    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
+    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
+
+    assert_eq!(
+        name_a, name_b,
+        "convergence: both peers must observe the same final sheet name"
+    );
+    // The winner is one of {S2, S3}; we don't predict WHICH (depends
+    // on Loro's tiebreaker).
+    assert!(
+        name_a == "S2" || name_a == "S3",
+        "sheet name must be one of the concurrently-written targets; got {name_a:?}"
+    );
+}
+
+/// **Step 2:** two peers concurrently rename to the SAME target.
+/// Trivially idempotent — both ops fold into the same final state.
+/// Pinned to catch any regression that breaks the "second op finds
+/// current == new_name → no-op" path (case 1 in the post-step-2
+/// classification).
+#[test]
+fn step2_concurrent_rename_identical_targets_is_idempotent() {
+    let base = base_with_sheet("S").export_bytes().unwrap();
+
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "Renamed".to_owned(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "Renamed".to_owned(),
+        })
+        .unwrap();
+
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+    let wb = replay_into_fresh(&peer_a);
+    assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
+}
+
+/// **Step 2:** sequential rename across peers (peer B SAW peer A's
+/// rename before issuing its own). No concurrency — peer B's op has
+/// `old_name = "S2"` matching the post-A-rename state. Pinned as a
+/// regression baseline: the policy change must NOT break the
+/// non-concurrent case.
+#[test]
+fn step2_sequential_rename_across_peers_converges() {
+    let base = base_with_sheet("S").export_bytes().unwrap();
+
+    // Peer A: rename S → S2.
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S2".to_owned(),
+        })
+        .unwrap();
+
+    // Peer B receives peer A's bytes FIRST (sees S2), then renames
+    // S2 → S3. This is the sequential (not concurrent) path.
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
+    peer_b
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S2".to_owned(),
+            new_name: "S3".to_owned(),
+        })
+        .unwrap();
+
+    // Peer A then receives peer B's full log.
+    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
+
+    let wb_a = replay_into_fresh(&peer_a);
+    let wb_b = replay_into_fresh(&peer_b);
+    assert_eq!(wb_a.sheet(0).unwrap().name(), "S3");
+    assert_eq!(wb_b.sheet(0).unwrap().name(), "S3");
+}
+
+/// **Step 2:** concurrent rename + concurrent literal write at the
+/// renamed sheet. Both ops apply (no hard-fail on either). The
+/// literal lives at the renamed sheet's address; sheet name is
+/// the rename winner. This is the test row 7 of the conflict
+/// matrix pinned ONLY for the rename-doesn't-fail property — full
+/// row-7 formula behavior (rewrite to new name) is step 3's work.
+#[test]
+fn step2_concurrent_rename_plus_literal_write_both_apply() {
+    let base = base_with_sheet("S").export_bytes().unwrap();
+
+    // Peer A: rename S → S2.
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "S2".to_owned(),
+        })
+        .unwrap();
+
+    // Peer B (concurrent, no knowledge of rename): PutValue at S!A1.
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::PutValue {
+            sheet: 0,
+            row: 0,
+            col: 0,
+            value: CellWireValue::Number(42.0),
+        })
+        .unwrap();
+
+    peer_a
+        .merge_bytes(&peer_b.export_bytes().unwrap())
+        .expect("merge must succeed even with concurrent rename + edit");
+    let wb = replay_into_fresh(&peer_a);
+
+    // Sheet is renamed (peer A's intent applied).
+    assert_eq!(
+        wb.sheet(0).unwrap().name(),
+        "S2",
+        "rename applied; literal write doesn't block rename"
+    );
+    // PutValue at sheet 0 row 0 col 0 still applied — addresses by
+    // sheet ID, not sheet NAME (sheet ID is stable across rename).
+    let val = wb.read(Address::new(0, 0, 0));
+    assert_eq!(
+        val,
+        ql_types::Value::Number(42.0),
+        "concurrent PutValue at sheet 0 must apply; got {val:?}"
+    );
+}
+
+/// **Step 2:** triple-peer concurrent rename. All three peers
+/// concurrently rename the same sheet to DIFFERENT targets. After
+/// pairwise merge, all peers must converge on the same name (one
+/// of the three targets).
+///
+/// **Why this test matters**: the audit at step 2 should consider
+/// peer counts beyond 2. Loro's causal order is transitive across
+/// peer counts, but the test pins the property explicitly.
+#[test]
+fn step2_three_peer_concurrent_rename_converges() {
+    let base = base_with_sheet("S").export_bytes().unwrap();
+
+    const PEER_C_ID: u64 = 3;
+
+    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
+    peer_a
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "Apple".to_owned(),
+        })
+        .unwrap();
+    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
+    peer_b
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "Banana".to_owned(),
+        })
+        .unwrap();
+    let mut peer_c = fork_with_peer(&base, PEER_C_ID);
+    peer_c
+        .append(Op::RenameSheet {
+            id: 0,
+            old_name: "S".to_owned(),
+            new_name: "Cherry".to_owned(),
+        })
+        .unwrap();
+
+    // Star-merge: every peer pulls every other peer's bytes.
+    let bytes_a = peer_a.export_bytes().unwrap();
+    let bytes_b = peer_b.export_bytes().unwrap();
+    let bytes_c = peer_c.export_bytes().unwrap();
+    peer_a.merge_bytes(&bytes_b).unwrap();
+    peer_a.merge_bytes(&bytes_c).unwrap();
+    peer_b.merge_bytes(&bytes_a).unwrap();
+    peer_b.merge_bytes(&bytes_c).unwrap();
+    peer_c.merge_bytes(&bytes_a).unwrap();
+    peer_c.merge_bytes(&bytes_b).unwrap();
+
+    let wb_a = replay_into_fresh(&peer_a);
+    let wb_b = replay_into_fresh(&peer_b);
+    let wb_c = replay_into_fresh(&peer_c);
+
+    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
+    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
+    let name_c = wb_c.sheet(0).unwrap().name().to_owned();
+
+    assert_eq!(name_a, name_b, "three-peer convergence A == B");
+    assert_eq!(name_b, name_c, "three-peer convergence B == C");
+    assert!(
+        ["Apple", "Banana", "Cherry"].contains(&name_a.as_str()),
+        "winner must be one of the three concurrent renames; got {name_a:?}"
+    );
+}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '140,230p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   140	    /// legitimately match neither. The replay handler now applies
   141	    /// the rename to the current sheet (last-in-causal-order wins
   142	    /// policy). Variant kept for ABI compat — external callers that
   143	    /// match against it will simply never see it. May be removed in
   144	    /// a future major version after a deprecation cycle.
   145	    #[error(
   146	        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
   147	         expected current name {expected:?}, found {found:?}"
   148	    )]
   149	    SheetRenameNameMismatch {
   150	        index: usize,
   151	        id: SheetId,
   152	        expected: String,
   153	        found: String,
   154	    },
   155	
   156	    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
   157	    /// new name (duplicate, reserved character, empty).
   158	    #[error(
   159	        "replay rename-sheet rejected at op index {index}: sheet {id} \
   160	         from {old_name:?} to {new_name:?} ({source})"
   161	    )]
   162	    SheetRenameRejected {
   163	        index: usize,
   164	        id: SheetId,
   165	        old_name: String,
   166	        new_name: String,
   167	        #[source]
   168	        source: ql_storage::SheetNameError,
   169	    },
   170	
   171	    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
   172	    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
   173	    /// under canonical comparison, or an Excel-reserved character.
   174	    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
   175	    /// accepted any name, so an op log produced against a buggy
   176	    /// storage path could let conflicting sheets enter replay state.
   177	    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
   178	    SheetNameRejected {
   179	        index: usize,
   180	        name: String,
   181	        #[source]
   182	        source: ql_storage::SheetNameError,
   183	    },
   184	
   185	    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
   186	    /// the producer should have validated. Catches snapshot-vs-replay
   187	    /// divergence (e.g. snapshot already has the table; another producer
   188	    /// raced).
   189	    #[error("replay create-table rejected at op index {index}: {reason}")]
   190	    TableCreateRejected {
   191	        index: usize,
   192	        name: String,
   193	        reason: &'static str,
   194	    },
   195	
   196	    /// **W5-118 (Phase 4.8.H):** `DropTable` op references a missing
   197	    /// table. Surfaces snapshot-vs-replay divergence loudly per
   198	    /// no-fallbacks doctrine.
   199	    #[error("replay drop-table at op index {index}: table {name:?} not found")]
   200	    TableNotFound { index: usize, name: String },
   201	
   202	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
   203	    /// that doesn't exist in the target table (case-insensitive). Either
   204	    /// the source column was already dropped/renamed before this op, or
   205	    /// the op log has diverged from the snapshot.
   206	    #[error(
   207	        "replay rename-column at op index {index}: table {table:?} \
   208	         has no column {column:?}"
   209	    )]
   210	    TableColumnNotFound {
   211	        index: usize,
   212	        table: String,
   213	        column: String,
   214	    },
   215	
   216	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
   217	    /// validation rule (target name already in the table, empty, etc.).
   218	    /// `reason` is a static string describing which invariant fired.
   219	    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
   220	    TableColumnRejected {
   221	        index: usize,
   222	        table: String,
   223	        column: String,
   224	        reason: &'static str,
   225	    },
   226	
   227	    /// **W5-122 (Phase 4.8.J):** `ResizeTable` op was rejected by a
   228	    /// validation rule (arithmetic mismatch, trailing-columns
   229	    /// mismatch, column-name collision, footprint overlap, etc.).
   230	    /// `reason` is a static string describing which invariant fired.

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '660,790p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   660	                return Err(ReplayError::TableNotFound {
   661	                    index,
   662	                    name: name.clone(),
   663	                });
   664	            }
   665	            Ok(())
   666	        }
   667	        Op::RenameTable { old_name, new_name } => {
   668	            apply_rename_table(workbook, index, old_name, new_name)
   669	        }
   670	        Op::RenameColumn {
   671	            table,
   672	            old_name,
   673	            new_name,
   674	        } => apply_rename_column(workbook, index, table, old_name, new_name),
   675	        Op::ResizeTable {
   676	            name,
   677	            new_rows,
   678	            new_cols,
   679	            added_columns,
   680	            removed_columns,
   681	        } => apply_resize_table(
   682	            workbook,
   683	            index,
   684	            name,
   685	            *new_rows,
   686	            *new_cols,
   687	            added_columns,
   688	            removed_columns,
   689	        ),
   690	        // **W5-146 (Phase 4.9.J) + W5-151 (4.9.O MEDIUM-2 closure):**
   691	        // workbook-scope reference-mode change. Forward-compat
   692	        // unknown wire values surface `ReplayError::UnknownReferenceMode`
   693	        // with the captured string (mirrors the `LocaleWire::Unknown`
   694	        // path below).
   695	        Op::SetReferenceMode { mode } => match mode.clone().to_runtime() {
   696	            Ok(m) => {
   697	                workbook.set_reference_mode(m);
   698	                Ok(())
   699	            }
   700	            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
   701	        },
   702	        // **W5-146 (Phase 4.9.J):** workbook-scope locale change.
   703	        // Unknown wire values (forward-compat op-log file) surface
   704	        // `ReplayError::UnknownLocale` with the captured string.
   705	        Op::SetLocale { locale } => match locale.clone().to_runtime() {
   706	            Ok(loc) => {
   707	                workbook.set_locale(loc);
   708	                Ok(())
   709	            }
   710	            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
   711	        },
   712	    }
   713	}
   714	
   715	/// **W5-119 (Phase 4.8.I):** replay a `RenameTable`. Validates source
   716	/// exists, target name is available (TableTable + NameTable shared
   717	/// namespace), then re-keys the entry. Note: formula text rewrites
   718	/// arrive as accompanying `Op::PutFormula` ops; this arm doesn't
   719	/// touch formula cells.
   720	fn apply_rename_table(
   721	    workbook: &mut Workbook,
   722	    index: usize,
   723	    old_name: &str,
   724	    new_name: &str,
   725	) -> Result<(), ReplayError> {
   726	    let old_canonical = old_name.to_ascii_uppercase();
   727	    let new_canonical: std::sync::Arc<str> =
   728	        std::sync::Arc::from(new_name.to_ascii_uppercase().as_str());
   729	
   730	    // Verify source.
   731	    if workbook.tables().lookup(&old_canonical).is_none() {
   732	        return Err(ReplayError::TableNotFound {
   733	            index,
   734	            name: old_name.to_owned(),
   735	        });
   736	    }
   737	    // Verify target availability (skip the no-op same-name case).
   738	    if !old_canonical.eq_ignore_ascii_case(new_name) {
   739	        if workbook.tables().lookup(&new_canonical).is_some() {
   740	            return Err(ReplayError::TableCreateRejected {
   741	                index,
   742	                name: new_name.to_owned(),
   743	                reason: "table with this canonical name already exists (rename target)",
   744	            });
   745	        }
   746	        if workbook.names().lookup_ci(&new_canonical).is_some() {
   747	            return Err(ReplayError::TableCreateRejected {
   748	                index,
   749	                name: new_name.to_owned(),
   750	                reason: "defined-name with this canonical name already exists (rename target)",
   751	            });
   752	        }
   753	    }
   754	    // Take the entry out, mutate name + display, reinsert under new key.
   755	    let mut meta = workbook
   756	        .tables_mut()
   757	        .remove(&old_canonical)
   758	        .expect("verified above");
   759	    meta.name = std::sync::Arc::clone(&new_canonical);
   760	    meta.display_name = std::sync::Arc::from(new_name);
   761	    workbook.tables_mut().insert(new_canonical, meta);
   762	    Ok(())
   763	}
   764	
   765	/// **W5-121 (Phase 4.8.I.2):** replay a `RenameColumn`. Validates the
   766	/// target table exists, the source column exists (case-insensitive), and
   767	/// the target column name is available within the table. Mutates the
   768	/// matching `TableColumn`'s `name` (lowercase canonical) and `display`
   769	/// (case-preserving). Bumps the `TableTable` generation so plan caches
   770	/// invalidate. Same-canonical column renames are rejected — the producer
   771	/// side treats those as a no-op and doesn't emit the op, so receiving
   772	/// one indicates log divergence.
   773	fn apply_rename_column(
   774	    workbook: &mut ql_storage::Workbook,
   775	    index: usize,
   776	    table: &str,
   777	    old_name: &str,
   778	    new_name: &str,
   779	) -> Result<(), ReplayError> {
   780	    let table_canonical = table.to_ascii_uppercase();
   781	    let meta = workbook
   782	        .tables_mut()
   783	        .get_mut(&table_canonical)
   784	        .ok_or_else(|| ReplayError::TableNotFound {
   785	            index,
   786	            name: table.to_owned(),
   787	        })?;
   788	    let (col_idx, _) =
   789	        meta.lookup_column(old_name)
   790	            .ok_or_else(|| ReplayError::TableColumnNotFound {

exec
/bin/zsh -lc "rg -n \"enum Op|RenameSheet|RenameTable|RenameColumn|DropSheet|DeleteSheet|RemoveSheet|SheetRenameNameMismatch\" quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:134:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/crates/ql-oplog/src/replay.rs:202:    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
quantbook-engine/crates/ql-oplog/src/replay.rs:216:    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
quantbook-engine/crates/ql-oplog/src/replay.rs:492:        Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/crates/ql-oplog/src/replay.rs:514:            //          concurrently issues `RenameSheet { old: "S1",
quantbook-engine/crates/ql-oplog/src/replay.rs:667:        Op::RenameTable { old_name, new_name } => {
quantbook-engine/crates/ql-oplog/src/replay.rs:670:        Op::RenameColumn {
quantbook-engine/crates/ql-oplog/src/replay.rs:715:/// **W5-119 (Phase 4.8.I):** replay a `RenameTable`. Validates source
quantbook-engine/crates/ql-oplog/src/replay.rs:765:/// **W5-121 (Phase 4.8.I.2):** replay a `RenameColumn`. Validates the
quantbook-engine/crates/ql-oplog/src/replay.rs:1615:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/crates/ql-oplog/src/replay.rs:1619:        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/crates/ql-oplog/src/replay.rs:1626:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1644:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/crates/ql-oplog/src/replay.rs:1678:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1699:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1727:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1770:                Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/op.rs:43:pub enum Op {
quantbook-engine/crates/ql-oplog/src/op.rs:108:    RenameSheet {
quantbook-engine/crates/ql-oplog/src/op.rs:200:    RenameTable { old_name: String, new_name: String },
quantbook-engine/crates/ql-oplog/src/op.rs:206:    /// `RenameTable`). The op carries `table` (canonical uppercase) so
quantbook-engine/crates/ql-oplog/src/op.rs:218:    RenameColumn {
quantbook-engine/crates/ql-oplog/src/error.rs:15:pub enum OpLogError {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:1://! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:3://! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:7://! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:8://! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:78:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:86:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:99:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:107:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:148:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:156:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:180:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:192:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:221:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:276:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:284:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:292:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:182:            Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:228:            | Op::RenameTable { .. }
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:229:            | Op::RenameColumn { .. }
quantbook-engine/crates/ql-formula-syntax/src/token.rs:205:pub enum Operator {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:266:    /// 2. Op-log append `Op::RenameTable` (before any mutation).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:305:        // RenameTable + N PutFormula ops; if the log append fails,
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:308:            oplog.append(Op::RenameTable {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:389:    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:447:        // Op-log append BEFORE mutation (W5-103 atomicity). RenameColumn
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:451:            oplog.append(Op::RenameColumn {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1180:        // CreateTable + PutFormula + RenameTable + PutFormula (rewrite).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1182:        assert!(matches!(&ops[2], Op::RenameTable { old_name, new_name }
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1518:        // Only the CreateTable op landed; no RenameColumn op emitted.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1537:        // CreateTable + PutFormula + RenameColumn + PutFormula (rewrite).
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1540:            matches!(&ops[2], Op::RenameColumn { table, old_name, new_name }
quantbook-engine/crates/ql-exec/src/transaction.rs:53:enum OpKind {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:644:/// `Op::RenameColumn` + `Op::PutFormula` for each rewritten cell;
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:27://! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:519:/// `RenameSheet` handler currently HARD-FAILS on concurrent
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:520:/// `RenameSheet × RenameSheet` (case 3 at `replay.rs:524-531`).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:521:/// This test exercises the safer scenario `RenameSheet × PutFormula`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:544:        Op::RenameSheet {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:584:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:15://!   `PutFormula` rewrite + the `RenameSheet` op.
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:185:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {

exec
/bin/zsh -lc "rg -n \"fn rename_sheet|rename_sheet\\(\" quantbook-engine/crates/ql-storage quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/workbook.rs:478:    pub fn rename_sheet(
quantbook-engine/crates/ql-storage/src/workbook.rs:1375:    fn rename_sheet_basic_swaps_name() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1378:        wb.rename_sheet(s0, "Renamed").unwrap();
quantbook-engine/crates/ql-storage/src/workbook.rs:1386:    fn rename_sheet_case_only_rename_allowed() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1390:        wb.rename_sheet(s0, "SHEET1").unwrap();
quantbook-engine/crates/ql-storage/src/workbook.rs:1396:    fn rename_sheet_duplicate_target_rejected() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1400:        let err = wb.rename_sheet(s0, "sheet2").unwrap_err();
quantbook-engine/crates/ql-storage/src/workbook.rs:1407:    fn rename_sheet_empty_rejected() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1411:            wb.rename_sheet(s0, ""),
quantbook-engine/crates/ql-storage/src/workbook.rs:1418:    fn rename_sheet_unknown_id_errors() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1424:        let err = wb.rename_sheet(7, "Other").unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:532:            // via `workbook.rename_sheet(id, new_name)`. The case
quantbook-engine/crates/ql-oplog/src/replay.rs:562:                    .rename_sheet(*id, new_name.clone())
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:190:                wb.rename_sheet(*id, new_name.clone())
quantbook-engine/crates/ql-storage/src/workbook.rs:478:    pub fn rename_sheet(
quantbook-engine/crates/ql-storage/src/workbook.rs:1375:    fn rename_sheet_basic_swaps_name() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1378:        wb.rename_sheet(s0, "Renamed").unwrap();
quantbook-engine/crates/ql-storage/src/workbook.rs:1386:    fn rename_sheet_case_only_rename_allowed() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1390:        wb.rename_sheet(s0, "SHEET1").unwrap();
quantbook-engine/crates/ql-storage/src/workbook.rs:1396:    fn rename_sheet_duplicate_target_rejected() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1400:        let err = wb.rename_sheet(s0, "sheet2").unwrap_err();
quantbook-engine/crates/ql-storage/src/workbook.rs:1407:    fn rename_sheet_empty_rejected() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1411:            wb.rename_sheet(s0, ""),
quantbook-engine/crates/ql-storage/src/workbook.rs:1418:    fn rename_sheet_unknown_id_errors() {
quantbook-engine/crates/ql-storage/src/workbook.rs:1424:        let err = wb.rename_sheet(7, "Other").unwrap_err();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:126:        rt.rename_sheet(s1, "RenamedData").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:331:        rt.rename_sheet(s2, "Renamed2").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:574:        rt.rename_sheet(s, "New").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:726:    let res = rt.rename_sheet(s1, "MyTable");
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:747:    rt.rename_sheet(s, "New").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:919:    rt.rename_sheet(s, "RenamedData").unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1156:        rt.rename_sheet(s1, "DataSheetRenamed").unwrap();
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
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:430:        rt.rename_sheet(1, "RenamedSheet")

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/workbook.rs | sed -n '430,530p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   430	    /// Excel canonical: sheet names compare case-insensitively (so
   431	    /// `"Sheet1"` and `"SHEET1"` are the same sheet) but the DISPLAY
   432	    /// form preserves user-supplied case. This function returns the
   433	    /// canonical form used for lookup / duplicate-detection ONLY;
   434	    /// display goes through `Sheet::name()`.
   435	    ///
   436	    /// V1 simplification: ASCII-only uppercase. `"Café"` and `"café"`
   437	    /// canonicalize to different forms (the non-ASCII `é` is not
   438	    /// folded). Excel itself uses Unicode casefolding here; if a real
   439	    /// workbook with non-ASCII sheet names surfaces a collision, this
   440	    /// gets revisited.
   441	    pub fn canonical_sheet_name(name: &str) -> String {
   442	        name.to_ascii_uppercase()
   443	    }
   444	
   445	    /// **Phase 4.6.AA (W5-86):** find a sheet by name (case-insensitive
   446	    /// per `canonical_sheet_name`). Returns the first match in id order.
   447	    ///
   448	    /// Lookup cost: O(sheet_count). Acceptable for typical workbooks
   449	    /// (low double-digits of sheets). If profiling shows pain, a
   450	    /// canonical-name → id index can be added without changing this
   451	    /// API surface.
   452	    pub fn sheet_id_by_name(&self, name: &str) -> Option<SheetId> {
   453	        let canonical = Self::canonical_sheet_name(name);
   454	        for (idx, sheet) in self.sheets.iter().enumerate() {
   455	            if Self::canonical_sheet_name(sheet.name()) == canonical {
   456	                return Some(idx as SheetId);
   457	            }
   458	        }
   459	        None
   460	    }
   461	
   462	    /// **Phase 4.6.C (W5-91):** rename a sheet by id. Validates the new
   463	    /// name via [`validate_sheet_name`] (rejects empty, Excel-reserved
   464	    /// chars, canonical duplicates) and swaps the sheet's display name.
   465	    ///
   466	    /// **DOES NOT touch formula text.** Stored formulas in
   467	    /// `formula_cells` and `NamedTarget::Formula` entries continue to
   468	    /// reference the OLD sheet name. The runtime wrapper
   469	    /// `WorkbookRuntime::rename_sheet` (`ql-exec`) owns the
   470	    /// tokenization-aware text rewrite + op-log recording per the
   471	    /// parent design doc § 3.1. Direct callers of this method (loader,
   472	    /// tests, op-log replay) get bare name swap only.
   473	    ///
   474	    /// **Phase 4.6 design doc § 3 (Codex HIGH-1 closure):** the swap is
   475	    /// fast (O(1) on the sheet's `name` field); the expensive text
   476	    /// rewrite is the caller's responsibility and is bounded by the
   477	    /// workbook's total formula text size.
   478	    pub fn rename_sheet(
   479	        &mut self,
   480	        id: SheetId,
   481	        new_name: impl Into<String>,
   482	    ) -> Result<(), SheetNameError> {
   483	        let new_name: String = new_name.into();
   484	        // Validate first. If the new name canonically matches the CURRENT
   485	        // sheet name, that's a no-op rename (case-only change is allowed
   486	        // as a display update; duplicate check rejects all other matches).
   487	        let current_canonical = self
   488	            .sheet(id)
   489	            .map(|s| Self::canonical_sheet_name(s.name()))
   490	            .ok_or_else(|| SheetNameError::Duplicate {
   491	                name: format!("<sheet id {id} not found>"),
   492	            })?;
   493	        let new_canonical = Self::canonical_sheet_name(&new_name);
   494	        if new_canonical != current_canonical {
   495	            // Full validation only when canonical name actually changes.
   496	            self.validate_sheet_name(&new_name)?;
   497	        } else if new_name.is_empty() {
   498	            return Err(SheetNameError::Empty);
   499	        }
   500	        // Swap the name. `Sheet::set_name` is private; mutate through
   501	        // sheet_mut + a new accessor.
   502	        if let Some(sheet) = self.sheets.get_mut(id as usize) {
   503	            sheet.set_name(new_name);
   504	        }
   505	        Ok(())
   506	    }
   507	
   508	    /// **Phase 4.6.AA (W5-86):** validate a sheet name for use with
   509	    /// `add_sheet` / `rename_sheet`. Rejects:
   510	    /// - empty string (Excel canon)
   511	    /// - canonical duplicate of an existing sheet name
   512	    /// - Excel-reserved characters `:`, `\`, `/`, `?`, `*`, `[`, `]`
   513	    ///   (also xlsx round-trip prerequisite for Phase 4.11)
   514	    ///
   515	    /// Per the parent design's named-divergence catalog: V1 matches
   516	    /// Excel's rejection set exactly. Length limit (Excel's 31-char
   517	    /// max) is NOT enforced in V1 — that's a UX hint, not a correctness
   518	    /// boundary; tracked for follow-up if xlsx import surfaces it.
   519	    pub fn validate_sheet_name(&self, name: &str) -> Result<(), SheetNameError> {
   520	        if name.is_empty() {
   521	            return Err(SheetNameError::Empty);
   522	        }
   523	        for c in name.chars() {
   524	            if matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']') {
   525	                return Err(SheetNameError::ReservedCharacter(c));
   526	            }
   527	        }
   528	        if self.sheet_id_by_name(name).is_some() {
   529	            return Err(SheetNameError::Duplicate {
   530	                name: name.to_owned(),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/op.rs | sed -n '1,245p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! The `Op` enum — the engine's mutation vocabulary for the op log.
     2	//!
     3	//! Phase 2A.3.a (2026-05-12): minimum producer set covering everything
     4	//! `WorkbookRuntime` and `WorkbookTransaction` can mutate through their
     5	//! public API. Future variants (sheet renames, sheet deletes, formatting
     6	//! changes) land alongside the API additions that produce them.
     7	//!
     8	//! Each variant mirrors a `Workbook` mutation method one-to-one:
     9	//!
    10	//! | `Op` variant       | Replays to                                       |
    11	//! |--------------------|--------------------------------------------------|
    12	//! | `PutValue`         | `Workbook::put_at`                               |
    13	//! | `PutFormula`       | `Workbook::put_formula`                          |
    14	//! | `ClearFormula`     | `Workbook::clear_formula`                        |
    15	//! | `SetName`          | `Workbook::set_name`                             |
    16	//! | `AddSheet`         | `Workbook::add_sheet_with_chunk_rows`            |
    17	//! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
    18	//! | `SetCellFormat`    | `CellFormatOverlay::set` / `::clear` (W5-80)     |
    19	//! | `BatchCommit`      | (recursive — applies each inner op in order)     |
    20	//!
    21	//! ## Wire format choices
    22	//!
    23	//! - `Arc<str>` is NOT used in wire fields. `serde` without the `rc`
    24	//!   feature can't deserialize `Arc<str>` directly. We store `String` on
    25	//!   the wire and convert at the replay boundary. Cleaner separation: the
    26	//!   wire format owns its strings; the runtime types share via Arc once
    27	//!   inside the workbook.
    28	//! - `ValueWire` and `NamedTargetWire` are reused from
    29	//!   `ql_io::qbook_format` (Phase 2A.8 shipped them). Sharing the
    30	//!   serialization vocabulary across the engine's three persistence
    31	//!   surfaces (qbook envelope, qbook JSONL, op log) prevents wire-format
    32	//!   drift.
    33	
    34	use serde::{Deserialize, Serialize};
    35	
    36	use crate::wire::{CellWireValue, NamedTargetWire};
    37	use ql_types::{ColId, RowId, SheetId};
    38	
    39	/// A mutation operation recordable in the op log.
    40	#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    41	#[serde(deny_unknown_fields, tag = "kind")]
    42	#[non_exhaustive]
    43	pub enum Op {
    44	    /// Single literal cell write. Mirrors `WorkbookRuntime::set_value`.
    45	    PutValue {
    46	        sheet: SheetId,
    47	        row: RowId,
    48	        col: ColId,
    49	        value: CellWireValue,
    50	    },
    51	
    52	    /// Single formula write (text only — replay re-evaluates via the
    53	    /// caller's `WorkbookRuntime::recompute_all`, not via replay itself).
    54	    /// Mirrors `WorkbookRuntime::set_formula` for the persistence side.
    55	    PutFormula {
    56	        sheet: SheetId,
    57	        row: RowId,
    58	        col: ColId,
    59	        text: String,
    60	    },
    61	
    62	    /// Remove formula association at a cell (cell becomes literal-only).
    63	    /// Mirrors `Workbook::clear_formula`.
    64	    ClearFormula {
    65	        sheet: SheetId,
    66	        row: RowId,
    67	        col: ColId,
    68	    },
    69	
    70	    /// Register a defined name. Mirrors `Workbook::set_name` when
    71	    /// `scope` is `None`, and `Sheet::set_scoped_name` when `scope` is
    72	    /// `Some(sheet_id)`. **W5-92 (Phase 4.6.D)** added the optional
    73	    /// `scope` field per design doc § 8.2 / Codex MEDIUM-4: a single
    74	    /// op variant covers both scopes rather than two separate ops.
    75	    ///
    76	    /// Wire compat: `#[serde(default, skip_serializing_if = "Option::is_none")]`
    77	    /// keeps v3+old ops deserializing unchanged (missing field → `None`
    78	    /// = workbook scope, the historical behavior). Sheet-scoped names
    79	    /// emit the field; workbook-scoped names omit it.
    80	    ///
    81	    /// Replay: routes to `Workbook::set_name` (scope `None`) or
    82	    /// `Sheet::set_scoped_name` (scope `Some`); reserved-name refusal
    83	    /// surfaces as `ReplayError::NameRejected` in either path. A
    84	    /// `scope: Some(id)` referencing an unknown sheet surfaces as
    85	    /// `ReplayError::InvalidSheet`.
    86	    SetName {
    87	        #[serde(default, skip_serializing_if = "Option::is_none")]
    88	        scope: Option<SheetId>,
    89	        name: String,
    90	        target: NamedTargetWire,
    91	    },
    92	
    93	    /// Create a new sheet. Mirrors `Workbook::add_sheet_with_chunk_rows`.
    94	    /// Sheet IDs are deterministic (the workbook assigns them in append
    95	    /// order); the producer doesn't pin the ID in the op, since replay
    96	    /// against an empty workbook produces the same sequence.
    97	    AddSheet { name: String, chunk_rows: u32 },
    98	
    99	    /// **W5-91 (Phase 4.6.C):** rename an existing sheet by id. Mirrors
   100	    /// `Workbook::rename_sheet`. Carries `old_name` for replay-time
   101	    /// validation (snapshot-vs-replay reconciliation: if the snapshot
   102	    /// already has the new name, replay no-ops gracefully when current
   103	    /// canonical matches the new name). Per design doc § 3.1, the
   104	    /// producer-side runtime rewrites all stored formula text BEFORE
   105	    /// emitting this op (and emits `Op::PutFormula` ops for each
   106	    /// rewritten cell in the same BatchCommit), so replay-on-top-of-
   107	    /// snapshot OR replay-from-empty both produce correct state.
   108	    RenameSheet {
   109	        id: SheetId,
   110	        old_name: String,
   111	        new_name: String,
   112	    },
   113	
   114	    /// Register a format string at a specific id. Mirrors
   115	    /// `FormatTable::register_at`. Emitted when
   116	    /// `WorkbookRuntime::intern_format` allocates a NEW id; idempotent
   117	    /// on replay (re-registering an existing id with the same string
   118	    /// is a no-op). Re-registering at the same id with a DIFFERENT
   119	    /// string fails at `FormatTable::register_at` and surfaces as
   120	    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
   121	    ///
   122	    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from `u32`
   123	    /// to [`crate::wire::FormatIdWire`] (tagged tuple `Builtin(u32)` /
   124	    /// `Custom(PeerId, u32)`). The `from_u32_legacy` migration helper
   125	    /// converts pre-5.2 saves to the new shape at envelope-load time
   126	    /// (step 5).
   127	    RegisterFormat {
   128	        id: crate::wire::FormatIdWire,
   129	        string: String,
   130	    },
   131	
   132	    /// Set or clear a cell's format id. Mirrors
   133	    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
   134	    /// (when `id` is `None`). The id MUST resolve in the workbook's
   135	    /// `FormatTable` at replay time; an unknown id surfaces as
   136	    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
   137	    ///
   138	    /// **Phase 5.2 D-1 step 4 (2026-05-20):** `id` changed from
   139	    /// `Option<u32>` to `Option<FormatIdWire>`.
   140	    SetCellFormat {
   141	        sheet: SheetId,
   142	        row: RowId,
   143	        col: ColId,
   144	        /// `None` ⇒ clear the overlay entry (cell falls back to General).
   145	        /// `Some(id)` ⇒ bind the cell to that format id.
   146	        id: Option<crate::wire::FormatIdWire>,
   147	    },
   148	
   149	    /// One transaction's ops applied atomically at replay time. Produced
   150	    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
   151	    /// inner op in order; on failure, replay reports the inner op's
   152	    /// index relative to the BatchCommit's parent index. No implicit
   153	    /// rollback at replay (commits are committed).
   154	    ///
   155	    /// Nested BatchCommits are permitted by the schema but produced
   156	    /// nowhere in production; replay handles them via recursion.
   157	    BatchCommit { ops: Vec<Op> },
   158	
   159	    /// **W5-118 (Phase 4.8.H):** create a workbook-scoped table.
   160	    /// Mirrors `WorkbookRuntime::create_table`. Replay inserts the
   161	    /// table into `Workbook::tables_mut()` after validating the same
   162	    /// invariants as the producer-side (non-overlapping footprint,
   163	    /// non-empty unique column names, table-name uniqueness against
   164	    /// both `TableTable` and `NameTable`).
   165	    ///
   166	    /// Column ids are NOT serialized — replay allocates fresh ids from
   167	    /// the workbook's `next_column_id` counter, matching producer-side
   168	    /// allocation order (deterministic if the op log is replayed in
   169	    /// order).
   170	    CreateTable {
   171	        name: String,
   172	        sheet: SheetId,
   173	        top_row: RowId,
   174	        top_col: ColId,
   175	        rows: u32,
   176	        cols: u32,
   177	        has_header: bool,
   178	        has_totals: bool,
   179	        column_names: Vec<String>,
   180	    },
   181	
   182	    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
   183	    /// the table footprint are untouched. Formulas referencing the
   184	    /// dropped table re-bind to `BindError::UnknownTable` on next
   185	    /// recompute. Mirrors `WorkbookRuntime::drop_table`.
   186	    DropTable { name: String },
   187	
   188	    /// **W5-119 (Phase 4.8.I):** rename a table.
   189	    ///
   190	    /// Producer side ALSO rewrites stored formula text (Excel canon —
   191	    /// per design § 12.2). The op carries `old_name` so replay can
   192	    /// re-key the `TableTable` entry; producer-side formula-text
   193	    /// rewrites land as accompanying `Op::PutFormula` entries in the
   194	    /// same op-log sequence (no `BatchCommit` wrapper today; relies on
   195	    /// replay-order determinism).
   196	    ///
   197	    /// Replay validates: target name available (NameTable + TableTable),
   198	    /// source name exists. Sheet-scoped names use the workbook's
   199	    /// shared canonical namespace.
   200	    RenameTable { old_name: String, new_name: String },
   201	
   202	    /// **W5-121 (Phase 4.8.I.2):** rename a single column within a table.
   203	    ///
   204	    /// Producer side ALSO rewrites stored formula text in every cell
   205	    /// referencing the renamed column (Excel canon — same semantic as
   206	    /// `RenameTable`). The op carries `table` (canonical uppercase) so
   207	    /// replay can locate the table; `old_name` and `new_name` are case-
   208	    /// preserving identifiers (replay matches `old_name` case-
   209	    /// insensitively against `TableColumn::name`, which is stored
   210	    /// lowercase-canonical). Producer-side formula-text rewrites land as
   211	    /// accompanying `Op::PutFormula` entries in the same op-log sequence.
   212	    ///
   213	    /// Replay validates: target table exists, source column exists,
   214	    /// target column name available within the table (case-insensitive).
   215	    /// Same-canonical rename is rejected at producer side (returns
   216	    /// `Ok(0)` no-op without emitting); replay treats receipt of a
   217	    /// same-canonical op as a divergence and rejects.
   218	    RenameColumn {
   219	        table: String,
   220	        old_name: String,
   221	        new_name: String,
   222	    },
   223	
   224	    /// **W5-122 (Phase 4.8.J):** resize a table's footprint.
   225	    ///
   226	    /// Three scenarios (per design § 12.3):
   227	    /// - Grow/shrink rows: change `new_rows`; `added_columns` and
   228	    ///   `removed_columns` both empty.
   229	    /// - Append column(s) at the END: list each in `added_columns`.
   230	    /// - Truncate trailing column(s): list each in `removed_columns`
   231	    ///   in current left-to-right order.
   232	    ///
   233	    /// Inserting / removing a column in the MIDDLE is NOT supported in
   234	    /// 4.8 (Phase 5 structural edits — requires physical cell move).
   235	    ///
   236	    /// **Arithmetic invariant**: `new_cols == old_cols +
   237	    /// added_columns.len() - removed_columns.len()`. Producer + replay
   238	    /// both validate.
   239	    ///
   240	    /// **Column ids are NOT serialized** (same pattern as `CreateTable`)
   241	    /// — replay allocates fresh ids from the workbook's
   242	    /// `next_column_id` counter for each entry in `added_columns`,
   243	    /// matching producer-side allocation order.
   244	    ///
   245	    /// Replay validates: target table exists; arithmetic matches;

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '160,210p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   160	                scope,
   161	                name,
   162	                target,
   163	            } => {
   164	                let t = target.to_target(name).unwrap();
   165	                match scope {
   166	                    None => {
   167	                        wb.set_name(name, t).unwrap();
   168	                    }
   169	                    Some(sheet) => {
   170	                        // W5-92 (Phase 4.6.D): sheet-scoped name; producer
   171	                        // mirrors replay by routing through Sheet::set_scoped_name.
   172	                        wb.sheet_mut(*sheet)
   173	                            .expect("producer-side sheet lookup must succeed")
   174	                            .set_scoped_name(name, t)
   175	                            .expect("producer-side set_scoped_name must succeed");
   176	                    }
   177	                }
   178	            }
   179	            Op::AddSheet { name, chunk_rows } => {
   180	                wb.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
   181	            }
   182	            Op::RenameSheet {
   183	                id,
   184	                old_name: _,
   185	                new_name,
   186	            } => {
   187	                // W5-91: producer side calls `Workbook::rename_sheet`
   188	                // directly here (the formula-text rewrite happens at the
   189	                // `WorkbookRuntime` layer, above the op-log boundary).
   190	                wb.rename_sheet(*id, new_name.clone())
   191	                    .expect("producer-side rename_sheet must succeed");
   192	            }
   193	            Op::RegisterFormat { id, string } => {
   194	                // Step 4: Op carries FormatIdWire directly. Convert
   195	                // to storage via `to_storage()`. Mirrors ql_oplog::replay.
   196	                wb.formats_mut()
   197	                    .register_at(id.to_storage(), string.as_str())
   198	                    .expect("producer-side register_at must succeed");
   199	            }
   200	            Op::SetCellFormat {
   201	                sheet,
   202	                row,
   203	                col,
   204	                id,
   205	            } => {
   206	                let s = wb.sheet_mut(*sheet).expect("sheet exists");
   207	                match id {
   208	                    Some(wire_id) => {
   209	                        s.format_overlay_mut().set(*row, *col, wire_id.to_storage());
   210	                    }

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/crdt-data-model.md | sed -n '300,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
nl: quantbook-engine/docs/crdt-data-model.md: No such file or directory

codex
The core replay change is exactly as described: `old_name` is no longer part of the branch condition, and only the canonical current-vs-new idempotency check remains. I’m now checking whether that relaxation interacts badly with merge ordering, target collisions, and the surrounding op vocabulary.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,280p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `OpLog` — Loro-backed append-only operation log.
     2	//!
     3	//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
     4	//! JSON-encoded strings inside a single Loro `LoroList` container named
     5	//! `"ops"`. Each `OpLog::append` call serializes the `Op`, pushes a string
     6	//! into the list, and commits the Loro doc.
     7	//!
     8	//! ## Why JSON-in-Loro
     9	//!
    10	//! Per Round 7 architectural lock T1-D05, Loro is reserved for the op log
    11	//! layer. Phase 2A.3.a aims for minimum viable scaffolding — full CRDT
    12	//! semantics (LoroMap-per-op with typed fields) is reserved for Phase 5+
    13	//! when inter-peer merging becomes load-bearing. The JSON layer is
    14	//! invisible to callers: they see typed `Op` values via `iter`.
    15	//!
    16	//! ## Persistence
    17	//!
    18	//! `export_bytes` produces a `Vec<u8>` via `ExportMode::Snapshot`. The
    19	//! resulting blob includes the full state plus history; **suitable for
    20	//! transport to other peers** (consumed by `merge_bytes` on the
    21	//! receiver). For `.qbook/oplog.bin` file persistence, the
    22	//! `ql_io::oplog_persistence` layer wraps this blob in a Quantlab
    23	//! header (Phase 5.2 D-1 step 7 — Tier D3: `OPLOG_MAGIC` + version u32).
    24	//! Do NOT write `export_bytes()` output directly to `oplog.bin`;
    25	//! use `save_workbook_with_oplog` instead.
    26	//!
    27	//! `import_bytes` reconstructs an `OpLog` from such a blob (raw Loro
    28	//! snapshot — the persistence layer strips the Quantlab header before
    29	//! calling this fn). The reader probes the `"ops"` LoroList; if absent
    30	//! (or the wrong shape), the import returns `OpLogError::SchemaMismatch`.
    31	
    32	use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
    33	
    34	use crate::error::OpLogError;
    35	use crate::op::Op;
    36	
    37	/// The Loro container name our ops live under. Hard-coded; Phase 5+
    38	/// CRDT-level refactoring may add more containers (versions, peer state,
    39	/// etc.) but `"ops"` is reserved.
    40	const OPS_CONTAINER: &str = "ops";
    41	
    42	/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
    43	/// ephemeral presence map (cursor + selection + typing indicator).
    44	/// Per the audit-closed Phase 5.1 design at
    45	/// `docs/architecture/crdt-data-model.md` § Presence container.
    46	/// Keys are peer-id strings; values are opaque JSON blobs (the
    47	/// typed `PresenceState` encoding lives in `ql_collab::presence`).
    48	const PRESENCE_CONTAINER: &str = "presence";
    49	
    50	/// **Phase 5.4 V1 (2026-05-19):** commit-origin tag for presence
    51	/// writes. `ql_collab::CollabSession` wires this to Loro's
    52	/// `UndoManager::add_exclude_origin_prefix` so cursor movements
    53	/// don't pollute the undo stack. Exported as `pub` so the higher-
    54	/// layer (ql-collab) can reference the same string constant.
    55	///
    56	/// **Reserved-namespace convention:** trailing `":"` so the prefix
    57	/// `presence:` only matches deliberately-namespaced origins (e.g.
    58	/// a future `presence:typing` would also be excluded; an
    59	/// independent `"presence-foo"` origin would NOT). This protects
    60	/// against accidental over-exclusion as more origins land
    61	/// (Codex+Opus 5.4 V1 audit findings A4/M5).
    62	pub const PRESENCE_COMMIT_ORIGIN: &str = "presence:";
    63	
    64	/// Append-only operation log backed by Loro.
    65	///
    66	/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
    67	/// to reconstruct from a persisted snapshot. Mutations go through `append`;
    68	/// reads through `iter` / `len` / `is_empty`.
    69	pub struct OpLog {
    70	    doc: LoroDoc,
    71	}
    72	
    73	impl std::fmt::Debug for OpLog {
    74	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    75	        f.debug_struct("OpLog")
    76	            .field("len", &self.len())
    77	            .field("doc", &"<LoroDoc>")
    78	            .finish()
    79	    }
    80	}
    81	
    82	impl Default for OpLog {
    83	    fn default() -> Self {
    84	        Self::new()
    85	    }
    86	}
    87	
    88	impl OpLog {
    89	    /// Construct an empty log.
    90	    pub fn new() -> Self {
    91	        Self {
    92	            doc: LoroDoc::new(),
    93	        }
    94	    }
    95	
    96	    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    97	    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    98	    /// underlying Loro doc.
    99	    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
   100	        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
   101	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   102	        list.push(LoroValue::from(json.as_str()))?;
   103	        self.doc.commit();
   104	        Ok(())
   105	    }
   106	
   107	    /// Iterate the log in append order. Each yielded item is a
   108	    /// `Result<Op, OpLogError>` — a deserialization failure yields
   109	    /// `Err(OpLogError::Deserialize { index, source })` and iteration
   110	    /// continues (no short-circuit). Callers wanting fail-fast can use
   111	    /// `iter().collect::<Result<Vec<_>, _>>()`.
   112	    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
   113	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   114	        let len = list.len();
   115	        (0..len).map(move |index| {
   116	            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
   117	                "ops LoroList lost an entry between len() and get()",
   118	            ))?;
   119	            let value = match entry {
   120	                ValueOrContainer::Value(v) => v,
   121	                ValueOrContainer::Container(_) => {
   122	                    return Err(OpLogError::SchemaMismatch(
   123	                        "ops LoroList holds a container; expected JSON-string values",
   124	                    ));
   125	                }
   126	            };
   127	            let s = match value {
   128	                LoroValue::String(s) => s,
   129	                _ => {
   130	                    return Err(OpLogError::SchemaMismatch(
   131	                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
   132	                    ));
   133	                }
   134	            };
   135	            serde_json::from_str::<Op>(&s)
   136	                .map_err(|source| OpLogError::Deserialize { index, source })
   137	        })
   138	    }
   139	
   140	    /// Number of ops currently visible in the `"ops"` LoroList.
   141	    ///
   142	    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
   143	    /// (was a cached `usize` field through 5.6). Codex 5.4 V1 audit
   144	    /// HIGH found the cache became stale after `loro::UndoManager`
   145	    /// retracted ops from the visible list. Returning Loro's
   146	    /// authoritative count is correct by construction; per-call
   147	    /// cost is one container handle lookup + a length read.
   148	    pub fn len(&self) -> usize {
   149	        self.doc.get_list(OPS_CONTAINER).len()
   150	    }
   151	
   152	    /// True iff `len() == 0`.
   153	    pub fn is_empty(&self) -> bool {
   154	        self.len() == 0
   155	    }
   156	
   157	    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
   158	    ///
   159	    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
   160	    /// to wire its stable `PeerId` through to Loro so concurrent
   161	    /// appends carry the right origin in the CRDT merge metadata.
   162	    ///
   163	    /// Loro takes `&self` (interior mutability), so this method is
   164	    /// `&self` too. Calling it twice with the same id leaves the
   165	    /// peer id unchanged but is NOT a strict no-op at Loro's
   166	    /// internal layer: Loro re-stores the atom and emits a
   167	    /// `peer_id_change_subs` notification each call. Avoid calling
   168	    /// repeatedly in hot paths.
   169	    ///
   170	    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
   171	    /// 1. NEVER reuse the same peer id across concurrent writers
   172	    ///    (multiple tabs / devices for the same user). Duplicate peer
   173	    ///    ids corrupt the document via conflicting OpIDs.
   174	    /// 2. Avoid pinning a peer id to a stable user/device identity
   175	    ///    unless you also enforce single-ownership locking. Prefer a
   176	    ///    per-process-random peer id.
   177	    /// 3. Setting peer id AFTER an import is safe — existing imported
   178	    ///    ops retain their original peer ids; only this log's future
   179	    ///    appends use the new id.
   180	    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
   181	    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
   182	    /// 5. **Phase 5.4 V1 (2026-05-19):** if a `loro::UndoManager`
   183	    ///    (constructed via [`new_undo_manager`]) is alive, Loro
   184	    ///    SILENTLY CLEARS its undo + redo stacks on the peer-id
   185	    ///    change (`loro-internal::undo:654-662`). Callers must
   186	    ///    treat post-construction peer-id changes as undo-stack-
   187	    ///    invalidating events.
   188	    ///
   189	    /// Signature note: `&mut self` (Phase 5.4 V1 audit closure)
   190	    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
   191	    /// `&mut` prevents accidental peer-id changes through a shared
   192	    /// `&OpLog` (`CollabSession::op_log()`) which would silently
   193	    /// clear an attached `UndoManager`'s stacks per pitfall 5.
   194	    ///
   195	    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
   196	    /// 2026-05-20):** asserts `peer != 0`. PeerId(0) is `LEGACY_PEER`
   197	    /// — reserved as the sentinel for pre-collab single-writer +
   198	    /// qbook envelope migration. An active session whose Loro peer
   199	    /// id is 0 would silently collide with the LEGACY_PEER semantic
   200	    /// in `FormatTable::with_peer(LEGACY_PEER)` (the cross-peer
   201	    /// same-string design assumes LEGACY_PEER is sentinel-only).
   202	    /// `CollabSession::new` + `from_snapshot` already assert this at
   203	    /// the higher level; this guard catches direct callers of
   204	    /// `OpLog::set_peer_id` that bypass the CollabSession constructor.
   205	    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
   206	        assert_ne!(
   207	            peer, 0,
   208	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   209	             OpLog::set_peer_id must be called with a non-zero peer; collides with LEGACY_PEER otherwise."
   210	        );
   211	        self.doc.set_peer_id(peer)?;
   212	        Ok(())
   213	    }
   214	
   215	    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
   216	    pub fn peer_id(&self) -> u64 {
   217	        self.doc.peer_id()
   218	    }
   219	
   220	    /// **Phase 5.6 (2026-05-19):** write the given peer's presence blob
   221	    /// into the `"presence"` LoroMap.
   222	    ///
   223	    /// `peer_key` is a string identifier (typically the 16-hex form of
   224	    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
   225	    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
   226	    /// This layer doesn't interpret the bytes.
   227	    ///
   228	    /// LWW semantics per peer: a later `presence_set` for the same
   229	    /// `peer_key` from any peer (including the same peer in a different
   230	    /// session) replaces the previous value at merge time. Concurrent
   231	    /// `presence_set` calls for DIFFERENT `peer_key`s are independent
   232	    /// and both survive merge.
   233	    ///
   234	    /// Triggers `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so
   235	    /// the write is durable through `export_bytes` / `merge_bytes`
   236	    /// immediately AND is excluded from `UndoManager` (Phase 5.4
   237	    /// V1 wires `add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`).
   238	    pub fn presence_set(&mut self, peer_key: &str, json: &str) -> Result<(), OpLogError> {
   239	        let map = self.doc.get_map(PRESENCE_CONTAINER);
   240	        map.insert(peer_key, LoroValue::from(json))?;
   241	        self.doc
   242	            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
   243	        Ok(())
   244	    }
   245	
   246	    /// **Phase 5.6 (2026-05-19):** read the given peer's presence blob.
   247	    /// Returns `None` if the peer has no presence entry.
   248	    ///
   249	    /// Surfaces `OpLogError::SchemaMismatch` if the `"presence"` map
   250	    /// holds a non-string or container value at `peer_key` (only
   251	    /// reachable if a future writer puts wrong-shape data into the
   252	    /// container; current API only writes strings).
   253	    pub fn presence_get(&self, peer_key: &str) -> Result<Option<String>, OpLogError> {
   254	        let map = self.doc.get_map(PRESENCE_CONTAINER);
   255	        let Some(entry) = map.get(peer_key) else {
   256	            return Ok(None);
   257	        };
   258	        let value = match entry {
   259	            ValueOrContainer::Value(v) => v,
   260	            ValueOrContainer::Container(_) => {
   261	                return Err(OpLogError::SchemaMismatch(
   262	                    "presence LoroMap holds a container value; expected JSON string",
   263	                ));
   264	            }
   265	        };
   266	        match value {
   267	            LoroValue::String(s) => Ok(Some(s.to_string())),
   268	            _ => Err(OpLogError::SchemaMismatch(
   269	                "presence LoroMap holds a non-string LoroValue; expected JSON string",
   270	            )),
   271	        }
   272	    }
   273	
   274	    /// **Phase 5.6 (2026-05-19):** remove the given peer's presence
   275	    /// entry. Idempotent — deleting a non-existent key is a no-op
   276	    /// (Loro returns Ok). Triggers
   277	    /// `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so the
   278	    /// tombstone propagates AND is excluded from undo.
   279	    pub fn presence_remove(&mut self, peer_key: &str) -> Result<(), OpLogError> {
   280	        let map = self.doc.get_map(PRESENCE_CONTAINER);

exec
/bin/zsh -lc "rg -n \"fn replay_into|for .*ops|iter\\(|export_bytes|merge_bytes|set_peer_id|Loro|oplog\" quantbook-engine/crates/ql-oplog/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:346:pub fn replay_into(
quantbook-engine/crates/ql-oplog/src/replay.rs:352:    for (index, op_result) in log.iter().enumerate() {
quantbook-engine/crates/ql-oplog/src/replay.rs:361:/// the synthetic position of the enclosing BatchCommit for nested ops —
quantbook-engine/crates/ql-oplog/src/replay.rs:524:            //          name converges deterministically because Loro's
quantbook-engine/crates/ql-oplog/src/replay.rs:537:            //     unchanged). Loro's causal order should not produce this
quantbook-engine/crates/ql-oplog/src/replay.rs:625:            for inner_op in ops {
quantbook-engine/crates/ql-oplog/src/replay.rs:863:                .iter()
quantbook-engine/crates/ql-oplog/src/replay.rs:906:    for (i, expected) in removed_columns.iter().enumerate() {
quantbook-engine/crates/ql-oplog/src/replay.rs:917:    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/crates/ql-oplog/src/replay.rs:926:        .iter()
quantbook-engine/crates/ql-oplog/src/replay.rs:995:    for (cn, id) in added_columns.iter().zip(new_ids) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1047:    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1116:        .iter()
quantbook-engine/crates/ql-oplog/src/wire.rs:5://! `ql-oplog` so `ql-oplog::Op` no longer depends on `ql-io`. Phase 5
quantbook-engine/crates/ql-oplog/src/wire.rs:6://! CRDT integration wants `ql-oplog` as a dependency floor; this move
quantbook-engine/crates/ql-oplog/src/wire.rs:7://! inverts the prior `ql-oplog → ql-io` dependency.
quantbook-engine/crates/ql-oplog/src/wire.rs:22://!   `ql-oplog` so `CellWireValue::to_value` and
quantbook-engine/crates/ql-oplog/src/wire.rs:41:/// small `ql-oplog`-owned error type so wire decoders don't reach into
quantbook-engine/crates/ql-oplog/src/wire.rs:78:/// here in `ql-oplog`.
quantbook-engine/crates/ql-oplog/src/wire.rs:386:    //!   over future Loro/serde upgrades).
quantbook-engine/crates/ql-oplog/src/wire.rs:499:        // serde_json::to_string into Loro's LoroList values), not
quantbook-engine/crates/ql-oplog/src/wire.rs:500:        // bincode or LoroValue's native binary format.
quantbook-engine/crates/ql-oplog/src/lib.rs:1://! `ql-oplog` — Loro-backed operation log for the Quantbook engine.
quantbook-engine/crates/ql-oplog/src/lib.rs:4://! T1-D05, Loro is reserved for the op log layer only — no other crate
quantbook-engine/crates/ql-oplog/src/lib.rs:6://! 5+ multi-user work; Phase 2A.3 uses Loro as the persistence + future-
quantbook-engine/crates/ql-oplog/src/lib.rs:14://!   `export_bytes`, `import_bytes`.
quantbook-engine/crates/ql-oplog/src/lib.rs:22://! commit) adds `oplog.bin` persistence alongside the `.qbook/` envelope
quantbook-engine/crates/ql-oplog/src/lib.rs:23://! via [`persistence::save_workbook_with_oplog`] /
quantbook-engine/crates/ql-oplog/src/lib.rs:24://! [`persistence::load_workbook_with_oplog`].
quantbook-engine/crates/ql-oplog/src/lib.rs:51:// for ergonomics. PeerId lived briefly at `ql_oplog::PeerId` in step 1
quantbook-engine/crates/ql-oplog/src/lib.rs:54:// reference a type living in `ql-oplog` because `ql-oplog` already
quantbook-engine/crates/ql-oplog/src/lib.rs:56:// dependency floor); `ql-oplog` re-exports for back-compat so callers
quantbook-engine/crates/ql-oplog/src/lib.rs:58:// ql-oplog for `Op` + `OpLog`) can keep using a single import line.
quantbook-engine/crates/ql-oplog/src/lib.rs:62:// `persistence` module (save_workbook_with_oplog / load_workbook_with_oplog
quantbook-engine/crates/ql-oplog/src/lib.rs:63:// / PersistenceError) moved to `ql-io::oplog_persistence`. The move
quantbook-engine/crates/ql-oplog/src/lib.rs:64:// inverts the prior `ql-oplog → ql-io` dependency so Phase 5 CRDT
quantbook-engine/crates/ql-oplog/src/lib.rs:65:// integration sees `ql-oplog` as a dependency floor.
quantbook-engine/crates/ql-oplog/src/lib.rs:67:// External callers that previously imported `ql_oplog::save_workbook_with_oplog`
quantbook-engine/crates/ql-oplog/src/lib.rs:69:// unchanged: `oplog.bin` sidecar inside `.qbook/` directories.
quantbook-engine/crates/ql-oplog/src/log.rs:1://! `OpLog` — Loro-backed append-only operation log.
quantbook-engine/crates/ql-oplog/src/log.rs:4://! JSON-encoded strings inside a single Loro `LoroList` container named
quantbook-engine/crates/ql-oplog/src/log.rs:6://! into the list, and commits the Loro doc.
quantbook-engine/crates/ql-oplog/src/log.rs:8://! ## Why JSON-in-Loro
quantbook-engine/crates/ql-oplog/src/log.rs:10://! Per Round 7 architectural lock T1-D05, Loro is reserved for the op log
quantbook-engine/crates/ql-oplog/src/log.rs:12://! semantics (LoroMap-per-op with typed fields) is reserved for Phase 5+
quantbook-engine/crates/ql-oplog/src/log.rs:18://! `export_bytes` produces a `Vec<u8>` via `ExportMode::Snapshot`. The
quantbook-engine/crates/ql-oplog/src/log.rs:20://! transport to other peers** (consumed by `merge_bytes` on the
quantbook-engine/crates/ql-oplog/src/log.rs:21://! receiver). For `.qbook/oplog.bin` file persistence, the
quantbook-engine/crates/ql-oplog/src/log.rs:22://! `ql_io::oplog_persistence` layer wraps this blob in a Quantlab
quantbook-engine/crates/ql-oplog/src/log.rs:24://! Do NOT write `export_bytes()` output directly to `oplog.bin`;
quantbook-engine/crates/ql-oplog/src/log.rs:25://! use `save_workbook_with_oplog` instead.
quantbook-engine/crates/ql-oplog/src/log.rs:27://! `import_bytes` reconstructs an `OpLog` from such a blob (raw Loro
quantbook-engine/crates/ql-oplog/src/log.rs:29://! calling this fn). The reader probes the `"ops"` LoroList; if absent
quantbook-engine/crates/ql-oplog/src/log.rs:32:use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
quantbook-engine/crates/ql-oplog/src/log.rs:37:/// The Loro container name our ops live under. Hard-coded; Phase 5+
quantbook-engine/crates/ql-oplog/src/log.rs:42:/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
quantbook-engine/crates/ql-oplog/src/log.rs:51:/// writes. `ql_collab::CollabSession` wires this to Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:64:/// Append-only operation log backed by Loro.
quantbook-engine/crates/ql-oplog/src/log.rs:70:    doc: LoroDoc,
quantbook-engine/crates/ql-oplog/src/log.rs:77:            .field("doc", &"<LoroDoc>")
quantbook-engine/crates/ql-oplog/src/log.rs:92:            doc: LoroDoc::new(),
quantbook-engine/crates/ql-oplog/src/log.rs:97:    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
quantbook-engine/crates/ql-oplog/src/log.rs:98:    /// underlying Loro doc.
quantbook-engine/crates/ql-oplog/src/log.rs:101:        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:102:        list.push(LoroValue::from(json.as_str()))?;
quantbook-engine/crates/ql-oplog/src/log.rs:111:    /// `iter().collect::<Result<Vec<_>, _>>()`.
quantbook-engine/crates/ql-oplog/src/log.rs:112:    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
quantbook-engine/crates/ql-oplog/src/log.rs:113:        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:117:                "ops LoroList lost an entry between len() and get()",
quantbook-engine/crates/ql-oplog/src/log.rs:123:                        "ops LoroList holds a container; expected JSON-string values",
quantbook-engine/crates/ql-oplog/src/log.rs:128:                LoroValue::String(s) => s,
quantbook-engine/crates/ql-oplog/src/log.rs:131:                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
quantbook-engine/crates/ql-oplog/src/log.rs:140:    /// Number of ops currently visible in the `"ops"` LoroList.
quantbook-engine/crates/ql-oplog/src/log.rs:142:    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
quantbook-engine/crates/ql-oplog/src/log.rs:145:    /// retracted ops from the visible list. Returning Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:157:    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
quantbook-engine/crates/ql-oplog/src/log.rs:159:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:160:    /// to wire its stable `PeerId` through to Loro so concurrent
quantbook-engine/crates/ql-oplog/src/log.rs:163:    /// Loro takes `&self` (interior mutability), so this method is
quantbook-engine/crates/ql-oplog/src/log.rs:165:    /// peer id unchanged but is NOT a strict no-op at Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:166:    /// internal layer: Loro re-stores the atom and emits a
quantbook-engine/crates/ql-oplog/src/log.rs:170:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
quantbook-engine/crates/ql-oplog/src/log.rs:180:    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
quantbook-engine/crates/ql-oplog/src/log.rs:181:    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
quantbook-engine/crates/ql-oplog/src/log.rs:183:    ///    (constructed via [`new_undo_manager`]) is alive, Loro
quantbook-engine/crates/ql-oplog/src/log.rs:190:    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
quantbook-engine/crates/ql-oplog/src/log.rs:198:    /// qbook envelope migration. An active session whose Loro peer
quantbook-engine/crates/ql-oplog/src/log.rs:204:    /// `OpLog::set_peer_id` that bypass the CollabSession constructor.
quantbook-engine/crates/ql-oplog/src/log.rs:205:    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:209:             OpLog::set_peer_id must be called with a non-zero peer; collides with LEGACY_PEER otherwise."
quantbook-engine/crates/ql-oplog/src/log.rs:211:        self.doc.set_peer_id(peer)?;
quantbook-engine/crates/ql-oplog/src/log.rs:215:    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
quantbook-engine/crates/ql-oplog/src/log.rs:221:    /// into the `"presence"` LoroMap.
quantbook-engine/crates/ql-oplog/src/log.rs:235:    /// the write is durable through `export_bytes` / `merge_bytes`
quantbook-engine/crates/ql-oplog/src/log.rs:240:        map.insert(peer_key, LoroValue::from(json))?;
quantbook-engine/crates/ql-oplog/src/log.rs:262:                    "presence LoroMap holds a container value; expected JSON string",
quantbook-engine/crates/ql-oplog/src/log.rs:267:            LoroValue::String(s) => Ok(Some(s.to_string())),
quantbook-engine/crates/ql-oplog/src/log.rs:269:                "presence LoroMap holds a non-string LoroValue; expected JSON string",
quantbook-engine/crates/ql-oplog/src/log.rs:276:    /// (Loro returns Ok). Triggers
quantbook-engine/crates/ql-oplog/src/log.rs:287:    /// **Phase 5.4 V1 (2026-05-19):** construct a Loro `UndoManager`
quantbook-engine/crates/ql-oplog/src/log.rs:288:    /// bound to this log's underlying `LoroDoc`.
quantbook-engine/crates/ql-oplog/src/log.rs:290:    /// Per Loro 1.12.0 docs (`lib.rs:3708`):
quantbook-engine/crates/ql-oplog/src/log.rs:296:    /// Callers MUST construct the manager AFTER `set_peer_id` and
quantbook-engine/crates/ql-oplog/src/log.rs:313:    /// Order is Loro's iteration order (not stable across versions).
quantbook-engine/crates/ql-oplog/src/log.rs:323:    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
quantbook-engine/crates/ql-oplog/src/log.rs:325:    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:332:    /// (Loro creates absent root containers on first access).
quantbook-engine/crates/ql-oplog/src/log.rs:334:        let doc = LoroDoc::new();
quantbook-engine/crates/ql-oplog/src/log.rs:340:    /// into this log via Loro's CRDT merge. Concurrent appends to
quantbook-engine/crates/ql-oplog/src/log.rs:341:    /// the `"ops"` LoroList are preserved in deterministic causal
quantbook-engine/crates/ql-oplog/src/log.rs:348:    /// 3. Peer A exports its current state via `export_bytes`.
quantbook-engine/crates/ql-oplog/src/log.rs:349:    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
quantbook-engine/crates/ql-oplog/src/log.rs:356:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:381:        assert!(log.iter().next().is_none());
quantbook-engine/crates/ql-oplog/src/log.rs:390:        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:433:        for op in &ops {
quantbook-engine/crates/ql-oplog/src/log.rs:437:        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:459:        for op in &ops {
quantbook-engine/crates/ql-oplog/src/log.rs:462:        let bytes = log.export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:465:        let read: Vec<Op> = restored.iter().collect::<Result<_, _>>().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:472:        let bytes = original.export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:483:            matches!(result, Err(OpLogError::Loro(_))),
quantbook-engine/crates/ql-oplog/src/log.rs:484:            "expected Loro error for garbage bytes, got {result:?}"
quantbook-engine/crates/ql-oplog/src/log.rs:489:    fn set_peer_id_changes_doc_peer_id() {
quantbook-engine/crates/ql-oplog/src/log.rs:492:        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:494:        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
quantbook-engine/crates/ql-oplog/src/log.rs:498:    fn set_peer_id_after_import_works() {
quantbook-engine/crates/ql-oplog/src/log.rs:501:        origin.set_peer_id(11).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:507:        let bytes = origin.export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:511:        reborn.set_peer_id(22).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:515:        let read: Vec<Op> = reborn.iter().collect::<Result<_, _>>().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:561:        let bytes = log.export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:573:        // surviving value at merge time (LoroMap LWW by Lamport
quantbook-engine/crates/ql-oplog/src/log.rs:574:        // then peer id). Pin the behavior so a future Loro upgrade
quantbook-engine/crates/ql-oplog/src/log.rs:582:        base.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:583:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:586:        peer_a.set_peer_id(10).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:592:        peer_b.set_peer_id(20).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:598:        peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:632:    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
quantbook-engine/crates/ql-oplog/src/log.rs:633:        // Loro 1.12.0 reserves u64::MAX as an internal sentinel
quantbook-engine/crates/ql-oplog/src/log.rs:634:        // (`LoroError::InvalidPeerID`). Pin the rejection behavior so
quantbook-engine/crates/ql-oplog/src/log.rs:635:        // a future Loro upgrade can't silently change it.
quantbook-engine/crates/ql-oplog/src/log.rs:637:        let result = log.set_peer_id(u64::MAX);
quantbook-engine/crates/ql-oplog/src/log.rs:639:            matches!(result, Err(OpLogError::Loro(_))),
quantbook-engine/crates/ql-oplog/src/log.rs:640:            "u64::MAX must be rejected as a Loro sentinel; got {result:?}"
quantbook-engine/crates/ql-oplog/src/error.rs:12:/// 3. Loro's own export/import surface its own errors via `loro::LoroError`.
quantbook-engine/crates/ql-oplog/src/error.rs:22:    /// indicates a corrupted on-disk op-log (`oplog.bin`) or version
quantbook-engine/crates/ql-oplog/src/error.rs:31:    /// Wrapped Loro internal error (commit / import / container access).
quantbook-engine/crates/ql-oplog/src/error.rs:35:    Loro(#[from] loro::LoroError),
quantbook-engine/crates/ql-oplog/src/error.rs:37:    /// Wrapped Loro encode error (raised by `LoroDoc::export`). Distinct
quantbook-engine/crates/ql-oplog/src/error.rs:38:    /// from `LoroError` (decode) in Loro 1.12.0's API surface.
quantbook-engine/crates/ql-oplog/src/error.rs:40:    LoroEncode(#[from] loro::LoroEncodeError),
quantbook-engine/crates/ql-oplog/src/error.rs:42:    /// The op log's internal Loro shape doesn't match what we wrote. Fires

exec
/bin/zsh -lc "rg -n \"crdt-data-model|RenameSheet ×|RenameSheet|concurrent edit|conflict matrix|Phase 5.3\" -S quantbook-engine . -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/MASTER-PLAN.md:470:   - 4.6.C (W5-91) — `WorkbookRuntime::rename_sheet` + formula-text rewrite + `Op::RenameSheet` with 3-case replay reconciliation.
quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
quantbook-engine/docs/MASTER-PLAN.md:851:6. **What is the collaboration conflict policy for formula versus value concurrent edits?**  
quantbook-engine/docs/MASTER-PLAN.md:853:   Decide by Phase 5.3.
quantbook-engine/docs/architecture/crdt-data-model.md:77:- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/architecture/crdt-data-model.md:156:character-level concurrent edits) and harmful in others
quantbook-engine/docs/architecture/crdt-data-model.md:174:op came last. We do NOT show the user "two concurrent edits;
quantbook-engine/docs/architecture/crdt-data-model.md:303:   for every rewritten cell + the RenameSheet op). Per-cell
quantbook-engine/docs/architecture/crdt-data-model.md:308:character-level concurrent editing of one long formula) that
quantbook-engine/docs/architecture/crdt-data-model.md:311:## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/architecture/crdt-data-model.md:318:target. Phase 5.3 formalizes this with these defaults:
quantbook-engine/docs/architecture/crdt-data-model.md:328:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/architecture/crdt-data-model.md:329:| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/architecture/crdt-data-model.md:338:**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
quantbook-engine/docs/architecture/crdt-data-model.md:577:open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/architecture/crdt-data-model.md:624:deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/architecture/crdt-data-model.md:640:### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/architecture/crdt-data-model.md:642:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/architecture/crdt-data-model.md:665:shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/architecture/crdt-data-model.md:667:walks formulas added causally-before the RenameSheet op and
quantbook-engine/docs/architecture/crdt-data-model.md:677:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/architecture/crdt-data-model.md:734:   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/architecture/crdt-data-model.md:797:- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/known-gaps.md:113:| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/architecture/ide-consumer-contract.md:195:- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. Causality-aware rename-repair pass at merge time is deferred to Phase 5.3.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:5:**Status:** DESIGN (pre-implementation, Codex-reviewed). Implementation shipped Phase 4.5.D (W5-79 / W5-80 / W5-81). **PARTIALLY SUPERSEDED by D-1 (2026-05-19/20):** the § 7 `FormatTable` shape (`next_custom_id: u32`, single `by_string: HashMap<String, FormatId>`, no `local_peer`/`with_peer`/`set_local_peer`) and § 7.3 `Op::RegisterFormat { id: FormatId }` are pre-D-1 designs. Current post-D-1 shape: `FormatId` is a tagged enum `Builtin(u32) | Custom(PeerId, u32)`; `FormatTable` carries `local_peer: PeerId` + split `by_builtin_string` / `by_custom_string` ((peer, string)-keyed); ops carry `FormatIdWire`. See `docs/architecture/crdt-data-model.md` § D-1 and `docs/phase5/d-1-starting-checklist.md` for the current shape + audit-locked decisions.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:39:- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:69:`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }` — old_name carried so replay can validate against the workbook state at replay time without scanning prior ops. Replay calls `Workbook::rename_sheet(id, new_name)` which is idempotent given matching old/new.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:257:**`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }`** — per § 3.2. `old_name` carried for replay validation. Replay calls `Workbook::rename_sheet(id, new_name)`.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:263:- `ReplayError::SheetRenameUnknownSheet { id }` — `RenameSheet` references a sheet that wasn't created by earlier ops.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:309:### 10.3 Phase 4.6.C — Sheet rename + Op::RenameSheet
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:312:- New `WorkbookRuntime::rename_sheet` wrapper emitting `Op::RenameSheet`.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:369:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:382:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:416:- `Op::RenameSheet { old_name, new_name }` field choice — confirmed at § 3.2; revisit if collab/CRDT semantics (Phase 5) want a different shape.
quantbook-engine/docs/phase5/v1-exit-packet.md:21:`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
quantbook-engine/docs/phase5/v1-exit-packet.md:30:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
quantbook-engine/docs/phase5/v1-exit-packet.md:226:- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
quantbook-engine/docs/phase5/v1-exit-packet.md:228:  for concurrent edits to renamed sheets). 4-7 days estimated.
quantbook-engine/docs/phase5/v1-exit-packet.md:269:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/phase5/entry-plan.md:185:- `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:200:- ✅ M1 (doc drift, 5 sites): collab session.rs export_bytes/sweep_presence, presence.rs, oplog log.rs, crdt-data-model.md — all reframed for post-Tier-D3 file-vs-transport contract.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:222:- 5-site cross-crate doc drift fixes (`CollabSession::export_bytes` + `sweep_presence`, `presence.rs`, `oplog/log.rs`, `crdt-data-model.md`).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:240:- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.
quantbook-engine/docs/phase5/d-1-exit-packet.md:125:- Architecture: `docs/architecture/crdt-data-model.md` § D-1
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:485:    33	//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1410:   128	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1757:   455	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2951:   180	            Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3980:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4348:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:76:9. **Doc cross-references.** The d-1-checklist marks step 2 ✅ shipped. Are there other doc surfaces that mention `FormatIdWire` ahead of time (e.g. crdt-data-model.md § "D-1") that should be updated post-ship to point at the actual shipped type?
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:1454:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7325:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7329:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7342:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7354:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7359:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7400:quantbook-engine/docs/phase5/d-1-starting-checklist.md:163:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7408:quantbook-engine/docs/architecture/crdt-data-model.md:449:**Phase 5 V1 COMPLETE 2026-05-19. D-1 step 1.1 (2026-05-19) moved PeerId to `ql_types`.** Current 4-module surface (verified against `crates/ql-collab/src/lib.rs`):
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7409:quantbook-engine/docs/architecture/crdt-data-model.md:459:// PeerId lives in ql_types (D-1 step 1.1); re-exported through ql_oplog.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7410:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7411:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7412:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7413:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7414:quantbook-engine/docs/architecture/crdt-data-model.md:576:  `cellXfs` numFmtId mapping all change.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7415:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7416:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7417:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7418:quantbook-engine/docs/architecture/crdt-data-model.md:711:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7419:quantbook-engine/docs/architecture/crdt-data-model.md:713:   in Phase 5.2 D-1 (next-session multi-day arc; see
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7489:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7491:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7495:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7497:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7522:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7533:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7534:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7535:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7536:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7537:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7538:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7539:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7540:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7653:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7665:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7667:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7668:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7669:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7693:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7696:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7749:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7893:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:614:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7897:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:618:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7909:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:631:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7911:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:633:quantbook-engine/docs/architecture/crdt-data-model.md:541:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7912:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:634:quantbook-engine/docs/architecture/crdt-data-model.md:557:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7913:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:635:quantbook-engine/docs/architecture/crdt-data-model.md:561:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7914:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:637:quantbook-engine/docs/architecture/crdt-data-model.md:573:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7915:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:638:quantbook-engine/docs/architecture/crdt-data-model.md:578:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7916:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:639:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7917:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:640:quantbook-engine/docs/architecture/crdt-data-model.md:709:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7918:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:641:quantbook-engine/docs/architecture/crdt-data-model.md:710:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7919:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:643:quantbook-engine/docs/architecture/crdt-data-model.md:712:   in Phase 5.2 D-1 (next-session multi-day arc; see
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7930:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:655:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7935:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:662:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7972:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:700:quantbook-engine/docs/phase5/d-1-starting-checklist.md:153:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8356:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1251:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8358:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1253:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8362:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1257:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8364:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1259:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8389:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1334:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8400:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1345:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8401:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1346:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8402:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1347:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8403:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1348:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8404:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1349:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8405:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1350:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8406:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1351:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8407:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1352:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8437:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1382:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8448:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1395:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8450:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1397:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8451:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1398:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8452:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1400:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8475:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1426:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8478:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1429:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8888:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1854:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9271:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2424:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9282:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2437:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9287:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2444:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9323:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2481:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9349:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2508:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9351:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2510:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9352:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2511:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9353:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2512:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9354:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2513:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9355:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2514:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9356:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2515:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9357:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2516:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9358:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2517:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9359:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2518:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9378:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2540:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9746:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2912:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9753:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2924:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9758:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2929:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9789:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2966:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9791:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2968:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9795:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2972:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9797:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2974:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9801:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2984:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9804:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2992:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9814:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3711:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9819:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3733:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9857:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3858:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9999:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10001:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10005:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10007:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10032:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10043:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10044:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10045:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10046:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10047:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10048:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10049:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10050:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10147:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10409:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10411:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10634:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10645:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10650:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10687:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10714:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10716:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10717:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10718:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10719:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10720:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10721:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10722:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10723:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10724:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10744:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11324:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11333:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11347:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11415:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11417:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11421:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11423:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11427:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11430:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12276:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12374:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '532,592p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12393:   549	open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12439:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '704,716p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12443:   706	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13195:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13962:/bin/zsh -lc 'rg -n "from_storage|to_storage|FormatIdWire|FormatId" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13964:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13965:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13966:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13967:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13968:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13969:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13970:quantbook-engine/docs/architecture/crdt-data-model.md:711:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14084:Detail: The checklist marks step 2 shipped, but the commit line still says `pending`. `crdt-data-model.md` can remain overall “implementation pending” for D-1, but the checklist should point at `135bbb99f75` now.  
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14115:Detail: The checklist marks step 2 shipped, but the commit line still says `pending`. `crdt-data-model.md` can remain overall “implementation pending” for D-1, but the checklist should point at `135bbb99f75` now.  
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:83:D1. `crdt-data-model.md` § Undo/redo (Phase 5.4 preview, lines ~307-320) was written pre-implementation. Now that V1 ships, does it need a "✅ V1 shipped at 89c02b9d83e" marker?
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:412:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:841:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1071:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1138:    14	# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2134:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2135:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2136:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2137:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2138:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2139:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2152:quantbook-engine/crates/ql-collab/src/undo.rs:11://! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2276:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2277:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4390:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4391:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7880:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '300,360p;388,405p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7885:   303	character-level concurrent editing of one long formula) that
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7888:   306	## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7895:   313	target. Phase 5.3 formalizes this with these defaults:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7905:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7906:   324	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7995:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13046:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13068:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13103:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13125:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3476:crates/ql-oplog/src/replay.rs:119:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3488:crates/ql-oplog/src/replay.rs:381:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3531:crates/ql-oplog/src/replay.rs:1434:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3533:crates/ql-oplog/src/replay.rs:1445:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3534:crates/ql-oplog/src/replay.rs:1463:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3535:crates/ql-oplog/src/replay.rs:1481:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3536:crates/ql-oplog/src/replay.rs:1498:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3539:crates/ql-oplog/src/replay.rs:1526:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3545:crates/ql-oplog/src/replay.rs:1569:                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4625:crates/ql-oplog/tests/producer_replay_equivalence.rs:181:            Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4974:crates/ql-exec/src/workbook_runtime.rs:2201:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4983:crates/ql-exec/src/workbook_runtime.rs:2269:            ops.push(Op::RenameSheet {
./Charts/BUILD/Delta_V3_FINAL_Complete_Pack/delta_v3_docs/IMPLEMENTATION_PLAN.md:885:### Phase 5.3: Drawing Tools (Lines)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:20:- Doc drift across `crdt-data-model.md` / `entry-plan.md` / `known-gaps.md`.
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1172:crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:490:    21	+ Phase 5.3 conflict resolution + Phase 5.5 V2 V2/V3 (WebSocket /
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:499:    30	| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:697:   228	- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:699:   230	  for concurrent edits to renamed sheets). 4-7 days estimated.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:734:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '400,500p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:920:   185	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1055:quantbook-engine/docs/architecture/crdt-data-model.md:218:**Phase 5.6 V1 ✅ shipped at `c677e244704` (2026-05-19).**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1056:quantbook-engine/docs/architecture/crdt-data-model.md:221:during 5.6 V1 deviated from the pre-implementation "UUIDs"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1057:quantbook-engine/docs/architecture/crdt-data-model.md:261:**V2 ✅ shipped 2026-05-19:** `CollabSession::sweep_presence()`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1058:quantbook-engine/docs/architecture/crdt-data-model.md:354:### Wired surface (V1 + V2 V1)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1059:quantbook-engine/docs/architecture/crdt-data-model.md:361:- **V2 V1 (`6138a7203f6` + `e199a5fda5a`):**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1060:quantbook-engine/docs/architecture/crdt-data-model.md:365:- **V2 V1:** `set_undo_merge_interval(i64)` — auto-merge
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1061:quantbook-engine/docs/architecture/crdt-data-model.md:367:- **V2 V1.1:** `start_undo_group_scoped() -> Result<UndoGroupGuard<'_>, _>`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1062:quantbook-engine/docs/architecture/crdt-data-model.md:378:### V1 / V2 V1 limitations / V2 V2 follow-ups
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1063:quantbook-engine/docs/architecture/crdt-data-model.md:381:- ~~No RAII closure helper~~ — V2 V1.1 ships
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1064:quantbook-engine/docs/architecture/crdt-data-model.md:404:**V2 V1 ✅ shipped at `ffd8f6e5f05` (2026-05-19):**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1065:quantbook-engine/docs/architecture/crdt-data-model.md:421:`LoopbackTransport` + V2 V1's `attach_transport`/`flush`/`poll`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1066:quantbook-engine/docs/architecture/crdt-data-model.md:426:confirms the substrate works regardless; 5.5 V1 + V2 V1 prove
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1067:quantbook-engine/docs/architecture/crdt-data-model.md:465:- `presence` — Phase 5.6 cursor + selection map.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1070:quantbook-engine/docs/architecture/crdt-data-model.md:559:tagged tuple:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1075:quantbook-engine/docs/architecture/crdt-data-model.md:585:collaboration tooling wants. The tagged tuple gives the same
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1204:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1571:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '520,600p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1602:   549	open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1649:   596	deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1927:   575	   Acceptance: CON-5-01 formula/value concurrent edits deterministic; CON-5-02 sheet/name conflicts deterministic; CON-5-03 conflicts visible in IDE diagnostics.  
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2027:quantbook-engine/docs/MASTER-PLAN.md:864:   Decide by Phase 5.3.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2031:/bin/zsh -lc 'rg -n "docs/audits/2026-05-19|phase-5|tier-d1|exit-packet|d-1-starting" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2037:quantbook-engine/docs/architecture/crdt-data-model.md:10:  - docs/audits/2026-05-19-phase-5-1-codex.md
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2038:quantbook-engine/docs/architecture/crdt-data-model.md:11:  - docs/audits/2026-05-19-phase-5-1-opus.md
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2039:quantbook-engine/docs/architecture/crdt-data-model.md:12:  - docs/audits/2026-05-19-phase-5-1-consolidated.md
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2040:quantbook-engine/docs/architecture/crdt-data-model.md:530:- `docs/audits/2026-05-19-phase-5-1-codex.md`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2041:quantbook-engine/docs/architecture/crdt-data-model.md:531:- `docs/audits/2026-05-19-phase-5-1-opus.md`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2042:quantbook-engine/docs/architecture/crdt-data-model.md:532:- `docs/audits/2026-05-19-phase-5-1-consolidated.md`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2043:quantbook-engine/docs/architecture/crdt-data-model.md:539:The parallel Codex + Opus audit (transcripts in `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md`)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2044:quantbook-engine/docs/architecture/crdt-data-model.md:732:- `docs/audits/2026-05-19-phase-5-1-codex.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2045:quantbook-engine/docs/architecture/crdt-data-model.md:733:- `docs/audits/2026-05-19-phase-5-1-opus.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2046:quantbook-engine/docs/architecture/crdt-data-model.md:734:- `docs/audits/2026-05-19-phase-5-1-consolidated.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2072:quantbook-engine/docs/phase5/v1-exit-packet.md:30:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2452:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5693:   128	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6682:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:381:/bin/zsh -lc 'nl -ba docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6692:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6698:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1998:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6699:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2000:/bin/zsh -lc 'git ls-files --stage Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6705:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2104:/bin/zsh -lc 'git show 66a571b30af:docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6707:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2126:/bin/zsh -lc 'git show 66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6720:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3196:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6937:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6948:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6953:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2288:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7968:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7880:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '300,360p;388,405p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7976:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8442:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:334:/bin/zsh -lc "rg --files -g 'Cargo.toml' -g 'log.rs' -g 'session.rs' -g 'peer.rs' -g 'crdt-data-model.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8443:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:372:/bin/zsh -lc 'git diff --stat 687e5dd3995..HEAD && git diff --find-renames -- crates/ql-oplog/src/log.rs crates/ql-collab/src/session.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8546:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1367:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10801:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11143:/bin/zsh -lc 'rg -n "undo module|Reserved module|V2 V1|group_start|merge-interval|No grouping API|No merge-interval|start_undo_group|set_undo_merge_interval" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/crates/ql-collab/src/lib.rs quantbook-engine/crates/ql-collab/src/session.rs -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11119:quantbook-engine/docs/architecture/crdt-data-model.md:2:title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11120:quantbook-engine/docs/architecture/crdt-data-model.md:19:Lock the Loro container-shape decision for Phase 5 collaborative
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11121:quantbook-engine/docs/architecture/crdt-data-model.md:26:top of Loro CRDTs so that 2+ peers can edit concurrently and the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11122:quantbook-engine/docs/architecture/crdt-data-model.md:30:`LoroDoc`. The narrow question for 5.1 is whether to:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11123:quantbook-engine/docs/architecture/crdt-data-model.md:32:- **(A) Keep the op-log shape.** Op-list-in-Loro is already a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11124:quantbook-engine/docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11125:quantbook-engine/docs/architecture/crdt-data-model.md:36:- **(B) Re-shape state as typed Loro containers per feature.**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11126:quantbook-engine/docs/architecture/crdt-data-model.md:37:  Cells, names, sheets, tables, formats become LoroMap /
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11127:quantbook-engine/docs/architecture/crdt-data-model.md:38:  LoroList / LoroText containers directly. Merge semantics are
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11128:quantbook-engine/docs/architecture/crdt-data-model.md:42:  log; sheets list becomes a LoroMovableList; names become a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11129:quantbook-engine/docs/architecture/crdt-data-model.md:43:  LoroMap.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11130:quantbook-engine/docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11131:quantbook-engine/docs/architecture/crdt-data-model.md:59:    doc: LoroDoc,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11132:quantbook-engine/docs/architecture/crdt-data-model.md:64:- One `LoroDoc` per workbook.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11133:quantbook-engine/docs/architecture/crdt-data-model.md:65:- All ops live in a single `LoroList` named `"ops"`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11134:quantbook-engine/docs/architecture/crdt-data-model.md:67:  `LoroValue::String` into the list.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11135:quantbook-engine/docs/architecture/crdt-data-model.md:84:## How Loro behavior changes when peers exchange updates
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11136:quantbook-engine/docs/architecture/crdt-data-model.md:90:1. Each peer holds a `LoroDoc` representing the workbook.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11137:quantbook-engine/docs/architecture/crdt-data-model.md:91:2. Peers exchange `LoroDoc` updates via Loro's
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11138:quantbook-engine/docs/architecture/crdt-data-model.md:93:3. Loro merges concurrent `LoroList::push` operations by
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11139:quantbook-engine/docs/architecture/crdt-data-model.md:104:draft of this section claimed Loro's merge rule is "Lamport
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11140:quantbook-engine/docs/architecture/crdt-data-model.md:106:timestamps." Both descriptions were imprecise. The actual Loro
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11141:quantbook-engine/docs/architecture/crdt-data-model.md:116:for free from Loro + the engine's deterministic replay path
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11142:quantbook-engine/docs/architecture/crdt-data-model.md:117:(Phase 4); we do NOT get it from Loro alone choosing one push
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11143:quantbook-engine/docs/architecture/crdt-data-model.md:148:Loro's `LoroList` doesn't try to merge string contents. It
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11144:quantbook-engine/docs/architecture/crdt-data-model.md:153:If we used typed containers, we'd inherit Loro's
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11145:quantbook-engine/docs/architecture/crdt-data-model.md:154:per-container merge semantics — useful in some cases (LoroText
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11146:quantbook-engine/docs/architecture/crdt-data-model.md:157:(LoroMap merge for `name_table: LoroMap<String, NamedTarget>`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11147:quantbook-engine/docs/architecture/crdt-data-model.md:164:`LoroDoc::export(ExportMode::Snapshot)` already produces a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11148:quantbook-engine/docs/architecture/crdt-data-model.md:180:diagnostic by inspecting the Loro version vector at the LWW
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11149:quantbook-engine/docs/architecture/crdt-data-model.md:186:edit non-overlapping ranges. Loro merges the op list in O(n) on
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11150:quantbook-engine/docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11151:quantbook-engine/docs/architecture/crdt-data-model.md:197:### One `LoroDoc` per workbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11152:quantbook-engine/docs/architecture/crdt-data-model.md:199:Carry through from `ql-oplog`. Each workbook = one `LoroDoc`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11153:quantbook-engine/docs/architecture/crdt-data-model.md:201:(presence below).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11154:quantbook-engine/docs/architecture/crdt-data-model.md:203:### Persistent state container: `"ops"` LoroList
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11155:quantbook-engine/docs/architecture/crdt-data-model.md:209:LoroDoc
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11156:quantbook-engine/docs/architecture/crdt-data-model.md:210:└── LoroList "ops"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11157:quantbook-engine/docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11158:quantbook-engine/docs/architecture/crdt-data-model.md:222:language since PeerId is u64-native to match Loro's PeerID type);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11159:quantbook-engine/docs/architecture/crdt-data-model.md:227:LoroDoc
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11160:quantbook-engine/docs/architecture/crdt-data-model.md:228:├── LoroList "ops"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11161:quantbook-engine/docs/architecture/crdt-data-model.md:229:└── LoroMap "presence"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11162:quantbook-engine/docs/architecture/crdt-data-model.md:234:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11163:quantbook-engine/docs/architecture/crdt-data-model.md:240:  its own key. LoroMap LWW merge gives "last position update
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11164:quantbook-engine/docs/architecture/crdt-data-model.md:245:save/load." The V1 implementation persists presence *de facto*
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11165:quantbook-engine/docs/architecture/crdt-data-model.md:246:because it lives in the same `LoroDoc` as `"ops"`, and
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11167:quantbook-engine/docs/architecture/crdt-data-model.md:249:restore stale presence entries.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11168:quantbook-engine/docs/architecture/crdt-data-model.md:253:   own entry is overwritten on first `update_presence` call.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11169:quantbook-engine/docs/architecture/crdt-data-model.md:258:   (Loro doesn't expose this) or a load-time `presence_remove`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11170:quantbook-engine/docs/architecture/crdt-data-model.md:261:**V2 ✅ shipped 2026-05-19:** `CollabSession::sweep_presence()`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11171:quantbook-engine/docs/architecture/crdt-data-model.md:262:clears all presence entries (own + remote) and returns the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11172:quantbook-engine/docs/architecture/crdt-data-model.md:269:Earlier `clear_presence` (V1) remains for the "leave session"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11173:quantbook-engine/docs/architecture/crdt-data-model.md:272:### Snapshot container: `"snapshot"` LoroMap (reserved, V2)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11174:quantbook-engine/docs/architecture/crdt-data-model.md:276:version vector. Replay against a snapshot skips ops older than
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11175:quantbook-engine/docs/architecture/crdt-data-model.md:282:LoroDoc
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11176:quantbook-engine/docs/architecture/crdt-data-model.md:283:└── LoroMap "cells"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11177:quantbook-engine/docs/architecture/crdt-data-model.md:284:    ├── "0,0,0": LoroMap { value: ..., formula: ..., format_id: ... }
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11178:quantbook-engine/docs/architecture/crdt-data-model.md:285:    ├── "0,0,1": LoroMap { ... }
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11179:quantbook-engine/docs/architecture/crdt-data-model.md:293:   completing BEFORE set_value(target). Loro's per-container
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11180:quantbook-engine/docs/architecture/crdt-data-model.md:299:3. Loro overhead per container is non-trivial. 100k containers
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11181:quantbook-engine/docs/architecture/crdt-data-model.md:313:The 5.1 design picks Option A → conflicts resolve by Loro's
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11182:quantbook-engine/docs/architecture/crdt-data-model.md:339:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11183:quantbook-engine/docs/architecture/crdt-data-model.md:342:the visible `"ops"` LoroList — so `OpLog::len()` shrinks
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11184:quantbook-engine/docs/architecture/crdt-data-model.md:345:Loro neither physically removes nor tombstones — it composes
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11185:quantbook-engine/docs/architecture/crdt-data-model.md:373:Plus `pub use loro::UndoManager` in `ql_collab::undo` for
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11186:quantbook-engine/docs/architecture/crdt-data-model.md:375:(`PRESENCE_COMMIT_ORIGIN = "presence:"`) are auto-excluded so
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11187:quantbook-engine/docs/architecture/crdt-data-model.md:380:- No push/pop listeners (`UndoManager::set_on_push` / `set_on_pop`) — defer to V2 V2.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11188:quantbook-engine/docs/architecture/crdt-data-model.md:385:- `set_peer_id` after construction silently CLEARS the undo
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11189:quantbook-engine/docs/architecture/crdt-data-model.md:386:  stack per Loro's internal subscription. V1 made
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11190:quantbook-engine/docs/architecture/crdt-data-model.md:387:  `OpLog::set_peer_id` `&mut self` so the footgun isn't
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11191:quantbook-engine/docs/architecture/crdt-data-model.md:391:  `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11192:quantbook-engine/docs/architecture/crdt-data-model.md:411:Loro's wire format:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11193:quantbook-engine/docs/architecture/crdt-data-model.md:412:- `LoroDoc::export(ExportMode::Updates(version_vector))` →
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11194:quantbook-engine/docs/architecture/crdt-data-model.md:414:- `LoroDoc::import(bytes)` → merge into local doc.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11195:quantbook-engine/docs/architecture/crdt-data-model.md:417:transport version vector + send deltas, not full snapshots);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11198:quantbook-engine/docs/architecture/crdt-data-model.md:439:  workbook (no peer IDs, no presence).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11199:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11200:quantbook-engine/docs/architecture/crdt-data-model.md:465:- `presence` — Phase 5.6 cursor + selection map.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11201:quantbook-engine/docs/architecture/crdt-data-model.md:466:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11202:quantbook-engine/docs/architecture/crdt-data-model.md:488:closed by adding `OpLog::set_peer_id` and calling it from
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11203:quantbook-engine/docs/architecture/crdt-data-model.md:490:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11204:quantbook-engine/docs/architecture/crdt-data-model.md:492:pitfall (from Loro docs): concurrent sessions MUST use distinct peer
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11205:quantbook-engine/docs/architecture/crdt-data-model.md:649:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11206:quantbook-engine/docs/architecture/crdt-data-model.md:693:   Loro's default is per-doc random `u64`; Phase 5.2 wires
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11207:quantbook-engine/docs/architecture/crdt-data-model.md:699:   ONCE into the LoroList. A concurrent peer's op can land
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11208:quantbook-engine/docs/architecture/crdt-data-model.md:721:- `crates/ql-oplog/src/log.rs` (the existing LoroDoc wrapper).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11498:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:529:docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11500:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:531:docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11546:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:646:docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11558:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:658:docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11559:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11560:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:660:docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11561:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:661:docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11562:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:662:docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11563:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:663:docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11588:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:688:docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11606:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:706:docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11610:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:710:docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11614:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:958:docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11695:/bin/zsh -lc 'rg -o "`[0-9a-f]{10,12}`|[0-9a-f]{10,12}" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed '"'s/.*://; s/"'`//g'"' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11703:/bin/zsh -lc "setopt NO_NOMATCH; rg -o '[0-9a-f]{10,12}' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*://' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11827:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '700,745p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11835:   706	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11860:   731	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11874:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11944:/bin/zsh -lc "rg -o 'docs/audits/[A-Za-z0-9_./{}*,-]+' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*:docs/docs/' | sort -u" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12132:- [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:560) still shows Phase 5 as unstarted generic work. Update 5.1, 5.2 partial, 5.4, 5.5 V1/V2 V1, 5.6 V1/V2 statuses, and replace stale deliverable `docs/architecture/collaboration-crdt.md` at [line 627](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:627) with `docs/architecture/crdt-data-model.md` plus `v1-exit-packet.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12134:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:447) has a stale `ql-collab` crate scope snippet listing only scaffold modules and calling presence/undo “reserved.” Replace with the current five-module surface from `crates/ql-collab/src/lib.rs`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12139:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:732) still marks Phase 5.1 audit deliverables “pending” even though the files exist. Mark them shipped.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12166:- [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:560) still shows Phase 5 as unstarted generic work. Update 5.1, 5.2 partial, 5.4, 5.5 V1/V2 V1, 5.6 V1/V2 statuses, and replace stale deliverable `docs/architecture/collaboration-crdt.md` at [line 627](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:627) with `docs/architecture/crdt-data-model.md` plus `v1-exit-packet.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12168:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:447) has a stale `ql-collab` crate scope snippet listing only scaffold modules and calling presence/undo “reserved.” Replace with the current five-module surface from `crates/ql-collab/src/lib.rs`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12173:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:732) still marks Phase 5.1 audit deliverables “pending” even though the files exist. Mark them shipped.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-opus.md:38:**M4-M7 — Doc drift across 5 files** (crdt-data-model.md,
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:154:**H.2 — `RenameSheet` op structure:** PASS  
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:166:`workbook_runtime.rs:862–877`: the `BatchCommit` contains `[PutFormula × N, RenameSheet]`. The rename op is always last — replaying the batch in order restores formula texts before the rename, matching the producer-side order.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:210:`workbook_runtime.rs:862–877` appends the `BatchCommit` (PutFormulas + RenameSheet) BEFORE the formula text writes (`workbook_runtime.rs:884–886`) and the actual sheet rename (`workbook_runtime.rs:888–890`).
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:253:When no formula references the renamed sheet, `rewritten_cells` is empty, the `BatchCommit` contains only `[RenameSheet]`, and the name swap proceeds. Correct.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-consolidated.md:33:crdt-data-model.md, entry-plan.md, known-gaps.md, lib.rs/session.rs)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:22:| M1 (Codex M2 / Opus M1, convergent) | Codex+Opus | MEDIUM | Doc drift in 4 sites: collab session.rs:248 + 596, presence.rs:19, oplog log.rs:18 + crdt-data-model.md:437 — all imply oplog.bin is "raw Loro snapshot" post-Tier-D3. | Updated all 5 sites to reflect post-Tier-D3 file-vs-transport contract. Transport bytes (export_bytes) are raw Loro; file bytes (save_workbook_with_oplog) add Quantlab header. | ✅ |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:57:### `docs/architecture/crdt-data-model.md`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-opus.md:25:Also `docs/architecture/crdt-data-model.md:437` — `.qbook/oplog.bin` "remains the same Loro snapshot blob."
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-opus.md:28:- M1: Doc drift across 4 files (transport.rs, crdt-data-model.md, entry-plan.md, known-gaps.md).
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-opus.md:63:  crdt-data-model.md / entry-plan.md / known-gaps.md.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32042:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1807:docs/architecture/2026-05-13-cross-sheet-references.md:263:- `ReplayError::SheetRenameUnknownSheet { id }` — `RenameSheet` references a sheet that wasn't created by earlier ops.
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2226:docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:169:**J.1** `WorkbookRuntime::rename_sheet` ordering: validate name → snapshot formulas → log BatchCommit (rewrite ops + RenameSheet) → apply rewrites → swap name → `plan_cache.clear()`. Verify the order: a failure between log-append and storage-mutation must not leave divergent state. Specifically: what happens if `oplog.append` succeeds but the subsequent storage write panics? (Probably can't happen given the validations, but verify.)
./Charts/BUILD/Delta_V3_Implementation_Kit/delta_v3_additions/IMPLEMENTATION_PLAN.md:885:### Phase 5.3: Drawing Tools (Lines)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1460:     RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1677:     /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1784:         Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2240:     // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2244:         // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2251:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2269:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2287:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2304:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3193:             Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4366:    33	//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5380:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5707:   461	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6796:  1550	    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6800:  1554	        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6807:  1561	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6825:  1579	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6843:  1597	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6860:  1614	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6888:  1642	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6931:  1685	                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8072:quantbook-engine/docs/architecture/crdt-data-model.md:78:- Formats: `RegisterFormat`, `SetCellFormat`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8073:quantbook-engine/docs/architecture/crdt-data-model.md:128:`.qbook` cold-load. Every Phase 4 fix carries forward.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8074:quantbook-engine/docs/architecture/crdt-data-model.md:244:design said "Presence updates do NOT persist across `.qbook`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8077:quantbook-engine/docs/architecture/crdt-data-model.md:266:slate (cold restart of a `.qbook`) call sweep after
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8078:quantbook-engine/docs/architecture/crdt-data-model.md:429:## Backwards compatibility with `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8079:quantbook-engine/docs/architecture/crdt-data-model.md:432:workbook as a `.qbook/` directory with JSON manifests +
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8082:quantbook-engine/docs/architecture/crdt-data-model.md:438:- Loading a `.qbook` still produces a single-writer-equivalent
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8083:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8084:quantbook-engine/docs/architecture/crdt-data-model.md:553:`Op::RegisterFormat { id: N, string: <different> }`. Replay's
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8085:quantbook-engine/docs/architecture/crdt-data-model.md:573:- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8086:quantbook-engine/docs/architecture/crdt-data-model.md:575:  signature, `.qbook` envelope cell-format-id encoding, xlsx
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8087:quantbook-engine/docs/architecture/crdt-data-model.md:578:- Backwards compat: old `.qbook` files with `u32` ids load as
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8170:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:369:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8171:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:382:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10793:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:335:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10794:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:336:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10796:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:426:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10797:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:427:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10803:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10963:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10551:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10964:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10552:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11904:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11199:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11909:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11559:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11962:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:657:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11963:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:670:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:76:D1. `crdt-data-model.md` § Transport (V1 partially shipped) — does V2 V1 need updating?
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:476:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:477:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:478:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:479:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:480:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:481:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 — V1 partially shipped)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:482:docs/architecture/crdt-data-model.md:375:**V1 ✅ shipped at `924750819bc` (2026-05-19):** `Transport`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:483:docs/architecture/crdt-data-model.md:376:trait + `NoopTransport` (5.2.a) + `LoopbackTransport` (5.5 V1)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:484:docs/architecture/crdt-data-model.md:388:**V2 pending:** WebSocket transport (or any bidirectional byte
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:485:docs/architecture/crdt-data-model.md:395:5.1 does NOT pick a production transport (WS vs Server-Sent
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:486:docs/architecture/crdt-data-model.md:396:Events vs custom protocol) — that's 5.5 V2's call. 5.1 just
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:487:docs/architecture/crdt-data-model.md:397:confirms the substrate works regardless; 5.5 V1 proves it via
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:488:docs/architecture/crdt-data-model.md:415:the new transport path handles the multi-peer case. Both call
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:489:docs/architecture/crdt-data-model.md:428:pub mod transport;   // trait Transport + NoopTransport test impl
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:490:docs/architecture/crdt-data-model.md:432:pub use transport::{NoopTransport, Transport, TransportError};
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:491:docs/architecture/crdt-data-model.md:445:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:492:docs/architecture/crdt-data-model.md:658:1. **Op-log compaction policy** — deferred to Phase 5.5
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:689:docs/audits/2026-05-19-handoff-audit-codex.md:1860:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:690:docs/audits/2026-05-19-handoff-audit-codex.md:1866:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:691:docs/audits/2026-05-19-handoff-audit-codex.md:1869:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:692:docs/audits/2026-05-19-handoff-audit-codex.md:1872:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:693:docs/audits/2026-05-19-handoff-audit-codex.md:1885:docs/architecture/crdt-data-model.md:322:## Transport (Phase 5.5 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:694:docs/audits/2026-05-19-handoff-audit-codex.md:1886:docs/architecture/crdt-data-model.md:329:Phase 5.5 wraps these with a WebSocket transport (or any
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:695:docs/audits/2026-05-19-handoff-audit-codex.md:1913:docs/architecture/crdt-data-model.md:577:1. **Op-log compaction policy** — deferred to Phase 5.5
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:726:docs/audits/2026-05-19-phase-5-5-v1-codex.md:77:D1. `crdt-data-model.md` § Transport (Phase 5.5 preview) — needs "V1 LoopbackTransport shipped at 924750819bc" marker?
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:734:docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:767:docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:855:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2262:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:856:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2263:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:857:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2264:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:858:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2265:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:859:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2266:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:860:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2267:docs/architecture/crdt-data-model.md:380:Phase 5.5 wraps these with a WebSocket transport (or any
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:861:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2268:docs/architecture/crdt-data-model.md:385:5.1 does NOT pick a transport (WS vs Server-Sent Events vs
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:862:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2269:docs/architecture/crdt-data-model.md:404:the new transport path handles the multi-peer case. Both call
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:863:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2270:docs/architecture/crdt-data-model.md:417:pub mod transport;   // trait Transport + NoopTransport test impl
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:864:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2271:docs/architecture/crdt-data-model.md:421:pub use transport::{NoopTransport, Transport, TransportError};
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:865:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2272:docs/architecture/crdt-data-model.md:434:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:866:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2273:docs/architecture/crdt-data-model.md:647:1. **Op-log compaction policy** — deferred to Phase 5.5
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:904:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7515:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:910:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7552:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:917:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7579:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:923:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7616:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1938:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '365,405p'; nl -ba docs/phase5/entry-plan.md | sed -n '104,116p'; nl -ba docs/known-gaps.md | sed -n '110,120p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2794:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:7906:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:8043:| LOW | [crdt-data-model.md:373](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:373), [entry-plan.md:111](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:111), [known-gaps.md:116](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:116), [transport.rs:6](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:6), [session.rs:12](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:12) | Docs still frame 5.5 V2 as fully pending and omit the attached-transport/manual flush+poll API. | Add V2 V1 marker `ffd8f6e5f05`, list the 5 `CollabSession` transport methods, and narrow remaining V2 to production transport/reconnect/offline/deltas/auto-flush. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:8098:| LOW | [crdt-data-model.md:373](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:373), [entry-plan.md:111](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:111), [known-gaps.md:116](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:116), [transport.rs:6](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:6), [session.rs:12](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:12) | Docs still frame 5.5 V2 as fully pending and omit the attached-transport/manual flush+poll API. | Add V2 V1 marker `ffd8f6e5f05`, list the 5 `CollabSession` transport methods, and narrow remaining V2 to production transport/reconnect/offline/deltas/auto-flush. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-opus.md:41:- `crdt-data-model.md` § Undo/redo: V1 wired surface → "V1 + V2 V1
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1533:120:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2397:404:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:5805:crates/ql-exec/src/workbook_runtime.rs:2537:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:52:**L2 (Codex) — crdt-data-model.md stale `pub mod peer` snippet.** The doc was written when PeerId lived in `ql-collab`. Updated to show `pub use ql_oplog::PeerId;` shape post step 1.1.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:14:Audit the Phase 5.1 CRDT Data Model Decision at branch `feat/quantbook-engine` in repo `~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Design at `docs/architecture/crdt-data-model.md` (commit `918d7efdd91`).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:20:- `docs/architecture/crdt-data-model.md`
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:80:### V5. RenameSheet cross-peer bug (Opus H-2)
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:85:3. Emits a `BatchCommit` containing `Op::PutFormula(rewrite)` × N + `Op::RenameSheet { id, old, new }`.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:130:/bin/zsh -lc "pwd && rg --files | rg '("'^docs/architecture/crdt-data-model.md$|''^crates/ql-oplog/src/(log|op|replay)'"\\.rs"'$|''^crates/ql-exec/src/workbook_runtime/(cells|recompute|formats|sheets)'"\\.rs"'$|''^crates/ql-storage/src/.*format.*'"\\.rs"'$|''^'"\\.github/copilot-instructions\\.md"'$)'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:133:docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:161:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:235:    73	- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:300:   138	character-level concurrent edits) and harmful in others
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:318:   156	op came last. We do NOT show the user "two concurrent edits;
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:421:   259	   for every rewritten cell + the RenameSheet op). Per-cell
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:427:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '260,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:433:   264	character-level concurrent editing of one long formula) that
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:436:   267	## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:439:   270	LWW by Lamport-timestamp at the op-log level. Phase 5.3
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:449:   280	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:450:   281	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:451:   282	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:598:   429	   - If A's RenameSheet op is causally-before B's PutFormula:
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:601:   432	   - If B's PutFormula is causally-before A's RenameSheet: A's
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:605:   436	     B's text. Bug? Phase 5.3 must address.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:615:   446	   `FormatRejectedSource::IdCollision`. Phase 5.3 must
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:634:   465	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1015:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1311:   120	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1607:   404	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2794:    15	//!   `PutFormula` rewrite + the `RenameSheet` op.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2907:   128	    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2964:   185	        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2975:   196	            ops.push(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:8874:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:3129:/// operations on a List. However, this approach fails in concurrent editing scenarios.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9352:docs/architecture/crdt-data-model.md:54:pub struct OpLog {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9353:docs/architecture/crdt-data-model.md:64:- `OpLog::append` = serialize + push + commit.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9354:docs/architecture/crdt-data-model.md:65:- `OpLog::iter` = list iterator → JSON-deserialize → `Op`.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9355:docs/architecture/crdt-data-model.md:82:Today's `OpLog` is single-writer (one runtime appends; replay is
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11391:  `docs/architecture/crdt-data-model.md:89`, `:99` says concurrent `LoroList::push` merges by Lamport timestamp and is LWW. Source does not support that. `LoroList::push` becomes a list insert at current len (`loro-internal-1.12.0/src/handler.rs:2765`), and concurrent inserts are preserved, not overwritten. The deterministic ordering rule I found is Fugue/origin-based with peer-id tie-breaks for same insertion site (`loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163`, `:192`). So: both pushes preserved = yes; receive-order-independent = yes with unique peer IDs; ordering = causal/origin order, peer-id tie-break for same origin, not LWW Lamport. Fix the design wording.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11403:  Rename only rewrites formulas visible on the producer at rename time (`crates/ql-exec/src/workbook_runtime/sheets.rs:168`) and logs those rewrites plus `RenameSheet` in one `BatchCommit` (`:183`). A concurrent formula `=S!A1+1` is not rewritten in either merge order. Binding later resolves names against current sheets (`crates/ql-exec/src/env.rs:402`, `crates/ql-exec/src/plan.rs:1678`) and fails as `BindError::UnknownSheet("S")`, not `UnresolvedName`. `recompute_all` does not map `UnknownSheet` to `#NAME?` (`crates/ql-exec/src/workbook_runtime/recompute.rs:179`), so storage may retain blank/stale value plus a recompute failure. Fix by storing sheet refs canonically by sheet id, or by adding a causality-aware rename repair policy for concurrent formulas.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11409:  `docs/architecture/crdt-data-model.md:89`, `:99` says concurrent `LoroList::push` merges by Lamport timestamp and is LWW. Source does not support that. `LoroList::push` becomes a list insert at current len (`loro-internal-1.12.0/src/handler.rs:2765`), and concurrent inserts are preserved, not overwritten. The deterministic ordering rule I found is Fugue/origin-based with peer-id tie-breaks for same insertion site (`loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163`, `:192`). So: both pushes preserved = yes; receive-order-independent = yes with unique peer IDs; ordering = causal/origin order, peer-id tie-break for same origin, not LWW Lamport. Fix the design wording.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11421:  Rename only rewrites formulas visible on the producer at rename time (`crates/ql-exec/src/workbook_runtime/sheets.rs:168`) and logs those rewrites plus `RenameSheet` in one `BatchCommit` (`:183`). A concurrent formula `=S!A1+1` is not rewritten in either merge order. Binding later resolves names against current sheets (`crates/ql-exec/src/env.rs:402`, `crates/ql-exec/src/plan.rs:1678`) and fails as `BindError::UnknownSheet("S")`, not `UnresolvedName`. `recompute_all` does not map `UnknownSheet` to `#NAME?` (`crates/ql-exec/src/workbook_runtime/recompute.rs:179`), so storage may retain blank/stale value plus a recompute failure. Fix by storing sheet refs canonically by sheet id, or by adding a causality-aware rename repair policy for concurrent formulas.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:26:- `918d7efdd91` Phase 5.1 design (crdt-data-model.md)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:48:### T3. crdt-data-model.md status markers
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:112: M docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:145:The branch and HEAD match the request. The worktree is already dirty: `Cargo.lock`, `docs/architecture/crdt-data-model.md`, and `docs/phase5/entry-plan.md` are modified, plus many untracked prompt/session files; I’ll treat those as current state and call out handoff impact rather than changing them.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:381:/bin/zsh -lc 'nl -ba docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:391:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:439:    14	# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:597:   148	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:678:    77	- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:757:   156	character-level concurrent edits) and harmful in others
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:775:   174	op came last. We do NOT show the user "two concurrent edits;
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:878:   277	   for every rewritten cell + the RenameSheet op). Per-cell
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:883:   282	character-level concurrent editing of one long formula) that
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:886:   285	## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:889:   288	LWW by Lamport-timestamp at the op-log level. Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:899:   298	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:900:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:901:   300	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1040:   439	open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1087:   486	deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1105:   504	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1128:   527	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1130:   529	walks formulas added causally-before the RenameSheet op and
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1140:   539	**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1197:   596	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1222:   621	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1856:docs/architecture/crdt-data-model.md:2:title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1857:docs/architecture/crdt-data-model.md:8:master_plan: docs/MASTER-PLAN.md § Phase 5 § 5.1
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1858:docs/architecture/crdt-data-model.md:15:# Phase 5.1 — CRDT Data Model Decision
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1859:docs/architecture/crdt-data-model.md:19:Lock the Loro container-shape decision for Phase 5 collaborative
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1860:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1861:docs/architecture/crdt-data-model.md:47:**Adopt Option A (op-log preservation) as Phase 5 V1 with a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1862:docs/architecture/crdt-data-model.md:50:Rationale below. Option B is a Phase 5 V2 / Phase 6 candidate;
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1863:docs/architecture/crdt-data-model.md:87:deterministic). The CRDT machinery is dormant. Phase 5 turns it
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1864:docs/architecture/crdt-data-model.md:120:## Why Option A is the right Phase 5 V1
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1865:docs/architecture/crdt-data-model.md:127:The replay path that Phase 5 inherits is the SAME path used by
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1866:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1867:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1868:docs/architecture/crdt-data-model.md:142:Option A gets Phase 5 to a "two peers editing one workbook"
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1869:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1870:docs/architecture/crdt-data-model.md:177:For Phase 5 V1 this is acceptable per master plan § 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1871:docs/architecture/crdt-data-model.md:189:testing post-5.2 will tell whether this is acceptable.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1872:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1875:docs/architecture/crdt-data-model.md:242:v8 may or may not persist it depending on whether the use case
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1876:docs/architecture/crdt-data-model.md:248:Phase 5 V2 may introduce a snapshot container that holds a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1877:docs/architecture/crdt-data-model.md:251:that vector. Reserved name; no Phase 5 V1 implementation.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1878:docs/architecture/crdt-data-model.md:280:Option B / per-cell-container is Phase 5 V2 work at the
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1879:docs/architecture/crdt-data-model.md:285:## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1880:docs/architecture/crdt-data-model.md:288:LWW by Lamport-timestamp at the op-log level. Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1881:docs/architecture/crdt-data-model.md:298:| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1882:docs/architecture/crdt-data-model.md:299:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1885:docs/architecture/crdt-data-model.md:322:## Transport (Phase 5.5 preview)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1886:docs/architecture/crdt-data-model.md:329:Phase 5.5 wraps these with a WebSocket transport (or any
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1887:docs/architecture/crdt-data-model.md:345:Phase 5 preserves both. The CRDT additions are purely additive:
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1888:docs/architecture/crdt-data-model.md:361:Phase 5.2 populates it with:
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1889:docs/architecture/crdt-data-model.md:372:Each module is small (~200-400 LOC). Total Phase 5.2 crate
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1890:docs/architecture/crdt-data-model.md:381:Opus-C HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1891:docs/architecture/crdt-data-model.md:382:backlog) is a separate pre-5.2 item. Phase 5.1 design assumes
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1892:docs/architecture/crdt-data-model.md:383:Tier D2 closes before 5.2.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1893:docs/architecture/crdt-data-model.md:389:| 5.2 effort | 1-2 weeks | 3-4 weeks | 2-3 weeks |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1894:docs/architecture/crdt-data-model.md:399:**Choose Option A** for Phase 5 V1. Revisit Option B/C as Phase
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1895:docs/architecture/crdt-data-model.md:402:## Audit checkpoint (gating 5.2)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1896:docs/architecture/crdt-data-model.md:405:BEFORE any 5.2 code lands. Per the engine audit-discipline rule
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1897:docs/architecture/crdt-data-model.md:424:No 5.2 commits land until the consolidated audit doc is signed
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1899:docs/architecture/crdt-data-model.md:439:open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1901:docs/architecture/crdt-data-model.md:454:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1902:docs/architecture/crdt-data-model.md:471:  for migration. (Phase 5.2 designs the migration path.)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1904:docs/architecture/crdt-data-model.md:486:deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1905:docs/architecture/crdt-data-model.md:491:**Resolution:** Phase 5.2 acceptance criterion: AddSheet
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1907:docs/architecture/crdt-data-model.md:504:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1908:docs/architecture/crdt-data-model.md:524:**Resolution:** Phase 5.2 adds the missing
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1909:docs/architecture/crdt-data-model.md:527:shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1910:docs/architecture/crdt-data-model.md:533:Documented as a **known Phase 5.2 V1 limitation**: concurrent
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1912:docs/architecture/crdt-data-model.md:539:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1913:docs/architecture/crdt-data-model.md:577:1. **Op-log compaction policy** — deferred to Phase 5.5
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1914:docs/architecture/crdt-data-model.md:578:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1915:docs/architecture/crdt-data-model.md:582:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1916:docs/architecture/crdt-data-model.md:583:   Loro's default is per-doc random `u64`; Phase 5.2 wires
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1918:docs/architecture/crdt-data-model.md:596:   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1921:docs/architecture/crdt-data-model.md:607:- `docs/MASTER-PLAN.md` § Phase 5 (master spec).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1922:docs/architecture/crdt-data-model.md:608:- `docs/phase5/entry-plan.md` (Phase 5 entry status).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1923:docs/architecture/crdt-data-model.md:610:  cleanup; pre-5.2 prerequisite).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1924:docs/architecture/crdt-data-model.md:613:  Phase 5 inherits).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1925:docs/architecture/crdt-data-model.md:615:  function that Phase 5's merge path reuses).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1926:docs/architecture/crdt-data-model.md:619:## Documentation deliverables (Phase 5.1 closure)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1927:docs/architecture/crdt-data-model.md:622:- `docs/audits/2026-05-19-phase-5-1-codex.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1928:docs/architecture/crdt-data-model.md:623:- `docs/audits/2026-05-19-phase-5-1-opus.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1929:docs/architecture/crdt-data-model.md:624:- `docs/audits/2026-05-19-phase-5-1-consolidated.md` — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1930:docs/architecture/crdt-data-model.md:625:- `docs/MASTER-PLAN.md` § Phase 5.1 update marking design
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1931:docs/architecture/crdt-data-model.md:626:  shipped + audit pending — pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1948:docs/MASTER-PLAN.md:864:   Decide by Phase 5.3.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1998:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2000:/bin/zsh -lc 'git ls-files --stage Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2005:100644 c7b297f05d2a93de060af2970f4fdbe684cc48f2 0	docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2104:/bin/zsh -lc 'git show 66a571b30af:docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2109:fatal: path 'quantbook-engine/docs/architecture/crdt-data-model.md' exists, but not 'docs/architecture/crdt-data-model.md'
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2110:hint: Did you mean '66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md' aka '66a571b30af:./docs/architecture/crdt-data-model.md'?
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2119: quantbook-engine/docs/architecture/crdt-data-model.md |  8 ++++++++
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2126:/bin/zsh -lc 'git show 66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2267:   140	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2348:    77	- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2427:   156	character-level concurrent edits) and harmful in others
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2445:   174	op came last. We do NOT show the user "two concurrent edits;
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2548:   277	   for every rewritten cell + the RenameSheet op). Per-cell
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2553:   282	character-level concurrent editing of one long formula) that
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2556:   285	## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2559:   288	LWW by Lamport-timestamp at the op-log level. Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2569:   298	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2570:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2571:   300	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2708:   437	open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2753:   482	deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2792:   521	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2794:   523	walks formulas added causally-before the RenameSheet op and
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2859:   588	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2884:   613	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2907:    14	# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3196:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3489:   160	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4152:- MEDIUM, T2, `docs/phase5/entry-plan.md:114-136`: risks/audit checkpoint still describe pre-5.1 state. Remove closed risks or mark them resolved; keep only D1/D3/C2/Phase 5.3+ risks.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4155:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4177:- MEDIUM, T2, `docs/phase5/entry-plan.md:114-136`: risks/audit checkpoint still describe pre-5.1 state. Remove closed risks or mark them resolved; keep only D1/D3/C2/Phase 5.3+ risks.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4180:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9330:   119	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10635:   390	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:5:design_under_review: docs/architecture/crdt-data-model.md @ 918d7efdd91
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:48:### RenameSheet × concurrent edit (Opus H-2, Codex V5)
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:163:1. Design doc (`docs/architecture/crdt-data-model.md`):
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14:# Codex audit — Phase 5.3 step 1 (conflict matrix test pinning) 2026-05-20
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:20:**Audit target**: the Phase 5.3 step 1 commit (HEAD at audit time — see `git log --oneline -3`).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:22:D-1 is SHIPPED; Phase 5.3 step 1 is the first new work on top.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:31:Pinned the 7-row conflict matrix from `quantbook-engine/docs/architecture/crdt-data-model.md:320-329` (§ Phase 5.3 preview) as 2-peer probe tests, following the D-4 template (`crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs`):
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:39:- Row 7: DropTable × concurrent edit referencing T — D-3 #NAME? pin
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:49:**Structural insight**: CRDT convergence in Quantbook DEPENDS on stable peer-ids. The design doc at `crdt-data-model.md` doesn't explicitly say this; it says "Fugue/origin-based with peer-id tiebreaker" but doesn't flag that callers MUST pin peer-ids for deterministic outcomes. Possibly worth a doc note in step 6 (exit packet).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:75:   - RenameTable × concurrent edit (likely needs step 4 fix first)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:76:   - InsertRow × concurrent edit (V1 doesn't have InsertRow ops — out of scope)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:95:/bin/zsh -lc 'nl -ba quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:99:     1	//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:100:     2	//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:101:     3	//! § Conflict resolution semantics (Phase 5.3 preview).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:118:    20	//! Coverage matches the design doc table at `crdt-data-model.md:320-329`:
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:125:    27	//! - Row 7: DropTable × concurrent edit referencing T (D-3 → #NAME?)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:520:   422	// ===== Row 7: DropTable × concurrent edit referencing T =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:684:    77	- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:763:   156	character-level concurrent edits) and harmful in others
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:781:   174	op came last. We do NOT show the user "two concurrent edits;
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:910:   303	   for every rewritten cell + the RenameSheet op). Per-cell
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:915:   308	character-level concurrent editing of one long formula) that
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:918:   311	## Conflict resolution semantics (Phase 5.3 preview)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:925:   318	target. Phase 5.3 formalizes this with these defaults:
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:935:   328	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:936:   329	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1159:   552	open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1206:   599	deferred to Phase 5.3. Audit pushed back: spreadsheet users
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1222:   615	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1224:   617	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1247:   640	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1249:   642	walks formulas added causally-before the RenameSheet op and
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1259:   652	**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1316:   709	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1379:   772	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1389:5595d8dcfb0 Phase 5.3 step 1 — conflict matrix test pinning (2-peer probes)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1428:The test file matches your description, and the doc row count has a twist: the preview table has eight rows, not seven, because `RenameSheet × concurrent edit` is a separate row before `DropTable`. I’m going into replay/session internals next to check whether that omission is intentional or a real gap.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1476:    45	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2104:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2105:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2106:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2107:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2110:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4076:    10	# Phase 5.3 — Conflict Resolution Semantics
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4080:    14	Phase 5.1 audit-locked the conflict-matrix table at `crdt-data-model.md:311-334` and explicitly deferred two items to 5.3:
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4097:    31	**Decision: chain-based, NOT causality-aware.** Build `(old_canonical → new_name)` chain by sheet_id from `Op::RenameSheet` ops in the log; walk all formulas; rewrite text via the existing `rewrite_formula_text_for_sheet_rename` helper (sheets.rs:37-60).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4105:    39	### D-5.3-3 — Concurrent RenameSheet policy (step 2 fix)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4130:    64	**In scope**: `Op::RenameSheet` chains.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4144:    78	### Step 2 — Concurrent RenameSheet replay fix (~0.5 day)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4153:    87	  - Concurrent rename + concurrent edit (the canonical case)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4172:   106	Write `docs/phase5/5-3-exit-packet.md` mirroring D-1 structure. Refresh 6 surfaces (MASTER-PLAN, v1-exit-packet, entry-plan, crdt-data-model, ide-consumer-contract, MEMORY). Final commit. Verify gates.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4204:   138	- Design doc preview: `quantbook-engine/docs/architecture/crdt-data-model.md` § 311-334 (Conflict resolution semantics)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4205:   139	- D-3 V1 limitation note: `crdt-data-model.md` § 615-648
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4209:   143	- Replay's RenameSheet handler (the bug + fix site): `crates/ql-oplog/src/replay.rs:486-532`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4214:/bin/zsh -lc "rg -n \"formula_text|put_formula|clear_formula|read\\(|set_value|SetName|BatchCommit|RenameSheet|DropTable|AddSheet|SetCellFormat|RenameTable|RenameColumn\" quantbook-engine/crates/ql-storage/src quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-exec/src" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4349:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4701:   486	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5790:  1575	    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5794:  1579	        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5801:  1586	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5819:  1604	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5837:  1622	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5854:  1639	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5882:  1667	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5925:  1710	                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6240:quantbook-engine/crates/ql-oplog/src/replay.rs:134:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6252:quantbook-engine/crates/ql-oplog/src/replay.rs:486:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6278:quantbook-engine/crates/ql-oplog/src/replay.rs:1575:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6279:quantbook-engine/crates/ql-oplog/src/replay.rs:1579:        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6281:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6282:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6283:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6284:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6287:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6292:quantbook-engine/crates/ql-oplog/src/replay.rs:1710:                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6732:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:15://!   `PutFormula` rewrite + the `RenameSheet` op.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6738:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6741:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:185:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6742:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7632:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8485:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8867:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14909:MEDIUM: [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20) claims coverage matches the design table, but [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:320) has 8 rows, including `RenameSheet × concurrent edit`. The active plan defers that to step 2/3, which is fine, but the step-1 test header and plan wording say “7-row matrix.” Suggested fix: either add the rename row probe now, or explicitly rename this as “7 non-rename/default rows; RenameSheet row deferred to step 2/3.”
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14923:The wider conflict space does not need to be fully covered in step 1 if 5.3 intentionally scopes this to the design-preview defaults. But the missing RenameSheet row must be called out as deferred, and row 3 must be made state-sensitive before this commit can honestly claim it pinned the matrix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14934:MEDIUM: [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20) claims coverage matches the design table, but [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:320) has 8 rows, including `RenameSheet × concurrent edit`. The active plan defers that to step 2/3, which is fine, but the step-1 test header and plan wording say “7-row matrix.” Suggested fix: either add the rename row probe now, or explicitly rename this as “7 non-rename/default rows; RenameSheet row deferred to step 2/3.”
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14948:The wider conflict space does not need to be fully covered in step 1 if 5.3 intentionally scopes this to the design-preview defaults. But the missing RenameSheet row must be called out as deferred, and row 3 must be made state-sensitive before this commit can honestly claim it pinned the matrix.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:20:- Doc currency across `current_work.md`, `MEMORY.md`, `docs/phase5/entry-plan.md`, `docs/architecture/crdt-data-model.md`, `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-opus-b.md:57:- **Doc-drift in active product docs:** crdt-data-model.md § D-1, ide-consumer-contract.md, MASTER-PLAN.md, v1-exit-packet.md, current_work.md all properly reflect steps 1-7 shipped + step 8 pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:31:4. `docs/architecture/crdt-data-model.md` § ql-collab crate scope: scaffold-limitation note replaced with "✅ closed" + caller-pitfall.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:68:D1. The crdt-data-model.md § ql-collab crate scope says "Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed)". Read the section and confirm it reads as truth.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:246: .../docs/architecture/crdt-data-model.md           | 18 +++---
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:280:    - docs/architecture/crdt-data-model.md § ql-collab crate scope:
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:293:quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:334:/bin/zsh -lc "rg --files -g 'Cargo.toml' -g 'log.rs' -g 'session.rs' -g 'peer.rs' -g 'crdt-data-model.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:338:quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:372:/bin/zsh -lc 'git diff --stat 687e5dd3995..HEAD && git diff --find-renames -- crates/ql-oplog/src/log.rs crates/ql-collab/src/session.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:376:docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:377:docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:378:docs/architecture/crdt-data-model.md:400:closed by adding `OpLog::set_peer_id` and calling it from
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:379:docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:380:docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:382:docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:433:docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:489:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:626: .../docs/architecture/crdt-data-model.md           | 18 +++---
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1367:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3686:docs/architecture/crdt-data-model.md:92:   `export_from(version_vector)` + `import` API.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3687:docs/architecture/crdt-data-model.md:456:**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3898:docs/architecture/2026-05-13-cross-sheet-references.md:39:- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4458:# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4471:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4472:docs/architecture/crdt-data-model.md:359:## `ql-collab` crate scope
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4473:docs/architecture/crdt-data-model.md:365:// crates/ql-collab/src/lib.rs (current state)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4474:docs/architecture/crdt-data-model.md:368:pub mod session;     // CollabSession: per-peer state holder
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4475:docs/architecture/crdt-data-model.md:372:pub use session::{CollabSession, CollabSessionError};
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4476:docs/architecture/crdt-data-model.md:384:Current Cargo.toml deps (verified against `crates/ql-collab/Cargo.toml`):
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4477:docs/architecture/crdt-data-model.md:391:- `thiserror` — `CollabSessionError` + `TransportError`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4478:docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4635:docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4639:docs/audits/2026-05-19-handoff-audit-codex.md:1867:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4680:docs/audits/2026-05-19-handoff-audit-codex.md:4155:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4684:docs/audits/2026-05-19-handoff-audit-codex.md:4180:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4691:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4716:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4762:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4778:/bin/zsh -lc 'git show --find-renames --format=short --stat --patch HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/peer.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4788: .../docs/architecture/crdt-data-model.md           | 18 +++---
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5043:diff --git a/quantbook-engine/docs/architecture/crdt-data-model.md b/quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5045:--- a/quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5046:+++ b/quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5122:docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5123:docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5124:docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5144:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:10230:D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:10289:D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3411://! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:572:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:702:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:703:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:704:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:705:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:767:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:768:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:769:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:770:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:786:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1099:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1189:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1190:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1191:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1192:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1228:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1229:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1230:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1262:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2617:docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2618:docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2619:docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2620:docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2621:docs/architecture/crdt-data-model.md:473:- `ql-oplog` — for `OpLog` + `Op` + `merge_bytes` + `import_bytes` + `export_bytes`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2622:docs/architecture/crdt-data-model.md:736:   oplog.bin magic bytes + version header, step 8 megaudit. See
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2633:docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3126:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3127:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3128:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3129:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3145:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3458:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3548:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3549:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3550:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3551:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3587:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3588:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3589:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3621:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3847:docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3977:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3978:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3979:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3980:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4359:docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4470:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4471:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4472:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4902:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8409:docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8410:docs/architecture/crdt-data-model.md:563:    Builtin(u32),        // Excel-canonical ids 0–163 (unchanged)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8411:docs/architecture/crdt-data-model.md:607:change. The `Op::AddSheet { name }` op is unchanged; replay
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8412:docs/architecture/crdt-data-model.md:688:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8413:docs/architecture/crdt-data-model.md:692:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8609:docs/audits/2026-05-19-handoff-audit-codex.md:1914:docs/architecture/crdt-data-model.md:578:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8610:docs/audits/2026-05-19-handoff-audit-codex.md:1915:docs/architecture/crdt-data-model.md:582:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8760:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8783:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8875:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10564:docs/architecture/crdt-data-model.md:604:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9336:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10304:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '230,255p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10608:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '426,442p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10833:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11951:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8072:quantbook-engine/docs/architecture/crdt-data-model.md:78:- Formats: `RegisterFormat`, `SetCellFormat`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11952:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8084:quantbook-engine/docs/architecture/crdt-data-model.md:553:`Op::RegisterFormat { id: N, string: <different> }`. Replay's
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11953:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8085:quantbook-engine/docs/architecture/crdt-data-model.md:573:- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13306:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:76:9. **Doc cross-references.** The d-1-checklist marks step 2 ✅ shipped. Are there other doc surfaces that mention `FormatIdWire` ahead of time (e.g. crdt-data-model.md § "D-1") that should be updated post-ship to point at the actual shipped type?
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13599:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13962:/bin/zsh -lc 'rg -n "from_storage|to_storage|FormatIdWire|FormatId" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:14093:MEDIUM: External docs/API comments still imply raw Loro bytes are suitable as `.qbook/oplog.bin`. Most notably `CollabSession::export_bytes` says “OR for `.qbook/oplog.bin` persistence” ([session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:248)), and the architecture doc says `.qbook/oplog.bin` remains the same Loro snapshot blob ([crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:437)). Post-D3, only `ql_io::save_workbook_with_oplog` writes the QLOL wrapper.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:14112:MEDIUM: External docs/API comments still imply raw Loro bytes are suitable as `.qbook/oplog.bin`. Most notably `CollabSession::export_bytes` says “OR for `.qbook/oplog.bin` persistence” ([session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:248)), and the architecture doc says `.qbook/oplog.bin` remains the same Loro snapshot blob ([crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:437)). Post-D3, only `ql_io::save_workbook_with_oplog` writes the QLOL wrapper.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:66:D2. `crdt-data-model.md` § Undo/redo (V1 shipped) — needs V2 V1 marker?
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:452:quantbook-engine/docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:453:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 — V1 shipped)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:454:quantbook-engine/docs/architecture/crdt-data-model.md:333:**Phase 5.4 V1 ✅ shipped at `89c02b9d83e` (2026-05-19).**
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:455:quantbook-engine/docs/architecture/crdt-data-model.md:335:peer has its own undo stack tracking THEIR local appends only.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:456:quantbook-engine/docs/architecture/crdt-data-model.md:338:post-undo. (V1 implementation correction: prior "remove from
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:457:quantbook-engine/docs/architecture/crdt-data-model.md:341:a remote-event-style retraction. See `ql_collab::CollabSession::undo`.)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:458:quantbook-engine/docs/architecture/crdt-data-model.md:343:This is local-undo, NOT collaborative-undo. Two users editing
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:459:quantbook-engine/docs/architecture/crdt-data-model.md:344:the same cell + one user undoing their edit produces a sane
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:460:quantbook-engine/docs/architecture/crdt-data-model.md:352:- `undo() -> Result<bool, _>` / `redo() -> Result<bool, _>`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:461:quantbook-engine/docs/architecture/crdt-data-model.md:353:- `can_undo() -> bool` / `can_redo() -> bool`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:462:quantbook-engine/docs/architecture/crdt-data-model.md:354:- `undo_count() -> usize` / `redo_count() -> usize`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:463:quantbook-engine/docs/architecture/crdt-data-model.md:355:- `clear_undo_stack()`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:464:quantbook-engine/docs/architecture/crdt-data-model.md:357:Plus `pub use loro::UndoManager` in `ql_collab::undo` for
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:465:quantbook-engine/docs/architecture/crdt-data-model.md:360:cursor movement doesn't pollute the undo stack.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:466:quantbook-engine/docs/architecture/crdt-data-model.md:367:- `set_peer_id` after construction silently CLEARS the undo
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:467:quantbook-engine/docs/architecture/crdt-data-model.md:445:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:498:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:499:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:515:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:328:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:518:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:418:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:550:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10542:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:652:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:83:D1. `crdt-data-model.md` § Undo/redo (Phase 5.4 preview, lines ~307-320) was written pre-implementation. Now that V1 ships, does it need a "✅ V1 shipped at 89c02b9d83e" marker?
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:665:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:412:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:834:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2134:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:835:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2135:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:836:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2136:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:837:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2137:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:838:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2138:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:839:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2139:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:843:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2152:quantbook-engine/crates/ql-collab/src/undo.rs:11://! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:868:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2276:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:869:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2277:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:927:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4390:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:928:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4391:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1127:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1138:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13046:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1144:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13068:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1156:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13103:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1162:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13125:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2295:/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/lib.rs | sed -n '1,90p'; nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '320,375p'; nl -ba quantbook-engine/docs/known-gaps.md | sed -n '108,118p'; nl -ba quantbook-engine/docs/phase5/entry-plan.md | sed -n '100,114p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2301:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2369:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2370:   324	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2427:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3081: | GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3302: - `docs/architecture/crdt-data-model.md` — at 5.1 close.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11047:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11143:/bin/zsh -lc 'rg -n "undo module|Reserved module|V2 V1|group_start|merge-interval|No grouping API|No merge-interval|start_undo_group|set_undo_merge_interval" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/crates/ql-collab/src/lib.rs quantbook-engine/crates/ql-collab/src/session.rs -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11189:quantbook-engine/docs/architecture/crdt-data-model.md:364:- No grouping API (`group_start` / `group_end`) — defer to V2.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11190:quantbook-engine/docs/architecture/crdt-data-model.md:365:- No merge-interval tuning (Loro's default 0 ms) — defer to V2.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11191:quantbook-engine/docs/architecture/crdt-data-model.md:383:**V2 V1 ✅ shipped at `ffd8f6e5f05` (2026-05-19):**
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11192:quantbook-engine/docs/architecture/crdt-data-model.md:400:`LoopbackTransport` + V2 V1's `attach_transport`/`flush`/`poll`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11193:quantbook-engine/docs/architecture/crdt-data-model.md:405:confirms the substrate works regardless; 5.5 V1 + V2 V1 prove
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11203:| LOW | Docs are stale: [crdt-data-model.md:331](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [undo.rs:24](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/undo.rs:24), [lib.rs:27](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:27), and [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) still describe V1-only or unpopulated undo state. | Update these to mention V2 V1 grouping and merge-interval methods. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11240:D2: FAIL. `crdt-data-model.md` still says no grouping API and no merge-interval tuning.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11268:| LOW | Docs are stale: [crdt-data-model.md:331](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [undo.rs:24](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/undo.rs:24), [lib.rs:27](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:27), and [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) still describe V1-only or unpopulated undo state. | Update these to mention V2 V1 grouping and merge-interval methods. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11305:D2: FAIL. `crdt-data-model.md` still says no grouping API and no merge-interval tuning.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:2:title: Phase 5.3 step 1 audit — Opus subagent verdict
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:35:**File**: `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20-27` AND `docs/architecture/crdt-data-model.md:320-329`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:37:**What**: The test file's prelude lists 7 rows; the design doc's matrix has 9 rows (rows 8 + 9 are `RenameSheet × concurrent edit` and `DropTable × concurrent edit referencing T`). Row 7 in the test is actually doc-row 9 (DropTable). Doc-row 8 (RenameSheet × edit) is deferred to step 2 — but the test file doesn't say that.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:83:**File**: `docs/architecture/crdt-data-model.md` § 311-334 (no mention) + § 489-496 (production peer-id wiring only).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:89:**Fix**: add 1-2 sentences to `crdt-data-model.md` § 311-334.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:91:**Closed**: Step 1 closure commit. Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-opus.md:29:**M1-M4 — doc drift across `session.rs:7-9`, `crdt-data-model.md:331-344`,
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-consolidated.md:43:`crdt-data-model.md` §373, `entry-plan.md:110`, `known-gaps.md:116`,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:2:title: Phase 5.3 step 1 audit synthesis (conflict matrix test pinning)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:8:closure_commit: (this commit — Phase 5.3 step 1 audit closures)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:20:| **MEDIUM-1**: Matrix labeling off — design doc has 8 rows; test calls "row 7" the DropTable row (actually row 8); row 7 (RenameSheet × edit) was missing | MEDIUM | MEDIUM-1 | Added new `row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix` pinning pre-fix #NAME? (step 3 will modify); renamed DropTable test to row 8 |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:34:| **Opus MEDIUM-2**: Plan understates step 4. `apply_rename_table` (replay.rs:691) and `apply_rename_column` (replay.rs:749) have IDENTICAL `old_canonical` lookup hard-fail bug to RenameSheet. Step 4 is "extend step 2," not "investigate." | MEDIUM | Updated `.plans/_active.md` step 4 + task #4 description: "extend step 2's fix" with replay.rs:691 + 749 references; revised effort from 0.5-1d "investigation" to ~0.5d "implementation" |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:36:| **Opus LOW-2**: Peer-id stability note should go in design doc NOW (step 6 deferral saves no time; step 2 will rediscover) | LOW | Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334 |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:56:The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:5:design_under_review: docs/architecture/crdt-data-model.md @ 918d7efdd91
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:15:`docs/architecture/crdt-data-model.md:442-447` (open question 5).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:24:### H-2 — RenameSheet asymmetric merge → user-visible bug
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:26:`docs/architecture/crdt-data-model.md:281`. If peer A does
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:27:RenameSheet(S→X) and peer B concurrently writes `=S!A1`, then
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:34:restart. Consider producer-side RenameSheet rewrite-pass at
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:35:replay time to catch B's concurrent edits.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:39:`docs/architecture/crdt-data-model.md:280`. Spreadsheet users
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:50:`docs/architecture/crdt-data-model.md:99-100` claims "Loro's
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:71:`docs/architecture/crdt-data-model.md:247-250` states spill-
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:107:`docs/architecture/crdt-data-model.md:423-424` asks whether
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:122:`docs/architecture/crdt-data-model.md:165-175` acknowledges
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:164:guardrails: format-id wire-format lock, RenameSheet user-
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:25:**Finding:** `crdt-data-model.md:240` (pre-implementation) said
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:34:  block, with cross-ref to crdt-data-model.md).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:35:- `docs/architecture/crdt-data-model.md` § Presence container
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:60:- `crdt-data-model.md` § Presence container: ✅ V1 shipped
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:21:| `083ad235d24` W5-91 | Phase 4.6.C — sheet rename + formula-text rewrite + `Op::RenameSheet` |
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:39:- `crates/ql-oplog/src/op.rs` — `Op::RenameSheet`, `Op::SetName { scope, .. }` extension.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:143:**H.3** `Op::RenameSheet` replay: 3-case reconciliation per design § 3.3 (current==old apply; current==new noop; else mismatch). Verify the canonical comparison uses `Workbook::canonical_sheet_name` (NOT raw `String::eq`).
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:145:**H.4** `Op::RenameSheet` producer side in `WorkbookRuntime::rename_sheet`: emits a BatchCommit containing all `PutFormula` rewrites for stored formula text PLUS the `RenameSheet`. Verify the order: rewrites first, then rename. Verify the rewrite captures `iter_formulas` snapshot BEFORE mutation (no live-iter mutation hazard).
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:169:**J.1** `WorkbookRuntime::rename_sheet` ordering: validate name → snapshot formulas → log BatchCommit (rewrite ops + RenameSheet) → apply rewrites → swap name → `plan_cache.clear()`. Verify the order: a failure between log-append and storage-mutation must not leave divergent state. Specifically: what happens if `oplog.append` succeeds but the subsequent storage write panics? (Probably can't happen given the validations, but verify.)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:851://! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3261:    RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6982:/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7771:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:24:Single commit at HEAD. Implements Phase 5.6 V1 per the audit-closed design at `docs/architecture/crdt-data-model.md` § Presence container. Workspace tests 4166 → 4177 (+11).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:79:D1. The crdt-data-model.md § Presence container section was written pre-implementation. Now that 5.6 V1 ships, does it need a "✅ shipped" marker + commit hash? (Same pattern as D-2/D-3/D-4 marked at the 2026-05-19 handoff audit.)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:109:/bin/zsh -lc 'rg -n "Presence|presence_|update_presence|peer_presence|clear_presence|peers_with_presence|presence" crates/ql-oplog/src/log.rs crates/ql-collab/src/presence.rs crates/ql-collab/src/session.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/roadmap/entry-plan.md docs/architecture/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:116:rg: docs/architecture/crdt-data-model.md: No such file or directory (os error 2)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:178:/bin/zsh -lc 'rg -n "Presence|presence_|update_presence|peer_presence|clear_presence|peers_with_presence|presence" crates/ql-oplog/src/log.rs crates/ql-collab/src/presence.rs crates/ql-collab/src/session.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/roadmap/entry-plan.md docs/architecture/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:191:crates/ql-oplog/src/log.rs:39:/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:328:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:329:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:330:docs/architecture/crdt-data-model.md:201:(presence below).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:331:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:332:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:333:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:334:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:335:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:336:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:337:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:338:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:339:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:380:/bin/zsh -lc "rg --files | rg '("'^|/)(entry-plan|known-gaps|crdt-data-model)'"\\.md"'$|copilot-instructions'"\\.md"'$'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:388:docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:418:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:419:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:420:docs/architecture/crdt-data-model.md:201:(presence below).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:421:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:422:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:423:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:424:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:425:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:426:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:427:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:428:docs/architecture/crdt-data-model.md:301:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:429:docs/architecture/crdt-data-model.md:302:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:430:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:431:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:432:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:433:docs/architecture/crdt-data-model.md:500:### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:434:docs/architecture/crdt-data-model.md:524:### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:435:docs/architecture/crdt-data-model.md:559:### D-4: Spill semantics — replay defers to recompute, not per-op
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:436:docs/architecture/crdt-data-model.md:616:   addressed by D-3** (above). The actual bug shape is
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:529:docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:531:docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:646:docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:658:docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:660:docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:661:docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:662:docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:663:docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:688:docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:706:docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:710:docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:958:docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1758:     4	//! audit-closed design at `docs/architecture/crdt-data-model.md`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2012:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2252:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '210,250p'; nl -ba docs/phase5/entry-plan.md | sed -n '95,120p'; nl -ba docs/known-gaps.md | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2905:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10542:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10543:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10544:docs/architecture/crdt-data-model.md:201:(presence below).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10545:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10546:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10547:docs/architecture/crdt-data-model.md:219:typing indicator. Keys are peer-IDs (UUIDs); values are JSON
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10548:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10549:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10550:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10551:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10552:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10553:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10554:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10555:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10557:docs/architecture/crdt-data-model.md:461:open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10563:docs/architecture/crdt-data-model.md:495:**Why not UUID?** UUIDs are bigger (128-bit), opaque to humans,
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10564:docs/architecture/crdt-data-model.md:604:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10822:B3. The 16-hex u64 key is defensible because `PeerId` is explicitly Loro-native `u64` in [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/peer.rs:3). But the design doc still says UUIDs in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:219). That is doc drift.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10838:D1. [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:216): add “✅ Phase 5.6 V1 shipped `c677e244704`”, change UUID keys to 16-hex `PeerId`, and resolve the persistence statement.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10881:B3. The 16-hex u64 key is defensible because `PeerId` is explicitly Loro-native `u64` in [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/peer.rs:3). But the design doc still says UUIDs in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:219). That is doc drift.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10897:D1. [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:216): add “✅ Phase 5.6 V1 shipped `c677e244704`”, change UUID keys to 16-hex `PeerId`, and resolve the persistence statement.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:43:6 doc surfaces refreshed (session.rs scaffold, undo.rs, lib.rs, crdt-data-model.md, known-gaps.md, entry-plan.md).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5756://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6161:docs/architecture/crdt-data-model.md:358:  `end_undo_group()` — atomic multi-op grouping for paste /
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6162:docs/architecture/crdt-data-model.md:359:  fill-down / table-import operations.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6163:docs/architecture/crdt-data-model.md:362:- **V2 V1.1:** `start_undo_group_scoped() -> Result<UndoGroupGuard<'_>, _>`
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6164:docs/architecture/crdt-data-model.md:377:  `start_undo_group_scoped` + `UndoGroupGuard`. Manual
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:74:| `083ad235d24` | **W5-91 — Phase 4.6.C: sheet rename + formula-text rewrite + `Op::RenameSheet`** | **1948** | `WorkbookRuntime::rename_sheet`, AST walker, op-log atomic batch |
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:98:- `Op::RenameSheet { id, old_name, new_name }` variant. Replay handler
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:115:  3. Log a single `BatchCommit { ops: [PutFormula × N, RenameSheet] }`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:77:D1. `crdt-data-model.md` § Transport (Phase 5.5 preview) — needs "V1 LoopbackTransport shipped at 924750819bc" marker?
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:270:quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:513://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2262:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2263:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2264:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2265:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2266:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 preview)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2267:docs/architecture/crdt-data-model.md:380:Phase 5.5 wraps these with a WebSocket transport (or any
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2268:docs/architecture/crdt-data-model.md:385:5.1 does NOT pick a transport (WS vs Server-Sent Events vs
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2269:docs/architecture/crdt-data-model.md:404:the new transport path handles the multi-peer case. Both call
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2270:docs/architecture/crdt-data-model.md:417:pub mod transport;   // trait Transport + NoopTransport test impl
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2271:docs/architecture/crdt-data-model.md:421:pub use transport::{NoopTransport, Transport, TransportError};
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2272:docs/architecture/crdt-data-model.md:434:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2273:docs/architecture/crdt-data-model.md:647:1. **Op-log compaction policy** — deferred to Phase 5.5
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2288:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2525:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7515:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7552:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7579:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7616:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:401://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:589:# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:614:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:618:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:631:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:633:quantbook-engine/docs/architecture/crdt-data-model.md:541:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:634:quantbook-engine/docs/architecture/crdt-data-model.md:557:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:635:quantbook-engine/docs/architecture/crdt-data-model.md:561:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:636:quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:637:quantbook-engine/docs/architecture/crdt-data-model.md:573:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:638:quantbook-engine/docs/architecture/crdt-data-model.md:578:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:639:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:640:quantbook-engine/docs/architecture/crdt-data-model.md:709:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:641:quantbook-engine/docs/architecture/crdt-data-model.md:710:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:642:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `u32` to a tagged tuple (Builtin | Custom(peer_id, counter))
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:643:quantbook-engine/docs/architecture/crdt-data-model.md:712:   in Phase 5.2 D-1 (next-session multi-day arc; see
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:644:quantbook-engine/docs/architecture/crdt-data-model.md:713:   `docs/phase5/d-1-starting-checklist.md`). Schema bump
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:655:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:662:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:700:quantbook-engine/docs/phase5/d-1-starting-checklist.md:153:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1251:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1253:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1257:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1259:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1334:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1345:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1346:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1347:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1348:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1349:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1350:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1351:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1352:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1382:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1395:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1397:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1398:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1399:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1901:docs/architecture/crdt-data-model.md:454:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1400:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1401:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1426:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1429:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1854:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2351:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2352:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:382:docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2355:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2356:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:433:docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2424:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2437:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2444:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2481:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2508:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2510:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2511:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2512:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2513:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2514:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2515:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2516:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2517:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2518:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2535:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2031:/bin/zsh -lc 'rg -n "docs/audits/2026-05-19|phase-5|tier-d1|exit-packet|d-1-starting" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2540:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2912:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2924:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2929:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2966:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2968:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2972:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2974:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2975:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11695:/bin/zsh -lc 'rg -o "`[0-9a-f]{10,12}`|[0-9a-f]{10,12}" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed '"'s/.*://; s/"'`//g'"' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2976:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11703:/bin/zsh -lc "setopt NO_NOMATCH; rg -o '[0-9a-f]{10,12}' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*://' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2981:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11944:/bin/zsh -lc "rg -o 'docs/audits/[A-Za-z0-9_./{}*,-]+' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*:docs/docs/' | sort -u" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2984:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2992:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3285:    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3480:/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3711:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3733:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3858:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4187:quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4217:/bin/zsh -lc "sed -n '540,590p' quantbook-engine/docs/architecture/crdt-data-model.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4227:open question 5 ("Phase 5.3 may switch to UUID"). Audit
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4274:quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4808:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5402:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '216,224p;553,584p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5450:    14	# closed design at `docs/architecture/crdt-data-model.md`,
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5629:/bin/zsh -lc "rg -n \"PeerId\" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5631:quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5632:quantbook-engine/docs/architecture/crdt-data-model.md:222:language since PeerId is u64-native to match Loro's PeerID type);
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5633:quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5634:quantbook-engine/docs/architecture/crdt-data-model.md:460:pub use peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5635:quantbook-engine/docs/architecture/crdt-data-model.md:486:scaffold's known limitation — `PeerId` stored as a label only — was
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5636:quantbook-engine/docs/architecture/crdt-data-model.md:489:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5637:quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5675:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '444,464p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5734:File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5778:File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-consolidated.md:63:Status header updated to mark § 7 as "PARTIALLY SUPERSEDED by D-1" with cross-references to `crdt-data-model.md § D-1` + `d-1-starting-checklist.md`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./.codex-phase-5-3-step-2-audit-prompt.md:1:# Codex audit — Phase 5.3 step 2 (concurrent RenameSheet replay fix) 2026-05-20
./.codex-phase-5-3-step-2-audit-prompt.md:7:**Audit target**: commit `1ed2bbba78a` (Phase 5.3 step 2 ship).
./.codex-phase-5-3-step-2-audit-prompt.md:40:   - Specifically: what happens if a peer issues `RenameSheet { id: 0, old: "Wrong", new: "X" }` against a workbook whose sheet 0 is currently named "S"? Pre-step-2: errored. Post-step-2: renames "S" → "X" silently. Is that desirable? It's the CRDT semantic ("what the peer thought was current"), but for SINGLE-WRITER scenarios this is now silently wrong.
./.codex-phase-5-3-step-2-audit-prompt.md:53:5. **What about RenameSheet × DropSheet concurrent?** The Op enum has no `DropSheet` variant (I checked earlier) — so this is out of scope. Verify.
./.codex-phase-5-3-step-2-audit-prompt.md:62:8. **`crdt-data-model.md` § 311-334** has the conflict matrix table. Row 7 (RenameSheet × concurrent edit) still describes `BindError::UnknownSheet → #NAME?` as the current behavior + "Phase 5.3 adds the causality-aware rename-repair pass." Step 2 changes the REPLAY behavior (no longer hard-fails) but not the rename-repair (step 3). Is the doc still correct, or does it need a step-2-specific update?
./.codex-phase-5-3-step-2-audit-prompt.md:66:9. **Did I break any pre-existing rename test?** The producer_replay_equivalence.rs test at lines 182-195 emits RenameSheet ops. Run through the logic and verify these still work post-step-2.
./quantbook-engine/docs/MASTER-PLAN.md:470:   - 4.6.C (W5-91) — `WorkbookRuntime::rename_sheet` + formula-text rewrite + `Op::RenameSheet` with 3-case replay reconciliation.
./quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
./quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
./quantbook-engine/docs/MASTER-PLAN.md:851:6. **What is the collaboration conflict policy for formula versus value concurrent edits?**  
./quantbook-engine/docs/MASTER-PLAN.md:853:   Decide by Phase 5.3.
./quantbook-engine/docs/architecture/crdt-data-model.md:77:- Sheets: `AddSheet`, `RenameSheet`
./quantbook-engine/docs/architecture/crdt-data-model.md:156:character-level concurrent edits) and harmful in others
./quantbook-engine/docs/architecture/crdt-data-model.md:174:op came last. We do NOT show the user "two concurrent edits;
./quantbook-engine/docs/architecture/crdt-data-model.md:303:   for every rewritten cell + the RenameSheet op). Per-cell
./quantbook-engine/docs/architecture/crdt-data-model.md:308:character-level concurrent editing of one long formula) that
./quantbook-engine/docs/architecture/crdt-data-model.md:311:## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/architecture/crdt-data-model.md:318:target. Phase 5.3 formalizes this with these defaults:
./quantbook-engine/docs/architecture/crdt-data-model.md:328:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
./quantbook-engine/docs/architecture/crdt-data-model.md:329:| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/architecture/crdt-data-model.md:338:**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
./quantbook-engine/docs/architecture/crdt-data-model.md:577:open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/architecture/crdt-data-model.md:624:deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/architecture/crdt-data-model.md:640:### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/architecture/crdt-data-model.md:642:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
./quantbook-engine/docs/architecture/crdt-data-model.md:665:shows `#NAME?` after the merge. Phase 5.3 adds a causality-
./quantbook-engine/docs/architecture/crdt-data-model.md:667:walks formulas added causally-before the RenameSheet op and
./quantbook-engine/docs/architecture/crdt-data-model.md:677:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
./quantbook-engine/docs/architecture/crdt-data-model.md:734:   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/architecture/crdt-data-model.md:797:- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/architecture/ide-consumer-contract.md:195:- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. Causality-aware rename-repair pass at merge time is deferred to Phase 5.3.
./quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:5:**Status:** DESIGN (pre-implementation, Codex-reviewed). Implementation shipped Phase 4.5.D (W5-79 / W5-80 / W5-81). **PARTIALLY SUPERSEDED by D-1 (2026-05-19/20):** the § 7 `FormatTable` shape (`next_custom_id: u32`, single `by_string: HashMap<String, FormatId>`, no `local_peer`/`with_peer`/`set_local_peer`) and § 7.3 `Op::RegisterFormat { id: FormatId }` are pre-D-1 designs. Current post-D-1 shape: `FormatId` is a tagged enum `Builtin(u32) | Custom(PeerId, u32)`; `FormatTable` carries `local_peer: PeerId` + split `by_builtin_string` / `by_custom_string` ((peer, string)-keyed); ops carry `FormatIdWire`. See `docs/architecture/crdt-data-model.md` § D-1 and `docs/phase5/d-1-starting-checklist.md` for the current shape + audit-locked decisions.
./quantbook-engine/docs/phase5/v1-exit-packet.md:21:`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
./quantbook-engine/docs/phase5/v1-exit-packet.md:30:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
./quantbook-engine/docs/phase5/v1-exit-packet.md:226:- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
./quantbook-engine/docs/phase5/v1-exit-packet.md:228:  for concurrent edits to renamed sheets). 4-7 days estimated.
./quantbook-engine/docs/phase5/v1-exit-packet.md:269:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:39:- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:69:`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }` — old_name carried so replay can validate against the workbook state at replay time without scanning prior ops. Replay calls `Workbook::rename_sheet(id, new_name)` which is idempotent given matching old/new.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:257:**`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }`** — per § 3.2. `old_name` carried for replay validation. Replay calls `Workbook::rename_sheet(id, new_name)`.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:263:- `ReplayError::SheetRenameUnknownSheet { id }` — `RenameSheet` references a sheet that wasn't created by earlier ops.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:309:### 10.3 Phase 4.6.C — Sheet rename + Op::RenameSheet
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:312:- New `WorkbookRuntime::rename_sheet` wrapper emitting `Op::RenameSheet`.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:369:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:382:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
./quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:416:- `Op::RenameSheet { old_name, new_name }` field choice — confirmed at § 3.2; revisit if collab/CRDT semantics (Phase 5) want a different shape.
./quantbook-engine/docs/known-gaps.md:113:| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/phase5/entry-plan.md:185:- `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/phase5/d-1-starting-checklist.md:200:- ✅ M1 (doc drift, 5 sites): collab session.rs export_bytes/sweep_presence, presence.rs, oplog log.rs, crdt-data-model.md — all reframed for post-Tier-D3 file-vs-transport contract.
./quantbook-engine/docs/phase5/d-1-starting-checklist.md:222:- 5-site cross-crate doc drift fixes (`CollabSession::export_bytes` + `sweep_presence`, `presence.rs`, `oplog/log.rs`, `crdt-data-model.md`).
./quantbook-engine/docs/phase5/d-1-starting-checklist.md:240:- [ ] You've read this doc's Step 4 + Step 5 sections (most-recent + next), `docs/audits/2026-05-20-phase-5-2-d-1-step-4-consolidated.md` (most-recent audit), and `crdt-data-model.md` § "Format id collision" (overall design status). `v1-exit-packet.md` is broader Phase 5 V1 context if needed.
./quantbook-engine/docs/phase5/d-1-exit-packet.md:125:- Architecture: `docs/architecture/crdt-data-model.md` § D-1
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:485:    33	//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1410:   128	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1757:   455	        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2951:   180	            Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3980:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4348:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:76:9. **Doc cross-references.** The d-1-checklist marks step 2 ✅ shipped. Are there other doc surfaces that mention `FormatIdWire` ahead of time (e.g. crdt-data-model.md § "D-1") that should be updated post-ship to point at the actual shipped type?
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:1454:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7325:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7329:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7342:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7354:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7359:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7400:quantbook-engine/docs/phase5/d-1-starting-checklist.md:163:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7408:quantbook-engine/docs/architecture/crdt-data-model.md:449:**Phase 5 V1 COMPLETE 2026-05-19. D-1 step 1.1 (2026-05-19) moved PeerId to `ql_types`.** Current 4-module surface (verified against `crates/ql-collab/src/lib.rs`):
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7409:quantbook-engine/docs/architecture/crdt-data-model.md:459:// PeerId lives in ql_types (D-1 step 1.1); re-exported through ql_oplog.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7410:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7411:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7412:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7413:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7414:quantbook-engine/docs/architecture/crdt-data-model.md:576:  `cellXfs` numFmtId mapping all change.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7415:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7416:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7417:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7418:quantbook-engine/docs/architecture/crdt-data-model.md:711:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7419:quantbook-engine/docs/architecture/crdt-data-model.md:713:   in Phase 5.2 D-1 (next-session multi-day arc; see
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7489:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7491:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7495:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7497:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7522:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7533:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7534:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7535:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7536:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7537:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7538:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7539:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7540:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7653:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7665:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7667:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7668:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7669:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7693:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7696:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7749:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7893:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:614:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7897:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:618:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7909:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:631:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7911:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:633:quantbook-engine/docs/architecture/crdt-data-model.md:541:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7912:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:634:quantbook-engine/docs/architecture/crdt-data-model.md:557:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7913:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:635:quantbook-engine/docs/architecture/crdt-data-model.md:561:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7914:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:637:quantbook-engine/docs/architecture/crdt-data-model.md:573:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7915:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:638:quantbook-engine/docs/architecture/crdt-data-model.md:578:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7916:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:639:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7917:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:640:quantbook-engine/docs/architecture/crdt-data-model.md:709:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7918:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:641:quantbook-engine/docs/architecture/crdt-data-model.md:710:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7919:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:643:quantbook-engine/docs/architecture/crdt-data-model.md:712:   in Phase 5.2 D-1 (next-session multi-day arc; see
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7930:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:655:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7935:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:662:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7972:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:700:quantbook-engine/docs/phase5/d-1-starting-checklist.md:153:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8356:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1251:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8358:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1253:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8362:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1257:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8364:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1259:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8389:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1334:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8400:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1345:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8401:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1346:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8402:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1347:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8403:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1348:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8404:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1349:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8405:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1350:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8406:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1351:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8407:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1352:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8437:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1382:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8448:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1395:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8450:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1397:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8451:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1398:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8452:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1400:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8475:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1426:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8478:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1429:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:8888:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1854:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9271:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2424:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9282:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2437:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9287:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2444:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9323:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2481:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9349:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2508:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9351:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2510:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9352:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2511:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9353:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2512:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9354:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2513:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9355:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2514:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9356:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2515:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9357:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2516:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9358:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2517:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9359:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2518:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9378:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2540:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9746:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2912:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9753:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2924:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9758:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2929:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9789:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2966:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9791:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2968:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9795:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2972:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9797:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2974:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9801:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2984:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9804:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2992:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9814:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3711:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9819:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3733:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9857:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3858:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:9999:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10001:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10005:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10007:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10032:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10043:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10044:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10045:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10046:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10047:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10048:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10049:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10050:./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10147:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10409:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10411:./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10634:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10645:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10650:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10687:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10714:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10716:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10717:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10718:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10719:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10720:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10721:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10722:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10723:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10724:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:10744:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11324:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11333:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11347:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11415:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11417:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11421:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11423:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11427:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11430:./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12276:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12374:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '532,592p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12393:   549	open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12439:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '704,716p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12443:   706	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13195:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13962:/bin/zsh -lc 'rg -n "from_storage|to_storage|FormatIdWire|FormatId" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13964:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13965:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13966:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13967:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13968:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13969:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13970:quantbook-engine/docs/architecture/crdt-data-model.md:711:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14084:Detail: The checklist marks step 2 shipped, but the commit line still says `pending`. `crdt-data-model.md` can remain overall “implementation pending” for D-1, but the checklist should point at `135bbb99f75` now.  
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:14115:Detail: The checklist marks step 2 shipped, but the commit line still says `pending`. `crdt-data-model.md` can remain overall “implementation pending” for D-1, but the checklist should point at `135bbb99f75` now.  
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:83:D1. `crdt-data-model.md` § Undo/redo (Phase 5.4 preview, lines ~307-320) was written pre-implementation. Now that V1 ships, does it need a "✅ V1 shipped at 89c02b9d83e" marker?
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:412:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:841:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1071:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1138:    14	# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2134:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2135:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2136:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2137:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2138:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2139:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2152:quantbook-engine/crates/ql-collab/src/undo.rs:11://! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2276:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2277:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4390:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4391:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7880:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '300,360p;388,405p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7885:   303	character-level concurrent editing of one long formula) that
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7888:   306	## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7895:   313	target. Phase 5.3 formalizes this with these defaults:
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7905:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7906:   324	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7995:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13046:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13068:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13103:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13125:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3476:crates/ql-oplog/src/replay.rs:119:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3488:crates/ql-oplog/src/replay.rs:381:        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3531:crates/ql-oplog/src/replay.rs:1434:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3533:crates/ql-oplog/src/replay.rs:1445:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3534:crates/ql-oplog/src/replay.rs:1463:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3535:crates/ql-oplog/src/replay.rs:1481:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3536:crates/ql-oplog/src/replay.rs:1498:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3539:crates/ql-oplog/src/replay.rs:1526:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3545:crates/ql-oplog/src/replay.rs:1569:                Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4625:crates/ql-oplog/tests/producer_replay_equivalence.rs:181:            Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4974:crates/ql-exec/src/workbook_runtime.rs:2201:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4983:crates/ql-exec/src/workbook_runtime.rs:2269:            ops.push(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:20:- Doc drift across `crdt-data-model.md` / `entry-plan.md` / `known-gaps.md`.
./quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1172:crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:490:    21	+ Phase 5.3 conflict resolution + Phase 5.5 V2 V2/V3 (WebSocket /
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:499:    30	| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:697:   228	- **Phase 5.3 — Conflict resolution semantics.** Causality-aware
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:699:   230	  for concurrent edits to renamed sheets). 4-7 days estimated.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:734:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '400,500p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:920:   185	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1055:quantbook-engine/docs/architecture/crdt-data-model.md:218:**Phase 5.6 V1 ✅ shipped at `c677e244704` (2026-05-19).**
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1056:quantbook-engine/docs/architecture/crdt-data-model.md:221:during 5.6 V1 deviated from the pre-implementation "UUIDs"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1057:quantbook-engine/docs/architecture/crdt-data-model.md:261:**V2 ✅ shipped 2026-05-19:** `CollabSession::sweep_presence()`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1058:quantbook-engine/docs/architecture/crdt-data-model.md:354:### Wired surface (V1 + V2 V1)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1059:quantbook-engine/docs/architecture/crdt-data-model.md:361:- **V2 V1 (`6138a7203f6` + `e199a5fda5a`):**
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1060:quantbook-engine/docs/architecture/crdt-data-model.md:365:- **V2 V1:** `set_undo_merge_interval(i64)` — auto-merge
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1061:quantbook-engine/docs/architecture/crdt-data-model.md:367:- **V2 V1.1:** `start_undo_group_scoped() -> Result<UndoGroupGuard<'_>, _>`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1062:quantbook-engine/docs/architecture/crdt-data-model.md:378:### V1 / V2 V1 limitations / V2 V2 follow-ups
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1063:quantbook-engine/docs/architecture/crdt-data-model.md:381:- ~~No RAII closure helper~~ — V2 V1.1 ships
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1064:quantbook-engine/docs/architecture/crdt-data-model.md:404:**V2 V1 ✅ shipped at `ffd8f6e5f05` (2026-05-19):**
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1065:quantbook-engine/docs/architecture/crdt-data-model.md:421:`LoopbackTransport` + V2 V1's `attach_transport`/`flush`/`poll`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1066:quantbook-engine/docs/architecture/crdt-data-model.md:426:confirms the substrate works regardless; 5.5 V1 + V2 V1 prove
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1067:quantbook-engine/docs/architecture/crdt-data-model.md:465:- `presence` — Phase 5.6 cursor + selection map.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1070:quantbook-engine/docs/architecture/crdt-data-model.md:559:tagged tuple:
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1075:quantbook-engine/docs/architecture/crdt-data-model.md:585:collaboration tooling wants. The tagged tuple gives the same
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1204:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1571:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '520,600p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1602:   549	open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1649:   596	deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1927:   575	   Acceptance: CON-5-01 formula/value concurrent edits deterministic; CON-5-02 sheet/name conflicts deterministic; CON-5-03 conflicts visible in IDE diagnostics.  
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2027:quantbook-engine/docs/MASTER-PLAN.md:864:   Decide by Phase 5.3.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2031:/bin/zsh -lc 'rg -n "docs/audits/2026-05-19|phase-5|tier-d1|exit-packet|d-1-starting" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2037:quantbook-engine/docs/architecture/crdt-data-model.md:10:  - docs/audits/2026-05-19-phase-5-1-codex.md
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2038:quantbook-engine/docs/architecture/crdt-data-model.md:11:  - docs/audits/2026-05-19-phase-5-1-opus.md
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2039:quantbook-engine/docs/architecture/crdt-data-model.md:12:  - docs/audits/2026-05-19-phase-5-1-consolidated.md
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2040:quantbook-engine/docs/architecture/crdt-data-model.md:530:- `docs/audits/2026-05-19-phase-5-1-codex.md`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2041:quantbook-engine/docs/architecture/crdt-data-model.md:531:- `docs/audits/2026-05-19-phase-5-1-opus.md`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2042:quantbook-engine/docs/architecture/crdt-data-model.md:532:- `docs/audits/2026-05-19-phase-5-1-consolidated.md`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2043:quantbook-engine/docs/architecture/crdt-data-model.md:539:The parallel Codex + Opus audit (transcripts in `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md`)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2044:quantbook-engine/docs/architecture/crdt-data-model.md:732:- `docs/audits/2026-05-19-phase-5-1-codex.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2045:quantbook-engine/docs/architecture/crdt-data-model.md:733:- `docs/audits/2026-05-19-phase-5-1-opus.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2046:quantbook-engine/docs/architecture/crdt-data-model.md:734:- `docs/audits/2026-05-19-phase-5-1-consolidated.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2072:quantbook-engine/docs/phase5/v1-exit-packet.md:30:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2452:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5693:   128	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6682:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:381:/bin/zsh -lc 'nl -ba docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6692:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6698:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1998:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6699:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2000:/bin/zsh -lc 'git ls-files --stage Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6705:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2104:/bin/zsh -lc 'git show 66a571b30af:docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6707:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2126:/bin/zsh -lc 'git show 66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6720:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3196:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6937:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6948:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6953:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2288:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7968:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7880:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '300,360p;388,405p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7976:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8442:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:334:/bin/zsh -lc "rg --files -g 'Cargo.toml' -g 'log.rs' -g 'session.rs' -g 'peer.rs' -g 'crdt-data-model.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8443:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:372:/bin/zsh -lc 'git diff --stat 687e5dd3995..HEAD && git diff --find-renames -- crates/ql-oplog/src/log.rs crates/ql-collab/src/session.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8546:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1367:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10801:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11143:/bin/zsh -lc 'rg -n "undo module|Reserved module|V2 V1|group_start|merge-interval|No grouping API|No merge-interval|start_undo_group|set_undo_merge_interval" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/crates/ql-collab/src/lib.rs quantbook-engine/crates/ql-collab/src/session.rs -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11119:quantbook-engine/docs/architecture/crdt-data-model.md:2:title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11120:quantbook-engine/docs/architecture/crdt-data-model.md:19:Lock the Loro container-shape decision for Phase 5 collaborative
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11121:quantbook-engine/docs/architecture/crdt-data-model.md:26:top of Loro CRDTs so that 2+ peers can edit concurrently and the
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11122:quantbook-engine/docs/architecture/crdt-data-model.md:30:`LoroDoc`. The narrow question for 5.1 is whether to:
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11123:quantbook-engine/docs/architecture/crdt-data-model.md:32:- **(A) Keep the op-log shape.** Op-list-in-Loro is already a
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11124:quantbook-engine/docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11125:quantbook-engine/docs/architecture/crdt-data-model.md:36:- **(B) Re-shape state as typed Loro containers per feature.**
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11126:quantbook-engine/docs/architecture/crdt-data-model.md:37:  Cells, names, sheets, tables, formats become LoroMap /
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11127:quantbook-engine/docs/architecture/crdt-data-model.md:38:  LoroList / LoroText containers directly. Merge semantics are
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11128:quantbook-engine/docs/architecture/crdt-data-model.md:42:  log; sheets list becomes a LoroMovableList; names become a
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11129:quantbook-engine/docs/architecture/crdt-data-model.md:43:  LoroMap.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11130:quantbook-engine/docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11131:quantbook-engine/docs/architecture/crdt-data-model.md:59:    doc: LoroDoc,
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11132:quantbook-engine/docs/architecture/crdt-data-model.md:64:- One `LoroDoc` per workbook.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11133:quantbook-engine/docs/architecture/crdt-data-model.md:65:- All ops live in a single `LoroList` named `"ops"`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11134:quantbook-engine/docs/architecture/crdt-data-model.md:67:  `LoroValue::String` into the list.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11135:quantbook-engine/docs/architecture/crdt-data-model.md:84:## How Loro behavior changes when peers exchange updates
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11136:quantbook-engine/docs/architecture/crdt-data-model.md:90:1. Each peer holds a `LoroDoc` representing the workbook.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11137:quantbook-engine/docs/architecture/crdt-data-model.md:91:2. Peers exchange `LoroDoc` updates via Loro's
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11138:quantbook-engine/docs/architecture/crdt-data-model.md:93:3. Loro merges concurrent `LoroList::push` operations by
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11139:quantbook-engine/docs/architecture/crdt-data-model.md:104:draft of this section claimed Loro's merge rule is "Lamport
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11140:quantbook-engine/docs/architecture/crdt-data-model.md:106:timestamps." Both descriptions were imprecise. The actual Loro
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11141:quantbook-engine/docs/architecture/crdt-data-model.md:116:for free from Loro + the engine's deterministic replay path
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11142:quantbook-engine/docs/architecture/crdt-data-model.md:117:(Phase 4); we do NOT get it from Loro alone choosing one push
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11143:quantbook-engine/docs/architecture/crdt-data-model.md:148:Loro's `LoroList` doesn't try to merge string contents. It
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11144:quantbook-engine/docs/architecture/crdt-data-model.md:153:If we used typed containers, we'd inherit Loro's
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11145:quantbook-engine/docs/architecture/crdt-data-model.md:154:per-container merge semantics — useful in some cases (LoroText
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11146:quantbook-engine/docs/architecture/crdt-data-model.md:157:(LoroMap merge for `name_table: LoroMap<String, NamedTarget>`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11147:quantbook-engine/docs/architecture/crdt-data-model.md:164:`LoroDoc::export(ExportMode::Snapshot)` already produces a
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11148:quantbook-engine/docs/architecture/crdt-data-model.md:180:diagnostic by inspecting the Loro version vector at the LWW
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11149:quantbook-engine/docs/architecture/crdt-data-model.md:186:edit non-overlapping ranges. Loro merges the op list in O(n) on
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11150:quantbook-engine/docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11151:quantbook-engine/docs/architecture/crdt-data-model.md:197:### One `LoroDoc` per workbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11152:quantbook-engine/docs/architecture/crdt-data-model.md:199:Carry through from `ql-oplog`. Each workbook = one `LoroDoc`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11153:quantbook-engine/docs/architecture/crdt-data-model.md:201:(presence below).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11154:quantbook-engine/docs/architecture/crdt-data-model.md:203:### Persistent state container: `"ops"` LoroList
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11155:quantbook-engine/docs/architecture/crdt-data-model.md:209:LoroDoc
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11156:quantbook-engine/docs/architecture/crdt-data-model.md:210:└── LoroList "ops"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11157:quantbook-engine/docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11158:quantbook-engine/docs/architecture/crdt-data-model.md:222:language since PeerId is u64-native to match Loro's PeerID type);
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11159:quantbook-engine/docs/architecture/crdt-data-model.md:227:LoroDoc
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11160:quantbook-engine/docs/architecture/crdt-data-model.md:228:├── LoroList "ops"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11161:quantbook-engine/docs/architecture/crdt-data-model.md:229:└── LoroMap "presence"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11162:quantbook-engine/docs/architecture/crdt-data-model.md:234:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11163:quantbook-engine/docs/architecture/crdt-data-model.md:240:  its own key. LoroMap LWW merge gives "last position update
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11164:quantbook-engine/docs/architecture/crdt-data-model.md:245:save/load." The V1 implementation persists presence *de facto*
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11165:quantbook-engine/docs/architecture/crdt-data-model.md:246:because it lives in the same `LoroDoc` as `"ops"`, and
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11167:quantbook-engine/docs/architecture/crdt-data-model.md:249:restore stale presence entries.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11168:quantbook-engine/docs/architecture/crdt-data-model.md:253:   own entry is overwritten on first `update_presence` call.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11169:quantbook-engine/docs/architecture/crdt-data-model.md:258:   (Loro doesn't expose this) or a load-time `presence_remove`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11170:quantbook-engine/docs/architecture/crdt-data-model.md:261:**V2 ✅ shipped 2026-05-19:** `CollabSession::sweep_presence()`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11171:quantbook-engine/docs/architecture/crdt-data-model.md:262:clears all presence entries (own + remote) and returns the
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11172:quantbook-engine/docs/architecture/crdt-data-model.md:269:Earlier `clear_presence` (V1) remains for the "leave session"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11173:quantbook-engine/docs/architecture/crdt-data-model.md:272:### Snapshot container: `"snapshot"` LoroMap (reserved, V2)
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11174:quantbook-engine/docs/architecture/crdt-data-model.md:276:version vector. Replay against a snapshot skips ops older than
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11175:quantbook-engine/docs/architecture/crdt-data-model.md:282:LoroDoc
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11176:quantbook-engine/docs/architecture/crdt-data-model.md:283:└── LoroMap "cells"
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11177:quantbook-engine/docs/architecture/crdt-data-model.md:284:    ├── "0,0,0": LoroMap { value: ..., formula: ..., format_id: ... }
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11178:quantbook-engine/docs/architecture/crdt-data-model.md:285:    ├── "0,0,1": LoroMap { ... }
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11179:quantbook-engine/docs/architecture/crdt-data-model.md:293:   completing BEFORE set_value(target). Loro's per-container
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11180:quantbook-engine/docs/architecture/crdt-data-model.md:299:3. Loro overhead per container is non-trivial. 100k containers
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11181:quantbook-engine/docs/architecture/crdt-data-model.md:313:The 5.1 design picks Option A → conflicts resolve by Loro's
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11182:quantbook-engine/docs/architecture/crdt-data-model.md:339:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11183:quantbook-engine/docs/architecture/crdt-data-model.md:342:the visible `"ops"` LoroList — so `OpLog::len()` shrinks
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11184:quantbook-engine/docs/architecture/crdt-data-model.md:345:Loro neither physically removes nor tombstones — it composes
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11185:quantbook-engine/docs/architecture/crdt-data-model.md:373:Plus `pub use loro::UndoManager` in `ql_collab::undo` for
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11186:quantbook-engine/docs/architecture/crdt-data-model.md:375:(`PRESENCE_COMMIT_ORIGIN = "presence:"`) are auto-excluded so
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11187:quantbook-engine/docs/architecture/crdt-data-model.md:380:- No push/pop listeners (`UndoManager::set_on_push` / `set_on_pop`) — defer to V2 V2.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11188:quantbook-engine/docs/architecture/crdt-data-model.md:385:- `set_peer_id` after construction silently CLEARS the undo
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11189:quantbook-engine/docs/architecture/crdt-data-model.md:386:  stack per Loro's internal subscription. V1 made
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11190:quantbook-engine/docs/architecture/crdt-data-model.md:387:  `OpLog::set_peer_id` `&mut self` so the footgun isn't
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11191:quantbook-engine/docs/architecture/crdt-data-model.md:391:  `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11192:quantbook-engine/docs/architecture/crdt-data-model.md:411:Loro's wire format:
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11193:quantbook-engine/docs/architecture/crdt-data-model.md:412:- `LoroDoc::export(ExportMode::Updates(version_vector))` →
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11194:quantbook-engine/docs/architecture/crdt-data-model.md:414:- `LoroDoc::import(bytes)` → merge into local doc.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11195:quantbook-engine/docs/architecture/crdt-data-model.md:417:transport version vector + send deltas, not full snapshots);
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11198:quantbook-engine/docs/architecture/crdt-data-model.md:439:  workbook (no peer IDs, no presence).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11199:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11200:quantbook-engine/docs/architecture/crdt-data-model.md:465:- `presence` — Phase 5.6 cursor + selection map.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11201:quantbook-engine/docs/architecture/crdt-data-model.md:466:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11202:quantbook-engine/docs/architecture/crdt-data-model.md:488:closed by adding `OpLog::set_peer_id` and calling it from
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11203:quantbook-engine/docs/architecture/crdt-data-model.md:490:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11204:quantbook-engine/docs/architecture/crdt-data-model.md:492:pitfall (from Loro docs): concurrent sessions MUST use distinct peer
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11205:quantbook-engine/docs/architecture/crdt-data-model.md:649:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11206:quantbook-engine/docs/architecture/crdt-data-model.md:693:   Loro's default is per-doc random `u64`; Phase 5.2 wires
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11207:quantbook-engine/docs/architecture/crdt-data-model.md:699:   ONCE into the LoroList. A concurrent peer's op can land
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11208:quantbook-engine/docs/architecture/crdt-data-model.md:721:- `crates/ql-oplog/src/log.rs` (the existing LoroDoc wrapper).
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11498:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:529:docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11500:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:531:docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11546:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:646:docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11558:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:658:docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11559:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11560:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:660:docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11561:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:661:docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11562:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:662:docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11563:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:663:docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11588:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:688:docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11606:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:706:docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11610:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:710:docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11614:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:958:docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11695:/bin/zsh -lc 'rg -o "`[0-9a-f]{10,12}`|[0-9a-f]{10,12}" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed '"'s/.*://; s/"'`//g'"' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11703:/bin/zsh -lc "setopt NO_NOMATCH; rg -o '[0-9a-f]{10,12}' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*://' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11827:/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '700,745p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11835:   706	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11860:   731	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11874:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11944:/bin/zsh -lc "rg -o 'docs/audits/[A-Za-z0-9_./{}*,-]+' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*:docs/docs/' | sort -u" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12132:- [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:560) still shows Phase 5 as unstarted generic work. Update 5.1, 5.2 partial, 5.4, 5.5 V1/V2 V1, 5.6 V1/V2 statuses, and replace stale deliverable `docs/architecture/collaboration-crdt.md` at [line 627](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:627) with `docs/architecture/crdt-data-model.md` plus `v1-exit-packet.md`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12134:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:447) has a stale `ql-collab` crate scope snippet listing only scaffold modules and calling presence/undo “reserved.” Replace with the current five-module surface from `crates/ql-collab/src/lib.rs`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12139:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:732) still marks Phase 5.1 audit deliverables “pending” even though the files exist. Mark them shipped.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12166:- [MASTER-PLAN.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:560) still shows Phase 5 as unstarted generic work. Update 5.1, 5.2 partial, 5.4, 5.5 V1/V2 V1, 5.6 V1/V2 statuses, and replace stale deliverable `docs/architecture/collaboration-crdt.md` at [line 627](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md:627) with `docs/architecture/crdt-data-model.md` plus `v1-exit-packet.md`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12168:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:447) has a stale `ql-collab` crate scope snippet listing only scaffold modules and calling presence/undo “reserved.” Replace with the current five-module surface from `crates/ql-collab/src/lib.rs`.
./quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12173:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:732) still marks Phase 5.1 audit deliverables “pending” even though the files exist. Mark them shipped.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-opus.md:38:**M4-M7 — Doc drift across 5 files** (crdt-data-model.md,
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:154:**H.2 — `RenameSheet` op structure:** PASS  
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:166:`workbook_runtime.rs:862–877`: the `BatchCommit` contains `[PutFormula × N, RenameSheet]`. The rename op is always last — replaying the batch in order restores formula texts before the rename, matching the producer-side order.
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:210:`workbook_runtime.rs:862–877` appends the `BatchCommit` (PutFormulas + RenameSheet) BEFORE the formula text writes (`workbook_runtime.rs:884–886`) and the actual sheet rename (`workbook_runtime.rs:888–890`).
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:253:When no formula references the renamed sheet, `rewritten_cells` is empty, the `BatchCommit` contains only `[RenameSheet]`, and the name swap proceeds. Correct.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-consolidated.md:33:crdt-data-model.md, entry-plan.md, known-gaps.md, lib.rs/session.rs)
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:22:| M1 (Codex M2 / Opus M1, convergent) | Codex+Opus | MEDIUM | Doc drift in 4 sites: collab session.rs:248 + 596, presence.rs:19, oplog log.rs:18 + crdt-data-model.md:437 — all imply oplog.bin is "raw Loro snapshot" post-Tier-D3. | Updated all 5 sites to reflect post-Tier-D3 file-vs-transport contract. Transport bytes (export_bytes) are raw Loro; file bytes (save_workbook_with_oplog) add Quantlab header. | ✅ |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-consolidated.md:57:### `docs/architecture/crdt-data-model.md`
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-opus.md:25:Also `docs/architecture/crdt-data-model.md:437` — `.qbook/oplog.bin` "remains the same Loro snapshot blob."
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-opus.md:28:- M1: Doc drift across 4 files (transport.rs, crdt-data-model.md, entry-plan.md, known-gaps.md).
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-opus.md:63:  crdt-data-model.md / entry-plan.md / known-gaps.md.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32042:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1807:docs/architecture/2026-05-13-cross-sheet-references.md:263:- `ReplayError::SheetRenameUnknownSheet { id }` — `RenameSheet` references a sheet that wasn't created by earlier ops.
./quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2226:docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:169:**J.1** `WorkbookRuntime::rename_sheet` ordering: validate name → snapshot formulas → log BatchCommit (rewrite ops + RenameSheet) → apply rewrites → swap name → `plan_cache.clear()`. Verify the order: a failure between log-append and storage-mutation must not leave divergent state. Specifically: what happens if `oplog.append` succeeds but the subsequent storage write panics? (Probably can't happen given the validations, but verify.)
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1460:     RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1677:     /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1784:         Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2240:     // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2244:         // AddSheet + RenameSheet replays into a sheet with the new name.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2251:         log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2269:         log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2287:         log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2304:         log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3193:             Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4366:    33	//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5380:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5707:   461	        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6796:  1550	    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6800:  1554	        // AddSheet + RenameSheet replays into a sheet with the new name.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6807:  1561	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6825:  1579	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6843:  1597	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6860:  1614	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6888:  1642	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6931:  1685	                Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8072:quantbook-engine/docs/architecture/crdt-data-model.md:78:- Formats: `RegisterFormat`, `SetCellFormat`
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8073:quantbook-engine/docs/architecture/crdt-data-model.md:128:`.qbook` cold-load. Every Phase 4 fix carries forward.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8074:quantbook-engine/docs/architecture/crdt-data-model.md:244:design said "Presence updates do NOT persist across `.qbook`
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8077:quantbook-engine/docs/architecture/crdt-data-model.md:266:slate (cold restart of a `.qbook`) call sweep after
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8078:quantbook-engine/docs/architecture/crdt-data-model.md:429:## Backwards compatibility with `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8079:quantbook-engine/docs/architecture/crdt-data-model.md:432:workbook as a `.qbook/` directory with JSON manifests +
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8082:quantbook-engine/docs/architecture/crdt-data-model.md:438:- Loading a `.qbook` still produces a single-writer-equivalent
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8083:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8084:quantbook-engine/docs/architecture/crdt-data-model.md:553:`Op::RegisterFormat { id: N, string: <different> }`. Replay's
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8085:quantbook-engine/docs/architecture/crdt-data-model.md:573:- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8086:quantbook-engine/docs/architecture/crdt-data-model.md:575:  signature, `.qbook` envelope cell-format-id encoding, xlsx
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8087:quantbook-engine/docs/architecture/crdt-data-model.md:578:- Backwards compat: old `.qbook` files with `u32` ids load as
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8170:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:369:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8171:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:382:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10793:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:335:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10794:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:336:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10796:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:426:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10797:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:427:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10803:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10963:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10551:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10964:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10552:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11904:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11199:quantbook-engine/docs/architecture/crdt-data-model.md:440:- Joining a session = load `.qbook` locally + receive Loro
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11909:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11559:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11962:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:657:- **R-E:** Sheet rename + op-log replay determinism. If a `.qbook` snapshot is saved AFTER a rename and the op-log replayed against a fresh empty workbook, the snapshot's `Sheet::name` and the op-log's `RenameSheet` events both need to converge. **Mitigation:** snapshot is authoritative for sheet names; op-log replay applies AFTER snapshot is loaded (current `load_workbook_and_recompute` order).
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11963:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:670:- [ ] **XS-4-04:** `Op::RenameSheet`, `Op::SetSheetScopedName` round-trip through replay + `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-opus.md:41:- `crdt-data-model.md` § Undo/redo: V1 wired surface → "V1 + V2 V1
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9330:   119	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10635:   390	        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:76:D1. `crdt-data-model.md` § Transport (V1 partially shipped) — does V2 V1 need updating?
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:476:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:477:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:478:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:479:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:480:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:481:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 — V1 partially shipped)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:482:docs/architecture/crdt-data-model.md:375:**V1 ✅ shipped at `924750819bc` (2026-05-19):** `Transport`
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:483:docs/architecture/crdt-data-model.md:376:trait + `NoopTransport` (5.2.a) + `LoopbackTransport` (5.5 V1)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:484:docs/architecture/crdt-data-model.md:388:**V2 pending:** WebSocket transport (or any bidirectional byte
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:485:docs/architecture/crdt-data-model.md:395:5.1 does NOT pick a production transport (WS vs Server-Sent
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:486:docs/architecture/crdt-data-model.md:396:Events vs custom protocol) — that's 5.5 V2's call. 5.1 just
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:487:docs/architecture/crdt-data-model.md:397:confirms the substrate works regardless; 5.5 V1 proves it via
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:488:docs/architecture/crdt-data-model.md:415:the new transport path handles the multi-peer case. Both call
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:489:docs/architecture/crdt-data-model.md:428:pub mod transport;   // trait Transport + NoopTransport test impl
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:490:docs/architecture/crdt-data-model.md:432:pub use transport::{NoopTransport, Transport, TransportError};
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:491:docs/architecture/crdt-data-model.md:445:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:492:docs/architecture/crdt-data-model.md:658:1. **Op-log compaction policy** — deferred to Phase 5.5
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:689:docs/audits/2026-05-19-handoff-audit-codex.md:1860:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:690:docs/audits/2026-05-19-handoff-audit-codex.md:1866:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:691:docs/audits/2026-05-19-handoff-audit-codex.md:1869:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:692:docs/audits/2026-05-19-handoff-audit-codex.md:1872:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:693:docs/audits/2026-05-19-handoff-audit-codex.md:1885:docs/architecture/crdt-data-model.md:322:## Transport (Phase 5.5 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:694:docs/audits/2026-05-19-handoff-audit-codex.md:1886:docs/architecture/crdt-data-model.md:329:Phase 5.5 wraps these with a WebSocket transport (or any
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:695:docs/audits/2026-05-19-handoff-audit-codex.md:1913:docs/architecture/crdt-data-model.md:577:1. **Op-log compaction policy** — deferred to Phase 5.5
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:726:docs/audits/2026-05-19-phase-5-5-v1-codex.md:77:D1. `crdt-data-model.md` § Transport (Phase 5.5 preview) — needs "V1 LoopbackTransport shipped at 924750819bc" marker?
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:734:docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:767:docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:855:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2262:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:856:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2263:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:857:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2264:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:858:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2265:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:859:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2266:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:860:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2267:docs/architecture/crdt-data-model.md:380:Phase 5.5 wraps these with a WebSocket transport (or any
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:861:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2268:docs/architecture/crdt-data-model.md:385:5.1 does NOT pick a transport (WS vs Server-Sent Events vs
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:862:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2269:docs/architecture/crdt-data-model.md:404:the new transport path handles the multi-peer case. Both call
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:863:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2270:docs/architecture/crdt-data-model.md:417:pub mod transport;   // trait Transport + NoopTransport test impl
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:864:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2271:docs/architecture/crdt-data-model.md:421:pub use transport::{NoopTransport, Transport, TransportError};
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:865:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2272:docs/architecture/crdt-data-model.md:434:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:866:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2273:docs/architecture/crdt-data-model.md:647:1. **Op-log compaction policy** — deferred to Phase 5.5
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:904:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7515:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:910:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7552:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:917:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7579:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:923:docs/audits/2026-05-19-phase-5-5-v1-codex.md:7616:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1938:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '365,405p'; nl -ba docs/phase5/entry-plan.md | sed -n '104,116p'; nl -ba docs/known-gaps.md | sed -n '110,120p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2794:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:7906:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:8043:| LOW | [crdt-data-model.md:373](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:373), [entry-plan.md:111](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:111), [known-gaps.md:116](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:116), [transport.rs:6](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:6), [session.rs:12](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:12) | Docs still frame 5.5 V2 as fully pending and omit the attached-transport/manual flush+poll API. | Add V2 V1 marker `ffd8f6e5f05`, list the 5 `CollabSession` transport methods, and narrow remaining V2 to production transport/reconnect/offline/deltas/auto-flush. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:8098:| LOW | [crdt-data-model.md:373](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:373), [entry-plan.md:111](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:111), [known-gaps.md:116](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:116), [transport.rs:6](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:6), [session.rs:12](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:12) | Docs still frame 5.5 V2 as fully pending and omit the attached-transport/manual flush+poll API. | Add V2 V1 marker `ffd8f6e5f05`, list the 5 `CollabSession` transport methods, and narrow remaining V2 to production transport/reconnect/offline/deltas/auto-flush. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:5:design_under_review: docs/architecture/crdt-data-model.md @ 918d7efdd91
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:48:### RenameSheet × concurrent edit (Opus H-2, Codex V5)
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:163:1. Design doc (`docs/architecture/crdt-data-model.md`):
./quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1533:120:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2397:404:        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:5805:crates/ql-exec/src/workbook_runtime.rs:2537:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:20:- Doc currency across `current_work.md`, `MEMORY.md`, `docs/phase5/entry-plan.md`, `docs/architecture/crdt-data-model.md`, `docs/PHASE-4-V2-BACKLOG.md`.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-consolidated.md:52:**L2 (Codex) — crdt-data-model.md stale `pub mod peer` snippet.** The doc was written when PeerId lived in `ql-collab`. Updated to show `pub use ql_oplog::PeerId;` shape post step 1.1.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:26:- `918d7efdd91` Phase 5.1 design (crdt-data-model.md)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:48:### T3. crdt-data-model.md status markers
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:112: M docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:145:The branch and HEAD match the request. The worktree is already dirty: `Cargo.lock`, `docs/architecture/crdt-data-model.md`, and `docs/phase5/entry-plan.md` are modified, plus many untracked prompt/session files; I’ll treat those as current state and call out handoff impact rather than changing them.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:381:/bin/zsh -lc 'nl -ba docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:391:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:439:    14	# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:597:   148	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:678:    77	- Sheets: `AddSheet`, `RenameSheet`
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:757:   156	character-level concurrent edits) and harmful in others
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:775:   174	op came last. We do NOT show the user "two concurrent edits;
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:878:   277	   for every rewritten cell + the RenameSheet op). Per-cell
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:883:   282	character-level concurrent editing of one long formula) that
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:886:   285	## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:889:   288	LWW by Lamport-timestamp at the op-log level. Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:899:   298	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:900:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:901:   300	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1040:   439	open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1087:   486	deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1105:   504	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1128:   527	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1130:   529	walks formulas added causally-before the RenameSheet op and
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1140:   539	**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1197:   596	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1222:   621	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1856:docs/architecture/crdt-data-model.md:2:title: Phase 5.1 — CRDT Data Model Decision (Loro Container Shape)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1857:docs/architecture/crdt-data-model.md:8:master_plan: docs/MASTER-PLAN.md § Phase 5 § 5.1
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1858:docs/architecture/crdt-data-model.md:15:# Phase 5.1 — CRDT Data Model Decision
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1859:docs/architecture/crdt-data-model.md:19:Lock the Loro container-shape decision for Phase 5 collaborative
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1860:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1861:docs/architecture/crdt-data-model.md:47:**Adopt Option A (op-log preservation) as Phase 5 V1 with a
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1862:docs/architecture/crdt-data-model.md:50:Rationale below. Option B is a Phase 5 V2 / Phase 6 candidate;
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1863:docs/architecture/crdt-data-model.md:87:deterministic). The CRDT machinery is dormant. Phase 5 turns it
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1864:docs/architecture/crdt-data-model.md:120:## Why Option A is the right Phase 5 V1
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1865:docs/architecture/crdt-data-model.md:127:The replay path that Phase 5 inherits is the SAME path used by
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1866:docs/architecture/crdt-data-model.md:134:### Pro: 5.1 → 5.2 → 5.5 ships faster
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1867:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1868:docs/architecture/crdt-data-model.md:142:Option A gets Phase 5 to a "two peers editing one workbook"
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1869:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1870:docs/architecture/crdt-data-model.md:177:For Phase 5 V1 this is acceptable per master plan § 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1871:docs/architecture/crdt-data-model.md:189:testing post-5.2 will tell whether this is acceptable.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1872:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1875:docs/architecture/crdt-data-model.md:242:v8 may or may not persist it depending on whether the use case
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1876:docs/architecture/crdt-data-model.md:248:Phase 5 V2 may introduce a snapshot container that holds a
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1877:docs/architecture/crdt-data-model.md:251:that vector. Reserved name; no Phase 5 V1 implementation.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1878:docs/architecture/crdt-data-model.md:280:Option B / per-cell-container is Phase 5 V2 work at the
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1879:docs/architecture/crdt-data-model.md:285:## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1880:docs/architecture/crdt-data-model.md:288:LWW by Lamport-timestamp at the op-log level. Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1881:docs/architecture/crdt-data-model.md:298:| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1882:docs/architecture/crdt-data-model.md:299:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1885:docs/architecture/crdt-data-model.md:322:## Transport (Phase 5.5 preview)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1886:docs/architecture/crdt-data-model.md:329:Phase 5.5 wraps these with a WebSocket transport (or any
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1887:docs/architecture/crdt-data-model.md:345:Phase 5 preserves both. The CRDT additions are purely additive:
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1888:docs/architecture/crdt-data-model.md:361:Phase 5.2 populates it with:
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1889:docs/architecture/crdt-data-model.md:372:Each module is small (~200-400 LOC). Total Phase 5.2 crate
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1890:docs/architecture/crdt-data-model.md:381:Opus-C HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1891:docs/architecture/crdt-data-model.md:382:backlog) is a separate pre-5.2 item. Phase 5.1 design assumes
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1892:docs/architecture/crdt-data-model.md:383:Tier D2 closes before 5.2.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1893:docs/architecture/crdt-data-model.md:389:| 5.2 effort | 1-2 weeks | 3-4 weeks | 2-3 weeks |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1894:docs/architecture/crdt-data-model.md:399:**Choose Option A** for Phase 5 V1. Revisit Option B/C as Phase
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1895:docs/architecture/crdt-data-model.md:402:## Audit checkpoint (gating 5.2)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1896:docs/architecture/crdt-data-model.md:405:BEFORE any 5.2 code lands. Per the engine audit-discipline rule
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1897:docs/architecture/crdt-data-model.md:424:No 5.2 commits land until the consolidated audit doc is signed
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1899:docs/architecture/crdt-data-model.md:439:open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1901:docs/architecture/crdt-data-model.md:454:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1902:docs/architecture/crdt-data-model.md:471:  for migration. (Phase 5.2 designs the migration path.)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1904:docs/architecture/crdt-data-model.md:486:deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1905:docs/architecture/crdt-data-model.md:491:**Resolution:** Phase 5.2 acceptance criterion: AddSheet
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1907:docs/architecture/crdt-data-model.md:504:**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1908:docs/architecture/crdt-data-model.md:524:**Resolution:** Phase 5.2 adds the missing
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1909:docs/architecture/crdt-data-model.md:527:shows `#NAME?` after the merge. Phase 5.3 adds a causality-
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1910:docs/architecture/crdt-data-model.md:533:Documented as a **known Phase 5.2 V1 limitation**: concurrent
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1912:docs/architecture/crdt-data-model.md:539:**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1913:docs/architecture/crdt-data-model.md:577:1. **Op-log compaction policy** — deferred to Phase 5.5
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1914:docs/architecture/crdt-data-model.md:578:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1915:docs/architecture/crdt-data-model.md:582:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1916:docs/architecture/crdt-data-model.md:583:   Loro's default is per-doc random `u64`; Phase 5.2 wires
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1918:docs/architecture/crdt-data-model.md:596:   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1921:docs/architecture/crdt-data-model.md:607:- `docs/MASTER-PLAN.md` § Phase 5 (master spec).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1922:docs/architecture/crdt-data-model.md:608:- `docs/phase5/entry-plan.md` (Phase 5 entry status).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1923:docs/architecture/crdt-data-model.md:610:  cleanup; pre-5.2 prerequisite).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1924:docs/architecture/crdt-data-model.md:613:  Phase 5 inherits).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1925:docs/architecture/crdt-data-model.md:615:  function that Phase 5's merge path reuses).
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1926:docs/architecture/crdt-data-model.md:619:## Documentation deliverables (Phase 5.1 closure)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1927:docs/architecture/crdt-data-model.md:622:- `docs/audits/2026-05-19-phase-5-1-codex.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1928:docs/architecture/crdt-data-model.md:623:- `docs/audits/2026-05-19-phase-5-1-opus.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1929:docs/architecture/crdt-data-model.md:624:- `docs/audits/2026-05-19-phase-5-1-consolidated.md` — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1930:docs/architecture/crdt-data-model.md:625:- `docs/MASTER-PLAN.md` § Phase 5.1 update marking design
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1931:docs/architecture/crdt-data-model.md:626:  shipped + audit pending — pending.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1948:docs/MASTER-PLAN.md:864:   Decide by Phase 5.3.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1998:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2000:/bin/zsh -lc 'git ls-files --stage Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2005:100644 c7b297f05d2a93de060af2970f4fdbe684cc48f2 0	docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2104:/bin/zsh -lc 'git show 66a571b30af:docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2109:fatal: path 'quantbook-engine/docs/architecture/crdt-data-model.md' exists, but not 'docs/architecture/crdt-data-model.md'
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2110:hint: Did you mean '66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md' aka '66a571b30af:./docs/architecture/crdt-data-model.md'?
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2119: quantbook-engine/docs/architecture/crdt-data-model.md |  8 ++++++++
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2126:/bin/zsh -lc 'git show 66a571b30af:quantbook-engine/docs/architecture/crdt-data-model.md | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2267:   140	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2348:    77	- Sheets: `AddSheet`, `RenameSheet`
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2427:   156	character-level concurrent edits) and harmful in others
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2445:   174	op came last. We do NOT show the user "two concurrent edits;
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2548:   277	   for every rewritten cell + the RenameSheet op). Per-cell
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2553:   282	character-level concurrent editing of one long formula) that
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2556:   285	## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2559:   288	LWW by Lamport-timestamp at the op-log level. Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2569:   298	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2570:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2571:   300	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2708:   437	open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2753:   482	deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2792:   521	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2794:   523	walks formulas added causally-before the RenameSheet op and
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2859:   588	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2884:   613	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2907:    14	# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3196:/bin/zsh -lc 'git diff --quiet -- Cargo.lock docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3489:   160	- `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4152:- MEDIUM, T2, `docs/phase5/entry-plan.md:114-136`: risks/audit checkpoint still describe pre-5.1 state. Remove closed risks or mark them resolved; keep only D1/D3/C2/Phase 5.3+ risks.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4155:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4177:- MEDIUM, T2, `docs/phase5/entry-plan.md:114-136`: risks/audit checkpoint still describe pre-5.1 state. Remove closed risks or mark them resolved; keep only D1/D3/C2/Phase 5.3+ risks.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4180:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:25:**Finding:** `crdt-data-model.md:240` (pre-implementation) said
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:34:  block, with cross-ref to crdt-data-model.md).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:35:- `docs/architecture/crdt-data-model.md` § Presence container
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:60:- `crdt-data-model.md` § Presence container: ✅ V1 shipped
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:21:| `083ad235d24` W5-91 | Phase 4.6.C — sheet rename + formula-text rewrite + `Op::RenameSheet` |
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:39:- `crates/ql-oplog/src/op.rs` — `Op::RenameSheet`, `Op::SetName { scope, .. }` extension.
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:143:**H.3** `Op::RenameSheet` replay: 3-case reconciliation per design § 3.3 (current==old apply; current==new noop; else mismatch). Verify the canonical comparison uses `Workbook::canonical_sheet_name` (NOT raw `String::eq`).
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:145:**H.4** `Op::RenameSheet` producer side in `WorkbookRuntime::rename_sheet`: emits a BatchCommit containing all `PutFormula` rewrites for stored formula text PLUS the `RenameSheet`. Verify the order: rewrites first, then rename. Verify the rewrite captures `iter_formulas` snapshot BEFORE mutation (no live-iter mutation hazard).
./quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:169:**J.1** `WorkbookRuntime::rename_sheet` ordering: validate name → snapshot formulas → log BatchCommit (rewrite ops + RenameSheet) → apply rewrites → swap name → `plan_cache.clear()`. Verify the order: a failure between log-append and storage-mutation must not leave divergent state. Specifically: what happens if `oplog.append` succeeds but the subsequent storage write panics? (Probably can't happen given the validations, but verify.)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:77:D1. `crdt-data-model.md` § Transport (Phase 5.5 preview) — needs "V1 LoopbackTransport shipped at 924750819bc" marker?
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:264:/bin/zsh -lc "rg --files -g 'transport.rs' -g 'session.rs' -g 'Cargo.toml' -g 'crdt-data-model.md' -g 'entry-plan.md' -g 'known-gaps.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:270:quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:513://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1302:/bin/zsh -lc "rg -n \"Phase 5\\.5|LoopbackTransport|NoopTransport|Transport trait|future|GAP-C-05|transport\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md crates/ql-collab/src/session.rs crates/ql-collab/src/transport.rs crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2262:docs/architecture/crdt-data-model.md:33:  CRDT under concurrent peer appends. Phase 5 adds transport +
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2263:docs/architecture/crdt-data-model.md:140:- 5.5 (transport layer): same effort either way.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2264:docs/architecture/crdt-data-model.md:166:Phase 5.5's offline-sync work uses `ExportMode::ShallowSnapshot`
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2265:docs/architecture/crdt-data-model.md:191:Mitigation: Loro's `ShallowSnapshot` compaction (Phase 5.5)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2266:docs/architecture/crdt-data-model.md:373:## Transport (Phase 5.5 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2267:docs/architecture/crdt-data-model.md:380:Phase 5.5 wraps these with a WebSocket transport (or any
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2268:docs/architecture/crdt-data-model.md:385:5.1 does NOT pick a transport (WS vs Server-Sent Events vs
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2269:docs/architecture/crdt-data-model.md:404:the new transport path handles the multi-peer case. Both call
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2270:docs/architecture/crdt-data-model.md:417:pub mod transport;   // trait Transport + NoopTransport test impl
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2271:docs/architecture/crdt-data-model.md:421:pub use transport::{NoopTransport, Transport, TransportError};
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2272:docs/architecture/crdt-data-model.md:434:- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2273:docs/architecture/crdt-data-model.md:647:1. **Op-log compaction policy** — deferred to Phase 5.5
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2288:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2525:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7515:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7552:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7579:| LOW | `docs/architecture/crdt-data-model.md:373`, `docs/phase5/entry-plan.md:110`, `docs/known-gaps.md:116`, `crates/ql-collab/src/session.rs:12`, `crates/ql-collab/src/transport.rs:3` | Docs still describe Phase 5.5 as future / Noop-only. | Mark LoopbackTransport V1 shipped at `924750819bc`; leave WebSocket/offline sync as Phase 5.5 V2/future. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:7616:D1 FAIL doc cleanup. `crdt-data-model.md` still says Phase 5.5 preview.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:5:design_under_review: docs/architecture/crdt-data-model.md @ 918d7efdd91
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:15:`docs/architecture/crdt-data-model.md:442-447` (open question 5).
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:24:### H-2 — RenameSheet asymmetric merge → user-visible bug
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:26:`docs/architecture/crdt-data-model.md:281`. If peer A does
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:27:RenameSheet(S→X) and peer B concurrently writes `=S!A1`, then
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:34:restart. Consider producer-side RenameSheet rewrite-pass at
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:35:replay time to catch B's concurrent edits.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:39:`docs/architecture/crdt-data-model.md:280`. Spreadsheet users
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:50:`docs/architecture/crdt-data-model.md:99-100` claims "Loro's
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:71:`docs/architecture/crdt-data-model.md:247-250` states spill-
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:107:`docs/architecture/crdt-data-model.md:423-424` asks whether
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:122:`docs/architecture/crdt-data-model.md:165-175` acknowledges
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-opus.md:164:guardrails: format-id wire-format lock, RenameSheet user-
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:14:Audit the Phase 5.1 CRDT Data Model Decision at branch `feat/quantbook-engine` in repo `~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Design at `docs/architecture/crdt-data-model.md` (commit `918d7efdd91`).
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:20:- `docs/architecture/crdt-data-model.md`
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:80:### V5. RenameSheet cross-peer bug (Opus H-2)
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:85:3. Emits a `BatchCommit` containing `Op::PutFormula(rewrite)` × N + `Op::RenameSheet { id, old, new }`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:130:/bin/zsh -lc "pwd && rg --files | rg '("'^docs/architecture/crdt-data-model.md$|''^crates/ql-oplog/src/(log|op|replay)'"\\.rs"'$|''^crates/ql-exec/src/workbook_runtime/(cells|recompute|formats|sheets)'"\\.rs"'$|''^crates/ql-storage/src/.*format.*'"\\.rs"'$|''^'"\\.github/copilot-instructions\\.md"'$)'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:133:docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:161:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:235:    73	- Sheets: `AddSheet`, `RenameSheet`
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:300:   138	character-level concurrent edits) and harmful in others
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:318:   156	op came last. We do NOT show the user "two concurrent edits;
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:421:   259	   for every rewritten cell + the RenameSheet op). Per-cell
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:427:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '260,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:433:   264	character-level concurrent editing of one long formula) that
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:436:   267	## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:439:   270	LWW by Lamport-timestamp at the op-log level. Phase 5.3
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:449:   280	| `AddSheet "S"` × `AddSheet "S"` | First wins; second's replay errors via NameRejected (existing replay path). Phase 5.3 can add a "rename second to S(2)" auto-resolution. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:450:   281	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:451:   282	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:598:   429	   - If A's RenameSheet op is causally-before B's PutFormula:
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:601:   432	   - If B's PutFormula is causally-before A's RenameSheet: A's
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:605:   436	     B's text. Bug? Phase 5.3 must address.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:615:   446	   `FormatRejectedSource::IdCollision`. Phase 5.3 must
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:634:   465	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1015:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1311:   120	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1607:   404	        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2794:    15	//!   `PutFormula` rewrite + the `RenameSheet` op.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2907:   128	    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2964:   185	        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2975:   196	            ops.push(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:8874:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:3129:/// operations on a List. However, this approach fails in concurrent editing scenarios.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9352:docs/architecture/crdt-data-model.md:54:pub struct OpLog {
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9353:docs/architecture/crdt-data-model.md:64:- `OpLog::append` = serialize + push + commit.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9354:docs/architecture/crdt-data-model.md:65:- `OpLog::iter` = list iterator → JSON-deserialize → `Op`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9355:docs/architecture/crdt-data-model.md:82:Today's `OpLog` is single-writer (one runtime appends; replay is
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11391:  `docs/architecture/crdt-data-model.md:89`, `:99` says concurrent `LoroList::push` merges by Lamport timestamp and is LWW. Source does not support that. `LoroList::push` becomes a list insert at current len (`loro-internal-1.12.0/src/handler.rs:2765`), and concurrent inserts are preserved, not overwritten. The deterministic ordering rule I found is Fugue/origin-based with peer-id tie-breaks for same insertion site (`loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163`, `:192`). So: both pushes preserved = yes; receive-order-independent = yes with unique peer IDs; ordering = causal/origin order, peer-id tie-break for same origin, not LWW Lamport. Fix the design wording.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11403:  Rename only rewrites formulas visible on the producer at rename time (`crates/ql-exec/src/workbook_runtime/sheets.rs:168`) and logs those rewrites plus `RenameSheet` in one `BatchCommit` (`:183`). A concurrent formula `=S!A1+1` is not rewritten in either merge order. Binding later resolves names against current sheets (`crates/ql-exec/src/env.rs:402`, `crates/ql-exec/src/plan.rs:1678`) and fails as `BindError::UnknownSheet("S")`, not `UnresolvedName`. `recompute_all` does not map `UnknownSheet` to `#NAME?` (`crates/ql-exec/src/workbook_runtime/recompute.rs:179`), so storage may retain blank/stale value plus a recompute failure. Fix by storing sheet refs canonically by sheet id, or by adding a causality-aware rename repair policy for concurrent formulas.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11409:  `docs/architecture/crdt-data-model.md:89`, `:99` says concurrent `LoroList::push` merges by Lamport timestamp and is LWW. Source does not support that. `LoroList::push` becomes a list insert at current len (`loro-internal-1.12.0/src/handler.rs:2765`), and concurrent inserts are preserved, not overwritten. The deterministic ordering rule I found is Fugue/origin-based with peer-id tie-breaks for same insertion site (`loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163`, `:192`). So: both pushes preserved = yes; receive-order-independent = yes with unique peer IDs; ordering = causal/origin order, peer-id tie-break for same origin, not LWW Lamport. Fix the design wording.
./quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11421:  Rename only rewrites formulas visible on the producer at rename time (`crates/ql-exec/src/workbook_runtime/sheets.rs:168`) and logs those rewrites plus `RenameSheet` in one `BatchCommit` (`:183`). A concurrent formula `=S!A1+1` is not rewritten in either merge order. Binding later resolves names against current sheets (`crates/ql-exec/src/env.rs:402`, `crates/ql-exec/src/plan.rs:1678`) and fails as `BindError::UnknownSheet("S")`, not `UnresolvedName`. `recompute_all` does not map `UnknownSheet` to `#NAME?` (`crates/ql-exec/src/workbook_runtime/recompute.rs:179`), so storage may retain blank/stale value plus a recompute failure. Fix by storing sheet refs canonically by sheet id, or by adding a causality-aware rename repair policy for concurrent formulas.
./quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:74:| `083ad235d24` | **W5-91 — Phase 4.6.C: sheet rename + formula-text rewrite + `Op::RenameSheet`** | **1948** | `WorkbookRuntime::rename_sheet`, AST walker, op-log atomic batch |
./quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:98:- `Op::RenameSheet { id, old_name, new_name }` variant. Replay handler
./quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:115:  3. Log a single `BatchCommit { ops: [PutFormula × N, RenameSheet] }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:401://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:589:# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:614:quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:618:quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:631:quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:633:quantbook-engine/docs/architecture/crdt-data-model.md:541:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:634:quantbook-engine/docs/architecture/crdt-data-model.md:557:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:635:quantbook-engine/docs/architecture/crdt-data-model.md:561:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:636:quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:637:quantbook-engine/docs/architecture/crdt-data-model.md:573:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:638:quantbook-engine/docs/architecture/crdt-data-model.md:578:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:639:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:640:quantbook-engine/docs/architecture/crdt-data-model.md:709:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:641:quantbook-engine/docs/architecture/crdt-data-model.md:710:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:642:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `u32` to a tagged tuple (Builtin | Custom(peer_id, counter))
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:643:quantbook-engine/docs/architecture/crdt-data-model.md:712:   in Phase 5.2 D-1 (next-session multi-day arc; see
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:644:quantbook-engine/docs/architecture/crdt-data-model.md:713:   `docs/phase5/d-1-starting-checklist.md`). Schema bump
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:655:quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:662:quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:700:quantbook-engine/docs/phase5/d-1-starting-checklist.md:153:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1251:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1253:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1257:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1259:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1334:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1345:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1346:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1347:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1348:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1349:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1350:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1351:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1352:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1382:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1395:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1397:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1398:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1399:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1901:docs/architecture/crdt-data-model.md:454:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1400:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1401:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1426:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1429:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:1854:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2351:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2352:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:382:docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2355:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2356:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:433:docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2424:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2437:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2444:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2481:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2508:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2510:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2511:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2512:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2513:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2514:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2515:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2516:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2517:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2518:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2535:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2031:/bin/zsh -lc 'rg -n "docs/audits/2026-05-19|phase-5|tier-d1|exit-packet|d-1-starting" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2540:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2912:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2924:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2929:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2966:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2968:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2972:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2974:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2975:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11695:/bin/zsh -lc 'rg -o "`[0-9a-f]{10,12}`|[0-9a-f]{10,12}" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed '"'s/.*://; s/"'`//g'"' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2976:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11703:/bin/zsh -lc "setopt NO_NOMATCH; rg -o '[0-9a-f]{10,12}' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*://' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2981:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11944:/bin/zsh -lc "rg -o 'docs/audits/[A-Za-z0-9_./{}*,-]+' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*:docs/docs/' | sort -u" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2984:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:2992:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3285:    RenameSheet {
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3480:/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3711:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3733:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3858:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4187:quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4217:/bin/zsh -lc "sed -n '540,590p' quantbook-engine/docs/architecture/crdt-data-model.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4227:open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4274:quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4808:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5402:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '216,224p;553,584p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5450:    14	# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5629:/bin/zsh -lc "rg -n \"PeerId\" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5631:quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5632:quantbook-engine/docs/architecture/crdt-data-model.md:222:language since PeerId is u64-native to match Loro's PeerID type);
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5633:quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5634:quantbook-engine/docs/architecture/crdt-data-model.md:460:pub use peer::PeerId;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5635:quantbook-engine/docs/architecture/crdt-data-model.md:486:scaffold's known limitation — `PeerId` stored as a label only — was
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5636:quantbook-engine/docs/architecture/crdt-data-model.md:489:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5637:quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5675:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '444,464p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5734:File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:5778:File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-consolidated.md:63:Status header updated to mark § 7 as "PARTIALLY SUPERSEDED by D-1" with cross-references to `crdt-data-model.md § D-1` + `d-1-starting-checklist.md`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:43:6 doc surfaces refreshed (session.rs scaffold, undo.rs, lib.rs, crdt-data-model.md, known-gaps.md, entry-plan.md).
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5756://! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6161:docs/architecture/crdt-data-model.md:358:  `end_undo_group()` — atomic multi-op grouping for paste /
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6162:docs/architecture/crdt-data-model.md:359:  fill-down / table-import operations.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6163:docs/architecture/crdt-data-model.md:362:- **V2 V1.1:** `start_undo_group_scoped() -> Result<UndoGroupGuard<'_>, _>`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6164:docs/architecture/crdt-data-model.md:377:  `start_undo_group_scoped` + `UndoGroupGuard`. Manual
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:24:Single commit at HEAD. Implements Phase 5.6 V1 per the audit-closed design at `docs/architecture/crdt-data-model.md` § Presence container. Workspace tests 4166 → 4177 (+11).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:79:D1. The crdt-data-model.md § Presence container section was written pre-implementation. Now that 5.6 V1 ships, does it need a "✅ shipped" marker + commit hash? (Same pattern as D-2/D-3/D-4 marked at the 2026-05-19 handoff audit.)
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:109:/bin/zsh -lc 'rg -n "Presence|presence_|update_presence|peer_presence|clear_presence|peers_with_presence|presence" crates/ql-oplog/src/log.rs crates/ql-collab/src/presence.rs crates/ql-collab/src/session.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/roadmap/entry-plan.md docs/architecture/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:116:rg: docs/architecture/crdt-data-model.md: No such file or directory (os error 2)
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:178:/bin/zsh -lc 'rg -n "Presence|presence_|update_presence|peer_presence|clear_presence|peers_with_presence|presence" crates/ql-oplog/src/log.rs crates/ql-collab/src/presence.rs crates/ql-collab/src/session.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/roadmap/entry-plan.md docs/architecture/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:191:crates/ql-oplog/src/log.rs:39:/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:328:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:329:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:330:docs/architecture/crdt-data-model.md:201:(presence below).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:331:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:332:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:333:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:334:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:335:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:336:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:337:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:338:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:339:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:380:/bin/zsh -lc "rg --files | rg '("'^|/)(entry-plan|known-gaps|crdt-data-model)'"\\.md"'$|copilot-instructions'"\\.md"'$'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:388:docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:418:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:419:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:420:docs/architecture/crdt-data-model.md:201:(presence below).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:421:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:422:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:423:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:424:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:425:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:426:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:427:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:428:docs/architecture/crdt-data-model.md:301:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:429:docs/architecture/crdt-data-model.md:302:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:430:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:431:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:432:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:433:docs/architecture/crdt-data-model.md:500:### D-2: AddSheet name collision — auto-rename in 5.2
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:434:docs/architecture/crdt-data-model.md:524:### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:435:docs/architecture/crdt-data-model.md:559:### D-4: Spill semantics — replay defers to recompute, not per-op
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:436:docs/architecture/crdt-data-model.md:616:   addressed by D-3** (above). The actual bug shape is
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:529:docs/audits/2026-05-19-handoff-audit-consolidated.md:38:| M-2 | `crdt-data-model.md` D-2/D-3/D-4 missing ✅ shipped markers | Opus | ✅ FIXED — markers + commit hashes added |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:531:docs/audits/2026-05-19-handoff-audit-consolidated.md:42:| M-6 | `crdt-data-model.md:287-299` conflict table claims Lamport LWW + AddSheet "second errors" | Codex | ✅ FIXED — Fugue/origin ordering + D-2 auto-rename + D-3 #NAME? mapping; commit hashes inline |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:646:docs/audits/2026-05-19-handoff-audit-codex.md:1103:   502	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:658:docs/audits/2026-05-19-handoff-audit-codex.md:1873:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:659:docs/audits/2026-05-19-handoff-audit-codex.md:1874:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:660:docs/audits/2026-05-19-handoff-audit-codex.md:1903:docs/architecture/crdt-data-model.md:478:### D-2: AddSheet name collision — auto-rename in 5.2
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:661:docs/audits/2026-05-19-handoff-audit-codex.md:1906:docs/architecture/crdt-data-model.md:502:### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:662:docs/audits/2026-05-19-handoff-audit-codex.md:1911:docs/architecture/crdt-data-model.md:537:### D-4: Spill semantics — replay defers to recompute, not per-op
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:663:docs/audits/2026-05-19-handoff-audit-codex.md:1917:docs/architecture/crdt-data-model.md:594:   addressed by D-3** (above). The actual bug shape is
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:688:docs/audits/2026-05-19-handoff-audit-codex.md:2769:   498	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:706:docs/audits/2026-05-19-handoff-audit-codex.md:4154:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:710:docs/audits/2026-05-19-handoff-audit-codex.md:4179:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:287-299`: conflict table still says Lamport LWW and `AddSheet "S"` second add errors. Update to Fugue/origin ordering and D-2 auto-rename behavior.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:958:docs/audits/2026-05-19-phase-5-1-opus.md:134:`docs/architecture/crdt-data-model.md:228-226` states presence
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1758:     4	//! audit-closed design at `docs/architecture/crdt-data-model.md`
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2012:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2252:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '210,250p'; nl -ba docs/phase5/entry-plan.md | sed -n '95,120p'; nl -ba docs/known-gaps.md | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2905:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10542:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10543:docs/architecture/crdt-data-model.md:48:narrow Option C extension for presence.**
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10544:docs/architecture/crdt-data-model.md:201:(presence below).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10545:docs/architecture/crdt-data-model.md:216:### Presence container: `"presence"` LoroMap (per-peer ephemeral)
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10546:docs/architecture/crdt-data-model.md:218:New for Phase 5.6. Holds the per-peer cursor + selection +
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10547:docs/architecture/crdt-data-model.md:219:typing indicator. Keys are peer-IDs (UUIDs); values are JSON
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10548:docs/architecture/crdt-data-model.md:226:└── LoroMap "presence"
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10549:docs/architecture/crdt-data-model.md:231:**Why MOM (Map of Maps) is wrong for cells but right for presence**:
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10550:docs/architecture/crdt-data-model.md:236:- Presence is ephemeral and unordered — each peer overwrites
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10551:docs/architecture/crdt-data-model.md:240:Presence updates do NOT persist across `.qbook` save/load.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10552:docs/architecture/crdt-data-model.md:241:Phase 5.6 wires the in-memory presence map; `.qbook` envelope
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10553:docs/architecture/crdt-data-model.md:351:  workbook (no peer IDs, no presence).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10554:docs/architecture/crdt-data-model.md:377:- `presence` — Phase 5.6 cursor + selection map.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10555:docs/architecture/crdt-data-model.md:419:| Presence | new map | new map | new map |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10557:docs/architecture/crdt-data-model.md:461:open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10563:docs/architecture/crdt-data-model.md:495:**Why not UUID?** UUIDs are bigger (128-bit), opaque to humans,
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10564:docs/architecture/crdt-data-model.md:604:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10822:B3. The 16-hex u64 key is defensible because `PeerId` is explicitly Loro-native `u64` in [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/peer.rs:3). But the design doc still says UUIDs in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:219). That is doc drift.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10838:D1. [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:216): add “✅ Phase 5.6 V1 shipped `c677e244704`”, change UUID keys to 16-hex `PeerId`, and resolve the persistence statement.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10881:B3. The 16-hex u64 key is defensible because `PeerId` is explicitly Loro-native `u64` in [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/peer.rs:3). But the design doc still says UUIDs in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:219). That is doc drift.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10897:D1. [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:216): add “✅ Phase 5.6 V1 shipped `c677e244704`”, change UUID keys to 16-hex `PeerId`, and resolve the persistence statement.
./quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:2:title: Phase 5.3 step 1 audit — Opus subagent verdict
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:35:**File**: `crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20-27` AND `docs/architecture/crdt-data-model.md:320-329`
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:37:**What**: The test file's prelude lists 7 rows; the design doc's matrix has 9 rows (rows 8 + 9 are `RenameSheet × concurrent edit` and `DropTable × concurrent edit referencing T`). Row 7 in the test is actually doc-row 9 (DropTable). Doc-row 8 (RenameSheet × edit) is deferred to step 2 — but the test file doesn't say that.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:83:**File**: `docs/architecture/crdt-data-model.md` § 311-334 (no mention) + § 489-496 (production peer-id wiring only).
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:89:**Fix**: add 1-2 sentences to `crdt-data-model.md` § 311-334.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:91:**Closed**: Step 1 closure commit. Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-opus.md:29:**M1-M4 — doc drift across `session.rs:7-9`, `crdt-data-model.md:331-344`,
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3411://! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
./quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-consolidated.md:43:`crdt-data-model.md` §373, `entry-plan.md:110`, `known-gaps.md:116`,
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:2:title: Phase 5.3 step 1 audit synthesis (conflict matrix test pinning)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:8:closure_commit: (this commit — Phase 5.3 step 1 audit closures)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:20:| **MEDIUM-1**: Matrix labeling off — design doc has 8 rows; test calls "row 7" the DropTable row (actually row 8); row 7 (RenameSheet × edit) was missing | MEDIUM | MEDIUM-1 | Added new `row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix` pinning pre-fix #NAME? (step 3 will modify); renamed DropTable test to row 8 |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:34:| **Opus MEDIUM-2**: Plan understates step 4. `apply_rename_table` (replay.rs:691) and `apply_rename_column` (replay.rs:749) have IDENTICAL `old_canonical` lookup hard-fail bug to RenameSheet. Step 4 is "extend step 2," not "investigate." | MEDIUM | Updated `.plans/_active.md` step 4 + task #4 description: "extend step 2's fix" with replay.rs:691 + 749 references; revised effort from 0.5-1d "investigation" to ~0.5d "implementation" |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:36:| **Opus LOW-2**: Peer-id stability note should go in design doc NOW (step 6 deferral saves no time; step 2 will rediscover) | LOW | Added "Peer-id stability is a precondition for CRDT convergence" subsection to `crdt-data-model.md` § 311-334 |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-consolidated.md:56:The 3-cycle divergent-HIGH pattern from D-1 (steps 5, 6, 7) extended into Phase 5.3 step 1. Both auditors caught HIGH-1 independently — the pattern is structurally validated AGAIN. The next phase-5-3 audit (step 2 + step 3 + step 4 + step 5 megaudit) should expect the same: parallel Codex + Opus, with closure for both, before progressing.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:851://! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3261:    RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6982:/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7771:        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14:# Codex audit — Phase 5.3 step 1 (conflict matrix test pinning) 2026-05-20
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:20:**Audit target**: the Phase 5.3 step 1 commit (HEAD at audit time — see `git log --oneline -3`).
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:22:D-1 is SHIPPED; Phase 5.3 step 1 is the first new work on top.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:31:Pinned the 7-row conflict matrix from `quantbook-engine/docs/architecture/crdt-data-model.md:320-329` (§ Phase 5.3 preview) as 2-peer probe tests, following the D-4 template (`crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs`):
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:39:- Row 7: DropTable × concurrent edit referencing T — D-3 #NAME? pin
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:49:**Structural insight**: CRDT convergence in Quantbook DEPENDS on stable peer-ids. The design doc at `crdt-data-model.md` doesn't explicitly say this; it says "Fugue/origin-based with peer-id tiebreaker" but doesn't flag that callers MUST pin peer-ids for deterministic outcomes. Possibly worth a doc note in step 6 (exit packet).
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:75:   - RenameTable × concurrent edit (likely needs step 4 fix first)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:76:   - InsertRow × concurrent edit (V1 doesn't have InsertRow ops — out of scope)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:95:/bin/zsh -lc 'nl -ba quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:99:     1	//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:100:     2	//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:101:     3	//! § Conflict resolution semantics (Phase 5.3 preview).
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:118:    20	//! Coverage matches the design doc table at `crdt-data-model.md:320-329`:
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:125:    27	//! - Row 7: DropTable × concurrent edit referencing T (D-3 → #NAME?)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:520:   422	// ===== Row 7: DropTable × concurrent edit referencing T =====
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:684:    77	- Sheets: `AddSheet`, `RenameSheet`
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:763:   156	character-level concurrent edits) and harmful in others
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:781:   174	op came last. We do NOT show the user "two concurrent edits;
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:910:   303	   for every rewritten cell + the RenameSheet op). Per-cell
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:915:   308	character-level concurrent editing of one long formula) that
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:918:   311	## Conflict resolution semantics (Phase 5.3 preview)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:925:   318	target. Phase 5.3 formalizes this with these defaults:
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:935:   328	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:936:   329	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1159:   552	open question 5 ("Phase 5.3 may switch to UUID"). Audit
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1206:   599	deferred to Phase 5.3. Audit pushed back: spreadsheet users
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1222:   615	### D-3: RenameSheet × concurrent edit — known V1 limitation
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1224:   617	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1247:   640	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1249:   642	walks formulas added causally-before the RenameSheet op and
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1259:   652	**Status:** ✅ SHIPPED at commit `2f217a2067a` (2026-05-19) — `OpLog::merge_bytes(&[u8]) -> Result<usize, OpLogError>` added (delegates to `LoroDoc::import`). 4 probe tests at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` verify spill blocking survives 2-peer CRDT merge in BOTH merge directions. First multi-peer test in the engine; establishes the pattern for Phase 5.3-5.7.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1316:   709	   recompute_all. Phase 5.2 adds the missing mapping; Phase 5.3
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1379:   772	- `docs/architecture/crdt-data-model.md` ✅ THIS DOC.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1389:5595d8dcfb0 Phase 5.3 step 1 — conflict matrix test pinning (2-peer probes)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1428:The test file matches your description, and the doc row count has a twist: the preview table has eight rows, not seven, because `RenameSheet × concurrent edit` is a separate row before `DropTable`. I’m going into replay/session internals next to check whether that omission is intentional or a real gap.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1476:    45	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2104:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2105:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2106:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2107:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2110:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4076:    10	# Phase 5.3 — Conflict Resolution Semantics
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4080:    14	Phase 5.1 audit-locked the conflict-matrix table at `crdt-data-model.md:311-334` and explicitly deferred two items to 5.3:
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4097:    31	**Decision: chain-based, NOT causality-aware.** Build `(old_canonical → new_name)` chain by sheet_id from `Op::RenameSheet` ops in the log; walk all formulas; rewrite text via the existing `rewrite_formula_text_for_sheet_rename` helper (sheets.rs:37-60).
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4105:    39	### D-5.3-3 — Concurrent RenameSheet policy (step 2 fix)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4130:    64	**In scope**: `Op::RenameSheet` chains.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4144:    78	### Step 2 — Concurrent RenameSheet replay fix (~0.5 day)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4153:    87	  - Concurrent rename + concurrent edit (the canonical case)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4172:   106	Write `docs/phase5/5-3-exit-packet.md` mirroring D-1 structure. Refresh 6 surfaces (MASTER-PLAN, v1-exit-packet, entry-plan, crdt-data-model, ide-consumer-contract, MEMORY). Final commit. Verify gates.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4204:   138	- Design doc preview: `quantbook-engine/docs/architecture/crdt-data-model.md` § 311-334 (Conflict resolution semantics)
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4205:   139	- D-3 V1 limitation note: `crdt-data-model.md` § 615-648
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4209:   143	- Replay's RenameSheet handler (the bug + fix site): `crates/ql-oplog/src/replay.rs:486-532`
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4214:/bin/zsh -lc "rg -n \"formula_text|put_formula|clear_formula|read\\(|set_value|SetName|BatchCommit|RenameSheet|DropTable|AddSheet|SetCellFormat|RenameTable|RenameColumn\" quantbook-engine/crates/ql-storage/src quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-exec/src" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4349:   134	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4701:   486	        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5790:  1575	    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5794:  1579	        // AddSheet + RenameSheet replays into a sheet with the new name.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5801:  1586	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5819:  1604	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5837:  1622	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5854:  1639	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5882:  1667	        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5925:  1710	                Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6240:quantbook-engine/crates/ql-oplog/src/replay.rs:134:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6252:quantbook-engine/crates/ql-oplog/src/replay.rs:486:        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6278:quantbook-engine/crates/ql-oplog/src/replay.rs:1575:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6279:quantbook-engine/crates/ql-oplog/src/replay.rs:1579:        // AddSheet + RenameSheet replays into a sheet with the new name.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6281:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6282:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6283:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6284:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6287:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6292:quantbook-engine/crates/ql-oplog/src/replay.rs:1710:                Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6732:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:15://!   `PutFormula` rewrite + the `RenameSheet` op.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6738:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6741:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:185:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6742:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7632:        Op::RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8485:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8867:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14909:MEDIUM: [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20) claims coverage matches the design table, but [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:320) has 8 rows, including `RenameSheet × concurrent edit`. The active plan defers that to step 2/3, which is fine, but the step-1 test header and plan wording say “7-row matrix.” Suggested fix: either add the rename row probe now, or explicitly rename this as “7 non-rename/default rows; RenameSheet row deferred to step 2/3.”
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14923:The wider conflict space does not need to be fully covered in step 1 if 5.3 intentionally scopes this to the design-preview defaults. But the missing RenameSheet row must be called out as deferred, and row 3 must be made state-sensitive before this commit can honestly claim it pinned the matrix.
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14934:MEDIUM: [phase_5_3_conflict_matrix_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:20) claims coverage matches the design table, but [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:320) has 8 rows, including `RenameSheet × concurrent edit`. The active plan defers that to step 2/3, which is fine, but the step-1 test header and plan wording say “7-row matrix.” Suggested fix: either add the rename row probe now, or explicitly rename this as “7 non-rename/default rows; RenameSheet row deferred to step 2/3.”
./quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14948:The wider conflict space does not need to be fully covered in step 1 if 5.3 intentionally scopes this to the design-preview defaults. But the missing RenameSheet row must be called out as deferred, and row 3 must be made state-sensitive before this commit can honestly claim it pinned the matrix.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:66:D2. `crdt-data-model.md` § Undo/redo (V1 shipped) — needs V2 V1 marker?
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:452:quantbook-engine/docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:453:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 — V1 shipped)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:454:quantbook-engine/docs/architecture/crdt-data-model.md:333:**Phase 5.4 V1 ✅ shipped at `89c02b9d83e` (2026-05-19).**
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:455:quantbook-engine/docs/architecture/crdt-data-model.md:335:peer has its own undo stack tracking THEIR local appends only.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:456:quantbook-engine/docs/architecture/crdt-data-model.md:338:post-undo. (V1 implementation correction: prior "remove from
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:457:quantbook-engine/docs/architecture/crdt-data-model.md:341:a remote-event-style retraction. See `ql_collab::CollabSession::undo`.)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:458:quantbook-engine/docs/architecture/crdt-data-model.md:343:This is local-undo, NOT collaborative-undo. Two users editing
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:459:quantbook-engine/docs/architecture/crdt-data-model.md:344:the same cell + one user undoing their edit produces a sane
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:460:quantbook-engine/docs/architecture/crdt-data-model.md:352:- `undo() -> Result<bool, _>` / `redo() -> Result<bool, _>`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:461:quantbook-engine/docs/architecture/crdt-data-model.md:353:- `can_undo() -> bool` / `can_redo() -> bool`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:462:quantbook-engine/docs/architecture/crdt-data-model.md:354:- `undo_count() -> usize` / `redo_count() -> usize`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:463:quantbook-engine/docs/architecture/crdt-data-model.md:355:- `clear_undo_stack()`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:464:quantbook-engine/docs/architecture/crdt-data-model.md:357:Plus `pub use loro::UndoManager` in `ql_collab::undo` for
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:465:quantbook-engine/docs/architecture/crdt-data-model.md:360:cursor movement doesn't pollute the undo stack.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:466:quantbook-engine/docs/architecture/crdt-data-model.md:367:- `set_peer_id` after construction silently CLEARS the undo
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:467:quantbook-engine/docs/architecture/crdt-data-model.md:445:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:498:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:499:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:515:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:328:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:518:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:418:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:550:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10542:docs/architecture/crdt-data-model.md:34:  snapshot + presence + undo without changing the state-on-Loro
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:652:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:83:D1. `crdt-data-model.md` § Undo/redo (Phase 5.4 preview, lines ~307-320) was written pre-implementation. Now that V1 ships, does it need a "✅ V1 shipped at 89c02b9d83e" marker?
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:665:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:412:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:834:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2134:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:835:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2135:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:836:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2136:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:837:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2137:quantbook-engine/docs/architecture/crdt-data-model.md:331:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:838:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2138:quantbook-engine/docs/architecture/crdt-data-model.md:343:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:839:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2139:quantbook-engine/docs/architecture/crdt-data-model.md:399:- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:843:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2152:quantbook-engine/crates/ql-collab/src/undo.rs:11://! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:868:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2276:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:869:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2277:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:927:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4390:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1883:docs/architecture/crdt-data-model.md:307:## Undo/redo (Phase 5.4 preview)
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:928:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4391:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1884:docs/architecture/crdt-data-model.md:319:Phase 5.4 wires this; 5.1 just confirms Loro provides the
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1127:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:12874:/bin/zsh -lc 'git status --short -- quantbook-engine/crates/ql-collab/tests/tmp_undo_probe.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/known-gaps.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1138:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13046:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1144:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13068:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1156:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13103:D1. YES. `crdt-data-model.md` still says “Phase 5.4 preview” and “Phase 5.4 wires this”; add shipped marker for `89c02b9d83e`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1162:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:13125:| LOW | [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:107), [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) | Phase 5.4 docs still describe undo as future/unpopulated. | Mark V1 shipped at `89c02b9d83e`, keep grouping/cache semantics as V2/open cleanup, and remove “undo remains unpopulated.” |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2295:/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/lib.rs | sed -n '1,90p'; nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '320,375p'; nl -ba quantbook-engine/docs/known-gaps.md | sed -n '108,118p'; nl -ba quantbook-engine/docs/phase5/entry-plan.md | sed -n '100,114p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2301:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2369:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2370:   324	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2427:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3081: | GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3302: - `docs/architecture/crdt-data-model.md` — at 5.1 close.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11047:    11	//! `docs/architecture/crdt-data-model.md` § Undo/redo (Phase
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11143:/bin/zsh -lc 'rg -n "undo module|Reserved module|V2 V1|group_start|merge-interval|No grouping API|No merge-interval|start_undo_group|set_undo_merge_interval" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/crates/ql-collab/src/lib.rs quantbook-engine/crates/ql-collab/src/session.rs -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11189:quantbook-engine/docs/architecture/crdt-data-model.md:364:- No grouping API (`group_start` / `group_end`) — defer to V2.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11190:quantbook-engine/docs/architecture/crdt-data-model.md:365:- No merge-interval tuning (Loro's default 0 ms) — defer to V2.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11191:quantbook-engine/docs/architecture/crdt-data-model.md:383:**V2 V1 ✅ shipped at `ffd8f6e5f05` (2026-05-19):**
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11192:quantbook-engine/docs/architecture/crdt-data-model.md:400:`LoopbackTransport` + V2 V1's `attach_transport`/`flush`/`poll`
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11193:quantbook-engine/docs/architecture/crdt-data-model.md:405:confirms the substrate works regardless; 5.5 V1 + V2 V1 prove
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11203:| LOW | Docs are stale: [crdt-data-model.md:331](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [undo.rs:24](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/undo.rs:24), [lib.rs:27](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:27), and [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) still describe V1-only or unpopulated undo state. | Update these to mention V2 V1 grouping and merge-interval methods. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11240:D2: FAIL. `crdt-data-model.md` still says no grouping API and no merge-interval tuning.
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11268:| LOW | Docs are stale: [crdt-data-model.md:331](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:331), [undo.rs:24](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/undo.rs:24), [lib.rs:27](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:27), and [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114) still describe V1-only or unpopulated undo state. | Update these to mention V2 V1 grouping and merge-interval methods. |
./quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11305:D2: FAIL. `crdt-data-model.md` still says no grouping API and no merge-interval tuning.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-opus-b.md:57:- **Doc-drift in active product docs:** crdt-data-model.md § D-1, ide-consumer-contract.md, MASTER-PLAN.md, v1-exit-packet.md, current_work.md all properly reflect steps 1-7 shipped + step 8 pending.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:572:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:702:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:703:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:704:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:705:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:767:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:768:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:769:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:770:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:786:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1099:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1189:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1190:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1191:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1192:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1228:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1229:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1230:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:1262:quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2617:docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2618:docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2619:docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2620:docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2621:docs/architecture/crdt-data-model.md:473:- `ql-oplog` — for `OpLog` + `Op` + `merge_bytes` + `import_bytes` + `export_bytes`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2622:docs/architecture/crdt-data-model.md:736:   oplog.bin magic bytes + version header, step 8 megaudit. See
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2633:docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3126:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8075:quantbook-engine/docs/architecture/crdt-data-model.md:247:`oplog_persistence::save_workbook_with_oplog` writes the
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3127:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8076:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3128:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8080:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3129:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3145:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8169:quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:278:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3458:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10791:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3548:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11067:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3549:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3550:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11070:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3551:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11072:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3587:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11901:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3588:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11902:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3589:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3621:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11961:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3847:docs/audits/2026-05-19-phase-5-6-v1-codex.md:55:A4. Per the audit-locked design (`crdt-data-model.md:240`): "Presence updates do NOT persist across `.qbook` save/load." The implementation lives in the same LoroDoc snapshot, so `export_bytes` DOES include presence. Is this a contradiction the V1 implementation needs to surface as a known limitation, or did the design intend "doesn't WIPE" + V2 may add an exclusion filter?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3977:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10814:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3978:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10858:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3979:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10873:A4. This is a real design-vs-implementation contradiction. The architecture doc says “Presence updates do NOT persist across `.qbook` save/load” in [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240). The implementation says presence “DO survive `OpLog::export_bytes` / `import_bytes`” in [presence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16), and `.qbook` persistence writes `oplog.export_bytes()` into `oplog.bin` in [oplog_persistence.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/oplog_persistence.rs:82). Treat as a V1 known limitation or add filtering; do not leave both docs true.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:3980:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10917:| MEDIUM | [crdt-data-model.md:240](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:240), [presence.rs:16](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/presence.rs:16) | Persistence contract contradicts implementation. | Decide contract. Either filter presence from `.qbook/oplog.bin` save/load, or document V1 persistence as a known limitation everywhere. |
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4359:docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:566:`Op::RenameSheet` events live in the op log. Loading a `.qbook` with an attached `oplog.bin` replays the rename history; the final state matches what was saved. No new persistence surface beyond the op-log variant.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4470:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11166:quantbook-engine/docs/architecture/crdt-data-model.md:248:WHOLE Loro snapshot to `oplog.bin`. So a cold restart DOES
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4471:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11196:quantbook-engine/docs/architecture/crdt-data-model.md:434:saves the LoroDoc snapshot as `oplog.bin`.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4472:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4902:    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8409:docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8410:docs/architecture/crdt-data-model.md:563:    Builtin(u32),        // Excel-canonical ids 0–163 (unchanged)
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8411:docs/architecture/crdt-data-model.md:607:change. The `Op::AddSheet { name }` op is unchanged; replay
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8412:docs/architecture/crdt-data-model.md:688:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8413:docs/architecture/crdt-data-model.md:692:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8609:docs/audits/2026-05-19-handoff-audit-codex.md:1914:docs/architecture/crdt-data-model.md:578:   (unchanged). Opus L-1 adds a 5.2 acceptance criterion: a
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8610:docs/audits/2026-05-19-handoff-audit-codex.md:1915:docs/architecture/crdt-data-model.md:582:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8760:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8081:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8783:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11903:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8875:docs/audits/2026-05-19-phase-5-6-v1-codex.md:10564:docs/architecture/crdt-data-model.md:604:2. **Per-peer peer-IDs** — deferred to Phase 5.2 (unchanged).
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9336:docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11197:quantbook-engine/docs/architecture/crdt-data-model.md:437:- `.qbook/oplog.bin` remains the same Loro snapshot blob.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10304:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '230,255p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10608:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '426,442p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10833:   108	    RenameSheet {
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11951:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8072:quantbook-engine/docs/architecture/crdt-data-model.md:78:- Formats: `RegisterFormat`, `SetCellFormat`
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11952:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8084:quantbook-engine/docs/architecture/crdt-data-model.md:553:`Op::RegisterFormat { id: N, string: <different> }`. Replay's
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:11953:docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:8085:quantbook-engine/docs/architecture/crdt-data-model.md:573:- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13306:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:76:9. **Doc cross-references.** The d-1-checklist marks step 2 ✅ shipped. Are there other doc surfaces that mention `FormatIdWire` ahead of time (e.g. crdt-data-model.md § "D-1") that should be updated post-ship to point at the actual shipped type?
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:13599:docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13962:/bin/zsh -lc 'rg -n "from_storage|to_storage|FormatIdWire|FormatId" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:14093:MEDIUM: External docs/API comments still imply raw Loro bytes are suitable as `.qbook/oplog.bin`. Most notably `CollabSession::export_bytes` says “OR for `.qbook/oplog.bin` persistence” ([session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:248)), and the architecture doc says `.qbook/oplog.bin` remains the same Loro snapshot blob ([crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:437)). Post-D3, only `ql_io::save_workbook_with_oplog` writes the QLOL wrapper.
./quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:14112:MEDIUM: External docs/API comments still imply raw Loro bytes are suitable as `.qbook/oplog.bin`. Most notably `CollabSession::export_bytes` says “OR for `.qbook/oplog.bin` persistence” ([session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:248)), and the architecture doc says `.qbook/oplog.bin` remains the same Loro snapshot blob ([crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:437)). Post-D3, only `ql_io::save_workbook_with_oplog` writes the QLOL wrapper.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:31:4. `docs/architecture/crdt-data-model.md` § ql-collab crate scope: scaffold-limitation note replaced with "✅ closed" + caller-pitfall.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:68:D1. The crdt-data-model.md § ql-collab crate scope says "Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed)". Read the section and confirm it reads as truth.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:246: .../docs/architecture/crdt-data-model.md           | 18 +++---
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:280:    - docs/architecture/crdt-data-model.md § ql-collab crate scope:
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:293:quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:334:/bin/zsh -lc "rg --files -g 'Cargo.toml' -g 'log.rs' -g 'session.rs' -g 'peer.rs' -g 'crdt-data-model.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:338:quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:372:/bin/zsh -lc 'git diff --stat 687e5dd3995..HEAD && git diff --find-renames -- crates/ql-oplog/src/log.rs crates/ql-collab/src/session.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:376:docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:377:docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:378:docs/architecture/crdt-data-model.md:400:closed by adding `OpLog::set_peer_id` and calling it from
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:379:docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:380:docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:382:docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:433:docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:489:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:626: .../docs/architecture/crdt-data-model.md           | 18 +++---
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1367:/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3686:docs/architecture/crdt-data-model.md:92:   `export_from(version_vector)` + `import` API.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3687:docs/architecture/crdt-data-model.md:456:**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3898:docs/architecture/2026-05-13-cross-sheet-references.md:39:- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4458:# closed design at `docs/architecture/crdt-data-model.md`,
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4471:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4472:docs/architecture/crdt-data-model.md:359:## `ql-collab` crate scope
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4473:docs/architecture/crdt-data-model.md:365:// crates/ql-collab/src/lib.rs (current state)
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4474:docs/architecture/crdt-data-model.md:368:pub mod session;     // CollabSession: per-peer state holder
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4475:docs/architecture/crdt-data-model.md:372:pub use session::{CollabSession, CollabSessionError};
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4476:docs/architecture/crdt-data-model.md:384:Current Cargo.toml deps (verified against `crates/ql-collab/Cargo.toml`):
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4477:docs/architecture/crdt-data-model.md:391:- `thiserror` — `CollabSessionError` + `TransportError`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4478:docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4635:docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4639:docs/audits/2026-05-19-handoff-audit-codex.md:1867:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4680:docs/audits/2026-05-19-handoff-audit-codex.md:4155:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4684:docs/audits/2026-05-19-handoff-audit-codex.md:4180:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4691:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4716:     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4762:   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4778:/bin/zsh -lc 'git show --find-renames --format=short --stat --patch HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/peer.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4788: .../docs/architecture/crdt-data-model.md           | 18 +++---
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5043:diff --git a/quantbook-engine/docs/architecture/crdt-data-model.md b/quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5045:--- a/quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5046:+++ b/quantbook-engine/docs/architecture/crdt-data-model.md
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5122:docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5123:docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5124:docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5144:docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:10230:D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.
./quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:10289:D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs | sed -n '120,230p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   120	
   121	        Ok(new_id)
   122	    }
   123	
   124	    /// **W5-91 (Phase 4.6.C):** rename a sheet by id. Walks every
   125	    /// stored formula in `formula_cells` and every `NamedTarget::Formula`
   126	    /// entry, rewrites cross-sheet references to the new sheet name via
   127	    /// `lex → parse → rewrite → print`, emits the rewritten text + the
   128	    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
   129	    /// the rewrites to storage, then swaps `Sheet::name`. Bumps the
   130	    /// `PlanCache` generation so cached bound plans miss on the next
   131	    /// recompute.
   132	    ///
   133	    /// Validation: rejects empty / Excel-reserved-char / canonical-
   134	    /// duplicate new names via `Workbook::validate_sheet_name`.
   135	    ///
   136	    /// **Tokenization-aware:** the parse + rewrite + print round-trip
   137	    /// catches every sheet-qualified ref in the AST, including those
   138	    /// inside string literals' position (it doesn't actually substitute
   139	    /// inside `"..."` because the parser keeps those as `Expr::String`).
   140	    /// If a formula's text fails to lex/parse (corrupt input from a
   141	    /// historical bug), the text is left UNCHANGED — defensive against
   142	    /// breaking otherwise-recoverable workbooks at rename time.
   143	    ///
   144	    /// Direct callers of `Workbook::rename_sheet` bypass formula-text
   145	    /// rewriting + op-log recording — that path is loader-only.
   146	    pub fn rename_sheet(
   147	        &mut self,
   148	        id: SheetId,
   149	        new_name: impl Into<String>,
   150	    ) -> Result<(), RuntimeError> {
   151	        let new_name: String = new_name.into();
   152	        // Capture old name BEFORE any mutation (defensive — if anything
   153	        // below errors, the workbook stays as-is).
   154	        let old_name = self.workbook.sheet(id).map(|s| s.name().to_owned()).ok_or(
   155	            RuntimeError::InvalidSheet {
   156	                sheet: id,
   157	                sheet_count: self.workbook.sheet_count(),
   158	            },
   159	        )?;
   160	        // Validate new name. Skip the validation if canonical name is
   161	        // unchanged (case-only rename is allowed); `Workbook::rename_sheet`
   162	        // will apply the display update.
   163	        let old_canonical = ql_storage::Workbook::canonical_sheet_name(&old_name);
   164	        let new_canonical = ql_storage::Workbook::canonical_sheet_name(&new_name);
   165	        if new_canonical != old_canonical {
   166	            self.workbook.validate_sheet_name(&new_name)?;
   167	        }
   168	        // Rewrite stored formula text. Collect rewrites into a batch so
   169	        // the op log records them alongside the rename atomically.
   170	        let new_name_arc: Arc<str> = Arc::from(new_name.as_str());
   171	        let mut rewritten_cells: Vec<(SheetId, RowId, ColId, String)> = Vec::new();
   172	        for (sheet, row, col, text) in self.workbook.iter_formulas() {
   173	            if let Some(new_text) =
   174	                rewrite_formula_text_for_sheet_rename(text.as_ref(), &old_canonical, &new_name_arc)
   175	            {
   176	                rewritten_cells.push((sheet, row, col, new_text));
   177	            }
   178	        }
   179	        // (Phase 4.6.D / future): walk NamedTarget::Formula entries for
   180	        // the same rewrite. Today named formulas are deferred so
   181	        // formula_cells is the only text-bearing surface to rewrite.
   182	
   183	        // Append-before-mutate: emit the BatchCommit op first so a
   184	        // failing append leaves storage unchanged. The batch carries:
   185	        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
   186	        if let Some(oplog) = self.oplog.as_deref_mut() {
   187	            let mut ops: Vec<Op> = Vec::with_capacity(rewritten_cells.len() + 1);
   188	            for (s, r, c, ref new_text) in &rewritten_cells {
   189	                ops.push(Op::PutFormula {
   190	                    sheet: *s,
   191	                    row: *r,
   192	                    col: *c,
   193	                    text: new_text.clone(),
   194	                });
   195	            }
   196	            ops.push(Op::RenameSheet {
   197	                id,
   198	                old_name: old_name.clone(),
   199	                new_name: new_name.clone(),
   200	            });
   201	            oplog.append(Op::BatchCommit { ops })?;
   202	        }
   203	        // Apply mutations. Rewrites go in first so the storage layer
   204	        // never sees a state where the sheet name is new but formula
   205	        // text still references the old name. (Order matters only for
   206	        // observers that race — single-threaded mutation doesn't care,
   207	        // but the invariant is cleaner.)
   208	        for (s, r, c, new_text) in rewritten_cells {
   209	            self.workbook.put_formula(s, r, c, new_text.as_str());
   210	        }
   211	        // Swap the name. Cannot fail here — validation already passed.
   212	        self.workbook
   213	            .rename_sheet(id, new_name)
   214	            .expect("rename_sheet validation already passed");
   215	        // Wipe the PlanCache so cached bound plans (which baked in the
   216	        // old SheetId via SheetRef::Name resolution) miss on next
   217	        // recompute and rebind against the new sheet name. Sheet
   218	        // rename is edit-rate, not recompute-rate; a full cache flush
   219	        // is acceptable per design § 10.5 / Codex MEDIUM-7. (A
   220	        // finer-grained `sheet_gen` counter could be wired in a follow-
   221	        // up — filed as a future polish item.)
   222	        self.plan_cache.clear();
   223	        Ok(())
   224	    }
   225	}
   226	
   227	#[cfg(test)]
   228	mod tests {
   229	    use ql_functions::default_registry;
   230	    use ql_storage::Workbook;

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '311,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   311	## Conflict resolution semantics (Phase 5.3 preview)
   312	
   313	The 5.1 design picks Option A → conflicts resolve by Loro's
   314	underlying merge order: **Fugue/origin-based with peer-id
   315	tiebreaker** (per `loro-internal-1.12.0/src/container/richtext/tracker/crdt_rope.rs:163,192`),
   316	NOT Lamport timestamps. The op-log replay path observes the
   317	final causal order; the LAST op in that order wins for each
   318	target. Phase 5.3 formalizes this with these defaults:
   319	
   320	| Concurrent op pair | Resolution |
   321	|---|---|
   322	| `PutValue { A1, v_a }` × `PutValue { A1, v_b }` | Last-in-causal-order wins (Fugue/origin) |
   323	| `PutFormula { A1, f_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins |
   324	| `PutValue { A1, v_a }` × `PutFormula { A1, f_b }` | Last-in-causal-order wins; replay applies both and recompute observes final state |
   325	| `ClearFormula { A1 }` × `PutFormula { A1, f }` | Last-in-causal-order wins |
   326	| `SetName { foo, t_a }` × `SetName { foo, t_b }` | Last-in-causal-order wins |
   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
   328	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
   329	| `DropTable "T"` × concurrent edit referencing T | Edit appends with old table-ref → bind fails post-merge → `#NAME?`. |
   330	
   331	The 5.3 audit checkpoint validates these defaults against the
   332	Phase 4.12 megaudit's cycle-detection / spill / drop-table
   333	invariants — every Phase 4 edge case must survive the CRDT
   334	merge.
   335	
   336	### Peer-id stability is a precondition for CRDT convergence
   337	
   338	**Phase 5.3 step 1 audit closure (2026-05-20).** Loro's
   339	Fugue/origin-based merge uses peer-ids as a tiebreaker. Two peers
   340	forking from the same snapshot MUST carry STABLE non-zero peer-ids
   341	across the lifetime of their OpLogs for deterministic convergence
   342	under bidirectional merge:
   343	
   344	- **Production code** (`ql_collab::CollabSession::new` /
   345	  `from_snapshot`) already enforces this — both constructors call

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '640,675p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   640	### D-3: RenameSheet × concurrent edit — known V1 limitation
   641	
   642	**Status:** ✅ SHIPPED at commit `e71312d4bcd` (2026-05-19) — `BindError::UnknownSheet(_)` now maps to `Value::Error(ErrorValue::Name)` in both `recompute_all` and `recompute_dirty`, matching the existing `UnknownTable` / `UnknownTableColumn` treatment. Phase 5.3 will add the causality-aware rename-repair pass; until then `RenameSheet × concurrent-edit` produces `#NAME?` (documented known V1 limitation). Cross-ref `crates/ql-exec/src/workbook_runtime/recompute.rs`.
   643	
   644	**Source:** Opus H-2 + Codex V5.
   645	
   646	The pre-audit design described this as "edit's formula text
   647	references the old name → bind fails → `#NAME?`." Codex
   648	verified the actual bug shape:
   649	
   650	- Bind error type is `BindError::UnknownSheet("S")`, NOT
   651	  `BindError::UnresolvedName("S")` (different code path).
   652	- `recompute_all` (post-Tier-C1) does NOT map
   653	  `BindError::UnknownSheet` to `Value::Error(ErrorValue::Name)`
   654	  — only `UnknownTable` and `UnknownTableColumn` get that
   655	  treatment in `cells.rs::recompute_dirty` and `recompute_all`
   656	  (`workbook_runtime/recompute.rs:179`).
   657	- Result: the cell retains its stale pre-recompute value AND
   658	  the formula appears as a `RecomputeFailure` in
   659	  `RecomputeResult::failures`. Worse than `#NAME?` — the user
   660	  sees the formula text but a wrong value.
   661	
   662	**Resolution:** Phase 5.2 adds the missing
   663	`BindError::UnknownSheet → ErrorValue::Name` mapping in
   664	`recompute_all` and `recompute_dirty` so the cell at least
   665	shows `#NAME?` after the merge. Phase 5.3 adds a causality-
   666	aware rename-repair pass: at merge time, the replay sweep
   667	walks formulas added causally-before the RenameSheet op and
   668	rewrites their text in-place (the same way the producer-side
   669	rename does for visible formulas).
   670	
   671	Documented as a **known Phase 5.2 V1 limitation**: concurrent
   672	cross-sheet formula additions may surface as `#NAME?` until
   673	manual edit or until 5.3 ships the causality-aware repair.
   674	
   675	### D-4: Spill semantics — replay defers to recompute, not per-op

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '300,365p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   300	    ///
   301	    /// Presence writes use the `PRESENCE_COMMIT_ORIGIN` origin
   302	    /// (see [`presence_set`]). To exclude them from the undo stack
   303	    /// call `manager.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`
   304	    /// after construction. The `ql_collab::CollabSession`
   305	    /// integration does this automatically.
   306	    pub fn new_undo_manager(&self) -> loro::UndoManager {
   307	        loro::UndoManager::new(&self.doc)
   308	    }
   309	
   310	    /// **Phase 5.6 (2026-05-19):** list the peer keys currently
   311	    /// represented in the `"presence"` map.
   312	    ///
   313	    /// Order is Loro's iteration order (not stable across versions).
   314	    /// Callers wanting deterministic order should sort the result.
   315	    pub fn presence_peers(&self) -> Vec<String> {
   316	        let map = self.doc.get_map(PRESENCE_CONTAINER);
   317	        let mut out = Vec::with_capacity(map.len());
   318	        map.for_each(|key, _| out.push(key.to_owned()));
   319	        out
   320	    }
   321	
   322	    /// Export the log to a binary blob suitable for on-disk persistence.
   323	    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
   324	    /// compressed.
   325	    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
   326	        Ok(self.doc.export(ExportMode::Snapshot)?)
   327	    }
   328	
   329	    /// Reconstruct an `OpLog` from a previously-exported snapshot.
   330	    /// If the snapshot doesn't carry our `"ops"` container shape,
   331	    /// subsequent `iter` / `len` calls operate on an empty list
   332	    /// (Loro creates absent root containers on first access).
   333	    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
   334	        let doc = LoroDoc::new();
   335	        doc.import(bytes)?;
   336	        Ok(Self { doc })
   337	    }
   338	
   339	    /// **Phase 5.2 D-4 (2026-05-19):** merge another peer's snapshot
   340	    /// into this log via Loro's CRDT merge. Concurrent appends to
   341	    /// the `"ops"` LoroList are preserved in deterministic causal
   342	    /// order (Fugue/origin-based with peer-id tiebreaker per
   343	    /// `loro-internal::container::richtext::tracker::crdt_rope`).
   344	    ///
   345	    /// Typical pattern for multi-peer collaboration:
   346	    /// 1. Both peers start from a shared snapshot (`import_bytes`).
   347	    /// 2. Each peer appends its own ops independently.
   348	    /// 3. Peer A exports its current state via `export_bytes`.
   349	    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
   350	    ///    contains both peers' ops in causal order.
   351	    /// 5. Replay against a workbook reconstructs the merged state.
   352	    /// 6. `WorkbookRuntime::recompute_all` resolves derived state
   353	    ///    (spills, formula values) from the merged final state.
   354	    ///
   355	    /// Returns the new `len()` after merge.
   356	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
   357	        self.doc.import(bytes)?;
   358	        Ok(self.len())
   359	    }
   360	}
   361	
   362	#[cfg(test)]
   363	mod tests {
   364	    use super::*;
   365	    use crate::wire::{CellWireValue, NamedTargetWire};

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '330,370p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   330	            _ => unreachable!(
   331	                "FormatTableError gained a variant — extend FormatRejectedSource::From"
   332	            ),
   333	        }
   334	    }
   335	}
   336	
   337	/// Replay every op in `log` against `workbook` in append order.
   338	///
   339	/// Returns the total count of ops applied on success. On failure, the
   340	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
   341	/// the caller how far replay got.
   342	///
   343	/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
   344	/// and is unused in 2A.3.a (replay persists formula text without
   345	/// re-evaluating; callers drive evaluation through `recompute_all`).
   346	pub fn replay_into(
   347	    log: &OpLog,
   348	    workbook: &mut Workbook,
   349	    _registry: &FunctionRegistry,
   350	) -> Result<usize, ReplayError> {
   351	    let mut count = 0;
   352	    for (index, op_result) in log.iter().enumerate() {
   353	        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
   354	        apply_op(&op, workbook, index)?;
   355	        count += 1;
   356	    }
   357	    Ok(count)
   358	}
   359	
   360	/// Recursive helper. `index` is the op's position in the outer log (or
   361	/// the synthetic position of the enclosing BatchCommit for nested ops —
   362	/// 2A.3.a flattens by reporting the parent's index for nested failures).
   363	fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
   364	    match op {
   365	        Op::PutValue {
   366	            sheet,
   367	            row,
   368	            col,
   369	            value,
   370	        } => {

codex
One serious candidate is emerging: same-source concurrent renames are fixed, but different-source concurrent renames to the same target still route through `Workbook::rename_sheet` and will reject the later op as a duplicate. I’m checking whether that is already covered/declared elsewhere or if this patch leaves a second replay hard-fail in the same feature area.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1610,1745p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1610	            wb.sheet(0).unwrap().format_overlay().get(0, 0),
  1611	            Some(ql_storage::FormatId::Builtin(14))
  1612	        );
  1613	    }
  1614	
  1615	    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
  1616	
  1617	    #[test]
  1618	    fn replay_rename_sheet_basic() {
  1619	        // AddSheet + RenameSheet replays into a sheet with the new name.
  1620	        let mut log = OpLog::new();
  1621	        log.append(Op::AddSheet {
  1622	            name: "Sheet1".to_owned(),
  1623	            chunk_rows: 1024,
  1624	        })
  1625	        .unwrap();
  1626	        log.append(Op::RenameSheet {
  1627	            id: 0,
  1628	            old_name: "Sheet1".to_owned(),
  1629	            new_name: "Renamed".to_owned(),
  1630	        })
  1631	        .unwrap();
  1632	
  1633	        let mut wb = Workbook::new();
  1634	        let reg = default_registry();
  1635	        replay_into(&log, &mut wb, &reg).unwrap();
  1636	        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
  1637	    }
  1638	
  1639	    #[test]
  1640	    fn replay_rename_sheet_already_renamed_is_noop() {
  1641	        // Replay-on-top-of-snapshot path: snapshot already has the new
  1642	        // name; replay must NOT error.
  1643	        let mut log = OpLog::new();
  1644	        log.append(Op::RenameSheet {
  1645	            id: 0,
  1646	            old_name: "Sheet1".to_owned(),
  1647	            new_name: "Renamed".to_owned(),
  1648	        })
  1649	        .unwrap();
  1650	
  1651	        let mut wb = Workbook::new();
  1652	        wb.add_sheet("Renamed"); // snapshot already at the new name
  1653	        let reg = default_registry();
  1654	        replay_into(&log, &mut wb, &reg).unwrap();
  1655	        assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
  1656	    }
  1657	
  1658	    /// **Phase 5.3 step 2 (2026-05-20):** test name + assertion
  1659	    /// inverted by the audit-locked CRDT policy change. Pre-step-2
  1660	    /// this asserted `SheetRenameNameMismatch` fired when the
  1661	    /// current sheet name matched neither old nor new (e.g. a
  1662	    /// snapshot whose state diverged from the op's `old_name`).
  1663	    /// Post-step-2 that case applies the rename to the current
  1664	    /// sheet ("last-in-causal-order wins" policy) — current name
  1665	    /// after replay is `new_name`.
  1666	    ///
  1667	    /// The renamed test reflects the new property: replay applies
  1668	    /// the rename even when current ≠ old_name.
  1669	    #[test]
  1670	    fn replay_rename_sheet_current_neither_old_nor_new_applies_rename() {
  1671	        // Snapshot has a name that's neither old nor new ⇒ under
  1672	        // Phase 5.3 step 2, this is the canonical concurrent-rename
  1673	        // scenario: another peer's rename already changed the sheet
  1674	        // name; this op's `old_name` is interpreted as "what the
  1675	        // peer thought was current," and replay applies the rename
  1676	        // to whatever the sheet currently is.
  1677	        let mut log = OpLog::new();
  1678	        log.append(Op::RenameSheet {
  1679	            id: 0,
  1680	            old_name: "Sheet1".to_owned(),
  1681	            new_name: "Renamed".to_owned(),
  1682	        })
  1683	        .unwrap();
  1684	
  1685	        let mut wb = Workbook::new();
  1686	        wb.add_sheet("Something Else");
  1687	        let reg = default_registry();
  1688	        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
  1689	        assert_eq!(
  1690	            wb.sheet(0).unwrap().name(),
  1691	            "Renamed",
  1692	            "Phase 5.3 step 2: 'last-in-causal-order wins' — rename applies to current sheet"
  1693	        );
  1694	    }
  1695	
  1696	    #[test]
  1697	    fn replay_rename_sheet_invalid_id_errors() {
  1698	        let mut log = OpLog::new();
  1699	        log.append(Op::RenameSheet {
  1700	            id: 7,
  1701	            old_name: "Sheet1".to_owned(),
  1702	            new_name: "Renamed".to_owned(),
  1703	        })
  1704	        .unwrap();
  1705	
  1706	        let mut wb = fresh_workbook_with_one_sheet();
  1707	        let reg = default_registry();
  1708	        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
  1709	        assert!(matches!(err, ReplayError::InvalidSheet { .. }));
  1710	    }
  1711	
  1712	    #[test]
  1713	    fn replay_rename_sheet_duplicate_target_errors() {
  1714	        // Two sheets exist; renaming the first to the second's name must
  1715	        // fail through SheetRenameRejected.
  1716	        let mut log = OpLog::new();
  1717	        log.append(Op::AddSheet {
  1718	            name: "Sheet1".to_owned(),
  1719	            chunk_rows: 1024,
  1720	        })
  1721	        .unwrap();
  1722	        log.append(Op::AddSheet {
  1723	            name: "Sheet2".to_owned(),
  1724	            chunk_rows: 1024,
  1725	        })
  1726	        .unwrap();
  1727	        log.append(Op::RenameSheet {
  1728	            id: 0,
  1729	            old_name: "Sheet1".to_owned(),
  1730	            new_name: "Sheet2".to_owned(),
  1731	        })
  1732	        .unwrap();
  1733	
  1734	        let mut wb = Workbook::new();
  1735	        let reg = default_registry();
  1736	        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
  1737	        assert!(matches!(err, ReplayError::SheetRenameRejected { .. }));
  1738	    }
  1739	
  1740	    #[test]
  1741	    fn replay_rename_inside_batchcommit() {
  1742	        // Producer pattern: rewrite-then-rename batched as a single
  1743	        // BatchCommit. Verify the batch replays atomically.
  1744	        let mut log = OpLog::new();
  1745	        log.append(Op::AddSheet {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs | sed -n '1,340p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
     2	//!
     3	//! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
     4	//! had three cases. Case 3 ("current name matches neither old nor
     5	//! new") returned `ReplayError::SheetRenameNameMismatch`, which
     6	//! **hard-failed replay** under CRDT merge of concurrent renames.
     7	//! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
     8	//! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
     9	//! After Loro's causal merge, whichever rename replays SECOND finds
    10	//! `current != "S"` (already renamed by the first) and `current !=
    11	//! its own new_name` — case 3 — replay errored.
    12	//!
    13	//! Post-step-2: case 3 applies the rename to whatever the sheet
    14	//! currently is. The audit-locked policy from `crdt-data-model.md`
    15	//! § 311-334 — "last-in-causal-order wins" — produces deterministic
    16	//! convergence: both peers, after merging each other's ops, observe
    17	//! the same final sheet name (the winner's new_name).
    18	//!
    19	//! These probes pin the property via the D-4 / step-1 test pattern.
    20	//! `fork_with_peer(base, peer_id)` inlined here because it lives in
    21	//! a different test target (ql-exec); the helper is small enough to
    22	//! duplicate, and keeping these tests in ql-oplog avoids pulling in
    23	//! ql-exec for a replay-layer concern.
    24	//!
    25	//! Convergence still requires stable non-zero peer-ids per
    26	//! `crdt-data-model.md` § "Peer-id stability is a precondition for
    27	//! CRDT convergence" (added by Phase 5.3 step 1 audit closure).
    28	
    29	use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
    30	use ql_storage::Workbook;
    31	use ql_types::Address;
    32	
    33	const PEER_A_ID: u64 = 1;
    34	const PEER_B_ID: u64 = 2;
    35	
    36	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    37	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    38	    log.set_peer_id(peer_id)
    39	        .expect("set_peer_id with non-zero id must succeed");
    40	    log
    41	}
    42	
    43	fn base_with_sheet(name: &str) -> OpLog {
    44	    let mut log = OpLog::new();
    45	    log.append(Op::AddSheet {
    46	        name: name.to_owned(),
    47	        chunk_rows: 16384,
    48	    })
    49	    .unwrap();
    50	    log
    51	}
    52	
    53	/// Replay log into a fresh workbook. NOTE: unlike the step 1 probes
    54	/// in `phase_5_3_conflict_matrix_probe.rs`, these tests don't need
    55	/// recompute (we're checking the sheet-name layer, not formula
    56	/// evaluation). So we use `replay_into` directly without pulling in
    57	/// `WorkbookRuntime` / ql-exec.
    58	fn replay_into_fresh(log: &OpLog) -> Workbook {
    59	    let mut wb = Workbook::new();
    60	    // default_registry would require ql-functions; pass an empty
    61	    // registry — replay doesn't call into the function registry
    62	    // anyway (it stores formulas as text, recomputes on demand).
    63	    let reg = ql_functions::default_registry();
    64	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    65	    wb
    66	}
    67	
    68	/// **Step 2 PRIMARY property:** two peers concurrently rename the
    69	/// same sheet to DIFFERENT targets. Replay must NOT hard-fail. The
    70	/// merged log's final sheet name converges across merge directions.
    71	#[test]
    72	fn step2_concurrent_rename_different_targets_converges() {
    73	    let base = base_with_sheet("S").export_bytes().unwrap();
    74	
    75	    // Peer A's view: id=1 renames S → S2, then merges peer B's bytes.
    76	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    77	    peer_a
    78	        .append(Op::RenameSheet {
    79	            id: 0,
    80	            old_name: "S".to_owned(),
    81	            new_name: "S2".to_owned(),
    82	        })
    83	        .unwrap();
    84	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
    85	    peer_b_for_a
    86	        .append(Op::RenameSheet {
    87	            id: 0,
    88	            old_name: "S".to_owned(),
    89	            new_name: "S3".to_owned(),
    90	        })
    91	        .unwrap();
    92	    peer_a
    93	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
    94	        .expect("merge_bytes must succeed");
    95	
    96	    // Peer B's view: symmetric — id=2 renames S → S3, then merges A.
    97	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    98	    peer_b
    99	        .append(Op::RenameSheet {
   100	            id: 0,
   101	            old_name: "S".to_owned(),
   102	            new_name: "S3".to_owned(),
   103	        })
   104	        .unwrap();
   105	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   106	    peer_a_for_b
   107	        .append(Op::RenameSheet {
   108	            id: 0,
   109	            old_name: "S".to_owned(),
   110	            new_name: "S2".to_owned(),
   111	        })
   112	        .unwrap();
   113	    peer_b
   114	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   115	        .expect("merge_bytes must succeed (reverse direction)");
   116	
   117	    // **The critical assertion**: replay must succeed (no
   118	    // SheetRenameNameMismatch hard-fail).
   119	    let wb_a = replay_into_fresh(&peer_a);
   120	    let wb_b = replay_into_fresh(&peer_b);
   121	
   122	    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
   123	    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
   124	
   125	    assert_eq!(
   126	        name_a, name_b,
   127	        "convergence: both peers must observe the same final sheet name"
   128	    );
   129	    // The winner is one of {S2, S3}; we don't predict WHICH (depends
   130	    // on Loro's tiebreaker).
   131	    assert!(
   132	        name_a == "S2" || name_a == "S3",
   133	        "sheet name must be one of the concurrently-written targets; got {name_a:?}"
   134	    );
   135	}
   136	
   137	/// **Step 2:** two peers concurrently rename to the SAME target.
   138	/// Trivially idempotent — both ops fold into the same final state.
   139	/// Pinned to catch any regression that breaks the "second op finds
   140	/// current == new_name → no-op" path (case 1 in the post-step-2
   141	/// classification).
   142	#[test]
   143	fn step2_concurrent_rename_identical_targets_is_idempotent() {
   144	    let base = base_with_sheet("S").export_bytes().unwrap();
   145	
   146	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   147	    peer_a
   148	        .append(Op::RenameSheet {
   149	            id: 0,
   150	            old_name: "S".to_owned(),
   151	            new_name: "Renamed".to_owned(),
   152	        })
   153	        .unwrap();
   154	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   155	    peer_b
   156	        .append(Op::RenameSheet {
   157	            id: 0,
   158	            old_name: "S".to_owned(),
   159	            new_name: "Renamed".to_owned(),
   160	        })
   161	        .unwrap();
   162	
   163	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   164	    let wb = replay_into_fresh(&peer_a);
   165	    assert_eq!(wb.sheet(0).unwrap().name(), "Renamed");
   166	}
   167	
   168	/// **Step 2:** sequential rename across peers (peer B SAW peer A's
   169	/// rename before issuing its own). No concurrency — peer B's op has
   170	/// `old_name = "S2"` matching the post-A-rename state. Pinned as a
   171	/// regression baseline: the policy change must NOT break the
   172	/// non-concurrent case.
   173	#[test]
   174	fn step2_sequential_rename_across_peers_converges() {
   175	    let base = base_with_sheet("S").export_bytes().unwrap();
   176	
   177	    // Peer A: rename S → S2.
   178	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   179	    peer_a
   180	        .append(Op::RenameSheet {
   181	            id: 0,
   182	            old_name: "S".to_owned(),
   183	            new_name: "S2".to_owned(),
   184	        })
   185	        .unwrap();
   186	
   187	    // Peer B receives peer A's bytes FIRST (sees S2), then renames
   188	    // S2 → S3. This is the sequential (not concurrent) path.
   189	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   190	    peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
   191	    peer_b
   192	        .append(Op::RenameSheet {
   193	            id: 0,
   194	            old_name: "S2".to_owned(),
   195	            new_name: "S3".to_owned(),
   196	        })
   197	        .unwrap();
   198	
   199	    // Peer A then receives peer B's full log.
   200	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   201	
   202	    let wb_a = replay_into_fresh(&peer_a);
   203	    let wb_b = replay_into_fresh(&peer_b);
   204	    assert_eq!(wb_a.sheet(0).unwrap().name(), "S3");
   205	    assert_eq!(wb_b.sheet(0).unwrap().name(), "S3");
   206	}
   207	
   208	/// **Step 2:** concurrent rename + concurrent literal write at the
   209	/// renamed sheet. Both ops apply (no hard-fail on either). The
   210	/// literal lives at the renamed sheet's address; sheet name is
   211	/// the rename winner. This is the test row 7 of the conflict
   212	/// matrix pinned ONLY for the rename-doesn't-fail property — full
   213	/// row-7 formula behavior (rewrite to new name) is step 3's work.
   214	#[test]
   215	fn step2_concurrent_rename_plus_literal_write_both_apply() {
   216	    let base = base_with_sheet("S").export_bytes().unwrap();
   217	
   218	    // Peer A: rename S → S2.
   219	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   220	    peer_a
   221	        .append(Op::RenameSheet {
   222	            id: 0,
   223	            old_name: "S".to_owned(),
   224	            new_name: "S2".to_owned(),
   225	        })
   226	        .unwrap();
   227	
   228	    // Peer B (concurrent, no knowledge of rename): PutValue at S!A1.
   229	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   230	    peer_b
   231	        .append(Op::PutValue {
   232	            sheet: 0,
   233	            row: 0,
   234	            col: 0,
   235	            value: CellWireValue::Number(42.0),
   236	        })
   237	        .unwrap();
   238	
   239	    peer_a
   240	        .merge_bytes(&peer_b.export_bytes().unwrap())
   241	        .expect("merge must succeed even with concurrent rename + edit");
   242	    let wb = replay_into_fresh(&peer_a);
   243	
   244	    // Sheet is renamed (peer A's intent applied).
   245	    assert_eq!(
   246	        wb.sheet(0).unwrap().name(),
   247	        "S2",
   248	        "rename applied; literal write doesn't block rename"
   249	    );
   250	    // PutValue at sheet 0 row 0 col 0 still applied — addresses by
   251	    // sheet ID, not sheet NAME (sheet ID is stable across rename).
   252	    let val = wb.read(Address::new(0, 0, 0));
   253	    assert_eq!(
   254	        val,
   255	        ql_types::Value::Number(42.0),
   256	        "concurrent PutValue at sheet 0 must apply; got {val:?}"
   257	    );
   258	}
   259	
   260	/// **Step 2:** triple-peer concurrent rename. All three peers
   261	/// concurrently rename the same sheet to DIFFERENT targets. After
   262	/// pairwise merge, all peers must converge on the same name (one
   263	/// of the three targets).
   264	///
   265	/// **Why this test matters**: the audit at step 2 should consider
   266	/// peer counts beyond 2. Loro's causal order is transitive across
   267	/// peer counts, but the test pins the property explicitly.
   268	#[test]
   269	fn step2_three_peer_concurrent_rename_converges() {
   270	    let base = base_with_sheet("S").export_bytes().unwrap();
   271	
   272	    const PEER_C_ID: u64 = 3;
   273	
   274	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   275	    peer_a
   276	        .append(Op::RenameSheet {
   277	            id: 0,
   278	            old_name: "S".to_owned(),
   279	            new_name: "Apple".to_owned(),
   280	        })
   281	        .unwrap();
   282	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   283	    peer_b
   284	        .append(Op::RenameSheet {
   285	            id: 0,
   286	            old_name: "S".to_owned(),
   287	            new_name: "Banana".to_owned(),
   288	        })
   289	        .unwrap();
   290	    let mut peer_c = fork_with_peer(&base, PEER_C_ID);
   291	    peer_c
   292	        .append(Op::RenameSheet {
   293	            id: 0,
   294	            old_name: "S".to_owned(),
   295	            new_name: "Cherry".to_owned(),
   296	        })
   297	        .unwrap();
   298	
   299	    // Star-merge: every peer pulls every other peer's bytes.
   300	    let bytes_a = peer_a.export_bytes().unwrap();
   301	    let bytes_b = peer_b.export_bytes().unwrap();
   302	    let bytes_c = peer_c.export_bytes().unwrap();
   303	    peer_a.merge_bytes(&bytes_b).unwrap();
   304	    peer_a.merge_bytes(&bytes_c).unwrap();
   305	    peer_b.merge_bytes(&bytes_a).unwrap();
   306	    peer_b.merge_bytes(&bytes_c).unwrap();
   307	    peer_c.merge_bytes(&bytes_a).unwrap();
   308	    peer_c.merge_bytes(&bytes_b).unwrap();
   309	
   310	    let wb_a = replay_into_fresh(&peer_a);
   311	    let wb_b = replay_into_fresh(&peer_b);
   312	    let wb_c = replay_into_fresh(&peer_c);
   313	
   314	    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
   315	    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
   316	    let name_c = wb_c.sheet(0).unwrap().name().to_owned();
   317	
   318	    assert_eq!(name_a, name_b, "three-peer convergence A == B");
   319	    assert_eq!(name_b, name_c, "three-peer convergence B == C");
   320	    assert!(
   321	        ["Apple", "Banana", "Cherry"].contains(&name_a.as_str()),
   322	        "winner must be one of the three concurrent renames; got {name_a:?}"
   323	    );
   324	}

exec
/bin/zsh -lc "rg -n \"duplicate.*rename|SheetRenameRejected|RenameSheet.*Duplicate|same target|S2\\)\" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:162:    SheetRenameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:503:            //      peers picked the same target). No-op; success.
quantbook-engine/crates/ql-oplog/src/replay.rs:541:            //     different sheet) → `SheetRenameRejected` propagated
quantbook-engine/crates/ql-oplog/src/replay.rs:563:                    .map_err(|source| ReplayError::SheetRenameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1715:        // fail through SheetRenameRejected.
quantbook-engine/crates/ql-oplog/src/replay.rs:1737:        assert!(matches!(err, ReplayError::SheetRenameRejected { .. }));
quantbook-engine/crates/ql-oplog/src/replay.rs:1891:    fn replay_add_sheet_canonical_duplicate_auto_renames() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:187:    // Peer B receives peer A's bytes FIRST (sees S2), then renames

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1745,1795p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1745	        log.append(Op::AddSheet {
  1746	            name: "S1".to_owned(),
  1747	            chunk_rows: 1024,
  1748	        })
  1749	        .unwrap();
  1750	        log.append(Op::AddSheet {
  1751	            name: "S2".to_owned(),
  1752	            chunk_rows: 1024,
  1753	        })
  1754	        .unwrap();
  1755	        log.append(Op::PutFormula {
  1756	            sheet: 1, // S2!A1
  1757	            row: 0,
  1758	            col: 0,
  1759	            text: "S1!A1 + 1".to_owned(),
  1760	        })
  1761	        .unwrap();
  1762	        log.append(Op::BatchCommit {
  1763	            ops: vec![
  1764	                Op::PutFormula {
  1765	                    sheet: 1,
  1766	                    row: 0,
  1767	                    col: 0,
  1768	                    text: "SX!A1 + 1".to_owned(),
  1769	                },
  1770	                Op::RenameSheet {
  1771	                    id: 0,
  1772	                    old_name: "S1".to_owned(),
  1773	                    new_name: "SX".to_owned(),
  1774	                },
  1775	            ],
  1776	        })
  1777	        .unwrap();
  1778	
  1779	        let mut wb = Workbook::new();
  1780	        let reg = default_registry();
  1781	        replay_into(&log, &mut wb, &reg).unwrap();
  1782	        assert_eq!(wb.sheet(0).unwrap().name(), "SX");
  1783	        assert_eq!(
  1784	            wb.formula_at(1, 0, 0).map(|s| s.as_ref().to_owned()),
  1785	            Some("SX!A1 + 1".to_owned())
  1786	        );
  1787	    }
  1788	
  1789	    // ===== W5-92 (Phase 4.6.D) Op::SetName scoped variant =====
  1790	
  1791	    #[test]
  1792	    fn replay_set_name_sheet_scoped_lands_on_sheet() {
  1793	        let mut log = OpLog::new();
  1794	        log.append(Op::AddSheet {
  1795	            name: "S1".to_owned(),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '773,835p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   773	fn apply_rename_column(
   774	    workbook: &mut ql_storage::Workbook,
   775	    index: usize,
   776	    table: &str,
   777	    old_name: &str,
   778	    new_name: &str,
   779	) -> Result<(), ReplayError> {
   780	    let table_canonical = table.to_ascii_uppercase();
   781	    let meta = workbook
   782	        .tables_mut()
   783	        .get_mut(&table_canonical)
   784	        .ok_or_else(|| ReplayError::TableNotFound {
   785	            index,
   786	            name: table.to_owned(),
   787	        })?;
   788	    let (col_idx, _) =
   789	        meta.lookup_column(old_name)
   790	            .ok_or_else(|| ReplayError::TableColumnNotFound {
   791	                index,
   792	                table: table.to_owned(),
   793	                column: old_name.to_owned(),
   794	            })?;
   795	    if new_name.is_empty() {
   796	        return Err(ReplayError::TableColumnRejected {
   797	            index,
   798	            table: table.to_owned(),
   799	            column: new_name.to_owned(),
   800	            reason: "column name cannot be empty",
   801	        });
   802	    }
   803	    let old_lower = old_name.to_ascii_lowercase();
   804	    let new_lower = new_name.to_ascii_lowercase();
   805	    if old_lower == new_lower {
   806	        return Err(ReplayError::TableColumnRejected {
   807	            index,
   808	            table: table.to_owned(),
   809	            column: new_name.to_owned(),
   810	            reason: "rename to same canonical column name (producer should not emit)",
   811	        });
   812	    }
   813	    if meta.lookup_column(new_name).is_some() {
   814	        return Err(ReplayError::TableColumnRejected {
   815	            index,
   816	            table: table.to_owned(),
   817	            column: new_name.to_owned(),
   818	            reason: "column with this canonical name already exists (rename target)",
   819	        });
   820	    }
   821	    meta.columns[col_idx as usize].name = std::sync::Arc::from(new_lower.as_str());
   822	    meta.columns[col_idx as usize].display = std::sync::Arc::from(new_name);
   823	    workbook.tables_mut().bump_generation();
   824	    Ok(())
   825	}
   826	
   827	/// **W5-122 (Phase 4.8.J):** replay a `ResizeTable`. Validates the
   828	/// target table exists, the arithmetic invariant
   829	/// (`new_cols == old_cols + added.len() - removed.len()`),
   830	/// `removed_columns` exactly match the current trailing columns
   831	/// (case-insensitive on display), the final column roster has unique
   832	/// canonical names, and the new footprint cells outside the old
   833	/// footprint don't overlap other tables. Mutates the table metadata
   834	/// in place (rows/cols + columns vec). Bumps `TableTable` generation.
   835	fn apply_resize_table(

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '500,575p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   500	// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
   501	
   502	/// **Conflict-matrix row 7 (PRE-FIX behavior):** peer A renames
   503	/// sheet "S" to "S2"; peer B concurrently writes a formula at A1
   504	/// referencing "S!A1" (the old name). Per D-3 V1 limitation
   505	/// (`crdt-data-model.md:615-648`), the merged log replays such
   506	/// that peer B's formula references "S" which no longer exists
   507	/// → `BindError::UnknownSheet` → `Value::Error(ErrorValue::Name)`.
   508	///
   509	/// **This test will be MODIFIED by Phase 5.3 step 3** when the
   510	/// rename-repair pass ships. Post-step-3, the formula's text
   511	/// will be REWRITTEN to "S2!A1" by the repair pass, and the
   512	/// expected value flips from `#NAME?` to whatever S2!A1 holds.
   513	///
   514	/// **Audit closure (Codex MEDIUM-1 + Opus MEDIUM-1):** pinning
   515	/// the pre-fix behavior closes the matrix-doc/test-doc alignment
   516	/// gap. Step 3 modifying this test is the OBSERVABLE step-3 win.
   517	///
   518	/// **Audit closure (Codex deferred-from-survey)**: replay's
   519	/// `RenameSheet` handler currently HARD-FAILS on concurrent
   520	/// `RenameSheet × RenameSheet` (case 3 at `replay.rs:524-531`).
   521	/// This test exercises the safer scenario `RenameSheet × PutFormula`
   522	/// which doesn't trip the hard-fail; the harder case is pinned in
   523	/// step 2's tests.
   524	///
   525	/// We must use a base log with at least one cell at S!A1 (so peer B's
   526	/// formula has something to reference), and place peer B's formula
   527	/// at A2 of the same sheet so the reference is observable.
   528	#[test]
   529	fn row7_rename_sheet_concurrent_edit_yields_name_error_pre_step_3_fix() {
   530	    // Base: sheet S with a literal at S!A1.
   531	    let mut base_log = base_with_sheet();
   532	    base_log
   533	        .append(Op::PutValue {
   534	            sheet: 0,
   535	            row: 0,
   536	            col: 0,
   537	            value: CellWireValue::Number(42.0),
   538	        })
   539	        .unwrap();
   540	    let base = base_log.export_bytes().unwrap();
   541	
   542	    let (wb_a, wb_b) = fork_apply_merge_both_directions(
   543	        &base,
   544	        Op::RenameSheet {
   545	            id: 0,
   546	            old_name: "S".to_owned(),
   547	            new_name: "S2".to_owned(),
   548	        },
   549	        Op::PutFormula {
   550	            sheet: 0,
   551	            row: 1,
   552	            col: 0,
   553	            text: "S!A1".to_owned(),
   554	        },
   555	    );
   556	
   557	    let a2_a = wb_a.read(Address::new(0, 1, 0));
   558	    let a2_b = wb_b.read(Address::new(0, 1, 0));
   559	
   560	    assert_eq!(a2_a, a2_b, "convergence on S2!A2");
   561	    // **PRE-FIX assertion**: bind fails → #NAME?. After Phase 5.3
   562	    // step 3 ships the rename-repair pass, this should resolve to
   563	    // Number(42.0) — the repair pass rewrites "S!A1" → "S2!A1" and
   564	    // bind succeeds. Step 3 will modify the assertion.
   565	    assert_eq!(
   566	        a2_a,
   567	        Value::Error(ErrorValue::Name),
   568	        "PRE-FIX (D-3 V1 limitation): formula references old sheet name → \
   569	         BindError::UnknownSheet → #NAME?; got {a2_a:?}. \
   570	         Phase 5.3 step 3 will fix this via rename-repair."
   571	    );
   572	}
   573	
   574	// ===== Row 8: DropTable × concurrent edit referencing T =====
   575	

exec
/bin/zsh -lc "rg -n \"RenameSheet \\{|old_name.*validation|replay-time validation|SheetRenameNameMismatch|current name matches neither|old_name carried\" quantbook-engine/crates quantbook-engine/docs -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:328:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/crates/ql-oplog/src/replay.rs:135:    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/crates/ql-oplog/src/replay.rs:149:    SheetRenameNameMismatch {
quantbook-engine/crates/ql-oplog/src/replay.rs:492:        Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:509:            //          `SheetRenameNameMismatch` (replay hard-failed).
quantbook-engine/crates/ql-oplog/src/replay.rs:514:            //          concurrently issues `RenameSheet { old: "S1",
quantbook-engine/crates/ql-oplog/src/replay.rs:1626:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1644:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1660:    /// this asserted `SheetRenameNameMismatch` fired when the
quantbook-engine/crates/ql-oplog/src/replay.rs:1678:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1699:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1727:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1770:                Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/op.rs:108:    RenameSheet {
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:69:`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }` — old_name carried so replay can validate against the workbook state at replay time without scanning prior ops. Replay calls `Workbook::rename_sheet(id, new_name)` which is idempotent given matching old/new.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:257:**`Op::RenameSheet { id: SheetId, old_name: String, new_name: String }`** — per § 3.2. `old_name` carried for replay validation. Replay calls `Workbook::rename_sheet(id, new_name)`.
quantbook-engine/docs/architecture/2026-05-13-cross-sheet-references.md:416:- `Op::RenameSheet { old_name, new_name }` field choice — confirmed at § 3.2; revisit if collab/CRDT semantics (Phase 5) want a different shape.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:544:        Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:4://! had three cases. Case 3 ("current name matches neither old nor
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:5://! new") returned `ReplayError::SheetRenameNameMismatch`, which
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:7://! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:8://! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:78:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:86:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:99:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:107:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:118:    // SheetRenameNameMismatch hard-fail).
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:148:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:156:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:180:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:192:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:221:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:276:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:284:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:292:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:182:            Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1411:   129	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1419:   137	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1757:   455	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2277:   494	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:2951:   180	            Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4348:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:1454:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12051:   489	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:161:3. Neither → `SheetRenameNameMismatch` error (divergent state).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:900:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1882:docs/architecture/crdt-data-model.md:299:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2570:   299	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9331:   120	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9339:   128	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10635:   390	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7905:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32043:   135	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:32051:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1460:     RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1678:     /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1686:     SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1784:         Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1823:                 Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2251:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2269:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2287:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2298:         assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:2304:         log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:3193:             Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5381:   135	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5389:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5707:   461	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5746:   500	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6807:  1561	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6825:  1579	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6843:  1597	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6854:  1608	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6860:  1614	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6888:  1642	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6931:  1685	                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:40:- `crates/ql-oplog/src/replay.rs` — rename-sheet replay 3-case reconciliation, scoped-SetName routing, `ReplayError::SheetRenameNameMismatch` + `SheetRenameRejected`.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3261:    RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6724:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7593:525:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7771:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:429:docs/architecture/crdt-data-model.md:302:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:98:- `Op::RenameSheet { id, old_name, new_name }` variant. Replay handler
quantbook-engine/docs/audits/2026-05-14-engine-session-final-handoff.md:101:  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:3285:    RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10833:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3488:crates/ql-oplog/src/replay.rs:381:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3533:crates/ql-oplog/src/replay.rs:1445:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3534:crates/ql-oplog/src/replay.rs:1463:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3535:crates/ql-oplog/src/replay.rs:1481:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3536:crates/ql-oplog/src/replay.rs:1498:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3539:crates/ql-oplog/src/replay.rs:1526:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3545:crates/ql-oplog/src/replay.rs:1569:                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4625:crates/ql-oplog/tests/producer_replay_equivalence.rs:181:            Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4983:crates/ql-exec/src/workbook_runtime.rs:2269:            ops.push(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2369:   323	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md:49:**What**: The plan flags `Op::RenameSheet` concurrent replay as hard-failing (`SheetRenameNameMismatch`) and frames it as "the" gap. But `apply_rename_table` at `crates/ql-oplog/src/replay.rs:680-723` keys lookups solely by `old_canonical` (line 691); same for `apply_rename_column` (`replay.rs:733-755`). Two concurrent peers renaming the same table (T→T1 vs T→T2) produce a merged log where the second op's `old_name="T"` no longer resolves — `ReplayError::TableNotFound`. Identical bug shape, same root cause, same architectural fix.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:6058:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:85:3. Emits a `BatchCommit` containing `Op::PutFormula(rewrite)` × N + `Op::RenameSheet { id, old, new }`.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:450:   281	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownTable` or unresolved sheet → emit `#NAME?` per design § 12.4. Phase 5.3 hardens this. |
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1015:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1312:   121	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1320:   129	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1607:   404	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1646:   443	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2975:   196	            ops.push(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:935:   328	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2104:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2105:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2106:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2107:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2110:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4087:    21	**Concurrent RenameSheet currently HARD-FAILS replay** with `ReplayError::SheetRenameNameMismatch`. Two peers each renaming the same sheet (A: S1→S2, B: S1→S3 concurrent) → after Loro's causal-order merge, the second rename's `old_name = "S1"` doesn't match current state (now `S2`) → replay errors → unrecoverable state. This is a real gap unflagged by the design doc preview. **5.3 step 2 fixes this.**
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4162:    96	Survey replay's RenameTable + RenameColumn paths. If they have the same `SheetRenameNameMismatch`-shaped gap, extend step 2's fix. If formula text needs the same repair, extend step 3's module.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4350:   135	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4358:   143	    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4701:   486	        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4740:   525	                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5801:  1586	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5819:  1604	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5837:  1622	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5848:  1633	        assert!(matches!(err, ReplayError::SheetRenameNameMismatch { .. }));
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5854:  1639	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5882:  1667	        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5925:  1710	                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6252:quantbook-engine/crates/ql-oplog/src/replay.rs:486:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6281:quantbook-engine/crates/ql-oplog/src/replay.rs:1586:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6282:quantbook-engine/crates/ql-oplog/src/replay.rs:1604:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6283:quantbook-engine/crates/ql-oplog/src/replay.rs:1622:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6284:quantbook-engine/crates/ql-oplog/src/replay.rs:1639:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6287:quantbook-engine/crates/ql-oplog/src/replay.rs:1667:        log.append(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6292:quantbook-engine/crates/ql-oplog/src/replay.rs:1710:                Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6742:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7632:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7671:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8485:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1534:121:    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1542:129:    SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2397:404:        Op::RenameSheet {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2649:443:                Err(ReplayError::SheetRenameNameMismatch {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2452:   108	    RenameSheet {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5694:   129	    /// whose current name matches neither `old_name` nor `new_name`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5702:   137	    SheetRenameNameMismatch {

exec
/bin/zsh -lc 'cargo test -p ql-oplog --test phase_5_3_step2_rename_concurrent -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 56031ms:
   Compiling ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 5.80s
     Running tests/phase_5_3_step2_rename_concurrent.rs (target/debug/deps/phase_5_3_step2_rename_concurrent-7342d3e8b96b0506)

running 5 tests
test step2_concurrent_rename_different_targets_converges ... ok
test step2_concurrent_rename_identical_targets_is_idempotent ... ok
test step2_concurrent_rename_plus_literal_write_both_apply ... ok
test step2_sequential_rename_across_peers_converges ... ok
test step2_three_peer_concurrent_rename_converges ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s


codex
The new `ql-oplog` step-2 test target compiled; it is still running under the harness. I’ll let it finish or time out before finalizing, because a hang in the dedicated test target would itself be audit-relevant.
exec
/bin/zsh -lc 'cargo test -p ql-oplog replay_rename_sheet_duplicate_target_errors -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 133008ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.08s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 1 test
test replay::tests::replay_rename_sheet_duplicate_target_errors ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 64 filtered out; finished in 0.02s

     Running tests/d1_step8_legacy_op_shape.rs (target/debug/deps/d1_step8_legacy_op_shape-9267ab888beaf8ea)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/phase_5_3_step2_rename_concurrent.rs (target/debug/deps/phase_5_3_step2_rename_concurrent-7342d3e8b96b0506)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs | sed -n '232,335p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   232	
   233	    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
   234	
   235	    // ===== W5-91 (Phase 4.6.C) rename_sheet =====
   236	
   237	    #[test]
   238	    fn rename_sheet_rewrites_formula_text_and_recomputes() {
   239	        // S1!A1 = 10 ; S2!A1 = S1!A1 * 2 = 20.
   240	        // Rename S1 → SheetX. Stored formula on S2!A1 must read
   241	        // "SheetX!A1 ..."; recompute must still produce 20.
   242	        let mut wb = Workbook::new();
   243	        let s1 = wb.add_sheet("S1");
   244	        let s2 = wb.add_sheet("S2");
   245	        wb.put_at(s1, 0, 0, Value::Number(10.0));
   246	        let reg = default_registry();
   247	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   248	        rt.set_formula(s2, 0, 0, "S1!A1 * 2").unwrap();
   249	        rt.rename_sheet(s1, "SheetX").unwrap();
   250	        let _ = rt.recompute_all();
   251	        drop(rt);
   252	        assert_eq!(wb.sheet(s1).unwrap().name(), "SheetX");
   253	        let new_text = wb
   254	            .formula_at(s2, 0, 0)
   255	            .map(|s| s.as_ref().to_owned())
   256	            .unwrap_or_default();
   257	        assert!(
   258	            new_text.contains("SheetX!A1"),
   259	            "expected rewrite to mention SheetX!A1, got: {new_text:?}"
   260	        );
   261	        assert_eq!(
   262	            wb.read(ql_types::Address::new(s2, 0, 0)),
   263	            Value::Number(20.0)
   264	        );
   265	    }
   266	
   267	    #[test]
   268	    fn rename_sheet_leaves_unrelated_formulas_alone() {
   269	        // S1!A1 = 10, S1!B1 = A1*2 (no sheet prefix, owning-sheet relative).
   270	        // S2 exists. Rename S2 → SheetX. S1!B1's formula text must not change.
   271	        let mut wb = Workbook::new();
   272	        let s1 = wb.add_sheet("S1");
   273	        let s2 = wb.add_sheet("S2");
   274	        wb.put_at(s1, 0, 0, Value::Number(10.0));
   275	        let reg = default_registry();
   276	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   277	        rt.set_formula(s1, 0, 1, "A1 * 2").unwrap();
   278	        let before = wb
   279	            .formula_at(s1, 0, 1)
   280	            .map(|s| s.as_ref().to_owned())
   281	            .unwrap_or_default();
   282	
   283	        // Re-borrow.
   284	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   285	        rt.rename_sheet(s2, "SheetX").unwrap();
   286	        drop(rt);
   287	
   288	        let after = wb
   289	            .formula_at(s1, 0, 1)
   290	            .map(|s| s.as_ref().to_owned())
   291	            .unwrap_or_default();
   292	        assert_eq!(before, after);
   293	    }
   294	
   295	    #[test]
   296	    fn rename_sheet_duplicate_target_rejected_runtime() {
   297	        let mut wb = Workbook::new();
   298	        let s1 = wb.add_sheet("S1");
   299	        let _s2 = wb.add_sheet("S2");
   300	        let reg = default_registry();
   301	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   302	        let err = rt.rename_sheet(s1, "s2").unwrap_err();
   303	        assert!(matches!(err, RuntimeError::SheetName(_)));
   304	        drop(rt);
   305	        assert_eq!(wb.sheet(s1).unwrap().name(), "S1");
   306	    }
   307	
   308	    #[test]
   309	    fn rename_sheet_unknown_id_rejected_runtime() {
   310	        let mut wb = Workbook::new();
   311	        let _ = wb.add_sheet("S1");
   312	        let reg = default_registry();
   313	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   314	        let err = rt.rename_sheet(42, "X").unwrap_err();
   315	        assert!(matches!(err, RuntimeError::InvalidSheet { .. }));
   316	    }
   317	
   318	    #[test]
   319	    fn rename_sheet_case_only_rename_runtime() {
   320	        let mut wb = Workbook::new();
   321	        let s1 = wb.add_sheet("Sheet1");
   322	        wb.put_at(s1, 0, 0, Value::Number(10.0));
   323	        let reg = default_registry();
   324	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   325	        rt.set_formula(s1, 0, 1, "Sheet1!A1 + 1").unwrap();
   326	        rt.rename_sheet(s1, "SHEET1").unwrap();
   327	        let _ = rt.recompute_all();
   328	        drop(rt);
   329	        assert_eq!(wb.sheet(s1).unwrap().name(), "SHEET1");
   330	        assert_eq!(
   331	            wb.read(ql_types::Address::new(s1, 0, 1)),
   332	            Value::Number(11.0)
   333	        );
   334	    }
   335	

exec
/bin/zsh -lc "rg -n \"AddSheet|sheet id|SheetId|stable.*sheet|concurrent.*sheet|auto-renames|S\\(2\\)|D-2\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-opus.md -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:77:- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/architecture/crdt-data-model.md:327:| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/architecture/crdt-data-model.md:328:| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/architecture/crdt-data-model.md:554:   user-visible bugs (e.g., concurrent AddSheet "S" + edit on
quantbook-engine/docs/architecture/crdt-data-model.md:555:   sheet 0 by someone who hasn't seen the AddSheet yet).
quantbook-engine/docs/architecture/crdt-data-model.md:616:### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/architecture/crdt-data-model.md:618:**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/architecture/crdt-data-model.md:622:The pre-audit design said "AddSheet S × AddSheet S → first
quantbook-engine/docs/architecture/crdt-data-model.md:626:auto-disambiguation (S and S(2)). Silent rejection of the
quantbook-engine/docs/architecture/crdt-data-model.md:629:**Resolution:** Phase 5.2 acceptance criterion: AddSheet
quantbook-engine/docs/architecture/crdt-data-model.md:630:collision auto-renames the SECOND ADD (in deterministic merge
quantbook-engine/docs/architecture/crdt-data-model.md:635:change. The `Op::AddSheet { name }` op is unchanged; replay
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:38:- Row 6: AddSheet × AddSheet — D-2 auto-rename pin
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:66:4. **Row 6 (AddSheet auto-rename)**: I check sheet count == 2 and both names present. But I don't pin WHICH peer's add becomes "Calc(2)". Is that OK or should it pin the order based on peer-ids (id=1 vs id=2)?
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:124:    26	//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename — pin)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:139:    41	/// Build a base op log carrying `AddSheet("S")`. Most tests fork
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:140:    42	/// from this; the AddSheet × AddSheet test bypasses it (since it
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:144:    46	    log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:465:   367	// ===== Row 6: AddSheet × AddSheet same name (D-2 auto-rename) =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:467:   369	/// **Conflict-matrix row 6:** two peers each AddSheet with the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:468:   370	/// same name. Phase 5.2 D-2 (`1ca19e2fa37`) shipped the auto-
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:474:   376	    // Empty base — no AddSheet here; both peers contribute one.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:479:   381	        Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:483:   385	        Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:684:    77	- Sheets: `AddSheet`, `RenameSheet`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:934:   327	| `AddSheet "S"` × `AddSheet "S"` | **Both succeed; second in causal order auto-renames to `S(2)`** (Phase 5.2 D-2 ✅ shipped `1ca19e2fa37`). Escalates to `S(3)`, etc. on cascading collision; `AUTO_RENAME_CEILING = 10_000`. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:935:   328	| `RenameSheet { 0, A, B }` × concurrent edit on sheet 0 | Edit's formula text written under old name → after merge, formula references old name → bind fails → `BindError::UnknownSheet` → emit `#NAME?` (Phase 5.2 D-3 ✅ shipped `e71312d4bcd`). Phase 5.3 adds the causality-aware rename-repair pass. |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1136:   529	   user-visible bugs (e.g., concurrent AddSheet "S" + edit on
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1137:   530	   sheet 0 by someone who hasn't seen the AddSheet yet).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1198:   591	### D-2: AddSheet name collision — auto-rename in 5.2
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1200:   593	**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1204:   597	The pre-audit design said "AddSheet S × AddSheet S → first
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1208:   601	auto-disambiguation (S and S(2)). Silent rejection of the
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1211:   604	**Resolution:** Phase 5.2 acceptance criterion: AddSheet
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1212:   605	collision auto-renames the SECOND ADD (in deterministic merge
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1217:   610	change. The `Op::AddSheet { name }` op is unchanged; replay
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1847:   416	            Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1885:   454	            Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2086:quantbook-engine/crates/ql-oplog/src/replay.rs:1249:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2103:quantbook-engine/crates/ql-oplog/src/replay.rs:1581:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2108:quantbook-engine/crates/ql-oplog/src/replay.rs:1657:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2109:quantbook-engine/crates/ql-oplog/src/replay.rs:1662:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2111:quantbook-engine/crates/ql-oplog/src/replay.rs:1685:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2112:quantbook-engine/crates/ql-oplog/src/replay.rs:1690:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2115:quantbook-engine/crates/ql-oplog/src/replay.rs:1734:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2120:quantbook-engine/crates/ql-oplog/src/replay.rs:1844:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2121:quantbook-engine/crates/ql-oplog/src/replay.rs:1849:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2122:quantbook-engine/crates/ql-oplog/src/replay.rs:1872:            log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2123:quantbook-engine/crates/ql-oplog/src/replay.rs:1894:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2124:quantbook-engine/crates/ql-oplog/src/replay.rs:1899:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2125:quantbook-engine/crates/ql-oplog/src/replay.rs:1904:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2126:quantbook-engine/crates/ql-oplog/src/replay.rs:1926:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3005:   753	        s.append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3019:   767	            .append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3036:   784	        base.append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3054:   802	            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3093:   841	            .append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3266:  1014	        s.append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4123:    57	    pub sheets_with_renames: Vec<(SheetId, Vec<(String, String)>)>, // (sheet, chain of old→new pairs)
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4188:   122	2. **D-5.3-3 policy on concurrent renames**: "last-in-causal-order wins; rename current to new" vs. alternative ("first wins; second becomes auto-rename like D-2 AddSheet"). I've recommended the former (matches SetName); flagging in case you prefer the AddSheet-style auto-rename for consistency.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4214:/bin/zsh -lc "rg -n \"formula_text|put_formula|clear_formula|read\\(|set_value|SetName|BatchCommit|RenameSheet|DropTable|AddSheet|SetCellFormat|RenameTable|RenameColumn\" quantbook-engine/crates/ql-storage/src quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-exec/src" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4236:    21	//! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4260:    45	use ql_types::{ColId, RowId, SheetId, Value, MAX_COLUMN, MAX_ROW};
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4274:    59	    /// The op referenced an out-of-range sheet id.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4280:    65	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4360:   145	        id: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4373:   158	        id: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4380:   165	    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4647:   432	        Op::AddSheet { name, chunk_rows } => {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4655:   440	            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4660:   445	            // `Op::AddSheet { name: "S", ... }`; merged log has both.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4662:   447	            // Pre-D-2 we rejected the second op (worse UX than Google
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4663:   448	            // Sheets, which auto-renames to S(2)). Now we walk
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5190:   975	    sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5317:  1102	    sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5464:  1249	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5794:  1579	        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5796:  1581	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5872:  1657	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5877:  1662	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5900:  1685	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5905:  1690	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5949:  1734	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6043:  1828	    // ===== W5-93 (Phase 4.6.E closure) Op::AddSheet name validation =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6047:  1832	        // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename replaces
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6048:  1833	        // the pre-D-2 behavior of rejecting duplicate-canonical names
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6053:  1838	        // second auto-renames to `Sheet1(2)` rather than rejecting.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6055:  1840	        // Pre-D-2 this test was `replay_add_sheet_canonical_duplicate_rejected`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6056:  1841	        // asserting `ReplayError::SheetNameRejected`. The D-2 spec
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6059:  1844	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6064:  1849	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6087:  1872	            log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6105:  1890	        // Pre-existing "Sheet1(2)" forces the second AddSheet("Sheet1")
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6109:  1894	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6114:  1899	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6119:  1904	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6141:  1926	        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6234:quantbook-engine/crates/ql-oplog/src/replay.rs:21://! - `AddSheet` → `Workbook::add_sheet_with_chunk_rows`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6241:quantbook-engine/crates/ql-oplog/src/replay.rs:165:    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6250:quantbook-engine/crates/ql-oplog/src/replay.rs:432:        Op::AddSheet { name, chunk_rows } => {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6251:quantbook-engine/crates/ql-oplog/src/replay.rs:445:            // `Op::AddSheet { name: "S", ... }`; merged log has both.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6266:quantbook-engine/crates/ql-oplog/src/replay.rs:1249:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6279:quantbook-engine/crates/ql-oplog/src/replay.rs:1579:        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6280:quantbook-engine/crates/ql-oplog/src/replay.rs:1581:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6285:quantbook-engine/crates/ql-oplog/src/replay.rs:1657:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6286:quantbook-engine/crates/ql-oplog/src/replay.rs:1662:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6289:quantbook-engine/crates/ql-oplog/src/replay.rs:1685:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6290:quantbook-engine/crates/ql-oplog/src/replay.rs:1690:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6294:quantbook-engine/crates/ql-oplog/src/replay.rs:1734:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6299:quantbook-engine/crates/ql-oplog/src/replay.rs:1828:    // ===== W5-93 (Phase 4.6.E closure) Op::AddSheet name validation =====
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6300:quantbook-engine/crates/ql-oplog/src/replay.rs:1844:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6301:quantbook-engine/crates/ql-oplog/src/replay.rs:1849:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6302:quantbook-engine/crates/ql-oplog/src/replay.rs:1872:            log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6303:quantbook-engine/crates/ql-oplog/src/replay.rs:1890:        // Pre-existing "Sheet1(2)" forces the second AddSheet("Sheet1")
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6304:quantbook-engine/crates/ql-oplog/src/replay.rs:1894:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6305:quantbook-engine/crates/ql-oplog/src/replay.rs:1899:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6306:quantbook-engine/crates/ql-oplog/src/replay.rs:1904:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6307:quantbook-engine/crates/ql-oplog/src/replay.rs:1926:        log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6411:quantbook-engine/crates/ql-storage/src/workbook.rs:914:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6468:quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:975:    pub fn on_set_value(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6471:quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1043:    pub fn on_clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6564:quantbook-engine/crates/ql-exec/src/env.rs:312:    fn formula_text_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<String> {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6730:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:11://!   validate name + chunk_rows, emit `Op::AddSheet`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6734:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:64:    /// emitting `Op::AddSheet` into the attached op log (if any). Returns
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6735:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:80:        // so a bad value can't leave a phantom AddSheet in the log followed
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6736:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:97:        // can't leave a phantom `AddSheet` entry followed by a failed
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6737:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:104:            oplog.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6748:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:368:        // name doesn't leave a phantom AddSheet in the log.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6749:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:381:            "no Op::AddSheet for rejected name; got {ops:?}"
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6750:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:388:    /// inside the column store — and the op log has a phantom AddSheet
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6863:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1767:    /// OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6864:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1788:            Op::AddSheet { name, chunk_rows } => {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6865:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1792:            other => panic!("expected AddSheet, got {other:?}"),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6881:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1911:    /// (PutValue, PutFormula, ClearFormula, SetName, AddSheet, BatchCommit).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:6883:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1927:            // AddSheet.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7332:quantbook-engine/crates/ql-storage/src/workbook.rs:914:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7333:quantbook-engine/crates/ql-storage/src/workbook.rs:920:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7398:quantbook-engine/crates/ql-storage/src/workbook.rs:299:    formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7435:quantbook-engine/crates/ql-storage/src/workbook.rs:914:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7438:quantbook-engine/crates/ql-storage/src/workbook.rs:920:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7444:quantbook-engine/crates/ql-storage/src/workbook.rs:931:    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7578:        Op::AddSheet { name, chunk_rows } => {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7586:            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7591:            // `Op::AddSheet { name: "S", ... }`; merged log has both.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7593:            // Pre-D-2 we rejected the second op (worse UX than Google
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7594:            // Sheets, which auto-renames to S(2)). Now we walk
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7916:    pub fn clear_spill_if_present(&mut self, anchor: (SheetId, RowId, ColId)) -> bool {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7922:    /// - **Missing sheet** (sheet id ≥ `sheet_count()`) → `Value::Error(Ref)`
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7967:    pub fn put_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7981:    pub fn put_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId, value: Value) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7994:    pub fn clear_computed_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8004:    pub fn clear_user_at(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8029:        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8065:    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8071:    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8082:    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8393:    16	//! | `AddSheet`         | `Workbook::add_sheet_with_chunk_rows`            |
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8414:    37	use ql_types::{ColId, RowId, SheetId};
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8423:    46	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8433:    56	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8442:    65	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8465:    88	        scope: Option<SheetId>,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8474:    97	    AddSheet { name: String, chunk_rows: u32 },
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8486:   109	        id: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8518:   141	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8549:   172	        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8842:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1911:    /// (PutValue, PutFormula, ClearFormula, SetName, AddSheet, BatchCommit).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9116:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:104:            oplog.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9644:        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9804:        sheet: SheetId,
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9972:            .append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9989:        base.append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:10007:            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:10046:            .append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:10219:        s.append_op(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14689:    31	/// Build a base op log carrying just `AddSheet("S")`. Both peers
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14693:    35	    log.append(Op::AddSheet {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:14749:    91	        "merged log must contain at least AddSheet + PutFormula + PutValue"

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1880,1925p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"rename_sheet_case_only|case-only|SHEET1|RenameSheet\" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-exec -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1880	        let reg = default_registry();
  1881	        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
  1882	        assert!(
  1883	            matches!(err, ReplayError::NameRejected { .. }),
  1884	            "expected NameRejected, got {err:?}"
  1885	        );
  1886	    }
  1887	
  1888	    // ===== W5-93 (Phase 4.6.E closure) Op::AddSheet name validation =====
  1889	
  1890	    #[test]
  1891	    fn replay_add_sheet_canonical_duplicate_auto_renames() {
  1892	        // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename replaces
  1893	        // the pre-D-2 behavior of rejecting duplicate-canonical names
  1894	        // at replay. Phase 5 collaboration scenario: peer A and peer B
  1895	        // both call `add_sheet("Sheet1")` locally with no collision
  1896	        // visible at producer time; both append the op; merged log
  1897	        // has both. Per the Google Sheets / Excel Online pattern, the
  1898	        // second auto-renames to `Sheet1(2)` rather than rejecting.
  1899	        //
  1900	        // Pre-D-2 this test was `replay_add_sheet_canonical_duplicate_rejected`
  1901	        // asserting `ReplayError::SheetNameRejected`. The D-2 spec
  1902	        // (5.1 audit Opus H-3) inverted that expectation.
  1903	        let mut log = OpLog::new();
  1904	        log.append(Op::AddSheet {
  1905	            name: "Sheet1".to_owned(),
  1906	            chunk_rows: 16,
  1907	        })
  1908	        .unwrap();
  1909	        log.append(Op::AddSheet {
  1910	            name: "SHEET1".to_owned(),
  1911	            chunk_rows: 16,
  1912	        })
  1913	        .unwrap();
  1914	
  1915	        let mut wb = Workbook::new();
  1916	        let reg = default_registry();
  1917	        replay_into(&log, &mut wb, &reg).expect("auto-rename succeeds");
  1918	        assert_eq!(wb.sheet_count(), 2);
  1919	        // First sheet keeps its name.
  1920	        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
  1921	        // Second sheet auto-renamed (original was "SHEET1" which is
  1922	        // a canonical-duplicate of "Sheet1"; suffix starts at (2)).
  1923	        assert_eq!(wb.sheet(1).unwrap().name(), "SHEET1(2)");
  1924	    }
  1925	

 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:134:    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
quantbook-engine/crates/ql-oplog/src/replay.rs:492:        Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:514:            //          concurrently issues `RenameSheet { old: "S1",
quantbook-engine/crates/ql-oplog/src/replay.rs:1615:    // ===== W5-91 (Phase 4.6.C) Op::RenameSheet replay =====
quantbook-engine/crates/ql-oplog/src/replay.rs:1619:        // AddSheet + RenameSheet replays into a sheet with the new name.
quantbook-engine/crates/ql-oplog/src/replay.rs:1626:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1644:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1678:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1699:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1727:        log.append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1770:                Op::RenameSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1910:            name: "SHEET1".to_owned(),
quantbook-engine/crates/ql-oplog/src/replay.rs:1921:        // Second sheet auto-renamed (original was "SHEET1" which is
quantbook-engine/crates/ql-oplog/src/replay.rs:1923:        assert_eq!(wb.sheet(1).unwrap().name(), "SHEET1(2)");
quantbook-engine/crates/ql-oplog/src/op.rs:108:    RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:1://! Phase 5.3 step 2 — concurrent RenameSheet replay convergence.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:3://! Pre-step-2: replay's RenameSheet handler at `replay.rs:486-532`
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:7://! E.g., peer A: `RenameSheet { id, old: "S", new: "S2" }`; peer B
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:8://! concurrently issues `RenameSheet { id, old: "S", new: "S3" }`.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:78:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:86:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:99:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:107:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:148:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:156:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:180:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:192:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:221:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:276:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:284:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:292:        .append(Op::RenameSheet {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:182:            Op::RenameSheet {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:15://!   `PutFormula` rewrite + the `RenameSheet` op.
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:128:    /// `Op::RenameSheet` op atomically (single `BatchCommit`), applies
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:161:        // unchanged (case-only rename is allowed); `Workbook::rename_sheet`
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:185:        //   [PutFormula(cell, new_text)] × N  +  RenameSheet
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:196:            ops.push(Op::RenameSheet {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:319:    fn rename_sheet_case_only_rename_runtime() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:326:        rt.rename_sheet(s1, "SHEET1").unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:329:        assert_eq!(wb.sheet(s1).unwrap().name(), "SHEET1");
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:349:        let err = rt.add_sheet("SHEET1", 16).unwrap_err();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:27://! - Row 7: RenameSheet × concurrent edit on sheet — **pinned here as
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:500:// ===== Row 7: RenameSheet × concurrent edit on sheet (PRE-FIX) =====
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:519:/// `RenameSheet` handler currently HARD-FAILS on concurrent
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:520:/// `RenameSheet × RenameSheet` (case 3 at `replay.rs:524-531`).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:521:/// This test exercises the safer scenario `RenameSheet × PutFormula`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:544:        Op::RenameSheet {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:584:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/crdt-data-model.md | sed -n '540,565p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   540	## Audit checkpoint (gating 5.2)
   541	
   542	This design doc requires a parallel Codex + separate-Opus audit
   543	BEFORE any 5.2 code lands. Per the engine audit-discipline rule
   544	(`memory/quantbook_engine_audit_discipline.md`), the audit
   545	should:
   546	
   547	1. Independently re-derive the Option A vs B vs C tradeoff and
   548	   confirm or challenge the recommendation.
   549	2. Test the cycle-detection / spill-invariant / drop-table-rebind
   550	   claims against the actual Phase 4 code.
   551	3. Survey alternative CRDT data-model designs (Yjs, Automerge,
   552	   Diamond Types) and flag any patterns this doc misses.
   553	4. Probe the LWW conflict semantics for cases that produce
   554	   user-visible bugs (e.g., concurrent AddSheet "S" + edit on
   555	   sheet 0 by someone who hasn't seen the AddSheet yet).
   556	
   557	Audit transcripts will land at:
   558	- `docs/audits/2026-05-19-phase-5-1-codex.md`
   559	- `docs/audits/2026-05-19-phase-5-1-opus.md`
   560	- `docs/audits/2026-05-19-phase-5-1-consolidated.md`
   561	
   562	No 5.2 commits land until the consolidated audit doc is signed
   563	off.
   564	
   565	## Post-audit decisions (2026-05-19)

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 2A.3.a integration test — producer-replay equivalence.
     2	//!
     3	//! The load-bearing invariant for the op log: any sequence of state
     4	//! mutations that we'd record as a sequence of `Op` values, when replayed
     5	//! against a fresh `Workbook`, produces the same observable workbook
     6	//! state as the producer side achieved by direct mutation.
     7	//!
     8	//! This test mocks the producer side (we don't have `WorkbookRuntime`
     9	//! integration yet — that's 2A.3.b). Instead, the test:
    10	//!
    11	//! 1. Builds a sequence of `Op` values matching a realistic IDE session
    12	//!    (paste block + named-range + multi-sheet).
    13	//! 2. Replays them against a fresh workbook (state A).
    14	//! 3. Manually applies the equivalent state mutations to a SECOND fresh
    15	//!    workbook (state B), using the same `Workbook` APIs that replay uses
    16	//!    internally.
    17	//! 4. Asserts the two workbooks are observationally equal on every cell +
    18	//!    formula + name that either touches.
    19	//!
    20	//! Future commits (2A.3.b) will replace step 3 with real producer-side
    21	//! op recording from `WorkbookRuntime` / `WorkbookTransaction`. The test
    22	//! shape stays the same; the producer just becomes "real" instead of
    23	//! "synthetic by hand."
    24	
    25	use ql_functions::default_registry;
    26	use ql_oplog::{replay_into, CellWireValue, NamedTargetWire, Op, OpLog};
    27	use ql_storage::{NamedTarget, Workbook};
    28	use ql_types::{Address, Value};
    29	
    30	/// Build a realistic op sequence: paste 5x5 block of literals, add a
    31	/// formula referencing one of them, register a named constant, add a
    32	/// second sheet, write a value on it.
    33	fn realistic_op_sequence() -> Vec<Op> {
    34	    let mut ops = Vec::new();
    35	    // 5x5 paste block on sheet 0.
    36	    for r in 0..5u32 {
    37	        for c in 0..5u32 {
    38	            ops.push(Op::PutValue {
    39	                sheet: 0,
    40	                row: r,
    41	                col: c,
    42	                value: CellWireValue::Number((r * 10 + c) as f64),
    43	            });
    44	        }
    45	    }
    46	    // Formula at (5, 0).
    47	    ops.push(Op::PutFormula {
    48	        sheet: 0,
    49	        row: 5,
    50	        col: 0,
    51	        text: "A1 + B2 + C3".to_owned(),
    52	    });
    53	    // Named constant.
    54	    ops.push(Op::SetName {
    55	        scope: None,
    56	        name: "TaxRate".to_owned(),
    57	        target: NamedTargetWire::Constant {
    58	            value: CellWireValue::Number(0.21),
    59	        },
    60	    });
    61	    // Second sheet.
    62	    ops.push(Op::AddSheet {
    63	        name: "Inventory".to_owned(),
    64	        chunk_rows: 16384,
    65	    });
    66	    // Value on sheet 1.
    67	    ops.push(Op::PutValue {
    68	        sheet: 1,
    69	        row: 0,
    70	        col: 0,
    71	        value: CellWireValue::Text("widget".to_owned()),
    72	    });
    73	    // **W5-84 closure (Sonnet MEDIUM D.3):** include format ops in the
    74	    // realistic sequence so the equivalence comparator exercises the
    75	    // FormatTable + CellFormatOverlay paths.
    76	    //
    77	    // Register a custom format id. Step 4: Op carries FormatIdWire.
    78	    // legacy_from_u32(164) = Custom { peer: LEGACY_PEER, counter: 0 } —
    79	    // matches the pre-5.2 semantics of "first custom" id 164.
    80	    ops.push(Op::RegisterFormat {
    81	        id: ql_oplog::FormatIdWire::from_u32_legacy(164),
    82	        string: "\"€\" #,##0.00".to_owned(),
    83	    });
    84	    // Bind a cell on sheet 0 to a built-in id 14 (m/d/yyyy) — no
    85	    // RegisterFormat needed; the built-in is pre-seeded by
    86	    // `FormatTable::default()`.
    87	    ops.push(Op::SetCellFormat {
    88	        sheet: 0,
    89	        row: 0,
    90	        col: 0,
    91	        id: Some(ql_oplog::FormatIdWire::Builtin { id: 14 }),
    92	    });
    93	    // Bind another cell to the custom id.
    94	    ops.push(Op::SetCellFormat {
    95	        sheet: 0,
    96	        row: 1,
    97	        col: 0,
    98	        id: Some(ql_oplog::FormatIdWire::from_u32_legacy(164)),
    99	    });
   100	    // And clear a binding (Op::SetCellFormat with None on a previously-
   101	    // bound cell). Tests the clear path.
   102	    ops.push(Op::SetCellFormat {
   103	        sheet: 0,
   104	        row: 0,
   105	        col: 0,
   106	        id: None,
   107	    });
   108	    // **W5-93 (Phase 4.6.E closure):** sheet-scoped name on sheet 0.
   109	    // Codex MEDIUM-3 + Sonnet M.2: the pre-W5-93 realistic sequence
   110	    // only exercised `scope: None`, so a missing or wrong scope branch
   111	    // in replay would have passed the equivalence test silently.
   112	    ops.push(Op::SetName {
   113	        scope: Some(0),
   114	        name: "ScopedRate".to_owned(),
   115	        target: NamedTargetWire::Constant {
   116	            value: CellWireValue::Number(0.42),
   117	        },
   118	    });
   119	    // And on sheet 1 (Inventory).
   120	    ops.push(Op::SetName {
   121	        scope: Some(1),
   122	        name: "WarehouseBin".to_owned(),
   123	        target: NamedTargetWire::Cell {
   124	            sheet: 1,
   125	            row: 0,
   126	            col: 0,
   127	        },
   128	    });
   129	    ops
   130	}
   131	
   132	/// Mocks the producer side by applying ops directly to a workbook via the
   133	/// same APIs that replay uses internally. In 2A.3.b this becomes the
   134	/// real `WorkbookRuntime` + `WorkbookTransaction` calls; the public
   135	/// invariant is unchanged.
   136	fn apply_producer_side(ops: &[Op], wb: &mut Workbook) {
   137	    for op in ops {
   138	        match op {
   139	            Op::PutValue {
   140	                sheet,
   141	                row,
   142	                col,
   143	                value,
   144	            } => {
   145	                let v = value.to_value().unwrap();
   146	                wb.put_at(*sheet, *row, *col, v);
   147	            }
   148	            Op::PutFormula {
   149	                sheet,
   150	                row,
   151	                col,
   152	                text,
   153	            } => {
   154	                wb.put_formula(*sheet, *row, *col, text.as_str());
   155	            }
   156	            Op::ClearFormula { sheet, row, col } => {
   157	                wb.clear_formula(*sheet, *row, *col);
   158	            }
   159	            Op::SetName {
   160	                scope,
   161	                name,
   162	                target,
   163	            } => {
   164	                let t = target.to_target(name).unwrap();
   165	                match scope {
   166	                    None => {
   167	                        wb.set_name(name, t).unwrap();
   168	                    }
   169	                    Some(sheet) => {
   170	                        // W5-92 (Phase 4.6.D): sheet-scoped name; producer
   171	                        // mirrors replay by routing through Sheet::set_scoped_name.
   172	                        wb.sheet_mut(*sheet)
   173	                            .expect("producer-side sheet lookup must succeed")
   174	                            .set_scoped_name(name, t)
   175	                            .expect("producer-side set_scoped_name must succeed");
   176	                    }
   177	                }
   178	            }
   179	            Op::AddSheet { name, chunk_rows } => {
   180	                wb.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
   181	            }
   182	            Op::RenameSheet {
   183	                id,
   184	                old_name: _,
   185	                new_name,
   186	            } => {
   187	                // W5-91: producer side calls `Workbook::rename_sheet`
   188	                // directly here (the formula-text rewrite happens at the
   189	                // `WorkbookRuntime` layer, above the op-log boundary).
   190	                wb.rename_sheet(*id, new_name.clone())
   191	                    .expect("producer-side rename_sheet must succeed");
   192	            }
   193	            Op::RegisterFormat { id, string } => {
   194	                // Step 4: Op carries FormatIdWire directly. Convert
   195	                // to storage via `to_storage()`. Mirrors ql_oplog::replay.
   196	                wb.formats_mut()
   197	                    .register_at(id.to_storage(), string.as_str())
   198	                    .expect("producer-side register_at must succeed");
   199	            }
   200	            Op::SetCellFormat {
   201	                sheet,
   202	                row,
   203	                col,
   204	                id,
   205	            } => {
   206	                let s = wb.sheet_mut(*sheet).expect("sheet exists");
   207	                match id {
   208	                    Some(wire_id) => {
   209	                        s.format_overlay_mut().set(*row, *col, wire_id.to_storage());
   210	                    }
   211	                    None => {
   212	                        s.format_overlay_mut().clear(*row, *col);
   213	                    }
   214	                }
   215	            }
   216	            Op::BatchCommit { ops } => {
   217	                apply_producer_side(ops, wb);
   218	            }
   219	            // **W5-118 (Phase 4.8.H), W5-119 (Phase 4.8.I), W5-121
   220	            // (Phase 4.8.I.2), W5-122 (Phase 4.8.J):** producer-side
   221	            // equivalence for table ops would require mirroring the
   222	            // WorkbookRuntime validation here. Not exercised by
   223	            // `realistic_op_sequence` today; assert unreachable so a
   224	            // future addition forces a test author to mirror the
   225	            // producer logic.
   226	            Op::CreateTable { .. }
   227	            | Op::DropTable { .. }
   228	            | Op::RenameTable { .. }
   229	            | Op::RenameColumn { .. }
   230	            | Op::ResizeTable { .. } => {
   231	                unreachable!(
   232	                    "realistic_op_sequence doesn't emit table ops yet; \
   233	                     update apply_producer_side when adding table coverage"
   234	                )
   235	            }
   236	            // **W5-146 (Phase 4.9.J):** workbook-scope reference mode /
   237	            // locale. Pure metadata; mirror replay by calling the
   238	            // matching `Workbook` setter directly.
   239	            Op::SetReferenceMode { mode } => {
   240	                // **W5-151 (4.9.O MEDIUM-2):** `to_runtime` is now
   241	                // fallible (mirroring LocaleWire); `realistic_op_sequence`
   242	                // never emits Unknown.
   243	                wb.set_reference_mode(
   244	                    mode.clone()
   245	                        .to_runtime()
   246	                        .expect("realistic_op_sequence never emits unknown reference modes"),
   247	                );
   248	            }
   249	            Op::SetLocale { locale } => {
   250	                wb.set_locale(
   251	                    locale
   252	                        .clone()
   253	                        .to_runtime()
   254	                        .expect("realistic_op_sequence never emits unknown locales"),
   255	                );
   256	            }
   257	            _ => unreachable!(
   258	                "Op gained a variant — extend apply_producer_side when adding op coverage"
   259	            ),
   260	        }

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '260,380p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   260	        }
   261	    }
   262	}
   263	
   264	/// Observational equality: compare two workbooks by cell-by-cell read,
   265	/// formula text, sheet count, sheet names, and NameTable contents.
   266	fn assert_workbooks_observationally_equal(a: &Workbook, b: &Workbook) {
   267	    assert_eq!(a.sheet_count(), b.sheet_count(), "sheet counts differ");
   268	    for sheet_id in 0..(a.sheet_count() as u16) {
   269	        let sa = a.sheet(sheet_id).expect("sheet exists in a");
   270	        let sb = b.sheet(sheet_id).expect("sheet exists in b");
   271	        assert_eq!(sa.name(), sb.name(), "sheet {sheet_id} name differs");
   272	        // Compare bounds + every cell within them. Outside-bounds cells
   273	        // are uniformly Blank, so bound-equality + within-bounds-equality
   274	        // suffices.
   275	        let bounds_a = sa.bounds();
   276	        let bounds_b = sb.bounds();
   277	        let row_extent = bounds_a.row_extent.max(bounds_b.row_extent);
   278	        let col_extent = bounds_a.col_extent.max(bounds_b.col_extent);
   279	        for row in 0..row_extent {
   280	            for col in 0..col_extent {
   281	                let va = sa.read(row, col);
   282	                let vb = sb.read(row, col);
   283	                assert_eq!(
   284	                    va, vb,
   285	                    "cell (sheet={sheet_id}, row={row}, col={col}) value differs: {va:?} vs {vb:?}"
   286	                );
   287	                let fa = a
   288	                    .formula_at(sheet_id, row, col)
   289	                    .map(|s| s.as_ref().to_owned());
   290	                let fb = b
   291	                    .formula_at(sheet_id, row, col)
   292	                    .map(|s| s.as_ref().to_owned());
   293	                assert_eq!(
   294	                    fa, fb,
   295	                    "cell (sheet={sheet_id}, row={row}, col={col}) formula differs: {fa:?} vs {fb:?}"
   296	                );
   297	            }
   298	        }
   299	    }
   300	    // NameTable: compare lengths and per-name lookups.
   301	    let names_a = a.names();
   302	    let names_b = b.names();
   303	    assert_eq!(names_a.len(), names_b.len(), "name table lengths differ");
   304	    for (name, _) in names_a.iter() {
   305	        let target_a = names_a.lookup_ci(name).expect("present in a");
   306	        let target_b = names_b
   307	            .lookup_ci(name)
   308	            .unwrap_or_else(|| panic!("name {name:?} present in a but not in b"));
   309	        assert_eq!(target_a, target_b, "name {name:?} target differs");
   310	    }
   311	
   312	    // **W5-84 closure (Sonnet MEDIUM D.3):** FormatTable + per-sheet
   313	    // CellFormatOverlay must also be compared so a producer/replay
   314	    // divergence in format ops surfaces here (rather than letting a
   315	    // bug in `RegisterFormat` / `SetCellFormat` ordering or id-
   316	    // prediction slip through with matching cell values but mismatched
   317	    // formats).
   318	    // Step 3: HashMap keyed by FormatId (enum) rather than u32 — the
   319	    // FormatId enum derives Hash + Eq, so this works directly without
   320	    // any to_legacy_u32 hop.
   321	    let formats_a: std::collections::HashMap<ql_storage::FormatId, String> = a
   322	        .formats()
   323	        .iter()
   324	        .map(|(id, s)| (id, s.to_owned()))
   325	        .collect();
   326	    let formats_b: std::collections::HashMap<ql_storage::FormatId, String> = b
   327	        .formats()
   328	        .iter()
   329	        .map(|(id, s)| (id, s.to_owned()))
   330	        .collect();
   331	    assert_eq!(
   332	        formats_a, formats_b,
   333	        "FormatTable contents differ between producer and replay"
   334	    );
   335	    for sheet_id in 0..(a.sheet_count() as u16) {
   336	        let overlay_a: std::collections::HashMap<(u32, u32), ql_storage::FormatId> =
   337	            a.sheet(sheet_id).unwrap().format_overlay().iter().collect();
   338	        let overlay_b: std::collections::HashMap<(u32, u32), ql_storage::FormatId> =
   339	            b.sheet(sheet_id).unwrap().format_overlay().iter().collect();
   340	        assert_eq!(
   341	            overlay_a, overlay_b,
   342	            "CellFormatOverlay differs on sheet {sheet_id}"
   343	        );
   344	
   345	        // **W5-93 (Phase 4.6.E closure):** per-sheet `scoped_names`
   346	        // also has to be compared so a producer/replay divergence
   347	        // in `Op::SetName { scope: Some(_), .. }` ordering or
   348	        // routing surfaces here. Codex MEDIUM-3 + Sonnet M.3: the
   349	        // pre-W5-93 comparator skipped scoped_names entirely, so a
   350	        // missed routing branch in replay would have passed silently.
   351	        let scoped_a = a.sheet(sheet_id).unwrap().scoped_names();
   352	        let scoped_b = b.sheet(sheet_id).unwrap().scoped_names();
   353	        assert_eq!(
   354	            scoped_a.len(),
   355	            scoped_b.len(),
   356	            "sheet {sheet_id} scoped_names lengths differ"
   357	        );
   358	        for (name, _) in scoped_a.iter() {
   359	            let target_a = scoped_a.lookup_ci(name).expect("present in a");
   360	            let target_b = scoped_b.lookup_ci(name).unwrap_or_else(|| {
   361	                panic!("scoped name {name:?} present on sheet {sheet_id} in a but not in b")
   362	            });
   363	            assert_eq!(
   364	                target_a, target_b,
   365	                "scoped name {name:?} on sheet {sheet_id} target differs"
   366	            );
   367	        }
   368	    }
   369	}
   370	
   371	#[test]
   372	fn producer_and_replay_produce_observationally_equivalent_workbooks() {
   373	    let ops = realistic_op_sequence();
   374	
   375	    // Producer side: direct mutations.
   376	    let mut producer_wb = Workbook::new();
   377	    producer_wb.add_sheet("S"); // sheet 0 pre-exists (matches the test setup).
   378	    apply_producer_side(&ops, &mut producer_wb);
   379	
   380	    // Replay side: build an OpLog, replay against an empty workbook with

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '380,455p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   380	    // Replay side: build an OpLog, replay against an empty workbook with
   381	    // the same pre-existing sheet 0.
   382	    let mut log = OpLog::new();
   383	    for op in &ops {
   384	        log.append(op.clone()).unwrap();
   385	    }
   386	    let mut replay_wb = Workbook::new();
   387	    replay_wb.add_sheet("S");
   388	    let reg = default_registry();
   389	    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
   390	    assert_eq!(count, ops.len());
   391	
   392	    // Observational equality.
   393	    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
   394	
   395	    // Sanity-spot-check some cells / names by hand.
   396	    assert_eq!(
   397	        replay_wb.read(Address::new(0, 2, 2)),
   398	        Value::Number(22.0),
   399	        "spot-check: (2,2) in the 5x5 paste block"
   400	    );
   401	    assert_eq!(
   402	        replay_wb.formula_at(0, 5, 0).map(|s| s.as_ref()),
   403	        Some("A1 + B2 + C3"),
   404	        "spot-check: formula at (5, 0) survived round-trip"
   405	    );
   406	    assert!(matches!(
   407	        replay_wb.names().lookup_ci("TaxRate"),
   408	        Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
   409	    ));
   410	    assert_eq!(replay_wb.sheet_count(), 2);
   411	    assert_eq!(
   412	        replay_wb.read(Address::new(1, 0, 0)),
   413	        Value::text("widget"),
   414	        "spot-check: text value on second sheet"
   415	    );
   416	}
   417	
   418	#[test]
   419	fn binary_export_then_replay_equivalent_to_in_memory_replay() {
   420	    // Verifies that going through the binary persistence layer doesn't
   421	    // change replay results.
   422	    let ops = realistic_op_sequence();
   423	
   424	    let mut log = OpLog::new();
   425	    for op in &ops {
   426	        log.append(op.clone()).unwrap();
   427	    }
   428	
   429	    // In-memory replay → workbook A.
   430	    let mut wb_in_memory = Workbook::new();
   431	    wb_in_memory.add_sheet("S");
   432	    let reg = default_registry();
   433	    replay_into(&log, &mut wb_in_memory, &reg).unwrap();
   434	
   435	    // Binary round-trip → restored log → replay → workbook B.
   436	    let bytes = log.export_bytes().unwrap();
   437	    let restored = OpLog::import_bytes(&bytes).unwrap();
   438	    let mut wb_via_disk = Workbook::new();
   439	    wb_via_disk.add_sheet("S");
   440	    replay_into(&restored, &mut wb_via_disk, &reg).unwrap();
   441	
   442	    assert_workbooks_observationally_equal(&wb_in_memory, &wb_via_disk);
   443	}
   444	
   445	#[test]
   446	fn batch_commit_replay_equivalent_to_flat_replay() {
   447	    // Two op logs: one with ops flat, the other wrapping the same ops in
   448	    // a single BatchCommit. Both should produce the same workbook state.
   449	    let flat_ops = vec![
   450	        Op::PutValue {
   451	            sheet: 0,
   452	            row: 0,
   453	            col: 0,
   454	            value: CellWireValue::Number(1.0),
   455	        },

codex
VERDICT: FAIL (HIGH + MEDIUM findings)

**Findings**

HIGH: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:540) still hard-fails valid concurrent renames when two different sheets choose the same target name.  
`RenameSheet` now tolerates stale `old_name`, but target collision still propagates `Workbook::rename_sheet` duplicate rejection at [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:561). Scenario: peer A renames sheet 0 `S1 -> S2`, peer B renames sheet 1 `S3 -> S2`; both producer-side ops were valid locally, merged replay rejects the second. This is the same blast radius as the fixed bug: merged log becomes unreplayable. Suggested fix: define policy and test it. The D-2-compatible policy is auto-disambiguate only on `SheetNameError::Duplicate` (`S2(2)`, etc.), while still rejecting empty/reserved names. Add bidirectional merge tests for different source sheets, same target.

MEDIUM: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:550) treats canonical equality as full idempotency, so case-only renames are dropped.  
`WorkbookRuntime::rename_sheet` permits and emits case-only renames (`Sheet1 -> SHEET1`) at [sheets.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:160), and storage applies them at [workbook.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/workbook.rs:484). Replay will no-op because `canonical(current) == canonical(new)`, leaving the old display name. Concurrent `S -> foo` vs `S -> FOO` also converges, but not last-in-causal-order for display text. Suggested fix: no-op only on exact display equality, or call `rename_sheet` when canonical matches but display differs. Add replay and concurrent tests.

MEDIUM: [op.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/op.rs:99) still documents `old_name` as replay-time validation, but [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:560) now makes it advisory.  
The intentional policy answers the CRDT case, but it also silently accepts single-writer malformed logs like `old="Wrong", new="X"` against current `S`, renaming `S -> X`. Replay currently cannot distinguish CRDT-merged vs single-writer from `OpLog::iter()`; it only sees `Op`. Suggested fix: update the public op docs and either bless advisory semantics everywhere or add an explicit strict replay mode / per-op causal metadata later. `let _ = old_name` is redundant because `old_name` is used in the rejection error closure.

LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
Do not remove it in this patch. `#[deprecated(note = "... no longer emitted ...")]` is reasonable; otherwise the docstring is enough. Keeping `old_name` in `SheetRenameRejected` remains useful for diagnostics.

**Direct Answers**

`DropSheet`: verified, no `Op::DropSheet`; only `DropTable`, so RenameSheet × DropSheet is out of scope.

`RenameTable` / `RenameColumn`: yes, same bug shape remains at [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:667) and [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:773). Acceptable only if step 4 is a hard gate before calling Phase 5.3 complete.

`crdt-data-model.md` row 7 is still materially correct: step 2 removes the replay hard-fail, but formula repair is still step 3, so `#NAME?` remains expected. A wording tweak to say “Phase 5.3 step 3” would reduce ambiguity.

The 3-peer test is valid as a convergence smoke test over different import orders, but it does not prove algebraic transitivity. It can stay; it should not be the only evidence.

`producer_replay_equivalence.rs` does not currently emit `RenameSheet` in `realistic_op_sequence`; it only has a match arm for it. Normal non-case renames still work. A case-only rename added there would expose the medium finding above.

**Verification**

Ran:
`cargo test -p ql-oplog --test phase_5_3_step2_rename_concurrent -- --test-threads=1`  
`cargo test -p ql-oplog replay_rename_sheet_duplicate_target_errors -- --test-threads=1`

Worst case: the HIGH remains an unrecoverable merged-log replay failure. The advisory `old_name` relaxation can become silent sheet-name corruption for malformed/snapshot-divergent single-writer logs.
tokens used
229,831
VERDICT: FAIL (HIGH + MEDIUM findings)

**Findings**

HIGH: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:540) still hard-fails valid concurrent renames when two different sheets choose the same target name.  
`RenameSheet` now tolerates stale `old_name`, but target collision still propagates `Workbook::rename_sheet` duplicate rejection at [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:561). Scenario: peer A renames sheet 0 `S1 -> S2`, peer B renames sheet 1 `S3 -> S2`; both producer-side ops were valid locally, merged replay rejects the second. This is the same blast radius as the fixed bug: merged log becomes unreplayable. Suggested fix: define policy and test it. The D-2-compatible policy is auto-disambiguate only on `SheetNameError::Duplicate` (`S2(2)`, etc.), while still rejecting empty/reserved names. Add bidirectional merge tests for different source sheets, same target.

MEDIUM: [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:550) treats canonical equality as full idempotency, so case-only renames are dropped.  
`WorkbookRuntime::rename_sheet` permits and emits case-only renames (`Sheet1 -> SHEET1`) at [sheets.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:160), and storage applies them at [workbook.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/workbook.rs:484). Replay will no-op because `canonical(current) == canonical(new)`, leaving the old display name. Concurrent `S -> foo` vs `S -> FOO` also converges, but not last-in-causal-order for display text. Suggested fix: no-op only on exact display equality, or call `rename_sheet` when canonical matches but display differs. Add replay and concurrent tests.

MEDIUM: [op.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/op.rs:99) still documents `old_name` as replay-time validation, but [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:560) now makes it advisory.  
The intentional policy answers the CRDT case, but it also silently accepts single-writer malformed logs like `old="Wrong", new="X"` against current `S`, renaming `S -> X`. Replay currently cannot distinguish CRDT-merged vs single-writer from `OpLog::iter()`; it only sees `Op`. Suggested fix: update the public op docs and either bless advisory semantics everywhere or add an explicit strict replay mode / per-op causal metadata later. `let _ = old_name` is redundant because `old_name` is used in the rejection error closure.

LOW: `ReplayError::SheetRenameNameMismatch` is okay to keep, but should be actively marked if you want discoverability.  
Do not remove it in this patch. `#[deprecated(note = "... no longer emitted ...")]` is reasonable; otherwise the docstring is enough. Keeping `old_name` in `SheetRenameRejected` remains useful for diagnostics.

**Direct Answers**

`DropSheet`: verified, no `Op::DropSheet`; only `DropTable`, so RenameSheet × DropSheet is out of scope.

`RenameTable` / `RenameColumn`: yes, same bug shape remains at [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:667) and [replay.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:773). Acceptable only if step 4 is a hard gate before calling Phase 5.3 complete.

`crdt-data-model.md` row 7 is still materially correct: step 2 removes the replay hard-fail, but formula repair is still step 3, so `#NAME?` remains expected. A wording tweak to say “Phase 5.3 step 3” would reduce ambiguity.

The 3-peer test is valid as a convergence smoke test over different import orders, but it does not prove algebraic transitivity. It can stay; it should not be the only evidence.

`producer_replay_equivalence.rs` does not currently emit `RenameSheet` in `realistic_op_sequence`; it only has a match arm for it. Normal non-case renames still work. A case-only rename added there would expose the medium finding above.

**Verification**

Ran:
`cargo test -p ql-oplog --test phase_5_3_step2_rename_concurrent -- --test-threads=1`  
`cargo test -p ql-oplog replay_rename_sheet_duplicate_target_errors -- --test-threads=1`

Worst case: the HIGH remains an unrecoverable merged-log replay failure. The advisory `old_name` relaxation can become silent sheet-name corruption for malformed/snapshot-divergent single-writer logs.
