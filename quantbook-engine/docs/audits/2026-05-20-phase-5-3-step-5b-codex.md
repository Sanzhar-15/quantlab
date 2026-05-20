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
session id: 019e46a8-b561-73d2-a3aa-f4ae36077da3
--------
user
# Phase 5.3 step 5b audit — `CollabSession::sync_workbook` wrapper

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: commit `815ecf0589e` (5b ship). Predecessors:
- `524615b7418` (5a batched megaudit closures)
- `18ad97d5725` (5.3 plan doc)
- `6752ca2545c` (step 4 audit closures)
- 12 audit transcripts at `docs/audits/2026-05-20-phase-5-3-step-{1,2,3,4}-{codex,opus,consolidated}.md`
- 3 megaudit transcripts at `docs/audits/2026-05-20-phase-5-3-step-5-{codex,opus-a,opus-b,consolidated}.md`

**Workspace tests at HEAD**: 4343 / 0 with `--test-threads=1` (+5 from 5b). fmt + clippy clean.

## What 5b shipped (production-wiring closure for Opus-A Scenario E HIGH)

Megaudit Opus-A Scenario E HIGH flagged that `repair_sheet_rename_chain` + `repair_table_rename_chain` (shipped in steps 3+4) had ZERO non-test callers. Real users running `CollabSession::merge_bytes` + downstream `replay_into` + `recompute` would STILL see `#NAME?` for concurrent-rename formulas. The 5.3 ship was correct in-principle but not in-practice for any production code path.

5b adds `CollabSession::sync_workbook(&self, &mut Workbook, &FunctionRegistry) -> Result<SyncReport, CollabSessionError>` that atomically chains:
1. `replay_into(self.op_log(), workbook, registry)`
2. `repair_sheet_rename_chain(workbook, self.op_log())`
3. `repair_table_rename_chain(workbook, self.op_log())`

Plus new `SyncReport` type, new `CollabSessionError::Replay` variant, 5 integration tests covering empty-log fast path / single-peer happy path / canonical D-3 closure scenario / table-rename analog / error propagation.

## Code shipped (read these)

- `crates/ql-collab/src/session.rs:52-130` — imports + CollabSessionError variant + SyncReport struct
- `crates/ql-collab/src/session.rs:300-410` (approximate — the `sync_workbook` method body)
- `crates/ql-collab/src/lib.rs:108` — re-exports `SyncReport`
- `crates/ql-collab/tests/sync_workbook.rs` — 5 integration tests (~250 LOC)

## Your lane: ADVERSARIAL CORRECTNESS + API ERGONOMICS

You are the **Codex lane** of a 2-way per-ship audit (the other lane is Opus). Your job is tactical adversarial review of the new public API.

### Required deliverables

1. **API surface correctness**:
   - Is `&self` the right receiver? `sync_workbook` reads the OpLog (via `op_log()`) and mutates the workbook (passed by mut ref). The session itself is unchanged. Verify no hidden mutation of session state.
   - Is `Result<SyncReport, CollabSessionError>` the right error shape? Could the `Replay(ReplayError)` and `OpLog(OpLogError)` variants overlap or shadow each other? Check the `#[from]` conversions.
   - Should the function take `&FunctionRegistry` (as it does) or eat the registry by value? Mirror the `replay_into` signature.
   - Is `SyncReport` ergonomic? Should `ops_replayed` be a `usize` or wrapped in a newtype? Should the report be `#[non_exhaustive]`?

2. **Error-handling soundness**:
   - On `Err(_)` from `replay_into`, the docstring says "workbook is in HALF-MERGED state per replay_into contract." Is this propagated cleanly? Does the wrapper preserve `ReplayError::At { index, .. }` diagnosis info?
   - The repair passes return `Result<_, OpLogError>` — when can THOSE fail? (They re-iterate the OpLog; a corrupted Loro value mid-iteration would surface as `OpLogError`.) If they DO fail, the workbook has already been replayed — what's the partial state contract for THAT?
   - Empty-log fast path: returns `Ok(SyncReport::default())`. Is this correct under "log has only AddSheet" or other ops that aren't renames? (Should return `Ok` with `ops_replayed = N` and `formulas_rewritten = 0`.) Verify the fast-path condition.

3. **Test coverage gaps**:
   - The 5 integration tests cover: empty, single-peer, sheet-rename, table-rename, error. What's missing?
     - 3-peer convergence?
     - BatchCommit-nested rename in the merged log?
     - The chain S→S2→S3 (single-peer chain with concurrent edit)?
     - `sync_workbook` called twice on the same workbook (idempotency — does the second call double-apply ops)?
     - Recompute after sync — does the formula RESOLVE correctly post-repair? (Test pins formula TEXT but not value.)
   - Are any of these load-bearing for production use?

4. **Caller-contract docstring accuracy**:
   - Verify `sync_workbook` docs match `replay_into` docs match `repair.rs` module docs. The "caller-driven D-5.3-1" claim threads through all three; check consistency.
   - "Empty-log fast path": docs say `op_count() == 0`. Is `OpLog::is_empty()` semantically identical? Check the implementation.

5. **Stale references**:
   - Does any other public surface (`CollabSession::merge_bytes`, `op_log`, etc.) need a docstring update to point at `sync_workbook`?
   - The `op_log()` docs were updated to recommend `sync_workbook`. Verify.

6. **Test-time bug from session_with_seed (commit message mentions)**:
   - The commit message describes a bug where each peer called `OpLog::new()` separately, getting random Loro peer-ids on base ops, causing D-2 auto-rename to fire spuriously. Verify the fix (shared `base_bytes`) is correct.
   - Are there OTHER tests in the workspace that have the same anti-pattern? Spot-check the existing collab tests.

### Verdict format

Produce: **VERDICT: PASS / PASS-WITH-FINDINGS / FAIL** + bucketed findings (HIGH / MEDIUM / LOW) + **1-paragraph executive summary at the top**.

For each HIGH, include file:line reference + reproduction + proposed closure.

codex
I’ll treat this as a focused code review of the 5b public wrapper: first I’ll verify the API and contracts in the shipped files, then I’ll trace tests and adjacent callers for stale guidance or repeated setup hazards.
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
/bin/zsh -lc 'git show --stat --oneline --decorate --no-renames 815ecf0589e' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
815ecf0589e (HEAD -> feat/quantbook-engine) Phase 5.3 step 5 sub-cycle 5b — CollabSession::sync_workbook wrapper
 quantbook-engine/crates/ql-collab/src/lib.rs       |   2 +-
 quantbook-engine/crates/ql-collab/src/session.rs   | 118 +++++++-
 .../crates/ql-collab/tests/sync_workbook.rs        | 309 +++++++++++++++++++++
 3 files changed, 426 insertions(+), 3 deletions(-)

exec
/bin/zsh -lc 'pwd && git status --short && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 876ms:
?? .codex-phase-5-3-step-5-audit.out
?? .codex-phase-5-3-step-5-megaudit-prompt.md
?? .codex-phase-5-3-step-5b-audit-prompt.md
?? .codex-phase-5-3-step-5b-audit.out
?? .opus-a-phase-5-3-step-5-prompt.md
?? .opus-b-phase-5-3-step-5-prompt.md
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
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-consolidated.md
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-opus-a.md
?? quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-opus-b.md
feat/quantbook-engine
815ecf0589eae380b901f6f0b867d705e6c5157f

codex
The target commit is HEAD on `feat/quantbook-engine`. I’m going to read the wrapper and repair/replay contracts together so line-level findings are based on the actual public API, not just the new tests.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/lib.rs | sed -n '1,170p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1,460p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold ship):** establishes the
     4	//! module shape per the audit-closed design at
     5	//! `docs/architecture/crdt-data-model.md`. Phase 5.1 locked Option
     6	//! A (preserve op-log shape on top of Loro `LoroList`); this crate
     7	//! is the layer above ql-oplog that orchestrates multi-peer
     8	//! collaboration.
     9	//!
    10	//! ## Module layout
    11	//!
    12	//! - `PeerId` — re-exported from [`ql_types::PeerId`] (Phase 5.2 D-1
    13	//!   step 1.1, 2026-05-19; originally `ql_collab::peer::PeerId` at
    14	//!   5.2.a, briefly relocated to `ql_oplog::PeerId` at step 1, finally
    15	//!   at `ql_types::PeerId` after the step-1 Codex audit caught a
    16	//!   forthcoming Cargo cycle). Stable per-session identifier; wraps
    17	//!   Loro's `u64`.
    18	//! - [`session`] — `CollabSession`: per-peer state holder that
    19	//!   wraps an `OpLog`, manages local appends, and exposes
    20	//!   `merge_bytes` + `export_bytes` for transport integration.
    21	//! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
    22	//!   (test stub) and `LoopbackTransport` (Phase 5.5 V1 ship
    23	//!   2026-05-19 — in-process paired endpoints for 2-peer
    24	//!   round-trip tests). Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05`)
    25	//!   added `CollabSession` typed transport methods
    26	//!   (attach/detach/flush/poll). Phase 5.5 V2 V2 / V3 pending —
    27	//!   auto-flush + version-vector deltas + WebSocket impl.
    28	//! - [`presence`] — per-peer ephemeral cursor + selection state
    29	//!   (Phase 5.6 V1 ship 2026-05-19). `PresenceState` JSON-encoded
    30	//!   into the shared `LoroDoc`'s `"presence"` LoroMap (LWW per key).
    31	//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`.
    32	//!   V1 ship 2026-05-19 (`89c02b9d83e`): 7 undo/redo methods.
    33	//!   V2 V1 (`6138a7203f6` + `e199a5fda5a`): atomic grouping +
    34	//!   merge-interval. V2 V1.1: RAII `start_undo_group_scoped`
    35	//!   returning `UndoGroupGuard`. V2 V2 pending — push/pop
    36	//!   listeners.
    37	//!
    38	//! ## Stability
    39	//!
    40	//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
    41	//! will populate the reserved modules and may shift trait shapes.
    42	//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
    43	//! megaudit per the engine audit-discipline rule.
    44	//!
    45	//! ### Pre-stability API changes (logged)
    46	//!
    47	//! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
    48	//!   return type changed from `Self` to
    49	//!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
    50	//!   fallible (`u64::MAX` is reserved), so the constructor must
    51	//!   propagate the error. Internal-only at the time of the change;
    52	//!   no external callers.
    53	//! - **Phase 5.4 V1 (2026-05-19, `89c02b9d83e` + audit closure):**
    54	//!   `CollabSessionError::Undo(loro::LoroError)` variant added.
    55	//!   Exposes `loro::LoroError` in the public error surface — pre-0.2.0
    56	//!   this couples consumers to the loro crate version; a stable API
    57	//!   would wrap it in a ql-collab-owned error. Will be re-typed
    58	//!   before 0.2.0.
    59	//! - **Phase 5.4 V1 audit closure (2026-05-19):**
    60	//!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
    61	//!   to `&mut self`. Prevents accidental peer-id changes through
    62	//!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
    63	//!   an attached `UndoManager`'s stacks per Loro's internal
    64	//!   subscription behavior (`loro-internal::undo:654-662`).
    65	//! - **Phase 5.2 D-1 step 1 (2026-05-19, `aaa54d32f4d`):** `PeerId`
    66	//!   moved from `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId`.
    67	//!   Brief intermediate placement; superseded same-day by step 1.1.
    68	//! - **Phase 5.2 D-1 step 1.1 (2026-05-19):** Codex audit on step 1
    69	//!   caught (a) PeerId lacked `Serialize`/`Deserialize` (blocks step
    70	//!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
    71	//!   in step 3 would form a Cargo cycle (`ql-oplog -> ql-storage` exists;
    72	//!   making `ql-storage -> ql-oplog` for PeerId would loop). Step 1.1
    73	//!   moved PeerId to `ql_types::PeerId` (the true dependency floor —
    74	//!   `ql-storage`, `ql-oplog`, and `ql-collab` all depend on it),
    75	//!   added `#[serde(transparent)]` derives, and shipped the
    76	//!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
    77	//!   migration. `ql_collab::PeerId` now re-exports `ql_types::PeerId`.
    78	//!
    79	//!   **Back-compat surface:** `use ql_collab::PeerId;` keeps working
    80	//!   unchanged (both step 1 and step 1.1 preserve the re-export).
    81	//!   `use ql_collab::peer::PeerId;` (the old module path) was broken
    82	//!   by step 1 and stays broken — `pub mod peer` is gone. Workspace
    83	//!   grep confirms no such caller existed; external consumers were
    84	//!   already using `ql_collab::PeerId` (the re-export).
    85	
    86	pub mod presence;
    87	// Phase 5.3 step 3 (2026-05-20) — rename-repair pass. Caller-driven
    88	// post-merge cleanup that rewrites formula text referencing pre-rename
    89	// sheet names. See `repair.rs` module docs + `docs/architecture/crdt-data-model.md`
    90	// § "Conflict resolution semantics" rows for the RenameSheet × concurrent
    91	// edit closure that this module ships.
    92	pub mod repair;
    93	pub mod session;
    94	pub mod transport;
    95	pub mod undo;
    96	
    97	// PeerId actually lives in `ql_types` post step 1.1, but ql-collab
    98	// re-exports via `ql_oplog::PeerId` (itself a re-export) to avoid
    99	// adding a new direct `ql-types` Cargo dep on ql-collab. External
   100	// callers using `use ql_collab::PeerId;` resolve identically.
   101	pub use ql_oplog::PeerId;
   102	
   103	pub use presence::{PresenceError, PresenceState};
   104	pub use repair::{
   105	    repair_sheet_rename_chain, repair_table_rename_chain, AmbiguousSkip, RepairReport,
   106	    SheetRewriteSummary, TableAmbiguousSkip, TableRepairReport, TableRewriteSummary,
   107	};
   108	pub use session::{CollabSession, CollabSessionError, SyncReport, UndoGroupGuard};
   109	pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
   110	pub use undo::UndoManager;

 succeeded in 0ms:
     1	//! `CollabSession` — per-peer collaboration state holder.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
     4	//! with peer-id-aware operations + transport plumbing. Subsequent
     5	//! phases populate richer behavior:
     6	//!
     7	//! - ~~**Phase 5.4**~~ ✅ V1 + V2 V1 + V2 V1.1 shipped — V1
     8	//!   `89c02b9d83e`: 7 undo/redo methods. V2 V1 `6138a7203f6` +
     9	//!   `e199a5fda5a`: `start_undo_group` / `end_undo_group` +
    10	//!   `set_undo_merge_interval`. V2 V1.1: `start_undo_group_scoped`
    11	//!   returns RAII `UndoGroupGuard` for panic/Err-safe grouping.
    12	//!   Presence-origin commits auto-excluded.
    13	//! - **Phase 5.5** — transport layer. V1 shipped at
    14	//!   `924750819bc` (LoopbackTransport for in-process 2-peer
    15	//!   tests). V2 V1 shipped at `ffd8f6e5f05` —
    16	//!   `CollabSession::{attach,detach,has}_transport` +
    17	//!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
    18	//!   typed methods; explicit-drive (caller invokes flush + poll
    19	//!   on a tick). V2 V2 / V3 pending — auto-flush + version-
    20	//!   vector deltas + WebSocket impl.
    21	//! - ~~**Phase 5.6**~~ ✅ V1 + V2 shipped — V1 `c677e244704`:
    22	//!   `presence` module + 4 typed methods. V2: `sweep_presence`
    23	//!   (caller-opt-in clean-slate on rejoin; closes V1 known
    24	//!   persistence limitation).
    25	//! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
    26	//!   handle that the IDE attaches to each open workbook.
    27	//!
    28	//! What ships in 5.2.a (5.2.b update 2026-05-19):
    29	//!
    30	//! - `CollabSession::new(peer_id)` — fresh session with an empty
    31	//!   `OpLog` and the peer-id wired through to
    32	//!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
    33	//!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
    34	//!   fallible.
    35	//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
    36	//!   shared base snapshot (used by both peers in the D-4 probe
    37	//!   pattern). The reborn session's peer id is `peer_id`; existing
    38	//!   ops in the imported snapshot retain their original
    39	//!   attribution.
    40	//! - `append_op(&mut self, Op)` — local append; delegates to
    41	//!   `OpLog::append`.
    42	//! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
    43	//!   snapshot via Loro's CRDT merge; delegates to
    44	//!   `OpLog::merge_bytes`.
    45	//! - `export_bytes(&self)` — produce a snapshot for transport.
    46	//! - `op_log(&self)` — read-only view of the underlying log
    47	//!   (for replay against a workbook).
    48	//! - `peer_id(&self)` — the session's stable peer id.
    49	
    50	use thiserror::Error;
    51	
    52	use ql_functions::FunctionRegistry;
    53	use ql_oplog::{replay_into, Op, OpLog, OpLogError, PeerId, ReplayError, PRESENCE_COMMIT_ORIGIN};
    54	use ql_storage::Workbook;
    55	
    56	use crate::presence::{self, PresenceError, PresenceState};
    57	use crate::repair::{
    58	    repair_sheet_rename_chain, repair_table_rename_chain, RepairReport, TableRepairReport,
    59	};
    60	use crate::transport::{Transport, TransportError};
    61	
    62	/// **Phase 5.5 V2 V1 audit closure (2026-05-19):** default cap on
    63	/// the number of blobs `CollabSession::poll_remote` drains per
    64	/// call. Prevents one poll from starving the calling thread when
    65	/// an externally-fed transport produces faster than we merge.
    66	/// Callers wanting a different bound use `poll_remote_with_limit`.
    67	pub const DEFAULT_POLL_REMOTE_LIMIT: usize = 64;
    68	
    69	// Phase 5.5 V2 V1 audit closure: pin the Send contract the
    70	// docstring promises ("callers can move sessions between threads
    71	// with attached transports"). If a future Loro dep bump or field
    72	// addition breaks Send, this stops compiling.
    73	const _ASSERT_COLLAB_SESSION_SEND: fn() = || {
    74	    fn assert_send<T: Send>() {}
    75	    assert_send::<CollabSession>();
    76	};
    77	
    78	/// Errors emitted by `CollabSession` operations.
    79	#[derive(Debug, Error)]
    80	#[non_exhaustive]
    81	pub enum CollabSessionError {
    82	    /// The underlying `OpLog` failed (Loro encode/decode, serde,
    83	    /// etc.). Surfaces the wrapped `OpLogError` for diagnosis.
    84	    #[error("op log error: {0}")]
    85	    OpLog(#[from] OpLogError),
    86	
    87	    /// A presence-layer call failed (serde, peer-key parse,
    88	    /// underlying OpLog).
    89	    #[error("presence error: {0}")]
    90	    Presence(#[from] PresenceError),
    91	
    92	    /// **Phase 5.4 V1:** a Loro `UndoManager` call (`undo` /
    93	    /// `redo`) returned an error. Reachable when the underlying
    94	    /// document is in an invalid state for the requested
    95	    /// operation (e.g. mid-transaction).
    96	    #[error("undo/redo error: {0}")]
    97	    Undo(#[from] loro::LoroError),
    98	
    99	    /// **Phase 5.5 V2 (2026-05-19):** the attached `Transport`
   100	    /// returned an error.
   101	    ///
   102	    /// For `flush_to_transport`: the local `OpLog` is unaffected
   103	    /// (the snapshot export happened first; the failed step was
   104	    /// `Transport::send`). Caller can retry the flush.
   105	    ///
   106	    /// For `poll_remote`: any bytes successfully drained BEFORE
   107	    /// the error were already `merge_bytes`'d into the local
   108	    /// `OpLog` — those merges persist. The error indicates the
   109	    /// transport itself is misbehaving (`Io`) — `Closed` is
   110	    /// handled gracefully by `poll_remote` itself (returns
   111	    /// `Ok(merged)`, see Codex+Opus 5.5 V2 V1 audit closure).
   112	    /// Caller should detach + reattach a new transport instead
   113	    /// of retrying poll.
   114	    #[error("transport error: {0}")]
   115	    Transport(#[from] TransportError),
   116	
   117	    /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
   118	    /// (Opus-A Scenario E HIGH).** `sync_workbook` invoked
   119	    /// `replay_into` on the session's `OpLog` and replay failed at
   120	    /// some op index. Per the `replay_into` caller contract
   121	    /// (Phase 5.3 step 5 megaudit closure — see
   122	    /// `ql_oplog::replay_into` docs), the workbook passed by
   123	    /// mut-ref is now in a HALF-MERGED state and MUST be discarded
   124	    /// by the caller. The session's `OpLog` is unaffected (replay
   125	    /// reads only).
   126	    #[error("replay error: {0}")]
   127	    Replay(#[from] ReplayError),
   128	}
   129	
   130	/// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
   131	/// (Opus-A Scenario E HIGH):** result of
   132	/// [`CollabSession::sync_workbook`]. Combines the replay op count
   133	/// with the two repair reports so callers can log a single
   134	/// diagnostic surface.
   135	#[derive(Debug, Clone, Default)]
   136	pub struct SyncReport {
   137	    /// Total ops applied by `replay_into`. Same as the success
   138	    /// value of `replay_into` itself.
   139	    pub ops_replayed: usize,
   140	    /// Sheet rename-repair pass diagnostics (formulas rewritten,
   141	    /// ambiguous-skipped rules).
   142	    pub sheet_repair: RepairReport,
   143	    /// Table rename-repair pass diagnostics.
   144	    pub table_repair: TableRepairReport,
   145	}
   146	
   147	/// Per-peer collaboration state holder.
   148	///
   149	/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
   150	/// at scaffold time; Phase 5.5 will add the live transport
   151	/// integration via `Transport::send` / `try_recv`.
   152	///
   153	/// The session is the engine-side handle for one peer's view of a
   154	/// shared workbook. Multiple peers each hold their own
   155	/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
   156	/// and call `merge_bytes` to incorporate remote ops. All sessions
   157	/// converge to the same `OpLog` content after exchange (per Loro's
   158	/// CRDT determinism — Phase 5.1 audit Codex V1).
   159	pub struct CollabSession {
   160	    peer_id: PeerId,
   161	    log: OpLog,
   162	    /// Phase 5.4 V1 — peer-local undo/redo.
   163	    ///
   164	    /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
   165	    /// in DECLARATION order, so this drops LAST (after `log`).
   166	    /// That is safe here because `loro::UndoManager` owns its own
   167	    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
   168	    /// borrow from `log`'s doc and won't UAF when `log` drops first.
   169	    undo: loro::UndoManager,
   170	    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
   171	    /// transport. `None` until `attach_transport` is called.
   172	    /// Boxed + `Send` so callers can move sessions between
   173	    /// threads with attached transports.
   174	    ///
   175	    /// V2 V1 scope: caller drives flush + poll explicitly
   176	    /// (no auto-flush on append). V2 V2 / V3 will add
   177	    /// auto-flush + version-vector delta exports.
   178	    transport: Option<Box<dyn Transport + Send>>,
   179	}
   180	
   181	impl CollabSession {
   182	    /// Construct a fresh session with an empty op log.
   183	    ///
   184	    /// Use this when no shared base snapshot exists yet (the first
   185	    /// peer to open a brand-new workbook). The `peer_id` is wired
   186	    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
   187	    /// CRDT merge metadata attributes this session's appends to
   188	    /// `peer_id` (not Loro's default random per-doc id).
   189	    ///
   190	    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
   191	    /// - Two concurrent sessions MUST use distinct peer ids.
   192	    ///   Duplicate ids corrupt the document via conflicting OpIDs.
   193	    /// - Prefer per-process-random peer ids over user-/device-pinned
   194	    ///   ids unless your transport layer enforces single-ownership.
   195	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
   196	    ///   `CollabSessionError::OpLog`.
   197	    /// - **Phase 5.2 D-1 step 4 (Opus step-2 L4 closure):**
   198	    ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
   199	    ///   by the qbook envelope's pre-5.2 u32 → tagged-tuple FormatId
   200	    ///   migration. Active multi-peer sessions MUST use a non-zero
   201	    ///   peer id; **release builds enforce** this here so misuse
   202	    ///   fails loudly in production too.
   203	    ///
   204	    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
   205	    /// 2026-05-20):** the prior `debug_assert_ne!` was a no-op in
   206	    /// `--release` builds. Now uses `assert!` so the guard fires
   207	    /// regardless of build profile. Centralized in `OpLog::set_peer_id`
   208	    /// too (see ql-oplog) for the lower-level construction path.
   209	    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
   210	        assert_ne!(
   211	            peer_id.as_u64(),
   212	            0,
   213	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   214	             Active CollabSession peers MUST use a non-zero PeerId."
   215	        );
   216	        let mut log = OpLog::new();
   217	        log.set_peer_id(peer_id.as_u64())?;
   218	        let undo = make_undo_manager(&log);
   219	        Ok(Self {
   220	            peer_id,
   221	            log,
   222	            undo,
   223	            transport: None,
   224	        })
   225	    }
   226	
   227	    /// Construct a session by importing a shared snapshot. Use this
   228	    /// when joining a session that already has history (the second+
   229	    /// peer to open a collaborative workbook).
   230	    ///
   231	    /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
   232	    /// by an earlier `CollabSession::export_bytes` call (typically
   233	    /// from the workbook owner / first peer). After import, this
   234	    /// session's peer id is set to `peer_id` — distinct from the
   235	    /// peer ids carried by the already-imported ops. Imported ops
   236	    /// retain their original peer-id attribution (Loro semantics);
   237	    /// only this session's future appends carry `peer_id`.
   238	    ///
   239	    /// **Caller pitfalls** (same as `CollabSession::new`):
   240	    /// - The new `peer_id` MUST differ from every peer already
   241	    ///   represented in the imported snapshot AND from every other
   242	    ///   concurrent session — see `OpLog::set_peer_id` for details.
   243	    /// - `PeerId(u64::MAX)` is reserved.
   244	    /// - **Phase 5.2 D-1 step 4 audit Codex MEDIUM-2 closure:**
   245	    ///   `PeerId(0)` is `LEGACY_PEER` — debug-asserted just like
   246	    ///   `CollabSession::new`. Snapshot-join sessions also count as
   247	    ///   active sessions and must use a non-zero peer id.
   248	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
   249	        // Step 8 megaudit closure (Opus-B HIGH-1, 2026-05-20):
   250	        // assert! (release-firing) replaces debug_assert_ne!.
   251	        assert_ne!(
   252	            peer_id.as_u64(),
   253	            0,
   254	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   255	             Snapshot-join CollabSession peers MUST use a non-zero PeerId, same as `new`."
   256	        );
   257	        let mut log = OpLog::import_bytes(bytes)?;
   258	        log.set_peer_id(peer_id.as_u64())?;
   259	        let undo = make_undo_manager(&log);
   260	        Ok(Self {
   261	            peer_id,
   262	            log,
   263	            undo,
   264	            transport: None,
   265	        })
   266	    }
   267	
   268	    /// Stable peer id assigned at session creation.
   269	    pub fn peer_id(&self) -> PeerId {
   270	        self.peer_id
   271	    }
   272	
   273	    /// Append a local op. Delegates to `OpLog::append`. Phase 5.5
   274	    /// will additionally push the appended bytes through the
   275	    /// attached `Transport`; 5.2.a leaves transport integration to
   276	    /// the caller.
   277	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
   278	        self.log.append(op)?;
   279	        Ok(())
   280	    }
   281	
   282	    /// Merge a remote peer's snapshot into this session's log. Loro's
   283	    /// CRDT preserves both peers' concurrent appends in deterministic
   284	    /// causal order (Fugue/origin-based with peer-id tiebreaker per
   285	    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
   286	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
   287	        Ok(self.log.merge_bytes(bytes)?)
   288	    }
   289	
   290	    /// Produce a Loro snapshot blob suitable for **transport to other
   291	    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
   292	    /// OR by `OpLog::merge_bytes` directly).
   293	    ///
   294	    /// **Phase 5.2 D-1 step 7 audit closure (2026-05-20):** these are
   295	    /// RAW Loro snapshot bytes — NOT directly suitable as
   296	    /// `.qbook/oplog.bin` file contents. The post-Tier-D3 file format
   297	    /// requires a Quantlab header (`OPLOG_MAGIC` + version u32) that
   298	    /// this function does NOT add. Use
   299	    /// `ql_io::oplog_persistence::save_workbook_with_oplog` for file
   300	    /// writes; that wrapper prepends the header. Writing raw export
   301	    /// bytes directly to `oplog.bin` would still load (via the
   302	    /// legacy backward-compat path) but bypasses the version header
   303	    /// and defeats forward-compat versioning.
   304	    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
   305	        Ok(self.log.export_bytes()?)
   306	    }
   307	
   308	    /// Borrow the underlying `OpLog` for replay against a `Workbook`.
   309	    ///
   310	    /// **Prefer [`Self::sync_workbook`] over this raw accessor** when
   311	    /// rebuilding a workbook after a `merge_bytes` — `sync_workbook`
   312	    /// atomically pairs `replay_into` with the Phase 5.3 rename-repair
   313	    /// passes (audit-locked D-5.3-1 caller contract). Raw `op_log()`
   314	    /// is kept for snapshot inspection + tests.
   315	    ///
   316	    /// Typical usage (raw):
   317	    /// ```ignore
   318	    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
   319	    /// let mut wb = ql_storage::Workbook::new();
   320	    /// let reg = ql_functions::default_registry();
   321	    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
   322	    /// ```
   323	    ///
   324	    /// Preferred usage for collaboration flows:
   325	    /// ```ignore
   326	    /// let mut session = CollabSession::from_snapshot(peer_id, &bytes)?;
   327	    /// session.merge_bytes(&peer_b_bytes)?;
   328	    /// let mut wb = ql_storage::Workbook::new();
   329	    /// let reg = ql_functions::default_registry();
   330	    /// let report = session.sync_workbook(&mut wb, &reg)?;
   331	    /// // log report.ops_replayed / report.sheet_repair / report.table_repair
   332	    /// ```
   333	    pub fn op_log(&self) -> &OpLog {
   334	        &self.log
   335	    }
   336	
   337	    /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
   338	    /// (Opus-A Scenario E HIGH, audit-locked D-5.3-1):**
   339	    /// atomically rebuild `workbook` from this session's `OpLog`,
   340	    /// running:
   341	    ///
   342	    ///   1. `ql_oplog::replay_into(self.op_log(), workbook, registry)`
   343	    ///   2. `repair_sheet_rename_chain(workbook, self.op_log())`
   344	    ///   3. `repair_table_rename_chain(workbook, self.op_log())`
   345	    ///
   346	    /// in that order. This is the **caller-driven repair contract**
   347	    /// from the Phase 5.3 step 3 audit-locked design decision D-5.3-1:
   348	    /// repair is NOT auto-invoked by `merge_bytes` (callers may want
   349	    /// manual control for batch-merge scenarios), but the production
   350	    /// path through `CollabSession` MUST pair replay + repair to close
   351	    /// the D-3 V1 limitation (concurrent-rename formulas → `#NAME?`).
   352	    /// Pre-step-5b no production caller wired this in — the 5.3 ship
   353	    /// was correct in-principle but not in-practice. This wrapper
   354	    /// closes that gap.
   355	    ///
   356	    /// # Error handling
   357	    ///
   358	    /// On `Err(_)`, the `workbook` may be in a partial state per the
   359	    /// `replay_into` caller contract (Phase 5.3 step 5 megaudit
   360	    /// closure on atomicity — see `ql_oplog::replay_into` docs). The
   361	    /// caller MUST discard the workbook on error rather than reuse
   362	    /// the partial state. The session's `OpLog` is unaffected.
   363	    ///
   364	    /// The function reads `self` immutably (via `self.op_log()`);
   365	    /// repair mutates the workbook only.
   366	    ///
   367	    /// # Empty-log fast path
   368	    ///
   369	    /// When `self.op_count() == 0` the function returns immediately
   370	    /// with `SyncReport::default()` (no replay, no repair work).
   371	    ///
   372	    /// # Caller pitfalls
   373	    ///
   374	    /// - The caller must pass a FRESH `Workbook` (e.g.,
   375	    ///   `Workbook::new()`), not a workbook from a previous replay
   376	    ///   against a different log — `replay_into` applies ops on top
   377	    ///   of whatever state the workbook holds, so reusing a stale
   378	    ///   workbook silently double-applies ops.
   379	    /// - The `registry` parameter is reserved for future replay-side
   380	    ///   recompute integration (today replay persists formula text
   381	    ///   without re-evaluating; callers drive evaluation through
   382	    ///   `recompute_all` after this returns).
   383	    pub fn sync_workbook(
   384	        &self,
   385	        workbook: &mut Workbook,
   386	        registry: &FunctionRegistry,
   387	    ) -> Result<SyncReport, CollabSessionError> {
   388	        if self.log.is_empty() {
   389	            return Ok(SyncReport::default());
   390	        }
   391	        let ops_replayed = replay_into(&self.log, workbook, registry)?;
   392	        let sheet_repair = repair_sheet_rename_chain(workbook, &self.log)?;
   393	        let table_repair = repair_table_rename_chain(workbook, &self.log)?;
   394	        Ok(SyncReport {
   395	            ops_replayed,
   396	            sheet_repair,
   397	            table_repair,
   398	        })
   399	    }
   400	
   401	    /// Current number of ops in the log. Cheap (cached).
   402	    pub fn op_count(&self) -> usize {
   403	        self.log.len()
   404	    }
   405	
   406	    /// True iff the log has no ops (session just opened, no edits yet).
   407	    pub fn is_empty(&self) -> bool {
   408	        self.log.is_empty()
   409	    }
   410	
   411	    /// **Phase 5.5 V2 V1 (2026-05-19):** attach a `Transport`
   412	    /// implementation to this session. Subsequent
   413	    /// [`flush_to_transport`] calls push the session's current
   414	    /// snapshot through it; [`poll_remote`] drains incoming
   415	    /// bytes and merges them.
   416	    ///
   417	    /// Returns `Some(previous)` if a transport was already
   418	    /// attached and got replaced. V2 V1 does NOT auto-flush on
   419	    /// `append_op` — caller drives flush + poll explicitly. V3
   420	    /// will add auto-flush + version-vector delta exports.
   421	    pub fn attach_transport<T: Transport + Send + 'static>(
   422	        &mut self,
   423	        transport: T,
   424	    ) -> Option<Box<dyn Transport + Send>> {
   425	        self.transport.replace(Box::new(transport))
   426	    }
   427	
   428	    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
   429	    /// transport. Returns it for caller cleanup; returns `None`
   430	    /// if no transport was attached.
   431	    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
   432	        self.transport.take()
   433	    }
   434	
   435	    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
   436	    /// currently attached.
   437	    pub fn has_transport(&self) -> bool {
   438	        self.transport.is_some()
   439	    }
   440	
   441	    /// **Phase 5.5 V2 V1 (2026-05-19):** export the current
   442	    /// session snapshot and push it through the attached
   443	    /// transport. No-op (returns `Ok(false)`) if no transport
   444	    /// attached.
   445	    ///
   446	    /// Returns `Ok(true)` if bytes were sent. Errors:
   447	    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
   448	    ///   fails (Loro encode error).
   449	    /// - `CollabSessionError::Transport` if `Transport::send`
   450	    ///   fails (Closed, Io).
   451	    ///
   452	    /// In both error cases the local `OpLog` is unaffected
   453	    /// (export runs first, send is the last step). Caller can
   454	    /// retry the flush after addressing the underlying cause.
   455	    ///
   456	    /// V2 V1 sends the FULL snapshot each call (O(state)). V2 V2
   457	    /// will track per-transport version vectors and send deltas
   458	    /// only.
   459	    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   460	        let Some(transport) = self.transport.as_mut() else {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/sync_workbook.rs | sed -n '1,380p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 5b — `CollabSession::sync_workbook` integration tests.
     2	//! 2026-05-20.
     3	//!
     4	//! Production-wiring closure for Opus-A Scenario E HIGH (step 5
     5	//! megaudit): the repair pass exists since step 3 but had ZERO
     6	//! non-test callers, so end-users running `merge_bytes` +
     7	//! `replay_into` + `recompute` would STILL see `#NAME?` for
     8	//! concurrent-rename formulas. `sync_workbook` atomically pairs
     9	//! `replay_into` with the two repair passes per audit-locked D-5.3-1
    10	//! caller contract.
    11	//!
    12	//! Coverage:
    13	//! - Empty-log fast path → `SyncReport::default()`.
    14	//! - Single-peer happy path: sync_workbook applies replay + reports.
    15	//! - Two-peer concurrent RenameSheet + edit → sheet repair rewrites
    16	//!   formula text (the canonical D-3 V1-limitation closure scenario).
    17	//! - Two-peer concurrent RenameTable + table-ref formula → table
    18	//!   repair rewrites.
    19	//! - Error propagation: cross-source target collision (V1 limitation)
    20	//!   produces `CollabSessionError::Replay`.
    21	
    22	use ql_collab::{CollabSession, CollabSessionError, SyncReport};
    23	use ql_functions::default_registry;
    24	use ql_oplog::{CellWireValue, Op};
    25	use ql_oplog::{OpLog, PeerId};
    26	use ql_storage::Workbook;
    27	use ql_types::Address;
    28	
    29	const PEER_A_ID: u64 = 1;
    30	const PEER_B_ID: u64 = 2;
    31	
    32	/// Produce a SHARED base log's snapshot bytes containing
    33	/// `Op::AddSheet("S")` + a literal at S!A1 = 42.0. Both peers must
    34	/// fork from the SAME bytes — otherwise each peer's base ops carry a
    35	/// different Loro internal peer-id (`OpLog::new` is random by default)
    36	/// and Loro treats the AddSheet ops as concurrent + distinct, firing
    37	/// D-2 auto-rename on merge and breaking the test's assumption that
    38	/// both peers operate on the same sheet 0. This is the per-step-1
    39	/// audit closure pattern: "CRDT convergence requires stable non-zero
    40	/// peer-ids" (`crdt-data-model.md` § Peer-id stability).
    41	fn shared_base_bytes() -> Vec<u8> {
    42	    let mut log = OpLog::new();
    43	    log.append(Op::AddSheet {
    44	        name: "S".to_owned(),
    45	        chunk_rows: 16384,
    46	    })
    47	    .unwrap();
    48	    log.append(Op::PutValue {
    49	        sheet: 0,
    50	        row: 0,
    51	        col: 0,
    52	        value: CellWireValue::Number(42.0),
    53	    })
    54	    .unwrap();
    55	    log.export_bytes().unwrap()
    56	}
    57	
    58	/// Build a fresh session at `peer_id` from the shared base bytes.
    59	fn session_with_seed(peer_id: u64, base_bytes: &[u8]) -> CollabSession {
    60	    CollabSession::from_snapshot(PeerId::new(peer_id), base_bytes).unwrap()
    61	}
    62	
    63	#[test]
    64	fn sync_workbook_empty_log_fast_path_returns_default_report() {
    65	    let session = CollabSession::new(PeerId::new(PEER_A_ID)).unwrap();
    66	    let mut wb = Workbook::new();
    67	    let reg = default_registry();
    68	    let report = session.sync_workbook(&mut wb, &reg).unwrap();
    69	
    70	    // Empty log → no ops replayed, no repairs.
    71	    assert_eq!(report.ops_replayed, 0);
    72	    assert_eq!(report.sheet_repair.formulas_rewritten, 0);
    73	    assert_eq!(report.table_repair.formulas_rewritten, 0);
    74	    // Workbook untouched.
    75	    assert_eq!(wb.sheet_count(), 0);
    76	}
    77	
    78	#[test]
    79	fn sync_workbook_single_peer_applies_replay() {
    80	    let base = shared_base_bytes();
    81	    let session = session_with_seed(PEER_A_ID, &base);
    82	    let mut wb = Workbook::new();
    83	    let reg = default_registry();
    84	    let report = session.sync_workbook(&mut wb, &reg).unwrap();
    85	
    86	    // 2 ops in the seed (AddSheet + PutValue).
    87	    assert_eq!(report.ops_replayed, 2);
    88	    // No rename ops, so both repair passes are no-ops.
    89	    assert_eq!(report.sheet_repair.formulas_rewritten, 0);
    90	    assert!(report.sheet_repair.sheet_rewrites.is_empty());
    91	    assert_eq!(report.table_repair.formulas_rewritten, 0);
    92	    // Workbook reflects replay state.
    93	    assert_eq!(wb.sheet_count(), 1);
    94	    assert_eq!(wb.sheet(0).unwrap().name(), "S");
    95	    assert_eq!(
    96	        wb.read(Address::new(0, 0, 0)),
    97	        ql_types::Value::Number(42.0)
    98	    );
    99	}
   100	
   101	/// **The canonical D-3 V1-limitation closure scenario.** Peer A
   102	/// renames sheet "S" → "S2"; peer B concurrently writes a formula
   103	/// `=S!A1` (referencing the old name). Without `sync_workbook`'s
   104	/// repair invocation, the formula would surface as `#NAME?` after
   105	/// recompute. With `sync_workbook`, the repair pass rewrites the
   106	/// formula text to `=S2!A1` so recompute resolves correctly.
   107	#[test]
   108	fn sync_workbook_concurrent_rename_sheet_plus_edit_repair_fires() {
   109	    // Both peers fork from the same shared base bytes (stable Loro
   110	    // peer-id on the base ops).
   111	    let base = shared_base_bytes();
   112	    let mut session_a = session_with_seed(PEER_A_ID, &base);
   113	    let mut session_b = session_with_seed(PEER_B_ID, &base);
   114	
   115	    // Peer A renames S → S2.
   116	    session_a
   117	        .append_op(Op::RenameSheet {
   118	            id: 0,
   119	            old_name: "S".to_owned(),
   120	            new_name: "S2".to_owned(),
   121	        })
   122	        .unwrap();
   123	
   124	    // Peer B (concurrent) writes a formula referencing the OLD name "S".
   125	    session_b
   126	        .append_op(Op::PutFormula {
   127	            sheet: 0,
   128	            row: 1,
   129	            col: 0,
   130	            text: "S!A1".to_owned(),
   131	        })
   132	        .unwrap();
   133	
   134	    // Merge into peer A's session.
   135	    let b_bytes = session_b.export_bytes().unwrap();
   136	    session_a.merge_bytes(&b_bytes).unwrap();
   137	
   138	    // Rebuild the workbook through the wrapper.
   139	    let mut wb = Workbook::new();
   140	    let reg = default_registry();
   141	    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();
   142	
   143	    // The repair pass fired on exactly the one formula peer B authored
   144	    // against the pre-rename name.
   145	    assert_eq!(
   146	        report.sheet_repair.formulas_rewritten, 1,
   147	        "exactly 1 formula must be rewritten by sheet repair"
   148	    );
   149	    assert!(
   150	        !report.sheet_repair.sheet_rewrites.is_empty(),
   151	        "sheet rewrite summary must be populated"
   152	    );
   153	
   154	    // Sheet is now named S2.
   155	    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
   156	    // Formula text was rewritten to reference the current name.
   157	    let formula = wb.formula_at(0, 1, 0).map(|s| s.to_string());
   158	    assert_eq!(
   159	        formula,
   160	        Some("S2!A1".to_string()),
   161	        "formula text MUST be rewritten by repair pass (production wiring closure: H-S1)"
   162	    );
   163	}
   164	
   165	/// **Table-rename analog of the sheet case.** Peer A creates a table T,
   166	/// renames it T → T2; peer B writes a formula referencing T's old name.
   167	/// Repair must rewrite to T2.
   168	#[test]
   169	fn sync_workbook_concurrent_rename_table_plus_edit_repair_fires() {
   170	    // Base log: sheet S + table T (2x2, 1 col header).
   171	    let mut base_log = OpLog::new();
   172	    base_log
   173	        .append(Op::AddSheet {
   174	            name: "S".to_owned(),
   175	            chunk_rows: 16384,
   176	        })
   177	        .unwrap();
   178	    base_log
   179	        .append(Op::CreateTable {
   180	            name: "T".to_owned(),
   181	            sheet: 0,
   182	            top_row: 0,
   183	            top_col: 0,
   184	            rows: 2,
   185	            cols: 1,
   186	            has_header: true,
   187	            has_totals: false,
   188	            column_names: vec!["A".to_owned()],
   189	        })
   190	        .unwrap();
   191	    let base_bytes = base_log.export_bytes().unwrap();
   192	
   193	    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
   194	    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();
   195	
   196	    // Peer A renames T → T2.
   197	    session_a
   198	        .append_op(Op::RenameTable {
   199	            old_name: "T".to_owned(),
   200	            new_name: "T2".to_owned(),
   201	        })
   202	        .unwrap();
   203	
   204	    // Peer B writes a formula referencing T's old name.
   205	    session_b
   206	        .append_op(Op::PutFormula {
   207	            sheet: 0,
   208	            row: 5,
   209	            col: 5,
   210	            text: "T[A]".to_owned(),
   211	        })
   212	        .unwrap();
   213	
   214	    let b_bytes = session_b.export_bytes().unwrap();
   215	    session_a.merge_bytes(&b_bytes).unwrap();
   216	
   217	    let mut wb = Workbook::new();
   218	    let reg = default_registry();
   219	    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();
   220	
   221	    assert_eq!(
   222	        report.table_repair.formulas_rewritten, 1,
   223	        "exactly 1 formula must be rewritten by table repair"
   224	    );
   225	    // Table renamed; formula rewritten.
   226	    assert!(wb.tables().lookup("T").is_none(), "T no longer present");
   227	    assert!(wb.tables().lookup("T2").is_some(), "T2 present post-rename");
   228	    let formula = wb.formula_at(0, 5, 5).map(|s| s.to_string());
   229	    assert_eq!(
   230	        formula,
   231	        Some("T2[A]".to_string()),
   232	        "table-ref formula text MUST be rewritten by repair pass"
   233	    );
   234	}
   235	
   236	/// **Error propagation:** the V1 cross-source target collision
   237	/// limitation makes `replay_into` hard-fail. `sync_workbook` should
   238	/// surface the error as `CollabSessionError::Replay`.
   239	#[test]
   240	fn sync_workbook_replay_error_surfaces_via_session_error_variant() {
   241	    // Build a log that triggers cross-source target collision:
   242	    // base has 2 tables T1 + T3; one peer renames T1→X, another T3→X.
   243	    let mut base_log = OpLog::new();
   244	    base_log
   245	        .append(Op::AddSheet {
   246	            name: "S".to_owned(),
   247	            chunk_rows: 16384,
   248	        })
   249	        .unwrap();
   250	    base_log
   251	        .append(Op::CreateTable {
   252	            name: "T1".to_owned(),
   253	            sheet: 0,
   254	            top_row: 0,
   255	            top_col: 0,
   256	            rows: 2,
   257	            cols: 1,
   258	            has_header: true,
   259	            has_totals: false,
   260	            column_names: vec!["A".to_owned()],
   261	        })
   262	        .unwrap();
   263	    base_log
   264	        .append(Op::CreateTable {
   265	            name: "T3".to_owned(),
   266	            sheet: 0,
   267	            top_row: 5,
   268	            top_col: 0,
   269	            rows: 2,
   270	            cols: 1,
   271	            has_header: true,
   272	            has_totals: false,
   273	            column_names: vec!["A".to_owned()],
   274	        })
   275	        .unwrap();
   276	    let base_bytes = base_log.export_bytes().unwrap();
   277	
   278	    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
   279	    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();
   280	
   281	    session_a
   282	        .append_op(Op::RenameTable {
   283	            old_name: "T1".to_owned(),
   284	            new_name: "X".to_owned(),
   285	        })
   286	        .unwrap();
   287	    session_b
   288	        .append_op(Op::RenameTable {
   289	            old_name: "T3".to_owned(),
   290	            new_name: "X".to_owned(),
   291	        })
   292	        .unwrap();
   293	
   294	    let b_bytes = session_b.export_bytes().unwrap();
   295	    session_a.merge_bytes(&b_bytes).unwrap();
   296	
   297	    let mut wb = Workbook::new();
   298	    let reg = default_registry();
   299	    let result: Result<SyncReport, CollabSessionError> = session_a.sync_workbook(&mut wb, &reg);
   300	    assert!(
   301	        matches!(result, Err(CollabSessionError::Replay(_))),
   302	        "expected CollabSessionError::Replay; got {result:?}"
   303	    );
   304	    // Per replay_into's caller contract (Phase 5.3 step 5 megaudit
   305	    // closure), the workbook is now in a HALF-MERGED state. The
   306	    // caller MUST discard it. We don't assert anything about wb's
   307	    // state here — that would lock in the partial-state contract by
   308	    // accident.
   309	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/repair.rs | sed -n '1,520p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
    57	//! ## Safety guard: skip rules where `old_canonical` is currently held
    58	//!
    59	//! Step 3 audit closure (Codex HIGH-1 + HIGH-2, 2026-05-20). Two
    60	//! formula-corruption scenarios drove the guard:
    61	//!
    62	//! 1. **Cascade through rewritten names** (Codex HIGH-1): base sheets
    63	//!    `A` and `B`. Peer renames `B → C`, then `A → B`. Final: sheet 0
    64	//!    = B, sheet 1 = C. Pre-guard the rules `{A → B, B → C}` would
    65	//!    apply iteratively: formula `A!A1` → `B!A1` (rule 1) → `C!A1`
    66	//!    (rule 2). **Wrong** — the cell ends up referencing sheet 1
    67	//!    when the formula author meant sheet 0 (now named B).
    68	//!
    69	//! 2. **Historic names live forever** (Codex HIGH-2): sheet S
    70	//!    renamed to T. Later, a NEW sheet S is added (after the rename).
    71	//!    A formula `S!A1` written after the new S is added INTENDS the
    72	//!    new S. Pre-guard the historic rule `S → T` would rewrite the
    73	//!    valid current reference to `T!A1`. **Wrong** — corrupts a
    74	//!    valid formula.
    75	//!
    76	//! Closure: **skip rules where `old_canonical` is currently held by
    77	//! ANY sheet in the workbook**. The `ambiguous_skipped` field of
    78	//! `RepairReport` surfaces these for diagnostics (no silent loss —
    79	//! per the no-fallback rule).
    80	//!
    81	//! ## Known limitations (V1, post-step-5 megaudit closure)
    82	//!
    83	//! - **Cross-sheet historic-name ambiguity** (when neither historic
    84	//!   is currently held): two sheets had the same canonical name at
    85	//!   different chain points, AND neither sheet currently holds that
    86	//!   name. Rules from BOTH sheets end up in the vec. The winner is
    87	//!   determined empirically by **substitution-order consumption**:
    88	//!   rules are iterated in `sheet_ids.sort_unstable()` order (lowest
    89	//!   sheet_id first), the first rule's rewrite of the formula text
    90	//!   removes the historic token, and subsequent rules find nothing to
    91	//!   match. The DOCS previously said "rule-iteration order picks the
    92	//!   winner" — the more accurate framing is "first rewrite consumes
    93	//!   the source token, subsequent rules are no-ops." Step 5 megaudit
    94	//!   Opus-A Scenario D verified the empirical behavior matches sheet_id
    95	//!   ordering. Rare; not closed in V1.
    96	//!
    97	//! - **Concurrent-rename intermediate names** are PRESERVED via the
    98	//!   `old_name` field of each `RenameSheet` op. The chain walker at
    99	//!   [`collect_rename_old_names`] accumulates them per sheet_id, so a
   100	//!   chain S1→S2→S3 (concurrent or sequential) produces
   101	//!   `historic_canonicals = [S1, S2]` for the relevant sheet_id and
   102	//!   formulas referencing either intermediate name are rewritten to S3.
   103	//!   **Step 5 megaudit Opus-A Scenario A empirically validated this**
   104	//!   for the sequential 3-chain case. The earlier docstring warning
   105	//!   about "intermediate names lost under last-wins policy" overstated
   106	//!   the risk; the case where it actually manifests is narrower than
   107	//!   originally framed. Future V2: causality-aware tracking via Loro
   108	//!   op-ids (covers edge cases the chain walker can't see).
   109	//!
   110	//! - **Whitespace canonicalization side effect** (Step 5 megaudit
   111	//!   Opus-A Scenario F): formulas touched by the repair pass route
   112	//!   through `lex → parse → rewrite → print`. The printer normalizes
   113	//!   whitespace, operator spacing, and function-name case — so a
   114	//!   formula `"SUM(  t[a] )    +1"` rewritten through the repair pass
   115	//!   becomes `"SUM(T2[a]) + 1"`. Formulas NOT touched by repair are
   116	//!   not affected (the rewriter returns `None` when no rule applies,
   117	//!   leaving the original text in place). This is consistent with the
   118	//!   producer-side helper at `sheets.rs:42-58`. Future V2: surgical
   119	//!   diff-only rewrite path that uses source spans rather than parse/
   120	//!   print round-trip.
   121	//!
   122	//! - **Table + column renames** (Step 4 ✅ shipped 2026-05-20 for
   123	//!   tables; column repair pass deferred to V2):
   124	//!   `Op::RenameTable` → [`repair_table_rename_chain`] (this module).
   125	//!   `Op::RenameColumn` repair pass is V2 (Step 5 megaudit Opus-A V1
   126	//!   LIM #3 + Opus-B MEDIUM-5; tracked in PHASE-4-V2-BACKLOG.md
   127	//!   Tier H). Until V2, concurrent column renames produce `#NAME?` /
   128	//!   `#REF?` for concurrent formula edits referencing the old column
   129	//!   name.
   130	
   131	use ql_oplog::{Op, OpLog, OpLogError};
   132	use ql_storage::Workbook;
   133	use ql_types::SheetId;
   134	use std::collections::HashMap;
   135	use std::sync::Arc;
   136	
   137	/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
   138	/// logging / diagnostics. Per the no-fallback rule (CLAUDE.md), this
   139	/// surfaces *what was done* rather than silently absorbing the work.
   140	#[derive(Debug, Clone, Default)]
   141	pub struct RepairReport {
   142	    /// Total number of formulas whose text was rewritten by the pass.
   143	    pub formulas_rewritten: usize,
   144	
   145	    /// Per-sheet rewrite summary: the sheet id, its final display name
   146	    /// post-replay, and the historic canonical names whose references
   147	    /// were rewritten. Empty if no sheet had a rename.
   148	    pub sheet_rewrites: Vec<SheetRewriteSummary>,
   149	
   150	    /// **Step 3 audit closure (Codex HIGH-1 + HIGH-2, Opus HIGH-1,
   151	    /// 2026-05-20):** rules that were SKIPPED because their
   152	    /// `old_canonical` is currently held by another (or the same)
   153	    /// sheet — applying the rewrite would corrupt formulas that
   154	    /// legitimately reference the current holder. Surfaced for
   155	    /// diagnostics per the no-fallback rule.
   156	    pub ambiguous_rules_skipped: Vec<AmbiguousSkip>,
   157	}
   158	
   159	/// Per-sheet summary line in [`RepairReport`].
   160	#[derive(Debug, Clone)]
   161	pub struct SheetRewriteSummary {
   162	    pub sheet: SheetId,
   163	    pub current_display_name: String,
   164	    /// Historic canonical names from `Op::RenameSheet.old_name`. Sorted
   165	    /// + deduped. Empty iff the sheet had no rename ops in the log.
   166	    pub historic_canonicals: Vec<String>,
   167	}
   168	
   169	/// **Step 3 audit closure entry**: an ambiguous rule the pass refused
   170	/// to apply because doing so would have corrupted a valid current
   171	/// reference. See the safety guard in the module docs.
   172	#[derive(Debug, Clone)]
   173	pub struct AmbiguousSkip {
   174	    /// Sheet id whose chain produced this rule.
   175	    pub origin_sheet: SheetId,
   176	    /// Historic canonical name (the rule's "old" side).
   177	    pub historic_canonical: String,
   178	    /// Sheet id of the current holder of `historic_canonical`. If equal
   179	    /// to `origin_sheet`, the same sheet was renamed away and then back
   180	    /// to its starting name (no-op, normally pruned earlier but recorded
   181	    /// here for completeness).
   182	    pub current_holder_sheet: SheetId,
   183	}
   184	
   185	/// Walk the op log to build a chain of sheet renames, then rewrite
   186	/// every formula in `workbook` whose text references a historic
   187	/// (pre-rename) sheet name. See module docs for the algorithm.
   188	///
   189	/// Returns a [`RepairReport`] describing what was changed. The report
   190	/// is informational; the workbook is mutated in place.
   191	///
   192	/// **Errors**: only propagates `OpLogError` from iterating the op log
   193	/// (e.g., a corrupted Loro `LoroValue::String` that fails serde
   194	/// decode). Formula rewrites that fail to parse are SKIPPED silently
   195	/// (the helper returns `None` on parse failure, preserving the
   196	/// pre-rewrite text). This matches the producer-side helper's
   197	/// behavior and avoids the no-fallback violation that would fire if
   198	/// we returned an error for unparseable formulas (those formulas
   199	/// would already produce parse errors at recompute time — repair
   200	/// doesn't worsen that).
   201	///
   202	/// **Caller-driven**: NOT auto-invoked by `merge_bytes`. See module
   203	/// docs for the expected call sequence.
   204	pub fn repair_sheet_rename_chain(
   205	    workbook: &mut Workbook,
   206	    log: &OpLog,
   207	) -> Result<RepairReport, OpLogError> {
   208	    // ===== Phase 1: walk op log; collect historic old_names per sheet.
   209	    //
   210	    // **Phase 5.3 step 5 megaudit (Opus-A Probe X HIGH-latent, 2026-05-20):**
   211	    // a debug-mode caller-contract assert was considered here to catch
   212	    // "wrong workbook" misuse (calling repair with a stale workbook
   213	    // produces silent formula corruption). The strict form
   214	    // (`workbook.sheet(id).name() == log's last RenameSheet new_name`)
   215	    // tripped on legitimate D-2-style auto-disambiguation paths from
   216	    // step 2 (where replay legitimately suffixes the target name to
   217	    // `X(2)` to avoid cross-sheet target collision) — false positive.
   218	    // The looser forms either gave false negatives for the Probe X case
   219	    // OR re-implemented replay's policy logic. Closure deferred to the
   220	    // production wiring fix at `CollabSession::sync_workbook`
   221	    // (Phase 5.3 step 5b), which enforces the `replay_into → repair_*`
   222	    // sequence at the API level — caller-contract violations are
   223	    // impossible from the wrapped path.
   224	    let mut historic_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();
   225	    for op_result in log.iter() {
   226	        let op = op_result?;
   227	        collect_rename_old_names(&op, &mut historic_by_sheet);
   228	    }
   229	
   230	    // ===== Phase 2: snapshot current canonical names + their owning
   231	    // sheet ids. Used by the ambiguity guard (step 3 audit closure)
   232	    // to skip rules whose `old_canonical` is currently held by some
   233	    // sheet — applying such a rule would corrupt formulas that
   234	    // legitimately reference the current holder.
   235	    let sheet_count = workbook.sheet_count() as u16;
   236	    let mut canonical_to_current_sheet: HashMap<String, SheetId> = HashMap::new();
   237	    for i in 0..sheet_count {
   238	        if let Some(s) = workbook.sheet(i) {
   239	            canonical_to_current_sheet.insert(Workbook::canonical_sheet_name(s.name()), i);
   240	        }
   241	    }
   242	
   243	    // ===== Phase 3: build (canonical_historic → current_display_name) rules.
   244	    // Skip pairs where canonical historic matches current canonical (no-op)
   245	    // OR where `historic_canonical` is currently held by ANY sheet (would
   246	    // corrupt the current holder's formula refs — Codex+Opus HIGH closure).
   247	    let mut rules: Vec<(String, Arc<str>, SheetId)> = Vec::new();
   248	    let mut sheet_rewrites: Vec<SheetRewriteSummary> = Vec::new();
   249	    let mut ambiguous_rules_skipped: Vec<AmbiguousSkip> = Vec::new();
   250	    let mut sheet_ids: Vec<SheetId> = historic_by_sheet.keys().copied().collect();
   251	    sheet_ids.sort_unstable();
   252	    for sheet_id in sheet_ids {
   253	        let historic = historic_by_sheet
   254	            .get(&sheet_id)
   255	            .cloned()
   256	            .unwrap_or_default();
   257	        let Some(current) = workbook.sheet(sheet_id).map(|s| s.name().to_owned()) else {
   258	            // Sheet ID is in the rename history but doesn't exist in the
   259	            // current workbook. Should not happen for sheet renames (no
   260	            // DropSheet op exists in V1). Defensive skip.
   261	            continue;
   262	        };
   263	        let current_canonical = Workbook::canonical_sheet_name(&current);
   264	        let current_arc: Arc<str> = Arc::from(current.as_str());
   265	
   266	        // Dedupe historic canonicals; skip those matching current canonical
   267	        // (no-op renames).
   268	        let mut historic_canonicals: Vec<String> = historic
   269	            .iter()
   270	            .map(|s| Workbook::canonical_sheet_name(s))
   271	            .filter(|c| c != &current_canonical)
   272	            .collect();
   273	        historic_canonicals.sort();
   274	        historic_canonicals.dedup();
   275	
   276	        for hc in &historic_canonicals {
   277	            // **Audit closure (Codex+Opus HIGH-1 + Codex HIGH-2)**: if
   278	            // `hc` is CURRENTLY held by any sheet, the rule would
   279	            // corrupt that sheet's legitimate formula references.
   280	            // E.g., sheet 0 renamed S→T; sheet 1 added as S afterward;
   281	            // formula `=S!A1` intends sheet 1, not sheet 0. The rule
   282	            // S→T would mis-rewrite it. Skip and report.
   283	            //
   284	            // Symmetric closure of the cascade case (Codex HIGH-1):
   285	            // sheets 0+1 each renamed; sheet 0's chain `B→C, A→B`
   286	            // and sheet 1's chain `S→...`. After all renames, sheet 0
   287	            // is named B. A rule from a DIFFERENT sheet with old=B
   288	            // would cascade-rewrite formulas that legitimately
   289	            // reference sheet 0. The guard catches both.
   290	            if let Some(holder) = canonical_to_current_sheet.get(hc) {
   291	                ambiguous_rules_skipped.push(AmbiguousSkip {
   292	                    origin_sheet: sheet_id,
   293	                    historic_canonical: hc.clone(),
   294	                    current_holder_sheet: *holder,
   295	                });
   296	                continue;
   297	            }
   298	            rules.push((hc.clone(), Arc::clone(&current_arc), sheet_id));
   299	        }
   300	
   301	        sheet_rewrites.push(SheetRewriteSummary {
   302	            sheet: sheet_id,
   303	            current_display_name: current,
   304	            historic_canonicals,
   305	        });
   306	    }
   307	
   308	    // ===== Phase 4: fast-path no-op when no rules survive.
   309	    // (Audit closure: Opus MEDIUM-2 — empty `rules` should NOT incur
   310	    // the per-formula iteration cost.)
   311	    if rules.is_empty() {
   312	        return Ok(RepairReport {
   313	            formulas_rewritten: 0,
   314	            sheet_rewrites,
   315	            ambiguous_rules_skipped,
   316	        });
   317	    }
   318	
   319	    // ===== Phase 5: walk formulas, collect updates.
   320	    // Two-phase to avoid mut/immut borrow conflict on workbook.
   321	    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
   322	    for (sheet, row, col, text) in workbook.iter_formulas() {
   323	        let mut current_text = text.to_string();
   324	        let mut changed = false;
   325	        for (old_canonical, new_name, _origin_sheet) in &rules {
   326	            if let Some(rewritten) =
   327	                rewrite_formula_with_rename(&current_text, old_canonical, new_name)
   328	            {
   329	                current_text = rewritten;
   330	                changed = true;
   331	            }
   332	        }
   333	        if changed {
   334	            to_update.push((sheet, row, col, current_text));
   335	        }
   336	    }
   337	    let rewrite_count = to_update.len();
   338	
   339	    // ===== Phase 6: apply updates.
   340	    for (sheet, row, col, new_text) in to_update {
   341	        workbook.put_formula(sheet, row, col, new_text);
   342	    }
   343	
   344	    Ok(RepairReport {
   345	        formulas_rewritten: rewrite_count,
   346	        sheet_rewrites,
   347	        ambiguous_rules_skipped,
   348	    })
   349	}
   350	
   351	/// Walk an `Op`, including ops nested in `BatchCommit`, and record
   352	/// `RenameSheet.old_name` entries in `historic`. Other op kinds are
   353	/// ignored.
   354	fn collect_rename_old_names(op: &Op, historic: &mut HashMap<SheetId, Vec<String>>) {
   355	    match op {
   356	        Op::RenameSheet { id, old_name, .. } => {
   357	            historic.entry(*id).or_default().push(old_name.clone());
   358	        }
   359	        Op::BatchCommit { ops } => {
   360	            for inner in ops {
   361	                collect_rename_old_names(inner, historic);
   362	            }
   363	        }
   364	        _ => {}
   365	    }
   366	}
   367	
   368	// **Phase 5.3 step 5 megaudit closure note (2026-05-20):** a helper
   369	// `collect_last_rename_new_name` was prototyped here to support a
   370	// debug-mode caller-contract assert (Opus-A Probe X HIGH-latent). It
   371	// was reverted because the assert tripped on legitimate D-2-style
   372	// auto-disambiguation paths (step 2 replay closure) — see the comment
   373	// at the start of `repair_sheet_rename_chain`. The caller-contract
   374	// enforcement now lives in `CollabSession::sync_workbook` (Phase 5.3
   375	// step 5b production-wiring closure) which atomically pairs
   376	// `replay_into` + `repair_*`.
   377	
   378	/// Rewrite `text` (formula source) substituting every reference to
   379	/// `old_canonical` (a canonical-uppercase sheet name) with `new_name`
   380	/// (the new display name).
   381	///
   382	/// Mirror of the producer-side helper at
   383	/// `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Kept here
   384	/// because ql-collab has no dep on ql-exec (direction: ql-collab is
   385	/// below ql-exec). Both helpers route through
   386	/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
   387	///
   388	/// **TODO (Opus step 3 audit MEDIUM-1, deferred-to-step-4 follow-up)**:
   389	/// promote this + `rewrite_formula_with_table_rename` +
   390	/// `rewrite_formula_with_column_rename` (this module) AND
   391	/// `rewrite_formula_text_for_sheet_rename` (sheets.rs:37-60) AND
   392	/// the inlined table/column rewrites (tables.rs:316-336, 471-490)
   393	/// to a single public helper in `ql-formula-syntax`. All 5+ call
   394	/// sites would converge on one implementation, preventing drift.
   395	/// Deferred to a separate refactor commit to keep step 4 scoped to
   396	/// the audit-locked algorithm + tests.
   397	///
   398	/// Returns `None` when:
   399	/// - The text doesn't lex/parse (formula is malformed — caller should
   400	///   not surface this as an error; recompute will surface it).
   401	/// - The parsed AST doesn't reference `old_canonical` (no rewrite).
   402	fn rewrite_formula_with_rename(
   403	    text: &str,
   404	    old_canonical: &str,
   405	    new_name: &Arc<str>,
   406	) -> Option<String> {
   407	    let stripped = text.strip_prefix('=').unwrap_or(text);
   408	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
   409	    let expr = ql_formula_syntax::parse(tokens).ok()?;
   410	    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
   411	    if rewritten == expr {
   412	        return None;
   413	    }
   414	    let printed = ql_formula_syntax::print(&rewritten);
   415	    let with_eq = if text.starts_with('=') {
   416	        format!("={printed}")
   417	    } else {
   418	        printed
   419	    };
   420	    Some(with_eq)
   421	}
   422	
   423	/// **Phase 5.3 step 4 (2026-05-20):** table-rename analog of
   424	/// [`repair_sheet_rename_chain`]. After a CRDT merge with concurrent
   425	/// table renames, formulas using `T[col]` structured references may
   426	/// reference table names that no longer exist. This pass rewrites
   427	/// the formula text to reference the current table name.
   428	///
   429	/// Algorithm mirrors the sheet version: chain-based, with the same
   430	/// safety guard (skip rules where `old_canonical` is currently held
   431	/// by ANY table — closes the cascade + reused-name corruption cases
   432	/// surfaced in step 3 audit).
   433	///
   434	/// Returns a [`TableRepairReport`] describing what was changed.
   435	///
   436	/// **Caller-driven**: invoke between `replay_into` and `recompute_all`
   437	/// (same call sequence as [`repair_sheet_rename_chain`]).
   438	pub fn repair_table_rename_chain(
   439	    workbook: &mut Workbook,
   440	    log: &OpLog,
   441	) -> Result<TableRepairReport, OpLogError> {
   442	    // Phase 1: collect historic table names from RenameTable ops.
   443	    // Tables are keyed by canonical (uppercase) name, NOT by id —
   444	    // unlike sheets which carry stable IDs. So our "chain" is keyed
   445	    // by NEW canonical name (the current key), with old_name as a
   446	    // value we map back from.
   447	    let mut historic_by_current: HashMap<String, Vec<String>> = HashMap::new();
   448	    // Use causal-order replay to know which historic name maps to
   449	    // which final canonical: walk ops in order, accumulating each
   450	    // hop's old_name under historic_by_current[new_name].
   451	    //
   452	    // **Audit closure (Opus MEDIUM-2):** previously also threaded
   453	    // a `canonical_chain: HashMap<String, String>` through the
   454	    // walker, but its `while let Some(next)` lookup result was
   455	    // never read — pure dead state. Removed.
   456	    for op_result in log.iter() {
   457	        let op = op_result?;
   458	        collect_table_renames(&op, &mut historic_by_current);
   459	    }
   460	
   461	    // Phase 2: snapshot current canonical names.
   462	    let current_table_canonicals: std::collections::HashSet<String> = workbook
   463	        .tables()
   464	        .iter()
   465	        .map(|(name, _)| name.to_ascii_uppercase())
   466	        .collect();
   467	
   468	    // Phase 3: build (canonical_historic -> current_display_name) rules.
   469	    // For each current table, walk its historic chain. Skip rules where
   470	    // the old_canonical is currently held by ANY table (safety guard
   471	    // mirroring step 3 audit closure).
   472	    //
   473	    // **Audit closure (Codex+Opus MEDIUM, 2026-05-20):** sort the
   474	    // current canonicals before iteration for deterministic rule
   475	    // order. HashSet iteration is non-deterministic; both the rules
   476	    // vec and the `table_rewrites` report would otherwise vary across
   477	    // runs.
   478	    let mut rules: Vec<(String, Arc<str>)> = Vec::new();
   479	    let mut table_rewrites: Vec<TableRewriteSummary> = Vec::new();
   480	    let mut ambiguous_rules_skipped: Vec<TableAmbiguousSkip> = Vec::new();
   481	    let mut sorted_current_canonicals: Vec<&String> = current_table_canonicals.iter().collect();
   482	    sorted_current_canonicals.sort();
   483	    for current_canonical in sorted_current_canonicals {
   484	        let Some(historic_set) = historic_by_current.get(current_canonical) else {
   485	            continue;
   486	        };
   487	        // Resolve current display name from the workbook.
   488	        let Some(meta) = workbook.tables().lookup(current_canonical) else {
   489	            continue;
   490	        };
   491	        let current_display: Arc<str> = Arc::clone(&meta.display_name);
   492	        let mut historic_canonicals: Vec<String> = historic_set
   493	            .iter()
   494	            .map(|s| s.to_ascii_uppercase())
   495	            .filter(|c| c != current_canonical)
   496	            .collect();
   497	        historic_canonicals.sort();
   498	        historic_canonicals.dedup();
   499	        for hc in &historic_canonicals {
   500	            if current_table_canonicals.contains(hc) {
   501	                // Safety guard: another table currently owns this
   502	                // historic name. Skip + report.
   503	                ambiguous_rules_skipped.push(TableAmbiguousSkip {
   504	                    origin_table_current_canonical: current_canonical.clone(),
   505	                    historic_canonical: hc.clone(),
   506	                });
   507	                continue;
   508	            }
   509	            rules.push((hc.clone(), Arc::clone(&current_display)));
   510	        }
   511	        table_rewrites.push(TableRewriteSummary {
   512	            current_canonical: current_canonical.clone(),
   513	            current_display_name: current_display.to_string(),
   514	            historic_canonicals,
   515	        });
   516	    }
   517	
   518	    if rules.is_empty() {
   519	        return Ok(TableRepairReport {
   520	            formulas_rewritten: 0,

exec
/bin/zsh -lc 'rg -n "pub fn replay_into|enum ReplayError|struct Replay|ReplayError|fn replay_into|pub enum OpLogError|pub fn is_empty|pub fn len|impl OpLog" quantbook-engine/crates/ql-oplog/src -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/error.rs:15:pub enum OpLogError {
quantbook-engine/crates/ql-oplog/src/log.rs:88:impl OpLog {
quantbook-engine/crates/ql-oplog/src/log.rs:148:    pub fn len(&self) -> usize {
quantbook-engine/crates/ql-oplog/src/log.rs:153:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-oplog/src/op.rs:83:    /// surfaces as `ReplayError::NameRejected` in either path. A
quantbook-engine/crates/ql-oplog/src/op.rs:85:    /// `ReplayError::InvalidSheet`.
quantbook-engine/crates/ql-oplog/src/op.rs:115:    ///   - diagnostics in `ReplayError::SheetRenameRejected.old_name`
quantbook-engine/crates/ql-oplog/src/op.rs:139:    /// `ReplayError::FormatRejected`. Shipped W5-80 (Phase 4.5.D part 4).
quantbook-engine/crates/ql-oplog/src/op.rs:155:    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
quantbook-engine/crates/ql-oplog/src/op.rs:283:    /// Unknown wire values (forward-compat) → `ReplayError::UnknownReferenceMode`
quantbook-engine/crates/ql-oplog/src/op.rs:291:    /// wire values surface `ReplayError::UnknownLocale` per design
quantbook-engine/crates/ql-oplog/src/op.rs:308:    /// `ReplayError::UnknownReferenceMode { index, found }` per
quantbook-engine/crates/ql-oplog/src/op.rs:324:    /// `ReplayError::UnknownReferenceMode`.
quantbook-engine/crates/ql-oplog/src/op.rs:360:/// path can surface `ReplayError::UnknownLocale` with the captured
quantbook-engine/crates/ql-oplog/src/lib.rs:16://! - [`OpLogError`], [`ReplayError`] — error surfaces (thiserror-derived).
quantbook-engine/crates/ql-oplog/src/lib.rs:33://! `ReplayError`, `FormatRejectedSource`) also carry the marker.
quantbook-engine/crates/ql-oplog/src/lib.rs:47:pub use replay::{replay_into, ReplayError};
quantbook-engine/crates/ql-oplog/src/replay.rs:4://! Workbook, &FunctionRegistry) -> Result<usize, ReplayError>`. Returns the
quantbook-engine/crates/ql-oplog/src/replay.rs:6://! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/crates/ql-oplog/src/replay.rs:20://!   as `ReplayError::NameRejected`.
quantbook-engine/crates/ql-oplog/src/replay.rs:54:pub enum ReplayError {
quantbook-engine/crates/ql-oplog/src/replay.rs:269:/// so `ReplayError` can stay `Clone + std::error::Error` without
quantbook-engine/crates/ql-oplog/src/replay.rs:351:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/crates/ql-oplog/src/replay.rs:378:pub fn replay_into(
quantbook-engine/crates/ql-oplog/src/replay.rs:382:) -> Result<usize, ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:385:        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
quantbook-engine/crates/ql-oplog/src/replay.rs:395:fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:406:                .map_err(|source| ReplayError::ValueDecode { index, source })?;
quantbook-engine/crates/ql-oplog/src/replay.rs:434:                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
quantbook-engine/crates/ql-oplog/src/replay.rs:439:                        ReplayError::NameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:454:                            .ok_or(ReplayError::InvalidSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:460:                        ReplayError::NameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:473:            // `ReplayError::SheetNameRejected` on validation failure.
quantbook-engine/crates/ql-oplog/src/replay.rs:505:                            return Err(ReplayError::SheetNameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:515:                        return Err(ReplayError::SheetNameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:581:                ReplayError::InvalidSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:602:                            return Err(ReplayError::SheetRenameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:614:                        return Err(ReplayError::SheetRenameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:640:                .map_err(|e| ReplayError::FormatRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:660:                    return Err(ReplayError::FormatNotRegistered { index, id: fid });
quantbook-engine/crates/ql-oplog/src/replay.rs:754:        // unknown wire values surface `ReplayError::UnknownReferenceMode`
quantbook-engine/crates/ql-oplog/src/replay.rs:762:            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
quantbook-engine/crates/ql-oplog/src/replay.rs:766:        // `ReplayError::UnknownLocale` with the captured string.
quantbook-engine/crates/ql-oplog/src/replay.rs:772:            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
quantbook-engine/crates/ql-oplog/src/replay.rs:818:) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:886:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:894:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:925:) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:930:        .ok_or_else(|| ReplayError::TableNotFound {
quantbook-engine/crates/ql-oplog/src/replay.rs:954:        return Err(ReplayError::TableColumnRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:964:        return Err(ReplayError::TableColumnRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:983:        return Err(ReplayError::TableColumnRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1013:) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:1022:                .ok_or_else(|| ReplayError::TableNotFound {
quantbook-engine/crates/ql-oplog/src/replay.rs:1039:        return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1050:        return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1059:        return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1067:        return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1079:            return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1088:        return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1108:                return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1132:                    return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1143:                return Err(ReplayError::TableResizeRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1193:) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:1197:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1204:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1211:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1218:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1230:                return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1239:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1246:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1257:        return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1269:                return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1276:                return Err(ReplayError::TableCreateRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1316:) -> Result<(), ReplayError> {
quantbook-engine/crates/ql-oplog/src/replay.rs:1319:        return Err(ReplayError::InvalidSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1326:        return Err(ReplayError::InvalidCell {
quantbook-engine/crates/ql-oplog/src/replay.rs:1334:        return Err(ReplayError::InvalidCell {
quantbook-engine/crates/ql-oplog/src/replay.rs:1523:            Err(ReplayError::InvalidSheet {
quantbook-engine/crates/ql-oplog/src/replay.rs:1555:                Err(ReplayError::InvalidCell {
quantbook-engine/crates/ql-oplog/src/replay.rs:1581:            Err(ReplayError::NameRejected {
quantbook-engine/crates/ql-oplog/src/replay.rs:1650:            Err(ReplayError::FormatRejected { index, source }) => {
quantbook-engine/crates/ql-oplog/src/replay.rs:1734:            Err(ReplayError::FormatNotRegistered { index, id }) => {
quantbook-engine/crates/ql-oplog/src/replay.rs:1757:            Err(ReplayError::InvalidSheet { sheet, .. }) => assert_eq!(sheet, 99),
quantbook-engine/crates/ql-oplog/src/replay.rs:1879:        assert!(matches!(err, ReplayError::InvalidSheet { .. }));
quantbook-engine/crates/ql-oplog/src/replay.rs:2043:            matches!(err, ReplayError::InvalidSheet { sheet: 7, .. }),
quantbook-engine/crates/ql-oplog/src/replay.rs:2065:            matches!(err, ReplayError::NameRejected { .. }),
quantbook-engine/crates/ql-oplog/src/replay.rs:2083:        // asserting `ReplayError::SheetNameRejected`. The D-2 spec
quantbook-engine/crates/ql-oplog/src/replay.rs:2177:        assert!(matches!(err, ReplayError::SheetNameRejected { .. }));
quantbook-engine/crates/ql-oplog/src/replay.rs:2213:    /// `ReplayError::UnknownLocale { index, found }`.
quantbook-engine/crates/ql-oplog/src/replay.rs:2225:            ReplayError::UnknownLocale { index, found } => {
quantbook-engine/crates/ql-oplog/src/replay.rs:2236:    /// `ReplayError::UnknownReferenceMode`.
quantbook-engine/crates/ql-oplog/src/replay.rs:2248:            ReplayError::UnknownReferenceMode { index, found } => {

exec
/bin/zsh -lc "rg -n \"repair_sheet_rename_chain|repair_table_rename_chain|sync_workbook|replay_into\\(|op_log\\(|merge_bytes\\(\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:3://! Phase 2A.3.a (2026-05-12): single entry point `replay_into(&OpLog, &mut
quantbook-engine/crates/ql-oplog/src/replay.rs:378:pub fn replay_into(
quantbook-engine/crates/ql-oplog/src/replay.rs:808:///    corruption when combined with `repair_table_rename_chain` —
quantbook-engine/crates/ql-oplog/src/replay.rs:864:    // repair pass at `ql_collab::repair_table_rename_chain` keys
quantbook-engine/crates/ql-oplog/src/replay.rs:1363:        let n = replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1380:        let n = replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1398:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1431:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1449:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1467:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1495:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1521:        let result = replay_into(&log, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/src/replay.rs:1551:        let result = replay_into(&log, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/src/replay.rs:1579:        let result = replay_into(&log, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/src/replay.rs:1608:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1629:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1649:        match replay_into(&log, &mut wb, &reg) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1682:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1715:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1733:        match replay_into(&log, &mut wb, &reg) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1756:        match replay_into(&log, &mut wb, &reg) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1778:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1805:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1824:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1858:        replay_into(&log, &mut wb, &reg).expect("replay must apply rename, not error");
quantbook-engine/crates/ql-oplog/src/replay.rs:1878:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:1914:        replay_into(&log, &mut wb, &reg)
quantbook-engine/crates/ql-oplog/src/replay.rs:1963:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:1992:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2018:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2041:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:2063:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:2099:        replay_into(&log, &mut wb, &reg).expect("auto-rename succeeds");
quantbook-engine/crates/ql-oplog/src/replay.rs:2123:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2154:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2176:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:2193:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2206:        replay_into(&log, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/src/replay.rs:2223:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/replay.rs:2246:        let err = replay_into(&log, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-oplog/src/log.rs:192:    /// `&OpLog` (`CollabSession::op_log()`) which would silently
quantbook-engine/crates/ql-oplog/src/log.rs:349:    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
quantbook-engine/crates/ql-oplog/src/log.rs:356:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:598:        peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:618:    fn presence_independent_from_op_log() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:64:    replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:93:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:114:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:165:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:186:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:222:    peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:232:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:274:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:296:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:355:        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:358:        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:364:        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:367:        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:373:        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:376:        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:447:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:468:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:56:    replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:88:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:152:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:158:    let result = replay_into(&peer_a, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:193:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:235:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:239:    let result = replay_into(&peer_a, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:66:    replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:92:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:127:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:173:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:191:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:259:    let result = replay_into(&log, &mut wb, &reg);
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:389:    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:433:    replay_into(&log, &mut wb_in_memory, &reg).unwrap();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:440:    replay_into(&restored, &mut wb_via_disk, &reg).unwrap();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:482:    replay_into(&log_flat, &mut wb_flat, &reg).unwrap();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:490:    replay_into(&log_batched, &mut wb_batched, &reg).unwrap();
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:155:                    replay_into(&log, &mut wb, &registry)
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:190:        replay_into(&log, &mut wb, &registry)
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:218:    let r = replay_into(&log, &mut wb, &registry);
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:239:    let r = replay_into(&log, &mut wb, &registry);
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:262:    let r = replay_into(&log, &mut wb, &registry);
quantbook-engine/crates/ql-collab/src/repair.rs:16://! `repair_sheet_rename_chain` is **caller-driven**, NOT hooked into
quantbook-engine/crates/ql-collab/src/repair.rs:21://! 1. CollabSession::merge_bytes(peer_b_bytes)   // pull peer's ops
quantbook-engine/crates/ql-collab/src/repair.rs:22://! 2. replay_into(log, &mut workbook, &registry) // apply ops to workbook
quantbook-engine/crates/ql-collab/src/repair.rs:23://! 3. ql_collab::repair_sheet_rename_chain(&mut workbook, &log)?  // <-- THIS module
quantbook-engine/crates/ql-collab/src/repair.rs:124://!   `Op::RenameTable` → [`repair_table_rename_chain`] (this module).
quantbook-engine/crates/ql-collab/src/repair.rs:137:/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
quantbook-engine/crates/ql-collab/src/repair.rs:204:pub fn repair_sheet_rename_chain(
quantbook-engine/crates/ql-collab/src/repair.rs:220:    // production wiring fix at `CollabSession::sync_workbook`
quantbook-engine/crates/ql-collab/src/repair.rs:373:// at the start of `repair_sheet_rename_chain`. The caller-contract
quantbook-engine/crates/ql-collab/src/repair.rs:374:// enforcement now lives in `CollabSession::sync_workbook` (Phase 5.3
quantbook-engine/crates/ql-collab/src/repair.rs:424:/// [`repair_sheet_rename_chain`]. After a CRDT merge with concurrent
quantbook-engine/crates/ql-collab/src/repair.rs:437:/// (same call sequence as [`repair_sheet_rename_chain`]).
quantbook-engine/crates/ql-collab/src/repair.rs:438:pub fn repair_table_rename_chain(
quantbook-engine/crates/ql-collab/src/repair.rs:616:/// Report for [`repair_table_rename_chain`].
quantbook-engine/crates/ql-collab/src/lib.rs:62://!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
quantbook-engine/crates/ql-collab/src/lib.rs:105:    repair_sheet_rename_chain, repair_table_rename_chain, AmbiguousSkip, RepairReport,
quantbook-engine/crates/ql-collab/src/session.rs:42://! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
quantbook-engine/crates/ql-collab/src/session.rs:46://! - `op_log(&self)` — read-only view of the underlying log
quantbook-engine/crates/ql-collab/src/session.rs:58:    repair_sheet_rename_chain, repair_table_rename_chain, RepairReport, TableRepairReport,
quantbook-engine/crates/ql-collab/src/session.rs:118:    /// (Opus-A Scenario E HIGH).** `sync_workbook` invoked
quantbook-engine/crates/ql-collab/src/session.rs:132:/// [`CollabSession::sync_workbook`]. Combines the replay op count
quantbook-engine/crates/ql-collab/src/session.rs:286:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:287:        Ok(self.log.merge_bytes(bytes)?)
quantbook-engine/crates/ql-collab/src/session.rs:310:    /// **Prefer [`Self::sync_workbook`] over this raw accessor** when
quantbook-engine/crates/ql-collab/src/session.rs:311:    /// rebuilding a workbook after a `merge_bytes` — `sync_workbook`
quantbook-engine/crates/ql-collab/src/session.rs:313:    /// passes (audit-locked D-5.3-1 caller contract). Raw `op_log()`
quantbook-engine/crates/ql-collab/src/session.rs:321:    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
quantbook-engine/crates/ql-collab/src/session.rs:327:    /// session.merge_bytes(&peer_b_bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:330:    /// let report = session.sync_workbook(&mut wb, &reg)?;
quantbook-engine/crates/ql-collab/src/session.rs:333:    pub fn op_log(&self) -> &OpLog {
quantbook-engine/crates/ql-collab/src/session.rs:342:    ///   1. `ql_oplog::replay_into(self.op_log(), workbook, registry)`
quantbook-engine/crates/ql-collab/src/session.rs:343:    ///   2. `repair_sheet_rename_chain(workbook, self.op_log())`
quantbook-engine/crates/ql-collab/src/session.rs:344:    ///   3. `repair_table_rename_chain(workbook, self.op_log())`
quantbook-engine/crates/ql-collab/src/session.rs:364:    /// The function reads `self` immutably (via `self.op_log()`);
quantbook-engine/crates/ql-collab/src/session.rs:383:    pub fn sync_workbook(
quantbook-engine/crates/ql-collab/src/session.rs:391:        let ops_replayed = replay_into(&self.log, workbook, registry)?;
quantbook-engine/crates/ql-collab/src/session.rs:392:        let sheet_repair = repair_sheet_rename_chain(workbook, &self.log)?;
quantbook-engine/crates/ql-collab/src/session.rs:393:        let table_repair = repair_table_rename_chain(workbook, &self.log)?;
quantbook-engine/crates/ql-collab/src/session.rs:513:                    self.log.merge_bytes(&bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:913:        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:938:        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-collab/src/session.rs:963:        assert_eq!(reborn.op_log().peer_id(), 22);
quantbook-engine/crates/ql-collab/src/session.rs:972:        assert_eq!(reborn.op_log().peer_id(), 22);
quantbook-engine/crates/ql-collab/src/session.rs:1032:        peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1063:        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1067:        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1100:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1110:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1210:            s.op_log().iter().count(),
quantbook-engine/crates/ql-collab/src/session.rs:1217:        assert_eq!(s.op_log().iter().count(), 5);
quantbook-engine/crates/ql-collab/src/session.rs:1257:        assert_eq!(s.op_log().iter().count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1435:        assert_eq!(s.op_log().iter().count(), 2);
quantbook-engine/crates/ql-collab/src/session.rs:1439:        assert_eq!(s.op_log().iter().count(), s.op_count());
quantbook-engine/crates/ql-collab/src/session.rs:1444:        assert_eq!(s.op_log().iter().count(), s.op_count());
quantbook-engine/crates/ql-collab/src/session.rs:1487:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1493:        let a_iter = peer_a.op_log().iter().count();
quantbook-engine/crates/ql-collab/src/session.rs:1500:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1501:        let b_iter_after = peer_b.op_log().iter().count();
quantbook-engine/crates/ql-collab/src/session.rs:1796:        peer_b.merge_bytes(&received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1806:        peer_a.merge_bytes(&b_received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1893:    fn presence_does_not_dirty_op_log() {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:1://! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:17://!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:25:use ql_collab::{repair_sheet_rename_chain, RepairReport};
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:55:    replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:66:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:109:    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:165:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:168:    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:216:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:221:    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:275:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:278:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:317:    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:320:    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:354:    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:419:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:426:    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:473:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:476:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:516:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:519:    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:527:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:530:    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:567:    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:656:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:661:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:730:    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:797:    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:12:use ql_collab::{repair_table_rename_chain, TableRepairReport};
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:53:    replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:83:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:97:    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:139:    let report: TableRepairReport = repair_table_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:175:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:247:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:252:    let result = replay_into(&peer_a, &mut wb, &reg);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:293:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:296:    let _report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:336:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:339:    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:372:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:375:    let first = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:377:    let second = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:439:    let report = repair_table_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:1://! Phase 5.3 step 5b — `CollabSession::sync_workbook` integration tests.
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:8://! concurrent-rename formulas. `sync_workbook` atomically pairs
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:14://! - Single-peer happy path: sync_workbook applies replay + reports.
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:64:fn sync_workbook_empty_log_fast_path_returns_default_report() {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:68:    let report = session.sync_workbook(&mut wb, &reg).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:79:fn sync_workbook_single_peer_applies_replay() {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:84:    let report = session.sync_workbook(&mut wb, &reg).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:103:/// `=S!A1` (referencing the old name). Without `sync_workbook`'s
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:105:/// recompute. With `sync_workbook`, the repair pass rewrites the
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:108:fn sync_workbook_concurrent_rename_sheet_plus_edit_repair_fires() {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:136:    session_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:141:    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:169:fn sync_workbook_concurrent_rename_table_plus_edit_repair_fires() {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:215:    session_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:219:    let report = session_a.sync_workbook(&mut wb, &reg).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:237:/// limitation makes `replay_into` hard-fail. `sync_workbook` should
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:240:fn sync_workbook_replay_error_surfaces_via_session_error_variant() {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:295:    session_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:299:    let result: Result<SyncReport, CollabSessionError> = session_a.sync_workbook(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:469:        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1951:        replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4718:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4755:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4785:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:121:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:160:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:198:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:230:    replay_into(&restored, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:280:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:336:    replay_into(&loaded_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:381:    replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:511:    replay_into(&oplog, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:559:    replay_into(&oplog, &mut wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:601:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:636:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:670:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:740:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:841:    let err = replay_into(&oplog, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:883:    let err = replay_into(&oplog, &mut wb, &reg).unwrap_err();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:934:    replay_into(&producer_oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:162:        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:29://!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:97:    replay_into(log, &mut wb, &reg).expect("replay should succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:141:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:151:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:506:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:557:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:581:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:588:        replay_into(log, &mut wb, &reg).expect("replay must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:592:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:593:            .expect("repair_sheet_rename_chain must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:719:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:48:    replay_into(log, &mut wb, &reg).expect("replay should succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:88:    peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:139:    peer_b.merge_bytes(&a_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:184:    peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:224:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:356:    replay_into(&oplog, &mut replayed, &reg).unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/error.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Error types for the op log.
     2	
     3	use thiserror::Error;
     4	
     5	/// Errors emitted by `OpLog` operations.
     6	///
     7	/// Phase 2A.3.a (2026-05-12): three failure modes —
     8	/// 1. Serializing a well-formed `Op` to JSON should never fail; if it does
     9	///    that's a programmer-error condition (bug in our `Op` derive).
    10	/// 2. Deserializing back is the failure mode that fires under corrupted
    11	///    on-disk op-log data.
    12	/// 3. Loro's own export/import surface its own errors via `loro::LoroError`.
    13	#[derive(Debug, Error)]
    14	#[non_exhaustive]
    15	pub enum OpLogError {
    16	    /// JSON serialization of an `Op` failed. Should be unreachable for
    17	    /// well-formed `Op` values produced by our own code.
    18	    #[error("op log serialize error: {0}")]
    19	    Serialize(#[source] serde_json::Error),
    20	
    21	    /// JSON deserialization of an `Op` from the log failed. Typically
    22	    /// indicates a corrupted on-disk op-log (`oplog.bin`) or version
    23	    /// drift (older binary reading newer ops).
    24	    #[error("op log deserialize error at op index {index}: {source}")]
    25	    Deserialize {
    26	        index: usize,
    27	        #[source]
    28	        source: serde_json::Error,
    29	    },
    30	
    31	    /// Wrapped Loro internal error (commit / import / container access).
    32	    /// Surfaces through `#[from]` so call sites that use `?` get automatic
    33	    /// conversion.
    34	    #[error("op log loro error: {0}")]
    35	    Loro(#[from] loro::LoroError),
    36	
    37	    /// Wrapped Loro encode error (raised by `LoroDoc::export`). Distinct
    38	    /// from `LoroError` (decode) in Loro 1.12.0's API surface.
    39	    #[error("op log loro encode error: {0}")]
    40	    LoroEncode(#[from] loro::LoroEncodeError),
    41	
    42	    /// The op log's internal Loro shape doesn't match what we wrote. Fires
    43	    /// when an imported snapshot was produced by code that wrote a
    44	    /// different container layout (e.g., a future version of this crate).
    45	    #[error("op log schema mismatch: {0}")]
    46	    SchemaMismatch(&'static str),
    47	}

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
   141	    /// the rename to the current sheet (last-in-causal-order wins
   142	    /// policy). Variant kept for ABI compat — external callers that
   143	    /// match against it will simply never see it. Marked
   144	    /// `#[deprecated]` for IDE discoverability (Codex step-2 audit
   145	    /// LOW closure). May be removed in a future major version.
   146	    #[deprecated(
   147	        since = "0.1.0",
   148	        note = "Phase 5.3 step 2: no longer emitted. Concurrent renames now apply via last-in-causal-order wins policy. See replay.rs RenameSheet handler."
   149	    )]
   150	    #[error(
   151	        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
   152	         expected current name {expected:?}, found {found:?}"
   153	    )]
   154	    SheetRenameNameMismatch {
   155	        index: usize,
   156	        id: SheetId,
   157	        expected: String,
   158	        found: String,
   159	    },
   160	
   161	    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
   162	    /// new name (duplicate, reserved character, empty).
   163	    #[error(
   164	        "replay rename-sheet rejected at op index {index}: sheet {id} \
   165	         from {old_name:?} to {new_name:?} ({source})"
   166	    )]
   167	    SheetRenameRejected {
   168	        index: usize,
   169	        id: SheetId,
   170	        old_name: String,
   171	        new_name: String,
   172	        #[source]
   173	        source: ql_storage::SheetNameError,
   174	    },
   175	
   176	    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
   177	    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
   178	    /// under canonical comparison, or an Excel-reserved character.
   179	    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
   180	    /// accepted any name, so an op log produced against a buggy
   181	    /// storage path could let conflicting sheets enter replay state.
   182	    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
   183	    SheetNameRejected {
   184	        index: usize,
   185	        name: String,
   186	        #[source]
   187	        source: ql_storage::SheetNameError,
   188	    },
   189	
   190	    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
   191	    /// the producer should have validated. Catches snapshot-vs-replay
   192	    /// divergence (e.g. snapshot already has the table; another producer
   193	    /// raced).
   194	    #[error("replay create-table rejected at op index {index}: {reason}")]
   195	    TableCreateRejected {
   196	        index: usize,
   197	        name: String,
   198	        reason: &'static str,
   199	    },
   200	
   201	    /// **W5-118 (Phase 4.8.H) + Phase 5.3 step 5 megaudit closure (2026-05-20):**
   202	    /// originally fired when `DropTable` referenced a missing table. The
   203	    /// step 5 megaudit (Codex HIGH + Opus-A V1 LIM #4) flagged this as
   204	    /// producing an order-dependent CRDT-merge failure (drop-then-rename
   205	    /// works; rename-then-drop hard-failed). The `DropTable` handler now
   206	    /// advisory-skips on missing source. This variant still fires from
   207	    /// `apply_rename_table` when the source table doesn't exist AND a
   208	    /// new-name table doesn't exist either (i.e., not an idempotent
   209	    /// concurrent-rename case — see `replay.rs:802-820`).
   210	    #[error("replay drop-table at op index {index}: table {name:?} not found")]
   211	    TableNotFound { index: usize, name: String },
   212	
   213	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
   214	    /// that doesn't exist in the target table (case-insensitive). Either
   215	    /// the source column was already dropped/renamed before this op, or
   216	    /// the op log has diverged from the snapshot.
   217	    #[error(
   218	        "replay rename-column at op index {index}: table {table:?} \
   219	         has no column {column:?}"
   220	    )]
   221	    TableColumnNotFound {
   222	        index: usize,
   223	        table: String,
   224	        column: String,
   225	    },
   226	
   227	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
   228	    /// validation rule (target name already in the table, empty, etc.).
   229	    /// `reason` is a static string describing which invariant fired.
   230	    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
   231	    TableColumnRejected {
   232	        index: usize,
   233	        table: String,
   234	        column: String,
   235	        reason: &'static str,
   236	    },
   237	
   238	    /// **W5-122 (Phase 4.8.J):** `ResizeTable` op was rejected by a
   239	    /// validation rule (arithmetic mismatch, trailing-columns
   240	    /// mismatch, column-name collision, footprint overlap, etc.).
   241	    /// `reason` is a static string describing which invariant fired.
   242	    #[error("replay resize-table rejected at op index {index}: table {name:?} ({reason})")]
   243	    TableResizeRejected {
   244	        index: usize,
   245	        name: String,
   246	        reason: &'static str,
   247	    },
   248	
   249	    /// **W5-146 (Phase 4.9.J):** `Op::SetLocale` wire value didn't
   250	    /// match any known locale code. Mirrors qbook v7's
   251	    /// `QbookError::UnknownLocale` (W5-145) — a forward-compat
   252	    /// op-log file with an unrecognized locale string surfaces this
   253	    /// instead of silently substituting EnUs (closes Sonnet L-10).
   254	    /// Captures the offending string for the IDE diagnostic.
   255	    #[error("replay unknown locale at op index {index}: {found:?}")]
   256	    UnknownLocale { index: usize, found: String },
   257	
   258	    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** `Op::SetReferenceMode`
   259	    /// wire value didn't match `A1` or `R1C1`. Per design § 4.9.J,
   260	    /// the forward-compat path captures unknown strings into
   261	    /// `ReferenceModeWire::Unknown(_)` and replay surfaces this
   262	    /// distinct error rather than letting the op silently no-op.
   263	    /// Parallels `UnknownLocale` above.
   264	    #[error("replay unknown reference mode at op index {index}: {found:?}")]
   265	    UnknownReferenceMode { index: usize, found: String },
   266	}
   267	
   268	/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
   269	/// so `ReplayError` can stay `Clone + std::error::Error` without
   270	/// borrowing into the table.
   271	///
   272	/// Phase 5.2 D-1 step 3: `id` / `existing_id` / `attempted_id` are now
   273	/// `ql_storage::FormatId` (tagged tuple) rather than the pre-step-3
   274	/// `u32`. Display formatting uses the FormatId's `Debug` impl so error
   275	/// messages identify both built-in and peer-allocated custom variants.
   276	#[derive(Clone, Debug, thiserror::Error)]
   277	#[non_exhaustive]
   278	pub enum FormatRejectedSource {
   279	    #[error("format id {id:?} already bound to {existing:?}, can't re-bind to {attempted:?}")]
   280	    IdCollision {
   281	        id: ql_storage::FormatId,
   282	        existing: String,
   283	        attempted: String,
   284	    },
   285	    #[error(
   286	        "format string {string:?} already at id {existing_id:?}, can't bind to id {attempted_id:?}"
   287	    )]
   288	    StringCollision {
   289	        string: String,
   290	        existing_id: ql_storage::FormatId,
   291	        attempted_id: ql_storage::FormatId,
   292	    },
   293	    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
   294	    /// replayed `Op::RegisterFormat` with a `Custom(local_peer, u32::MAX)`
   295	    /// id would have panicked at `FormatTable::register_at`'s counter
   296	    /// advancement before this guard landed; now surfaces as a recoverable
   297	    /// replay error.
   298	    #[error("format counter overflow for peer {peer:?} (counter == u32::MAX)")]
   299	    CounterOverflow { peer: ql_types::PeerId },
   300	    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
   301	    /// replayed `Op::RegisterFormat` with `Builtin(n > 163)`. Built-in
   302	    /// format ids are contractually `0..=FIRST_XLSX_BUILTIN_MAX`;
   303	    /// `FormatIdWire::Builtin { id: u32 }` carries no range bound at the
   304	    /// type level so a malformed op can smuggle the bad shape past serde
   305	    /// validation. Surfaces here as a replay error rather than letting
   306	    /// the storage table silently accept and later drop the entry.
   307	    #[error(
   308	        "builtin format id {id} out of range (max {FIRST_XLSX_BUILTIN_MAX})",
   309	        FIRST_XLSX_BUILTIN_MAX = 163
   310	    )]
   311	    BuiltinOutOfRange { id: u32 },
   312	}
   313	
   314	impl From<ql_storage::FormatTableError> for FormatRejectedSource {
   315	    fn from(e: ql_storage::FormatTableError) -> Self {
   316	        match e {
   317	            ql_storage::FormatTableError::IdCollision {
   318	                id,
   319	                existing,
   320	                attempted,
   321	            } => FormatRejectedSource::IdCollision {
   322	                id,
   323	                existing,
   324	                attempted,
   325	            },
   326	            ql_storage::FormatTableError::StringCollision {
   327	                string,
   328	                existing_id,
   329	                attempted_id,
   330	            } => FormatRejectedSource::StringCollision {
   331	                string,
   332	                existing_id,
   333	                attempted_id,
   334	            },
   335	            ql_storage::FormatTableError::CounterOverflow { peer } => {
   336	                FormatRejectedSource::CounterOverflow { peer }
   337	            }
   338	            ql_storage::FormatTableError::BuiltinOutOfRange { id } => {
   339	                FormatRejectedSource::BuiltinOutOfRange { id }
   340	            }
   341	            _ => unreachable!(
   342	                "FormatTableError gained a variant — extend FormatRejectedSource::From"
   343	            ),
   344	        }
   345	    }
   346	}
   347	
   348	/// Replay every op in `log` against `workbook` in append order.
   349	///
   350	/// Returns the total count of ops applied on success. On failure, the
   351	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
   352	/// the caller how far replay got.
   353	///
   354	/// # Caller contract on `Err` (Phase 5.3 step 5 megaudit closure)
   355	///
   356	/// **`replay_into` is NOT transactional.** On `Err(_)`, the workbook
   357	/// passed by `&mut` reference is in a HALF-MERGED state: ops 0..index
   358	/// have been applied; the op at `index` errored; ops at `index+1..` were
   359	/// not attempted. The mutation is NOT rolled back. The caller MUST
   360	/// discard the workbook (e.g., re-construct from a clean state then
   361	/// re-replay up to but not including the failing op) — reusing the
   362	/// passed-by-mut-ref workbook after `Err` operates on the partial state
   363	/// and produces incorrect downstream behavior.
   364	///
   365	/// This is the audit-locked V1 policy per Phase 5.3 step 5 megaudit
   366	/// (Opus-A HIGH-1 / V1 LIM #1). The CRDT-merge use case requires
   367	/// `replay_into` to be safe under concurrent ops; the V1 hard-fails
   368	/// (e.g., cross-source `RenameTable` target collision) trigger this
   369	/// partial-state path. Future V2 closure paths considered: workbook
   370	/// snapshot/restore (memory cost), two-phase replay validate-then-apply
   371	/// (compute cost), or replay-side soft-fail with synthesized correction
   372	/// ops (architectural change). For V1, the documentation contract is
   373	/// the only protection.
   374	///
   375	/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
   376	/// and is unused in 2A.3.a (replay persists formula text without
   377	/// re-evaluating; callers drive evaluation through `recompute_all`).
   378	pub fn replay_into(
   379	    log: &OpLog,
   380	    workbook: &mut Workbook,
   381	    _registry: &FunctionRegistry,
   382	) -> Result<usize, ReplayError> {
   383	    let mut count = 0;
   384	    for (index, op_result) in log.iter().enumerate() {
   385	        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
   386	        apply_op(&op, workbook, index)?;
   387	        count += 1;
   388	    }
   389	    Ok(count)
   390	}
   391	
   392	/// Recursive helper. `index` is the op's position in the outer log (or
   393	/// the synthetic position of the enclosing BatchCommit for nested ops —
   394	/// 2A.3.a flattens by reporting the parent's index for nested failures).
   395	fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
   396	    match op {
   397	        Op::PutValue {
   398	            sheet,
   399	            row,
   400	            col,
   401	            value,
   402	        } => {
   403	            validate_cell(workbook, *sheet, *row, *col, index)?;
   404	            let v: Value = value
   405	                .to_value()
   406	                .map_err(|source| ReplayError::ValueDecode { index, source })?;
   407	            workbook.put_at(*sheet, *row, *col, v);
   408	            Ok(())
   409	        }
   410	        Op::PutFormula {
   411	            sheet,
   412	            row,
   413	            col,
   414	            text,
   415	        } => {
   416	            validate_cell(workbook, *sheet, *row, *col, index)?;
   417	            workbook.put_formula(*sheet, *row, *col, text.as_str());
   418	            Ok(())
   419	        }
   420	        Op::ClearFormula { sheet, row, col } => {
   421	            // clear_formula is idempotent on missing entries; we still
   422	            // validate bounds so a corrupted op-log can't sneak past.
   423	            validate_cell(workbook, *sheet, *row, *col, index)?;
   424	            workbook.clear_formula(*sheet, *row, *col);
   425	            Ok(())
   426	        }
   427	        Op::SetName {
   428	            scope,
   429	            name,
   430	            target,

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '80,380p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   281	        map.delete(peer_key)?;
   282	        self.doc
   283	            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
   284	        Ok(())
   285	    }
   286	
   287	    /// **Phase 5.4 V1 (2026-05-19):** construct a Loro `UndoManager`
   288	    /// bound to this log's underlying `LoroDoc`.
   289	    ///
   290	    /// Per Loro 1.12.0 docs (`lib.rs:3708`):
   291	    /// - "Local-only: undo/redo affects only local operations from
   292	    ///   the bound peer; it does not revert remote edits."
   293	    /// - "keep the `peer_id` stable while an `UndoManager` is in
   294	    ///   use."
   295	    ///
   296	    /// Callers MUST construct the manager AFTER `set_peer_id` and
   297	    /// SHOULD NOT change the peer id while it's alive. The returned
   298	    /// manager subscribes to the doc's commit stream; subsequent
   299	    /// `append` / `presence_set` / `presence_remove` calls feed it.
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
   366	
   367	    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
   368	        Op::PutValue {
   369	            sheet,
   370	            row,
   371	            col,
   372	            value: CellWireValue::Number(n),
   373	        }
   374	    }
   375	
   376	    #[test]
   377	    fn new_log_is_empty() {
   378	        let log = OpLog::new();
   379	        assert!(log.is_empty());
   380	        assert_eq!(log.len(), 0);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/repair.rs | sed -n '516,720p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   516	    }
   517	
   518	    if rules.is_empty() {
   519	        return Ok(TableRepairReport {
   520	            formulas_rewritten: 0,
   521	            table_rewrites,
   522	            ambiguous_rules_skipped,
   523	        });
   524	    }
   525	
   526	    // Phase 4: walk formulas, collect updates.
   527	    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
   528	    for (sheet, row, col, text) in workbook.iter_formulas() {
   529	        let mut current_text = text.to_string();
   530	        let mut changed = false;
   531	        for (old_canonical, new_display) in &rules {
   532	            if let Some(rewritten) =
   533	                rewrite_formula_with_table_rename(&current_text, old_canonical, new_display)
   534	            {
   535	                current_text = rewritten;
   536	                changed = true;
   537	            }
   538	        }
   539	        if changed {
   540	            to_update.push((sheet, row, col, current_text));
   541	        }
   542	    }
   543	    let rewrite_count = to_update.len();
   544	
   545	    // Phase 5: apply updates.
   546	    for (sheet, row, col, new_text) in to_update {
   547	        workbook.put_formula(sheet, row, col, new_text);
   548	    }
   549	
   550	    Ok(TableRepairReport {
   551	        formulas_rewritten: rewrite_count,
   552	        table_rewrites,
   553	        ambiguous_rules_skipped,
   554	    })
   555	}
   556	
   557	/// Walk an `Op` (including BatchCommit-nested) and accumulate
   558	/// historic table canonicals per current canonical. Transitive
   559	/// chain propagation: when an op renames `old_c → new_c`, any
   560	/// historic entries previously keyed under `old_c` move to `new_c`
   561	/// (along with `old_c` itself).
   562	fn collect_table_renames(op: &Op, historic_by_current: &mut HashMap<String, Vec<String>>) {
   563	    match op {
   564	        Op::RenameTable { old_name, new_name } => {
   565	            let old_c = old_name.to_ascii_uppercase();
   566	            let new_c = new_name.to_ascii_uppercase();
   567	            // historic_by_current[new_c] gets old_c appended (the
   568	            // most recent old name for this final canonical).
   569	            historic_by_current
   570	                .entry(new_c.clone())
   571	                .or_default()
   572	                .push(old_c.clone());
   573	            // Propagate prior chain: if old_c had its own historic
   574	            // entries, move them to new_c.
   575	            if let Some(prior) = historic_by_current.remove(&old_c) {
   576	                for p in prior {
   577	                    historic_by_current
   578	                        .entry(new_c.clone())
   579	                        .or_default()
   580	                        .push(p);
   581	                }
   582	            }
   583	        }
   584	        Op::BatchCommit { ops } => {
   585	            for inner in ops {
   586	                collect_table_renames(inner, historic_by_current);
   587	            }
   588	        }
   589	        _ => {}
   590	    }
   591	}
   592	
   593	/// Table-rename analog of [`rewrite_formula_with_rename`]. Routes
   594	/// through `ql_formula_syntax::rewrite_table_ref`.
   595	fn rewrite_formula_with_table_rename(
   596	    text: &str,
   597	    old_canonical: &str,
   598	    new_name: &Arc<str>,
   599	) -> Option<String> {
   600	    let stripped = text.strip_prefix('=').unwrap_or(text);
   601	    let tokens = ql_formula_syntax::lex(stripped).ok()?;
   602	    let expr = ql_formula_syntax::parse(tokens).ok()?;
   603	    let rewritten = ql_formula_syntax::rewrite_table_ref(&expr, old_canonical, new_name);
   604	    if rewritten == expr {
   605	        return None;
   606	    }
   607	    let printed = ql_formula_syntax::print(&rewritten);
   608	    let with_eq = if text.starts_with('=') {
   609	        format!("={printed}")
   610	    } else {
   611	        printed
   612	    };
   613	    Some(with_eq)
   614	}
   615	
   616	/// Report for [`repair_table_rename_chain`].
   617	#[derive(Debug, Clone, Default)]
   618	pub struct TableRepairReport {
   619	    pub formulas_rewritten: usize,
   620	    pub table_rewrites: Vec<TableRewriteSummary>,
   621	    pub ambiguous_rules_skipped: Vec<TableAmbiguousSkip>,
   622	}
   623	
   624	/// Per-table summary line in [`TableRepairReport`].
   625	#[derive(Debug, Clone)]
   626	pub struct TableRewriteSummary {
   627	    pub current_canonical: String,
   628	    pub current_display_name: String,
   629	    pub historic_canonicals: Vec<String>,
   630	}
   631	
   632	/// Skipped table rule due to current-holder ambiguity.
   633	#[derive(Debug, Clone)]
   634	pub struct TableAmbiguousSkip {
   635	    pub origin_table_current_canonical: String,
   636	    pub historic_canonical: String,
   637	}

codex
The wrapper itself is a straight immutable read of the session log and mutable workbook pass. One stale contract surfaced outside the wrapper already: `ql_oplog::replay_into` docs still mention a `ReplayError::At` wrapper that no longer exists; I’m checking whether that is just documentation drift or affects the new error surface.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '720,850p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   720	            //
   721	            // Post-closure: idempotent skip when the table is gone. This
   722	            // mirrors the `apply_rename_table` policy at lines 802-820
   723	            // (advisory-skip on missing source) — same bug class, same
   724	            // fix shape.
   725	            let canonical = name.to_ascii_uppercase();
   726	            let _ = workbook.tables_mut().remove(canonical.as_str());
   727	            Ok(())
   728	        }
   729	        Op::RenameTable { old_name, new_name } => {
   730	            apply_rename_table(workbook, index, old_name, new_name)
   731	        }
   732	        Op::RenameColumn {
   733	            table,
   734	            old_name,
   735	            new_name,
   736	        } => apply_rename_column(workbook, index, table, old_name, new_name),
   737	        Op::ResizeTable {
   738	            name,
   739	            new_rows,
   740	            new_cols,
   741	            added_columns,
   742	            removed_columns,
   743	        } => apply_resize_table(
   744	            workbook,
   745	            index,
   746	            name,
   747	            *new_rows,
   748	            *new_cols,
   749	            added_columns,
   750	            removed_columns,
   751	        ),
   752	        // **W5-146 (Phase 4.9.J) + W5-151 (4.9.O MEDIUM-2 closure):**
   753	        // workbook-scope reference-mode change. Forward-compat
   754	        // unknown wire values surface `ReplayError::UnknownReferenceMode`
   755	        // with the captured string (mirrors the `LocaleWire::Unknown`
   756	        // path below).
   757	        Op::SetReferenceMode { mode } => match mode.clone().to_runtime() {
   758	            Ok(m) => {
   759	                workbook.set_reference_mode(m);
   760	                Ok(())
   761	            }
   762	            Err(found) => Err(ReplayError::UnknownReferenceMode { index, found }),
   763	        },
   764	        // **W5-146 (Phase 4.9.J):** workbook-scope locale change.
   765	        // Unknown wire values (forward-compat op-log file) surface
   766	        // `ReplayError::UnknownLocale` with the captured string.
   767	        Op::SetLocale { locale } => match locale.clone().to_runtime() {
   768	            Ok(loc) => {
   769	                workbook.set_locale(loc);
   770	                Ok(())
   771	            }
   772	            Err(found) => Err(ReplayError::UnknownLocale { index, found }),
   773	        },
   774	    }
   775	}
   776	
   777	/// **W5-119 (Phase 4.8.I) + Phase 5.3 step 4 (2026-05-20):**
   778	/// replay a `RenameTable`. Validates source exists, target name is
   779	/// available (TableTable + NameTable shared namespace), then re-keys
   780	/// the entry.
   781	///
   782	/// **Phase 5.3 step 4 (audit-locked, mirrors step 2 for
   783	/// RenameSheet):** two CRDT-merge scenarios required this handler to
   784	/// be made resilient:
   785	///
   786	/// 1. **Concurrent rename of same table** (last-wins): peer A
   787	///    renames T→T1, peer B (concurrent) renames T→T2. After Loro's
   788	///    causal merge, the second op's `old_name="T"` no longer
   789	///    resolves to a live table. Pre-step-4 this errored with
   790	///    `TableNotFound`. Post-step-4: if NO table at `old_canonical`
   791	///    exists but the workbook still has the post-first-rename
   792	///    name (T1 or T2 depending on causal order), we no-op the
   793	///    second rename if its `new_name` matches a current table
   794	///    (idempotency); otherwise, we treat the rename as advisory
   795	///    and skip if the table simply doesn't exist anywhere.
   796	///    Note: unlike sheets which carry stable IDs, tables are
   797	///    keyed by canonical name — there's no equivalent "rename
   798	///    current table to new_name" because we can't disambiguate
   799	///    which current table the wire op was thought to be acting on.
   800	///    Skip is the safer policy.
   801	///
   802	/// 2. **Cross-table target collision** (V1 LIMITATION — hard-fail):
   803	///    peer A renames T1→X, peer B renames T2→X (different sources,
   804	///    same target). After merge, the second op errors with
   805	///    `TableCreateRejected`. Pre-step-4-audit the handler attempted
   806	///    D-2-style auto-disambig (X → X(2)), but the step 4 audit
   807	///    (Codex+Opus HIGH-1) showed this produced silent formula-
   808	///    corruption when combined with `repair_table_rename_chain` —
   809	///    the repair keyed its chain by op's wire `new_name` and missed
   810	///    the auto-disambig'd canonical. Reverted to hard-reject. V2
   811	///    closure path: emit synthesized correction op at replay (would
   812	///    require API change to surface the disambig outcome to repair).
   813	fn apply_rename_table(
   814	    workbook: &mut Workbook,
   815	    index: usize,
   816	    old_name: &str,
   817	    new_name: &str,
   818	) -> Result<(), ReplayError> {
   819	    let old_canonical = old_name.to_ascii_uppercase();
   820	
   821	    // **Step 4 audit-locked policy** (V1 — tables): source table
   822	    // missing under CRDT merge means a concurrent peer renamed it.
   823	    // Three scenarios:
   824	    //  (a) the rename has already been applied as part of this peer's
   825	    //      causal-order replay (idempotent — current state has new_name).
   826	    //  (b) a concurrent peer renamed it to a DIFFERENT target (e.g.
   827	    //      peer A: T→T2; peer B: T→T3). Sheets handle this via stable
   828	    //      sheet IDs (rename current sheet to new_name); tables don't
   829	    //      have stable IDs (keyed by canonical name) so we can't
   830	    //      disambiguate which table this op was thought to be acting
   831	    //      on. Apply "advisory skip" — drop the second rename's intent
   832	    //      to avoid corruption.
   833	    //  (c) the source genuinely doesn't exist (corruption or stale op
   834	    //      against a never-existed table).
   835	    //
   836	    // V1 policy: skip silently in case (a) and (b); error only when
   837	    // there's clearly no related table state to interpret the op
   838	    // against (no current_canonical, no new_canonical, no plausible
   839	    // post-rename state).
   840	    //
   841	    // **V1 limitation (deferred to V2):** scenario (b) loses peer
   842	    // B's rename intent. Causality-aware tracking would let us tell
   843	    // "this op was authored when T existed locally; the table was
   844	    // since renamed to T2 by a concurrent peer; we COULD apply
   845	    // T2→T3." Today the only safe call is advisory-skip.
   846	    if workbook.tables().lookup(&old_canonical).is_none() {
   847	        let new_canonical = new_name.to_ascii_uppercase();
   848	        if workbook.tables().lookup(&new_canonical).is_some() {
   849	            // Case (a): idempotent — new_name already exists.
   850	            return Ok(());

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '430,720p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   430	            target,
   431	        } => {
   432	            let target = target
   433	                .to_target(name)
   434	                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
   435	            match scope {
   436	                None => {
   437	                    // Workbook-scoped (historical path).
   438	                    workbook.set_name(name, target).map_err(|source| {
   439	                        ReplayError::NameRejected {
   440	                            index,
   441	                            name: name.clone(),
   442	                            source,
   443	                        }
   444	                    })?;
   445	                }
   446	                Some(sheet) => {
   447	                    // **W5-92 (Phase 4.6.D):** sheet-scoped. Validate sheet
   448	                    // first so an unknown id surfaces as InvalidSheet, not
   449	                    // a panicking out-of-bounds index.
   450	                    let sheet_count = workbook.sheet_count();
   451	                    let sheet_ref =
   452	                        workbook
   453	                            .sheet_mut(*sheet)
   454	                            .ok_or(ReplayError::InvalidSheet {
   455	                                index,
   456	                                sheet: *sheet,
   457	                                sheet_count,
   458	                            })?;
   459	                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
   460	                        ReplayError::NameRejected {
   461	                            index,
   462	                            name: name.clone(),
   463	                            source,
   464	                        }
   465	                    })?;
   466	                }
   467	            }
   468	            Ok(())
   469	        }
   470	        Op::AddSheet { name, chunk_rows } => {
   471	            // **W5-93 (Phase 4.6.E closure):** route through the fallible
   472	            // `try_add_sheet_with_chunk_rows` and surface a clean
   473	            // `ReplayError::SheetNameRejected` on validation failure.
   474	            // Codex HIGH-1 flagged that the prior infallible path
   475	            // silently accepted duplicate-canonical names + reserved
   476	            // characters at the replay boundary too.
   477	            //
   478	            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
   479	            // duplicate-canonical-name. Phase 5 multi-peer scenario:
   480	            // peer A and peer B both call `add_sheet("S")` locally;
   481	            // each producer-side validates against its own snapshot
   482	            // (no collision visible); both emit
   483	            // `Op::AddSheet { name: "S", ... }`; merged log has both.
   484	            // First replay succeeds; second hits the duplicate guard.
   485	            // Pre-D-2 we rejected the second op (worse UX than Google
   486	            // Sheets, which auto-renames to S(2)). Now we walk
   487	            // `<name>(2)`, `<name>(3)`, … until we find a free name.
   488	            // `Empty` + `ReservedCharacter` still reject — auto-rename
   489	            // only resolves the collaboration-collision case.
   490	            let mut chosen = name.clone();
   491	            let mut suffix = 2u32;
   492	            const AUTO_RENAME_CEILING: u32 = 10_000;
   493	            loop {
   494	                match workbook.try_add_sheet_with_chunk_rows(chosen.clone(), *chunk_rows) {
   495	                    Ok(_) => return Ok(()),
   496	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   497	                        chosen = format!("{name}({suffix})");
   498	                        suffix += 1;
   499	                        if suffix > AUTO_RENAME_CEILING {
   500	                            // Pathological: more than 10k sheets all
   501	                            // share the same base name (impossible in
   502	                            // realistic workbooks; max sheets per
   503	                            // workbook is 65,535). Surface a clean
   504	                            // error rather than loop forever.
   505	                            return Err(ReplayError::SheetNameRejected {
   506	                                index,
   507	                                name: name.clone(),
   508	                                source: ql_storage::SheetNameError::Duplicate {
   509	                                    name: name.clone(),
   510	                                },
   511	                            });
   512	                        }
   513	                    }
   514	                    Err(other) => {
   515	                        return Err(ReplayError::SheetNameRejected {
   516	                            index,
   517	                            name: name.clone(),
   518	                            source: other,
   519	                        });
   520	                    }
   521	                }
   522	            }
   523	        }
   524	        Op::RenameSheet {
   525	            id,
   526	            old_name,
   527	            new_name,
   528	        } => {
   529	            // **W5-91 (Phase 4.6.C) + Phase 5.3 step 2 + step-2 audit
   530	            // closure (2026-05-20):** snapshot-vs-replay reconciliation
   531	            // + CRDT concurrent-rename policy.
   532	            //
   533	            // Two cases (post-step-2-audit-closure):
   534	            //
   535	            //   1. Current display name == new_name (EXACT equality, not
   536	            //      canonical) → idempotent. Replay-on-top-of-snapshot OR
   537	            //      concurrent peers picked the same target. No-op.
   538	            //
   539	            //      **MEDIUM-1 audit closure (Codex):** pre-closure the
   540	            //      idempotency check used canonical equality, which
   541	            //      silently dropped case-only renames (e.g. "Sheet1" →
   542	            //      "SHEET1"). Storage permits case-only renames and
   543	            //      updates the display field; replay must do the same.
   544	            //
   545	            //   2. Otherwise → apply the rename. Subsumes:
   546	            //      - pre-step-2 case 2 (current == old_name; fresh rename).
   547	            //      - pre-step-2 case 3 (current ∈ neither; **Phase 5.3
   548	            //        step 2 policy**, audit-locked: last-in-causal-order
   549	            //        wins under CRDT merge — apply to current sheet name.
   550	            //        Matches `crdt-data-model.md` § 311-334 last-wins
   551	            //        rule for SetName + same-cell writes).
   552	            //      - case-only rename (canonical equal, display differs).
   553	            //
   554	            // **HIGH-1 audit closure (Codex + Opus convergent):** rename
   555	            // target collision (`new_name` already used by a different
   556	            // sheet) auto-disambiguates via D-2-style suffix walk
   557	            // (`<name>(2)`, `<name>(3)`, …). Pre-closure this propagated
   558	            // `SheetRenameRejected` and hard-failed replay — same blast
   559	            // radius as the original pre-step-2 bug, just shifted to a
   560	            // different concurrent scenario (peer A: sheet0 S1→X, peer
   561	            // B: sheet1 S3→X, both valid locally, second errors on merge).
   562	            //
   563	            // D-2 (AddSheet auto-rename) set the precedent at
   564	            // `replay.rs:458-490`; RenameSheet now follows the same
   565	            // pattern for consistency. `Empty` + `ReservedCharacter`
   566	            // still reject — auto-rename only resolves collisions.
   567	            //
   568	            // Edge cases:
   569	            //   - Sheet doesn't exist at id → `InvalidSheet` (unchanged).
   570	            //   - `new_name` is empty → `SheetRenameRejected { source:
   571	            //     SheetNameError::Empty }` propagated from storage. The
   572	            //     wire op format does not enforce non-empty; producer-side
   573	            //     `WorkbookRuntime::rename_sheet` validates, but a
   574	            //     malformed log can still bypass that path. HIGH-2 audit
   575	            //     closure (Opus): documented here.
   576	            //   - Reserved-character in `new_name` → `SheetRenameRejected
   577	            //     { source: ReservedCharacter(_) }`. Same caveat as Empty.
   578	            const AUTO_RENAME_CEILING: u32 = 10_000;
   579	
   580	            let current = workbook.sheet(*id).map(|s| s.name().to_owned()).ok_or(
   581	                ReplayError::InvalidSheet {
   582	                    index,
   583	                    sheet: *id,
   584	                    sheet_count: workbook.sheet_count(),
   585	                },
   586	            )?;
   587	            if current == *new_name {
   588	                // Case 1: already at exact target display. No-op.
   589	                return Ok(());
   590	            }
   591	            // Case 2: apply rename, auto-disambiguating Duplicate via D-2
   592	            // pattern. Empty + ReservedCharacter still reject.
   593	            let mut chosen = new_name.clone();
   594	            let mut suffix = 2u32;
   595	            loop {
   596	                match workbook.rename_sheet(*id, chosen.clone()) {
   597	                    Ok(_) => return Ok(()),
   598	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   599	                        chosen = format!("{new_name}({suffix})");
   600	                        suffix += 1;
   601	                        if suffix > AUTO_RENAME_CEILING {
   602	                            return Err(ReplayError::SheetRenameRejected {
   603	                                index,
   604	                                id: *id,
   605	                                old_name: old_name.clone(),
   606	                                new_name: new_name.clone(),
   607	                                source: ql_storage::SheetNameError::Duplicate {
   608	                                    name: new_name.clone(),
   609	                                },
   610	                            });
   611	                        }
   612	                    }
   613	                    Err(other) => {
   614	                        return Err(ReplayError::SheetRenameRejected {
   615	                            index,
   616	                            id: *id,
   617	                            old_name: old_name.clone(),
   618	                            new_name: new_name.clone(),
   619	                            source: other,
   620	                        });
   621	                    }
   622	                }
   623	            }
   624	        }
   625	        Op::RegisterFormat { id, string } => {
   626	            // **W5-80:** route through `FormatTable::register_at` so
   627	            // collisions surface as `FormatRejected` (rather than the
   628	            // panic-on-duplicate behavior `intern` would have via the
   629	            // by_string fast path; `register_at` is the explicit-id form).
   630	            //
   631	            // Phase 5.2 D-1 step 4: `Op::RegisterFormat.id` is now
   632	            // `FormatIdWire`. Convert to `ql_storage::FormatId` via
   633	            // `to_storage()`. The pre-step-4 `legacy_from_u32` migration
   634	            // helper is no longer needed for the wire-replay path; it's
   635	            // reserved for envelope-load migration in step 5.
   636	            let fid = id.to_storage();
   637	            workbook
   638	                .formats_mut()
   639	                .register_at(fid, string.as_str())
   640	                .map_err(|e| ReplayError::FormatRejected {
   641	                    index,
   642	                    source: e.into(),
   643	                })?;
   644	            Ok(())
   645	        }
   646	        Op::SetCellFormat {
   647	            sheet,
   648	            row,
   649	            col,
   650	            id,
   651	        } => {
   652	            validate_cell(workbook, *sheet, *row, *col, index)?;
   653	            // **W5-80:** require the id to be registered. Catches
   654	            // producer bugs where `SetCellFormat` was emitted without
   655	            // a preceding `RegisterFormat`. `None` means clear.
   656	            if let Some(wire_id) = id {
   657	                // Phase 5.2 D-1 step 4: same wire→storage conversion.
   658	                let fid = wire_id.to_storage();
   659	                if workbook.formats().lookup(fid).is_none() {
   660	                    return Err(ReplayError::FormatNotRegistered { index, id: fid });
   661	                }
   662	                workbook
   663	                    .sheet_mut(*sheet)
   664	                    .expect("sheet validated above")
   665	                    .format_overlay_mut()
   666	                    .set(*row, *col, fid);
   667	            } else {
   668	                workbook
   669	                    .sheet_mut(*sheet)
   670	                    .expect("sheet validated above")
   671	                    .format_overlay_mut()
   672	                    .clear(*row, *col);
   673	            }
   674	            Ok(())
   675	        }
   676	        Op::BatchCommit { ops } => {
   677	            for inner_op in ops {
   678	                // Phase 2A.3.a: nested ops flatten to the parent's index
   679	                // for error reporting. Phase 5+ may extend with
   680	                // (outer, inner) tuple indexing once the producer side
   681	                // emits nested commits in practice.
   682	                apply_op(inner_op, workbook, index)?;
   683	            }
   684	            Ok(())
   685	        }
   686	        Op::CreateTable {
   687	            name,
   688	            sheet,
   689	            top_row,
   690	            top_col,
   691	            rows,
   692	            cols,
   693	            has_header,
   694	            has_totals,
   695	            column_names,
   696	        } => apply_create_table(
   697	            workbook,
   698	            index,
   699	            name,
   700	            *sheet,
   701	            *top_row,
   702	            *top_col,
   703	            *rows,
   704	            *cols,
   705	            *has_header,
   706	            *has_totals,
   707	            column_names,
   708	        ),
   709	        Op::DropTable { name } => {
   710	            // **Phase 5.3 step 5 megaudit closure (Codex HIGH + Opus-A
   711	            // V1 LIM #4, 2026-05-20):** advisory-skip on missing source
   712	            // under CRDT merge. Pre-closure the handler hard-failed via
   713	            // `TableNotFound` when the table was already gone, producing
   714	            // an order-dependent failure:
   715	            //   drop(T) then rename(T→T2) → OK (rename advisory-skips)
   716	            //   rename(T→T2) then drop(T) → Err(TableNotFound)
   717	            // The two orderings are logically equivalent (concurrent
   718	            // ops on the same table; final state: table absent), so the
   719	            // hard-fail in one direction is a CRDT-merge regression.
   720	            //

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '880,1160p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   880	        origin
   881	            .append_op(Op::AddSheet {
   882	                name: "S".to_owned(),
   883	                chunk_rows: 16384,
   884	            })
   885	            .unwrap();
   886	        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   887	
   888	        let bytes = origin.export_bytes().unwrap();
   889	        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
   890	        assert_eq!(reborn.peer_id(), PeerId::new(2));
   891	        assert_eq!(reborn.op_count(), 2);
   892	    }
   893	
   894	    #[test]
   895	    fn merge_bytes_grows_log_with_remote_ops() {
   896	        // Two peers, shared base, each appends; one merges the other.
   897	        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
   898	        base.append_op(Op::AddSheet {
   899	            name: "S".to_owned(),
   900	            chunk_rows: 16384,
   901	        })
   902	        .unwrap();
   903	        let base_bytes = base.export_bytes().unwrap();
   904	
   905	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
   906	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
   907	
   908	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
   909	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
   910	
   911	        // Peer A pulls peer B's bytes.
   912	        let b_bytes = peer_b.export_bytes().unwrap();
   913	        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
   914	        assert!(
   915	            merged_count >= 3,
   916	            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
   917	        );
   918	    }
   919	
   920	    #[test]
   921	    fn debug_impl_includes_peer_id_and_count() {
   922	        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
   923	        s.append_op(put_value(0, 0, 0, 1.0)).ok();
   924	        let d = format!("{s:?}");
   925	        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
   926	        assert!(d.contains("op_count"), "Debug must include op_count: {d}");
   927	    }
   928	
   929	    #[test]
   930	    fn peer_id_is_wired_to_underlying_loro_doc() {
   931	        // Regression: prior to Phase 5.2.b the PeerId was stored on
   932	        // CollabSession but never passed to LoroDoc::set_peer_id, so
   933	        // op attribution at the CRDT layer used Loro's random
   934	        // per-doc peer id. After 5.2.b the configured PeerId MUST
   935	        // appear as the underlying log's peer_id().
   936	        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
   937	        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
   938	        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
   939	    }
   940	
   941	    #[test]
   942	    fn from_snapshot_overrides_imported_peer_id() {
   943	        // The origin session writes ops under PeerId(11). The reborn
   944	        // session imports the snapshot but uses its own PeerId(22)
   945	        // for future appends — the imported ops keep their original
   946	        // attribution (Loro semantics), but log.peer_id() reflects
   947	        // the reborn's configured PeerId.
   948	        //
   949	        // Codex/Opus 5.2.b audit caught: the prior version exported
   950	        // an empty origin, so the "imported ops retain peer 11"
   951	        // promise was never exercised. Now we append before export
   952	        // and assert the imported op survives the peer-id change.
   953	        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
   954	        origin
   955	            .append_op(Op::AddSheet {
   956	                name: "S".to_owned(),
   957	                chunk_rows: 16384,
   958	            })
   959	            .unwrap();
   960	        let bytes = origin.export_bytes().unwrap();
   961	
   962	        let mut reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
   963	        assert_eq!(reborn.op_log().peer_id(), 22);
   964	        assert_eq!(
   965	            reborn.op_count(),
   966	            1,
   967	            "imported op must survive peer-id swap"
   968	        );
   969	        // Reborn can append under its new peer id.
   970	        reborn.append_op(put_value(0, 0, 0, 99.0)).unwrap();
   971	        assert_eq!(reborn.op_count(), 2);
   972	        assert_eq!(reborn.op_log().peer_id(), 22);
   973	    }
   974	
   975	    #[test]
   976	    fn presence_round_trip_within_one_session() {
   977	        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
   978	        // No presence yet.
   979	        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
   980	        assert!(s.peers_with_presence().unwrap().is_empty());
   981	
   982	        // Set our own.
   983	        let state = PresenceState {
   984	            sheet: 1,
   985	            row: 10,
   986	            col: 5,
   987	            selection_end_row: 12,
   988	            selection_end_col: 7,
   989	            typing: true,
   990	        };
   991	        s.update_presence(state).unwrap();
   992	
   993	        let read = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
   994	        assert_eq!(read, state);
   995	        let peers = s.peers_with_presence().unwrap();
   996	        assert_eq!(peers, vec![PeerId::new(7)]);
   997	
   998	        // Overwrite (LWW per key).
   999	        let state2 = PresenceState::at_cell(0, 0, 0);
  1000	        s.update_presence(state2).unwrap();
  1001	        let read2 = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
  1002	        assert_eq!(read2, state2);
  1003	        assert_eq!(s.peers_with_presence().unwrap().len(), 1);
  1004	
  1005	        // Clear.
  1006	        s.clear_presence().unwrap();
  1007	        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
  1008	        assert!(s.peers_with_presence().unwrap().is_empty());
  1009	    }
  1010	
  1011	    #[test]
  1012	    fn presence_two_peer_merge_preserves_both() {
  1013	        // Both peers fork from the same empty base. Each writes
  1014	        // its own presence; one merges the other's snapshot. After
  1015	        // merge BOTH peers see BOTH presences (LoroMap LWW per key
  1016	        // keeps distinct keys).
  1017	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  1018	        let base_bytes = base.export_bytes().unwrap();
  1019	
  1020	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
  1021	        peer_a
  1022	            .update_presence(PresenceState::at_cell(0, 3, 4))
  1023	            .unwrap();
  1024	
  1025	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
  1026	        peer_b
  1027	            .update_presence(PresenceState::at_cell(1, 100, 200))
  1028	            .unwrap();
  1029	
  1030	        // Peer A merges peer B's snapshot.
  1031	        let b_bytes = peer_b.export_bytes().unwrap();
  1032	        peer_a.merge_bytes(&b_bytes).unwrap();
  1033	
  1034	        // Peer A now sees BOTH presences.
  1035	        let a = peer_a.peer_presence(PeerId::new(0x0a)).unwrap().unwrap();
  1036	        assert_eq!(a, PresenceState::at_cell(0, 3, 4));
  1037	        let b = peer_a.peer_presence(PeerId::new(0x0b)).unwrap().unwrap();
  1038	        assert_eq!(b, PresenceState::at_cell(1, 100, 200));
  1039	
  1040	        let mut peers = peer_a.peers_with_presence().unwrap();
  1041	        peers.sort();
  1042	        assert_eq!(peers, vec![PeerId::new(0x0a), PeerId::new(0x0b)]);
  1043	    }
  1044	
  1045	    #[test]
  1046	    fn presence_merge_is_commutative() {
  1047	        // Audit-discipline closure (Codex 5.6 V1 LOW-1): the
  1048	        // existing 2-peer test only verifies one merge direction.
  1049	        // This test exercises BOTH directions and asserts the
  1050	        // final state is identical.
  1051	        fn make_pair() -> (CollabSession, CollabSession) {
  1052	            let base = CollabSession::new(PeerId::new(1)).unwrap();
  1053	            let base_bytes = base.export_bytes().unwrap();
  1054	            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
  1055	            a.update_presence(PresenceState::at_cell(0, 1, 2)).unwrap();
  1056	            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
  1057	            b.update_presence(PresenceState::at_cell(3, 4, 5)).unwrap();
  1058	            (a, b)
  1059	        }
  1060	
  1061	        // Direction 1: A merges B.
  1062	        let (mut a1, b1) = make_pair();
  1063	        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();
  1064	
  1065	        // Direction 2: B merges A (fresh pair to avoid state pollution).
  1066	        let (a2, mut b2) = make_pair();
  1067	        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();
  1068	
  1069	        // Both ended states must agree on the peer set + per-peer
  1070	        // values.
  1071	        let mut a1_peers = a1.peers_with_presence().unwrap();
  1072	        let mut b2_peers = b2.peers_with_presence().unwrap();
  1073	        a1_peers.sort();
  1074	        b2_peers.sort();
  1075	        assert_eq!(a1_peers, b2_peers);
  1076	        for peer in a1_peers {
  1077	            assert_eq!(
  1078	                a1.peer_presence(peer).unwrap(),
  1079	                b2.peer_presence(peer).unwrap(),
  1080	                "peer {peer:?} state must agree across merge directions"
  1081	            );
  1082	        }
  1083	    }
  1084	
  1085	    #[test]
  1086	    fn presence_tombstone_propagates_through_merge() {
  1087	        // Audit-discipline closure (Codex 5.6 V1 LOW-1 / C4): peer A
  1088	        // sets presence, B merges + sees A. Then A clears its
  1089	        // presence and re-exports. B merges the cleared snapshot
  1090	        // and MUST observe A as gone.
  1091	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  1092	        let base_bytes = base.export_bytes().unwrap();
  1093	
  1094	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
  1095	        peer_a
  1096	            .update_presence(PresenceState::at_cell(0, 0, 0))
  1097	            .unwrap();
  1098	
  1099	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
  1100	        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
  1101	        assert!(
  1102	            peer_b.peer_presence(PeerId::new(0xaa)).unwrap().is_some(),
  1103	            "B must initially see A's presence after first merge"
  1104	        );
  1105	
  1106	        // A leaves the session.
  1107	        peer_a.clear_presence().unwrap();
  1108	
  1109	        // B pulls A's new state.
  1110	        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
  1111	        assert_eq!(
  1112	            peer_b.peer_presence(PeerId::new(0xaa)).unwrap(),
  1113	            None,
  1114	            "B must see A as cleared after merging the tombstone"
  1115	        );
  1116	    }
  1117	
  1118	    #[test]
  1119	    fn undo_redo_local_appends() {
  1120	        // Append two ops, undo both, redo both. Verify can_undo /
  1121	        // can_redo / undo_count / redo_count track correctly.
  1122	        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
  1123	        assert!(!s.can_undo());
  1124	        assert!(!s.can_redo());
  1125	        assert_eq!(s.undo_count(), 0);
  1126	        assert_eq!(s.redo_count(), 0);
  1127	
  1128	        s.append_op(Op::AddSheet {
  1129	            name: "S1".to_owned(),
  1130	            chunk_rows: 16384,
  1131	        })
  1132	        .unwrap();
  1133	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1134	        assert!(s.can_undo());
  1135	        assert_eq!(s.undo_count(), 2);
  1136	        assert_eq!(s.redo_count(), 0);
  1137	
  1138	        // Undo the second op.
  1139	        assert!(s.undo().unwrap());
  1140	        assert_eq!(s.undo_count(), 1);
  1141	        assert_eq!(s.redo_count(), 1);
  1142	        assert!(s.can_redo());
  1143	
  1144	        // Undo the first op.
  1145	        assert!(s.undo().unwrap());
  1146	        assert_eq!(s.undo_count(), 0);
  1147	        assert_eq!(s.redo_count(), 2);
  1148	        assert!(!s.can_undo());
  1149	
  1150	        // Undo on empty stack returns false.
  1151	        assert!(!s.undo().unwrap());
  1152	
  1153	        // Redo both back.
  1154	        assert!(s.redo().unwrap());
  1155	        assert!(s.redo().unwrap());
  1156	        assert_eq!(s.undo_count(), 2);
  1157	        assert_eq!(s.redo_count(), 0);
  1158	        assert!(!s.can_redo());
  1159	        assert!(!s.redo().unwrap());
  1160	    }

exec
/bin/zsh -lc "rg -n \"OpLog::new\\(\\).*export_bytes|from_snapshot|shared base|shared_base|session_with_seed|let mut peer_[ab]|let mut base_log|base_bytes|merge_bytes\" quantbook-engine/crates/ql-collab/tests quantbook-engine/crates/ql-collab/src/session.rs -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/session.rs:35://! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
quantbook-engine/crates/ql-collab/src/session.rs:36://!   shared base snapshot (used by both peers in the D-4 probe
quantbook-engine/crates/ql-collab/src/session.rs:42://! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
quantbook-engine/crates/ql-collab/src/session.rs:44://!   `OpLog::merge_bytes`.
quantbook-engine/crates/ql-collab/src/session.rs:107:    /// the error were already `merge_bytes`'d into the local
quantbook-engine/crates/ql-collab/src/session.rs:156:/// and call `merge_bytes` to incorporate remote ops. All sessions
quantbook-engine/crates/ql-collab/src/session.rs:184:    /// Use this when no shared base snapshot exists yet (the first
quantbook-engine/crates/ql-collab/src/session.rs:248:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:286:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:287:        Ok(self.log.merge_bytes(bytes)?)
quantbook-engine/crates/ql-collab/src/session.rs:291:    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
quantbook-engine/crates/ql-collab/src/session.rs:292:    /// OR by `OpLog::merge_bytes` directly).
quantbook-engine/crates/ql-collab/src/session.rs:311:    /// rebuilding a workbook after a `merge_bytes` — `sync_workbook`
quantbook-engine/crates/ql-collab/src/session.rs:318:    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:326:    /// let mut session = CollabSession::from_snapshot(peer_id, &bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:327:    /// session.merge_bytes(&peer_b_bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:348:    /// repair is NOT auto-invoked by `merge_bytes` (callers may want
quantbook-engine/crates/ql-collab/src/session.rs:513:                    self.log.merge_bytes(&bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:578:    /// from other peers (merged via `merge_bytes`) are NOT
quantbook-engine/crates/ql-collab/src/session.rs:727:    /// Use after [`from_snapshot`] when the caller wants a clean
quantbook-engine/crates/ql-collab/src/session.rs:735:    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:878:    fn from_snapshot_reconstructs_op_count() {
quantbook-engine/crates/ql-collab/src/session.rs:889:        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:895:    fn merge_bytes_grows_log_with_remote_ops() {
quantbook-engine/crates/ql-collab/src/session.rs:896:        // Two peers, shared base, each appends; one merges the other.
quantbook-engine/crates/ql-collab/src/session.rs:903:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:905:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:908:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:913:        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:942:    fn from_snapshot_overrides_imported_peer_id() {
quantbook-engine/crates/ql-collab/src/session.rs:962:        let mut reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1018:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1020:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1025:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1032:        peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1053:            let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1054:            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1056:            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1063:        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1067:        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1092:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1094:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1099:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1100:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1110:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1461:        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1480:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1482:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1485:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1487:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1500:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1611:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1613:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1615:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1780:        let base_bytes = base.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1782:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1783:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1796:        peer_b.merge_bytes(&received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1806:        peer_a.merge_bytes(&b_received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1868:    fn sweep_presence_after_from_snapshot_gives_clean_slate() {
quantbook-engine/crates/ql-collab/src/session.rs:1877:        let mut reborn = CollabSession::from_snapshot(PeerId::new(0xa), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1915:        // For from_snapshot we need a valid empty snapshot first.
quantbook-engine/crates/ql-collab/src/session.rs:1918:        let result = CollabSession::from_snapshot(PeerId::new(u64::MAX), &bytes);
quantbook-engine/crates/ql-collab/src/session.rs:1921:            "from_snapshot(u64::MAX) must fail; got {result:?}"
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:12://!   1. Build shared base log.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:15://!   4. Exchange via `export_bytes` + `merge_bytes`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:32:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:33:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:62:    let mut peer_a = fork_with_peer(base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:64:    let mut peer_b = fork_with_peer(base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:66:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:138:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:155:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:165:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:189:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:206:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:216:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:239:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:255:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:265:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:275:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:375:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:391:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:402:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:419:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:451:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:463:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:473:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:511:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:513:    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:516:        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:522:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:524:    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:527:        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:613:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:629:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:646:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:656:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:765:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:19:fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:20:    let mut log = OpLog::import_bytes(base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:66:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:73:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:83:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:160:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:167:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:175:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:197:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:233:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:240:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:247:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:269:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:283:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:293:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:317:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:327:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:336:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:356:    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:363:    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:372:    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:6://! non-test callers, so end-users running `merge_bytes` +
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:41:fn shared_base_bytes() -> Vec<u8> {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:58:/// Build a fresh session at `peer_id` from the shared base bytes.
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:59:fn session_with_seed(peer_id: u64, base_bytes: &[u8]) -> CollabSession {
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:60:    CollabSession::from_snapshot(PeerId::new(peer_id), base_bytes).unwrap()
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:80:    let base = shared_base_bytes();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:81:    let session = session_with_seed(PEER_A_ID, &base);
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:109:    // Both peers fork from the same shared base bytes (stable Loro
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:111:    let base = shared_base_bytes();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:112:    let mut session_a = session_with_seed(PEER_A_ID, &base);
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:113:    let mut session_b = session_with_seed(PEER_B_ID, &base);
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:136:    session_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:171:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:191:    let base_bytes = base_log.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:193:    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:194:    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:215:    session_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:243:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:276:    let base_bytes = base_log.export_bytes().unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:278:    let mut session_a = CollabSession::from_snapshot(PeerId::new(PEER_A_ID), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:279:    let mut session_b = CollabSession::from_snapshot(PeerId::new(PEER_B_ID), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs:295:    session_a.merge_bytes(&b_bytes).unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '460,820p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   460	        let Some(transport) = self.transport.as_mut() else {
   461	            return Ok(false);
   462	        };
   463	        let bytes = self.log.export_bytes()?;
   464	        transport.send(&bytes)?;
   465	        Ok(true)
   466	    }
   467	
   468	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
   469	    /// the attached transport's recv queue up to a default cap
   470	    /// (`DEFAULT_POLL_REMOTE_LIMIT = 64` blobs), merging each
   471	    /// blob into the local `OpLog`. Returns the number of blobs
   472	    /// merged.
   473	    ///
   474	    /// For unbounded drain (or a different cap), use
   475	    /// [`poll_remote_with_limit`]. The cap prevents one
   476	    /// `poll_remote` call from starving the calling thread when
   477	    /// a future externally-fed transport is producing faster
   478	    /// than we drain.
   479	    ///
   480	    /// Returns `Ok(0)` if no transport attached.
   481	    /// `TransportError::Closed` is handled gracefully — the
   482	    /// trait contract guarantees Closed only after the queue
   483	    /// drains, so the merge count reflects all queued blobs and
   484	    /// the function returns `Ok(merged)`. `Io` errors propagate
   485	    /// as `CollabSessionError::Transport` — any merges before
   486	    /// the error already persist in the local `OpLog`.
   487	    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
   488	        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
   489	    }
   490	
   491	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
   492	    /// [`poll_remote`] but with an explicit per-call cap on the
   493	    /// number of blobs to drain.
   494	    ///
   495	    /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
   496	    /// blobs are queued — call again with a non-zero cap).
   497	    ///
   498	    /// Returns `Ok(merged)` where `merged <= max_blobs`. If the
   499	    /// returned count equals `max_blobs`, more blobs may still
   500	    /// be queued — call again. If less, the queue drained
   501	    /// (either empty or transport reported `Closed`).
   502	    pub fn poll_remote_with_limit(
   503	        &mut self,
   504	        max_blobs: usize,
   505	    ) -> Result<usize, CollabSessionError> {
   506	        let Some(transport) = self.transport.as_mut() else {
   507	            return Ok(0);
   508	        };
   509	        let mut merged = 0usize;
   510	        while merged < max_blobs {
   511	            match transport.try_recv() {
   512	                Ok(Some(bytes)) => {
   513	                    self.log.merge_bytes(&bytes)?;
   514	                    merged += 1;
   515	                }
   516	                Ok(None) => break,
   517	                Err(TransportError::Closed) => {
   518	                    // Trait contract: Closed only after queue drains. Any
   519	                    // already-drained bytes are accounted in `merged`.
   520	                    // Treat as graceful end-of-stream.
   521	                    break;
   522	                }
   523	                Err(other) => return Err(CollabSessionError::Transport(other)),
   524	            }
   525	        }
   526	        Ok(merged)
   527	    }
   528	
   529	    /// **Phase 5.6 V1 (2026-05-19):** write this session's own
   530	    /// presence state into the shared `"presence"` LoroMap.
   531	    ///
   532	    /// Uses the session's `PeerId` as the map key (16-hex
   533	    /// `Display` form). Subsequent calls overwrite the previous
   534	    /// value (LWW per peer); merges with other peers'
   535	    /// presence writes preserve all distinct peers.
   536	    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
   537	        let key = presence::peer_key(self.peer_id);
   538	        let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
   539	        self.log.presence_set(&key, &json)?;
   540	        Ok(())
   541	    }
   542	
   543	    /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
   544	    /// presence state. Returns `Ok(None)` if the peer has never
   545	    /// updated its presence in this session (or has been removed
   546	    /// via `clear_presence`).
   547	    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
   548	        let key = presence::peer_key(peer);
   549	        let Some(json) = self.log.presence_get(&key)? else {
   550	            return Ok(None);
   551	        };
   552	        let state: PresenceState =
   553	            serde_json::from_str(&json).map_err(|source| PresenceError::Deserialize {
   554	                peer_key: key,
   555	                source,
   556	            })?;
   557	        Ok(Some(state))
   558	    }
   559	
   560	    /// **Phase 5.6 V1 (2026-05-19):** remove this session's own
   561	    /// presence entry from the shared map. Use this when the
   562	    /// peer leaves the session (window close, disconnect). After
   563	    /// removal, other peers' `peer_presence(self_id)` returns
   564	    /// `Ok(None)`.
   565	    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
   566	        let key = presence::peer_key(self.peer_id);
   567	        self.log.presence_remove(&key)?;
   568	        Ok(())
   569	    }
   570	
   571	    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
   572	    /// local op. Loro's `UndoManager` semantically inverts it by
   573	    /// appending an inverse op (NOT by physical removal). Returns
   574	    /// `Ok(true)` if an undo stack item was consumed,
   575	    /// `Ok(false)` if the stack was empty.
   576	    ///
   577	    /// Local-only per Loro's `UndoManager` contract — remote ops
   578	    /// from other peers (merged via `merge_bytes`) are NOT
   579	    /// affected.
   580	    ///
   581	    /// Presence updates are excluded from the undo stack by
   582	    /// construction (see `CollabSession::new`), so cursor movements
   583	    /// don't consume undo slots.
   584	    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
   585	        Ok(self.undo.undo()?)
   586	    }
   587	
   588	    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
   589	    /// Returns `Ok(true)` if a redo stack item was consumed,
   590	    /// `Ok(false)` if the stack was empty.
   591	    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
   592	        Ok(self.undo.redo()?)
   593	    }
   594	
   595	    /// **Phase 5.4 V1 (2026-05-19):** true iff the undo stack has
   596	    /// at least one item.
   597	    pub fn can_undo(&self) -> bool {
   598	        self.undo.can_undo()
   599	    }
   600	
   601	    /// **Phase 5.4 V1 (2026-05-19):** true iff the redo stack has
   602	    /// at least one item.
   603	    pub fn can_redo(&self) -> bool {
   604	        self.undo.can_redo()
   605	    }
   606	
   607	    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
   608	    /// on the undo stack.
   609	    pub fn undo_count(&self) -> usize {
   610	        self.undo.undo_count()
   611	    }
   612	
   613	    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
   614	    /// on the redo stack.
   615	    pub fn redo_count(&self) -> usize {
   616	        self.undo.redo_count()
   617	    }
   618	
   619	    /// **Phase 5.4 V1 (2026-05-19):** clear both undo and redo
   620	    /// stacks. Use when starting a fresh logical session (e.g.
   621	    /// opening a new workbook tab while reusing the
   622	    /// `CollabSession` shell).
   623	    pub fn clear_undo_stack(&self) {
   624	        self.undo.clear();
   625	    }
   626	
   627	    /// **Phase 5.4 V2 V1 (2026-05-19):** begin a new undo group.
   628	    /// All subsequent appends merge into a SINGLE undo unit on
   629	    /// the undo stack; one `undo()` call after `end_undo_group`
   630	    /// reverts all of them as a unit. Useful for atomic multi-
   631	    /// cell operations (paste, fill-down, table import) where
   632	    /// per-cell undo would surprise the user.
   633	    ///
   634	    /// Pair with [`end_undo_group`]. Calling `start_undo_group`
   635	    /// while a group is already open returns
   636	    /// `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
   637	    /// deterministically (Loro 1.12.0 `loro-internal::undo:674-688`).
   638	    /// Nesting is NOT supported.
   639	    ///
   640	    /// **Caller pitfall — panic / error mid-group:** if a call
   641	    /// between `start_undo_group` and `end_undo_group` returns
   642	    /// `Err` (via `?`) or panics, the group stays open and the
   643	    /// next `start_undo_group` will fail with the deterministic
   644	    /// `UndoGroupAlreadyStarted` error. **Prefer
   645	    /// [`start_undo_group_scoped`]** (Phase 5.4 V2 V1.1 — RAII
   646	    /// guard that auto-closes the group on scope exit, including
   647	    /// on panic-unwind) over manual start/end pairing for any
   648	    /// code path that can return `Err` mid-group.
   649	    ///
   650	    /// Closes GAP-C-04's "command grouping" half. Merge-interval
   651	    /// auto-grouping is the complement — see
   652	    /// [`set_undo_merge_interval`].
   653	    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
   654	        Ok(self.undo.group_start()?)
   655	    }
   656	
   657	    /// **Phase 5.4 V2 V1 (2026-05-19):** close the current undo
   658	    /// group started by [`start_undo_group`]. All appends since
   659	    /// the matching `start_undo_group` are now a single undo
   660	    /// unit.
   661	    ///
   662	    /// Loro's `group_end` is infallible; calling it without a
   663	    /// matching `group_start` is a no-op. Safe to call in `Drop`
   664	    /// guards.
   665	    pub fn end_undo_group(&mut self) {
   666	        self.undo.group_end();
   667	    }
   668	
   669	    /// **Phase 5.4 V2 V1 (2026-05-19):** set the auto-merge
   670	    /// interval in milliseconds. Consecutive changes within this
   671	    /// window auto-merge into a single undo unit — useful for
   672	    /// rapid typing where per-keystroke undo is too granular.
   673	    ///
   674	    /// `0` (Loro default) disables auto-merge. Negative values
   675	    /// behave as `0` (Loro stores the raw `i64` and the compare
   676	    /// `now - last_undo_time < interval_ms` is false for any
   677	    /// non-negative elapsed time vs a negative threshold). Phase
   678	    /// 5.4 V1 used the default; V2 V1 callers can opt in via
   679	    /// this method. Recommended IDE settings: 200-500 ms for
   680	    /// typing windows.
   681	    ///
   682	    /// Orthogonal to [`start_undo_group`] / [`end_undo_group`] —
   683	    /// explicit groups take precedence over the interval.
   684	    pub fn set_undo_merge_interval(&mut self, interval_ms: i64) {
   685	        self.undo.set_merge_interval(interval_ms);
   686	    }
   687	
   688	    /// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII variant of
   689	    /// [`start_undo_group`]. Returns an [`UndoGroupGuard`] that
   690	    /// holds a `&mut` borrow of this session; `Drop` on the
   691	    /// guard automatically calls [`end_undo_group`].
   692	    ///
   693	    /// Panic-safe: if any code between this call and the guard's
   694	    /// drop panics (including the body of a paste / fill-down /
   695	    /// table-import operation), the guard's `Drop` still runs
   696	    /// during unwinding and closes the group cleanly. Compare
   697	    /// the manual start/end pattern which leaks group state on
   698	    /// panic.
   699	    ///
   700	    /// Usage:
   701	    /// ```ignore
   702	    /// {
   703	    ///     let mut guard = session.start_undo_group_scoped()?;
   704	    ///     for (row, col, value) in paste_data {
   705	    ///         guard.append_op(Op::PutValue { sheet: 0, row, col, value })?;
   706	    ///     }
   707	    ///     // guard drops here → end_undo_group runs.
   708	    /// }
   709	    /// // All N PutValue ops are now one undo unit.
   710	    /// ```
   711	    ///
   712	    /// The guard implements `Deref<Target = CollabSession>` +
   713	    /// `DerefMut`, so all of `CollabSession`'s methods are
   714	    /// callable directly on the guard.
   715	    ///
   716	    /// Errors from [`start_undo_group`] propagate (nested call
   717	    /// returns `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`).
   718	    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
   719	        self.start_undo_group()?;
   720	        Ok(UndoGroupGuard { session: self })
   721	    }
   722	
   723	    /// **Phase 5.6 V2 (2026-05-19):** clear ALL presence entries
   724	    /// from the shared `"presence"` LoroMap. Returns the number
   725	    /// of entries removed.
   726	    ///
   727	    /// Use after [`from_snapshot`] when the caller wants a clean
   728	    /// slate — without this call, presence entries persist across
   729	    /// `.qbook` save/load (V1 known limitation: presence lives in
   730	    /// the same `LoroDoc` whose snapshot is wrapped into the
   731	    /// post-Tier-D3 `oplog.bin` file format).
   732	    ///
   733	    /// Typical pattern for "rejoin with clean presence":
   734	    /// ```ignore
   735	    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
   736	    /// s.sweep_presence()?;
   737	    /// // Presence is empty; first update_presence sets self fresh.
   738	    /// ```
   739	    ///
   740	    /// Caller-opt-in by design: a session that WANTS to see other
   741	    /// peers' last-known positions (e.g. an IDE rejoining a live
   742	    /// collab session) skips the sweep.
   743	    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
   744	        let keys = self.log.presence_peers();
   745	        let count = keys.len();
   746	        for key in keys {
   747	            self.log.presence_remove(&key)?;
   748	        }
   749	        Ok(count)
   750	    }
   751	
   752	    /// **Phase 5.6 V1 (2026-05-19):** list every peer with a
   753	    /// presence entry in the shared map.
   754	    ///
   755	    /// Order is Loro's iteration order. Sort the result if you
   756	    /// need determinism.
   757	    ///
   758	    /// Returns `Err(CollabSessionError::Presence(PresenceError::PeerKeyParse))`
   759	    /// if a key in the map can't be parsed as a `PeerId` (only
   760	    /// reachable if a future writer uses an incompatible
   761	    /// encoding).
   762	    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
   763	        let keys = self.log.presence_peers();
   764	        let mut out = Vec::with_capacity(keys.len());
   765	        for k in keys {
   766	            out.push(presence::parse_peer_key(&k)?);
   767	        }
   768	        Ok(out)
   769	    }
   770	}
   771	
   772	impl std::fmt::Debug for CollabSession {
   773	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
   774	        f.debug_struct("CollabSession")
   775	            .field("peer_id", &self.peer_id)
   776	            .field("op_count", &self.log.len())
   777	            .field("undo_count", &self.undo.undo_count())
   778	            .field("redo_count", &self.undo.redo_count())
   779	            .field("transport_attached", &self.transport.is_some())
   780	            .finish()
   781	    }
   782	}
   783	
   784	/// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII guard returned by
   785	/// [`CollabSession::start_undo_group_scoped`]. `Drop` calls
   786	/// `end_undo_group` automatically — runs on scope exit, on `?`
   787	/// propagation, AND on panic-unwind. Use this in any code path
   788	/// that can fail mid-group; the manual `start_undo_group` /
   789	/// `end_undo_group` pair only handles the happy path.
   790	///
   791	/// Implements `Deref<Target = CollabSession>` + `DerefMut`, so
   792	/// all `CollabSession` methods are callable directly on the
   793	/// guard during its lifetime.
   794	pub struct UndoGroupGuard<'a> {
   795	    session: &'a mut CollabSession,
   796	}
   797	
   798	impl std::fmt::Debug for UndoGroupGuard<'_> {
   799	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
   800	        f.debug_struct("UndoGroupGuard")
   801	            .field("session", &self.session)
   802	            .finish()
   803	    }
   804	}
   805	
   806	impl std::ops::Deref for UndoGroupGuard<'_> {
   807	    type Target = CollabSession;
   808	    fn deref(&self) -> &CollabSession {
   809	        self.session
   810	    }
   811	}
   812	
   813	impl std::ops::DerefMut for UndoGroupGuard<'_> {
   814	    fn deref_mut(&mut self) -> &mut CollabSession {
   815	        self.session
   816	    }
   817	}
   818	
   819	impl Drop for UndoGroupGuard<'_> {
   820	    fn drop(&mut self) {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1440,1830p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1440	        assert_eq!(s.op_count(), 1, "visible op count must shrink to 1");
  1441	
  1442	        // Redo restores.
  1443	        assert!(s.redo().unwrap());
  1444	        assert_eq!(s.op_log().iter().count(), s.op_count());
  1445	        assert_eq!(s.op_count(), 2);
  1446	    }
  1447	
  1448	    #[test]
  1449	    fn reborn_session_has_empty_undo_stack() {
  1450	        // Codex 5.4 V1 audit C3 closure: imported ops are NOT
  1451	        // undoable by the reborn peer (Loro local-only undo
  1452	        // semantics — `loro-internal::undo:615-643` composes
  1453	        // imported events into `remote_event` rather than pushing
  1454	        // them onto the undo stack).
  1455	        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
  1456	        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1457	        origin.append_op(put_value(0, 0, 1, 2.0)).unwrap();
  1458	        assert!(origin.can_undo());
  1459	        let bytes = origin.export_bytes().unwrap();
  1460	
  1461	        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
  1462	        assert_eq!(
  1463	            reborn.undo_count(),
  1464	            0,
  1465	            "reborn session must NOT inherit origin's undo stack"
  1466	        );
  1467	        assert!(!reborn.can_undo());
  1468	        // But it sees the imported ops in the log.
  1469	        assert_eq!(reborn.op_count(), 2);
  1470	    }
  1471	
  1472	    #[test]
  1473	    fn local_undo_after_remote_merge_preserves_remote_ops() {
  1474	        // Codex 5.4 V1 audit C2 closure: peer A appends, B merges A's
  1475	        // bytes, A undoes A's append, B re-merges. After re-merge, B
  1476	        // sees A's op as retracted (Loro propagates the undo's inverse
  1477	        // through the CRDT). The remote contribution from B's own
  1478	        // appends survives unchanged.
  1479	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  1480	        let base_bytes = base.export_bytes().unwrap();
  1481	
  1482	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
  1483	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
  1484	
  1485	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
  1486	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
  1487	        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
  1488	        let b_count_before = peer_b.op_count();
  1489	        assert!(b_count_before >= 2, "B sees A's + B's ops");
  1490	
  1491	        // A undoes its append. iter().count() shrinks on A.
  1492	        assert!(peer_a.undo().unwrap());
  1493	        let a_iter = peer_a.op_log().iter().count();
  1494	        assert!(
  1495	            a_iter < 1 || a_iter == 0,
  1496	            "A's visible ops shrink post-undo, got {a_iter}"
  1497	        );
  1498	
  1499	        // B merges A's post-undo state. A's retract should propagate.
  1500	        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
  1501	        let b_iter_after = peer_b.op_log().iter().count();
  1502	        assert!(
  1503	            b_iter_after < b_count_before,
  1504	            "B's visible op count must shrink after merging A's undo (was {b_count_before}, now {b_iter_after})"
  1505	        );
  1506	        // But B still sees its OWN op — undo is local-only.
  1507	        assert!(
  1508	            b_iter_after >= 1,
  1509	            "B's own op must survive A's local undo (local-only semantics)"
  1510	        );
  1511	    }
  1512	
  1513	    #[test]
  1514	    fn attach_transport_returns_none_when_no_prior() {
  1515	        use crate::transport::NoopTransport;
  1516	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1517	        assert!(!s.has_transport());
  1518	        let prior = s.attach_transport(NoopTransport::new());
  1519	        assert!(prior.is_none());
  1520	        assert!(s.has_transport());
  1521	    }
  1522	
  1523	    #[test]
  1524	    fn attach_transport_returns_previous_on_replace() {
  1525	        use crate::transport::NoopTransport;
  1526	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1527	        s.attach_transport(NoopTransport::new());
  1528	        let prior = s.attach_transport(NoopTransport::new());
  1529	        assert!(prior.is_some(), "second attach must return the first");
  1530	    }
  1531	
  1532	    #[test]
  1533	    fn detach_transport_returns_box_then_clears() {
  1534	        use crate::transport::NoopTransport;
  1535	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1536	        s.attach_transport(NoopTransport::new());
  1537	        assert!(s.has_transport());
  1538	        let detached = s.detach_transport();
  1539	        assert!(detached.is_some());
  1540	        assert!(!s.has_transport());
  1541	        assert!(s.detach_transport().is_none(), "second detach is None");
  1542	    }
  1543	
  1544	    #[test]
  1545	    fn flush_to_transport_noop_without_attached() {
  1546	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1547	        let flushed = s.flush_to_transport().unwrap();
  1548	        assert!(!flushed, "flush with no transport returns false");
  1549	    }
  1550	
  1551	    #[test]
  1552	    fn poll_remote_noop_without_attached() {
  1553	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1554	        let drained = s.poll_remote().unwrap();
  1555	        assert_eq!(drained, 0, "poll with no transport returns 0");
  1556	    }
  1557	
  1558	    #[test]
  1559	    fn flush_to_transport_pushes_bytes_via_attached() {
  1560	        use crate::transport::LoopbackTransport;
  1561	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  1562	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1563	        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  1564	        s.attach_transport(tx_a);
  1565	
  1566	        assert_eq!(
  1567	            tx_b.pending_recv(),
  1568	            0,
  1569	            "transport idle until flush is called"
  1570	        );
  1571	        let flushed = s.flush_to_transport().unwrap();
  1572	        assert!(flushed);
  1573	        assert_eq!(tx_b.pending_recv(), 1, "flush pushed exactly one blob");
  1574	
  1575	        // Sanity: the pushed bytes are a valid Loro snapshot
  1576	        // (poll on B's side drains them).
  1577	        let received = tx_b.try_recv().unwrap().expect("tx_b drains one blob");
  1578	        assert!(!received.is_empty());
  1579	    }
  1580	
  1581	    #[test]
  1582	    fn poll_remote_drains_attached_transport() {
  1583	        use crate::transport::LoopbackTransport;
  1584	        let (tx_a, tx_b) = LoopbackTransport::pair();
  1585	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1586	        // Pre-populate tx_a's inbox by writing into tx_b's outbox via
  1587	        // tx_b's send. (tx_b.send → tx_a.inbox)
  1588	        let snapshot = {
  1589	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  1590	            other.export_bytes().unwrap()
  1591	        };
  1592	        let mut tx_b = tx_b; // own it for send
  1593	        tx_b.send(&snapshot).unwrap();
  1594	        tx_b.send(&snapshot).unwrap();
  1595	
  1596	        s.attach_transport(tx_a);
  1597	        let drained = s.poll_remote().unwrap();
  1598	        assert_eq!(drained, 2, "poll drained both queued blobs");
  1599	
  1600	        // Next poll is a no-op (queue empty).
  1601	        let drained2 = s.poll_remote().unwrap();
  1602	        assert_eq!(drained2, 0);
  1603	    }
  1604	
  1605	    #[test]
  1606	    fn two_sessions_converge_via_attached_loopback() {
  1607	        use crate::transport::LoopbackTransport;
  1608	        let (tx_a, tx_b) = LoopbackTransport::pair();
  1609	
  1610	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  1611	        let base_bytes = base.export_bytes().unwrap();
  1612	
  1613	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
  1614	        peer_a.attach_transport(tx_a);
  1615	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
  1616	        peer_b.attach_transport(tx_b);
  1617	
  1618	        // A appends + flushes; B polls.
  1619	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
  1620	        peer_a.flush_to_transport().unwrap();
  1621	        let drained_b = peer_b.poll_remote().unwrap();
  1622	        assert_eq!(drained_b, 1);
  1623	        assert!(peer_b.op_count() >= peer_a.op_count());
  1624	
  1625	        // Reverse: B appends + flushes; A polls.
  1626	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
  1627	        peer_b.flush_to_transport().unwrap();
  1628	        let drained_a = peer_a.poll_remote().unwrap();
  1629	        assert_eq!(drained_a, 1);
  1630	        assert_eq!(peer_a.op_count(), peer_b.op_count());
  1631	    }
  1632	
  1633	    #[test]
  1634	    fn flush_to_transport_errors_when_transport_closed() {
  1635	        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
  1636	        // flush-on-closed-transport. Attach a LoopbackTransport,
  1637	        // close it, then attempt flush — expect Transport::Closed.
  1638	        use crate::transport::LoopbackTransport;
  1639	        let (tx_a, _tx_b) = LoopbackTransport::pair();
  1640	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1641	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1642	        // Close BEFORE attaching: close() takes &self so we can do
  1643	        // this on the raw transport.
  1644	        tx_a.close();
  1645	        s.attach_transport(tx_a);
  1646	        let result = s.flush_to_transport();
  1647	        assert!(
  1648	            matches!(
  1649	                result,
  1650	                Err(CollabSessionError::Transport(TransportError::Closed))
  1651	            ),
  1652	            "flush on closed transport must Err(Closed), got {result:?}"
  1653	        );
  1654	        // Local OpLog unaffected — op still in the log.
  1655	        assert!(s.op_count() >= 1);
  1656	    }
  1657	
  1658	    #[test]
  1659	    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
  1660	        // Codex+Opus 5.5 V2 V1 audit closure: pin partial-merge-
  1661	        // then-Closed semantics. The trait contract guarantees
  1662	        // Closed only after queue drains; CollabSession::poll_remote
  1663	        // returns Ok(merged) on Closed (NOT Err) so the caller sees
  1664	        // the merge count.
  1665	        use crate::transport::LoopbackTransport;
  1666	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  1667	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1668	
  1669	        // Queue 3 snapshots in tx_a's inbox.
  1670	        let snapshot = {
  1671	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  1672	            other.export_bytes().unwrap()
  1673	        };
  1674	        for _ in 0..3 {
  1675	            tx_b.send(&snapshot).unwrap();
  1676	        }
  1677	        // Close tx_a's endpoint. Per trait contract, A.try_recv
  1678	        // drains 3 queued blobs first, then returns Closed.
  1679	        tx_a.close();
  1680	        s.attach_transport(tx_a);
  1681	
  1682	        let drained = s.poll_remote().unwrap();
  1683	        assert_eq!(
  1684	            drained, 3,
  1685	            "poll_remote must drain all queued blobs even when transport is closed"
  1686	        );
  1687	        // Next poll: queue is empty + closed → still Ok(0) (graceful).
  1688	        let drained2 = s.poll_remote().unwrap();
  1689	        assert_eq!(drained2, 0);
  1690	    }
  1691	
  1692	    #[test]
  1693	    fn poll_remote_with_limit_caps_drain() {
  1694	        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
  1695	        // bounds the drain. Pre-populate 10 blobs, drain 4 at a time.
  1696	        use crate::transport::LoopbackTransport;
  1697	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  1698	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1699	
  1700	        let snapshot = {
  1701	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  1702	            other.export_bytes().unwrap()
  1703	        };
  1704	        for _ in 0..10 {
  1705	            tx_b.send(&snapshot).unwrap();
  1706	        }
  1707	        s.attach_transport(tx_a);
  1708	
  1709	        let d1 = s.poll_remote_with_limit(4).unwrap();
  1710	        assert_eq!(d1, 4, "first call drains 4");
  1711	        let d2 = s.poll_remote_with_limit(4).unwrap();
  1712	        assert_eq!(d2, 4, "second call drains 4");
  1713	        let d3 = s.poll_remote_with_limit(4).unwrap();
  1714	        assert_eq!(d3, 2, "third call drains the remaining 2");
  1715	        let d4 = s.poll_remote_with_limit(4).unwrap();
  1716	        assert_eq!(d4, 0, "queue empty");
  1717	
  1718	        // limit = 0 is a no-op even with queued blobs.
  1719	        tx_b.send(&snapshot).unwrap();
  1720	        let d5 = s.poll_remote_with_limit(0).unwrap();
  1721	        assert_eq!(d5, 0, "limit=0 must be a no-op");
  1722	    }
  1723	
  1724	    #[test]
  1725	    fn attach_flush_detach_reattach_cycle() {
  1726	        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
  1727	        // full attach-flush-detach-reattach lifecycle.
  1728	        use crate::transport::LoopbackTransport;
  1729	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1730	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1731	
  1732	        // Cycle 1: attach, flush, detach.
  1733	        let (tx_a1, tx_b1) = LoopbackTransport::pair();
  1734	        s.attach_transport(tx_a1);
  1735	        assert!(s.flush_to_transport().unwrap());
  1736	        assert_eq!(tx_b1.pending_recv(), 1, "first cycle: 1 blob in tx_b1");
  1737	        let detached1 = s.detach_transport();
  1738	        assert!(detached1.is_some());
  1739	        assert!(!s.has_transport());
  1740	
  1741	        // Cycle 2: attach DIFFERENT transport, flush, detach.
  1742	        let (tx_a2, tx_b2) = LoopbackTransport::pair();
  1743	        s.attach_transport(tx_a2);
  1744	        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
  1745	        assert!(s.flush_to_transport().unwrap());
  1746	        assert_eq!(tx_b2.pending_recv(), 1, "second cycle: 1 blob in tx_b2");
  1747	        // tx_b1 unaffected by the second cycle.
  1748	        assert_eq!(tx_b1.pending_recv(), 1, "tx_b1 isolated from second attach");
  1749	        s.detach_transport();
  1750	    }
  1751	
  1752	    #[test]
  1753	    fn debug_includes_transport_attached() {
  1754	        use crate::transport::NoopTransport;
  1755	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1756	        let d_pre = format!("{s:?}");
  1757	        assert!(
  1758	            d_pre.contains("transport_attached: false"),
  1759	            "Debug must include transport_attached: false: {d_pre}"
  1760	        );
  1761	        s.attach_transport(NoopTransport::new());
  1762	        let d_post = format!("{s:?}");
  1763	        assert!(
  1764	            d_post.contains("transport_attached: true"),
  1765	            "Debug must reflect attached: {d_post}"
  1766	        );
  1767	    }
  1768	
  1769	    #[test]
  1770	    fn two_sessions_exchange_state_via_loopback_transport() {
  1771	        // Phase 5.5 V1 integration: drive two CollabSessions
  1772	        // through a LoopbackTransport pair. V1 doesn't auto-
  1773	        // flush appends to the transport (5.5 V2 work), so the
  1774	        // test manually exports/sends/recvs/merges to verify the
  1775	        // wire actually carries the right bytes.
  1776	        use crate::transport::{LoopbackTransport, Transport};
  1777	        let (mut tx_a, mut tx_b) = LoopbackTransport::pair();
  1778	
  1779	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  1780	        let base_bytes = base.export_bytes().unwrap();
  1781	
  1782	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
  1783	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
  1784	
  1785	        // Peer A appends an op, exports, sends over the wire.
  1786	        peer_a.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  1787	        let a_bytes = peer_a.export_bytes().unwrap();
  1788	        tx_a.send(&a_bytes).unwrap();
  1789	
  1790	        // Peer B drains the transport and merges.
  1791	        let received = tx_b
  1792	            .try_recv()
  1793	            .unwrap()
  1794	            .expect("tx_b must receive A's bytes");
  1795	        assert_eq!(received, a_bytes);
  1796	        peer_b.merge_bytes(&received).unwrap();
  1797	        assert!(peer_b.op_count() >= 1, "B must see A's op after merge");
  1798	
  1799	        // Reverse direction: B appends, sends to A.
  1800	        peer_b.append_op(put_value(0, 1, 0, 99.0)).unwrap();
  1801	        tx_b.send(&peer_b.export_bytes().unwrap()).unwrap();
  1802	        let b_received = tx_a
  1803	            .try_recv()
  1804	            .unwrap()
  1805	            .expect("tx_a must receive B's bytes");
  1806	        peer_a.merge_bytes(&b_received).unwrap();
  1807	
  1808	        // After the exchange, both sessions converge on the same op count.
  1809	        assert_eq!(peer_a.op_count(), peer_b.op_count());
  1810	    }
  1811	
  1812	    #[test]
  1813	    fn debug_includes_undo_redo_counts() {
  1814	        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
  1815	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1816	        let d = format!("{s:?}");
  1817	        assert!(
  1818	            d.contains("undo_count"),
  1819	            "Debug must include undo_count: {d}"
  1820	        );
  1821	        assert!(
  1822	            d.contains("redo_count"),
  1823	            "Debug must include redo_count: {d}"
  1824	        );
  1825	    }
  1826	
  1827	    #[test]
  1828	    fn sweep_presence_clears_all_entries_and_returns_count() {
  1829	        // Phase 5.6 V2: sweep_presence removes ALL presence
  1830	        // entries (including own + remote peers) and returns the

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_renames.rs | sed -n '1,120p;300,340p;500,535p;740,820p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   740	        report.formulas_rewritten, 0,
   741	        "no formulas should be rewritten (the only candidate rule was skipped)"
   742	    );
   743	
   744	    // Report MUST surface the skipped rule.
   745	    let skipped: Vec<_> = report
   746	        .ambiguous_rules_skipped
   747	        .iter()
   748	        .filter(|s| s.historic_canonical == "S")
   749	        .collect();
   750	    assert_eq!(skipped.len(), 1);
   751	    assert_eq!(skipped[0].origin_sheet, 0);
   752	    assert_eq!(skipped[0].current_holder_sheet, 1);
   753	}
   754	
   755	// ===== Test 13: cross-sheet formula reference (Opus LOW-1) =====
   756	
   757	/// **Step 3 audit closure (Opus LOW-1):** formula lives on sheet T,
   758	/// references renamed sheet S. The repair must rewrite refs in
   759	/// formulas regardless of which sheet holds the formula. Most
   760	/// tests put the formula on the renamed sheet itself; this pins
   761	/// the cross-sheet rewrite case.
   762	#[test]
   763	fn step3_audit_cross_sheet_formula_reference_gets_rewritten() {
   764	    // Base: sheet 0 = "S", sheet 1 = "T".
   765	    let mut base_log = OpLog::new();
   766	    base_log
   767	        .append(Op::AddSheet {
   768	            name: "S".to_owned(),
   769	            chunk_rows: 16384,
   770	        })
   771	        .unwrap();
   772	    base_log
   773	        .append(Op::AddSheet {
   774	            name: "T".to_owned(),
   775	            chunk_rows: 16384,
   776	        })
   777	        .unwrap();
   778	    let base = base_log.export_bytes().unwrap();
   779	
   780	    let log = merged_log_with_concurrent_ops(
   781	        &base,
   782	        Op::RenameSheet {
   783	            id: 0,
   784	            old_name: "S".to_owned(),
   785	            new_name: "S2".to_owned(),
   786	        },
   787	        // Formula lives on sheet T (id 1), references renamed sheet S (id 0).
   788	        Op::PutFormula {
   789	            sheet: 1,
   790	            row: 5,
   791	            col: 3,
   792	            text: "S!A1".to_owned(),
   793	        },
   794	    );
   795	
   796	    let mut wb = replay_to_workbook(&log);
   797	    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
   798	
   799	    assert_eq!(report.formulas_rewritten, 1);
   800	    // Formula on sheet T was rewritten — `S` (sheet 0's old name)
   801	    // becomes `S2` (sheet 0's current name).
   802	    assert_eq!(
   803	        wb.formula_at(1, 5, 3).map(|s| s.to_string()),
   804	        Some("S2!A1".to_string()),
   805	        "cross-sheet ref must be rewritten regardless of holder sheet"
   806	    );
   807	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '1,110p;350,385p;420,460p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 step 4 — table rename-repair integration tests. 2026-05-20.
     2	//!
     3	//! Mirrors `repair_renames.rs` (sheet repair) pattern for table
     4	//! rename scenarios. Covers:
     5	//! - Primary case: concurrent rename + concurrent formula referencing old table name
     6	//! - Auto-disambiguation interaction (step 4 replay handler)
     7	//! - Safety guard: skip rules where old_canonical is currently held
     8	//! - No-rename log → no-op
     9	//! - BatchCommit traversal
    10	//! - Empty new_name + same-canonical no-op (replay rejects/skips)
    11	
    12	use ql_collab::{repair_table_rename_chain, TableRepairReport};
    13	use ql_oplog::{replay_into, Op, OpLog};
    14	use ql_storage::Workbook;
    15	
    16	const PEER_A_ID: u64 = 1;
    17	const PEER_B_ID: u64 = 2;
    18	
    19	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
    20	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
    21	    log.set_peer_id(peer_id)
    22	        .expect("set_peer_id with non-zero id must succeed");
    23	    log
    24	}
    25	
    26	/// Build a base log: AddSheet("S") + CreateTable("T") with columns
    27	/// [A, B] over A1:B3.
    28	fn base_with_table(table_name: &str) -> OpLog {
    29	    let mut log = OpLog::new();
    30	    log.append(Op::AddSheet {
    31	        name: "S".to_owned(),
    32	        chunk_rows: 16384,
    33	    })
    34	    .unwrap();
    35	    log.append(Op::CreateTable {
    36	        name: table_name.to_owned(),
    37	        sheet: 0,
    38	        top_row: 0,
    39	        top_col: 0,
    40	        rows: 3,
    41	        cols: 2,
    42	        has_header: true,
    43	        has_totals: false,
    44	        column_names: vec!["A".to_owned(), "B".to_owned()],
    45	    })
    46	    .unwrap();
    47	    log
    48	}
    49	
    50	fn replay_to_workbook(log: &OpLog) -> Workbook {
    51	    let mut wb = Workbook::new();
    52	    let reg = ql_functions::default_registry();
    53	    replay_into(log, &mut wb, &reg).expect("replay must succeed");
    54	    wb
    55	}
    56	
    57	// ===== Test 1: PRIMARY — concurrent table rename + concurrent formula =====
    58	
    59	/// **Step 4 PRIMARY property**: peer A renames table T → T2; peer B
    60	/// (concurrent) writes a formula `=T[A]` referencing the old name.
    61	/// After merge + table repair, formula text is rewritten to `=T2[A]`.
    62	#[test]
    63	fn repair_rewrites_concurrent_formula_referencing_old_table_name() {
    64	    let base = base_with_table("T").export_bytes().unwrap();
    65	
    66	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
    67	    peer_a
    68	        .append(Op::RenameTable {
    69	            old_name: "T".to_owned(),
    70	            new_name: "T2".to_owned(),
    71	        })
    72	        .unwrap();
    73	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
    74	    peer_b
    75	        .append(Op::PutFormula {
    76	            sheet: 0,
    77	            row: 5,
    78	            col: 0,
    79	            text: "T[A]".to_owned(),
    80	        })
    81	        .unwrap();
    82	
    83	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
    84	    let mut wb = replay_to_workbook(&peer_a);
    85	
    86	    // Table is now T2 (peer A's rename applied via replay).
    87	    assert_eq!(
    88	        wb.tables().lookup("T2").unwrap().display_name.as_ref(),
    89	        "T2"
    90	    );
    91	    // Pre-repair: formula references old "T".
    92	    assert_eq!(
    93	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
    94	        Some("T[A]".to_string())
    95	    );
    96	
    97	    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
    98	
    99	    // Post-repair: formula references current table name.
   100	    assert_eq!(
   101	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   102	        Some("T2[A]".to_string()),
   103	        "repair must rewrite T[A] to T2[A] (current name)"
   104	    );
   105	    assert_eq!(report.formulas_rewritten, 1);
   106	}
   107	
   108	// ===== Test 2: No-rename log → fast-path no-op =====
   109	
   110	#[test]
   350	
   351	// ===== Test 5: Idempotency =====
   352	
   353	#[test]
   354	fn table_repair_is_idempotent() {
   355	    let base = base_with_table("T").export_bytes().unwrap();
   356	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   357	    peer_a
   358	        .append(Op::RenameTable {
   359	            old_name: "T".to_owned(),
   360	            new_name: "T2".to_owned(),
   361	        })
   362	        .unwrap();
   363	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   364	    peer_b
   365	        .append(Op::PutFormula {
   366	            sheet: 0,
   367	            row: 5,
   368	            col: 0,
   369	            text: "T[A]".to_owned(),
   370	        })
   371	        .unwrap();
   372	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   373	    let mut wb = replay_to_workbook(&peer_a);
   374	
   375	    let first = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   376	    let after_first = wb.formula_at(0, 5, 0).map(|s| s.to_string());
   377	    let second = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   378	    let after_second = wb.formula_at(0, 5, 0).map(|s| s.to_string());
   379	
   380	    assert_eq!(first.formulas_rewritten, 1);
   381	    assert_eq!(second.formulas_rewritten, 0);
   382	    assert_eq!(after_first, after_second);
   383	}
   384	
   385	// ===== Test 6: Reused-name safety guard =====
   420	        top_row: 5,
   421	        top_col: 0,
   422	        rows: 2,
   423	        cols: 1,
   424	        has_header: true,
   425	        has_totals: false,
   426	        column_names: vec!["A".to_owned()],
   427	    })
   428	    .unwrap();
   429	    // Formula written AFTER the new T is created, intending the new T.
   430	    log.append(Op::PutFormula {
   431	        sheet: 0,
   432	        row: 10,
   433	        col: 0,
   434	        text: "T[A]".to_owned(),
   435	    })
   436	    .unwrap();
   437	
   438	    let mut wb = replay_to_workbook(&log);
   439	    let report = repair_table_rename_chain(&mut wb, &log).unwrap();
   440	
   441	    // Formula must NOT be rewritten — T is currently a live table.
   442	    assert_eq!(
   443	        wb.formula_at(0, 10, 0).map(|s| s.to_string()),
   444	        Some("T[A]".to_string()),
   445	        "safety guard: rule T → T2 is skipped because T is currently held by another table"
   446	    );
   447	    assert_eq!(report.formulas_rewritten, 0);
   448	    // The skipped rule is reported.
   449	    assert!(
   450	        report
   451	            .ambiguous_rules_skipped
   452	            .iter()
   453	            .any(|s| s.historic_canonical == "T"),
   454	        "skipped rule must be surfaced for diagnostics"
   455	    );
   456	}

exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/crates/ql-collab/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '500,630p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   500	
   501	// ===== Row 7: RenameSheet × concurrent edit on sheet (POST-STEP-3) =====
   502	
   503	/// **Conflict-matrix row 7 (Phase 5.3 step 3 — REPAIR PASS APPLIED):**
   504	/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
   505	/// formula at A2 referencing "S!A1" (the old name). After merge +
   506	/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
   507	/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
   508	/// literal at S2!A1, originally at S!A1 before rename).
   509	///
   510	/// **Pre-step-3 behavior** (kept here as historical context):
   511	/// without the repair pass, the formula bind-failed at recompute →
   512	/// `Value::Error(ErrorValue::Name)` per the D-3 V1 limitation. Step
   513	/// 3's rename-repair pass closes that limitation.
   514	///
   515	/// **Test is intentionally bidirectional via `fork_apply_merge_both_directions`**
   516	/// — both peers, after merge + repair, must converge to the same
   517	/// formula text + resolved value.
   518	#[test]
   519	fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
   520	    // Base: sheet S with a literal at S!A1 = 42.0.
   521	    let mut base_log = base_with_sheet();
   522	    base_log
   523	        .append(Op::PutValue {
   524	            sheet: 0,
   525	            row: 0,
   526	            col: 0,
   527	            value: CellWireValue::Number(42.0),
   528	        })
   529	        .unwrap();
   530	    let base = base_log.export_bytes().unwrap();
   531	
   532	    // Use the bidirectional helper to fork the two peers + apply
   533	    // their concurrent ops + cross-merge — but we have to interpose
   534	    // the repair pass between replay and recompute. The fork helper
   535	    // doesn't know about repair (it's a step-2-and-earlier helper),
   536	    // so we duplicate its logic inline here for the step 3 case.
   537	    let mut peer_a = OpLog::import_bytes(&base).unwrap();
   538	    peer_a.set_peer_id(1).unwrap();
   539	    peer_a
   540	        .append(Op::RenameSheet {
   541	            id: 0,
   542	            old_name: "S".to_owned(),
   543	            new_name: "S2".to_owned(),
   544	        })
   545	        .unwrap();
   546	    let mut peer_b_for_a = OpLog::import_bytes(&base).unwrap();
   547	    peer_b_for_a.set_peer_id(2).unwrap();
   548	    peer_b_for_a
   549	        .append(Op::PutFormula {
   550	            sheet: 0,
   551	            row: 1,
   552	            col: 0,
   553	            text: "S!A1".to_owned(),
   554	        })
   555	        .unwrap();
   556	    peer_a
   557	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   558	        .unwrap();
   559	
   560	    // Symmetric peer B view.
   561	    let mut peer_b = OpLog::import_bytes(&base).unwrap();
   562	    peer_b.set_peer_id(2).unwrap();
   563	    peer_b
   564	        .append(Op::PutFormula {
   565	            sheet: 0,
   566	            row: 1,
   567	            col: 0,
   568	            text: "S!A1".to_owned(),
   569	        })
   570	        .unwrap();
   571	    let mut peer_a_for_b = OpLog::import_bytes(&base).unwrap();
   572	    peer_a_for_b.set_peer_id(1).unwrap();
   573	    peer_a_for_b
   574	        .append(Op::RenameSheet {
   575	            id: 0,
   576	            old_name: "S".to_owned(),
   577	            new_name: "S2".to_owned(),
   578	        })
   579	        .unwrap();
   580	    peer_b
   581	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   582	        .unwrap();
   583	
   584	    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
   585	    let replay_repair_recompute = |log: &OpLog| -> Workbook {
   586	        let mut wb = Workbook::new();
   587	        let reg = default_registry();
   588	        replay_into(log, &mut wb, &reg).expect("replay must succeed");
   589	        // **Step 3 closure point**: the repair pass rewrites concurrent
   590	        // formula text referencing pre-rename sheet names. Without
   591	        // this call, recompute would surface #NAME? (D-3 V1 limitation).
   592	        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
   593	            .expect("repair_sheet_rename_chain must succeed");
   594	        assert_eq!(
   595	            report.formulas_rewritten, 1,
   596	            "exactly 1 formula (peer B's =S!A1) must be rewritten"
   597	        );
   598	        {
   599	            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   600	            rt.recompute_all();
   601	        }
   602	        wb
   603	    };
   604	
   605	    let wb_a = replay_repair_recompute(&peer_a);
   606	    let wb_b = replay_repair_recompute(&peer_b);
   607	
   608	    let a2_a = wb_a.read(Address::new(0, 1, 0));
   609	    let a2_b = wb_b.read(Address::new(0, 1, 0));
   610	
   611	    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
   612	    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
   613	    // cell at S2!A1 is the literal 42.0 from the base log.
   614	    assert_eq!(
   615	        a2_a,
   616	        Value::Number(42.0),
   617	        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
   618	         got {a2_a:?}. Without the repair pass, this would be #NAME? (D-3 V1 limitation)."
   619	    );
   620	
   621	    // Pin the formula text directly to confirm the repair did its job.
   622	    assert_eq!(
   623	        wb_a.formula_at(0, 1, 0).map(|s| s.to_string()),
   624	        Some("S2!A1".to_string()),
   625	        "formula text post-repair must reference current sheet name (S2)"
   626	    );
   627	}
   628	
   629	// ===== Row 8: DropTable × concurrent edit referencing T =====
   630	

exec
/bin/zsh -lc 'rg -n "WorkbookRuntime|recompute_all|sync_workbook|repair_sheet_rename_chain|repair_table_rename_chain" quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs quantbook-engine/crates/ql-exec -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:29://!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:53:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:99:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:100:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:506:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:592:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:593:            .expect("repair_sheet_rename_chain must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:599:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:600:            rt.recompute_all();
quantbook-engine/crates/ql-exec/src/loader.rs:9://! 2. `let mut rt = WorkbookRuntime::new(&mut wb, &registry);`
quantbook-engine/crates/ql-exec/src/loader.rs:10://! 3. `let _ = rt.recompute_all();`
quantbook-engine/crates/ql-exec/src/loader.rs:35:use crate::workbook_runtime::{RecomputeResult, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/loader.rs:48:/// `WorkbookRuntime::recompute_all`); intra-workbook formula→formula
quantbook-engine/crates/ql-exec/src/loader.rs:62:        let mut runtime = WorkbookRuntime::new(&mut workbook, registry);
quantbook-engine/crates/ql-exec/src/loader.rs:63:        runtime.recompute_all()
quantbook-engine/crates/ql-exec/src/loader.rs:95:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:164:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:196:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:244:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:287:    /// **W5-105 (Phase 4.7.L)** — full save → load → recompute_all
quantbook-engine/crates/ql-exec/src/loader.rs:298:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:311:        // Load + recompute_all. 4.7.J #128 made recompute_all dispatch
quantbook-engine/crates/ql-exec/src/loader.rs:322:            "spill anchor must be re-registered by recompute_all"
quantbook-engine/crates/ql-exec/src/loader.rs:348:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:400:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:16://!   `on_add_sheet`) wired through `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:46://! - **Topological recompute.** `recompute_all` still HashMap-order
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:66://!         └─ constructs WorkbookRuntime per edit (per-edit borrow window)
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:720:        // `WorkbookRuntime::set_formula`), which calls
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:962:    /// `WorkbookRuntime::set_value`. Phase 3.3 (2026-05-12): the hook
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:981:    /// `WorkbookRuntime::set_formula`. Ensures the cell has a node,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1028:    /// `WorkbookRuntime::clear_formula`. Phase 3.2: drops the cell's
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1064:    /// `WorkbookRuntime::set_name`. Phase 3.3 (2026-05-12): marks all
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1099:    /// `WorkbookRuntime::add_sheet`. Phase 3.1 stub still: bumps
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1108:    /// `WorkbookRuntime::drop_table`. Walks `table_to_formulas[name]`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1122:    /// **W5-155** wired this hook into `WorkbookRuntime::drop_table`.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1125:    /// `recompute_dirty` / `recompute_all` (HIGH-2 closure) so the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1154:    /// `WorkbookRuntime::rename_table`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1245:    /// `WorkbookRuntime::rename_column`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1308:    /// `WorkbookRuntime::resize_table`. The runtime has already
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1321:    /// `WorkbookRuntime::reextract_table_readers` — the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1352:    /// last bind. Used by `WorkbookRuntime::reextract_table_readers`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1448:    /// Used by `WorkbookRuntime::reextract_spill_footprint_readers`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1566:    /// `pub`. This method is only safe as part of `WorkbookRuntime`'s
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1597:    /// (notably `WorkbookRuntime`'s spill-writeback path) that need to
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1616:    /// of `WorkbookRuntime`'s spill-mutation choreography.
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:1://! Defined-name API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:10://! - [`WorkbookRuntime::set_name`] (Phase 2B.5) — register a
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:14://! - [`WorkbookRuntime::set_sheet_scoped_name`] (W5-92) — register
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:23:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:25:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:158:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:176:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:193:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:205:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:221:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:257:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:278:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:287:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:309:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:326:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:340:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:356:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:366:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:390:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:411:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:445:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:458:    fn recompute_all_resolves_named_constant() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:464:        // Seed a formula manually (skipping set_formula) so recompute_all does the work.
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:469:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:470:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:489:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:1://! Validation + transaction API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:11://! - [`WorkbookRuntime::transaction`] (Phase 2A.2 / 2A.3.b) — begin
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:15://! - [`WorkbookRuntime::validate_formula`] (Phase 2B.7, GAP-I-04
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:28:use super::{validate_cell, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:30:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:125:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:148:        let rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:167:        let rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:184:        let rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:211:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:378:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:400:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:450:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:500:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:579:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:600:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:624:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:625:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/lib.rs:14://!   `WorkbookRuntime`; `PlanCacheStats` for ql-profile observability.
quantbook-engine/crates/ql-exec/src/lib.rs:37://!   `recompute_dirty`) — `WorkbookRuntime` live-formula facade
quantbook-engine/crates/ql-exec/src/lib.rs:38://!   wrapping lex → parse → bind → eval → persist + recompute_all.
quantbook-engine/crates/ql-exec/src/lib.rs:87://! submodules — each adds an `impl<'a> WorkbookRuntime<'a>` block to
quantbook-engine/crates/ql-exec/src/lib.rs:97://! - `workbook_runtime::recompute` — `recompute_all`, `recompute_dirty`,
quantbook-engine/crates/ql-exec/src/lib.rs:106://! Public API is unchanged: every method stays on `WorkbookRuntime`
quantbook-engine/crates/ql-exec/src/lib.rs:152:pub use workbook_runtime::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1://! Table mutation API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:9://! - [`WorkbookRuntime::create_table`] (W5-118) — register a new
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:12://! - [`WorkbookRuntime::drop_table`] (W5-118) — drop a table,
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:15://! - [`WorkbookRuntime::rename_table`] (W5-119) — rename + rewrite
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:18://! - [`WorkbookRuntime::rename_column`] (W5-121) — rename a column
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:20://! - [`WorkbookRuntime::resize_table`] (W5-122) — change a table's
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:35:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:37:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:573:    /// [`Self::recompute_all`] to pick up post-resize changes.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:868:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:924:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:973:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1012:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1030:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1068:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1084:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1097:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1105:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1111:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1130:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1131:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1141:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1159:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1173:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1205:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1217:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1237:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1261:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1268:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1273:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1299:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1300:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1311:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1328:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1336:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1353:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1371:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1376:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1385:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1386:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1397:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1409:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1414:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1435:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1461:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1478:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1490:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1511:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1529:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1565:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1581:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1597:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1619:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1627:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1635:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1637:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1658:    /// `recompute_all` path in the existing W5-122 test happened to
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1669:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1681:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1698:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1712:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1729:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1739:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1745:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1747:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1768:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1774:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1797:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1813:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1838:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1859:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1880:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1892:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1908:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1927:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1957:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1966:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1980:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2002:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2028:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2064:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2099:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2105:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:2138:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/eval_result.rs:25://! - **W5-102+ (Phase 4.7.J):** `WorkbookRuntime::set_formula` adopts
quantbook-engine/crates/ql-exec/src/eval_result.rs:51:/// **Cell-boundary contract (Phase 4.7.J):** `WorkbookRuntime::set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:1://! Format API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:10://! - [`WorkbookRuntime::intern_format`] — register a format string
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:13://! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:16://! - [`WorkbookRuntime::read_display`] — read a cell and render it
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:19://!   `WorkbookRuntime::format_cache`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:28:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:227:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:237:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:256:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:288:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:304:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:336:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:351:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:370:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:386:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:396:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:415:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:436:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:450:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:462:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/env.rs:152:    /// the cell (set_formula, recompute_dirty, recompute_all,
quantbook-engine/crates/ql-exec/src/env.rs:405:/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
quantbook-engine/crates/ql-exec/src/transaction.rs:77:/// via `WorkbookRuntime::transaction`), buffer writes via `put_value` and
quantbook-engine/crates/ql-exec/src/transaction.rs:85:/// via `WorkbookRuntime::with_oplog`). When attached, `commit` produces a
quantbook-engine/crates/ql-exec/src/transaction.rs:116:    /// `WorkbookRuntime::with_oplog`.
quantbook-engine/crates/ql-exec/src/transaction.rs:132:    /// `WorkbookRuntime::transaction` to pass through the runtime's
quantbook-engine/crates/ql-exec/src/transaction.rs:838:        use crate::WorkbookRuntime;
quantbook-engine/crates/ql-exec/src/transaction.rs:841:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/transaction.rs:968:        use crate::WorkbookRuntime;
quantbook-engine/crates/ql-exec/src/transaction.rs:973:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:1://! Sheet mutation API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:10://! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:12://! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:22:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:62:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:233:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:247:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:250:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:276:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:284:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:301:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:313:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:324:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:327:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:344:        // Codex HIGH-1: WorkbookRuntime::add_sheet must pre-validate.
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:348:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:360:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:374:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:401:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1://! Recompute pipeline for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:10://! - [`WorkbookRuntime::recompute_all`] — HashMap-order full pass
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:13://! - [`WorkbookRuntime::recompute_dirty`] — incremental graph-
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:36:use super::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:38:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:61:    pub fn recompute_all(&mut self) -> RecomputeResult {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:63:        // cycle detection. `recompute_all` is the no-session-attached
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:160:            // here — `recompute_all` is the legacy full-pass path).
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:174:                    // mapping so the recompute_all path (used by
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:221:            // Phase 3.8: `recompute_all` doesn't run the VEQ check —
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:227:            // only. `recompute_all` is the legacy full-pass path.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:245:    /// `recompute_all` for a full HashMap-order pass instead.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:248:    /// aggregation shape of `recompute_all`: per-cell failures
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:596:                        // the `recompute_all` change for cross-sheet
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:659:    /// Phase 2B.3 helper for `recompute_all`: consult the bind-plan cache
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:785:        // followed by `recompute_all` would write #CALC! at the
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:866:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:874:    // ===== recompute_all =====
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:877:    fn recompute_all_on_empty_workbook_is_noop() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:880:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:882:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:889:    fn recompute_all_refreshes_formula_values() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:906:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:907:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:920:    fn recompute_all_handles_multiple_formulas() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:933:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:934:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:964:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:997:        let mut rt = WorkbookRuntime::new(&mut loaded, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:998:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1008:    /// `recompute_all` (no session attached — the `.qbook` load / replay
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1014:    fn recompute_all_emits_circ_for_self_referential_a1_plus_one() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1019:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1020:            let r = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1022:            let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1040:    fn recompute_all_emits_circ_for_two_cycle_a1_b1() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1046:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1047:            let r = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1070:    fn recompute_all_isolates_cycle_from_acyclic_formulas() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1077:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1078:            let r = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1094:    /// Cycle value must be stable across repeated `recompute_all`
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1098:    fn recompute_all_repeated_calls_are_idempotent_on_cycle() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1103:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1105:                rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1111:            "cycle value must remain #CIRC! across repeated recompute_all calls (no drift)"
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1123:    fn recompute_all_dependent_of_cycle_propagates_circ_error() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1134:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1135:            rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1156:    fn recompute_all_clears_stale_spill_when_anchor_becomes_circular() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1161:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1162:            rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1192:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1193:            rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1227:    fn recompute_all_failure_carries_exact_cell_and_formula_text() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1236:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1237:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1257:    fn recompute_all_does_not_short_circuit_on_first_failure() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1269:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1270:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1292:    fn recompute_all_does_not_panic_on_invalid_persisted_formulas() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1299:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1302:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1314:    fn recompute_all_eval_time_error_values_count_as_succeeded() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1320:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1321:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1335:    fn recompute_all_failed_cells_preserve_prior_state() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1341:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1342:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1355:    /// BPC-01: repeated `recompute_all` against the same workbook does NOT
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1359:    fn recompute_all_second_pass_is_all_cache_hits() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1367:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1370:        let r1 = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1379:        let r2 = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1386:    /// BPC-02: a NameTable mutation between recompute_all calls invalidates
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1388:    /// The next recompute_all is all misses.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1402:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1403:            let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1416:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1418:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1431:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1435:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1444:    /// BPC-03: cache keys are stable across recompute_all calls — same
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1455:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1459:            let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1479:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1480:        let _ = rt.recompute_all(); // 1 miss
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1481:        let _ = rt.recompute_all(); // 1 hit
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1492:    /// `set_formula` pre-warms the cache. A subsequent `recompute_all`
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1500:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1509:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1532:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1556:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1581:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1607:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1648:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1671:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1714:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1738:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1751:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1770:                WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1786:    // Phase 3.4 integration: WorkbookRuntime::recompute_dirty drives
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1797:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1812:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1822:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1849:    /// `WorkbookRuntime::set_formula` for the second cycle member
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1875:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1904:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1917:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1950:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1982:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2014:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2043:                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2084:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2154:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2192:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2204:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2218:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2238:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2246:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2256:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2290:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2317:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2323:        let mut rt2 = WorkbookRuntime::new(&mut wb2, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2344:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2352:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2372:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2386:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2427:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2439:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2471:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2487:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2518:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2525:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2533:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2546:        // Case 3: `recompute_all` legacy path — skipped is always 0.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2547:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2548:        let r3 = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2551:            "recompute_all doesn't run VEQ — field is always 0"
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2567:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2572:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2637:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2661:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2672:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2685:        // Sanity: the legacy `recompute_all` path is always 0.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2686:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2687:        let r_all = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2690:            "recompute_all is the legacy path; simd_classified is always 0"
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2722:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2741:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2760:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2791:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2817:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2823:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2861:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2893:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2918:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2949:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2968:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2992:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3020:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3059:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3082:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3107:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3149:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3164:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3182:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3186:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3199:    // BindError::UnknownSheet → #NAME? mapping in recompute_all +
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3206:    /// `recompute_all` maps cross-sheet ref to a missing sheet name
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3210:    fn recompute_all_maps_unknown_sheet_to_name_error() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3221:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3222:            let r = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3240:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3241:            rt.recompute_all()
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3257:    /// to `#NAME?`. Mirror of the recompute_all test above.
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3271:        // Hand-write the formula text directly. `WorkbookRuntime::set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3292:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/plan_cache.rs:5://! [`crate::WorkbookRuntime`] and is shared into spawned
quantbook-engine/crates/ql-exec/src/plan_cache.rs:77:/// `WorkbookRuntime::cache_stats()` and surfaced through `ql-profile`.
quantbook-engine/crates/ql-exec/src/plan_cache.rs:106:/// `WorkbookRuntime::with_plan_cache_disabled` — not yet implemented; the
quantbook-engine/crates/ql-exec/src/plan_cache.rs:146:    /// claimed `WorkbookRuntime::set_formula` uses this method — it
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:1://! Workbook-level config setters for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:10://! - [`WorkbookRuntime::set_reference_mode`] — switch between A1
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:12://! - [`WorkbookRuntime::set_locale`] — switch between EnUs / De /
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:17:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:19:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:76:    use crate::workbook_runtime::WorkbookRuntime;
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:98:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:112:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:125:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:138:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/config.rs:155:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1://! Cell mutation API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:10://! - [`WorkbookRuntime::set_formula`] — lex → parse → bind → eval →
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:14://! - [`WorkbookRuntime::set_value`] — literal write with op-log
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:16://! - [`WorkbookRuntime::clear_formula`] — strip a cell's formula
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:40:use super::{validate_cell, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:42:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:148:        // because replay re-derives it via `WorkbookRuntime::recompute_all`
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1126:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1140:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1157:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1171:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1182:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1194:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1211:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1227:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1237:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1250:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1262:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1269:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1288:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1307:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1324:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1342:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1364:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1386:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1403:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1413:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1432:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1442:    // (Tier D1 Step 3.6: recompute_all tests moved.)
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1451:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1477:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1504:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1527:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1542:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1574:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1621:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1635:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1655:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1668:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1676:    fn recompute_all_does_not_emit_ops() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1677:        // recompute_all is idempotent re-evaluation; it shouldn't show up in
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1683:        // then recompute_all must not add more.
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1686:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1692:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1693:            let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1699:            "recompute_all must not append ops"
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1709:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1726:    /// OPL-2B-01 (part 1): `WorkbookRuntime::set_name` records `Op::SetName`
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1738:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1767:    /// OPL-2B-01 (part 2): `WorkbookRuntime::add_sheet` records `Op::AddSheet`
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1779:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1796:    /// OPL-2B-01 (part 3): `WorkbookRuntime::clear_formula` records a
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1810:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1861:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1882:    /// OPL-2B-01 (reserved name): `WorkbookRuntime::set_name` propagates
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1895:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1923:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1954:            let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1955:            assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2004:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2006:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2019:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2021:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2033:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2036:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2053:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2055:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2076:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2078:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2092:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2112:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2115:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2150:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2178:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2196:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2212:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2248:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2268:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2295:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2319:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2347:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2367:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2389:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2401:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2427:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2434:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2459:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2465:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2486:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2526:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2540:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2568:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2582:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2607:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2619:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2641:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2674:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2715:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2743:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2772:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2815:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2831:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2853:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2861:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2882:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2892:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2929:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2988:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3023:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3059:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3064:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3094:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3108:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3128:    // + recompute_all collapsed spilled formulas to #CALC! because
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3135:    /// "{1, 2, 3}" }` followed by `recompute_all` MUST produce the
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3140:    fn recompute_all_materializes_spill_for_array_formula() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3148:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3150:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3160:            "recompute_all must register the spill anchor"
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3167:    /// recompute_all on a SCALAR formula keeps its existing behavior
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3172:    fn recompute_all_scalar_formula_unchanged() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3177:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3178:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3187:    /// recompute_all on an array formula that would spill out of
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3192:    fn recompute_all_out_of_bounds_spill_writes_spill_error() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3197:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3198:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3208:    /// Re-run of recompute_all on an already-spilled formula must
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3214:    fn recompute_all_array_formula_idempotent_across_two_passes() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3218:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3219:        rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3220:        rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3244:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3268:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3290:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3318:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3324:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3344:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3356:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3380:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3403:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3422:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3448:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3455:    /// `=SEQUENCE(3)` after replay + recompute_all re-derives the spill.
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3456:    /// This is THE 4.7.J #128 acceptance — recompute_all dispatches
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3459:    fn recompute_all_materializes_sequence_spill() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3463:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3464:        let result = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3486:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3500:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3517:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3534:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3559:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3579:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3598:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3619:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3637:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3655:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3670:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3706:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3751:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3790:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3803:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3838:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3867:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3906:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3919:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3943:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3953:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3986:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3999:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4033:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4052:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4067:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4096:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4110:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4140:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4171:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4193:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4202:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4218:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4225:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4239:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4267:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4294:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4318:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4334:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4348:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4387:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4415:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4432:    /// **W5-155 / W5-156 (Phase 4.8.G.3):** `WorkbookRuntime::drop_table`
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4451:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4472:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4490:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4518:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4531:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4576:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4620:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4641:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4656:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4674:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4701:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4728:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4729:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4746:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4775:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4802:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4808:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4826:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4831:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4846:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4861:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5059:                let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5116:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5163:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5183:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5197:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:5212:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:1://! `WorkbookRuntime` error + result types.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:8://! - [`RecomputeResult`] — aggregate outcome of `recompute_all` /
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:89:    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:99:    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:104:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:112:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:134:    /// 2026-05-20):** `WorkbookRuntime::intern_format` was called when
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:201:/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:227:/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:262:/// `recompute_dirty`. The counter is `0` for `recompute_all` (which
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:279:    /// Always `0` for the legacy `recompute_all` path.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:286:    /// of region-eligible formulas. Always `0` for `recompute_all`.
quantbook-engine/crates/ql-exec/src/plan.rs:274:    /// and `recompute_all` (W5-156, workbook_runtime.rs:2882 + :3266).
quantbook-engine/crates/ql-exec/src/plan.rs:283:    /// and `recompute_all` (W5-156) alongside `UnknownTable` — covers
quantbook-engine/crates/ql-exec/src/plan.rs:597:/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
quantbook-engine/crates/ql-exec/Cargo.toml:23:# Phase 2A.3.b (2026-05-12): opt-in op-log attachment for WorkbookRuntime +
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:1://! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:5://! formula. Plus a `recompute_all` method that re-evaluates every formula cell in
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:16://! - `recompute_all()` — HashMap-order full pass. Tier C1 (2026-05-18,
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:49:// `impl<'a> WorkbookRuntime<'a>` block extending the same struct
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:129:/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:133:pub struct WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:141:    /// successive `set_formula` and `recompute_all` calls hit the cache
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:161:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:175:    /// log against a fresh workbook (then calling `recompute_all` to
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:201:    /// edge updates. Today's recompute_all still walks formulas in
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:26:use ql_exec::{CalcgraphSession, WorkbookRuntime};
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:43:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:69:                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:89:                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs:351:/// `WorkbookRuntime::set_formula` evaluates BEFORE storing the formula,
quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs:395:/// `WorkbookRuntime::volatile_set`). This test exercises a different
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:17:use ql_exec::{BindError, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:44:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:50:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:87:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:122:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:141:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:149:    // WorkbookRuntime is constructed.
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:162:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:185:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:238:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:321:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:332:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:333:        rt.recompute_all()
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:349:/// works end-to-end: after one recompute_all there's exactly one miss
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:350:/// per formula; the second recompute_all is all hits.
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:356:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:362:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:363:    let _r1 = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:365:    let _r2 = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:29://!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:53:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:99:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:100:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:506:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:592:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:593:            .expect("repair_sheet_rename_chain must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:599:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:600:            rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:9://! 2. `recompute_all` is called ONCE post-replay against the final
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:25:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:50:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:51:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:99:        "A1 must emit #SPILL! when A2 is occupied (recompute_all detects \
quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs:93:            // WorkbookRuntime::set_formula). For this test, the stored
quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs:294:/// divergence pattern as `=ISFORMULA(A1)`. `WorkbookRuntime::set_formula`
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:4://! Each test drives a formula through `WorkbookRuntime` and verifies the
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:22:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:35:fn eval(rt: &mut WorkbookRuntime, sheet: u16, row: u32, col: u32, formula: &str) -> Value {
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:47:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:68:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:92:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:111:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:129:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:151:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:164:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:180:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:193:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:205:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:223:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:244:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:257:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:277:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/error_precedence.rs:294:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:5://! 2A.3.b wires the engine's real producer (WorkbookRuntime + WorkbookTransaction)
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:10://! The replay side runs `WorkbookRuntime::recompute_all` after replay because
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:14:use ql_exec::{load_workbook_and_recompute, WorkbookRuntime, WorkbookTransaction};
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:92:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:123:    // recompute_all to materialize.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:125:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:127:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:137:/// emits one `BatchCommit`. Replay against fresh workbook + recompute_all
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:145:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:162:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:164:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:186:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:200:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:202:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:220:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:232:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:234:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:250:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:274:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:282:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:284:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:312:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:338:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:340:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:405:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:416:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:420:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:424:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:468:    let mut rt = WorkbookRuntime::new(&mut loaded_wb_mut, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:485:/// `recompute_all` MUST reconstruct the spill anchor + target
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:515:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:517:            rt.recompute_all().is_complete(),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:526:        "recompute_all must re-register the SEQUENCE spill anchor"
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:539:/// must ALSO reconstruct the spill via recompute_all. Pins design
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:561:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:562:        assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:582:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:589:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:609:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:610:        assert!(rt.recompute_all().is_complete(), "recompute failures");
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:628:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:647:/// recompute_all evaluates the SUM correctly under the new column
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:655:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:692:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:693:        assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:704:/// new column roster; post-replay recompute_all picks up the resized
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:712:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:729:        // legacy-pass `recompute_all` re-evaluates every formula so
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:731:        assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:752:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:753:        assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:774:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:905:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:957:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:979:        let mut rt = WorkbookRuntime::new(&mut reloaded, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:982:        assert!(rt.recompute_all().is_complete());
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:21:use ql_exec::{CalcgraphSession, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:47:        let mut rt = WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:117:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:128:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:144:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:208:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:239:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:278:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:301:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:358:        let mut rt2 = WorkbookRuntime::new(&mut replayed, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:359:        let _ = rt2.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:410:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:427:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:463:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:494:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:524:    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:549:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:571:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:604:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:615:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:634:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:642:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:664:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:688:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:705:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:706:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:721:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:742:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:748:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:751:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:773:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:785:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:787:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:807:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:827:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:850:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:883:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:913:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:920:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:941:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:973:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:998:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1022:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1041:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1068:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1080:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1099:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1118:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1141:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1155:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1157:        let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1181:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1184:    println!("[I21] If WorkbookRuntime exposes no delete_sheet API, that's a Phase 4 IDE gap.");
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1194:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:20:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:31:fn try_set_formula(rt: &mut WorkbookRuntime, row: u32, col: u32, text: &str) -> String {
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:105:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:150:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:213:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:217:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:227:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:230:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:242:    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut session);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:257:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:261:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:275:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:291:    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:308:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:320:    let result = panic::catch_unwind(panic::AssertUnwindSafe(|| rt.recompute_all()));
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:338:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:354:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:366:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:375:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:388:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:406:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:413:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:424:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:433:    let _ = rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:11://! WorkbookRuntime + op-log + recompute path rather than the binder /
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:14:use ql_exec::{eval_scalar_with_cache, CellEnv, NoAggregateCache, WorkbookEnv, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:21:// Structured-ref args via WorkbookRuntime::create_table
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:27:) -> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:29:    let mut rt = WorkbookRuntime::new(wb, reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:196:    // WorkbookRuntime::set_formula. Recompute. Assert B1 = TRUE.
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:204:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:209:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:224:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:230:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:241:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:246:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:250:    // WorkbookRuntime::set_formula canonicalizes via print_with(EnUs);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:281:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:287:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:290:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:364:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:369:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:373:        rt.recompute_all();

exec
/bin/zsh -lc "rg -n \"ReplayError::At|At \\{|Error::At|op_count\\(\\) == 0|is_empty\\(\\)\" quantbook-engine/crates/ql-oplog/src quantbook-engine/crates/ql-collab/src quantbook-engine/docs -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/repair.rs:311:    if rules.is_empty() {
quantbook-engine/crates/ql-collab/src/repair.rs:518:    if rules.is_empty() {
quantbook-engine/crates/ql-oplog/src/replay.rs:6://! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/crates/ql-oplog/src/replay.rs:351:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/crates/ql-oplog/src/replay.rs:953:    if new_name.is_empty() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1087:    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1217:    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/crates/ql-oplog/src/replay.rs:1999:        assert!(wb.names().is_empty());
quantbook-engine/crates/ql-oplog/src/replay.rs:2024:        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/crates/ql-oplog/src/log.rs:377:    fn new_log_is_empty() {
quantbook-engine/crates/ql-oplog/src/log.rs:379:        assert!(log.is_empty());
quantbook-engine/crates/ql-oplog/src/log.rs:474:        assert!(restored.is_empty());
quantbook-engine/crates/ql-oplog/src/log.rs:528:        assert!(log.presence_peers().is_empty());
quantbook-engine/crates/ql-oplog/src/log.rs:623:        assert!(log.is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:369:    /// When `self.op_count() == 0` the function returns immediately
quantbook-engine/crates/ql-collab/src/session.rs:388:        if self.log.is_empty() {
quantbook-engine/crates/ql-collab/src/session.rs:408:        self.log.is_empty()
quantbook-engine/crates/ql-collab/src/session.rs:857:    fn new_session_is_empty() {
quantbook-engine/crates/ql-collab/src/session.rs:861:        assert!(s.is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:874:        assert!(!s.is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:980:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:1008:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:1578:        assert!(!received.is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:1845:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/crates/ql-collab/src/session.rs:1887:            reborn.peers_with_presence().unwrap().is_empty(),
quantbook-engine/docs/architecture/2026-05-16-phase-4.10-function-library-wave-2.md:79:    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/architecture/2026-05-16-phase-4.10-function-library-wave-2.md:116:    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1380:   143	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1408:   171	    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1412:   175	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1425:   188	        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4104:   186	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4106:   188	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1421:             if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1492:         if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1532:-        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1533:+        if pairs.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1587:         if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1844:             if line.trim().is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:1970:         assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2524:         assert!(loaded.names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2700:             entries.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:2801:         assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3103:  1090	    if orphans.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3209:  1196	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3270:  1257	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3494:  1730	            if line.trim().is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:3535:  1289	        if pairs.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-5-codex.md:4602:   491	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:3704:   162	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:4943:   667	            if rows.is_empty() || rows[0].is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:4999:   723	                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:5155:   879	            if rows.is_empty() || rows[0].is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6014:   598	        if letters.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:7528:   670	            if rows.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9217:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9911:  1419	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10388:crates/ql-exec/src/workbook_runtime.rs:3215:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10422:crates/ql-exec/src/workbook_runtime.rs:5538:        assert!(graph.dirty_formulas().is_empty(), "rebuild starts clean");
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10440:crates/ql-exec/src/workbook_runtime.rs:6842:        assert!(graph.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10507:  1353	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10532:  1378	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:1188:   200	        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:1364:   411	            if rows.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:1427:   474	                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2320:crates/ql-oplog/src/replay.rs:6://! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2339:crates/ql-oplog/src/replay.rs:214:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2781:crates/ql-io/src/qbook_format.rs:751:            return Err(QbookError::AtomicSaveRollbackFailed {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:6480:+            if rows.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:6614:7. FLAG - MEDIUM: Empty/degenerate direct-AST array validation is incomplete and uses the wrong error class. `rows.is_empty()` returns generic `BindError::UnsupportedVariant` at `crates/ql-exec/src/plan.rs:410`, while the parser has a dedicated `ParseError::EmptyArrayLiteral` path at `crates/ql-formula-syntax/src/parser.rs:464`; additionally, `Expr::Array(vec![vec![]])` is accepted because `expected_arity` can be `0` at `crates/ql-exec/src/plan.rs:421`, even though the parser grammar requires at least one cell per row. Suggested fix: add a dedicated `BindError::EmptyArrayLiteral` or `BindError::DegenerateArrayLiteral` and reject `rows.is_empty() || rows[0].is_empty()` before binding.
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:6657:7. FLAG - MEDIUM: Empty/degenerate direct-AST array validation is incomplete and uses the wrong error class. `rows.is_empty()` returns generic `BindError::UnsupportedVariant` at `crates/ql-exec/src/plan.rs:410`, while the parser has a dedicated `ParseError::EmptyArrayLiteral` path at `crates/ql-formula-syntax/src/parser.rs:464`; additionally, `Expr::Array(vec![vec![]])` is accepted because `expected_arity` can be `0` at `crates/ql-exec/src/plan.rs:421`, even though the parser grammar requires at least one cell per row. Suggested fix: add a dedicated `BindError::EmptyArrayLiteral` or `BindError::DegenerateArrayLiteral` and reject `rows.is_empty() || rows[0].is_empty()` before binding.
quantbook-engine/docs/audits/2026-05-17-w5-d-6-opus.md:159:3. **`xs.is_empty()` vs `xs.len() < 1`** — semantically equivalent; clippy would warn against `< 1`. Choice is idiomatic.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:794:   339	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:999:   544	            assert!(!s.is_empty(), "id {id:?} has empty string");
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1288:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:1605:   303	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3160:  1103	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3226:  1169	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3258:  1201	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3439:   335	    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3511:   254	        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3660:    64	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3687:    91	    fn default_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3689:    93	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3738:   142	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:3869:    91	        assert!(s.format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1096:   377	        assert!(g.outgoing(b).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1097:   378	        assert!(g.incoming(a).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1285:   566	        assert!(g.dependents_for_cell(0, 0, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1335:   616	        assert!(g.dependents_for_cell(0, 500, 2).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1754:   124	        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1755:   125	        assert!(a.incoming(NodeId(2)).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1889:    70	        self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:1908:    89	    if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2088:   269	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2098:   279	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2107:   288	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2121:   302	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2142:   323	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2154:   335	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2189:   370	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2216:   397	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2233:   414	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2647:   353	        assert!(idx.candidates_for_cell(0, 2, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:2663:   369	        assert!(idx.candidates_for_cell(0, 100, 3).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3054:   198	        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3201:   343	        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3372:   514	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3388:   530	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3396:   538	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3654:crates/ql-exec/src/calcgraph_session.rs:1548:        assert!(s.dirty_formulas().is_empty(), "take_dirty clears the set");
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:3950:   975	    fn rebuild_from_empty_workbook_is_empty() {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4095:  1120	        assert!(deps.named_ranges.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4133:  1158	            deps.cells.is_empty(),
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4269:crates/ql-calcgraph/src/graph.rs:566:        assert!(g.dependents_for_cell(0, 0, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4277:crates/ql-calcgraph/src/graph.rs:616:        assert!(g.dependents_for_cell(0, 500, 2).is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4346:  3048	        assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4384:  3086	        assert!(graph.dirty_formulas().is_empty(), "rebuild starts clean");
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4399:  3101	        assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4616:  1762	        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4750:  1896	        assert!(r.session.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4824:  1970	        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4834:  1980	        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4882:  2028	        assert!(sched.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:4950:  2096	        assert!(sched.is_empty());
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:5155:   988	                if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:5591:   514	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt:5946:    89	    if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:825:   177	        assert!(!name.is_empty(), "{method}: name must not be empty");
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:1234:   213	        self.cells.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:1303:   348	        self.fns.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:1540:   585	        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:1625:   670	        if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2018:docs/audits/2026-05-13-session-final-megaudit-codex.txt:2941:   124	        self.fns.is_empty() && self.range_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2070:crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2089:crates/ql-storage/src/workbook.rs:985:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2094:crates/ql-oplog/src/replay.rs:1082:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2096:crates/ql-oplog/src/replay.rs:1107:        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2104:crates/ql-io/src/qbook_format.rs:2838:        assert!(loaded.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2111:crates/ql-io/src/qbook_format.rs:3097:        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2152:crates/ql-exec/src/workbook_runtime.rs:5359:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2153:crates/ql-exec/src/workbook_runtime.rs:5388:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2197:   794	        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2199:   796	        assert!(!r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2746:   279	        missing.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2775:   308	        stale.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2793:   326	        overlap.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3277:crates/ql-functions/src/registry.rs:348:        self.fns.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3401:61:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3417:96:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3427:129:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3497:217:        self.fns.is_empty() && self.range_aware_fns.is_empty() && self.context_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3569:454:        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3585:537:        if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3677:660:        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3679:662:        assert!(!r.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3758:    61	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3793:    96	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3826:   129	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3890:61-            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3896:96-            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3902:129-            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3911:454-        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:486:   248	                if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:656:   418	        assert!(idx.candidates_for_cell(0, 2, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:672:   434	        assert!(idx.candidates_for_cell(0, 100, 3).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:913:   675	        assert!(idx.candidates_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:957:   719	        assert!(idx.candidates_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1151:   168	        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1152:   169	        assert!(a.incoming(NodeId(2)).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1229:   246	        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1235:   252	    fn clear_outgoing_on_node_with_no_edges_is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1239:   256	        assert!(drained.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1240:   257	        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1262:   279	        assert!(a.incoming(NodeId(1)).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1736:   455	        assert!(g.outgoing(b).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1737:   456	        assert!(g.incoming(a).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1925:   644	        assert!(g.dependents_for_cell(0, 0, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:1975:   694	        assert!(g.dependents_for_cell(0, 500, 2).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2025:   744	        assert!(g.outgoing(b1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2026:   745	        assert!(g.incoming(a1).is_empty(), "back-pointer dropped");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2027:   746	        assert!(g.incoming(a2).is_empty(), "back-pointer dropped");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2043:   762	        assert!(g.outgoing(b1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2056:   775	        assert!(g.outgoing(a).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2097:   816	        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2098:   817	        assert!(g.dependents_for_cell(0, 5, 1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2144:   863	        assert!(sched.cycled.is_empty(), "no false #CIRC! after revocation");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2179:   898	        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2282:    70	        self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2330:   118	    if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2530:   318	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2540:   328	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2549:   337	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2563:   351	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2584:   372	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2596:   384	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2631:   419	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2658:   446	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2675:   463	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2754:   542	        assert!(s.sorted.is_empty(), "should be all cycled");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2774:   562	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2788:   576	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2805:   593	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2824:   612	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2839:   627	        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2969:   524	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2987:   542	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:2995:   550	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:3209:   681	    if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:3477:    47	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:3510:    80	        self.fns.is_empty()
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:4310:         self.fns.is_empty()
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:4415:         assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:4518:     if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:4564:     if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5314:   999	            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5362:  1047	    fn rebuild_from_empty_workbook_is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5501:  1610	        assert!(s.dirty_formulas().is_empty(), "rebuild leaves clean state");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5511:  1620	        assert!(s.dirty_formulas().is_empty(), "take_dirty clears the set");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5533:  1642	        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5675:  2018	            s.graph().incoming(a1).is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5732:  2075	        assert!(s.graph().outgoing(b1).is_empty(), "B1's outgoing cleared");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5740:  2083	            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5806:  2149	            s.graph().dependents_for_cell(0, 5, 0).is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5825:  2302	            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5865:  2342	        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5914:  2391	        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5972:crates/ql-exec/src/calcgraph_session.rs:2083:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5983:crates/ql-exec/src/calcgraph_session.rs:2302:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5990:crates/ql-exec/src/calcgraph_session.rs:2391:        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:5995:crates/ql-exec/src/calcgraph_session.rs:2506:        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7066:         assert!(g.outgoing(b).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7067:         assert!(g.incoming(a).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7110:         assert!(g.dependents_for_cell(0, 0, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7160:         assert!(g.dependents_for_cell(0, 500, 2).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7210:+        assert!(g.outgoing(b1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7211:+        assert!(g.incoming(a1).is_empty(), "back-pointer dropped");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7212:+        assert!(g.incoming(a2).is_empty(), "back-pointer dropped");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7228:+        assert!(g.outgoing(b1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7241:+        assert!(g.outgoing(a).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7282:+        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7283:+        assert!(g.dependents_for_cell(0, 5, 1).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7329:+        assert!(sched.cycled.is_empty(), "no false #CIRC! after revocation");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7364:+        assert!(g.dependents_for_cell(0, 5, 0).is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7470:         self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7518:     if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7726:         assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7736:         assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7745:         assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7759:         assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7780:         assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7792:         assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7825:         assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7852:         assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7869:         assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7948:+        assert!(s.sorted.is_empty(), "should be all cycled");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7968:+        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7982:+        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:7999:+        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8018:+        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8033:+        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8280:         self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8465:         if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8485:                     if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8493:                     if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8767:+            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:8815:     fn rebuild_from_empty_workbook_is_empty() {
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9084:+            s.graph().incoming(a1).is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9141:+        assert!(s.graph().outgoing(b1).is_empty(), "B1's outgoing cleared");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9149:+            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9215:+            s.graph().dependents_for_cell(0, 5, 0).is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9304:+            sched.sorted.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9368:+            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9408:+        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9457:+        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9498:         assert!(r.session.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9572:         assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt:9582:         assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:812:         self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:1009:             assert!(!s.is_empty(), "id {id:?} has empty string");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4776:   443	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:4997:   664	            assert!(!s.is_empty(), "id {id:?} has empty string");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5252:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5555:   309	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:5976:   730	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6098:   852	    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6228:   982	    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:6978:  1732	        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7003:  1757	        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:7883:        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9257:quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2781:crates/ql-io/src/qbook_format.rs:751:            return Err(QbookError::AtomicSaveRollbackFailed {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9427:quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4163:crates/ql-io/src/qbook_format.rs:989:            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9493:quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4229:crates/ql-io/src/qbook_format.rs:2646:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9545:quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2104:crates/ql-io/src/qbook_format.rs:2838:        assert!(loaded.names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:9552:quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:2111:crates/ql-io/src/qbook_format.rs:3097:        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:10101:quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:6926:quantbook-engine/crates/ql-io/src/qbook_format.rs:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11346:quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:2484:crates/ql-io/src/qbook_format.rs:3894:        assert!(loaded.tables().is_empty(), "v5 file → empty TableTable");
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:11802:quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6272:quantbook-engine/crates/ql-io/src/qbook_format.rs:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:12026:quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8642:crates/ql-io/src/qbook_format.rs:3072:        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13253:            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13319:        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13351:        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13409:    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-4-codex.md:13639:3118:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-17-w5-d-7-opus.md:18:- `compute_xnpv`: hoists `values[0]` out of loop (algebraically equivalent to summing from i=0 since `(1+r)^0 = 1`), then sums `vᵢ / (1+r)^((dᵢ-d₀)/365)` for i≥1. Identical to IronCalc. **Extra guard added**: `if values.is_empty() { return Err(Num) }` before `values[0]` access — IronCalc has a latent panic on empty (guarded at all callers); ours is defensive in-depth. Good.
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-opus.md:31:Test body only checks `multi_peer_drops.is_empty()` and re-import correctness; does NOT compare bytes or exercise non-contiguous counters. Given HIGH-1 exists, the test passes despite the byte regression.
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:626:    - `iter_anchors()`, `len()`, `is_empty()`.
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:960:   271	        self.anchors.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:977:   288	        assert!(t.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1103:   414	        assert!(t.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1395:   210	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1627:    78	        assert!(s.format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:2423:  1069	        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1092:        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1252:    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1256:        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1860:   193	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2020:   353	    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2024:   357	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2037:   370	        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2143:   476	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2171:   504	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:1224:   210	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:1982:   389	        } else if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:2005:   412	        if name.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:2504:   347	        if letters.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:2542:   385	        if letters.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3199:    94	    let needs_quoting = name.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3473:   421	    if letters.is_empty() || letters.len() > 3 {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3486:   434	    if letters.is_empty() || letters.len() > 3 {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:4912:   362	                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5595:   281	/// (= `failures.is_empty()`); see `failed_count()` for the count.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5647:   333	        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5893:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:6087:   200	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7879:   737	            return Err(QbookError::AtomicSaveRollbackFailed {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8016:   869	    if orphans.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8122:   975	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8179:  1032	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8204:  1057	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8435:crates/ql-oplog/src/replay.rs:1086:        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8469:crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8642:crates/ql-io/src/qbook_format.rs:3072:        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8655:crates/ql-exec/src/workbook_runtime.rs:5366:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8841:  1335	            if line.trim().is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9151:  5337	        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9180:  5366	        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9398:  1061	        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9423:  1086	        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:935:    assert!(report.sheet_rewrites.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3356:        } else if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3379:        if name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3690:quantbook-engine/crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3796:quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:185:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:3799:quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:212:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:4731:   357	    assert!(report.sheet_rewrites.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:5389:        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:6061:    let needs_quoting = name.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-codex.md:6833:        // check (which inspects `failures.is_empty()`) signals the
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-sonnet-review.md:168:if rows.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:583:docs/audits/2026-05-19-phase-5-1-codex.md:8978:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:346:    let peer_ids = if peer_ids.is_empty() { &[1] } else { peer_ids };
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:722:   313	        assert!(restored.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:974:   216	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:976:   218	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1240:   153	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1268:   181	    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1272:   185	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1285:   198	        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:2308:   401	        if message.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:2583:   440	        if self.local_ops.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:2684:   536	        if !self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3129:   442	        if !self.event_recorder.recording_diff || diff.diff.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3167:   480	        if recorder.diffs.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3378:   146	    if !oplog.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3390:   158	    if !state.frontiers.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3398:   166	    if !oplog.frontiers().is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3411:   179	        if shallow_root_state_bytes.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3529:   264	    assert!(doc.drop_pending_events().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4906:     fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4911:         assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:1187:   166	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:1332:   311	            assert!(!s.is_empty(), "id {id:?} has empty string");
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2598:   865	            return Err(QbookError::AtomicSaveRollbackFailed {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2730:   997	    if orphans.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2836:  1103	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2893:  1160	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2918:  1185	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:2959:  1226	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:3337:  1604	            if line.trim().is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:3566:  1833	                    if col.name.is_empty() || col.display.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:3810:  2077	        let lines: Vec<&str> = jsonl.lines().filter(|l| !l.is_empty()).collect();
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:4814:  3081	        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:5102:  3369	        assert!(loaded.names().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:5274:  3541	            entries.is_empty(),
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:5368:  3635	        assert!(loaded.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:5690:  3957	        assert!(loaded.tables().is_empty(), "v5 file → empty TableTable");
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:6722:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:6926:quantbook-engine/crates/ql-io/src/qbook_format.rs:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:7278:quantbook-engine/crates/ql-storage/src/lib.rs:90:        assert!(s.format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11722:  1103	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11779:  1160	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:11804:  1185	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:12871:  3081	        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13019:   247	        if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13026:   254	        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-2-codex.md:13066:   324	    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:357:     if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:510:+    if rules.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:899:   909	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:1220:   268	    if rules.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:1406:   454	    if rules.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:1939:   142	    assert!(report.table_rewrites.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:3059:   332	        self.tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:3407:   424	        if new_col.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:3601:   613	            && added_columns.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:3602:   614	            && removed_columns.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:3651:   663	        if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4271:  1173	    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4476:   104	        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-4-codex.md:4645:quantbook-engine/crates/ql-oplog/src/replay.rs:909:    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:236:  `<cellXfs>` when `!cellxfs_roster.is_empty()`, so an empty workbook with
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:118:**Detail:** Per CLAUDE.md no-fallbacks rule, malformed OOXML should surface errors loudly. Example: `attr.unescape_value().unwrap_or_default().to_string()` for the `name` attribute of `<sheet>` returns `""` on UTF-8 decode failure, which then passes the `if name.is_empty()` malformed-check — but only because we happen to check `is_empty()`. Sites without such follow-up checks silently corrupt.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:212:crates/ql-oplog/src/log.rs:453:        assert!(log.presence_peers().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:300:crates/ql-collab/src/session.rs:384:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:311:crates/ql-collab/src/session.rs:412:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1050:docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1297:docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2375:   384	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2403:   412	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2635:   172	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2991:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/encoding_rs-0.8.35/src/lib.rs:4587:                if src.is_empty() && !(last && self.has_pending_state()) {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2993:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/encoding_rs-0.8.35/src/lib.rs:4774:                if src.is_empty() && !(last && self.has_pending_state()) {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:4407:  2109	        self.handler.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:4569:    33	        self.map.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:5470:   453	        assert!(log.presence_peers().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:5517:   500	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:661:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1556:   497	        } else if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:1579:   520	        if name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:2197:quantbook-engine/crates/ql-oplog/src/replay.rs:917:    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:2200:quantbook-engine/crates/ql-oplog/src/replay.rs:1047:    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5253:   340	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-codex.md:5847:   795	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:106:new_cols == old_cols && added.is_empty() && removed.is_empty()`.
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:284:   `new_rows == old_rows && new_cols == old_cols && added.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:285:   && removed.is_empty()`? Or does it always emit an op even for
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:809:   332	        self.tables.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:908:  1544	        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1001:  1985	            && added_columns.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1002:  1986	            && removed_columns.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1051:  2035	        if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1140:   537	        assert!(!tt.is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1426:  1781	                    if col.name.is_empty() || col.display.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1481:   743	    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1611:   873	    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1677: 10604	                && removed_columns.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:2286:crates/ql-io/src/qbook_format.rs:1781:                    if col.name.is_empty() || col.display.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:2126:   446	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:2149:   469	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:2963:   706	    if values.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:2994:   737	    if values.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:3253:   711	    if values.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:3329:  2292	    if trimmed.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:3419:  2382	    if args.is_empty() || args.len() > 3 {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:3461:  2424	    if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:3661:  2560	        Some(s) if !s.is_empty() => {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:5691:  1068	    if pair_args.is_empty() || pair_args.len() % 2 != 0 {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8598:  1393	            Value::Text(s) if s.is_empty() => count += 1,
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8655:  1807	        if ignore_empty && text.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8691:  1843	    if !parts.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8989:  2744	    if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:11991:  1843	    if !parts.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:12338:  1172	        if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-final-reverify-codex.md:174:  1787	                    if col.name.is_empty() || col.display.is_empty() {
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:863:**Detail:** `if !col_name.is_empty() { columns.push(...) }`. A malformed
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:2721:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:2756:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:2789:            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:2877:        self.fns.is_empty() && self.range_aware_fns.is_empty() && self.context_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:3357:        assert!(g.outgoing(b).is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:3358:        assert!(g.incoming(a).is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:3546:        assert!(g.dependents_for_cell(0, 0, 0).is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:3702:                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4163:crates/ql-io/src/qbook_format.rs:989:            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4229:crates/ql-io/src/qbook_format.rs:2646:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5084:/// (= `failures.is_empty()`); see `failed_count()` for the count.
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5136:        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5427:        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5572:        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5990:        self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:6038:    if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:6294:        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:6315:                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:6323:                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7373:        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7383:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7392:        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7406:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7427:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7439:        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7474:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7501:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7518:        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7597:        assert!(s.sorted.is_empty(), "should be all cycled");
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7617:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7631:        assert!(s.sorted.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7648:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7667:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7824:            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:7881:    fn rebuild_from_empty_workbook_is_empty() {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:166:Design § 7.1 specifies: `anchors` map, `targets` map, `SpillShape { rows, cols }`. Implementation matches exactly. Design § 7.1 describes `register`, `unregister`, `anchor_at`, `target_anchor` as the four operations. Implementation delivers all four plus `iter_anchors()`, `len()`, `is_empty()` — a superset, no drift.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:109:    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:146:    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1796:        assert!(!name.is_empty(), "{method}: name must not be empty");
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2013:crates/ql-exec/src/calcgraph_session.rs:639:        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2096:crates/ql-exec/src/calcgraph_session.rs:1732:        assert!(deps.named_ranges.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2101:crates/ql-exec/src/calcgraph_session.rs:1770:            deps.cells.is_empty(),
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2170:crates/ql-exec/src/calcgraph_session.rs:3108:            s.graph().range_deps_for(a1).is_empty(),
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2429:crates/ql-exec/src/workbook_runtime.rs:3203:                    if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:3754:        if args.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:4223:        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:5670:        if !args.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:6928:    56	    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:6965:    93	    if args.is_empty() { return Value::Error(ErrorValue::Value); }
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:7711:   206	        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:517:A direct integration test would walk `ExprPlan::Function { name: "ISREF", args: [ExprPlan::CellRef { ... }] }` and assert `deps.cells.is_empty()`.
quantbook-engine/docs/audits/2026-05-17-rt-step-3-opus.md:530:    assert!(deps.cells.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:1144:        !preservation.original_bytes.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:1504:            drops.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:2116:        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:2833:        assert!(loaded_log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3921:    if workbook_props.sheets.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:3995:            if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4148:        if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4155:        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4226:            if !report.formula_failures.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4296:            if !report.dropped_features.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4848:    if format_code.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4906:        assert!(idx.num_fmts.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:4907:        assert!(idx.cell_xfs.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5556:    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5632:        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5633:        || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5634:        || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5635:        || !cellxfs_roster_translated.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5705:                if !defined_names.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5709:                if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5712:                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5715:            } else if name == "[Content_Types].xml" && !tables.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:5719:                    if !fixes.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6074:618:        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6075:621:        || !cellxfs_roster_translated.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6080:695:                if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6082:698:                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6375:1209:            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:6428:3269:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7572:6://! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7578:334:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:7614:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-8-megaudit-codex.md:34466:   254	        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:649:   189	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1235:   349	    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1239:   353	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1252:   366	        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1358:   472	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1386:   500	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1720:   338	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1722:   340	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1877:quantbook-engine/crates/ql-oplog/src/log.rs:489:        assert!(log.presence_peers().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1982:quantbook-engine/crates/ql-collab/src/session.rs:472:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1991:quantbook-engine/crates/ql-collab/src/session.rs:500:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2687:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1050:docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2890:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1297:docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3626:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1050:docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3751:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1297:docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4345:quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4363:quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:343:Either add a guard in `formula_text_at` (if `arc.is_empty() { return None; }`), OR add an invariant assertion in `Workbook::put_formula` rejecting empty strings, OR add a defensive test pinning the current behavior so a future change is intentional.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5311:quantbook-engine/docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5325:quantbook-engine/docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5665:   369	                    .is_none_or(|diff| diff.is_empty())
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5671:   375	            !last_remote_diff.cid_to_events.is_empty() && !is_disjoint_group;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5701:   405	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5720:   424	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5742:   446	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5750:   454	        if first.0.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5845:   549	        let should_merge = !this.undo_stack.is_empty() && (in_merge_interval || group_should_merge);
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6107:    49	        if other.cid_to_events.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6122:    64	        if other.cid_to_events.is_empty() || self.cid_to_events.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6371:   313	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6385:   327	        while self.stack.back().unwrap().0.is_empty() && self.stack.len() > 1 {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6388:   330	            if !diff.cid_to_events.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6393:   335	        if self.stack.len() == 1 && self.stack.back().unwrap().0.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6574:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:536:        if !self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6577:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:712:        if self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6894:   875	                    && get_opposite(&mut inner.borrow_mut()).is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6919:   900	        !self.inner.lock().borrow().undo_stack.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6923:   904	        !self.inner.lock().borrow().redo_stack.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7279:   401	        if message.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7474:   440	        if self.local_ops.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7570:   536	        if !self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7593:   698	        self.local_ops.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7607:   712	        if self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:2873:    56	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:2895:    78	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:2941:   124	        self.fns.is_empty() && self.range_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:3316:   304	        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:3630:   142	                    || matches!(v, Value::Text(s) if s.as_ref().is_empty());
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:3695:   207	            if rest.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:3941:   448	    if values.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4294:   801	    if pair_args.is_empty() || pair_args.len() % 2 != 0 {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4371:   878	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4453:   955	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4581:  1083	    if arr.is_empty() || k < 1 || (k as usize) > arr.len() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4606:  1108	    if arr.is_empty() || k < 1 || (k as usize) > arr.len() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4640:  1142	    if arr.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4673:  1175	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4680:  1182	    if nums.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4701:  1203	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4708:  1210	    if nums.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4957:   838	    if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:4992:   873	    if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5140:  1021	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5356:  1341	    if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5381:  1366	    if args.is_empty() || args.len() > 2 {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5465:  1450	    if needle_chars.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5514:  1499	    if needle_u.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5551:  1536	    if old.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:5639:  1624	    if args.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6152:   529	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6173:   550	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6181:   558	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6436:    70	        self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6484:   118	    if dirty.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6697:   318	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6707:   328	        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:6863:  1024	            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:7506:crates/ql-functions/src/registry.rs:124:        self.fns.is_empty() && self.range_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-13-session-final-megaudit-codex.txt:8414:   988	                if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:755:  3052	                    if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:1288:  3270	        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:2014:  2981	        // check (which inspects `failures.is_empty()`) signals the
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:2607:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:2932:  1617	        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:3085:   332	        self.tables.is_empty()
quantbook-engine/docs/audits/2026-05-15-w5155-audit-codex.md:3411:   206	        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1690:crates/ql-exec/src/workbook_runtime/error.rs:223:/// (= `failures.is_empty()`); see `failed_count()` for the count.
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5547:        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:6739:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:6788:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7442:                result.failures.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7483:            assert!(result.failures.is_empty(), "no structural failures");
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7851:/// (= `failures.is_empty()`); see `failed_count()` for the count.
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7903:        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:3091:   181	1. **`on_clear_formula` must call `graph.clear_outgoing(node)` and `graph.clear_range_deps_for_formula(node)`.** Add both calls after `remove_formula_deps(node)` at line 724 in `calcgraph_session.rs`. Add a regression test: set a formula with a range dep and a cell dep, clear it, then verify `graph.outgoing(node).is_empty()` and `graph.dependents_for_cell(...)` no longer returns the cleared node.
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:3169:    56	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:3191:    78	            !name.is_empty(),
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:3237:   124	        self.fns.is_empty() && self.range_aware_fns.is_empty()
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:3785:   304	        assert!(r.is_empty());
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:4382:   524	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:4403:   545	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:4411:   553	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-13-finalization-planning-codex.txt:5005:   248	                if set.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-1-codex.md:4628:        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:2019:   419	        assert!(loaded_log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:4823:   452	        assert!(restored.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:5218:   355	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:5220:   357	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6113:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:571:                let base_snapshot = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6224:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:70:    SnapshotAt { version: Cow<'a, Frontiers> },
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6246:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:135:        ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6315:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:509:        oplog.is_empty() && self.state.lock().can_import_snapshot()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6347:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1996:                ExportMode::SnapshotAt { version } => export_snapshot_at(self, &version)?,
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6870:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:993:        .export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6908:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1401:    let base_snapshot = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6911:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1455:        let base_snapshot = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6914:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1541:    let base_snapshot = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:6919:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1592:    base.import(&doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7120:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/snapshot_at_test.rs:22:    let snapshot_at_first = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7123:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/snapshot_at_test.rs:32:    let snapshot_at_second = doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7160:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:170:        self.dag.is_empty() && self.arena.can_import_snapshot()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7377:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/fork.rs:40:            .export(crate::loro::ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7883:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:281:    assert!(snapshot_meta.start_frontiers.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:7962:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:131:    assert!(snapshot_at_meta.start_frontiers.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8114:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2238:        .export(loro::ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8186:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:251:    assert!(snapshot_meta.start_frontiers.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:8194:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:267:    assert!(snapshot_at_meta.start_frontiers.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9419:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1996:                ExportMode::SnapshotAt { version } => export_snapshot_at(self, &version)?,
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9690:  1996	                ExportMode::SnapshotAt { version } => export_snapshot_at(self, &version)?,
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9817:    70	    SnapshotAt { version: Cow<'a, Frontiers> },
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:9882:   135	        ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10087:   289	            pending: (!pending.is_empty()).then_some(pending),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10089:   291	        has_deps_before_shallow_root: !changes_that_have_deps_before_shallow_root.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-7-codex.md:10472:  1103	    if orphans.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:387:526:        || !cellxfs_roster_translated.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:393:603:                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:873:    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:934:        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:935:        || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:936:        || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:937:        || !cellxfs_roster_translated.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1007:                if !defined_names.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1011:                if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1014:                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1017:            } else if name == "[Content_Types].xml" && !tables.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:1021:                    if !fixes.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2068:     let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2139:         || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2140:         || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2141:         || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2142:-        || !cellxfs_roster.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2143:+        || !cellxfs_roster_translated.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2215:                 if !defined_names.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2219:                 if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2222:                 if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2225:             } else if name == "[Content_Types].xml" && !tables.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2229:                     if !fixes.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2587:    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2641:        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2642:        || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2643:        || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2644:        || !cellxfs_roster.is_empty();
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2710:                if !defined_names.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2714:                if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2717:                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2720:            } else if name == "[Content_Types].xml" && !tables.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2724:                    if !fixes.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:2896:quantbook-engine/crates/ql-storage/src/lib.rs:91:        assert!(s.format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3144:quantbook-engine/crates/ql-io/src/qbook_format.rs:3269:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3316:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1727:            .map(|s| !s.format_overlay().is_empty())
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:3907:        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4209:    if bytes.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4332:        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4419:            .map(|s| !s.format_overlay().is_empty())
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4627:            drops.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4773:quantbook-engine/crates/ql-io-xlsx/src/lib.rs:385:            if !report.dropped_features.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4907:            if !report.dropped_features.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:4975:    if !dropped.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5495:    if !dropped.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5554:            if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5583:        if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5590:        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5898:        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:5986:quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:232:        assert!(idx.cell_xfs.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7201:   523	        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7202:   524	        || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7203:   525	        || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7240:   254	        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7284:   385	            if !report.dropped_features.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7309:   226	    if !dropped.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-2-d-1-step-6-codex.md:7499:  1935	            drops.is_empty(),
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:258:  1022	        if dependents.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1033:  3125	        // check (which inspects `failures.is_empty()`) signals the
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1104:  3196	                    if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3770:  1617	        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3841:  1980	        if new_col.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4026:  2165	            && added_columns.is_empty()
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4027:  2166	            && removed_columns.is_empty()
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4076:  2215	        if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4690:crates/ql-exec/src/calcgraph_session.rs:206:        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4743:crates/ql-exec/src/calcgraph_session.rs:1729:        assert!(deps.named_ranges.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4790:crates/ql-exec/src/calcgraph_session.rs:4174:        assert!(s.dependents_for_table("Orders").is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5332:   636	        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5353:   657	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5361:   665	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5375:   679	                    if set.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5500: 10313	                result.failures.is_empty(),
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5541: 10354	            assert!(result.failures.is_empty(), "no structural failures");
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5706: 10519	                result.failures.is_empty(),
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5772: 10877	            assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5857: 10962	            assert!(result.failures.is_empty(), "no structural failures");
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5874: 10979	            assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5888: 10993	            assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:8307:  1397	    if selectors.is_empty() {
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:8359:  1449	    if col_items.is_empty() {
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:62:     checks `dropped.is_empty()`.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-2-opus.md:34:**What**: Step 2 silently delegates ALL non-case-1 paths to `Workbook::rename_sheet(id, new_name.clone())`. `Workbook::rename_sheet` at `workbook.rs:497-499` returns `SheetNameError::Empty` when `new_name.is_empty()`. Pre-step-2 producer-side validation in `WorkbookRuntime::rename_sheet` rejects empty names — but the wire op format does not enforce this.
quantbook-engine/docs/audits/2026-05-12-megaudit-cycle3.md:113:**Fix**: add `QbookError::AtomicSaveRollbackFailed { install: Error, restore: Error, backup: PathBuf }`. The user sees the compound failure mode.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:975:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5845:   549	        let should_merge = !this.undo_stack.is_empty() && (in_merge_interval || group_should_merge);
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1063:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6919:   900	        !self.inner.lock().borrow().undo_stack.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2643:     fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2647:         assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2660:         assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4422:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/prettyplease-0.2.37/src/item.rs:750:        if use_group.items.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:6519:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fancy-regex-0.14.0/src/parse.rs:109:        if self.numeric_backrefs && !self.named_groups.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:6669:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fancy-regex-0.14.0/src/expand.rs:74:            } else if !regex.named_groups.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:6878:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/calamine-0.34.0/src/xls.rs:530:        if !draw_group.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:6944:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/rustls-0.23.36/src/builder.rs:223:        if self.provider.kx_groups.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8211:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/restriction.rs:80:                if group.content.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8527:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3309:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8530:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3380:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8539:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3515:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8544:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3855:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10260:   549	        let should_merge = !this.undo_stack.is_empty() && (in_merge_interval || group_should_merge);
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10713:   313	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10727:   327	        while self.stack.back().unwrap().0.is_empty() && self.stack.len() > 1 {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10730:   330	            if !diff.cid_to_events.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10735:   335	        if self.stack.len() == 1 && self.stack.back().unwrap().0.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10769:   369	                    .is_none_or(|diff| diff.is_empty())
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10775:   375	            !last_remote_diff.cid_to_events.is_empty() && !is_disjoint_group;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10805:   405	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10824:   424	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10846:   446	        if self.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10854:   454	        if first.0.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3181:   556	        if letters.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:4250:   325	            if rows.is_empty() {
quantbook-engine/docs/audits/2026-05-17-w5-d-9-opus.md:10:**Lexer extension:** Surgical. The new `letters + digits + letters` branch is correctly guarded (`!leading_dollar && !mid_dollar && !letters.is_empty() && next-char-is-letter`). Trailing-digit-only patterns like `LOG10`, `LOG10(2)`, `ATAN2(x,y)`, `A1048577`, and `A1:B5` are preserved by the `next-char-is-letter` peek. Full lex-of-known-callsites was traced manually — no regression.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:805:   162	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:807:   164	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:902:   259	        assert!(restored.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1197:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1481:   290	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2482:   291	        // check (which inspects `failures.is_empty()`) signals the
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3118:   612	        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3959:    64	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3986:    91	    fn default_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3988:    93	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4034:   139	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4236:   166	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:5165:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1996:                ExportMode::SnapshotAt { version } => export_snapshot_at(self, &version)?,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:5527:  1880	        self.handler.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:6264:   183	        if self.list.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:6290:   209	        assert!(data.arr.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:6294:   213	        if self.list.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:6441:   360	        self.list.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:6452:   360	        self.list.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:7861:    49	        if self.tree.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:7950:   138	        if !in_between.is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:8732:    70	    SnapshotAt { version: Cow<'a, Frontiers> },
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:8797:   135	        ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:8978:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:346:    let peer_ids = if peer_ids.is_empty() { &[1] } else { peer_ids };
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:9040:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1592:    base.import(&doc.export(ExportMode::SnapshotAt {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:10247:  3114	        assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1808:   377	    fn new_log_is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1810:   379	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1905:   474	        assert!(restored.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:1959:   528	        assert!(log.presence_peers().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2054:   623	        assert!(log.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2546:   294	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2995:   743	    fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2999:   747	        assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3012:   760	        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3118:   866	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3146:   894	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3716:  1464	        assert!(!received.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:3983:  1731	        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4025:  1773	            reborn.peers_with_presence().unwrap().is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4221:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4549:   334	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:4970:   755	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5092:   877	    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5222:  1007	    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5972:  1757	        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:5997:  1782	        assert!(wb.sheet(0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:7901:    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:8920:quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:158:        assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9015:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1511:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9035:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1643:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9039:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1659:        assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9042:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1672:        assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9071:quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1904:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9125:quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:411:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9172:quantbook-engine/crates/ql-exec/src/transaction.rs:898:            oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9187:quantbook-engine/crates/ql-exec/src/transaction.rs:963:        assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9951:            if !log_ops.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:9965:        assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:10071:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:10099:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1311:         self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1546:     fn new_session_is_empty() {
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1550:         assert!(s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1563:         assert!(!s.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1740:+        assert!(!received.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2013:   953	        assert!(!received.is_empty());
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2637:   223	        self.log.is_empty()
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2818:crates/ql-oplog/src/replay.rs:834:    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2824:crates/ql-oplog/src/replay.rs:964:    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1989:   879	            if rows.is_empty() || rows[0].is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:2559:   339	/// (= `failures.is_empty()`); see `failed_count()` for the count.
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:2611:   391	        self.failures.is_empty()
quantbook-engine/docs/audits/2026-05-17-rt-step-1-opus.md:248:**Recommendation:** add an assertion or `debug_assert!` in the per-fn impls of ROW/ROWS/COLUMN/COLUMNS — `assert!(values.is_empty())` — so a future-misuse that DOES populate values surfaces loudly. Or, better: drop the `values` field from `RefArg::Range` entirely until the day a consumer needs it. The current shape is mis-specified for v1 (a single empty vec carried around for no reason).
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:2409:   268	    if rules.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:2606:   465	    if rules.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:3800:   916	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:4523:   142	    assert!(report.table_rewrites.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:5102:   357	    assert!(report.sheet_rewrites.is_empty());
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:6155:   424	        if new_col.is_empty() {
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5-codex.md:8072:  2049	                && removed_columns.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:254:crates/ql-exec/src/calcgraph_session.rs:2826:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:270:crates/ql-exec/src/calcgraph_session.rs:3048:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:277:crates/ql-exec/src/calcgraph_session.rs:3089:        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:280:crates/ql-exec/src/calcgraph_session.rs:3139:        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:289:crates/ql-exec/src/calcgraph_session.rs:3329:        assert!(sched.cycled.is_empty(), "no phantom cycle");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:295:crates/ql-exec/src/calcgraph_session.rs:3406:        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:305:crates/ql-exec/src/calcgraph_session.rs:3525:        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:563:3182:        // check (which inspects `failures.is_empty()`) signals the
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:634:3253:                    if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:851:1695:            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1369:3503:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:1419:6://! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2005:             oplog.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2021:         assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2034:         assert!(oplog.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2283:290:/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2872:666:    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3155:crates/ql-exec/src/calcgraph_session.rs:245:        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3249:crates/ql-exec/src/calcgraph_session.rs:1931:        assert!(deps.named_ranges.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3253:crates/ql-exec/src/calcgraph_session.rs:1969:            deps.cells.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3292:crates/ql-exec/src/calcgraph_session.rs:3307:            s.graph().range_deps_for(a1).is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3567:crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3784:crates/ql-storage/src/workbook.rs:1219:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4203:crates/ql-exec/src/workbook_runtime.rs:8010:        assert!(wb.names().is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4209:crates/ql-exec/src/workbook_runtime.rs:8039:        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4389:crates/ql-exec/src/calcgraph_session.rs:245:        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4473:crates/ql-exec/src/calcgraph_session.rs:1695:            if ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4480:crates/ql-exec/src/calcgraph_session.rs:1931:        assert!(deps.named_ranges.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4615:crates/ql-exec/src/calcgraph_session.rs:3307:            s.graph().range_deps_for(a1).is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4688:crates/ql-exec/src/workbook_runtime.rs:3253:                    if !deps.named_ranges.is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:5240:245:        self.cells.is_empty() && self.named_ranges.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:5581:806:        if !deps.is_empty() || deps.is_volatile {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:6034:818:            if rows.is_empty() || rows[0].is_empty() {
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:6090:874:                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:7197:9192:        assert!(result.failures.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8196:crates/ql-calcgraph/src/edges.rs:168:        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8197:crates/ql-calcgraph/src/edges.rs:169:        assert!(a.incoming(NodeId(2)).is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8230:crates/ql-calcgraph/src/edges.rs:246:        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8234:crates/ql-calcgraph/src/edges.rs:257:        assert!(a.outgoing(NodeId(0)).is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8243:crates/ql-calcgraph/src/edges.rs:279:        assert!(a.incoming(NodeId(1)).is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8281:crates/ql-calcgraph/src/topo.rs:70:        self.sorted.is_empty() && self.cycled.is_empty()
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8297:crates/ql-calcgraph/src/topo.rs:328:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8300:crates/ql-calcgraph/src/topo.rs:351:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8301:crates/ql-calcgraph/src/topo.rs:372:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8310:crates/ql-calcgraph/src/topo.rs:419:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8312:crates/ql-calcgraph/src/topo.rs:446:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8329:crates/ql-calcgraph/src/topo.rs:542:        assert!(s.sorted.is_empty(), "should be all cycled");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8332:crates/ql-calcgraph/src/topo.rs:562:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8337:crates/ql-calcgraph/src/topo.rs:593:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8340:crates/ql-calcgraph/src/topo.rs:612:        assert!(s.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8363:crates/ql-exec/src/calcgraph_session.rs:2826:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8375:crates/ql-exec/src/calcgraph_session.rs:3048:            sched.cycled.is_empty(),
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8381:crates/ql-exec/src/calcgraph_session.rs:3089:        assert!(sched.sorted.is_empty(), "self-cycle, sorted empty");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8383:crates/ql-exec/src/calcgraph_session.rs:3139:        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8389:crates/ql-exec/src/calcgraph_session.rs:3329:        assert!(sched.cycled.is_empty(), "no phantom cycle");
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8392:crates/ql-exec/src/calcgraph_session.rs:3406:        assert!(sched.cycled.is_empty());
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:8395:crates/ql-exec/src/calcgraph_session.rs:3525:        assert!(sched.cycled.is_empty(), "no cycles in a linear chain");
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-sonnet.md:181:1. **`on_clear_formula` must call `graph.clear_outgoing(node)` and `graph.clear_range_deps_for_formula(node)`.** Add both calls after `remove_formula_deps(node)` at line 724 in `calcgraph_session.rs`. Add a regression test: set a formula with a range dep and a cell dep, clear it, then verify `graph.outgoing(node).is_empty()` and `graph.dependents_for_cell(...)` no longer returns the cleared node.
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-3-opus.md:48:**Closure**: added `if rules.is_empty() { return ... }` early return after rule building.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2248:   166	        self.by_id.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3099:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3667:    64	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3694:    91	    fn default_is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3696:    93	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3742:   139	        assert!(o.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4784:   218	            if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4813:   247	        if part_path.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4820:   254	        if styled_cells.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5010:   155	        assert!(out.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5218:   173	    if format_code.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5289:   369	        || !custom_formats.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5290:   370	        || !defined_names.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5291:   371	        || !tables.is_empty()
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5292:   372	        || !cellxfs_roster.is_empty();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5358:   438	                if !defined_names.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5362:   442	                if !custom_formats.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5365:   445	                if !cellxfs_roster.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5368:   448	            } else if name == "[Content_Types].xml" && !tables.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5372:   452	                    if !fixes.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5571:     6	//! `ReplayError::At { index, kind }` carrying the position of the failing
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6214:quantbook-engine/crates/ql-storage/src/lib.rs:90:        assert!(s.format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6272:quantbook-engine/crates/ql-io/src/qbook_format.rs:3081:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6412:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1722:            .map(|s| !s.format_overlay().is_empty())
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6474:quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:232:        assert!(idx.cell_xfs.is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7729:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6574:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:536:        if !self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7732:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:6577:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:712:        if self.origin.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8523:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:583:docs/audits/2026-05-19-phase-5-1-codex.md:8978:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:346:    let peer_ids = if peer_ids.is_empty() { &[1] } else { peer_ids };
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:9245:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8211:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/restriction.rs:80:                if group.content.is_empty() {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:9561:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8527:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3309:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:9564:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8530:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3380:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:9573:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8539:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3515:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:9578:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:8544:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/syn-2.0.117/src/expr.rs:3855:        let needs_group = !e.attrs.is_empty();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11030:quantbook-engine/crates/ql-collab/src/session.rs:824:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11039:quantbook-engine/crates/ql-collab/src/session.rs:852:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11091:quantbook-engine/crates/ql-collab/src/session.rs:1689:        assert!(s.peers_with_presence().unwrap().is_empty());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11108:quantbook-engine/crates/ql-collab/src/session.rs:1731:            reborn.peers_with_presence().unwrap().is_empty(),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:109:   `new_rows == old_rows && new_cols == old_cols && added.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:110:   && removed.is_empty()`? Or does it always emit an op even for
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:1169:   621	    if new_name.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:1280:   732	    if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:1410:   862	    if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:1896:  1798	        if new_col.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:2093:  1995	        if added_columns.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:2332:   286	        self.tables.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:3440:   890	            return Err(QbookError::AtomicSaveRollbackFailed {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:3887:  1917	        let lines: Vec<&str> = jsonl.lines().filter(|l| !l.is_empty()).collect();
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:3975:  1022	    if orphans.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4081:  1128	            if overlay.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4138:  1185	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4163:  1210	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4204:  1251	        if entries.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4444:   980	    if selectors.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4496:  1032	    if col_items.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4750:   963	    if trimmed.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4886:   117	    let needs_quoting = name.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5277:   989	        if name.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5337:  1049	        self.rest.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5397:  1109	        if raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5411:  1123	    if first_raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5416:  1128	    if cursor.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5434:  1146	    if second_raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5439:  1151	    if !cursor.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5526:  1238	    if trimmed_raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5716:  1032	    if col_items.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:6201:  1532	        if column_names.iter().any(|s| s.is_empty()) {
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:8062:  3788	        assert!(loaded.tables().is_empty(), "v5 file → empty TableTable");
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:8702:  Fix: after validation/snapshot, return `Ok(())` without op emission when `new_rows == old_rows && new_cols == old_cols && added_columns.is_empty() && removed_columns.is_empty()`.
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:8733:  Fix: after validation/snapshot, return `Ok(())` without op emission when `new_rows == old_rows && new_cols == old_cols && added_columns.is_empty() && removed_columns.is_empty()`.
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:520:crates/ql-bench/src/machine.rs:229:        assert!(!r.rustc_version.is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1153:crates/ql-exec/src/workbook_runtime.rs:3115:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:2484:crates/ql-io/src/qbook_format.rs:3894:        assert!(loaded.tables().is_empty(), "v5 file → empty TableTable");
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4288:crates/ql-exec/src/calcgraph_session.rs:1712:        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4300:crates/ql-exec/src/calcgraph_session.rs:1828:        assert!(s.dirty_formulas().is_empty(), "rebuild leaves clean state");
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4304:crates/ql-exec/src/calcgraph_session.rs:1838:        assert!(s.dirty_formulas().is_empty(), "take_dirty clears the set");
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4308:crates/ql-exec/src/calcgraph_session.rs:1860:        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4313:crates/ql-exec/src/calcgraph_session.rs:1967:            s.dirty_formulas().is_empty(),
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4314:crates/ql-exec/src/calcgraph_session.rs:1977:            s.dirty_formulas().is_empty(),
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4326:crates/ql-exec/src/calcgraph_session.rs:2052:        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4411:crates/ql-exec/src/calcgraph_session.rs:2929:        assert!(r.session.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4415:crates/ql-exec/src/calcgraph_session.rs:3013:        assert!(s.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:5051:crates/ql-exec/src/workbook_runtime.rs:3115:        if iter_count == MAX_ITERATIONS && !session.dirty_formulas().is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:5444:crates/ql-exec/src/workbook_runtime.rs:5421:        assert!(graph.dirty_formulas().is_empty(), "rebuild starts clean");
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:5614:crates/ql-exec/src/workbook_runtime.rs:6725:        assert!(graph.dirty_formulas().is_empty());
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7249:  1561	            if line.trim().is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7787:   628	            if rows.is_empty() || rows[0].is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7843:   684	                !name.is_empty(),
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8295:   210	        self.entries.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8908:  1049	        self.rest.is_empty()
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8968:  1109	        if raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8982:  1123	    if first_raw.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8987:  1128	    if cursor.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:9213:.references/ironcalc/base/src/expressions/utils/mod.rs:9:    if column.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:9573:.references/ironcalc/base/src/expressions/lexer/ranges.rs:29:        if column.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:9603:.references/ironcalc/base/src/expressions/lexer/ranges.rs:142:                if !row_left.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:9605:.references/ironcalc/base/src/expressions/lexer/ranges.rs:144:                    if row_right.is_empty() || !column_left.is_empty() || !column_right.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:9624:.references/ironcalc/base/src/expressions/lexer/ranges.rs:185:                if column_right.is_empty() || !row_right.is_empty() {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:11522:.references/ironcalc/base/src/expressions/parser/mod.rs:522:        if next_token == TokenType::At {

exec
/bin/zsh -lc "sed -n '1,160p' quantbook-engine/crates/ql-exec/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
/bin/zsh -lc 'rg -n "ql-collab|ql_collab" quantbook-engine/crates/ql-exec/Cargo.toml quantbook-engine/crates/ql-exec/src quantbook-engine/crates/ql-exec/tests -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/Cargo.toml:46:# Direction: dev-only; ql-collab → ql-exec has no Cargo cycle since
quantbook-engine/crates/ql-exec/Cargo.toml:47:# ql-collab does not depend on ql-exec (they are siblings).
quantbook-engine/crates/ql-exec/Cargo.toml:48:ql-collab  = { path = "../ql-collab" }
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:29://!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:506:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:592:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)

exec
/bin/zsh -lc "rg -n \"let mut peer_[ab].*=\\s*OpLog::new\\(|fn mk_peer|base_with_sheet\\(|base_log = OpLog::new|OpLog::new\\(\\).*set_peer_id|set_peer_id\\(\" quantbook-engine/crates/ql-oplog/tests quantbook-engine/crates/ql-exec/tests -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:38:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:43:fn base_with_sheet(name: &str) -> OpLog {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:73:    let base = base_with_sheet("S").export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:145:    let base = base_with_sheet("S").export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:207:    let base = base_with_sheet("S").export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:253:    let base = base_with_sheet("S").export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:337:    let base = base_with_sheet("S").export_bytes().unwrap();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs:413:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:26:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:103:    let mut base_log = OpLog::new();
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:35:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:62:fn base_with_sheet() -> OpLog {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:76:    let mut log = base_with_sheet();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:111:/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:122:    log.set_peer_id(peer_id)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:164:    let base = base_with_sheet().export_bytes().unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:206:    let base = base_with_sheet().export_bytes().unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:268:    let base = base_with_sheet().export_bytes().unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:341:    let mut base_log = base_with_sheet();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:412:    let mut base_log = base_with_sheet();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:521:    let mut base_log = base_with_sheet();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:538:    peer_a.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:547:    peer_b_for_a.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:562:    peer_b.set_peer_id(2).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:572:    peer_a_for_b.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:698:    let base = base_with_sheet().export_bytes().unwrap();

exec
/bin/zsh -lc "git show --format=fuller --no-patch 815ecf0589e && git show --name-only --format='' 815ecf0589e" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
commit 815ecf0589eae380b901f6f0b867d705e6c5157f
Author:     steppen0mad <nurtaymergaliyev@gmail.com>
AuthorDate: Wed May 20 19:31:12 2026 +0100
Commit:     steppen0mad <nurtaymergaliyev@gmail.com>
CommitDate: Wed May 20 19:31:12 2026 +0100

    Phase 5.3 step 5 sub-cycle 5b — CollabSession::sync_workbook wrapper
    
    Closes the production-wiring HIGH from the step 5 megaudit (Opus-A
    Scenario E, 2026-05-20). The repair pass has existed since step 3
    (`e76a9ce5499`) but had ZERO non-test callers — `CollabSession::merge_bytes`
    was a thin wrapper around `OpLog::merge_bytes` and end-users running
    the canonical collab flow (`merge_bytes` + `replay_into` +
    `recompute`) would STILL see `#NAME?` for concurrent-rename formulas.
    The 5.3 ship was correct in-principle but not in-practice for any
    production code path. This wrapper closes the gap.
    
    Surface added:
    - `CollabSession::sync_workbook(&self, &mut Workbook, &FunctionRegistry)
      -> Result<SyncReport, CollabSessionError>` — atomically pairs
      `replay_into` with `repair_sheet_rename_chain` +
      `repair_table_rename_chain` per audit-locked D-5.3-1 caller contract.
    - `SyncReport { ops_replayed, sheet_repair, table_repair }` —
      combined diagnostic surface for a single log message.
    - `CollabSessionError::Replay(#[from] ReplayError)` — surfaces
      replay failures (e.g., V1 cross-source target collision hard-fails)
      as a session-level error.
    - Empty-log fast path: returns `SyncReport::default()` without
      invoking either pass.
    
    Caller contract preserved: `sync_workbook` is a CONVENIENCE wrapper;
    the raw `op_log()` accessor remains for snapshot inspection + tests.
    The audit-locked D-5.3-1 ("repair is caller-driven, NOT hooked into
    merge_bytes") still holds — `merge_bytes` does NOT auto-trigger
    repair; only `sync_workbook` does, and only when callers opt in.
    
    Integration tests (`tests/sync_workbook.rs`, 5 tests):
    - Empty-log fast path.
    - Single-peer happy path.
    - **Canonical D-3 V1-limitation closure scenario**: peer A renames
      S→S2; peer B concurrently writes `=S!A1`; sync_workbook merges +
      repair rewrites the formula text to `=S2!A1`.
    - Table-rename analog.
    - Error propagation: cross-source target collision (V1 limitation)
      surfaces as `CollabSessionError::Replay`.
    
    Bug found+fixed at test-write time: my first test version had each
    peer call `OpLog::new()` separately, which assigns a random Loro
    peer-id to each peer's BASE ops. Loro then treated both peers'
    `AddSheet("S")` as concurrent + distinct, firing D-2 auto-rename on
    merge. Refactored to a shared `base_bytes` snapshot — both peers fork
    from the same Loro doc. This is the per-step-1 audit closure pattern
    ("CRDT convergence requires stable non-zero peer-ids" —
    `crdt-data-model.md` § Peer-id stability).
    
    Workspace tests: 4338 → 4343 (+5 from 5b integration tests) with
    --test-threads=1. fmt + clippy clean.
    
    Remaining 5.3 work: 5c (repair_column_rename_chain), 6 (exit packet
    + 6-surface refresh).
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
quantbook-engine/crates/ql-collab/src/lib.rs
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-collab/tests/sync_workbook.rs

codex
The existing repair suites already cover idempotent repair, bidirectional convergence, batch traversal, and recompute at the lower/raw level. I’m going to run the new integration test target once, then I’ll classify whether any remaining gaps are production blockers or just wrapper-level coverage holes.
exec
/bin/zsh -lc 'cargo test -p ql-collab --test sync_workbook -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 346ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.10s
     Running tests/sync_workbook.rs (target/debug/deps/sync_workbook-0d2b2fe5b741c1c1)

running 5 tests
test sync_workbook_concurrent_rename_sheet_plus_edit_repair_fires ... ok
test sync_workbook_concurrent_rename_table_plus_edit_repair_fires ... ok
test sync_workbook_empty_log_fast_path_returns_default_report ... ok
test sync_workbook_replay_error_surfaces_via_session_error_variant ... ok
test sync_workbook_single_peer_applies_replay ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs | sed -n '320,390p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   320	
   321	/// **Step 2:** triple-peer concurrent rename. All three peers
   322	/// concurrently rename the same sheet to DIFFERENT targets. After
   323	/// merge, all peers must converge on the same name.
   324	///
   325	/// **Audit closure (Opus MEDIUM-3):** the original test used star-
   326	/// merge (every peer pulls every other peer's bytes), but star-merge
   327	/// gives all three peers byte-equivalent merged logs — assertions
   328	/// A==B and B==C are a tautology under that pattern. A real
   329	/// transitivity test exercises DIFFERENT merge sequences (e.g. A
   330	/// merges B then C; B merges C then A; C merges A then B) and
   331	/// asserts the final state still converges. Loro's CRDT semantic
   332	/// SHOULD make this hold via commutativity + associativity of the
   333	/// underlying op apply — but the test must exercise that, not
   334	/// merely the star case.
   335	#[test]
   336	fn step2_three_peer_concurrent_rename_converges() {
   337	    let base = base_with_sheet("S").export_bytes().unwrap();
   338	
   339	    const PEER_C_ID: u64 = 3;
   340	
   341	    let mk_peer = |peer_id: u64, target: &str| -> OpLog {
   342	        let mut log = fork_with_peer(&base, peer_id);
   343	        log.append(Op::RenameSheet {
   344	            id: 0,
   345	            old_name: "S".to_owned(),
   346	            new_name: target.to_owned(),
   347	        })
   348	        .unwrap();
   349	        log
   350	    };
   351	
   352	    // Peer A merges B then C (order: BC).
   353	    let mut peer_a_bc = mk_peer(PEER_A_ID, "Apple");
   354	    peer_a_bc
   355	        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
   356	        .unwrap();
   357	    peer_a_bc
   358	        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
   359	        .unwrap();
   360	
   361	    // Peer B merges C then A (order: CA).
   362	    let mut peer_b_ca = mk_peer(PEER_B_ID, "Banana");
   363	    peer_b_ca
   364	        .merge_bytes(&mk_peer(PEER_C_ID, "Cherry").export_bytes().unwrap())
   365	        .unwrap();
   366	    peer_b_ca
   367	        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
   368	        .unwrap();
   369	
   370	    // Peer C merges A then B (order: AB).
   371	    let mut peer_c_ab = mk_peer(PEER_C_ID, "Cherry");
   372	    peer_c_ab
   373	        .merge_bytes(&mk_peer(PEER_A_ID, "Apple").export_bytes().unwrap())
   374	        .unwrap();
   375	    peer_c_ab
   376	        .merge_bytes(&mk_peer(PEER_B_ID, "Banana").export_bytes().unwrap())
   377	        .unwrap();
   378	
   379	    let wb_a = replay_into_fresh(&peer_a_bc);
   380	    let wb_b = replay_into_fresh(&peer_b_ca);
   381	    let wb_c = replay_into_fresh(&peer_c_ab);
   382	
   383	    let name_a = wb_a.sheet(0).unwrap().name().to_owned();
   384	    let name_b = wb_b.sheet(0).unwrap().name().to_owned();
   385	    let name_c = wb_c.sheet(0).unwrap().name().to_owned();
   386	
   387	    // **Genuine transitivity test**: 3 peers, 3 different merge
   388	    // orderings (BC vs CA vs AB), all converge to the same final
   389	    // state. Pre-closure star-merge made this assertion trivial.
   390	    assert_eq!(name_a, name_b, "transitivity A(BC) == B(CA)");

exec
/bin/zsh -lc 'rg -n "BatchCommit|chain|S2|S3|idempotent|three|3-peer|3 peer|recompute|resolves" quantbook-engine/crates/ql-collab/tests/repair_renames.rs quantbook-engine/crates/ql-collab/tests/repair_tables.rs quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:17://!   5. Replay + recompute via `replay_and_recompute`.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:29://!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:31://!   between replay and recompute (caller-driven per audit-locked
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:92:/// Replay log into a fresh workbook + recompute. Mirror of D-4's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:94:fn replay_and_recompute(log: &OpLog) -> Workbook {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:100:        rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:130:/// replayed+recomputed workbooks `(wb_after_a_merges_b,
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:154:    (replay_and_recompute(&peer_a), replay_and_recompute(&peer_b))
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:251:/// and recompute observes final state."
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:259:/// order. Recompute then resolves based on read-cascade priority,
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:402:/// test bundled SetName + PutFormula per peer in a BatchCommit,
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:447:        "TaxRate resolves to 0.21 or 0.42; got {a1_a:?}"
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:504:/// peer A renames sheet "S" to "S2"; peer B concurrently writes a
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:506:/// `ql_collab::repair_sheet_rename_chain` + recompute, the formula's
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:507:/// text is REWRITTEN to "S2!A1" and the cell resolves to 42.0 (the
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:508:/// literal at S2!A1, originally at S!A1 before rename).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:511:/// without the repair pass, the formula bind-failed at recompute →
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:519:fn row7_rename_sheet_concurrent_edit_resolves_via_repair_pass() {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:534:    // the repair pass between replay and recompute. The fork helper
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:543:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:577:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:584:    // Replay + REPAIR PASS (Phase 5.3 step 3 work) + recompute.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:585:    let replay_repair_recompute = |log: &OpLog| -> Workbook {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:591:        // this call, recompute would surface #NAME? (D-3 V1 limitation).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:592:        let report = ql_collab::repair_sheet_rename_chain(&mut wb, log)
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:593:            .expect("repair_sheet_rename_chain must succeed");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:600:            rt.recompute_all();
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:605:    let wb_a = replay_repair_recompute(&peer_a);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:606:    let wb_b = replay_repair_recompute(&peer_b);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:611:    assert_eq!(a2_a, a2_b, "convergence on S2!A2 across merge directions");
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:612:    // **POST-STEP-3 assertion**: repair rewrote `S!A1` → `S2!A1`; the
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:613:    // cell at S2!A1 is the literal 42.0 from the base log.
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:617:        "post-repair: formula resolves correctly via rewritten text (S!A1 → S2!A1); \
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:624:        Some("S2!A1".to_string()),
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:625:        "formula text post-repair must reference current sheet name (S2)"
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:634:/// `T[X]` reference binds to UnknownTable → recompute emits
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:646:/// recompute, the formula binds against current table table (which
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:720:    let wb_first = replay_and_recompute(&peer_a);
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:724:    let wb_second = replay_and_recompute(&reloaded);
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:9://! - BatchCommit traversal
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:12:use ql_collab::{repair_table_rename_chain, TableRepairReport};
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:97:    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:139:    let report: TableRepairReport = repair_table_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:155:/// idempotent skip if new_name matches the current table state.
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:259:// ===== Test 7: Audit closure — transitive chain T → T2 → T3 + concurrent formula =====
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:262:/// chain (sequential single-peer T → T2 → T3) with a concurrent
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:266:fn step4_audit_transitive_table_chain_to_final_name() {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:296:    let _report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:301:        "transitive chain: T → T2 → T3 rewrites T references directly to T3 (skipping intermediate T2)"
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:305:// ===== Test 8: Audit closure — BatchCommit traversal =====
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:308:/// `collect_table_renames` correctly walks BatchCommit-nested
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:311:/// PutFormula in one BatchCommit.
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:316:    // Peer A: BatchCommit-wrapped rename.
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:319:        .append(Op::BatchCommit {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:339:    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:343:        "BatchCommit-nested RenameTable must be discovered by the chain walker"
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:354:fn table_repair_is_idempotent() {
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:375:    let first = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:377:    let second = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_tables.rs:439:    let report = repair_table_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:1://! Phase 5.3 step 3 (CORE 5.3 work) — `ql_collab::repair_sheet_rename_chain`
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:17://!   6. `repair_sheet_rename_chain(&mut wb, &log)`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:18://!   7. Assert formula text + (optionally) recomputed value.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:20://! NOTE: these tests don't recompute (no ql-functions in ql-collab's
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:25:use ql_collab::{repair_sheet_rename_chain, RepairReport};
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:51:/// it; we don't recompute (that's a downstream test concern).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:72:/// **Step 3 PRIMARY property**: peer A renames sheet S → S2;
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:74:/// After merge + repair, the formula text is rewritten to `=S2!A1`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:78:/// recompute → #NAME?. Post-step-3 the formula references the current
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:79:/// sheet name and resolves correctly.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:90:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:101:    assert_eq!(wb.sheet(0).unwrap().name(), "S2");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:109:    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:114:        Some("S2!A1".to_string()),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:115:        "post-repair formula text references current sheet name (S2)"
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:123:    assert_eq!(report.sheet_rewrites[0].current_display_name, "S2");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:127:// ===== Test 2: Transitive chain (sequential renames) =====
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:129:/// **Step 3:** sequential rename chain S → S2 → S3 (single peer
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:131:/// Repair should rewrite the formula to `=S3!A1` (the final name)
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:134:fn repair_handles_transitive_chain_to_final_name() {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:137:    // Peer A: chain S → S2 → S3.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:143:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:149:            old_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:150:            new_name: "S3".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:168:    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:170:    // Formula rewritten directly to the final name S3 (skipping S2).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:173:        Some("S3!A1".to_string()),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:174:        "transitive chain: S → S2 → S3 rewrites S references directly to S3"
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:178:// ===== Test 3: Rename-back (chain collapses) =====
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:180:/// **Step 3:** rename-back chain S → S2 → S. Peer B writes
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:181:/// `=S2!A1` (referencing the intermediate). After repair:
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:182:/// formula references S (the current name), because S2 is now a
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:183:/// historic name in the chain.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:188:    // Peer A: S → S2 → S (final = original).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:194:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:200:            old_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:205:    // Peer B references the INTERMEDIATE name S2.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:212:            text: "S2!A1".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:221:    let _report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:223:    // S2 was historic; repair rewrites S2 → S (current name).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:227:        "rename-back: S2 references rewritten to current name S"
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:254:    // Peer A: rename S → S2 (id 0).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:260:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:278:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:299:fn repair_is_idempotent() {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:306:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:317:    let first = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:320:    let second = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:354:    let report = repair_sheet_rename_chain(&mut wb, &log).expect("repair on no-rename log");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:364:// ===== Test 7: Step 2 auto-disambiguation chain =====
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:369:/// `=S3!A1` referencing sheet 1's original name. After merge +
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:374:    // Base: 2 sheets (S1 = id 0, S3 = id 1).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:384:            name: "S3".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:399:    // Peer B: rename sheet 1 (S3) → X (concurrent, target collision
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:401:    // referencing the OLD name S3.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:406:            old_name: "S3".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:415:            text: "S3!B1".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:426:    repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:428:    // Sheet 1's formula referencing old S3 → rewritten to current X(2).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:441:// ===== Test 8: BatchCommit-wrapped rename =====
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:443:/// **Step 3:** the producer-side rename emits in a `BatchCommit`
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:445:/// BatchCommits to find nested `Op::RenameSheet`.
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:450:    // Peer A: rename via BatchCommit (mirrors producer pattern).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:453:        .append(Op::BatchCommit {
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:476:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).expect("repair must succeed");
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:479:        "BatchCommit-nested RenameSheet must be discovered by the chain walker"
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:501:        new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:519:    repair_sheet_rename_chain(&mut wb_a, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:530:    repair_sheet_rename_chain(&mut wb_b, &peer_b).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:539:        Some("S2!A1".to_string())
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:567:    let report: RepairReport = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:661:    let report = repair_sheet_rename_chain(&mut wb, &peer_a).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:730:    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:785:            new_name: "S2".to_owned(),
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:797:    let report = repair_sheet_rename_chain(&mut wb, &log).unwrap();
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:801:    // becomes `S2` (sheet 0's current name).
quantbook-engine/crates/ql-collab/tests/repair_renames.rs:804:        Some("S2!A1".to_string()),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_renames.rs | sed -n '330,370p;540,610p;610,670p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   578	    // **Audit closure (Opus LOW-2):** strengthened from "contains" to
   579	    // pin BOTH occurrences explicitly.
   580	    let f = wb.formula_at(0, 0, 0).unwrap();
   581	    assert!(
   582	        f.contains("Calculations!A1"),
   583	        "first ref must be rewritten; got: {f}"
   584	    );
   585	    assert!(
   586	        f.contains("Calculations!B2"),
   587	        "second ref must be rewritten; got: {f}"
   588	    );
   589	    assert!(
   590	        !f.contains("Sheet1!"),
   591	        "no Sheet1 references should remain; got: {f}"
   592	    );
   593	}
   594	
   595	// ===== Test 11: Step-3 audit Codex+Opus HIGH-1 (cascade closure) =====
   596	
   597	/// **Step 3 audit closure (Codex+Opus HIGH-1):** sheet 0 renamed
   598	/// `A → B`; sheet 1 (which existed initially as `B`) renamed
   599	/// `B → C`. Pre-closure both rules would land in the rule vec and
   600	/// applying them iteratively would cascade `A!X → B!X → C!X` —
   601	/// silently retargeting a formula meant for sheet 0 (now named B)
   602	/// to sheet 1. Post-closure: the rule `B → C` is SKIPPED because
   603	/// `B` is currently held by sheet 0; formula `A!X` rewrites to
   604	/// `B!X` correctly.
   605	///
   606	/// To produce this scenario via the op log: base has sheet 0 (initially
   607	/// `A`) and sheet 1 (initially `B`). One peer renames sheet 1
   608	/// `B → C` and sheet 0 `A → B`. (Order matters at producer side; here
   609	/// we batch them into a single peer's log for simplicity.)
   610	#[test]
   610	#[test]
   611	fn step3_audit_cross_sheet_cascade_does_not_corrupt_formula() {
   612	    // Base: sheet 0 = "A", sheet 1 = "B".
   613	    let mut base_log = OpLog::new();
   614	    base_log
   615	        .append(Op::AddSheet {
   616	            name: "A".to_owned(),
   617	            chunk_rows: 16384,
   618	        })
   619	        .unwrap();
   620	    base_log
   621	        .append(Op::AddSheet {
   622	            name: "B".to_owned(),
   623	            chunk_rows: 16384,
   624	        })
   625	        .unwrap();
   626	    let base = base_log.export_bytes().unwrap();
   627	
   628	    // Peer A: rename sheet 1 (B → C) AND sheet 0 (A → B). Both at peer 1.
   629	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   630	    peer_a
   631	        .append(Op::RenameSheet {
   632	            id: 1,
   633	            old_name: "B".to_owned(),
   634	            new_name: "C".to_owned(),
   635	        })
   636	        .unwrap();
   637	    peer_a
   638	        .append(Op::RenameSheet {
   639	            id: 0,
   640	            old_name: "A".to_owned(),
   641	            new_name: "B".to_owned(),
   642	        })
   643	        .unwrap();
   644	
   645	    // Peer B: concurrent formula referencing original sheet 0 by name "A".
   646	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   647	    peer_b
   648	        .append(Op::PutFormula {
   649	            sheet: 0,
   650	            row: 0,
   651	            col: 0,
   652	            text: "A!A1".to_owned(),
   653	        })
   654	        .unwrap();
   655	
   656	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   657	    let mut wb = replay_to_workbook(&peer_a);
   658	    assert_eq!(wb.sheet(0).unwrap().name(), "B");
   659	    assert_eq!(wb.sheet(1).unwrap().name(), "C");
   660	
   661	    let report = repair_sheet_rename_chain(&mut wb, &peer_a).unwrap();
   662	
   663	    // Formula must rewrite to "B!A1" (sheet 0's current name).
   664	    // Pre-closure the cascade would have produced "C!A1" (sheet 1)
   665	    // because rule (B → C) would cascade-apply to the just-rewritten
   666	    // "B!A1".
   667	    assert_eq!(
   668	        wb.formula_at(0, 0, 0).map(|s| s.to_string()),
   669	        Some("B!A1".to_string()),
   670	        "post-closure: A → B applies, B → C is skipped because B is current. \

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '108,150p;180,260p;300,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   108	// ===== Test 2: No-rename log → fast-path no-op =====
   109	
   110	#[test]
   111	fn repair_with_no_table_renames_is_noop() {
   112	    let mut log = OpLog::new();
   113	    log.append(Op::AddSheet {
   114	        name: "S".to_owned(),
   115	        chunk_rows: 16384,
   116	    })
   117	    .unwrap();
   118	    log.append(Op::CreateTable {
   119	        name: "T".to_owned(),
   120	        sheet: 0,
   121	        top_row: 0,
   122	        top_col: 0,
   123	        rows: 2,
   124	        cols: 1,
   125	        has_header: true,
   126	        has_totals: false,
   127	        column_names: vec!["X".to_owned()],
   128	    })
   129	    .unwrap();
   130	    log.append(Op::PutFormula {
   131	        sheet: 0,
   132	        row: 5,
   133	        col: 0,
   134	        text: "T[X]".to_owned(),
   135	    })
   136	    .unwrap();
   137	
   138	    let mut wb = replay_to_workbook(&log);
   139	    let report: TableRepairReport = repair_table_rename_chain(&mut wb, &log).unwrap();
   140	
   141	    assert_eq!(report.formulas_rewritten, 0);
   142	    assert!(report.table_rewrites.is_empty());
   143	    assert_eq!(
   144	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   145	        Some("T[X]".to_string())
   146	    );
   147	}
   148	
   149	// ===== Test 3: Step 4 replay last-wins — concurrent same-table rename =====
   150	
   180	    // under SOME canonical name. (Idempotent same-name case + T→T2
   181	    // case both leave a valid state.)
   182	    let count = wb.tables().iter().count();
   183	    assert_eq!(count, 1, "exactly one table after merge");
   184	}
   185	
   186	// ===== Test 4: Step 4 audit closure — cross-table target collision V1 limitation =====
   187	
   188	/// **Step 4 audit closure (Codex+Opus HIGH-1, 2026-05-20):** two
   189	/// peers concurrently rename DIFFERENT tables to the SAME target.
   190	/// Pre-audit-closure: replay auto-disambig'd to {X, X(2)} but the
   191	/// repair pass mishandled the auto-disambig'd canonical, causing
   192	/// silent formula corruption. Post-audit-closure: replay HARD-FAILS
   193	/// via `TableCreateRejected`. Documented V1 limitation.
   194	#[test]
   195	fn step4_audit_cross_table_target_collision_hard_fails() {
   196	    // Base: 2 tables T1 + T3.
   197	    let mut base_log = OpLog::new();
   198	    base_log
   199	        .append(Op::AddSheet {
   200	            name: "S".to_owned(),
   201	            chunk_rows: 16384,
   202	        })
   203	        .unwrap();
   204	    base_log
   205	        .append(Op::CreateTable {
   206	            name: "T1".to_owned(),
   207	            sheet: 0,
   208	            top_row: 0,
   209	            top_col: 0,
   210	            rows: 2,
   211	            cols: 1,
   212	            has_header: true,
   213	            has_totals: false,
   214	            column_names: vec!["A".to_owned()],
   215	        })
   216	        .unwrap();
   217	    base_log
   218	        .append(Op::CreateTable {
   219	            name: "T3".to_owned(),
   220	            sheet: 0,
   221	            top_row: 5,
   222	            top_col: 0,
   223	            rows: 2,
   224	            cols: 1,
   225	            has_header: true,
   226	            has_totals: false,
   227	            column_names: vec!["B".to_owned()],
   228	        })
   229	        .unwrap();
   230	    let base = base_log.export_bytes().unwrap();
   231	
   232	    // Peer A: rename T1 → X. Peer B: rename T3 → X. Both valid locally.
   233	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   234	    peer_a
   235	        .append(Op::RenameTable {
   236	            old_name: "T1".to_owned(),
   237	            new_name: "X".to_owned(),
   238	        })
   239	        .unwrap();
   240	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   241	    peer_b
   242	        .append(Op::RenameTable {
   243	            old_name: "T3".to_owned(),
   244	            new_name: "X".to_owned(),
   245	        })
   246	        .unwrap();
   247	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   248	
   249	    // Replay must hard-fail with TableCreateRejected. V1 limitation.
   250	    let mut wb = Workbook::new();
   251	    let reg = ql_functions::default_registry();
   252	    let result = replay_into(&peer_a, &mut wb, &reg);
   253	    assert!(
   254	        result.is_err(),
   255	        "post-audit-closure: cross-source target collision hard-fails (V1 limitation, audit-locked)"
   256	    );
   257	}
   258	
   259	// ===== Test 7: Audit closure — transitive chain T → T2 → T3 + concurrent formula =====
   260	
   300	        Some("T3[A]".to_string()),
   301	        "transitive chain: T → T2 → T3 rewrites T references directly to T3 (skipping intermediate T2)"
   302	    );
   303	}
   304	
   305	// ===== Test 8: Audit closure — BatchCommit traversal =====
   306	
   307	/// **Step 4 audit closure (Opus MEDIUM-4):** verify that
   308	/// `collect_table_renames` correctly walks BatchCommit-nested
   309	/// `Op::RenameTable` ops. The recursive code-path is exercised on
   310	/// real CRDT-merge scenarios where producer-side bundles rename +
   311	/// PutFormula in one BatchCommit.
   312	#[test]
   313	fn step4_audit_batchcommit_nested_table_rename_traverses_correctly() {
   314	    let base = base_with_table("T").export_bytes().unwrap();
   315	
   316	    // Peer A: BatchCommit-wrapped rename.
   317	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   318	    peer_a
   319	        .append(Op::BatchCommit {
   320	            ops: vec![Op::RenameTable {
   321	                old_name: "T".to_owned(),
   322	                new_name: "T2".to_owned(),
   323	            }],
   324	        })
   325	        .unwrap();
   326	    // Peer B: concurrent formula referencing the old name.
   327	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   328	    peer_b
   329	        .append(Op::PutFormula {
   330	            sheet: 0,
   331	            row: 5,
   332	            col: 0,
   333	            text: "T[A]".to_owned(),
   334	        })
   335	        .unwrap();
   336	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   337	
   338	    let mut wb = replay_to_workbook(&peer_a);
   339	    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   340	
   341	    assert_eq!(
   342	        report.formulas_rewritten, 1,
   343	        "BatchCommit-nested RenameTable must be discovered by the chain walker"
   344	    );
   345	    assert_eq!(

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_renames.rs | sed -n '127,178p;441,485p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/repair_tables.rs | sed -n '259,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   259	// ===== Test 7: Audit closure — transitive chain T → T2 → T3 + concurrent formula =====
   260	
   261	/// **Step 4 audit closure (Opus LOW-2):** transitive table rename
   262	/// chain (sequential single-peer T → T2 → T3) with a concurrent
   263	/// peer's formula referencing the original name. Repair must
   264	/// rewrite `T[A]` → `T3[A]` (skipping the intermediate T2).
   265	#[test]
   266	fn step4_audit_transitive_table_chain_to_final_name() {
   267	    let base = base_with_table("T").export_bytes().unwrap();
   268	
   269	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   270	    peer_a
   271	        .append(Op::RenameTable {
   272	            old_name: "T".to_owned(),
   273	            new_name: "T2".to_owned(),
   274	        })
   275	        .unwrap();
   276	    peer_a
   277	        .append(Op::RenameTable {
   278	            old_name: "T2".to_owned(),
   279	            new_name: "T3".to_owned(),
   280	        })
   281	        .unwrap();
   282	
   283	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   284	    peer_b
   285	        .append(Op::PutFormula {
   286	            sheet: 0,
   287	            row: 5,
   288	            col: 0,
   289	            text: "T[A]".to_owned(),
   290	        })
   291	        .unwrap();
   292	
   293	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   294	    let mut wb = replay_to_workbook(&peer_a);
   295	
   296	    let _report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   297	
   298	    assert_eq!(
   299	        wb.formula_at(0, 5, 0).map(|s| s.to_string()),
   300	        Some("T3[A]".to_string()),
   301	        "transitive chain: T → T2 → T3 rewrites T references directly to T3 (skipping intermediate T2)"
   302	    );
   303	}
   304	
   305	// ===== Test 8: Audit closure — BatchCommit traversal =====
   306	
   307	/// **Step 4 audit closure (Opus MEDIUM-4):** verify that
   308	/// `collect_table_renames` correctly walks BatchCommit-nested
   309	/// `Op::RenameTable` ops. The recursive code-path is exercised on
   310	/// real CRDT-merge scenarios where producer-side bundles rename +
   311	/// PutFormula in one BatchCommit.
   312	#[test]
   313	fn step4_audit_batchcommit_nested_table_rename_traverses_correctly() {
   314	    let base = base_with_table("T").export_bytes().unwrap();
   315	
   316	    // Peer A: BatchCommit-wrapped rename.
   317	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   318	    peer_a
   319	        .append(Op::BatchCommit {
   320	            ops: vec![Op::RenameTable {
   321	                old_name: "T".to_owned(),
   322	                new_name: "T2".to_owned(),
   323	            }],
   324	        })
   325	        .unwrap();
   326	    // Peer B: concurrent formula referencing the old name.
   327	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   328	    peer_b
   329	        .append(Op::PutFormula {
   330	            sheet: 0,
   331	            row: 5,
   332	            col: 0,
   333	            text: "T[A]".to_owned(),
   334	        })
   335	        .unwrap();
   336	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   337	
   338	    let mut wb = replay_to_workbook(&peer_a);
   339	    let report = repair_table_rename_chain(&mut wb, &peer_a).unwrap();
   340	
   341	    assert_eq!(
   342	        report.formulas_rewritten, 1,
   343	        "BatchCommit-nested RenameTable must be discovered by the chain walker"
   344	    );
   345	    assert_eq!(

 succeeded in 0ms:
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

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/phase_5_3_step2_rename_concurrent.rs | sed -n '390,480p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   390	    assert_eq!(name_a, name_b, "transitivity A(BC) == B(CA)");
   391	    assert_eq!(name_b, name_c, "transitivity B(CA) == C(AB)");
   392	    assert!(
   393	        ["Apple", "Banana", "Cherry"].contains(&name_a.as_str()),
   394	        "winner must be one of the three concurrent renames; got {name_a:?}"
   395	    );
   396	}
   397	
   398	/// **Step 2 audit closure (Codex + Opus convergent HIGH-1):** two
   399	/// peers concurrently rename DIFFERENT sheets to the SAME target
   400	/// name. Pre-closure this hard-failed replay via
   401	/// `SheetRenameRejected { source: Duplicate }` — same blast radius
   402	/// as the original step-2 bug it was meant to close, just shifted
   403	/// to a different concurrent scenario.
   404	///
   405	/// Post-closure: replay auto-disambiguates via D-2-style suffix
   406	/// walk (`X` → `X(2)`). Final state has both sheets renamed (one
   407	/// to `X`, the other to `X(2)`), depending on which causal order
   408	/// the merged log applies.
   409	#[test]
   410	fn step2_audit_concurrent_rename_to_same_target_auto_disambiguates() {
   411	    // Base: 3 sheets — peer A renames sheet 0; peer B renames sheet 1.
   412	    // Sheet 2 unused; gives the base "two sheets with distinct names".
   413	    let mut base_log = OpLog::new();
   414	    base_log
   415	        .append(Op::AddSheet {
   416	            name: "S1".to_owned(),
   417	            chunk_rows: 16384,
   418	        })
   419	        .unwrap();
   420	    base_log
   421	        .append(Op::AddSheet {
   422	            name: "S3".to_owned(),
   423	            chunk_rows: 16384,
   424	        })
   425	        .unwrap();
   426	    let base = base_log.export_bytes().unwrap();
   427	
   428	    // Peer A renames sheet 0 (S1) → X. Peer B (concurrent) renames
   429	    // sheet 1 (S3) → X. Both valid locally; merge must auto-disambiguate.
   430	    let mut peer_a = fork_with_peer(&base, PEER_A_ID);
   431	    peer_a
   432	        .append(Op::RenameSheet {
   433	            id: 0,
   434	            old_name: "S1".to_owned(),
   435	            new_name: "X".to_owned(),
   436	        })
   437	        .unwrap();
   438	    let mut peer_b_for_a = fork_with_peer(&base, PEER_B_ID);
   439	    peer_b_for_a
   440	        .append(Op::RenameSheet {
   441	            id: 1,
   442	            old_name: "S3".to_owned(),
   443	            new_name: "X".to_owned(),
   444	        })
   445	        .unwrap();
   446	    peer_a
   447	        .merge_bytes(&peer_b_for_a.export_bytes().unwrap())
   448	        .expect("merge must succeed; auto-disambiguation prevents hard-fail");
   449	
   450	    // Symmetric direction.
   451	    let mut peer_b = fork_with_peer(&base, PEER_B_ID);
   452	    peer_b
   453	        .append(Op::RenameSheet {
   454	            id: 1,
   455	            old_name: "S3".to_owned(),
   456	            new_name: "X".to_owned(),
   457	        })
   458	        .unwrap();
   459	    let mut peer_a_for_b = fork_with_peer(&base, PEER_A_ID);
   460	    peer_a_for_b
   461	        .append(Op::RenameSheet {
   462	            id: 0,
   463	            old_name: "S1".to_owned(),
   464	            new_name: "X".to_owned(),
   465	        })
   466	        .unwrap();
   467	    peer_b
   468	        .merge_bytes(&peer_a_for_b.export_bytes().unwrap())
   469	        .expect("merge must succeed (symmetric)");
   470	
   471	    let wb_a = replay_into_fresh(&peer_a);
   472	    let wb_b = replay_into_fresh(&peer_b);
   473	
   474	    // After merge: one sheet gets "X", the other gets "X(2)". Both
   475	    // peers must converge on the same id→name mapping.
   476	    let names_a: Vec<String> = (0..wb_a.sheet_count() as u16)
   477	        .map(|i| wb_a.sheet(i).unwrap().name().to_owned())
   478	        .collect();
   479	    let names_b: Vec<String> = (0..wb_b.sheet_count() as u16)
   480	        .map(|i| wb_b.sheet(i).unwrap().name().to_owned())

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs | sed -n '1,130p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Phase 5.3 conflict-matrix probe tests — pin the audit-locked
     2	//! "last-in-causal-order wins" defaults from `crdt-data-model.md`
     3	//! § Conflict resolution semantics (Phase 5.3 preview).
     4	//!
     5	//! Most rows in the matrix are correct by Loro's underlying CRDT
     6	//! merge (Fugue/origin-based with peer-id tiebreaker). These tests
     7	//! make that load-bearing — any future regression in either Loro's
     8	//! semantics OR our op-replay path trips a test.
     9	//!
    10	//! Pattern: D-4's `phase_5_2_d4_spill_2peer_probe.rs` template.
    11	//! Each test:
    12	//!   1. Build a shared base log (common causal ancestor).
    13	//!   2. Fork peer A + peer B by `import_bytes(&base_bytes)`.
    14	//!   3. Each peer appends its local op.
    15	//!   4. Exchange via `export_bytes` + `merge_bytes` — in BOTH
    16	//!      directions when the test verifies convergence.
    17	//!   5. Replay + recompute via `replay_and_recompute`.
    18	//!   6. Assert final workbook state.
    19	//!
    20	//! Coverage of the 8-row matrix at `crdt-data-model.md:320-329`:
    21	//! - Row 1: PutValue × PutValue same address — pinned here
    22	//! - Row 2: PutFormula × PutFormula same address — pinned here
    23	//! - Row 3: PutValue × PutFormula same address — pinned here
    24	//! - Row 4: ClearFormula × PutFormula same address — pinned here
    25	//! - Row 5: SetName concurrent same name — pinned here
    26	//! - Row 6: AddSheet × AddSheet same name (D-2 auto-rename) — pinned here
    27	//! - Row 7: RenameSheet × concurrent edit on sheet — pinned here as
    28	//!   **post-fix behavior** (formula text rewritten + correct value
    29	//!   resolves) via `ql_collab::repair_sheet_rename_chain` shipped in
    30	//!   Phase 5.3 step 3 (`e76a9ce5499`). The test invokes the repair pass
    31	//!   between replay and recompute (caller-driven per audit-locked
    32	//!   D-5.3-1).
    33	//! - Row 8: DropTable × concurrent edit referencing T — pinned here
    34	//!   (D-3 → #NAME?; no repair planned — drop is destructive)
    35	//!
    36	//! "Last-in-causal-order wins" means the CRDT picks ONE value
    37	//! deterministically; both merge directions converge to the same
    38	//! state. The tests verify CONVERGENCE (both peers see the same
    39	//! final state) — they don't predict WHICH op wins (that depends
    40	//! on Loro's internal peer-id tiebreaker, which we don't pin).
    41	//!
    42	//! Audit-discipline NOTE (step 1 audit closure, both Codex HIGH
    43	//! and Opus HIGH-1): value-only assertions are NOT load-bearing.
    44	//! A test that checks `Value::Number(7.0)` after concurrent
    45	//! literal-7 and formula-3+4 cannot distinguish which op won
    46	//! (both produce 7.0) AND would pass even if structural state
    47	//! diverges (e.g. peer A has formula_at=None, peer B has
    48	//! formula_at=Some). Convergence tests at the same address MUST
    49	//! additionally assert `formula_at` convergence to pin structural
    50	//! state, and SHOULD use distinct observable values (literal=7
    51	//! and formula="99-50"=49).
    52	
    53	use ql_exec::WorkbookRuntime;
    54	use ql_functions::default_registry;
    55	use ql_oplog::{replay_into, CellWireValue, NamedTargetWire, Op, OpLog};
    56	use ql_storage::Workbook;
    57	use ql_types::{Address, ErrorValue, Value};
    58	
    59	/// Build a base op log carrying `AddSheet("S")`. Most tests fork
    60	/// from this; the AddSheet × AddSheet test bypasses it (since it
    61	/// needs to test sheet-name collision directly).
    62	fn base_with_sheet() -> OpLog {
    63	    let mut log = OpLog::new();
    64	    log.append(Op::AddSheet {
    65	        name: "S".to_owned(),
    66	        chunk_rows: 16384,
    67	    })
    68	    .unwrap();
    69	    log
    70	}
    71	
    72	/// Build a base op log with sheet "S" + a `CreateTable("T")`
    73	/// covering A1:B3 with header row. Used by the DropTable conflict
    74	/// test (row 7).
    75	fn base_with_sheet_and_table() -> OpLog {
    76	    let mut log = base_with_sheet();
    77	    log.append(Op::CreateTable {
    78	        name: "T".to_owned(),
    79	        sheet: 0,
    80	        top_row: 0,
    81	        top_col: 0,
    82	        rows: 3,
    83	        cols: 2,
    84	        has_header: true,
    85	        has_totals: false,
    86	        column_names: vec!["X".to_owned(), "Y".to_owned()],
    87	    })
    88	    .unwrap();
    89	    log
    90	}
    91	
    92	/// Replay log into a fresh workbook + recompute. Mirror of D-4's
    93	/// helper.
    94	fn replay_and_recompute(log: &OpLog) -> Workbook {
    95	    let mut wb = Workbook::new();
    96	    let reg = default_registry();
    97	    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    98	    {
    99	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
   100	        rt.recompute_all();
   101	    }
   102	    wb
   103	}
   104	
   105	/// Stable peer ids for the two-peer fork. Loro's CRDT tiebreaker
   106	/// picks deterministic order ONLY when peer-ids are stable across
   107	/// the merge — if both directions use random `LoroDoc::new()` ids,
   108	/// the (peer-id pair) differs across directions and convergence
   109	/// breaks. PEER_A_ID < PEER_B_ID makes the order observable.
   110	///
   111	/// Both ids are non-zero (LEGACY_PEER reservation — `set_peer_id(0)`
   112	/// asserts post-step-8 audit closure).
   113	const PEER_A_ID: u64 = 1;
   114	const PEER_B_ID: u64 = 2;
   115	
   116	/// Build a freshly-forked `OpLog` carrying `base_bytes` and a fixed
   117	/// peer-id. New ops appended to this log carry `peer_id` in their
   118	/// Loro op-ids; the imported base ops retain their original peer-id
   119	/// (Loro semantic — import preserves origin).
   120	fn fork_with_peer(base_bytes: &[u8], peer_id: u64) -> OpLog {
   121	    let mut log = OpLog::import_bytes(base_bytes).unwrap();
   122	    log.set_peer_id(peer_id)
   123	        .expect("set_peer_id with non-zero id must succeed");
   124	    log
   125	}
   126	
   127	/// Fork two peers from `base_bytes` with STABLE peer-ids, apply
   128	/// `op_a` on peer A (id = `PEER_A_ID`) and `op_b` on peer B
   129	/// (id = `PEER_B_ID`), then merge bidirectionally. Returns the two
   130	/// replayed+recomputed workbooks `(wb_after_a_merges_b,

exec
/bin/zsh -lc 'rg -n "missing|absent|root container|container" quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-oplog/tests -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/log.rs:4://! JSON-encoded strings inside a single Loro `LoroList` container named
quantbook-engine/crates/ql-oplog/src/log.rs:29://! calling this fn). The reader probes the `"ops"` LoroList; if absent
quantbook-engine/crates/ql-oplog/src/log.rs:32:use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
quantbook-engine/crates/ql-oplog/src/log.rs:37:/// The Loro container name our ops live under. Hard-coded; Phase 5+
quantbook-engine/crates/ql-oplog/src/log.rs:38:/// CRDT-level refactoring may add more containers (versions, peer state,
quantbook-engine/crates/ql-oplog/src/log.rs:40:const OPS_CONTAINER: &str = "ops";
quantbook-engine/crates/ql-oplog/src/log.rs:42:/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
quantbook-engine/crates/ql-oplog/src/log.rs:45:/// `docs/architecture/crdt-data-model.md` § Presence container.
quantbook-engine/crates/ql-oplog/src/log.rs:48:const PRESENCE_CONTAINER: &str = "presence";
quantbook-engine/crates/ql-oplog/src/log.rs:101:        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:113:        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:120:                ValueOrContainer::Value(v) => v,
quantbook-engine/crates/ql-oplog/src/log.rs:121:                ValueOrContainer::Container(_) => {
quantbook-engine/crates/ql-oplog/src/log.rs:123:                        "ops LoroList holds a container; expected JSON-string values",
quantbook-engine/crates/ql-oplog/src/log.rs:147:    /// cost is one container handle lookup + a length read.
quantbook-engine/crates/ql-oplog/src/log.rs:149:        self.doc.get_list(OPS_CONTAINER).len()
quantbook-engine/crates/ql-oplog/src/log.rs:239:        let map = self.doc.get_map(PRESENCE_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:250:    /// holds a non-string or container value at `peer_key` (only
quantbook-engine/crates/ql-oplog/src/log.rs:252:    /// container; current API only writes strings).
quantbook-engine/crates/ql-oplog/src/log.rs:254:        let map = self.doc.get_map(PRESENCE_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:259:            ValueOrContainer::Value(v) => v,
quantbook-engine/crates/ql-oplog/src/log.rs:260:            ValueOrContainer::Container(_) => {
quantbook-engine/crates/ql-oplog/src/log.rs:262:                    "presence LoroMap holds a container value; expected JSON string",
quantbook-engine/crates/ql-oplog/src/log.rs:280:        let map = self.doc.get_map(PRESENCE_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:316:        let map = self.doc.get_map(PRESENCE_CONTAINER);
quantbook-engine/crates/ql-oplog/src/log.rs:330:    /// If the snapshot doesn't carry our `"ops"` container shape,
quantbook-engine/crates/ql-oplog/src/log.rs:332:    /// (Loro creates absent root containers on first access).
quantbook-engine/crates/ql-oplog/src/log.rs:343:    /// `loro-internal::container::richtext::tracker::crdt_rope`).
quantbook-engine/crates/ql-oplog/src/log.rs:622:        assert_eq!(log.len(), 0, "presence is not in the 'ops' container");
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step4_table_column_concurrent.rs:11://! Post-step-4: replay applies "advisory-skip" on missing source
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:2://! missing source (Codex HIGH + Opus-A V1 LIM #4, 2026-05-20).
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:14://! same table; final state: table absent), so the asymmetric failure
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:19://! Post-closure: `Op::DropTable` now advisory-skips on missing source,
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:21://! Both orderings now converge to "table absent."
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:72:/// because the source table is already gone. Final state: table absent.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:74:fn step5_drop_then_rename_succeeds_with_table_absent() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:95:    // Both T and T2 absent: drop removed T; rename advisory-skip (step 4).
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:109:fn step5_rename_then_drop_succeeds_with_table_absent_advisory_skip() {
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:138:    //       lookup miss). Empirically: T absent, T2 may be absent OR present.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:140:    //       (source gone). Final: both absent.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:141:    // The convergence property: T is ALWAYS absent. T2 may be present in
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:145:        "T must be absent post-merge regardless of causal order"
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:212:    // T MUST be absent in both views.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:215:        "T absent in peer A view"
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:219:        "T absent in peer B view"
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:233:    // related state. This triggers the non-idempotent missing-source
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:248:    // returns Ok(()) when both old and new canonicals are absent —
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:260:    // Confirm advisory-skip semantics: missing source + missing new = Ok.
quantbook-engine/crates/ql-oplog/tests/phase_5_3_step5_droptable_advisory_skip.rs:263:        "advisory-skip applies — both old and new tables absent, so the rename is dropped silently. \
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:110:    // only exercised `scope: None`, so a missing or wrong scope branch

exec
/bin/zsh -lc "rg -n \"pub fn export\\(|struct LoroDoc|fn commit\\(\" ~/.cargo/registry/src/index.crates.io-*/loro-1.12.0 ~/.cargo/registry/src/index.crates.io-*/loro-internal-1.12.0 -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:101:pub struct LoroDoc {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:593:    pub fn commit(&self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1302:    pub fn export(&self, mode: ExportMode) -> Result<Vec<u8>, LoroEncodeError> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/lib.rs:123:pub struct LoroDoc {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/lib.rs:141:pub struct LoroDocInner {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1983:    pub fn export(&self, mode: ExportMode) -> Result<Vec<u8>, LoroEncodeError> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:426:    pub fn commit(mut self) -> Result<Option<CommitOptions>, LoroError> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/utils/kv_wrapper.rs:45:    pub fn export(&self) -> Bytes {

exec
/bin/zsh -lc "rg -n \"fn get_list|get_list\\(\" ~/.cargo/registry/src -g '*.rs' | head -40" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:465:    pub fn get_list<I: IntoContainerId>(&self, id: I) -> LoroList {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:467:            handler: self.doc.get_list(id),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:477:            .try_get_list(id)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1183:    /// let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1717:/// // let coord = doc.get_list("coord");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1731:/// let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1891:    /// let list = doc.get_list("m");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1925:    /// let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1956:    /// let list = doc.get_list("my_list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_snapshot_fuzz.rs:177:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:217:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_golden_gen.rs:93:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/panic_test.rs:35:fn get_list_with_nonexistent_container_id_panics() {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/panic_test.rs:38:    let _list = doc.get_list(id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/panic_test.rs:82:    assert!(doc.try_get_list(id).is_none());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:366:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:821:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:916:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1113:    let list = doc.get_list("l");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1136:    doc.get_list(root_emoji.as_str()).push("y")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/change_store_test.rs:12:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:430:    let list_a = doc_a.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:33:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:102:    let redacted_list = redacted_doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:15:    doc.get_list("list").insert(0, "Counter")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:102:    doc.get_list("list").insert(0, 0)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:103:    doc.get_list("list").insert(1, 1)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:104:    doc.get_list("list").insert(2, 2)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:105:    doc.get_list("list").insert(1, 3)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:108:    doc.get_list("list").delete(0, 3)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:114:        new_doc.get_list("list").to_vec(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:146:    local.get_list("items").push("task")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:161:        local.get_list("items").get_deep_value().to_json_value(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:176:        local.get_list("items").get_deep_value().to_json_value(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:189:        local.get_list("items").get_deep_value().to_json_value(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:149:    a.get_list("items").push("a-only")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:19:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:52:    let list = doc.get_list("list");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:396:    let map = doc.get_list("list").insert_container(0, LoroMap::new())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/mod.rs:19:    let root_list = doc.get_list("list");

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,70p;600,635p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
   600	        // Exactly one value survives — LWW by (lamport, peer_id).
   601	        // Both peers had lamport=1 so peer-id tiebreaker picks B's
   602	        // value (20 > 10). Whichever loro chose, assert it's ONE of
   603	        // the two writes (no corruption) and that listing peers
   604	        // returns exactly one entry.
   605	        let value = peer_a.presence_get("shared-key").unwrap().unwrap();
   606	        assert!(
   607	            value == r#"{"from":"A"}"# || value == r#"{"from":"B"}"#,
   608	            "same-key concurrent write must produce one of the two values, got {value:?}"
   609	        );
   610	        assert_eq!(
   611	            peer_a.presence_peers(),
   612	            vec!["shared-key".to_owned()],
   613	            "same-key concurrent write must yield exactly one map entry"
   614	        );
   615	    }
   616	
   617	    #[test]
   618	    fn presence_independent_from_op_log() {
   619	        // Presence writes MUST NOT increment the op log len.
   620	        let mut log = OpLog::new();
   621	        log.presence_set("peer-a", "{}").unwrap();
   622	        assert_eq!(log.len(), 0, "presence is not in the 'ops' container");
   623	        assert!(log.is_empty());
   624	
   625	        // And vice-versa: appending an op MUST NOT touch presence.
   626	        log.append(put_value(0, 0, 0, 1.0)).unwrap();
   627	        assert_eq!(log.len(), 1);
   628	        assert!(log.presence_get("peer-a").unwrap().is_some());
   629	    }
   630	
   631	    #[test]
   632	    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
   633	        // Loro 1.12.0 reserves u64::MAX as an internal sentinel
   634	        // (`LoroError::InvalidPeerID`). Pin the rejection behavior so
   635	        // a future Loro upgrade can't silently change it.

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '450,485p;1290,1310p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '1968,2005p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   450	    #[inline]
   451	    pub fn try_get_movable_list<I: IntoContainerId>(&self, id: I) -> Option<LoroMovableList> {
   452	        self.doc
   453	            .try_get_movable_list(id)
   454	            .map(|handler| LoroMovableList { handler })
   455	    }
   456	
   457	    /// Get a [LoroList] by container id.
   458	    ///
   459	    /// If the provided id is string, it will be converted into a root container id with the name of the string.
   460	    /// Note: creating/accessing a root container does not record history; creating nested
   461	    /// containers (e.g., `Map::insert_container`) does.
   462	    ///
   463	    /// Panics if the container does not exist. Use [`try_get_list`] for a safe alternative.
   464	    #[inline]
   465	    pub fn get_list<I: IntoContainerId>(&self, id: I) -> LoroList {
   466	        LoroList {
   467	            handler: self.doc.get_list(id),
   468	        }
   469	    }
   470	
   471	    /// Try to get a [LoroList] by container id.
   472	    ///
   473	    /// Returns `None` if the container does not exist in the document.
   474	    #[inline]
   475	    pub fn try_get_list<I: IntoContainerId>(&self, id: I) -> Option<LoroList> {
   476	        self.doc
   477	            .try_get_list(id)
   478	            .map(|handler| LoroList { handler })
   479	    }
   480	
   481	    /// Get a [LoroMap] by container id.
   482	    ///
   483	    /// If the provided id is string, it will be converted into a root container id with the name of the string.
   484	    /// Note: creating/accessing a root container does not record history; creating nested
   485	    /// containers (e.g., `Map::insert_container`) does.
  1290	    ///
  1291	    /// // 1) Full snapshot
  1292	    /// let snapshot = doc.export(ExportMode::Snapshot).unwrap();
  1293	    ///
  1294	    /// // 2) All updates
  1295	    /// let all = doc.export(ExportMode::all_updates()).unwrap();
  1296	    ///
  1297	    /// // 3) Updates from another peer’s version vector
  1298	    /// let vv = doc.oplog_vv();
  1299	    /// let delta = doc.export(ExportMode::updates(&vv)).unwrap();
  1300	    /// assert!(!delta.is_empty());
  1301	    /// ```
  1302	    pub fn export(&self, mode: ExportMode) -> Result<Vec<u8>, LoroEncodeError> {
  1303	        self.doc.export(mode)
  1304	    }
  1305	
  1306	    /// Analyze the container info of the doc
  1307	    ///
  1308	    /// This is used for development and debugging. It can be slow.
  1309	    pub fn analyze(&self) -> DocAnalysis {
  1310	        self.doc.analyze()

 succeeded in 0ms:
  1968	
  1969	    /// Get the path from the root to the container
  1970	    pub fn get_path_to_container(&self, id: &ContainerID) -> Option<Vec<(ContainerID, Index)>> {
  1971	        let mut state = self.state.lock();
  1972	        if state.arena.id_to_idx(id).is_none() {
  1973	            if !state.does_container_exist(id) {
  1974	                return None;
  1975	            }
  1976	            state.ensure_container(id);
  1977	        }
  1978	        let idx = state.arena.id_to_idx(id).unwrap();
  1979	        state.get_path(idx)
  1980	    }
  1981	
  1982	    #[instrument(skip(self))]
  1983	    pub fn export(&self, mode: ExportMode) -> Result<Vec<u8>, LoroEncodeError> {
  1984	        self.with_barrier(|| {
  1985	            let ans = match mode {
  1986	                ExportMode::Snapshot => export_fast_snapshot(self),
  1987	                ExportMode::Updates { from } => export_fast_updates(self, &from),
  1988	                ExportMode::UpdatesInRange { spans } => {
  1989	                    export_fast_updates_in_range(&self.oplog.lock(), spans.as_ref())
  1990	                }
  1991	                ExportMode::ShallowSnapshot(f) => export_shallow_snapshot(self, &f)?,
  1992	                ExportMode::StateOnly(f) => match f {
  1993	                    Some(f) => export_state_only_snapshot(self, &f)?,
  1994	                    None => export_state_only_snapshot(self, &self.oplog_frontiers())?,
  1995	                },
  1996	                ExportMode::SnapshotAt { version } => export_snapshot_at(self, &version)?,
  1997	            };
  1998	            Ok(ans)
  1999	        })
  2000	    }
  2001	
  2002	    /// The doc only contains the history since the shallow history start version vector.
  2003	    ///
  2004	    /// This is empty if the doc is not shallow.
  2005	    ///

exec
/bin/zsh -lc 'rg -n "fn get_list|try_get_list|register_container|create.*container|get_map" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src -S | head -80' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:212:                    let (old_depth, calculator) = self.get_or_create_calc(container, depth);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:290:                        oplog.arena.register_container(c);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:314:                let idx = oplog.arena.register_container(&id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:980:    pub fn try_get_list<I: IntoContainerId>(&self, id: I) -> Option<ListHandler> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:991:    pub fn get_list<I: IntoContainerId>(&self, id: I) -> ListHandler {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:992:        self.try_get_list(id)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:993:            .expect("The container does not exist in the document. Use `try_get_list` or `get_container` to check for existence.")
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1020:    pub fn try_get_map<I: IntoContainerId>(&self, id: I) -> Option<MapHandler> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1031:    pub fn get_map<I: IntoContainerId>(&self, id: I) -> MapHandler {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1032:        self.try_get_map(id)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1033:            .expect("The container does not exist in the document. Use `try_get_map` or `get_container` to check for existence.")
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1250:    /// This method will not recreate containers with the same [ContainerID]s.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2385:        let map = doc.get_map("map");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2408:        let map = doc.get_map("map");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2553:        let map = src.get_map("map");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2736:        let map = loro.get_map("map");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container.rs:25:    // During a transaction, we may create some containers which are deleted later. And these containers also need a unique ContainerIdx.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container.rs:27:    // An empty store decodes the snapshot, it will create these containers in a sequence of natural numbers so that containers and ops can correspond one-to-one
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container.rs:297:        let idx = arena.register_container(&normal);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container.rs:310:        let idx = arena.register_container(&id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:654:    pub fn get_list<I: IntoContainerId>(&self, id: I) -> ListHandler {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:663:    pub fn get_map<I: IntoContainerId>(&self, id: I) -> MapHandler {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:191:        self.register_container_and_parent_link(&change);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:756:        let state = self.store.get_or_create_mut(op.container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:857:                    let child_idx = self.arena.register_container(&child_id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1079:                            let container_idx = self.arena.register_container(container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1101:                        let container_idx = self.arena.register_container(container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1150:                            let container_idx = self.arena.register_container(container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1167:                        let container_idx = self.arena.register_container(container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1197:        let idx = self.arena.register_container(id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1333:            self.arena.register_container(id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1488:    pub fn create_state(&self, idx: ContainerIdx) -> State {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1494:    pub fn create_unknown_state(&self, idx: ContainerIdx) -> State {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1499:        let idx = self.arena.register_container(&pos.container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1566:                            state_idx = CurContainer::Container(self.arena.register_container(c));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1574:                            state_idx = CurContainer::Container(self.arena.register_container(c));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1580:                            state_idx = CurContainer::Container(self.arena.register_container(c));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1600:                            .register_container(&node.associated_meta_container());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1608:                        state_idx = CurContainer::Container(self.arena.register_container(c));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1646:                        .register_container(&node.associated_meta_container())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1705:fn create_state_(idx: ContainerIdx, config: &Configure, peer: u64) -> State {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1763:                    listener(arena.register_container(&id));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:86:    fn register_container(&mut self, id: &ContainerID) -> ContainerIdx {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:146:    pub fn register_container(&mut self, id: &ContainerID) -> ContainerIdx {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:147:        self.containers.register_container(id)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:232:    pub fn register_container(&self, id: &ContainerID) -> ContainerIdx {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:233:        self.inner.containers.write().register_container(id)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:356:                let parent_idx = self.register_container(&parent_id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/arena.rs:420:        let container = self.register_container(container);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/jsonpath/jsonpath_impl.rs:853:        let store = doc.get_map("store");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/jsonpath/jsonpath_impl.rs:1452:            let map = doc.get_map("store");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc/tree.rs:120:                    // the metadata could be modified before, so (re)create a node need emit the map container diffs
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:203:    pub(super) fn get_or_create_mut(&mut self, idx: ContainerIdx) -> &mut State {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:217:        let idx = self.arena.register_container(id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:228:    pub(super) fn get_or_create_imm(&mut self, idx: ContainerIdx) -> &State {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:260:            let other_idx = other.arena.register_container(&id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:321:        let map = doc.get_map("map");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:334:        // Create child containers
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:22:    pub(super) fn register_container_and_parent_link(&self, change: &Change) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:24:        register_container_and_parent_link(arena, change);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:28:pub(super) fn register_container_and_parent_link(arena: &SharedArena, change: &Change) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:31:            let idx = arena.register_container(c);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:55:                            let idx = self.arena.register_container(c);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:65:                    let idx = self.arena.register_container(c);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:71:                    let idx = self.arena.register_container(c);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:77:                // create associated metadata container
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:78:                // TODO: maybe we could create map container only when setting metadata
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/parent.rs:80:                let child_idx = self.arena.register_container(&container_id);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/jsonpath/subscription.rs:480:        let store = doc.get_map("store");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:674:        let c_idx = shared_arena.register_container(cid);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:714:        doc.get_map("map").insert("x", 100).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:777:        doc.get_map("map").insert("x", 100).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:782:        doc.get_map("map").insert("y", 20).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:784:        doc.get_map("map").insert("z", 1000).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:10:    parent::register_container_and_parent_link,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1635:            register_container_and_parent_link(a, c)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1715:            let map = doc_a.get_map("root");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1730:            let map = doc_b.get_map("root");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1744:            let map = doc_c.get_map("root");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:37:    "Cannot insert a LoroValue::Container directly. To create child container, use insert_container";

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '960,1000p;1008,1040p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   960	    #[inline]
   961	    pub fn try_get_text<I: IntoContainerId>(&self, id: I) -> Option<TextHandler> {
   962	        let id = id.into_container_id(&self.arena, ContainerType::Text);
   963	        if !self.has_container(&id) {
   964	            return None;
   965	        }
   966	        Handler::new_attached(id, self.clone()).into_text().ok()
   967	    }
   968	
   969	    /// id can be a str, ContainerID, or ContainerIdRaw.
   970	    /// if it's str it will use Root container, which will not be None
   971	    #[inline]
   972	    pub fn get_text<I: IntoContainerId>(&self, id: I) -> TextHandler {
   973	        self.try_get_text(id)
   974	            .expect("The container does not exist in the document. Use `try_get_text` or `get_container` to check for existence.")
   975	    }
   976	
   977	    /// id can be a str, ContainerID, or ContainerIdRaw.
   978	    /// if it's str it will use Root container, which will not be None
   979	    #[inline]
   980	    pub fn try_get_list<I: IntoContainerId>(&self, id: I) -> Option<ListHandler> {
   981	        let id = id.into_container_id(&self.arena, ContainerType::List);
   982	        if !self.has_container(&id) {
   983	            return None;
   984	        }
   985	        Handler::new_attached(id, self.clone()).into_list().ok()
   986	    }
   987	
   988	    /// id can be a str, ContainerID, or ContainerIdRaw.
   989	    /// if it's str it will use Root container, which will not be None
   990	    #[inline]
   991	    pub fn get_list<I: IntoContainerId>(&self, id: I) -> ListHandler {
   992	        self.try_get_list(id)
   993	            .expect("The container does not exist in the document. Use `try_get_list` or `get_container` to check for existence.")
   994	    }
   995	
   996	    /// id can be a str, ContainerID, or ContainerIdRaw.
   997	    /// if it's str it will use Root container, which will not be None
   998	    #[inline]
   999	    pub fn try_get_movable_list<I: IntoContainerId>(&self, id: I) -> Option<MovableListHandler> {
  1000	        let id = id.into_container_id(&self.arena, ContainerType::MovableList);
  1008	
  1009	    /// id can be a str, ContainerID, or ContainerIdRaw.
  1010	    /// if it's str it will use Root container, which will not be None
  1011	    #[inline]
  1012	    pub fn get_movable_list<I: IntoContainerId>(&self, id: I) -> MovableListHandler {
  1013	        self.try_get_movable_list(id)
  1014	            .expect("The container does not exist in the document. Use `try_get_movable_list` or `get_container` to check for existence.")
  1015	    }
  1016	
  1017	    /// id can be a str, ContainerID, or ContainerIdRaw.
  1018	    /// if it's str it will use Root container, which will not be None
  1019	    #[inline]
  1020	    pub fn try_get_map<I: IntoContainerId>(&self, id: I) -> Option<MapHandler> {
  1021	        let id = id.into_container_id(&self.arena, ContainerType::Map);
  1022	        if !self.has_container(&id) {
  1023	            return None;
  1024	        }
  1025	        Handler::new_attached(id, self.clone()).into_map().ok()
  1026	    }
  1027	
  1028	    /// id can be a str, ContainerID, or ContainerIdRaw.
  1029	    /// if it's str it will use Root container, which will not be None
  1030	    #[inline]
  1031	    pub fn get_map<I: IntoContainerId>(&self, id: I) -> MapHandler {
  1032	        self.try_get_map(id)
  1033	            .expect("The container does not exist in the document. Use `try_get_map` or `get_container` to check for existence.")
  1034	    }
  1035	
  1036	    /// id can be a str, ContainerID, or ContainerIdRaw.
  1037	    /// if it's str it will use Root container, which will not be None
  1038	    #[inline]
  1039	    pub fn try_get_tree<I: IntoContainerId>(&self, id: I) -> Option<TreeHandler> {
  1040	        let id = id.into_container_id(&self.arena, ContainerType::Tree);

exec
/bin/zsh -lc "rg -n \"pub fn is_empty|fn is_empty|sheet_count\\(|table_count|names\\(\\).*is_empty|Workbook::new\" quantbook-engine/crates/ql-storage/src -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/sheet.rs:378:        assert!(s.scoped_names().is_empty());
quantbook-engine/crates/ql-storage/src/format_overlay.rs:63:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-storage/src/tables.rs:331:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-storage/src/workbook.rs:255:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-storage/src/workbook.rs:419:    pub fn sheet_count(&self) -> usize {
quantbook-engine/crates/ql-storage/src/workbook.rs:771:    /// - **Missing sheet** (sheet id ≥ `sheet_count()`) → `Value::Error(Ref)`
quantbook-engine/crates/ql-storage/src/workbook.rs:794:        let total = self.sheet_count();
quantbook-engine/crates/ql-storage/src/workbook.rs:831:        let total = self.sheet_count();
quantbook-engine/crates/ql-storage/src/workbook.rs:867:    /// Phase 2A.13 audit cycle-3 H2: panics if `sheet >= sheet_count()`, `row >
quantbook-engine/crates/ql-storage/src/workbook.rs:945:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:946:        assert_eq!(wb.sheet_count(), 0);
quantbook-engine/crates/ql-storage/src/workbook.rs:959:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:964:        assert_eq!(wb.sheet_count(), 2);
quantbook-engine/crates/ql-storage/src/workbook.rs:971:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:983:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:995:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1007:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1050:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1060:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1068:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1076:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1083:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1094:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1127:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1134:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1144:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1154:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1163:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1173:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1197:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1212:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1219:        assert!(wb.names().is_empty());
quantbook-engine/crates/ql-storage/src/workbook.rs:1226:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1236:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1261:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1273:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1285:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1289:        let s1: SheetId = (wb.sheet_count() - 1) as SheetId;
quantbook-engine/crates/ql-storage/src/workbook.rs:1298:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1304:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1318:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1343:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1357:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1376:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1387:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1397:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1408:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1419:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1435:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1439:        assert_eq!(wb.sheet_count(), 1);
quantbook-engine/crates/ql-storage/src/workbook.rs:1444:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1449:        assert_eq!(wb.sheet_count(), 0);
quantbook-engine/crates/ql-storage/src/workbook.rs:1454:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1457:        assert_eq!(wb.sheet_count(), 0);
quantbook-engine/crates/ql-storage/src/workbook.rs:1466:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1475:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1500:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1526:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1542:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1554:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1572:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1586:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1598:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1609:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1623:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1629:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1635:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1644:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/workbook.rs:1659:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/spill.rs:328:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-storage/src/overlay.rs:53:    pub fn is_empty(&self) -> bool {
quantbook-engine/crates/ql-storage/src/lib.rs:52:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/lib.rs:68:        let wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/lib.rs:75:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/lib.rs:82:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/lib.rs:105:        let mut wb = Workbook::new();
quantbook-engine/crates/ql-storage/src/format.rs:523:    pub fn is_empty(&self) -> bool {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/workbook.rs | sed -n '1,180p;900,1020p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `Workbook` — top-level container; holds the sheet list + the name table.
     2	//!
     3	//! Per spec Part V §4 Week 2 Days 3-4:
     4	//! - `sheets: Vec<Sheet>` indexed by `SheetId` (u16).
     5	//! - `names: NameTable` — workbook-level defined names. Phase 2A.1 (2026-05-12)
     6	//!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
     7	//!   binder in `ql-exec` resolves names against this table at bind time.
     8	//!   Sheet-scope names land Phase 3+ with `ql-formula-semantics`.
     9	
    10	use std::collections::HashMap;
    11	use std::sync::Arc;
    12	
    13	use ql_types::{Address, ColId, ErrorValue, Range, RowId, SheetId, Value};
    14	
    15	use crate::sheet::Sheet;
    16	
    17	/// What a defined name resolves to.
    18	///
    19	/// Per codex r13 N9 + opus arch F5: the prior `lookup -> Option<Address>` couldn't represent
    20	/// the common Excel defined-name targets (range, constant, formula). The shape was a wrong
    21	/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
    22	/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
    23	///
    24	/// Phase 0 shipped all variants for forward compatibility. Phase 2A.1 (2026-05-12)
    25	/// added real storage for `Cell` and `Constant` variants; the `Range` and `Formula`
    26	/// variants are still resolution-deferred (the binder returns
    27	/// `BindError::UnsupportedVariant` for them — Phase 2B+ aggregate-context wiring
    28	/// closes that gap).
    29	#[derive(Clone, Debug, PartialEq)]
    30	pub enum NamedTarget {
    31	    /// Named single cell (`SalesRow1 = $A$1`).
    32	    Cell(Address),
    33	    /// Named range (`Sales = $A$2:$A$1000`).
    34	    Range(Range),
    35	    /// Named constant (`TaxRate = 0.21`).
    36	    Constant(Value),
    37	    /// Named formula (`Profit = Revenue - Costs`). Stored as the raw formula source; the
    38	    /// binder re-parses + evaluates in the use-site context. Phase 3+ feature.
    39	    Formula(std::sync::Arc<str>),
    40	}
    41	
    42	/// Defined-names table.
    43	///
    44	/// Phase 2A.1 (2026-05-12): real workbook-scope storage. Phase 2A.6 audit fix
    45	/// (H2/M6/D5): canonicalization is enforced at the **insert** boundary — `set`
    46	/// uppercases the key on write, so every entry lives at its canonical
    47	/// upper-case form. `lookup` is case-sensitive on canonical form (fast path for
    48	/// the parser, which already canonicalizes); `lookup_ci` exists as a
    49	/// belt-and-suspenders entry point for callers that bypass the parser
    50	/// canonicalization. Sheet-scope names (Excel's `Sheet1!Local`) are deferred to
    51	/// Phase 3+ ql-formula-semantics.
    52	///
    53	/// ## Generation counter (Phase 2B.3)
    54	///
    55	/// `generation` is bumped on every successful `set` / `clear`. Bind-plan
    56	/// caches in `ql-exec` key cached plans by `(formula_text, sheet,
    57	/// generation)` so a name registration / rename invalidates affected plans
    58	/// without an explicit cache-flush call — the next lookup just misses.
    59	#[derive(Clone, Debug, Default)]
    60	pub struct NameTable {
    61	    entries: HashMap<Arc<str>, NamedTarget>,
    62	    /// Monotonic counter bumped on every successful mutation. See struct
    63	    /// docs for the cache-invalidation contract. Wraps at u64::MAX (4×10^18
    64	    /// mutations — not a realistic concern).
    65	    generation: u64,
    66	}
    67	
    68	/// Errors emitted by `NameTable::set` when a registration is refused.
    69	///
    70	/// Phase 2A.9 audit M6 (2026-05-12): closes the AI() reservation hole. The
    71	/// previous `NameTable::set` returned `()` and silently accepted any name,
    72	/// including ones reserved by the engine. A user calling
    73	/// `wb.set_name("AI", NamedTarget::Constant(...))` then writing `=AI` bypassed
    74	/// the CORR-06 AI sentinel because `=AI` (no parens) goes through the binder's
    75	/// NameRef path instead of the function-call path. Now the registration
    76	/// itself is refused.
    77	#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
    78	#[non_exhaustive]
    79	pub enum NameTableError {
    80	    /// The name is reserved by the engine. Per CORR-06: `AI`. Future
    81	    /// reservations belong in `is_reserved_name` below.
    82	    #[error("name {0:?} is reserved by the engine and cannot be registered")]
    83	    Reserved(Arc<str>),
    84	}
    85	
    86	/// **Phase 4.6.AA (W5-86):** errors from `Workbook::validate_sheet_name`,
    87	/// used by `add_sheet` / `rename_sheet` (Phase 4.6.C). Distinct from
    88	/// `NameTableError` because the validation rules differ (sheet names
    89	/// allow reserved-name-table entries like `AI`; sheet names reject
    90	/// Excel-reserved characters; etc.).
    91	#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
    92	#[non_exhaustive]
    93	pub enum SheetNameError {
    94	    /// Empty string — Excel canon rejects.
    95	    #[error("sheet name cannot be empty")]
    96	    Empty,
    97	
    98	    /// Excel-reserved character in the proposed name. Set: `:`, `\`,
    99	    /// `/`, `?`, `*`, `[`, `]`. xlsx round-trip prerequisite (Phase 4.11).
   100	    #[error("sheet name contains Excel-reserved character {0:?}")]
   101	    ReservedCharacter(char),
   102	
   103	    /// Canonical duplicate of an existing sheet name (case-insensitive
   104	    /// comparison per `Workbook::canonical_sheet_name`).
   105	    #[error("sheet name {name:?} is already in use (case-insensitive)")]
   106	    Duplicate { name: String },
   107	}
   108	
   109	/// Phase 2A.9 audit M6: the canonical-uppercase reserved-name list. Names
   110	/// here cannot be registered via `NameTable::set` or `Workbook::set_name`.
   111	/// Keep small; document each entry.
   112	fn is_reserved_name(canonical: &str) -> bool {
   113	    matches!(
   114	        canonical,
   115	        // CORR-06 / T4-D05: AI is the reserved sentinel that dispatches to
   116	        // `Error(AINotAvailable)` until the Phase 4+ AI() function ships.
   117	        "AI"
   118	    )
   119	}
   120	
   121	/// **W5-D-PM12-2 (megaudit Opus-A HIGH-4 closure):** does `name` look
   122	/// like an Excel column letter (`K`, `XFC`) or cell reference
   123	/// (`A1`, `XFD1048576`)?
   124	///
   125	/// Helper kept available for the deferred HIGH-4 closure that
   126	/// will reject these names at the producer once the binder's
   127	/// AggregateArg-side literal-range support lands (HIGH-1). The
   128	/// current code path doesn't call this — see `NameTable::set` for
   129	/// the deferred-closure rationale.
   130	#[allow(dead_code)]
   131	fn looks_like_excel_cell_ref(canonical: &str) -> bool {
   132	    let bytes = canonical.as_bytes();
   133	    if bytes.is_empty() {
   134	        return false;
   135	    }
   136	    // Walk letters first.
   137	    let mut i = 0;
   138	    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
   139	        i += 1;
   140	    }
   141	    // Excel column max is XFD = 3 letters. Anything else can't be a
   142	    // ref shape.
   143	    if i == 0 || i > 3 {
   144	        return false;
   145	    }
   146	    // Pure-letter case: matches a column-letter token (`K`, `XFC`).
   147	    if i == bytes.len() {
   148	        return true;
   149	    }
   150	    // Letter-then-digits case: cell-ref shape (`A1`, `XFD1048576`).
   151	    let rest = &canonical[i..];
   152	    rest.bytes().all(|b| b.is_ascii_digit())
   153	}
   154	
   155	impl NameTable {
   156	    pub fn new() -> Self {
   157	        Self::default()
   158	    }
   159	
   160	    /// Register a name → target binding. The key is uppercased before insertion
   161	    /// so the table always stores entries in canonical Excel case.
   162	    ///
   163	    /// Phase 2A.6 audit M6/D5 added the on-write canonicalization (was: stored
   164	    /// as-is, creating a disagreement with `lookup` that uppercased queries).
   165	    ///
   166	    /// Phase 2A.9 audit M6 added the reserved-name guard. Names returned `true`
   167	    /// from `is_reserved_name` (currently just `AI` per CORR-06) are refused
   168	    /// with `NameTableError::Reserved`. The return type is now `Result` —
   169	    /// callers that previously expected `()` need to handle the error or
   170	    /// `.expect(...)` it.
   171	    pub fn set(
   172	        &mut self,
   173	        name: impl AsRef<str>,
   174	        target: NamedTarget,
   175	    ) -> Result<(), NameTableError> {
   176	        let upper: Arc<str> = Arc::from(name.as_ref().to_ascii_uppercase().as_str());
   177	        if is_reserved_name(&upper) {
   178	            return Err(NameTableError::Reserved(upper));
   179	        }
   180	        // **W5-D-PM12-2 megaudit Opus-A HIGH-4 — DEFERRED.**
   900	
   901	    /// Remove any formula association for a cell. Used when a formula cell becomes a
   902	    /// literal (e.g. user types over the formula with a value). Idempotent: removing
   903	    /// a non-existent entry is a no-op.
   904	    ///
   905	    /// Phase 3.5 (CORR-25): ALSO drops any computed-overlay entry at this cell. A
   906	    /// cell without a formula text has no business carrying a formula output; the
   907	    /// invariant the rest of the engine relies on is "computed overlay populated ⇒
   908	    /// formula text present", and `clear_formula` is the only path that breaks the
   909	    /// formula→computed pair, so the storage layer enforces both sides here.
   910	    ///
   911	    /// **Phase 2B.5 (2026-05-12) — LOW-LEVEL.** Bypasses the op log. Use
   912	    /// `ql_exec::WorkbookRuntime::clear_formula` to record `Op::ClearFormula`
   913	    /// in an attached log. GAP-O-03.
   914	    pub fn clear_formula(&mut self, sheet: SheetId, row: RowId, col: ColId) {
   915	        self.formula_cells.remove(&(sheet, row, col));
   916	        self.clear_computed_at(sheet, row, col);
   917	    }
   918	
   919	    /// Borrow the formula source for a cell, if it has one.
   920	    pub fn formula_at(&self, sheet: SheetId, row: RowId, col: ColId) -> Option<&Arc<str>> {
   921	        self.formula_cells.get(&(sheet, row, col))
   922	    }
   923	
   924	    /// Count of formula cells across the workbook.
   925	    pub fn formula_count(&self) -> usize {
   926	        self.formula_cells.len()
   927	    }
   928	
   929	    /// Iterate every formula cell as `(sheet, row, col, formula)`. Iteration order is
   930	    /// HashMap-arbitrary; callers that need determinism (qbook save) should sort first.
   931	    pub fn iter_formulas(&self) -> impl Iterator<Item = (SheetId, RowId, ColId, &Arc<str>)> + '_ {
   932	        self.formula_cells
   933	            .iter()
   934	            .map(|((s, r, c), f)| (*s, *r, *c, f))
   935	    }
   936	}
   937	
   938	#[cfg(test)]
   939	mod tests {
   940	    use super::*;
   941	    use ql_types::ErrorValue;
   942	
   943	    #[test]
   944	    fn empty_workbook_has_no_sheets() {
   945	        let wb = Workbook::new();
   946	        assert_eq!(wb.sheet_count(), 0);
   947	        assert!(wb.sheet(0).is_none());
   948	        // Phase 2A.13 audit cycle-3 M2: read out-of-bounds sheet → #REF!
   949	        // (was: Blank). Aligns the storage-layer public read API with
   950	        // `WorkbookEnv::read_cell` per Excel canon.
   951	        assert_eq!(
   952	            wb.read(Address::new(0, 0, 0)),
   953	            Value::Error(ErrorValue::Ref)
   954	        );
   955	    }
   956	
   957	    #[test]
   958	    fn add_sheet_returns_zero_based_id() {
   959	        let mut wb = Workbook::new();
   960	        let id0 = wb.add_sheet("Sheet1");
   961	        assert_eq!(id0, 0);
   962	        let id1 = wb.add_sheet("Sheet2");
   963	        assert_eq!(id1, 1);
   964	        assert_eq!(wb.sheet_count(), 2);
   965	        assert_eq!(wb.sheet(0).unwrap().name(), "Sheet1");
   966	        assert_eq!(wb.sheet(1).unwrap().name(), "Sheet2");
   967	    }
   968	
   969	    #[test]
   970	    fn put_then_read_across_sheets() {
   971	        let mut wb = Workbook::new();
   972	        let s0 = wb.add_sheet("S0");
   973	        let s1 = wb.add_sheet("S1");
   974	        wb.put_at(s0, 0, 0, Value::Number(1.0));
   975	        wb.put_at(s1, 0, 0, Value::Number(99.0));
   976	        // Each sheet maintains its own cells.
   977	        assert_eq!(wb.read(Address::new(s0, 0, 0)), Value::Number(1.0));
   978	        assert_eq!(wb.read(Address::new(s1, 0, 0)), Value::Number(99.0));
   979	    }
   980	
   981	    #[test]
   982	    fn sheets_are_isolated() {
   983	        let mut wb = Workbook::new();
   984	        let a = wb.add_sheet_with_chunk_rows("A", 4);
   985	        let b = wb.add_sheet_with_chunk_rows("B", 4);
   986	        wb.put_at(a, 5, 3, Value::Number(50.0));
   987	        // Sheet B at the same coords reads Blank.
   988	        assert_eq!(wb.read(Address::new(b, 5, 3)), Value::Blank);
   989	        // Sheet A keeps the value.
   990	        assert_eq!(wb.read(Address::new(a, 5, 3)), Value::Number(50.0));
   991	    }
   992	
   993	    #[test]
   994	    fn names_lookup_on_empty_table_returns_none() {
   995	        let wb = Workbook::new();
   996	        assert!(wb.names().lookup("MyName").is_none());
   997	        assert!(wb.names().lookup_ci("MyName").is_none());
   998	    }
   999	
  1000	    /// Phase 2A.6 audit M6/D5 (2026-05-12): `NameTable::set` canonicalizes
  1001	    /// (uppercases) the key on insert, so a raw `NameTable::set("mixedCase",
  1002	    /// target)` and `Workbook::set_name("MIXEDCASE", target)` produce the same
  1003	    /// canonical entry. Pin both paths through both `lookup` (case-sensitive
  1004	    /// on canonical form) and `lookup_ci` (case-insensitive query).
  1005	    #[test]
  1006	    fn name_table_set_canonicalizes_key_on_insert() {
  1007	        let mut wb = Workbook::new();
  1008	        let target = NamedTarget::Constant(Value::Number(0.21));
  1009	
  1010	        // Path A: raw NameTable::set with mixed case.
  1011	        wb.names_mut().set("MixedCase", target.clone()).unwrap();
  1012	        // Case-sensitive lookup on the canonical (upper) form succeeds.
  1013	        assert!(wb.names().lookup("MIXEDCASE").is_some());
  1014	        // The mixed-case query does NOT find it via plain lookup …
  1015	        assert!(wb.names().lookup("MixedCase").is_none());
  1016	        // … but lookup_ci uppercases the query and does.
  1017	        assert!(wb.names().lookup_ci("MixedCase").is_some());
  1018	        assert!(wb.names().lookup_ci("mixedcase").is_some());
  1019	
  1020	        // Path B: convenience set_name accepts any case and produces the same

exec
/bin/zsh -lc "rg -n \"pub fn tables\\(|pub fn names\\(|pub fn sheet_count\\(\" quantbook-engine/crates/ql-storage/src/workbook.rs -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
419:    pub fn sheet_count(&self) -> usize {
536:    pub fn names(&self) -> &NameTable {
551:    pub fn tables(&self) -> &crate::TableTable {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/workbook.rs | sed -n '230,270p;410,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   230	            return Err(NameTableError::Reserved(upper));
   231	        }
   232	        Ok(())
   233	    }
   234	
   235	    /// Look up a name. Case-sensitive on the canonical-uppercase form — used
   236	    /// by the parser-internal path where the query is already canonicalized.
   237	    /// External callers should prefer `lookup_ci` unless they've already
   238	    /// uppercased the query.
   239	    pub fn lookup(&self, name: &str) -> Option<NamedTarget> {
   240	        self.entries.get(name).cloned()
   241	    }
   242	
   243	    /// Case-insensitive lookup: uppercases the query before searching.
   244	    /// Phase 2A.6 audit H2: the `NameLookup for NameTable` impl uses this so
   245	    /// the binder is robust against future callers who forget to canonicalize.
   246	    pub fn lookup_ci(&self, name: &str) -> Option<NamedTarget> {
   247	        let upper = name.to_ascii_uppercase();
   248	        self.entries.get(upper.as_str()).cloned()
   249	    }
   250	
   251	    pub fn len(&self) -> usize {
   252	        self.entries.len()
   253	    }
   254	
   255	    pub fn is_empty(&self) -> bool {
   256	        self.entries.is_empty()
   257	    }
   258	
   259	    /// Iterate all `(name, target)` bindings. Order is HashMap-arbitrary.
   260	    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &NamedTarget)> + '_ {
   261	        self.entries.iter()
   262	    }
   263	}
   264	
   265	/// Top-level Quantbook container.
   266	///
   267	/// Phase 1 W5-9 adds `formula_cells`: a HashMap keyed by `(sheet, row, col)` mapping
   268	/// formula-bearing cells to their formula source text (e.g. `"A1 + B1"`). The cell's
   269	/// EVALUATED result still lives in the Sheet's columnar storage as a Value; this map
   270	/// records that the value was *produced by a formula* (so it can be recomputed and so
   410	
   411	    /// **W5-79 (Phase 4.5.D part 3):** mutable access for `intern` /
   412	    /// `register_at`. Phase 4.5.D part 4 (W5-80) will route mutations
   413	    /// through `WorkbookRuntime::register_format` so they land in the
   414	    /// op log; direct access stays available for the loader + tests.
   415	    pub fn formats_mut(&mut self) -> &mut crate::FormatTable {
   416	        &mut self.formats
   417	    }
   418	
   419	    pub fn sheet_count(&self) -> usize {
   420	        self.sheets.len()
   421	    }
   422	
   423	    // ===== Phase 4.6.AA (W5-86): sheet registry + canonicalizer =====
   424	
   425	    /// **Phase 4.6.AA (W5-86):** canonicalize a sheet name for
   426	    /// case-insensitive comparison. ASCII uppercase per the parent
   427	    /// design doc § 7.3 (consistency with `NameTable::set`'s rule;
   428	    /// Unicode casefolding deferred to a follow-up gap).
   429	    ///
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
   531	            });
   532	        }
   533	        Ok(())
   534	    }
   535	
   536	    pub fn names(&self) -> &NameTable {
   537	        &self.names
   538	    }
   539	
   540	    /// Mutable access to the name table. Phase 2A.1 (2026-05-12) addition for
   541	    /// runtime registration of defined names.
   542	    pub fn names_mut(&mut self) -> &mut NameTable {
   543	        &mut self.names
   544	    }
   545	
   546	    // ===== W5-110 (Phase 4.8.A): table registry =====
   547	
   548	    /// **W5-110 (Phase 4.8.A):** read access to the workbook's table
   549	    /// registry. See `crate::TableTable` and the design doc at
   550	    /// `docs/architecture/2026-05-14-structured-references-and-tables.md`.
   551	    pub fn tables(&self) -> &crate::TableTable {
   552	        &self.tables
   553	    }
   554	
   555	    /// **W5-110 (Phase 4.8.A) — LOW-LEVEL.** Mutable access to the
   556	    /// table registry. Bypasses the op log silently; product mutations
   557	    /// go through `WorkbookRuntime::create_table` etc. (4.8.H+) which
   558	    /// emit op-log entries. Direct callers: qbook loader, tests,
   559	    /// engine-internal reconstruction.
   560	    pub fn tables_mut(&mut self) -> &mut crate::TableTable {

exec
/bin/zsh -lc "rg -n \"impl Default for Workbook|derive\\(["'^'"\\)]*Default|pub fn new\\(\\) -> Self\" quantbook-engine/crates/ql-storage/src/workbook.rs -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
59:#[derive(Clone, Debug, Default)]
156:    pub fn new() -> Self {
295:#[derive(Clone, Debug, Default)]
345:    pub fn new() -> Self {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/workbook.rs | sed -n '280,360p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   280	/// `Clone` is **shallow with respect to Arrow chunk buffers**: each
   281	/// `ColumnStore` holds `Vec<Arc<dyn arrow_array::Array>>`, and cloning the
   282	/// Workbook clones the Arc handles (cheap refcount bump), NOT the underlying
   283	/// Arrow buffers. This is safe today because the only mutating APIs
   284	/// (`Workbook::put`, `Sheet::put`, `ColumnStore::put`, `replace_chunk`,
   285	/// `append_chunk`) operate at the chunk granularity — they install whole new
   286	/// `ArrayRef` values, never mutate an existing Arrow buffer in place. So a
   287	/// clone and the original never see each other's writes through their shared
   288	/// chunk Arcs.
   289	///
   290	/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
   291	/// mutates a chunk's bytes in place (e.g. `Float64Array::values_mut` via
   292	/// `Arc::make_mut`), it MUST also break the Arc-sharing contract — either
   293	/// clone the buffer first or document the in-place mutation. The
   294	/// chunk-replace-only invariant is what makes shallow Clone correct.
   295	#[derive(Clone, Debug, Default)]
   296	pub struct Workbook {
   297	    sheets: Vec<Sheet>,
   298	    names: NameTable,
   299	    formula_cells: HashMap<(SheetId, RowId, ColId), Arc<str>>,
   300	    /// **W5-71 (Phase 4.5.A.2):** Excel date system for this workbook.
   301	    /// Default `Excel1900` (Windows Excel canon). The `.qbook` envelope
   302	    /// persists this; xlsx I/O (Phase 4.11) maps it from the workbook's
   303	    /// `date1904` SST flag. Functions read this via
   304	    /// `WorkbookEnv::eval_context()` to drive serial ↔ date conversion.
   305	    date_system: ql_types::DateSystem,
   306	    /// **W5-79 (Phase 4.5.D part 3):** workbook-level format-string
   307	    /// interning table. Cells with non-General formats reference an id
   308	    /// into this table via per-sheet [`crate::CellFormatOverlay`].
   309	    /// Default loads the Excel built-ins from
   310	    /// `docs/architecture/2026-05-13-format-string-grammar.md` § 10
   311	    /// (parser-relevant subset).
   312	    formats: crate::FormatTable,
   313	    /// **W5-101 (Phase 4.7.H):** spill-anchor table. Workbook-level
   314	    /// because spills can theoretically span sheets (rare in Excel; v1
   315	    /// keeps single-sheet but the table doesn't assume). Map-only by
   316	    /// design; mutation goes through `register_spill` / `clear_spill_at`
   317	    /// — the latter is the workbook-layer convenience that also clears
   318	    /// computed overlays at every target cell. See
   319	    /// `crates/ql-storage/src/spill.rs` module docs.
   320	    spill_anchors: crate::SpillAnchorTable,
   321	    /// **W5-110 (Phase 4.8.A):** workbook-level table registry. Mirrors
   322	    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
   323	    /// `WorkbookRuntime::create_table` etc.; direct access here is for
   324	    /// the qbook loader + tests. See `crates/ql-storage/src/tables.rs`
   325	    /// module docs.
   326	    tables: crate::TableTable,
   327	    /// **W5-133 (Phase 4.9.A):** formula-text reference mode. A
   328	    /// workbook-level user preference; default `A1`. Storage canon
   329	    /// stays A1 regardless of this setting — `R1C1` only affects how
   330	    /// the lexer/parser interpret user input and how the printer
   331	    /// emits the stored canonical AST. See Phase 4.9 design doc § 1.
   332	    reference_mode: ql_types::ReferenceMode,
   333	    /// **W5-133 (Phase 4.9.A):** locale for separator + decimal rules.
   334	    /// Workbook-level. Default `EnUs`. Storage canon stays EN
   335	    /// separators (decimal `.`, arg `,`, array row `;`, array col
   336	    /// `,`) regardless of this setting; non-EN locales affect only
   337	    /// the edit-time lex/print transforms. Promoted from
   338	    /// `EvalContext::locale` (which previously held this for the
   339	    /// eval layer only) — the persistent home is now the workbook.
   340	    /// See Phase 4.9 design doc § 1 + § 3.2.
   341	    locale: ql_types::Locale,
   342	}
   343	
   344	impl Workbook {
   345	    pub fn new() -> Self {
   346	        Self::default()
   347	    }
   348	
   349	    /// **W5-71 (Phase 4.5.A.2):** the workbook's date system.
   350	    pub fn date_system(&self) -> ql_types::DateSystem {
   351	        self.date_system
   352	    }
   353	
   354	    /// **W5-71 (Phase 4.5.A.2):** set the workbook's date system.
   355	    /// Used by the `.qbook` loader on file load (defaults to `Excel1900`
   356	    /// when missing from the envelope) and by xlsx import in Phase 4.11.
   357	    /// Switching post-load shifts every serial by 1462 days — not
   358	    /// recommended as a runtime operation.
   359	    ///
   360	    /// **W5-76 mega-audit caveat:** `WorkbookEnv` (`ql-exec`) caches the

exec
/bin/zsh -lc "rg -n \"T2\\[A\\]|T3\\[A\\]|repair_table|table repair|RenameTable.*repair|structured.*repair|UnknownTable|Table\" quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:33://! - Row 8: DropTable × concurrent edit referencing T — pinned here
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:72:/// Build a base op log with sheet "S" + a `CreateTable("T")`
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:73:/// covering A1:B3 with header row. Used by the DropTable conflict
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:77:    log.append(Op::CreateTable {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:629:// ===== Row 8: DropTable × concurrent edit referencing T =====
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:634:/// `T[X]` reference binds to UnknownTable → recompute emits
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:639:/// DropTable as row 8 (row 7 is RenameSheet × concurrent edit).
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:643:/// the original test claimed "DropTable wins deterministically"
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:644:/// — imprecise. The correct statement: BOTH ops apply (DropTable
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:655:        Op::DropTable {
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:671:    // T is dropped (DropTable always applies — there's no
quantbook-engine/crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:677:        "A5 must emit #NAME? (D-3: BindError::UnknownTable → ErrorValue::Name); got {a5_a:?}"
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:79:/// workbook (NameTable mutations don't flow through the op log in 2A.3.b —
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:436:    // FormatTable: the custom entry survived.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:472:        "read_display through reloaded FormatTable + overlay must match producer"
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:573:/// **W5-118 (Phase 4.8.H) e2e:** create_table emits Op::CreateTable;
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:619:/// **W5-118 (Phase 4.8.H) e2e:** drop_table emits Op::DropTable; replay
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:621:/// UnknownTable (we verify by checking the table is absent).
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:702:/// **W5-122 (Phase 4.8.J) e2e:** resize_table emits `Op::ResizeTable`;
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:726:        // Resize bumps TableTable generation + clears plan cache, but
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:741:    // Table metadata reflects resize.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:767:/// `Table[Col]` formula.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:793:    // Table metadata reloaded.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:816:/// replay-side footprint-bounds check rejects a `CreateTable` op whose
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:827:        .append(Op::CreateTable {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:843:        ReplayError::TableCreateRejected { reason, .. } => {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:846:        other => panic!("expected TableCreateRejected, got {other:?}"),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:851:/// for `ResizeTable`. Constructs a valid CreateTable then a
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:852:/// hand-crafted ResizeTable that grows past MAX_ROW.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:859:        .append(Op::CreateTable {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:873:        .append(Op::ResizeTable {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:885:        ReplayError::TableResizeRejected { reason, .. } => {
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:888:        other => panic!("expected TableResizeRejected, got {other:?}"),

exec
/bin/zsh -lc 'cargo test -p ql-exec row7_rename_sheet_concurrent_edit_resolves_via_repair_pass -- --test-threads=1' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 446015ms:
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 18.98s
     Running unittests src/lib.rs (target/debug/deps/ql_exec-77a7c0ccf0b4a340)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 636 filtered out; finished in 0.00s

     Running tests/_audit_5b_probes.rs (target/debug/deps/_audit_5b_probes-43b38cc29b2989a3)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.00s

     Running tests/distribution_fns_e2e.rs (target/debug/deps/distribution_fns_e2e-978034af0ab2744e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 111 filtered out; finished in 0.00s

     Running tests/error_precedence.rs (target/debug/deps/error_precedence-16b74909cce5d5d6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/ide_simulation.rs (target/debug/deps/ide_simulation-e8f76697287a81cc)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.00s

     Running tests/oplog_e2e.rs (target/debug/deps/oplog_e2e-a6d9eee78ceaab44)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 20 filtered out; finished in 0.00s

     Running tests/opus_a_phase_4_12_cross_features.rs (target/debug/deps/opus_a_phase_4_12_cross_features-9c0b5954fe0f940d)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 35 filtered out; finished in 0.00s

     Running tests/p412_function_arg_fuzz.rs (target/debug/deps/p412_function_arg_fuzz-5745bb960651be88)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/phase_5_2_d4_spill_2peer_probe.rs (target/debug/deps/phase_5_2_d4_spill_2peer_probe-2001fad6b359f662)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/phase_5_3_conflict_matrix_probe.rs (target/debug/deps/phase_5_3_conflict_matrix_probe-a7d4507d25a58877)

running 1 test
test row7_rename_sheet_concurrent_edit_resolves_via_repair_pass ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.01s

     Running tests/reference_fns_coverage_extensions.rs (target/debug/deps/reference_fns_coverage_extensions-fd620457eab55647)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 14 filtered out; finished in 0.00s

     Running tests/reference_fns_e2e.rs (target/debug/deps/reference_fns_e2e-510c39c4c11f3796)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 32 filtered out; finished in 0.00s

     Running tests/reference_fns_step3_e2e.rs (target/debug/deps/reference_fns_step3_e2e-44f7b6b861163ff6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 29 filtered out; finished in 0.00s

     Running tests/reference_fns_step4_e2e.rs (target/debug/deps/reference_fns_step4_e2e-52c4d057d1903f61)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 17 filtered out; finished in 0.00s

     Running tests/reference_fns_step5_cross_cutting.rs (target/debug/deps/reference_fns_step5_cross_cutting-cde4d558deb1b6e5)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.00s

     Running tests/reference_tier_dispatcher_smoke.rs (target/debug/deps/reference_tier_dispatcher_smoke-0f53850705baf65e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 13 filtered out; finished in 0.00s

     Running tests/region_mul2_e2e.rs (target/debug/deps/region_mul2_e2e-9d4987213cc5dd41)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 69 filtered out; finished in 0.00s


codex
Executive summary: the wrapper is directionally correct and closes the production-wiring gap, but I would not call the API fully ergonomic yet. The main risk is that `sync_workbook(&mut Workbook, ...)` sounds like it can be called on an existing workbook, while it actually replays the full log on top of whatever state is passed. The docs warn about this, so I’m not marking it HIGH, but it is the primary production footgun.

**VERDICT: PASS-WITH-FINDINGS**

**HIGH**
None.

**MEDIUM**
- Fresh-workbook contract is not enforced. [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:374>) documents that callers must pass a fresh `Workbook`, but [sync_workbook](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:388>) just replays into the provided instance. Repro: log with `AddSheet("S")`, call `sync_workbook` twice on the same workbook; the second call applies `AddSheet` again and replay auto-disambiguates to `S(2)`. Closure: either rename/reshape as `rebuild_workbook(&self, registry) -> Result<(Workbook, SyncReport), _>`, reset the workbook internally before replay, or assert/debug-assert a pristine workbook and add a regression test.
- Public guidance still leaves stale raw paths. `op_log()` now points to `sync_workbook`, but [merge_bytes](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:282>) and [poll_remote](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:468>) do not. The repair module’s top call sequence also only mentions sheet repair, not table repair or the wrapper: [repair.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:16>). Closure: update those docs to say collaborative callers should rebuild through `sync_workbook` before recompute.

**LOW**
- `replay_into` docs mention nonexistent `ReplayError::At`: [replay.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:3>) and [replay.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:348>). Actual variants carry `index` directly. The wrapper preserves the real `ReplayError` via `CollabSessionError::Replay(#[from] ReplayError)`: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:117>). Closure: fix docs and optionally strengthen the wrapper error test to assert the inner replay variant/index.
- `SyncReport` should likely be `#[non_exhaustive]`: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:130>). 5c column repair is likely to add another field, and external struct literals would break.
- Error docs should distinguish replay failure from repair failure. Current docs say discard on any error, which is safe, but repair `OpLogError`s occur after replay succeeded and may leave the workbook fully replayed but unrepaired or partially repaired: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:356>).

**Checks**
- `&self` is correct: the method reads `self.log` and mutates only the workbook.
- `&FunctionRegistry` is correct; it mirrors `replay_into`.
- `Replay` vs `OpLog` variants do not shadow each other: replay-stage deserialization is wrapped as `Replay`, repair-stage iteration errors as `OpLog`.
- Empty-log fast path is correct: `CollabSession::op_count()` and `OpLog::is_empty()` both reduce to `len() == 0`.
- The shared `base_bytes` fix in `sync_workbook.rs` is correct; spot-checks in collab/oplog repair tests use the same “single base snapshot, fork with peer id” pattern.
- Ran: `cargo test -p ql-collab --test sync_workbook -- --test-threads=1` and the ql-exec row7 recompute probe; both passed.
Executive summary: the wrapper is directionally correct and closes the production-wiring gap, but I would not call the API fully ergonomic yet. The main risk is that `sync_workbook(&mut Workbook, ...)` sounds like it can be called on an existing workbook, while it actually replays the full log on top of whatever state is passed. The docs warn about this, so I’m not marking it HIGH, but it is the primary production footgun.

**VERDICT: PASS-WITH-FINDINGS**

**HIGH**
None.

**MEDIUM**
- Fresh-workbook contract is not enforced. [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:374>) documents that callers must pass a fresh `Workbook`, but [sync_workbook](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:388>) just replays into the provided instance. Repro: log with `AddSheet("S")`, call `sync_workbook` twice on the same workbook; the second call applies `AddSheet` again and replay auto-disambiguates to `S(2)`. Closure: either rename/reshape as `rebuild_workbook(&self, registry) -> Result<(Workbook, SyncReport), _>`, reset the workbook internally before replay, or assert/debug-assert a pristine workbook and add a regression test.
- Public guidance still leaves stale raw paths. `op_log()` now points to `sync_workbook`, but [merge_bytes](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:282>) and [poll_remote](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:468>) do not. The repair module’s top call sequence also only mentions sheet repair, not table repair or the wrapper: [repair.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/repair.rs:16>). Closure: update those docs to say collaborative callers should rebuild through `sync_workbook` before recompute.

**LOW**
- `replay_into` docs mention nonexistent `ReplayError::At`: [replay.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:3>) and [replay.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/replay.rs:348>). Actual variants carry `index` directly. The wrapper preserves the real `ReplayError` via `CollabSessionError::Replay(#[from] ReplayError)`: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:117>). Closure: fix docs and optionally strengthen the wrapper error test to assert the inner replay variant/index.
- `SyncReport` should likely be `#[non_exhaustive]`: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:130>). 5c column repair is likely to add another field, and external struct literals would break.
- Error docs should distinguish replay failure from repair failure. Current docs say discard on any error, which is safe, but repair `OpLogError`s occur after replay succeeded and may leave the workbook fully replayed but unrepaired or partially repaired: [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:356>).

**Checks**
- `&self` is correct: the method reads `self.log` and mutates only the workbook.
- `&FunctionRegistry` is correct; it mirrors `replay_into`.
- `Replay` vs `OpLog` variants do not shadow each other: replay-stage deserialization is wrapped as `Replay`, repair-stage iteration errors as `OpLog`.
- Empty-log fast path is correct: `CollabSession::op_count()` and `OpLog::is_empty()` both reduce to `len() == 0`.
- The shared `base_bytes` fix in `sync_workbook.rs` is correct; spot-checks in collab/oplog repair tests use the same “single base snapshot, fork with peer id” pattern.
- Ran: `cargo test -p ql-collab --test sync_workbook -- --test-threads=1` and the ql-exec row7 recompute probe; both passed.
tokens used
200,426
