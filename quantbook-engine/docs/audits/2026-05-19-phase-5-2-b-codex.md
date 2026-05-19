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
session id: 019e4071-5351-7f00-aad4-c42b208c4a7d
--------
user
# Codex audit — Phase 5.2.b (PeerId wiring) 2026-05-19

## Context

Working directory: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (a quantbook engine worktree on `feat/quantbook-engine`).

HEAD: `ef056f50bee` (Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id).
Predecessor: `687e5dd3995` (handoff audit closure).

## What shipped

Single commit at HEAD. Reverses the Phase 5.2.a scaffold limitation surfaced by the 2026-05-19 handoff audit (Codex M-8: CollabSession stored PeerId as a label but never propagated it to Loro's CRDT merge metadata).

Changes:
1. `crates/ql-oplog/src/log.rs`: added `OpLog::set_peer_id(&self, peer: u64) -> Result<(), OpLogError>` and `OpLog::peer_id(&self) -> u64`. Both wrap loro 1.12.0's LoroDoc methods.
2. `crates/ql-collab/src/session.rs`: `CollabSession::new(peer_id)` now returns `Result<Self, CollabSessionError>` (was `Self`); both `new` and `from_snapshot` call `log.set_peer_id(peer_id.as_u64())` after construction. All 6 existing in-file tests updated to `.unwrap()` the constructor.
3. `crates/ql-collab/src/peer.rs`: docstring refreshed to claim PeerId IS wired through (was scaffold-limitation note).
4. `docs/architecture/crdt-data-model.md` § ql-collab crate scope: scaffold-limitation note replaced with "✅ closed" + caller-pitfall.
5. `docs/phase5/entry-plan.md` risk 6: marked CLOSED.

New tests (workspace went 4160 → 4162):
- `crates/ql-oplog/src/log.rs`: `set_peer_id_changes_doc_peer_id`, `set_peer_id_after_import_works`.
- `crates/ql-collab/src/session.rs`: `peer_id_is_wired_to_underlying_loro_doc`, `from_snapshot_overrides_imported_peer_id`.

## What you need to verify

### A. Correctness of the Loro integration

A1. Does `LoroDoc::set_peer_id` actually do what the docstring claims? Verify against `loro-1.12.0/src/lib.rs:985`. Specifically: does it affect FUTURE appends only, or does it also retroactively rewrite already-committed ops?

A2. Loro 1.12.0 docs warn "Never reuse the same PeerID across concurrent writers" and "Do not assign a fixed PeerID to a user or device without strict single-ownership locking. Prefer the default random PeerID per process/session." Does the OpLog::set_peer_id docstring surface BOTH pitfalls? Does the CollabSession::new/from_snapshot docstring surface them?

A3. Is `LoroDoc::set_peer_id` actually safe to call AFTER `LoroDoc::import(bytes)` (i.e., after a snapshot has been imported with ops by other peers)? `from_snapshot` does this. Verify via Loro source or empirical test.

A4. Does set_peer_id behave correctly with concurrent commits in flight? The OpLog::append path does `list.push(...); doc.commit()` — if a peer id change happens between push and commit, what's the behavior?

### B. API ergonomics

B1. `CollabSession::new(peer_id)` changed from infallible to fallible. Is this a defensible API change for a 0.1.0 crate? (Per ql-collab's stability docs, yes — pre-0.2.0 is in flux. Confirm or push back.)

B2. Are there any callers of `CollabSession::new` OUTSIDE the session.rs unit tests? Grep for `CollabSession::new` workspace-wide. Any missed call site that still uses the old infallible API would fail to compile.

B3. Should `OpLog::set_peer_id` take a `PeerID` type alias instead of raw `u64`? Loro internally uses `pub type PeerID = u64;` — the alias documents intent but exposes the same primitive.

### C. Test coverage

C1. The new tests cover: peer_id matches after construction, after import, after explicit set. Anything missed?

C2. The Phase 5.2 D-4 2-peer spill probe at `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` predates the peer-id wiring. Does it still pass with the new behavior? It uses CollabSession-equivalent pattern via direct OpLog calls — does the D-4 probe need updating to set distinct peer ids?

C3. Is there a test that two CollabSessions with DUPLICATE peer ids produces detectable misbehavior (per Loro's "duplicate PeerIDs corrupt the document" warning)? If not, should there be?

### D. Doc accuracy

D1. The crdt-data-model.md § ql-collab crate scope says "Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed)". Read the section and confirm it reads as truth.

D2. Risk 6 in entry-plan.md says CLOSED at Phase 5.2.b. Are there any OTHER doc references to the scaffold-limitation that I missed?

D3. The `current_work.md` / `MEMORY.md` (in `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/`) need to be updated for the new HEAD `ef056f50bee` + 4162 test count + Phase 5.2.b completion. These are on the Linux VM (not visible to your Mac shell) but I will update them post-audit. Flag if any code-side claims would be invalidated by stale memory.

### E. Gates

E1. `cargo test --workspace` — expect 4162 passing.
E2. `cargo fmt --all -- --check` — expect clean.
E3. `cargo clippy --workspace --all-targets -- -D warnings` — expect clean (note: I fixed a clippy::doc_lazy_continuation warning during commit).

## Output format

Single-pass audit report:
- **Loro integration correctness** — A1-A4 with quoted source evidence.
- **API ergonomics** — B1-B3 with verdict on each.
- **Test coverage** — C1-C3 with recommendations.
- **Doc accuracy** — D1-D3 with verdicts.
- **Gates** — E1-E3 with observed values.
- **Findings** — categorized HIGH / MEDIUM / LOW with file:line locations and proposed fixes.
- **Verdict** — "Phase 5.2.b is ship-clean" / "Phase 5.2.b has N MUST-FIX issues" / "Phase 5.2.b has N SHOULD-FIX issues for follow-up".

Be specific. The 2-way audit-discipline rule depends on Codex catching what Opus + self might miss.

codex
I’ll audit this as a code review against the current worktree, starting with repo instructions and the HEAD diff, then I’ll verify Loro behavior from the installed source and run the requested gates.
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
/bin/zsh -lc 'git show --stat --oneline --decorate HEAD && git show --name-only --format=fuller HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'pwd && git status --short && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 182ms:
ef056f50bee (HEAD -> feat/quantbook-engine) Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id
 quantbook-engine/crates/ql-collab/src/peer.rs      | 23 +++----
 quantbook-engine/crates/ql-collab/src/session.rs   | 75 ++++++++++++++++------
 quantbook-engine/crates/ql-oplog/src/log.rs        | 51 +++++++++++++++
 .../docs/architecture/crdt-data-model.md           | 18 +++---
 quantbook-engine/docs/phase5/entry-plan.md         | 12 ++--
 5 files changed, 130 insertions(+), 49 deletions(-)
commit ef056f50bee7914455521f62703119efe941644a
Author:     steppen0mad <nurtaymergaliyev@gmail.com>
AuthorDate: Tue May 19 14:32:05 2026 +0100
Commit:     steppen0mad <nurtaymergaliyev@gmail.com>
CommitDate: Tue May 19 14:32:05 2026 +0100

    Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id
    
    Closes the Phase 5.2.a scaffold limitation surfaced by the
    2026-05-19 handoff audit (Codex M-8): CollabSession stored PeerId
    as a label but never propagated it to Loro's CRDT merge metadata.
    
    Changes:
    - ql-oplog::OpLog: add `set_peer_id(&self, peer: u64)` (wraps
      LoroDoc::set_peer_id) and `peer_id(&self)` accessor. Documents
      the duplicate-peer-id pitfall from Loro 1.12.0 docs.
    - ql-collab::CollabSession: `new()` and `from_snapshot()` call
      `log.set_peer_id(peer_id.as_u64())` after construction.
      Signature of `new()` changes from `Self` to
      `Result<Self, CollabSessionError>` because set_peer_id is fallible.
    - ql-collab::peer module: refresh docstring — PeerId is now
      wired through to LoroDoc, no longer label-only.
    
    Tests added (workspace count 4160 → 4162):
    - ql-oplog: `set_peer_id_changes_doc_peer_id`,
      `set_peer_id_after_import_works`.
    - ql-collab: `peer_id_is_wired_to_underlying_loro_doc` (regression
      guard: log.peer_id() must match the CollabSession's configured
      PeerId after construction), `from_snapshot_overrides_imported_peer_id`.
    
    Doc closures:
    - docs/architecture/crdt-data-model.md § ql-collab crate scope:
      replace "Known scaffold limitation" block with "Peer-id wiring
      ✅ closed" + caller-pitfall note.
    - docs/phase5/entry-plan.md risk 6: marked CLOSED at Phase 5.2.b.
    
    Workspace gates: 4162 tests passing; fmt + clippy clean on
    ql-oplog + ql-collab.
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

quantbook-engine/crates/ql-collab/src/peer.rs
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-oplog/src/log.rs
quantbook-engine/docs/architecture/crdt-data-model.md
quantbook-engine/docs/phase5/entry-plan.md

 succeeded in 2864ms:
?? .codex-phase-5-2-b-audit-prompt.md
?? .codex-phase-5-2-b-audit.out
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
?? quantbook-engine/.plans/
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt
feat/quantbook-engine
ef056f50bee7914455521f62703119efe941644a

codex
The repo-level Copilot guidance looks like a copied VS Code template and does not match this Rust workspace, so I’m treating the in-repo Rust patterns and the requested gates as authoritative. The HEAD commit and touched-file set match the audit brief.
exec
/bin/zsh -lc "rg --files -g 'Cargo.toml' -g 'log.rs' -g 'session.rs' -g 'peer.rs' -g 'crdt-data-model.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
cli/src/log.rs
cli/Cargo.toml
quantbook-engine/docs/architecture/crdt-data-model.md
build/win32/Cargo.toml
quantbook-engine/docs/phase5/entry-plan.md
quantbook-engine/docs/phase2/entry-plan.md
quantbook-engine/crates/ql-bindings-node/Cargo.toml
quantbook-engine/crates/ql-io-ods/Cargo.toml
quantbook-engine/crates/ql-formula-semantics/Cargo.toml
quantbook-engine/crates/ql-oplog/src/log.rs
quantbook-engine/crates/ql-oplog/Cargo.toml
quantbook-engine/crates/ql-storage/Cargo.toml
quantbook-engine/crates/ql-collab/src/peer.rs
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-collab/Cargo.toml
quantbook-engine/crates/ql-ai/Cargo.toml
quantbook-engine/crates/ql-types/Cargo.toml
quantbook-engine/crates/ql-calcgraph/Cargo.toml
quantbook-engine/crates/ql-bench/Cargo.toml
quantbook-engine/crates/ql-io-xlsx/Cargo.toml
quantbook-engine/crates/ql-connectors/Cargo.toml
quantbook-engine/crates/ql-terminal/Cargo.toml
quantbook-engine/crates/ql-bindings-wasm/Cargo.toml
quantbook-engine/crates/ql-bindings-c/Cargo.toml
quantbook-engine/crates/ql-udf/Cargo.toml
quantbook-engine/crates/ql-profile/Cargo.toml
quantbook-engine/crates/ql-io/Cargo.toml
quantbook-engine/crates/quantbook-py/Cargo.toml
quantbook-engine/crates/ql-exec/Cargo.toml
quantbook-engine/crates/ql-service/Cargo.toml
quantbook-engine/crates/ql-sql/Cargo.toml
quantbook-engine/crates/ql-functions/Cargo.toml
quantbook-engine/crates/ql-formula-syntax/Cargo.toml
quantbook-engine/Cargo.toml

exec
/bin/zsh -lc 'git diff --stat 687e5dd3995..HEAD && git diff --find-renames -- crates/ql-oplog/src/log.rs crates/ql-collab/src/session.rs crates/ql-collab/src/peer.rs docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"CollabSession::new|scaffold limitation|scaffold-limitation|label-only|PeerId.*label|PeerID|set_peer_id|peer_id\" crates docs -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 303ms:
docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
docs/architecture/crdt-data-model.md:400:closed by adding `OpLog::set_peer_id` and calling it from
docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
docs/phase5/entry-plan.md:138:6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
docs/phase5/entry-plan.md:139:   2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
docs/phase5/entry-plan.md:140:   from `CollabSession::new` + `from_snapshot`. PeerId now wired
crates/ql-oplog/src/log.rs:130:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
crates/ql-oplog/src/log.rs:138:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
crates/ql-oplog/src/log.rs:148:    pub fn set_peer_id(&self, peer: u64) -> Result<(), OpLogError> {
crates/ql-oplog/src/log.rs:149:        self.doc.set_peer_id(peer)?;
crates/ql-oplog/src/log.rs:153:    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
crates/ql-oplog/src/log.rs:154:    pub fn peer_id(&self) -> u64 {
crates/ql-oplog/src/log.rs:155:        self.doc.peer_id()
crates/ql-oplog/src/log.rs:328:    fn set_peer_id_changes_doc_peer_id() {
crates/ql-oplog/src/log.rs:330:        let before = log.peer_id();
crates/ql-oplog/src/log.rs:331:        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
crates/ql-oplog/src/log.rs:332:        assert_eq!(log.peer_id(), 0xdead_beef_cafe_babe);
crates/ql-oplog/src/log.rs:333:        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
crates/ql-oplog/src/log.rs:337:    fn set_peer_id_after_import_works() {
crates/ql-oplog/src/log.rs:340:        origin.set_peer_id(11).unwrap();
crates/ql-oplog/src/log.rs:344:        reborn.set_peer_id(22).unwrap();
crates/ql-oplog/src/log.rs:345:        assert_eq!(reborn.peer_id(), 22);
crates/ql-collab/src/peer.rs:10://!   time AND passed through to `OpLog::set_peer_id` → Loro's
crates/ql-collab/src/peer.rs:11://!   `LoroDoc::set_peer_id` so concurrent appends carry the right
crates/ql-collab/src/peer.rs:39:    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/audits/2026-05-19-handoff-audit-codex.md:910:   309	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/audits/2026-05-19-handoff-audit-codex.md:1033:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
docs/audits/2026-05-19-handoff-audit-codex.md:1203:   602	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
docs/audits/2026-05-19-handoff-audit-codex.md:1257:    20	//! - `CollabSession::new(peer_id)` — fresh session with an empty
docs/audits/2026-05-19-handoff-audit-codex.md:1259:    22	//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
docs/audits/2026-05-19-handoff-audit-codex.md:1270:    33	//! - `peer_id(&self)` — the session's stable peer id.
docs/audits/2026-05-19-handoff-audit-codex.md:1301:    64	    peer_id: PeerId,
docs/audits/2026-05-19-handoff-audit-codex.md:1311:    74	    pub fn new(peer_id: PeerId) -> Self {
docs/audits/2026-05-19-handoff-audit-codex.md:1313:    76	            peer_id,
docs/audits/2026-05-19-handoff-audit-codex.md:1325:    88	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1327:    90	            peer_id,
docs/audits/2026-05-19-handoff-audit-codex.md:1333:    96	    pub fn peer_id(&self) -> PeerId {
docs/audits/2026-05-19-handoff-audit-codex.md:1334:    97	        self.peer_id
docs/audits/2026-05-19-handoff-audit-codex.md:1364:   127	    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
docs/audits/2026-05-19-handoff-audit-codex.md:1387:   150	            .field("peer_id", &self.peer_id)
docs/audits/2026-05-19-handoff-audit-codex.md:1409:   172	        let s = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1410:   173	        assert_eq!(s.peer_id(), PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1417:   180	        let mut s = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1430:   193	        let mut origin = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1441:   204	        assert_eq!(reborn.peer_id(), PeerId::new(2));
docs/audits/2026-05-19-handoff-audit-codex.md:1448:   211	        let mut base = CollabSession::new(PeerId::new(0));
docs/audits/2026-05-19-handoff-audit-codex.md:1472:   235	    fn debug_impl_includes_peer_id_and_count() {
docs/audits/2026-05-19-handoff-audit-codex.md:1473:   236	        let mut s = CollabSession::new(PeerId::new(42));
docs/audits/2026-05-19-handoff-audit-codex.md:1476:   239	        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
docs/audits/2026-05-19-handoff-audit-codex.md:1650:    10	//!   time; passed to Loro's `LoroDoc::set_peer_id` so concurrent
docs/audits/2026-05-19-handoff-audit-codex.md:1675:    35	    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/audits/2026-05-19-handoff-audit-codex.md:1772:crates/ql-collab/src/session.rs:88:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
docs/audits/2026-05-19-handoff-audit-codex.md:2580:   309	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/audits/2026-05-19-handoff-audit-codex.md:2703:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
docs/audits/2026-05-19-handoff-audit-codex.md:2865:   594	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
docs/audits/2026-05-19-handoff-audit-codex.md:3795:/bin/zsh -lc "rg -n \"set_peer_id|peer_id|LoroDoc|pub struct OpLog|impl OpLog|doc:\" crates/ql-oplog/src/log.rs crates/ql-oplog/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:3829:    10	//!   time; passed to Loro's `LoroDoc::set_peer_id` so concurrent
docs/audits/2026-05-19-handoff-audit-codex.md:3854:    35	    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/audits/2026-05-19-handoff-audit-codex.md:3868:    74	    pub fn new(peer_id: PeerId) -> Self {
docs/audits/2026-05-19-handoff-audit-codex.md:3870:    76	            peer_id,
docs/audits/2026-05-19-handoff-audit-codex.md:3882:    88	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:3884:    90	            peer_id,
docs/audits/2026-05-19-handoff-audit-codex.md:3890:    96	    pub fn peer_id(&self) -> PeerId {
docs/audits/2026-05-19-handoff-audit-codex.md:3891:    97	        self.peer_id
docs/audits/2026-05-19-handoff-audit-codex.md:4157:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
docs/audits/2026-05-19-handoff-audit-codex.md:4182:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
crates/ql-collab/src/session.rs:20://! - `CollabSession::new(peer_id)` — fresh session with an empty
crates/ql-collab/src/session.rs:22://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
crates/ql-collab/src/session.rs:23://!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
crates/ql-collab/src/session.rs:25://! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
crates/ql-collab/src/session.rs:27://!   pattern). The reborn session's peer id is `peer_id`; existing
crates/ql-collab/src/session.rs:38://! - `peer_id(&self)` — the session's stable peer id.
crates/ql-collab/src/session.rs:69:    peer_id: PeerId,
crates/ql-collab/src/session.rs:77:    /// peer to open a brand-new workbook). The `peer_id` is wired
crates/ql-collab/src/session.rs:78:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
crates/ql-collab/src/session.rs:80:    /// `peer_id` (not Loro's default random per-doc id).
crates/ql-collab/src/session.rs:83:    /// peer ids — see `OpLog::set_peer_id` for details.
crates/ql-collab/src/session.rs:84:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
crates/ql-collab/src/session.rs:86:        log.set_peer_id(peer_id.as_u64())?;
crates/ql-collab/src/session.rs:87:        Ok(Self { peer_id, log })
crates/ql-collab/src/session.rs:97:    /// session's peer id is set to `peer_id` — distinct from the
crates/ql-collab/src/session.rs:99:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
crates/ql-collab/src/session.rs:101:        log.set_peer_id(peer_id.as_u64())?;
crates/ql-collab/src/session.rs:102:        Ok(Self { peer_id, log })
crates/ql-collab/src/session.rs:106:    pub fn peer_id(&self) -> PeerId {
crates/ql-collab/src/session.rs:107:        self.peer_id
crates/ql-collab/src/session.rs:137:    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
crates/ql-collab/src/session.rs:160:            .field("peer_id", &self.peer_id)
crates/ql-collab/src/session.rs:182:        let s = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:183:        assert_eq!(s.peer_id(), PeerId::new(1));
crates/ql-collab/src/session.rs:190:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:203:        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:214:        assert_eq!(reborn.peer_id(), PeerId::new(2));
crates/ql-collab/src/session.rs:221:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
crates/ql-collab/src/session.rs:245:    fn debug_impl_includes_peer_id_and_count() {
crates/ql-collab/src/session.rs:246:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
crates/ql-collab/src/session.rs:249:        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
crates/ql-collab/src/session.rs:254:    fn peer_id_is_wired_to_underlying_loro_doc() {
crates/ql-collab/src/session.rs:256:        // CollabSession but never passed to LoroDoc::set_peer_id, so
crates/ql-collab/src/session.rs:259:        // appear as the underlying log's peer_id().
crates/ql-collab/src/session.rs:260:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
crates/ql-collab/src/session.rs:261:        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
crates/ql-collab/src/session.rs:262:        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
crates/ql-collab/src/session.rs:266:    fn from_snapshot_overrides_imported_peer_id() {
crates/ql-collab/src/session.rs:270:        // attribution (Loro semantics), but log.peer_id() reflects
crates/ql-collab/src/session.rs:272:        let origin = CollabSession::new(PeerId::new(11)).unwrap();
crates/ql-collab/src/session.rs:275:        assert_eq!(reborn.op_log().peer_id(), 22);
docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
docs/audits/2026-05-19-handoff-audit-consolidated.md:44:| M-8 | `peer.rs` module + struct docstring claims PeerId is passed to `LoroDoc::set_peer_id` but it isn't | Codex | ✅ FIXED — docstrings updated to surface the Phase 5.2.a scaffold limitation; behavior change deferred to Phase 5.5 |
docs/audits/2026-05-19-handoff-audit-consolidated.md:77:- Codex caught the deeper `entry-plan.md` body drift (sub-item table, risks section, test count) and the `peer.rs` docstring lie about `LoroDoc::set_peer_id` (neither Opus nor self had checked the docstring against actual behavior).
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:551:**Verdict:** **Healthy for v2 (Phase 5 collab).** Phase 5 will likely add a `peer_id`, `version_vector`, or similar — append the field with `#[serde(default)]`, bump to v8. The recovery path is well-shaped. The atomic-save protocol is hardened by Phase 2A.13 audit cycle-3.
docs/audits/2026-05-19-phase-5-1-codex.md:75:- Could `next_custom_id` use a peer-ID prefix (e.g., (peer_id, counter) tuple) so concurrent peers never collide?
docs/audits/2026-05-19-phase-5-1-codex.md:460:   291	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/audits/2026-05-19-phase-5-1-codex.md:6662:   570	    use loro_common::{Counter, Lamport, PeerID};
docs/audits/2026-05-19-phase-5-1-codex.md:6672:   580	        peer_idx: usize,
docs/audits/2026-05-19-phase-5-1-codex.md:6696:   604	            let mut peers: ValueRegister<PeerID> = ValueRegister::new();
docs/audits/2026-05-19-phase-5-1-codex.md:6700:   608	                let peer_idx = peers.register(&id.peer);
docs/audits/2026-05-19-phase-5-1-codex.md:6702:   610	                    peer_idx,
docs/audits/2026-05-19-phase-5-1-codex.md:6730:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:570:    use loro_common::{Counter, Lamport, PeerID};
docs/audits/2026-05-19-phase-5-1-codex.md:6731:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:580:        peer_idx: usize,
docs/audits/2026-05-19-phase-5-1-codex.md:6737:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:604:            let mut peers: ValueRegister<PeerID> = ValueRegister::new();
docs/audits/2026-05-19-phase-5-1-codex.md:6738:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:608:                let peer_idx = peers.register(&id.peer);
docs/audits/2026-05-19-phase-5-1-codex.md:6739:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:610:                    peer_idx,
docs/audits/2026-05-19-phase-5-1-codex.md:6749:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:648:                peers.push(PeerID::from_le_bytes(buf));
docs/audits/2026-05-19-phase-5-1-codex.md:6751:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:660:                        peers[id.peer_idx],
docs/audits/2026-05-19-phase-5-1-codex.md:6775:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:15:    CompactIdLp, ContainerID, Counter, HasCounterSpan, IdFull, IdLp, IdSpan, LoroValue, PeerID, ID,
docs/audits/2026-05-19-phase-5-1-codex.md:6797:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:686:            assert_ne!(id.peer, PeerID::MAX);
docs/audits/2026-05-19-phase-5-1-codex.md:6827:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:1116:                                assert_ne!(id.peer, PeerID::MAX);
docs/audits/2026-05-19-phase-5-1-codex.md:6848:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:1352:                                    peer: PeerID::MAX - 2,
docs/audits/2026-05-19-phase-5-1-codex.md:6887:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:360:    fn id(peer: PeerID, counter: Counter) -> ID {
docs/audits/2026-05-19-phase-5-1-codex.md:6913:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:358:    fn id(peer: PeerID, counter: Counter) -> ID {
docs/audits/2026-05-19-phase-5-1-codex.md:6932:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:123:                peer_id_change_subs: SubscriberSetWithQueue::new(),
docs/audits/2026-05-19-phase-5-1-codex.md:6934:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:169:                self.renew_peer_id();
docs/audits/2026-05-19-phase-5-1-codex.md:6935:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:183:    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
docs/audits/2026-05-19-phase-5-1-codex.md:6936:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:184:        if peer == PeerID::MAX {
docs/audits/2026-05-19-phase-5-1-codex.md:6940:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:199:            self.peer_id_change_subs.emit(&(), next_id);
docs/audits/2026-05-19-phase-5-1-codex.md:6944:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:216:        self.peer_id_change_subs.emit(&(), next_id);
docs/audits/2026-05-19-phase-5-1-codex.md:6945:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:221:    pub(crate) fn renew_peer_id(&self) {
docs/audits/2026-05-19-phase-5-1-codex.md:6946:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:222:        let mut peer_id = DefaultRandom.next_u64();
docs/audits/2026-05-19-phase-5-1-codex.md:6947:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:223:        while peer_id == PeerID::MAX {
docs/audits/2026-05-19-phase-5-1-codex.md:6948:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:224:            peer_id = DefaultRandom.next_u64();
docs/audits/2026-05-19-phase-5-1-codex.md:6949:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:226:        self.set_peer_id(peer_id).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:6954:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:281:                    peer: self.peer_id(),
docs/audits/2026-05-19-phase-5-1-codex.md:6955:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:527:    pub fn peer_id(&self) -> PeerID {
docs/audits/2026-05-19-phase-5-1-codex.md:6957:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:569:        let s = debug_span!("import", peer = self.peer_id());
docs/audits/2026-05-19-phase-5-1-codex.md:6958:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:601:                    peer = self.peer_id()
docs/audits/2026-05-19-phase-5-1-codex.md:6959:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:611:                    loro_common::info!("Init by snapshot {}", self.peer_id());
docs/audits/2026-05-19-phase-5-1-codex.md:6960:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:623:                    loro_common::info!("Init by fast snapshot {}", self.peer_id());
docs/audits/2026-05-19-phase-5-1-codex.md:7153:   686	            assert_ne!(id.peer, PeerID::MAX);
docs/audits/2026-05-19-phase-5-1-codex.md:7258:  1116	                                assert_ne!(id.peer, PeerID::MAX);
docs/audits/2026-05-19-phase-5-1-codex.md:7504:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/history_cache.rs:14:    ContainerType, Counter, HasLamport, IdFull, IdLp, InternalString, LoroValue, PeerID, ID,
docs/audits/2026-05-19-phase-5-1-codex.md:7595:     7	use loro_common::{Counter, HasId, HasIdSpan, IdFull, IdSpan, Lamport, PeerID, ID};
docs/audits/2026-05-19-phase-5-1-codex.md:7626:    38	pub(super) const UNKNOWN_PEER_ID: PeerID = u64::MAX;
docs/audits/2026-05-19-phase-5-1-codex.md:8199:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container/richtext/tracker.rs:7:use loro_common::{Counter, HasId, HasIdSpan, IdFull, IdSpan, Lamport, PeerID, ID};
docs/audits/2026-05-19-phase-5-1-codex.md:8239:   702	            IdFull::new(id as PeerID, 0 as Counter, 0),
docs/audits/2026-05-19-phase-5-1-codex.md:8249:   712	            IdFull::new(id as PeerID, 0 as Counter, 0),
docs/audits/2026-05-19-phase-5-1-codex.md:8661:/bin/zsh -lc "rg -n \"concurrent|merge|same position|same pos|peer_id|set_peer_id|list\\.push|list\\.insert|LoroList|import\\(\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | head -240" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-phase-5-1-codex.md:8806:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:240:    /// - Ensure no concurrent operations share the same PeerID if set manually.
docs/audits/2026-05-19-phase-5-1-codex.md:8807:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:275:    /// - Ensure no concurrent operations share the same PeerID if set manually.
docs/audits/2026-05-19-phase-5-1-codex.md:8823:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:802:    /// doc.set_peer_id(0).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8825:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:973:    pub fn peer_id(&self) -> PeerID {
docs/audits/2026-05-19-phase-5-1-codex.md:8826:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:974:        self.doc.peer_id()
docs/audits/2026-05-19-phase-5-1-codex.md:8827:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:980:    /// - Never reuse the same PeerID across concurrent writers (multiple tabs/devices). Duplicate
docs/audits/2026-05-19-phase-5-1-codex.md:8828:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:985:    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
docs/audits/2026-05-19-phase-5-1-codex.md:8829:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:986:        self.doc.set_peer_id(peer)
docs/audits/2026-05-19-phase-5-1-codex.md:8832:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1126:    /// let sub = doc.subscribe_peer_id_change(Box::new(move |new_peer_id| {
docs/audits/2026-05-19-phase-5-1-codex.md:8833:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1127:    ///     changes_clone.lock().unwrap().push(*new_peer_id);
docs/audits/2026-05-19-phase-5-1-codex.md:8834:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1131:    /// doc.set_peer_id(42).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8835:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1132:    /// doc.set_peer_id(100).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8836:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1134:    pub fn subscribe_peer_id_change(&self, callback: PeerIdUpdateCallback) -> Subscription {
docs/audits/2026-05-19-phase-5-1-codex.md:8837:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1135:        self.doc.subscribe_peer_id_change(callback)
docs/audits/2026-05-19-phase-5-1-codex.md:8843:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1501:    /// doc.set_peer_id(1);
docs/audits/2026-05-19-phase-5-1-codex.md:8847:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1552:    /// doc.set_peer_id(0).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8848:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1572:    /// doc.set_peer_id(1).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8889:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:3710:/// - Peer identity: keep the `peer_id` stable while an `UndoManager` is in use. Changing peer IDs
docs/audits/2026-05-19-phase-5-1-codex.md:8896:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:39:    doc.set_peer_id(peer).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8899:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:72:    base.set_peer_id(1).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8900:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:82:    peer2.set_peer_id(2).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8901:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:89:    peer3.set_peer_id(3).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8905:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:118:    src.set_peer_id(1).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8909:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:157:    base.set_peer_id(1).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8910:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:166:    peer2.set_peer_id(2).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8912:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:172:    peer3.set_peer_id(3).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8921:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:279:    src.set_peer_id(9).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8929:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:17:    doc.set_peer_id(1).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8930:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:27:    src.set_peer_id(2).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8932:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:43:    doc.set_peer_id(3).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8933:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:53:    src.set_peer_id(4).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8936:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:79:    src.set_peer_id(5).unwrap();
docs/audits/2026-05-19-phase-5-1-codex.md:8940:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:89:    doc.set_peer_id(7)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8942:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:136:    local.set_peer_id(31)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8944:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:153:    remote.set_peer_id(32)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8948:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:207:    doc.set_peer_id(88)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8951:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:26:    source.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8955:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:80:    doc.set_peer_id(10)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8956:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:95:    remote.set_peer_id(11)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8960:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:114:    seed.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8962:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:137:    a.set_peer_id(2)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8964:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:141:    b.set_peer_id(3)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8974:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:10:    doc.set_peer_id(801)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8977:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:342:    peer_ids: &[u64],
docs/audits/2026-05-19-phase-5-1-codex.md:8978:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:346:    let peer_ids = if peer_ids.is_empty() { &[1] } else { peer_ids };
docs/audits/2026-05-19-phase-5-1-codex.md:8979:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:363:    let mut active_peer = peer_ids[0];
docs/audits/2026-05-19-phase-5-1-codex.md:8980:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:364:    doc.set_peer_id(active_peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:8987:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:432:        if commit_every > 0 && i > 0 && i % commit_every == 0 && peer_ids.len() > 1 {
docs/audits/2026-05-19-phase-5-1-codex.md:8988:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:433:            active_peer = peer_ids[rng.gen_range(0..peer_ids.len())];
docs/audits/2026-05-19-phase-5-1-codex.md:8989:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:434:            doc.set_peer_id(active_peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9013:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1069:    doc_a.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9014:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1075:    doc_b.set_peer_id(2)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9017:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1116:    doc.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9019:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1142:        doc.set_peer_id(peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9020:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1156:    doc.set_peer_id(big_peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9024:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1227:    doc.set_peer_id(peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9025:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1289:    doc.set_peer_id(peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9026:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1346:    doc.set_peer_id(peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9028:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1375:    doc.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9029:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1381:    doc.set_peer_id(2)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9039:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1568:    doc.set_peer_id(peer)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9041:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1699:    doc_a.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9042:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1704:    doc_b.set_peer_id(2)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9173:   239	    /// - This mode uses a different PeerID for each checkout.
docs/audits/2026-05-19-phase-5-1-codex.md:9174:   240	    /// - Ensure no concurrent operations share the same PeerID if set manually.
docs/audits/2026-05-19-phase-5-1-codex.md:9208:   274	    /// - This mode uses a different PeerID for each checkout.
docs/audits/2026-05-19-phase-5-1-codex.md:9209:   275	    /// - Ensure no concurrent operations share the same PeerID if set manually.
docs/audits/2026-05-19-phase-5-1-codex.md:9255:   971	    /// Get the PeerID
docs/audits/2026-05-19-phase-5-1-codex.md:9257:   973	    pub fn peer_id(&self) -> PeerID {
docs/audits/2026-05-19-phase-5-1-codex.md:9258:   974	        self.doc.peer_id()
docs/audits/2026-05-19-phase-5-1-codex.md:9261:   977	    /// Change the PeerID
docs/audits/2026-05-19-phase-5-1-codex.md:9264:   980	    /// - Never reuse the same PeerID across concurrent writers (multiple tabs/devices). Duplicate
docs/audits/2026-05-19-phase-5-1-codex.md:9265:   981	    ///   PeerIDs can produce conflicting OpIDs and corrupt the document.
docs/audits/2026-05-19-phase-5-1-codex.md:9266:   982	    /// - Do not assign a fixed PeerID to a user or device without strict single-ownership locking.
docs/audits/2026-05-19-phase-5-1-codex.md:9267:   983	    ///   Prefer the default random PeerID per process/session.
docs/audits/2026-05-19-phase-5-1-codex.md:9269:   985	    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
docs/audits/2026-05-19-phase-5-1-codex.md:9270:   986	        self.doc.set_peer_id(peer)
docs/audits/2026-05-19-phase-5-1-codex.md:9281:   114	    seed.set_peer_id(1)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9304:   137	    a.set_peer_id(2)?;
docs/audits/2026-05-19-phase-5-1-codex.md:9308:   141	    b.set_peer_id(3)?;
docs/audits/2026-05-19-phase-5-1-codex.md:11400:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.
docs/audits/2026-05-19-phase-5-1-codex.md:11418:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.

 succeeded in 321ms:
 quantbook-engine/crates/ql-collab/src/peer.rs      | 23 +++----
 quantbook-engine/crates/ql-collab/src/session.rs   | 75 ++++++++++++++++------
 quantbook-engine/crates/ql-oplog/src/log.rs        | 51 +++++++++++++++
 .../docs/architecture/crdt-data-model.md           | 18 +++---
 quantbook-engine/docs/phase5/entry-plan.md         | 12 ++--
 5 files changed, 130 insertions(+), 49 deletions(-)

exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/log.rs | sed -n '230,390p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/log.rs | sed -n '1,230p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/session.rs | sed -n '1,330p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/peer.rs | sed -n '1,180p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 264ms:
   230	        assert_eq!(read, vec![op]);
   231	    }
   232	
   233	    #[test]
   234	    fn append_each_variant_round_trips() {
   235	        let ops = vec![
   236	            put_value(0, 0, 0, 1.0),
   237	            Op::PutFormula {
   238	                sheet: 0,
   239	                row: 1,
   240	                col: 0,
   241	                text: "A1 * 2".to_owned(),
   242	            },
   243	            Op::ClearFormula {
   244	                sheet: 0,
   245	                row: 1,
   246	                col: 0,
   247	            },
   248	            Op::SetName {
   249	                scope: None,
   250	                name: "TaxRate".to_owned(),
   251	                target: NamedTargetWire::Constant {
   252	                    value: CellWireValue::Number(0.21),
   253	                },
   254	            },
   255	            Op::AddSheet {
   256	                name: "Inventory".to_owned(),
   257	                chunk_rows: 16384,
   258	            },
   259	            Op::BatchCommit {
   260	                ops: vec![
   261	                    put_value(0, 0, 0, 7.0),
   262	                    Op::PutFormula {
   263	                        sheet: 0,
   264	                        row: 0,
   265	                        col: 1,
   266	                        text: "A1 + 1".to_owned(),
   267	                    },
   268	                ],
   269	            },
   270	        ];
   271	        let mut log = OpLog::new();
   272	        for op in &ops {
   273	            log.append(op.clone()).unwrap();
   274	        }
   275	        assert_eq!(log.len(), ops.len());
   276	        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
   277	        assert_eq!(read, ops);
   278	    }
   279	
   280	    #[test]
   281	    fn binary_export_import_preserves_order() {
   282	        let mut log = OpLog::new();
   283	        let ops = vec![
   284	            put_value(0, 0, 0, 1.0),
   285	            put_value(0, 0, 1, 2.0),
   286	            put_value(0, 0, 2, 3.0),
   287	            Op::PutFormula {
   288	                sheet: 0,
   289	                row: 1,
   290	                col: 0,
   291	                text: "A1 + B1 + C1".to_owned(),
   292	            },
   293	            Op::AddSheet {
   294	                name: "Sheet2".to_owned(),
   295	                chunk_rows: 16384,
   296	            },
   297	        ];
   298	        for op in &ops {
   299	            log.append(op.clone()).unwrap();
   300	        }
   301	        let bytes = log.export_bytes().unwrap();
   302	        let restored = OpLog::import_bytes(&bytes).unwrap();
   303	        assert_eq!(restored.len(), ops.len());
   304	        let read: Vec<Op> = restored.iter().collect::<Result<_, _>>().unwrap();
   305	        assert_eq!(read, ops);
   306	    }
   307	
   308	    #[test]
   309	    fn import_empty_snapshot_yields_empty_log() {
   310	        let original = OpLog::new();
   311	        let bytes = original.export_bytes().unwrap();
   312	        let restored = OpLog::import_bytes(&bytes).unwrap();
   313	        assert!(restored.is_empty());
   314	        assert_eq!(restored.len(), 0);
   315	    }
   316	
   317	    #[test]
   318	    fn import_garbage_bytes_returns_loro_error() {
   319	        let bytes = b"this is not a loro snapshot";
   320	        let result = OpLog::import_bytes(bytes);
   321	        assert!(
   322	            matches!(result, Err(OpLogError::Loro(_))),
   323	            "expected Loro error for garbage bytes, got {result:?}"
   324	        );
   325	    }
   326	
   327	    #[test]
   328	    fn set_peer_id_changes_doc_peer_id() {
   329	        let log = OpLog::new();
   330	        let before = log.peer_id();
   331	        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
   332	        assert_eq!(log.peer_id(), 0xdead_beef_cafe_babe);
   333	        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
   334	    }
   335	
   336	    #[test]
   337	    fn set_peer_id_after_import_works() {
   338	        // Origin writes ops under peer 11.
   339	        let origin = OpLog::new();
   340	        origin.set_peer_id(11).unwrap();
   341	        let bytes = origin.export_bytes().unwrap();
   342	        // Reborn imports + reassigns peer id; future appends use 22.
   343	        let reborn = OpLog::import_bytes(&bytes).unwrap();
   344	        reborn.set_peer_id(22).unwrap();
   345	        assert_eq!(reborn.peer_id(), 22);
   346	    }
   347	}

 succeeded in 264ms:
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
    19	//! resulting blob includes the full state plus history; suitable for
    20	//! `oplog.bin` on-disk persistence (Phase 2A.3.c).
    21	//!
    22	//! `import_bytes` reconstructs an `OpLog` from such a blob. The reader
    23	//! probes the `"ops"` LoroList; if absent (or the wrong shape), the
    24	//! import returns `OpLogError::SchemaMismatch`.
    25	
    26	use loro::{ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
    27	
    28	use crate::error::OpLogError;
    29	use crate::op::Op;
    30	
    31	/// The Loro container name our ops live under. Hard-coded; Phase 5+
    32	/// CRDT-level refactoring may add more containers (versions, peer state,
    33	/// etc.) but `"ops"` is reserved.
    34	const OPS_CONTAINER: &str = "ops";
    35	
    36	/// Append-only operation log backed by Loro.
    37	///
    38	/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
    39	/// to reconstruct from a persisted snapshot. Mutations go through `append`;
    40	/// reads through `iter` / `len` / `is_empty`.
    41	pub struct OpLog {
    42	    doc: LoroDoc,
    43	    /// Cached count to avoid round-tripping into Loro for `len()`. Always
    44	    /// equal to `doc.get_list(OPS_CONTAINER).len()`; updated on append
    45	    /// and on import.
    46	    cached_len: usize,
    47	}
    48	
    49	impl std::fmt::Debug for OpLog {
    50	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    51	        f.debug_struct("OpLog")
    52	            .field("cached_len", &self.cached_len)
    53	            .field("doc", &"<LoroDoc>")
    54	            .finish()
    55	    }
    56	}
    57	
    58	impl Default for OpLog {
    59	    fn default() -> Self {
    60	        Self::new()
    61	    }
    62	}
    63	
    64	impl OpLog {
    65	    /// Construct an empty log.
    66	    pub fn new() -> Self {
    67	        Self {
    68	            doc: LoroDoc::new(),
    69	            cached_len: 0,
    70	        }
    71	    }
    72	
    73	    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    74	    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    75	    /// underlying Loro doc.
    76	    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
    77	        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
    78	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
    79	        list.push(LoroValue::from(json.as_str()))?;
    80	        self.doc.commit();
    81	        self.cached_len += 1;
    82	        Ok(())
    83	    }
    84	
    85	    /// Iterate the log in append order. Each yielded item is a
    86	    /// `Result<Op, OpLogError>` — a deserialization failure yields
    87	    /// `Err(OpLogError::Deserialize { index, source })` and iteration
    88	    /// continues (no short-circuit). Callers wanting fail-fast can use
    89	    /// `iter().collect::<Result<Vec<_>, _>>()`.
    90	    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
    91	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
    92	        let len = list.len();
    93	        (0..len).map(move |index| {
    94	            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
    95	                "ops LoroList lost an entry between len() and get()",
    96	            ))?;
    97	            let value = match entry {
    98	                ValueOrContainer::Value(v) => v,
    99	                ValueOrContainer::Container(_) => {
   100	                    return Err(OpLogError::SchemaMismatch(
   101	                        "ops LoroList holds a container; expected JSON-string values",
   102	                    ));
   103	                }
   104	            };
   105	            let s = match value {
   106	                LoroValue::String(s) => s,
   107	                _ => {
   108	                    return Err(OpLogError::SchemaMismatch(
   109	                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
   110	                    ));
   111	                }
   112	            };
   113	            serde_json::from_str::<Op>(&s)
   114	                .map_err(|source| OpLogError::Deserialize { index, source })
   115	        })
   116	    }
   117	
   118	    /// Number of ops in the log.
   119	    pub fn len(&self) -> usize {
   120	        self.cached_len
   121	    }
   122	
   123	    /// True iff `len() == 0`.
   124	    pub fn is_empty(&self) -> bool {
   125	        self.cached_len == 0
   126	    }
   127	
   128	    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
   129	    ///
   130	    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
   131	    /// to wire its stable `PeerId` through to Loro so concurrent
   132	    /// appends carry the right origin in the CRDT merge metadata.
   133	    ///
   134	    /// Loro takes `&self` (interior mutability), so this method is
   135	    /// `&self` too. Idempotent — calling it twice with the same id
   136	    /// is a no-op.
   137	    ///
   138	    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
   139	    /// 1. NEVER reuse the same peer id across concurrent writers
   140	    ///    (multiple tabs / devices for the same user). Duplicate peer
   141	    ///    ids corrupt the document via conflicting OpIDs.
   142	    /// 2. Avoid pinning a peer id to a stable user/device identity
   143	    ///    unless you also enforce single-ownership locking. Prefer a
   144	    ///    per-process-random peer id.
   145	    /// 3. Setting peer id AFTER an import is safe — existing imported
   146	    ///    ops retain their original peer ids; only this log's future
   147	    ///    appends use the new id.
   148	    pub fn set_peer_id(&self, peer: u64) -> Result<(), OpLogError> {
   149	        self.doc.set_peer_id(peer)?;
   150	        Ok(())
   151	    }
   152	
   153	    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
   154	    pub fn peer_id(&self) -> u64 {
   155	        self.doc.peer_id()
   156	    }
   157	
   158	    /// Export the log to a binary blob suitable for on-disk persistence.
   159	    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
   160	    /// compressed.
   161	    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
   162	        Ok(self.doc.export(ExportMode::Snapshot)?)
   163	    }
   164	
   165	    /// Reconstruct an `OpLog` from a previously-exported snapshot.
   166	    /// Probes the `"ops"` container to set the cached length; if the
   167	    /// snapshot doesn't carry our shape, returns `OpLogError::SchemaMismatch`.
   168	    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
   169	        let doc = LoroDoc::new();
   170	        doc.import(bytes)?;
   171	        let list: LoroList = doc.get_list(OPS_CONTAINER);
   172	        let cached_len = list.len();
   173	        Ok(Self { doc, cached_len })
   174	    }
   175	
   176	    /// **Phase 5.2 D-4 (2026-05-19):** merge another peer's snapshot
   177	    /// into this log via Loro's CRDT merge. Concurrent appends to
   178	    /// the `"ops"` LoroList are preserved in deterministic causal
   179	    /// order (Fugue/origin-based with peer-id tiebreaker per
   180	    /// `loro-internal::container::richtext::tracker::crdt_rope`).
   181	    ///
   182	    /// Typical pattern for multi-peer collaboration:
   183	    /// 1. Both peers start from a shared snapshot (`import_bytes`).
   184	    /// 2. Each peer appends its own ops independently.
   185	    /// 3. Peer A exports its current state via `export_bytes`.
   186	    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
   187	    ///    contains both peers' ops in causal order.
   188	    /// 5. Replay against a workbook reconstructs the merged state.
   189	    /// 6. `WorkbookRuntime::recompute_all` resolves derived state
   190	    ///    (spills, formula values) from the merged final state.
   191	    ///
   192	    /// Returns the new `len()` after merge.
   193	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
   194	        self.doc.import(bytes)?;
   195	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   196	        self.cached_len = list.len();
   197	        Ok(self.cached_len)
   198	    }
   199	}
   200	
   201	#[cfg(test)]
   202	mod tests {
   203	    use super::*;
   204	    use crate::wire::{CellWireValue, NamedTargetWire};
   205	
   206	    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
   207	        Op::PutValue {
   208	            sheet,
   209	            row,
   210	            col,
   211	            value: CellWireValue::Number(n),
   212	        }
   213	    }
   214	
   215	    #[test]
   216	    fn new_log_is_empty() {
   217	        let log = OpLog::new();
   218	        assert!(log.is_empty());
   219	        assert_eq!(log.len(), 0);
   220	        assert!(log.iter().next().is_none());
   221	    }
   222	
   223	    #[test]
   224	    fn append_single_op_round_trips() {
   225	        let mut log = OpLog::new();
   226	        let op = put_value(0, 5, 3, 42.0);
   227	        log.append(op.clone()).unwrap();
   228	        assert_eq!(log.len(), 1);
   229	        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
   230	        assert_eq!(read, vec![op]);

 succeeded in 254ms:
     1	//! Per-peer identifier for Phase 5 collaboration.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19):** `PeerId` is a thin newtype around
     4	//! `u64` matching Loro's native peer-id type. Stable per-session;
     5	//! the user-facing collaboration tooling decides how to assign IDs
     6	//! (random vs user-derived vs server-allocated).
     7	//!
     8	//! Used by:
     9	//! - [`crate::session::CollabSession`] — attached at session-create
    10	//!   time AND passed through to `OpLog::set_peer_id` → Loro's
    11	//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
    12	//!   origin in the CRDT merge metadata (Phase 5.2.b 2026-05-19;
    13	//!   5.2.a stored this as a label only).
    14	//! - Phase 5.6 presence module — will key the `presence` `LoroMap`
    15	//!   so each peer's cursor position lives at its own slot.
    16	//! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
    17	//!   variant will use this type for collision-free format-id
    18	//!   allocation across peers.
    19	
    20	/// Per-peer collaboration identifier.
    21	///
    22	/// Wraps a `u64` to match Loro's native peer-id type. Stable for
    23	/// the lifetime of a `CollabSession`; the user-facing tooling
    24	/// decides assignment policy. Two concurrent peers MUST have
    25	/// distinct ids — duplicate peer ids corrupt the document via
    26	/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
    27	/// then closed by Phase 5.2.b wiring). Prefer per-process-random
    28	/// allocation unless your server enforces uniqueness explicitly.
    29	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
    30	pub struct PeerId(pub u64);
    31	
    32	impl PeerId {
    33	    /// Construct a `PeerId` from the raw u64.
    34	    pub const fn new(id: u64) -> Self {
    35	        Self(id)
    36	    }
    37	
    38	    /// Unwrap to the raw `u64`. Used at the Loro boundary
    39	    /// (`LoroDoc::set_peer_id` takes `u64`).
    40	    pub const fn as_u64(self) -> u64 {
    41	        self.0
    42	    }
    43	}
    44	
    45	impl From<u64> for PeerId {
    46	    fn from(id: u64) -> Self {
    47	        Self(id)
    48	    }
    49	}
    50	
    51	impl From<PeerId> for u64 {
    52	    fn from(p: PeerId) -> Self {
    53	        p.0
    54	    }
    55	}
    56	
    57	impl std::fmt::Display for PeerId {
    58	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    59	        // 16-hex-char form keeps display compact and easy to spot in logs.
    60	        write!(f, "{:016x}", self.0)
    61	    }
    62	}
    63	
    64	#[cfg(test)]
    65	mod tests {
    66	    use super::PeerId;
    67	
    68	    #[test]
    69	    fn round_trips_through_u64() {
    70	        let p = PeerId::new(0xdead_beef_cafe_babe);
    71	        assert_eq!(p.as_u64(), 0xdead_beef_cafe_babe);
    72	        assert_eq!(u64::from(p), 0xdead_beef_cafe_babe);
    73	        assert_eq!(PeerId::from(0xdead_beef_cafe_babe_u64), p);
    74	    }
    75	
    76	    #[test]
    77	    fn display_is_16_hex_chars() {
    78	        let p = PeerId::new(0x1234);
    79	        assert_eq!(format!("{p}"), "0000000000001234");
    80	    }
    81	
    82	    #[test]
    83	    fn equality_and_hash_consistent() {
    84	        use std::collections::HashSet;
    85	        let a = PeerId::new(42);
    86	        let b = PeerId::new(42);
    87	        let c = PeerId::new(43);
    88	        assert_eq!(a, b);
    89	        assert_ne!(a, c);
    90	        let mut set: HashSet<PeerId> = HashSet::new();
    91	        set.insert(a);
    92	        assert!(set.contains(&b));
    93	        assert!(!set.contains(&c));
    94	    }
    95	}

 succeeded in 256ms:
     1	//! `CollabSession` — per-peer collaboration state holder.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
     4	//! with peer-id-aware operations + transport plumbing. Subsequent
     5	//! phases populate richer behavior:
     6	//!
     7	//! - **Phase 5.4** — undo manager integration (per-peer Loro
     8	//!   `UndoManager` tracks local appends; undo removes them from
     9	//!   the log).
    10	//! - **Phase 5.5** — automatic transport integration: append a
    11	//!   local op → broadcast bytes via [`crate::Transport::send`];
    12	//!   poll [`crate::Transport::try_recv`] for remote bytes →
    13	//!   `merge_bytes`.
    14	//! - **Phase 5.6** — presence map updates (per-peer cursor + selection).
    15	//! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
    16	//!   handle that the IDE attaches to each open workbook.
    17	//!
    18	//! What ships in 5.2.a (5.2.b update 2026-05-19):
    19	//!
    20	//! - `CollabSession::new(peer_id)` — fresh session with an empty
    21	//!   `OpLog` and the peer-id wired through to
    22	//!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
    23	//!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
    24	//!   fallible.
    25	//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
    26	//!   shared base snapshot (used by both peers in the D-4 probe
    27	//!   pattern). The reborn session's peer id is `peer_id`; existing
    28	//!   ops in the imported snapshot retain their original
    29	//!   attribution.
    30	//! - `append_op(&mut self, Op)` — local append; delegates to
    31	//!   `OpLog::append`.
    32	//! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
    33	//!   snapshot via Loro's CRDT merge; delegates to
    34	//!   `OpLog::merge_bytes`.
    35	//! - `export_bytes(&self)` — produce a snapshot for transport.
    36	//! - `op_log(&self)` — read-only view of the underlying log
    37	//!   (for replay against a workbook).
    38	//! - `peer_id(&self)` — the session's stable peer id.
    39	
    40	use thiserror::Error;
    41	
    42	use ql_oplog::{Op, OpLog, OpLogError};
    43	
    44	use crate::peer::PeerId;
    45	
    46	/// Errors emitted by `CollabSession` operations.
    47	#[derive(Debug, Error)]
    48	#[non_exhaustive]
    49	pub enum CollabSessionError {
    50	    /// The underlying `OpLog` failed (Loro encode/decode, serde,
    51	    /// etc.). Surfaces the wrapped `OpLogError` for diagnosis.
    52	    #[error("op log error: {0}")]
    53	    OpLog(#[from] OpLogError),
    54	}
    55	
    56	/// Per-peer collaboration state holder.
    57	///
    58	/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
    59	/// at scaffold time; Phase 5.5 will add the live transport
    60	/// integration via `Transport::send` / `try_recv`.
    61	///
    62	/// The session is the engine-side handle for one peer's view of a
    63	/// shared workbook. Multiple peers each hold their own
    64	/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
    65	/// and call `merge_bytes` to incorporate remote ops. All sessions
    66	/// converge to the same `OpLog` content after exchange (per Loro's
    67	/// CRDT determinism — Phase 5.1 audit Codex V1).
    68	pub struct CollabSession {
    69	    peer_id: PeerId,
    70	    log: OpLog,
    71	}
    72	
    73	impl CollabSession {
    74	    /// Construct a fresh session with an empty op log.
    75	    ///
    76	    /// Use this when no shared base snapshot exists yet (the first
    77	    /// peer to open a brand-new workbook). The `peer_id` is wired
    78	    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
    79	    /// CRDT merge metadata attributes this session's appends to
    80	    /// `peer_id` (not Loro's default random per-doc id).
    81	    ///
    82	    /// **Caller pitfall:** two concurrent sessions MUST use distinct
    83	    /// peer ids — see `OpLog::set_peer_id` for details.
    84	    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
    85	        let log = OpLog::new();
    86	        log.set_peer_id(peer_id.as_u64())?;
    87	        Ok(Self { peer_id, log })
    88	    }
    89	
    90	    /// Construct a session by importing a shared snapshot. Use this
    91	    /// when joining a session that already has history (the second+
    92	    /// peer to open a collaborative workbook).
    93	    ///
    94	    /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
    95	    /// by an earlier `CollabSession::export_bytes` call (typically
    96	    /// from the workbook owner / first peer). After import, this
    97	    /// session's peer id is set to `peer_id` — distinct from the
    98	    /// peer ids carried by the already-imported ops.
    99	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
   100	        let log = OpLog::import_bytes(bytes)?;
   101	        log.set_peer_id(peer_id.as_u64())?;
   102	        Ok(Self { peer_id, log })
   103	    }
   104	
   105	    /// Stable peer id assigned at session creation.
   106	    pub fn peer_id(&self) -> PeerId {
   107	        self.peer_id
   108	    }
   109	
   110	    /// Append a local op. Delegates to `OpLog::append`. Phase 5.5
   111	    /// will additionally push the appended bytes through the
   112	    /// attached `Transport`; 5.2.a leaves transport integration to
   113	    /// the caller.
   114	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
   115	        self.log.append(op)?;
   116	        Ok(())
   117	    }
   118	
   119	    /// Merge a remote peer's snapshot into this session's log. Loro's
   120	    /// CRDT preserves both peers' concurrent appends in deterministic
   121	    /// causal order (Fugue/origin-based with peer-id tiebreaker per
   122	    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
   123	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
   124	        Ok(self.log.merge_bytes(bytes)?)
   125	    }
   126	
   127	    /// Produce a Loro snapshot blob suitable for transport to other
   128	    /// peers OR for `.qbook/oplog.bin` persistence.
   129	    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
   130	        Ok(self.log.export_bytes()?)
   131	    }
   132	
   133	    /// Borrow the underlying `OpLog` for replay against a `Workbook`.
   134	    ///
   135	    /// Typical usage:
   136	    /// ```ignore
   137	    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
   138	    /// let mut wb = ql_storage::Workbook::new();
   139	    /// let reg = ql_functions::default_registry();
   140	    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
   141	    /// ```
   142	    pub fn op_log(&self) -> &OpLog {
   143	        &self.log
   144	    }
   145	
   146	    /// Current number of ops in the log. Cheap (cached).
   147	    pub fn op_count(&self) -> usize {
   148	        self.log.len()
   149	    }
   150	
   151	    /// True iff the log has no ops (session just opened, no edits yet).
   152	    pub fn is_empty(&self) -> bool {
   153	        self.log.is_empty()
   154	    }
   155	}
   156	
   157	impl std::fmt::Debug for CollabSession {
   158	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
   159	        f.debug_struct("CollabSession")
   160	            .field("peer_id", &self.peer_id)
   161	            .field("op_count", &self.log.len())
   162	            .finish()
   163	    }
   164	}
   165	
   166	#[cfg(test)]
   167	mod tests {
   168	    use super::*;
   169	    use ql_oplog::CellWireValue;
   170	
   171	    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
   172	        Op::PutValue {
   173	            sheet,
   174	            row,
   175	            col,
   176	            value: CellWireValue::Number(n),
   177	        }
   178	    }
   179	
   180	    #[test]
   181	    fn new_session_is_empty() {
   182	        let s = CollabSession::new(PeerId::new(1)).unwrap();
   183	        assert_eq!(s.peer_id(), PeerId::new(1));
   184	        assert_eq!(s.op_count(), 0);
   185	        assert!(s.is_empty());
   186	    }
   187	
   188	    #[test]
   189	    fn append_grows_log() {
   190	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   191	        s.append_op(Op::AddSheet {
   192	            name: "S".to_owned(),
   193	            chunk_rows: 16384,
   194	        })
   195	        .unwrap();
   196	        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
   197	        assert_eq!(s.op_count(), 2);
   198	        assert!(!s.is_empty());
   199	    }
   200	
   201	    #[test]
   202	    fn from_snapshot_reconstructs_op_count() {
   203	        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
   204	        origin
   205	            .append_op(Op::AddSheet {
   206	                name: "S".to_owned(),
   207	                chunk_rows: 16384,
   208	            })
   209	            .unwrap();
   210	        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   211	
   212	        let bytes = origin.export_bytes().unwrap();
   213	        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
   214	        assert_eq!(reborn.peer_id(), PeerId::new(2));
   215	        assert_eq!(reborn.op_count(), 2);
   216	    }
   217	
   218	    #[test]
   219	    fn merge_bytes_grows_log_with_remote_ops() {
   220	        // Two peers, shared base, each appends; one merges the other.
   221	        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
   222	        base.append_op(Op::AddSheet {
   223	            name: "S".to_owned(),
   224	            chunk_rows: 16384,
   225	        })
   226	        .unwrap();
   227	        let base_bytes = base.export_bytes().unwrap();
   228	
   229	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
   230	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
   231	
   232	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
   233	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
   234	
   235	        // Peer A pulls peer B's bytes.
   236	        let b_bytes = peer_b.export_bytes().unwrap();
   237	        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
   238	        assert!(
   239	            merged_count >= 3,
   240	            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
   241	        );
   242	    }
   243	
   244	    #[test]
   245	    fn debug_impl_includes_peer_id_and_count() {
   246	        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
   247	        s.append_op(put_value(0, 0, 0, 1.0)).ok();
   248	        let d = format!("{s:?}");
   249	        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
   250	        assert!(d.contains("op_count"), "Debug must include op_count: {d}");
   251	    }
   252	
   253	    #[test]
   254	    fn peer_id_is_wired_to_underlying_loro_doc() {
   255	        // Regression: prior to Phase 5.2.b the PeerId was stored on
   256	        // CollabSession but never passed to LoroDoc::set_peer_id, so
   257	        // op attribution at the CRDT layer used Loro's random
   258	        // per-doc peer id. After 5.2.b the configured PeerId MUST
   259	        // appear as the underlying log's peer_id().
   260	        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
   261	        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
   262	        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
   263	    }
   264	
   265	    #[test]
   266	    fn from_snapshot_overrides_imported_peer_id() {
   267	        // The origin session writes ops under PeerId(11). The reborn
   268	        // session imports the snapshot but uses its own PeerId(22)
   269	        // for future appends — the imported ops keep their original
   270	        // attribution (Loro semantics), but log.peer_id() reflects
   271	        // the reborn's configured PeerId.
   272	        let origin = CollabSession::new(PeerId::new(11)).unwrap();
   273	        let bytes = origin.export_bytes().unwrap();
   274	        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
   275	        assert_eq!(reborn.op_log().peer_id(), 22);
   276	    }
   277	}

exec
/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '360,430p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba docs/phase5/entry-plan.md | sed -n '120,155p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"CollabSession::new|from_snapshot\\(|OpLog::new\\(|set_peer_id\\(|peer_id\\(\\)\" crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs crates/ql-exec/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 283ms:
   120	1. ~~**Loro container shape uncertain**~~ — ✅ CLOSED. 5.1 design
   121	   audit-closed at `918d7efdd91` + `df52cb44ad2`. Option A
   122	   (op-log preservation on top of Loro `LoroList`) locked.
   123	2. **`oplog.bin` schema versioning is non-existent** — Phase 5
   124	   needs magic bytes + version header (Tier D3). Bundle into D-1
   125	   tagged-tuple FormatId schema work (next session).
   126	3. ~~**`WorkbookRuntime` monolith**~~ — ✅ CLOSED. Tier D1 split
   127	   shipped this session: 12,725-LOC `workbook_runtime.rs` → 9
   128	   sibling submodules + 247-LOC `mod.rs`. Public API surface
   129	   byte-for-byte identical; 4160 tests passing.
   130	4. ~~**Cycle-detection gap in `recompute_all`**~~ — ✅ CLOSED.
   131	   Tier C1 shipped at `3451d90a03f` + audit closures
   132	   `8137697b5fc`. Replay paths now inherit cycle detection via
   133	   ephemeral `CalcgraphSession`.
   134	5. ~~**API stability**~~ — ✅ CLOSED. Tier A
   135	   `#[non_exhaustive]` pass + deprecated removals + per-crate
   136	   stability docs shipped at `40bb584a25b`. Phase 5 additions
   137	   to `Op`, error types, etc. won't break 0.2.0 consumers.
   138	6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
   139	   2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
   140	   from `CollabSession::new` + `from_snapshot`. PeerId now wired
   141	   through to Loro's merge metadata. Caller pitfall (concurrent
   142	   sessions MUST use distinct peer ids) documented in
   143	   `crates/ql-collab/src/peer.rs` + `crates/ql-oplog/src/log.rs`.
   144	
   145	## Audit checkpoints
   146	
   147	Per master plan Phase 5:
   148	- **Design audit after 5.1 before implementation** — Codex + Opus
   149	  parallel review of the Loro data model decision.
   150	- **Megaudit after 5.7** — Phase 5.8 covers this.
   151	
   152	## Exit criteria (forward target)
   153	
   154	- `ql-collab` is real.
   155	- Cells, formulas, names, sheets, and tables merge deterministically.

 succeeded in 292ms:
   360	
   361	**Phase 5.2.a (2026-05-19, ✅ shipped at `66a571b30af`):** scaffold
   362	ships with the following module surface:
   363	
   364	```rust
   365	// crates/ql-collab/src/lib.rs (current state)
   366	
   367	pub mod peer;        // PeerId newtype (u64 wrapper)
   368	pub mod session;     // CollabSession: per-peer state holder
   369	pub mod transport;   // trait Transport + NoopTransport test impl
   370	
   371	pub use peer::PeerId;
   372	pub use session::{CollabSession, CollabSessionError};
   373	pub use transport::{NoopTransport, Transport, TransportError};
   374	```
   375	
   376	Reserved (not yet populated, named in `docs/MASTER-PLAN.md` §541):
   377	- `presence` — Phase 5.6 cursor + selection map.
   378	- `undo` — Phase 5.4 peer-local undo via Loro `UndoManager`.
   379	
   380	Phase 5.2.a totals ~11 unit tests + ~600 LOC of scaffold. Phase
   381	5.2.b onward populates richer behavior; full Phase 5.2 crate LOC
   382	estimate remains 1,500-2,500 LOC + tests.
   383	
   384	Current Cargo.toml deps (verified against `crates/ql-collab/Cargo.toml`):
   385	- `ql-oplog` — for `OpLog` + `Op` + `merge_bytes` + `import_bytes` + `export_bytes`.
   386	- `ql-storage` — forward-looking for Phase 5.5/5.7 replay integration
   387	  (currently used only in doc examples; kept to avoid Cargo churn
   388	  when replay wiring lands).
   389	- `ql-functions` — same forward-looking justification (registry
   390	  needed by replay).
   391	- `thiserror` — `CollabSessionError` + `TransportError`.
   392	
   393	It does NOT depend on `ql-io` or `ql-io-xlsx`. Phase 4.12 Opus-C
   394	HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2 backlog) closed
   395	this session at commit `e15e8908742`. `ql-oplog` is the dependency
   396	floor.
   397	
   398	**Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed):** the
   399	scaffold's known limitation — `PeerId` stored as a label only — was
   400	closed by adding `OpLog::set_peer_id` and calling it from
   401	`CollabSession::new` + `CollabSession::from_snapshot`. The configured
   402	`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
   403	merge metadata attributes each session's appends correctly. Caller
   404	pitfall (from Loro docs): concurrent sessions MUST use distinct peer
   405	ids — duplicate ids corrupt the document via conflicting OpIDs.
   406	
   407	## Decision matrix summary
   408	
   409	| Dimension | Option A (op-log) | Option B (per-feature containers) | Option C (hybrid) |
   410	|---|---|---|---|
   411	| 5.2 effort | 1-2 weeks | 3-4 weeks | 2-3 weeks |
   412	| Phase 4 replay reuse | ✅ full | ❌ rewrite | partial |
   413	| Concurrent cell merge | LWW | per-cell CRDT | per-cell CRDT |
   414	| Cycle detection | works | needs re-design | partial |
   415	| Spill invariants | preserved | risk | risk |
   416	| Snapshot mechanism | `ExportMode::Snapshot` works | ditto | ditto |
   417	| Replay determinism | proven | needs new proof | partial |
   418	| Memory per workbook | low | high (100k containers) | medium |
   419	| Presence | new map | new map | new map |
   420	
   421	**Choose Option A** for Phase 5 V1. Revisit Option B/C as Phase
   422	5 V2 / Phase 6 candidate.
   423	
   424	## Audit checkpoint (gating 5.2)
   425	
   426	This design doc requires a parallel Codex + separate-Opus audit
   427	BEFORE any 5.2 code lands. Per the engine audit-discipline rule
   428	(`memory/quantbook_engine_audit_discipline.md`), the audit
   429	should:
   430	

 succeeded in 289ms:
     1	//! Phase 5.2 D-4 probe test — spill semantics survive 2-peer CRDT merge.
     2	//!
     3	//! Phase 5.1 audit Opus M-2 + Codex V3 closure: design claims that
     4	//! spill blocking semantics are order-independent under CRDT merge
     5	//! because:
     6	//!
     7	//! 1. Replay stores formula text per `Op::PutFormula` (no
     8	//!    materialization at replay time).
     9	//! 2. `recompute_all` is called ONCE post-replay against the final
    10	//!    merged workbook state.
    11	//! 3. `write_spill` (`cells.rs:669`) blocks on occupied target
    12	//!    cells — irrespective of which op was logged "first."
    13	//!
    14	//! This probe verifies the claim end-to-end. Two peers concurrently
    15	//! edit: peer A writes `=SEQUENCE(3)` at A1 (would spill to A1:A3);
    16	//! peer B writes literal `5` at A2. After merging both peers' op
    17	//! logs via Loro's CRDT and replaying + recomputing, A1 emits
    18	//! `#SPILL!` because A2 is occupied. The same outcome must hold for
    19	//! BOTH peer-export orderings (A merges B's bytes; OR B merges A's
    20	//! bytes) — this is the order-independence claim.
    21	//!
    22	//! New `OpLog::merge_bytes` API added in this commit; this is the
    23	//! first test that exercises it.
    24	
    25	use ql_exec::WorkbookRuntime;
    26	use ql_functions::default_registry;
    27	use ql_oplog::{replay_into, CellWireValue, Op, OpLog};
    28	use ql_storage::Workbook;
    29	use ql_types::{Address, ErrorValue, Value};
    30	
    31	/// Build a base op log carrying just `AddSheet("S")`. Both peers
    32	/// fork from this to share a common causal ancestor.
    33	fn shared_base_log() -> OpLog {
    34	    let mut log = OpLog::new();
    35	    log.append(Op::AddSheet {
    36	        name: "S".to_owned(),
    37	        chunk_rows: 16384,
    38	    })
    39	    .unwrap();
    40	    log
    41	}
    42	
    43	/// Helper: replay a log into a fresh workbook + recompute. Returns
    44	/// the workbook ready for assertions.
    45	fn replay_and_recompute(log: &OpLog) -> Workbook {
    46	    let mut wb = Workbook::new();
    47	    let reg = default_registry();
    48	    replay_into(log, &mut wb, &reg).expect("replay should succeed");
    49	    {
    50	        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
    51	        rt.recompute_all();
    52	    }
    53	    wb
    54	}
    55	
    56	/// **Peer A merges peer B's bytes.** After merge, peer A's log
    57	/// contains both ops in deterministic causal order. Replay +
    58	/// recompute → A1 emits `#SPILL!` (A2 occupied), A2 keeps `5`.
    59	#[test]
    60	fn d4_spill_blocking_survives_a_merges_b() {
    61	    let base_bytes = shared_base_log().export_bytes().unwrap();
    62	
    63	    // Peer A: fork from base + write the spilling formula.
    64	    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
    65	    peer_a
    66	        .append(Op::PutFormula {
    67	            sheet: 0,
    68	            row: 0,
    69	            col: 0,
    70	            text: "SEQUENCE(3)".to_owned(),
    71	        })
    72	        .unwrap();
    73	
    74	    // Peer B: fork from base + write the blocking literal at A2.
    75	    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
    76	    peer_b
    77	        .append(Op::PutValue {
    78	            sheet: 0,
    79	            row: 1,
    80	            col: 0,
    81	            value: CellWireValue::Number(5.0),
    82	        })
    83	        .unwrap();
    84	
    85	    // Peer A merges peer B's bytes (Phase 5.5 will do this via the
    86	    // transport layer; the test uses the export/merge API directly).
    87	    let b_bytes = peer_b.export_bytes().unwrap();
    88	    peer_a.merge_bytes(&b_bytes).unwrap();
    89	    assert!(
    90	        peer_a.len() >= 3,
    91	        "merged log must contain at least AddSheet + PutFormula + PutValue"
    92	    );
    93	
    94	    let merged_wb = replay_and_recompute(&peer_a);
    95	
    96	    assert_eq!(
    97	        merged_wb.read(Address::new(0, 0, 0)),
    98	        Value::Error(ErrorValue::Spill),
    99	        "A1 must emit #SPILL! when A2 is occupied (recompute_all detects \
   100	         the spill block regardless of which op was logged first)"
   101	    );
   102	    assert_eq!(
   103	        merged_wb.read(Address::new(0, 1, 0)),
   104	        Value::Number(5.0),
   105	        "A2 retains its literal value 5"
   106	    );
   107	}
   108	
   109	/// **Peer B merges peer A's bytes.** The CRDT-determinism claim:
   110	/// outcome MUST be identical to `d4_spill_blocking_survives_a_merges_b`
   111	/// regardless of which peer initiates the merge. Verifies
   112	/// order-independence of the merge direction.
   113	#[test]
   114	fn d4_spill_blocking_survives_b_merges_a() {
   115	    let base_bytes = shared_base_log().export_bytes().unwrap();
   116	
   117	    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
   118	    peer_a
   119	        .append(Op::PutFormula {
   120	            sheet: 0,
   121	            row: 0,
   122	            col: 0,
   123	            text: "SEQUENCE(3)".to_owned(),
   124	        })
   125	        .unwrap();
   126	
   127	    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
   128	    peer_b
   129	        .append(Op::PutValue {
   130	            sheet: 0,
   131	            row: 1,
   132	            col: 0,
   133	            value: CellWireValue::Number(5.0),
   134	        })
   135	        .unwrap();
   136	
   137	    // Reverse merge direction: peer B pulls peer A's bytes.
   138	    let a_bytes = peer_a.export_bytes().unwrap();
   139	    peer_b.merge_bytes(&a_bytes).unwrap();
   140	
   141	    let merged_wb = replay_and_recompute(&peer_b);
   142	
   143	    assert_eq!(
   144	        merged_wb.read(Address::new(0, 0, 0)),
   145	        Value::Error(ErrorValue::Spill),
   146	        "merge direction is irrelevant — A1 still emits #SPILL!"
   147	    );
   148	    assert_eq!(
   149	        merged_wb.read(Address::new(0, 1, 0)),
   150	        Value::Number(5.0),
   151	        "A2 retains 5 under reverse merge too"
   152	    );
   153	}
   154	
   155	/// **No collision case.** If peer B writes at a NON-spill-footprint
   156	/// cell (e.g. A5 outside the SEQUENCE(3) target A1:A3), the spill
   157	/// succeeds — A1:A3 materialize with 1, 2, 3; A5 keeps its literal.
   158	/// This is the order-independence claim's "happy path" complement.
   159	#[test]
   160	fn d4_spill_succeeds_when_concurrent_op_outside_footprint() {
   161	    let base_bytes = shared_base_log().export_bytes().unwrap();
   162	
   163	    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
   164	    peer_a
   165	        .append(Op::PutFormula {
   166	            sheet: 0,
   167	            row: 0,
   168	            col: 0,
   169	            text: "SEQUENCE(3)".to_owned(),
   170	        })
   171	        .unwrap();
   172	
   173	    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
   174	    peer_b
   175	        .append(Op::PutValue {
   176	            sheet: 0,
   177	            row: 4,
   178	            col: 0, // A5, outside the SEQUENCE(3) footprint A1:A3
   179	            value: CellWireValue::Number(99.0),
   180	        })
   181	        .unwrap();
   182	
   183	    let b_bytes = peer_b.export_bytes().unwrap();
   184	    peer_a.merge_bytes(&b_bytes).unwrap();
   185	
   186	    let merged_wb = replay_and_recompute(&peer_a);
   187	
   188	    // Spill materialized: A1=1, A2=2, A3=3.
   189	    assert_eq!(merged_wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
   190	    assert_eq!(merged_wb.read(Address::new(0, 1, 0)), Value::Number(2.0));
   191	    assert_eq!(merged_wb.read(Address::new(0, 2, 0)), Value::Number(3.0));
   192	    // A5 keeps peer B's value.
   193	    assert_eq!(merged_wb.read(Address::new(0, 4, 0)), Value::Number(99.0));
   194	}
   195	
   196	/// **Determinism across re-merge.** Replay an export of the merged
   197	/// log a SECOND time on a fresh workbook — the outcome must be
   198	/// byte-identical to the first replay. This pins the "deterministic
   199	/// replay" claim from the design doc.
   200	#[test]
   201	fn d4_replay_of_merged_log_is_deterministic_across_runs() {
   202	    let base_bytes = shared_base_log().export_bytes().unwrap();
   203	
   204	    let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
   205	    peer_a
   206	        .append(Op::PutFormula {
   207	            sheet: 0,
   208	            row: 0,
   209	            col: 0,
   210	            text: "SEQUENCE(3)".to_owned(),
   211	        })
   212	        .unwrap();
   213	
   214	    let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
   215	    peer_b
   216	        .append(Op::PutValue {
   217	            sheet: 0,
   218	            row: 1,
   219	            col: 0,
   220	            value: CellWireValue::Number(5.0),
   221	        })
   222	        .unwrap();
   223	
   224	    peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
   225	
   226	    let wb_first = replay_and_recompute(&peer_a);
   227	
   228	    // Round-trip the merged log through export/import (simulates
   229	    // saving + reloading the merged state) and replay again.
   230	    let merged_bytes = peer_a.export_bytes().unwrap();
   231	    let reloaded = OpLog::import_bytes(&merged_bytes).unwrap();
   232	    let wb_second = replay_and_recompute(&reloaded);
   233	
   234	    // Same cell values across both runs.
   235	    for (row, col) in [(0, 0), (1, 0), (2, 0)] {
   236	        assert_eq!(
   237	            wb_first.read(Address::new(0, row, col)),
   238	            wb_second.read(Address::new(0, row, col)),
   239	            "cell ({row},{col}) must match across replays"
   240	        );
   241	    }
   242	}

 succeeded in 294ms:
crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:34:    let mut log = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:90:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:143:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:184:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:218:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:248:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:272:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:310:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:370:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:497:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:546:    let mut oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:579:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:625:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:652:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:709:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:824:    let mut oplog = ql_oplog::OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:856:    let mut oplog = ql_oplog::OpLog::new();
crates/ql-exec/tests/oplog_e2e.rs:902:    let mut producer_oplog = OpLog::new();
crates/ql-exec/tests/error_precedence.rs:31:    (wb, OpLog::new())
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:45:    let mut oplog = OpLog::new();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:115:    let mut oplog = OpLog::new();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:206:    let mut oplog = OpLog::new();
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:299:    let mut oplog = OpLog::new();
crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:34:    let mut log = OpLog::new();
crates/ql-exec/tests/ide_simulation.rs:30:    (wb, OpLog::new())

codex
The new wrapper code is small and matches the brief mechanically. The first thing that stands out is that the older D-4 probe still uses bare `OpLog::import_bytes` without assigning explicit peer ids; I’m checking Loro’s import and transaction internals before deciding whether that is just a test-style gap or a correctness issue.
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '960,1000p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '150,235p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '250,315p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"fn commit|pub fn commit|record_local|set_peer_id|peer_id\\(|start_auto_commit|transaction\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 270ms:
   960	    /// let doc = LoroDoc::new();
   961	    /// let before = doc.state_frontiers();
   962	    /// doc.get_text("t").insert(0, "x").unwrap();
   963	    /// let after = doc.state_frontiers();
   964	    /// assert_ne!(before, after);
   965	    /// ```
   966	    #[inline]
   967	    pub fn state_frontiers(&self) -> Frontiers {
   968	        self.doc.state_frontiers()
   969	    }
   970	
   971	    /// Get the PeerID
   972	    #[inline]
   973	    pub fn peer_id(&self) -> PeerID {
   974	        self.doc.peer_id()
   975	    }
   976	
   977	    /// Change the PeerID
   978	    ///
   979	    /// Pitfalls:
   980	    /// - Never reuse the same PeerID across concurrent writers (multiple tabs/devices). Duplicate
   981	    ///   PeerIDs can produce conflicting OpIDs and corrupt the document.
   982	    /// - Do not assign a fixed PeerID to a user or device without strict single-ownership locking.
   983	    ///   Prefer the default random PeerID per process/session.
   984	    #[inline]
   985	    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
   986	        self.doc.set_peer_id(peer)
   987	    }
   988	
   989	    /// Subscribe the events of a container.
   990	    ///
   991	    /// The callback will be invoked after a transaction that change the container.
   992	    /// Returns a subscription that can be used to unsubscribe.
   993	    ///
   994	    /// The events will be emitted after a transaction is committed. A transaction is committed when:
   995	    ///
   996	    /// - `doc.commit()` is called.
   997	    /// - `doc.export(mode)` is called.
   998	    /// - `doc.import(data)` is called.
   999	    /// - `doc.checkout(version)` is called.
  1000	    ///

 succeeded in 268ms:
   150	    /// Enables editing of the document in detached mode.
   151	    ///
   152	    /// By default, the document cannot be edited in detached mode (after calling
   153	    /// `detach` or checking out a version other than the latest). This method
   154	    /// allows editing in detached mode.
   155	    ///
   156	    /// # Important Notes:
   157	    ///
   158	    /// - After enabling this mode, the document will use a different PeerID. Each
   159	    ///   time you call checkout, a new PeerID will be used.
   160	    /// - If you set a custom PeerID while this mode is enabled, ensure that
   161	    ///   concurrent operations with the same PeerID are not possible.
   162	    /// - On detached mode, importing will not change the state of the document.
   163	    ///   It also doesn't change the version of the [DocState]. The changes will be
   164	    ///   recorded into [OpLog] only. You need to call `checkout` to make it take effect.
   165	    pub fn set_detached_editing(&self, enable: bool) {
   166	        self.config.set_detached_editing(enable);
   167	        if enable && self.is_detached() {
   168	            self.with_barrier(|| {
   169	                self.renew_peer_id();
   170	            });
   171	        }
   172	    }
   173	
   174	    /// Create a doc with auto commit enabled.
   175	    #[inline]
   176	    pub fn new_auto_commit() -> Self {
   177	        let doc = Self::new();
   178	        doc.start_auto_commit();
   179	        doc
   180	    }
   181	
   182	    #[inline(always)]
   183	    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
   184	        if peer == PeerID::MAX {
   185	            return Err(LoroError::InvalidPeerID);
   186	        }
   187	        let next_id = self.oplog.lock().next_id(peer);
   188	        if self.auto_commit.load(Acquire) {
   189	            let doc_state = self.state.lock();
   190	            doc_state
   191	                .peer
   192	                .store(peer, std::sync::atomic::Ordering::Relaxed);
   193	
   194	            if doc_state.is_in_txn() {
   195	                drop(doc_state);
   196	                // Use implicit-style barrier to avoid swallowing next-commit options
   197	                self.with_barrier(|| {});
   198	            }
   199	            self.peer_id_change_subs.emit(&(), next_id);
   200	            return Ok(());
   201	        }
   202	
   203	        let doc_state = self.state.lock();
   204	        if doc_state.is_in_txn() {
   205	            return Err(LoroError::TransactionError(
   206	                "Cannot change peer id during transaction"
   207	                    .to_string()
   208	                    .into_boxed_str(),
   209	            ));
   210	        }
   211	
   212	        doc_state
   213	            .peer
   214	            .store(peer, std::sync::atomic::Ordering::Relaxed);
   215	        drop(doc_state);
   216	        self.peer_id_change_subs.emit(&(), next_id);
   217	        Ok(())
   218	    }
   219	
   220	    /// Renews the PeerID for the document.
   221	    pub(crate) fn renew_peer_id(&self) {
   222	        let mut peer_id = DefaultRandom.next_u64();
   223	        while peer_id == PeerID::MAX {
   224	            peer_id = DefaultRandom.next_u64();
   225	        }
   226	        self.set_peer_id(peer_id).unwrap();
   227	    }
   228	
   229	    /// Implicitly commit the cumulative auto-commit transaction.
   230	    /// This method only has effect when `auto_commit` is true.
   231	    ///
   232	    /// Follow-ups: the caller is responsible for renewing the transaction
   233	    /// as needed (e.g., via `renew_txn_if_auto_commit`). Prefer using
   234	    /// `with_barrier(...)` for most internal flows to handle this safely.
   235	    ///

 succeeded in 266ms:
   250	        (a, b.unwrap())
   251	    }
   252	
   253	    /// Commit the cumulative auto commit transaction.
   254	    /// It will start the next one immediately
   255	    ///
   256	    /// It only returns Some(options_of_the_empty_txn) when the txn is empty
   257	    #[inline]
   258	    pub fn commit_then_renew(&self) -> Option<CommitOptions> {
   259	        // Explicit commit: swallow options on empty commit
   260	        self.commit_internal(CommitOptions::new().immediate_renew(true), false)
   261	            .0
   262	    }
   263	
   264	    /// This method is called before the commit.
   265	    /// It can be used to modify the change before it is committed.
   266	    ///
   267	    /// It return Some(txn) if the txn is None
   268	    fn before_commit(&self) -> Option<LoroMutexGuard<'_, Option<Transaction>>> {
   269	        let mut txn_guard = self.txn.lock();
   270	        let Some(txn) = txn_guard.as_mut() else {
   271	            return Some(txn_guard);
   272	        };
   273	
   274	        if txn.is_peer_first_appearance {
   275	            txn.is_peer_first_appearance = false;
   276	            drop(txn_guard);
   277	            // First commit from a peer
   278	            self.first_commit_from_peer_subs.emit(
   279	                &(),
   280	                FirstCommitFromPeerPayload {
   281	                    peer: self.peer_id(),
   282	                },
   283	            );
   284	        }
   285	
   286	        None
   287	    }
   288	
   289	    /// Core implementation for committing the cumulative auto-commit transaction.
   290	    ///
   291	    /// - When `preserve_on_empty` is true (implicit commits like export/checkout),
   292	    ///   commit options from an empty transaction are carried over to the next transaction
   293	    ///   (except `origin`, which never carries across an empty commit).
   294	    /// - When `preserve_on_empty` is false (explicit commits), commit options from an
   295	    ///   empty transaction are swallowed and NOT carried over.
   296	    #[instrument(skip_all)]
   297	    fn commit_internal(
   298	        &self,
   299	        config: CommitOptions,
   300	        preserve_on_empty: bool,
   301	    ) -> (
   302	        Option<CommitOptions>,
   303	        Option<LoroMutexGuard<'_, Option<Transaction>>>,
   304	    ) {
   305	        if !self.auto_commit.load(Acquire) {
   306	            let txn_guard = self.txn.lock();
   307	            // if not auto_commit, nothing should happen
   308	            // because the global txn is not used
   309	            return (None, Some(txn_guard));
   310	        }
   311	
   312	        loop {
   313	            if let Some(txn_guard) = self.before_commit() {
   314	                return (None, Some(txn_guard));
   315	            }

 succeeded in 269ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:83:    /// This finalizes any pending auto-commit transaction first (preserving
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:84:    /// options across an empty txn), executes `f`, then renews the transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:146:            doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:169:                self.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:178:        doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:183:    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:206:                "Cannot change peer id during transaction"
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:221:    pub(crate) fn renew_peer_id(&self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:226:        self.set_peer_id(peer_id).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:229:    /// Implicitly commit the cumulative auto-commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:232:    /// Follow-ups: the caller is responsible for renewing the transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:236:    /// Empty-commit behavior: if the pending transaction is empty, the returned
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:238:    /// timestamp so they can carry into the renewed transaction. Transient
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:253:    /// Commit the cumulative auto commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:258:    pub fn commit_then_renew(&self) -> Option<CommitOptions> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:281:                    peer: self.peer_id(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:289:    /// Core implementation for committing the cumulative auto-commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:292:    ///   commit options from an empty transaction are carried over to the next transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:295:    ///   empty transaction are swallowed and NOT carried over.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:297:    fn commit_internal(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:379:    /// Commit the cumulative auto commit transaction (explicit API).
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:381:    /// This is used by user-facing explicit commits. If the transaction is empty,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:384:    pub fn commit_with(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:527:    pub fn peer_id(&self) -> PeerID {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:569:        let s = debug_span!("import", peer = self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:601:                    peer = self.peer_id()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:611:                    loro_common::info!("Init by snapshot {}", self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:623:                    loro_common::info!("Init by fast snapshot {}", self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1152:        self.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1516:        tracing::info_span!("CheckoutToLatest", peer = self.peer_id()).in_scope(|| {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1524:                this.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1546:                self.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1570:                "checkout requires the transaction mutex to be held"
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1696:            let peer_id = self.peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2020:    /// Get the number of operations in the pending transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2022:    /// The pending transaction is the one that is not committed yet. It will be committed
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2235:    /// Whether to immediately start a new transaction after committing.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2264:    /// Sets whether to immediately start a new transaction after committing.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2279:    pub fn commit_msg(mut self, commit_msg: &str) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2370:        doc.set_peer_id(peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2407:        doc.set_peer_id(peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2466:        src.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2492:        src.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2548:        src.set_peer_id(12).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2666:        src.set_peer_id(14).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2734:        loro.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:39:    doc.set_peer_id(peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:72:    base.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:82:    peer2.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:89:    peer3.set_peer_id(3).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:118:    src.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:157:    base.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:166:    peer2.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:172:    peer3.set_peer_id(3).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:279:    src.set_peer_id(9).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/jsonpath/jsonpath_impl.rs:852:        doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/jsonpath/jsonpath_impl.rs:1451:            doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:871:        let ids = filter_duplicated_peer_id(last_ids);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:919:fn filter_duplicated_peer_id(last_ids: &Frontiers) -> Vec<ID> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:17:    doc.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:27:    src.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:43:    doc.set_peer_id(3).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:53:    src.set_peer_id(4).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:79:    src.set_peer_id(5).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:83:    /// This finalizes any pending auto-commit transaction first (preserving
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:84:    /// options across an empty txn), executes `f`, then renews the transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:146:            doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:169:                self.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:178:        doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:183:    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:206:                "Cannot change peer id during transaction"
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:221:    pub(crate) fn renew_peer_id(&self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:226:        self.set_peer_id(peer_id).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:229:    /// Implicitly commit the cumulative auto-commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:232:    /// Follow-ups: the caller is responsible for renewing the transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:236:    /// Empty-commit behavior: if the pending transaction is empty, the returned
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:238:    /// timestamp so they can carry into the renewed transaction. Transient
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:253:    /// Commit the cumulative auto commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:258:    pub fn commit_then_renew(&self) -> Option<CommitOptions> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:281:                    peer: self.peer_id(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:289:    /// Core implementation for committing the cumulative auto-commit transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:292:    ///   commit options from an empty transaction are carried over to the next transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:295:    ///   empty transaction are swallowed and NOT carried over.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:297:    fn commit_internal(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:379:    /// Commit the cumulative auto commit transaction (explicit API).
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:381:    /// This is used by user-facing explicit commits. If the transaction is empty,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:384:    pub fn commit_with(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:527:    pub fn peer_id(&self) -> PeerID {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:569:        let s = debug_span!("import", peer = self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:601:                    peer = self.peer_id()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:611:                    loro_common::info!("Init by snapshot {}", self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:623:                    loro_common::info!("Init by fast snapshot {}", self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1152:        self.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1516:        tracing::info_span!("CheckoutToLatest", peer = self.peer_id()).in_scope(|| {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1524:                this.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1546:                self.renew_peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1570:                "checkout requires the transaction mutex to be held"
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1696:            let peer_id = self.peer_id();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2020:    /// Get the number of operations in the pending transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2022:    /// The pending transaction is the one that is not committed yet. It will be committed
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2235:    /// Whether to immediately start a new transaction after committing.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2264:    /// Sets whether to immediately start a new transaction after committing.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2279:    pub fn commit_msg(mut self, commit_msg: &str) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2370:        doc.set_peer_id(peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2407:        doc.set_peer_id(peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2466:        src.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2492:        src.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2548:        src.set_peer_id(12).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2666:        src.set_peer_id(14).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2734:        loro.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/container.rs:25:    // During a transaction, we may create some containers which are deleted later. And these containers also need a unique ContainerIdx.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:1773:    /// Insert text within an existing transaction using the provided `pos_type`.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:1998:    /// Delete text within a transaction using the specified `pos_type`.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4318:            doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4531:        loro.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4533:        loro2.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4595:        doc_a.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4607:        doc_b.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4702:        loro.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/fork.rs:47:            doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/undo.rs:573:        let peer = Arc::new(AtomicU64::new(doc.peer_id()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/undo.rs:577:            get_counter_end(doc, doc.peer_id()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/container_store.rs:318:        doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:222:    pub(crate) fn commit_import_rollback(&mut self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:381:    pub(crate) fn check_change_greater_than_last_peer_id(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/event.rs:36:    /// The event is triggered by a local transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/event.rs:83:/// [DocDiff] may include the diff that calculated from several transactions and imports.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:46:    /// Create a new transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:47:    /// Every ops created inside one transaction will be packed into a single
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:50:    /// There can only be one active transaction at a time for a [LoroDoc].
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:56:    /// Create a new transaction with specified origin.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:59:    /// There can only be one active transaction at a time for a [LoroDoc].
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:94:    pub fn start_auto_commit(&self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:104:            .expect("auto-commit should be able to create a transaction");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:118:                .expect("auto-commit should be able to renew a transaction");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:139:                .expect("auto-commit should be able to renew a transaction");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:192:/// record them, so that we can avoid recalculate them when we commit the transaction.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:355:            oplog_lock.check_change_greater_than_last_peer_id(peer, next_counter, &frontiers)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:426:    pub fn commit(mut self) -> Result<Option<CommitOptions>, LoroError> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:485:                "missing uncommitted change while committing transaction",
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:981:        doc.set_peer_id(7).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:990:        doc.set_peer_id(7).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/delta/map.rs:48:                // should not happen in transaction
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:280:        a.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:282:        b.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:311:        a.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:313:        b.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:333:        a.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:335:        b.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:337:        c.set_peer_id(3).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:339:        d.set_peer_id(4).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:376:        a.set_peer_id(1).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:378:        b.set_peer_id(2).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:380:        c.set_peer_id(3).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:401:    //     a.set_peer_id(1);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:403:    //     b.set_peer_id(2);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:405:    //     c.set_peer_id(3);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:173:    pub(crate) fn commit_import_rollback(&mut self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:376:    pub fn fork_with_new_peer_id(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:417:    pub fn refresh_peer_id(&mut self) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:459:    /// This should be called when DocState is going to apply a transaction / a diff.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:494:    pub fn set_peer_id(&mut self, peer: PeerID) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:498:    pub fn peer_id(&self) -> PeerID {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:516:                "apply_diff should not be called in a transaction"
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:745:                let state = create_state_(diff.idx, &self.config, self.peer_id());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:803:    pub(crate) fn commit_txn(&mut self, new_frontiers: Frontiers, diff: Option<InternalDocDiff>) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:776:        doc.start_auto_commit();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/json_schema.rs:1594:        doc.set_peer_id(0).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/shallow_snapshot.rs:320:                "encode_snapshot_at: state is unexpectedly still in a transaction",
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/tree_state.rs:1569:        last_set_peer_idx: usize,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/tree_state.rs:1624:                last_set_peer_idx: peers.register(&last_set_id.peer),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/tree_state.rs:1641:                last_set_peer_idx: peers.register(&last_set_id.peer),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/tree_state.rs:1732:                        peers[node.last_set_peer_idx],

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '80,150p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '315,410p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '515,635p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs | sed -n '300,470p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 300ms:
    80	impl LoroDoc {
    81	    /// Run the provided closure within a commit barrier.
    82	    ///
    83	    /// This finalizes any pending auto-commit transaction first (preserving
    84	    /// options across an empty txn), executes `f`, then renews the transaction
    85	    /// (carrying preserved options) if auto-commit is enabled. This is the
    86	    /// common implicit-commit pattern used by internal operations such as
    87	    /// import/export/checkouts.
    88	    #[inline]
    89	    pub fn with_barrier<F, R>(&self, f: F) -> R
    90	    where
    91	        F: FnOnce() -> R,
    92	    {
    93	        let (options, guard) = self.implicit_commit_then_stop();
    94	        let result = f();
    95	        drop(guard);
    96	        self.renew_txn_if_auto_commit(options);
    97	        result
    98	    }
    99	
   100	    pub fn new() -> Self {
   101	        let visible_op_count = Arc::new(AtomicUsize::new(0));
   102	        let oplog = OpLog::new(visible_op_count.clone());
   103	        let arena = oplog.arena.clone();
   104	        let config: Configure = oplog.configure.clone();
   105	        let lock_group = LoroLockGroup::new();
   106	        let global_txn = Arc::new(lock_group.new_lock(None, LockKind::Txn));
   107	        let inner = Arc::new_cyclic(|w| {
   108	            let state = DocState::new_arc(w.clone(), arena.clone(), config.clone(), &lock_group);
   109	            LoroDocInner {
   110	                oplog: Arc::new(lock_group.new_lock(oplog, LockKind::OpLog)),
   111	                state,
   112	                config,
   113	                visible_op_count,
   114	                detached: AtomicBool::new(false),
   115	                auto_commit: AtomicBool::new(false),
   116	                observer: Arc::new(Observer::new(arena.clone())),
   117	                diff_calculator: Arc::new(
   118	                    lock_group.new_lock(DiffCalculator::new(true), LockKind::DiffCalculator),
   119	                ),
   120	                txn: global_txn,
   121	                arena,
   122	                local_update_subs: SubscriberSetWithQueue::new(),
   123	                peer_id_change_subs: SubscriberSetWithQueue::new(),
   124	                pre_commit_subs: SubscriberSetWithQueue::new(),
   125	                first_commit_from_peer_subs: SubscriberSetWithQueue::new(),
   126	            }
   127	        });
   128	        LoroDoc { inner }
   129	    }
   130	
   131	    pub fn fork(&self) -> Self {
   132	        if self.is_detached() {
   133	            return self
   134	                .fork_at(&self.state_frontiers())
   135	                .expect("fork_at on detached doc should not fail");
   136	        }
   137	
   138	        let snapshot = self.with_barrier(|| encoding::fast_snapshot::encode_snapshot_inner(self));
   139	        let doc = Self::new();
   140	        doc.with_barrier(|| {
   141	            encoding::fast_snapshot::decode_snapshot_inner(snapshot, &doc, Default::default())
   142	        })
   143	        .unwrap();
   144	        doc.set_config(&self.config);
   145	        if self.auto_commit.load(std::sync::atomic::Ordering::Relaxed) {
   146	            doc.start_auto_commit();
   147	        }
   148	        doc
   149	    }
   150	    /// Enables editing of the document in detached mode.

 succeeded in 297ms:
   315	            }
   316	
   317	            let mut txn_guard = self.txn.lock();
   318	            let txn = txn_guard.take();
   319	            let Some(mut txn) = txn else {
   320	                return (None, Some(txn_guard));
   321	            };
   322	            let on_commit = txn.take_on_commit();
   323	            if let Some(origin) = config.origin.clone() {
   324	                txn.set_origin(origin);
   325	            }
   326	
   327	            if let Some(timestamp) = config.timestamp {
   328	                txn.set_timestamp(timestamp);
   329	            }
   330	
   331	            if let Some(msg) = config.commit_msg.as_ref() {
   332	                txn.set_msg(Some(msg.clone()));
   333	            }
   334	
   335	            let id_span = txn.id_span();
   336	            let mut options = txn.commit().unwrap();
   337	            // Empty commit returns Some(options). We may preserve parts of it for implicit commits.
   338	            if let Some(opts) = options.as_mut() {
   339	                // `origin` is an event-only label and never carries across an empty commit
   340	                if config.origin.is_some() {
   341	                    opts.set_origin(None);
   342	                }
   343	                // For explicit commits, swallow options from empty commit entirely
   344	                if !preserve_on_empty {
   345	                    options = None;
   346	                }
   347	            }
   348	            if config.immediate_renew {
   349	                if self.can_edit() {
   350	                    let mut t = self.txn().unwrap();
   351	                    if let Some(options) = options.as_ref() {
   352	                        t.set_options(options.clone());
   353	                    }
   354	                    *txn_guard = Some(t);
   355	                }
   356	            }
   357	
   358	            if let Some(on_commit) = on_commit {
   359	                drop(txn_guard);
   360	                on_commit(&self.state, &self.oplog, id_span);
   361	                txn_guard = self.txn.lock();
   362	                if !config.immediate_renew && txn_guard.is_some() {
   363	                    // make sure that txn_guard is None when config.immediate_renew is false
   364	                    continue;
   365	                }
   366	            }
   367	
   368	            return (
   369	                options,
   370	                if !config.immediate_renew {
   371	                    Some(txn_guard)
   372	                } else {
   373	                    None
   374	                },
   375	            );
   376	        }
   377	    }
   378	
   379	    /// Commit the cumulative auto commit transaction (explicit API).
   380	    ///
   381	    /// This is used by user-facing explicit commits. If the transaction is empty,
   382	    /// any provided commit options are swallowed and will NOT carry over.
   383	    #[instrument(skip_all)]
   384	    pub fn commit_with(
   385	        &self,
   386	        config: CommitOptions,
   387	    ) -> (
   388	        Option<CommitOptions>,
   389	        Option<LoroMutexGuard<'_, Option<Transaction>>>,
   390	    ) {
   391	        self.commit_internal(config, false)
   392	    }
   393	
   394	    /// Set the commit message of the next commit
   395	    pub fn set_next_commit_message(&self, message: &str) {
   396	        let mut binding = self.txn.lock();
   397	        let Some(txn) = binding.as_mut() else {
   398	            return;
   399	        };
   400	
   401	        if message.is_empty() {
   402	            txn.set_msg(None)
   403	        } else {
   404	            txn.set_msg(Some(message.into()))
   405	        }
   406	    }
   407	
   408	    /// Set the origin of the next commit
   409	    pub fn set_next_commit_origin(&self, origin: &str) {
   410	        let mut txn = self.txn.lock();

 succeeded in 290ms:
   515	    /// It also doesn't change the version of the [DocState]. The changes will be recorded into [OpLog] only.
   516	    /// You need to call `checkout` to make it take effect.
   517	    #[inline(always)]
   518	    pub fn is_detached(&self) -> bool {
   519	        self.detached.load(Acquire)
   520	    }
   521	
   522	    pub(crate) fn set_detached(&self, detached: bool) {
   523	        self.detached.store(detached, Release);
   524	    }
   525	
   526	    #[inline(always)]
   527	    pub fn peer_id(&self) -> PeerID {
   528	        self.state
   529	            .lock()
   530	            .peer
   531	            .load(std::sync::atomic::Ordering::Relaxed)
   532	    }
   533	
   534	    #[inline(always)]
   535	    pub fn detach(&self) {
   536	        self.with_barrier(|| self.set_detached(true));
   537	    }
   538	
   539	    #[inline(always)]
   540	    pub fn attach(&self) {
   541	        self.checkout_to_latest()
   542	    }
   543	
   544	    /// Get the timestamp of the current state.
   545	    /// It's the last edit time of the [DocState].
   546	    pub fn state_timestamp(&self) -> Timestamp {
   547	        // Acquire locks in correct order: read frontiers first, then query OpLog.
   548	        let f = { self.state.lock().frontiers.clone() };
   549	        self.oplog.lock().get_timestamp_of_version(&f)
   550	    }
   551	
   552	    #[inline(always)]
   553	    pub fn app_state(&self) -> &Arc<LoroMutex<DocState>> {
   554	        &self.state
   555	    }
   556	
   557	    #[inline]
   558	    pub fn get_state_deep_value(&self) -> LoroValue {
   559	        self.state.lock().get_deep_value()
   560	    }
   561	
   562	    #[inline(always)]
   563	    pub fn oplog(&self) -> &Arc<LoroMutex<OpLog>> {
   564	        &self.oplog
   565	    }
   566	
   567	    #[inline(always)]
   568	    pub fn import(&self, bytes: &[u8]) -> Result<ImportStatus, LoroError> {
   569	        let s = debug_span!("import", peer = self.peer_id());
   570	        let _e = s.enter();
   571	        self.import_with(bytes, Default::default())
   572	    }
   573	
   574	    #[inline]
   575	    pub fn import_with(
   576	        &self,
   577	        bytes: &[u8],
   578	        origin: InternalString,
   579	    ) -> Result<ImportStatus, LoroError> {
   580	        self.with_barrier(|| self._import_with(bytes, origin))
   581	    }
   582	
   583	    #[tracing::instrument(skip_all)]
   584	    fn _import_with(
   585	        &self,
   586	        bytes: &[u8],
   587	        origin: InternalString,
   588	    ) -> Result<ImportStatus, LoroError> {
   589	        ensure_cov::notify_cov("loro_internal::import");
   590	        let parsed = parse_header_and_body(bytes, true)?;
   591	        loro_common::info!("Importing with mode={:?}", &parsed.mode);
   592	        let result = match parsed.mode {
   593	            EncodeMode::OutdatedRle => {
   594	                if self.state.lock().is_in_txn() {
   595	                    return Err(LoroError::ImportWhenInTxn);
   596	                }
   597	
   598	                let s = tracing::span!(
   599	                    tracing::Level::INFO,
   600	                    "Import updates ",
   601	                    peer = self.peer_id()
   602	                );
   603	                let _e = s.enter();
   604	                self.update_oplog_and_apply_delta_to_state_if_needed(
   605	                    |oplog| oplog.decode(parsed),
   606	                    origin,
   607	                )
   608	            }
   609	            EncodeMode::OutdatedSnapshot => {
   610	                if self.can_reset_with_snapshot() {
   611	                    loro_common::info!("Init by snapshot {}", self.peer_id());
   612	                    decode_snapshot(self, parsed.mode, parsed.body, origin)
   613	                } else {
   614	                    self.update_oplog_and_apply_delta_to_state_if_needed(
   615	                        |oplog| oplog.decode(parsed),
   616	                        origin,
   617	                    )
   618	                }
   619	            }
   620	            EncodeMode::FastSnapshot => {
   621	                if self.can_reset_with_snapshot() {
   622	                    ensure_cov::notify_cov("loro_internal::import::snapshot");
   623	                    loro_common::info!("Init by fast snapshot {}", self.peer_id());
   624	                    decode_snapshot(self, parsed.mode, parsed.body, origin)
   625	                } else {
   626	                    self.import_changes_and_apply_delta_to_state_if_needed(
   627	                        |oplog| encoding::decode_oplog_changes(oplog, parsed),
   628	                        origin,
   629	                    )
   630	
   631	                    // let new_doc = LoroDoc::new();
   632	                    // new_doc.import(bytes)?;
   633	                    // let updates = new_doc.export(ExportMode::updates(&self.oplog_vv())).unwrap();
   634	                    // return self.import_with(updates.as_slice(), origin);
   635	                }

 succeeded in 290ms:
   300	                },
   301	                EventHint::InsertText {
   302	                    event_len: r_event_len,
   303	                    unicode_len: r_len,
   304	                    ..
   305	                },
   306	            ) => {
   307	                *len += *r_len;
   308	                *event_len += *r_event_len;
   309	            }
   310	            (
   311	                EventHint::InsertList { len, pos: _ },
   312	                EventHint::InsertList { len: r_len, pos: _ },
   313	            ) => *len += *r_len,
   314	            (EventHint::DeleteList(l), EventHint::DeleteList(r)) => l.merge(r, &()),
   315	            (
   316	                EventHint::DeleteText { span, unicode_len },
   317	                EventHint::DeleteText {
   318	                    span: r_span,
   319	                    unicode_len: r_len,
   320	                },
   321	            ) => {
   322	                *unicode_len += *r_len;
   323	                span.merge(r_span, &());
   324	            }
   325	            _ => unreachable!(),
   326	        }
   327	    }
   328	
   329	    fn merge_left(&mut self, _: &Self) {
   330	        unreachable!()
   331	    }
   332	}
   333	
   334	impl Transaction {
   335	    #[inline]
   336	    pub fn new(doc: Arc<LoroDocInner>) -> LoroResult<Self> {
   337	        Self::new_with_origin(doc.clone(), "".into())
   338	    }
   339	
   340	    pub fn new_with_origin(doc: Arc<LoroDocInner>, origin: InternalString) -> LoroResult<Self> {
   341	        let oplog_lock = doc.oplog.lock();
   342	        let mut state_lock = doc.state.lock();
   343	        if state_lock.is_in_txn() {
   344	            return Err(LoroError::DuplicatedTransactionError);
   345	        }
   346	
   347	        state_lock.start_txn(origin, crate::event::EventTriggerKind::Local);
   348	        let arena = state_lock.arena.clone();
   349	        let frontiers = state_lock.frontiers.clone();
   350	        let peer = state_lock.peer.load(std::sync::atomic::Ordering::Relaxed);
   351	        let next_counter = oplog_lock.next_id(peer).counter;
   352	        let next_lamport = oplog_lock.dag.frontiers_to_next_lamport(&frontiers);
   353	        let latest_timestamp = oplog_lock.get_greatest_timestamp(&frontiers);
   354	        if let Err(err) =
   355	            oplog_lock.check_change_greater_than_last_peer_id(peer, next_counter, &frontiers)
   356	        {
   357	            state_lock.abort_txn();
   358	            return Err(err);
   359	        }
   360	        drop(state_lock);
   361	        drop(oplog_lock);
   362	        Ok(Self {
   363	            peer,
   364	            doc: Arc::downgrade(&doc),
   365	            arena,
   366	            frontiers,
   367	            timestamp: None,
   368	            next_counter,
   369	            next_lamport,
   370	            origin: Default::default(),
   371	            start_counter: next_counter,
   372	            start_lamport: next_lamport,
   373	            event_hints: Default::default(),
   374	            local_ops: RleVec::new(),
   375	            finished: false,
   376	            on_commit: None,
   377	            msg: None,
   378	            latest_timestamp,
   379	            is_peer_first_appearance: false,
   380	        })
   381	    }
   382	
   383	    pub fn set_origin(&mut self, origin: InternalString) {
   384	        self.origin = origin;
   385	    }
   386	
   387	    pub fn set_timestamp(&mut self, time: Timestamp) {
   388	        self.timestamp = Some(time);
   389	    }
   390	
   391	    pub fn set_msg(&mut self, msg: Option<Arc<str>>) {
   392	        self.msg = msg;
   393	    }
   394	
   395	    pub fn local_ops(&self) -> &RleVec<[Op; 1]> {
   396	        &self.local_ops
   397	    }
   398	
   399	    pub fn peer(&self) -> &PeerID {
   400	        &self.peer
   401	    }
   402	
   403	    pub fn timestamp(&self) -> &Option<Timestamp> {
   404	        &self.timestamp
   405	    }
   406	
   407	    pub fn frontiers(&self) -> &Frontiers {
   408	        &self.frontiers
   409	    }
   410	    pub fn msg(&self) -> &Option<Arc<str>> {
   411	        &self.msg
   412	    }
   413	
   414	    pub fn lamport(&self) -> &Lamport {
   415	        &self.start_lamport
   416	    }
   417	
   418	    pub(crate) fn set_on_commit(&mut self, f: OnCommitFn) {
   419	        self.on_commit = Some(f);
   420	    }
   421	
   422	    pub(crate) fn take_on_commit(&mut self) -> Option<OnCommitFn> {
   423	        self.on_commit.take()
   424	    }
   425	
   426	    pub fn commit(mut self) -> Result<Option<CommitOptions>, LoroError> {
   427	        self._commit()
   428	    }
   429	
   430	    #[tracing::instrument(level = "debug", skip(self))]
   431	    fn _commit(&mut self) -> Result<Option<CommitOptions>, LoroError> {
   432	        if self.finished {
   433	            return Ok(None);
   434	        }
   435	
   436	        let Some(doc) = self.doc.upgrade() else {
   437	            return Ok(None);
   438	        };
   439	        self.finished = true;
   440	        if self.local_ops.is_empty() {
   441	            let mut state = doc.state.lock();
   442	            state.abort_txn();
   443	            return Ok(Some(self.take_options()));
   444	        }
   445	
   446	        let ops = std::mem::take(&mut self.local_ops);
   447	        let deps = take(&mut self.frontiers);
   448	        let change = Change {
   449	            lamport: self.start_lamport,
   450	            ops,
   451	            deps,
   452	            id: ID::new(self.peer, self.start_counter),
   453	            timestamp: self.latest_timestamp.max(
   454	                self.timestamp
   455	                    .unwrap_or_else(|| doc.oplog.lock().get_timestamp_for_next_txn()),
   456	            ),
   457	            commit_msg: take(&mut self.msg),
   458	        };
   459	
   460	        let change_meta = ChangeMeta::from_change(&change);
   461	        {
   462	            // add change to uncommit field of oplog
   463	            let mut oplog = doc.oplog.lock();
   464	            oplog.set_uncommitted_change(change);
   465	        }
   466	
   467	        let modifier = ChangeModifier::default();
   468	        doc.pre_commit_subs.emit(
   469	            &(),
   470	            PreCommitCallbackPayload {

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs | sed -n '470,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 284ms:
   470	            PreCommitCallbackPayload {
   471	                change_meta,
   472	                origin: self.origin.to_string(),
   473	                modifier: modifier.clone(),
   474	            },
   475	        );
   476	
   477	        let mut oplog = doc.oplog.lock();
   478	        let mut state = doc.state.lock();
   479	
   480	        let Some(mut change) = oplog.uncommitted_change.take() else {
   481	            state.abort_txn();
   482	            drop(state);
   483	            drop(oplog);
   484	            return Err(LoroError::internal(
   485	                "missing uncommitted change while committing transaction",
   486	            ));
   487	        };
   488	        modifier.modify_change(&mut change);
   489	        let diff = if state.is_recording() {
   490	            Some(change_to_diff(
   491	                &change,
   492	                doc.clone(),
   493	                std::mem::take(&mut self.event_hints),
   494	            ))
   495	        } else {
   496	            None
   497	        };
   498	
   499	        let last_id = change.id_last();
   500	        if let Err(err) = oplog.import_local_change(change) {
   501	            state.abort_txn();
   502	            drop(state);
   503	            drop(oplog);
   504	            return Err(err);
   505	        }
   506	
   507	        state.commit_txn(
   508	            Frontiers::from_id(last_id),
   509	            diff.map(|arr| InternalDocDiff {
   510	                by: crate::event::EventTriggerKind::Local,
   511	                origin: self.origin.clone(),
   512	                diff: Cow::Owned(
   513	                    arr.into_iter()
   514	                        .map(|x| InternalContainerDiff {
   515	                            idx: x.idx,
   516	                            bring_back: false,
   517	                            diff: (x.diff.into()),
   518	                            diff_mode: crate::diff_calc::DiffMode::Linear,
   519	                        })
   520	                        .collect(),
   521	                ),
   522	                new_version: Cow::Borrowed(oplog.frontiers()),
   523	            }),
   524	        );
   525	        drop(state);
   526	        drop(oplog);
   527	        if let Some(on_commit) = self.on_commit.take() {
   528	            assert!(!doc.txn.is_locked());
   529	            on_commit(&doc.state.clone(), &doc.oplog.clone(), self.id_span());
   530	        }
   531	        Ok(None)
   532	    }
   533	
   534	    fn take_options(&self) -> CommitOptions {
   535	        let mut options = CommitOptions::new();
   536	        if !self.origin.is_empty() {
   537	            options = options.origin(self.origin.as_str());
   538	        }
   539	        if let Some(msg) = self.msg.as_ref() {
   540	            options = options.commit_msg(msg);
   541	        }
   542	        if let Some(timestamp) = self.timestamp {
   543	            options = options.timestamp(timestamp);
   544	        }
   545	        options
   546	    }
   547	
   548	    pub(super) fn apply_local_op(
   549	        &mut self,
   550	        container: ContainerIdx,
   551	        content: RawOpContent,
   552	        event: EventHint,
   553	        // check whether context and txn are referring to the same state context
   554	        doc: &LoroDoc,
   555	    ) -> LoroResult<()> {
   556	        // TODO: need to check if the doc is the same
   557	        let this_doc = self.doc.upgrade().unwrap();
   558	        if Arc::as_ptr(&this_doc.state) != Arc::as_ptr(&doc.state) {
   559	            return Err(LoroError::UnmatchedContext {
   560	                expected: this_doc

exec
/bin/zsh -lc "rg -n \"pub struct LoroDoc|impl LoroDoc|pub fn new\\(|new_auto_commit|start_auto_commit|commit\\(\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | head -120" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '600,670p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '1070,1125p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs | sed -n '85,150p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 297ms:
   600	    /// It will automatically commit when users invoke export or import.
   601	    /// The event will be sent after a transaction is committed
   602	    ///
   603	    /// See also: [`set_next_commit_message`], [`set_next_commit_origin`],
   604	    /// [`set_next_commit_timestamp`]. Commit messages are persisted and replicate to peers;
   605	    /// origins are local-only metadata.
   606	    ///
   607	    /// Empty-commit behavior: this method is an explicit commit. If the pending
   608	    /// transaction is empty, the provided options are swallowed and will not carry over.
   609	    /// For implicit commits triggered by `export`/`checkout` (commit barriers),
   610	    /// message/timestamp/origin from an empty transaction are preserved for the next commit.
   611	    #[inline]
   612	    pub fn commit_with(&self, options: CommitOptions) {
   613	        self.doc.commit_with(options);
   614	    }
   615	
   616	    /// Set commit message for the current uncommitted changes
   617	    ///
   618	    /// It will be persisted.
   619	    pub fn set_next_commit_message(&self, msg: &str) {
   620	        self.doc.set_next_commit_message(msg)
   621	    }
   622	
   623	    /// Set `origin` for the current uncommitted changes, it can be used to track the source of changes in an event.
   624	    ///
   625	    /// It will NOT be persisted.
   626	    pub fn set_next_commit_origin(&self, origin: &str) {
   627	        self.doc.set_next_commit_origin(origin)
   628	    }
   629	
   630	    /// Set the timestamp of the next commit.
   631	    ///
   632	    /// It will be persisted and stored in the `OpLog`.
   633	    /// You can get the timestamp from the [`Change`] type.
   634	    pub fn set_next_commit_timestamp(&self, timestamp: Timestamp) {
   635	        self.doc.set_next_commit_timestamp(timestamp)
   636	    }
   637	
   638	    /// Set the options of the next commit.
   639	    ///
   640	    /// It will be used when the next commit is performed.
   641	    ///
   642	    /// # Example
   643	    /// ```
   644	    /// use loro::{LoroDoc, CommitOptions};
   645	    /// let doc = LoroDoc::new();
   646	    /// doc.set_next_commit_options(CommitOptions::new().origin("ui").commit_msg("tagged"));
   647	    /// doc.get_text("t").insert(0, "x").unwrap();
   648	    /// doc.commit();
   649	    /// ```
   650	    pub fn set_next_commit_options(&self, options: CommitOptions) {
   651	        self.doc.set_next_commit_options(options);
   652	    }
   653	
   654	    /// Clear the options of the next commit.
   655	    pub fn clear_next_commit_options(&self) {
   656	        self.doc.clear_next_commit_options();
   657	    }
   658	
   659	    /// Whether the document is in detached mode, where the [loro_internal::DocState] is not
   660	    /// synchronized with the latest version of the [loro_internal::OpLog].
   661	    #[inline]
   662	    pub fn is_detached(&self) -> bool {
   663	        self.doc.is_detached()
   664	    }
   665	
   666	    /// Create a new `LoroDoc` from a snapshot.
   667	    ///
   668	    /// The snapshot is created via [`LoroDoc::export`] with [`ExportMode::Snapshot`].
   669	    ///
   670	    /// # Example

 succeeded in 306ms:
101:pub struct LoroDoc {
125:impl LoroDoc {
137:    pub fn new() -> Self {
139:        doc.start_auto_commit();
161:        new_doc.start_auto_commit();
226:    /// doc.commit();
252:    /// doc.commit();
580:    /// - `doc.commit()` is called.
593:    pub fn commit(&self) {
648:    /// doc.commit();
684:        inner.start_auto_commit();
732:    /// a.commit();
804:    /// doc.commit();
806:    /// let _sub = doc.subscribe_pre_commit(Box::new(move |e| {
819:    /// doc.commit();
996:    /// - `doc.commit()` is called.
1029:    /// doc.commit();
1051:    /// - `doc.commit()` is called.
1097:    /// doc.commit();
1375:    /// after calling `doc.commit()`, `doc.export(mode)` or `doc.checkout(version)`.
1428:    /// doc.commit();
1456:    /// doc.commit();
1569:    /// doc.commit();
1574:    /// doc.commit();
1593:    /// Pitfall: `commit()` can be triggered implicitly by `import`, `export`, and `checkout`.
1621:    /// let sub = doc.subscribe_pre_commit(Box::new(move |payload| {
1632:    /// doc.commit();
1634:    pub fn subscribe_pre_commit(&self, callback: PreCommitCallback) -> Subscription {
1635:        self.doc.subscribe_pre_commit(callback)
1784:            doc.start_auto_commit();
1795:    pub fn new() -> Self {
2057:            doc.start_auto_commit();
2068:    pub fn new() -> Self {
2260:            doc.start_auto_commit();
2271:    pub fn new() -> Self {
2771:            doc.start_auto_commit();
2797:    pub fn new() -> Self {
3185:            doc.start_auto_commit();
3196:    pub fn new() -> LoroMovableList {
3483:            doc.start_auto_commit();
3625:    pub fn new(kind: ContainerType) -> Self {
3719:    pub fn new(doc: &LoroDoc) -> Self {

 succeeded in 293ms:
    85	                    let bytes = { export_fast_updates_in_range(&oplog.lock(), &[id_span]) };
    86	                    local_update_subs.emit(&(), bytes);
    87	                }
    88	            }
    89	        }));
    90	
    91	        Ok(txn)
    92	    }
    93	
    94	    pub fn start_auto_commit(&self) {
    95	        self.auto_commit
    96	            .store(true, std::sync::atomic::Ordering::Release);
    97	        let mut self_txn = self.txn.lock();
    98	        if self_txn.is_some() || !self.can_edit() {
    99	            return;
   100	        }
   101	
   102	        let txn = self
   103	            .txn()
   104	            .expect("auto-commit should be able to create a transaction");
   105	        self_txn.replace(txn);
   106	    }
   107	
   108	    #[inline]
   109	    pub fn renew_txn_if_auto_commit(&self, options: Option<CommitOptions>) {
   110	        if self.auto_commit.load(std::sync::atomic::Ordering::Acquire) && self.can_edit() {
   111	            let mut self_txn = self.txn.lock();
   112	            if self_txn.is_some() {
   113	                return;
   114	            }
   115	
   116	            let mut txn = self
   117	                .txn()
   118	                .expect("auto-commit should be able to renew a transaction");
   119	            if let Some(options) = options {
   120	                txn.set_options(options);
   121	            }
   122	            self_txn.replace(txn);
   123	        }
   124	    }
   125	
   126	    #[inline]
   127	    pub(crate) fn _renew_txn_if_auto_commit_with_guard(
   128	        &self,
   129	        options: Option<CommitOptions>,
   130	        mut guard: LoroMutexGuard<Option<Transaction>>,
   131	    ) {
   132	        if self.auto_commit.load(std::sync::atomic::Ordering::Acquire) && self.can_edit() {
   133	            if guard.is_some() {
   134	                return;
   135	            }
   136	
   137	            let mut txn = self
   138	                .txn()
   139	                .expect("auto-commit should be able to renew a transaction");
   140	            if let Some(options) = options {
   141	                txn.set_options(options);
   142	            }
   143	            guard.replace(txn);
   144	        }
   145	    }
   146	}
   147	
   148	pub(crate) type OnCommitFn =
   149	    Box<dyn FnOnce(&Arc<LoroMutex<DocState>>, &Arc<LoroMutex<OpLog>>, IdSpan) + Sync + Send>;
   150	

 succeeded in 297ms:
  1070	    /// subscriptions in Rust.
  1071	    ///
  1072	    /// # Parameters
  1073	    /// - `callback`: Function that receives `&Vec<u8>` (encoded updates) and returns `bool`
  1074	    ///   - Return `true` to keep the subscription active
  1075	    ///   - Return `false` to automatically unsubscribe
  1076	    ///
  1077	    /// # Example
  1078	    /// ```rust
  1079	    /// use loro::LoroDoc;
  1080	    /// use std::sync::{Arc, Mutex};
  1081	    ///
  1082	    /// let doc = LoroDoc::new();
  1083	    /// let updates = Arc::new(Mutex::new(Vec::new()));
  1084	    /// let updates_clone = updates.clone();
  1085	    /// let count = Arc::new(Mutex::new(0));
  1086	    /// let count_clone = count.clone();
  1087	    ///
  1088	    /// // Subscribe and collect first 3 updates, then auto-unsubscribe
  1089	    /// let sub = doc.subscribe_local_update(Box::new(move |bytes| {
  1090	    ///     updates_clone.lock().unwrap().push(bytes.clone());
  1091	    ///     let mut c = count_clone.lock().unwrap();
  1092	    ///     *c += 1;
  1093	    ///     *c < 3  // Auto-unsubscribe after 3 updates
  1094	    /// }));
  1095	    ///
  1096	    /// doc.get_text("text").insert(0, "hello").unwrap();
  1097	    /// doc.commit();
  1098	    /// ```
  1099	    pub fn subscribe_local_update(&self, callback: LocalUpdateCallback) -> Subscription {
  1100	        self.doc.subscribe_local_update(callback)
  1101	    }
  1102	
  1103	    /// Subscribe to peer ID changes in the document.
  1104	    ///
  1105	    /// The callback is triggered whenever the document's peer ID is modified.
  1106	    /// This is useful for tracking identity changes and updating related state accordingly.
  1107	    ///
  1108	    /// **Auto-unsubscription**: If the callback returns `false`, the subscription will be
  1109	    /// automatically removed, providing a convenient way to implement one-time or conditional
  1110	    /// subscriptions in Rust.
  1111	    ///
  1112	    /// # Parameters
  1113	    /// - `callback`: Function that receives `&ID` (the new peer ID) and returns `bool`
  1114	    ///   - Return `true` to keep the subscription active
  1115	    ///   - Return `false` to automatically unsubscribe
  1116	    ///
  1117	    /// # Example
  1118	    /// ```rust
  1119	    /// use loro::LoroDoc;
  1120	    /// use std::sync::{Arc, Mutex};
  1121	    ///
  1122	    /// let doc = LoroDoc::new();
  1123	    /// let peer_changes = Arc::new(Mutex::new(Vec::new()));
  1124	    /// let changes_clone = peer_changes.clone();
  1125	    ///

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '120,170p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 280ms:
   120	        let doc = self.doc.clone();
   121	        LoroDoc::_new(doc)
   122	    }
   123	}
   124	
   125	impl LoroDoc {
   126	    #[inline(always)]
   127	    fn _new(doc: InnerLoroDoc) -> Self {
   128	        Self {
   129	            doc,
   130	            #[cfg(debug_assertions)]
   131	            _temp: 0,
   132	        }
   133	    }
   134	
   135	    /// Create a new `LoroDoc` instance.
   136	    #[inline]
   137	    pub fn new() -> Self {
   138	        let doc = InnerLoroDoc::default();
   139	        doc.start_auto_commit();
   140	
   141	        LoroDoc::_new(doc)
   142	    }
   143	
   144	    /// Duplicate the document with a different PeerID
   145	    ///
   146	    /// The time complexity and space complexity of this operation are both O(n),
   147	    ///
   148	    /// When called in detached mode, it will fork at the current state frontiers.
   149	    /// It will have the same effect as `fork_at(&self.state_frontiers())`.
   150	    #[inline]
   151	    pub fn fork(&self) -> Self {
   152	        let doc = self.doc.fork();
   153	        LoroDoc::_new(doc)
   154	    }
   155	
   156	    /// Fork the document at the given frontiers.
   157	    ///
   158	    /// The created doc will only contain the history before the specified frontiers.
   159	    pub fn fork_at(&self, frontiers: &Frontiers) -> LoroResult<LoroDoc> {
   160	        let new_doc = self.doc.fork_at(frontiers)?;
   161	        new_doc.start_auto_commit();
   162	        Ok(LoroDoc::_new(new_doc))
   163	    }
   164	
   165	    /// Get the configurations of the document.
   166	    #[inline]
   167	    pub fn config(&self) -> &Configure {
   168	        self.doc.config()
   169	    }
   170	

exec
/bin/zsh -lc "rg -n \"fn decode_snapshot|decode_snapshot\\(\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs | sed -n '360,510p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '635,735p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/snapshot.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 310ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/richtext_state.rs:1264:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/counter_state.rs:104:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:113:    fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:178:    fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:1388:    pub(crate) fn check_before_decode_snapshot(&self) -> LoroResult<()> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:486:                decode_snapshot(&doc, mode, body, Default::default())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:612:                    decode_snapshot(self, parsed.mode, parsed.body, origin)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:624:                    decode_snapshot(self, parsed.mode, parsed.body, origin)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/unknown_state.rs:90:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/map_state.rs:305:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:454:pub(crate) fn decode_snapshot(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:465:            fast_snapshot::decode_snapshot(doc, body.to_vec().into(), origin)?
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/list_state.rs:635:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/tree_state.rs:1693:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1545:        fn decode_snapshot_fast(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:244:    pub(crate) fn decode_snapshot_for_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:125:pub(crate) fn decode_snapshot(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:134:pub(crate) fn decode_snapshot_inner(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:156:    state.check_before_decode_snapshot()?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:390:pub(crate) fn decode_snapshot_blob_meta(

 succeeded in 297ms:
   360	            Self {
   361	                store: ContainerStore::new(arena.clone(), config.clone(), peer.clone()),
   362	                peer,
   363	                arena,
   364	                frontiers: Frontiers::default(),
   365	                doc,
   366	                config,
   367	                in_txn: false,
   368	                changed_idx_in_txn: FxHashSet::default(),
   369	                event_recorder: Default::default(),
   370	                dead_containers_cache: Default::default(),
   371	            },
   372	            crate::lock::LockKind::DocState,
   373	        ))
   374	    }
   375	
   376	    pub fn fork_with_new_peer_id(
   377	        &mut self,
   378	        doc: Weak<LoroDocInner>,
   379	        arena: SharedArena,
   380	        config: Configure,
   381	    ) -> Arc<Mutex<Self>> {
   382	        let peer = Arc::new(AtomicU64::new(DefaultRandom.next_u64()));
   383	        let store = self.store.fork(arena.clone(), peer.clone(), config.clone());
   384	        Arc::new(Mutex::new(Self {
   385	            peer,
   386	            frontiers: self.frontiers.clone(),
   387	            store,
   388	            arena,
   389	            config,
   390	            doc,
   391	            in_txn: false,
   392	            changed_idx_in_txn: FxHashSet::default(),
   393	            event_recorder: Default::default(),
   394	            dead_containers_cache: Default::default(),
   395	        }))
   396	    }
   397	
   398	    pub fn start_recording(&mut self) {
   399	        if self.is_recording() {
   400	            return;
   401	        }
   402	
   403	        self.event_recorder.recording_diff = true;
   404	        self.event_recorder.diff_start_version = Some(self.frontiers.clone());
   405	    }
   406	
   407	    #[inline(always)]
   408	    pub fn stop_and_clear_recording(&mut self) {
   409	        self.event_recorder = Default::default();
   410	    }
   411	
   412	    #[inline(always)]
   413	    pub fn is_recording(&self) -> bool {
   414	        self.event_recorder.recording_diff
   415	    }
   416	
   417	    pub fn refresh_peer_id(&mut self) {
   418	        self.peer.store(
   419	            DefaultRandom.next_u64(),
   420	            std::sync::atomic::Ordering::Relaxed,
   421	        );
   422	    }
   423	
   424	    /// Take all the diffs that are recorded and convert them to events.
   425	    pub fn take_events(&mut self) -> Vec<DocDiff> {
   426	        if !self.is_recording() {
   427	            return vec![];
   428	        }
   429	
   430	        self.convert_current_batch_diff_into_event();
   431	        std::mem::take(&mut self.event_recorder.events)
   432	    }
   433	
   434	    /// Record the next diff.
   435	    /// Caller should call [pre_txn] before calling this.
   436	    ///
   437	    /// # Panic
   438	    ///
   439	    /// Panic when the diff cannot be merged with the previous diff.
   440	    /// Caller should call [pre_txn] before calling this to avoid panic.
   441	    fn record_diff(&mut self, diff: InternalDocDiff) {
   442	        if !self.event_recorder.recording_diff || diff.diff.is_empty() {
   443	            return;
   444	        }
   445	
   446	        let Some(last_diff) = self.event_recorder.diffs.last_mut() else {
   447	            self.event_recorder.diffs.push(diff.into_owned());
   448	            return;
   449	        };
   450	
   451	        if last_diff.can_merge(&diff) {
   452	            self.event_recorder.diffs.push(diff.into_owned());
   453	            return;
   454	        }
   455	
   456	        panic!("should call pre_txn before record_diff")
   457	    }
   458	
   459	    /// This should be called when DocState is going to apply a transaction / a diff.
   460	    fn pre_txn(&mut self, next_origin: InternalString, next_trigger: EventTriggerKind) {
   461	        if !self.is_recording() {
   462	            return;
   463	        }
   464	
   465	        let Some(last_diff) = self.event_recorder.diffs.last() else {
   466	            return;
   467	        };
   468	
   469	        if last_diff.origin == next_origin && last_diff.by == next_trigger {
   470	            return;
   471	        }
   472	
   473	        // current diff batch cannot merge with the incoming diff,
   474	        // need to convert all the current diffs into event
   475	        self.convert_current_batch_diff_into_event()
   476	    }
   477	
   478	    fn convert_current_batch_diff_into_event(&mut self) {
   479	        let recorder = &mut self.event_recorder;
   480	        if recorder.diffs.is_empty() {
   481	            return;
   482	        }
   483	
   484	        let diffs = std::mem::take(&mut recorder.diffs);
   485	        let start = recorder.diff_start_version.take().unwrap();
   486	        recorder.diff_start_version = Some((*diffs.last().unwrap().new_version).to_owned());
   487	        let event = self.diffs_to_event(diffs, start);
   488	        self.event_recorder.events.push(event);
   489	    }
   490	
   491	    /// Change the peer id of this doc state.
   492	    /// It changes the peer id for the future txn on this AppState
   493	    #[inline]
   494	    pub fn set_peer_id(&mut self, peer: PeerID) {
   495	        self.peer.store(peer, std::sync::atomic::Ordering::Relaxed);
   496	    }
   497	
   498	    pub fn peer_id(&self) -> PeerID {
   499	        self.peer.load(std::sync::atomic::Ordering::Relaxed)
   500	    }
   501	
   502	    /// It's expected that diff only contains [`InternalDiff`]
   503	    ///
   504	    /// Returns `Err` if any container state rejects its diff as malformed
   505	    /// (see `ContainerState::validate_diff`). Validation runs before mutating
   506	    /// any container state, so a returned error leaves the doc-state view at
   507	    /// the previous version.
   508	    #[instrument(skip_all)]
   509	    pub(crate) fn apply_diff(
   510	        &mut self,

 succeeded in 295ms:
   635	                }
   636	            }
   637	            EncodeMode::FastUpdates => self.import_changes_and_apply_delta_to_state_if_needed(
   638	                |oplog| encoding::decode_oplog_changes(oplog, parsed),
   639	                origin,
   640	            ),
   641	            EncodeMode::Auto => {
   642	                unreachable!()
   643	            }
   644	        };
   645	
   646	        self.emit_events();
   647	
   648	        result
   649	    }
   650	
   651	    #[tracing::instrument(skip_all)]
   652	    pub(crate) fn update_oplog_and_apply_delta_to_state_if_needed(
   653	        &self,
   654	        f: impl FnOnce(&mut OpLog) -> Result<ImportStatus, LoroError>,
   655	        origin: InternalString,
   656	    ) -> Result<ImportStatus, LoroError> {
   657	        let mut oplog = self.oplog.lock();
   658	        oplog.begin_import_rollback();
   659	        if !self.is_detached() {
   660	            let old_vv = oplog.vv().clone();
   661	            let old_frontiers = oplog.frontiers().clone();
   662	            let result = f(&mut oplog);
   663	            if &old_vv != oplog.vv() {
   664	                let mut diff = DiffCalculator::new(false);
   665	                let (diff, diff_mode) = diff.calc_diff_internal(
   666	                    &oplog,
   667	                    &old_vv,
   668	                    &old_frontiers,
   669	                    oplog.vv(),
   670	                    oplog.dag.get_frontiers(),
   671	                    None,
   672	                );
   673	                let mut state = self.state.lock();
   674	                if let Err(e) = state.apply_diff(
   675	                    InternalDocDiff {
   676	                        origin,
   677	                        diff: (diff).into(),
   678	                        by: EventTriggerKind::Import,
   679	                        new_version: Cow::Owned(oplog.frontiers().clone()),
   680	                    },
   681	                    diff_mode,
   682	                ) {
   683	                    oplog.rollback_import();
   684	                    return Err(e);
   685	                }
   686	            }
   687	            match result {
   688	                Ok(result) => {
   689	                    oplog.commit_import_rollback();
   690	                    Ok(result)
   691	                }
   692	                Err(e) => {
   693	                    // Some import errors are reported after a valid prefix has
   694	                    // been inserted into the oplog. Keep that prefix if it was
   695	                    // also applied to state; rollback is for failed state apply
   696	                    // or decode errors that made no visible oplog progress.
   697	                    if &old_vv == oplog.vv() {
   698	                        oplog.rollback_import();
   699	                    } else {
   700	                        oplog.commit_import_rollback();
   701	                    }
   702	                    Err(e)
   703	                }
   704	            }
   705	        } else {
   706	            match f(&mut oplog) {
   707	                Ok(result) => {
   708	                    oplog.commit_import_rollback();
   709	                    Ok(result)
   710	                }
   711	                Err(e) => {
   712	                    oplog.rollback_import();
   713	                    Err(e)
   714	                }
   715	            }
   716	        }
   717	    }
   718	
   719	    #[tracing::instrument(skip_all)]
   720	    pub(crate) fn import_changes_and_apply_delta_to_state_if_needed(
   721	        &self,
   722	        decode_changes: impl FnOnce(&mut OpLog) -> Result<Vec<Change>, LoroError>,
   723	        origin: InternalString,
   724	    ) -> Result<ImportStatus, LoroError> {
   725	        let mut oplog = self.oplog.lock();
   726	        let arena_checkpoint = oplog.arena.checkpoint_for_rollback();
   727	        let changes = match decode_changes(&mut oplog) {
   728	            Ok(changes) => changes,
   729	            Err(e) => {
   730	                oplog.arena.rollback(arena_checkpoint);
   731	                return Err(e);
   732	            }
   733	        };
   734	
   735	        let preflight = oplog.preflight_import_changes(&changes);

 succeeded in 297ms:
nl: /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/snapshot.rs: No such file or directory

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs | sed -n '440,475p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs | sed -n '120,190p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs | sed -n '1378,1405p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs | sed -n '190,280p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 297ms:
   440	    let checksum = [0; 16];
   441	    ans.extend(checksum);
   442	    ans.extend(mode.to_bytes());
   443	
   444	    // BODY
   445	    f(&mut ans)?;
   446	
   447	    // CHECKSUM in HEADER
   448	    let checksum_body = &ans[20..];
   449	    let checksum = xxhash_rust::xxh32::xxh32(checksum_body, XXH_SEED);
   450	    ans[16..20].copy_from_slice(&checksum.to_le_bytes());
   451	    Ok(ans)
   452	}
   453	
   454	pub(crate) fn decode_snapshot(
   455	    doc: &LoroDoc,
   456	    mode: EncodeMode,
   457	    body: &[u8],
   458	    origin: InternalString,
   459	) -> Result<ImportStatus, LoroError> {
   460	    match mode {
   461	        EncodeMode::OutdatedSnapshot => {
   462	            return Err(LoroError::ImportUnsupportedEncodingMode);
   463	        }
   464	        EncodeMode::FastSnapshot => {
   465	            fast_snapshot::decode_snapshot(doc, body.to_vec().into(), origin)?
   466	        }
   467	        _ => {
   468	            return Err(LoroError::DecodeError(
   469	                format!("Invalid snapshot encoding mode: {mode:?}").into_boxed_str(),
   470	            ));
   471	        }
   472	    };
   473	    Ok(ImportStatus {
   474	        success: VersionRange::from_vv(&doc.oplog_vv()),
   475	        pending: None,

 succeeded in 290ms:
   120	        )
   121	    })?;
   122	    Ok(u32::from_le_bytes(buf))
   123	}
   124	
   125	pub(crate) fn decode_snapshot(
   126	    doc: &LoroDoc,
   127	    bytes: Bytes,
   128	    origin: InternalString,
   129	) -> LoroResult<()> {
   130	    let snapshot = _decode_snapshot_bytes(bytes)?;
   131	    decode_snapshot_inner(snapshot, doc, origin)
   132	}
   133	
   134	pub(crate) fn decode_snapshot_inner(
   135	    snapshot: Snapshot,
   136	    doc: &LoroDoc,
   137	    origin: InternalString,
   138	) -> Result<(), LoroError> {
   139	    let Snapshot {
   140	        oplog_bytes,
   141	        state_bytes,
   142	        shallow_root_state_bytes,
   143	    } = snapshot;
   144	    ensure_cov::notify_cov("loro_internal::import::fast_snapshot::decode_snapshot");
   145	    let mut oplog = doc.oplog().lock();
   146	    if !oplog.is_empty() {
   147	        return Err(LoroError::DecodeError(
   148	            "decode_snapshot: cannot import snapshot into a non-empty doc"
   149	                .to_string()
   150	                .into_boxed_str(),
   151	        ));
   152	    }
   153	
   154	    let mut state = doc.app_state().lock();
   155	
   156	    state.check_before_decode_snapshot()?;
   157	
   158	    if !state.frontiers.is_empty() {
   159	        return Err(LoroError::DecodeError(
   160	            "decode_snapshot: app state frontiers must be empty before import"
   161	                .to_string()
   162	                .into_boxed_str(),
   163	        ));
   164	    }
   165	
   166	    if !oplog.frontiers().is_empty() {
   167	        return Err(LoroError::DecodeError(
   168	            "decode_snapshot: oplog frontiers must be empty before import"
   169	                .to_string()
   170	                .into_boxed_str(),
   171	        ));
   172	    }
   173	    let need_calc = state_bytes.is_none();
   174	
   175	    let arena_checkpoint = oplog.arena.checkpoint_for_rollback();
   176	    let decode_result = (|| -> LoroResult<()> {
   177	        oplog.decode_change_store(oplog_bytes)?;
   178	        let state_frontiers;
   179	        if shallow_root_state_bytes.is_empty() {
   180	            ensure_cov::notify_cov("loro_internal::import::snapshot::normal");
   181	            if let Some(bytes) = state_bytes {
   182	                state.store.decode(bytes)?;
   183	            }
   184	            state_frontiers = oplog.frontiers().clone();
   185	        } else {
   186	            ensure_cov::notify_cov("loro_internal::import::snapshot::gc");
   187	            let shallow_root_state_frontiers = state.store.decode_gc(
   188	                shallow_root_state_bytes.clone(),
   189	                oplog.dag().shallow_since_frontiers().clone(),
   190	                doc.config.clone(),

 succeeded in 284ms:
  1378	                ans.push((id, Index::Key(prop.0)));
  1379	                break;
  1380	            }
  1381	        }
  1382	
  1383	        ans.reverse();
  1384	
  1385	        Some(ans)
  1386	    }
  1387	
  1388	    pub(crate) fn check_before_decode_snapshot(&self) -> LoroResult<()> {
  1389	        if self.is_in_txn() {
  1390	            return Err(LoroError::DecodeError(
  1391	                "State is in txn".to_string().into_boxed_str(),
  1392	            ));
  1393	        }
  1394	
  1395	        if !self.can_import_snapshot() {
  1396	            return Err(LoroError::DecodeError(
  1397	                "State is not empty, cannot import snapshot directly"
  1398	                    .to_string()
  1399	                    .into_boxed_str(),
  1400	            ));
  1401	        }
  1402	
  1403	        Ok(())
  1404	    }
  1405	

 succeeded in 284ms:
   190	                doc.config.clone(),
   191	            )?;
   192	            state.store.decode_state_by_two_bytes(
   193	                shallow_root_state_bytes,
   194	                state_bytes.unwrap_or_default(),
   195	            )?;
   196	
   197	            let shallow_root_store = state.shallow_root_store().cloned();
   198	            oplog.with_history_cache(|h| {
   199	                h.set_shallow_root_store(shallow_root_store);
   200	            });
   201	
   202	            if need_calc {
   203	                ensure_cov::notify_cov("shallow_snapshot::need_calc");
   204	                state_frontiers = shallow_root_state_frontiers.ok_or_else(|| {
   205	                    LoroError::DecodeError(
   206	                        "decode_snapshot: shallow root frontiers are missing"
   207	                            .to_string()
   208	                            .into_boxed_str(),
   209	                    )
   210	                })?;
   211	            } else {
   212	                ensure_cov::notify_cov("shallow_snapshot::dont_need_calc");
   213	                state_frontiers = oplog.frontiers().clone();
   214	            }
   215	        }
   216	
   217	        // FIXME: we may need to extract the unknown containers here?
   218	        // Or we should lazy load it when the time comes?
   219	
   220	        state.init_with_states_and_version(state_frontiers, &oplog, vec![], false, origin)?;
   221	        Ok(())
   222	    })();
   223	
   224	    if let Err(e) = decode_result {
   225	        state.reset_to_empty_for_failed_snapshot_import();
   226	        oplog.reset_to_empty_for_failed_snapshot_import(arena_checkpoint);
   227	        return Err(e);
   228	    }
   229	    drop(state);
   230	    drop(oplog);
   231	    if need_calc {
   232	        doc.set_detached(true);
   233	        if let Err(e) = doc._checkout_to_latest_without_commit(false) {
   234	            doc.set_detached(false);
   235	            doc.app_state()
   236	                .lock()
   237	                .reset_to_empty_for_failed_snapshot_import();
   238	            doc.oplog()
   239	                .lock()
   240	                .reset_to_empty_for_failed_snapshot_import(arena_checkpoint);
   241	            return Err(e);
   242	        }
   243	        debug_assert_eq!(doc.state_frontiers(), doc.oplog_frontiers());
   244	    }
   245	
   246	    Ok(())
   247	}
   248	
   249	impl OpLog {
   250	    pub(super) fn decode_change_store(&mut self, bytes: bytes::Bytes) -> LoroResult<()> {
   251	        let v = self.change_store().import_all(bytes)?;
   252	        self.dag.set_version_by_fast_snapshot_import(v);
   253	        self.refresh_visible_op_count();
   254	        Ok(())
   255	    }
   256	}
   257	
   258	pub(crate) fn encode_snapshot<W: std::io::Write>(doc: &LoroDoc, w: &mut W) {
   259	    let snapshot = encode_snapshot_inner(doc);
   260	    _encode_snapshot(snapshot, w);
   261	}
   262	
   263	pub(crate) fn encode_snapshot_inner(doc: &LoroDoc) -> Snapshot {
   264	    assert!(doc.drop_pending_events().is_empty());
   265	    let old_state_frontiers = doc.state_frontiers();
   266	    let was_detached = doc.is_detached();
   267	    let oplog = doc.oplog().lock();
   268	    let mut state = doc.app_state().lock();
   269	    let is_gc = state.store.shallow_root_store().is_some();
   270	    if is_gc {
   271	        // TODO: PERF: this can be optimized by reusing the bytes of gc store
   272	        let f = oplog.shallow_since_frontiers().clone();
   273	        drop(state);
   274	        drop(oplog);
   275	        let (snapshot, _) = shallow_snapshot::export_shallow_snapshot_inner(doc, &f).unwrap();
   276	        return snapshot;
   277	    }
   278	
   279	    assert!(!state.is_in_txn());
   280	    let oplog_bytes = oplog.encode_change_store();

exec
/bin/zsh -lc "rg -n \"0\\.1\\.0|0\\.2\\.0|stability|breaking|semver|pre-0\\.2|API\" crates/ql-collab docs crates -g '*.md' -g '*.rs' -g 'Cargo.toml'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"CollabSession::new\\(\" . -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "rg -n \"pub type PeerID|type PeerID\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-common-*/src /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "sed -n '1,120p' crates/ql-collab/Cargo.toml && rg -n \"ql-collab|CollabSession\" crates docs -g 'Cargo.toml' -g '*.rs' -g '*.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 276ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-common-1.12.0/src/lib.rs:28:pub type PeerID = u64;

 succeeded in 278ms:
./crates/ql-collab/src/session.rs:20://! - `CollabSession::new(peer_id)` — fresh session with an empty
./crates/ql-collab/src/session.rs:182:        let s = CollabSession::new(PeerId::new(1)).unwrap();
./crates/ql-collab/src/session.rs:190:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
./crates/ql-collab/src/session.rs:203:        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
./crates/ql-collab/src/session.rs:221:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
./crates/ql-collab/src/session.rs:246:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
./crates/ql-collab/src/session.rs:260:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
./crates/ql-collab/src/session.rs:272:        let origin = CollabSession::new(PeerId::new(11)).unwrap();
./docs/audits/2026-05-19-handoff-audit-codex.md:1257:    20	//! - `CollabSession::new(peer_id)` — fresh session with an empty
./docs/audits/2026-05-19-handoff-audit-codex.md:1409:   172	        let s = CollabSession::new(PeerId::new(1));
./docs/audits/2026-05-19-handoff-audit-codex.md:1417:   180	        let mut s = CollabSession::new(PeerId::new(1));
./docs/audits/2026-05-19-handoff-audit-codex.md:1430:   193	        let mut origin = CollabSession::new(PeerId::new(1));
./docs/audits/2026-05-19-handoff-audit-codex.md:1448:   211	        let mut base = CollabSession::new(PeerId::new(0));
./docs/audits/2026-05-19-handoff-audit-codex.md:1473:   236	        let mut s = CollabSession::new(PeerId::new(42));

 succeeded in 297ms:
crates/ql-bindings-node/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-collab/src/lib.rs:26://! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
docs/process/audit-protocol.md:130:When facing a design with multiple valid approaches, breaking changes, or architecture impact (e.g. W5-49's graph storage choice), follow this pattern:
docs/process/audit-protocol.md:267:Both APIs always bump `Graph::revision()` even when called on a node with no outgoing edges / no range deps. State-idempotent, revision-not-idempotent. Affects only callers using revision as a cheapness proxy — none today, but Phase 4.7 array formulas may add one.
docs/process/audit-protocol.md:312:The split fixes Codex HIGH H1 (bounded ranges silently shrunk under clamp, breaking trailing-blank semantics in lookups). Any future change to `read_range_with_shape` must preserve this branch.
crates/ql-io-ods/src/lib.rs:10://! be a breaking change for any consumer pinning the workspace shape.
docs/MASTER-PLAN.md:30:| Engine 2A.3 (op log) ✅ | Product Phase 0 deliverable (`ql-oplog` scaffolding) advanced into producer wiring + persistence | Loro op log scaffolding called for in canonical Phase 0; we shipped it now because the API surface was ready. |
docs/MASTER-PLAN.md:40:- **Canonical Phase 1 (Renderer spike, WebGL grid)** — entirely TypeScript work in `Charts/packages/sheets-{protocol,client,renderer}`. Engine provides the API surface; renderer is its own project. No engine-side phase covers it.
docs/MASTER-PLAN.md:42:- **Canonical Phase 6 (Quantlab IDE integration)** — the engine's job is to provide a usable API; the actual `extensions/quantlab/` work is a parallel TypeScript track. Engine 2B includes the first vertical slice as a forcing function.
docs/MASTER-PLAN.md:62:- T1-D06: stock VS Code APIs for v1.
docs/MASTER-PLAN.md:101:| `ql-service` | engine-as-service API, transport, auth boundary hooks |
docs/MASTER-PLAN.md:176:   Exercise `extensions/quantlab/` against the engine path: edit a formula in a Monaco-powered formula bar, get diagnostics, commit/cancel, paste a small block, save `.qbook`, reload, and verify `oplog.bin`. Use stock VS Code APIs.  
docs/MASTER-PLAN.md:177:   References: `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `.references/formualizer/bindings/wasm/src/index.ts` for binding-shape ideas; VS Code API docs already vendored in the host repo.  
docs/MASTER-PLAN.md:178:   Acceptance: IDE-2B-01 formula edit calls engine and displays value; IDE-2B-02 lex/parse/bind errors display without falling back; IDE-2B-03 cancel leaves workbook unchanged; IDE-2B-04 paste uses transaction API; IDE-2B-05 saved workbook reloads with same visible state and op log length.  
docs/MASTER-PLAN.md:231:   Decide where graph state lives: likely inside `WorkbookRuntime` session state with persistable rebuild from workbook formulas, not inside `Workbook` storage alone. Define rebuild, mutation, and snapshot APIs.  
docs/MASTER-PLAN.md:233:   Acceptance: G3-01 ✅ graph rebuilds deterministically (`rebuild_is_deterministic_across_runs`); G3-02 ✅ 5-hook mutation API (`on_set_value`, `on_set_formula`, `on_clear_formula`, `on_set_name`, `on_add_sheet`); G3-03 ✅ no petgraph hot-path dep — Phase 0 W3-1 hand-rolled `Graph` per Round 7 T1-D02 lock.  
docs/MASTER-PLAN.md:276:   - `Sheet::{put_computed, clear_computed, clear_user}` mirror the column API.  
docs/MASTER-PLAN.md:389:- ~~Phase 4.3 V2 is gated on GAP-G-01 (Option A) + GAP-G-03 (small Option C).~~ **Gate cleared W5-50.** Phase 4.7 (array formulas) consumes Option A's revocation API as well.
docs/MASTER-PLAN.md:495:   **Status (2026-05-15): SHIPPED triple-confirmed at `6523001b837` (W5-152).** All 15 sub-phases shipped (AA design + A types + B.1-.4 lexer + C parser+binder + D printer + F locale-printer + G `@`-parser-printer + H `@`-binder + I persistence v6→v7 + J op-log + K runtime+canonical + L round-trip + M coverage matrix + N polish + O closing megaudit). Acceptance closures: LOC-4-01 R1C1 round-trips pinned at lex/parse/bind/print stages; LOC-4-02 EN/DE/FR separators pinned by 30-cell coverage matrix; LOC-4-03 `@` operator + design § 3.3 9-rule narrowing implemented at bind time; LOC-4-04 `WorkbookRuntime::set_reference_mode` + `set_locale` APIs available. Closing megaudit (three-way: self-review + Sonnet + Codex async) found 1 HIGH (PlanCache × `@<range>` cell collision — fixed W5-150) + 2 MEDIUM (W5-151) + 3 LOW (W5-152). +175 net tests (2443 → 2618). Function-name localization remained OUT-of-scope per LOC-4-02 (separators only). Known gaps documented: rule 7 (array-returning function under `@` returns `#CALC!` per existing 4.7.G limit) → cell-boundary spill rewiring; cross-sheet structured refs (`Sheet1.Sales[Qty]`) → later Phase. Full audit trail in `docs/audits/2026-05-15-phase-4.9-*.md`.
docs/MASTER-PLAN.md:586:   References: `.references/formualizer/crates/formualizer-sheetport/src/session.rs`; `tokio` pinned workspace deps; VS Code stock WebSocket-compatible APIs.  
docs/MASTER-PLAN.md:592:   References: VS Code APIs; Loro awareness examples if available; `.references/formualizer/crates/formualizer-sheetport/src/session.rs`.  
docs/MASTER-PLAN.md:637:- Core runtime API no longer churns daily.
docs/MASTER-PLAN.md:643:- Bindings depend on stable runtime/session APIs.
docs/MASTER-PLAN.md:647:1. **6.1 Stable Engine Session API**  
docs/MASTER-PLAN.md:648:   Define a common API used by service and bindings: open, edit, batch, recalc, query range, save, import/export, subscribe diagnostics, cancel.  
docs/MASTER-PLAN.md:650:   Acceptance: API6-01 one Rust trait/API backs all bindings; API6-02 cancellation included; API6-03 errors are structured.  
docs/MASTER-PLAN.md:660:   Make `ql-bindings-wasm`, `ql-bindings-node`, `ql-bindings-c`, and `quantbook-py` real over the stable session API.  
docs/MASTER-PLAN.md:747:   References: Phase 2B/5/6 IDE proof docs; VS Code stock API constraints.  
docs/MASTER-PLAN.md:843:   Why this matters: putting graph state in `Workbook`, `WorkbookRuntime`, or a separate session object changes persistence, bindings, collab, and service APIs.  
docs/MASTER-PLAN.md:897:| Binding APIs fork behavior | High | WASM/Node/Python/C expose different semantics | Stable session API shared by all bindings | 6 |
crates/ql-formula-semantics/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-terminal/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/quantbook-py/src/lib.rs:5://! the stable session API delivered in 6.1. Maturin wheel target. Tracked as
crates/quantbook-py/src/lib.rs:10://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-ai/src/lib.rs:12://! be a breaking change for any consumer pinning the workspace shape.
docs/phase5/entry-plan.md:60:### Tier A — API stability (mechanical, ship-before-0.2.0)
docs/phase5/entry-plan.md:65:- **A4.** Per-crate stability docs.
docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
docs/phase5/entry-plan.md:128:   sibling submodules + 247-LOC `mod.rs`. Public API surface
docs/phase5/entry-plan.md:134:5. ~~**API stability**~~ — ✅ CLOSED. Tier A
docs/phase5/entry-plan.md:136:   stability docs shipped at `40bb584a25b`. Phase 5 additions
docs/phase5/entry-plan.md:137:   to `Op`, error types, etc. won't break 0.2.0 consumers.
docs/phase1/progress.md:227:| IDE integration (Phase 1 #3) requires engine API changes | Medium | Engine surface is stable; new APIs are additive. Audit may surface gaps. |
crates/ql-bindings-wasm/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-sql/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-types/src/coercion.rs:1047:    // -- to_number_strict_skip_blank (aggregate-skip API) ---------------------
docs/phase1/exit-packet.md:209:| IDE integration (Phase 1 #3) requires engine API changes | Low | Engine surface is stable; `WorkbookRuntime` IS the IDE-facing API. Additive changes only expected. |
docs/phase1/exit-packet.md:212:| Workbook formula state can be inconsistent (value ≠ formula) | Medium | `WorkbookRuntime::set_formula` is the safe API; direct `put_at` + `put_formula` doesn't keep them in sync. Tests warn; documentation makes the contract explicit. |
docs/phase1/exit-packet.md:225:- Op log API surface (Phase 5+ ships full op log; Phase 2 scaffolds the trait)
docs/phase1/exit-packet.md:226:- Multi-cell transaction API (atomic batch writes to `Workbook`)
docs/phase1/exit-packet.md:233:- Phase 0/1 engine API is stable; no engine changes expected
docs/known-gaps.md:35:| GAP-B-08 | Resolver-aware printer (`SheetRef::Id` post-bind print path). Current `print` panics on `SheetRef::Id`; the rename-rewrite path is pre-bind so production never hits the panic. Phase 4.6.E audit MEDIUM. Codex/Sonnet flagged at `crates/ql-formula-syntax/src/printer.rs:75`. | Bind any `=Sheet1!A1` to `ExprPlan`, then call `print(&Expr)` on the recovered AST — panics. | Engine | Engine Phase 4.7 (alongside any post-bind round-trip API) |
docs/known-gaps.md:46:| GAP-O-06 | Op log has no compaction/truncation strategy — unbounded growth on edit-heavy workbooks. Loro snapshot export compresses but retains full history. | `ql-oplog/src/log.rs` (no compaction API); no compaction in any MASTER-PLAN phase | Engine | Engine Phase 5 (CRDT collab re-examines op-log model) |
docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/known-gaps.md:130:| GAP-PS-09 | `WorkbookRuntime<'a>` carries lifetime parameters; Node-API / WASM bindings can't safely wrap it in a long-lived JS object. Need a `WorkbookSession` owning wb + oplog + registry + plan_cache without lifetimes. | `ql-exec/src/workbook_runtime.rs::WorkbookRuntime` (`<'a>` parameter) | Engine | Engine Phase 6.1 (Stable Engine Session API). Subsumes GAP-R-06. |
docs/known-gaps.md:139:| ~~GAP-I-04~~ | ~~No dry-run formula validation API~~ — **CLOSED** in Engine Phase 2B.7 audit closure: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` runs the full lex/parse/bind/eval pipeline without mutating workbook, op log, or plan cache. IDE can call per-keystroke. |
docs/known-gaps.md:140:| GAP-I-05 | No cancellation API on long-running engine operations (`recompute_all`, `transaction::commit`, future `replay_into`). For 1k-formula workbooks instant; for 100k+ blocks the binding thread. | `ql-exec/src/workbook_runtime.rs::recompute_all` (no `CancelToken` parameter) | Engine | Engine Phase 6.1 (Session API + cancellation) |
docs/known-gaps.md:158:- **GAP-I-04** (no dry-run formula validation API) — closed in Engine Phase 2B.7 audit closure: `WorkbookRuntime::validate_formula`.
crates/ql-storage/src/lib.rs:18://! Pre-0.2.0 the public API surface is in flux. Error enums carry
crates/ql-storage/src/lib.rs:107:        // Compose: set a format on A:(0,0) via the table + overlay APIs.
crates/ql-bindings-c/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
crates/ql-oplog/src/replay.rs:40://! avoids a breaking signature change in 2A.3.b/c when the eval path
crates/ql-oplog/src/replay.rs:301:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
crates/ql-functions/src/reference_fns.rs:128:            // ranges. Public-API paths (qbook import, programmatic
crates/ql-functions/src/reference_fns.rs:153:            // from public-API paths that bypass `Range::new` normalization.
crates/ql-functions/src/reference_fns.rs:298:/// **Producer API canonicalization divergence (S4-HIGH-1 doc closure):**
crates/ql-functions/src/reference_fns.rs:299:/// the stored formula text depends on which producer API wrote it:
docs/phase2/entry-plan.md:93:Loro CRDT integration, op log scaffolding, multi-cell transaction API. This is engine work; you can do it here.
docs/phase2/entry-plan.md:123:### Phase 2A.2 — Multi-cell transaction API ✅ DONE (2026-05-12)
docs/phase2/entry-plan.md:127:**API (final):**
docs/phase2/entry-plan.md:155:**Why:** Phase 5 ships full multi-user collaboration. Phase 2 scaffolds the API surface so Phase 5's wiring is incremental.
docs/phase2/entry-plan.md:163:2. `OpLog` API: `append(op)`, `iter()`, `len()`, replay-against-Workbook.
docs/phase2/entry-plan.md:211:- **Don't ship workbench integration** in the engine repo. That's TypeScript work in `extensions/quantlab/`. Engine APIs are stable; IDE work is a separate session.
crates/ql-storage/src/tables.rs:8://! This module is **data model only** for 4.8.A. Mutation API (create /
crates/ql-storage/src/tables.rs:12://! and tests; product code uses the runtime API.
crates/ql-storage/src/tables.rs:278:/// **No mutation API in 4.8.A.** Direct `tables.insert` from the qbook
crates/ql-storage/src/tables.rs:335:    /// **Loader / mutation-internal API.** Insert a table by canonical
crates/ql-oplog/src/op.rs:5://! public API. Future variants (sheet renames, sheet deletes, formatting
crates/ql-oplog/src/op.rs:6://! changes) land alongside the API additions that produce them.
crates/ql-oplog/src/op.rs:268:/// could be renamed without breaking on-disk op-log files).
crates/ql-types/src/array.rs:211:    /// API symmetry; identical to `is_degenerate()` under the invariant.
docs/phase2/exit-packet.md:21:| 2A.2  | `825b3cbf5a7` | `WorkbookTransaction` multi-cell batch API + `WorkbookRuntime::transaction()`. |
docs/phase2/exit-packet.md:117:3. A consumer for its API — `WorkbookTransaction::commit` is the natural producer; no consumer exists yet.
docs/phase2/exit-packet.md:119:The `WorkbookTransaction` API is shaped to absorb op-log integration without breaking changes.
crates/ql-collab/src/lib.rs:26://! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
crates/ql-udf/src/lib.rs:10://! be a breaking change for any consumer pinning the workspace shape.
docs/phase0/references-reading-log.md:108:### Q8. `interval_tree.rs` API?
docs/phase0/references-reading-log.md:167:- `crates/formualizer-eval/src/arrow_store/mod.rs` (6669 lines, API-surface scan + 15 hot-spot deep reads)
docs/phase0/references-reading-log.md:495:| **Graph dump format** | (No precedent in any reference) | — | — | **Quantbook A4 assertion API**: `#[cfg(test)] fn stripe_to_dependents()`, `formula_to_range_deps()` typed accessors; assertions directly on `(StripeKey, HashSet<NodeId>)` shape. NOT a serialized form. |
docs/phase0/references-reading-log.md:514:2. Returns `(sorted, cycled)` tuple — clearer API than Kahn + post-hoc cycle check.
crates/ql-exec/src/scalar.rs:591:            // `delete_sheet` API) and a future deletion path will need
crates/ql-exec/src/loader.rs:23://! at the API level — it always returns a result. Load is the only
crates/ql-io-xlsx/src/model.rs:26:    /// without breaking callers.
crates/ql-storage/src/column.rs:551:    // -- FIX-3: N1/F8 — iter_chunks API ---
docs/phase4/exit-packet.md:52:- **Opus-C** — architecture / public API / persistence across all crates
docs/phase4/exit-packet.md:64:public API surface that downstream consumers (Phase 5 collaboration,
docs/phase4/exit-packet.md:67:### Stable public API (committed)
docs/phase4/exit-packet.md:74:### Deprecated for removal in 0.2.0 (Phase 4.11 megaudit closure)
docs/phase4/exit-packet.md:87:- Table-id stability across round-trips.
docs/phase4/exit-packet.md:144:2. **Public API stability** — deprecation warnings landed in
docs/phase4/exit-packet.md:146:   (0.2.0) removes them. Any other deprecation candidates surfaced
docs/phase4/exit-packet.md:147:   by Phase 4.12 megaudit should land BEFORE 0.2.0.
docs/phase4/exit-packet.md:155:   divergences surfaced should be ranked + closed before 0.2.0.
docs/phase4/exit-packet.md:168:- **API-stability (BEFORE 0.2.0):** `#[non_exhaustive]` pass +
docs/phase0/exit-packet.md:116:- ✅ Stock VS Code APIs only in v1 (T1-D06) — Quantbook engine doesn't touch IDE in Phase 0
crates/ql-oplog/src/lib.rs:28://! Pre-0.2.0 the public API surface is in flux. `Op` carries
crates/ql-storage/src/spill.rs:45://! access. Keeping the table layer pure-map keeps testability +
crates/ql-storage/src/spill.rs:271:        // pre-stabilized `HashMap` API). The panic-on-OOM effective
crates/ql-functions/src/reference_aware_fns.rs:47:    /// will populate values via the existing `CellEnv::read_range` API. **Step 1.1 (S1-MED-η
crates/ql-functions/src/reference_aware_fns.rs:61:    /// value" with "the ref is itself invalid", breaking `ISFORMULA(A1)`
docs/architecture/crdt-data-model.md:92:   `export_from(version_vector)` + `import` API.
docs/architecture/crdt-data-model.md:456:**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.
crates/ql-oplog/src/log.rs:3://! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
crates/ql-profile/src/lib.rs:11://! Pre-0.2.0 the public API surface is in flux. `NodeKind` mirrors
crates/ql-oplog/src/error.rs:38:    /// from `LoroError` (decode) in Loro 1.12.0's API surface.
crates/ql-io-xlsx/src/read/convert.rs:112:/// the public-API layer.
docs/PHASE-4-V2-BACKLOG.md:5:ship-before-0.2.0 (API stability), Phase 5 prep (architectural),
docs/PHASE-4-V2-BACKLOG.md:18:## Tier A — SHIP BEFORE 0.2.0 RELEASE (API stability commitments) — ✅ SHIPPED 2026-05-18 at commit `40bb584a25b`
docs/PHASE-4-V2-BACKLOG.md:56:### ~~A4.~~ Per-crate stability docs — DONE
docs/PHASE-4-V2-BACKLOG.md:224:- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
docs/PHASE-4-V2-BACKLOG.md:253:  4. Pure table-API tests in `cells.rs::tests`
docs/PHASE-4-V2-BACKLOG.md:283:- **External API compat:** `ql_io::CellWireValue` etc. preserved
docs/PHASE-4-V2-BACKLOG.md:410:  Workbook god-struct testability.
docs/PHASE-4-V2-BACKLOG.md:451:**Next-session recommendation:** start with Tier A (API stability,
docs/PHASE-4-V2-BACKLOG.md:452:mechanical, ships before 0.2.0), then Tier B1 (literal-range bind,
crates/ql-storage/src/workbook.rs:6://!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
crates/ql-storage/src/workbook.rs:21:/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
crates/ql-storage/src/workbook.rs:22:/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
crates/ql-storage/src/workbook.rs:283:/// Arrow buffers. This is safe today because the only mutating APIs
crates/ql-storage/src/workbook.rs:290:/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
crates/ql-storage/src/workbook.rs:322:    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
crates/ql-storage/src/workbook.rs:451:    /// API surface.
crates/ql-storage/src/workbook.rs:683:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
crates/ql-storage/src/workbook.rs:761:    /// if no anchor was registered at the cell. Friendlier API for the
crates/ql-storage/src/workbook.rs:781:    /// layer's public read API. Any host code that bypasses `WorkbookEnv`
crates/ql-storage/src/workbook.rs:949:        // (was: Blank). Aligns the storage-layer public read API with
crates/ql-profile/src/timings.rs:139:/// just the timing API.
crates/ql-oplog/tests/producer_replay_equivalence.rs:15://!    workbook (state B), using the same `Workbook` APIs that replay uses
crates/ql-oplog/tests/producer_replay_equivalence.rs:131:/// same APIs that replay uses internally. In 2A.3.b this becomes the
crates/ql-exec/src/calcgraph_session.rs:512:/// construction. Phase 3.1 ships this for testability + ql-profile
crates/ql-exec/src/calcgraph_session.rs:669:    /// inert, but the parameter is part of the stable graph API).
crates/ql-exec/src/calcgraph_session.rs:1563:    /// at insert time, not by this query's API.
crates/ql-exec/src/calcgraph_session.rs:1571:    /// API that bundles dirtying + cache invalidation + bind-failure
crates/ql-exec/src/calcgraph_session.rs:1886:    /// `NodeId` API, not anything petgraph-derived. Phase 3.1 does
crates/ql-exec/src/calcgraph_session.rs:1910:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
crates/ql-exec/src/calcgraph_session.rs:2710:    // The graph-level revocation API has its own tests in
crates/ql-io-xlsx/src/lib.rs:44://! Pre-0.2.0 the public API surface is in flux. The `XlsxPreservation`
crates/ql-io-xlsx/src/lib.rs:60:// itself. Stubs declared here so the public API can reference them
crates/ql-exec/src/transaction.rs:1://! `WorkbookTransaction` — Phase 2A.2 batch-write API.
crates/ql-exec/src/transaction.rs:58:/// One pending operation in a transaction. Internal — the public API is the
crates/ql-functions/src/lib.rs:27://! Pre-0.2.0 the public API surface is in flux. Error enums
docs/compat/error-matrix.md:187:| `RAND` / `RANDBETWEEN` | Non-deterministic; deterministic test-seed API exists (`set_test_rng_seed`) | 🟢 |
docs/compat/error-matrix.md:205:Helper API (`ql-types::coercion`):
docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:131:### 4.3 Anchor-aware lex + parse + print API (closes Codex H-2 + Sonnet H-3/H-4)
docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:184:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:185:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:198:| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:7://! Each probe records what happens when the op-log API or replay path is
crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:147:                // the public API only takes Op::append. Use that — depth
crates/ql-types/src/lib.rs:17://! Pre-0.2.0 the public API surface is in flux. Variants will be added.
crates/ql-io-xlsx/src/write/umya_export.rs:97:    // value. The `iter_formulas` API gives us only formula-bearing
crates/ql-io-xlsx/src/write/umya_export.rs:1487:        // for stability and isolation from any umya-emitted rIds.
crates/ql-io-xlsx/src/write/umya_export.rs:1692:        // Re-import via the public API.
docs/audits/2026-05-18-phase-4-12-megaudit-self.md:140:2. **Public API stability commitments** — what 0.1.x → 0.2.0 breaks?
crates/ql-functions/src/format/render.rs:25:// Public API
docs/audits/2026-05-13-w5-61-megaudit-sonnet.md:91:### M5 — CONCAT row-major flattening is correct but undocumented at the API level
docs/audits/2026-05-13-w5-61-megaudit-sonnet.md:135:For `mode = NaN`: `NaN == 0.0` is false → falls into the mode≠0 branch. Excel would probably return `#VALUE!` for NaN mode. Quantbook treats NaN-mode as truthy and continues. Not breaking, not pinned.
docs/audits/2026-05-13-w5-61-megaudit-sonnet.md:178:- `mode = 0` vs `mode != 0`: correct branch via `if number >= 0.0 || mode == 0.0`. Edge: `-0.0 == 0.0` is true, so -0.0 hits mode=0 branch. `NaN == 0.0` is false → mode≠0 branch. L6; not breaking.
docs/architecture/2026-05-13-graph-storage-decision.md:7:**Precondition for:** Phase 4.3 V2 batch, Phase 4.7 array formulas (FormulaRegion binder rests on Option A's revocation API).
docs/architecture/2026-05-13-graph-storage-decision.md:21:- **Option A** — Add per-formula revocation API to `Graph` + `StripeIndex`. Reverse-index stripe membership so per-formula clear is `O(stripes-this-formula-is-in)` rather than scanning the whole stripe map. Call the new APIs in `extract_and_register_deps` at the same point as the existing `remove_formula_deps`. Keeps `Vec<Vec<NodeId>>` adjacency, no new graph library, no `IndexSet`/`petgraph` dep, no edge-epoch metadata.
docs/architecture/2026-05-13-graph-storage-decision.md:98:### Phase A.2 — `Graph` revocation API
docs/audits/2026-05-19-handoff-audit-consolidated.md:53:| D-1 | `FormatId` tagged tuple (Phase 5.2.b) | Phase 5.1 audit | Multi-day schema-breaking work; needs its own session + parallel Codex+Opus audit per discipline rule |
docs/audits/2026-05-19-handoff-audit-consolidated.md:71:too schema-breaking for a single session.
crates/ql-exec/src/workbook_runtime/names.rs:1://! Defined-name API for `WorkbookRuntime`.
docs/audits/2026-05-12-phase-3-megaudit.md:117:  API. **GAP-G-01 description updated** (now correctness-relevant);
crates/ql-types/tests/coercion_matrix.rs:33://! Integration tests use the public API only.
crates/ql-functions/src/scalar_fns.rs:30:// `ql_types::coercion::to_number_strict_skip_blank` (the central neutral API).
crates/ql-functions/src/scalar_fns.rs:80:/// empty input. Uses Welford for numerical stability (matches A6 spec).
crates/ql-functions/src/scalar_fns.rs:4981:        // Non-breaking space (U+00A0) is NOT collapsed by Excel TRIM;
crates/ql-io/src/qbook_format.rs:1796:            // duplicate or empty column names breaking `lookup_column`.
docs/audits/.codex-w5-d-2-prompt.md:37:1. **statrs API verification:** `StudentsT::new(location, scale, freedom)` with `(0.0, 1.0, df)`; `cdf(x)`, `pdf(x)`, `inverse_cdf(p)`. Verify all 5 impls use these correctly. `students_t_with(df)` helper uses `.expect()` per No-Fallbacks rule.
docs/audits/2026-05-13-deep-audit-closure.md:37:(German ß → SS for UPPER; emoji ZWJ count for LEN; non-breaking
crates/ql-exec/src/workbook_runtime/validate.rs:1://! Validation + transaction API for `WorkbookRuntime`.
crates/ql-functions/src/volatile.rs:23://! `ql-exec` test suite can use them via the public crate API.
crates/ql-io/src/lib.rs:10://! Pre-0.2.0 the public API surface is in flux. `QbookError` carries
docs/audits/2026-05-18-w5-d-15-opus.md:358:  set General format". Not breaking, but worth tracking.
docs/architecture/2026-05-14-structured-references-and-tables.md:12:This doc covers TBL-4-01 through TBL-4-03. **TBL-4-04 (xlsx import creates tables)** lives in Phase 4.11 (xlsx I/O); 4.8 ships table create/edit/destroy through the engine API + op log, and 4.11 lights up xlsx round-trip.
docs/architecture/2026-05-14-structured-references-and-tables.md:20:5. **Mutation API** — `WorkbookRuntime::create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`. Each emits a corresponding op-log entry.
docs/architecture/2026-05-14-structured-references-and-tables.md:164:Decision: use `Arc<str>` (uppercase canonical) as the primary key, matching `NameTable`. A separate `TableId(u32)` is tempting for the graph (stable across renames) but adds complexity. **Renames REWRITE formula text** (Excel canon, see § 12.2). The plan-cache-invalidation alternative (the original draft's approach) was broken: cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence. Rewrite-on-rename is the simpler correct path.
docs/architecture/2026-05-14-structured-references-and-tables.md:608:**Formula text IS rewritten on rename** (Excel canon). The original draft proposed plan-cache invalidation + no rewrite — Codex correctly noted that cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence.
docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/architecture/2026-05-14-structured-references-and-tables.md:713:2. **4.8.N soft-fail** — backwards-incompatible API contract change. Currently `set_formula("SUM(Sales[Qty])")` BEFORE `create_table("Sales", ...)` hard-rejects with `BindError::UnknownTable`. Design § 7.4 wants accept-text-and-surface-error-cell-value with re-bind on `on_table_create`. Needs explicit sign-off on the contract change before implementation.
docs/audits/2026-05-18-tier-c1-opus.md:121:  repeated-call stability invariant.
docs/audits/2026-05-17-w5-d-10-opus.md:10:W5-D-10 is **clean and ready to commit**. All 4 functions are mathematically correct, match IronCalc semantics exactly (`erf(y) - erf(x)` for the 2-arg form, strict 1-arg for the three other shapes), use the appropriate statrs API (separate `erf` / `erfc` — not naive `1 - erf(x)`), route through `finite_or_num` defense-in-depth, and propagate errors per the engine's documented coercion divergence (`to_number_strict` accepts Booleans, IronCalc rejects them — same as every other Wave 3 distribution).
docs/audits/2026-05-17-w5-d-10-opus.md:103:### CNI-4 — statrs API: separate `erfc`, not `1 - erf`
crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:287:fn p5_double_roundtrip_stability() {
crates/ql-functions/src/welford.rs:27://! ## Streaming API
crates/ql-connectors/src/lib.rs:10://! be a breaking change for any consumer pinning the workspace shape.
crates/ql-calcgraph/src/graph.rs:276:    /// during a `SUM`/`COUNT`/etc. reduction. Locking the API in W3-6 means Week 4 just
crates/ql-calcgraph/src/graph.rs:295:    /// downstream scheduling order, silently breaking replay determinism.
crates/ql-calcgraph/src/graph.rs:624:    /// Rust's randomized hash state to callers, silently breaking replay determinism.
crates/ql-calcgraph/src/graph.rs:740:    // ===== W5-50 (Phase 4 pre-V2): per-formula revocation API =====
docs/architecture/2026-05-17-reference-tier-design.md:141:**Documented divergence — canonicalization-per-producer-API (S4-HIGH-1 closure):** TWO public producer APIs write formulas and the stored text shape differs:
docs/architecture/2026-05-17-reference-tier-design.md:146:Both APIs satisfy the leading-`=` invariant. v1 acceptance: this is a known divergence. Both forms parse to the same AST, so the divergence is purely cosmetic (spacing/case in formula text). Alignment is post-RT-V1 work (Opus pre-review S4-HIGH-1 Option 1 or 2 path: canonicalize at FORMULATEXT boundary OR at Transaction).
docs/architecture/2026-05-17-reference-tier-design.md:519:All identifiers verified against actual API (LOW/MEDIUM closures): `RowId`/`ColId` are `u32` (no `.0`), `Value::Error(...)` not `Value::error(...)`, `ErrorValue::NA` not `NotApplicable`, `ql_types::Range::start_row` / `end_row` etc.
docs/audits/2026-05-14-phase-4.7.F-sonnet-review.md:195:**Severity: LOW** — no observable runtime regression (the parser prevents this path in production), but it is an API inconsistency that breaks the parallel-with-parser design intent and could mislead an IDE consumer.
docs/audits/2026-05-17-w5-d-4-codex.md:10:Aside from the findings below, the remaining function paths match the requested IronCalc domains and the statrs 0.18.0 APIs checked locally:
docs/audits/2026-05-14-phase-4.6-closing-megaudit-prompt.md:203:**L.7** Hash stability: `SheetRef::Name(Arc<str>)` — two ARCs containing the same string should compare/hash equal. Verify the derive(Hash) on `Arc<str>` does what we expect. (Arc<str>'s Hash impl delegates to str's Hash, so yes.)
crates/ql-functions/src/range_aware_fns.rs:41:/// API neutral (Result/Option) but the function-aware enum stays in
crates/ql-functions/src/range_aware_fns.rs:45:/// internal cross-module helper, not part of the public API. External
crates/ql-functions/src/registry.rs:17://! `register_*` / `lookup_*` API surface: legacy callers still call
crates/ql-functions/src/registry.rs:653:    // the source (deprecated callable API) but no longer registered.
crates/ql-calcgraph/src/node.rs:14://!   in Phase 0; included so adding it later isn't a breaking enum change.
crates/ql-exec/src/workbook_runtime/tables.rs:1://! Table mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/tables.rs:38:    // ===== W5-118 (Phase 4.8.H) — table mutation API =====
crates/ql-exec/src/workbook_runtime/tables.rs:2061:    /// the runtime API end-to-end.
crates/ql-calcgraph/src/fingerprint.rs:182:            // for stability) + the spec subtree's debug representation
crates/ql-calcgraph/src/fingerprint.rs:327:/// helper. Tags 0/1 preserve fingerprint stability for `Current`/`Id`
docs/architecture/2026-05-13-coercion-matrix.md:159:3. **(Codex MEDIUM 3 fix)** Move `NumericArg` + `coerce_numeric` (the aggregate-with-skip variant) to `ql-types::coercion` as a **neutral** API: `pub fn to_number_strict_skip_blank(v: &Value) -> Result<Option<f64>, ErrorValue>`. `Ok(Some(n))` = Number, `Ok(None)` = Blank-skip, `Err(e)` = Error. This avoids leaking "aggregate" terminology into `ql-types` (which should remain function-agnostic). The function-specific `NumericArg` enum stays out of `ql-types`; if a caller still wants the match-friendly shape, it can `match` on the Result.
docs/architecture/2026-05-13-coercion-matrix.md:168:4. **(Codex MEDIUM 4 fix)** Coverage check: `crates/ql-functions/tests/coverage.rs` walks the registry's BOTH tables (scalar `fns` AND `range_aware_fns`) and asserts every registered name has at least one matrix-test entry. `FunctionRegistry::names()` currently exposes only scalar names (`registry.rs:115`); the coverage script either uses an extended API (`fn names_all()`) or directly inspects both tables. Without this, new fns landing in `range_aware_fns` (MATCH, VLOOKUP, COUNTIF, RANK, CONCAT, etc.) can slip through without matrix coverage.
docs/audits/2026-05-13-engine-session-final-handoff.md:60:**Decision:** Option A (per-formula revocation API: `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index) + small Option C (`topo::schedule_with_supplemental` injecting temp `F→G` edges at recompute time for dirty formula pairs inside ranges). FormulaRegion binder (Option B) deferred to Phase 4.7.
crates/ql-calcgraph/src/edges.rs:109:    /// Phase 4 / W5-50: introduced for the per-formula edge revocation API
docs/architecture/ide-consumer-contract.md:5:**Stability:** **DRAFT** — names + shapes will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden.
docs/architecture/ide-consumer-contract.md:99:This is the canonical "no-op cancel" path. The engine offers no explicit cancel API because none is needed — borrow-checked mutation requires explicit `&mut` access, and the IDE never grants it for cancelled edits.
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1182:    // Look for an API to delete sheet.
crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1184:    println!("[I21] If WorkbookRuntime exposes no delete_sheet API, that's a Phase 4 IDE gap.");
crates/ql-calcgraph/src/lib.rs:31://! Pre-0.2.0 the public API surface is in flux. `Node` and
crates/ql-calcgraph/src/lib.rs:252:    /// that the counter exists + the API is stable + a manual increment via
docs/audits/2026-05-19-handoff-audit-codex.md:18:- `40bb584a25b` Tier A — `#[non_exhaustive]` pass + deprecated removal + per-crate stability docs
docs/audits/2026-05-19-handoff-audit-codex.md:412:    26	//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
docs/audits/2026-05-19-handoff-audit-codex.md:497:    48	### Tier A — API stability (mechanical, ship-before-0.2.0)
docs/audits/2026-05-19-handoff-audit-codex.md:502:    53	- **A4.** Per-crate stability docs.
docs/audits/2026-05-19-handoff-audit-codex.md:563:   114	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:564:   115	   the public API. The Tier A `#[non_exhaustive]` pass should
docs/audits/2026-05-19-handoff-audit-codex.md:565:   116	   precede Phase 5 to avoid 0.2.0-breaking churn on Phase-5-added
docs/audits/2026-05-19-handoff-audit-codex.md:693:    92	   `export_from(version_vector)` + `import` API.
docs/audits/2026-05-19-handoff-audit-codex.md:1035:   434	**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.
docs/audits/2026-05-19-handoff-audit-codex.md:1805:docs/PHASE-4-V2-BACKLOG.md:5:ship-before-0.2.0 (API stability), Phase 5 prep (architectural),
docs/audits/2026-05-19-handoff-audit-codex.md:1847:docs/phase5/entry-plan.md:114:5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:1848:docs/phase5/entry-plan.md:116:   precede Phase 5 to avoid 0.2.0-breaking churn on Phase-5-added
docs/audits/2026-05-19-handoff-audit-codex.md:2057:?? .plans/_archive/2026-05-18_tier-a-api-stability.md
docs/audits/2026-05-19-handoff-audit-codex.md:2075:69ede106a61 Tier D1 Step 3.8 — extract WorkbookRuntime validate + transaction API to validate.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2076:de7f87c5334 Tier D1 Step 3.7 — extract WorkbookRuntime cell mutation API to cells.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2078:aa6e37800ff Tier D1 Step 3.5 — extract WorkbookRuntime table API to tables.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2079:a48e985c5ec Tier D1 Step 3.4 — extract WorkbookRuntime defined-name API to names.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2080:c37c556dd0f Tier D1 Step 3.3 — extract WorkbookRuntime sheet API to sheets.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2082:2761e1f88cf Tier D1 Step 3.1 — extract WorkbookRuntime format API to formats.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2088:40bb584a25b Tier A / Phase 5 prep — #[non_exhaustive] pass + deprecated removal + stability docs
docs/audits/2026-05-19-handoff-audit-codex.md:2167:    40	### Tier A — API stability (mechanical, ship-before-0.2.0)
docs/audits/2026-05-19-handoff-audit-codex.md:2172:    45	- **A4.** Per-crate stability docs.
docs/audits/2026-05-19-handoff-audit-codex.md:2233:   106	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:2234:   107	   the public API. The Tier A `#[non_exhaustive]` pass should
docs/audits/2026-05-19-handoff-audit-codex.md:2235:   108	   precede Phase 5 to avoid 0.2.0-breaking churn on Phase-5-added
docs/audits/2026-05-19-handoff-audit-codex.md:2363:    92	   `export_from(version_vector)` + `import` API.
docs/audits/2026-05-19-handoff-audit-codex.md:2964:2073-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:2976:2105-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:2984:2113-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3006:2155-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3018:2184-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3022:2188-version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3099:  2073	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3109:  2083	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3113:  2087	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3136:  2073	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3140:  2077	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3144:  2081	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3161:  2073	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3171:  2083	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3175:  2087	version = "0.1.0"
docs/audits/2026-05-19-handoff-audit-codex.md:3237:?? .plans/_archive/2026-05-18_tier-a-api-stability.md
docs/audits/2026-05-19-handoff-audit-codex.md:3389:    60	### Tier A — API stability (mechanical, ship-before-0.2.0)
docs/audits/2026-05-19-handoff-audit-codex.md:3394:    65	- **A4.** Per-crate stability docs.
docs/audits/2026-05-19-handoff-audit-codex.md:3455:   126	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:3456:   127	   the public API. The Tier A `#[non_exhaustive]` pass should
docs/audits/2026-05-19-handoff-audit-codex.md:3457:   128	   precede Phase 5 to avoid 0.2.0-breaking churn on Phase-5-added
docs/audits/2026-05-19-handoff-audit-codex.md:3610:?? .plans/_archive/2026-05-18_tier-a-api-stability.md
docs/audits/2026-05-19-handoff-audit-codex.md:3615:/bin/zsh -lc 'git check-ignore -v ../node_modules .codex/prompts/2026-05-14-AA-design-review.md .plans/_archive/2026-05-18_tier-a-api-stability.md 2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt ../2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:3741:quantbook-engine/.plans/_archive/2026-05-18_tier-a-api-stability.md
docs/audits/2026-05-19-handoff-audit-codex.md:3921:     3	//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
crates/ql-exec/src/workbook_runtime/formats.rs:1://! Format API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/formats.rs:274:        // Pre-set the binding via low-level API.
crates/ql-exec/src/workbook_runtime/formats.rs:339:        // Intern then bind via runtime APIs (mirrors IDE-flow).
crates/ql-calcgraph/src/topo.rs:12://! 2. **Direct API for the Phase 0 cycle policy.** The spec's Phase 0 minimum: cycled
crates/ql-functions/src/array_returning_fns.rs:239:            // Bound to u32 for the ArrayValue API.
crates/ql-functions/src/distribution_fns.rs:245://! stability vs `1 - dist.cdf(x)` in the far right tail; F.DIST.RT
docs/audits/.codex-w5-d-11-prompt.md:132:### Sort stability
docs/audits/.codex-w5-d-4-prompt.md:53:1. **statrs API verification:** `Binomial::new(p, n: u64)`,
docs/architecture/2026-05-13-dates-times-formats.md:372:**Default format**: `"General"` — matches Excel exactly: render the raw numeric value (or text body, or `TRUE`/`FALSE`, or sigil). **NO auto-date-detection** — a date format is shown ONLY when the cell has an explicit date format applied. **Codex HIGH 2 fix**: the prior draft proposed auto-detecting "looks like a date" by serial range. That would render literal `45810` as `"6/30/2025"`, breaking the value/display separation that DTF-4-04 demands.
docs/audits/2026-05-17-rt-step-2-opus.md:111:**Concrete user-visible case** (low-likelihood in v1 because sheet-delete API isn't exposed in workbook_runtime — see CC note below — but reachable through scenarios where a binder mis-resolution happens at the boundary, or through any future deletion path):
docs/audits/2026-05-17-rt-step-2-opus.md:127:**Reachability assessment.** Today, the workbook_runtime has no `delete_sheet` API (grep for `delete_sheet` / `remove_sheet` in workbook_runtime.rs returns 0 production paths). So the deleted-sheet case isn't exercisable from end-user formulas. BUT: any future deletion API will need to either (a) bring this in scope as a regression OR (b) ship with this materializer arm pre-fixed. Also: the WorkbookEnv's `read_cell` returns `Blank` for missing cells in an existing sheet — that's correct and not an error. The error-path is reachable only via the missing-sheet branch today.
docs/audits/2026-05-17-rt-step-2-opus.md:474:**Severity rationale:** MEDIUM-as-API-cleanliness; LOW-as-runtime-cost. Carry-over of Step 1's MEDIUM-O-3. Flagging again because Step 2 is the last reasonable moment to drop the field before user-facing fns start dispatching through it; once Step 2 ships, removing the field becomes more disruptive.
docs/audits/2026-05-17-rt-step-2-opus.md:494:Same outcome (rows count of the array). But `av.shape()` doesn't exist on `ArrayValue` (grep `pub fn shape` in `crates/ql-types/src/array.rs` returns zero results). The design pseudo-code was written against a non-existent API.
docs/audits/2026-05-17-rt-step-2-opus.md:498:**Recommendation:** Update design § 5.6 to use `av.rows() as f64` and `av.cols() as f64` to match the actual API. Or, alternatively, add `pub fn shape(&self) -> (u32, u32) { (self.rows, self.cols) }` to ArrayValue and update the impl. The former is lower-impact.
docs/audits/2026-05-17-rt-step-2-opus.md:609:**Detail:** Step 1.1 closure left the audit-trail in the doc-comment. Step 2 didn't clean it up. Future readers don't need the audit-history; they need the current API contract.
crates/ql-functions/tests/coverage.rs:8://! This test enumerates BOTH tables via the new `names_all()` API and
crates/ql-functions/tests/coverage.rs:889:         1-cdf() for numerical stability, negative-x #NUM!, df<1 #NUM!, \
docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md:8:Opus-C (architecture / public API / persistence), self (exit-packet
docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md:50:| D9 | Opus-C H-1 | `#[non_exhaustive]` missing on public enums. | API-stability batch — should land BEFORE 0.2.0 release. |
docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md:89:**API stability (BEFORE 0.2.0):**
docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md:92:- Document public API stability commitments per crate.
crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:22://! New `OpLog::merge_bytes` API added in this commit; this is the
crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:86:    // transport layer; the test uses the export/merge API directly).
docs/audits/2026-05-17-w5-d-1-codex.md:8:No HIGH correctness findings found in the implementation. The four functions use the expected `statrs::distribution::Normal` APIs (`Normal::new`, `cdf`, `pdf`, `inverse_cdf`), enforce the Excel/IronCalc numeric domains, route non-finite statrs outputs through `#NUM!`, and register at scalar tier. Workspace dependency pinning is exact (`=0.18.0`) with `default-features = false`, and `ql-functions` consumes it through `{ workspace = true }`.
docs/audits/2026-05-17-w5-d-1-codex.md:102:- `Normal::new(mean, sd)`, `cdf(x)`, `pdf(x)`, and `inverse_cdf(p)` are the correct `statrs 0.18.0` APIs. `inverse_cdf` would panic outside `[0,1]`, but both inverse functions check the stricter Excel domain `(0,1)` before calling it.
crates/ql-calcgraph/Cargo.toml:17:# algorithm contract is "not specified" per the Rust API.
docs/audits/.codex-w5-d-1-prompt.md:32:1. **statrs API verification:** `Normal::new(mean, sd)`, `cdf(x)`, `pdf(x)`, `inverse_cdf(p)`. Verify the impl uses the right methods.
crates/ql-exec/src/workbook_runtime/recompute.rs:302:        // instead of silently breaking. After the loop, if `iter_count`
crates/ql-exec/src/workbook_runtime/recompute.rs:1518:    /// context-awareness. Regression guard against accidentally breaking
crates/ql-exec/src/workbook_runtime/recompute.rs:1848:    /// `put_formula` API and rebuild the session. Going through
crates/ql-exec/src/workbook_runtime/recompute.rs:2195:            // workbook API which doesn't populate the session cache.
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:94:Any code that attempts to print a post-bind AST (where `SheetRef::Name` has been resolved to `SheetRef::Id` by the binder) will panic. The rename rewrite round-trip in `workbook_runtime.rs:85–108` correctly uses a pre-bind parse (never binds before printing), so the panic is not triggered in the current happy path. However, this is a latent footgun for any future caller that binds then prints. The design acknowledges this with a "future `print_with_resolver` API" note, but no tracking issue exists. Severity: MEDIUM (no current crash path, but the API is a trap for future contributors).
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:193:**I.6 — v1-v4 round-trip byte-stability:** PASS  
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:261:**L.7 — `NameTable` hash stability:** PASS  
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:297:- The design's `print_with_resolver` API is not implemented (future work, acknowledged).
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:322:The rename rewrite round-trip does not trigger this because it never binds before printing. However, the footgun is real: any future code that binds a formula (converting `Name` → `Id`) then attempts to print the AST will panic. Options: (a) implement `print_with_resolver` API that takes a `SheetId → &str` resolver, or (b) add a `#[doc(hidden)]` warning and a prominent comment on `print_sheet_prefix` noting the `Id` panic, and file a tracking issue. For W5-93 close, (b) is acceptable.
docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:339:The criterion says "cross-sheet cell refs parse, print, bind, and recompute." The `print` direction from a post-bind AST panics. Either scope down the criterion to "pre-bind print" or track the `print_with_resolver` API as a follow-up under XS-4-01. An explicit statement in the MASTER-PLAN that `print` is scoped to pre-bind ASTs would close this interpretive gap.
crates/ql-formula-syntax/src/printer.rs:81:/// public API; callers configure via `print_with(...)` args.
crates/ql-formula-syntax/src/printer.rs:119:/// **Locale**: parameter is accepted today for signature stability
crates/ql-formula-syntax/src/printer.rs:344:             resolver-aware print_with_resolver(expr, &workbook) API is \
crates/ql-formula-syntax/src/printer.rs:837:            // round-trip stability.
crates/ql-formula-syntax/src/printer.rs:1178:    /// resulting string re-parses as right-grouped `a^(b^c)`, breaking the AST. Fix:
crates/ql-formula-syntax/src/printer.rs:1511:        // bracketed form `[@[Col]]` for round-trip stability (a column
docs/architecture/2026-05-13-cross-sheet-references.md:39:- **Sheet rename ops:** no `Op::RenameSheet`; `Workbook` has no `rename_sheet(id, new_name)` API.
docs/architecture/2026-05-13-cross-sheet-references.md:89:This is consistent with how `WorkbookEnv` already treats cell coordinates (storage by id; names at the API surface) and avoids the IronCalc bag of rename hazards (formula text must be re-written on rename).
docs/architecture/2026-05-13-cross-sheet-references.md:218:- **A — per-sheet NameTable:** `Sheet { scoped_names: NameTable, .. }`. Lookup chain: sheet's table first, then workbook's. Simpler to model but doubles the API surface.
docs/architecture/2026-05-13-cross-sheet-references.md:241:The current `bind_with_names` API takes a single `&NameLookup`. Extend it to `bind_with_names(expr, owning_sheet, names: &dyn NameLookupForSheet)` where `NameLookupForSheet::lookup(name, owning_sheet)` performs the two-tier chain internally.
crates/ql-exec/tests/ide_simulation.rs:6://! involving any TypeScript / VS Code APIs. The five tests map 1:1 to the
crates/ql-exec/tests/ide_simulation.rs:133:/// edit. No engine API call needed; this test pins the convention.
crates/ql-exec/tests/ide_simulation.rs:174:/// the transaction API. Commit emits exactly ONE `Op::BatchCommit` per
crates/ql-functions/src/range_fns.rs:6345:        // defensively. Skipped through the public API since `r(vec![])`
docs/audits/.codex-w5-d-14-audit-prompt.md:20:  - `c0a496e3627` — W5-D-14 scaffolding (deps + public API + types)
docs/audits/.codex-w5-d-14-audit-prompt.md:37:- `src/lib.rs` — public API + import_xlsx_path/bytes +
docs/audits/.codex-w5-d-14-audit-prompt.md:191:- Public-API rustdoc accuracy.
crates/ql-formula-syntax/src/lib.rs:31://! Pre-0.2.0 the public API surface is in flux. Error enums carry
docs/audits/2026-05-13-phase-4.4-megaudit-prompt.md:70:3. **`coerce_numeric` → `to_number_strict_skip_blank`**: the new central API
docs/audits/2026-05-13-phase-4.4-megaudit-prompt.md:192:### CONCERN-G: Public API surface — exports clean?
crates/ql-formula-syntax/src/token.rs:19://! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:67:The writer API should separate two modes:
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:80:- Public `ql-io-xlsx` API and dependency wiring.
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:108:The fastest safe importer is not a list of runtime edits. Runtime APIs are user-operation APIs; they parse, bind, evaluate, emit oplog, and mutate spills. XLSX import should bulk-load storage state and then ask the runtime to recompute.
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:130:| Calamine stagnates | Public API gaps remain, or formula/table behavior changes. | Medium | Medium | Hide it behind `CalamineGridReader`; keep direct XML scanners independent; pin versions; add corpus tests so replacement cost is localized. |
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:138:| Unsupported feature silence | CF/DV/comments/images/macros disappear without user awareness. | High unless designed | High | `UnsupportedFeature` inventory is part of import/export API. Strict mode fails; permissive mode reports. |
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:171:Public API sketch:
docs/audits/2026-05-18-phase-4-11-architecture-codex.md:267:External API checks:
docs/audits/.codex-w5-d-10-prompt.md:39:1. **statrs API usage**: `erf(f64) -> f64`, `erfc(f64) -> f64`. Both
crates/ql-service/src/lib.rs:7://! be a breaking change for any consumer pinning the workspace shape.
docs/audits/2026-05-14-engine-session-final-handoff.md:65:| `e1413b54397` | W5-82 — `WorkbookRuntime` format wrappers + `read_display` | ~1810 | Public API |
docs/audits/2026-05-15-phase-4.8-final-reverify-codex.md:137:  1750	            // duplicate or empty column names breaking `lookup_column`.
docs/architecture/calcgraph-runtime.md:80:The public API for the scheduler:
docs/architecture/calcgraph-runtime.md:93:Earlier Phase 3 commits shipped the Phase 0 `Graph` as append-only — no API to remove edges or revoke a `register_range_dependency`. Phase 3.10 megaudit found this was correctness-relevant: stale forward edges after rebind could produce FALSE `#CIRC!` cycles in Tarjan (H3), and stale range-dep stripe entries falsely dirty the formula on writes to OLD ranges (H4).
docs/architecture/calcgraph-runtime.md:109:- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
docs/audits/2026-05-18-phase-4-12-megaudit-opus-a.md:224:**Impact:** Producer API silently degrades when the calcgraph is not
docs/audits/2026-05-18-phase-4-12-megaudit-opus-a.md:250:### LOW-1: `delete_sheet` API missing from runtime
crates/ql-exec/src/workbook_runtime/cells.rs:1://! Cell mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/cells.rs:376:            // so use the public(crate) `mark_dirty` API.
crates/ql-exec/src/workbook_runtime/cells.rs:1666:        // Regression guard for the existing public API.
crates/ql-exec/src/aggregate_cache.rs:45:/// Read/write API the scalar evaluator and the runtime see. Two impls in
docs/architecture/workbook-runtime-split-design.md:35:   from "recompute pipeline" from "format API". A new
docs/architecture/workbook-runtime-split-design.md:81:mutation API =====" already separates table tests).
docs/architecture/workbook-runtime-split-design.md:127:Public API surface (`pub use workbook_runtime::WorkbookRuntime`
docs/architecture/workbook-runtime-split-design.md:243:- Public API surface byte-for-byte identical (verify with
docs/architecture/workbook-runtime-split-design.md:259:- Changing `WorkbookRuntime`'s public API.
crates/ql-exec/src/workbook_runtime/mod.rs:50:// without changing the public API. Full per-step history with
docs/audits/2026-05-15-phase-4.9-closing-megaudit.md:151:- **`@` operator fingerprint stability (W5-143):** tag byte 13 is
docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:257:**Severity**: MEDIUM (documented behavior, but the public-API doc string says "on first failure abort the whole import", implying any error fails — users wanting strict will be surprised that an unknown-function formula evaluates to `Value::Error(Name)` which Strict considers success).
docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:377:## LOW-4 — `UnsupportedFeatureKind::Other("...")` variants leak strings across the API surface
docs/audits/2026-05-17-reference-tier-audit-summary.md:78:| **S1-LOW-1** | `contract_of(name)` doc reference | Update `register_reference_aware` doc-comment to match actual API (`lookup_reference_aware`). |
docs/audits/2026-05-17-reference-tier-audit-summary.md:132:| CellRef materializer reads value AND silently coerces `Value::Error` to `RefArg::Reference` | — | HIGH-2 | **HIGH** | Opus-only. Real error-propagation bug: `ROW(Sheet99!A1)` where Sheet99 missing returns `1` instead of `#REF!`. Reachability is low today (no `delete_sheet` API) but the gap is architectural. |
docs/audits/2026-05-17-reference-tier-audit-summary.md:134:| `ROWS`/`COLUMNS` u32 underflow on non-normalized Range | MED-1 | LOW-3 | **MEDIUM** | Codex's framing emphasizes public-API reachability. Take higher. |
docs/audits/2026-05-17-reference-tier-audit-summary.md:154:| **S2-MED-β** | u32 underflow on non-normalized Range | Range arithmetic already safe in v1 paths (binder normalizes via `Range::new`). Add defensive `checked_sub`-style guard in `rows`/`columns` impls OR add a debug_assert. Document the public-API risk for follow-up. |
docs/audits/2026-05-17-reference-tier-audit-summary.md:255:| Transaction::put_formula canonicalization divergence | — | S4-HIGH-1 | **HIGH** | Opus-only architectural finding. Two public producer APIs store text differently; design § 2.5 "canonical printer output" promise broken for one of them. |
docs/audits/2026-05-17-reference-tier-audit-summary.md:268:| **S4-HIGH-1** | `Transaction::put_formula` skips canonicalization | Document the divergence in `reference_fns.rs` doc-comment + `excel-matrix.md` row. **Option 3 (accept-and-document)** per Opus's recommendation — alignment fix is post-RT-V1. Both producer APIs preserve the leading-`=` invariant; only canonical-vs-raw stored text varies. |
docs/audits/2026-05-17-reference-tier-audit-summary.md:298:2. **Two producer APIs is one too many for a single canonical invariant.** `WorkbookRuntime::set_formula` canonicalizes; `WorkbookTransaction::put_formula` doesn't. Design § 2.5 wrote the canonical invariant assuming one API; reality has two. **Pattern signal:** when a design promises a "canonical X", audit ALL public producer APIs for X — not just the one named in the design.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:44:9eff03ca413  W5-141 / 4.9.D    print_with API + FormulaSite +          (+20)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:51:edb6b3714b8  W5-146 / 4.9.J/K  op-log + runtime APIs                   (+8)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:194:    `Op::SetLocale { De }` from the runtime-API calls. On load,
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:213:17. **`@` fingerprint stability.** W5-143 added fingerprint tag
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:275:- Do NOT propose breaking the schema-version range check.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:277:- Do NOT propose breaking the canonical-storage contract (design
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:417:### 4.3 Anchor-aware lex + parse + print API (closes Codex H-2 + Sonnet H-3/H-4)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:470:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:471:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:484:| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:835:./docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:184:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:836:./docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:185:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:840:./docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:198:| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:861:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:94:Any code that attempts to print a post-bind AST (where `SheetRef::Name` has been resolved to `SheetRef::Id` by the binder) will panic. The rename rewrite round-trip in `workbook_runtime.rs:85–108` correctly uses a pre-bind parse (never binds before printing), so the panic is not triggered in the current happy path. However, this is a latent footgun for any future caller that binds then prints. The design acknowledges this with a "future `print_with_resolver` API" note, but no tracking issue exists. Severity: MEDIUM (no current crash path, but the API is a trap for future contributors).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:862:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:297:- The design's `print_with_resolver` API is not implemented (future work, acknowledged).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:863:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:322:The rename rewrite round-trip does not trigger this because it never binds before printing. However, the footgun is real: any future code that binds a formula (converting `Name` → `Id`) then attempts to print the AST will panic. Options: (a) implement `print_with_resolver` API that takes a `SheetId → &str` resolver, or (b) add a `#[doc(hidden)]` warning and a prominent comment on `print_sheet_prefix` noting the `Id` panic, and file a tracking issue. For W5-93 close, (b) is acceptable.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:864:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-sonnet.md:339:The criterion says "cross-sheet cell refs parse, print, bind, and recompute." The `print` direction from a post-bind AST panics. Either scope down the criterion to "pre-bind print" or track the `print_with_resolver` API as a follow-up under XS-4-01. An explicit statement in the MASTER-PLAN that `print` is scoped to pre-bind ASTs would close this interpretive gap.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:870:./docs/architecture/calcgraph-runtime.md:109:- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:886:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:44:9eff03ca413  W5-141 / 4.9.D    print_with API + FormulaSite +          (+20)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:914:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:194:    `Op::SetLocale { De }` from the runtime-API calls. On load,
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:970:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:470:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:971:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:471:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:975:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:484:| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1430:./docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2538:   182	| 11 | **4.9.K** | `WorkbookRuntime::set_reference_mode` + `set_locale` API; canonical-storage contract per § 4.4 wired into `set_formula` |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1434:./docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2551:   195	| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1731:./docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:376:names). No locale-switching API exists. This is intentional V1 scope; not
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1793:./docs/audits/2026-05-13-codex-graph-decision-review.txt:667:- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1824:./docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4872:   103	             resolver-aware print_with_resolver(expr, &workbook) API is \
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1864:./docs/audits/2026-05-13-phase-4.5-closing-megaudit-codex.txt:294:     4.5.D/E, actual AST/API shape, qbook schema v4, locale-hints deferral, and
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1943:./docs/audits/2026-05-13-session-final-megaudit-codex.txt:2552:- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2008:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3179:    74	/// `print_with_resolver(expr, id_to_name)` API will handle that path).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2009:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3188:    83	            "print: SheetRef::Id({id}) requires a sheet-name resolver — use a future print_with_resolver API"
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2034:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8555:docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3179:    74	/// `print_with_resolver(expr, id_to_name)` API will handle that path).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2035:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8557:docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:3188:    83	            "print: SheetRef::Id({id}) requires a sheet-name resolver — use a future print_with_resolver API"
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2036:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8628:crates/ql-formula-syntax/src/printer.rs:74:/// `print_with_resolver(expr, id_to_name)` API will handle that path).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2037:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8630:crates/ql-formula-syntax/src/printer.rs:83:            "print: SheetRef::Id({id}) requires a sheet-name resolver — use a future print_with_resolver API"
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2059:./docs/audits/2026-05-13-finalization-planning-codex.txt:1260:   109	- ✅ **Topological recompute (Phase 3.4 / W5-37):** `WorkbookRuntime::recompute_dirty()` runs the Phase 0 W3-3 iterative Tarjan over the dirty set. `sorted` goes through the PlanCache evaluator; `cycled` gets `Value::Error(ErrorValue::Circ)`. `recompute_all` stays as the full-pass legacy entry point (`GAP-R-01` retargeted to Phase 6.1 for the API rename decision).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2204:./crates/ql-formula-syntax/src/printer.rs:80:/// public API; callers configure via `print_with(...)` args.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2239:./crates/ql-formula-syntax/src/printer.rs:325:             resolver-aware print_with_resolver(expr, &workbook) API is \
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2558:./docs/audits/2026-05-15-phase-4.9-design-review-codex.md:330:   145	2. **Relative R1C1 resolution timing** — `R[-1]C` is relative to the formula's owning cell. Resolve at parse-time (parser needs owning-cell context, breaking parser purity) OR bind-time (parser emits a `Relative` marker the binder resolves). Phase 4.8.E shipped `BindSite` plumbing — bind-time resolution matches that pattern.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2588:./docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8619:   103	             resolver-aware print_with_resolver(expr, &workbook) API is \
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2853:./docs/audits/2026-05-15-phase-4.9-design-review-codex.md:11611:HIGH: [doc §5 lines 123-124](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:123) treats R1C1 parse/print as A1-canonical without specifying formula-cell context, but relative R1C1 printing cannot be reconstructed from `Expr` alone. Fix: add an anchor-aware API, e.g. `parse_with_site(..., FormulaSite)` for R1C1 input and `print_with_site(expr, mode, locale, FormulaSite)` for R1C1 output.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:2868:./docs/audits/2026-05-15-phase-4.9-design-review-codex.md:11651:HIGH: [doc §5 lines 123-124](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:123) treats R1C1 parse/print as A1-canonical without specifying formula-cell context, but relative R1C1 printing cannot be reconstructed from `Expr` alone. Fix: add an anchor-aware API, e.g. `parse_with_site(..., FormulaSite)` for R1C1 input and `print_with_site(expr, mode, locale, FormulaSite)` for R1C1 output.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:3864:    80	/// public API; callers configure via `print_with(...)` args.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:3902:   118	/// **Locale**: parameter is accepted today for signature stability
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:4607:   338	/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6446:crates/ql-storage/src/workbook.rs:715:    /// if no anchor was registered at the cell. Friendlier API for the
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9132:   267	/// could be renamed without breaking on-disk op-log files).
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9248:    37	//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9251:    40	//! avoids a breaking signature change in 2A.3.b/c when the eval path
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10253:   715	    /// if no anchor was registered at the cell. Friendlier API for the
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:10273:   735	    /// layer's public read API. Any host code that bypasses `WorkbookEnv`
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:11971:   184	| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:11972:   185	| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:12006:   182	            // for stability) + the spec subtree's debug representation
docs/audits/2026-05-13-w5-68-codex-dates-prompt.md:106:2. The `set_test_now_secs(unix_secs)` test API — does the upgrade affect deterministic-RNG-seed tests in Phase 3.7's volatile suite? Probably not (those use the same Unix-secs path).
crates/ql-exec/src/lib.rs:50://!   `WorkbookTransaction` multi-cell batch API with eager validation,
crates/ql-exec/src/lib.rs:76://! Pre-0.2.0 the public API surface is in flux. Error enums
crates/ql-exec/src/lib.rs:99://! - `workbook_runtime::tables` — table mutation API.
crates/ql-exec/src/lib.rs:100://! - `workbook_runtime::sheets` — sheet mutation API.
crates/ql-exec/src/lib.rs:106://! Public API is unchanged: every method stays on `WorkbookRuntime`
docs/audits/2026-05-17-rt-step-4-opus.md:29:The HIGH-D pre-review closure RESOLVED source-text retention by asserting `Workbook::formula_at` always returns canonical printer output (per `parse → print_with(...EnUs...)` at `workbook_runtime.rs:573`). This is true for **`WorkbookRuntime::set_formula`** only. For **`WorkbookTransaction::put_formula`** (a public producer API used in test infrastructure and intended for paste-block / batch writes per `transaction.rs:5-78`):
docs/audits/2026-05-17-rt-step-4-opus.md:44:Same formula, two different FORMULATEXT outputs depending on the producer API. The design § 2.5 promise ("canonicalized A1/EnUs printer output") is violated by the Transaction path.
docs/audits/2026-05-17-rt-step-4-opus.md:52:2. **Canonicalize at `Transaction::put_formula`**: parallel the `WorkbookRuntime::set_formula` flow — call `print_with` on the parsed AST and store canonical text. Cost: one print_with per buffered op, dropped on raw text. Aligns the two producer APIs.
docs/audits/2026-05-17-rt-step-4-opus.md:53:3. **Re-document the divergence**: accept that FORMULATEXT returns "whatever's stored" and explicitly note in design § 2.5 + module docs that Transaction-API users get raw text. This is the cheapest fix but contradicts the HIGH-D closure framing.
docs/audits/2026-05-17-rt-step-4-opus.md:57:**Severity rationale:** real user-visible divergence in a documented contract. The design doc says canonical; the impl breaks that promise for one of two public producer APIs. Not a wrong-result crash, but a contract violation. Step 4 closes the mini-phase; this gap should be resolved or explicitly accepted with updated docs.
docs/audits/2026-05-17-rt-step-4-opus.md:357:**Recommendation:** Add a one-line explanation: "Storage-level tests use `Workbook` directly in `reference_fns_step4_e2e.rs` (ql-exec crate) — `ql-functions` can't depend on `ql-storage` without breaking the crate graph."
docs/audits/2026-05-17-rt-step-4-opus.md:371:**Severity rationale:** doc-comment gap on a `pub` API. LOW because the unwary caller is also doing something off-the-beaten-path.
docs/audits/2026-05-17-rt-step-4-opus.md:442:**Detail:** The row says "returns canonical formula text WITH leading `=` (Excel canon)" — which is the design-promise framing but doesn't acknowledge the producer-API divergence flagged in S4-HIGH-1.
docs/audits/2026-05-17-rt-step-4-opus.md:589:2. **Canonicalization promise depends on producer-API choice.** S4-HIGH-1 — `Workbook::formula_at`'s "canonical" contract is enforced by `WorkbookRuntime::set_formula` only. `WorkbookTransaction::put_formula` (a parallel public producer) bypasses canonicalization silently. Pattern signal: when a downstream contract (FORMULATEXT canonical output) is verified against ONE producer, audit ALL producers reaching the same storage state.
crates/ql-exec/src/workbook_runtime/sheets.rs:1://! Sheet mutation API for `WorkbookRuntime`.
crates/ql-exec/src/workbook_runtime/sheets.rs:142:    /// breaking otherwise-recoverable workbooks at rename time.
docs/audits/2026-05-17-rt-step-2-codex.md:54:So an API caller, loader path, or test can register an inverted range such as `start_row = 10, end_row = 0`. `ROWS(MyBadRange)` then panics in debug builds or wraps to a huge count in release builds.
docs/audits/2026-05-17-rt-step-2-codex.md:65:MEDIUM because normal parsed A1 ranges are safe, but the public API does not actually enforce the invariant the Step 2 arithmetic relies on. If qbook import or external host code can feed raw `Range` structs, this becomes a user-visible wrong result or panic.
docs/audits/2026-05-17-w5-d-6-opus.md:161:5. **`Result<f64, ErrorValue>` return type from `compute_covariance`** — only error path returned is `ErrorValue::Num` from the `is_finite` guard. The `Result` shape matches `compute_correl` for API symmetry within the file. No issue.
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:358:- Do NOT propose breaking the schema-version range check.
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:755:   278	/// **No mutation API in 4.8.A.** Direct `tables.insert` from the qbook
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:812:   335	    /// **Loader / mutation-internal API.** Insert a table by canonical
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1395:  1750	            // duplicate or empty column names breaking `lookup_column`.
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:1721:The main HIGH fix is present structurally: the helper uses `checked_add`, and producer/replay/load call it before the affected footprint walks. I’m now checking the load-side validations and the tests that make those paths reachable through normal APIs.
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:3355:  1478	    // ===== W5-118 (Phase 4.8.H) — table mutation API =====
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:4072:   Compiling ql-io v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io)
docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:4178:crates/ql-storage/src/workbook.rs:589:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
crates/ql-exec/src/env.rs:356:// removes a case-sensitivity footgun without breaking any happy path.
docs/audits/.codex-w5-d-5-prompt.md:52:1. **statrs API verification:**
docs/architecture/2026-05-14-array-formulas-and-spills.md:17:- **MEDIUM:** `SpillAnchorTable` map-only; overlay clearing in `Workbook` API. Binder returns `BindError`, not panic. Sub-phase order moved graph before runtime.
docs/architecture/2026-05-14-array-formulas-and-spills.md:33:- **Storage:** `ColumnStore::computed_overlays: Vec<SparseOverlay>` already exists (Phase 3.5, W5-38). `Sheet::put_computed` / `clear_computed` API in place. Read cascade is `user → computed → base`.
docs/architecture/2026-05-14-array-formulas-and-spills.md:541:- If 4.7.B function-ABI unification surfaces a deeper API problem, halt and re-design.
crates/ql-exec/src/plan.rs:359:/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:217:### 4.3 Anchor-aware lex + parse + print API (closes Codex H-2 + Sonnet H-3/H-4)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:270:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:271:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:284:| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:423:docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:184:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:424:docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:185:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:881:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:44:9eff03ca413  W5-141 / 4.9.D    print_with API + FormulaSite +          (+20)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:886:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:51:edb6b3714b8  W5-146 / 4.9.J/K  op-log + runtime APIs                   (+8)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:929:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:470:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:930:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:471:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:959:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:835:./docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:184:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:960:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:836:./docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:185:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:974:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:886:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:44:9eff03ca413  W5-141 / 4.9.D    print_with API + FormulaSite +          (+20)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:993:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:970:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:470:| 10 | **4.9.J** (W5-146, shipped) | Op log: `Op::SetReferenceMode { mode: ReferenceModeWire }` + `Op::SetLocale { locale: LocaleWire }` variants in `ql-oplog::op`. Replay arms call `Workbook::set_reference_mode` / `Workbook::set_locale`. **Custom `LocaleWire` deserializer** matches the W5-145 qbook v7 pattern: unknown strings captured to `LocaleWire::Unknown(s)`, surfaced via new `ReplayError::UnknownLocale { index, found }` (closes Sonnet L-10). Wire types `ReferenceModeWire` / `LocaleWire` re-exported from `ql_oplog::` for use by the runtime API and downstream consumers. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:994:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:971:./docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:471:| 11 | **4.9.K** (W5-146 runtime APIs + W5-147 canonical wiring, both shipped) | **W5-146 runtime APIs**: `WorkbookRuntime::set_reference_mode(mode)` + `set_locale(locale)` append `Op::SetReferenceMode` / `Op::SetLocale` (idempotent — setting to the current value emits no op). **W5-147 canonical-storage wiring** (the remaining § 4.4 piece): `set_formula(text)` now reads `wb.reference_mode()` + `wb.locale()`, lexes via `lex_with`, parses, then `print_with(&expr, A1, EnUs, Some(FormulaSite::at_cell(addr)))` to produce canonical (A1+EnUs) text. Cache key, op-log `PutFormula`, and `Workbook::put_formula` all receive the canonical form. New `RuntimeError::Print(PrintError)` variant for completeness. The recompute path uses `lex_with(.., A1, EnUs)` (matches canonical storage assumption). 2 prior tests + 1 integration test updated to reflect canonical-uppercase NameRef behavior (parser canonicalizes identifiers per Excel canon, now visible in stored text). +4 new tests: R1C1 input → `$A$1` storage; relative R[-1]C at (1,0) → `A1`; DE `SUM(2,5; 3,5)` → `SUM(2.5, 3.5)`; `@A1` preserved through canonicalization. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1047:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1430:./docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2538:   182	| 11 | **4.9.K** | `WorkbookRuntime::set_reference_mode` + `set_locale` API; canonical-storage contract per § 4.4 wired into `set_formula` |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1534:9eff03ca413  W5-141 / 4.9.D    print_with API + FormulaSite +          (+20)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1541:edb6b3714b8  W5-146 / 4.9.J/K  op-log + runtime APIs                   (+8)
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1684:    `Op::SetLocale { De }` from the runtime-API calls. On load,
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1703:17. **`@` fingerprint stability.** W5-143 added fingerprint tag
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1845:   338	/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:3578:crates/ql-exec/src/workbook_runtime.rs:5867:            // workbook API which doesn't populate the session cache.
crates/ql-exec/src/workbook_runtime/config.rs:89:    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
docs/audits/2026-05-17-rt-step-3-codex.md:42:Do not use the referenced cell's value error as the validity signal for a reference. Either produce `RefArg::Reference { address, value }` even when `value` is an error, or add a separate env/reference validation API so missing-sheet stale refs can still surface `#REF!` without treating ordinary error-valued cells as invalid refs. Add tests for `ISFORMULA(A1)` where A1 is a literal error and where A1 is a formula returning an error.
docs/audits/2026-05-19-phase-5-1-opus.md:17:and `formats.rs:51`). Switching to UUID is a schema-breaking change.
docs/audits/2026-05-12-megaudit-cycle3.md:38:| `Workbook::read` still returns Blank for missing sheet — H6 fixed eval path, not read API |   |   |   | ✓ |
docs/audits/2026-05-12-megaudit-cycle3.md:96:**Agent C finding.** H6 was closed at the evaluator layer (`env.rs:38-51`). But `Workbook::read` (`workbook.rs:260-265`) — the public storage read API — still maps missing-sheet to `Blank`. Production formula eval correctly returns `#REF!`; direct public read returns the silent fallback.
docs/audits/2026-05-12-megaudit-cycle3.md:98:**Fix**: align `Workbook::read` with `WorkbookEnv::read_cell` (return `Value::Error(ErrorValue::Ref)` for missing sheet). Or add a `// CAUTION` doc that the storage API is "trusted callers only."
docs/audits/2026-05-12-megaudit-cycle3.md:136:**Agent A finding.** `recompute_all`'s direct `put_at` bypasses `validate_cell`. Sheet IDs in `formula_cells` are populated via `put_formula`, which doesn't validate. In practice safe today (no `remove_sheet` API), but the assumption is undocumented.
docs/audits/2026-05-12-megaudit-cycle3.md:177:- **API surface ergonomics** for the new public types: mostly fine; CC-M1/L9 (ql-io re-exports) is the only active gap.
docs/audits/.codex-w5170-megaudit-prompt.md:36:3. **Numerical stability** — RATE / IRR use Newton-Raphson. Specific concerns:
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:253:### Tier 3 — API hygiene + dead code
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:255:#### H-CONS-18: `XlsxPreservation.known_parts` is dead in the public API
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:266:- Fix: remove the variant (technically a breaking change to an
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:317:| **W5-D-PM-5** (API + docs hygiene) | H-CONS-18, 19, 20 | known_parts deprecation, Reconciliation removal, doc drift |
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:334:- Public API stability commitments: types in `pub use` blocks are
docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:359:- Table-id stability across round-trips.
docs/audits/2026-05-13-session-final-megaudit-sonnet.md:94:`"Use the Agent tool with subagent_type: 'general-purpose' and model: 'sonnet'."` This refers to an internal tool API that may not be stable across Claude Code versions. The reference is a gotcha for future sessions if the tool API changes. Suggest augmenting to say "or equivalent Sonnet-dispatch mechanism per current Claude Code docs."
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:3:Scope: architecture, module structure, technical debt, v2 upgrade-path, public API stability, documentation correctness, test architecture, cross-crate boundary discipline, build-time concerns. Out of scope (covered by other auditors): OOXML schema details (Codex), round-trip invariants (Opus-A), adversarial inputs (Opus-B), audit-trail integrity (self).
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:42:### HIGH-2 — `XlsxPreservation.known_parts` is dead code in the public API
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:58:**Severity:** HIGH because it's already in the public API. Trapped now means breaking later.
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:66:**Severity:** HIGH because the public enum is a stability surface.
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:237:`pub fn import_xlsx_bytes` at `lib.rs:112-290` is 178 lines. It orchestrates 12 distinct phases (W5-D-14b Phase 0 → Phase 4) inline. While each phase is well-commented, the sequential dispatch is logic that doesn't belong at the public API layer — it should live in `read::pipeline::import` or similar so `lib.rs` reads as a thin facade.
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:245:1. **`XlsxPreservation.known_parts` dead field** (HIGH-2) — public API drag; cheaper to fix before v1 ships than to deprecate later.
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:247:3. **`XlsxError::Reconciliation` dead variant** (HIGH-3) — public enum stability concern; cheap to address now.
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:259:## Public API stability commitments
docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:285:- HIGH-2 / HIGH-3 (dead public API surface) are unlikely to surface in Opus-A's round-trip checks (the fields aren't read or written) or Opus-B's adversarial inputs (they don't take input). Lifting them here is the right home.
docs/audits/2026-05-12-megaudit.md:36:12 issues had multi-agent corroboration. Highest confidence: **row/col validation gap** (3 agents) and **fingerprint stability** (2 agents, on a load-bearing Phase 4 invariant).
docs/audits/2026-05-12-megaudit.md:105:### H9 — `ql-exec` Phase 2A.1 public API (`bind_with_names`, `NameLookup`, `ResolvedName`) not re-exported from `lib.rs` ✅ CLOSED 2A.7
docs/audits/2026-05-12-megaudit.md:157:### API / structural
docs/audits/2026-05-13-phase-4.5-closing-megaudit-prompt.md:105:**F.5** format_cache stability: parsed FormatStrings live for the runtime's lifetime; cache only inserts (never invalidates).
docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:278:### F.2 — intern_format id prediction stability (PASS)
docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:300:### F.5 — format_cache stability (PASS)
docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:376:names). No locale-switching API exists. This is intentional V1 scope; not
docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:479:| F — Runtime | PASS | append-before-mutate, validation order, cache stability correct |
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:11:## Concern 1 — API coherence: naming conventions
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:20:One naming inconsistency with existing mutators: `register_spill` uses the verb "register" where the rest of the Workbook API uses "put" (`put_formula`, `put_at`, `put_computed_at`). Conversely, "clear" is already used for the complementary operation so `clear_spill_at` fits. The verb mismatch is minor because "register" signals multi-step setup (the map-only nature + lack of overlay writes) while "put" implies writing through to storage. The distinction is defensible and the docstring makes it explicit. File as LOW polish.
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:24:**Suggested fix (LOW, deferred):** Consider renaming `register_spill` → `put_spill` for consistency with the put/clear verb pair across the API. Or document the deliberate verb choice ("register = map-only, no overlay") in the method doc — the current doc does say "Map-only" but doesn't frame it as a naming rationale.
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:28:## Concern 2 — API coherence: coordinate-arg style (TUPLE vs separate args)
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:32:This is the most concrete API inconsistency in the commit. The **mutating** spill methods take the anchor as a single `(SheetId, RowId, ColId)` tuple:
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:59:The tuple style is inherited from `SpillAnchorTable::register(anchor, shape)` where the tuple is motivated by carrying the anchor as a conceptual unit. That's fine for the storage-layer type, but the Workbook facade should normalize to the existing API style.
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:144:**LOW note:** an idempotent `clear_spill_if_present` convenience would reduce the chance of the runtime author omitting the pre-check. Currently the design relies on documentation. This is acceptable for a storage-layer API where pre-checking is cheap (one HashMap lookup) and the error type is named `SpillNotFoundError` (not `SpillError`), which somewhat signals "this shouldn't happen unexpectedly." File as LOW / ergonomic polish.
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:168:Design § 7.2 Workbook API specifies: `spill_anchors()`, `spill_anchor_at()`, `spill_target_anchor()`, `register_spill()`, `clear_spill_at()`. All five are present.
docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:208:All PASS items (Default, Clone, design § 7 match, encapsulation, re-eval idiom doc) are solid. The two MEDIUM items are API-surface issues that will compound at Phase 4.7.J if not resolved beforehand.
docs/audits/2026-05-17-w5-d-2-codex.md:63:dotted function name if printer stability matters.
docs/audits/2026-05-17-w5-d-2-codex.md:116:- `StudentsT::new(location, scale, freedom)` is the correct statrs 0.18.0 API,
docs/audits/.codex-w5-d-3-prompt.md:50:1. **statrs API verification:** `ChiSquared::new(df)` and
docs/audits/.codex-w5-d-3-prompt.md:54:   (survival function) directly for numerical stability vs
docs/audits/2026-05-17-w5-d-9-opus.md:57:  Without these, ANY future refactor of `lex_ident_or_ref` risks silently breaking the W5-D-9 path. The whole motivation for this branch was that "before W5-D-9, DEC2BIN was a `Trailing { count }` parser error". A test pinning that the NEW path emits `Token::Ident` is the natural regression guard.
docs/audits/2026-05-13-session-final-megaudit-prompt.md:57:crates/ql-calcgraph/src/graph.rs                  # Graph revocation API
docs/audits/2026-05-18-phase-4-11-megaudit-self.md:139:  - Table-id stability across round-trips
docs/audits/2026-05-18-phase-4-11-megaudit-self.md:157:  in the public API. The doc says "Map from OOXML part path →
docs/audits/2026-05-18-phase-4-11-megaudit-self.md:163:  API. Either we wire it (would be useful for UpdateOriginal to skip
docs/audits/2026-05-18-phase-4-11-megaudit-self.md:165:- Suggested fix: either remove (breaking but cleaner), or document
docs/audits/2026-05-17-w5-d-3-codex.md:8:No HIGH or MEDIUM runtime correctness findings found. The eight new functions use the expected `statrs 0.18.0` APIs:
docs/audits/2026-05-18-w5-d-14-codex.md:31:**Recommendation:** Use umya's formula-result API that does not clear formulas (`set_formula_result_default` / equivalent), or build a `CellValue` that sets formula and cached raw value without calling the public value setters. Add a tracked test for formula + cached number, bool, text, error, and blank cache.
docs/audits/2026-05-18-w5-d-14-codex.md:77:**Detail:** `Value::Error(e)` is written with `cell.set_value_string(e.sigil())`. That forces an OOXML string cell. A compiled probe re-imported `Value::Error(ErrorValue::DivZero)` as `Value::Text("#DIV/0!")`. The code comment says umya will produce `t="e"`, but the API being called is the string setter; umya has separate typed/error-guessing paths.
docs/audits/2026-05-18-w5-d-14-codex.md:151:**Detail:** `recompute_loaded_workbook` calls `WorkbookRuntime::recompute_all()` directly. It translates returned failures into `FormulaImportFailure`, but if the runtime panics on an adversarial formula or engine bug, the panic propagates through the import API. That contradicts the "BestEffort reports failures and keeps imported cached values" behavior.
docs/audits/2026-05-18-w5-d-14-codex.md:277:**Severity rationale:** This is mostly API/documentation drift while `UpdateOriginal` remains unimplemented.
docs/audits/2026-05-18-w5-d-14-codex.md:285:**Detail:** A probe exporting `Workbook::new()` returned `Ok` and re-imported as a zero-sheet workbook. Excel workbooks normally require at least one sheet, and the current API does not say whether zero-sheet xlsx output is valid or intentionally supported.
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:67:- `Locale::default()` still returns `EnUs` — no breaking change.
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:290:crates/ql-storage/src/workbook.rs:244:/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:1818:   276	    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:1997:   237	/// Arrow buffers. This is safe today because the only mutating APIs
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2004:   244	/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2162:   131	### 4.3 Anchor-aware lex + parse + print API (closes Codex H-2 + Sonnet H-3/H-4)
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2208:crates/ql-storage/src/tables.rs:278:/// **No mutation API in 4.8.A.** Direct `tables.insert` from the qbook
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2538:   182	| 11 | **4.9.K** | `WorkbookRuntime::set_reference_mode` + `set_locale` API; canonical-storage contract per § 4.4 wired into `set_formula` |
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:2551:   195	| Q2 Relative R1C1 timing | Bind-time. Intermediate AST carries offsets + abs/rel markers. Anchor required at print-time too (§ 4.3 API). Codex + Sonnet agree. |
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3452:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:4329:   404	            // round-trip stability.
docs/audits/2026-05-14-phase-4.7.D-sonnet-review.md:215:## 5. Fingerprint stability
docs/audits/2026-05-14-phase-4.7.D-sonnet-review.md:241:`ev.sigil().hash(h)` hashes the sigil string (e.g. `"#REF!"`, `"#N/A"`). Adding a new `ErrorValue` variant later would not shift the fingerprint of any existing error value, provided the new variant is not interleaved among existing sigils. This is a sound design choice — it gives sigil-value stability rather than discriminant-value stability, which is harder to guarantee across codebase evolution.
docs/audits/2026-05-12-phase-2B.md:101:The two engine state types the Node-API / WASM bindings will own (`Workbook` + `OpLog`) had no compile-time proof that they were `Send + Sync`. A future Loro version regressing `LoroDoc`'s `Sync` impl, or a future Workbook field gaining an `Rc`, would only blow up when the binding crate tries to wrap them — exactly the wrong time to find out.
docs/audits/2026-05-12-phase-2B.md:107:#### H6 (filed) — `WorkbookRuntime<'a>` borrow shape incompatible with Node-API object lifetimes
docs/audits/2026-05-12-phase-2B.md:111:Node-API can't safely stash a struct with lifetime parameters inside a JS-visible object. Phase 6.3 binding work needs a `WorkbookSession` type that owns wb + oplog + registry without lifetimes. This is **Engine Phase 6.1** scope per MASTER-PLAN ("Stable Engine Session API").
docs/audits/2026-05-12-phase-2B.md:119:- **No cancellation API on `recompute_all`** (IDE-shape M5). Phase 6.1 work. **Filed as GAP-I-05.**
docs/audits/2026-05-12-phase-2B.md:172:**Phase 6.3 (Node-API / WASM bindings):**
docs/audits/2026-05-13-codex-graph-decision-prompt.md:36:- **GAP-G-01 fix → Option A only.** Add per-formula revocation API to Graph + StripeIndex; call it at extract_and_register_deps entry. The current `remove_formula_deps` at `calcgraph_session.rs:525` already cleans session-side reverse indices but explicitly does NOT touch graph edges / stripes ("Does NOT touch the Phase 0 `Graph`'s stripe state or edges (append-only contract)"). Extend it.
docs/audits/2026-05-13-codex-graph-decision-prompt.md:42:- **Combined A + C is the minimum surgical correctness fix.** Estimated 1 session for A (mostly mechanical: APIs + reverse lookup + wire into extract_and_register_deps + regression tests for the H3/H4 examples), 0.5-1 session for C (single Tarjan-input augmentation pass + regression tests for the H1 examples). Total ~1-1.5 sessions of implementation.
docs/audits/2026-05-13-codex-graph-decision-prompt.md:54:3. **Is the Option A revocation API the smallest correct change to `Graph`?** Concretely: should `Graph::clear_outgoing(node)` also walk each former target's `incoming[target]` to remove the back-pointer? (Yes, for symmetry — but is the linear scan acceptable? Most cell formulas have ≤4 outgoing edges so the per-rebind cost is `Σ over edges of O(in_degree(target))`. For a heavy DAG with high in-degree nodes that could be costly — but how often does rebind hit such nodes?) What about determinism — `Vec` preserves insertion order, but after `clear_outgoing + re-extract` the new edges may be in a different order if the binder pass yields a different walk order; is that observable downstream? (My read: Tarjan's output ordering depends on insertion order via dfs_stack scan order — so yes, observable. But re-extract from the SAME plan should produce the SAME walk order, so as long as Plan→deps extraction is deterministic, the new edge order matches the old.)
docs/audits/2026-05-13-codex-graph-decision-prompt.md:57:   - Mark edges with a per-formula epoch counter; sweep stale-epoch edges at scheduler time. Avoids removal API but adds epoch metadata to every edge.
docs/audits/2026-05-15-w5155-audit-codex.md:2011:  2978	        // instead of silently breaking. After the loop, if `iter_count`
docs/audits/2026-05-15-w5155-audit-codex.md:2638:    37	//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-15-w5155-audit-codex.md:2641:    40	//! avoids a breaking signature change in 2A.3.b/c when the eval path
docs/audits/2026-05-15-w5155-audit-codex.md:3088:   335	    /// **Loader / mutation-internal API.** Insert a table by canonical
docs/audits/2026-05-13-w5-49-50-51-megaudit-sonnet.md:5:W5-50 is the most important commit and its core correctness logic is sound: the Graph revocation APIs (`clear_outgoing`, `clear_range_deps_for_formula`), the StripeIndex reverse index, and the Tarjan supplemental adjacency all implement the W5-49 decision faithfully. The H3/H4/H1 scenario tests are genuine and pass. However, there is one confirmed HIGH bug: `on_clear_formula` calls `remove_formula_deps` but NOT `graph.clear_outgoing` or `graph.clear_range_deps_for_formula`, leaving stale graph edges and stripe entries behind whenever a formula cell is cleared (rather than rebound). This is the same class of staleness that W5-50 was specifically built to fix — and it was missed for the clear path. W5-51 (trig batch) is correct but has a doc-title error in the `atan2` rustdoc (says `ATAN2(y, x)` in the signature line but the implementation and tests use the correct `(x, y)` Excel order). W5-49 is a decision doc and its claims about Codex effort estimates are honest. No false cycles, no determinism breaks, and no test-count fraud were found, though per-file counts in commit messages have minor off-by-one errors that net to zero.
docs/audits/2026-05-18-tier-d1-consolidated.md:97:- **L-5**: pure table API tests
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:2:## Architecture / public API / persistence across the whole engine
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:4:Scope per the design doc (`docs/audits/2026-05-18-phase-4-12-megaudit-design.md` §97-112): cross-crate dependency map, public-API stability per crate, error taxonomy across crates, `.qbook` persistence forward/back compat, test architecture across crates, crate build hygiene, documentation coherence. Out of scope: function correctness (Codex), cross-feature integration (Opus-A), defensive/fuzz (Opus-B), audit-trail (self).
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:16:1. **Public-API stability commitments**. ONE enum in the workspace carries `#[non_exhaustive]` today (`ql_functions::format::V2Token`). Every other public enum — `ErrorValue`, `Value`, `BindError`, `RuntimeError`, `QbookError`, `OpLogError`, `ReplayError`, `XlsxError`, `UnsupportedFeatureKind`, `PersistenceError`, `NameTableError`, `SheetNameError`, `TotalsFunction`, `LexError`, `ParseError`, `PrintError`, `FormatParseError`, `SimdShape`, `ReferenceMode`, `Locale`, `DateSystem` — is open to break callers on every variant addition. The Phase 4.11 Opus-C recommendation (add `#[non_exhaustive]` to xlsx enums before 0.2) needs to extend to the whole workspace.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:73:**Severity:** HIGH because Phase 4.12's compatibility-freeze acceptance criterion (A4-02) calls out "complete enough to guide users" — the API stability story is the user-visible half of that.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:241:> 2A.3.a's replay doesn't use it (formula evaluation is deferred to a separate `recompute_all` call), but keeping the parameter stable here avoids a breaking signature change in 2A.3.b/c when the eval path could land inside replay.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:259:The Phase 4.11 Opus-C HIGH-3 recommended REMOVE (`docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:60-66`). The closure chose deprecation instead. Per the comment at line 75, the variant will be removed in 0.2.0.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:267:**Action:** in 0.2.0 close, drop `Reconciliation`. Per HIGH-1, mark `XlsxError` `#[non_exhaustive]` at the same time so future additions are non-breaking.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:284:Four symbols of six are leakage. `lex_with` and `column_letters_to_index` may be intentional API surface for future consumers; today they're dead exposure.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:286:**Action:** either (a) demote unused symbols to `pub(crate)`, or (b) document them as deliberate API surface in the lib.rs doc-comment. My preference is (a) — the v0.x crate has no external SemVer commitment yet.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:365:### MEDIUM-11 — `ql-exec`'s public surface has no documented stability story
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:369:By the API-surface census:
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:380:**Recommendation:** before Phase 5, write a `docs/architecture/ql-exec-public-api.md` that classifies every `pub use` from `ql-exec/src/lib.rs:87-117` as Stable / Provisional / Deprecated / Internal. Move internal-only ones to `pub(crate)`. The result is the stability story that Phase 6.1 (`WorkbookSession`) will harden.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:394:### MEDIUM-13 — `ql-storage::Workbook` is the "god struct" but its public surface is reasonable; concern is testability
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:535:Loro is the Phase 5 substrate per T1-D05. We're on 1.12.0 today; Loro just (2026-05) hit 1.x stability per its release notes. The major-version stability is reassuring. The audit-relevant fact: every Loro minor bump may change the on-disk snapshot format. Per HIGH-4 (no engine-level magic bytes), a Loro 2.0 upgrade is a wire-breaking change with no soft landing.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:559:**Versioning:** none at the engine level. Relies on Loro 1.x snapshot stability.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:561:**Verdict:** **NOT ready for v2.** Phase 5 will reshape the op model (CRDT merge needs peer-aware ops). With no magic-bytes / version-probe at the wrapping level, evolution is harder than `.qbook/` — every change requires either a Loro container rename (`OPS_CONTAINER` per `log.rs:34`) or breaking the on-disk format.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:567:## Public API stability commitments per crate
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:569:Recommendation set, applied workspace-wide. **None of these break callers today** because no crate is tagged 0.2+; all are 0.1.0.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:712:### Public-API surfaces
docs/audits/2026-05-17-reference-tier-design-codex.md:43:**Recommendation:** Define `ReferenceQuery::formula_text_at` as an Excel-facing API that returns the canonical formula with leading `=`, or have `FORMULATEXT` prepend `=` at the function boundary. Document that Quantbook returns canonical A1/En-US printer text, not the exact raw user input.
docs/audits/2026-05-17-reference-tier-design-codex.md:141:**Detail:** The sketch uses `range.top`, `range.left`, `range.bottom`, `range.right`, but `Range` exposes `start_row`, `start_col`, `end_row`, `end_col` plus `top_left()`/`bottom_right()`. It also uses `Value::error`, `ErrorValue::NotApplicable`, and `ErrorValue::Na`, but the real API is `Value::Error(...)` and `ErrorValue::NA`.
docs/audits/2026-05-15-phase-4.9-closing-megaudit-sonnet.md:241:- **`@` operator fingerprint stability (W5-143):** tag byte 13 doesn't
docs/audits/2026-05-17-w5-d-3-opus.md:322:  (CHISQ.DIST.RT uses `sf` for numerical stability; F.DIST.RT uses
docs/audits/2026-05-17-reference-tier-design-opus.md:257:**Severity rationale.** MEDIUM because it works as designed; just duplicates an existing API. Implementation cost: low if caught now, more if it ships with the redundant method and we have two ways to ask "what cell?". Keep the env surface minimal.
docs/audits/2026-05-17-reference-tier-design-opus.md:335:**Detail.** The design § 5.5 offers two shapes for the workbook-introspection API:
docs/audits/2026-05-17-reference-tier-design-opus.md:531:### LOW-3 — § 5.6 pseudocode uses `Value::error(ErrorValue::Value)` but actual API is `Value::Error(ErrorValue::Value)` (capital E)
docs/audits/2026-05-17-reference-tier-design-opus.md:533:**Where:** Design § 5.6 throughout; the API is `Value::Error(ErrorValue::Value)` (variant of the `Value` enum), not `Value::error(...)`.
docs/audits/2026-05-13-w5-49-50-51-megaudit-prompt.md:79:- Phase A.2 — Graph revocation APIs. ✓ shipped.
docs/audits/2026-05-13-w5-63-codex-coercion-prompt.md:82:3. **`NumericArg` enum vs `Result<Option<f64>, ErrorValue>`**: the doc proposes promoting `NumericArg` to public API. But `Result<Option<f64>, ErrorValue>` is the more standard Rust shape (Some=Number, None=Skip, Err=Error). Worth that signature instead?
docs/audits/2026-05-18-w5-d-14-opus.md:60:### H-1 — Exporter clobbers every formula it writes (umya API misuse)
docs/audits/2026-05-18-w5-d-14-opus.md:147:   verify the exact API (check `umya_spreadsheet::structs::WorkbookProperties::set_date1904`).
docs/audits/2026-05-18-w5-d-14-opus.md:189:   a Table API (`umya_spreadsheet::structs::Table`) — check.
docs/audits/2026-05-18-w5-d-14-opus.md:224:1. Wire `workbook.formats().iter()` into umya's stylesheet API. umya tracks
docs/audits/2026-05-18-w5-d-14-opus.md:225:   number formats via `StyleSheet::add_number_format` (verify exact API).
docs/audits/2026-05-18-w5-d-14-opus.md:259:**Recommendation:** Use umya's `set_error(sigil)` API
docs/audits/2026-05-18-w5-d-14-opus.md:270:3. Stop offering `Value::Error` round-trip in the public API contract.
docs/audits/2026-05-18-w5-d-14-opus.md:315:2. **Allow ALIAS registration** in `FormatTable` (a new API that maps a
docs/audits/2026-05-18-w5-d-14-opus.md:585:- Direct API: `crates/ql-storage/src/workbook.rs:830-853` (`put_formula`
docs/audits/2026-05-18-w5-d-14-opus.md:586:  doc says "formula body WITHOUT the leading `=`" but the API doesn't
docs/audits/2026-05-18-w5-d-14-opus.md:590:import strips `=` defensively. But the direct API `wb.put_formula(s, 0, 0, "=A1")`
docs/audits/2026-05-18-w5-d-14-opus.md:616:### M-3 — `convert.rs` uses `catch_unwind` when fallible API is available
docs/audits/2026-05-18-w5-d-14-opus.md:831:public API contains a dead field.
docs/audits/2026-05-18-w5-d-14-opus.md:834:the field until then. Public-API ergonomic.
docs/audits/2026-05-18-w5-d-14-opus.md:836:**Severity rationale:** Minor API hygiene.
docs/audits/2026-05-18-w5-d-14-opus.md:952:**Where:** Public API surface.
docs/audits/2026-05-18-w5-d-14-opus.md:1066:1. **Fix H-1 (formula clobber)** — single-line API order change in the
docs/audits/2026-05-17-reference-tier-pre-review-summary.md:73:**Closure (v2):** Remove § 8 R3 from open-risk list. Add the `ReferenceQuery::formula_text_at` Excel-facing API: `fn formula_text_at(...) -> Option<String>` returning `Some(format!("={}", canonical))` where `canonical` is `workbook.formula_at(sheet, row, col)?.as_ref()`. Documented divergence from raw-user-source (we return canonicalized, IronCalc returns canonicalized-English-no-spaces; both are non-verbatim). Documented in v2 § 2.5, § 5.5, § 5.6.
docs/audits/2026-05-17-reference-tier-pre-review-summary.md:131:| Codex LOW-1 / Opus HIGH-6 (RowId.0, ErrorValue::NotApplicable, range field names, Value::error) | **MEDIUM-class fix in v2 (per severity reconciliation):** rewrite all pseudo-code identifiers to match real API. |
docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:237:The Microsoft docs are somewhat ambiguous on BIN2DEC text input — the function signature says "number" but real Excel accepts text. IronCalc accepts text-form for all three. The engine's BIN2DEC is more strict than its siblings, breaking even simple usage like `=BIN2DEC("1010")` which would work in real Excel.
docs/audits/2026-05-17-rt-step-3-opus.md:57:> Note: today this path is unreachable from end-user formulas (the workbook runtime has no `delete_sheet` API and binder rejects unknown-sheet refs at bind time, not at eval).
docs/audits/2026-05-17-rt-step-1-codex.md:144:Subject: Registry doc comment references a nonexistent `contract_of(name)` API
docs/audits/2026-05-17-rt-step-1-codex.md:150:The `register_reference_aware` documentation says the dispatcher consults `contract_of(name)` to decide whether to materialize eagerly or lazily. No such API exists in the implementation. The contract is stored in `RegisteredFn::ReferenceAware(ReferenceAwareFn, ArgContract)` and is obtained through `lookup_any` or `lookup_reference_aware`.
docs/audits/2026-05-17-rt-step-1-codex.md:154:Update the comment to describe the actual API shape, or add a `contract_of` helper if that is still the intended public surface for future tests or dispatchers.
docs/audits/2026-05-19-phase-5-1-codex.md:250:    88	   `export_from(version_vector)` + `import` API.
docs/audits/2026-05-19-phase-5-1-codex.md:646:     3	//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
docs/audits/2026-05-19-phase-5-1-codex.md:912:     5	//! public API. Future variants (sheet renames, sheet deletes, formatting
docs/audits/2026-05-19-phase-5-1-codex.md:913:     6	//! changes) land alongside the API additions that produce them.
docs/audits/2026-05-19-phase-5-1-codex.md:1175:   268	/// could be renamed without breaking on-disk op-log files).
docs/audits/2026-05-19-phase-5-1-codex.md:1228:    37	//! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-19-phase-5-1-codex.md:1231:    40	//! avoids a breaking signature change in 2A.3.b/c when the eval path
docs/audits/2026-05-19-phase-5-1-codex.md:1484:   293	/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-19-phase-5-1-codex.md:1828:     1	//! Cell mutation API for `WorkbookRuntime`.
docs/audits/2026-05-19-phase-5-1-codex.md:2479:   288	        // instead of silently breaking. After the loop, if `iter_count`
docs/audits/2026-05-19-phase-5-1-codex.md:2556:     1	//! Format API for `WorkbookRuntime`.
docs/audits/2026-05-19-phase-5-1-codex.md:2780:     1	//! Sheet mutation API for `WorkbookRuntime`.
docs/audits/2026-05-19-phase-5-1-codex.md:2921:   142	    /// breaking otherwise-recoverable workbooks at rename time.
docs/audits/2026-05-19-phase-5-1-codex.md:3505:   376	            // so use the public(crate) `mark_dirty` API.
docs/audits/2026-05-19-phase-5-1-codex.md:8657:Loro’s public `push` is just `insert(len, value)`, so I’m tracing the internal list tracker rather than relying on the API name. The implementation points to Fugue-style list insertion with peer-id tiebreaking, not a simple “Lamport LWW” rule.
docs/audits/2026-05-19-phase-5-1-codex.md:9566:docs/phase2/entry-plan.md:163:2. `OpLog` API: `append(op)`, `iter()`, `len()`, replay-against-Workbook.
docs/audits/2026-05-19-phase-5-1-codex.md:9875:   761	    /// if no anchor was registered at the cell. Friendlier API for the
docs/audits/2026-05-19-phase-5-1-codex.md:9895:   781	    /// layer's public read API. Any host code that bypasses `WorkbookEnv`
docs/audits/2026-05-19-phase-5-1-codex.md:10141:    23	//! at the API level — it always returns a result. Load is the only
docs/audits/2026-05-19-phase-5-1-codex.md:10785:   356	// removes a case-sensitivity footgun without breaking any happy path.
docs/audits/2026-05-19-phase-5-1-codex.md:11220:   359	/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-17-w5-d-1-opus.md:444:**Severity rationale:** MEDIUM. The Cargo.toml comment makes a forward-looking promise that depends on statrs's feature stability. If we ship a Wave 3 cohort and a follow-on `statrs` patch (the project pins `=0.18.0` so this requires a deliberate bump) gates a distribution, the comment becomes a lie. Cheap to harden now.
docs/audits/2026-05-17-w5-d-1-opus.md:474:**Detail:** IronCalc pins `statrs = "0.18.0"` (semver-compatible, allowing 0.18.x patch updates). We pin `=0.18.0` (exact). This is intentional — our project-wide convention is `=X.Y.Z` strict pins for reproducibility — but the module docstring says "Both projects use the `statrs` crate (pinned to 0.18.0 across both)" implying parity. The pins are NOT exactly the same: ours is strict-equal, theirs is caret. If IronCalc upgrades to 0.18.5 and our `=0.18.0` doesn't, behavioral parity drifts the moment statrs ships a behavioral bugfix patch.
docs/audits/2026-05-13-phase-4.4-megaudit-sonnet.md:81:  'for free'"). But the public-API docstring users will read says "byte-for-
docs/audits/2026-05-13-phase-4.4-megaudit-sonnet.md:194:  not the central API. Diff-friendly, but stylistically odd.
docs/audits/2026-05-13-phase-4.4-megaudit-sonnet.md:248:no behavior introduced beyond the central API; verified by inspection. The
docs/audits/2026-05-13-phase-4.4-megaudit-sonnet.md:352:   internal API bug.
docs/audits/2026-05-13-phase-4.4-megaudit-sonnet.md:354:### G: Public API surface
docs/audits/2026-05-18-tier-c1-codex.md:560:3179:        // instead of silently breaking. After the loop, if `iter_count`
docs/audits/2026-05-18-tier-c1-codex.md:1194:4602:        // Regression guard for the existing public API.
docs/audits/2026-05-18-tier-c1-codex.md:1450:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-18-tier-c1-codex.md:1453:40://! avoids a breaking signature change in 2A.3.b/c when the eval path
docs/audits/2026-05-18-tier-c1-codex.md:1677:crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-18-tier-c1-codex.md:1678:crates/ql-oplog/src/replay.rs:293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-18-tier-c1-codex.md:1681:crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-18-tier-c1-codex.md:1682:crates/ql-oplog/src/replay.rs:293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-18-tier-c1-codex.md:2068:         // Regression guard for the existing public API.
docs/audits/2026-05-18-tier-c1-codex.md:2286:293:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-18-tier-c1-codex.md:3243:crates/ql-exec/src/calcgraph_session.rs:1910:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
docs/audits/2026-05-18-tier-c1-codex.md:3403:crates/ql-storage/src/workbook.rs:683:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
docs/audits/2026-05-18-tier-c1-codex.md:3728:crates/ql-storage/src/workbook.rs:6://!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
docs/audits/2026-05-18-tier-c1-codex.md:5444:669:    /// inert, but the parameter is part of the stable graph API).
docs/audits/2026-05-18-tier-c1-codex.md:5680:359:/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-18-tier-c1-codex.md:6704:451:    /// API surface.
docs/audits/2026-05-18-tier-c1-codex.md:7154:761:    /// if no anchor was registered at the cell. Friendlier API for the
docs/audits/2026-05-18-tier-c1-codex.md:7418:crates/ql-storage/src/workbook.rs:683:    // ===== W5-101 (Phase 4.7.H) spill-anchor API =====
docs/audits/2026-05-18-tier-c1-codex.md:8275:crates/ql-calcgraph/src/topo.rs:12://! 2. **Direct API for the Phase 0 cycle policy.** The spec's Phase 0 minimum: cycled
docs/audits/2026-05-18-tier-c1-codex.md:8830:5:Visual Studio Code is built with a layered architecture using TypeScript, web APIs and Electron, combining web technologies with native app capabilities. The codebase is organized into key architectural layers:
docs/audits/2026-05-18-tier-c1-codex.md:8849:24:  - `workbench/api/` - Extension host and VS Code API implementation
docs/audits/2026-05-18-tier-c1-codex.md:8866:41:Each extension follows the standard VS Code extension structure with `package.json`, TypeScript sources, and contribution points to extend the workbench through the Extension API.
docs/audits/2026-05-17-rt-step-1-opus.md:217:Alternatively, the design's `ArrayValue` constructor invariant requires `cells.len() == rows * cols`, so the shape can't be carried without the values via the current `ArrayValue` API. Leaving as-is is reasonable.
docs/audits/2026-05-17-rt-step-1-opus.md:431:For v1's ISREF, the collapse is fine — ISREF returns FALSE for all of these. But the PlanKind enum is a public-ish ABI (it's re-exported from ql-functions); adding a variant later is a breaking change for anyone who pattern-matched on it. Step 1 should over-specify, not under-specify.
docs/audits/2026-05-17-rt-step-1-opus.md:543:But: a future code path that constructs `ExprPlan::Function` directly (e.g., via test fixtures or programmatic API) could produce mixed-case names. The guard would silently miss them.
docs/audits/2026-05-18-phase-4-11-megaudit-design.md:82:- API consistency: every importable feature is also exportable?
docs/audits/2026-05-18-phase-4-11-megaudit-design.md:120:  `PartAction` enum support it cleanly, or will it require breaking
docs/audits/2026-05-18-phase-4-11-megaudit-design.md:122:- Public API stability: are the types exposed in `pub use` blocks
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:49:3. **Numerical stability** — RATE / IRR use Newton-Raphson. Specific concerns:
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1884:docs/audits/.codex-w5170-megaudit-prompt.md:36:3. **Numerical stability** — RATE / IRR use Newton-Raphson. Specific concerns:
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:2057:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:49:3. **Numerical stability** — RATE / IRR use Newton-Raphson. Specific concerns:
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6782:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6802:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6896:docs/audits/2026-05-13-engine-session-final-handoff.md:60:**Decision:** Option A (per-formula revocation API: `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index) + small Option C (`topo::schedule_with_supplemental` injecting temp `F→G` edges at recompute time for dirty formula pairs inside ranges). FormulaRegion binder (Option B) deferred to Phase 4.7.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7127:docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3452:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7153:crates/ql-formula-syntax/src/token.rs:19://! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7207:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7383:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7399:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7468:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7561:docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:24:**Suggested fix (LOW, deferred):** Consider renaming `register_spill` → `put_spill` for consistency with the put/clear verb pair across the API. Or document the deliberate verb choice ("register = map-only, no overlay") in the method doc — the current doc does say "Map-only" but doesn't frame it as a naming rationale.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7599:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7672:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2143:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7743:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2277:docs/audits/2026-05-13-engine-session-final-handoff.md:60:**Decision:** Option A (per-formula revocation API: `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index) + small Option C (`topo::schedule_with_supplemental` injecting temp `F→G` edges at recompute time for dirty formula pairs inside ranges). FormulaRegion binder (Option B) deferred to Phase 4.7.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7766:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2322:docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:24:**Suggested fix (LOW, deferred):** Consider renaming `register_spill` → `put_spill` for consistency with the put/clear verb pair across the API. Or document the deliberate verb choice ("register = map-only, no overlay") in the method doc — the current doc does say "Map-only" but doesn't frame it as a naming rationale.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7816:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2586:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7863:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2678:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7899:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3170:docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3452:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7921:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3612:docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7281:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7928:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4159:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7934:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4166:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7941:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4177:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7951:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4191:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2143:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7960:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4201:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2586:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7963:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4204:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2678:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8007:docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7281:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:8080:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:12529:- [financial_fns.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/src/financial_fns.rs:205): `RATE(..., guess=0)` divides by `rate` and falls through to `#NUM!`. That fails the near-zero stability concern; Microsoft says RATE normally converges with guesses between 0 and 1, and zero is a natural user guess.  
docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:12575:- [financial_fns.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/src/financial_fns.rs:205): `RATE(..., guess=0)` divides by `rate` and falls through to `#NUM!`. That fails the near-zero stability concern; Microsoft says RATE normally converges with guesses between 0 and 1, and zero is a natural user guess.  
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:183:- Do NOT propose breaking the schema-version range check.
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:270:./2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt:4374:  - Mutation API (create_table, rename_table, resize_table, drop_table)
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:316:./docs/architecture/2026-05-14-structured-references-and-tables.md:20:5. **Mutation API** — `WorkbookRuntime::create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`. Each emits a corresponding op-log entry.
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:342:./docs/audits/2026-05-13-phase-4.6-design-codex-review.txt:123:A -> B -> C -> D is close, but the real first deliverable should be "sheet registry API and canonicalizer" before parser work. Parser context, rename collision checks, printer inverse lookup, qbook load validation, and IDE diagnostics all depend on that. Sheet-scoped names can land after rename only if the rename design already accounts for per-sheet name tables and cache generations.
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:731:     8	//! This module is **data model only** for 4.8.A. Mutation API (create /
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:735:    12	//! and tests; product code uses the runtime API.
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:955:   232	/// **No mutation API in 4.8.A.** Direct `tables.insert` from the qbook
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:2335:   289	    /// **Loader / mutation-internal API.** Insert a table by canonical
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:4872:   103	             resolver-aware print_with_resolver(expr, &workbook) API is \
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:5637:   404	            // round-trip stability.
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:6147:  1478	    // ===== W5-118 (Phase 4.8.H) — table mutation API =====
docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:6970:   687	    /// layer's public read API. Any host code that bypasses `WorkbookEnv`
docs/audits/2026-05-18-phase-4-12-megaudit-design.md:97:### Auditor 4: Opus-C — Phase 4 architectural coherence + public API + persistence
docs/audits/2026-05-18-phase-4-12-megaudit-design.md:103:- Public API stability commitments per crate. What's `pub use`-d
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1030:  3122	        // instead of silently breaking. After the loop, if `iter_count`
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1339:   341	/// (scalar). Internal to the binder; not exposed in the public API yet.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2098:docs/architecture/2026-05-14-structured-references-and-tables.md:20:5. **Mutation API** — `WorkbookRuntime::create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`. Each emits a corresponding op-log entry.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2103:docs/architecture/2026-05-14-structured-references-and-tables.md:164:Decision: use `Arc<str>` (uppercase canonical) as the primary key, matching `NameTable`. A separate `TableId(u32)` is tempting for the graph (stable across renames) but adds complexity. **Renames REWRITE formula text** (Excel canon, see § 12.2). The plan-cache-invalidation alternative (the original draft's approach) was broken: cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence. Rewrite-on-rename is the simpler correct path.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2127:docs/architecture/2026-05-14-structured-references-and-tables.md:608:**Formula text IS rewritten on rename** (Excel canon). The original draft proposed plan-cache invalidation + no rewrite — Codex correctly noted that cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2143:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2147:docs/architecture/2026-05-14-structured-references-and-tables.md:713:2. **4.8.N soft-fail** — backwards-incompatible API contract change. Currently `set_formula("SUM(Sales[Qty])")` BEFORE `create_table("Sales", ...)` hard-rejects with `BindError::UnknownTable`. Design § 7.4 wants accept-text-and-surface-error-cell-value with re-bind on `on_table_create`. Needs explicit sign-off on the contract change before implementation.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2277:docs/audits/2026-05-13-engine-session-final-handoff.md:60:**Decision:** Option A (per-formula revocation API: `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index) + small Option C (`topo::schedule_with_supplemental` injecting temp `F→G` edges at recompute time for dirty formula pairs inside ranges). FormulaRegion binder (Option B) deferred to Phase 4.7.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2322:docs/audits/2026-05-14-phase-4.7.H-sonnet-review.md:24:**Suggested fix (LOW, deferred):** Consider renaming `register_spill` → `put_spill` for consistency with the put/clear verb pair across the API. Or document the deliberate verb choice ("register = map-only, no overlay") in the method doc — the current doc does say "Map-only" but doesn't frame it as a naming rationale.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2445:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:1864:./docs/audits/2026-05-13-phase-4.5-closing-megaudit-codex.txt:294:     4.5.D/E, actual AST/API shape, qbook schema v4, locale-hints deferral, and
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2586:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2678:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3170:docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3452:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3223:docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:270:./2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt:4374:  - Mutation API (create_table, rename_table, resize_table, drop_table)
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3241:docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:316:./docs/architecture/2026-05-14-structured-references-and-tables.md:20:5. **Mutation API** — `WorkbookRuntime::create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`. Each emits a corresponding op-log entry.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3612:docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7281:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:3704:  1551	    // ===== W5-118 (Phase 4.8.H) — table mutation API =====
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4159:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4160:docs/architecture/2026-05-14-structured-references-and-tables.md:713:2. **4.8.N soft-fail** — backwards-incompatible API contract change. Currently `set_formula("SUM(Sales[Qty])")` BEFORE `create_table("Sales", ...)` hard-rejects with `BindError::UnknownTable`. Design § 7.4 wants accept-text-and-surface-error-cell-value with re-bind on `on_table_create`. Needs explicit sign-off on the contract change before implementation.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4166:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4177:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4191:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2143:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4192:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2147:docs/architecture/2026-05-14-structured-references-and-tables.md:713:2. **4.8.N soft-fail** — backwards-incompatible API contract change. Currently `set_formula("SUM(Sales[Qty])")` BEFORE `create_table("Sales", ...)` hard-rejects with `BindError::UnknownTable`. Design § 7.4 wants accept-text-and-surface-error-cell-value with re-bind on `on_table_create`. Needs explicit sign-off on the contract change before implementation.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4201:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2586:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4204:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2678:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:1308:docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:6438:docs/architecture/2026-05-14-structured-references-and-tables.md:684:| 14 | **4.8.N** (deferred) | Soft-fail error→cell-value mapping (design § 7.4): accept formula text typed BEFORE its referenced table exists; surface error cell value; re-bind on `on_table_create`. | ⏳ DEFERRED — backwards-incompatible API contract change. Phase 4.8 ships without it; current behavior is hard-reject at `set_formula`. Fresh-session work, needs explicit user sign-off on the contract change before implementation. |
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4603:   344	/// construction. Phase 3.1 ships this for testability + ql-profile
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:4741:crates/ql-exec/src/calcgraph_session.rs:1708:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:5117:  1401	    /// API that bundles dirtying + cache invalidation + bind-failure
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:6559:docs/architecture/2026-05-14-structured-references-and-tables.md:164:Decision: use `Arc<str>` (uppercase canonical) as the primary key, matching `NameTable`. A separate `TableId(u32)` is tempting for the graph (stable across renames) but adds complexity. **Renames REWRITE formula text** (Excel canon, see § 12.2). The plan-cache-invalidation alternative (the original draft's approach) was broken: cached plans rebind against the OLD name and fail `BindError::UnknownTable`, breaking bind/recompute/persistence. Rewrite-on-rename is the simpler correct path.
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:6625:crates/ql-storage/src/workbook.rs:6://!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:6643:crates/ql-storage/src/workbook.rs:276:    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:6990:   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:7400:crates/ql-formula-syntax/src/printer.rs:1510:        // bracketed form `[@[Col]]` for round-trip stability (a column
docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:8231:   836	            // round-trip stability.
docs/audits/2026-05-18-w5-d-14-self.md:51:**Recommendation:** Use a different umya API — `Cell::get_cell_value_mut().set_value_and_data_type(...)` with `CellValue::set_error(...)` or equivalent. Verify the round-trip restores `ErrorValue` correctly.
docs/audits/2026-05-18-w5-d-14-self.md:64:**Recommendation:** Add `if workbook.date_system() == DateSystem::Excel1904 { spreadsheet.workbook_mut().set_date1904(true); }` (or equivalent umya API) before write.
docs/audits/2026-05-18-w5-d-14-self.md:76:**Recommendation:** Iterate `workbook.tables().iter()` (if available; see `TableTable::iter()`) and call umya's table-add API for each. umya supports `Worksheet::tables_mut()` / `add_table(Table)`. Verify the round-trip restores `TableMetadata` semantically equivalent to the original.
docs/audits/2026-05-18-w5-d-14-self.md:90:**Recommendation:** Iterate `workbook.names().iter()` and call umya's defined-names API for each workbook-scoped entry. For sheet-scoped: iterate each sheet's `scoped_names()`. Set `localSheetId` on the umya defined-name to match.
docs/audits/2026-05-18-w5-d-14-self.md:106:**Recommendation:** Add a styles-write step to the exporter. umya exposes a styles-add API on the workbook level.
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:670:./docs/phase0/references-reading-log.md:495:| **Graph dump format** | (No precedent in any reference) | — | — | **Quantbook A4 assertion API**: `#[cfg(test)] fn stripe_to_dependents()`, `formula_to_range_deps()` typed accessors; assertions directly on `(StripeKey, HashSet<NodeId>)` shape. NOT a serialized form. |
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:675:./docs/phase0/exit-packet.md:116:- ✅ Stock VS Code APIs only in v1 (T1-D06) — Quantbook engine doesn't touch IDE in Phase 0
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:681:./docs/audits/2026-05-13-w5-61-megaudit-sonnet.md:135:For `mode = NaN`: `NaN == 0.0` is false → falls into the mode≠0 branch. Excel would probably return `#VALUE!` for NaN mode. Quantbook treats NaN-mode as truthy and continues. Not breaking, not pinned.
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1352:./docs/audits/2026-05-13-w5-63-codex-coercion-review.txt:5:The design is close, but I would not implement from it unchanged. The largest issue is that the doc mixes three different things without clean labels: Excel canon, current Quantbook behavior, and aspirational behavior after later lazy-dispatch work. That causes at least one wrong error-precedence row, under-specifies major existing overrides like `COUNT`/`COUNTA`/information predicates, and risks pinning Quantbook divergences as if they were canonical Excel behavior. The helper migration is directionally right, but the proposed API names should be made less function-aware before promoting them into `ql-types`.
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1636://! `register_*` / `lookup_*` API surface: legacy callers still call
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:2091:crates/ql-exec/src/calcgraph_session.rs:1711:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:4105:    // the source (deprecated callable API) but no longer registered.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:330:   145	2. **Relative R1C1 resolution timing** — `R[-1]C` is relative to the formula's owning cell. Resolve at parse-time (parser needs owning-cell context, breaking parser purity) OR bind-time (parser emits a `Relative` marker the binder resolves). Phase 4.8.E shipped `BindSite` plumbing — bind-time resolution matches that pattern.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:332:   147	3. **`@` operator precedence + disambiguation** — `=@SUM(...)` (implicit intersection of function result) vs `=Sales[@Col]` (structured-ref `@`). The parser context matters: inside `[...]` of a structured ref, `@` means "this row"; outside, `@` means implicit intersection. How to teach the parser this without breaking the existing structured-ref escape rules from 4.8.D?
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1758:crates/ql-storage/src/workbook.rs:276:    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3473:crates/ql-oplog/src/replay.rs:37://! Passed for API symmetry with `WorkbookRuntime::new(&mut wb, &registry)`.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:3478:crates/ql-oplog/src/replay.rs:270:/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:4236:crates/ql-exec/src/calcgraph_session.rs:1388:    // `formula_deps` / `is_volatile` / `formulas_referencing_name` API.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:5440:crates/ql-exec/src/workbook_runtime.rs:5403:    /// `put_formula` API and rebuild the session. Going through
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:6330:crates/ql-calcgraph/src/edges.rs:109:    /// Phase 4 / W5-50: introduced for the per-formula edge revocation API
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:6384:crates/ql-exec/tests/ide_simulation.rs:170:/// the transaction API. Commit emits exactly ONE `Op::BatchCommit` per
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:6581:crates/ql-calcgraph/src/graph.rs:733:    // ===== W5-50 (Phase 4 pre-V2): per-formula revocation API =====
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7281:    19	//! The `Token` enum is intentionally narrow — adding deferred surface later is non-breaking.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8090:     6	//!   wired the real HashMap-backed storage and `Workbook::set_name` API; the
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8105:    21	/// stub that would force a breaking change in Week 3 ql-calcgraph binding. Widening to the
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8106:    22	/// enum NOW is non-breaking later — calcgraph callers pattern-match on the variant they need.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8322:   237	/// Arrow buffers. This is safe today because the only mutating APIs
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8329:   244	/// Phase 2A.12 audit H4 (persistence-agent finding): if a future API ever
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8361:   276	    /// `names` (the `NameTable`). Mutation API lands in 4.8.H+ via
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8486:   270	/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8619:   103	             resolver-aware print_with_resolver(expr, &workbook) API is \
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8680:  1078	        // bracketed form `[@[Col]]` for round-trip stability (a column
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:11611:HIGH: [doc §5 lines 123-124](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:123) treats R1C1 parse/print as A1-canonical without specifying formula-cell context, but relative R1C1 printing cannot be reconstructed from `Expr` alone. Fix: add an anchor-aware API, e.g. `parse_with_site(..., FormulaSite)` for R1C1 input and `print_with_site(expr, mode, locale, FormulaSite)` for R1C1 output.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:11651:HIGH: [doc §5 lines 123-124](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md:123) treats R1C1 parse/print as A1-canonical without specifying formula-cell context, but relative R1C1 printing cannot be reconstructed from `Expr` alone. Fix: add an anchor-aware API, e.g. `parse_with_site(..., FormulaSite)` for R1C1 input and `print_with_site(expr, mode, locale, FormulaSite)` for R1C1 output.
docs/audits/2026-05-18-tier-d1-codex.md:32:Each submodule adds an `impl<'a> WorkbookRuntime<'a>` block via the sibling-module impl pattern. Public API surface unchanged.
docs/audits/2026-05-18-tier-d1-codex.md:86:69ede106a61 Tier D1 Step 3.8 — extract WorkbookRuntime validate + transaction API to validate.rs
docs/audits/2026-05-18-tier-d1-codex.md:87:de7f87c5334 Tier D1 Step 3.7 — extract WorkbookRuntime cell mutation API to cells.rs
docs/audits/2026-05-18-tier-d1-codex.md:89:aa6e37800ff Tier D1 Step 3.5 — extract WorkbookRuntime table API to tables.rs
docs/audits/2026-05-18-tier-d1-codex.md:90:a48e985c5ec Tier D1 Step 3.4 — extract WorkbookRuntime defined-name API to names.rs
docs/audits/2026-05-18-tier-d1-codex.md:91:c37c556dd0f Tier D1 Step 3.3 — extract WorkbookRuntime sheet API to sheets.rs
docs/audits/2026-05-18-tier-d1-codex.md:93:2761e1f88cf Tier D1 Step 3.1 — extract WorkbookRuntime format API to formats.rs
docs/audits/2026-05-18-tier-d1-codex.md:99:40bb584a25b Tier A / Phase 5 prep — #[non_exhaustive] pass + deprecated removal + stability docs
docs/audits/2026-05-18-tier-d1-codex.md:197:   from "recompute pipeline" from "format API". A new
docs/audits/2026-05-18-tier-d1-codex.md:243:mutation API =====" already separates table tests).
docs/audits/2026-05-18-tier-d1-codex.md:289:Public API surface (`pub use workbook_runtime::WorkbookRuntime`
docs/audits/2026-05-18-tier-d1-codex.md:405:- Public API surface byte-for-byte identical (verify with
docs/audits/2026-05-18-tier-d1-codex.md:421:- Changing `WorkbookRuntime`'s public API.
docs/audits/2026-05-18-tier-d1-codex.md:478://!   `WorkbookTransaction` multi-cell batch API with eager validation,
docs/audits/2026-05-18-tier-d1-codex.md:504://! Pre-0.2.0 the public API surface is in flux. Error enums
docs/audits/2026-05-18-tier-d1-codex.md:527://! - `workbook_runtime::tables` — table mutation API.
docs/audits/2026-05-18-tier-d1-codex.md:528://! - `workbook_runtime::sheets` — sheet mutation API.
docs/audits/2026-05-18-tier-d1-codex.md:534://! Public API is unchanged: every method stays on `WorkbookRuntime`
docs/audits/2026-05-18-tier-d1-codex.md:596:224:- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
docs/audits/2026-05-18-tier-d1-codex.md:652:- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
docs/audits/2026-05-18-tier-d1-codex.md:1186:crates/ql-exec/src/workbook_runtime/sheets.rs:142:    /// breaking otherwise-recoverable workbooks at rename time.
docs/audits/2026-05-18-tier-d1-codex.md:1579:crates/ql-exec/src/workbook_runtime/tables.rs:2061:    /// the runtime API end-to-end.
docs/audits/2026-05-18-tier-d1-codex.md:1841:crates/ql-exec/src/workbook_runtime/recompute.rs:1474:    /// context-awareness. Regression guard against accidentally breaking
docs/audits/2026-05-18-tier-d1-codex.md:1881:crates/ql-exec/src/workbook_runtime/recompute.rs:1804:    /// `put_formula` API and rebuild the session. Going through
docs/audits/2026-05-18-tier-d1-codex.md:2472:crates/ql-exec/src/workbook_runtime/sheets.rs:1://! Sheet mutation API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:2498:crates/ql-exec/src/workbook_runtime/validate.rs:1://! Validation + transaction API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:2541:crates/ql-exec/src/workbook_runtime/tables.rs:1://! Table mutation API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:2897:crates/ql-exec/src/workbook_runtime/names.rs:1://! Defined-name API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:2958:crates/ql-exec/src/workbook_runtime/formats.rs:1://! Format API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:3013:crates/ql-exec/src/workbook_runtime/cells.rs:1://! Cell mutation API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:4143:69ede106a61 Tier D1 Step 3.8 — extract WorkbookRuntime validate + transaction API to validate.rs
docs/audits/2026-05-18-tier-d1-codex.md:4147:de7f87c5334 Tier D1 Step 3.7 — extract WorkbookRuntime cell mutation API to cells.rs
docs/audits/2026-05-18-tier-d1-codex.md:4155:aa6e37800ff Tier D1 Step 3.5 — extract WorkbookRuntime table API to tables.rs
docs/audits/2026-05-18-tier-d1-codex.md:4159:a48e985c5ec Tier D1 Step 3.4 — extract WorkbookRuntime defined-name API to names.rs
docs/audits/2026-05-18-tier-d1-codex.md:4164:c37c556dd0f Tier D1 Step 3.3 — extract WorkbookRuntime sheet API to sheets.rs
docs/audits/2026-05-18-tier-d1-codex.md:4172:2761e1f88cf Tier D1 Step 3.1 — extract WorkbookRuntime format API to formats.rs
docs/audits/2026-05-18-tier-d1-codex.md:4309:    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
docs/audits/2026-05-18-tier-d1-codex.md:4716://! Validation + transaction API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:5073:// without changing its public API surface. See
docs/audits/2026-05-18-tier-d1-codex.md:5080:// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
docs/audits/2026-05-18-tier-d1-codex.md:5087:// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
docs/audits/2026-05-18-tier-d1-codex.md:5089:// Step 3.4 (2026-05-18): defined-name API (set_name,
docs/audits/2026-05-18-tier-d1-codex.md:5093:// Step 3.5 (2026-05-18): table mutation API (create_table, drop_table,
docs/audits/2026-05-18-tier-d1-codex.md:5102:// Step 3.7 (2026-05-18): cell mutation API (set_formula, set_value,
docs/audits/2026-05-18-tier-d1-codex.md:5109://   transaction API (transaction, validate_formula) → `validate.rs`.
docs/audits/2026-05-18-tier-d1-codex.md:5326:    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
docs/audits/2026-05-18-tier-d1-codex.md:5358://! Format API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:5481:    // ===== W5-118 (Phase 4.8.H) — table mutation API =====
docs/audits/2026-05-18-tier-d1-codex.md:7965:    50	// without changing its public API surface. See
docs/audits/2026-05-18-tier-d1-codex.md:7972:    57	// Step 3.1 (2026-05-18): format API (intern_format, set_cell_format,
docs/audits/2026-05-18-tier-d1-codex.md:7979:    64	// Step 3.3 (2026-05-18): sheet API (add_sheet, rename_sheet) + the
docs/audits/2026-05-18-tier-d1-codex.md:7981:    66	// Step 3.4 (2026-05-18): defined-name API (set_name,
docs/audits/2026-05-18-tier-d1-codex.md:7985:    70	// Step 3.5 (2026-05-18): table mutation API (create_table, drop_table,
docs/audits/2026-05-18-tier-d1-codex.md:7994:    79	// Step 3.7 (2026-05-18): cell mutation API (set_formula, set_value,
docs/audits/2026-05-18-tier-d1-codex.md:8001:    86	//   transaction API (transaction, validate_formula) → `validate.rs`.
docs/audits/2026-05-18-tier-d1-codex.md:8231:    50	//!   `WorkbookTransaction` multi-cell batch API with eager validation,
docs/audits/2026-05-18-tier-d1-codex.md:8257:    76	//! Pre-0.2.0 the public API surface is in flux. Error enums
docs/audits/2026-05-18-tier-d1-codex.md:8280:    99	//! - `workbook_runtime::tables` — table mutation API.
docs/audits/2026-05-18-tier-d1-codex.md:8281:   100	//! - `workbook_runtime::sheets` — sheet mutation API.
docs/audits/2026-05-18-tier-d1-codex.md:8287:   106	//! Public API is unchanged: every method stays on `WorkbookRuntime`
docs/audits/2026-05-18-tier-d1-codex.md:8355:    50	//!   `WorkbookTransaction` multi-cell batch API with eager validation,
docs/audits/2026-05-18-tier-d1-codex.md:8386:   224	- **Public API:** byte-for-byte identical. `WorkbookRuntime` and
docs/audits/2026-05-18-tier-d1-codex.md:8446:    35	   from "recompute pipeline" from "format API". A new
docs/audits/2026-05-18-tier-d1-codex.md:8490:   243	- Public API surface byte-for-byte identical (verify with
docs/audits/2026-05-18-tier-d1-codex.md:8538:    81	mutation API =====" already separates table tests).
docs/audits/2026-05-18-tier-d1-codex.md:8584:   127	Public API surface (`pub use workbook_runtime::WorkbookRuntime`
docs/audits/2026-05-18-tier-d1-codex.md:8761:     1	//! Cell mutation API for `WorkbookRuntime`.
docs/audits/2026-05-18-tier-d1-codex.md:8808:- **L** [cells.rs:4388](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4388): pure table API tests (`drop_table_removes_metadata...`, `drop_table_missing_errors`) remain in `cells.rs`; move to `tables.rs`. The spill/table boundary tests around [cells.rs:4093](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4093) are acceptable only if intentionally kept as spill integration tests.
docs/audits/2026-05-18-tier-d1-codex.md:8842:- **L** [cells.rs:4388](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4388): pure table API tests (`drop_table_removes_metadata...`, `drop_table_missing_errors`) remain in `cells.rs`; move to `tables.rs`. The spill/table boundary tests around [cells.rs:4093](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:4093) are acceptable only if intentionally kept as spill integration tests.

 succeeded in 281ms:
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
docs/MASTER-PLAN.md:100:| `ql-collab` | multi-user CRDT documents, merge, presence, undo/redo, offline sync |
docs/MASTER-PLAN.md:566:2. **5.2 `ql-collab` Core Documents**  
docs/MASTER-PLAN.md:618:- `ql-collab` is real.
docs/phase0/exit-packet.md:99:Other 13 crates (ql-formula-semantics, ql-udf, ql-sql, ql-collab, ql-connectors,
docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
docs/architecture/crdt-data-model.md:359:## `ql-collab` crate scope
docs/architecture/crdt-data-model.md:365:// crates/ql-collab/src/lib.rs (current state)
docs/architecture/crdt-data-model.md:368:pub mod session;     // CollabSession: per-peer state holder
docs/architecture/crdt-data-model.md:372:pub use session::{CollabSession, CollabSessionError};
docs/architecture/crdt-data-model.md:384:Current Cargo.toml deps (verified against `crates/ql-collab/Cargo.toml`):
docs/architecture/crdt-data-model.md:391:- `thiserror` — `CollabSessionError` + `TransportError`.
docs/architecture/crdt-data-model.md:401:`CollabSession::new` + `CollabSession::from_snapshot`. The configured
crates/ql-oplog/src/log.rs:130:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
docs/known-gaps.md:114:| GAP-C-03 | `ql-collab` is a 15-line stub | `ql-collab/src/lib.rs` | Engine | Engine Phase 5.2 |
docs/known-gaps.md:116:| GAP-C-05 | No transport layer (WebSocket / offline sync) | Stub crate `ql-collab` empty | Engine | Engine Phase 5.5 |
docs/phase5/entry-plan.md:14:  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
docs/phase5/entry-plan.md:138:6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
docs/phase5/entry-plan.md:140:   from `CollabSession::new` + `from_snapshot`. PeerId now wired
docs/phase5/entry-plan.md:143:   `crates/ql-collab/src/peer.rs` + `crates/ql-oplog/src/log.rs`.
docs/phase5/entry-plan.md:154:- `ql-collab` is real.
crates/ql-collab/src/peer.rs:9://! - [`crate::session::CollabSession`] — attached at session-create
crates/ql-collab/src/peer.rs:23:/// the lifetime of a `CollabSession`; the user-facing tooling
crates/ql-collab/src/lib.rs:1://! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
crates/ql-collab/src/lib.rs:14://! - [`session`] — `CollabSession`: per-peer state holder that
crates/ql-collab/src/lib.rs:36:pub use session::{CollabSession, CollabSessionError};
crates/ql-collab/src/session.rs:1://! `CollabSession` — per-peer collaboration state holder.
crates/ql-collab/src/session.rs:15://! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
crates/ql-collab/src/session.rs:20://! - `CollabSession::new(peer_id)` — fresh session with an empty
crates/ql-collab/src/session.rs:25://! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
crates/ql-collab/src/session.rs:46:/// Errors emitted by `CollabSession` operations.
crates/ql-collab/src/session.rs:49:pub enum CollabSessionError {
crates/ql-collab/src/session.rs:64:/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
crates/ql-collab/src/session.rs:68:pub struct CollabSession {
crates/ql-collab/src/session.rs:73:impl CollabSession {
crates/ql-collab/src/session.rs:84:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
crates/ql-collab/src/session.rs:95:    /// by an earlier `CollabSession::export_bytes` call (typically
crates/ql-collab/src/session.rs:99:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
crates/ql-collab/src/session.rs:114:    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
crates/ql-collab/src/session.rs:123:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
crates/ql-collab/src/session.rs:129:    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
crates/ql-collab/src/session.rs:137:    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
crates/ql-collab/src/session.rs:157:impl std::fmt::Debug for CollabSession {
crates/ql-collab/src/session.rs:159:        f.debug_struct("CollabSession")
crates/ql-collab/src/session.rs:182:        let s = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:190:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:203:        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
crates/ql-collab/src/session.rs:213:        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
crates/ql-collab/src/session.rs:221:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
crates/ql-collab/src/session.rs:229:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
crates/ql-collab/src/session.rs:232:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
crates/ql-collab/src/session.rs:246:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
crates/ql-collab/src/session.rs:256:        // CollabSession but never passed to LoroDoc::set_peer_id, so
crates/ql-collab/src/session.rs:260:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
crates/ql-collab/src/session.rs:272:        let origin = CollabSession::new(PeerId::new(11)).unwrap();
crates/ql-collab/src/session.rs:274:        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
crates/ql-collab/src/transport.rs:17://! That's enough to plumb a `CollabSession::export_bytes` →
crates/ql-collab/src/transport.rs:18://! transport → remote `CollabSession::merge_bytes` flow. The
crates/ql-collab/src/transport.rs:79:/// that exercise `CollabSession::append_op` without needing a
crates/ql-collab/src/transport.rs:85:    /// inspect this to verify their `CollabSession` calls emit the
crates/ql-collab/Cargo.toml:2:name = "ql-collab"
crates/ql-collab/Cargo.toml:13:# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
crates/ql-collab/Cargo.toml:15:# ql-collab is the Phase 5 collaboration crate. Depends on
docs/audits/2026-05-19-handoff-audit-codex.md:33:- `66a571b30af` Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:52:### T4. ql-collab cargo deps minimality
docs/audits/2026-05-19-handoff-audit-codex.md:54:Read `crates/ql-collab/Cargo.toml`. The scaffold (commit `66a571b30af`) added `ql-oplog, ql-storage, ql-functions, thiserror`. Verify each dep is actually used in the source (`src/lib.rs`, `peer.rs`, `session.rs`, `transport.rs`). If `ql-storage` and `ql-functions` are unused in code (only in doc-comment examples), flag whether they should be removed or documented as forward-looking.
docs/audits/2026-05-19-handoff-audit-codex.md:383:/bin/zsh -lc 'nl -ba crates/ql-collab/Cargo.toml' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:385:/bin/zsh -lc 'nl -ba crates/ql-collab/src/lib.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:387:     1	//! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
docs/audits/2026-05-19-handoff-audit-codex.md:400:    14	//! - [`session`] — `CollabSession`: per-peer state holder that
docs/audits/2026-05-19-handoff-audit-codex.md:422:    36	pub use session::{CollabSession, CollabSessionError};
docs/audits/2026-05-19-handoff-audit-codex.md:427:     2	name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:438:    13	# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
docs/audits/2026-05-19-handoff-audit-codex.md:440:    15	# ql-collab is the Phase 5 collaboration crate. Depends on
docs/audits/2026-05-19-handoff-audit-codex.md:463:    14	  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:541:    92	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | Two-peer merge for cells/names/sheets. |
docs/audits/2026-05-19-handoff-audit-codex.md:563:   114	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:577:   128	- `ql-collab` is real.
docs/audits/2026-05-19-handoff-audit-codex.md:739:   138	- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
docs/audits/2026-05-19-handoff-audit-codex.md:957:   356	## `ql-collab` crate scope
docs/audits/2026-05-19-handoff-audit-codex.md:959:   358	Currently empty (`crates/ql-collab/src/lib.rs` is a 17-line
docs/audits/2026-05-19-handoff-audit-codex.md:965:   364	// crates/ql-collab/src/lib.rs
docs/audits/2026-05-19-handoff-audit-codex.md:967:   366	pub mod session;     // CollabSession: per-peer state holder
docs/audits/2026-05-19-handoff-audit-codex.md:1230:/bin/zsh -lc 'nl -ba crates/ql-collab/src/peer.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:1232:/bin/zsh -lc 'nl -ba crates/ql-collab/src/session.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:1234:/bin/zsh -lc 'nl -ba crates/ql-collab/src/transport.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:1236:/bin/zsh -lc 'rg -n "ql_storage|ql_functions|ql_oplog|OpLog|Workbook|FunctionRegistry|thiserror|Error" crates/ql-collab/src crates/ql-collab/Cargo.toml' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:1238:     1	//! `CollabSession` — per-peer collaboration state holder.
docs/audits/2026-05-19-handoff-audit-codex.md:1252:    15	//! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
docs/audits/2026-05-19-handoff-audit-codex.md:1257:    20	//! - `CollabSession::new(peer_id)` — fresh session with an empty
docs/audits/2026-05-19-handoff-audit-codex.md:1259:    22	//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
docs/audits/2026-05-19-handoff-audit-codex.md:1278:    41	/// Errors emitted by `CollabSession` operations.
docs/audits/2026-05-19-handoff-audit-codex.md:1281:    44	pub enum CollabSessionError {
docs/audits/2026-05-19-handoff-audit-codex.md:1296:    59	/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
docs/audits/2026-05-19-handoff-audit-codex.md:1300:    63	pub struct CollabSession {
docs/audits/2026-05-19-handoff-audit-codex.md:1305:    68	impl CollabSession {
docs/audits/2026-05-19-handoff-audit-codex.md:1323:    86	    /// by an earlier `CollabSession::export_bytes` call (typically
docs/audits/2026-05-19-handoff-audit-codex.md:1325:    88	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1341:   104	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1350:   113	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1356:   119	    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1364:   127	    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
docs/audits/2026-05-19-handoff-audit-codex.md:1384:   147	impl std::fmt::Debug for CollabSession {
docs/audits/2026-05-19-handoff-audit-codex.md:1386:   149	        f.debug_struct("CollabSession")
docs/audits/2026-05-19-handoff-audit-codex.md:1409:   172	        let s = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1417:   180	        let mut s = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1430:   193	        let mut origin = CollabSession::new(PeerId::new(1));
docs/audits/2026-05-19-handoff-audit-codex.md:1440:   203	        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
docs/audits/2026-05-19-handoff-audit-codex.md:1448:   211	        let mut base = CollabSession::new(PeerId::new(0));
docs/audits/2026-05-19-handoff-audit-codex.md:1456:   219	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
docs/audits/2026-05-19-handoff-audit-codex.md:1459:   222	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
docs/audits/2026-05-19-handoff-audit-codex.md:1473:   236	        let mut s = CollabSession::new(PeerId::new(42));
docs/audits/2026-05-19-handoff-audit-codex.md:1498:    17	//! That's enough to plumb a `CollabSession::export_bytes` →
docs/audits/2026-05-19-handoff-audit-codex.md:1499:    18	//! transport → remote `CollabSession::merge_bytes` flow. The
docs/audits/2026-05-19-handoff-audit-codex.md:1560:    79	/// that exercise `CollabSession::append_op` without needing a
docs/audits/2026-05-19-handoff-audit-codex.md:1566:    85	    /// inspect this to verify their `CollabSession` calls emit the
docs/audits/2026-05-19-handoff-audit-codex.md:1649:     9	//! - [`crate::session::CollabSession`] — attached at session-create
docs/audits/2026-05-19-handoff-audit-codex.md:1661:    21	/// the lifetime of a `CollabSession`; the user-facing tooling
docs/audits/2026-05-19-handoff-audit-codex.md:1734:crates/ql-collab/Cargo.toml:16:# ql-oplog (the dependency floor post Tier D2) for OpLog + Op +
docs/audits/2026-05-19-handoff-audit-codex.md:1735:crates/ql-collab/Cargo.toml:17:# merge_bytes. ql-storage gives us Workbook for replay
docs/audits/2026-05-19-handoff-audit-codex.md:1736:crates/ql-collab/Cargo.toml:22:thiserror    = { workspace = true }
docs/audits/2026-05-19-handoff-audit-codex.md:1737:crates/ql-collab/src/lib.rs:15://!   wraps an `OpLog`, manages local appends, and exposes
docs/audits/2026-05-19-handoff-audit-codex.md:1738:crates/ql-collab/src/lib.rs:36:pub use session::{CollabSession, CollabSessionError};
docs/audits/2026-05-19-handoff-audit-codex.md:1739:crates/ql-collab/src/lib.rs:37:pub use transport::{NoopTransport, Transport, TransportError};
docs/audits/2026-05-19-handoff-audit-codex.md:1740:crates/ql-collab/src/transport.rs:22:use thiserror::Error;
docs/audits/2026-05-19-handoff-audit-codex.md:1741:crates/ql-collab/src/transport.rs:24:/// Errors emitted by `Transport` impls.
docs/audits/2026-05-19-handoff-audit-codex.md:1742:crates/ql-collab/src/transport.rs:25:#[derive(Debug, Error)]
docs/audits/2026-05-19-handoff-audit-codex.md:1743:crates/ql-collab/src/transport.rs:27:pub enum TransportError {
docs/audits/2026-05-19-handoff-audit-codex.md:1744:crates/ql-collab/src/transport.rs:60:    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
docs/audits/2026-05-19-handoff-audit-codex.md:1745:crates/ql-collab/src/transport.rs:67:    /// Returns `Err(TransportError::Closed)` only when the channel
docs/audits/2026-05-19-handoff-audit-codex.md:1746:crates/ql-collab/src/transport.rs:70:    /// `Err(TransportError::Io)`.
docs/audits/2026-05-19-handoff-audit-codex.md:1747:crates/ql-collab/src/transport.rs:71:    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
docs/audits/2026-05-19-handoff-audit-codex.md:1748:crates/ql-collab/src/transport.rs:99:    /// `TransportError::Closed`; `try_recv` returns `Closed` since
docs/audits/2026-05-19-handoff-audit-codex.md:1749:crates/ql-collab/src/transport.rs:107:    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1750:crates/ql-collab/src/transport.rs:109:            return Err(TransportError::Closed);
docs/audits/2026-05-19-handoff-audit-codex.md:1751:crates/ql-collab/src/transport.rs:115:    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1752:crates/ql-collab/src/transport.rs:117:            return Err(TransportError::Closed);
docs/audits/2026-05-19-handoff-audit-codex.md:1753:crates/ql-collab/src/transport.rs:125:    use super::{NoopTransport, Transport, TransportError};
docs/audits/2026-05-19-handoff-audit-codex.md:1754:crates/ql-collab/src/transport.rs:146:        assert!(matches!(t.send(b"second"), Err(TransportError::Closed)));
docs/audits/2026-05-19-handoff-audit-codex.md:1755:crates/ql-collab/src/transport.rs:155:        assert!(matches!(t.try_recv(), Err(TransportError::Closed)));
docs/audits/2026-05-19-handoff-audit-codex.md:1756:crates/ql-collab/src/session.rs:3://! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
docs/audits/2026-05-19-handoff-audit-codex.md:1757:crates/ql-collab/src/session.rs:21://!   `OpLog` and the peer-id stamp.
docs/audits/2026-05-19-handoff-audit-codex.md:1758:crates/ql-collab/src/session.rs:26://!   `OpLog::append`.
docs/audits/2026-05-19-handoff-audit-codex.md:1759:crates/ql-collab/src/session.rs:29://!   `OpLog::merge_bytes`.
docs/audits/2026-05-19-handoff-audit-codex.md:1760:crates/ql-collab/src/session.rs:35:use thiserror::Error;
docs/audits/2026-05-19-handoff-audit-codex.md:1761:crates/ql-collab/src/session.rs:37:use ql_oplog::{Op, OpLog, OpLogError};
docs/audits/2026-05-19-handoff-audit-codex.md:1762:crates/ql-collab/src/session.rs:41:/// Errors emitted by `CollabSession` operations.
docs/audits/2026-05-19-handoff-audit-codex.md:1763:crates/ql-collab/src/session.rs:42:#[derive(Debug, Error)]
docs/audits/2026-05-19-handoff-audit-codex.md:1764:crates/ql-collab/src/session.rs:44:pub enum CollabSessionError {
docs/audits/2026-05-19-handoff-audit-codex.md:1765:crates/ql-collab/src/session.rs:45:    /// The underlying `OpLog` failed (Loro encode/decode, serde,
docs/audits/2026-05-19-handoff-audit-codex.md:1766:crates/ql-collab/src/session.rs:46:    /// etc.). Surfaces the wrapped `OpLogError` for diagnosis.
docs/audits/2026-05-19-handoff-audit-codex.md:1767:crates/ql-collab/src/session.rs:48:    OpLog(#[from] OpLogError),
docs/audits/2026-05-19-handoff-audit-codex.md:1768:crates/ql-collab/src/session.rs:53:/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
docs/audits/2026-05-19-handoff-audit-codex.md:1769:crates/ql-collab/src/session.rs:61:/// converge to the same `OpLog` content after exchange (per Loro's
docs/audits/2026-05-19-handoff-audit-codex.md:1770:crates/ql-collab/src/session.rs:65:    log: OpLog,
docs/audits/2026-05-19-handoff-audit-codex.md:1771:crates/ql-collab/src/session.rs:77:            log: OpLog::new(),
docs/audits/2026-05-19-handoff-audit-codex.md:1772:crates/ql-collab/src/session.rs:88:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1773:crates/ql-collab/src/session.rs:91:            log: OpLog::import_bytes(bytes)?,
docs/audits/2026-05-19-handoff-audit-codex.md:1774:crates/ql-collab/src/session.rs:100:    /// Append a local op. Delegates to `OpLog::append`. Phase 5.5
docs/audits/2026-05-19-handoff-audit-codex.md:1775:crates/ql-collab/src/session.rs:104:    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1776:crates/ql-collab/src/session.rs:113:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1777:crates/ql-collab/src/session.rs:119:    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:1778:crates/ql-collab/src/session.rs:123:    /// Borrow the underlying `OpLog` for replay against a `Workbook`.
docs/audits/2026-05-19-handoff-audit-codex.md:1779:crates/ql-collab/src/session.rs:128:    /// let mut wb = ql_storage::Workbook::new();
docs/audits/2026-05-19-handoff-audit-codex.md:1780:crates/ql-collab/src/session.rs:129:    /// let reg = ql_functions::default_registry();
docs/audits/2026-05-19-handoff-audit-codex.md:1781:crates/ql-collab/src/session.rs:130:    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
docs/audits/2026-05-19-handoff-audit-codex.md:1782:crates/ql-collab/src/session.rs:132:    pub fn op_log(&self) -> &OpLog {
docs/audits/2026-05-19-handoff-audit-codex.md:1783:crates/ql-collab/src/session.rs:159:    use ql_oplog::CellWireValue;
docs/audits/2026-05-19-handoff-audit-codex.md:1792:/bin/zsh -lc 'git diff -- docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md crates/ql-collab/Cargo.toml Cargo.lock' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:1824:docs/phase5/entry-plan.md:14:  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:1841:docs/phase5/entry-plan.md:92:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | Two-peer merge for cells/names/sheets. |
docs/audits/2026-05-19-handoff-audit-codex.md:1847:docs/phase5/entry-plan.md:114:5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:1867:docs/architecture/crdt-data-model.md:138:- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
docs/audits/2026-05-19-handoff-audit-codex.md:1943:docs/MASTER-PLAN.md:566:2. **5.2 `ql-collab` Core Documents**  
docs/audits/2026-05-19-handoff-audit-codex.md:2065:66a571b30af Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:2211:    84	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | Two-peer merge for cells/names/sheets. |
docs/audits/2026-05-19-handoff-audit-codex.md:2233:   106	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:2247:   120	- `ql-collab` is real.
docs/audits/2026-05-19-handoff-audit-codex.md:2409:   138	- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
docs/audits/2026-05-19-handoff-audit-codex.md:2627:   356	## `ql-collab` crate scope
docs/audits/2026-05-19-handoff-audit-codex.md:2629:   358	Currently empty (`crates/ql-collab/src/lib.rs` is a 17-line
docs/audits/2026-05-19-handoff-audit-codex.md:2635:   364	// crates/ql-collab/src/lib.rs
docs/audits/2026-05-19-handoff-audit-codex.md:2637:   366	pub mod session;     // CollabSession: per-peer state holder
docs/audits/2026-05-19-handoff-audit-codex.md:2892:/bin/zsh -lc 'git show 66a571b30af:quantbook-engine/crates/ql-collab/Cargo.toml | nl -ba' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
docs/audits/2026-05-19-handoff-audit-codex.md:2895:     2	name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:2906:    13	# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
docs/audits/2026-05-19-handoff-audit-codex.md:2908:    15	# ql-collab is the Phase 5 collaboration crate. Depends on
docs/audits/2026-05-19-handoff-audit-codex.md:2918:/bin/zsh -lc "git show 66a571b30af:quantbook-engine/Cargo.lock | rg -n \"name = \\\"ql-collab\\\"|name = \\\"ql-oplog\\\"|name = \\\"ql-storage\\\"|name = \\\"ql-functions\\\"|thiserror\" -C 3" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
docs/audits/2026-05-19-handoff-audit-codex.md:2963:2072:name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:3098:  2072	name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:3121:66a571b30af Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:3122:quantbook-engine/crates/ql-collab/Cargo.toml
docs/audits/2026-05-19-handoff-audit-codex.md:3123:quantbook-engine/crates/ql-collab/src/lib.rs
docs/audits/2026-05-19-handoff-audit-codex.md:3124:quantbook-engine/crates/ql-collab/src/peer.rs
docs/audits/2026-05-19-handoff-audit-codex.md:3125:quantbook-engine/crates/ql-collab/src/session.rs
docs/audits/2026-05-19-handoff-audit-codex.md:3126:quantbook-engine/crates/ql-collab/src/transport.rs
docs/audits/2026-05-19-handoff-audit-codex.md:3135:  2072	name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:3160:  2072	name = "ql-collab"
docs/audits/2026-05-19-handoff-audit-codex.md:3179:The 66a571b30af snapshot has the exact stale `entry-plan.md` status the prompt warned about, and its `Cargo.lock` does not include the new `ql-collab` dependencies. The branch’s newer `055bb7f3e0c` commit appears to address those two commit-currency problems, but several body sections remain stale. Next I’m running the requested gates against the current checkout.
docs/audits/2026-05-19-handoff-audit-codex.md:3343:    14	  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
docs/audits/2026-05-19-handoff-audit-codex.md:3433:   104	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | Two-peer merge for cells/names/sheets. |
docs/audits/2026-05-19-handoff-audit-codex.md:3455:   126	5. **API stability** — Phase 5 will expose `ql-collab` types into
docs/audits/2026-05-19-handoff-audit-codex.md:3469:   140	- `ql-collab` is real.
docs/audits/2026-05-19-handoff-audit-codex.md:3799:/bin/zsh -lc "nl -ba crates/ql-collab/src/session.rs | sed -n '68,122p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:3801:/bin/zsh -lc "nl -ba crates/ql-collab/src/peer.rs | sed -n '1,40p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
docs/audits/2026-05-19-handoff-audit-codex.md:3828:     9	//! - [`crate::session::CollabSession`] — attached at session-create
docs/audits/2026-05-19-handoff-audit-codex.md:3840:    21	/// the lifetime of a `CollabSession`; the user-facing tooling
docs/audits/2026-05-19-handoff-audit-codex.md:3862:    68	impl CollabSession {
docs/audits/2026-05-19-handoff-audit-codex.md:3880:    86	    /// by an earlier `CollabSession::export_bytes` call (typically
docs/audits/2026-05-19-handoff-audit-codex.md:3882:    88	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:3898:   104	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:3907:   113	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:3913:   119	    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
docs/audits/2026-05-19-handoff-audit-codex.md:4155:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
docs/audits/2026-05-19-handoff-audit-codex.md:4156:- MEDIUM, T4, `crates/ql-collab/Cargo.toml:17-21`: `ql-storage` and `ql-functions` are unused in compiled code; only mentioned in an ignored doc example at `crates/ql-collab/src/session.rs:123-130`. Remove until replay integration lands, or explicitly document as forward-looking scaffold deps.
docs/audits/2026-05-19-handoff-audit-codex.md:4157:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
docs/audits/2026-05-19-handoff-audit-codex.md:4158:- MEDIUM, T5, `Cargo.lock:2074-2079`: `Cargo.lock` is committed at current HEAD `055bb7f3e0c` and now includes ql-collab deps. At requested `66a571b30af`, it was not committed.
docs/audits/2026-05-19-handoff-audit-codex.md:4180:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:356-383`: ql-collab section says crate is empty and expects `ql-exec`; scaffold now exists and actual deps are `ql-oplog`, `ql-storage`, `ql-functions`, `thiserror`.
docs/audits/2026-05-19-handoff-audit-codex.md:4181:- MEDIUM, T4, `crates/ql-collab/Cargo.toml:17-21`: `ql-storage` and `ql-functions` are unused in compiled code; only mentioned in an ignored doc example at `crates/ql-collab/src/session.rs:123-130`. Remove until replay integration lands, or explicitly document as forward-looking scaffold deps.
docs/audits/2026-05-19-handoff-audit-codex.md:4182:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
docs/audits/2026-05-19-handoff-audit-codex.md:4183:- MEDIUM, T5, `Cargo.lock:2074-2079`: `Cargo.lock` is committed at current HEAD `055bb7f3e0c` and now includes ql-collab deps. At requested `66a571b30af`, it was not committed.
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1077:crates/ql-collab/Cargo.toml:3:version.workspace = true
docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1078:crates/ql-collab/Cargo.toml:5:rust-version.workspace = true
docs/audits/2026-05-19-handoff-audit-consolidated.md:21:- Code spot-checks: `OpLog::merge_bytes`, `Op::AddSheet` auto-rename, `BindError::UnknownSheet` mapping, 2-peer spill probe, ql-collab scaffold modules, Tier D1 submodule split shape.
docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:665:crates/ql-collab/src/lib.rs
docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:666:crates/ql-collab/Cargo.toml
docs/audits/2026-05-19-phase-5-1-consolidated.md:119:- **Opus M-4:** ql-collab module-level LOC breakdown not
docs/audits/2026-05-19-phase-5-1-consolidated.md:185:(ql-collab core documents) can start. Pre-5.2 prerequisites:
docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:962:./crates/ql-collab/src/lib.rs:3://! Reserved for Phase 5+ — multi-user collaboration on top of the Phase 2A.3 op log.
docs/audits/2026-05-19-phase-5-1-opus.md:93:### M-4 — ql-collab scope under-specified for transport
docs/audits/2026-05-19-phase-5-1-opus.md:95:The design lists `ql-collab` modules as `session, transport,
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:446:Re-verified: default-members line 13-25 includes ql-types, ql-storage, ql-formula-syntax, ql-formula-semantics, ql-functions, ql-calcgraph, ql-exec, ql-bench, ql-profile, ql-oplog, ql-terminal. Missing: ql-io, ql-io-xlsx, ql-io-ods (the I/O family), and all the stub-shaped crates (ql-ai, ql-bindings-*, ql-collab, ql-connectors, ql-service, ql-sql, ql-terminal, ql-udf, quantbook-py).
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:480:**Action:** not urgent. If Phase 5 introduces a new integration shape (collaboration), the natural home is `ql-collab/tests/` — which is currently empty since the crate is stub-only.
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:658:### Stub crates (ql-ai, ql-bindings-*, ql-collab, ql-connectors, ql-formula-semantics, ql-io-ods, ql-service, ql-sql, ql-terminal, ql-udf, quantbook-py)
docs/audits/2026-05-19-phase-5-1-codex.md:282:   120	- 5.2 (`ql-collab` core documents): 1-2 weeks under Option A;
docs/audits/2026-05-19-phase-5-1-codex.md:507:   338	## `ql-collab` crate scope
docs/audits/2026-05-19-phase-5-1-codex.md:509:   340	Currently empty (`crates/ql-collab/src/lib.rs` is a 17-line
docs/audits/2026-05-19-phase-5-1-codex.md:515:   346	// crates/ql-collab/src/lib.rs
docs/audits/2026-05-19-phase-5-1-codex.md:517:   348	pub mod session;     // CollabSession: per-peer state holder
docs/audits/2026-05-15-phase-4.9-mid-arc-audit-codex.md:3231:crates/ql-collab/Cargo.toml

exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/lib.rs | sed -n '1,80p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 259ms:
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
    12	//! - [`peer`] — `PeerId` type. Stable per-session identifier used
    13	//!   to attribute ops + presence state. Wraps Loro's `u64` peer id.
    14	//! - [`session`] — `CollabSession`: per-peer state holder that
    15	//!   wraps an `OpLog`, manages local appends, and exposes
    16	//!   `merge_bytes` + `export_bytes` for transport integration.
    17	//! - [`transport`] — `Transport` trait: the wire-byte channel
    18	//!   abstraction (Phase 5.5 will add a WebSocket impl).
    19	//! - [`presence`] — reserved name; Phase 5.6 populates with the
    20	//!   ephemeral cursor + selection state map.
    21	//! - [`undo`] — reserved name; Phase 5.4 populates with peer-local
    22	//!   undo via Loro's `UndoManager`.
    23	//!
    24	//! ## Stability
    25	//!
    26	//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
    27	//! will populate the reserved modules and may shift trait shapes.
    28	//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
    29	//! megaudit per the engine audit-discipline rule.
    30	
    31	pub mod peer;
    32	pub mod session;
    33	pub mod transport;
    34	
    35	pub use peer::PeerId;
    36	pub use session::{CollabSession, CollabSessionError};
    37	pub use transport::{NoopTransport, Transport, TransportError};

exec
/bin/zsh -lc "nl -ba docs/known-gaps.md | sed -n '104,122p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 264ms:
   104	| ~~GAP-G-03~~ | ~~Range deps not scheduler edges — `register_range_dependency` populated stripes + precision map but never `add_edge`. Tarjan invisible to range-induced ordering / cycles.~~ — **CLOSED in Engine Phase 4 pre-V2 (W5-50).** `topo::schedule_with_supplemental` accepts a `HashMap<NodeId, Vec<NodeId>>` of temp adjacency layered on top of `graph.outgoing(v)`. `CalcgraphSession::build_range_supplemental` builds it at schedule_dirty time: for each dirty formula `F` with range deps, for each OTHER dirty FORMULA node `G` whose address is inside one of F's ranges, push `G` into `supplemental[F]`. Scope: dirty formula nodes only (Codex W5-49 refinement). 7 Tarjan-level supplemental tests + 4 session-level acceptance tests (h1_range_induced_cycle_detected, h1_range_induced_ordering_via_supplemental, self_range_cycle_via_supplemental, partial_dirty_literal_in_range_no_supplemental). |
   105	| GAP-G-04 | VEQ (value-equality short-circuit, GAP-R-05) interaction with supplemental edges (W5-50 GAP-G-03 closure) is UNTESTED. Codex's W5-49 watch list explicitly named this risk: if a formula `F` reads a range covering dirty formula `G`, and `G`'s direct cell deps are VEQ-skipped, does `F` still see correct ordering and re-evaluation? Filed W5-60 closure (Codex H3 closure's catchment). Acceptance: a regression test that sets up `A1 = G(B1)`, `B1 = SUM(A1:A1)`, mutates upstream so A1 is VEQ-skipped, asserts B1's recompute still observes A1's value correctly. | No test exists in `crates/ql-exec/tests/` covering this case | Engine | Engine Phase 4.7 (array formulas) OR sooner if a regression surfaces |
   106	| GAP-G-05 | `formula_to_stripe_keys` (the W5-50 reverse index added to `StripeIndex` for revocation) has NOT been benchmarked at scale. For a workbook with N formulas each registering M range deps spanning K stripe keys per range, memory grows as `O(N · M · K)` — bounded but unbenchmarked. Codex W5-49 listed this as a stop-condition for Option A. Acceptance: bench fixture in `crates/ql-bench` measuring memory growth as a function of N for N ∈ {1k, 10k, 100k} formulas with realistic range-dep distributions. | `crates/ql-calcgraph/src/stripes.rs` `formula_to_stripe_keys: HashMap<NodeId, Vec<StripeKey>>` field has no bench coverage | Engine | Engine Phase 4.10 (function library wave 2) or earlier if scale workload surfaces it |
   107	
   108	### Collaboration
   109	
   110	| ID | Gap | Reproduce | Owner | Target phase |
   111	|---|---|---|---|---|
   112	| GAP-C-01 | Loro op log is single-writer history, not multi-user CRDT state | `ql-oplog/src/log.rs` is append-only log only | Engine | Engine Phase 5.1 (collab data model decision) |
   113	| GAP-C-02 | No conflict resolution semantics for concurrent peer edits | Out-of-scope today | Engine | Engine Phase 5.3 |
   114	| GAP-C-03 | `ql-collab` is a 15-line stub | `ql-collab/src/lib.rs` | Engine | Engine Phase 5.2 |
   115	| GAP-C-04 | No undo/redo model defined; transactions exist but command grouping is informal | `ql-exec/src/transaction.rs` doesn't expose inverse ops | Engine | Engine Phase 5.4 |
   116	| GAP-C-05 | No transport layer (WebSocket / offline sync) | Stub crate `ql-collab` empty | Engine | Engine Phase 5.5 |
   117	
   118	### Product surfaces
   119	
   120	| ID | Gap | Reproduce | Owner | Target phase |
   121	|---|---|---|---|---|
   122	| GAP-PS-01 | `quantbook-py` Python binding stub only | `quantbook-py/src/lib.rs:15` | Engine | Engine Phase 6.3 |

codex
The source check confirms Loro’s public wrapper delegates directly to the internal setter, and the internal setter only updates the document’s current peer state; transaction creation captures that peer for future commits. I’ve also found one stale non-audit doc entry in `docs/known-gaps.md` that still describes `ql-collab` as an empty stub.
exec
/bin/zsh -lc 'cargo test --workspace' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'git show --find-renames --format=short --stat --patch HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/peer.rs quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
commit ef056f50bee7914455521f62703119efe941644a
Author: steppen0mad <nurtaymergaliyev@gmail.com>

    Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id
---
 quantbook-engine/crates/ql-collab/src/peer.rs      | 23 +++----
 quantbook-engine/crates/ql-collab/src/session.rs   | 75 ++++++++++++++++------
 quantbook-engine/crates/ql-oplog/src/log.rs        | 51 +++++++++++++++
 .../docs/architecture/crdt-data-model.md           | 18 +++---
 quantbook-engine/docs/phase5/entry-plan.md         | 12 ++--
 5 files changed, 130 insertions(+), 49 deletions(-)

diff --git a/quantbook-engine/crates/ql-collab/src/peer.rs b/quantbook-engine/crates/ql-collab/src/peer.rs
index 01a3b83df89..2539db75153 100644
--- a/quantbook-engine/crates/ql-collab/src/peer.rs
+++ b/quantbook-engine/crates/ql-collab/src/peer.rs
@@ -6,13 +6,11 @@
 //! (random vs user-derived vs server-allocated).
 //!
 //! Used by:
-//! - [`crate::session::CollabSession`] — stored at session-create
-//!   time as a stable label. **Phase 5.2.a scaffold limitation:**
-//!   not yet passed to Loro's `LoroDoc::set_peer_id`; each peer's
-//!   doc gets Loro's default random per-doc peer id until Phase 5.5
-//!   wires the stable id through during the transport handshake.
-//!   Multi-peer convergence still works because the random ids are
-//!   distinct (verified by Phase 5.2 D-4 2-peer probe).
+//! - [`crate::session::CollabSession`] — attached at session-create
+//!   time AND passed through to `OpLog::set_peer_id` → Loro's
+//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
+//!   origin in the CRDT merge metadata (Phase 5.2.b 2026-05-19;
+//!   5.2.a stored this as a label only).
 //! - Phase 5.6 presence module — will key the `presence` `LoroMap`
 //!   so each peer's cursor position lives at its own slot.
 //! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
@@ -23,12 +21,11 @@
 ///
 /// Wraps a `u64` to match Loro's native peer-id type. Stable for
 /// the lifetime of a `CollabSession`; the user-facing tooling
-/// decides assignment policy (random / user-derived /
-/// server-allocated). Two peers SHOULD have distinct IDs to keep
-/// presence / undo / format-id allocation deterministic. (Loro's
-/// own merge rule uses its `LoroDoc` peer id, which is
-/// independently per-doc-random in Phase 5.2.a — see module
-/// docstring.)
+/// decides assignment policy. Two concurrent peers MUST have
+/// distinct ids — duplicate peer ids corrupt the document via
+/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
+/// then closed by Phase 5.2.b wiring). Prefer per-process-random
+/// allocation unless your server enforces uniqueness explicitly.
 #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
 pub struct PeerId(pub u64);
 
diff --git a/quantbook-engine/crates/ql-collab/src/session.rs b/quantbook-engine/crates/ql-collab/src/session.rs
index a97a6e93da6..10622fff412 100644
--- a/quantbook-engine/crates/ql-collab/src/session.rs
+++ b/quantbook-engine/crates/ql-collab/src/session.rs
@@ -15,13 +15,18 @@
 //! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
 //!   handle that the IDE attaches to each open workbook.
 //!
-//! What ships in 5.2.a:
+//! What ships in 5.2.a (5.2.b update 2026-05-19):
 //!
 //! - `CollabSession::new(peer_id)` — fresh session with an empty
-//!   `OpLog` and the peer-id stamp.
+//!   `OpLog` and the peer-id wired through to
+//!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
+//!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
+//!   fallible.
 //! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
 //!   shared base snapshot (used by both peers in the D-4 probe
-//!   pattern).
+//!   pattern). The reborn session's peer id is `peer_id`; existing
+//!   ops in the imported snapshot retain their original
+//!   attribution.
 //! - `append_op(&mut self, Op)` — local append; delegates to
 //!   `OpLog::append`.
 //! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
@@ -69,13 +74,17 @@ impl CollabSession {
     /// Construct a fresh session with an empty op log.
     ///
     /// Use this when no shared base snapshot exists yet (the first
-    /// peer to open a brand-new workbook). Phase 5.2.b will document
-    /// the policy for peer-id assignment; for now the caller picks.
-    pub fn new(peer_id: PeerId) -> Self {
-        Self {
-            peer_id,
-            log: OpLog::new(),
-        }
+    /// peer to open a brand-new workbook). The `peer_id` is wired
+    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
+    /// CRDT merge metadata attributes this session's appends to
+    /// `peer_id` (not Loro's default random per-doc id).
+    ///
+    /// **Caller pitfall:** two concurrent sessions MUST use distinct
+    /// peer ids — see `OpLog::set_peer_id` for details.
+    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
+        let log = OpLog::new();
+        log.set_peer_id(peer_id.as_u64())?;
+        Ok(Self { peer_id, log })
     }
 
     /// Construct a session by importing a shared snapshot. Use this
@@ -84,12 +93,13 @@ impl CollabSession {
     ///
     /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
     /// by an earlier `CollabSession::export_bytes` call (typically
-    /// from the workbook owner / first peer).
+    /// from the workbook owner / first peer). After import, this
+    /// session's peer id is set to `peer_id` — distinct from the
+    /// peer ids carried by the already-imported ops.
     pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
-        Ok(Self {
-            peer_id,
-            log: OpLog::import_bytes(bytes)?,
-        })
+        let log = OpLog::import_bytes(bytes)?;
+        log.set_peer_id(peer_id.as_u64())?;
+        Ok(Self { peer_id, log })
     }
 
     /// Stable peer id assigned at session creation.
@@ -169,7 +179,7 @@ mod tests {
 
     #[test]
     fn new_session_is_empty() {
-        let s = CollabSession::new(PeerId::new(1));
+        let s = CollabSession::new(PeerId::new(1)).unwrap();
         assert_eq!(s.peer_id(), PeerId::new(1));
         assert_eq!(s.op_count(), 0);
         assert!(s.is_empty());
@@ -177,7 +187,7 @@ mod tests {
 
     #[test]
     fn append_grows_log() {
-        let mut s = CollabSession::new(PeerId::new(1));
+        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
         s.append_op(Op::AddSheet {
             name: "S".to_owned(),
             chunk_rows: 16384,
@@ -190,7 +200,7 @@ mod tests {
 
     #[test]
     fn from_snapshot_reconstructs_op_count() {
-        let mut origin = CollabSession::new(PeerId::new(1));
+        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
         origin
             .append_op(Op::AddSheet {
                 name: "S".to_owned(),
@@ -208,7 +218,7 @@ mod tests {
     #[test]
     fn merge_bytes_grows_log_with_remote_ops() {
         // Two peers, shared base, each appends; one merges the other.
-        let mut base = CollabSession::new(PeerId::new(0));
+        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
         base.append_op(Op::AddSheet {
             name: "S".to_owned(),
             chunk_rows: 16384,
@@ -233,10 +243,35 @@ mod tests {
 
     #[test]
     fn debug_impl_includes_peer_id_and_count() {
-        let mut s = CollabSession::new(PeerId::new(42));
+        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
         s.append_op(put_value(0, 0, 0, 1.0)).ok();
         let d = format!("{s:?}");
         assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
         assert!(d.contains("op_count"), "Debug must include op_count: {d}");
     }
+
+    #[test]
+    fn peer_id_is_wired_to_underlying_loro_doc() {
+        // Regression: prior to Phase 5.2.b the PeerId was stored on
+        // CollabSession but never passed to LoroDoc::set_peer_id, so
+        // op attribution at the CRDT layer used Loro's random
+        // per-doc peer id. After 5.2.b the configured PeerId MUST
+        // appear as the underlying log's peer_id().
+        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
+        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
+        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
+    }
+
+    #[test]
+    fn from_snapshot_overrides_imported_peer_id() {
+        // The origin session writes ops under PeerId(11). The reborn
+        // session imports the snapshot but uses its own PeerId(22)
+        // for future appends — the imported ops keep their original
+        // attribution (Loro semantics), but log.peer_id() reflects
+        // the reborn's configured PeerId.
+        let origin = CollabSession::new(PeerId::new(11)).unwrap();
+        let bytes = origin.export_bytes().unwrap();
+        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
+        assert_eq!(reborn.op_log().peer_id(), 22);
+    }
 }
diff --git a/quantbook-engine/crates/ql-oplog/src/log.rs b/quantbook-engine/crates/ql-oplog/src/log.rs
index 15653dd6f5f..a1fb21c574f 100644
--- a/quantbook-engine/crates/ql-oplog/src/log.rs
+++ b/quantbook-engine/crates/ql-oplog/src/log.rs
@@ -125,6 +125,36 @@ impl OpLog {
         self.cached_len == 0
     }
 
+    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
+    ///
+    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
+    /// to wire its stable `PeerId` through to Loro so concurrent
+    /// appends carry the right origin in the CRDT merge metadata.
+    ///
+    /// Loro takes `&self` (interior mutability), so this method is
+    /// `&self` too. Idempotent — calling it twice with the same id
+    /// is a no-op.
+    ///
+    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
+    /// 1. NEVER reuse the same peer id across concurrent writers
+    ///    (multiple tabs / devices for the same user). Duplicate peer
+    ///    ids corrupt the document via conflicting OpIDs.
+    /// 2. Avoid pinning a peer id to a stable user/device identity
+    ///    unless you also enforce single-ownership locking. Prefer a
+    ///    per-process-random peer id.
+    /// 3. Setting peer id AFTER an import is safe — existing imported
+    ///    ops retain their original peer ids; only this log's future
+    ///    appends use the new id.
+    pub fn set_peer_id(&self, peer: u64) -> Result<(), OpLogError> {
+        self.doc.set_peer_id(peer)?;
+        Ok(())
+    }
+
+    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
+    pub fn peer_id(&self) -> u64 {
+        self.doc.peer_id()
+    }
+
     /// Export the log to a binary blob suitable for on-disk persistence.
     /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
     /// compressed.
@@ -293,4 +323,25 @@ mod tests {
             "expected Loro error for garbage bytes, got {result:?}"
         );
     }
+
+    #[test]
+    fn set_peer_id_changes_doc_peer_id() {
+        let log = OpLog::new();
+        let before = log.peer_id();
+        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
+        assert_eq!(log.peer_id(), 0xdead_beef_cafe_babe);
+        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
+    }
+
+    #[test]
+    fn set_peer_id_after_import_works() {
+        // Origin writes ops under peer 11.
+        let origin = OpLog::new();
+        origin.set_peer_id(11).unwrap();
+        let bytes = origin.export_bytes().unwrap();
+        // Reborn imports + reassigns peer id; future appends use 22.
+        let reborn = OpLog::import_bytes(&bytes).unwrap();
+        reborn.set_peer_id(22).unwrap();
+        assert_eq!(reborn.peer_id(), 22);
+    }
 }
diff --git a/quantbook-engine/docs/architecture/crdt-data-model.md b/quantbook-engine/docs/architecture/crdt-data-model.md
index 37e05235cb1..07577ad4abb 100644
--- a/quantbook-engine/docs/architecture/crdt-data-model.md
+++ b/quantbook-engine/docs/architecture/crdt-data-model.md
@@ -395,16 +395,14 @@ HIGH-3 (`ql-oplog → ql-io` cleanup, Tier D2 in v2 backlog) closed
 this session at commit `e15e8908742`. `ql-oplog` is the dependency
 floor.
 
-**Known scaffold limitation (Phase 5.2.a, deferred to Phase 5.5):**
-`CollabSession` stores `PeerId` but does NOT yet pass it to
-`LoroDoc::set_peer_id`. The op log writes ops under Loro's default
-random per-doc peer id. Multi-peer convergence still works for the
-shipped 2-peer probe test (Phase 5.2 D-4 at `2f217a2067a`) because
-each peer gets a distinct random Loro peer id at session-create.
-Phase 5.5 (Transport layer) adds the stable-peer-id wiring as part
-of the connect handshake. Until then, the `PeerId` newtype is a
-*label* (used in presence and FormatId D-1), not a Loro merge-rule
-input.
+**Peer-id wiring (Phase 5.2.b 2026-05-19, ✅ closed):** the
+scaffold's known limitation — `PeerId` stored as a label only — was
+closed by adding `OpLog::set_peer_id` and calling it from
+`CollabSession::new` + `CollabSession::from_snapshot`. The configured
+`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
+merge metadata attributes each session's appends correctly. Caller
+pitfall (from Loro docs): concurrent sessions MUST use distinct peer
+ids — duplicate ids corrupt the document via conflicting OpIDs.
 
 ## Decision matrix summary
 
diff --git a/quantbook-engine/docs/phase5/entry-plan.md b/quantbook-engine/docs/phase5/entry-plan.md
index 5cab2d358d6..113d03bea05 100644
--- a/quantbook-engine/docs/phase5/entry-plan.md
+++ b/quantbook-engine/docs/phase5/entry-plan.md
@@ -135,12 +135,12 @@ Total Phase 5 effort estimate: **~7-12 weeks**.
    `#[non_exhaustive]` pass + deprecated removals + per-crate
    stability docs shipped at `40bb584a25b`. Phase 5 additions
    to `Op`, error types, etc. won't break 0.2.0 consumers.
-6. **`ql-collab` scaffold limitation (Phase 5.2.a)** — `PeerId`
-   is stored as a label but not yet passed to `LoroDoc::set_peer_id`.
-   Multi-peer convergence works (Loro per-doc-random ids are
-   distinct) but stable peer-id wiring is deferred to Phase 5.5
-   transport handshake. See `crates/ql-collab/src/peer.rs`
-   module docstring for full context.
+6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
+   2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
+   from `CollabSession::new` + `from_snapshot`. PeerId now wired
+   through to Loro's merge metadata. Caller pitfall (concurrent
+   sessions MUST use distinct peer ids) documented in
+   `crates/ql-collab/src/peer.rs` + `crates/ql-oplog/src/log.rs`.
 
 ## Audit checkpoints
 

exec
/bin/zsh -lc 'cargo test -p ql-exec --test phase_5_2_d4_spill_2peer_probe' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'rg -n "label-only|label only|stored as a label|set_peer_id scaffold|scaffold limitation|scaffold-limitation|LoroDoc::set_peer_id|PeerId.*label|ql-collab.*stub|Stub crate `ql-collab` empty|ql-collab` is a 15-line stub" docs crates -g '"'*.md' -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 1 in 268ms:
zsh:1: unmatched "

 succeeded in 15184ms:
   Compiling ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
   Compiling ql-io v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io)
   Compiling ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 8.00s
     Running tests/phase_5_2_d4_spill_2peer_probe.rs (target/debug/deps/phase_5_2_d4_spill_2peer_probe-eb5baeb9a9501ca6)

running 4 tests
test d4_spill_blocking_survives_a_merges_b ... ok
test d4_spill_succeeds_when_concurrent_op_outside_footprint ... ok
test d4_spill_blocking_survives_b_merges_a ... ok
test d4_replay_of_merged_log_is_deterministic_across_runs ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


exec
/bin/zsh -lc "rg -n 'label-only|label only|stored as a label|set_peer_id scaffold|scaffold limitation|scaffold-limitation|LoroDoc::set_peer_id|PeerId.*label|ql-collab.*stub|Stub crate "'`ql-collab` empty|ql-collab` is a 15-line stub'"' docs crates -g '*.md' -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 258ms:
docs/architecture/crdt-data-model.md:312:Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/architecture/crdt-data-model.md:399:scaffold's known limitation — `PeerId` stored as a label only — was
docs/architecture/crdt-data-model.md:402:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
crates/ql-oplog/src/log.rs:130:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
crates/ql-oplog/src/log.rs:138:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
crates/ql-collab/src/peer.rs:11://!   `LoroDoc::set_peer_id` so concurrent appends carry the right
crates/ql-collab/src/peer.rs:13://!   5.2.a stored this as a label only).
crates/ql-collab/src/peer.rs:39:    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/known-gaps.md:114:| GAP-C-03 | `ql-collab` is a 15-line stub | `ql-collab/src/lib.rs` | Engine | Engine Phase 5.2 |
docs/known-gaps.md:116:| GAP-C-05 | No transport layer (WebSocket / offline sync) | Stub crate `ql-collab` empty | Engine | Engine Phase 5.5 |
crates/ql-collab/src/session.rs:22://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
crates/ql-collab/src/session.rs:78:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
crates/ql-collab/src/session.rs:256:        // CollabSession but never passed to LoroDoc::set_peer_id, so
docs/phase5/entry-plan.md:138:6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
docs/audits/2026-05-19-handoff-audit-codex.md:910:   309	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/audits/2026-05-19-handoff-audit-codex.md:1650:    10	//!   time; passed to Loro's `LoroDoc::set_peer_id` so concurrent
docs/audits/2026-05-19-handoff-audit-codex.md:1675:    35	    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/audits/2026-05-19-handoff-audit-codex.md:2580:   309	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each
docs/audits/2026-05-19-handoff-audit-codex.md:3829:    10	//!   time; passed to Loro's `LoroDoc::set_peer_id` so concurrent
docs/audits/2026-05-19-handoff-audit-codex.md:3854:    35	    /// (`LoroDoc::set_peer_id` takes `u64`).
docs/audits/2026-05-19-handoff-audit-codex.md:4157:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
docs/audits/2026-05-19-handoff-audit-codex.md:4182:- MEDIUM, T4, `crates/ql-collab/src/peer.rs:9-11` vs `crates/ql-collab/src/session.rs:74-91`: docs claim `PeerId` is passed to `LoroDoc::set_peer_id`, but `CollabSession` only stores it and `OpLog` exposes no peer-id setter. Next 5.2 work should add `OpLog::with_peer_id`/setter and call it.
docs/audits/2026-05-19-handoff-audit-consolidated.md:43:| M-7 | `crdt-data-model.md:356-383` ql-collab section says crate is empty and lists wrong deps | Codex | ✅ FIXED — refreshed to reflect 5.2.a scaffold state; documents the PeerId / set_peer_id scaffold limitation |
docs/audits/2026-05-19-handoff-audit-consolidated.md:44:| M-8 | `peer.rs` module + struct docstring claims PeerId is passed to `LoroDoc::set_peer_id` but it isn't | Codex | ✅ FIXED — docstrings updated to surface the Phase 5.2.a scaffold limitation; behavior change deferred to Phase 5.5 |
docs/audits/2026-05-19-handoff-audit-consolidated.md:77:- Codex caught the deeper `entry-plan.md` body drift (sub-item table, risks section, test count) and the `peer.rs` docstring lie about `LoroDoc::set_peer_id` (neither Opus nor self had checked the docstring against actual behavior).
docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:480:**Action:** not urgent. If Phase 5 introduces a new integration shape (collaboration), the natural home is `ql-collab/tests/` — which is currently empty since the crate is stub-only.
docs/audits/2026-05-19-phase-5-1-codex.md:460:   291	Loro 1.x exposes `LoroDoc::set_peer_id` + `UndoManager`. Each

codex
The dedicated D-4 spill probe passes: 4/4. It still relies on bare `OpLog` defaults rather than explicit peer ids, so it exercises Loro’s random-peer path, not the new stable-peer wiring path.
 succeeded in 269340ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.24s
     Running unittests src/lib.rs (target/debug/deps/ql_ai-56b2b6f970b00080)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_bench-3294c837de9ac1b5)

running 21 tests
test machine::tests::simd_struct_is_constructible ... ok
test synthetic::tests::columns_are_prefix_independent ... ok
test synthetic::tests::float64_columns_reproducible_across_calls ... ok
test synthetic::tests::float64_columns_shape_and_dtype ... ok
test synthetic::tests::float64_uniform_in_unit_interval ... ok
test tests::smoke ... ok
test synthetic::tests::phase0_constants_match_25m_cells ... ok
test synthetic::tests::splitmix64_different_seeds_diverge ... ok
test synthetic::tests::splitmix64_is_deterministic ... ok
test machine::tests::rustc_version_is_actual_not_msrv ... ok
test machine::tests::chunk_rows_default_matches_storage ... ok
test machine::tests::markdown_renders ... ok
test machine::tests::collect_populates_baseline_fields ... ok
test report::tests::default_criterion_constructs ... ok
test report::tests::fast_criterion_constructs ... ok
test synthetic::tests::mixed_fixture_sparse_nan_columns_have_nans ... ok
test synthetic::tests::mixed_fixture_shape_and_count ... ok
test synthetic::tests::mixed_fixture_volumes_integer_shape ... ok
test synthetic::tests::mixed_fixture_normal_returns_within_reasonable_sigma ... ok
test synthetic::tests::mixed_fixture_log_uniform_band_in_range ... ok
test synthetic::tests::mixed_fixture_reproducible_across_calls ... ok

test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.92s

     Running unittests src/lib.rs (target/debug/deps/ql_bindings_c-9197186d947f39eb)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_bindings_node-f9c231e873487b0d)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_bindings_wasm-b7365bdcf31c84ce)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_calcgraph-5a019843294fc3b9)

running 139 tests
test dirty::tests::empty_dirty_set ... ok
test dirty::tests::empty_seeds_no_op ... ok
test dirty::tests::mark_cell_creates_one_chunk_entry ... ok
test dirty::tests::mark_cell_at_max_row_does_not_panic ... ok
test dirty::tests::mark_different_columns_produces_separate_entries ... ok
test dirty::tests::mark_different_chunks_in_same_column_produces_multiple_entries ... ok
test dirty::tests::mark_range_in_single_chunk ... ok
test dirty::tests::mark_cell_panics_on_row_over_max - should panic ... ok
test dirty::tests::mark_same_chunk_repeatedly_keeps_one_entry ... ok
test dirty::tests::mark_range_panics_on_end_row_over_max - should panic ... ok
test dirty::tests::mark_range_with_reversed_bounds_panics - should panic ... ok
test dirty::tests::propagate_cell_to_cell_dependency ... ok
test dirty::tests::og05_acceptance_single_cell_write_marks_only_affected_chunk_in_source_column ... ok
test dirty::tests::propagate_handles_cycles_via_visited_set ... ok
test dirty::tests::propagate_diamond_dependency ... ok
test dirty::tests::propagate_multiple_seeds ... ok
test dirty::tests::propagate_single_seed_no_dependents ... ok
test dirty::tests::small_chunk_size_for_test_isolation ... ok
test dirty::tests::propagate_through_range_node_intermediary ... ok
test dirty::tests::zero_chunk_rows_panics - should panic ... ok
test edges::tests::add_edge_populates_both_sides ... ok
test edges::tests::add_edge_from_oob_panics - should panic ... ok
test dirty::tests::propagate_through_formula_region_node ... ok
test edges::tests::clear_outgoing_on_node_with_no_edges_is_empty ... ok
test edges::tests::add_edge_to_oob_panics - should panic ... ok
test edges::tests::clear_outgoing_returns_prior_targets_and_empties ... ok
test edges::tests::diamond_dependency ... ok
test edges::tests::clear_outgoing_oob_panics - should panic ... ok
test edges::tests::empty_adjacency_is_zero_everywhere ... ok
test edges::tests::multiple_edges_to_same_target_not_deduped ... ok
test edges::tests::push_node_grows_both_directions ... ok
test edges::tests::remove_back_pointer_preserves_others ... ok
test edges::tests::remove_back_pointer_removes_all_matching_entries ... ok
test fingerprint::tests::arc_str_content_not_identity ... ok
test fingerprint::tests::binary_operand_order_matters ... ok
test fingerprint::tests::binary_operator_matters ... ok
test fingerprint::tests::cellref_absolute_flags_matter ... ok
test fingerprint::tests::cellref_addr_round_trips ... ok
test fingerprint::tests::different_numbers_different_fingerprints ... ok
test dirty::tests::mark_range_across_chunks ... ok
test fingerprint::tests::formula_region_use_case_n_cells_with_same_formula ... ok
test fingerprint::tests::function_arg_count_matters ... ok
test fingerprint::tests::function_arg_order_matters ... ok
test fingerprint::tests::function_name_case_matters ... ok
test fingerprint::tests::golden_fingerprints_locked ... ok
test fingerprint::tests::nan_bit_pattern_handled_without_panic ... ok
test fingerprint::tests::nested_binary_deterministic ... ok
test fingerprint::tests::rangeref_variants_distinguish ... ok
test fingerprint::tests::same_expr_same_fingerprint ... ok
test fingerprint::tests::variant_tags_disambiguate_payload_collisions ... ok
test graph::tests::add_cell_node_bumps_revision_and_returns_sequential_ids ... ok
test graph::tests::add_edge_bumps_revision_and_populates_adjacency ... ok
test graph::tests::add_formula_region_node_carries_fingerprint ... ok
test fingerprint::tests::fingerprint_deterministic_across_repeated_calls ... ok
test graph::tests::add_range_node_returns_correct_variant ... ok
test graph::tests::add_spill_node_panics - should panic ... ok
test graph::tests::clear_outgoing_drops_edges_and_back_pointers ... ok
test graph::tests::clear_outgoing_is_idempotent_and_handles_empty ... ok
test graph::tests::clear_outgoing_preserves_other_dependents_back_pointers ... ok
test graph::tests::clear_range_deps_for_formula_clears_stripes_and_map ... ok
test graph::tests::clear_range_deps_preserves_other_formulas ... ok
test graph::tests::dependents_for_cell_empty_when_no_ranges_registered ... ok
test graph::tests::dependents_for_cell_precision_filters_false_positives ... ok
test graph::tests::determinism_rebind_same_plan_same_edges ... ok
test graph::tests::diamond_graph ... ok
test graph::tests::edge_order_preserved ... ok
test graph::tests::empty_graph_has_zero_state ... ok
test graph::tests::mixed_node_types_in_one_graph ... ok
test graph::tests::many_cell_nodes_get_sequential_ids ... ok
test graph::tests::multiple_ranges_per_formula_all_tracked ... ok
test graph::tests::out_of_bounds_add_edge_panics ... ok
test graph::tests::rebind_workflow_no_stale_false_circ ... ok
test graph::tests::out_of_bounds_node_lookup_panics ... ok
test graph::tests::dependents_for_cell_returns_sorted_vec ... ok
test graph::tests::rebind_workflow_no_stale_stripe_dirty ... ok
test graph::tests::register_range_dependency_inserts_into_stripes_and_lookup_map ... ok
test graph::tests::revision_only_bumps_on_structural_change ... ok
test graph::tests::register_range_dependency_oob_panics - should panic ... ok
test integration_tests::a4_assertion_1_whole_column_compressed_to_one_range_ref ... ok
test integration_tests::a4_assertion_3_chunked_reduce_counter_present_and_writable ... ok
test integration_tests::build_a_mini_graph ... ok
test integration_tests::formula_region_node_one_node_for_dense_column ... ok
test integration_tests::stripe_inserts_counter_increments_on_register ... ok
test node::tests::cell_node_constructs_and_compares ... ok
test node::tests::formula_region_node_constructs ... ok
test node::tests::node_enum_variants_are_distinguishable ... ok
test node::tests::node_id_index_is_u32_cast ... ok
test node::tests::range_node_constructs_with_whole_column ... ok
test node::tests::spill_node_shape_locked ... ok
test stats::tests::default_stats_zero ... ok
test stats::tests::stats_are_copy_and_eq ... ok
test stripes::tests::clear_for_formula_handles_stripe_with_multiple_deps_correctly ... ok
test stripes::tests::clear_for_formula_is_idempotent ... ok
test integration_tests::a4_assertion_2_n_formulas_share_one_stripe_no_scan_fallback ... ok
test stripes::tests::clear_for_formula_removes_from_all_stripes ... ok
test stripes::tests::cross_sheet_isolation ... ok
test stripes::tests::duplicate_register_idempotent ... ok
test stripes::tests::empty_index_zero_stripes ... ok
test stripes::tests::range_contains_rowcol_for_cells_variant ... ok
test stripes::tests::range_contains_rowcol_for_whole_column ... ok
test stripes::tests::range_contains_rowcol_for_whole_row ... ok
test stripes::tests::raw_map_accessor_exposes_internals_for_a4 ... ok
test stripes::tests::clear_for_formula_preserves_other_formulas ... ok
test stripes::tests::re_register_after_clear_works ... ok
test stripes::tests::register_panics_on_cells_reversed_cols - should panic ... ok
test stripes::tests::many_formulas_one_stripe_bucket ... ok
test stripes::tests::register_panics_on_cells_reversed_rows - should panic ... ok
test stripes::tests::register_panics_on_whole_column_reversed - should panic ... ok
test stripes::tests::register_panics_on_whole_row_reversed - should panic ... ok
test stripes::tests::reverse_index_populated_on_register ... ok
test stripes::tests::reverse_index_dedups_same_formula_same_stripe ... ok
test stripes::tests::square_cells_range_ties_to_row_stripes ... ok
test stripes::tests::tall_cells_range_uses_column_stripes ... ok
test stripes::tests::whole_column_registers_one_column_stripe ... ok
test stripes::tests::whole_column_spans_multiple_cols ... ok
test stripes::tests::whole_row_registers_one_row_stripe ... ok
test stripes::tests::wide_cells_range_uses_row_stripes ... ok
test topo::tests::cycle_with_acyclic_dependent ... ok
test topo::tests::diamond_dependency_orders_correctly ... ok
test topo::tests::dirty_subset_filters_edges_to_clean_nodes ... ok
test topo::tests::empty_dirty_returns_empty_schedule ... ok
test topo::tests::duplicate_seeds_are_deduped ... ok
test topo::tests::linear_chain_yields_dependency_first_order ... ok
test topo::tests::mixed_cycle_and_acyclic_in_same_dirty_subset ... ok
test topo::tests::nodes_not_in_dirty_subset_never_appear_in_output ... ok
test topo::tests::self_loop_in_dirty_subset_only_cycles_if_target_also_dirty ... ok
test topo::tests::schedule_with_empty_supplemental_matches_schedule ... ok
test topo::tests::single_node_no_edges_goes_to_sorted ... ok
test topo::tests::single_node_with_self_loop_goes_to_cycled ... ok
test topo::tests::supplemental_does_not_duplicate_existing_real_edge ... ok
test topo::tests::supplemental_edge_produces_correct_ordering ... ok
test topo::tests::supplemental_edge_produces_cycle ... ok
test topo::tests::supplemental_edge_to_non_dirty_node_ignored ... ok
test topo::tests::supplemental_self_loop_is_cycled ... ok
test topo::tests::supplemental_three_node_cycle_via_mixed_edges ... ok
test topo::tests::three_node_cycle ... ok
test topo::tests::two_node_cycle_goes_to_cycled ... ok
test topo::tests::deep_linear_chain_no_stack_overflow ... ok
test stripes::tests::a5_acceptance_100k_formulas_linear_scaling ... ok

test result: ok. 139 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s

     Running unittests src/lib.rs (target/debug/deps/ql_collab-29775d5c32bbf9e7)

running 14 tests
test peer::tests::display_is_16_hex_chars ... ok
test peer::tests::round_trips_through_u64 ... ok
test peer::tests::equality_and_hash_consistent ... ok
test transport::tests::noop_try_recv_after_close_errors ... ok
test transport::tests::noop_try_recv_returns_none_when_open ... ok
test transport::tests::noop_send_records_bytes ... ok
test transport::tests::noop_send_after_close_errors ... ok
test session::tests::peer_id_is_wired_to_underlying_loro_doc ... ok
test session::tests::new_session_is_empty ... ok
test session::tests::debug_impl_includes_peer_id_and_count ... ok
test session::tests::append_grows_log ... ok
test session::tests::from_snapshot_overrides_imported_peer_id ... ok
test session::tests::from_snapshot_reconstructs_op_count ... ok
test session::tests::merge_bytes_grows_log_with_remote_ops ... ok

test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_connectors-9f144529c060c5db)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_exec-79ceaccd8848d882)

running 636 tests
test aggregate_cache::tests::no_cache_always_misses ... ok
test aggregate_cache::tests::different_function_names_are_separate_entries ... ok
test aggregate_cache::tests::invalidate_at_drops_multiple_overlapping_entries ... ok
test aggregate_cache::tests::invalidate_at_drops_entry_when_cell_in_range ... ok
test aggregate_cache::tests::invalidate_at_skips_entry_when_cell_outside_range ... ok
test aggregate_cache::tests::clear_all_drops_everything_keeps_stats ... ok
test aggregate_cache::tests::store_then_lookup_hits ... ok
test calcgraph_session::tests::clear_formula_then_no_phantom_cycle ... ok
test calcgraph_session::tests::clear_formula_revokes_range_stripes ... ok
test calcgraph_session::tests::build_range_supplemental_dedups_overlapping_ranges ... ok
test calcgraph_session::tests::dep_suppressed_reference_fns_match_design ... ok
test calcgraph_session::tests::clear_formula_revokes_outgoing_graph_edges ... ok
test calcgraph_session::tests::dependents_for_table_returns_indexed_readers ... ok
test calcgraph_session::tests::empty_session_has_zero_nodes_and_zero_counts ... ok
test calcgraph_session::tests::graph_construction_uses_no_petgraph_types ... ok
test calcgraph_session::tests::h1_range_induced_cycle_detected ... ok
test calcgraph_session::tests::h1_range_induced_ordering_via_supplemental ... ok
test calcgraph_session::tests::dep_3_01_direct_cell_refs_captured ... ok
test calcgraph_session::tests::dir_3_02_write_outside_range_filtered_by_precision_check ... ok
test calcgraph_session::tests::h3_no_false_circ_after_rebind_to_constant ... ok
test calcgraph_session::tests::dir_3_03_whole_col_whole_row_bounded_all_supported ... ok
test calcgraph_session::tests::clear_formula_evicts_dep_state ... ok
test calcgraph_session::tests::dir_3_04_no_per_cell_edge_explosion_for_full_columns ... ok
test calcgraph_session::tests::dep_3_02_range_deps_remain_compressed ... ok
test calcgraph_session::tests::dep_3_03_named_deps_captured ... ok
test calcgraph_session::tests::on_column_rename_bumps_hook_count ... ok
test calcgraph_session::tests::mutation_hooks_each_bump_their_counter ... ok
test calcgraph_session::tests::on_column_rename_case_insensitive_table_lookup ... ok
test calcgraph_session::tests::h4_rebind_clears_stale_range_stripe_dirty ... ok
test calcgraph_session::tests::on_column_rename_dirties_all_table_readers ... ok
test calcgraph_session::tests::on_table_drop_bumps_hook_count ... ok
test calcgraph_session::tests::on_set_formula_is_idempotent_for_cell_node_creation ... ok
test calcgraph_session::tests::dir_3_01_write_inside_range_dirties_dependent ... ok
test calcgraph_session::tests::on_table_drop_is_case_insensitive_via_fallback_scan ... ok
test calcgraph_session::tests::on_table_rename_bumps_hook_count ... ok
test calcgraph_session::tests::on_column_rename_leaves_deps_tables_unchanged ... ok
test calcgraph_session::tests::graph_dependents_for_cell_remains_deterministic ... ok
test calcgraph_session::tests::on_table_rename_case_insensitive_fallback ... ok
test calcgraph_session::tests::on_table_rename_dirties_readers_directly ... ok
test calcgraph_session::tests::on_table_drop_marks_table_referencing_formulas_dirty ... ok
test calcgraph_session::tests::on_table_resize_bumps_hook_count ... ok
test calcgraph_session::tests::on_table_rename_updates_formula_deps_tables_in_place ... ok
test calcgraph_session::tests::on_table_rename_rekeys_index_and_dirties_readers ... ok
test calcgraph_session::tests::partial_dirty_literal_in_range_no_supplemental ... ok
test calcgraph_session::tests::on_table_resize_dirties_readers ... ok
test calcgraph_session::tests::cell_address_for_inverts_cell_node_for ... ok
test calcgraph_session::tests::producer_alias_dedupe_same_target_twice ... ok
test calcgraph_session::tests::producer_alias_reroutes_target_dep_to_anchor ... ok
test calcgraph_session::tests::producer_alias_single_formula_two_targets_collapse ... ok
test calcgraph_session::tests::producer_alias_leaves_non_target_dep_unchanged ... ok
test calcgraph_session::tests::rebind_clears_cell_reverse_index_for_old_deps ... ok
test calcgraph_session::tests::producer_alias_rebind_to_non_alias_evicts_anchor_dep ... ok
test calcgraph_session::tests::producer_alias_two_readers_one_anchor_both_dirty_together ... ok
test calcgraph_session::tests::dep_3_04_volatile_functions_marked ... ok
test calcgraph_session::tests::rebind_evicts_stale_table_to_formulas_entries ... ok
test calcgraph_session::tests::rebind_replaces_prior_deps ... ok
test calcgraph_session::tests::rebind_to_same_plan_yields_same_graph_state ... ok
test calcgraph_session::tests::rebuild_from_empty_workbook_is_empty ... ok
test calcgraph_session::tests::rebind_clears_graph_outgoing_edges ... ok
test calcgraph_session::tests::retroactive_edge_when_dep_becomes_formula ... ok
test calcgraph_session::tests::schedule_dirty_with_empty_dirty_is_empty_schedule ... ok
test calcgraph_session::tests::volatile_function_set_is_canonical ... ok
test calcgraph_session::tests::self_range_cycle_via_supplemental ... ok
test calcgraph_session::tests::walk_plan_for_deps_is_pure ... ok
test calcgraph_session::tests::clear_formula_evicts_self_and_dirties_downstream ... ok
test calcgraph_session::tests::table_to_formulas_index_populates_on_structured_ref ... ok
test env::tests::map_env_blank_for_missing ... ok
test calcgraph_session::tests::rebuild_from_workbook_starts_clean_no_dirty ... ok
test env::tests::map_env_eval_context_is_default_excel1900 ... ok
test env::tests::map_env_roundtrip ... ok
test env::tests::name_lookup_for_workbook_owning_sheet_out_of_range_falls_back ... ok
test env::tests::name_lookup_for_workbook_resolves_sheet_scoped_only ... ok
test env::tests::name_lookup_for_workbook_sheet_scoped_shadows_workbook_scoped ... ok
test env::tests::workbook_env_eval_context_reflects_default_excel1900 ... ok
test env::tests::name_lookup_for_workbook_unknown_name_returns_none ... ok
test env::tests::name_lookup_for_workbook_resolves_workbook_scoped ... ok
test env::tests::workbook_env_eval_context_reflects_excel1904_workbook ... ok
test env::tests::workbook_env_new_default_locale_is_en_us ... ok
test calcgraph_session::tests::set_name_dirties_all_referencing_formulas ... ok
test env::tests::workbook_env_new_propagates_workbook_locale_to_eval_context ... ok
test eval_result::tests::array_is_array ... ok
test eval_result::tests::into_scalar_for_test_returns_calc_for_degenerate_array ... ok
test eval_result::tests::equality_compares_scalar_to_scalar_only ... ok
test env::tests::workbook_env_ref_error_for_missing_sheet ... ok
test eval_result::tests::scalar_is_not_array ... ok
test eval_result::tests::into_scalar_for_test_returns_value_for_scalar ... ok
test eval_result::tests::into_scalar_for_test_returns_first_for_non_degenerate_array ... ok
test calcgraph_session::tests::rebuild_creates_one_cell_node_per_formula ... ok
test calcgraph_session::tests::h2_set_name_propagates_dirty_transitively ... ok
test calcgraph_session::tests::rebuild_aggregates_per_formula_failures ... ok
test env::tests::workbook_env_reads_existing_cell ... ok
test calcgraph_session::tests::sch_3_02_cycles_report_all_scc_members ... ok
test loader::tests::load_failure_surfaces_as_qbook_error ... ok
test lower::tests::classify_add_scalar_commutative ... ok
test calcgraph_session::tests::sch_3_01_dependency_chains_schedule_in_dependency_first_order ... ok
test calcgraph_session::tests::set_value_on_direct_cell_dep_dirties_formula ... ok
test lower::tests::classify_array_kernels ... ok
test lower::tests::classify_comparison_not_applicable ... ok
test lower::tests::classify_div_array_routes_to_scalar_evaluator ... ok
test lower::tests::classify_div_scalar_routes_to_scalar_evaluator ... ok
test lower::tests::classify_mul_scalar_commutative ... ok
test calcgraph_session::tests::sch_3_04_dirty_subset_avoids_unrelated_formulas ... ok
test lower::tests::classify_scalar_div_cellref_not_applicable ... ok
test lower::tests::classify_nested_binary_not_applicable ... ok
test lower::tests::classify_og02_mul_scalar ... ok
test lower::tests::classify_single_cellref_not_applicable ... ok
test lower::tests::classify_single_number_not_applicable ... ok
test lower::tests::classify_sub_scalar_non_commutative ... ok
test lower::tests::classify_unary_not_applicable ... ok
test calcgraph_session::tests::rebuild_is_deterministic_across_runs ... ok
test lower::tests::dispatch_mul_array ... ok
test lower::tests::dispatch_mul_scalar ... ok
test lower::tests::dispatch_not_applicable_returns_false ... ok
test lower::tests::dispatch_scalar_sub ... ok
test lower::tests::is_applicable_helper ... ok
test plan::tests::accepts_special_arg_lists_only_registered_reference_aware_matcher_pin ... ok
test lower::tests::og02_e2e_classify_then_dispatch ... ok
test plan::tests::at_all_combination_does_not_force_is_this_row ... ok
test plan::tests::at_array_literal_returns_top_left ... ok
test plan::tests::at_cellref_idempotent ... ok
test plan::tests::at_bare_column_structured_ref_sets_is_this_row_true ... ok
test plan::tests::at_function_inner_drops_wrapper ... ok
test calcgraph_session::tests::sch_3_03_schedule_is_deterministic_across_runs ... ok
test plan::tests::at_headers_combination_does_not_force_is_this_row ... ok
test plan::tests::at_multi_whole_column_returns_value_error ... ok
test plan::tests::at_scalar_bool_drops_wrapper ... ok
test plan::tests::at_range_without_anchor_errors ... ok
test plan::tests::at_single_cell_range_returns_single_cell ... ok
test plan::tests::at_scalar_number_drops_wrapper ... ok
test plan::tests::at_single_column_narrows_to_anchor_row ... ok
test plan::tests::at_single_column_out_of_row_span_returns_value_error ... ok
test plan::tests::at_single_row_out_of_col_span_returns_value_error ... ok
test plan::tests::at_two_d_range_always_returns_value_error ... ok
test plan::tests::at_single_row_narrows_to_anchor_col ... ok
test plan::tests::bind_array_literal_3x2_lowers ... ok
test plan::tests::bind_array_literal_lowers_element_wise ... ok
test plan::tests::at_whole_column_narrows_to_anchor_row ... ok
test plan::tests::bind_array_literal_one_empty_row_rejects ... ok
test plan::tests::at_whole_row_narrows_to_anchor_col ... ok
test plan::tests::bind_array_literal_rejects_function_cell ... ok
test plan::tests::bind_array_literal_rejects_name_ref_cell ... ok
test plan::tests::bind_array_literal_rejects_nested_array ... ok
test plan::tests::bind_array_literal_rejects_non_literal_cell ... ok
test plan::tests::bind_array_literal_rejects_ragged_via_arity_error ... ok
test plan::tests::bind_array_literal_singleton_lowers ... ok
test plan::tests::bind_array_literal_zero_rows_rejects ... ok
test plan::tests::bind_binary_mul ... ok
test plan::tests::bind_bool ... ok
test plan::tests::bind_cellref_resolved_sheet_kept ... ok
test plan::tests::bind_cellref_unresolved_sheet_uses_owning ... ok
test plan::tests::bind_current_sheet_resolves_to_owning_sheet ... ok
test plan::tests::bind_empty_sheet_resolver_rejects_all_sheet_names ... ok
test plan::tests::bind_error_literal_lowers_to_expr_plan_error ... ok
test plan::tests::bind_function_lands_in_w4_5 ... ok
test plan::tests::bind_function_with_nested_cellref ... ok
test plan::tests::bind_number ... ok
test plan::tests::bind_rangeref_unsupported ... ok
test plan::tests::bind_resolves_sheet_ref_name_case_insensitively ... ok
test plan::tests::bind_resolves_sheet_ref_name_via_resolver ... ok
test plan::tests::bind_sheet_resolution_propagates_through_binary_op ... ok
test plan::tests::bind_structured_ref_all_resolves_to_full_footprint ... ok
test plan::tests::bind_structured_ref_bare_column_resolves_to_data_range ... ok
test plan::tests::bind_structured_ref_column_range ... ok
test plan::tests::bind_structured_ref_special_column_intersection ... ok
test plan::tests::bind_structured_ref_unknown_column_errors ... ok
test plan::tests::bind_unary_minus ... ok
test plan::tests::bind_unknown_sheet_name_surfaces_as_error ... ok
test plan::tests::bind_structured_ref_headers_on_table_without_header_errors ... ok
test loader::tests::empty_workbook_loads_and_recomputes_trivially ... ok
test plan::tests::bind_structured_ref_this_row_column_sets_flag ... ok
test plan::tests::bind_structured_ref_unknown_table_errors ... ok
test plan::tests::bind_structured_ref_headers_resolves_to_header_row ... ok
test plan::tests::nested_at_collapses ... ok
test plan::tests::r1c1_bind_absolute_at_grid_boundary ... ok
test plan::tests::r1c1_bind_absolute_lowers_to_cellref ... ok
test plan::tests::r1c1_bind_absolute_no_anchor_still_works ... ok
test plan::tests::r1c1_bind_absolute_overflow_rejected ... ok
test plan::tests::r1c1_bind_bare_rc_resolves_to_anchor ... ok
test plan::tests::r1c1_bind_mixed_abs_row_rel_col_per_axis_flags ... ok
test plan::tests::r1c1_bind_relative_lowers_against_anchor ... ok
test plan::tests::r1c1_bind_relative_overflow_rejected ... ok
test plan::tests::r1c1_bind_relative_underflow_rejected ... ok
test plan::tests::r1c1_bind_relative_without_anchor_rejected ... ok
test plan::tests::r1c1_bind_sheet_qualified_resolves_sheet_id ... ok
test plan::tests::r1c1_bind_unknown_sheet_errors ... ok
test plan::tests::r1c1_variant_kind_string ... ok
test plan_cache::tests::clear_resets_state ... ok
test plan_cache::tests::build_failure_does_not_cache ... ok
test plan_cache::tests::different_name_generation_misses ... ok
test plan_cache::tests::empty_cache_stats_have_no_hit_rate ... ok
test plan_cache::tests::different_sheet_misses ... ok
test plan_cache::tests::insert_pre_warms_then_lookup_hits ... ok
test plan::tests::step_2_reference_aware_names_registered_in_reference_tier ... ok
test plan_cache::tests::miss_then_hit ... ok
test scalar::tests::arithmetic_lenient_coerces_numeric_text ... ok
test scalar::tests::arithmetic_lenient_handles_percent_text ... ok
test scalar::tests::arithmetic_lenient_unparseable_text_is_value_error ... ok
test scalar::tests::arithmetic_overflow_to_num_error ... ok
test scalar::tests::array_literal_as_aggregate_arg_propagates_error_cell ... ok
test scalar::tests::array_literal_count_with_mixed_types ... ok
test scalar::tests::array_literal_counta_with_mixed_types ... ok
test scalar::tests::array_literal_in_range_aware_function_still_calc_error ... ok
test scalar::tests::array_literal_max_with_negative_and_error ... ok
test scalar::tests::array_literal_average_with_only_numbers ... ok
test scalar::tests::array_literal_in_non_aggregate_function_still_calc_error ... ok
test scalar::tests::array_literal_max_without_error_short_circuit ... ok
test scalar::tests::array_literal_sum_2d_array_row_major ... ok
test scalar::tests::array_literal_product_with_only_numbers ... ok
test scalar::tests::binary_mul_is_og02_op ... ok
test scalar::tests::array_literal_sum_mixed_with_scalar_arg ... ok
test scalar::tests::binary_div ... ok
test scalar::tests::binary_minus ... ok
test scalar::tests::array_literal_nested_aggregate_sum_of_sum ... ok
test scalar::tests::binary_op_with_error_literal_propagates ... ok
test scalar::tests::binary_plus ... ok
test scalar::tests::array_literal_sum_singleton ... ok
test scalar::tests::array_literal_sum_with_only_numbers ... ok
test scalar::tests::blank_plus_number_yields_number ... ok
test scalar::tests::bool_literal ... ok
test scalar::tests::bool_plus_number_coerces_to_one ... ok
test scalar::tests::cell_ref_missing_is_blank ... ok
test scalar::tests::cell_ref_reads_from_env ... ok
test scalar::tests::compare_blank_equals_zero ... ok
test scalar::tests::compare_number_less_than_text_excel_canon ... ok
test scalar::tests::compare_number_not_greater_or_equal_text_excel_canon ... ok
test scalar::tests::compare_same_type_numbers_unchanged ... ok
test scalar::tests::compare_text_less_than_boolean_excel_canon ... ok
test scalar::tests::comparison_eq ... ok
test scalar::tests::comparison_ge ... ok
test scalar::tests::comparison_lt ... ok
test scalar::tests::concat_number_and_string ... ok
test scalar::tests::concat_two_strings ... ok
test scalar::tests::context_aware_dispatch_order_range_aware_wins ... ok
test scalar::tests::context_aware_dispatch_pre_evaluates_args ... ok
test scalar::tests::context_aware_dispatch_uses_env_eval_context ... ok
test scalar::tests::context_aware_dispatch_routes_to_registered_fn ... ok
test scalar::tests::div_by_zero_scalar_returns_div_zero_error ... ok
test scalar::tests::div_cellref_by_zero_cellref_returns_div_zero_error ... ok
test scalar::tests::div_by_zero_yields_div_zero_error ... ok
test scalar::tests::error_in_lhs_propagates ... ok
test scalar::tests::error_in_rhs_propagates ... ok
test scalar::tests::eval_at_cell_boundary_1x1_array_stays_array ... ok
test scalar::tests::eval_at_cell_boundary_2x2_array_literal_returns_array_value ... ok
test scalar::tests::eval_at_cell_boundary_array_with_error_cell_preserves_error_per_cell ... ok
test scalar::tests::eval_at_cell_boundary_scalar_plan_returns_scalar ... ok
test scalar::tests::eval_scalar_expr_plan_error_returns_value_error ... ok
test scalar::tests::eval_scalar_expr_plan_array_in_scalar_context_returns_calc_error ... ok
test scalar::tests::eval_at_cell_boundary_sequence_2x2_returns_array ... ok
test scalar::tests::eval_at_cell_boundary_sequence_zero_returns_num_error ... ok
test scalar::tests::eval_at_cell_boundary_function_returning_scalar_stays_scalar ... ok
test scalar::tests::eval_scalar_with_cache_expr_plan_error_returns_value_error ... ok
test loader::tests::multiple_formulas_all_recomputed ... ok
test scalar::tests::eval_scalar_with_cache_expr_plan_array_returns_calc_error ... ok
test scalar::tests::function_error_in_arg_propagates_via_excel_semantics ... ok
test scalar::tests::function_nested_in_binary ... ok
test scalar::tests::eval_at_cell_boundary_sequence_returns_array ... ok
test loader::tests::named_range_formula_round_trips_through_load_and_recompute ... ok
test scalar::tests::function_unknown_name_via_registry_yields_name_error ... ok
test scalar::tests::function_if_via_registry ... ok
test scalar::tests::function_without_registry_yields_name_error ... ok
test scalar::tests::function_var_uses_two_pass_via_registry ... ok
test scalar::tests::nan_literal_becomes_num_error ... ok
test scalar::tests::lhs_error_wins_over_rhs_error ... ok
test scalar::tests::nested_a1_plus_b1_times_2 ... ok
test scalar::tests::number_literal ... ok
test scalar::tests::function_sum_via_registry ... ok
test scalar::tests::function_sum_with_cellrefs_via_registry ... ok
test scalar::tests::og02_pattern_cell_times_two ... ok
test scalar::tests::pow_basic ... ok
test scalar::tests::pow_negative_base_with_fractional_exponent_yields_num_error ... ok
test scalar::tests::pow_normal_unchanged ... ok
test loader::tests::load_and_recompute_refreshes_formula_values ... ok
test scalar::tests::pow_zero_negative_exp_is_div_zero_excel_canon ... ok
test scalar::tests::pow_zero_zero_is_num_error_excel_canon ... ok
test scalar::tests::string_literal ... ok
test scalar::tests::text_plus_number_yields_value_error ... ok
test scalar::tests::unary_minus ... ok
test scalar::tests::unary_percent ... ok
test simd::tests::add_array_basic ... ok
test simd::tests::add_scalar_basic ... ok
test loader::tests::load_and_recompute_on_workbook_without_formulas_is_clean ... ok
test simd::tests::mul_array_basic ... ok
test simd::tests::mul_scalar_empty ... ok
test loader::tests::spill_sequence_formula_round_trip ... ok
test scalar::tests::sequence_in_scalar_subexpression_produces_calc_error ... ok
test simd::tests::mul_scalar_small ... ok
test loader::tests::recompute_failure_preserves_partial_workbook_in_result ... ok
test simd::tests::mul_scalar_length_mismatch_panics - should panic ... ok
test simd::tests::scalar_sub_basic ... ok
test simd::tests::sub_scalar_basic ... ok
test transaction::tests::commit_with_no_ops_is_noop ... ok
test simd::tests::mul_scalar_one_chunk ... ok
test transaction::tests::commit_empty_transaction_emits_no_batch_commit ... ok
test simd::tests::og03_output_buffer_reuse_across_chunks ... ok
test loader::tests::spill_formula_save_load_recompute_round_trip ... ok
test transaction::tests::dropping_transaction_without_commit_leaves_workbook_unchanged ... ok
test loader::tests::spill_transpose_named_range_round_trip ... ok
test transaction::tests::dropping_transaction_without_commit_emits_nothing ... ok
test transaction::tests::formula_error_value_propagates_through_commit ... ok
test transaction::tests::named_blank_constant_surfaces_as_distinct_bind_error ... ok
test transaction::tests::commit_value_over_existing_formula_emits_clear_formula_inside_batch ... ok
test simd::tests::og02_correctness_consistency_with_scalar_path ... ok
test transaction::tests::named_error_constant_surfaces_as_distinct_bind_error ... ok
test transaction::tests::formula_then_value_on_same_cell_rejected_as_conflict ... ok
test transaction::tests::put_formula_rejects_invalid_sheet ... ok
test transaction::tests::last_write_wins_when_same_cell_written_twice ... ok
test transaction::tests::put_formula_rejects_col_above_max ... ok
test transaction::tests::put_formula_unresolved_name_errors_at_buffer_time ... ok
test transaction::tests::named_constant_resolves_inside_transaction ... ok
test transaction::tests::put_value_rejects_row_above_max ... ok
test transaction::tests::formula_sees_value_written_in_same_transaction ... ok
test transaction::tests::put_formula_commits_text_and_value ... ok
test transaction::tests::put_value_rejects_invalid_sheet ... ok
test transaction::tests::commit_emits_clear_formula_only_for_pre_existing_formula_cells ... ok
test transaction::tests::transaction_on_workbook_with_no_sheets_errors_at_buffer_time ... ok
test transaction::tests::commit_value_then_formula_emits_one_batch_commit_with_two_ops ... ok
test transaction::tests::put_formula_parse_error_rejects_op_immediately ... ok
test transaction::tests::paste_block_pattern_5x2_grid ... ok
test transaction::tests::multiple_value_writes_on_same_cell_still_allowed_after_conflict_fix ... ok
test transaction::tests::runtime_transaction_method_returns_working_tx ... ok
test transaction::tests::transaction_without_oplog_still_works ... ok
test transaction::tests::put_value_buffers_until_commit ... ok
test workbook_runtime::cells::tests::at_operator_round_trips_through_oplog_replay ... ok
test transaction::tests::value_write_clears_existing_formula ... ok
test transaction::tests::value_then_formula_on_same_cell_rejected_as_conflict ... ok
test workbook_runtime::cells::tests::coverage_matrix_dimension_counts ... ok
test workbook_runtime::cells::tests::at_scalar_idempotent_through_eval ... ok
test workbook_runtime::cells::tests::at_whole_row_evals_to_anchor_col ... ok
test workbook_runtime::cells::tests::coverage_matrix_has_no_duplicates ... ok
test workbook_runtime::cells::tests::at_function_with_scalar_return_passes_through ... ok
test workbook_runtime::cells::tests::at_whole_column_evals_to_anchor_row ... ok
test workbook_runtime::cells::tests::create_table_rejects_duplicate_column_names_case_insensitive ... ok
test workbook_runtime::cells::tests::create_table_rejects_footprint_past_max_column ... ok
test workbook_runtime::cells::tests::create_table_rejects_footprint_past_max_row ... ok
test workbook_runtime::cells::tests::create_table_rejected_when_footprint_contains_spill_anchor ... ok
test transaction::tests::transaction_via_runtime_inherits_oplog_handle ... ok
test workbook_runtime::cells::tests::clear_formula_at_spill_anchor_fires_on_set_value_for_targets ... ok
test workbook_runtime::cells::tests::create_table_rejects_footprint_u32_overflow_on_rows ... ok
test workbook_runtime::cells::tests::create_table_succeeds_when_anchor_is_outside_footprint ... ok
test workbook_runtime::cells::tests::clear_formula_at_non_anchor_cell_unchanged_behavior ... ok
test workbook_runtime::cells::tests::create_table_rejects_namespace_collision_with_defined_name ... ok
test workbook_runtime::cells::tests::create_table_rejects_overlap ... ok
test workbook_runtime::cells::tests::clear_formula_at_spill_anchor_reextracts_aliased_readers ... ok
test workbook_runtime::cells::tests::cross_sheet_formula_with_unknown_sheet_surfaces_bind_error_at_set_time ... ok
test workbook_runtime::cells::tests::mixed_relativity_r1c1_range_rejected_at_set_formula ... ok
test workbook_runtime::cells::tests::clear_formula_at_spill_anchor_dissolves_spill ... ok
test workbook_runtime::cells::tests::cross_sheet_cellref_evaluates_after_recompute ... ok
test workbook_runtime::cells::tests::clear_formula_at_spill_anchor_emits_only_clear_formula_op ... ok
test workbook_runtime::cells::tests::drop_table_missing_errors ... ok
test workbook_runtime::cells::tests::drop_table_removes_metadata_and_emits_op ... ok
test workbook_runtime::cells::tests::cross_sheet_quoted_name_with_space_evaluates ... ok
test workbook_runtime::cells::tests::locale_change_leaves_stored_formula_text_canonical ... ok
test workbook_runtime::cells::tests::cross_sheet_three_sheet_chain_evaluates ... ok
test workbook_runtime::cells::tests::de_locale_input_round_trips_through_oplog_replay ... ok
test workbook_runtime::cells::tests::drop_table_fires_on_table_drop_hook_and_emits_name_error ... ok
test workbook_runtime::cells::tests::plan_cache_at_range_collision_across_cells_regression ... ok
test workbook_runtime::cells::tests::drop_table_propagates_name_error_through_chain ... ok
test workbook_runtime::cells::tests::recompute_all_does_not_emit_ops ... ok
test workbook_runtime::cells::tests::recompute_all_materializes_sequence_spill ... ok
test workbook_runtime::cells::tests::r1c1_input_round_trips_through_oplog_replay ... ok
test workbook_runtime::cells::tests::recompute_all_array_formula_idempotent_across_two_passes ... ok
test workbook_runtime::cells::tests::recompute_dirty_sequence_grows_footprint ... ok
test workbook_runtime::cells::tests::recompute_all_materializes_spill_for_array_formula ... ok
test workbook_runtime::cells::tests::recompute_all_scalar_formula_unchanged ... ok
test workbook_runtime::cells::tests::recompute_dirty_dissolution_reextracts_aliased_readers ... ok
test workbook_runtime::cells::tests::resize_table_grow_succeeds_when_anchor_is_outside_new_footprint ... ok
test workbook_runtime::cells::tests::recompute_dirty_aliased_reader_sees_target_value_change_when_anchor_unchanged ... ok
test workbook_runtime::cells::tests::resize_table_grow_rejected_when_new_cells_contain_spill_anchor ... ok
test workbook_runtime::cells::tests::recompute_dirty_sequence_grows_dirties_new_target_readers ... ok
test workbook_runtime::cells::tests::reference_mode_change_leaves_stored_formula_text_canonical ... ok
test workbook_runtime::cells::tests::recompute_dirty_filter_with_named_ranges_grows_footprint ... ok
test workbook_runtime::cells::tests::runtime_add_sheet_emits_op_into_attached_oplog ... ok
test workbook_runtime::cells::tests::resize_table_rejects_growing_past_max_row ... ok
test workbook_runtime::cells::tests::runtime_set_name_reserved_name_does_not_append_op ... ok
test workbook_runtime::cells::tests::recompute_dirty_transpose_with_named_range_updates_on_value_change ... ok
test workbook_runtime::cells::tests::runtime_set_name_emits_op_into_attached_oplog ... ok
test workbook_runtime::cells::tests::runtime_without_oplog_set_value_and_set_formula_still_work ... ok
test workbook_runtime::cells::tests::recompute_dirty_sequence_shrinks_footprint ... ok
test workbook_runtime::cells::tests::runtime_clear_formula_emits_atomic_pair_when_formula_present ... ok
test workbook_runtime::cells::tests::set_formula_ai_returns_ai_not_available ... ok
test workbook_runtime::cells::tests::runtime_set_name_add_sheet_clear_formula_work_without_oplog ... ok
test workbook_runtime::cells::tests::opl_2b_02_full_op_vocabulary_producer_replay_equivalence ... ok
test workbook_runtime::cells::tests::set_formula_array_2x2_fires_three_on_set_value ... ok
test workbook_runtime::cells::tests::set_formula_array_literal_2x2_spills ... ok
test workbook_runtime::cells::tests::set_formula_array_literal_vertical_spills_3x1 ... ok
test workbook_runtime::cells::tests::set_formula_array_at_spill_target_dissolves_then_spills ... ok
test workbook_runtime::cells::tests::set_formula_array_blocked_by_user_value_at_target ... ok
test workbook_runtime::cells::tests::set_formula_array_reshape_fires_on_set_value_for_union ... ok
test workbook_runtime::cells::tests::set_formula_array_blocked_by_formula_at_target ... ok
test workbook_runtime::cells::tests::set_formula_array_reshape_records_one_op_per_call ... ok
test workbook_runtime::cells::tests::set_formula_array_writeback_fires_on_set_value_for_each_target ... ok
test workbook_runtime::cells::tests::set_formula_array_shrinks_clears_old_footprint ... ok
test workbook_runtime::cells::tests::set_formula_array_literal_horizontal_spills_1x3 ... ok
test workbook_runtime::cells::tests::set_formula_array_same_formula_twice_is_stable ... ok
test workbook_runtime::cells::tests::set_formula_filter_all_false_no_if_empty_produces_calc ... ok
test workbook_runtime::cells::tests::set_formula_at_anchor_does_not_double_clear_spill ... ok
test workbook_runtime::cells::tests::set_formula_filter_all_false_with_if_empty_spills_singleton ... ok
test workbook_runtime::cells::tests::set_formula_blocked_spill_does_not_fire_target_hooks ... ok
test workbook_runtime::cells::tests::set_formula_filter_of_sequence_in_arg_position_is_calc_error ... ok
test workbook_runtime::cells::tests::set_formula_at_spill_target_dissolves_host_spill ... ok
test workbook_runtime::cells::tests::set_formula_filter_column_keeps_truthy ... ok
test workbook_runtime::cells::tests::set_formula_at_non_spill_target_unchanged_behavior ... ok
test workbook_runtime::cells::tests::set_formula_filter_row_keeps_truthy ... ok
test workbook_runtime::cells::tests::set_formula_filter_with_named_range_args_binds_and_spills ... ok
test workbook_runtime::cells::tests::set_formula_invalid_cell_does_not_emit_op ... ok
test workbook_runtime::cells::tests::coverage_matrix_mode_locale_at_presence_30_cells ... ok
test workbook_runtime::cells::tests::set_formula_invalid_syntax_returns_parse_error ... ok
test simd::tests::mul_scalar_large ... ok
test workbook_runtime::cells::tests::set_formula_into_host_target_marks_host_anchor_dirty ... ok
test workbook_runtime::cells::tests::set_formula_dissolving_spill_dirties_old_target_readers ... ok
test workbook_runtime::cells::tests::set_formula_into_host_target_reextracts_aliased_readers ... ok
test workbook_runtime::cells::tests::set_formula_lex_error_does_not_emit_op ... ok
test workbook_runtime::cells::tests::set_formula_parse_error_does_not_emit_op ... ok
test workbook_runtime::cells::tests::set_formula_into_host_target_dirties_readers_of_other_host_targets ... ok
test workbook_runtime::cells::tests::set_formula_rejects_col_above_max ... ok
test workbook_runtime::cells::tests::set_formula_literal_arithmetic ... ok
test workbook_runtime::cells::tests::set_formula_rejects_invalid_sheet ... ok
test workbook_runtime::cells::tests::set_formula_into_spill_target_emits_put_formula_op ... ok
test workbook_runtime::cells::tests::set_formula_reads_existing_cell ... ok
test workbook_runtime::cells::tests::set_formula_reextract_aliases_pre_existing_reader_to_anchor ... ok
test workbook_runtime::cells::tests::set_formula_rejects_row_above_max ... ok
test workbook_runtime::cells::tests::set_formula_propagates_div_by_zero ... ok
test workbook_runtime::cells::tests::set_formula_reextract_skipped_on_blocked_spill_with_no_old_footprint ... ok
test workbook_runtime::cells::tests::set_formula_sequence_of_sequence_in_arg_position_is_error ... ok
test workbook_runtime::cells::tests::set_formula_sequence_inside_binary_op_produces_calc_error ... ok
test workbook_runtime::cells::tests::set_formula_trailing_tokens_returns_parse_error ... ok
test workbook_runtime::cells::tests::set_formula_stdev_p_dotted_function_dispatches ... ok
test workbook_runtime::cells::tests::set_formula_reextract_dedupes_across_old_and_new_footprint ... ok
test workbook_runtime::cells::tests::set_formula_reextract_unroutes_alias_after_spill_dissolves ... ok
test workbook_runtime::cells::tests::set_formula_sequence_zero_rows_produces_num_error ... ok
test workbook_runtime::cells::tests::set_formula_sequence_rows_only_spills_vertically ... ok
test workbook_runtime::cells::tests::set_formula_transpose_of_sequence_in_arg_position_is_calc_error ... ok
test workbook_runtime::cells::tests::set_formula_transpose_row_literal_spills_as_column ... ok
test workbook_runtime::cells::tests::set_formula_scalar_after_array_clears_spill_state ... ok
test workbook_runtime::cells::tests::set_formula_transpose_2x2 ... ok
test workbook_runtime::cells::tests::set_formula_var_s_dotted_function_dispatches ... ok
test workbook_runtime::cells::tests::set_formula_sequence_rows_cols_spills_2d ... ok
test workbook_runtime::cells::tests::set_formula_transpose_column_literal_spills_as_row ... ok
test workbook_runtime::cells::tests::set_formula_with_function_call ... ok
test workbook_runtime::cells::tests::set_formula_transpose_with_named_range_arg_binds_and_spills ... ok
test workbook_runtime::cells::tests::set_formula_with_oplog_emits_put_formula_text_only ... ok
test workbook_runtime::cells::tests::set_value_at_spill_anchor_dissolves_own_spill ... ok
test workbook_runtime::cells::tests::set_value_at_spill_target_dissolves_host_spill ... ok
test workbook_runtime::cells::tests::set_value_clears_existing_formula ... ok
test workbook_runtime::cells::tests::set_value_on_blank_cell_no_formula ... ok
test workbook_runtime::cells::tests::set_value_at_non_spill_cell_unchanged ... ok
test workbook_runtime::cells::tests::set_value_blank_emits_nothing_when_cell_is_already_blank ... ok
test workbook_runtime::cells::tests::set_value_rejects_invalid_cell ... ok
test workbook_runtime::cells::tests::set_value_rejects_invalid_sheet ... ok
test workbook_runtime::cells::tests::set_value_at_spill_target_reextracts_aliased_readers ... ok
test workbook_runtime::cells::tests::set_value_blank_over_formula_emits_clear_formula_only ... ok
test workbook_runtime::cells::tests::set_value_at_spill_target_marks_host_anchor_dirty ... ok
test workbook_runtime::cells::tests::set_value_with_oplog_emits_put_value ... ok
test workbook_runtime::cells::tests::set_value_over_existing_formula_emits_batch_commit_pair ... ok
test workbook_runtime::cells::tests::text_formula_invalid_format_returns_value_error ... ok
test workbook_runtime::config::tests::set_locale_noop_when_unchanged_emits_no_op ... ok
test workbook_runtime::cells::tests::text_formula_renders_through_recompute ... ok
test workbook_runtime::config::tests::set_reference_mode_updates_workbook_and_emits_op ... ok
test workbook_runtime::cells::tests::set_value_over_spill_anchor_formula_emits_batch_commit ... ok
test workbook_runtime::config::tests::set_reference_mode_noop_when_unchanged_emits_no_op ... ok
test workbook_runtime::config::tests::set_locale_updates_workbook_and_emits_op ... ok
test workbook_runtime::cells::tests::structured_ref_at_inside_vs_outside_brackets_eval_identically ... ok
test workbook_runtime::formats::tests::intern_and_set_cell_format_replay_round_trip ... ok
test workbook_runtime::formats::tests::intern_format_new_string_emits_register_op ... ok
test workbook_runtime::formats::tests::intern_format_duplicate_call_idempotent_no_second_op ... ok
test workbook_runtime::formats::tests::intern_format_returns_existing_builtin_id_no_oplog_op ... ok
test workbook_runtime::cells::tests::sheet_qualified_at_ref_resolves_correctly ... ok
test workbook_runtime::cells::tests::text_formula_with_number_format_returns_formatted_text ... ok
test workbook_runtime::formats::tests::read_display_general_path_for_unbound_cell ... ok
test workbook_runtime::formats::tests::read_display_error_value_passes_sigil_through ... ok
test workbook_runtime::formats::tests::set_cell_format_with_none_clears_overlay_and_emits_op ... ok
test workbook_runtime::formats::tests::set_cell_format_emits_op_and_updates_overlay ... ok
test workbook_runtime::formats::tests::read_display_text_value_through_at_format ... ok
test workbook_runtime::formats::tests::set_cell_format_unknown_id_is_runtime_error ... ok
test workbook_runtime::names::tests::runtime_error_bind_display_is_human_readable ... ok
test workbook_runtime::formats::tests::read_display_with_custom_format ... ok
test workbook_runtime::formats::tests::read_display_with_built_in_date_format ... ok
test workbook_runtime::names::tests::set_formula_named_range_in_scalar_context_errors ... ok
test workbook_runtime::names::tests::runtime_error_lex_display_is_human_readable ... ok
test workbook_runtime::formats::tests::read_display_caches_parsed_format ... ok
test workbook_runtime::names::tests::formula_resolves_sheet_scoped_over_workbook_scoped ... ok
test workbook_runtime::names::tests::set_formula_unresolved_name_errors ... ok
test workbook_runtime::names::tests::recompute_all_resolves_named_constant ... ok
test workbook_runtime::names::tests::set_formula_resolves_named_boolean_constant ... ok
test workbook_runtime::names::tests::set_sheet_scoped_name_invalid_sheet_errors ... ok
test workbook_runtime::names::tests::set_formula_resolves_named_text_constant ... ok
test workbook_runtime::names::tests::set_sheet_scoped_name_lands_on_sheet_table ... ok
test workbook_runtime::names::tests::set_formula_resolves_named_number_constant ... ok
test workbook_runtime::names::tests::set_sheet_scoped_name_emits_op_with_scope ... ok
test workbook_runtime::names::tests::set_sheet_scoped_name_reserved_name_rejected ... ok
test workbook_runtime::names::tests::set_formula_resolves_named_cell_target ... ok
test workbook_runtime::names::tests::set_name_uppercases_for_canonical_lookup ... ok
test workbook_runtime::names::tests::set_sheet_scoped_name_invalidates_plan_cache ... ok
test workbook_runtime::recompute::tests::cache_keys_are_stable_across_recompute_passes ... ok
test workbook_runtime::recompute::tests::agg_3_03_full_column_aggregate_remains_compressed ... ok
test workbook_runtime::recompute::tests::agg_3_04_results_match_scalar_baseline ... ok
test workbook_runtime::recompute::tests::cache_stats_flow_into_timings_struct ... ok
test transaction::tests::put_value_at_max_row_max_col_ok ... ok
test workbook_runtime::recompute::tests::mark_volatile_dirty_zero_when_no_volatile_formulas ... ok
test workbook_runtime::recompute::tests::nag_03_named_range_in_aggregate_function_binds_to_explicit_variant ... ok
test workbook_runtime::recompute::tests::nag_04_named_range_in_scalar_positions_errors_precisely ... ok
test workbook_runtime::recompute::tests::nag_02_named_cell_references_still_work ... ok
test workbook_runtime::recompute::tests::nag_01_named_constants_still_work_in_scalar_and_aggregate_contexts ... ok
test workbook_runtime::recompute::tests::agg_3_02_intersecting_write_invalidates_cache ... ok
test workbook_runtime::recompute::tests::named_formula_surfaces_distinct_bind_error ... ok
test workbook_runtime::recompute::tests::name_table_mutation_invalidates_bind_plan_cache ... ok
test workbook_runtime::recompute::tests::recompute_all_does_not_panic_on_invalid_persisted_formulas ... ok
test workbook_runtime::recompute::tests::agg_3_01_no_rescan_on_unrelated_writes ... ok
test workbook_runtime::recompute::tests::recompute_all_clears_stale_spill_when_anchor_becomes_circular ... ok
test workbook_runtime::recompute::tests::ovr_3_02b_clear_formula_promotes_value_to_user_lane ... ok
test workbook_runtime::recompute::tests::ovr_3_01_set_formula_writes_to_computed_overlay_not_user ... ok
test workbook_runtime::recompute::tests::rebuild_then_edit_keeps_cell_index_in_sync ... ok
test workbook_runtime::recompute::tests::ovr_3_02_typing_over_formula_clears_formula_and_computed ... ok
test workbook_runtime::recompute::tests::recompute_all_failure_carries_exact_cell_and_formula_text ... ok
test workbook_runtime::recompute::tests::recompute_all_does_not_short_circuit_on_first_failure ... ok
test workbook_runtime::recompute::tests::recompute_all_emits_circ_for_self_referential_a1_plus_one ... ok
test workbook_runtime::recompute::tests::recompute_all_eval_time_error_values_count_as_succeeded ... ok
test workbook_runtime::recompute::tests::recompute_all_on_empty_workbook_is_noop ... ok
test workbook_runtime::recompute::tests::recompute_all_handles_multiple_formulas ... ok
test workbook_runtime::recompute::tests::recompute_all_dependent_of_cycle_propagates_circ_error ... ok
test workbook_runtime::recompute::tests::recompute_all_emits_circ_for_two_cycle_a1_b1 ... ok
test workbook_runtime::recompute::tests::recompute_all_failed_cells_preserve_prior_state ... ok
test workbook_runtime::recompute::tests::recompute_dirty_returns_none_when_no_graph_attached ... ok
test workbook_runtime::recompute::tests::recompute_all_refreshes_formula_values ... ok
test workbook_runtime::recompute::tests::recompute_all_second_pass_is_all_cache_hits ... ok
test workbook_runtime::recompute::tests::ovr_3_04_read_cascade_consistent_across_lane_types ... ok
test workbook_runtime::recompute::tests::recompute_dirty_maps_unknown_sheet_to_name_error ... ok
test workbook_runtime::recompute::tests::recompute_all_maps_unknown_sheet_to_name_error ... ok
test workbook_runtime::recompute::tests::ovr_3_03_save_load_preserves_layer ... ok
test workbook_runtime::recompute::tests::recompute_all_isolates_cycle_from_acyclic_formulas ... ok
test workbook_runtime::recompute::tests::recompute_dirty_twice_in_a_row_is_idempotent ... ok
test workbook_runtime::recompute::tests::recompute_all_repeated_calls_are_idempotent_on_cycle ... ok
test workbook_runtime::recompute::tests::simd_3_01_og02_pattern_classifies_to_mul_scalar ... ok
test workbook_runtime::recompute::tests::runtime_without_graph_works_as_before ... ok
test workbook_runtime::recompute::tests::runtime_mutations_fire_calcgraph_hooks ... ok
test workbook_runtime::recompute::tests::recompute_dirty_skips_unrelated_formulas ... ok
test workbook_runtime::recompute::tests::runtime_with_oplog_and_graph_drives_both ... ok
test workbook_runtime::recompute::tests::set_formula_populates_cache_for_subsequent_recompute ... ok
test workbook_runtime::recompute::tests::recompute_dirty_writes_circ_error_for_cycle_members ... ok
test workbook_runtime::recompute::tests::veq_does_not_skip_volatile_formulas ... ok
test workbook_runtime::recompute::tests::recompute_dirty_cascades_dependency_chain ... ok
test workbook_runtime::recompute::tests::veq_3_03_profile_records_skipped_vertices ... ok
test workbook_runtime::recompute::tests::vol_3_02_nonvolatile_dependents_update_when_volatile_changes ... ok
test workbook_runtime::recompute::tests::veq_3_02_error_equality_suppresses_downstream ... ok
test workbook_runtime::recompute::tests::vol_3_03_seeded_rng_produces_deterministic_rand_sequence ... ok
test workbook_runtime::recompute::tests::simd_3_02_division_falls_back_to_scalar ... ok
test workbook_runtime::recompute::tests::veq_3_01_unchanged_upstream_suppresses_downstream_recompute ... ok
test workbook_runtime::cells::tests::recompute_all_out_of_bounds_spill_writes_spill_error ... ok
test workbook_runtime::recompute::tests::simd_3_03_profile_records_simd_eligible_formulas ... ok
test workbook_runtime::recompute::tests::vol_3_01_volatile_formulas_recompute_when_requested ... ok
test workbook_runtime::recompute::tests::w5_54_choose_e2e ... ok
test workbook_runtime::recompute::tests::save_load_recompute_e2e ... ok
test workbook_runtime::recompute::tests::w5_53_countif_named_range ... ok
test workbook_runtime::recompute::tests::w5_53_sumif_comparator_criteria ... ok
test workbook_runtime::recompute::tests::w5_53_sumif_named_range_numeric_criteria ... ok
test workbook_runtime::recompute::tests::w5_53_sumif_with_separate_sum_range ... ok
test workbook_runtime::recompute::tests::w5_53_sumif_recomputes_on_range_cell_change ... ok
test workbook_runtime::recompute::tests::w5_55_countifs_single_condition_e2e ... ok
test workbook_runtime::recompute::tests::w5_54_hlookup_exact_match_e2e ... ok
test workbook_runtime::recompute::tests::w5_55_averageif_e2e ... ok
test workbook_runtime::recompute::tests::w5_54_vlookup_exact_match_e2e ... ok
test workbook_runtime::sheets::tests::add_sheet_with_bad_name_emits_no_oplog_entry ... ok
test workbook_runtime::sheets::tests::add_sheet_rejects_canonical_duplicate ... ok
test workbook_runtime::sheets::tests::rename_sheet_duplicate_target_rejected_runtime ... ok
test workbook_runtime::sheets::tests::add_sheet_rejects_reserved_char ... ok
test workbook_runtime::recompute::tests::w5_54_vlookup_approximate_match_e2e ... ok
test workbook_runtime::sheets::tests::rename_sheet_unknown_id_rejected_runtime ... ok
test workbook_runtime::recompute::tests::w5_54_index_match_pattern_e2e ... ok
test workbook_runtime::recompute::tests::w5_54_vlookup_not_found_returns_na_e2e ... ok
test workbook_runtime::recompute::tests::w5_55_averageifs_e2e ... ok
test workbook_runtime::tables::tests::create_table_happy_path_registers_and_emits_op ... ok
test workbook_runtime::sheets::tests::rename_sheet_leaves_unrelated_formulas_alone ... ok
test workbook_runtime::recompute::tests::w5_55_sumifs_two_conditions_e2e ... ok
test workbook_runtime::recompute::tests::w5_55_sumproduct_two_columns_e2e ... ok
test workbook_runtime::tables::tests::rename_column_empty_target_errors ... ok
test workbook_runtime::sheets::tests::rename_sheet_case_only_rename_runtime ... ok
test workbook_runtime::tables::tests::rename_column_combination_form_rewritten ... ok
test workbook_runtime::tables::tests::rename_column_missing_source_errors ... ok
test workbook_runtime::tables::tests::create_table_then_sum_column_works ... ok
test workbook_runtime::tables::tests::rename_column_emits_ops ... ok
test workbook_runtime::tables::tests::rename_column_unknown_table_errors ... ok
test workbook_runtime::tables::tests::rename_column_happy_path_rewrites_formula_text ... ok
test workbook_runtime::tables::tests::rename_column_fires_hook_and_keeps_value_consistent ... ok
test workbook_runtime::tables::tests::rename_column_target_collision_errors ... ok
test workbook_runtime::tables::tests::rename_column_same_canonical_is_noop ... ok
test workbook_runtime::tables::tests::rename_column_other_table_unaffected ... ok
test workbook_runtime::sheets::tests::rename_sheet_rewrites_formula_text_and_recomputes ... ok
test workbook_runtime::tables::tests::resize_table_add_column_appends_new_column ... ok
test workbook_runtime::tables::tests::resize_table_added_column_duplicate_rejected ... ok
test workbook_runtime::tables::tests::rename_table_target_collision_with_table_errors ... ok
test workbook_runtime::tables::tests::resize_table_arithmetic_mismatch_rejected ... ok
test workbook_runtime::tables::tests::resize_table_exact_noop_emits_nothing ... ok
test workbook_runtime::tables::tests::resize_table_emits_ops ... ok
test workbook_runtime::tables::tests::rename_table_missing_source_errors ... ok
test workbook_runtime::tables::tests::resize_table_removed_columns_excess_count_rejected ... ok
test workbook_runtime::tables::tests::rename_table_emits_ops ... ok
test workbook_runtime::tables::tests::resize_table_overlap_with_other_table_rejected ... ok
test workbook_runtime::tables::tests::rename_table_happy_path_rewrites_formula_text ... ok
test workbook_runtime::tables::tests::resize_table_remove_last_column_drops_column ... ok
test workbook_runtime::tables::tests::rename_column_this_row_form_rewritten ... ok
test workbook_runtime::tables::tests::resize_table_zero_dims_rejected ... ok
test workbook_runtime::tables::tests::resize_table_unknown_table_errors ... ok
test workbook_runtime::tables::tests::resize_table_removed_columns_not_trailing_rejected ... ok
test workbook_runtime::tables::tests::resize_table_grow_rows_extends_sum_range ... ok
test workbook_runtime::tables::tests::rename_table_then_drop_new_name_emits_name_error ... ok
test workbook_runtime::tables::tests::resize_table_grow_then_recompute_dirty_picks_up_new_range_writes ... ok
test workbook_runtime::tables::tests::set_reference_mode_op_round_trips_through_replay ... ok
test workbook_runtime::tables::tests::set_formula_canonicalizes_r1c1_input_to_a1 ... ok
test workbook_runtime::tables::tests::set_formula_preserves_at_through_canonicalization ... ok
test workbook_runtime::cells::tests::set_formula_array_out_of_bounds_returns_spill ... ok
test workbook_runtime::tables::tests::resize_table_shrink_rows_truncates_sum_range ... ok
test workbook_runtime::tables::tests::set_formula_canonicalizes_de_locale_to_en ... ok
test workbook_runtime::validate::tests::add_sheet_rejects_zero_chunk_rows ... ok
test workbook_runtime::tables::tests::structured_ref_average_qty_column_works_end_to_end ... ok
test workbook_runtime::validate::tests::every_range_aware_fn_is_admitted_to_is_aggregate_function ... ok
test workbook_runtime::validate::tests::clear_formula_rejects_invalid_cell ... ok
test workbook_runtime::validate::tests::is_aggregate_function_lists_only_registered_aggregates ... ok
test workbook_runtime::validate::tests::clear_formula_rejects_invalid_sheet ... ok
test workbook_runtime::validate::tests::validate_formula_returns_anchor_value_for_top_level_array ... ok
test workbook_runtime::tables::tests::set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1 ... ok
test workbook_runtime::tables::tests::structured_ref_sum_qty_column_works_end_to_end ... ok
test workbook_runtime::validate::tests::nag_05_nested_aggregates_with_named_range_bind_cleanly ... ok
test workbook_runtime::validate::tests::nag_06_round_with_nested_sum_of_named_range_binds_cleanly ... ok
test workbook_runtime::validate::tests::validate_formula_surfaces_bind_errors ... ok
test workbook_runtime::tables::tests::structured_ref_at_column_narrows_to_current_row ... ok
test workbook_runtime::tables::tests::resize_table_remove_referenced_column_emits_name_error ... ok
test workbook_runtime::tables::tests::structured_ref_at_column_outside_table_returns_value_error ... ok
test workbook_runtime::validate::tests::validate_formula_does_not_pollute_plan_cache ... ok
test workbook_runtime::validate::tests::recompute_result_is_complete_is_single_source_of_truth ... ok
test workbook_runtime::validate::tests::validate_formula_returns_value_without_writing ... ok
test workbook_runtime::validate::tests::w5_d_13_1_atan2_and_sumxmy2_via_source_text ... ok
test workbook_runtime::validate::tests::w5_d_13_1_subtotal_named_range_binds_and_evaluates ... ok
test workbook_runtime::cells::tests::set_formula_at_max_row_max_col_ok ... ok
test workbook_runtime::validate::tests::w5_d_13_1_percentile_quartile_named_range_binds_and_evaluates ... ok
test workbook_runtime::validate::tests::w5_d_13_1_paired_array_stats_named_range_binds_and_evaluates ... ok
test transaction::tests::stress_10k_op_paste_block_completes_under_5s_debug ... ok

test result: ok. 636 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s

     Running tests/distribution_fns_e2e.rs (target/debug/deps/distribution_fns_e2e-791e1659779cf1a1)

running 111 tests
test beta_dist_with_optional_bounds_through_dispatcher ... ok
test binom_dist_cdf_at_n_through_dispatcher_returns_one ... ok
test beta_dist_uniform_cdf_through_dispatcher_returns_half ... ok
test beta_inv_with_optional_bounds_through_dispatcher ... ok
test beta_inv_uniform_at_half_through_dispatcher_returns_half ... ok
test binom_dist_k_greater_than_n_through_dispatcher_returns_num_error ... ok
test beta_dist_x_outside_bounds_through_dispatcher_returns_num_error ... ok
test binom_inv_p_one_through_dispatcher_returns_trials ... ok
test binom_dist_pmf_at_five_through_dispatcher_closed_form ... ok
test binom_dist_range_three_arg_form_through_dispatcher ... ok
test beta_inv_p_at_endpoints_through_dispatcher_returns_num_error ... ok
test beta_inv_dist_round_trip_through_dispatcher ... ok
test binom_inv_through_dispatcher_returns_smallest_k_with_cdf_at_least_alpha ... ok
test binom_dist_pmf_at_zero_through_dispatcher_closed_form ... ok
test binom_dist_range_reversed_through_dispatcher_returns_num_error ... ok
test binom_dist_range_full_through_dispatcher_returns_one ... ok
test binom_inv_trials_zero_through_dispatcher_panic_regression ... ok
test chisq_dist_cdf_at_zero_through_dispatcher_returns_zero ... ok
test chisq_dist_rt_at_zero_through_dispatcher_returns_one ... ok
test chisq_dist_negative_x_through_dispatcher_returns_num_error ... ok
test chisq_dist_rt_libreoffice_anchor_through_dispatcher ... ok
test chisq_inv_at_zero_prob_through_dispatcher_returns_zero ... ok
test chisq_inv_p_above_one_through_dispatcher_returns_num_error ... ok
test chisq_dist_libreoffice_anchor_through_dispatcher ... ok
test chisq_inv_rt_at_zero_prob_through_dispatcher_returns_num_error ... ok
test chisq_inv_rt_libreoffice_anchor_through_dispatcher ... ok
test chisq_inv_rt_at_one_prob_through_dispatcher_returns_zero ... ok
test chisq_inv_libreoffice_anchor_through_dispatcher ... ok
test confidence_t_size_10_through_dispatcher_statrs_self_consistent ... ok
test confidence_norm_alpha_zero_through_dispatcher_returns_num_error ... ok
test binom_poisson_case_insensitive_lookup_works ... ok
test chisq_inv_chisq_dist_round_trip_through_dispatcher ... ok
test confidence_t_size_less_than_two_through_dispatcher_returns_div_zero ... ok
test expon_dist_cdf_at_one_lambda_one_through_dispatcher ... ok
test expon_dist_lambda_zero_through_dispatcher_returns_num_error ... ok
test expon_dist_pdf_at_zero_through_dispatcher_returns_lambda ... ok
test f_dist_libreoffice_anchor_through_dispatcher ... ok
test chisq_f_dist_case_insensitive_lookup_works ... ok
test f_dist_rt_at_zero_through_dispatcher_returns_one ... ok
test confidence_norm_through_dispatcher_returns_z_critical_over_sqrt_n ... ok
test f_dist_rt_symmetry_through_dispatcher ... ok
test f_dist_negative_x_through_dispatcher_returns_num_error ... ok
test f_inv_libreoffice_anchor_through_dispatcher ... ok
test f_inv_p_negative_through_dispatcher_returns_num_error ... ok
test f_dist_cdf_symmetry_through_dispatcher ... ok
test f_inv_rt_at_zero_prob_through_dispatcher_returns_num_error ... ok
test f_inv_rt_libreoffice_anchor_through_dispatcher ... ok
test f_inv_at_half_equal_dfs_through_dispatcher ... ok
test chisq_f_dist_arity_mismatch_through_dispatcher_returns_value ... ok
test gamma_at_half_through_dispatcher_returns_sqrt_pi ... ok
test gamma_at_one_through_dispatcher_closed_form ... ok
test f_inv_rt_at_one_through_dispatcher_returns_zero ... ok
test gamma_inv_alpha_one_at_half_through_dispatcher_closed_form ... ok
test gamma_inv_p_at_zero_through_dispatcher_returns_zero ... ok
test gamma_inv_p_one_through_dispatcher_returns_num_error ... ok
test gamma_dist_negative_x_through_dispatcher_returns_num_error ... ok
test gamma_inv_subnormal_scale_through_dispatcher_panic_regression ... ok
test gamma_dist_alpha_one_at_one_through_dispatcher_closed_form ... ok
test gamma_ln_at_one_through_dispatcher_returns_zero ... ok
test gamma_negative_integer_through_dispatcher_returns_num_error ... ok
test gamma_inv_dist_round_trip_through_dispatcher ... ok
test lognorm_dist_x_zero_through_dispatcher_returns_num_error ... ok
test gamma_ln_at_four_through_dispatcher_closed_form ... ok
test gamma_ln_negative_x_through_dispatcher_returns_num_error ... ok
test lognorm_dist_cdf_at_one_standard_through_dispatcher_returns_half ... ok
test gamma_ln_precise_alias_through_dispatcher ... ok
test lognorm_inv_median_through_dispatcher_returns_exp_mean ... ok
test lognorm_inv_p_one_through_dispatcher_returns_num_error ... ok
test lognorm_inv_dist_round_trip_through_dispatcher ... ok
test negbinom_dist_pmf_at_zero_through_dispatcher_closed_form ... ok
test negbinom_dist_r_zero_through_dispatcher_returns_num_error ... ok
test norm_dist_zero_sd_through_dispatcher_returns_num_error ... ok
test norm_inv_ci_upper_through_dispatcher ... ok
test norm_inv_at_half_through_dispatcher_returns_mean ... ok
test norm_inv_zero_prob_through_dispatcher_returns_num_error ... ok
test norm_s_dist_at_one_sigma_through_dispatcher ... ok
test norm_s_dist_pdf_at_zero_through_dispatcher ... ok
test norm_s_inv_arity_mismatch_through_dispatcher_returns_value ... ok
test norm_dist_libreoffice_anchor_through_dispatcher ... ok
test norm_dist_case_insensitive_lookup_works ... ok
test norm_s_inv_at_half_through_dispatcher_returns_zero ... ok
test norm_dist_cdf_at_mean_through_dispatcher_returns_half ... ok
test norm_dist_pdf_through_dispatcher ... ok
test norm_s_inv_one_prob_through_dispatcher_returns_num_error ... ok
test norm_s_inv_ci_upper_through_dispatcher ... ok
test poisson_dist_negative_lambda_through_dispatcher_returns_num_error ... ok
test t_dist_2t_at_one_df_one_through_dispatcher ... ok
test poisson_dist_pmf_at_zero_lambda_one_through_dispatcher ... ok
test poisson_dist_lambda_zero_degenerate_through_dispatcher ... ok
test t_dist_df_less_than_one_through_dispatcher_returns_num_error ... ok
test t_dist_2t_negative_x_through_dispatcher_returns_num_error ... ok
test t_dist_rt_at_one_df_one_through_dispatcher ... ok
test t_dist_cdf_at_zero_through_dispatcher_returns_half ... ok
test t_dist_rt_at_zero_through_dispatcher_returns_half ... ok
test t_dist_rt_df_less_than_one_through_dispatcher_returns_num_error ... ok
test t_inv_2t_above_one_prob_through_dispatcher_returns_num_error ... ok
test t_dist_pdf_at_zero_df_one_through_dispatcher ... ok
test t_dist_rt_negative_x_through_dispatcher_returns_above_half ... ok
test t_dist_arity_mismatch_through_dispatcher_returns_value ... ok
test t_inv_2t_libreoffice_anchor_through_dispatcher ... ok
test t_inv_libreoffice_anchor_through_dispatcher ... ok
test t_inv_2t_zero_prob_through_dispatcher_returns_num_error ... ok
test t_inv_at_half_through_dispatcher_returns_zero ... ok
test t_inv_2t_at_p_one_through_dispatcher_returns_zero ... ok
test t_inv_p_greater_or_equal_one_through_dispatcher_returns_num_error ... ok
test t_inv_zero_prob_through_dispatcher_returns_num_error ... ok
test t_inv_t_dist_round_trip_through_dispatcher ... ok
test t_dist_case_insensitive_lookup_works ... ok
test w5_d_5_case_insensitive_lookup_works ... ok
test w5_d_4_arity_mismatch_through_dispatcher_returns_value ... ok
test w5_d_5_arity_mismatch_through_dispatcher_returns_value ... ok

test result: ok. 111 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/error_precedence.rs (target/debug/deps/error_precedence-10f70c4d01ebbfac)

running 15 tests
test precedence_iferror_passes_through_non_error_canon ... ok
test precedence_iserror_non_error_is_false_canon ... ok
test precedence_left_div_zero_error_propagates_canon ... ok
test precedence_error_wins_over_text_coercion_failure_canon ... ok
test precedence_actual_div_zero_when_no_arg_error_canon ... ok
test precedence_isna_distinguishes_na_from_other_errors_canon ... ok
test precedence_binary_op_error_propagates_before_coercion_canon ... ok
test precedence_iserr_excludes_na_canon ... ok
test precedence_if_cond_error_short_circuits_canon ... ok
test precedence_arg_error_beats_div_zero_canon ... ok
test precedence_iferror_catches_via_post_eval_introspection_canon ... ok
test precedence_iserror_introspects_canon ... ok
test precedence_binary_op_left_error_wins_canon ... ok
test precedence_sum_first_arg_error_wins_canon ... ok
test precedence_lone_text_coercion_failure_is_value_error_canon ... ok

test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/ide_simulation.rs (target/debug/deps/ide_simulation-944f1bfcf208d162)

running 7 tests
test ide_02_bind_errors_carry_user_facing_display ... ok
test ide_03_cancel_pattern_no_state_change ... ok
test ide_recompute_cache_observability ... ok
test ide_recompute_failures_are_per_cell ... ok
test ide_01_formula_edit_returns_value ... ok
test ide_04_paste_block_via_transaction ... ok
test ide_05_save_reload_preserves_state_and_oplog ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/oplog_e2e.rs (target/debug/deps/oplog_e2e-8e8edad97a0473da)

running 20 tests
test replay_rejects_resize_table_with_footprint_past_max_row ... ok
test replay_rejects_create_table_with_footprint_past_max_row ... ok
test oplog_replay_then_recompute_reconstructs_spill_anchor_for_array_function ... ok
test failed_set_formula_does_not_append_to_oplog ... ok
test oplog_replay_then_recompute_reconstructs_spill_for_literal_array ... ok
test composed_create_rename_column_resize_replay_roundtrip ... ok
test rename_column_op_log_replay_reconstructs_rename ... ok
test composed_save_load_then_rename_column_roundtrip ... ok
test create_table_op_log_replay_reconstructs_table ... ok
test drop_table_op_log_replay_removes_table ... ok
test resize_table_op_log_replay_reconstructs_resize ... ok
test mixed_runtime_and_transaction_producer_replays_equivalently ... ok
test runtime_produced_oplog_survives_binary_round_trip ... ok
test replayed_workbook_supports_load_recompute_convenience ... ok
test format_persistence_round_trip_through_qbook ... ok
test runtime_produced_oplog_replay_then_recompute_yields_observationally_equivalent_workbook ... ok
test standalone_transaction_with_oplog_produces_batch_commit ... ok
test transaction_produced_oplog_replay_then_recompute_yields_observationally_equivalent_workbook ... ok
test save_load_workbook_with_table_and_formula_roundtrips ... ok
test producer_save_load_replay_recompute_round_trip_yields_equivalent_workbook ... ok

test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/opus_a_phase_4_12_cross_features.rs (target/debug/deps/opus_a_phase_4_12_cross_features-7ad91339fd19ee73)

running 35 tests
test i10_rename_sheet_to_table_name_collision ... ignored
test i11_sheet_scoped_name_survives_sheet_rename ... ignored
test i12_drop_table_name_pointing_into_data_range_still_works ... ignored
test i13_many_names_lookup_does_not_blow_up ... ignored
test i14_format_intern_collision ... ignored
test i15_cross_sheet_ref_to_nonexistent_sheet ... ignored
test i16_read_display_stale_after_locale_switch ... ignored
test i17_read_display_stale_after_date_system_switch ... ignored
test i18_whole_column_sum ... ignored
test i19_cross_sheet_whole_column_via_name ... ignored
test i1_drop_table_invalidates_dependent_formulas ... ignored
test i20_structured_ref_after_host_sheet_rename_stress ... ignored
test i21_delete_sheet_not_supported ... ignored
test i22_single_letter_named_constant_vs_column_letter ... ignored
test i23_transpose_over_structured_ref ... ignored
test i24_blank_vs_zero_aggregate_skipping ... ignored
test i25_range_aware_fn_with_literal_range_arg ... ignored
test i26_structured_ref_from_third_sheet ... ignored
test i27_named_range_survives_sheet_rename ... ignored
test i2_sheet_scoped_name_shadows_workbook_scoped ... ignored
test i3_format_overlay_refresh_after_recompute ... ignored
test i4_array_formula_spill_downstream_visibility ... ignored
test i5_rename_sheet_with_formulas_referencing_old_sheet ... ignored
test i6_name_target_range_inside_table_after_resize ... ignored
test i7_clear_formula_dissolves_spill ... ignored
test i8_rename_table_collides_with_existing_name ... ignored
test i9_locale_change_after_canonicalization_preserves_formulas ... ignored
test w1a_cross_sheet_table_ref_with_name_then_resize ... ignored
test w1b_rename_sheet_hosting_table_doesnt_break_structured_ref ... ignored
test w1c_date1904_with_custom_format_renders_correctly ... ignored
test w2a_array_formula_over_table_then_resize ... ignored
test w3a_locale_de_parses_decimal_comma_in_formula ... ignored
test w3b_locale_de_with_semicolon_arg_separator ... ignored
test w4_oplog_replay_mixed_mutations_reproduces_state ... ignored
test w5_long_cross_sheet_chain_recomputes_downstream_after_source_change ... ignored

test result: ok. 0 passed; 0 failed; 35 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/p412_function_arg_fuzz.rs (target/debug/deps/p412_function_arg_fuzz-a3748bbdfa25d8b3)

running 15 tests
test cross_sheet_ref_after_rename ... ignored
test deep_dependency_chain_1000 ... ignored
test deep_dependency_chain_10000 ... ignored
test defined_name_self_reference ... ignored
test function_with_zero_args ... ignored
test iterative_kernels_near_singular ... ignored
test scalar_fns_with_nan_inf ... ignored
test self_referential_formula_direct ... ignored
test self_referential_sum_whole_column ... ignored
test sum_whole_column_million_cells_sparse ... ignored
test sum_with_1000_arg_list ... ignored
test sumproduct_with_2d_arrays ... ignored
test two_cycle_a1_b1 ... ignored
test two_cycle_a1_b1_with_graph ... ignored
test unknown_function_name ... ignored

test result: ok. 0 passed; 0 failed; 15 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/phase_5_2_d4_spill_2peer_probe.rs (target/debug/deps/phase_5_2_d4_spill_2peer_probe-b1c0fb58110c3426)

running 4 tests
test d4_spill_blocking_survives_b_merges_a ... ok
test d4_spill_succeeds_when_concurrent_op_outside_footprint ... ok
test d4_spill_blocking_survives_a_merges_b ... ok
test d4_replay_of_merged_log_is_deterministic_across_runs ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/reference_fns_coverage_extensions.rs (target/debug/deps/reference_fns_coverage_extensions-480b23d050ab9d8e)

running 14 tests
test row_of_sum_literal_range_bind_fails_v1_scope ... ok
test row_of_unknown_sheet_at_bind_time_surfaces_error_class ... ok
test row_of_cross_sheet_cell_ref_returns_row ... ok
test row_of_named_range_returns_top_left_row ... ok
test columns_of_named_range_returns_range_width ... ok
test column_of_named_range_returns_top_left_col ... ok
test columns_of_cross_sheet_range_returns_width ... ok
test rows_of_named_range_returns_range_height ... ok
test column_of_cross_sheet_cell_ref_returns_column ... ok
test rows_of_cross_sheet_range_returns_height ... ok
test row_of_sum_named_range_works_via_existing_aggregate_path ... ok
test column_zero_arg_with_formula_cell_via_workbook_env_returns_col ... ok
test row_zero_arg_evaluates_per_cell_via_plan_cache_sharing ... ok
test row_zero_arg_with_formula_cell_via_workbook_env_returns_row ... ok

test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/reference_fns_e2e.rs (target/debug/deps/reference_fns_e2e-848b71c61e1f9c15)

running 32 tests
test columns_of_single_cell_returns_1 ... ok
test column_with_arithmetic_arg_returns_value_error ... ok
test column_of_e10_returns_5 ... ok
test column_with_error_arg_propagates ... ok
test columns_of_whole_row_returns_16384 ... ok
test column_of_multi_cell_range_at_cell_boundary_returns_calc_error ... ok
test columns_of_a1_e1_returns_5 ... ok
test column_of_b5_returns_2 ... ok
test columns_of_array_literal_returns_second_dim ... ok
test column_of_literal_range_returns_top_left_col ... ok
test columns_of_a1_b3_returns_2 ... ok
test column_of_a1_returns_1 ... ok
test columns_with_no_args_returns_na ... ok
test row_in_scalar_context_with_range_returns_top_left ... ok
test row_of_a1_through_dispatcher_returns_1 ... ok
test row_of_b5_through_dispatcher_returns_5 ... ok
test row_of_single_cell_range_at_cell_boundary_returns_top_left ... ok
test row_of_multi_cell_range_at_cell_boundary_returns_calc_error ... ok
test row_with_arithmetic_arg_returns_value_error ... ok
test row_with_error_arg_propagates ... ok
test row_with_zero_args_in_scalar_context_returns_ref ... ok
test rows_of_a1_a5_returns_5 ... ok
test row_with_text_arg_returns_value_error ... ok
test row_of_literal_range_returns_top_left_row ... ok
test row_with_too_many_args_returns_na ... ok
test rows_of_a1_b3_returns_3 ... ok
test rows_of_single_cell_returns_1 ... ok
test rows_of_array_literal_returns_first_dim ... ok
test rows_of_whole_column_returns_1048576 ... ok
test rows_with_error_arg_propagates ... ok
test rows_with_no_args_returns_na ... ok
test rows_with_text_arg_returns_value_error ... ok

test result: ok. 32 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/reference_fns_step3_e2e.rs (target/debug/deps/reference_fns_step3_e2e-0bdc492f3fd3f1ba)

running 29 tests
test isformula_of_number_arg_returns_na ... ok
test isformula_of_blank_cell_returns_false ... ok
test isformula_of_named_cell_pointing_at_formula_returns_true ... ok
test isformula_of_formula_cell_returns_true ... ok
test isformula_of_sum_literal_range_bind_fails_v1_scope ... ok
test isformula_of_arithmetic_arg_returns_na ... ok
test isformula_arity_two_returns_na ... ok
test isformula_arity_zero_returns_na ... ok
test isformula_cross_sheet_returns_correct_status ... ok
test isformula_of_multi_cell_range_returns_na ... ok
test isformula_of_text_arg_returns_na ... ok
test isformula_propagates_ref_error ... ok
test isformula_of_cell_with_error_value_returns_false ... ok
test isformula_self_reference_returns_false_during_set_formula_v1_pin ... ok
test isref_arity_two_returns_na ... ok
test isformula_of_literal_cell_returns_false ... ok
test isref_arity_zero_returns_na ... ok
test isref_of_arithmetic_expr_returns_false ... ok
test isref_of_divide_by_zero_returns_false_without_eval ... ok
test isref_of_sum_literal_range_bind_fails_v1_scope ... ok
test isref_of_error_literal_returns_false ... ok
test isref_of_function_call_returns_false_v1_scope ... ok
test isref_of_literal_range_returns_true ... ok
test isref_of_cellref_returns_true ... ok
test isref_of_named_range_returns_true ... ok
test isref_of_number_literal_returns_false ... ok
test isref_of_text_literal_returns_false ... ok
test isref_of_volatile_fn_returns_false_without_evaluating ... ok
test row_of_cell_with_error_value_returns_row_index ... ok

test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/reference_fns_step4_e2e.rs (target/debug/deps/reference_fns_step4_e2e-5c5052a7a0506d81)

running 17 tests
test formulatext_cross_sheet_returns_text ... ok
test formulatext_of_complex_formula_returns_canonical_text ... ok
test formulatext_of_formula_cell_returns_text_with_leading_eq ... ok
test formulatext_of_arithmetic_arg_returns_na ... ok
test formulatext_arity_zero_returns_na ... ok
test formulatext_of_multi_cell_range_returns_na ... ok
test formulatext_of_text_arg_returns_na ... ok
test formulatext_of_cell_with_error_value_returns_na_not_propagated_error ... ok
test formulatext_arity_two_returns_na ... ok
test formulatext_of_sum_literal_range_bind_fails_v1_scope ... ok
test formulatext_of_named_cell_pointing_at_formula_returns_text ... ok
test formulatext_of_number_arg_returns_na ... ok
test formulatext_of_1x1_range_pointing_at_formula_returns_text ... ok
test formulatext_of_blank_cell_returns_na ... ok
test formulatext_propagates_ref_error ... ok
test formulatext_self_reference_returns_na_during_set_formula_v1_pin ... ok
test formulatext_of_literal_cell_returns_na ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/reference_fns_step5_cross_cutting.rs (target/debug/deps/reference_fns_step5_cross_cutting-a40d2d77d537ceaa)

running 15 tests
test isref_with_unknown_name_bind_fails ... ok
test at_prefix_on_row_with_range_arg_returns_top_left ... ok
test row_at_max_row_index_returns_max_row ... ok
test at_prefix_on_columns_with_range_arg_returns_columns ... ok
test isref_of_structured_ref_returns_true ... ok
test row_of_structured_ref_returns_top_left_data_row ... ok
test columns_of_structured_ref_full_table_returns_column_count ... ok
test rows_of_structured_ref_at_this_row_narrows_to_one ... ok
test formulatext_replay_yields_canonical_text ... ok
test isformula_replay_yields_false_when_target_cell_holds_literal ... ok
test rows_of_whole_column_at_max_returns_max_row_count ... ok
test isformula_recompute_after_a1_changes_from_literal_to_formula ... ok
test isformula_replay_yields_correct_result_when_target_cell_holds_formula ... ok
test rows_of_structured_ref_full_column_returns_data_row_count ... ok
test formulatext_of_cleared_formula_returns_na_after_clear ... ok

test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/reference_tier_dispatcher_smoke.rs (target/debug/deps/reference_tier_dispatcher_smoke-db83d9bf9aa5f3b7)

running 13 tests
test eager_dispatch_with_arity_zero_returns_na ... ok
test lazy_dispatch_with_error_literal_produces_planshape_error ... ok
test lazy_dispatch_does_not_evaluate_div_by_zero ... ok
test eager_dispatch_propagates_ref_context_workbook_default_is_noop_reference_query ... ok
test eager_dispatch_with_array_literal_produces_array_variant ... ok
test lazy_dispatch_with_arithmetic_produces_planshape_literal ... ok
test eager_dispatch_with_cellref_produces_reference_variant ... ok
test lazy_dispatch_with_string_literal_produces_planshape_literal ... ok
test eager_dispatch_with_arithmetic_arg_eager_evaluates_to_scalar ... ok
test lazy_dispatch_with_function_call_produces_planshape_function ... ok
test lazy_dispatch_with_cellref_produces_planshape_cellref ... ok
test lazy_dispatch_with_number_literal_produces_planshape_literal ... ok
test ref_arg_array_shape_matches_array_literal_shape ... ok

test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/region_mul2_e2e.rs (target/debug/deps/region_mul2_e2e-ea00711cdddb7bdc)

running 69 tests
test e2e_a1_times_two ... ok
test e2e_ai_with_no_args_also_returns_ai_not_available ... ok
test e2e_averagea_text_counts_as_zero ... ok
test e2e_ai_case_insensitive_dispatch ... ok
test e2e_base_conversion_through_dispatcher ... ok
test e2e_ai_function_returns_ai_not_available ... ok
test e2e_address_basic ... ok
test e2e_comparison_returns_bool ... ok
test e2e_correl_registered ... ok
test e2e_covariance_p_s_registered ... ok
test e2e_char_code_basic ... ok
test e2e_div_by_zero_yields_div_zero_error ... ok
test e2e_combin_combina ... ok
test e2e_complex_formula ... ok
test e2e_db_depreciation ... ok
test e2e_error_propagation_through_arithmetic ... ok
test e2e_dollar_negative ... ok
test e2e_fact_basic ... ok
test e2e_error_type_dispatches_on_dotted_name ... ok
test e2e_ddb_depreciation ... ok
test e2e_iferror_with_safe_value ... ok
test e2e_fixed_default_format ... ok
test e2e_bit_ops_through_dispatcher ... ok
test e2e_factdouble_basic ... ok
test e2e_ifna_passes_value_through ... ok
test e2e_if_function ... ok
test e2e_ifs_first_match ... ok
test e2e_maxa_diverges_from_max_on_text ... ok
test e2e_mirr_registered ... ok
test e2e_minifs_maxifs_countblank_registered ... ok
test e2e_n_value_text_coerces_to_zero ... ok
test e2e_nested_arithmetic ... ok
test e2e_iseven_isodd_basic ... ok
test e2e_na_returns_na_sigil ... ok
test e2e_npv_irr_registered ... ok
test e2e_erf_erfc_through_dispatcher ... ok
test e2e_og02_bare_column_bind_unsupported_in_phase_0 ... ok
test e2e_og02_source_to_simd_dispatch ... ok
test e2e_postfix_percent ... ok
test e2e_pearson_rsq_steyx_registered ... ok
test e2e_percentile_quartile_registered ... ok
test e2e_simple_addition ... ok
test e2e_paired_sum_variants_registered ... ok
test e2e_string_literal_and_concat ... ok
test e2e_pmt_zero_rate ... ok
test e2e_pv_zero_rate ... ok
test e2e_permut_permutationa ... ok
test e2e_slope_intercept_registered ... ok
test e2e_subtotal_109_normalizes_to_sum ... ok
test e2e_subtotal_invalid_function_num_is_value_error ... ok
test e2e_sln_syd_depreciation ... ok
test e2e_numbervalue_basic_enus ... ok
test e2e_subtotal_scalar_args_dispatch ... ok
test e2e_subtotal_registered ... ok
test e2e_unary_minus ... ok
test e2e_sum_function ... ok
test e2e_switch_with_default ... ok
test e2e_sumsq_basic ... ok
test e2e_switch_type_strict_no_match ... ok
test e2e_textjoin_registered ... ok
test e2e_unknown_function_returns_name_error ... ok
test e2e_value_basic_enus ... ok
test e2e_var_s_via_alias ... ok
test e2e_xlookup_xmatch_registered ... ok
test e2e_xnpv_xirr_registered ... ok
test rangeref_reexport_compiles ... ok
test e2e_unicode_unichar_basic ... ok
test e2e_vdb_depreciation ... ok
test e2e_xor_parity ... ok

test result: ok. 69 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/lib.rs (target/debug/deps/ql_formula_semantics-d287b63efe5960c0)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_formula_syntax-838196c1954ccbcf)

running 463 tests
test ast::tests::rangeref_cells_bounded_shape ... ok
test ast::tests::expr_simple_constructors_compile ... ok
test ast::tests::expr_structural_equality ... ok
test ast::tests::rangeref_variants_distinct ... ok
test ast::tests::rangeref_whole_column_shape ... ok
test ast::tests::expr_function_construction ... ok
test ast::tests::rangeref_whole_row_shape ... ok
test ast::tests::expr_binary_construction ... ok
test ast::tests::rewrite_column_ref_cross_table_isolation_holds ... ok
test ast::tests::rewrite_column_ref_string_literal_is_immune ... ok
test ast::tests::rewrite_column_ref_column_range_rewrites_only_matching_endpoint ... ok
test ast::tests::rewrite_is_case_insensitive_on_match ... ok
test ast::tests::rewrite_column_ref_this_row_column_range_rewrites_both_endpoints ... ok
test ast::tests::rewrite_column_ref_special_item_passes_through ... ok
test ast::tests::rewrite_non_matching_name_passes_through ... ok
test ast::tests::rewrite_recurses_into_binary_and_function ... ok
test ast::tests::rewrite_recurses_into_rangeref_cells ... ok
test ast::tests::rewrite_renames_matching_cellref_sheet_name ... ok
test ast::tests::rewrite_skips_current_and_id_sheet_refs ... ok
test lexer::tests::a_bracket_zero_lexes_as_structured_ref ... ok
test lexer::tests::ai_lexes_as_bare_column ... ok
test lexer::tests::ai_lexes_with_text_preserved ... ok
test lexer::tests::ascii_whitespace_only_no_nbsp ... ok
test lexer::tests::array_literal_shape_lexes_to_expected_token_stream ... ok
test lexer::tests::at_followed_by_cellref_lexes_as_two_tokens ... ok
test lexer::tests::at_inside_structured_ref_brackets_stays_inside_bracket_content ... ok
test lexer::tests::atan2_call_form_lexes_correctly ... ok
test lexer::tests::atan2_lexes_as_ident_via_letters_gt3_digit_fallback ... ok
test lexer::tests::bare_column_without_bracket_still_lexes_as_bare_column ... ok
test lexer::tests::bare_row_absolute_marker_preserved ... ok
test lexer::tests::bare_row_relative_marker_when_no_dollar ... ok
test lexer::tests::cell_ref_shaped_name_classifies_as_sheet_when_followed_by_bang ... ok
test lexer::tests::cellref_absolute_markers ... ok
test lexer::tests::cellref_basic ... ok
test lexer::tests::cellref_case_insensitive_column ... ok
test lexer::tests::cellref_followed_by_dot_still_works_as_separate_tokens ... ok
test lexer::tests::cellref_row_overflow_rejected ... ok
test lexer::tests::cellref_row_zero_rejected ... ok
test lexer::tests::column_letters_case_insensitive ... ok
test lexer::tests::column_letters_overflow_rejected ... ok
test lexer::tests::column_letters_zero_based ... ok
test lexer::tests::dangling_quoted_string_without_bang_errors ... ok
test lexer::tests::days360_lexes_as_ident_via_letters_gt3_digit_fallback ... ok
test lexer::tests::de_locale_backslash_acts_as_array_col_separator ... ok
test lexer::tests::de_locale_bare_comma_errors_invalid_number ... ok
test lexer::tests::de_locale_dot_acts_as_array_row_separator ... ok
test lexer::tests::de_locale_dot_not_decimal_splits_into_three_tokens ... ok
test lexer::tests::de_locale_full_array_literal_lexes_as_2x2 ... ok
test lexer::tests::de_locale_leading_comma_is_decimal_start ... ok
test lexer::tests::de_locale_scientific_notation_with_comma_decimal ... ok
test lexer::tests::de_locale_semicolon_acts_as_arg_separator ... ok
test lexer::tests::de_locale_separator_pair_dispatch_disambiguates_correctly ... ok
test lexer::tests::de_locale_treats_comma_inside_number_as_decimal ... ok
test lexer::tests::dollar_prefix_letters_gt3_digit_falls_through_to_cellref_path ... ok
test lexer::tests::dollar_prefixed_ident_does_not_match_structured_ref_lookahead ... ok
test lexer::tests::dotted_ident_digit_leading_segment_followed_by_args ... ok
test lexer::tests::dotted_ident_digit_leading_segment_lowercase_preserved ... ok
test lexer::tests::dotted_ident_digit_leading_segment_orphan_dot_rejects ... ok
test lexer::tests::dotted_ident_digit_leading_segment_pure_digit_rejects ... ok
test lexer::tests::dotted_ident_digit_leading_segment_rejects_trailing_digit ... ok
test lexer::tests::dotted_ident_digit_leading_segment_rejects_underscore ... ok
test lexer::tests::dotted_ident_digit_leading_segment_t_dist_2t ... ok
test lexer::tests::dotted_ident_digit_leading_segment_t_inv_2t ... ok
test lexer::tests::dotted_ident_function_call ... ok
test lexer::tests::dotted_ident_letter_then_digit_leading_segment_f_dist_rt ... ok
test lexer::tests::dotted_ident_lowercase_preserved_at_lex_time ... ok
test lexer::tests::dotted_ident_multi_dot ... ok
test lexer::tests::dotted_ident_multi_dot_digit_leading_final_segment ... ok
test lexer::tests::dotted_ident_rejects_leading_dollar ... ok
test lexer::tests::dotted_ident_rejects_trailing_digit ... ok
test lexer::tests::dotted_ident_rejects_trailing_dollar ... ok
test lexer::tests::dotted_ident_stdev_p ... ok
test lexer::tests::dotted_ident_var_s ... ok
test lexer::tests::dotted_sheet_name_supported ... ok
test lexer::tests::double_dollar_rejected ... ok
test lexer::tests::double_sheet_qualifier_lexes_but_parser_will_reject ... ok
test lexer::tests::empty_input_yields_empty_tokens ... ok
test lexer::tests::empty_string_literal ... ok
test lexer::tests::en_locale_separators_unchanged_after_4_9_b_3 ... ok
test lexer::tests::en_locale_treats_comma_outside_number_as_comma_token ... ok
test lexer::tests::en_locale_treats_dot_inside_number_as_decimal_unchanged ... ok
test lexer::tests::en_number_lex_regression_battery ... ok
test lexer::tests::error_sigil_ai_not_available_v1_followed_by_space_does_not_over_consume ... ok
test lexer::tests::error_sigil_ai_not_available_v1_lexes ... ok
test lexer::tests::error_sigil_binding_lexes ... ok
test lexer::tests::error_sigil_calc_lexes ... ok
test lexer::tests::error_sigil_case_insensitive ... ok
test lexer::tests::error_sigil_circ_lexes ... ok
test lexer::tests::error_sigil_disconnected_lexes ... ok
test lexer::tests::error_sigil_div_zero_with_slash_lexes ... ok
test lexer::tests::error_sigil_followed_by_digit_does_not_over_consume ... ok
test lexer::tests::error_sigil_in_array_lexes ... ok
test lexer::tests::error_sigil_inside_function_call_lexes ... ok
test lexer::tests::error_sigil_na_followed_by_letter_does_not_over_consume ... ok
test lexer::tests::error_sigil_na_lexes_without_trailing_punct ... ok
test lexer::tests::error_sigil_name_with_question_mark_lexes ... ok
test lexer::tests::error_sigil_null_lexes ... ok
test lexer::tests::error_sigil_num_lexes ... ok
test lexer::tests::error_sigil_permission_lexes ... ok
test lexer::tests::error_sigil_ref_lexes ... ok
test lexer::tests::error_sigil_spill_lexes ... ok
test lexer::tests::error_sigil_timeout_lexes ... ok
test lexer::tests::error_sigil_value_lexes ... ok
test lexer::tests::formula_a1_times_2 ... ok
test lexer::tests::formula_a_times_2 ... ok
test lexer::tests::formula_arithmetic_precedence_witnesses ... ok
test lexer::tests::formula_concat_strings ... ok
test lexer::tests::formula_function_call_shape ... ok
test lexer::tests::formula_negative_number_via_unary ... ok
test lexer::tests::formula_parentheses_grouping ... ok
test lexer::tests::fr_locale_treats_comma_inside_number_as_decimal ... ok
test lexer::tests::function_call_still_works_after_sheet_prefix_check ... ok
test lexer::tests::function_name_shaped_sheet_works_without_paren ... ok
test lexer::tests::function_name_table_ref_lexes_as_structured_ref ... ok
test lexer::tests::ident_bin2dec_hex2dec_oct2dec_all_lex_as_idents ... ok
test lexer::tests::ident_function_name ... ok
test lexer::tests::ident_inside_function_args_still_works ... ok
test lexer::tests::ident_letters_digits_letters_lexes_as_single_ident ... ok
test lexer::tests::ident_letters_digits_letters_with_dollar_falls_through ... ok
test lexer::tests::ident_letters_digits_letters_with_lparen ... ok
test lexer::tests::ident_long_function_name ... ok
test lexer::tests::ident_with_underscore ... ok
test lexer::tests::invalid_error_sigil_empty_body_surfaces_clean_error ... ok
test lexer::tests::invalid_error_sigil_surfaces_clean_error ... ok
test lexer::tests::invalid_number_errors ... ok
test lexer::tests::issue_148_closure_a_colon_a_still_works ... ok
test lexer::tests::issue_148_closure_aaa_lexes_as_structured_ref ... ok
test lexer::tests::issue_148_closure_src_lexes_as_structured_ref ... ok
test lexer::tests::lbrace_and_rbrace_lex_to_brace_tokens ... ok
test lexer::tests::leading_dot_routes_through_number_lexer_and_rejects ... ok
test lexer::tests::lex_and_lex_with_a1_enus_match_on_representative_inputs ... ok
test lexer::tests::log10_followed_by_lparen_preserves_text_for_function_dispatch ... ok
test lexer::tests::lex_with_accepts_all_mode_locale_combinations_without_panic ... ok
test lexer::tests::log10_lexes_as_cellref_with_text_for_parser ... ok
test lexer::tests::log10_still_lexes_as_cellref_no_regression ... ok
test lexer::tests::log2_still_lex_as_cellref_no_regression ... ok
test lexer::tests::lt_then_gt_is_lt_neq_combined_carefully ... ok
test lexer::tests::number_decimal ... ok
test lexer::tests::number_exponent ... ok
test lexer::tests::number_integer ... ok
test lexer::tests::number_overflow_rejected ... ok
test lexer::tests::orphan_dot_in_ident_position_errors ... ok
test lexer::tests::plain_ident_still_works_after_dot_extension ... ok
test lexer::tests::punctuation_tokens ... ok
test lexer::tests::quoted_sheet_name_with_escaped_quote ... ok
test lexer::tests::quoted_sheet_name_with_space ... ok
test lexer::tests::quoted_sheet_with_whitespace_before_bang ... ok
test lexer::tests::quoted_string_after_quote_uses_quoted_sheet_name_path ... ok
test lexer::tests::r1c1_a1_mode_leaves_r1_as_cellref ... ok
test lexer::tests::r1c1_absolute_pair_lexes_to_r1c1ref ... ok
test lexer::tests::r1c1_absolute_zero_col_rejected_as_malformed ... ok
test lexer::tests::r1c1_absolute_zero_row_rejected_as_malformed ... ok
test lexer::tests::r1c1_at_grid_boundary_accepted ... ok
test lexer::tests::r1c1_back_off_on_r_followed_by_non_c_letter ... ok
test lexer::tests::r1c1_back_off_on_r_followed_by_whitespace ... ok
test lexer::tests::r1c1_bare_rc_canonicalizes_to_rel_zero ... ok
test lexer::tests::r1c1_col_overflow_uses_column_too_large_error ... ok
test lexer::tests::r1c1_committed_then_non_c_rejected ... ok
test lexer::tests::r1c1_decimal_in_brackets_rejected ... ok
test lexer::tests::r1c1_dispatch_skipped_in_a1_mode_for_rc ... ok
test lexer::tests::r1c1_empty_brackets_rejected ... ok
test lexer::tests::r1c1_explicit_positive_sign_in_brackets ... ok
test lexer::tests::r1c1_inside_function_call_tokenizes_cleanly ... ok
test lexer::tests::r1c1_lowercase_lexes_same_as_uppercase ... ok
test lexer::tests::r1c1_missing_c_axis_after_committed_r_rejected ... ok
test lexer::tests::r1c1_mixed_abs_row_rel_col ... ok
test lexer::tests::r1c1_mixed_case_axis_prefixes_accepted ... ok
test lexer::tests::r1c1_mode_composes_with_de_locale ... ok
test lexer::tests::r1c1_range_lexes_as_two_refs_joined_by_colon ... ok
test lexer::tests::r1c1_relative_negative_row_bare_col_lexes ... ok
test lexer::tests::r1c1_relative_positive_offsets_both_axes ... ok
test lexer::tests::r1c1_row_overflow_uses_row_too_large_error ... ok
test lexer::tests::r1c1_sign_only_brackets_rejected ... ok
test lexer::tests::r1c1_unterminated_brackets_rejected ... ok
test lexer::tests::range_two_cells ... ok
test lexer::tests::range_whole_column ... ok
test lexer::tests::range_whole_row ... ok
test lexer::tests::sheet_prefix_takes_priority_over_a1_classification ... ok
test lexer::tests::sheet_qualified_at_ref_lexes_as_four_tokens ... ok
test lexer::tests::single_char_operators ... ok
test lexer::tests::standalone_at_lexes_to_token_at ... ok
test lexer::tests::string_escaped_quote ... ok
test lexer::tests::string_simple ... ok
test lexer::tests::string_unterminated_errors ... ok
test lexer::tests::structured_ref_dangling_escape_errors ... ok
test lexer::tests::structured_ref_escape_pairs ... ok
test lexer::tests::structured_ref_simple_column ... ok
test lexer::tests::structured_ref_unterminated_bracket_errors ... ok
test lexer::tests::structured_ref_with_nested_brackets ... ok
test lexer::tests::sumxmy2_call_form_lexes_correctly ... ok
test lexer::tests::sumxmy2_lexes_as_ident_via_letters_gt3_digit_fallback ... ok
test lexer::tests::two_char_operators ... ok
test lexer::tests::unexpected_char_errors ... ok
test lexer::tests::unquoted_sheet_prefix_emits_sheet_name_bang_then_cellref ... ok
test lexer::tests::unquoted_sheet_prefix_with_range ... ok
test lexer::tests::unterminated_quoted_sheet_name_errors ... ok
test lexer::tests::whitespace_around_bang_accepted ... ok
test lexer::tests::whitespace_is_skipped ... ok
test lexer::tests::whole_row_range_absolute_pattern ... ok
test locale::tests::de_separators_match_design_doc_section_3_2 ... ok
test locale::tests::de_vs_en_decimal_vs_arg_collision_avoided ... ok
test locale::tests::en_us_arg_and_array_col_share_comma_by_design ... ok
test locale::tests::en_us_separators_match_phase_4_7_canon ... ok
test locale::tests::fr_separators_match_design_doc_section_3_2 ... ok
test locale::tests::locale_separators_have_no_within_context_collisions ... ok
test parser::tests::at_does_not_affect_non_at_a1_parsing ... ok
test parser::tests::at_inside_function_argument ... ok
test parser::tests::at_wraps_cellref_into_implicit_intersection ... ok
test parser::tests::at_wraps_function_call ... ok
test parser::tests::at_wraps_scalar_number ... ok
test parser::tests::at_wraps_structured_ref ... ok
test parser::tests::at_wraps_whole_column_range ... ok
test parser::tests::in_bracket_at_does_not_produce_implicit_intersection ... ok
test parser::tests::nested_at_wraps_twice ... ok
test parser::tests::parse_ai_function_case_insensitive ... ok
test parser::tests::parse_ai_function_reservation_canonical ... ok
test parser::tests::parse_arithmetic_with_cellref_pattern ... ok
test parser::tests::parse_array_literal_1x3 ... ok
test parser::tests::parse_array_literal_2x2 ... ok
test parser::tests::parse_array_literal_3x1 ... ok
test parser::tests::parse_array_literal_3x2_three_rows ... ok
test parser::tests::parse_array_literal_arity_mismatch_rejects ... ok
test parser::tests::parse_array_literal_arity_mismatch_second_row_longer ... ok
test parser::tests::parse_array_literal_as_function_arg ... ok
test parser::tests::parse_array_literal_cell_ref_rejects ... ok
test parser::tests::parse_array_literal_double_semicolon_rejects ... ok
test parser::tests::parse_array_literal_empty_rejects ... ok
test parser::tests::parse_array_literal_false_lowercase_bool ... ok
test parser::tests::parse_array_literal_function_call_rejects ... ok
test parser::tests::parse_array_literal_nested_array_rejects ... ok
test parser::tests::parse_array_literal_singleton_1x1 ... ok
test parser::tests::parse_array_literal_unclosed_rejects ... ok
test parser::tests::parse_array_literal_with_bool_string_error_mixed ... ok
test parser::tests::parse_array_literal_with_negative_numbers ... ok
test parser::tests::parse_bare_identifier_function_name_to_name_ref ... ok
test parser::tests::parse_bare_identifier_unknown_name_to_name_ref ... ok
test parser::tests::parse_bool_literals_via_ident ... ok
test parser::tests::parse_cell_ref_a1 ... ok
test parser::tests::parse_cell_ref_absolute ... ok
test parser::tests::parse_comparison_eq ... ok
test parser::tests::parse_comparison_lower_precedence_than_concat ... ok
test parser::tests::parse_concat_lower_precedence_than_arithmetic ... ok
test parser::tests::parse_complex_formula ... ok
test parser::tests::parse_concat_string ... ok
test parser::tests::parse_dangling_bang_at_end_of_input ... ok
test parser::tests::parse_dotted_function_name ... ok
test parser::tests::parse_dotted_sheet_name ... ok
test parser::tests::parse_double_sheet_qualifier_rejected ... ok
test parser::tests::parse_empty_errors ... ok
test parser::tests::parse_error_literal_as_binary_operand ... ok
test parser::tests::parse_error_literal_inside_function_call ... ok
test parser::tests::parse_error_literal_na ... ok
test parser::tests::parse_error_literal_ref ... ok
test parser::tests::parse_function_multiple_args ... ok
test parser::tests::parse_function_name_uppercased ... ok
test parser::tests::parse_function_no_args ... ok
test parser::tests::parse_function_one_arg ... ok
test parser::tests::parse_log10_disambiguation ... ok
test parser::tests::parse_mismatched_range_types_errors ... ok
test parser::tests::parse_mixed_sheet_range_endpoints_rejected ... ok
test parser::tests::parse_nested_function ... ok
test parser::tests::parse_nested_range_errors ... ok
test parser::tests::parse_number_literal ... ok
test parser::tests::parse_og02_full_pipeline ... ok
test parser::tests::parse_og02_pattern ... ok
test parser::tests::parse_parenthesized_range_pair_ok ... ok
test parser::tests::parse_postfix_percent ... ok
test parser::tests::parse_power_right_associative ... ok
test parser::tests::parse_precedence_mul_over_add ... ok
test parser::tests::parse_precedence_parens_override ... ok
test parser::tests::parse_range_cells ... ok
test parser::tests::parse_range_normalizes_reversed_corners ... ok
test parser::tests::parse_range_whole_column ... ok
test parser::tests::parse_range_whole_column_multi ... ok
test parser::tests::parse_range_whole_row ... ok
test parser::tests::parse_sheet_qualified_absolute_ref ... ok
test parser::tests::parse_sheet_qualified_cellref_quoted ... ok
test parser::tests::parse_sheet_qualified_cellref_unquoted ... ok
test parser::tests::parse_sheet_qualified_inside_binary_op ... ok
test parser::tests::parse_sheet_qualified_inside_function_arg ... ok
test parser::tests::parse_sheet_qualified_quoted_with_escape ... ok
test parser::tests::parse_sheet_qualified_range_redundant_explicit_form_normalizes ... ok
test parser::tests::parse_sheet_qualified_range_single_prefix ... ok
test parser::tests::parse_sheet_qualified_redundant_form_case_insensitive ... ok
test parser::tests::parse_sheet_qualified_whole_column ... ok
test parser::tests::parse_sheet_qualified_whole_row ... ok
test parser::tests::parse_simple_add ... ok
test parser::tests::parse_string_literal ... ok
test parser::tests::parse_structured_ref_all_5_specifiers ... ok
test parser::tests::parse_structured_ref_at_bracketed_column ... ok
test parser::tests::parse_structured_ref_at_column_range ... ok
test parser::tests::parse_structured_ref_at_column_shorthand ... ok
test parser::tests::parse_structured_ref_bare_column ... ok
test parser::tests::parse_structured_ref_column_range ... ok
test parser::tests::parse_structured_ref_empty_bracket_errors ... ok
test parser::tests::parse_structured_ref_single_column_in_brackets ... ok
test parser::tests::parse_structured_ref_special_column_combination ... ok
test parser::tests::parse_structured_ref_special_headers ... ok
test parser::tests::parse_structured_ref_sum_of_table_column ... ok
test parser::tests::parse_structured_ref_three_item_combination ... ok
test parser::tests::parse_structured_ref_unknown_special_errors ... ok
test parser::tests::parse_subtraction_left_associative ... ok
test parser::tests::parse_sum_of_whole_column ... ok
test parser::tests::parse_trailing_garbage_errors ... ok
test parser::tests::parse_unary_binds_tighter_than_mul ... ok
test parser::tests::parse_unary_minus_cellref ... ok
test parser::tests::parse_unary_minus_number ... ok
test parser::tests::parse_unclosed_paren_errors ... ok
test parser::tests::parse_unqualified_range_still_works ... ok
test parser::tests::r1c1_a1_mode_cellref_still_parses_in_a1_mode ... ok
test parser::tests::r1c1_parse_absolute_single_ref ... ok
test parser::tests::r1c1_parse_bare_rc_both_axes_rel_zero ... ok
test parser::tests::r1c1_parse_double_sheet_qualifier_rejected ... ok
test parser::tests::r1c1_parse_inside_binary_op ... ok
test parser::tests::r1c1_parse_inside_function_call ... ok
test parser::tests::r1c1_parse_mixed_a1_and_r1c1_range_rejected_as_invalid ... ok
test parser::tests::r1c1_parse_nested_range_rejected ... ok
test parser::tests::r1c1_parse_range_both_endpoints_absolute ... ok
test parser::tests::r1c1_parse_range_both_endpoints_relative ... ok
test parser::tests::r1c1_parse_range_mixed_both_axes_rejected ... ok
test parser::tests::r1c1_parse_range_mixed_col_relativity_rejected ... ok
test parser::tests::r1c1_parse_range_mixed_row_relativity_rejected ... ok
test parser::tests::r1c1_parse_range_per_axis_independent_relativity_accepted ... ok
test parser::tests::r1c1_parse_range_rel_row_bare_col_preserves_axis_values ... ok
test parser::tests::r1c1_parse_range_rel_rows_abs_cols_accepted ... ok
test parser::tests::r1c1_parse_relative_single_ref ... ok
test parser::tests::r1c1_parse_sheet_qualified_range ... ok
test parser::tests::r1c1_parse_sheet_qualified_single_ref ... ok
test parser::tests::r1c1_parse_unary_minus_in_front_of_r1c1ref ... ok
test parser::tests::sheet_qualified_at_ref_binds_sheet_to_inner ... ok
test printer::tests::at_cellref_round_trips ... ok
test printer::tests::at_function_call_round_trips ... ok
test printer::tests::at_inside_function_arg_round_trips ... ok
test printer::tests::at_under_de_locale_emits_at_unchanged ... ok
test printer::tests::at_under_r1c1_mode_emits_at_plus_r1c1_ref ... ok
test printer::tests::at_whole_column_round_trips ... ok
test printer::tests::col_letters_basic ... ok
test printer::tests::col_letters_max_excel ... ok
test printer::tests::nested_at_round_trips ... ok
test printer::tests::print_ai_function ... ok
test printer::tests::print_array_literal_1x3 ... ok
test printer::tests::print_and_print_with_a1_en_match_for_a1_inputs ... ok
test printer::tests::print_array_literal_2x2 ... ok
test printer::tests::print_array_literal_3x1 ... ok
test printer::tests::print_array_literal_as_function_arg ... ok
test printer::tests::print_array_literal_mixed_cells ... ok
test printer::tests::print_array_normalizes_whitespace ... ok
test printer::tests::print_array_round_trip_through_parse_print_parse ... ok
test printer::tests::print_binary_simple_add ... ok
test printer::tests::print_bool ... ok
test printer::tests::print_cell_ref_a1 ... ok
test printer::tests::print_cell_ref_absolute ... ok
test printer::tests::print_cell_ref_two_letter_col ... ok
test printer::tests::print_comparison ... ok
test printer::tests::print_concat_with_arithmetic ... ok
test printer::tests::print_decimal_number ... ok
test printer::tests::print_dotted_sheet_name_unquoted ... ok
test printer::tests::print_error_literal_canonicalizes_case ... ok
test printer::tests::print_error_literal_round_trips ... ok
test printer::tests::print_explicit_parens_preserved_when_needed ... ok
test printer::tests::print_function_name_canonicalized ... ok
test printer::tests::print_function_no_args ... ok
test printer::tests::print_function_with_args ... ok
test printer::tests::print_function_with_range_arg ... ok
test printer::tests::print_integer_number ... ok
test printer::tests::print_mul_over_add_no_parens ... ok
test printer::tests::print_multi_dot_name_ref ... ok
test printer::tests::print_negative_number_via_unary ... ok
test printer::tests::print_nested_function ... ok
test printer::tests::print_postfix_percent_on_grouped ... ok
test printer::tests::print_power_right_assoc ... ok
test printer::tests::print_quoted_sheet_name_with_escape ... ok
test printer::tests::print_quoted_sheet_name_with_space ... ok
test printer::tests::print_range_cells ... ok
test printer::tests::print_range_whole_column ... ok
test printer::tests::print_range_whole_row ... ok
test printer::tests::print_redundant_explicit_form_normalizes_to_single_prefix ... ok
test printer::tests::print_sheet_name_starting_with_digit_is_quoted ... ok
test printer::tests::print_sheet_name_with_special_char_is_quoted ... ok
test printer::tests::print_sheet_prefix_in_binary_expression ... ok
test printer::tests::print_sheet_prefix_in_function_arg ... ok
test printer::tests::print_sheet_prefix_on_range ... ok
test printer::tests::print_sheet_prefix_on_whole_column ... ok
test printer::tests::print_sheet_prefix_on_whole_row ... ok
test printer::tests::print_sheet_prefix_preserves_absolute_markers ... ok
test printer::tests::print_sref_all_5_specifiers ... ok
test printer::tests::print_sref_at_column_range_round_trips ... ok
test printer::tests::print_sref_at_column_shorthand_canonicalizes_to_bracketed ... ok
test printer::tests::print_sref_bare_column ... ok
test printer::tests::print_sref_bracketed_column_canonicalizes_to_bare ... ok
test printer::tests::print_sref_column_name_with_apostrophe_round_trips ... ok
test printer::tests::print_sref_column_name_with_at_sign_round_trips ... ok
test printer::tests::print_sref_column_name_with_bracket_round_trips ... ok
test printer::tests::print_sref_column_name_with_close_bracket_round_trips ... ok
test printer::tests::print_sref_column_name_with_hash_round_trips ... ok
test printer::tests::print_sref_column_range ... ok
test printer::tests::print_sref_special_column_combination ... ok
test printer::tests::print_sref_three_item_combination ... ok
test printer::tests::print_string_basic ... ok
test printer::tests::print_sref_round_trip_through_parse_print_parse ... ok
test printer::tests::print_string_with_embedded_quote ... ok
test printer::tests::print_subtraction_left_assoc ... ok
test printer::tests::print_subtraction_with_negated_rhs ... ok
test printer::tests::print_unary_minus ... ok
test printer::tests::print_unary_minus_then_mul ... ok
test printer::tests::print_unquoted_sheet_prefix_cellref ... ok
test printer::tests::print_with_a1_axisspec_abs_zero_errors_loudly ... ok
test printer::tests::print_with_a1_emits_r1c1_range_absolute_as_a1 ... ok
test printer::tests::print_with_a1_emits_r1c1ref_absolute_as_dollar_a1 ... ok
test printer::tests::print_with_a1_relative_r1c1ref_with_site_emits_a1 ... ok
test printer::tests::print_with_a1_relative_r1c1ref_without_site_errors ... ok
test printer::tests::print_with_de_locale_array_uses_backslash_and_dot ... ok
test printer::tests::print_with_de_locale_array_with_decimals ... ok
test printer::tests::print_with_de_locale_compound_function_and_decimals ... ok
test printer::tests::print_with_de_locale_integer_unchanged ... ok
test printer::tests::print_with_de_locale_scientific_integer ... ok
test printer::tests::print_with_de_locale_small_fraction ... ok
test printer::tests::print_with_de_locale_uses_comma_for_decimal ... ok
test printer::tests::print_with_de_locale_uses_semicolon_for_function_args ... ok
test printer::tests::print_with_de_round_trip_through_lex_parse ... ok
test printer::tests::print_with_en_locale_array_stays_comma_semicolon ... ok
test printer::tests::print_with_en_locale_decimal_stays_dot ... ok
test printer::tests::print_with_en_locale_function_args_stay_comma ... ok
test printer::tests::print_with_fr_locale_uses_comma_for_decimal ... ok
test printer::tests::print_with_r1c1_de_combines_correctly ... ok
test printer::tests::print_with_r1c1_emits_absolute_cellref_as_r1c1 ... ok
test printer::tests::print_with_r1c1_emits_absolute_range ... ok
test printer::tests::print_with_r1c1_emits_bare_rc_verbatim ... ok
test printer::tests::print_with_r1c1_emits_mixed_abs_rel_per_axis ... ok
test printer::tests::print_with_r1c1_emits_r1c1_ref_verbatim ... ok
test printer::tests::print_with_r1c1_emits_relative_cellref_at_anchor_as_rc ... ok
test printer::tests::print_with_r1c1_emits_relative_offset_brackets ... ok
test printer::tests::print_with_r1c1_emits_relative_range_with_site ... ok
test printer::tests::print_with_r1c1_function_composes_r1c1_refs ... ok
test printer::tests::print_with_r1c1_handles_absolute_cellref_post_bind ... ok
test printer::tests::print_with_r1c1_relative_without_site_errors ... ok
test printer::tests::print_with_r1c1_whole_column_emits_col_only_range ... ok
test printer::tests::print_with_r1c1_whole_row_emits_row_only_range ... ok
test printer::tests::r1c1_round_trip_lex_parse_print ... ok
test printer::tests::roundtrip_cellrefs ... ok
test printer::tests::roundtrip_arithmetic ... ok
test printer::tests::roundtrip_chained_function_calls ... ok
test printer::tests::roundtrip_comparison_concat ... ok
test printer::tests::roundtrip_deeply_nested ... ok
test printer::tests::roundtrip_dotted_function_name ... ok
test printer::tests::roundtrip_iferror_pattern ... ok
test printer::tests::roundtrip_complex_formula ... ok
test printer::tests::roundtrip_left_grouped_power ... ok
test printer::tests::roundtrip_literals ... ok
test printer::tests::roundtrip_functions ... ok
test printer::tests::roundtrip_mixed_abs_markers ... ok
test printer::tests::roundtrip_og02_pattern ... ok
test printer::tests::roundtrip_string_with_special_chars ... ok
test printer::tests::roundtrip_ranges ... ok
test printer::tests::roundtrip_unary ... ok
test printer::tests::roundtrip_with_many_args ... ok
test printer::tests::same_sheet_ref_omits_prefix ... ok
test printer::tests::sheet_at_cellref_round_trips_via_ast ... ok
test tests::og02_formula_body_lexes_to_expected_stream ... ok
test tests::reexports_compile ... ok
test token::tests::cellref_components_distinct ... ok
test token::tests::operator_as_str_table ... ok
test token::tests::token_equality_is_structural ... ok

test result: ok. 463 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/p412_b_pinpoint.rs (target/debug/deps/p412_b_pinpoint-0e135c835ed5aa8f)

running 2 tests
test function_call_threshold_2mib ... ignored
test paren_threshold_2mib ... ignored

test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/p412_b_threaded_depth_probe.rs (target/debug/deps/p412_b_threaded_depth_probe-262a1425a2f37b6f)

running 4 tests
test deep_function_call_thresholds ... ignored
test deep_paren_thresholds ... ignored
test deep_unary_minus_thresholds ... ignored
test long_addition_thresholds ... ignored

test result: ok. 0 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/p412_defensive_fuzz_probes.rs (target/debug/deps/p412_defensive_fuzz_probes-7ea6115705f48a2d)

running 37 tests
test array_literal_huge_row_arity_10000 ... ignored
test array_literal_huge_rows_10000 ... ignored
test deep_function_call_1000 ... ignored
test deep_paren_1000 ... ignored
test deep_paren_200 ... ignored
test deep_paren_20000 ... ignored
test deep_paren_5000 ... ignored
test deep_power_chain_1000 ... ignored
test deep_unary_minus_5000 ... ignored
test long_a1_addition_10000_terms ... ignored
test long_addition_10000_terms ... ignored
test long_function_call_10000_args ... ignored
test long_garbage_100kb ... ignored
test long_string_literal_100kb ... ignored
test malformed_bad_cell_ref ... ignored
test malformed_dangling_operator ... ignored
test malformed_double_operator ... ignored
test malformed_lone_equals ... ignored
test malformed_missing_close_paren ... ignored
test malformed_missing_open_paren ... ignored
test malformed_nested_range ... ignored
test malformed_unmatched_quote ... ignored
test number_giant_digits ... ignored
test number_many_decimals ... ignored
test number_scientific_overflow ... ignored
test number_scientific_underflow ... ignored
test sref_nested_brackets_deep ... ignored
test unicode_bom_prefix ... ignored
test unicode_combining_diacritics ... ignored
test unicode_control_chars_in_string ... ignored
test unicode_emoji_in_ident ... ignored
test unicode_emoji_in_string ... ignored
test unicode_high_codepoint_string ... ignored
test unicode_nbsp_in_formula ... ignored
test unicode_nul_in_string ... ignored
test unicode_rtl_in_string ... ignored
test unicode_zero_width_joiner ... ignored

test result: ok. 0 passed; 0 failed; 37 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_functions-8a0a04f0fea98885)

running 1807 tests
test array_returning_fns::tests::filter_four_args_returns_na ... ok
test array_returning_fns::tests::filter_error_in_array_propagates ... ok
test array_returning_fns::tests::filter_2d_array_returns_value_error ... ok
test array_returning_fns::tests::filter_one_arg_returns_na ... ok
test array_returning_fns::tests::filter_length_mismatch_returns_value_error ... ok
test array_returning_fns::tests::filter_orientation_mismatch_returns_value_error ... ok
test array_returning_fns::tests::filter_error_in_include_propagates ... ok
test array_returning_fns::tests::filter_nan_in_include_returns_num_error ... ok
test array_returning_fns::tests::filter_all_false_degenerate_if_empty_array_does_not_panic ... ok
test array_returning_fns::tests::filter_all_false_no_if_empty_returns_degenerate ... ok
test array_returning_fns::tests::filter_all_false_with_error_if_empty_returns_error_singleton ... ok
test array_returning_fns::tests::filter_column_vector_keeps_truthy_only ... ok
test array_returning_fns::tests::filter_all_false_with_if_empty_returns_singleton ... ok
test array_returning_fns::tests::filter_all_truthy_returns_full_input ... ok
test array_returning_fns::tests::filter_numeric_truthy_zero_is_falsy ... ok
test array_returning_fns::tests::filter_blank_is_falsy ... ok
test array_returning_fns::tests::filter_row_vector_keeps_truthy_only ... ok
test array_returning_fns::tests::filter_text_in_include_returns_value_error ... ok
test array_returning_fns::tests::filter_zero_args_returns_na ... ok
test array_returning_fns::tests::sequence_custom_start ... ok
test array_returning_fns::tests::sequence_custom_start_and_step ... ok
test array_returning_fns::tests::sequence_error_arg_propagates ... ok
test array_returning_fns::tests::sequence_five_args_returns_na ... ok
test array_returning_fns::tests::sequence_negative_fractional_cols_returns_value_error_not_calc ... ok
test array_returning_fns::tests::sequence_negative_fractional_rows_returns_value_error_not_calc ... ok
test array_returning_fns::tests::sequence_negative_rows_returns_value_error ... ok
test array_returning_fns::tests::sequence_negative_step ... ok
test array_returning_fns::tests::sequence_range_arg_returns_value_error ... ok
test array_returning_fns::tests::sequence_rows_cols_row_major_fill ... ok
test array_returning_fns::tests::sequence_rows_only_produces_column_vector ... ok
test array_returning_fns::tests::sequence_text_arg_that_doesnt_parse_returns_value_error ... ok
test array_returning_fns::tests::sequence_truncates_fractional_dims ... ok
test array_returning_fns::tests::sequence_zero_args_returns_na ... ok
test array_returning_fns::tests::sequence_zero_cols_returns_num_error ... ok
test array_returning_fns::tests::sequence_zero_rows_returns_num_error ... ok
test array_returning_fns::tests::transpose_1x3_to_3x1 ... ok
test array_returning_fns::tests::transpose_2x2_swaps_off_diagonal ... ok
test array_returning_fns::tests::transpose_2x3_to_3x2 ... ok
test array_returning_fns::tests::transpose_3x1_to_1x3 ... ok
test array_returning_fns::tests::transpose_degenerate_input_returns_degenerate ... ok
test array_returning_fns::tests::transpose_error_arg_propagates ... ok
test array_returning_fns::tests::transpose_is_involutive ... ok
test array_returning_fns::tests::transpose_range_arg ... ok
test array_returning_fns::tests::transpose_scalar_returns_singleton ... ok
test array_returning_fns::tests::sequence_text_arg_that_parses_coerces_correctly ... ok
test array_returning_fns::tests::transpose_two_args_returns_na ... ok
test array_returning_fns::tests::transpose_zero_args_returns_na ... ok
test date_fns::tests::date_arity_error ... ok
test date_fns::tests::date_day_overflow_cascades_forward ... ok
test date_fns::tests::date_excel1904_year_before_1904_is_num_error ... ok
test date_fns::tests::date_happy_path_1900_system ... ok
test date_fns::tests::date_month_overflow_cascades_forward ... ok
test date_fns::tests::date_month_zero_or_negative_cascades_backward ... ok
test date_fns::tests::date_negative_year_is_num_error ... ok
test date_fns::tests::date_phantom_day_in_excel1900 ... ok
test date_fns::tests::date_propagates_error_in_any_arg ... ok
test date_fns::tests::date_two_digit_year_coerced_to_19xx ... ok
test date_fns::tests::date_year_above_9999_is_num_error ... ok
test date_fns::tests::hour_arity_error ... ok
test date_fns::tests::hour_minute_second_6_30_45 ... ok
test date_fns::tests::hour_minute_second_at_known_fractions ... ok
test date_fns::tests::hour_minute_second_zero_at_midnight ... ok
test date_fns::tests::hour_negative_serial_is_num_error ... ok
test date_fns::tests::hour_strips_integer_part ... ok
test date_fns::tests::second_propagates_error ... ok
test date_fns::tests::time_arity_error ... ok
test date_fns::tests::time_cascading_minutes_and_seconds ... ok
test date_fns::tests::time_known_values ... ok
test date_fns::tests::time_negative_arg_is_num_error ... ok
test date_fns::tests::time_propagates_error_in_any_arg ... ok
test date_fns::tests::time_wraps_24h ... ok
test date_fns::tests::year_arity_error ... ok
test date_fns::tests::year_month_day_basic_1900_system ... ok
test date_fns::tests::year_month_day_phantom_serial_60_in_excel1900 ... ok
test date_fns::tests::year_month_day_serial_60_in_excel1904_is_real_date ... ok
test date_fns::tests::year_month_day_strips_fractional_time ... ok
test date_fns::tests::year_negative_serial_is_num_error ... ok
test date_fns::tests::year_serial_zero_in_excel1900_is_num_error ... ok
test date_fns::tests_wave2::datevalue_arity_error ... ok
test date_fns::tests_wave2::datevalue_non_text_input_is_value_error ... ok
test date_fns::tests_wave2::edate_clamps_day_when_target_month_shorter ... ok
test date_fns::tests_wave2::edate_negative_months_walks_backward ... ok
test date_fns::tests_wave2::edate_propagates_error ... ok
test date_fns::tests_wave2::edate_same_day_in_next_month ... ok
test date_fns::tests_wave2::datevalue_iso_format ... ok
test date_fns::tests_wave2::datevalue_phantom_1900_02_29 ... ok
test date_fns::tests_wave2::datevalue_us_slash_format ... ok
test date_fns::tests_wave2::eomonth_arity_error ... ok
test date_fns::tests_wave2::datevalue_two_digit_year ... ok
test date_fns::tests_wave2::datevalue_unparseable_is_value_error ... ok
test date_fns::tests_wave2::eomonth_feb_1900_returns_phantom_60 ... ok
test date_fns::tests_wave2::eomonth_negative_offset_walks_backward ... ok
test date_fns::tests_wave2::eomonth_positive_offset_walks_forward ... ok
test date_fns::tests_wave2::eomonth_zero_offset_returns_last_of_start_month ... ok
test date_fns::tests_wave2::timevalue_24h ... ok
test date_fns::tests_wave2::timevalue_12h_am_pm ... ok
test date_fns::tests_wave2::weekday_at_serial_25569_unix_epoch_is_thursday ... ok
test date_fns::tests_wave2::timevalue_invalid_format_is_value_error ... ok
test date_fns::tests_wave2::weekday_default_return_type_1_serial_1_is_sunday ... ok
test date_fns::tests_wave2::weekday_excel1904_serial_0_is_friday ... ok
test date_fns::tests_wave2::weekday_invalid_return_type_is_num_error ... ok
test date_fns::tests_wave2::weekday_negative_serial_is_num_error ... ok
test date_fns::tests_wave2::weekday_return_type_11_and_17_match_2_and_1 ... ok
test date_fns::tests_wave2::weekday_return_type_12_through_16_exhaustive ... ok
test date_fns::tests_wave2::weekday_return_type_2_serial_1_is_sunday_index_7 ... ok
test date_fns::tests_wave2::weekday_return_type_3_serial_1_is_sunday_index_6 ... ok
test date_fns::tests_wave3::days_arity_error ... ok
test date_fns::tests_wave3::days_basic_subtraction ... ok
test date_fns::tests_wave3::days_text_arg_is_value_error_v1_divergence ... ok
test date_fns::tests_wave3::days_truncates_fractional ... ok
test date_fns::tests_wave3::networkdays_includes_endpoints_skips_weekend ... ok
test date_fns::tests_wave3::yearfrac_basis_1_same_leap_year ... ok
test date_fns::tests_wave3::networkdays_with_holidays_arg_is_value_error_v1_divergence ... ok
test date_fns::tests_wave3::networkdays_negative_when_end_before_start ... ok
test date_fns::tests_wave3::w5_d_pm12_1_networkdays_out_of_range_endpoints_rejected ... ok
test date_fns::tests_wave3::workday_backward ... ok
test date_fns::tests_wave3::workday_crosses_weekend ... ok
test date_fns::tests_wave3::w5_d_pm12_1_workday_out_of_range_start_rejected ... ok
test date_fns::tests_wave3::workday_with_holidays_arg_is_value_error_v1_divergence ... ok
test date_fns::tests_wave3::workday_forward_simple ... ok
test date_fns::tests_wave3::yearfrac_arity_error ... ok
test date_fns::tests_wave3::networkdays_single_week ... ok
test date_fns::tests_wave3::networkdays_full_week_window ... ok
test date_fns::tests_wave3::workday_zero_days_returns_start ... ok
test date_fns::tests_wave3::yearfrac_basis_2_actual_360 ... ok
test date_fns::tests_wave3::yearfrac_basis_3_actual_365 ... ok
test date_fns::tests_wave3::yearfrac_basis_4_european_30_360 ... ok
test date_fns::tests_wave3::yearfrac_default_basis_is_zero ... ok
test date_fns::tests_wave3::yearfrac_invalid_basis_is_num_error ... ok
test date_fns::tests_wave3::yearfrac_zero_for_same_date ... ok
test date_fns::tests_wave_c::datedif_d_total_days ... ok
test date_fns::tests_wave_c::datedif_invalid_unit_is_num_error ... ok
test date_fns::tests_wave_c::datedif_m_complete_months ... ok
test date_fns::tests_wave_c::datedif_md_days_ignoring_months_and_years ... ok
test date_fns::tests_wave_c::datedif_md_end_day_before_start_day_wraps ... ok
test date_fns::tests_wave_c::datedif_negative_is_num_error ... ok
test date_fns::tests_wave_c::datedif_unit_case_insensitive ... ok
test date_fns::tests_wave_c::datedif_y_complete_years ... ok
test date_fns::tests_wave_c::datedif_y_partial_year_rounds_down ... ok
test date_fns::tests_wave_c::datedif_ym_months_ignoring_years ... ok
test date_fns::tests_wave_c::days360_day_31_adjustment_us ... ok
test date_fns::tests_wave_c::days360_european_method ... ok
test date_fns::tests_wave_c::days360_full_year_us ... ok
test date_fns::tests_wave_c::days360_one_month_us ... ok
test date_fns::tests_wave_c::excel1900_serial_0_uniformly_rejected_by_date_functions ... ok
test date_fns::tests_wave_c::excel1904_serial_0_accepted_as_epoch ... ok
test date_fns::tests_wave_c::isoweeknum_dec_31_2018_is_week_1_of_2019 ... ok
test date_fns::tests_wave_c::isoweeknum_excel1900_serial_0_is_num_error ... ok
test date_fns::tests_wave_c::isoweeknum_excel1900_serial_1_no_panic_returns_week_1 ... ok
test date_fns::tests_wave_c::isoweeknum_excel1904_serial_0_no_panic_returns_week_53 ... ok
test date_fns::tests_wave_c::isoweeknum_jan_1_2023_is_week_52_of_prior_year ... ok
test date_fns::tests_wave_c::isoweeknum_jan_1_2024_is_week_1 ... ok
test date_fns::tests_wave_c::isoweeknum_mid_year_thursday ... ok
test date_fns::tests_wave_c::weeknum_default_return_type_1_jan_1_2024 ... ok
test date_fns::tests_wave_c::weeknum_invalid_return_type_is_num_error ... ok
test date_fns::tests_wave_c::weeknum_mid_year ... ok
test date_fns::tests_wave_c::weeknum_return_type_21_delegates_to_isoweeknum ... ok
test date_fns::tests_wave_c::weeknum_return_type_2_mon_start ... ok
test date_fns::tests_wave_c::yearfrac_basis_0_matches_days360_at_february_end ... ok
test date_fns::tests_wave_c::yearfrac_basis_0_matches_days360_us_nasd ... ok
test distribution_fns::tests::beta_dist_5_arg_variant_with_a_only ... ok
test distribution_fns::tests::beta_dist_a_equals_b_is_num_error ... ok
test distribution_fns::tests::beta_dist_alpha_or_beta_zero_is_num_error ... ok
test distribution_fns::tests::beta_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::beta_dist_error_arg_propagates ... ok
test distribution_fns::tests::beta_dist_cdf_at_one_returns_one_closed_form ... ok
test distribution_fns::tests::beta_dist_optional_bounds_scaling ... ok
test distribution_fns::tests::beta_dist_pdf_at_lower_bound_a ... ok
test distribution_fns::tests::beta_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::beta_dist_uniform_cdf_at_half_returns_half_closed_form ... ok
test distribution_fns::tests::beta_dist_uniform_pdf_at_half_returns_one_closed_form ... ok
test distribution_fns::tests::beta_dist_x_outside_bounds_is_num_error ... ok
test distribution_fns::tests::beta_inv_4_arg_variant_with_a_only ... ok
test distribution_fns::tests::beta_inv_alpha_or_beta_zero_is_num_error ... ok
test distribution_fns::tests::beta_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::beta_inv_b_below_a_is_num_error ... ok
test distribution_fns::tests::beta_inv_error_arg_propagates ... ok
test distribution_fns::tests::beta_inv_inverse_of_beta_dist_round_trip ... ok
test distribution_fns::tests::beta_inv_optional_bounds_scaling ... ok
test distribution_fns::tests::beta_inv_p_at_endpoints_is_num_error ... ok
test distribution_fns::tests::beta_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::beta_inv_uniform_at_half_returns_half_closed_form ... ok
test distribution_fns::tests::binom_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::binom_dist_cdf_at_n_returns_one ... ok
test distribution_fns::tests::binom_dist_cdf_at_zero_equals_pmf_zero ... ok
test distribution_fns::tests::binom_dist_error_arg_propagates ... ok
test distribution_fns::tests::binom_dist_k_greater_than_n_is_num_error ... ok
test distribution_fns::tests::binom_dist_negative_k_is_num_error ... ok
test distribution_fns::tests::binom_dist_p_outside_unit_is_num_error ... ok
test distribution_fns::tests::binom_dist_pmf_at_five_n_10_p_half_closed_form ... ok
test distribution_fns::tests::binom_dist_pmf_at_zero_n_10_p_half_closed_form ... ok
test distribution_fns::tests::binom_dist_range_arity_mismatch_returns_value ... ok
test distribution_fns::tests::binom_dist_range_error_arg_propagates ... ok
test distribution_fns::tests::binom_dist_range_full_returns_one ... ok
test distribution_fns::tests::binom_dist_range_lower_above_upper_is_num_error ... ok
test distribution_fns::tests::binom_dist_range_lower_zero_equals_cdf_upper ... ok
test distribution_fns::tests::binom_dist_range_middle_window_4_to_6 ... ok
test distribution_fns::tests::binom_dist_range_single_point_equals_pmf ... ok
test distribution_fns::tests::binom_dist_range_text_arg_is_value_error ... ok
test distribution_fns::tests::binom_dist_range_three_arg_form_is_single_point ... ok
test distribution_fns::tests::binom_dist_range_upper_above_trials_is_num_error ... ok
test distribution_fns::tests::binom_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::binom_dist_trials_at_u64_max_boundary_is_num_error ... ok
test distribution_fns::tests::binom_dist_trials_zero_degenerate_pmf_at_zero ... ok
test distribution_fns::tests::binom_inv_alpha_outside_strict_unit_is_num_error ... ok
test distribution_fns::tests::binom_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::binom_inv_error_arg_propagates ... ok
test distribution_fns::tests::binom_inv_negative_trials_is_num_error ... ok
test distribution_fns::tests::binom_inv_p_one_returns_trials ... ok
test distribution_fns::tests::binom_inv_p_zero_accepted_but_returns_zero ... ok
test distribution_fns::tests::binom_inv_small_alpha_returns_small_k ... ok
test distribution_fns::tests::binom_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::binom_inv_smallest_k_with_cdf_at_least_half ... ok
test distribution_fns::tests::binom_inv_trials_zero_returns_zero_panic_regression ... ok
test distribution_fns::tests::chisq_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::chisq_dist_cdf_at_two_df_two_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_dist_cdf_at_zero_returns_zero ... ok
test distribution_fns::tests::chisq_dist_df_above_max_is_num_error ... ok
test distribution_fns::tests::chisq_dist_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::chisq_dist_error_arg_propagates ... ok
test distribution_fns::tests::chisq_dist_libreoffice_anchor_df_one_at_3_84 ... ok
test distribution_fns::tests::chisq_dist_negative_x_is_num_error ... ok
test distribution_fns::tests::chisq_dist_pdf_at_zero_df_two_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_dist_rt_arity_mismatch_returns_value ... ok
test distribution_fns::tests::chisq_dist_rt_at_two_df_two_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_dist_rt_at_zero_returns_one ... ok
test distribution_fns::tests::chisq_dist_rt_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::chisq_dist_rt_error_arg_propagates ... ok
test distribution_fns::tests::chisq_dist_rt_libreoffice_anchor_df_one_at_3_84 ... ok
test distribution_fns::tests::chisq_dist_rt_negative_x_is_num_error ... ok
test distribution_fns::tests::chisq_dist_rt_round_trip_with_chisq_dist ... ok
test distribution_fns::tests::chisq_dist_rt_text_arg_is_value_error ... ok
test distribution_fns::tests::chisq_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::chisq_inv_95_pct_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::chisq_inv_at_half_df_two_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_inv_at_one_is_num_error ... ok
test distribution_fns::tests::chisq_inv_at_zero_returns_zero ... ok
test distribution_fns::tests::chisq_inv_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::chisq_inv_error_arg_propagates ... ok
test distribution_fns::tests::chisq_inv_inverse_of_chisq_dist_round_trip ... ok
test distribution_fns::tests::chisq_inv_p_above_one_is_num_error ... ok
test distribution_fns::tests::chisq_inv_p_negative_is_num_error ... ok
test distribution_fns::tests::chisq_inv_rt_5_pct_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_inv_rt_arity_mismatch_returns_value ... ok
test distribution_fns::tests::chisq_inv_rt_at_half_df_two_libreoffice_anchor ... ok
test distribution_fns::tests::chisq_inv_rt_at_one_returns_zero ... ok
test distribution_fns::tests::chisq_inv_rt_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::chisq_inv_rt_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::chisq_inv_rt_error_arg_propagates ... ok
test distribution_fns::tests::chisq_inv_rt_p_above_one_is_num_error ... ok
test distribution_fns::tests::chisq_inv_rt_p_negative_is_num_error ... ok
test distribution_fns::tests::chisq_inv_rt_round_trip_with_chisq_dist_rt ... ok
test distribution_fns::tests::chisq_inv_rt_text_arg_is_value_error ... ok
test distribution_fns::tests::chisq_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::confidence_norm_alpha_5pct_size_1_returns_z_critical ... ok
test distribution_fns::tests::confidence_norm_alpha_at_endpoints_is_num_error ... ok
test distribution_fns::tests::confidence_norm_arity_mismatch_returns_value ... ok
test distribution_fns::tests::confidence_norm_error_arg_propagates ... ok
test distribution_fns::tests::confidence_norm_sd_scales_margin_linearly ... ok
test distribution_fns::tests::confidence_norm_sd_zero_or_negative_is_num_error ... ok
test distribution_fns::tests::confidence_norm_size_4_halves_margin ... ok
test distribution_fns::tests::confidence_norm_size_floors_fractional ... ok
test distribution_fns::tests::confidence_norm_size_less_than_one_is_num_error ... ok
test distribution_fns::tests::confidence_norm_text_arg_is_value_error ... ok
test distribution_fns::tests::confidence_norm_vs_t_floor_trunc_divergence_visible_at_negative_fractional_size ... ok
test distribution_fns::tests::confidence_t_alpha_5pct_size_10_statrs_self_consistent ... ok
test distribution_fns::tests::confidence_t_alpha_at_endpoints_is_num_error ... ok
test distribution_fns::tests::confidence_t_arity_mismatch_returns_value ... ok
test distribution_fns::tests::confidence_t_error_arg_propagates ... ok
test distribution_fns::tests::confidence_t_large_size_approaches_norm ... ok
test distribution_fns::tests::confidence_t_sd_zero_is_num_error ... ok
test distribution_fns::tests::confidence_t_size_less_than_two_is_div_zero ... ok
test distribution_fns::tests::confidence_t_size_truncs_fractional ... ok
test distribution_fns::tests::confidence_t_text_arg_is_value_error ... ok
test distribution_fns::tests::erf_2_arg_error_propagates_from_either_position ... ok
test distribution_fns::tests::erf_arity_mismatch_returns_value ... ok
test distribution_fns::tests::erf_at_one_libreoffice_anchor ... ok
test distribution_fns::tests::erf_at_two_libreoffice_anchor ... ok
test distribution_fns::tests::erf_at_zero_returns_zero_closed_form ... ok
test distribution_fns::tests::erf_error_arg_propagates ... ok
test distribution_fns::tests::erf_large_positive_approaches_one ... ok
test distribution_fns::tests::erf_odd_function_property ... ok
test distribution_fns::tests::erf_precise_arity_mismatch_returns_value ... ok
test distribution_fns::tests::erf_precise_matches_erf_1_arg ... ok
test distribution_fns::tests::erf_precise_rejects_2_args ... ok
test distribution_fns::tests::erf_precise_text_arg_is_value_error ... ok
test distribution_fns::tests::erf_text_arg_is_value_error ... ok
test distribution_fns::tests::erf_two_arg_definite_integral ... ok
test distribution_fns::tests::erf_two_arg_swapped_negates ... ok
test distribution_fns::tests::erfc_arity_mismatch_returns_value ... ok
test distribution_fns::tests::erfc_at_one_libreoffice_anchor ... ok
test distribution_fns::tests::erfc_at_zero_returns_one_closed_form ... ok
test distribution_fns::tests::erfc_complement_identity ... ok
test distribution_fns::tests::erfc_error_arg_propagates ... ok
test distribution_fns::tests::erfc_large_negative_approaches_two ... ok
test distribution_fns::tests::erfc_large_positive_approaches_zero ... ok
test distribution_fns::tests::erfc_precise_arity_mismatch_returns_value ... ok
test distribution_fns::tests::erfc_precise_matches_erfc ... ok
test distribution_fns::tests::erfc_text_arg_is_value_error ... ok
test distribution_fns::tests::expon_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::expon_dist_cdf_at_one_lambda_one_closed_form ... ok
test distribution_fns::tests::expon_dist_cdf_at_zero_returns_zero ... ok
test distribution_fns::tests::expon_dist_error_arg_propagates ... ok
test distribution_fns::tests::expon_dist_lambda_2_at_1_cdf ... ok
test distribution_fns::tests::expon_dist_lambda_zero_or_negative_is_num_error ... ok
test distribution_fns::tests::expon_dist_negative_x_is_num_error ... ok
test distribution_fns::tests::expon_dist_pdf_at_one_lambda_one_closed_form ... ok
test distribution_fns::tests::expon_dist_pdf_at_zero_lambda_one_closed_form ... ok
test distribution_fns::tests::expon_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::f_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::f_dist_cdf_at_one_equal_dfs_is_half ... ok
test distribution_fns::tests::f_dist_cdf_at_zero_returns_zero ... ok
test distribution_fns::tests::f_dist_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::f_dist_error_arg_propagates ... ok
test distribution_fns::tests::f_dist_negative_x_is_num_error ... ok
test distribution_fns::tests::f_dist_pdf_at_one_equal_dfs_closed_form ... ok
test distribution_fns::tests::f_dist_rt_arity_mismatch_returns_value ... ok
test distribution_fns::tests::f_dist_rt_at_one_equal_dfs_is_half ... ok
test distribution_fns::tests::f_dist_rt_at_zero_returns_one ... ok
test distribution_fns::tests::f_dist_rt_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::f_dist_rt_error_arg_propagates ... ok
test distribution_fns::tests::f_dist_rt_negative_x_is_num_error ... ok
test distribution_fns::tests::f_dist_rt_round_trip_with_f_dist ... ok
test distribution_fns::tests::f_dist_rt_statrs_self_consistent_5_pct_round_trip ... ok
test distribution_fns::tests::f_dist_rt_text_arg_is_value_error ... ok
test distribution_fns::tests::f_dist_statrs_self_consistent_95th_percentile_round_trip ... ok
test distribution_fns::tests::f_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::f_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::f_inv_at_half_equal_dfs_returns_one ... ok
test distribution_fns::tests::f_inv_at_one_is_num_error ... ok
test distribution_fns::tests::f_inv_at_zero_returns_zero ... ok
test distribution_fns::tests::f_inv_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::f_inv_error_arg_propagates ... ok
test distribution_fns::tests::f_inv_inverse_of_f_dist_round_trip ... ok
test distribution_fns::tests::f_inv_libreoffice_anchor_95_pct_5_10 ... ok
test distribution_fns::tests::f_inv_p_above_one_is_num_error ... ok
test distribution_fns::tests::f_inv_p_negative_is_num_error ... ok
test distribution_fns::tests::f_inv_rt_arity_mismatch_returns_value ... ok
test distribution_fns::tests::f_inv_rt_at_half_equal_dfs_returns_one ... ok
test distribution_fns::tests::f_inv_rt_at_one_returns_zero ... ok
test distribution_fns::tests::f_inv_rt_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::f_inv_rt_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::f_inv_rt_error_arg_propagates ... ok
test distribution_fns::tests::f_inv_rt_libreoffice_anchor_5_pct_5_10 ... ok
test distribution_fns::tests::f_inv_rt_p_above_one_is_num_error ... ok
test distribution_fns::tests::f_inv_rt_p_negative_is_num_error ... ok
test distribution_fns::tests::f_inv_rt_round_trip_with_f_dist_rt ... ok
test distribution_fns::tests::f_inv_rt_text_arg_is_value_error ... ok
test distribution_fns::tests::f_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::gamma_arity_mismatch_returns_value ... ok
test distribution_fns::tests::gamma_at_five_returns_24_closed_form ... ok
test distribution_fns::tests::gamma_at_half_returns_sqrt_pi_closed_form ... ok
test distribution_fns::tests::gamma_at_negative_half_closed_form ... ok
test distribution_fns::tests::gamma_at_one_returns_one_closed_form ... ok
test distribution_fns::tests::gamma_at_zero_is_num_error ... ok
test distribution_fns::tests::gamma_dist_alpha_or_beta_zero_is_num_error ... ok
test distribution_fns::tests::gamma_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::gamma_dist_cdf_alpha_one_beta_one_at_one_closed_form ... ok
test distribution_fns::tests::gamma_dist_cdf_at_zero_returns_zero ... ok
test distribution_fns::tests::gamma_dist_error_arg_propagates ... ok
test distribution_fns::tests::gamma_dist_negative_x_is_num_error ... ok
test distribution_fns::tests::gamma_dist_pdf_alpha_one_beta_one_at_zero_closed_form ... ok
test distribution_fns::tests::gamma_dist_subnormal_scale_is_num_error_not_panic ... ok
test distribution_fns::tests::gamma_dist_subnormal_scale_returns_num_error ... ok
test distribution_fns::tests::gamma_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::gamma_error_arg_propagates ... ok
test distribution_fns::tests::gamma_inv_alpha_one_at_half_closed_form ... ok
test distribution_fns::tests::gamma_inv_alpha_or_beta_zero_is_num_error ... ok
test distribution_fns::tests::gamma_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::gamma_inv_at_one_is_num_error ... ok
test distribution_fns::tests::gamma_inv_at_zero_returns_zero ... ok
test distribution_fns::tests::gamma_inv_error_arg_propagates ... ok
test distribution_fns::tests::gamma_inv_inverse_of_gamma_dist_round_trip ... ok
test distribution_fns::tests::gamma_inv_p_above_one_is_num_error ... ok
test distribution_fns::tests::gamma_inv_p_negative_is_num_error ... ok
test distribution_fns::tests::gamma_inv_subnormal_scale_non_termination_regression ... ok
test distribution_fns::tests::gamma_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::gamma_ln_arity_mismatch_returns_value ... ok
test distribution_fns::tests::gamma_ln_at_four_returns_ln_six_closed_form ... ok
test distribution_fns::tests::gamma_ln_at_half_returns_half_ln_pi_closed_form ... ok
test distribution_fns::tests::gamma_ln_at_one_returns_zero_closed_form ... ok
test distribution_fns::tests::gamma_ln_at_two_returns_zero_closed_form ... ok
test distribution_fns::tests::gamma_ln_at_zero_is_num_error ... ok
test distribution_fns::tests::gamma_ln_error_arg_propagates ... ok
test distribution_fns::tests::gamma_ln_negative_x_is_num_error ... ok
test distribution_fns::tests::gamma_ln_precise_arity_mismatch_returns_value ... ok
test distribution_fns::tests::gamma_ln_precise_matches_gamma_ln_at_four ... ok
test distribution_fns::tests::gamma_ln_precise_matches_gamma_ln_at_half ... ok
test distribution_fns::tests::gamma_ln_precise_negative_x_is_num_error ... ok
test distribution_fns::tests::gamma_inv_subnormal_scale_is_num_error_not_panic ... ok
test distribution_fns::tests::gamma_ln_precise_text_arg_is_value_error ... ok
test distribution_fns::tests::gamma_ln_text_arg_is_value_error ... ok
test distribution_fns::tests::gamma_negative_integer_is_num_error ... ok
test distribution_fns::tests::gamma_text_arg_is_value_error ... ok
test distribution_fns::tests::lognorm_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::lognorm_dist_cdf_at_one_standard_returns_half ... ok
test distribution_fns::tests::lognorm_dist_error_arg_propagates ... ok
test distribution_fns::tests::lognorm_dist_negative_mean_accepted ... ok
test distribution_fns::tests::lognorm_dist_pdf_at_one_standard_closed_form ... ok
test distribution_fns::tests::lognorm_dist_sd_zero_or_negative_is_num_error ... ok
test distribution_fns::tests::lognorm_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::lognorm_dist_x_zero_or_negative_is_num_error ... ok
test distribution_fns::tests::lognorm_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::lognorm_inv_error_arg_propagates ... ok
test distribution_fns::tests::lognorm_inv_inverse_of_lognorm_dist_round_trip ... ok
test distribution_fns::tests::lognorm_inv_median_at_half_returns_exp_mean ... ok
test distribution_fns::tests::lognorm_inv_median_with_nonzero_mean ... ok
test distribution_fns::tests::lognorm_inv_p_at_endpoints_is_num_error ... ok
test distribution_fns::tests::lognorm_inv_sd_zero_is_num_error ... ok
test distribution_fns::tests::lognorm_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::negbinom_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::negbinom_dist_cdf_at_zero_r_1_p_half_closed_form ... ok
test distribution_fns::tests::negbinom_dist_error_arg_propagates ... ok
test distribution_fns::tests::negbinom_dist_negative_failures_is_num_error ... ok
test distribution_fns::tests::negbinom_dist_number_s_less_than_one_is_num_error ... ok
test distribution_fns::tests::negbinom_dist_p_at_endpoints_is_num_error ... ok
test distribution_fns::tests::negbinom_dist_pmf_at_one_r_1_p_half_closed_form ... ok
test distribution_fns::tests::negbinom_dist_pmf_at_zero_r_1_p_half_closed_form ... ok
test distribution_fns::tests::negbinom_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::norm_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::norm_dist_cdf_at_mean_returns_half ... ok
test distribution_fns::tests::norm_dist_error_arg_propagates ... ok
test distribution_fns::tests::norm_dist_libreoffice_anchor_x_1_sd_2 ... ok
test distribution_fns::tests::norm_dist_negative_sd_is_num_error ... ok
test distribution_fns::tests::norm_dist_pdf_at_mean_returns_inv_sqrt_2pi ... ok
test distribution_fns::tests::norm_dist_pdf_libreoffice_anchor ... ok
test distribution_fns::tests::norm_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::norm_dist_zero_sd_is_num_error ... ok
test distribution_fns::tests::norm_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::norm_inv_at_half_returns_mean ... ok
test distribution_fns::tests::norm_inv_at_one_prob_is_num_error ... ok
test distribution_fns::tests::norm_inv_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::norm_inv_error_arg_propagates ... ok
test distribution_fns::tests::norm_inv_inverse_of_norm_dist_round_trip ... ok
test distribution_fns::tests::norm_inv_libreoffice_anchor_at_975_pct ... ok
test distribution_fns::tests::norm_inv_negative_prob_is_num_error ... ok
test distribution_fns::tests::norm_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::norm_inv_zero_sd_is_num_error ... ok
test distribution_fns::tests::norm_s_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::norm_s_dist_cdf_at_extreme_positive_is_close_to_one ... ok
test distribution_fns::tests::norm_s_dist_cdf_at_neg_two_libreoffice_anchor ... ok
test distribution_fns::tests::norm_s_dist_cdf_at_one_sigma_libreoffice_anchor ... ok
test distribution_fns::tests::norm_s_dist_cdf_at_zero_returns_half ... ok
test distribution_fns::tests::norm_s_dist_error_arg_propagates ... ok
test distribution_fns::tests::norm_s_dist_pdf_at_zero_returns_inv_sqrt_2pi ... ok
test distribution_fns::tests::norm_s_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::norm_s_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::norm_s_inv_at_975_pct_libreoffice_anchor ... ok
test distribution_fns::tests::norm_s_inv_at_half_returns_zero ... ok
test distribution_fns::tests::norm_s_inv_at_one_prob_is_num_error ... ok
test distribution_fns::tests::norm_s_inv_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::norm_s_inv_error_arg_propagates ... ok
test distribution_fns::tests::norm_s_inv_inverse_of_norm_s_dist_round_trip ... ok
test distribution_fns::tests::norm_s_inv_negative_prob_is_num_error ... ok
test distribution_fns::tests::norm_s_inv_text_arg_is_value_error ... ok
test distribution_fns::tests::poisson_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::poisson_dist_cdf_at_one_lambda_one_closed_form ... ok
test distribution_fns::tests::poisson_dist_error_arg_propagates ... ok
test distribution_fns::tests::poisson_dist_lambda_zero_degenerate_cdf_at_any_k ... ok
test distribution_fns::tests::poisson_dist_lambda_zero_degenerate_pmf_at_positive_k ... ok
test distribution_fns::tests::poisson_dist_lambda_zero_degenerate_pmf_at_zero ... ok
test distribution_fns::tests::poisson_dist_negative_lambda_is_num_error ... ok
test distribution_fns::tests::poisson_dist_negative_x_is_num_error ... ok
test distribution_fns::tests::poisson_dist_pmf_at_zero_lambda_one_closed_form ... ok
test distribution_fns::tests::poisson_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::t_dist_2t_arity_mismatch_returns_value ... ok
test distribution_fns::tests::t_dist_2t_at_one_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::t_dist_2t_at_zero_returns_one ... ok
test distribution_fns::tests::t_dist_2t_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::t_dist_2t_error_arg_propagates ... ok
test distribution_fns::tests::t_dist_2t_far_tail_in_unit_range ... ok
test distribution_fns::tests::t_dist_2t_negative_x_is_num_error ... ok
test distribution_fns::tests::t_dist_2t_text_arg_is_value_error ... ok
test distribution_fns::tests::t_dist_arity_mismatch_returns_value ... ok
test distribution_fns::tests::t_dist_cdf_at_one_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::t_dist_cdf_at_zero_returns_half_for_any_df ... ok
test distribution_fns::tests::t_dist_converges_to_normal_at_large_df ... ok
test distribution_fns::tests::t_dist_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::t_dist_df_truncates_fractional ... ok
test distribution_fns::tests::t_dist_error_arg_propagates ... ok
test distribution_fns::tests::t_dist_pdf_at_one_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::t_dist_pdf_at_zero_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::t_dist_rt_arity_mismatch_returns_value ... ok
test distribution_fns::tests::t_dist_rt_at_one_df_one_libreoffice_anchor ... ok
test distribution_fns::tests::t_dist_rt_at_zero_returns_half ... ok
test distribution_fns::tests::t_dist_rt_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::t_dist_rt_error_arg_propagates ... ok
test distribution_fns::tests::t_dist_rt_inverse_of_t_dist_round_trip ... ok
test distribution_fns::tests::t_dist_rt_negative_x_above_half ... ok
test distribution_fns::tests::t_dist_rt_text_arg_is_value_error ... ok
test distribution_fns::tests::t_dist_text_arg_is_value_error ... ok
test distribution_fns::tests::t_inv_2t_above_one_prob_is_num_error ... ok
test distribution_fns::tests::t_inv_2t_arity_mismatch_returns_value ... ok
test distribution_fns::tests::t_inv_2t_at_05_df_30_libreoffice_anchor ... ok
test distribution_fns::tests::t_inv_2t_at_p_one_returns_zero ... ok
test distribution_fns::tests::t_inv_2t_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::t_inv_2t_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::t_inv_2t_error_arg_propagates ... ok
test distribution_fns::tests::t_inv_2t_inverse_of_t_dist_2t_round_trip ... ok
test distribution_fns::tests::t_inv_2t_returns_positive_value ... ok
test distribution_fns::tests::t_inv_2t_text_arg_is_value_error ... ok
test distribution_fns::tests::t_inv_arity_mismatch_returns_value ... ok
test distribution_fns::tests::t_inv_at_975_pct_df_10_libreoffice_anchor ... ok
test distribution_fns::tests::t_inv_at_half_returns_zero ... ok
test distribution_fns::tests::t_inv_at_one_prob_is_num_error ... ok
test distribution_fns::tests::t_inv_at_zero_prob_is_num_error ... ok
test distribution_fns::tests::t_inv_df_less_than_one_is_num_error ... ok
test distribution_fns::tests::t_inv_error_arg_propagates ... ok
test distribution_fns::tests::t_inv_inverse_of_t_dist_round_trip ... ok
test distribution_fns::tests::t_inv_text_arg_is_value_error ... ok
test financial_fns::tests::db_default_month_is_12 ... ok
test financial_fns::tests::compute_xirr_direct_nan_guess_is_value_error ... ok
test financial_fns::tests::db_boolean_month_coerces_to_number ... ok
test financial_fns::tests::db_error_in_arg_propagates ... ok
test financial_fns::tests::db_fractional_life_below_one_is_num ... ok
test financial_fns::tests::db_fractional_period_below_one_is_num ... ok
test financial_fns::tests::db_full_year_period_equals_life_pins_value ... ok
test financial_fns::tests::db_huge_life_rejected ... ok
test financial_fns::tests::db_microsoft_first_period_partial ... ok
test financial_fns::tests::db_microsoft_last_partial_period ... ok
test financial_fns::tests::db_microsoft_rate_is_canonical ... ok
test financial_fns::tests::db_microsoft_second_period ... ok
test financial_fns::tests::db_month_12_period_exceeds_life_is_num ... ok
test financial_fns::tests::db_month_exceeds_12_is_num ... ok
test financial_fns::tests::db_month_fractional_truncates ... ok
test financial_fns::tests::db_negative_cost_is_num ... ok
test financial_fns::tests::db_negative_life_is_num ... ok
test financial_fns::tests::db_negative_period_is_num ... ok
test financial_fns::tests::db_period_exceeds_life_plus_one_is_num ... ok
test financial_fns::tests::db_wrong_arity ... ok
test financial_fns::tests::db_zero_cost_returns_zero ... ok
test financial_fns::tests::db_zero_life_is_num ... ok
test financial_fns::tests::db_zero_month_is_num ... ok
test financial_fns::tests::db_zero_period_is_num ... ok
test financial_fns::tests::ddb_error_in_arg_propagates ... ok
test financial_fns::tests::ddb_explicit_factor_one_single_declining ... ok
test financial_fns::tests::ddb_life_in_months ... ok
test financial_fns::tests::ddb_microsoft_example_final_year ... ok
test financial_fns::tests::ddb_microsoft_example_first_year ... ok
test financial_fns::tests::ddb_negative_cost_is_num ... ok
test financial_fns::tests::ddb_negative_factor_is_num ... ok
test financial_fns::tests::ddb_negative_period_is_num ... ok
test financial_fns::tests::ddb_negative_salvage_is_num ... ok
test financial_fns::tests::ddb_period_exceeds_life_is_num ... ok
test financial_fns::tests::ddb_rate_clamps_to_one_when_factor_exceeds_life ... ok
test financial_fns::tests::ddb_rate_one_zero_after_first_period ... ok
test financial_fns::tests::ddb_salvage_floor_clamps_to_zero ... ok
test financial_fns::tests::ddb_wrong_arity ... ok
test financial_fns::tests::ddb_zero_factor_is_num ... ok
test financial_fns::tests::ddb_zero_period_is_num ... ok
test financial_fns::tests::fv_savings ... ok
test financial_fns::tests::fv_zero_rate ... ok
test financial_fns::tests::ipmt_first_period_loan ... ok
test financial_fns::tests::ipmt_invalid_period_is_num ... ok
test financial_fns::tests::ipmt_plus_ppmt_equals_pmt ... ok
test financial_fns::tests::irr_all_negative_is_num ... ok
test financial_fns::tests::irr_all_positive_is_num ... ok
test financial_fns::tests::irr_basic ... ok
test financial_fns::tests::irr_bisection_fallback_when_newton_diverges ... ok
test financial_fns::tests::irr_error_in_range_propagates ... ok
test financial_fns::tests::irr_scalar_arg_is_value_error ... ok
test financial_fns::tests::irr_skips_text_and_bool_per_excel_canon ... ok
test financial_fns::tests::irr_with_guess ... ok
test financial_fns::tests::mirr_all_zero_is_div_zero ... ok
test financial_fns::tests::mirr_error_in_finance_rate_propagates ... ok
test financial_fns::tests::mirr_error_in_range_propagates ... ok
test financial_fns::tests::mirr_finance_rate_minus_one_special_single_negative_at_index_0 ... ok
test financial_fns::tests::mirr_invalid_finance_rate_is_num ... ok
test financial_fns::tests::mirr_microsoft_example ... ok
test financial_fns::tests::mirr_no_negative_is_div_zero ... ok
test financial_fns::tests::mirr_no_positive_is_div_zero ... ok
test financial_fns::tests::mirr_range_rate_is_value_error ... ok
test financial_fns::tests::mirr_reinvest_rate_minus_one_special ... ok
test financial_fns::tests::mirr_scalar_first_arg_is_value_error ... ok
test financial_fns::tests::mirr_single_value_is_div_zero ... ok
test financial_fns::tests::mirr_skips_text_and_bool_per_excel_canon ... ok
test financial_fns::tests::mirr_wrong_arity ... ok
test financial_fns::tests::mirr_zero_in_values_neutral ... ok
test financial_fns::tests::nper_zero_rate ... ok
test financial_fns::tests::nper_zero_rate_zero_pmt_is_num ... ok
test financial_fns::tests::npv_basic ... ok
test financial_fns::tests::npv_empty_cash_flow_is_num ... ok
test financial_fns::tests::npv_propagates_errors ... ok
test financial_fns::tests::npv_skips_text ... ok
test financial_fns::tests::npv_with_range ... ok
test financial_fns::tests::pmt_loan ... ok
test financial_fns::tests::pmt_wrong_arity ... ok
test financial_fns::tests::pmt_zero_rate ... ok
test financial_fns::tests::pv_loan ... ok
test financial_fns::tests::pv_zero_rate ... ok
test financial_fns::tests::rate_zero_guess_perturbs_and_converges ... ok
test financial_fns::tests::rate_zero_pmt ... ok
test financial_fns::tests::sln_basic ... ok
test financial_fns::tests::sln_blank_coerces_to_zero ... ok
test financial_fns::tests::sln_error_in_arg_propagates ... ok
test financial_fns::tests::sln_life_zero_is_div_zero ... ok
test financial_fns::tests::sln_microsoft_example ... ok
test financial_fns::tests::sln_negative_life_passes_through ... ok
test financial_fns::tests::sln_no_salvage ... ok
test financial_fns::tests::sln_wrong_arity ... ok
test financial_fns::tests::syd_error_in_arg_propagates ... ok
test financial_fns::tests::syd_life_zero_is_num ... ok
test financial_fns::tests::syd_microsoft_example_final_year ... ok
test financial_fns::tests::syd_microsoft_example_first_year ... ok
test financial_fns::tests::syd_negative_per_is_num ... ok
test financial_fns::tests::syd_per_equals_life_succeeds ... ok
test financial_fns::tests::syd_per_exceeds_life_is_num ... ok
test financial_fns::tests::syd_sum_over_periods_equals_total_depreciation ... ok
test financial_fns::tests::syd_wrong_arity ... ok
test financial_fns::tests::syd_zero_per_is_num ... ok
test financial_fns::tests::vdb_additivity_invariant ... ok
test financial_fns::tests::vdb_boolean_no_switch_genuinely_changes_result ... ok
test financial_fns::tests::vdb_cost_zero_returns_zero ... ok
test financial_fns::tests::vdb_default_vs_no_switch_partial_late_range_libreoffice ... ok
test financial_fns::tests::vdb_end_before_start_is_num ... ok
test financial_fns::tests::vdb_end_exceeds_life_is_num ... ok
test financial_fns::tests::vdb_error_in_arg_propagates ... ok
test financial_fns::tests::vdb_huge_end_period_rejected ... ok
test financial_fns::tests::vdb_huge_life_rejected ... ok
test financial_fns::tests::vdb_libreoffice_fractional_overlap_half_period_boundary ... ok
test financial_fns::tests::vdb_libreoffice_fractional_overlap_mid_life ... ok
test financial_fns::tests::vdb_libreoffice_periods_5_to_7 ... ok
test financial_fns::tests::vdb_microsoft_example_factor_1_5_months_6_to_18 ... ok
test financial_fns::tests::vdb_microsoft_example_first_day ... ok
test financial_fns::tests::vdb_microsoft_example_first_month ... ok
test financial_fns::tests::vdb_microsoft_example_first_year ... ok
test financial_fns::tests::vdb_microsoft_example_months_6_to_18 ... ok
test financial_fns::tests::vdb_microsoft_example_partial_first_year_factor_1_5 ... ok
test financial_fns::tests::vdb_negative_cost_is_num ... ok
test financial_fns::tests::vdb_negative_factor_is_num ... ok
test financial_fns::tests::vdb_negative_life_is_num ... ok
test financial_fns::tests::vdb_negative_salvage_is_num ... ok
test financial_fns::tests::vdb_negative_start_is_num ... ok
test financial_fns::tests::vdb_no_switch_full_life_below_cost_salvage_when_cap_not_reached ... ok
test financial_fns::tests::vdb_no_switch_full_life_salvage_cap_fixture ... ok
test financial_fns::tests::vdb_no_switch_numeric_coerces_to_bool ... ok
test financial_fns::tests::vdb_salvage_exceeds_cost_is_num ... ok
test financial_fns::tests::vdb_start_equals_end_returns_zero ... ok
test financial_fns::tests::vdb_start_period_zero_returns_full_first_period ... ok
test financial_fns::tests::vdb_start_zero_equals_end_zero_returns_zero ... ok
test financial_fns::tests::vdb_wrong_arity ... ok
test financial_fns::tests::vdb_zero_factor_is_num ... ok
test financial_fns::tests::vdb_zero_life_is_num ... ok
test financial_fns::tests::xirr_all_negative_values_is_num_error ... ok
test financial_fns::tests::xirr_all_positive_values_is_num_error ... ok
test financial_fns::tests::xirr_arity_violations ... ok
test financial_fns::tests::xirr_bisection_fallback_path ... ok
test financial_fns::tests::xirr_date_precedes_first_is_num_error ... ok
test financial_fns::tests::xirr_date_serial_zero_is_num_error ... ok
test financial_fns::tests::xirr_dates_length_mismatch_is_num_error ... ok
test financial_fns::tests::xirr_empty_cell_in_values_treated_as_zero ... ok
test financial_fns::tests::xirr_error_in_values_propagates ... ok
test financial_fns::tests::xirr_guess_at_or_below_minus_one_is_value_error ... ok
test financial_fns::tests::xirr_microsoft_canonical_anchor ... ok
test financial_fns::tests::xirr_nan_guess_is_num_error ... ok
test financial_fns::tests::xirr_near_minus_one_guess_high1_regression ... ok
test financial_fns::tests::xirr_optional_guess ... ok
test financial_fns::tests::xirr_round_trip_with_xnpv ... ok
test financial_fns::tests::xirr_text_in_values_is_value_error ... ok
test financial_fns::tests::xnpv_arity_violations ... ok
test financial_fns::tests::xnpv_date_outside_excel_serial_range_is_num_error ... ok
test financial_fns::tests::xnpv_date_precedes_first_is_num_error ... ok
test financial_fns::tests::xnpv_date_serial_zero_is_num_error ... ok
test financial_fns::tests::xnpv_dates_length_mismatch_is_num_error ... ok
test financial_fns::tests::xnpv_empty_cell_in_values_is_num_error ... ok
test financial_fns::tests::xnpv_error_in_values_propagates ... ok
test financial_fns::tests::xnpv_microsoft_canonical_anchor ... ok
test financial_fns::tests::xnpv_negative_rate_in_neg_one_zero_open_interval_works ... ok
test financial_fns::tests::xnpv_rate_at_or_below_negative_one_is_num_error ... ok
test financial_fns::tests::xnpv_scalar_for_values_is_value_error ... ok
test financial_fns::tests::xnpv_single_value_returns_value_at_zero_offset ... ok
test financial_fns::tests::xnpv_text_in_dates_is_value_error ... ok
test financial_fns::tests::xnpv_text_in_values_is_num_error ... ok
test format::lexer::tests::lex_ampm_long_and_short ... ok
test format::lexer::tests::lex_bracket_currency_no_locale ... ok
test format::lexer::tests::lex_bracket_currency_with_locale_code ... ok
test format::lexer::tests::lex_color_codes_unsupported_v2 ... ok
test format::lexer::tests::lex_conditional_unsupported_v2 ... ok
test format::lexer::tests::lex_day_all_lengths ... ok
test format::lexer::tests::lex_digit_placeholders ... ok
test format::lexer::tests::lex_direct_currency_chars ... ok
test format::lexer::tests::lex_elapsed_time_unsupported_v2 ... ok
test format::lexer::tests::lex_empty_is_error ... ok
test format::lexer::tests::lex_escaped_char ... ok
test format::lexer::tests::lex_four_section_format ... ok
test format::lexer::tests::lex_general_keyword ... ok
test format::lexer::tests::lex_hour_and_second ... ok
test format::lexer::tests::lex_iso_date_format ... ok
test format::lexer::tests::lex_keyword_runs_are_case_insensitive ... ok
test format::lexer::tests::lex_literal_punctuation ... ok
test format::lexer::tests::lex_month_all_lengths ... ok
test format::lexer::tests::lex_percent ... ok
test format::lexer::tests::lex_period_and_comma ... ok
test format::lexer::tests::lex_quoted_text ... ok
test format::lexer::tests::lex_quoted_text_with_special_chars_inside ... ok
test format::lexer::tests::lex_raw_text_passthrough ... ok
test format::lexer::tests::lex_scientific_plus_and_minus ... ok
test format::lexer::tests::lex_separator ... ok
test format::lexer::tests::lex_spacer_and_ghost ... ok
test format::lexer::tests::lex_thousands_with_fixed_decimal ... ok
test format::lexer::tests::lex_time_format_hmms ... ok
test format::lexer::tests::lex_trailing_asterisk_is_error ... ok
test format::lexer::tests::lex_trailing_backslash_is_error ... ok
test format::lexer::tests::lex_trailing_underscore_is_error ... ok
test format::lexer::tests::lex_unrecognized_bracket_block_is_error ... ok
test format::lexer::tests::lex_unterminated_bracket_block_is_error ... ok
test format::lexer::tests::lex_unterminated_quoted_text_is_error ... ok
test format::lexer::tests::lex_year_short_and_long ... ok
test format::lexer::tests::lex_year_three_y_is_error ... ok
test format::parser::tests::bracket_currency_with_locale_preserved ... ok
test format::parser::tests::builtin_id_0_general ... ok
test format::parser::tests::builtin_id_14_m_d_yyyy_is_date ... ok
test format::parser::tests::builtin_id_18_h_mm_ampm_is_date_with_ampm ... ok
test format::parser::tests::builtin_id_22_m_d_yyyy_h_mm_is_date ... ok
test format::parser::tests::builtin_id_37_neg_in_parens_two_section ... ok
test format::parser::tests::builtin_id_4_thousands_with_decimal ... ok
test format::parser::tests::color_codes_error_is_uncovered_v2 ... ok
test format::parser::tests::conditional_error_is_uncovered_v2 ... ok
test format::parser::tests::day_lengths ... ok
test format::parser::tests::decimal_point_switches_number_state ... ok
test format::parser::tests::direct_dollar_is_currency ... ok
test format::parser::tests::elapsed_time_error_is_uncovered_v2 ... ok
test format::parser::tests::empty_input_propagates_empty_error ... ok
test format::parser::tests::escaped_char_renders_literal ... ok
test format::parser::tests::exponent_marker_switches_number_state ... ok
test format::parser::tests::five_sections_is_error ... ok
test format::parser::tests::four_section_with_empty_zero ... ok
test format::parser::tests::fraction_format_inside_section_is_uncovered_v2 ... ok
test format::parser::tests::fraction_format_is_uncovered_v2 ... ok
test format::parser::tests::fraction_format_with_integer_part_is_uncovered_v2 ... ok
test format::parser::tests::general_keyword_classifies_as_general ... ok
test format::parser::tests::ghost_ast_preserved ... ok
test format::parser::tests::invalid_year_length_propagates ... ok
test format::parser::tests::iso_date_is_date_section ... ok
test format::parser::tests::literal_only_section_is_text ... ok
test format::parser::tests::mm_after_ss_in_reverse_position_resolves_to_minute ... ok
test format::parser::tests::mm_after_time_then_m_in_date_context_classifies_correctly ... ok
test format::parser::tests::mm_before_ss_resolves_to_minute ... ok
test format::parser::tests::mm_in_time_context_is_minute ... ok
test format::parser::tests::mmm_is_always_month_name_short ... ok
test format::parser::tests::mmmmm_is_single_letter_month ... ok
test format::parser::tests::percent_collapses_to_count ... ok
test format::parser::tests::quoted_text_preserved ... ok
test format::parser::tests::raw_at_is_text_section ... ok
test format::parser::tests::single_zero_is_number_section ... ok
test format::parser::tests::slash_between_non_question_tokens_is_not_fraction ... ok
test format::parser::tests::spacer_ast_preserved ... ok
test format::parser::tests::standalone_mm_is_month_when_no_time_anchor ... ok
test format::parser::tests::thousands_separator_between_digits ... ok
test format::parser::tests::three_section_with_zero_label ... ok
test format::parser::tests::trailing_backslash_propagates ... ok
test format::parser::tests::trailing_comma_is_scale_by_thousands ... ok
test format::parser::tests::trailing_semicolon_creates_empty_second_section ... ok
test format::parser::tests::trailing_underscore_propagates ... ok
test format::parser::tests::two_section_split ... ok
test format::parser::tests::two_trailing_commas_scale_by_millions ... ok
test format::parser::tests::unterminated_quoted_propagates ... ok
test format::parser::tests::year_short_vs_long ... ok
test format::render::tests::at_passthrough_for_text_value ... ok
test format::render::tests::at_passthrough_wraps_with_literals ... ok
test format::render::tests::bracket_currency_locale_code_ignored_at_render ... ok
test format::render::tests::builtin_id_10_percent_two_decimals ... ok
test format::render::tests::builtin_id_15_d_mmm_yy ... ok
test format::render::tests::builtin_id_17_mmm_yy ... ok
test format::render::tests::builtin_id_18_h_mm_ampm ... ok
test format::render::tests::builtin_id_19_h_mm_ss_ampm ... ok
test format::render::tests::builtin_id_1_integer ... ok
test format::render::tests::builtin_id_21_h_mm_ss_24h ... ok
test format::render::tests::builtin_id_22_datetime ... ok
test format::render::tests::builtin_id_2_two_decimals ... ok
test format::render::tests::builtin_id_3_thousands ... ok
test format::render::tests::builtin_id_45_mm_ss_minute_second_disambiguation ... ok
test format::render::tests::builtin_id_49_text_passthrough ... ok
test format::render::tests::builtin_id_4_thousands_with_decimals ... ok
test format::render::tests::builtin_id_9_percent_no_decimals ... ok
test format::render::tests::currency_symbol_emitted ... ok
test format::render::tests::date_full_weekday ... ok
test format::render::tests::date_full_month_name ... ok
test format::render::tests::date_iso_format ... ok
test format::render::tests::date_m_d_yyyy_renders_serial ... ok
test format::render::tests::date_short_month_name ... ok
test format::render::tests::date_short_weekday ... ok
test format::render::tests::date_single_letter_month ... ok
test format::render::tests::date_two_digit_year ... ok
test format::render::tests::date_with_padded_month_and_day ... ok
test format::render::tests::datetime_combined ... ok
test format::render::tests::empty_third_section_renders_zero_as_empty ... ok
test format::render::tests::escaped_char_emitted_as_literal ... ok
test format::render::tests::fixed_decimal_pads_with_zero ... ok
test format::render::tests::fixed_decimal_rounds ... ok
test format::render::tests::four_section_text_value_uses_section_three ... ok
test format::render::tests::general_blank_is_empty ... ok
test format::render::tests::general_boolean_uppercase ... ok
test format::render::tests::general_renders_fractional ... ok
test format::render::tests::general_renders_integer_value_without_decimal ... ok
test format::render::tests::general_text_is_passthrough ... ok
test format::render::tests::num_error_renders_as_sigil ... ok
test format::render::tests::one_section_negative_emits_leading_minus ... ok
test format::render::tests::percent_multiplies_by_hundred ... ok
test format::render::tests::quoted_text_emitted_verbatim ... ok
test format::render::tests::scientific_renders_exponent_sign ... ok
test format::render::tests::sharp_format_does_not_pad ... ok
test format::render::tests::small_number_with_thousands_format_unchanged ... ok
test format::render::tests::thousands_separator_inserts_comma ... ok
test format::render::tests::thousands_with_decimal ... ok
test format::render::tests::three_section_zero_uses_section_two ... ok
test format::render::tests::time_h_mm_ampm ... ok
test format::render::tests::time_h_mm_ampm_midnight ... ok
test format::render::tests::time_h_mm_ampm_one_pm ... ok
test format::render::tests::time_h_mm_ss_24h ... ok
test format::render::tests::time_padded_hour ... ok
test format::render::tests::trailing_comma_scales_by_thousand ... ok
test format::render::tests::two_section_negative_uses_section_one ... ok
test format::render::tests::zero_format_pads_with_zero ... ok
test format::render::tests::zero_format_renders_integer ... ok
test format::text_fn::tests::arity_one_is_value_error ... ok
test format::text_fn::tests::arity_three_is_value_error ... ok
test format::text_fn::tests::arity_zero_is_value_error ... ok
test format::text_fn::tests::blank_format_arg_treated_as_empty ... ok
test format::text_fn::tests::boolean_format_arg_is_value_error ... ok
test format::text_fn::tests::empty_format_string_returns_empty_text ... ok
test format::text_fn::tests::format_string_error_propagates ... ok
test format::text_fn::tests::invalid_format_string_returns_value_error ... ok
test format::text_fn::tests::invalid_year_token_surfaces_as_value_error ... ok
test format::text_fn::tests::numeric_format_arg_is_value_error ... ok
test format::text_fn::tests::text_at_passthrough_for_text_value ... ok
test format::text_fn::tests::text_general_for_text_value ... ok
test format::text_fn::tests::text_general_format ... ok
test format::text_fn::tests::text_negative_in_parens ... ok
test format::text_fn::tests::text_with_combined_datetime ... ok
test format::text_fn::tests::text_with_currency ... ok
test format::text_fn::tests::text_with_excel1904_date_system ... ok
test format::text_fn::tests::text_with_iso_date_format ... ok
test format::text_fn::tests::text_with_percent ... ok
test format::text_fn::tests::text_with_scientific ... ok
test format::text_fn::tests::text_with_short_month_name ... ok
test format::text_fn::tests::text_with_thousands_separator ... ok
test format::text_fn::tests::text_with_time_ampm ... ok
test format::text_fn::tests::text_with_two_decimals ... ok
test format::text_fn::tests::value_error_propagates ... ok
test range_fns::tests::averageif_arity_errors ... ok
test range_fns::tests::averageif_basic ... ok
test range_fns::tests::averageif_comparator ... ok
test range_fns::tests::averageif_empty_range_is_div_zero ... ok
test range_fns::tests::averageif_no_match_is_div_zero ... ok
test range_fns::tests::averageif_separate_average_range ... ok
test range_fns::tests::averageifs_avg_range_shape_mismatch_is_value_error ... ok
test range_fns::tests::averageifs_no_match_div_zero ... ok
test range_fns::tests::averageifs_two_conditions ... ok
test range_fns::tests::choose_arity_error ... ok
test range_fns::tests::choose_out_of_bounds_is_value_error ... ok
test range_fns::tests::choose_range_arg_is_value_error ... ok
test range_fns::tests::choose_returns_indexed_value ... ok
test range_fns::tests::choose_truncates_fractional_index ... ok
test range_fns::tests::concat_blanks_become_empty_string ... ok
test range_fns::tests::concat_coerces_numbers_and_bools ... ok
test range_fns::tests::concat_empty_args_is_value_error ... ok
test range_fns::tests::concat_flattens_range ... ok
test range_fns::tests::concat_mixed_scalar_and_range ... ok
test range_fns::tests::concat_propagates_errors ... ok
test range_fns::tests::concat_scalars_only ... ok
test range_fns::tests::correl_constant_x_is_div_zero ... ok
test range_fns::tests::correl_constant_y_is_div_zero ... ok
test range_fns::tests::correl_empty_pairs_is_div_zero ... ok
test range_fns::tests::correl_error_in_x_propagates ... ok
test range_fns::tests::correl_error_in_y_propagates ... ok
test range_fns::tests::correl_known_microsoft_example ... ok
test range_fns::tests::correl_perfect_negative_is_minus_one ... ok
test range_fns::tests::correl_perfect_positive_is_one ... ok
test range_fns::tests::correl_scalar_args_are_value_error ... ok
test range_fns::tests::correl_shape_mismatch_is_value_error ... ok
test range_fns::tests::correl_skips_booleans ... ok
test range_fns::tests::correl_skips_pairs_with_blanks ... ok
test range_fns::tests::correl_skips_pairs_with_nonnumeric_either_side ... ok
test range_fns::tests::correl_too_few_pairs_is_div_zero ... ok
test range_fns::tests::correl_wrong_arity_is_value_error ... ok
test range_fns::tests::countblank_counts_blanks ... ok
test range_fns::tests::countblank_counts_empty_strings ... ok
test range_fns::tests::countblank_does_not_count_errors_as_blank ... ok
test range_fns::tests::countblank_does_not_count_non_empty_text ... ok
test range_fns::tests::countblank_scalar_arg_is_value_error ... ok
test range_fns::tests::countblank_wrong_arity_is_value_error ... ok
test range_fns::tests::countif_arity_errors ... ok
test range_fns::tests::countif_basic ... ok
test range_fns::tests::countif_blank_criteria_matches_blanks ... ok
test range_fns::tests::countif_comparator_criteria ... ok
test range_fns::tests::countif_empty_range ... ok
test range_fns::tests::countif_error_in_criteria_propagates ... ok
test range_fns::tests::countif_ignores_error_cells ... ok
test range_fns::tests::countif_text_criteria ... ok
test range_fns::tests::countif_wildcard_case_insensitive ... ok
test range_fns::tests::countif_wildcard_combined_star_and_question ... ok
test range_fns::tests::countif_wildcard_does_not_match_numbers ... ok
test range_fns::tests::countif_wildcard_eq_does_not_match_numbers ... ok
test range_fns::tests::countif_wildcard_escape_treats_as_literal ... ok
test range_fns::tests::countif_wildcard_neq_does_not_match_numbers ... ok
test range_fns::tests::countif_wildcard_not_equal_inverts ... ok
test range_fns::tests::countif_wildcard_question_matches_single_char ... ok
test range_fns::tests::countif_wildcard_star_matches_prefix ... ok
test range_fns::tests::countifs_arity_must_be_pairs ... ok
test range_fns::tests::countif_wildcard_star_matches_suffix ... ok
test range_fns::tests::countifs_no_matches_is_zero ... ok
test range_fns::tests::countifs_shape_mismatch_between_two_criteria_ranges_is_value_error ... ok
test range_fns::tests::countifs_two_conditions ... ok
test range_fns::tests::covariance_p_arity_violations ... ok
test range_fns::tests::covariance_p_constant_array_returns_zero ... ok
test range_fns::tests::covariance_p_error_propagation ... ok
test range_fns::tests::covariance_p_perfect_negative_relationship ... ok
test range_fns::tests::covariance_p_no_numeric_pairs_is_div_zero ... ok
test range_fns::tests::covariance_p_perfect_positive_relationship ... ok
test range_fns::tests::covariance_p_shape_mismatch_is_value_error ... ok
test range_fns::tests::covariance_p_single_pair_returns_zero ... ok
test range_fns::tests::covariance_p_skips_booleans_and_blanks ... ok
test range_fns::tests::covariance_p_skips_pairs_with_nonnumeric ... ok
test range_fns::tests::covariance_s_arity_violations ... ok
test range_fns::tests::covariance_s_bessel_transform_of_microsoft_p_example ... ok
test range_fns::tests::covariance_s_constant_array_returns_zero ... ok
test range_fns::tests::covariance_s_error_propagation ... ok
test range_fns::tests::covariance_s_microsoft_canonical_anchor ... ok
test range_fns::tests::covariance_s_no_numeric_pairs_is_div_zero ... ok
test range_fns::tests::covariance_s_perfect_positive_uses_bessel_correction ... ok
test range_fns::tests::covariance_s_population_relationship ... ok
test range_fns::tests::covariance_s_shape_mismatch_is_value_error ... ok
test range_fns::tests::covariance_s_single_pair_is_div_zero ... ok
test range_fns::tests::covariance_s_skips_pairs_with_nonnumeric ... ok
test range_fns::tests::hlookup_exact_match ... ok
test range_fns::tests::hlookup_row_index_out_of_range_is_ref ... ok
test range_fns::tests::index_1d_column_returns_nth ... ok
test range_fns::tests::index_2d_with_row_and_col ... ok
test range_fns::tests::index_arity_errors ... ok
test range_fns::tests::index_out_of_bounds_is_ref_error ... ok
test range_fns::tests::index_zero_row_or_col_is_ref_error_v1 ... ok
test range_fns::tests::intercept_arity_and_scalar_validation ... ok
test range_fns::tests::intercept_inherits_slope_div_zero_on_constant_x ... ok
test range_fns::tests::intercept_known_fixture ... ok
test range_fns::tests::intercept_negative_slope_known_fixture ... ok
test range_fns::tests::intercept_shape_mismatch_is_value_error ... ok
test range_fns::tests::intercept_skips_non_numeric_pairs ... ok
test range_fns::tests::intercept_too_few_pairs_is_div_zero ... ok
test range_fns::tests::intercept_y_equals_2x_baseline_is_zero ... ok
test range_fns::tests::large_empty_range_is_num ... ok
test range_fns::tests::large_k_out_of_range_is_num ... ok
test range_fns::tests::large_returns_kth_largest ... ok
test range_fns::tests::match_approximate_inverse ... ok
test range_fns::tests::match_approximate_largest_le_default ... ok
test range_fns::tests::match_arity_errors ... ok
test range_fns::tests::match_error_propagates ... ok
test range_fns::tests::match_exact_finds_position ... ok
test range_fns::tests::match_exact_not_found_is_na ... ok
test range_fns::tests::match_text_case_insensitive ... ok
test range_fns::tests::maxifs_error_in_value_range_propagates ... ok
test range_fns::tests::maxifs_no_match_returns_zero ... ok
test range_fns::tests::maxifs_single_condition ... ok
test range_fns::tests::median_arity_zero_is_value_error ... ok
test range_fns::tests::median_empty_is_num ... ok
test range_fns::tests::median_even_count_averages ... ok
test range_fns::tests::median_mixed_scalar_and_range ... ok
test range_fns::tests::median_odd_count ... ok
test range_fns::tests::median_text_in_range_propagates_value ... ok
test range_fns::tests::median_unsorted_input ... ok
test range_fns::tests::minifs_error_in_value_range_propagates ... ok
test range_fns::tests::minifs_no_match_returns_zero ... ok
test range_fns::tests::minifs_shape_mismatch_is_value_error ... ok
test range_fns::tests::minifs_single_condition ... ok
test range_fns::tests::minifs_too_few_args_is_value_error ... ok
test range_fns::tests::minifs_two_conditions ... ok
test range_fns::tests::minifs_with_comparator_criteria ... ok
test range_fns::tests::mode_basic ... ok
test range_fns::tests::mode_empty_is_num ... ok
test range_fns::tests::mode_floats_exact_equality ... ok
test range_fns::tests::mode_mixed_scalar_and_range ... ok
test range_fns::tests::mode_no_repeat_is_na ... ok
test range_fns::tests::mode_tie_picks_first_appearance ... ok
test range_fns::tests::pearson_matches_correl_known_fixture ... ok
test range_fns::tests::pearson_matches_correl_perfect_positive ... ok
test range_fns::tests::pearson_propagates_div_zero_from_constant_array ... ok
test range_fns::tests::percentile_exc_arity_violations ... ok
test range_fns::tests::percentile_exc_boolean_k_coerces ... ok
test range_fns::tests::percentile_exc_empty_array_is_num_error ... ok
test range_fns::tests::percentile_exc_error_in_array_propagates ... ok
test range_fns::tests::percentile_exc_error_in_k_propagates ... ok
test range_fns::tests::percentile_exc_k_above_upper_bound_is_num_error ... ok
test range_fns::tests::percentile_exc_k_at_lower_bound_returns_minimum ... ok
test range_fns::tests::percentile_exc_k_at_upper_bound_returns_maximum ... ok
test range_fns::tests::percentile_exc_k_below_lower_bound_is_num_error ... ok
test range_fns::tests::percentile_exc_k_zero_is_num_error ... ok
test range_fns::tests::percentile_exc_microsoft_example ... ok
test range_fns::tests::percentile_exc_n_one_only_k_half_works ... ok
test range_fns::tests::percentile_exc_nan_k_is_num_error ... ok
test range_fns::tests::percentile_exc_skips_blank_in_range ... ok
test range_fns::tests::percentile_exc_text_in_range_is_value_error ... ok
test range_fns::tests::percentile_exc_text_k_is_value_error ... ok
test range_fns::tests::percentile_exc_unsorted_input ... ok
test range_fns::tests::percentile_inc_arity_violations ... ok
test range_fns::tests::percentile_inc_boolean_k_coerces ... ok
test range_fns::tests::percentile_inc_empty_array_is_num_error ... ok
test range_fns::tests::percentile_inc_error_in_array_propagates ... ok
test range_fns::tests::percentile_inc_error_in_k_propagates ... ok
test range_fns::tests::percentile_inc_k_above_one_is_num_error ... ok
test range_fns::tests::percentile_inc_k_half_on_odd_count_is_median ... ok
test range_fns::tests::percentile_inc_k_negative_is_num_error ... ok
test range_fns::tests::percentile_inc_k_one_is_maximum ... ok
test range_fns::tests::percentile_inc_k_zero_is_minimum ... ok
test range_fns::tests::percentile_inc_microsoft_example ... ok
test range_fns::tests::percentile_inc_nan_k_is_num_error ... ok
test range_fns::tests::percentile_inc_single_element_returns_that_element ... ok
test range_fns::tests::percentile_inc_skips_blank_in_range ... ok
test range_fns::tests::percentile_inc_text_in_range_is_value_error ... ok
test range_fns::tests::percentile_inc_text_k_is_value_error ... ok
test range_fns::tests::percentile_inc_unsorted_input_is_sorted_internally ... ok
test range_fns::tests::predicate_blank_equality ... ok
test range_fns::tests::predicate_boolean ... ok
test range_fns::tests::predicate_error_propagates ... ok
test range_fns::tests::predicate_number_eq ... ok
test range_fns::tests::predicate_text_eq_case_insensitive ... ok
test range_fns::tests::predicate_text_gt ... ok
test range_fns::tests::predicate_text_le ... ok
test range_fns::tests::predicate_text_ne ... ok
test range_fns::tests::quartile_exc_arity_violations ... ok
test range_fns::tests::quartile_exc_empty_array_is_num_error ... ok
test range_fns::tests::quartile_exc_error_in_array_propagates ... ok
test range_fns::tests::quartile_exc_error_q_propagates ... ok
test range_fns::tests::quartile_exc_matches_percentile_exc_at_quart_div_4 ... ok
test range_fns::tests::quartile_exc_q0_is_num_error ... ok
test range_fns::tests::quartile_exc_nan_q_is_num_error ... ok
test range_fns::tests::quartile_exc_q2_microsoft_example ... ok
test range_fns::tests::quartile_exc_q4_is_num_error ... ok
test range_fns::tests::quartile_exc_q_text_is_value_error ... ok
test range_fns::tests::quartile_exc_small_array_q1_propagates_exc_bounds ... ok
test range_fns::tests::quartile_exc_text_in_range_is_value_error ... ok
test range_fns::tests::quartile_inc_arity_violations ... ok
test range_fns::tests::quartile_inc_empty_array_is_num_error ... ok
test range_fns::tests::quartile_inc_error_in_array_propagates ... ok
test range_fns::tests::quartile_inc_matches_percentile_inc_at_quart_div_4 ... ok
test range_fns::tests::quartile_inc_error_q_propagates ... ok
test range_fns::tests::quartile_inc_nan_q_is_num_error ... ok
test range_fns::tests::quartile_inc_q0_is_minimum ... ok
test range_fns::tests::quartile_inc_q2_is_median ... ok
test range_fns::tests::quartile_inc_q4_is_maximum ... ok
test range_fns::tests::quartile_inc_q_above_4_is_num_error ... ok
test range_fns::tests::quartile_inc_q_negative_fraction_truncates_toward_zero ... ok
test range_fns::tests::quartile_inc_q_negative_is_num_error ... ok
test range_fns::tests::quartile_inc_q_text_is_value_error ... ok
test range_fns::tests::quartile_inc_q_truncates_toward_zero ... ok
test range_fns::tests::quartile_inc_text_in_range_is_value_error ... ok
test range_fns::tests::rank_ascending_with_order ... ok
test range_fns::tests::rank_avg_arity_error ... ok
test range_fns::tests::rank_avg_ascending ... ok
test range_fns::tests::rank_avg_descending_with_ties_averages ... ok
test range_fns::tests::rank_avg_empty_ref_is_na ... ok
test range_fns::tests::rank_avg_no_ties_matches_rank ... ok
test range_fns::tests::rank_avg_three_way_tie ... ok
test range_fns::tests::rank_avg_value_not_in_ref_is_na ... ok
test range_fns::tests::rank_descending_default ... ok
test range_fns::tests::rank_empty_ref_is_na ... ok
test range_fns::tests::rank_ties_get_same_rank ... ok
test range_fns::tests::rank_value_not_in_ref_is_na ... ok
test range_fns::tests::rsq_arity_violations ... ok
test range_fns::tests::rsq_constant_array_is_div_zero ... ok
test range_fns::tests::rsq_known_fixture ... ok
test range_fns::tests::rsq_perfect_negative_is_one ... ok
test range_fns::tests::rsq_perfect_positive_is_one ... ok
test range_fns::tests::rsq_shape_mismatch_is_value_error ... ok
test range_fns::tests::rsq_too_few_pairs_is_div_zero ... ok
test range_fns::tests::slope_arity_violations ... ok
test range_fns::tests::slope_constant_x_is_div_zero ... ok
test range_fns::tests::slope_error_in_x_propagates ... ok
test range_fns::tests::slope_error_in_y_propagates ... ok
test range_fns::tests::slope_known_fixture ... ok
test range_fns::tests::slope_negative ... ok
test range_fns::tests::slope_perfect_y_equals_2x ... ok
test range_fns::tests::slope_scalar_args_are_value_error ... ok
test range_fns::tests::slope_shape_mismatch_is_value_error ... ok
test range_fns::tests::slope_skips_non_numeric_pairs ... ok
test range_fns::tests::slope_too_few_pairs_is_div_zero ... ok
test range_fns::tests::small_k_out_of_range_is_num ... ok
test range_fns::tests::small_returns_kth_smallest ... ok
test range_fns::tests::steyx_arity_and_scalar_validation ... ok
test range_fns::tests::steyx_constant_x_is_div_zero ... ok
test range_fns::tests::steyx_error_propagation ... ok
test range_fns::tests::steyx_exactly_three_pairs_succeeds ... ok
test range_fns::tests::steyx_manual_scatter_fixture ... ok
test range_fns::tests::steyx_perfect_line_is_zero ... ok
test range_fns::tests::steyx_shape_mismatch_is_value_error ... ok
test range_fns::tests::steyx_skips_non_numeric_pairs ... ok
test range_fns::tests::steyx_too_few_pairs_is_div_zero ... ok
test range_fns::tests::subtotal_101_normalizes_to_average ... ok
test range_fns::tests::subtotal_109_normalizes_to_sum ... ok
test range_fns::tests::subtotal_arity_violations ... ok
test range_fns::tests::subtotal_average_function_num_1 ... ok
test range_fns::tests::subtotal_boolean_function_num_coerces ... ok
test range_fns::tests::subtotal_count_function_num_2 ... ok
test range_fns::tests::subtotal_count_skips_errors_in_range ... ok
test range_fns::tests::subtotal_counta_counts_errors_in_range ... ok
test range_fns::tests::subtotal_counta_function_num_3 ... ok
test range_fns::tests::subtotal_empty_numeric_data_for_average_is_div_zero ... ok
test range_fns::tests::subtotal_error_in_data_propagates_via_dispatched_kernel ... ok
test range_fns::tests::subtotal_fractional_function_num_truncates ... ok
test range_fns::tests::subtotal_function_num_100_is_value_error ... ok
test range_fns::tests::subtotal_function_num_112_is_value_error ... ok
test range_fns::tests::subtotal_function_num_12_is_value_error ... ok
test range_fns::tests::subtotal_function_num_error_propagates ... ok
test range_fns::tests::subtotal_function_num_lenient_text_still_value_error ... ok
test range_fns::tests::subtotal_function_num_nan_is_num_error ... ok
test range_fns::tests::subtotal_function_num_negative_is_value_error ... ok
test range_fns::tests::subtotal_function_num_text_is_value_error ... ok
test range_fns::tests::subtotal_function_num_zero_is_value_error ... ok
test range_fns::tests::subtotal_max_function_num_4 ... ok
test range_fns::tests::subtotal_min_function_num_5 ... ok
test range_fns::tests::subtotal_multiple_ranges_concatenate ... ok
test range_fns::tests::subtotal_product_function_num_6 ... ok
test range_fns::tests::subtotal_scalar_data_args_supported ... ok
test range_fns::tests::subtotal_stdev_p_function_num_8 ... ok
test range_fns::tests::subtotal_nested_subtotal_value_in_args_not_skipped_engine_divergence ... ok
test range_fns::tests::subtotal_stdev_s_function_num_7 ... ok
test range_fns::tests::subtotal_sum_function_num_9 ... ok
test range_fns::tests::subtotal_var_p_function_num_11 ... ok
test range_fns::tests::subtotal_var_s_function_num_10 ... ok
test range_fns::tests::sumif_arity_errors ... ok
test range_fns::tests::sumif_basic_numeric_criteria ... ok
test range_fns::tests::sumif_blank_in_range_skipped ... ok
test range_fns::tests::sumif_empty_range ... ok
test range_fns::tests::sumif_error_in_criteria_propagates ... ok
test range_fns::tests::sumif_error_in_sum_range_propagates ... ok
test range_fns::tests::sumif_greater_than_criteria ... ok
test range_fns::tests::sumif_text_criteria_skips_non_matching_strings ... ok
test range_fns::tests::sumif_wildcard_sums_matching_indices ... ok
test range_fns::tests::sumif_with_separate_sum_range ... ok
test range_fns::tests::sumif_wrong_arg_shape ... ok
test range_fns::tests::sumifs_1x3_vs_3x1_criteria_range_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumifs_empty_match_is_zero ... ok
test range_fns::tests::sumifs_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumifs_sum_range_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumifs_three_conditions_and ... ok
test range_fns::tests::sumifs_unpaired_extra_arg_is_value_error ... ok
test range_fns::tests::sumproduct_1x3_vs_3x1_same_length_different_shape_is_value_error ... ok
test range_fns::tests::sumifs_two_conditions_2d_column_shape ... ok
test range_fns::tests::sumifs_two_conditions ... ok
test range_fns::tests::sumproduct_2x2_matching_arrays_works ... ok
test range_fns::tests::sumproduct_2x2_vs_1x4_same_length_different_shape_is_value_error ... ok
test range_fns::tests::sumproduct_empty_args_is_value_error ... ok
test range_fns::tests::sumproduct_error_in_cell_propagates ... ok
test range_fns::tests::sumproduct_scalar_acts_as_constant_multiplier ... ok
test range_fns::tests::sumproduct_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumproduct_single_array_is_sum ... ok
test range_fns::tests::sumproduct_text_treated_as_zero ... ok
test range_fns::tests::sumproduct_three_arrays ... ok
test range_fns::tests::sumproduct_two_arrays ... ok
test range_fns::tests::sumx2my2_basic ... ok
test range_fns::tests::sumx2my2_error_propagates ... ok
test range_fns::tests::sumx2my2_scalar_arg_is_value_error ... ok
test range_fns::tests::sumx2my2_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumx2my2_text_coerces_to_zero ... ok
test range_fns::tests::sumx2py2_basic ... ok
test range_fns::tests::sumx2py2_shape_mismatch_is_value_error ... ok
test range_fns::tests::sumxmy2_basic ... ok
test range_fns::tests::sumxmy2_wrong_arity_is_value_error ... ok
test range_fns::tests::sumxmy2_zero_diff ... ok
test range_fns::tests::textjoin_basic ... ok
test range_fns::tests::textjoin_coerces_numbers_and_bools ... ok
test range_fns::tests::textjoin_empty_delimiter ... ok
test range_fns::tests::textjoin_error_in_arg_propagates ... ok
test range_fns::tests::textjoin_ignore_empty_false_keeps_empty_strings ... ok
test range_fns::tests::textjoin_ignore_empty_true_skips_empty_strings ... ok
test range_fns::tests::textjoin_range_flattens ... ok
test range_fns::tests::textjoin_range_with_ignore_empty_skips_blanks ... ok
test range_fns::tests::textjoin_too_few_args_is_value_error ... ok
test range_fns::tests::vlookup_approximate_match_default ... ok
test range_fns::tests::vlookup_col_index_out_of_range_is_ref ... ok
test range_fns::tests::vlookup_col_index_zero_or_negative_is_value ... ok
test range_fns::tests::vlookup_error_in_lookup_value_propagates ... ok
test range_fns::tests::vlookup_exact_match ... ok
test range_fns::tests::vlookup_exact_not_found_is_na ... ok
test range_fns::tests::xlookup_binary_asc_exact_match ... ok
test range_fns::tests::xlookup_binary_asc_next_larger ... ok
test range_fns::tests::xlookup_binary_asc_next_smaller ... ok
test range_fns::tests::xlookup_binary_asc_no_match_returns_na ... ok
test range_fns::tests::xlookup_binary_desc_exact_match ... ok
test range_fns::tests::xlookup_binary_desc_needle_at_extremes ... ok
test range_fns::tests::xlookup_binary_desc_next_larger ... ok
test range_fns::tests::xlookup_binary_desc_next_smaller ... ok
test range_fns::tests::xlookup_binary_empty_hay_is_na ... ok
test range_fns::tests::xlookup_binary_unsorted_input_diverges_from_linear ... ok
test range_fns::tests::xlookup_exact_match ... ok
test range_fns::tests::xlookup_if_not_found_when_no_match ... ok
test range_fns::tests::xlookup_invalid_match_mode_is_value_error ... ok
test range_fns::tests::xlookup_match_mode_next_larger ... ok
test range_fns::tests::xlookup_match_mode_next_smaller ... ok
test range_fns::tests::xlookup_no_match_returns_na_by_default ... ok
test range_fns::tests::xlookup_search_mode_reverse ... ok
test range_fns::tests::xlookup_shape_mismatch_is_value_error ... ok
test range_fns::tests::xlookup_too_few_args_is_value_error ... ok
test range_fns::tests::xlookup_wildcard_match ... ok
test range_fns::tests::xlookup_wildcard_plus_binary_is_value_error ... ok
test range_fns::tests::xmatch_basic ... ok
test range_fns::tests::xmatch_binary_asc_exact ... ok
test range_fns::tests::xmatch_binary_desc_exact ... ok
test range_fns::tests::xmatch_no_match_is_na ... ok
test range_fns::tests::xmatch_reverse_search ... ok
test range_fns::tests::xmatch_wildcard_mode ... ok
test range_fns::tests::xmatch_wildcard_plus_binary_is_value_error ... ok
test reference_aware_fns::tests::arg_contract_variants_distinct ... ok
test reference_aware_fns::tests::no_op_reference_query_singleton_is_usable ... ok
test reference_aware_fns::tests::no_op_reference_query_returns_defaults ... ok
test reference_aware_fns::tests::plan_kind_function_returns_reference_distinction ... ok
test reference_aware_fns::tests::ref_arg_variants_construct ... ok
test reference_aware_fns::tests::registry_round_trip_for_reference_aware ... ok
test reference_fns::tests::column_of_array_literal_is_value_error ... ok
test reference_fns::tests::column_of_cell_a1_returns_1 ... ok
test reference_fns::tests::column_of_cell_b5_returns_2 ... ok
test reference_fns::tests::column_of_range_returns_top_left_col ... ok
test reference_fns::tests::column_of_scalar_arg_is_value_error ... ok
test reference_fns::tests::column_propagates_error_arg ... ok
test reference_fns::tests::column_zero_arg_with_formula_cell_returns_formula_col ... ok
test reference_fns::tests::column_zero_arg_without_formula_cell_returns_ref ... ok
test reference_fns::tests::columns_arity_errors ... ok
test reference_fns::tests::columns_of_array_literal_returns_second_dim ... ok
test reference_fns::tests::columns_of_range_a1_b3_returns_2 ... ok
test reference_fns::tests::columns_of_range_a1_e1_returns_5 ... ok
test reference_fns::tests::columns_of_scalar_arg_is_value_error ... ok
test reference_fns::tests::columns_of_single_cell_returns_1 ... ok
test reference_fns::tests::columns_of_whole_row_returns_max_column_plus_1 ... ok
test reference_fns::tests::columns_propagates_error_arg ... ok
test reference_fns::tests::formulatext_arity_two_returns_na ... ok
test reference_fns::tests::formulatext_arity_zero_returns_na ... ok
test reference_fns::tests::formulatext_of_array_literal_returns_na ... ok
test reference_fns::tests::formulatext_of_cellref_with_noop_workbook_returns_na ... ok
test reference_fns::tests::formulatext_of_number_scalar_returns_na ... ok
test reference_fns::tests::formulatext_of_multi_cell_range_returns_na ... ok
test reference_fns::tests::formulatext_of_text_scalar_returns_na ... ok
test reference_fns::tests::formulatext_of_single_cell_range_with_noop_workbook_returns_na ... ok
test reference_fns::tests::formulatext_propagates_error_arg ... ok
test reference_fns::tests::isformula_arity_two_returns_na ... ok
test reference_fns::tests::isformula_arity_zero_returns_na ... ok
test reference_fns::tests::isformula_of_array_literal_returns_na ... ok
test reference_fns::tests::isformula_of_cellref_with_noop_workbook_returns_false ... ok
test reference_fns::tests::isformula_of_multi_cell_range_returns_na ... ok
test reference_fns::tests::isformula_of_number_scalar_returns_na ... ok
test reference_fns::tests::isformula_of_single_cell_range_with_noop_workbook_returns_false ... ok
test reference_fns::tests::isformula_of_text_scalar_returns_na ... ok
test reference_fns::tests::isformula_propagates_error_arg ... ok
test reference_fns::tests::isref_arity_two_returns_na ... ok
test reference_fns::tests::isref_arity_zero_returns_na ... ok
test reference_fns::tests::isref_of_cellref_shape_is_true ... ok
test reference_fns::tests::isref_of_error_shape_is_false ... ok
test reference_fns::tests::isref_of_function_call_shape_is_false_when_not_reference_returning ... ok
test reference_fns::tests::isref_of_function_call_shape_is_true_when_reference_returning ... ok
test reference_fns::tests::isref_of_literal_shape_is_false ... ok
test reference_fns::tests::isref_of_rangeref_shape_is_true ... ok
test reference_fns::tests::isref_with_reference_eager_arg_returns_true_defensive ... ok
test reference_fns::tests::isref_with_scalar_eager_arg_returns_false_defensive ... ok
test reference_fns::tests::row_of_arity_zero_with_extra_args_returns_na ... ok
test reference_fns::tests::row_of_array_literal_is_value_error ... ok
test reference_fns::tests::row_of_cell_a1_returns_1 ... ok
test reference_fns::tests::row_of_cell_b5_returns_5 ... ok
test reference_fns::tests::row_of_range_returns_top_left_row ... ok
test reference_fns::tests::row_of_scalar_arg_is_value_error ... ok
test reference_fns::tests::row_propagates_error_arg ... ok
test reference_fns::tests::row_with_shape_arg_returns_value_error ... ok
test reference_fns::tests::row_zero_arg_with_formula_cell_returns_formula_row ... ok
test reference_aware_fns::tests::register_reference_aware_rejects_lowercase - should panic ... ok
test reference_aware_fns::tests::register_reference_aware_rejects_duplicate - should panic ... ok
test reference_fns::tests::row_zero_arg_without_formula_cell_returns_ref ... ok
test reference_fns::tests::rows_arity_errors ... ok
test reference_fns::tests::rows_of_array_literal_returns_first_dim ... ok
test reference_fns::tests::rows_of_range_a1_a5_returns_5 ... ok
test reference_fns::tests::rows_of_range_a1_b3_returns_3 ... ok
test reference_fns::tests::rows_of_scalar_arg_is_value_error ... ok
test reference_fns::tests::rows_of_single_cell_returns_1 ... ok
test reference_fns::tests::rows_of_whole_column_returns_max_row_plus_1 ... ok
test reference_fns::tests::rows_propagates_error_arg ... ok
test reference_fns::tests::rows_with_shape_arg_returns_value_error ... ok
test registry::tests::context_aware_fn_receives_eval_context ... ok
test registry::tests::context_aware_names_returns_only_context_aware ... ok
test registry::tests::context_aware_register_and_lookup_works ... ok
test registry::tests::ai_dispatches_to_not_available_sentinel ... ok
test registry::tests::aliases_dispatch_to_same_fn ... ok
test registry::tests::empty_registry_lookup_none ... ok
test registry::tests::function_arg_array_round_trips_through_unified ... ok
test registry::tests::context_aware_tier_disjoint_from_range_aware ... ok
test registry::tests::default_registry_has_expected_count ... ok
test registry::tests::is_empty_checks_all_three_tables ... ok
test registry::tests::dotted_function_names_supported ... ok
test registry::tests::function_return_is_array_helper ... ok
test registry::tests::len_includes_context_aware_table ... ok
test registry::tests::context_aware_tier_disjoint_from_scalar ... ok
test registry::tests::lookup_any_returns_tagged_enum ... ok
test registry::tests::lookup_unified_is_case_insensitive ... ok
test registry::tests::end_to_end_sum_via_registry ... ok
test registry::tests::names_all_chains_all_three_tables ... ok
test registry::tests::duplicate_range_aware_registration_panics - should panic ... ok
test registry::tests::duplicate_context_aware_registration_panics - should panic ... ok
test registry::tests::duplicate_unified_registration_panics - should panic ... ok
test registry::tests::names_all_includes_unified ... ok
test registry::tests::lookup_missing_returns_none ... ok
test registry::tests::register_context_aware_with_existing_scalar_name_panics - should panic ... ok
test registry::tests::register_context_aware_with_existing_range_aware_name_panics - should panic ... ok
test registry::tests::register_dotted_uppercase_name_ok ... ok
test registry::tests::register_empty_name_panics - should panic ... ok
test registry::tests::register_duplicate_name_panics - should panic ... ok
test registry::tests::lookup_is_case_insensitive ... ok
test registry::tests::register_lowercase_name_panics - should panic ... ok
test registry::tests::register_range_aware_with_existing_context_aware_name_panics - should panic ... ok
test registry::tests::register_range_aware_with_existing_scalar_name_panics - should panic ... ok
test registry::tests::range_aware_lookup_returns_registered_function ... ok
test registry::tests::register_scalar_with_existing_unified_name_panics - should panic ... ok
test registry::tests::register_unified_and_lookup_unified_round_trip ... ok
test registry::tests::register_mixed_case_name_panics - should panic ... ok
test registry::tests::unified_names_returns_only_unified ... ok
test registry::tests::register_unified_with_existing_scalar_name_panics - should panic ... ok
test registry::tests::register_scalar_with_existing_context_aware_name_panics - should panic ... ok
test registry::tests::unified_tier_disjoint_from_other_tiers ... ok
test range_fns::tests::concat_exceeds_32k_char_cap_is_value_error ... ok
test scalar_fns::tests::abs_basic ... ok
test scalar_fns::tests::acosh_domain_and_basic ... ok
test range_fns::tests::concat_just_under_cap_succeeds ... ok
test scalar_fns::tests::address_col_letters_multi ... ok
test scalar_fns::tests::address_a1_reference_name_gets_quoted ... ok
test scalar_fns::tests::address_abs_modes ... ok
test scalar_fns::tests::address_default_abs ... ok
test registry::tests::scalar_and_range_aware_tiers_are_disjoint ... ok
test scalar_fns::tests::address_dot_name_not_quoted ... ok
test scalar_fns::tests::address_invalid_coords_is_value_error ... ok
test scalar_fns::tests::address_leading_digit_name_gets_quoted ... ok
test scalar_fns::tests::address_invalid_abs_is_value_error ... ok
test scalar_fns::tests::address_r1c1_reference_name_gets_quoted ... ok
test scalar_fns::tests::address_r1c1_style ... ok
test scalar_fns::tests::address_sheet_with_space_gets_quoted ... ok
test scalar_fns::tests::address_single_quote_in_name_gets_doubled ... ok
test scalar_fns::tests::address_with_sheet_text ... ok
test scalar_fns::tests::ai_no_args_returns_not_available ... ok
test scalar_fns::tests::ai_with_args_still_returns_not_available ... ok
test scalar_fns::tests::and_all_true ... ok
test scalar_fns::tests::and_empty_is_value_error ... ok
test scalar_fns::tests::and_one_false ... ok
test scalar_fns::tests::arc_str_value_preserved_through_iferror ... ok
test scalar_fns::tests::asin_acos_domain_errors ... ok
test scalar_fns::tests::asin_acos_boundary_values_ok ... ok
test scalar_fns::tests::asinh_basic ... ok
test scalar_fns::tests::asin_acos_atan_basic_inverses ... ok
test scalar_fns::tests::atan2_basic_quadrants ... ok
test scalar_fns::tests::atan2_blank_args_treated_as_zero ... ok
test scalar_fns::tests::atan2_zero_zero_is_div_zero ... ok
test scalar_fns::tests::atan_extreme_inputs_converge ... ok
test scalar_fns::tests::atanh_domain_and_basic ... ok
test scalar_fns::tests::average_basic ... ok
test scalar_fns::tests::average_empty_is_div_zero ... ok
test scalar_fns::tests::average_uses_welford_for_large_offset ... ok
test scalar_fns::tests::averagea_counts_text_and_bool ... ok
test scalar_fns::tests::averagea_empty_is_div_zero ... ok
test scalar_fns::tests::averagea_propagates_errors ... ok
test scalar_fns::tests::averagea_skips_blanks ... ok
test scalar_fns::tests::bin2dec_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bin2dec_basic ... ok
test scalar_fns::tests::bin2dec_error_arg_propagates ... ok
test scalar_fns::tests::bin2dec_high_bit_set_is_negative ... ok
test scalar_fns::tests::bin2dec_non_binary_digit_is_num_error ... ok
test scalar_fns::tests::bin2dec_out_of_range_with_valid_binary_digits_is_num_error ... ok
test scalar_fns::tests::bin2dec_round_trip_with_dec2bin_positive ... ok
test scalar_fns::tests::bin2dec_text_arg_now_accepted ... ok
test scalar_fns::tests::bit_lshift_rshift_round_trip ... ok
test scalar_fns::tests::bit_xor_or_and_identity ... ok
test scalar_fns::tests::bitand_above_max_is_num_error ... ok
test scalar_fns::tests::bitand_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bitand_basic_closed_form ... ok
test scalar_fns::tests::bitand_error_arg_propagates ... ok
test scalar_fns::tests::bitand_max_value_canon ... ok
test scalar_fns::tests::bitand_negative_is_num_error ... ok
test scalar_fns::tests::bitand_non_integer_is_num_error ... ok
test scalar_fns::tests::bitand_self_identity ... ok
test scalar_fns::tests::bitand_text_arg_is_value_error ... ok
test scalar_fns::tests::bitand_zero_identity ... ok
test scalar_fns::tests::bitlshift_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bitlshift_basic_closed_form ... ok
test scalar_fns::tests::bitlshift_error_arg_propagates ... ok
test scalar_fns::tests::bitlshift_high_bit_wrap_to_negative_regression ... ok
test scalar_fns::tests::bitlshift_high_bit_wrap_to_zero_regression ... ok
test scalar_fns::tests::bitlshift_negative_number_is_num_error ... ok
test scalar_fns::tests::bitlshift_negative_shift_is_right_shift ... ok
test scalar_fns::tests::bitlshift_non_integer_number_is_num_error ... ok
test scalar_fns::tests::bitlshift_non_integer_shift_silently_truncated ... ok
test scalar_fns::tests::bitlshift_number_above_max_is_num_error ... ok
test scalar_fns::tests::bitlshift_result_overflow_is_num_error ... ok
test scalar_fns::tests::bitlshift_shift_above_53_is_num_error ... ok
test scalar_fns::tests::bitlshift_text_arg_is_value_error ... ok
test scalar_fns::tests::bitlshift_wrap_family_regression ... ok
test scalar_fns::tests::bitlshift_zero_shift_identity ... ok
test scalar_fns::tests::bitor_above_max_is_num_error ... ok
test scalar_fns::tests::bitor_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bitor_basic_closed_form ... ok
test scalar_fns::tests::bitor_error_arg_propagates ... ok
test scalar_fns::tests::bitor_max_value_canon ... ok
test scalar_fns::tests::bitor_negative_is_num_error ... ok
test scalar_fns::tests::bitor_non_integer_is_num_error ... ok
test scalar_fns::tests::bitor_self_identity ... ok
test scalar_fns::tests::bitor_text_arg_is_value_error ... ok
test scalar_fns::tests::bitor_zero_identity ... ok
test scalar_fns::tests::bitrshift_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bitrshift_basic_closed_form ... ok
test scalar_fns::tests::bitrshift_error_arg_propagates ... ok
test scalar_fns::tests::bitrshift_negative_number_is_num_error ... ok
test scalar_fns::tests::bitrshift_negative_shift_is_left_shift ... ok
test scalar_fns::tests::bitrshift_negative_shift_overflow_is_num_error ... ok
test scalar_fns::tests::bitrshift_negative_shift_overflow_wrap_regression ... ok
test scalar_fns::tests::bitrshift_non_integer_number_is_num_error ... ok
test scalar_fns::tests::bitrshift_number_above_max_is_num_error ... ok
test scalar_fns::tests::bitrshift_shift_above_53_is_num_error ... ok
test scalar_fns::tests::bitrshift_text_arg_is_value_error ... ok
test scalar_fns::tests::bitrshift_zero_shift_identity ... ok
test scalar_fns::tests::bitxor_above_max_is_num_error ... ok
test scalar_fns::tests::bitxor_arity_mismatch_returns_value ... ok
test scalar_fns::tests::bitxor_basic_closed_form ... ok
test scalar_fns::tests::bitxor_error_arg_propagates ... ok
test scalar_fns::tests::bitxor_max_value_canon ... ok
test scalar_fns::tests::bitxor_negative_is_num_error ... ok
test scalar_fns::tests::bitxor_non_integer_is_num_error ... ok
test scalar_fns::tests::bitxor_self_zero ... ok
test scalar_fns::tests::bitxor_text_arg_is_value_error ... ok
test scalar_fns::tests::bitxor_zero_identity ... ok
test scalar_fns::tests::ceiling_default_significance_is_one ... ok
test scalar_fns::tests::ceiling_explicit_significance ... ok
test scalar_fns::tests::ceiling_math_arity_error ... ok
test scalar_fns::tests::ceiling_math_negative_default_mode_zero ... ok
test scalar_fns::tests::ceiling_math_negative_mode_one ... ok
test scalar_fns::tests::ceiling_math_positive_default ... ok
test scalar_fns::tests::ceiling_math_uses_abs_significance ... ok
test scalar_fns::tests::ceiling_math_with_significance ... ok
test scalar_fns::tests::ceiling_math_zero_significance_returns_zero ... ok
test scalar_fns::tests::ceiling_positive_with_negative_significance_is_num ... ok
test scalar_fns::tests::ceiling_zero_significance_returns_zero ... ok
test scalar_fns::tests::char_ascii_basic ... ok
test scalar_fns::tests::char_out_of_range_is_value_error ... ok
test scalar_fns::tests::char_truncates_toward_zero ... ok
test scalar_fns::tests::clean_empty_input ... ok
test scalar_fns::tests::clean_preserves_high_chars ... ok
test scalar_fns::tests::clean_propagates_errors ... ok
test scalar_fns::tests::clean_strips_low_control_chars ... ok
test scalar_fns::tests::code_ascii_basic ... ok
test scalar_fns::tests::code_empty_string_is_value_error ... ok
test scalar_fns::tests::combin_basic ... ok
test scalar_fns::tests::combin_k_greater_than_n_is_num_error ... ok
test scalar_fns::tests::combin_negative_is_num_error ... ok
test scalar_fns::tests::combin_overflow_is_num_error ... ok
test scalar_fns::tests::combin_symmetry_handles_large_k ... ok
test scalar_fns::tests::combina_basic ... ok
test scalar_fns::tests::combina_n_zero_k_positive_is_num_error ... ok
test scalar_fns::tests::combina_overflow_is_num_error ... ok
test scalar_fns::tests::concatenate_basic ... ok
test scalar_fns::tests::concatenate_coerces_numbers ... ok
test scalar_fns::tests::concatenate_empty_args_is_value_error ... ok
test scalar_fns::tests::concatenate_propagates_errors ... ok
test scalar_fns::tests::cosh_basic ... ok
test scalar_fns::tests::count_only_numbers ... ok
test scalar_fns::tests::counta_counts_non_blank ... ok
test scalar_fns::tests::dec2bin_arity_mismatch_returns_value ... ok
test scalar_fns::tests::dec2bin_basic ... ok
test scalar_fns::tests::dec2bin_error_arg_propagates ... ok
test scalar_fns::tests::dec2bin_negative_ignores_places ... ok
test scalar_fns::tests::dec2bin_negative_twos_complement_10_digits ... ok
test scalar_fns::tests::dec2bin_out_of_range_is_num_error ... ok
test scalar_fns::tests::dec2bin_places_out_of_range_is_num_error ... ok
test scalar_fns::tests::dec2bin_places_too_small_for_positive_is_num_error ... ok
test scalar_fns::tests::dec2bin_text_arg_is_value_error ... ok
test scalar_fns::tests::dec2bin_with_places_zero_pads ... ok
test scalar_fns::tests::dec2hex_arity_mismatch_returns_value ... ok
test scalar_fns::tests::dec2hex_basic ... ok
test scalar_fns::tests::dec2hex_error_arg_propagates ... ok
test scalar_fns::tests::dec2hex_negative_ignores_places ... ok
test scalar_fns::tests::dec2hex_negative_twos_complement ... ok
test scalar_fns::tests::dec2hex_out_of_range_is_num_error ... ok
test scalar_fns::tests::dec2hex_places_too_small_is_num_error ... ok
test scalar_fns::tests::dec2hex_text_arg_is_value_error ... ok
test scalar_fns::tests::dec2hex_uppercase_output ... ok
test scalar_fns::tests::dec2hex_with_places_zero_pads ... ok
test scalar_fns::tests::dec2oct_arity_mismatch_returns_value ... ok
test scalar_fns::tests::dec2oct_basic ... ok
test scalar_fns::tests::dec2oct_error_arg_propagates ... ok
test scalar_fns::tests::dec2oct_negative_twos_complement ... ok
test scalar_fns::tests::dec2oct_out_of_range_is_num_error ... ok
test scalar_fns::tests::dec2oct_places_boundary_exact_fit ... ok
test scalar_fns::tests::dec2oct_places_too_small_is_num_error ... ok
test scalar_fns::tests::dec2oct_text_arg_is_value_error ... ok
test scalar_fns::tests::dec2oct_with_places_zero_pads ... ok
test scalar_fns::tests::degrees_and_radians_round_trip ... ok
test scalar_fns::tests::dollar_arity_violations ... ok
test scalar_fns::tests::dollar_blank_is_treated_as_zero ... ok
test scalar_fns::tests::dollar_de_locale_euro_suffix ... ok
test scalar_fns::tests::dollar_de_negative_uses_minus_prefix ... ok
test scalar_fns::tests::dollar_default_decimals ... ok
test scalar_fns::tests::dollar_error_in_decimals_propagates ... ok
test scalar_fns::tests::dollar_error_in_number_propagates ... ok
test scalar_fns::tests::dollar_fr_locale_euro_suffix_with_space_grouping ... ok
test scalar_fns::tests::dollar_fr_negative_uses_minus_prefix ... ok
test scalar_fns::tests::dollar_negative_decimals_round_left_enus ... ok
test scalar_fns::tests::dollar_negative_uses_accounting_parens_enus ... ok
test scalar_fns::tests::dollar_zero_decimals ... ok
test scalar_fns::tests::dollar_zero_value_has_no_parens ... ok
test scalar_fns::tests::error_type_canonical_codes ... ok
test scalar_fns::tests::error_type_non_error_returns_na ... ok
test scalar_fns::tests::error_type_wrong_arity_is_value_error ... ok
test scalar_fns::tests::even_basic ... ok
test scalar_fns::tests::exact_case_sensitive ... ok
test scalar_fns::tests::exact_number_coercion ... ok
test scalar_fns::tests::exp_and_ln_round_trip ... ok
test scalar_fns::tests::fact_above_170_is_num_error ... ok
test scalar_fns::tests::fact_basic ... ok
test scalar_fns::tests::fact_negative_is_num_error ... ok
test scalar_fns::tests::fact_truncates_toward_zero ... ok
test scalar_fns::tests::factdouble_basic ... ok
test scalar_fns::tests::factdouble_huge_arg_is_num_error_fast ... ok
test scalar_fns::tests::factdouble_negative_below_minus_one_is_num_error ... ok
test scalar_fns::tests::find_case_sensitive ... ok
test scalar_fns::tests::find_empty_needle_matches_start ... ok
test scalar_fns::tests::find_not_found_is_value_error ... ok
test scalar_fns::tests::find_with_start_num ... ok
test scalar_fns::tests::fixed_default_decimals_enus ... ok
test scalar_fns::tests::fixed_locale_de ... ok
test scalar_fns::tests::fixed_negative_decimals ... ok
test scalar_fns::tests::fixed_negative_value ... ok
test scalar_fns::tests::fixed_no_commas ... ok
test scalar_fns::tests::fixed_zero_decimals ... ok
test scalar_fns::tests::floor_basic ... ok
test scalar_fns::tests::floor_math_arity_error ... ok
test scalar_fns::tests::floor_math_negative_default_mode_zero ... ok
test scalar_fns::tests::floor_math_negative_mode_one ... ok
test scalar_fns::tests::floor_math_positive_default ... ok
test scalar_fns::tests::floor_math_uses_abs_significance ... ok
test scalar_fns::tests::floor_math_with_significance ... ok
test scalar_fns::tests::floor_math_zero_significance_nonzero_number_is_div_zero ... ok
test scalar_fns::tests::floor_math_zero_significance_zero_number_is_zero ... ok
test scalar_fns::tests::floor_positive_with_negative_significance_is_num ... ok
test scalar_fns::tests::floor_zero_significance_nonzero_number_is_div_zero ... ok
test scalar_fns::tests::gcd_arity ... ok
test scalar_fns::tests::gcd_basic ... ok
test scalar_fns::tests::gcd_negative_arg_is_num ... ok
test scalar_fns::tests::gcd_truncates_to_integer ... ok
test scalar_fns::tests::h5_degrees_radians_arity_error_overflow ... ok
test scalar_fns::tests::h5_exp_arity_error_overflow ... ok
test scalar_fns::tests::h5_len_known_unicode_divergence ... ok
test scalar_fns::tests::h5_log10_arity_error_coercion ... ok
test scalar_fns::tests::h5_rounddown_arity_error_coercion ... ok
test scalar_fns::tests::h5_sign_arity_error_coercion ... ok
test scalar_fns::tests::h5_trim_arity_nbsp_preserved ... ok
test scalar_fns::tests::h5_trunc_arity_error_coercion ... ok
test scalar_fns::tests::h5_upper_lower_arity ... ok
test scalar_fns::tests::hex2dec_arity_mismatch_returns_value ... ok
test scalar_fns::tests::hex2dec_basic ... ok
test scalar_fns::tests::hex2dec_error_arg_propagates ... ok
test scalar_fns::tests::hex2dec_high_bit_is_negative ... ok
test scalar_fns::tests::hex2dec_invalid_hex_is_num_error ... ok
test scalar_fns::tests::hex2dec_number_arg_excel_canon_auto_coerces ... ok
test scalar_fns::tests::hex2dec_round_trip_with_dec2hex ... ok
test scalar_fns::tests::hex2dec_too_long_is_num_error ... ok
test scalar_fns::tests::hyperbolic_arity_errors ... ok
test scalar_fns::tests::if_basic ... ok
test scalar_fns::tests::if_wrong_arity ... ok
test scalar_fns::tests::iferror_replaces_error ... ok
test scalar_fns::tests::ifna_passes_non_na_value_through ... ok
test scalar_fns::tests::ifna_propagates_non_na_errors ... ok
test scalar_fns::tests::ifna_replaces_na_with_fallback ... ok
test scalar_fns::tests::ifna_wrong_arity_returns_value_error ... ok
test scalar_fns::tests::ifs_coerces_numeric_test_via_to_logical ... ok
test scalar_fns::tests::ifs_empty_args_is_value_error ... ok
test scalar_fns::tests::ifs_no_match_returns_na ... ok
test scalar_fns::tests::ifs_odd_arg_count_silently_discards_trailing ... ok
test scalar_fns::tests::ifs_propagates_test_errors ... ok
test scalar_fns::tests::ifs_returns_first_matching_value ... ok
test scalar_fns::tests::int_floors_negative_correctly ... ok
test scalar_fns::tests::is_fns_arity_check ... ok
test scalar_fns::tests::iserror_catches_all_iserr_excludes_na ... ok
test scalar_fns::tests::iseven_basic ... ok
test scalar_fns::tests::iseven_blank_is_true ... ok
test scalar_fns::tests::iseven_text_is_value_error ... ok
test scalar_fns::tests::isnontext_basic ... ok
test scalar_fns::tests::isnumber_recognizes_numbers_only ... ok
test scalar_fns::tests::isodd_basic ... ok
test scalar_fns::tests::istext_isblank_islogical ... ok
test scalar_fns::tests::lcm_basic ... ok
test scalar_fns::tests::lcm_negative_arg_is_num ... ok
test scalar_fns::tests::left_arity_errors ... ok
test scalar_fns::tests::left_default_and_explicit_count ... ok
test scalar_fns::tests::left_empty_text ... ok
test scalar_fns::tests::left_negative_count_is_value_error ... ok
test scalar_fns::tests::len_coerces_non_text_args ... ok
test scalar_fns::tests::len_counts_chars_not_bytes ... ok
test scalar_fns::tests::ln_non_positive_is_num_error ... ok
test scalar_fns::tests::log10_basic ... ok
test scalar_fns::tests::log_default_base_is_ten ... ok
test scalar_fns::tests::log_explicit_base ... ok
test scalar_fns::tests::log_invalid_inputs ... ok
test scalar_fns::tests::max_basic ... ok
test scalar_fns::tests::maxa_empty_is_zero ... ok
test scalar_fns::tests::maxa_text_counts_as_zero ... ok
test scalar_fns::tests::maxa_true_is_one ... ok
test scalar_fns::tests::mid_basic ... ok
test scalar_fns::tests::mid_start_below_one_is_value_error ... ok
test scalar_fns::tests::min_basic ... ok
test scalar_fns::tests::min_empty_is_zero ... ok
test scalar_fns::tests::mina_empty_is_zero ... ok
test scalar_fns::tests::mina_false_is_zero ... ok
test scalar_fns::tests::mina_text_counts_as_zero ... ok
test scalar_fns::tests::mod_basic ... ok
test scalar_fns::tests::mod_zero_divisor ... ok
test scalar_fns::tests::mround_basic ... ok
test scalar_fns::tests::mround_sign_mismatch_is_num ... ok
test scalar_fns::tests::mround_zero_multiple_with_nonzero_number_is_num ... ok
test scalar_fns::tests::mround_zero_multiple_with_zero_number_returns_zero ... ok
test scalar_fns::tests::n_value_coerces ... ok
test scalar_fns::tests::n_value_propagates_errors ... ok
test scalar_fns::tests::na_returns_na_with_no_args ... ok
test scalar_fns::tests::na_with_args_is_value_error ... ok
test scalar_fns::tests::not_basic ... ok
test scalar_fns::tests::numbervalue_arity_violations ... ok
test scalar_fns::tests::numbervalue_basic_enus ... ok
test scalar_fns::tests::numbervalue_blank_is_zero ... ok
test scalar_fns::tests::numbervalue_blank_separator_uses_default ... ok
test scalar_fns::tests::numbervalue_boolean_text_fails ... ok
test scalar_fns::tests::numbervalue_decimal_equals_group_is_value_error ... ok
test scalar_fns::tests::numbervalue_decimal_with_no_integer_part ... ok
test scalar_fns::tests::numbervalue_default_locale_de ... ok
test scalar_fns::tests::numbervalue_default_locale_fr ... ok
test scalar_fns::tests::numbervalue_empty_separator_arg_is_value_error ... ok
test scalar_fns::tests::numbervalue_empty_string_is_zero ... ok
test scalar_fns::tests::numbervalue_error_in_separator_propagates ... ok
test scalar_fns::tests::numbervalue_error_in_text_propagates ... ok
test scalar_fns::tests::numbervalue_explicit_decimal_separator ... ok
test scalar_fns::tests::numbervalue_explicit_group_separator ... ok
test scalar_fns::tests::numbervalue_fr_locale_space_after_decimal_pins_divergence ... ok
test scalar_fns::tests::numbervalue_group_after_decimal_is_value_error ... ok
test scalar_fns::tests::numbervalue_internal_spaces_ignored ... ok
test scalar_fns::tests::numbervalue_leading_sign_only_at_start ... ok
test scalar_fns::tests::numbervalue_letters_fail ... ok
test scalar_fns::tests::numbervalue_multi_char_separator_uses_first_char ... ok
test scalar_fns::tests::numbervalue_multiple_decimals_is_value_error ... ok
test scalar_fns::tests::numbervalue_multiple_groups_ok ... ok
test scalar_fns::tests::numbervalue_multiple_percent_divides_by_100_n ... ok
test scalar_fns::tests::numbervalue_number_passes_through ... ok
test scalar_fns::tests::numbervalue_only_separators_no_digits_fails ... ok
test scalar_fns::tests::numbervalue_percent_suffix_divides_by_100 ... ok
test scalar_fns::tests::numbervalue_percent_with_trailing_whitespace ... ok
test scalar_fns::tests::numbervalue_trailing_decimal_ok ... ok
test scalar_fns::tests::numbervalue_whitespace_only_is_zero ... ok
test scalar_fns::tests::numbervalue_zero_with_group_only_ok ... ok
test scalar_fns::tests::oct2dec_arity_mismatch_returns_value ... ok
test scalar_fns::tests::oct2dec_basic ... ok
test scalar_fns::tests::oct2dec_error_arg_propagates ... ok
test scalar_fns::tests::oct2dec_high_bit_is_negative ... ok
test scalar_fns::tests::oct2dec_invalid_octal_is_num_error ... ok
test scalar_fns::tests::oct2dec_number_arg_excel_canon_auto_coerces ... ok
test scalar_fns::tests::oct2dec_round_trip_with_dec2oct ... ok
test scalar_fns::tests::oct2dec_too_long_is_num_error ... ok
test scalar_fns::tests::odd_basic ... ok
test scalar_fns::tests::or_any_true ... ok
test scalar_fns::tests::permut_basic ... ok
test scalar_fns::tests::permut_k_greater_than_n_is_num_error ... ok
test scalar_fns::tests::permut_overflow_is_num_error ... ok
test scalar_fns::tests::permutationa_basic ... ok
test scalar_fns::tests::pi_constant ... ok
test scalar_fns::tests::pi_with_args_is_value_error ... ok
test scalar_fns::tests::power_basic ... ok
test scalar_fns::tests::power_negative_fractional_is_num ... ok
test scalar_fns::tests::product_basic ... ok
test scalar_fns::tests::product_empty_zero_per_excel ... ok
test scalar_fns::tests::proper_arity_error ... ok
test scalar_fns::tests::proper_digits_break_words ... ok
test scalar_fns::tests::proper_empty_and_blank ... ok
test scalar_fns::tests::proper_propagates_errors ... ok
test scalar_fns::tests::proper_punctuation_breaks_words ... ok
test scalar_fns::tests::proper_simple_words ... ok
test scalar_fns::tests::quotient_basic ... ok
test scalar_fns::tests::quotient_zero_denominator_is_div_zero ... ok
test scalar_fns::tests::replace_basic ... ok
test scalar_fns::tests::replace_insert_at_end ... ok
test scalar_fns::tests::replace_start_below_one_is_value_error ... ok
test scalar_fns::tests::rept_basic ... ok
test scalar_fns::tests::rept_excessive_length_is_value_error ... ok
test scalar_fns::tests::rept_negative_count_is_value_error ... ok
test scalar_fns::tests::right_default_and_explicit ... ok
test scalar_fns::tests::round_basic ... ok
test scalar_fns::tests::round_decimal_2_675_matches_excel_via_double_rounding ... ok
test scalar_fns::tests::rounddown_truncates_toward_zero ... ok
test scalar_fns::tests::roundup_error_arg_propagates ... ok
test scalar_fns::tests::roundup_positive_and_negative_round_away_from_zero ... ok
test scalar_fns::tests::roundup_wrong_arity_is_value_error ... ok
test scalar_fns::tests::roundup_zero_input_zero_output ... ok
test scalar_fns::tests::search_case_insensitive ... ok
test scalar_fns::tests::search_not_found ... ok
test scalar_fns::tests::search_wildcard_escape_literal ... ok
test scalar_fns::tests::search_wildcard_no_match ... ok
test scalar_fns::tests::search_wildcard_question_matches_single ... ok
test scalar_fns::tests::search_wildcard_star_finds_substring ... ok
test scalar_fns::tests::search_wildcard_with_start_skips_earlier_match ... ok
test scalar_fns::tests::sign_basic ... ok
test scalar_fns::tests::sin_cos_tan_basic_values ... ok
test scalar_fns::tests::sinh_basic ... ok
test scalar_fns::tests::sinh_overflow_is_num ... ok
test scalar_fns::tests::sqrt_basic ... ok
test scalar_fns::tests::sqrt_negative_is_num_error ... ok
test scalar_fns::tests::stdev_s_simple ... ok
test scalar_fns::tests::substitute_empty_old_no_op ... ok
test scalar_fns::tests::substitute_nth_only ... ok
test scalar_fns::tests::substitute_replace_all ... ok
test scalar_fns::tests::substitute_target_instance_not_present_returns_text_unchanged ... ok
test scalar_fns::tests::sum_basic ... ok
test scalar_fns::tests::sum_empty ... ok
test scalar_fns::tests::sum_error_propagates ... ok
test scalar_fns::tests::sum_text_yields_value_error ... ok
test scalar_fns::tests::sum_with_blanks ... ok
test scalar_fns::tests::sum_with_bool ... ok
test scalar_fns::tests::sumsq_basic ... ok
test scalar_fns::tests::sumsq_empty_is_zero ... ok
test scalar_fns::tests::sumsq_propagates_errors ... ok
test scalar_fns::tests::sumsq_skips_blanks ... ok
test scalar_fns::tests::switch_case_insensitive_string_match ... ok
test scalar_fns::tests::switch_default_branch_when_no_match ... ok
test scalar_fns::tests::switch_error_in_case_value_propagates ... ok
test scalar_fns::tests::switch_error_in_expression_propagates ... ok
test scalar_fns::tests::switch_nan_never_matches ... ok
test scalar_fns::tests::switch_no_match_no_default_is_na ... ok
test scalar_fns::tests::switch_positive_zero_matches_negative_zero ... ok
test scalar_fns::tests::switch_returns_first_matching_result ... ok
test scalar_fns::tests::switch_too_few_args_is_value_error ... ok
test scalar_fns::tests::switch_type_strict_number_vs_string_never_matches ... ok
test scalar_fns::tests::tan_at_quarter_pi_is_one ... ok
test scalar_fns::tests::tan_near_half_pi_is_huge_finite_not_error ... ok
test scalar_fns::tests::tanh_basic_and_saturation ... ok
test scalar_fns::tests::text_fns_propagate_errors ... ok
test scalar_fns::tests::trig_arity_errors ... ok
test scalar_fns::tests::trig_blank_coerces_to_zero ... ok
test scalar_fns::tests::trig_error_propagation ... ok
test scalar_fns::tests::trig_non_finite_input_is_num_error_at_coercion ... ok
test scalar_fns::tests::trig_text_arg_is_value_error ... ok
test scalar_fns::tests::trim_collapses_internal_space_runs ... ok
test scalar_fns::tests::trunc_with_and_without_digits ... ok
test scalar_fns::tests::type_of_codes ... ok
test scalar_fns::tests::unichar_basic ... ok
test scalar_fns::tests::unichar_surrogate_is_na ... ok
test scalar_fns::tests::unichar_zero_is_value_error ... ok
test scalar_fns::tests::unicode_basic ... ok
test scalar_fns::tests::upper_lower_basic ... ok
test scalar_fns::tests::value_basic_enus ... ok
test scalar_fns::tests::value_blank_is_zero ... ok
test scalar_fns::tests::value_empty_string_is_value_error ... ok
test scalar_fns::tests::value_locale_aware_decimal_de ... ok
test scalar_fns::tests::value_locale_aware_decimal_fr ... ok
test scalar_fns::tests::value_non_numeric_text_is_value_error ... ok
test scalar_fns::tests::value_number_passes_through ... ok
test scalar_fns::tests::var_p_simple ... ok
test scalar_fns::tests::var_s_simple ... ok
test scalar_fns::tests::var_single_sample_div_zero ... ok
test scalar_fns::tests::w5_d_pm12_1_mod_overflow_sanitized_to_num_error ... ok
test scalar_fns::tests::w5_d_pm12_1_quotient_overflow_sanitized_to_num_error ... ok
test scalar_fns::tests::xor_all_blanks_is_value_error ... ok
test scalar_fns::tests::xor_empty_args_is_value_error ... ok
test scalar_fns::tests::xor_one_true_is_true ... ok
test scalar_fns::tests::xor_propagates_errors ... ok
test scalar_fns::tests::xor_skips_blanks_and_coerces_numeric ... ok
test scalar_fns::tests::xor_three_trues_is_true ... ok
test scalar_fns::tests::xor_two_trues_is_false ... ok
test scalar_fns::tests::xor_zero_trues_is_false ... ok
test volatile::tests::arity_error_for_now_with_args ... ok
test volatile::tests::now_changes_after_clock_advance ... ok
test volatile::tests::now_ctx_arity_error ... ok
test volatile::tests::now_ctx_test_override_via_thread_local_takes_precedence ... ok
test volatile::tests::now_ctx_unix_epoch_in_excel1900_is_25569 ... ok
test volatile::tests::now_ctx_unix_epoch_in_excel1904_is_24107 ... ok
test volatile::tests::now_ctx_with_utc_offset_shifts_local_time ... ok
test volatile::tests::now_is_deterministic_with_test_override ... ok
test volatile::tests::rand_is_deterministic_with_seeded_rng ... ok
test volatile::tests::rand_returns_value_in_unit_interval ... ok
test volatile::tests::randbetween_inclusive_bounds ... ok
test volatile::tests::randbetween_low_above_high_is_num_error ... ok
test volatile::tests::randbetween_wrong_arity_is_value_error ... ok
test volatile::tests::today_ctx_unix_epoch_in_excel1900_is_25569 ... ok
test volatile::tests::today_ctx_with_utc_offset_can_shift_day ... ok
test volatile::tests::today_is_deterministic_with_test_override ... ok
test welford::tests::empty_input ... ok
test welford::tests::a6_acceptance_literal_numacc3_certified_moments ... ok
test welford::tests::linear_sequence_analytic_match ... ok
test welford::tests::a6_acceptance_shape_lock_offset_with_small_variance ... ok
test welford::tests::naive_vs_welford_large_offset ... ok
test welford::tests::single_sample_no_variance ... ok
test welford::tests::two_samples_known_variance ... ok
test welford::tests::uniform_zero_variance ... ok
test wildcard::tests::case_insensitive_matching ... ok
test welford::tests::welford_at_numacc4_extreme_scale_degrades_predictably ... ok
test wildcard::tests::consecutive_stars_collapse ... ok
test wildcard::tests::empty_pattern_matches_only_empty ... ok
test wildcard::tests::escaped_question_is_literal ... ok
test wildcard::tests::escaped_star_is_literal ... ok
test wildcard::tests::escaped_tilde_is_literal ... ok
test wildcard::tests::has_wildcards_detects_unescaped ... ok
test wildcard::tests::has_wildcards_ignores_escaped ... ok
test wildcard::tests::just_star_matches_anything ... ok
test wildcard::tests::multi_star_with_partial_literal ... ok
test wildcard::tests::no_wildcards_acts_as_exact_match ... ok
test wildcard::tests::pathological_star_pattern_completes_quickly ... ok
test wildcard::tests::question_matches_exactly_one ... ok
test wildcard::tests::search_in_finds_substring ... ok
test wildcard::tests::search_in_no_match_returns_none ... ok
test wildcard::tests::search_in_question_pattern ... ok
test wildcard::tests::search_in_respects_start_index ... ok
test wildcard::tests::star_in_middle ... ok
test wildcard::tests::star_matches_zero_or_more ... ok
test wildcard::tests::star_then_question ... ok
test wildcard::tests::trailing_star_after_match ... ok

test result: ok. 1807 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s

     Running tests/coverage.rs (target/debug/deps/coverage-7e6314102ed62dcb)

running 3 tests
test coverage_lists_are_disjoint ... ok
test no_stale_coverage_entries_for_unregistered_functions ... ok
test every_registered_function_has_a_coverage_decision ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/per_function_overrides.rs (target/debug/deps/per_function_overrides-18c25d0ba30805d9)

running 36 tests
test choose_index_greater_than_args_is_value_canon ... ok
test counta_counts_errors_canon ... ok
test count_skips_errors_canon ... ok
test hlookup_exact_match_returns_lower_row_canon ... ok
test isblank_introspects_never_propagates_canon ... ok
test average_empty_args_is_div_zero_canon ... ok
test choose_range_arg_returns_value_v1_divergence ... ok
test hlookup_row_index_less_than_one_is_value_canon ... ok
test choose_basic_picks_indexed_arg_canon ... ok
test count_direct_bool_and_numeric_text_v1_divergence ... ok
test choose_index_less_than_one_is_value_canon ... ok
test hlookup_not_found_is_na_canon ... ok
test average_all_blank_args_is_div_zero_canon ... ok
test hlookup_row_index_greater_than_rows_is_ref_canon ... ok
test count_skips_text_and_bools_v1_divergence ... ok
test counta_skips_only_blanks_canon ... ok
test iserr_true_for_all_errors_except_na_canon ... ok
test iserror_true_for_any_error_canon ... ok
test islogical_introspects_never_propagates_canon ... ok
test isnumber_introspects_never_propagates_canon ... ok
test isna_true_only_for_na_canon ... ok
test roundup_binary_float_divergence_v1_divergence ... ok
test istext_introspects_never_propagates_canon ... ok
test large_k_too_large_is_num_canon ... ok
test large_text_in_range_v1_divergence_value_error ... ok
test vlookup_col_index_less_than_one_is_value_canon ... ok
test vlookup_not_found_is_na_canon ... ok
test small_k_less_than_one_is_num_canon ... ok
test match_not_found_is_na_canon ... ok
test vlookup_col_index_greater_than_cols_is_ref_canon ... ok
test median_empty_range_is_num_canon ... ok
test mode_no_repeat_is_na_canon ... ok
test median_text_in_range_v1_divergence_value_error ... ok
test rank_avg_value_not_in_ref_is_na_canon ... ok
test rounddown_binary_float_well_behaved_for_clean_values ... ok
test rank_value_not_in_ref_is_na_canon ... ok

test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/lib.rs (target/debug/deps/ql_io-2b68bb7b6558b1dd)

running 101 tests
test qbook_format::tests::date_system_wire_round_trip ... ok
test qbook_format::tests::atomic_save_leaves_no_temp_or_backup_after_success ... ok
test qbook_format::tests::custom_format_round_trips_through_save_load ... ok
test qbook_format::tests::blank_cells_are_skipped_in_jsonl ... ok
test oplog_persistence::tests::load_with_oplog_when_oplog_missing_returns_missing_file_error ... ok
test qbook_format::tests::col_over_max_col_errors_not_panics ... ok
test qbook_format::tests::empty_format_table_round_trips_without_persisting_builtins ... ok
test qbook_format::tests::date_system_excel1904_round_trips ... ok
test qbook_format::tests::date_system_excel1900_round_trips ... ok
test oplog_persistence::tests::save_then_load_round_trip_preserves_workbook_and_oplog ... ok
test qbook_format::tests::chunk_rows_envelope_reflects_actual_sheet_value ... ok
test oplog_persistence::tests::load_with_oplog_when_oplog_bin_is_corrupted_returns_oplog_error ... ok
test oplog_persistence::tests::load_workbook_without_oplog_ignores_present_oplog_bin ... ok
test oplog_persistence::tests::empty_oplog_round_trips ... ok
test qbook_format::tests::envelope_contains_expected_metadata ... ok
test oplog_persistence::tests::save_workbook_without_oplog_drops_existing_oplog_bin ... ok
test qbook_format::tests::full_format_round_trip_custom_id_plus_overlay ... ok
test qbook_format::tests::load_normalizes_mixed_case_table_name ... ok
test qbook_format::tests::load_refuses_when_multiple_orphans_and_target_missing ... ok
test qbook_format::tests::formula_only_cell_round_trips_as_pending ... ok
test qbook_format::tests::load_recovers_orphan_backup_when_target_missing_rollback ... ok
test qbook_format::tests::future_schema_version_rejected ... ok
test qbook_format::tests::load_accepts_two_non_overlapping_tables ... ok
test qbook_format::tests::load_rejects_scoped_name_referencing_unknown_sheet ... ok
test qbook_format::tests::load_rejects_envelope_with_reserved_char_sheet_name ... ok
test qbook_format::tests::malformed_format_id_collision_surfaces_as_error ... ok
test qbook_format::tests::load_rejects_envelope_with_duplicate_canonical_sheet_names ... ok
test qbook_format::tests::load_does_not_touch_user_created_sibling_lacking_marker ... ok
test qbook_format::tests::load_recovers_orphan_backup_when_target_valid_roll_forward ... ok
test qbook_format::tests::load_cleans_all_orphans_when_target_valid_post_2a13 ... ok
test qbook_format::tests::load_rejects_unknown_envelope_field ... ok
test qbook_format::tests::malformed_table_columns_length_mismatch_rejected ... ok
test qbook_format::tests::malformed_table_rejected_when_column_name_empty ... ok
test qbook_format::tests::malformed_table_rejected_when_duplicate_canonical_name ... ok
test qbook_format::tests::malformed_format_overlay_out_of_range_surfaces_as_error ... ok
test qbook_format::tests::malformed_table_rejected_when_column_id_is_u32_max ... ok
test qbook_format::tests::malformed_jsonl_errors ... ok
test qbook_format::tests::nan_inf_become_num_error_via_value_constructor ... ok
test qbook_format::tests::malformed_table_rejected_when_mixed_case_duplicate_canonical_name ... ok
test qbook_format::tests::malformed_table_rejected_when_footprint_past_max_row ... ok
test qbook_format::tests::malformed_format_overlay_unregistered_id_surfaces_as_error ... ok
test qbook_format::tests::failed_save_does_not_clobber_target ... ok
test qbook_format::tests::malformed_table_rejected_when_duplicate_column_name ... ok
test qbook_format::tests::nonexistent_path_errors ... ok
test qbook_format::tests::malformed_table_rejected_when_footprint_past_max_column ... ok
test qbook_format::tests::malformed_table_rejected_when_name_collides_with_defined_name ... ok
test qbook_format::tests::malformed_table_zero_dims_rejected ... ok
test qbook_format::tests::missing_workbook_toml_errors ... ok
test qbook_format::tests::malformed_table_unknown_sheet_rejected ... ok
test qbook_format::tests::roundtrip_empty_workbook_one_sheet ... ok
test qbook_format::tests::old_schema_v1_files_without_formula_field_load_as_literal_only ... ok
test qbook_format::tests::roundtrip_formula_only_cell_outside_bounds ... ok
test qbook_format::tests::missing_sheet_jsonl_errors ... ok
test qbook_format::tests::non_sequential_sheet_ids_errors_not_panics ... ok
test qbook_format::tests::per_sheet_format_overlay_round_trips ... ok
test qbook_format::tests::name_table_round_trip_through_save_load ... ok
test qbook_format::tests::roundtrip_formula_with_value ... ok
test qbook_format::tests::malformed_table_rejected_when_footprints_overlap ... ok
test qbook_format::tests::roundtrip_preserves_text_with_special_chars ... ok
test qbook_format::tests::save_session_suffix_is_distinct_per_call ... ok
test qbook_format::tests::save_with_neg_inf_value_errors_cleanly ... ok
test qbook_format::tests::roundtrip_multi_sheet ... ok
test qbook_format::tests::save_refuses_when_target_is_a_regular_file ... ok
test qbook_format::tests::roundtrip_with_multiple_tables_preserves_each ... ok
test qbook_format::tests::schema_version_constant_is_seven ... ok
test qbook_format::tests::save_with_nan_value_errors_cleanly ... ok
test qbook_format::tests::save_with_inf_value_errors_cleanly ... ok
test qbook_format::tests::roundtrip_with_all_value_variants ... ok
test qbook_format::tests::roundtrip_with_number_cells ... ok
test qbook_format::tests::roundtrip_with_totals_function_preserves_each_variant ... ok
test qbook_format::tests::unsupported_schema_version_errors ... ok
test qbook_format::tests::roundtrip_with_single_table_preserves_metadata ... ok
test qbook_format::tests::row_over_max_row_errors_not_panics ... ok
test qbook_format::tests::spill_target_cells_skipped_on_save ... ok
test qbook_format::tests::two_phase_load_rejects_out_of_range_via_probe ... ok
test qbook_format::tests::sheet_scoped_name_round_trips_through_save_load ... ok
test qbook_format::tests::roundtrip_no_tables_omits_section_from_toml ... ok
test qbook_format::tests::spill_targets_load_as_blank_pending_recompute ... ok
test qbook_format::tests::v4_envelope_missing_scope_loads_into_workbook_scope ... ok
test qbook_format::tests::save_workbook_extending_writes_sidecar_into_target ... ok
test qbook_format::tests::v1_envelope_loads_on_v2_reader_with_legacy_pending_rewrite ... ok
test qbook_format::tests::wire_value_blank_is_none ... ok
test qbook_format::tests::wire_value_error_canonical_text ... ok
test qbook_format::tests::wire_value_error_roundtrip_all_variants ... ok
test qbook_format::tests::wire_value_unknown_error_text_errors ... ok
test oplog_persistence::tests::save_with_oplog_overwrites_existing_oplog_bin ... ok
test qbook_format::tests::v5_envelope_loads_into_v6_with_empty_tables ... ok
test qbook_format::tests::v3_envelope_missing_formats_loads_with_defaults ... ok
test qbook_format::tests::v6_file_with_locale_rejected_as_forward_compat ... ok
test qbook_format::tests::v6_file_with_reference_mode_rejected_as_forward_compat ... ok
test qbook_format::tests::v2_envelope_missing_date_system_loads_as_excel1900 ... ok
test qbook_format::tests::roundtrip_multiple_formulas_across_sheets ... ok
test qbook_format::tests::crash_window_at_every_step_recovers_a_valid_workbook ... ok
test qbook_format::tests::save_workbook_extending_closure_failure_cleans_temp_and_preserves_target ... ok
test qbook_format::tests::v7_de_locale_round_trips ... ok
test qbook_format::tests::v7_unknown_locale_string_rejected_with_captured_value ... ok
test qbook_format::tests::v7_default_workbook_omits_reference_mode_and_locale ... ok
test qbook_format::tests::v6_file_without_v7_fields_loads_with_defaults ... ok
test qbook_format::tests::v7_r1c1_workbook_round_trips_reference_mode ... ok
test qbook_format::tests::v7_fr_locale_round_trips ... ok
test qbook_format::tests::workbook_only_names_round_trip_serializes_without_scope_field ... ok

test result: ok. 101 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.28s

     Running tests/p412_qbook_corruption_probes.rs (target/debug/deps/p412_qbook_corruption_probes-66a1959002a6efcc)

running 12 tests
test entire_qbook_directory_corrupted ... ignored
test envelope_giant_schema_version ... ignored
test envelope_missing_required_field ... ignored
test envelope_negative_schema_version ... ignored
test envelope_random_bytes ... ignored
test envelope_truncated ... ignored
test not_a_directory_at_all ... ignored
test sheet_jsonl_giant_one_line ... ignored
test sheet_jsonl_out_of_range_coords ... ignored
test sheet_jsonl_random_bytes ... ignored
test sheet_jsonl_truncated_midline ... ignored
test sheets_directory_missing ... ignored

test result: ok. 0 passed; 0 failed; 12 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_io_ods-cf52be05b2b98985)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_io_xlsx-665d45a08c929589)

running 60 tests
test read::cell_styles_xml::tests::parses_a1_cell_rejects_malformed ... ok
test read::cell_styles_xml::tests::parses_a1_cell_basic ... ok
test read::calamine_grid::tests::data_to_value_maps_each_variant ... ok
test read::cell_styles_xml::tests::empty_sheet_returns_empty_vec ... ok
test read::names_import::tests::parse_boolean_constants ... ok
test read::cell_styles_xml::tests::extracts_styled_cells ... ok
test read::cell_styles_xml::tests::skips_unparseable_cell_refs_gracefully ... ok
test read::names_import::tests::parse_numeric_constant ... ok
test read::names_import::tests::parse_quoted_string_constant ... ok
test read::names_import::tests::parse_unknown_sheet_returns_none ... ok
test read::names_import::tests::parse_cell_target ... ok
test read::names_import::tests::parse_quoted_sheet_target ... ok
test read::names_import::tests::parse_range_target ... ok
test read::names_import::tests::parse_escaped_single_quote_in_sheet_name ... ok
test read::rels::tests::empty_relationships_returns_empty ... ok
test read::rels::tests::parse_relationship_basic ... ok
test read::feature_inventory::tests::comments_part_detected ... ok
test read::feature_inventory::tests::drawings_and_media_detected_separately ... ok
test read::feature_inventory::tests::clean_workbook_has_empty_inventory ... ok
test read::feature_inventory::tests::vba_macros_detected ... ok
test read::feature_inventory::tests::conditional_formatting_in_sheet_detected ... ok
test read::feature_inventory::tests::data_validation_and_merged_cells_detected ... ok
test read::rels::tests::resolve_target_resolves_dotdot_paths ... ok
test read::sheet_parts::tests::derive_basic ... ok
test read::sheet_parts::tests::derive_no_dir ... ok
test read::styles_import::tests::register_custom_registers_id_164_and_above ... ok
test read::styles_import::tests::re_registering_same_id_with_same_string_is_idempotent ... ok
test read::styles_import::tests::libreoffice_general_at_custom_id_is_idempotent ... ok
test read::styles_import::tests::register_custom_skips_builtins_below_164 ... ok
test read::styles_import::tests::collision_with_existing_format_id_is_malformed_error ... ok
test read::styles_xml::tests::missing_styles_xml_returns_empty_index ... ok
test read::styles_xml::tests::numfmt_without_format_code_is_skipped ... ok
test read::styles_xml::tests::parse_cell_xfs_only_not_cell_style_xfs ... ok
test read::styles_xml::tests::parse_custom_numfmts ... ok
test read::tables_import::tests::import_tables_handles_sheet_with_no_rels ... ok
test read::tables_import::tests::import_tables_skips_non_table_relationships ... ok
test read::tables_xml::tests::parse_a1_cell_invalid_rejected ... ok
test read::tables_xml::tests::parse_a1_cell_basic ... ok
test read::tables_xml::tests::parse_a1_ref_inverted_rejected ... ok
test read::tables_import::tests::import_tables_registers_one_table ... ok
test read::tables_xml::tests::parse_a1_ref_rectangular ... ok
test read::tables_xml::tests::parse_a1_ref_single_cell ... ok
test read::tables_xml::tests::parse_table_xml_default_headerrowcount_is_one ... ok
test read::tables_import::tests::import_tables_two_sheets_two_tables ... ok
test read::tables_xml::tests::parse_table_xml_missing_name_is_malformed ... ok
test read::tables_xml::tests::parse_table_xml_full_shape ... ok
test read::tables_xml::tests::parsed_table_to_metadata_canonicalizes_name ... ok
test read::workbook_xml::tests::missing_workbook_xml_is_malformed_error ... ok
test read::workbook_xml::tests::parse_date1904_attribute_sets_1904_system ... ok
test read::workbook_xml::tests::parse_date1904_true_also_recognized ... ok
test read::workbook_xml::tests::parse_default_date_system_is_1900 ... ok
test tests::feature_inventory_record_and_is_clean ... ok
test read::workbook_xml::tests::parse_sheet_state_attribute ... ok
test read::workbook_xml::tests::parse_scoped_defined_names ... ok
test tests::unsupported_feature_kind_is_hashable ... ok
test tests::import_invalid_bytes_returns_zip_error ... ok
test tests::import_nonexistent_file_returns_io_error ... ok
test tests::export_update_original_empty_preservation_falls_through_to_shadow ... ok
test write::umya_export::tests::export_empty_workbook_writes_valid_xlsx ... ok
test write::umya_export::tests::export_workbook_with_values_round_trips_via_calamine ... ok

test result: ok. 60 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/calamine_smoke.rs (target/debug/deps/calamine_smoke-3f7dccc373b7b520)

running 40 tests
test import_ironcalc_basic_text_inventory_is_clean ... ok
test import_ironcalc_basic_text_records_date_system ... ok
test import_ironcalc_basic_text_with_preservation_carries_bytes ... ok
test w5_d_14_1_libreoffice_general_at_custom_id_does_not_error ... ok
test w5_d_14_2_round_trip_preserves_custom_format_codes ... ok
test w5_d_14_2_2_strict_update_original_does_not_overwrite_output_on_drop ... ok
test w5_d_14_2_2_permissive_update_original_populates_dropped_features ... ok
test import_ironcalc_basic_text_fixture_succeeds ... ok
test w5_d_14_1_round_trip_preserves_formula_with_cached_value ... ok
test w5_d_14_1_round_trip_preserves_error_values ... ok
test w5_d_14_1_round_trip_preserves_date1904 ... ok
test w5_d_14_2_round_trip_preserves_sheet_scoped_name ... ok
test w5_d_14_2_round_trip_preserves_table ... ok
test w5_d_15_1_libreoffice_apply_number_format_default_true ... ok
test round_trip_ironcalc_basic_text_preserves_sheet_count ... ok
test w5_d_14_2_round_trip_preserves_workbook_scoped_name_cell ... ok
test w5_d_pm_2_numfmt_id_overflow_rejected ... ok
test w5_d_14_2_3_update_original_preserves_original_theme_bytes ... ok
test w5_d_15_2_blank_cell_with_format_overlay_round_trips ... ok
test w5_d_15_2_formula_with_blank_cache_format_overlay_round_trips ... ok
test w5_d_pm_2_sheet_name_with_control_char_rejected ... ok
test w5_d_pm_2_path_traversal_rels_rejected ... ok
test w5_d_pm_2_oob_cell_ref_skipped_silently ... ok
test w5_d_pm_3_unknown_r_id_surfaces_visibly ... ok
test w5_d_pm_3_hidden_sheet_records_inventory_entry ... ok
test w5_d_14_2_round_trip_preserves_workbook_scoped_name_range ... ok
test w5_d_15_round_trip_dedup_shared_format_id ... ok
test w5_d_pm_3_zero_sheet_workbook_rejected ... ok
test w5_d_15_1_empty_sheet_before_styled_sheet_preserves_alignment ... ok
test w5_d_15_round_trip_per_cell_builtin_format_application ... ok
test w5_d_pm_3_new_workbook_strict_errors_on_constant_error_name ... ok
test w5_d_15_round_trip_per_cell_custom_format_application ... ok
test w5_d_14_2_update_original_round_trip_preserves_opaque_theme ... ok
test w5_d_15_2_cross_sheet_roster_byte_deterministic ... ok
test w5_d_pm_1_blank_overlay_below_existing_row_keeps_sorted ... ok
test w5_d_pm_3_update_original_strict_catches_inline_cf ... ok
test w5_d_pm_1_formula_with_boolean_cache_round_trips_as_boolean ... ok
test w5_d_pm_1_formula_with_error_cache_round_trips_as_error ... ok
test import_ironcalc_example_fixture_with_recompute_doesnt_panic ... ok
test w5_d_14_2_update_original_round_trip_preserves_cell_edits ... ok

test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s

     Running tests/opus_a_cache_policy.rs (target/debug/deps/opus_a_cache_policy-340af14c4dee399a)

running 2 tests
test recompute_strict_on_unknown_function ... ignored
test skip_cache_round_trip_behavior ... ignored

test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_deep_probe.rs (target/debug/deps/opus_a_deep_probe-d8e50ef3f750e602)

running 10 tests
test deep_cell_value_round_trip ... ignored
test deep_format_codes_round_trip ... ignored
test deep_formula_text_round_trip ... ignored
test deep_name_round_trip ... ignored
test deep_overlay_round_trip ... ignored
test deep_strict_new_workbook ... ignored
test deep_strict_with_vba ... ignored
test deep_synthetic_cross_feature ... ignored
test deep_tables_round_trip ... ignored
test deep_update_original_strict_policy ... ignored

test result: ok. 0 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_dup_fmt.rs (target/debug/deps/opus_a_dup_fmt-128f34c8a6ffc2b3)

running 2 tests
test libreoffice_general_at_custom_id_round_trip ... ignored
test two_custom_ids_with_same_format_code ... ignored

test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_edge_cases.rs (target/debug/deps/opus_a_edge_cases-030d3e1d13c60662)

running 9 tests
test custom_format_byte_for_byte_preservation_with_special_chars ... ignored
test dropped_features_vs_feature_inventory_completeness ... ignored
test import_strict_with_drawings ... ignored
test name_case_round_trip ... ignored
test name_numeric_constant_precision ... ignored
test overlay_on_text_and_error_and_shared_string ... ignored
test sheet_scoped_name_with_orphan_target ... ignored
test table_column_id_renumbering ... ignored
test unicode_survival ... ignored

test result: ok. 0 passed; 0 failed; 9 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_error_cell_probe.rs (target/debug/deps/opus_a_error_cell_probe-0883561acf301cf8)

running 1 test
test investigate_error_cells_with_and_without_formula ... ignored

test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_format_no_overlay.rs (target/debug/deps/opus_a_format_no_overlay-673d1e773333adb9)

running 3 tests
test empty_workbook_round_trip ... ignored
test format_registered_but_not_used_anywhere_round_trips ... ignored
test overlay_on_unpopulated_builtin ... ignored

test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_misc.rs (target/debug/deps/opus_a_misc-b1d986ca03c48955)

running 3 tests
test new_workbook_with_invalid_name_target_constant_error ... ignored
test sheet_with_only_blank_overlay_cells_followed_by_normal_sheet ... ignored
test strict_update_original_does_not_leave_partial_output ... ignored

test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_phase_4_12_ide_proof.rs (target/debug/deps/opus_a_phase_4_12_ide_proof-36287debc62dc5a3)

running 16 tests
test p10_sweep_calc_tests_recompute_failure_rate ... ignored
test p11_even_overflow_panic ... ignored
test p12_prefix_comma_failure_shapes ... ignored
test p13_full_ide_proof_point_xlsx_qbook_xlsx ... ignored
test p14_qbook_persistence_with_full_phase4_features ... ignored
test p15_edit_imported_literal_range_formula ... ignored
test p16_failed_formula_cached_value_preserved_or_corrupted ... ignored
test p1_import_recompute_formulas_bind_success_rate ... ignored
test p2_import_then_edit_formula ... ignored
test p3_roundtrip_with_literal_range_sum ... ignored
test p4_roundtrip_multi_feature_workbook ... ignored
test p5_double_roundtrip_stability ... ignored
test p6_locale_survives_xlsx_roundtrip ... ignored
test p7_date1904_survives_roundtrip ... ignored
test p8_export_writes_recomputed_cached_values ... ignored
test p9_table_roundtrip_then_structured_ref ... ignored

test result: ok. 0 passed; 0 failed; 16 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/opus_a_text_edge.rs (target/debug/deps/opus_a_text_edge-5801dc184e1d2468)

running 3 tests
test date1900_survives ... ignored
test text_with_whitespace_xml_chars_newlines ... ignored
test very_long_text ... ignored

test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/phase_4_11_corpus_probe.rs (target/debug/deps/phase_4_11_corpus_probe-14d3b8656d6bf480)

running 1 test
test phase_4_11_corpus_round_trip_report ... ignored

test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_oplog-60398aa280b2579d)

running 44 tests
test log::tests::set_peer_id_changes_doc_peer_id ... ok
test log::tests::new_log_is_empty ... ok
test log::tests::import_garbage_bytes_returns_loro_error ... ok
test log::tests::append_single_op_round_trips ... ok
test replay::tests::replay_add_sheet_grows_workbook ... ok
test replay::tests::replay_add_sheet_auto_rename_walks_suffix_until_free ... ok
test replay::tests::replay_add_sheet_auto_rename_skips_already_taken_suffix ... ok
test replay::tests::replay_clear_formula_idempotent ... ok
test replay::tests::replay_invalid_cell_row_above_max_returns_indexed_error ... ok
test replay::tests::replay_empty_log_succeeds ... ok
test replay::tests::replay_put_formula_persists_text_only ... ok
test log::tests::append_each_variant_round_trips ... ok
test replay::tests::replay_add_sheet_reserved_char_rejected ... ok
test log::tests::set_peer_id_after_import_works ... ok
test log::tests::import_empty_snapshot_yields_empty_log ... ok
test replay::tests::replay_add_sheet_canonical_duplicate_auto_renames ... ok
test replay::tests::replay_register_and_set_cell_format_built_in_id_14 ... ok
test replay::tests::replay_register_format_idempotent_for_existing_builtin ... ok
test log::tests::binary_export_import_preserves_order ... ok
test replay::tests::replay_register_format_installs_custom_id ... ok
test replay::tests::replay_batch_commit_applies_inner_ops_in_order ... ok
test replay::tests::replay_invalid_sheet_returns_indexed_error ... ok
test replay::tests::replay_rename_inside_batchcommit ... ok
test replay::tests::replay_put_value_lands_in_workbook ... ok
test replay::tests::replay_register_format_id_collision_errors ... ok
test replay::tests::replay_rename_sheet_invalid_id_errors ... ok
test replay::tests::replay_rename_sheet_duplicate_target_errors ... ok
test replay::tests::replay_rename_sheet_name_mismatch_errors ... ok
test replay::tests::replay_rename_sheet_basic ... ok
test replay::tests::replay_set_cell_format_invalid_sheet_errors ... ok
test replay::tests::replay_set_locale_applies_to_workbook ... ok
test replay::tests::replay_rename_sheet_already_renamed_is_noop ... ok
test replay::tests::replay_set_cell_format_with_none_clears_overlay ... ok
test replay::tests::replay_set_name_registers_target ... ok
test replay::tests::replay_set_cell_format_unregistered_id_errors ... ok
test replay::tests::replay_reserved_name_returns_name_rejected ... ok
test replay::tests::replay_set_cell_format_binds_overlay ... ok
test replay::tests::replay_set_locale_unknown_value_errors_loudly ... ok
test replay::tests::replay_set_name_scope_none_lands_on_workbook ... ok
test replay::tests::replay_set_name_scope_reserved_name_rejected ... ok
test replay::tests::replay_set_name_sheet_scoped_lands_on_sheet ... ok
test replay::tests::replay_set_name_scope_unknown_sheet_errors ... ok
test replay::tests::replay_set_reference_mode_applies_to_workbook ... ok
test replay::tests::replay_set_reference_mode_unknown_value_errors_loudly ... ok

test result: ok. 44 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-4a1df24b37102cf6)

running 10 tests
test import_byte_flipped_snapshot ... ignored
test import_giant_zero_buffer ... ignored
test import_random_bytes ... ignored
test import_truncated_snapshot ... ignored
test import_zero_length ... ignored
test replay_deeply_nested_batch_commit ... ignored
test replay_giant_batch_commit_flat ... ignored
test replay_op_referring_to_nonexistent_sheet ... ignored
test replay_op_with_extreme_coords ... ignored
test replay_set_cell_format_without_register ... ignored

test result: ok. 0 passed; 0 failed; 10 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-73e390f4dc4755d2)

running 3 tests
test batch_commit_replay_equivalent_to_flat_replay ... ok
test producer_and_replay_produce_observationally_equivalent_workbooks ... ok
test binary_export_then_replay_equivalent_to_in_memory_replay ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

     Running unittests src/lib.rs (target/debug/deps/ql_profile-78c7394dd9650d98)

running 15 tests
test graph_profile::tests::schema_version_locked ... ok
test graph_profile::tests::dirty_section_populated_when_set_provided ... ok
test graph_profile::tests::empty_graph_profile_zero_everything ... ok
test graph_profile::tests::sample_graph_profile_stats ... ok
test timings::tests::bind_plan_cache_hit_rate_independent_of_fingerprint_cache ... ok
test graph_profile::tests::sample_graph_profile_node_counts ... ok
test graph_profile::tests::timings_section_present_when_supplied ... ok
test timings::tests::cache_hit_rate_computes_correctly ... ok
test graph_profile::tests::timings_section_in_json_output ... ok
test timings::tests::default_timings_zero ... ok
test graph_profile::tests::export_graph_profile_yields_valid_json ... ok
test graph_profile::tests::timings_section_skipped_when_none ... ok
test graph_profile::tests::pretty_printed_json_is_structurally_consistent ... ok
test timings::tests::record_dispatches ... ok
test timings::tests::record_node_eval_accumulates ... ok

test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_service-4c2c946c9437d6d4)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_sql-cd6ab19212f67010)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_storage-979f9709b378176c)

running 179 tests
test column::tests::new_is_empty ... ok
test column::tests::from_chunks_initializes_overlays ... ok
test column::tests::append_chunk_grows_correctly ... ok
test column::tests::put_into_empty_column_autogrows_chunks ... ok
test column::tests::clear_computed_drops_only_computed_lane ... ok
test column::tests::iter_chunks_walks_all_chunks_with_overlays ... ok
test column::tests::locate_at_chunk_boundary ... ok
test column::tests::overlay_supports_heterogeneous_value ... ok
test column::tests::put_computed_clears_user_at_same_row ... ok
test column::tests::overlay_takes_precedence_over_base ... ok
test column::tests::put_user_clears_computed_at_same_row ... ok
test column::tests::read_base_nan_returns_num_error ... ok
test column::tests::read_cascade_user_then_computed_then_base ... ok
test column::tests::read_crosses_chunks ... ok
test column::tests::put_panics_on_row_beyond_max_excel - should panic ... ok
test column::tests::from_chunks_panics_on_oversized_chunk - should panic ... ok
test column::tests::from_chunks_panics_on_undersized_non_last_chunk - should panic ... ok
test column::tests::from_chunks_panics_on_non_float64 - should panic ... ok
test column::tests::read_first_chunk_base ... ok
test column::tests::read_short_last_chunk_tail_is_blank ... ok
test column::tests::replace_chunk_clears_both_overlays ... ok
test column::tests::replace_chunk_swaps_base_clears_overlay ... ok
test column::tests::replace_chunk_panics_on_non_float64 - should panic ... ok
test column::tests::replace_chunk_panics_on_length_mismatch - should panic ... ok
test column::tests::resolve_chunk_rows_empty_panics - should panic ... ok
test column::tests::resolve_chunk_rows_non_numeric_panics - should panic ... ok
test column::tests::resolve_chunk_rows_valid_value ... ok
test column::tests::resolve_chunk_rows_unset_returns_default ... ok
test column::tests::resolve_chunk_rows_zero_panics - should panic ... ok
test format::tests::general_is_id_zero ... ok
test format::tests::first_custom_id_is_past_builtins ... ok
test format::tests::intern_does_not_advance_for_repeats ... ok
test format::tests::default_pre_populates_builtins ... ok
test format::tests::intern_new_allocates_custom_id ... ok
test format::tests::intern_existing_returns_same_id ... ok
test format::tests::intern_two_distinct_strings_get_sequential_ids ... ok
test format::tests::iter_returns_all_entries ... ok
test format::tests::next_custom_id_advances_on_intern ... ok
test format::tests::register_at_replays_known_id ... ok
test format::tests::register_at_same_id_same_string_is_idempotent ... ok
test format_overlay::tests::clear_missing_returns_none ... ok
test format::tests::register_at_id_collision_errors ... ok
test format_overlay::tests::clear_all_wipes_overlay ... ok
test format::tests::register_at_string_collision_errors ... ok
test format::tests::unregistered_builtin_returns_none ... ok
test format_overlay::tests::distinct_addresses_isolated ... ok
test format_overlay::tests::clear_removes_entry ... ok
test format_overlay::tests::get_miss_returns_none ... ok
test format_overlay::tests::iter_returns_all_entries ... ok
test format_overlay::tests::count_refs_returns_match_count ... ok
test format_overlay::tests::default_is_empty ... ok
test format_overlay::tests::set_overwrites_and_returns_prior ... ok
test format_overlay::tests::set_then_get ... ok
test overlay::tests::clear_resets_to_empty ... ok
test overlay::tests::default_is_empty ... ok
test overlay::tests::get_miss_returns_none ... ok
test overlay::tests::heterogeneous_values_allowed ... ok
test overlay::tests::iter_returns_ascending_rows ... ok
test overlay::tests::put_then_get ... ok
test overlay::tests::put_overwrites_returns_prior ... ok
test overlay::tests::remove_clears_entry ... ok
test overlay::tests::remove_missing_returns_none ... ok
test sheet::tests::append_column_updates_bounds ... ok
test sheet::tests::clear_scoped_name_removes_binding ... ok
test sheet::tests::bounds_never_shrinks ... ok
test sheet::tests::empty_sheet_reads_blank_everywhere ... ok
test sheet::tests::put_grows_columns_and_bounds ... ok
test sheet::tests::heterogeneous_writes_per_column ... ok
test sheet::tests::scoped_names_empty_by_default ... ok
test sheet::tests::scoped_names_independent_across_sheets ... ok
test sheet::tests::set_scoped_name_registers_canonicalized ... ok
test sheet::tests::set_scoped_name_reserved_name_rejected ... ok
test spill::tests::empty_table_lookups_return_none ... ok
test spill::tests::iter_anchors_yields_all_registered ... ok
test spill::tests::register_1x1_spill ... ok
test spill::tests::register_2x3_spill_populates_all_cells ... ok
test spill::tests::register_5x1_spill_populates_targets ... ok
test spill::tests::register_accepts_spill_ending_exactly_at_max_row ... ok
test spill::tests::register_rejects_anchor_already_exists ... ok
test spill::tests::register_rejects_degenerate_zero_rows ... ok
test spill::tests::register_rejects_degenerate_zero_cols ... ok
test spill::tests::register_rejects_spill_extending_past_max_column ... ok
test spill::tests::register_rejects_spill_extending_past_max_row ... ok
test spill::tests::register_rejects_target_collision_atomically ... ok
test spill::tests::register_rejects_u32_overflow_anchor_plus_shape ... ok
test spill::tests::register_unregister_register_works ... ok
test spill::tests::spill_shape_cell_count ... ok
test spill::tests::spills_on_different_sheets_are_independent ... ok
test spill::tests::two_disjoint_spills_coexist ... ok
test spill::tests::unregister_clears_anchor_and_all_targets ... ok
test spill::tests::unregister_unknown_anchor_errors ... ok
test tables::tests::all_range_covers_entire_footprint ... ok
test tables::tests::allocate_column_id_is_monotonic ... ok
test tables::tests::column_data_range_picks_one_column ... ok
test tables::tests::column_data_range_returns_none_for_out_of_range_idx ... ok
test tables::tests::contains_checks_full_footprint ... ok
test tables::tests::data_range_excludes_header_and_totals ... ok
test tables::tests::header_only_table_has_no_data_range ... ok
test tables::tests::header_range_matches_top_row ... ok
test tables::tests::insert_bumps_next_column_id_past_loaded_ids ... ok
test tables::tests::insert_empty_columns_does_not_change_next_column_id ... ok
test tables::tests::insert_preserves_high_water_across_multiple_inserts ... ok
test tables::tests::lookup_column_is_case_insensitive ... ok
test tables::tests::lookup_column_returns_none_for_missing ... ok
test tables::tests::table_at_finds_containing_table ... ok
test tables::tests::table_table_generation_bumps_on_mutation ... ok
test tables::tests::totals_range_matches_bottom_row ... ok
test tables::tests::table_table_insert_lookup_round_trip ... ok
test tables::tests::validate_footprint_bounds_accepts_in_range_footprint ... ok
test tables::tests::validate_footprint_bounds_rejects_past_max_column ... ok
test tables::tests::validate_footprint_bounds_rejects_past_max_row ... ok
test tables::tests::validate_footprint_bounds_rejects_u32_overflow_on_rows ... ok
test tables::tests::validate_footprint_bounds_rejects_u32_overflow_on_cols ... ok
test tests::end_to_end_minimum_workbook_read_write ... ok
test tests::sheet_format_overlay_set_and_clear_round_trip ... ok
test tests::sheet_format_overlay_starts_empty ... ok
test tests::workbook_default_has_format_table_with_builtins ... ok
test tests::workbook_intern_new_string_allocates_custom_id ... ok
test workbook::tests::canonical_sheet_name_uppercases_ascii ... ok
test tests::workbook_intern_returns_existing_builtin_id ... ok
test tests::workbook_independent_sheets_have_independent_overlays ... ok
test workbook::tests::canonical_sheet_name_passes_non_ascii_through ... ok
test workbook::tests::add_sheet_returns_zero_based_id ... ok
test workbook::tests::add_sheet_panics_on_duplicate - should panic ... ok
test workbook::tests::clear_formula_removes_entry ... ok
test workbook::tests::clear_nonexistent_formula_is_noop ... ok
test workbook::tests::empty_workbook_has_no_sheets ... ok
test workbook::tests::formula_cells_default_empty ... ok
test workbook::tests::iter_formulas_yields_all ... ok
test workbook::tests::heterogeneous_workbook_state ... ok
test workbook::tests::named_target_variants_distinct ... ok
test workbook::tests::put_and_get_formula ... ok
test workbook::tests::name_table_set_canonicalizes_key_on_insert ... ok
test workbook::tests::names_lookup_on_empty_table_returns_none ... ok
test workbook::tests::rename_sheet_duplicate_target_rejected ... ok
test workbook::tests::put_formula_at_max_row_max_col_ok ... ok
test workbook::tests::put_formula_above_max_row_panics - should panic ... ok
test workbook::tests::put_formula_replaces_existing ... ok
test workbook::tests::put_formula_above_max_col_panics - should panic ... ok
test workbook::tests::put_formula_to_missing_sheet_panics - should panic ... ok
test workbook::tests::rename_sheet_basic_swaps_name ... ok
test workbook::tests::put_to_missing_sheet_panics - should panic ... ok
test workbook::tests::formula_and_value_coexist_on_same_cell ... ok
test workbook::tests::rename_sheet_empty_rejected ... ok
test workbook::tests::rename_sheet_case_only_rename_allowed ... ok
test workbook::tests::rename_sheet_unknown_id_errors ... ok
test workbook::tests::set_name_accepts_non_reserved ... ok
test workbook::tests::set_name_rejects_reserved_ai_canonical_upper ... ok
test workbook::tests::set_name_rejects_reserved_ai_case_insensitive ... ok
test workbook::tests::sheet_id_by_name_returns_none_on_miss ... ok
test workbook::tests::sheet_id_by_name_finds_case_insensitive ... ok
test workbook::tests::sheet_id_by_name_first_match_in_id_order ... ok
test workbook::tests::sheets_are_isolated ... ok
test workbook::tests::validate_sheet_name_rejects_empty ... ok
test workbook::tests::try_add_sheet_rejects_canonical_duplicate ... ok
test workbook::tests::try_add_sheet_rejects_empty_name ... ok
test workbook::tests::try_add_sheet_rejects_reserved_char ... ok
test workbook::tests::validate_sheet_name_accepts_valid_names ... ok
test workbook::tests::validate_sheet_name_rejects_canonical_duplicate ... ok
test workbook::tests::validate_sheet_name_reserved_chars_anywhere_in_name_rejected ... ok
test workbook::tests::validate_sheet_name_rejects_excel_reserved_characters ... ok
test workbook::tests::workbook_default_reference_mode_is_a1 ... ok
test workbook::tests::workbook_register_spill_round_trip ... ok
test workbook::tests::workbook_clear_spill_at_unknown_anchor_errors ... ok
test workbook::tests::workbook_clear_spill_if_present_returns_false_when_missing ... ok
test workbook::tests::put_then_read_across_sheets ... ok
test workbook::tests::workbook_clear_spill_at_clears_anchor_own_computed_overlay ... ok
test workbook::tests::workbook_clear_spill_if_present_returns_true_when_cleared ... ok
test workbook::tests::workbook_default_locale_is_en_us ... ok
test workbook::tests::workbook_reference_mode_and_locale_are_independent ... ok
test workbook::tests::workbook_register_spill_rejects_collision_with_existing ... ok
test workbook::tests::workbook_set_locale_round_trips_all_variants ... ok
test workbook::tests::workbook_set_reference_mode_round_trips ... ok
test workbook::tests::workbook_spill_anchors_accessor_returns_table ... ok
test workbook::tests::workbook_clear_spill_at_clears_computed_overlays ... ok
test workbook::tests::workbook_clear_spill_at_preserves_user_overlays_outside_rectangle ... ok
test column::tests::read_empty_column_is_blank ... ok
test column::tests::put_at_excel_max_row_is_accepted ... ok
test column::tests::put_then_read_round_trips ... ok

test result: ok. 179 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.57s

     Running unittests src/lib.rs (target/debug/deps/ql_terminal-8834ef5aaf818757)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_types-bc6f3a0f24caa3a6)

running 199 tests
test address::tests::primitive_ids_size_check ... ok
test address::tests::address_equality_and_ordering ... ok
test address::tests::address_const_new ... ok
test address::tests::address_is_copy ... ok
test address::tests::address_size_is_compact ... ok
test address::tests::range_contains_inclusive ... ok
test address::tests::address_display ... ok
test address::tests::range_cell_count_matches_inclusive_bounds ... ok
test address::tests::range_already_normalized ... ok
test address::tests::range_corners ... ok
test address::tests::range_display ... ok
test address::tests::range_is_copy ... ok
test address::tests::range_normalizes_corners ... ok
test address::tests::range_single_cell_count ... ok
test array::tests::column_constructor_is_nx1 ... ok
test array::tests::default_is_degenerate_zero_zero ... ok
test array::tests::empty_helper_constructs_degenerate ... ok
test array::tests::equality_compares_shape_and_cells ... ok
test array::tests::get_returns_none_for_out_of_bounds ... ok
test array::tests::heterogeneous_cells_compile ... ok
test array::tests::iter_rows_yields_row_slices ... ok
test array::tests::iter_yields_row_major ... ok
test array::tests::new_validates_cell_count ... ok
test array::tests::new_with_degenerate_shape_requires_empty_cells ... ok
test array::tests::row_constructor_is_1xn ... ok
test array::tests::row_major_indexing ... ok
test array::tests::first_panics_on_degenerate - should panic ... ok
test array::tests::at_panics_on_out_of_bounds - should panic ... ok
test array::tests::singleton_is_1x1 ... ok
test coercion::tests::comma_decimal_separator_rejected_locale_v1 ... ok
test coercion::tests::display_text_finite_numbers_unchanged ... ok
test coercion::tests::display_text_invariant_forms ... ok
test coercion::tests::display_text_preserves_arc_str_content ... ok
test coercion::tests::display_text_raw_inf_renders_as_num_sigil ... ok
test coercion::tests::display_text_raw_nan_renders_as_num_sigil ... ok
test coercion::tests::dot_only_and_dotted_edges ... ok
test coercion::tests::empty_string_vs_blank_logical_distinction ... ok
test coercion::tests::error_short_circuits_in_all_coercions ... ok
test coercion::tests::exponent_malformed_rejected ... ok
test coercion::tests::exponent_overflow_to_infinity_is_rejected ... ok
test coercion::tests::exponent_underflow_to_subnormal_or_zero ... ok
test coercion::tests::exponent_zero_forms_resolve_to_zero ... ok
test coercion::tests::format_number_for_arg_fractional ... ok
test coercion::tests::format_number_for_arg_integer_rendering ... ok
test coercion::tests::format_number_for_arg_large_falls_back_to_display ... ok
test coercion::tests::formula_text_non_errors_match_display ... ok
test coercion::tests::formula_text_propagates_every_error_variant ... ok
test coercion::tests::formula_text_raw_inf_propagates_as_num_error ... ok
test coercion::tests::formula_text_raw_nan_propagates_as_num_error ... ok
test coercion::tests::hex_octal_binary_prefixes_rejected ... ok
test coercion::tests::integer_2_pow_53_boundary_collapses_per_f64_mantissa ... ok
test coercion::tests::leading_zeros_accepted_as_decimal ... ok
test coercion::tests::lenient_non_text_same_as_strict ... ok
test coercion::tests::lenient_text_nan_inf_unparseable ... ok
test coercion::tests::lenient_text_percent ... ok
test coercion::tests::lenient_text_simple ... ok
test coercion::tests::lenient_text_unparseable_is_value_error ... ok
test coercion::tests::lenient_text_with_whitespace_and_exponent ... ok
test coercion::tests::locale_currency_explicitly_rejected_v1_boundary ... ok
test coercion::tests::logical_blank_is_false ... ok
test coercion::tests::logical_boolean_passthrough ... ok
test coercion::tests::logical_error_propagates ... ok
test coercion::tests::logical_number_nan_inf_is_num_error ... ok
test coercion::tests::logical_number_nonzero_is_true ... ok
test coercion::tests::logical_text_only_true_false_recognized ... ok
test coercion::tests::logical_text_other_is_value_error ... ok
test coercion::tests::logical_text_true_false_case_insensitive ... ok
test coercion::tests::nan_inf_text_unparseable ... ok
test coercion::tests::nbsp_and_bom_boundary_behavior ... ok
test coercion::tests::negative_zero_equality_with_positive_zero ... ok
test coercion::tests::parse_number_invariant_edge_cases ... ok
test coercion::tests::percent_alone_rejected ... ok
test coercion::tests::percent_chaining_rejected ... ok
test coercion::tests::percent_with_decimal_and_exponent ... ok
test coercion::tests::sanitize_passes_finite_numbers ... ok
test coercion::tests::sanitize_rejects_nan_and_infinities ... ok
test coercion::tests::sanitize_treats_infinity_as_num_so_div_kernels_must_check_zero_first ... ok
test coercion::tests::sign_only_rejected ... ok
test coercion::tests::skip_blank_blank_returns_none ... ok
test coercion::tests::skip_blank_boolean_returns_some ... ok
test coercion::tests::skip_blank_error_propagates ... ok
test coercion::tests::skip_blank_nan_inf_is_num_error ... ok
test coercion::tests::skip_blank_number_returns_some ... ok
test coercion::tests::skip_blank_text_is_value_error ... ok
test coercion::tests::space_between_sign_and_digits_rejected ... ok
test coercion::tests::strict_blank_is_zero ... ok
test coercion::tests::strict_boolean_to_unit_or_zero ... ok
test coercion::tests::strict_error_propagates ... ok
test coercion::tests::strict_number_nan_inf_becomes_num_error ... ok
test coercion::tests::strict_number_passthrough ... ok
test coercion::tests::strict_text_is_value_error ... ok
test coercion::tests::subnormal_numbers_pass_through_strict_and_lenient ... ok
test coercion::tests::to_int_arg_blank_is_zero ... ok
test coercion::tests::to_int_arg_bool_to_one_or_zero ... ok
test coercion::tests::to_int_arg_error_propagates ... ok
test coercion::tests::to_int_arg_nan_inf_is_num_error ... ok
test coercion::tests::to_int_arg_number_truncates_toward_zero ... ok
test coercion::tests::to_int_arg_text_parseable_truncates ... ok
test coercion::tests::to_int_arg_text_unparseable_is_value_error ... ok
test coercion::tests::to_text_for_arg_basic_types ... ok
test coercion::tests::to_text_for_arg_fractional_uses_display ... ok
test coercion::tests::to_text_for_arg_integer_rendering_no_trailing_zero ... ok
test coercion::tests::to_text_for_arg_large_integers_fall_back_to_display ... ok
test coercion::tests::to_text_for_arg_nan_inf_is_num_error ... ok
test coercion::tests::to_text_for_arg_propagates_errors ... ok
test coercion::tests::very_large_number_passes_strict ... ok
test coercion::tests::whitespace_combinations ... ok
test date::tests::days_30_months ... ok
test date::tests::days_31_months ... ok
test date::tests::days_feb_leap_vs_non_leap ... ok
test date::tests::days_invalid_month_is_zero ... ok
test date::tests::fraction_half_is_noon ... ok
test date::tests::fraction_handles_nan_or_inf ... ok
test date::tests::fraction_one_second ... ok
test date::tests::fraction_quarter_is_6am ... ok
test date::tests::fraction_strips_integer_part ... ok
test date::tests::fraction_three_quarter_is_6pm ... ok
test date::tests::fraction_wraps_at_24_hours ... ok
test date::tests::fraction_zero_is_midnight ... ok
test date::tests::hinnant_1900_01_01_is_minus_25567 ... ok
test date::tests::hinnant_round_trip_known_dates ... ok
test date::tests::hinnant_unix_epoch_is_day_zero ... ok
test date::tests::hms_25_hours_is_one_am ... ok
test date::tests::hms_cascading_minutes_and_seconds ... ok
test date::tests::hms_noon_is_half ... ok
test date::tests::hms_round_trip_at_arbitrary_time ... ok
test date::tests::hms_wraps_24_hour_to_zero ... ok
test date::tests::hms_zero_is_zero ... ok
test date::tests::leap_year_400_rule ... ok
test date::tests::leap_year_century_rule ... ok
test date::tests::leap_year_divisible_by_4 ... ok
test date::tests::leap_year_not_divisible_by_4 ... ok
test date::tests::round_trip_1900_system_common_dates ... ok
test date::tests::round_trip_1904_system_common_dates ... ok
test date::tests::serial_0_in_excel1900_is_num_error_v1_display_oddity ... ok
test date::tests::serial_0_in_excel1904_is_real_epoch ... ok
test date::tests::serial_1_in_excel1904_is_1904_01_02 ... ok
test date::tests::serial_1_is_1900_01_01 ... ok
test date::tests::serial_25569_is_unix_epoch ... ok
test date::tests::serial_2_is_1900_01_02 ... ok
test date::tests::serial_59_is_1900_02_28 ... ok
test date::tests::serial_60_fractional_still_phantom ... ok
test date::tests::serial_60_in_excel1904_is_real_1904_03_01 ... ok
test date::tests::serial_60_is_phantom_feb_29_1900_in_excel1900 ... ok
test date::tests::serial_61_is_1900_03_01 ... ok
test date::tests::serial_beyond_9999_is_num_error ... ok
test date::tests::serial_max_is_9999_12_31 ... ok
test date::tests::serial_nan_or_inf_is_num_error ... ok
test date::tests::serial_negative_is_num_error ... ok
test date::tests::ymd_1900_01_01_is_serial_1 ... ok
test date::tests::ymd_1900_02_28_is_serial_59 ... ok
test date::tests::ymd_1900_02_29_is_num_error_in_excel1904 ... ok
test date::tests::ymd_1900_02_29_is_serial_60_in_excel1900 ... ok
test date::tests::ymd_1900_03_01_is_serial_61 ... ok
test date::tests::ymd_1904_01_01_in_excel1904_is_serial_0 ... ok
test date::tests::ymd_1970_01_01_is_serial_25569 ... ok
test date::tests::ymd_9999_12_31_is_max_serial ... ok
test date::tests::ymd_invalid_day_is_num_error ... ok
test date::tests::ymd_invalid_month_is_num_error ... ok
test date::tests::ymd_year_before_1900_excel1900_is_num_error ... ok
test date::tests::ymd_year_before_1904_excel1904_is_num_error ... ok
test date::tests::ymd_year_beyond_9999_is_num_error ... ok
test error::tests::ai_not_available_parses_with_v1_suffix ... ok
test error::tests::all_contains_fifteen_distinct_variants ... ok
test error::tests::copy_is_actually_copy ... ok
test error::tests::display_matches_sigil ... ok
test error::tests::equality_is_structural ... ok
test error::tests::from_str_case_insensitive ... ok
test error::tests::from_str_rejects_unknown ... ok
test error::tests::from_str_roundtrips_all_variants ... ok
test error::tests::parse_error_carries_input ... ok
test error::tests::sigil_circ_matches_excel_canonical_form ... ok
test error::tests::sigil_excel_set_matches_excel_canonical_forms ... ok
test error::tests::sigil_quantbook_specific ... ok
test eval_context::tests::date_system_default_is_excel1900 ... ok
test eval_context::tests::default_is_excel1900_enus_system ... ok
test eval_context::tests::eval_context_is_copy ... ok
test eval_context::tests::for_test_helper_pins_clock ... ok
test eval_context::tests::locale_default_is_enus ... ok
test eval_context::tests::locale_default_still_enus_after_de_fr_addition ... ok
test eval_context::tests::locale_has_de_and_fr_variants ... ok
test eval_context::tests::now_provider_default_is_system ... ok
test eval_context::tests::now_provider_system_returns_some_secs_with_zero_offset_v1 ... ok
test eval_context::tests::now_provider_test_path_returns_pinned_values ... ok
test eval_context::tests::reference_mode_default_is_a1 ... ok
test eval_context::tests::reference_mode_variants_distinct ... ok
test eval_context::tests::static_default_matches_const ... ok
test tests::reexports_compile ... ok
test value::tests::as_error_yields_error_only ... ok
test value::tests::default_is_blank ... ok
test value::tests::display_matches_excel_invariant_forms ... ok
test value::tests::equality_is_structural_per_variant ... ok
test value::tests::from_impls ... ok
test value::tests::is_blank_helper ... ok
test value::tests::is_error_helper ... ok
test value::tests::nan_number_unequal_per_ieee ... ok
test value::tests::number_constructor_sanitizes_nan_and_inf ... ok
test value::tests::size_of_value_is_reasonable ... ok
test value::tests::text_constructor_shares_buffer_for_arc_input ... ok

test result: ok. 199 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/coercion_matrix.rs (target/debug/deps/coercion_matrix-79aa16f9717e0ecc)

running 46 tests
test case_blank_formula_canon_is_empty_string_ok ... ok
test case_blank_lenient_canon_is_zero ... ok
test case_blank_logical_canon_is_false ... ok
test case_blank_display_canon_is_empty_string ... ok
test case_blank_strict_canon_is_zero ... ok
test case_bool_false_formula_canon_is_uppercase_false_literal ... ok
test case_bool_false_display_canon_is_uppercase_false_literal ... ok
test case_bool_false_lenient_canon_is_zero ... ok
test case_bool_false_logical_canon_passthrough ... ok
test case_bool_false_strict_canon_is_zero ... ok
test case_bool_true_display_canon_is_uppercase_true_literal ... ok
test case_bool_true_formula_canon_is_uppercase_true_literal ... ok
test case_bool_true_lenient_canon_is_one ... ok
test case_bool_true_logical_canon_passthrough ... ok
test case_bool_true_strict_canon_is_one ... ok
test case_error_display_canon_renders_sigil ... ok
test case_error_formula_canon_propagates_all_variants ... ok
test case_error_lenient_canon_propagates_all_variants ... ok
test case_error_logical_canon_propagates_all_variants ... ok
test case_error_strict_canon_propagates_all_variants ... ok
test case_number_finite_display_canon_invariant_rendering ... ok
test case_number_finite_formula_canon_invariant_rendering ... ok
test case_number_finite_lenient_canon_passthrough ... ok
test case_number_finite_logical_canon_nonzero_is_true ... ok
test case_number_finite_strict_canon_passthrough ... ok
test case_number_inf_display_w5_64_policy_is_num_sigil ... ok
test case_number_inf_formula_w5_64_policy_is_num_error ... ok
test case_number_inf_lenient_canon_is_num_error ... ok
test case_number_inf_logical_canon_is_num_error ... ok
test case_number_inf_strict_canon_is_num_error ... ok
test case_number_nan_display_w5_64_policy_is_num_sigil ... ok
test case_number_nan_formula_w5_64_policy_is_num_error ... ok
test case_number_nan_lenient_canon_is_num_error ... ok
test case_number_nan_logical_canon_is_num_error ... ok
test case_number_nan_strict_canon_is_num_error ... ok
test case_text_parseable_display_canon_passthrough ... ok
test case_text_parseable_formula_canon_passthrough ... ok
test case_text_parseable_lenient_canon_parses ... ok
test case_text_parseable_logical_canon_only_true_false_match ... ok
test case_text_parseable_strict_canon_is_value_error ... ok
test case_text_unparseable_display_canon_passthrough ... ok
test case_text_unparseable_formula_canon_passthrough ... ok
test case_text_unparseable_lenient_canon_is_value_error ... ok
test case_text_unparseable_logical_canon_is_value_error ... ok
test case_text_unparseable_strict_canon_is_value_error ... ok
test cross_cutting_error_short_circuits_in_all_coercion_contexts ... ok

test result: ok. 46 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/ql_udf-e82dc8dc9145d105)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (target/debug/deps/quantbook_py-4027e78a0a92b16f)

running 1 test
test tests::smoke ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_ai

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_bench

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_bindings_c

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_bindings_node

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_bindings_wasm

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_calcgraph

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_collab

running 1 test
test crates/ql-collab/src/session.rs - session::CollabSession::op_log (line 136) ... ignored

test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_connectors

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_exec

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_formula_semantics

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_formula_syntax

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_functions

running 1 test
test crates/ql-functions/src/range_aware_fns.rs - range_aware_fns (line 14) ... ignored

test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_io

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_io_ods

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_io_xlsx

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_oplog

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_profile

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_service

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_sql

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_storage

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_terminal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_types

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests ql_udf

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests quantbook_py

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


codex
The full workspace test run completed cleanly. I’m doing the lightweight list/count pass now so the report can state the observed test count instead of relying on the commit message.
exec
/bin/zsh -lc "cargo test --workspace -- --list | awk '/: test"'$|: benchmark$/ {count++} END {print count}'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'cargo fmt --all -- --check' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 867ms:
 succeeded in 34626ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.18s
     Running unittests src/lib.rs (target/debug/deps/ql_ai-56b2b6f970b00080)
     Running unittests src/lib.rs (target/debug/deps/ql_bench-3294c837de9ac1b5)
     Running unittests src/lib.rs (target/debug/deps/ql_bindings_c-9197186d947f39eb)
     Running unittests src/lib.rs (target/debug/deps/ql_bindings_node-f9c231e873487b0d)
     Running unittests src/lib.rs (target/debug/deps/ql_bindings_wasm-b7365bdcf31c84ce)
     Running unittests src/lib.rs (target/debug/deps/ql_calcgraph-5a019843294fc3b9)
     Running unittests src/lib.rs (target/debug/deps/ql_collab-29775d5c32bbf9e7)
     Running unittests src/lib.rs (target/debug/deps/ql_connectors-9f144529c060c5db)
     Running unittests src/lib.rs (target/debug/deps/ql_exec-79ceaccd8848d882)
     Running tests/distribution_fns_e2e.rs (target/debug/deps/distribution_fns_e2e-791e1659779cf1a1)
     Running tests/error_precedence.rs (target/debug/deps/error_precedence-10f70c4d01ebbfac)
     Running tests/ide_simulation.rs (target/debug/deps/ide_simulation-944f1bfcf208d162)
     Running tests/oplog_e2e.rs (target/debug/deps/oplog_e2e-8e8edad97a0473da)
     Running tests/opus_a_phase_4_12_cross_features.rs (target/debug/deps/opus_a_phase_4_12_cross_features-7ad91339fd19ee73)
     Running tests/p412_function_arg_fuzz.rs (target/debug/deps/p412_function_arg_fuzz-a3748bbdfa25d8b3)
     Running tests/phase_5_2_d4_spill_2peer_probe.rs (target/debug/deps/phase_5_2_d4_spill_2peer_probe-b1c0fb58110c3426)
     Running tests/reference_fns_coverage_extensions.rs (target/debug/deps/reference_fns_coverage_extensions-480b23d050ab9d8e)
     Running tests/reference_fns_e2e.rs (target/debug/deps/reference_fns_e2e-848b71c61e1f9c15)
     Running tests/reference_fns_step3_e2e.rs (target/debug/deps/reference_fns_step3_e2e-0bdc492f3fd3f1ba)
     Running tests/reference_fns_step4_e2e.rs (target/debug/deps/reference_fns_step4_e2e-5c5052a7a0506d81)
     Running tests/reference_fns_step5_cross_cutting.rs (target/debug/deps/reference_fns_step5_cross_cutting-a40d2d77d537ceaa)
     Running tests/reference_tier_dispatcher_smoke.rs (target/debug/deps/reference_tier_dispatcher_smoke-db83d9bf9aa5f3b7)
     Running tests/region_mul2_e2e.rs (target/debug/deps/region_mul2_e2e-ea00711cdddb7bdc)
     Running unittests src/lib.rs (target/debug/deps/ql_formula_semantics-d287b63efe5960c0)
     Running unittests src/lib.rs (target/debug/deps/ql_formula_syntax-838196c1954ccbcf)
     Running tests/p412_b_pinpoint.rs (target/debug/deps/p412_b_pinpoint-0e135c835ed5aa8f)
     Running tests/p412_b_threaded_depth_probe.rs (target/debug/deps/p412_b_threaded_depth_probe-262a1425a2f37b6f)
     Running tests/p412_defensive_fuzz_probes.rs (target/debug/deps/p412_defensive_fuzz_probes-7ea6115705f48a2d)
     Running unittests src/lib.rs (target/debug/deps/ql_functions-8a0a04f0fea98885)
     Running tests/coverage.rs (target/debug/deps/coverage-7e6314102ed62dcb)
     Running tests/per_function_overrides.rs (target/debug/deps/per_function_overrides-18c25d0ba30805d9)
     Running unittests src/lib.rs (target/debug/deps/ql_io-2b68bb7b6558b1dd)
     Running tests/p412_qbook_corruption_probes.rs (target/debug/deps/p412_qbook_corruption_probes-66a1959002a6efcc)
     Running unittests src/lib.rs (target/debug/deps/ql_io_ods-cf52be05b2b98985)
     Running unittests src/lib.rs (target/debug/deps/ql_io_xlsx-665d45a08c929589)
     Running tests/calamine_smoke.rs (target/debug/deps/calamine_smoke-3f7dccc373b7b520)
     Running tests/opus_a_cache_policy.rs (target/debug/deps/opus_a_cache_policy-340af14c4dee399a)
     Running tests/opus_a_deep_probe.rs (target/debug/deps/opus_a_deep_probe-d8e50ef3f750e602)
     Running tests/opus_a_dup_fmt.rs (target/debug/deps/opus_a_dup_fmt-128f34c8a6ffc2b3)
     Running tests/opus_a_edge_cases.rs (target/debug/deps/opus_a_edge_cases-030d3e1d13c60662)
     Running tests/opus_a_error_cell_probe.rs (target/debug/deps/opus_a_error_cell_probe-0883561acf301cf8)
     Running tests/opus_a_format_no_overlay.rs (target/debug/deps/opus_a_format_no_overlay-673d1e773333adb9)
     Running tests/opus_a_misc.rs (target/debug/deps/opus_a_misc-b1d986ca03c48955)
     Running tests/opus_a_phase_4_12_ide_proof.rs (target/debug/deps/opus_a_phase_4_12_ide_proof-36287debc62dc5a3)
     Running tests/opus_a_text_edge.rs (target/debug/deps/opus_a_text_edge-5801dc184e1d2468)
     Running tests/phase_4_11_corpus_probe.rs (target/debug/deps/phase_4_11_corpus_probe-14d3b8656d6bf480)
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-60398aa280b2579d)
     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-4a1df24b37102cf6)
     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-73e390f4dc4755d2)
     Running unittests src/lib.rs (target/debug/deps/ql_profile-78c7394dd9650d98)
     Running unittests src/lib.rs (target/debug/deps/ql_service-4c2c946c9437d6d4)
     Running unittests src/lib.rs (target/debug/deps/ql_sql-cd6ab19212f67010)
     Running unittests src/lib.rs (target/debug/deps/ql_storage-979f9709b378176c)
     Running unittests src/lib.rs (target/debug/deps/ql_terminal-8834ef5aaf818757)
     Running unittests src/lib.rs (target/debug/deps/ql_types-bc6f3a0f24caa3a6)
     Running tests/coercion_matrix.rs (target/debug/deps/coercion_matrix-79aa16f9717e0ecc)
     Running unittests src/lib.rs (target/debug/deps/ql_udf-e82dc8dc9145d105)
     Running unittests src/lib.rs (target/debug/deps/quantbook_py-4027e78a0a92b16f)
   Doc-tests ql_ai
   Doc-tests ql_bench
   Doc-tests ql_bindings_c
   Doc-tests ql_bindings_node
   Doc-tests ql_bindings_wasm
   Doc-tests ql_calcgraph
   Doc-tests ql_collab
   Doc-tests ql_connectors
   Doc-tests ql_exec
   Doc-tests ql_formula_semantics
   Doc-tests ql_formula_syntax
   Doc-tests ql_functions
   Doc-tests ql_io
   Doc-tests ql_io_ods
   Doc-tests ql_io_xlsx
   Doc-tests ql_oplog
   Doc-tests ql_profile
   Doc-tests ql_service
   Doc-tests ql_sql
   Doc-tests ql_storage
   Doc-tests ql_terminal
   Doc-tests ql_types
   Doc-tests ql_udf
   Doc-tests quantbook_py
4331

exec
/bin/zsh -lc "cargo test --workspace 2>/tmp/quantbook_cargo_test_stderr.log | awk '/test result:/ { for (i=1; i<=NF; i++) { if ("'$i=="passed;") passed += $(i-1); if ($i=="failed;") failed += $(i-1); if ($i=="ignored;") ignored += $(i-1); } } END { print "passed=" passed " failed=" failed " ignored=" ignored " total=" passed+failed+ignored }'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'rg -n "pub use .*PeerID|PeerID" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | head -40' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 299ms:
76:    Counter, CounterSpan, FractionalIndex, IdLp, IdSpan, Lamport, PeerID, TreeID, TreeParentId, ID,
144:    /// Duplicate the document with a different PeerID
239:    /// - This mode uses a different PeerID for each checkout.
240:    /// - Ensure no concurrent operations share the same PeerID if set manually.
274:    /// - This mode uses a different PeerID for each checkout.
275:    /// - Ensure no concurrent operations share the same PeerID if set manually.
357:    /// PeerID per checkout.
971:    /// Get the PeerID
973:    pub fn peer_id(&self) -> PeerID {
977:    /// Change the PeerID
980:    /// - Never reuse the same PeerID across concurrent writers (multiple tabs/devices). Duplicate
981:    ///   PeerIDs can produce conflicting OpIDs and corrupt the document.
982:    /// - Do not assign a fixed PeerID to a user or device without strict single-ownership locking.
983:    ///   Prefer the default random PeerID per process/session.
985:    pub fn set_peer_id(&self, peer: PeerID) -> LoroResult<()> {
2184:    pub fn get_last_editor(&self, key: &str) -> Option<PeerID> {
2711:    pub fn get_editor_at_unicode_pos(&self, pos: usize) -> Option<PeerID> {
3409:    pub fn get_creator_at(&self, pos: usize) -> Option<PeerID> {
3414:    pub fn get_last_mover_at(&self, pos: usize) -> Option<PeerID> {
3419:    pub fn get_last_editor_at(&self, pos: usize) -> Option<PeerID> {
3815:    pub fn peer(&self) -> PeerID {

exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/error.rs | sed -n '1,90p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 299ms:
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

 succeeded in 33960ms:
passed=4164 failed=0 ignored=167 total=4331

codex
One gate detail diverges from the prompt: the counted current run is `4164 passed, 0 failed, 167 ignored`, not 4162 passed. That matches the four new tests visible in `ql-oplog` and `ql-collab`, so I’ll report 4164 as the observed value.
exec
/bin/zsh -lc 'cargo clippy --workspace --all-targets -- -D warnings' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
codex
`cargo fmt --all -- --check` is clean. Clippy is still running through the workspace; no diagnostics have appeared so far.
 succeeded in 85636ms:
    Checking ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
    Checking ql-io v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io)
    Checking ql-collab v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab)
    Checking ql-exec v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec)
    Checking ql-io-xlsx v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 25s

exec
/bin/zsh -lc 'git status --short' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 2180ms:
?? .codex-phase-5-2-b-audit-prompt.md
?? .codex-phase-5-2-b-audit.out
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
?? quantbook-engine/.plans/
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt

codex
**Loro Integration Correctness**

A1. Correct. `loro::LoroDoc::set_peer_id` is only a wrapper over the internal doc setter: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:985). The internal state doc says it changes the peer id “for the future txn”: [state.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:491). Existing committed ops are not traversed or rewritten. Transaction creation captures the current peer at [txn.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:350), and commit writes `ID::new(self.peer, ...)` at [txn.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:448).

A2. `OpLog::set_peer_id` surfaces both Loro pitfalls at [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:138). Loro’s own docs say “Never reuse the same PeerID” and “Prefer the default random PeerID”: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:979). `CollabSession::new` only directly surfaces duplicate peer ids and refers to `OpLog`; `from_snapshot` does not surface either pitfall directly. Low doc gap.

A3. Safe after import. Loro `import` runs through `with_barrier`: [loro.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:568), snapshot decode requires an empty op log: [fast_snapshot.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:145), and `set_peer_id` then updates only the current/future peer state.

A4. Through `OpLog`, there is no public interleaving point between `list.push` and `doc.commit()` because `append` holds `&mut self`: [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:76). At raw Loro level, changing peer id during an auto-commit txn triggers a barrier: [loro.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:187). Pending txn ops keep the peer captured when that txn was created; future txn/appends use the new peer.

**API Ergonomics**

B1. Defensible. `ql-collab` explicitly says pre-0.2.0 API is in flux at [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:26), and `PeerId::MAX` can fail via Loro, so returning `Result` is correct.

B2. No missed live call sites. `rg 'CollabSession::new('` finds only `session.rs` tests plus historical audit docs. Workspace compile/test confirms no old infallible caller remains.

B3. Raw `u64` is acceptable. Using `loro::PeerID` would improve Rustdoc intent but adds no type safety because Loro defines `pub type PeerID = u64`: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-common-1.12.0/src/lib.rs:28). `ql-collab::PeerId` remains the meaningful newtype.

**Test Coverage**

C1. Coverage is directionally good, but the import tests do not actually import committed ops despite comments saying they do: [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:337), [session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:266). Add one append before export in each.

C2. D-4 still passes: `cargo test -p ql-exec --test phase_5_2_d4_spill_2peer_probe` = 4 passed. It uses bare `OpLog` defaults at [phase_5_2_d4_spill_2peer_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:64), so it exercises Loro random peer ids, not the new stable `PeerId` path. I’d update it or add a CollabSession-backed variant.

C3. No duplicate-peer-id corruption test. I would not add one at this layer: Loro warns this corrupts documents but does not promise a clean detection signal. Enforce/test uniqueness in the future peer allocation or transport/session registry layer.

**Doc Accuracy**

D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.

D2. The specific label-only limitation is closed in current docs. Historical audit docs still mention it, appropriately. Separate stale docs remain in [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114): `ql-collab` is no longer a 15-line/empty stub.

D3. I cannot access the Linux VM memory path from this Mac shell. Do not write `4162` there; observed current `cargo test --workspace` count is `4164 passed, 0 failed, 167 ignored`. HEAD `ef056f50bee` and Phase 5.2.b completion are valid.

**Gates**

E1. `cargo test --workspace`: passed. Observed `4164 passed, 0 failed, 167 ignored` via parsed run output. This differs from the prompt’s expected 4162.

E2. `cargo fmt --all -- --check`: clean.

E3. `cargo clippy --workspace --all-targets -- -D warnings`: clean.

**Findings**

HIGH: none.

MEDIUM: none.

LOW:
- [log.rs:135](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:135): “Idempotent/no-op” overstates Loro behavior. Same-id calls can still emit peer-id-change callbacks and trigger an auto-commit barrier. Fix: soften wording to “leaves peer id unchanged.”
- [session.rs:82](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:82) / [session.rs:99](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:99): `CollabSession` method docs do not directly surface both Loro peer-id pitfalls. Fix: add duplicate-id and fixed-user/device-locking warnings to both constructors.
- [log.rs:337](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:337), [session.rs:266](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:266), [phase_5_2_d4_spill_2peer_probe.rs:64](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:64): test comments/coverage imply imported committed ops and stable peer-id two-peer behavior, but current tests do not fully exercise that. Fix: append before export and set explicit peer ids in D-4 or add a CollabSession D-4 variant.
- [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114): stale `ql-collab` stub/empty claims. Fix: close/update GAP-C-03 and revise GAP-C-05 reproduce text.

**Verdict**

Phase 5.2.b has 4 SHOULD-FIX issues for follow-up. No MUST-FIX correctness issue found in the PeerId-to-Loro wiring.
tokens used
278,234
**Loro Integration Correctness**

A1. Correct. `loro::LoroDoc::set_peer_id` is only a wrapper over the internal doc setter: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:985). The internal state doc says it changes the peer id “for the future txn”: [state.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state.rs:491). Existing committed ops are not traversed or rewritten. Transaction creation captures the current peer at [txn.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:350), and commit writes `ID::new(self.peer, ...)` at [txn.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/txn.rs:448).

A2. `OpLog::set_peer_id` surfaces both Loro pitfalls at [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:138). Loro’s own docs say “Never reuse the same PeerID” and “Prefer the default random PeerID”: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:979). `CollabSession::new` only directly surfaces duplicate peer ids and refers to `OpLog`; `from_snapshot` does not surface either pitfall directly. Low doc gap.

A3. Safe after import. Loro `import` runs through `with_barrier`: [loro.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:568), snapshot decode requires an empty op log: [fast_snapshot.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:145), and `set_peer_id` then updates only the current/future peer state.

A4. Through `OpLog`, there is no public interleaving point between `list.push` and `doc.commit()` because `append` holds `&mut self`: [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:76). At raw Loro level, changing peer id during an auto-commit txn triggers a barrier: [loro.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:187). Pending txn ops keep the peer captured when that txn was created; future txn/appends use the new peer.

**API Ergonomics**

B1. Defensible. `ql-collab` explicitly says pre-0.2.0 API is in flux at [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:26), and `PeerId::MAX` can fail via Loro, so returning `Result` is correct.

B2. No missed live call sites. `rg 'CollabSession::new('` finds only `session.rs` tests plus historical audit docs. Workspace compile/test confirms no old infallible caller remains.

B3. Raw `u64` is acceptable. Using `loro::PeerID` would improve Rustdoc intent but adds no type safety because Loro defines `pub type PeerID = u64`: [lib.rs](/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-common-1.12.0/src/lib.rs:28). `ql-collab::PeerId` remains the meaningful newtype.

**Test Coverage**

C1. Coverage is directionally good, but the import tests do not actually import committed ops despite comments saying they do: [log.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:337), [session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:266). Add one append before export in each.

C2. D-4 still passes: `cargo test -p ql-exec --test phase_5_2_d4_spill_2peer_probe` = 4 passed. It uses bare `OpLog` defaults at [phase_5_2_d4_spill_2peer_probe.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:64), so it exercises Loro random peer ids, not the new stable `PeerId` path. I’d update it or add a CollabSession-backed variant.

C3. No duplicate-peer-id corruption test. I would not add one at this layer: Loro warns this corrupts documents but does not promise a clean detection signal. Enforce/test uniqueness in the future peer allocation or transport/session registry layer.

**Doc Accuracy**

D1. `crdt-data-model.md` now reads as truth for the closed wiring: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:398). It only names the duplicate-id pitfall, not the fixed user/device id pitfall.

D2. The specific label-only limitation is closed in current docs. Historical audit docs still mention it, appropriately. Separate stale docs remain in [known-gaps.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114): `ql-collab` is no longer a 15-line/empty stub.

D3. I cannot access the Linux VM memory path from this Mac shell. Do not write `4162` there; observed current `cargo test --workspace` count is `4164 passed, 0 failed, 167 ignored`. HEAD `ef056f50bee` and Phase 5.2.b completion are valid.

**Gates**

E1. `cargo test --workspace`: passed. Observed `4164 passed, 0 failed, 167 ignored` via parsed run output. This differs from the prompt’s expected 4162.

E2. `cargo fmt --all -- --check`: clean.

E3. `cargo clippy --workspace --all-targets -- -D warnings`: clean.

**Findings**

HIGH: none.

MEDIUM: none.

LOW:
- [log.rs:135](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:135): “Idempotent/no-op” overstates Loro behavior. Same-id calls can still emit peer-id-change callbacks and trigger an auto-commit barrier. Fix: soften wording to “leaves peer id unchanged.”
- [session.rs:82](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:82) / [session.rs:99](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:99): `CollabSession` method docs do not directly surface both Loro peer-id pitfalls. Fix: add duplicate-id and fixed-user/device-locking warnings to both constructors.
- [log.rs:337](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/log.rs:337), [session.rs:266](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:266), [phase_5_2_d4_spill_2peer_probe.rs:64](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:64): test comments/coverage imply imported committed ops and stable peer-id two-peer behavior, but current tests do not fully exercise that. Fix: append before export and set explicit peer ids in D-4 or add a CollabSession D-4 variant.
- [known-gaps.md:114](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/known-gaps.md:114): stale `ql-collab` stub/empty claims. Fix: close/update GAP-C-03 and revise GAP-C-05 reproduce text.

**Verdict**

Phase 5.2.b has 4 SHOULD-FIX issues for follow-up. No MUST-FIX correctness issue found in the PeerId-to-Loro wiring.
