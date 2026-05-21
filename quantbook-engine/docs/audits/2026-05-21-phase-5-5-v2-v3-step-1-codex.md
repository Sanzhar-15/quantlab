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
session id: 019e4924-17bb-7f03-b932-1dfba4583a98
--------
user
# Phase 5.5 V2 V3 step 1 audit — version-vector delta flush

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: HEAD will be the V2 V3 step 1 ship commit (pending — engineer will commit before dispatching). Predecessor: `b7aa4cb7bb9` (Phase 5.5 V2 V2 audit-closure).

**Workspace tests at ship**: 4386 → expected 4395 (+9 V2 V3 step 1 tests). fmt + clippy clean (gates verified in this session).

**Plan**: `quantbook-engine/.plans/_active.md` (status: in-progress at audit dispatch time; will be archived at closure).

## What shipped

Step 1 of V2 V3 — per-transport version-vector tracking + delta flush. Closes V2 V2 audit M3 (bandwidth — O(state) → O(delta)) + sets foundation for V2 V3 step 2 closing M1 (poll_remote bypass) + M2/E1 (echo loop).

### New `OpLog` API (in `crates/ql-oplog/src/log.rs`):

```rust
pub fn export_delta_bytes(&self, from: &loro::VersionVector)
    -> Result<Vec<u8>, OpLogError>;  // ExportMode::updates(&from)

pub fn oplog_vv(&self) -> loro::VersionVector;  // cheap accessor
```

### New `CollabSession` API (in `crates/ql-collab/src/session.rs`):

```rust
pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError>;
```

### New `CollabSession` field:

```rust
last_flushed_vv: Option<loro::VersionVector>,  // None = no flush yet → next sends from empty VV
```

### Behavior changes

1. `maybe_auto_flush` reroutes from `flush_to_transport` → `flush_delta_to_transport`. Auto-flush wire payload is now delta-encoded.
2. `flush_to_transport` (full snapshot) now ALSO updates `last_flushed_vv` on success, so mix-and-match with delta path doesn't re-send the snapshot's content.
3. `attach_transport` + `detach_transport` reset `last_flushed_vv = None`. New transport = fresh baseline.

### Tests added (9 new in `crates/ql-collab/tests/auto_flush.rs`)

`delta_flush_first_call_sends_all_ops_with_no_transport_baseline`,
`delta_flush_idempotency_short_circuits_when_no_state_change`,
`delta_flush_subsequent_calls_send_only_new_ops`,
`attach_transport_resets_last_flushed_vv`,
`flush_to_transport_full_snapshot_path_still_works_and_updates_vv`,
`on_append_uses_delta_path_under_v2_v3`,
`delta_flush_with_no_transport_returns_ok_false`,
`delta_flush_failure_does_not_advance_vv_so_retry_resends`,
`delta_flush_after_merge_bytes_sends_merged_state_to_third_peer`.

## Files to focus your audit on

* `crates/ql-oplog/src/log.rs` lines ~325-365 (new export_delta_bytes + oplog_vv).
* `crates/ql-collab/src/session.rs` — search for `last_flushed_vv` and `flush_delta_to_transport`.
* `crates/ql-collab/src/transport.rs` module-doc note about V2 V3 step 1.
* `crates/ql-collab/tests/auto_flush.rs` — last ~250 lines (the 9 new tests).
* `docs/architecture/ide-consumer-contract.md` — delta-flush bullet.
* `docs/phase5/v1-exit-packet.md` § "Phase 5.5 V2 V3 step 1" + § "remaining".
* `docs/MASTER-PLAN.md` § 5.5 row.

## Specific audit dimensions

### 1. VV equality semantics

Loro's `VersionVector` `PartialEq` — does `==` compare structurally (same op count per peer) or by reference? My idempotency short-circuit at `flush_delta_to_transport` uses `last_vv == &current_vv`. If Loro's VV equality has surprising behavior (e.g. reference equality only, or comparing only the SET of peers not their counts), the short-circuit might either:
- (a) never fire → wasted bandwidth (no correctness bug)
- (b) fire when it shouldn't → peers miss ops (CORRECTNESS BUG — HIGH)

Verify by reading `loro_internal::version::VersionVector` `Eq`/`PartialEq` impl. Or by writing a test that appends an op, gets oplog_vv before vs after, asserts they're not equal.

### 2. VV cloning cost

`self.log.oplog_vv()` clones an internal VV. How expensive is this? Looking at `loro::LoroDoc::oplog_vv`, it returns by value — does it clone N×u64 (one per peer) or something heavier? Under OnAppend per-keystroke, this fires on every mutation. Acceptable per-call cost?

### 3. Lifecycle correctness around `merge_bytes`

`merge_bytes` mutates `self.log` (adds peer ops) then calls `maybe_auto_flush`. Auto-flush calls `flush_delta_to_transport` which reads `self.log.oplog_vv()` (post-merge) and compares against `self.last_flushed_vv` (pre-merge). If the merge advanced the VV (peer had new ops), delta flush fires with `from = last_flushed_vv`. The delta bytes encode the ops added BY US PLUS the ops we merged FROM PEER.

Edge case: peer A's transport endpoint is the SAME peer that just sent us the bytes (B). Now A's `merge_bytes(peer_b_bytes)` auto-flushes a delta back to B. B's `poll_remote` will receive these bytes; but they contain B's own ops (deduplicated by Loro on import). So B sees: its own ops echoed back + any new ops A appended. Loro dedupes the echoed B-ops, but the wire payload is wasted.

Is this a problem? Could we avoid sending the merged-FROM-peer ops back to the peer? The cleanest fix would be per-transport VV (not per-session). Documented as V2 V3 step 2 concern? Or worth fixing now?

### 4. `attach_transport` reset is destructive

Scenario: caller has session with attached transport T1. Session has flushed several deltas. Caller does `attach_transport(T2)` (which REPLACES T1, returning Some(T1)). My reset clears `last_flushed_vv` to None. This is correct for T2 (fresh peer) but ALSO means the caller can't reattach T1 later and continue from the existing baseline.

Is this acceptable? Document?

### 5. Idempotency short-circuit timing

The short-circuit at `flush_delta_to_transport` checks `last_vv == &current_vv`. But `current_vv` is read BEFORE the bytes are encoded. If another thread (impossible per `&mut self`, but conceptually) appended in between, the VV check might miss the new ops.

`&mut self` prevents this — single-threaded by construction. Confirm.

### 6. First-flush semantics in `flush_delta_to_transport`

When `last_flushed_vv` is `None`, my code uses `&loro::VersionVector::default()` as `from`. Loro's `export(ExportMode::updates(&empty_vv))` is documented as equivalent to `all_updates()` — sends everything. But is `VersionVector::default()` really the empty VV? Verify.

If `VersionVector::default()` is something other than empty (e.g. an uninitialized state Loro doesn't accept as `from`), the first flush could fail or send wrong bytes.

### 7. Error handling on `export_delta_bytes` Err

The export can fail with `LoroEncodeError`. My code propagates via `?` correctly. But what does this error mean in practice? Is it recoverable? Does it leave the doc in a bad state? Loro's docs say export is read-only (no doc mutation), so `last_flushed_vv` not being updated on error is the right call.

### 8. Auto-flush bandwidth claim

I claim the V2 V3 step 1 wire payload is O(per-op delta) instead of O(state). Verify empirically: the `delta_flush_subsequent_calls_send_only_new_ops` test compares first-flush and second-flush byte counts? No — it just verifies correctness via reconstruction. Could add a byte-size comparison? Or is this a documentation claim to verify by inspection of Loro's encoding?

### 9. Test coverage gaps

- 3-peer scenarios under V2 V3 (peer A is hub, peer B + C are leaves)?
- Mix of `flush_to_transport` (snapshot) and `flush_delta_to_transport` (delta) interleaved in adversarial orders?
- Failure during `export_delta_bytes` itself (not transport.send)?

### 10. Docstring accuracy

Every claim should be verifiable. Specifically:
- "First flush sends from empty VV = all_updates" — verified by `delta_flush_first_call_sends_all_ops_with_no_transport_baseline`.
- "Idempotency short-circuit" — verified by `delta_flush_idempotency_short_circuits_when_no_state_change`.
- "Peers don't need to change" — Loro's `import` accepts both formats — verify in Loro docs.

## Output

**VERDICT: PASS / PASS-WITH-FINDINGS / FAIL**

Bucketed findings (HIGH / MEDIUM / LOW) with file:line evidence. Don't paraphrase the code; quote it.

## Note

Don't run cargo test — gates already verified.

Audit transcript will be saved to `quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md`.

codex
I’ll audit this as a review: first pin the exact HEAD/diff against `b7aa4cb7bb9`, then inspect the touched code, docs, and Loro `VersionVector` implementation locally. I’ll avoid running the cargo test suite as requested.
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
/bin/zsh -lc "git rev-parse HEAD && git merge-base --is-ancestor b7aa4cb7bb9 HEAD; printf '%s\\n' "'$?' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
603bdc9aa6c026aae3b2eb1ca8b9d6aa36cee000
0

exec
/bin/zsh -lc 'pwd && git status --short --branch' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 930ms:
## feat/quantbook-engine...origin/feat/quantbook-engine [ahead 352]
?? .codex-phase-5-5-v2-v3-step-1-audit-prompt.md
?? .codex-phase-5-5-v2-v3-step-1-audit.out
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
?? quantbook-engine/.plans/_active.md
?? quantbook-engine/.plans/_archive/2026-05-13_w5-77-phase-4.5d-format-parser.md
?? quantbook-engine/.plans/_archive/2026-05-13_w5-78-phase-4.5d-renderer.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-121-phase-4.8.i.2-rename-column.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-122-phase-4.8.j-resize-table.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-123-phase-4.8.l-persistence-v6.md
?? quantbook-engine/.plans/_archive/2026-05-15_phase-4.8.O-findings.md
?? quantbook-engine/.plans/_archive/2026-05-17_phase-4-10-v1-260-closeout.md
?? quantbook-engine/.plans/_archive/2026-05-17_rt-v1-01-reference-tier-mini-phase.md
?? quantbook-engine/.plans/_archive/2026-05-18_phase-4-11-xlsx-import-export.md
?? quantbook-engine/.plans/_archive/2026-05-18_tier-a-api-stability.md
?? quantbook-engine/.plans/_archive/2026-05-21_phase-5-5-v2-v2-auto-flush.md
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt

codex
HEAD is `603bdc9aa6c026aae3b2eb1ca8b9d6aa36cee000`, and `b7aa4cb7bb9` is an ancestor, so I’m reviewing the shipped delta relative to the requested predecessor. The working tree has unrelated untracked files, but the tracked target commit is available for inspection.
exec
/bin/zsh -lc 'git diff --name-status b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs quantbook-engine/crates/ql-collab/tests/auto_flush.rs quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/MASTER-PLAN.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'git diff --stat b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs quantbook-engine/crates/ql-collab/tests/auto_flush.rs quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/MASTER-PLAN.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
M	quantbook-engine/crates/ql-collab/src/session.rs
M	quantbook-engine/crates/ql-collab/src/transport.rs
M	quantbook-engine/crates/ql-collab/tests/auto_flush.rs
M	quantbook-engine/crates/ql-oplog/src/log.rs
M	quantbook-engine/docs/MASTER-PLAN.md
M	quantbook-engine/docs/architecture/ide-consumer-contract.md
M	quantbook-engine/docs/phase5/v1-exit-packet.md

 succeeded in 0ms:
 quantbook-engine/crates/ql-collab/src/session.rs   | 170 +++++++++--
 quantbook-engine/crates/ql-collab/src/transport.rs |  24 +-
 .../crates/ql-collab/tests/auto_flush.rs           | 310 +++++++++++++++++++++
 quantbook-engine/crates/ql-oplog/src/log.rs        |  33 +++
 quantbook-engine/docs/MASTER-PLAN.md               |   9 +-
 .../docs/architecture/ide-consumer-contract.md     |   4 +-
 quantbook-engine/docs/phase5/v1-exit-packet.md     |  38 ++-
 7 files changed, 545 insertions(+), 43 deletions(-)

exec
/bin/zsh -lc 'rg -n "last_flushed_vv|flush_delta_to_transport|export_delta_bytes|oplog_vv|maybe_auto_flush|attach_transport|detach_transport|merge_bytes|flush_to_transport" quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-oplog/src/log.rs quantbook-engine/crates/ql-collab/src/transport.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/transport.rs:8://! (`attach_transport` / `detach_transport` / `has_transport` /
quantbook-engine/crates/ql-collab/src/transport.rs:9://! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
quantbook-engine/crates/ql-collab/src/transport.rs:19://! `CollabSession::flush_delta_to_transport` sends only the delta
quantbook-engine/crates/ql-collab/src/transport.rs:41://! transport → remote `CollabSession::merge_bytes` flow. The
quantbook-engine/crates/ql-collab/src/transport.rs:173:/// session mutator (`append_op`, `merge_bytes`, presence writes,
quantbook-engine/crates/ql-collab/src/transport.rs:178:/// the transport, recv on the other side, merge_bytes — useful
quantbook-engine/crates/ql-oplog/src/log.rs:20://! transport to other peers** (consumed by `merge_bytes` on the
quantbook-engine/crates/ql-oplog/src/log.rs:235:    /// the write is durable through `export_bytes` / `merge_bytes`
quantbook-engine/crates/ql-oplog/src/log.rs:337:    /// `from = &self.oplog_vv()` (current VV) produces a payload with
quantbook-engine/crates/ql-oplog/src/log.rs:344:    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:356:    /// above is one-way: `CollabSession::flush_delta_to_transport`
quantbook-engine/crates/ql-oplog/src/log.rs:358:    pub fn oplog_vv(&self) -> loro::VersionVector {
quantbook-engine/crates/ql-oplog/src/log.rs:359:        self.doc.oplog_vv()
quantbook-engine/crates/ql-oplog/src/log.rs:382:    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
quantbook-engine/crates/ql-oplog/src/log.rs:389:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:631:        peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:17://!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
quantbook-engine/crates/ql-collab/src/session.rs:42://! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
quantbook-engine/crates/ql-collab/src/session.rs:44://!   `OpLog::merge_bytes`.
quantbook-engine/crates/ql-collab/src/session.rs:103:    /// For `flush_to_transport`: the local `OpLog` is unaffected
quantbook-engine/crates/ql-collab/src/session.rs:108:    /// the error were already `merge_bytes`'d into the local
quantbook-engine/crates/ql-collab/src/session.rs:182:/// explicit [`CollabSession::flush_to_transport`] call.
quantbook-engine/crates/ql-collab/src/session.rs:193:    /// explicitly via [`CollabSession::flush_to_transport`] +
quantbook-engine/crates/ql-collab/src/session.rs:198:    /// underlying `LoroDoc`. Triggers on: `append_op`, `merge_bytes`,
quantbook-engine/crates/ql-collab/src/session.rs:203:    /// through [`flush_delta_to_transport`] (delta path) rather than
quantbook-engine/crates/ql-collab/src/session.rs:204:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
quantbook-engine/crates/ql-collab/src/session.rs:218:    /// - Transport-lifecycle methods (`attach_transport` etc.).
quantbook-engine/crates/ql-collab/src/session.rs:224:    ///   [`CollabSession::flush_to_transport`] after the drain. The
quantbook-engine/crates/ql-collab/src/session.rs:249:    /// guard short-circuits `flush_delta_to_transport` when no ops
quantbook-engine/crates/ql-collab/src/session.rs:262:    /// [`flush_delta_to_transport`] or [`flush_to_transport`].
quantbook-engine/crates/ql-collab/src/session.rs:275:/// and call `merge_bytes` to incorporate remote ops. All sessions
quantbook-engine/crates/ql-collab/src/session.rs:290:    /// transport. `None` until `attach_transport` is called.
quantbook-engine/crates/ql-collab/src/session.rs:304:    /// `flush_to_transport` / `flush_delta_to_transport` call.
quantbook-engine/crates/ql-collab/src/session.rs:311:    /// - Reset to `None` on `attach_transport` (a new transport-peer
quantbook-engine/crates/ql-collab/src/session.rs:312:    ///   needs the full state from scratch) and `detach_transport`
quantbook-engine/crates/ql-collab/src/session.rs:315:    ///   either `flush_to_transport` (full snapshot path) or
quantbook-engine/crates/ql-collab/src/session.rs:316:    ///   `flush_delta_to_transport` (V2 V3 delta path).
quantbook-engine/crates/ql-collab/src/session.rs:318:    last_flushed_vv: Option<loro::VersionVector>,
quantbook-engine/crates/ql-collab/src/session.rs:365:            last_flushed_vv: None,
quantbook-engine/crates/ql-collab/src/session.rs:408:            last_flushed_vv: None,
quantbook-engine/crates/ql-collab/src/session.rs:421:    /// [`flush_to_transport`] internally after the append. Transport
quantbook-engine/crates/ql-collab/src/session.rs:428:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:439:    /// caller-driven so callers can batch multiple `merge_bytes` calls
quantbook-engine/crates/ql-collab/src/session.rs:454:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:455:        let new_len = self.log.merge_bytes(bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:456:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:461:    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
quantbook-engine/crates/ql-collab/src/session.rs:462:    /// OR by `OpLog::merge_bytes` directly).
quantbook-engine/crates/ql-collab/src/session.rs:495:    /// session.merge_bytes(&peer_b_bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:551:    /// Repair is NOT auto-invoked by `merge_bytes` (callers may want
quantbook-engine/crates/ql-collab/src/session.rs:623:    /// [`flush_to_transport`] calls push the session's current
quantbook-engine/crates/ql-collab/src/session.rs:631:    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
quantbook-engine/crates/ql-collab/src/session.rs:637:    pub fn attach_transport<T: Transport + Send + 'static>(
quantbook-engine/crates/ql-collab/src/session.rs:641:        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** reset `last_flushed_vv`
quantbook-engine/crates/ql-collab/src/session.rs:643:        // session's ops, so the next `flush_delta_to_transport` must
quantbook-engine/crates/ql-collab/src/session.rs:647:        self.last_flushed_vv = None;
quantbook-engine/crates/ql-collab/src/session.rs:654:    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
quantbook-engine/crates/ql-collab/src/session.rs:656:        // a subsequent `attach_transport` lands on a clean baseline.
quantbook-engine/crates/ql-collab/src/session.rs:657:        self.last_flushed_vv = None;
quantbook-engine/crates/ql-collab/src/session.rs:673:    /// this session (`append_op`, `merge_bytes`, presence writes,
quantbook-engine/crates/ql-collab/src/session.rs:674:    /// `undo`, `redo`) auto-invoke [`flush_to_transport`] internally
quantbook-engine/crates/ql-collab/src/session.rs:677:    /// Orthogonal to [`attach_transport`]: setting `OnAppend` without
quantbook-engine/crates/ql-collab/src/session.rs:680:    /// `flush_to_transport` API remains available regardless of
quantbook-engine/crates/ql-collab/src/session.rs:700:    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
quantbook-engine/crates/ql-collab/src/session.rs:708:    /// [`flush_delta_to_transport`] (delta path) instead of
quantbook-engine/crates/ql-collab/src/session.rs:709:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
quantbook-engine/crates/ql-collab/src/session.rs:712:    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:719:                let _sent = self.flush_delta_to_transport()?;
quantbook-engine/crates/ql-collab/src/session.rs:750:    /// still call `flush_to_transport` after an explicit batch
quantbook-engine/crates/ql-collab/src/session.rs:752:    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:759:        // `last_flushed_vv` to current. The peer now has everything
quantbook-engine/crates/ql-collab/src/session.rs:760:        // up to this VV; subsequent `flush_delta_to_transport` calls
quantbook-engine/crates/ql-collab/src/session.rs:762:        // update, a mixed-call sequence (`flush_to_transport` then
quantbook-engine/crates/ql-collab/src/session.rs:763:        // `flush_delta_to_transport`) would re-send the snapshot's
quantbook-engine/crates/ql-collab/src/session.rs:766:        self.last_flushed_vv = Some(self.log.oplog_vv());
quantbook-engine/crates/ql-collab/src/session.rs:778:    /// Wire bytes are `LoroDoc::ExportMode::Updates { from: last_flushed_vv }`.
quantbook-engine/crates/ql-collab/src/session.rs:779:    /// The first flush after `attach_transport` (or after `new`)
quantbook-engine/crates/ql-collab/src/session.rs:789:    /// # Mix-and-match with `flush_to_transport`
quantbook-engine/crates/ql-collab/src/session.rs:791:    /// Both APIs maintain the SHARED `last_flushed_vv` field, so
quantbook-engine/crates/ql-collab/src/session.rs:794:    /// - Initial handshake: `flush_to_transport` to seed the peer
quantbook-engine/crates/ql-collab/src/session.rs:796:    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
quantbook-engine/crates/ql-collab/src/session.rs:797:    ///   `flush_delta_to_transport`) sends tiny deltas per
quantbook-engine/crates/ql-collab/src/session.rs:799:    /// - On peer reconnect: caller may choose to `flush_to_transport`
quantbook-engine/crates/ql-collab/src/session.rs:805:    /// Same partial-state contract as `flush_to_transport`:
quantbook-engine/crates/ql-collab/src/session.rs:806:    /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
quantbook-engine/crates/ql-collab/src/session.rs:808:    /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
quantbook-engine/crates/ql-collab/src/session.rs:810:    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:814:        let current_vv = self.log.oplog_vv();
quantbook-engine/crates/ql-collab/src/session.rs:821:        if let Some(last_vv) = self.last_flushed_vv.as_ref() {
quantbook-engine/crates/ql-collab/src/session.rs:826:        // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
quantbook-engine/crates/ql-collab/src/session.rs:827:        let bytes = match self.last_flushed_vv.as_ref() {
quantbook-engine/crates/ql-collab/src/session.rs:828:            Some(from) => self.log.export_delta_bytes(from)?,
quantbook-engine/crates/ql-collab/src/session.rs:831:                .export_delta_bytes(&loro::VersionVector::default())?,
quantbook-engine/crates/ql-collab/src/session.rs:839:        // last_flushed_vv at its prior value so retry sends the
quantbook-engine/crates/ql-collab/src/session.rs:841:        self.last_flushed_vv = Some(current_vv);
quantbook-engine/crates/ql-collab/src/session.rs:867:    /// into `self.log` (low-level `OpLog::merge_bytes`), bypassing
quantbook-engine/crates/ql-collab/src/session.rs:868:    /// `CollabSession::merge_bytes` and therefore
quantbook-engine/crates/ql-collab/src/session.rs:873:    /// onward, call [`flush_to_transport`] explicitly after the
quantbook-engine/crates/ql-collab/src/session.rs:902:                    self.log.merge_bytes(&bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:935:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:969:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:980:    /// from other peers (merged via `merge_bytes`) are NOT
quantbook-engine/crates/ql-collab/src/session.rs:1006:            self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1024:            self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1192:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1339:    fn merge_bytes_grows_log_with_remote_ops() {
quantbook-engine/crates/ql-collab/src/session.rs:1357:        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1476:        peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1507:        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1511:        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1544:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1554:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1931:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1944:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1958:    fn attach_transport_returns_none_when_no_prior() {
quantbook-engine/crates/ql-collab/src/session.rs:1962:        let prior = s.attach_transport(NoopTransport::new());
quantbook-engine/crates/ql-collab/src/session.rs:1968:    fn attach_transport_returns_previous_on_replace() {
quantbook-engine/crates/ql-collab/src/session.rs:1971:        s.attach_transport(NoopTransport::new());
quantbook-engine/crates/ql-collab/src/session.rs:1972:        let prior = s.attach_transport(NoopTransport::new());
quantbook-engine/crates/ql-collab/src/session.rs:1977:    fn detach_transport_returns_box_then_clears() {
quantbook-engine/crates/ql-collab/src/session.rs:1980:        s.attach_transport(NoopTransport::new());
quantbook-engine/crates/ql-collab/src/session.rs:1982:        let detached = s.detach_transport();
quantbook-engine/crates/ql-collab/src/session.rs:1985:        assert!(s.detach_transport().is_none(), "second detach is None");
quantbook-engine/crates/ql-collab/src/session.rs:1989:    fn flush_to_transport_noop_without_attached() {
quantbook-engine/crates/ql-collab/src/session.rs:1991:        let flushed = s.flush_to_transport().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2003:    fn flush_to_transport_pushes_bytes_via_attached() {
quantbook-engine/crates/ql-collab/src/session.rs:2008:        s.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2015:        let flushed = s.flush_to_transport().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2040:        s.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2058:        peer_a.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2060:        peer_b.attach_transport(tx_b);
quantbook-engine/crates/ql-collab/src/session.rs:2064:        peer_a.flush_to_transport().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2071:        peer_b.flush_to_transport().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2078:    fn flush_to_transport_errors_when_transport_closed() {
quantbook-engine/crates/ql-collab/src/session.rs:2089:        s.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2090:        let result = s.flush_to_transport();
quantbook-engine/crates/ql-collab/src/session.rs:2124:        s.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2151:        s.attach_transport(tx_a);
quantbook-engine/crates/ql-collab/src/session.rs:2178:        s.attach_transport(tx_a1);
quantbook-engine/crates/ql-collab/src/session.rs:2179:        assert!(s.flush_to_transport().unwrap());
quantbook-engine/crates/ql-collab/src/session.rs:2181:        let detached1 = s.detach_transport();
quantbook-engine/crates/ql-collab/src/session.rs:2187:        s.attach_transport(tx_a2);
quantbook-engine/crates/ql-collab/src/session.rs:2189:        assert!(s.flush_to_transport().unwrap());
quantbook-engine/crates/ql-collab/src/session.rs:2193:        s.detach_transport();
quantbook-engine/crates/ql-collab/src/session.rs:2205:        s.attach_transport(NoopTransport::new());
quantbook-engine/crates/ql-collab/src/session.rs:2240:        peer_b.merge_bytes(&received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2250:        peer_a.merge_bytes(&b_received).unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '315,370p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '280,330p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   329	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export the delta of
   330	    /// ops added SINCE the given version vector `from`. Uses
   331	    /// `ExportMode::updates(&from)`.
   332	    ///
   333	    /// `from = &VersionVector::default()` (empty VV) is equivalent to
   334	    /// `ExportMode::all_updates()` — sends every op the doc has ever
   335	    /// seen. Use for fresh-peer handshakes.
   336	    ///
   337	    /// `from = &self.oplog_vv()` (current VV) produces a payload with
   338	    /// no new ops — typically an empty / near-empty wire blob. Use
   339	    /// for "did anything happen since last sync" checks.
   340	    ///
   341	    /// Returns the encoded bytes. Loro's `import` transparently
   342	    /// consumes both `Snapshot` and `Updates` blobs on the receiver
   343	    /// side, so the wire format is opaque to peers.
   344	    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
   345	        Ok(self.doc.export(ExportMode::updates(from))?)
   346	    }
   347	
   348	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** read the doc's
   349	    /// current op-log version vector. Cheap (clones an internal
   350	    /// `VersionVector`). Used by [`crate::CollabSession`] to track
   351	    /// per-transport "last successfully flushed" state for delta
   352	    /// exports.
   353	    ///
   354	    /// Wait — `CollabSession` lives in `ql-collab` and depends on
   355	    /// `ql-oplog`, not the other way around. The cross-reference
   356	    /// above is one-way: `CollabSession::flush_delta_to_transport`
   357	    /// calls this accessor. No reverse dependency.
   358	    pub fn oplog_vv(&self) -> loro::VersionVector {
   359	        self.doc.oplog_vv()
   360	    }
   361	
   362	    /// Reconstruct an `OpLog` from a previously-exported snapshot.
   363	    /// If the snapshot doesn't carry our `"ops"` container shape,
   364	    /// subsequent `iter` / `len` calls operate on an empty list
   365	    /// (Loro creates absent root containers on first access).
   366	    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
   367	        let doc = LoroDoc::new();
   368	        doc.import(bytes)?;
   369	        Ok(Self { doc })
   370	    }

 succeeded in 0ms:
   280	    log: OpLog,
   281	    /// Phase 5.4 V1 — peer-local undo/redo.
   282	    ///
   283	    /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
   284	    /// in DECLARATION order, so this drops LAST (after `log`).
   285	    /// That is safe here because `loro::UndoManager` owns its own
   286	    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
   287	    /// borrow from `log`'s doc and won't UAF when `log` drops first.
   288	    undo: loro::UndoManager,
   289	    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
   290	    /// transport. `None` until `attach_transport` is called.
   291	    /// Boxed + `Send` so callers can move sessions between
   292	    /// threads with attached transports.
   293	    ///
   294	    /// V2 V1 scope was explicit-drive (caller invokes flush + poll
   295	    /// on a tick). V2 V2 (2026-05-21) adds `AutoFlushPolicy::OnAppend`
   296	    /// for IDE callers who want every mutator to propagate.
   297	    transport: Option<Box<dyn Transport + Send>>,
   298	    /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy. Default
   299	    /// is `Disabled` so existing V2 V1 callers see no behavior
   300	    /// change. Set via [`set_auto_flush_policy`].
   301	    auto_flush_policy: AutoFlushPolicy,
   302	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** tracks the
   303	    /// `loro::VersionVector` at the time of the last successful
   304	    /// `flush_to_transport` / `flush_delta_to_transport` call.
   305	    ///
   306	    /// `None` means "no successful flush yet" — the next delta-flush
   307	    /// sends from the empty VV (= all ops the doc has ever seen).
   308	    ///
   309	    /// Lifecycle:
   310	    /// - Initialized `None` in `new` + `from_snapshot`.
   311	    /// - Reset to `None` on `attach_transport` (a new transport-peer
   312	    ///   needs the full state from scratch) and `detach_transport`
   313	    ///   (orphaned VV is meaningless).
   314	    /// - Updated to `Some(current_vv)` after a successful send via
   315	    ///   either `flush_to_transport` (full snapshot path) or
   316	    ///   `flush_delta_to_transport` (V2 V3 delta path).
   317	    /// - NOT updated on flush failure (`Err`) — caller can retry.
   318	    last_flushed_vv: Option<loro::VersionVector>,
   319	}
   320	
   321	impl CollabSession {
   322	    /// Construct a fresh session with an empty op log.
   323	    ///
   324	    /// Use this when no shared base snapshot exists yet (the first
   325	    /// peer to open a brand-new workbook). The `peer_id` is wired
   326	    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
   327	    /// CRDT merge metadata attributes this session's appends to
   328	    /// `peer_id` (not Loro's default random per-doc id).
   329	    ///
   330	    /// **Caller pitfalls** (from `OpLog::set_peer_id`):

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '630,845p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   630	    /// **Phase 5.5 V2 V2 (2026-05-21):** V2 V1 was explicit-drive
   631	    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
   632	    /// the opt-in [`AutoFlushPolicy::OnAppend`] for IDE callers who
   633	    /// want every mutator to propagate without scheduling their
   634	    /// own ticks. Default policy remains
   635	    /// [`AutoFlushPolicy::Disabled`] so V2 V1 callers see no
   636	    /// behavior change; switch via [`set_auto_flush_policy`].
   637	    pub fn attach_transport<T: Transport + Send + 'static>(
   638	        &mut self,
   639	        transport: T,
   640	    ) -> Option<Box<dyn Transport + Send>> {
   641	        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** reset `last_flushed_vv`
   642	        // to `None`. A new transport-peer hasn't seen ANY of this
   643	        // session's ops, so the next `flush_delta_to_transport` must
   644	        // send from the empty VV (= all ops). If we kept the stale
   645	        // VV from a prior transport, the new peer would miss ops
   646	        // 0..stale_vv and end up with a corrupt view.
   647	        self.last_flushed_vv = None;
   648	        self.transport.replace(Box::new(transport))
   649	    }
   650	
   651	    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
   652	    /// transport. Returns it for caller cleanup; returns `None`
   653	    /// if no transport was attached.
   654	    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
   655	        // Phase 5.5 V2 V3 step 1: orphaned VV is meaningless. Clear so
   656	        // a subsequent `attach_transport` lands on a clean baseline.
   657	        self.last_flushed_vv = None;
   658	        self.transport.take()
   659	    }
   660	
   661	    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
   662	    /// currently attached.
   663	    pub fn has_transport(&self) -> bool {
   664	        self.transport.is_some()
   665	    }
   666	
   667	    /// **Phase 5.5 V2 V2 (2026-05-21):** set the auto-flush policy
   668	    /// for this session. Returns the previous policy.
   669	    ///
   670	    /// Default is [`AutoFlushPolicy::Disabled`] (V2 V1 behavior:
   671	    /// caller drives flush explicitly). Setting
   672	    /// [`AutoFlushPolicy::OnAppend`] makes every public mutator on
   673	    /// this session (`append_op`, `merge_bytes`, presence writes,
   674	    /// `undo`, `redo`) auto-invoke [`flush_to_transport`] internally
   675	    /// — IDE callers can stop scheduling their own flush ticks.
   676	    ///
   677	    /// Orthogonal to [`attach_transport`]: setting `OnAppend` without
   678	    /// a transport is harmless (auto-flush is silently a no-op until
   679	    /// a transport is attached). Conversely, the explicit
   680	    /// `flush_to_transport` API remains available regardless of
   681	    /// policy — callers can mix-and-match.
   682	    ///
   683	    /// **Partial-state contract**: if an auto-flush attempt fails
   684	    /// (transport closed, I/O error), the surrounding mutator
   685	    /// returns `Err(CollabSessionError::Transport(_))`. The local
   686	    /// mutation is ALREADY committed at that point — see
   687	    /// [`AutoFlushPolicy::OnAppend`] for the full contract.
   688	    pub fn set_auto_flush_policy(&mut self, policy: AutoFlushPolicy) -> AutoFlushPolicy {
   689	        std::mem::replace(&mut self.auto_flush_policy, policy)
   690	    }
   691	
   692	    /// **Phase 5.5 V2 V2 (2026-05-21):** read the current auto-flush
   693	    /// policy. Default is [`AutoFlushPolicy::Disabled`].
   694	    pub fn auto_flush_policy(&self) -> AutoFlushPolicy {
   695	        self.auto_flush_policy
   696	    }
   697	
   698	    /// **Phase 5.5 V2 V2 (2026-05-21):** internal hook called by every
   699	    /// public mutator after a successful state change. Fires
   700	    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
   701	    /// is attached; otherwise no-op.
   702	    ///
   703	    /// Errors propagate to the caller; the local mutation is already
   704	    /// committed at the point this is called (per the partial-state
   705	    /// contract documented at [`AutoFlushPolicy::OnAppend`]).
   706	    ///
   707	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** routes through
   708	    /// [`flush_delta_to_transport`] (delta path) instead of
   709	    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
   710	    /// now O(ops since last flush) instead of O(state); a flush
   711	    /// after no state change short-circuits to `Ok(false)`.
   712	    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
   713	        match self.auto_flush_policy {
   714	            AutoFlushPolicy::Disabled => Ok(()),
   715	            AutoFlushPolicy::OnAppend => {
   716	                if self.transport.is_none() {
   717	                    return Ok(());
   718	                }
   719	                let _sent = self.flush_delta_to_transport()?;
   720	                Ok(())
   721	            }
   722	        }
   723	    }
   724	
   725	    /// **Phase 5.5 V2 V1 (2026-05-19):** export the current
   726	    /// session snapshot and push it through the attached
   727	    /// transport. No-op (returns `Ok(false)`) if no transport
   728	    /// attached.
   729	    ///
   730	    /// Returns `Ok(true)` if bytes were sent. Errors:
   731	    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
   732	    ///   fails (Loro encode error).
   733	    /// - `CollabSessionError::Transport` if `Transport::send`
   734	    ///   fails (Closed, Io).
   735	    ///
   736	    /// In both error cases the local `OpLog` is unaffected
   737	    /// (export runs first, send is the last step). Caller can
   738	    /// retry the flush after addressing the underlying cause.
   739	    ///
   740	    /// V2 V1 sends the FULL snapshot each call (O(state)). V2 V3
   741	    /// will track per-transport version vectors and send deltas
   742	    /// only.
   743	    ///
   744	    /// **Phase 5.5 V2 V2 (2026-05-21):** this method remains
   745	    /// available for explicit-drive callers regardless of
   746	    /// [`auto_flush_policy`]. With `OnAppend`, [`append_op`] etc.
   747	    /// invoke this internally — calling it directly is harmless
   748	    /// (just sends an extra idempotent snapshot). Mix-and-match
   749	    /// is supported: set `OnAppend` for steady-state appends but
   750	    /// still call `flush_to_transport` after an explicit batch
   751	    /// operation if you want a deterministic flush point.
   752	    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   753	        let Some(transport) = self.transport.as_mut() else {
   754	            return Ok(false);
   755	        };
   756	        let bytes = self.log.export_bytes()?;
   757	        transport.send(&bytes)?;
   758	        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** advance
   759	        // `last_flushed_vv` to current. The peer now has everything
   760	        // up to this VV; subsequent `flush_delta_to_transport` calls
   761	        // send only ops appended AFTER this point. Without this
   762	        // update, a mixed-call sequence (`flush_to_transport` then
   763	        // `flush_delta_to_transport`) would re-send the snapshot's
   764	        // contents as a delta — wasted bandwidth, no correctness
   765	        // issue (Loro dedupes on import).
   766	        self.last_flushed_vv = Some(self.log.oplog_vv());
   767	        Ok(true)
   768	    }
   769	
   770	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export and send the
   771	    /// DELTA of ops added since the last successful flush to the
   772	    /// attached transport. Returns `Ok(true)` if bytes were sent,
   773	    /// `Ok(false)` if no transport is attached OR if no ops have
   774	    /// been appended since the last flush (idempotency short-
   775	    /// circuit — closes V2 V2 audit M2/M3 echo-loop class for
   776	    /// step 2's `poll_remote` auto-flush wiring).
   777	    ///
   778	    /// Wire bytes are `LoroDoc::ExportMode::Updates { from: last_flushed_vv }`.
   779	    /// The first flush after `attach_transport` (or after `new`)
   780	    /// sends from the empty VV — equivalent to `all_updates()` —
   781	    /// delivering the full history to the new transport-peer.
   782	    /// Subsequent flushes send only the delta since the prior flush.
   783	    ///
   784	    /// Loro's `LoroDoc::import` transparently consumes both
   785	    /// `Snapshot` and `Updates` blobs, so the wire format is opaque
   786	    /// to peers — switching from snapshots to deltas is a
   787	    /// SENDER-SIDE optimization with NO PEER-SIDE CHANGES required.
   788	    ///
   789	    /// # Mix-and-match with `flush_to_transport`
   790	    ///
   791	    /// Both APIs maintain the SHARED `last_flushed_vv` field, so
   792	    /// callers can interleave full snapshots and deltas freely. A
   793	    /// typical pattern:
   794	    /// - Initial handshake: `flush_to_transport` to seed the peer
   795	    ///   with full state.
   796	    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
   797	    ///   `flush_delta_to_transport`) sends tiny deltas per
   798	    ///   mutation.
   799	    /// - On peer reconnect: caller may choose to `flush_to_transport`
   800	    ///   again as a safety net (Loro deduplicates on import; no
   801	    ///   harm even if the peer already has those ops).
   802	    ///
   803	    /// # Error handling
   804	    ///
   805	    /// Same partial-state contract as `flush_to_transport`:
   806	    /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
   807	    /// - `CollabSessionError::Transport` on `send` failure (Closed, Io).
   808	    /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
   809	    ///   the same delta the failed call would have sent.
   810	    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   811	        if self.transport.is_none() {
   812	            return Ok(false);
   813	        }
   814	        let current_vv = self.log.oplog_vv();
   815	        // Idempotency short-circuit: no state change since last flush.
   816	        // Closes V2 V2 audit M2/M3 (echo-loop). NOTE: VersionVector
   817	        // equality is by value (Loro impls PartialEq via the
   818	        // underlying op count per peer); a session that hasn't
   819	        // appended/merged anything since the prior flush returns
   820	        // Ok(false) without invoking transport.send.
   821	        if let Some(last_vv) = self.last_flushed_vv.as_ref() {
   822	            if last_vv == &current_vv {
   823	                return Ok(false);
   824	            }
   825	        }
   826	        // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
   827	        let bytes = match self.last_flushed_vv.as_ref() {
   828	            Some(from) => self.log.export_delta_bytes(from)?,
   829	            None => self
   830	                .log
   831	                .export_delta_bytes(&loro::VersionVector::default())?,
   832	        };
   833	        // Now borrow transport mutably for the send. Done in two
   834	        // phases because we needed self.log (immut) above and need
   835	        // self.transport (mut) here — borrow-checker dance.
   836	        let transport = self.transport.as_mut().expect("just-checked is_some above");
   837	        transport.send(&bytes)?;
   838	        // Advance the VV checkpoint. Only on success — Err leaves
   839	        // last_flushed_vv at its prior value so retry sends the
   840	        // same delta.
   841	        self.last_flushed_vv = Some(current_vv);
   842	        Ok(true)
   843	    }
   844	
   845	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '445,462p;925,940p;960,975p;998,1030p;1185,1195p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   445	    /// as `#NAME?` at recompute time.
   446	    ///
   447	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
   448	    /// [`auto_flush_policy`]. After merging peer ops the local snapshot
   449	    /// contains the union; auto-flushing it propagates the union to
   450	    /// any third-party peer attached via the transport (3+ peer fanout
   451	    /// via this session's transport endpoint). Same partial-state
   452	    /// contract as `append_op` if the auto-flush fails — the local
   453	    /// merge is already committed.
   454	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
   455	        let new_len = self.log.merge_bytes(bytes)?;
   456	        self.maybe_auto_flush()?;
   457	        Ok(new_len)
   458	    }
   459	
   460	    /// Produce a Loro snapshot blob suitable for **transport to other
   461	    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
   462	    /// OR by `OpLog::merge_bytes` directly).
   925	    ///
   926	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
   927	    /// [`auto_flush_policy`]. Partial-state contract on flush
   928	    /// failure: the presence write is already committed to
   929	    /// `self.log` when the auto-flush attempt runs — same shape
   930	    /// as `append_op` (see [`AutoFlushPolicy::OnAppend`]).
   931	    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
   932	        let key = presence::peer_key(self.peer_id);
   933	        let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
   934	        self.log.presence_set(&key, &json)?;
   935	        self.maybe_auto_flush()?;
   936	        Ok(())
   937	    }
   938	
   939	    /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
   940	    /// presence state. Returns `Ok(None)` if the peer has never
   960	    /// `Ok(None)`.
   961	    ///
   962	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
   963	    /// [`auto_flush_policy`]. Same partial-state contract as
   964	    /// `update_presence` — the removal is committed locally
   965	    /// before the auto-flush attempt.
   966	    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
   967	        let key = presence::peer_key(self.peer_id);
   968	        self.log.presence_remove(&key)?;
   969	        self.maybe_auto_flush()?;
   970	        Ok(())
   971	    }
   972	
   973	    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
   974	    /// local op. Loro's `UndoManager` semantically inverts it by
   975	    /// appending an inverse op (NOT by physical removal). Returns
   998	        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
   999	        // auto-flush when an undo item was actually consumed. The prior
  1000	        // "flush unconditionally" pattern turned `Ok(false)` into
  1001	        // `Err(Transport(_))` when the transport was closed AND the
  1002	        // undo stack was empty — spurious failure semantics. With the
  1003	        // gate, `undo` on an empty stack stays `Ok(false)` regardless
  1004	        // of transport state (no mutation, no flush attempt).
  1005	        if consumed {
  1006	            self.maybe_auto_flush()?;
  1007	        }
  1008	        Ok(consumed)
  1009	    }
  1010	
  1011	    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
  1012	    /// Returns `Ok(true)` if a redo stack item was consumed,
  1013	    /// `Ok(false)` if the stack was empty.
  1014	    ///
  1015	    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** matches
  1016	    /// [`undo`] — auto-flush fires only when `consumed == true`.
  1017	    /// Partial-state contract on flush failure when consumed:
  1018	    /// the redo's appended op is already in `self.log` (mutate-
  1019	    /// then-flush).
  1020	    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
  1021	        let consumed = self.undo.redo()?;
  1022	        // Phase 5.5 V2 V2 audit closure (Codex M2): gate matches `undo`.
  1023	        if consumed {
  1024	            self.maybe_auto_flush()?;
  1025	        }
  1026	        Ok(consumed)
  1027	    }
  1028	
  1029	    /// **Phase 5.4 V1 (2026-05-19):** true iff the undo stack has
  1030	    /// at least one item.
  1185	        let count = keys.len();
  1186	        for key in keys {
  1187	            self.log.presence_remove(&key)?;
  1188	        }
  1189	        // Phase 5.5 V2 V2: single auto-flush after the batch removal,
  1190	        // not per-key. Sending N intermediate snapshots would be wasted
  1191	        // bandwidth (peers only need the final post-sweep state).
  1192	        self.maybe_auto_flush()?;
  1193	        Ok(count)
  1194	    }
  1195	

codex
The core implementation is a session-wide checkpoint, not a true per-detached-transport baseline. That matches the current single-attached-transport API, but I’m checking whether any behavior or docs overstate “per-transport” beyond that.
exec
/bin/zsh -lc 'nl -ba quantbook-engine/crates/ql-collab/tests/auto_flush.rs | tail -n 360' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   610	    assert_eq!(
   611	        observer.pending_recv(),
   612	        1,
   613	        "flip-back to Disabled MUST stop auto-flush — no new sends"
   614	    );
   615	    // But explicit flush still works for V2 V1 callers.
   616	    peer_a.flush_to_transport().unwrap();
   617	    assert_eq!(
   618	        observer.pending_recv(),
   619	        2,
   620	        "explicit flush_to_transport remains available regardless of policy"
   621	    );
   622	}
   623	
   624	// ===== Accessor methods must NOT trigger auto-flush =====
   625	
   626	#[test]
   627	fn accessor_methods_do_not_trigger_auto_flush() {
   628	    let (tx_a, observer) = LoopbackTransport::pair();
   629	    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
   630	    peer_a.append_op(add_sheet()).unwrap();
   631	    peer_a
   632	        .update_presence(PresenceState::at_cell(0, 0, 0))
   633	        .unwrap();
   634	    peer_a.attach_transport(tx_a);
   635	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   636	
   637	    assert_eq!(observer.pending_recv(), 0);
   638	
   639	    // None of these should trigger auto-flush — they're all read-only.
   640	    let _ = peer_a.peer_id();
   641	    let _ = peer_a.op_count();
   642	    let _ = peer_a.is_empty();
   643	    let _ = peer_a.auto_flush_policy();
   644	    let _ = peer_a.has_transport();
   645	    let _ = peer_a.op_log();
   646	    let _ = peer_a.can_undo();
   647	    let _ = peer_a.can_redo();
   648	    let _ = peer_a.undo_count();
   649	    let _ = peer_a.redo_count();
   650	    let _ = peer_a.peer_presence(PeerId::new(1)).unwrap();
   651	    let _ = peer_a.peers_with_presence().unwrap();
   652	    let _ = peer_a.export_bytes().unwrap();
   653	
   654	    assert_eq!(
   655	        observer.pending_recv(),
   656	        0,
   657	        "no accessor method may trigger auto-flush"
   658	    );
   659	}
   660	
   661	// ============================================================
   662	// Phase 5.5 V2 V3 step 1 — version-vector tracking + delta flush
   663	// ============================================================
   664	
   665	#[test]
   666	fn delta_flush_first_call_sends_all_ops_with_no_transport_baseline() {
   667	    // First `flush_delta_to_transport` after attach_transport sends
   668	    // from the EMPTY version vector (no `last_flushed_vv` yet), which
   669	    // is equivalent to `all_updates()` — the new transport-peer
   670	    // receives every op the session has ever appended. Subsequent
   671	    // peers can import the bytes and reconstruct the full state.
   672	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   673	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   674	    s.append_op(add_sheet()).unwrap();
   675	    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
   676	
   677	    s.attach_transport(tx_a);
   678	    assert_eq!(tx_b.pending_recv(), 0, "attach alone doesn't flush");
   679	
   680	    let sent = s.flush_delta_to_transport().unwrap();
   681	    assert!(sent, "first delta flush MUST send (no last_flushed_vv yet)");
   682	    assert_eq!(tx_b.pending_recv(), 1);
   683	
   684	    let bytes = tx_b.try_recv().unwrap().expect("first-flush bytes");
   685	    assert!(!bytes.is_empty());
   686	    // Verify peer can reconstruct the full state from these bytes.
   687	    let imported = ql_oplog::OpLog::import_bytes(&bytes).unwrap();
   688	    assert_eq!(
   689	        imported.len(),
   690	        2,
   691	        "first delta flush carries all 2 ops; peer reconstructs full state from empty-VV baseline"
   692	    );
   693	}
   694	
   695	#[test]
   696	fn delta_flush_idempotency_short_circuits_when_no_state_change() {
   697	    // After a successful flush, calling flush_delta_to_transport
   698	    // AGAIN with no mutation in between returns Ok(false) WITHOUT
   699	    // invoking transport.send. Closes V2 V2 audit M2/M3 echo-loop
   700	    // concern: a peer auto-flushing after an idempotent merge is a
   701	    // no-op when state didn't actually advance.
   702	    let (tx_a, observer) = LoopbackTransport::pair();
   703	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   704	    s.append_op(add_sheet()).unwrap();
   705	    s.attach_transport(tx_a);
   706	
   707	    let sent1 = s.flush_delta_to_transport().unwrap();
   708	    assert!(sent1);
   709	    assert_eq!(observer.pending_recv(), 1);
   710	
   711	    // Second call: no mutation in between → short-circuit.
   712	    let sent2 = s.flush_delta_to_transport().unwrap();
   713	    assert!(!sent2, "idempotent flush MUST short-circuit to Ok(false)");
   714	    assert_eq!(
   715	        observer.pending_recv(),
   716	        1,
   717	        "transport.send MUST NOT be invoked on idempotent flush"
   718	    );
   719	
   720	    // Third call after a mutation: state advanced, so it fires again.
   721	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   722	    let sent3 = s.flush_delta_to_transport().unwrap();
   723	    assert!(sent3, "post-mutation flush MUST send");
   724	    assert_eq!(observer.pending_recv(), 2);
   725	}
   726	
   727	#[test]
   728	fn delta_flush_subsequent_calls_send_only_new_ops() {
   729	    // Second flush carries DELTA from the first's VV checkpoint,
   730	    // not the full state. Asserted by: importing the second's bytes
   731	    // standalone produces a doc with ONLY the post-first-flush ops
   732	    // (the first-flush ops are missing because they're before the
   733	    // delta's `from`).
   734	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   735	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   736	    s.append_op(add_sheet()).unwrap();
   737	    s.attach_transport(tx_a);
   738	
   739	    s.flush_delta_to_transport().unwrap();
   740	    let _first_bytes = tx_b.try_recv().unwrap().unwrap();
   741	
   742	    // Append more ops; flush delta.
   743	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   744	    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
   745	    s.flush_delta_to_transport().unwrap();
   746	    let second_bytes = tx_b.try_recv().unwrap().unwrap();
   747	
   748	    // Importing second_bytes into a FRESH doc — without seeing
   749	    // first_bytes — should produce a partial state (2 ops, no
   750	    // AddSheet). Loro's import accepts the delta and applies it,
   751	    // but the AddSheet op is BEFORE the delta's `from` VV so it
   752	    // doesn't appear.
   753	    //
   754	    // Actual Loro behavior: import of update bytes WITHOUT the
   755	    // baseline may error (missing dependencies). Acceptable test:
   756	    // import BOTH blobs and verify the final state has all 3 ops.
   757	    let mut fresh = ql_oplog::OpLog::new();
   758	    fresh.merge_bytes(&_first_bytes).unwrap();
   759	    fresh.merge_bytes(&second_bytes).unwrap();
   760	    assert_eq!(
   761	        fresh.len(),
   762	        3,
   763	        "delta-chain reconstruction: first + second flush together yield 3 ops total"
   764	    );
   765	}
   766	
   767	#[test]
   768	fn attach_transport_resets_last_flushed_vv() {
   769	    // Detach + reattach (or attach a NEW transport) MUST reset the
   770	    // VV so the new peer receives the full state from scratch.
   771	    // Without the reset, the second peer would only receive
   772	    // post-attach ops and miss everything that happened before.
   773	    let (tx_a1, mut tx_b1) = LoopbackTransport::pair();
   774	    let (tx_a2, mut tx_b2) = LoopbackTransport::pair();
   775	
   776	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   777	    s.append_op(add_sheet()).unwrap();
   778	    s.attach_transport(tx_a1);
   779	
   780	    s.flush_delta_to_transport().unwrap();
   781	    let first_peer_bytes = tx_b1.try_recv().unwrap().expect("first peer got bytes");
   782	
   783	    // Reconstruct what first peer sees.
   784	    let mut first_peer_view = ql_oplog::OpLog::new();
   785	    first_peer_view.merge_bytes(&first_peer_bytes).unwrap();
   786	    assert_eq!(first_peer_view.len(), 1, "first peer sees 1 op");
   787	
   788	    // Now append more ops, detach, and reattach a FRESH transport.
   789	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   790	    s.detach_transport();
   791	    s.attach_transport(tx_a2);
   792	
   793	    // The next delta flush MUST send EVERYTHING (both ops) because
   794	    // the new peer hasn't seen anything yet.
   795	    s.flush_delta_to_transport().unwrap();
   796	    let second_peer_bytes = tx_b2.try_recv().unwrap().expect("second peer got bytes");
   797	
   798	    let mut second_peer_view = ql_oplog::OpLog::new();
   799	    second_peer_view.merge_bytes(&second_peer_bytes).unwrap();
   800	    assert_eq!(
   801	        second_peer_view.len(),
   802	        2,
   803	        "second peer MUST see ALL ops (attach reset the VV — no carryover)"
   804	    );
   805	}
   806	
   807	#[test]
   808	fn flush_to_transport_full_snapshot_path_still_works_and_updates_vv() {
   809	    // The V2 V1 `flush_to_transport` method remains available + sends
   810	    // full snapshots. V2 V3 also updates last_flushed_vv on success,
   811	    // so a subsequent flush_delta_to_transport doesn't re-send the
   812	    // snapshot's content.
   813	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   814	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   815	    s.append_op(add_sheet()).unwrap();
   816	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   817	    s.attach_transport(tx_a);
   818	
   819	    // Full snapshot flush.
   820	    let sent = s.flush_to_transport().unwrap();
   821	    assert!(sent);
   822	    let snapshot_bytes = tx_b.try_recv().unwrap().unwrap();
   823	    let mut peer_view = ql_oplog::OpLog::new();
   824	    peer_view.merge_bytes(&snapshot_bytes).unwrap();
   825	    assert_eq!(peer_view.len(), 2);
   826	
   827	    // Now subsequent flush_delta_to_transport should short-circuit
   828	    // because last_flushed_vv now matches current_vv.
   829	    let sent2 = s.flush_delta_to_transport().unwrap();
   830	    assert!(
   831	        !sent2,
   832	        "flush_to_transport MUST update last_flushed_vv so subsequent delta flush is idempotent"
   833	    );
   834	    assert_eq!(tx_b.pending_recv(), 0);
   835	
   836	    // Append a new op; delta flush sends only that.
   837	    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
   838	    s.flush_delta_to_transport().unwrap();
   839	    let delta_bytes = tx_b.try_recv().unwrap().unwrap();
   840	    peer_view.merge_bytes(&delta_bytes).unwrap();
   841	    assert_eq!(
   842	        peer_view.len(),
   843	        3,
   844	        "mix-and-match: snapshot then delta produces correct final state on peer"
   845	    );
   846	}
   847	
   848	#[test]
   849	fn on_append_uses_delta_path_under_v2_v3() {
   850	    // V2 V3 step 1 reroutes maybe_auto_flush through
   851	    // flush_delta_to_transport. After N appends under OnAppend,
   852	    // each wire blob is a delta (small) not a full snapshot. The
   853	    // user-visible behavior is the same — peers reconstruct the
   854	    // full state — but bandwidth scales O(per-op delta) instead
   855	    // of O(state).
   856	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   857	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   858	    s.attach_transport(tx_a);
   859	    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   860	
   861	    s.append_op(add_sheet()).unwrap();
   862	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   863	    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
   864	
   865	    // Three appends → three auto-flushes, each a delta.
   866	    assert_eq!(
   867	        tx_b.pending_recv(),
   868	        3,
   869	        "OnAppend fires once per mutator (delta path doesn't change the fire count)"
   870	    );
   871	
   872	    // Drain all three and reconstruct on peer side.
   873	    let mut peer = ql_oplog::OpLog::new();
   874	    for _ in 0..3 {
   875	        let bytes = tx_b.try_recv().unwrap().expect("delta bytes");
   876	        peer.merge_bytes(&bytes).unwrap();
   877	    }
   878	    assert_eq!(
   879	        peer.len(),
   880	        3,
   881	        "peer reconstructs full state from chained deltas"
   882	    );
   883	}
   884	
   885	#[test]
   886	fn delta_flush_with_no_transport_returns_ok_false() {
   887	    // Sanity: with no transport attached, flush_delta_to_transport
   888	    // is a no-op (matches flush_to_transport semantics).
   889	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   890	    s.append_op(add_sheet()).unwrap();
   891	    let sent = s.flush_delta_to_transport().unwrap();
   892	    assert!(!sent, "no transport → Ok(false) without invoking anything");
   893	}
   894	
   895	#[test]
   896	fn delta_flush_failure_does_not_advance_vv_so_retry_resends() {
   897	    // Partial-state contract: on transport.send Err, last_flushed_vv
   898	    // is NOT updated. A successful retry sends the same delta the
   899	    // failed call would have sent. Use NoopTransport closed-state to
   900	    // simulate the failure.
   901	    let mut bad = NoopTransport::new();
   902	    bad.close();
   903	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   904	    s.append_op(add_sheet()).unwrap();
   905	    s.attach_transport(bad);
   906	
   907	    let result = s.flush_delta_to_transport();
   908	    assert!(
   909	        matches!(
   910	            result,
   911	            Err(CollabSessionError::Transport(TransportError::Closed))
   912	        ),
   913	        "closed transport MUST surface Err; got {result:?}"
   914	    );
   915	
   916	    // last_flushed_vv NOT advanced — but we can't easily inspect it
   917	    // directly (private field). Instead, retry with a fresh
   918	    // (working) transport and assert the bytes sent contain the op.
   919	    s.detach_transport();
   920	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   921	    s.attach_transport(tx_a);
   922	    // attach_transport resets last_flushed_vv to None, so this
   923	    // tests a different property than the original intent.
   924	    // Re-frame: assert that the prior failure didn't corrupt state.
   925	    s.flush_delta_to_transport().unwrap();
   926	    let bytes = tx_b.try_recv().unwrap().unwrap();
   927	    let mut peer = ql_oplog::OpLog::new();
   928	    peer.merge_bytes(&bytes).unwrap();
   929	    assert_eq!(
   930	        peer.len(),
   931	        1,
   932	        "post-failure recovery: the op IS still in the local log + flushable"
   933	    );
   934	}
   935	
   936	#[test]
   937	fn delta_flush_after_merge_bytes_sends_merged_state_to_third_peer() {
   938	    // Hub scenario simplified: peer A (hub) has a transport to peer
   939	    // C. A merges peer B's bytes (via direct merge_bytes call —
   940	    // simulating B handing A bytes through some other channel).
   941	    // A's flush_delta_to_transport then sends the merged state to
   942	    // peer C. This is the V2 V2 merge_bytes auto-flush behavior
   943	    // continuing to work under V2 V3 delta semantics.
   944	    let (tx_ac_a, mut tx_ac_c) = LoopbackTransport::pair();
   945	
   946	    // Build peer B with one op + export.
   947	    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
   948	    peer_b.append_op(add_sheet()).unwrap();
   949	    let b_bytes = peer_b.export_bytes().unwrap();
   950	
   951	    // Hub: append own op, attach transport to C, merge B's bytes,
   952	    // verify C sees both hub + B ops.
   953	    let mut hub = CollabSession::new(PeerId::new(1)).unwrap();
   954	    hub.append_op(put_value(0, 5, 5, 99.0)).unwrap();
   955	    hub.attach_transport(tx_ac_a);
   956	    hub.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   957	
   958	    hub.merge_bytes(&b_bytes).unwrap();
   959	    // merge_bytes auto-fires flush_delta_to_transport. C now sees
   960	    // hub's existing op + B's op.
   961	    let bytes = tx_ac_c.try_recv().unwrap().expect("hub auto-flushed");
   962	    let mut peer_c = ql_oplog::OpLog::new();
   963	    peer_c.merge_bytes(&bytes).unwrap();
   964	    assert!(
   965	        peer_c.len() >= 2,
   966	        "peer C MUST see hub's op + B's op via the hub's auto-flush: got {}",
   967	        peer_c.len()
   968	    );
   969	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/transport.rs | sed -n '1,70p;155,190p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
     4	//! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
     5	//! shipped — in-process paired endpoints for 2-peer tests.
     6	//! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
     7	//! `CollabSession` exposes 5 typed transport methods
     8	//! (`attach_transport` / `detach_transport` / `has_transport` /
     9	//! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
    10	//! V2 V1 is "explicit drive" — caller invokes flush + poll on a
    11	//! tick.
    12	//! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
    13	//! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
    14	//! after every mutator. Default is `Disabled` (V2 V1 behavior
    15	//! preserved). See [`crate::AutoFlushPolicy`] +
    16	//! [`crate::CollabSession::set_auto_flush_policy`].
    17	//! **Phase 5.5 V2 V3 step 1 (2026-05-21, this ship):** per-transport
    18	//! version-vector tracking + delta flushes. New
    19	//! `CollabSession::flush_delta_to_transport` sends only the delta
    20	//! since the last successful flush, using
    21	//! `LoroDoc::ExportMode::Updates`. Auto-flush now routes through
    22	//! this delta path — wire payload is O(per-op delta) instead of
    23	//! O(full state). Includes an idempotency short-circuit (no
    24	//! state change → no send), which closes the V2 V2 audit
    25	//! echo-loop concern.
    26	//! **Phase 5.5 V2 V3 remaining (pending):** poll_remote auto-flush
    27	//! wiring (step 2) + offline-write queue (step 3) + WebSocket impl
    28	//! (step 4) + reconnect / offline sync semantics.
    29	//!
    30	//! Tests can also use [`NoopTransport`] which discards traffic.
    31	//!
    32	//! The contract is intentionally minimal:
    33	//!
    34	//! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
    35	//!   Bytes are an opaque blob (a Loro export). The transport
    36	//!   doesn't interpret them.
    37	//! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
    38	//!   receive. Returns `None` if no bytes are queued.
    39	//!
    40	//! That's enough to plumb a `CollabSession::export_bytes` →
    41	//! transport → remote `CollabSession::merge_bytes` flow. The
    42	//! transport handles framing / reliability / reconnect / auth as
    43	//! its implementation details.
    44	
    45	use std::collections::VecDeque;
    46	use std::sync::atomic::{AtomicBool, Ordering};
    47	use std::sync::{Arc, Mutex};
    48	
    49	use thiserror::Error;
    50	
    51	/// Errors emitted by `Transport` impls.
    52	#[derive(Debug, Error)]
    53	#[non_exhaustive]
    54	pub enum TransportError {
    55	    /// The underlying I/O failed (socket dead, network partition,
    56	    /// etc.). Implementations should distinguish recoverable
    57	    /// (reconnect) from permanent (auth rejected) failures via
    58	    /// variant structure in their own error type, then map to this
    59	    /// variant at the trait boundary if they don't want to expose
    60	    /// implementation details.
    61	    #[error("transport I/O error: {0}")]
    62	    Io(String),
    63	
    64	    /// The transport is closed and no further sends are accepted.
    65	    /// Receivers should still drain any already-queued bytes via
    66	    /// `try_recv` before considering the channel done.
    67	    #[error("transport closed")]
    68	    Closed,
    69	}
    70	
   155	/// endpoints `(a, b)` where `a.send(bytes)` lands in `b`'s recv
   156	/// queue and vice versa. The two endpoints share two
   157	/// `Arc<Mutex<VecDeque<Vec<u8>>>>` channels via interior
   158	/// mutability — `Send + Sync` so they can also be used across
   159	/// threads if a future test wants that.
   160	///
   161	/// ## Use case
   162	///
   163	/// Wire two `CollabSession`s together for tests like:
   164	/// ```ignore
   165	/// let (mut tx_a, mut tx_b) = LoopbackTransport::pair();
   166	/// let session_a = CollabSession::new(PeerId::new(1))?;
   167	/// let session_b = CollabSession::new(PeerId::new(2))?;
   168	/// // ... append ops on a, drain via tx_a.send / tx_b.try_recv ...
   169	/// ```
   170	///
   171	/// **Phase 5.5 V2 V2 (2026-05-21):** `CollabSession` supports
   172	/// opt-in auto-flush via `AutoFlushPolicy::OnAppend` — every
   173	/// session mutator (`append_op`, `merge_bytes`, presence writes,
   174	/// `undo` / `redo` when consumed, `sweep_presence`) then sends
   175	/// through the attached transport automatically. Default policy
   176	/// remains `Disabled` (V2 V1 explicit-drive behavior). Tests can
   177	/// still drive the flow manually: append, export_bytes, send via
   178	/// the transport, recv on the other side, merge_bytes — useful
   179	/// when the test wants deterministic control over when bytes
   180	/// land on the wire (e.g. ordering tests). `poll_remote` does
   181	/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
   182	/// the rationale.
   183	///
   184	/// ## Close semantics
   185	///
   186	/// Each endpoint has its OWN `closed` flag (separate
   187	/// `AtomicBool`). `a.close()` shuts down endpoint A:
   188	/// - A's `send` returns `TransportError::Closed` immediately.
   189	/// - A's `try_recv` drains any already-queued bytes FIRST and
   190	///   only returns `Closed` once the queue is empty (per the

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/ide-consumer-contract.md | sed -n '1,200p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	# IDE consumer contract
     2	
     3	**Status:** Engine Phase 2B.6 — first vertical-slice surface  
     4	**Date:** 2026-05-12  
     5	**Stability:** **DRAFT** — names + shapes will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden.
     6	
     7	This document describes how the Quantlab IDE (`extensions/quantlab/`, a separate worktree) consumes the Quantbook engine. It is informed by the IDE-2B-01..05 acceptance criteria in `docs/MASTER-PLAN.md` Phase 2B.6 and exercised in `crates/ql-exec/tests/ide_simulation.rs`.
     8	
     9	## 1. Lifecycle (one workbook session)
    10	
    11	```text
    12	                                         ┌────────────────────────────┐
    13	   IDE opens .qbook                      │ engine state:              │
    14	   ────────────►  load_workbook_with_oplog─►  Workbook + OpLog        │
    15	                                         └────────────┬───────────────┘
    16	                                                      │
    17	                                                      ▼
    18	   user types in formula bar / pastes   ┌────────────────────────────┐
    19	   ──────────────────────────────────►  │ per-edit:                  │
    20	                                         │   WorkbookRuntime::with_oplog
    21	                                         │   .set_value / .set_formula│
    22	                                         │   .transaction().commit()  │
    23	                                         └────────────┬───────────────┘
    24	                                                      │ (mutates wb, appends ops)
    25	                                                      ▼
    26	   user saves                            ┌────────────────────────────┐
    27	   ──────────────────────────────────►  │ save_workbook_with_oplog   │
    28	                                         └────────────┬───────────────┘
    29	                                                      │
    30	   user reopens                                       ▼
    31	   ──────────────────────────────────►  load_workbook_with_oplog → restored
    32	```
    33	
    34	The IDE holds three pieces of state per open workbook:
    35	
    36	| State | Type | Lifetime |
    37	|---|---|---|
    38	| `wb` | `ql_storage::Workbook` | Open until save / close |
    39	| `oplog` | `ql_oplog::OpLog` | Open until save / close. Carries mutation history. |
    40	| `registry` | `ql_functions::FunctionRegistry` | Process-wide singleton (`default_registry()`) |
    41	
    42	`WorkbookRuntime` is **per-edit**, not per-session. It borrows `&mut wb` + `&reg` + `&mut oplog` for the duration of one user action (one set_formula call, one paste transaction, one recompute). Borrowing `&mut wb` for the runtime's lifetime prevents the IDE from reading the workbook through other paths while an edit is in flight — that's intentional. The IDE typically constructs a runtime, performs ONE operation, drops the runtime, then re-reads cells for grid rendering.
    43	
    44	Engine Phase 6.1 will formalize this as a `WorkbookSession` struct that owns wb + oplog + registry, exposing edit methods directly without the borrow dance. 2B.6 doesn't ship that — the test scaffolding in `ide_simulation.rs` documents the pattern.
    45	
    46	## 2. Operations the IDE invokes
    47	
    48	### 2.1 Open / load
    49	
    50	```rust
    51	let (wb, oplog) = ql_io::load_workbook_with_oplog(path)?;
    52	```
    53	
    54	- Loads the `.qbook/` directory.
    55	- `oplog.bin` MUST be present (Phase 2A.3.c contract; load fails with `MissingFile` otherwise).
    56	- The IDE then renders the grid by walking cells via `wb.sheet(id)?.read(row, col)` for each visible cell, and `wb.formula_at(sheet, row, col)` for the formula bar.
    57	
    58	**Tier D2 (2026-05-19, `e15e8908742`):** the persistence API moved from `ql_oplog::{load,save}_workbook_with_oplog` to `ql_io::{load,save}_workbook_with_oplog`. The old import paths fail to compile.
    59	
    60	If the workbook has no op log (legacy save or external tool), use the bare `ql_io::load_workbook(path)` and construct a fresh empty `OpLog::new()` — but note that subsequent saves via `ql_io::save_workbook_with_oplog` will write the new (empty-then-growing) log over the absent one.
    61	
    62	### 2.2 Edit a single cell
    63	
    64	User types `=A1 * 2` and hits Enter:
    65	
    66	```rust
    67	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    68	let value = rt.set_formula(sheet, row, col, "A1 * 2")?;
    69	// value is Value::Number(20.0) given A1=10
    70	// rt drops; wb + oplog observable again
    71	```
    72	
    73	The IDE renders `value` in the cell. If `set_formula` returns `Err(RuntimeError::...)`:
    74	- The Display string is user-facing — render it in a diagnostic panel / hover tooltip.
    75	- The workbook is unchanged (no partial write, per the no-fallbacks rule).
    76	- The op log is unchanged (append-before-mutate ordering).
    77	
    78	Common error variants the IDE renders:
    79	- `RuntimeError::Lex(...)` — syntax / tokenization error (e.g., unexpected `@`).
    80	- `RuntimeError::Parse(...)` — parse error (e.g., unclosed paren).
    81	- `RuntimeError::Bind(BindError::UnresolvedName(...))` — `#NAME?` analogue.
    82	- `RuntimeError::Bind(BindError::NamedRangeInScalarContext(...))` — use SUM/AVERAGE/COUNT etc.
    83	- `RuntimeError::Bind(BindError::NamedFormulaUnsupported(...))` — named formulas are Engine Phase 4.
    84	- `RuntimeError::InvalidSheet { ... }` / `InvalidCell { ... }` — coordinate out of range.
    85	
    86	### 2.3 Edit a single cell to a literal
    87	
    88	User types `42` (no leading `=`):
    89	
    90	```rust
    91	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    92	rt.set_value(sheet, row, col, Value::Number(42.0))?;
    93	```
    94	
    95	Sets a literal; clears any prior formula. Emits `Op::PutValue` (+ `Op::ClearFormula` if cell had a formula).
    96	
    97	### 2.4 Cancel an edit
    98	
    99	User starts typing, presses Esc. **The IDE simply does not call `set_formula` / `set_value`.** No engine state changes. No op log entry. The runtime is never constructed.
   100	
   101	This is the canonical "no-op cancel" path. The engine offers no explicit cancel API because none is needed — borrow-checked mutation requires explicit `&mut` access, and the IDE never grants it for cancelled edits.
   102	
   103	### 2.5 Paste a block
   104	
   105	User pastes 10 cells (literals + formulas):
   106	
   107	```rust
   108	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   109	{
   110	    let mut tx = rt.transaction();
   111	    for (row, col, value) in pasted_literals {
   112	        tx.put_value(sheet, row, col, value)?;
   113	    }
   114	    for (row, col, formula) in pasted_formulas {
   115	        tx.put_formula(sheet, row, col, formula)?;
   116	    }
   117	    tx.commit()?;
   118	}
   119	```
   120	
   121	The transaction:
   122	- Buffers all writes; eager bind validation surfaces formula errors BEFORE the commit (so the paste atomically succeeds or rejects).
   123	- Drop without commit = no-op (canonical "ESC cancels paste" path).
   124	- Emits exactly one `Op::BatchCommit { ops: [...] }` per commit.
   125	
   126	### 2.6 Set / remove a defined name
   127	
   128	User adds a named range in the Name Manager:
   129	
   130	```rust
   131	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   132	rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))?;
   133	```
   134	
   135	Emits `Op::SetName`. Returns `RuntimeError::Name(NameTableError::Reserved(...))` for reserved names (currently just `AI` per CORR-06).
   136	
   137	### 2.7 Add a sheet
   138	
   139	```rust
   140	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   141	let new_sheet_id = rt.add_sheet("Sheet2", 16_384)?;
   142	```
   143	
   144	`16_384` is the engine default chunk size; pass the same unless deliberately tuning.
   145	
   146	### 2.8 Clear a formula (keep value)
   147	
   148	User edits the formula bar to remove the leading `=` (Excel-canon: strips formula, leaves last-evaluated value as a literal):
   149	
   150	```rust
   151	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   152	rt.clear_formula(sheet, row, col)?;
   153	```
   154	
   155	Emits `Op::PutValue(current) + Op::ClearFormula` (preserves the "strip formula, keep value" semantic across replay). No-op if cell had no formula.
   156	
   157	### 2.9 Recompute on demand
   158	
   159	After an out-of-band mutation (e.g., a UDF refresh, a future connector update) the IDE forces a full recompute:
   160	
   161	```rust
   162	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   163	let result = rt.recompute_all();
   164	if !result.is_complete() {
   165	    for failure in &result.failures {
   166	        // display per-cell diagnostic
   167	    }
   168	}
   169	```
   170	
   171	Hit/miss counters in the bind-plan cache visible via `rt.cache_stats()` — IDE can surface these in a status bar / debug pane (Engine Phase 6.2 wires them into the ql-profile JSON for the IDE to render).
   172	
   173	### 2.10 Save
   174	
   175	```rust
   176	ql_io::save_workbook_with_oplog(&wb, &oplog, "name", path)?;
   177	```
   178	
   179	Atomic save (`.qbook/` + `oplog.bin` ride the same temp-then-rename protocol). The op log persists in full — any future session reloading this `.qbook` sees the same history.
   180	
   181	## 3. What the IDE does NOT do
   182	
   183	- **The IDE does NOT call `Workbook::set_name`, `Workbook::add_sheet`, `Workbook::put_at`, or `Workbook::clear_formula` directly.** Those are LOW-LEVEL methods (doc-marked Phase 2B.5) used by the qbook loader, the op-log replay path, runtime-internal recompute pass 2, and tests. Direct calls bypass the op log silently — a correctness hole for product code.
   184	- **The IDE does NOT manage the op log directly.** No `oplog.append(...)` calls. The runtime emits ops; the IDE just hands the runtime an `&mut OpLog` and the runtime handles the rest.
   185	- **The IDE does NOT evaluate formulas itself.** All evaluation goes through the runtime. The IDE consumes results, never produces them.
   186	- **The IDE does NOT cache parsed/bound plans.** That's the runtime's `PlanCache`. The IDE consumes hit/miss stats for observability but never inserts directly.
   187	
   188	## 4. Engine surfaces NOT yet shipped (filed in `docs/known-gaps.md`)
   189	
   190	The IDE will need these eventually; they're not blocking the Phase 2B.6 vertical slice:
   191	
   192	- ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
   193	- ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
   194	- **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
   195	- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. ✅ **Phase 5.3 SHIPPED 2026-05-20** — causality-aware rename-repair pass via `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See § 4.1 below for the IDE-facing API.
   196	- **Long-running cancellation.** No `Cancel-token` on long operations. Engine Phase 6.1 work.
   197	
   198	### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
   199	
   200	Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/phase5/v1-exit-packet.md | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	---
     2	title: Phase 5 V1 exit packet (5.1 → 5.6 V1+V2 + 5.4 V2 V1+V1.1 + 5.5 V2 V1 + D1.a)
     3	status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
     4	date: 2026-05-19
     5	updated: 2026-05-20 (post-exit-packet additions: 5.6 V2 sweep_presence + D1.a 4-cluster closure + D-1 ALL STEPS SHIPPED)
     6	predecessor: docs/phase4/exit-packet.md + docs/phase5/entry-plan.md
     7	successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
     8	supersedes_pointer: docs/phase5/entry-plan.md (entry-plan stays as historical scope reference; this packet is the closeout)
     9	---
    10	
    11	# Phase 5 V1 exit packet — multi-user CRDT collaboration substrate
    12	
    13	This packet closes the Phase 5 **V1 surface** of the Quantbook
    14	engine. V1 shipped the engine-side collaboration data model end-to-
    15	end: CRDT data model decision (5.1), op-log semantic decisions
    16	(5.2 D-2/D-3/D-4 + 5.2.a scaffold + 5.2.b set_peer_id), peer-local
    17	undo (5.4 V1 + V2 V1 + V2 V1.1), in-process transport (5.5 V1 +
    18	V2 V1), and ephemeral presence (5.6 V1).
    19	
    20	Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
    21	`docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
    22	✅ SHIPPED 2026-05-20 — see `docs/phase5/5-3-exit-packet.md`.
    23	Phase 5.5 V2 V2 (auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5 V2 V3
    24	step 1 (version-vector delta flush) ✅ SHIPPED 2026-05-21. Phase 5.5
    25	V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue +
    26	WebSocket transport + reconnect/offline sync) + Phase 5.7 IDE vertical
    27	slice remain ahead of the 5.8 megaudit.
    28	
    29	## Acceptance criteria status (Phase 5 V1)
    30	
    31	| ID | Criterion | Status | Evidence |
    32	|---|---|---|---|
    33	| A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
    34	| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
    35	| A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
    36	| A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
    37	| A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |
    38	
    39	All five acceptance criteria empirically met.
    40	
    41	## Sub-phase shipped tally
    42	
    43	| Sub-phase | Theme | Status | Commit(s) |
    44	|---|---|---|---|
    45	| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
    46	| Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
    47	| 5.2 D-2 | AddSheet auto-rename on duplicate | ✅ SHIPPED | `1ca19e2fa37` |
    48	| 5.2 D-3 | BindError::UnknownSheet → ErrorValue::Name | ✅ SHIPPED | `e71312d4bcd` |
    49	| 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
    50	| 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
    51	| 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
    52	| 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
    53	| 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
    54	| 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
    55	| 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
    56	| 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
    57	| 5.4 V2 V1.1 | RAII UndoGroupGuard (panic/Err-safe grouping) | ✅ SHIPPED | `7cbdc689ea9` + `d49e873f237` (Codex audit PASS) |
    58	| **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
    59	| 5.6 V2 (sweep_presence — closes V1 persistence known-limitation) | ✅ shipped | `d4b3cdb2dc2` |
    60	| D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
    61	| D1.a cluster 2 (clear_formula_rejects_* → cells.rs) | ✅ shipped | `9b45ee656eb` + `4528dc62c3b` (backlog status) |
    62	| D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |
    63	
    64	**23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total** in the Phase 5 V1 arc.
    65	
    66	Post-exit-packet adds (2026-05-19 session-end additions):
    67	- Phase 5.6 V2 sweep_presence (+3 tests; closes V1 persistence known-limitation).
    68	- D1.a re-partitioning across 4 clusters (9 tests relocated; net 0 workspace test count change since these are byte-identical relocations).
    69	
    70	## Final API surface (ql-collab)
    71	
    72	```rust
    73	// Identity
    74	pub struct PeerId(pub u64);  // 16-hex Display; matches Loro's u64 peer id
    75	
    76	// Per-peer session
    77	pub struct CollabSession {
    78	    peer_id: PeerId,
    79	    log: OpLog,
    80	    undo: loro::UndoManager,
    81	    transport: Option<Box<dyn Transport + Send>>,
    82	}
    83	
    84	impl CollabSession {
    85	    // Construction
    86	    pub fn new(peer_id: PeerId) -> Result<Self, _>;
    87	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, _>;
    88	
    89	    // State access
    90	    pub fn peer_id(&self) -> PeerId;
    91	    pub fn op_log(&self) -> &OpLog;
    92	    pub fn op_count(&self) -> usize;
    93	    pub fn is_empty(&self) -> bool;
    94	
    95	    // Op log + merge
    96	    pub fn append_op(&mut self, op: Op) -> Result<(), _>;
    97	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, _>;
    98	    pub fn export_bytes(&self) -> Result<Vec<u8>, _>;
    99	
   100	    // Undo / redo (5.4 V1)
   101	    pub fn undo(&mut self) -> Result<bool, _>;
   102	    pub fn redo(&mut self) -> Result<bool, _>;
   103	    pub fn can_undo(&self) -> bool;
   104	    pub fn can_redo(&self) -> bool;
   105	    pub fn undo_count(&self) -> usize;
   106	    pub fn redo_count(&self) -> usize;
   107	    pub fn clear_undo_stack(&self);
   108	
   109	    // Undo grouping (5.4 V2 V1 + V1.1)
   110	    pub fn start_undo_group(&mut self) -> Result<(), _>;
   111	    pub fn end_undo_group(&mut self);
   112	    pub fn set_undo_merge_interval(&mut self, ms: i64);
   113	    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, _>;
   114	
   115	    // Transport (5.5 V2 V1)
   116	    pub fn attach_transport<T: Transport + Send + 'static>(&mut self, t: T) -> Option<Box<...>>;
   117	    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>>;
   118	    pub fn has_transport(&self) -> bool;
   119	    pub fn flush_to_transport(&mut self) -> Result<bool, _>;
   120	    pub fn poll_remote(&mut self) -> Result<usize, _>;
   121	    pub fn poll_remote_with_limit(&mut self, max: usize) -> Result<usize, _>;
   122	
   123	    // Presence (5.6 V1 + V2)
   124	    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), _>;
   125	    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, _>;
   126	    pub fn clear_presence(&mut self) -> Result<(), _>;
   127	    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, _>;
   128	    pub fn sweep_presence(&mut self) -> Result<usize, _>;  // V2: clear all, return count
   129	}
   130	
   131	// Transport
   132	pub trait Transport {
   133	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
   134	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
   135	}
   136	pub struct NoopTransport { ... }
   137	pub struct LoopbackTransport { ... }  // pair() returns 2 endpoints
   138	
   139	// Presence (5.6 V1)
   140	pub struct PresenceState {
   141	    pub sheet: u16,
   142	    pub row: u32, pub col: u32,
   143	    pub selection_end_row: u32, pub selection_end_col: u32,
   144	    pub typing: bool,
   145	}
   146	
   147	// Undo RAII (5.4 V2 V1.1)
   148	pub struct UndoGroupGuard<'a> { ... }  // Drop calls end_undo_group
   149	impl Deref<Target = CollabSession> + DerefMut for UndoGroupGuard
   150	```
   151	
   152	Total: **~31 public methods + 5 types** on `ql-collab` (was 30 at exit-packet; +1 sweep_presence in V2 follow-up).
   153	
   154	## Audit-locked decisions (Phase 5.1)
   155	
   156	| ID | Decision | Status |
   157	|---|---|---|
   158	| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit. See `docs/phase5/d-1-exit-packet.md`. |
   159	| D-2 | AddSheet auto-rename on duplicate canonical | ✅ SHIPPED `1ca19e2fa37` |
   160	| D-3 | `BindError::UnknownSheet → ErrorValue::Name` mapping | ✅ SHIPPED `e71312d4bcd` |
   161	| D-4 | Spill semantics: replay defers to recompute, not per-op | ✅ SHIPPED `2f217a2067a` |
   162	
   163	## Audit discipline performance
   164	
   165	The 2-way Codex + Opus audit rule was applied to **9 of 10** substantive cycles (5.6 V1 ran Codex-only due to Anthropic 529 outage × 3 Opus retries; 5.4 V2 V1.1 ran Codex-only as a documented follow-up to a pre-audited design).
   166	
   167	| Cycle | Codex finding | Opus finding | Convergent? |
   168	|---|---|---|---|
   169	| 5.2.b set_peer_id | MEDIUM: API exposure of set_peer_id | HIGH: silent undo-stack-clear footgun | Same root cause, different framing |
   170	| 5.6 V1 presence | MEDIUM: persistence contract drift | (529 unavailable) | N/A — Codex-only this cycle |
   171	| 5.4 V1 undo | HIGH: cached_len stale after undo | HIGH: silent set_peer_id footgun (different angle) | Both unique correctness HIGHs |
   172	| 5.5 V1 LoopbackTransport | MEDIUM: drain-before-Closed contract violation | HIGH: same finding, different framing | Yes |
   173	| 5.5 V2 V1 transport wrappers | MEDIUM: poll_remote unbounded + partial-merge ambiguity | HIGH: same | Yes |
   174	| 5.4 V2 V1 undo grouping | HIGH: TRUNCATION (commit blob broken) | HIGH: same TRUNCATION | Yes |
   175	| 5.4 V2 V1.1 RAII guard | (Codex-only) PASS | (skipped — pre-audited design) | N/A |
   176	
   177	**8 of 9 cycles that ran 2-way caught real correctness/contract bugs.**
   178	**5 of 9 cycles caught convergent findings from both auditors.**
   179	
   180	The 2-way audit-discipline rule is validated as load-bearing —
   181	without either auditor, real bugs would have shipped (cached_len
   182	stale, drain-before-Closed contract violation, truncation race
   183	twice, etc.).
   184	
   185	## Index-padding race incidents
   186	
   187	The `cargo fmt --all` × `git add` race noted in user memory
   188	(`git_index_padding_race.md`) recurred **3 times** this session:
   189	1. Phase 5.5 V1 (`3590aa6d89e`, truncated `session.rs` + `transport.rs`) — caught by self-audit reading git diff; repaired in `924750819bc`.
   190	2. Phase 5.4 V2 V1 (`6138a7203f6`, truncated `session.rs`) — caught by BOTH Codex + Opus 2-way audit via clean-checkout verification; repaired in `e199a5fda5a`.
   191	3. Phase 5.4 V2 V1.1 audit-closure commit + 5.4 V2 V1 audit-closure commit + D1.a cluster 2 commit each hit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in the pre-commit hook (recovered via re-stage + retry; no truncation made it into the blob those times — different failure mode than incidents 1+2 but same root cause: cargo fmt × git add timing on large files).
   192	
   193	The recurring pre-commit-hook `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
   194	error pattern is well-documented; mitigation (re-stage + commit
   195	fix) works reliably. Root-cause investigation of the husky
   196	precommit hook's stdio handling is forward work for a separate
   197	session.
   198	
   199	## Test count evolution
   200	
   201	| Phase milestone | Workspace test count |
   202	|---|---|
   203	| Phase 4 exit | 4131 |
   204	| Phase 5.1 audit-closed | (no change; design-only) |
   205	| Phase 5.2.b ship | 4164 (+33 across 5.2 D-2/D-3/D-4 + 5.2.a + 5.2.b) |
   206	| Phase 5.6 V1 ship + audit | 4180 (+16) |
   207	| Phase 5.4 V1 ship + audit | 4187 (+7) |
   208	| Phase 5.5 V1 ship + audit | 4196 (+9) |
   209	| Phase 5.5 V2 V1 ship + audit | 4209 (+13) |
   210	| Phase 5.4 V2 V1 ship + audit | 4215 (+6) |
   211	| Phase 5.4 V2 V1.1 ship | 4219 (+4) |
   212	| Phase 5.6 V2 sweep_presence | 4222 (+3) |
   213	| D1.a clusters 1-4 (relocations) | **4222** (0 net; byte-identical) |
   214	
   215	Phase 5 V1 added **91 net tests** to the engine.
   216	
   217	## What's deferred (forward work for next session(s))
   218	
   219	### Major (multi-day)
   220	

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/MASTER-PLAN.md | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	# Quantbook Engine Master Plan
     2	
     3	**Status:** Canonical engine-side plan, Phase 4.3 V2 closure session 2026-05-13  
     4	**Date:** 2026-05-13 (last touched W5-58 — FN4-01 closure)  
     5	**Current HEAD:** see `docs/audits/2026-05-13-engine-session-final-handoff.md` § Session ledger for the exact hash (last shippable W5-58 = `d6a6bcdcfc5`; W5-59 finalization = `51fedf11c68`; W5-60 closure adds the final mega-audit fixes on top)  
     6	**Scope:** engine-internal sequencing for all 24 workspace crates  
     7	**Authored:** Claude Opus 4.7 + Codex (co-thinking session, 2026-05-12)
     8	
     9	This is the long path. There is no MVP shortcut in this plan. The v1 target is a real spreadsheet engine backing Quantlab: correct scalar semantics, fast graph-driven recomputation, Excel coverage, collaboration, import/export, bindings, service mode, Python UDFs, SQL, connectors, AI(), and an exercised IDE integration.
    10	
    11	---
    12	
    13	## 0. How this document relates to the product master plan
    14	
    15	There is a **canonical product master plan** for Quantbook at:
    16	
    17	> `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md`
    18	
    19	That document (dated 2026-05-10, 949 lines) is the **product source-of-truth**: the fusion thesis, the wedge, the v1 ship definition, the 11-phase / 9-12 month budget, the kill gates, the v1.5 deferrals, the legal posture, the renderer/Python/IDE phase plan. It is gitignored (lives outside this engine worktree). Future sessions should read it before making product-level decisions.
    20	
    21	This `MASTER-PLAN.md` is the **engine-side execution plan**: how the Rust engine work proceeds from where it is today (HEAD at W5-60 closure, post-FN4-01 wave 1 closure + final mega-audit fixes; see `docs/audits/2026-05-13-engine-session-final-handoff.md` for the precise hash) through to a state where every product-plan phase that needs engine support has it. It uses engine-internal phase numbers (`2B`, `3`, `4`, `5`, `6`, `7`) that DO NOT align with the canonical plan's numbering (`Phase 0..10`).
    22	
    23	### Mapping between engine-internal phases and canonical product phases
    24	
    25	| Engine phase (this doc) | Canonical product phase(s) | Notes |
    26	|---|---|---|
    27	| Engine 0 (Viability spike) ✅ | Product Phase 0 | Same. 13/13 gates locked. |
    28	| Engine 1 (Parser + persistence + runtime facade) ✅ | Product Phase 0 spillover + parts of Phase 2 (`.qbook/`) + parts of Phase 3 (parser, recompute) | Engine front-ran the canonical plan by absorbing parts of Phase 2 storage and Phase 3 parser. |
    29	| Engine 2A.1–2A.13 ✅ | Parts of Product Phase 3 (named ranges, errors, fingerprints, parser breadth) | Engine correctness + audit closure. |
    30	| Engine 2A.3 (op log) ✅ | Product Phase 0 deliverable (`ql-oplog` scaffolding) advanced into producer wiring + persistence | Loro op log scaffolding called for in canonical Phase 0; we shipped it now because the API surface was ready. |
    31	| **Engine 2B (Correct Runtime Contract)** | Product Phase 3 (continued) + Product Phase 6 (first IDE integration vertical slice) | First time the IDE is exercised against the engine. |
    32	| **Engine 3 (One Engine — calcgraph integration)** | Product Phase 3 (the unified engine spine the canonical plan assumed in §2.1) | The canonical plan describes "one authoritative graph"; Engine 3 actually builds that. |
    33	| **Engine 4 (Excel Coverage)** | Product Phase 3 (depth) + Product Phase 4 (xlsx import) | Roughly 260 functions + arrays/spills/tables/cross-sheet refs + xlsx I/O. |
    34	| **Engine 5 (Collaboration CRDT)** | Product Phase 9 (deferred to v1.5 per canonical plan) | Canonical plan defers full collab to v1.5; engine-side, when this work happens, it lives here. May be cut from v1 per canonical. |
    35	| **Engine 6 (Product Surfaces)** | Product Phase 5 (Python kernel + UDFs) + Phase 6 (VS Code surface) + Phase 7 (UX) + Phase 8 (SQL/connectors) | The canonical plan splits these across four product phases; the engine work to support them is sequenced here. The TypeScript/UI work in canonical phases 1, 7 lives in `Charts/packages/sheets-*` and `extensions/quantlab/`, NOT in this engine worktree. |
    36	| **Engine 7 (Hardening + Ship)** | Product Phase 10 | Same. Final release candidate. |
    37	
    38	**Where the engine plan does NOT cover canonical phases:**
    39	
    40	- **Canonical Phase 1 (Renderer spike, WebGL grid)** — entirely TypeScript work in `Charts/packages/sheets-{protocol,client,renderer}`. Engine provides the API surface; renderer is its own project. No engine-side phase covers it.
    41	- **Canonical Phase 2 (storage + protocol + skeleton packages)** — engine has shipped the `.qbook/` storage piece; the `sheets-protocol`/`sheets-client` TypeScript packages are renderer-team work.
    42	- **Canonical Phase 6 (Quantlab IDE integration)** — the engine's job is to provide a usable API; the actual `extensions/quantlab/` work is a parallel TypeScript track. Engine 2B includes the first vertical slice as a forcing function.
    43	
    44	### Why two documents
    45	
    46	The canonical plan is product-shaped and parallel-track (engine + renderer + Python + IDE proceeding in measured concurrency). The actual execution since 2026-05-11 has been engine-serial: depth-first through the Rust core. This engine plan reflects that reality and extends it. Future sessions should:
    47	
    48	1. Open the canonical plan to understand product intent, v1 definition, ship gates.
    49	2. Open this engine plan to know what to build next in the engine.
    50	3. When the two diverge, **the canonical plan wins on product scope and timing**; this doc adjusts.
    51	
    52	## PART I - Strategic Posture
    53	
    54	### 1. How We Got Here
    55	
    56	Phase 0 proved that the engine shape is viable. The locked architectural gates are still binding:
    57	
    58	- T1-D02: hand-rolled dependency graph on the hot path, not petgraph.
    59	- T1-D03: direct Arrow kernels on the hot path, not Polars or DataFusion.
    60	- T1-D04: pulp plus multiversion SIMD.
    61	- T1-D05: Loro reserved for operation history and collaboration substrate work, not evaluator state.
    62	- T1-D06: stock VS Code APIs for v1.
    63	- T1-D07: Tier-0 wedge is Monaco-powered formula bar plus Python UDFs.
    64	- T2-D01: `.qbook/` directory plus `workbook.toml` envelope.
    65	- T3-D03: roughly 260 v1 spreadsheet functions.
    66	
    67	Phase 1 built the first live formula path: lexer, parser, AST printer, scalar binding, scalar evaluation, `.qbook/` persistence, `WorkbookRuntime::set_formula`, and `recompute_all`. It made the engine useful, but it did not make it architecturally complete. `recompute_all` still walks formula cells in map order, so dependency chains can compute incorrectly.
    68	
    69	Phase 2A closed a large correctness and persistence pass: defined names, transactions, load-and-recompute, dotted function identifiers, schema v2, crash-safe save, Excel-canon coercion fixes, deterministic formula fingerprints, error ergonomics, and audit closure. Phase 2A.3 then shipped Loro-backed op-log scaffolding: `ql-oplog`, typed `Op` variants, Loro snapshot persistence, replay, runtime and transaction producer wiring, and `.qbook/oplog.bin` persistence. The stale `docs/phase2/entry-plan.md` and `docs/phase2/exit-packet.md` still say 2A.3 is deferred; this plan supersedes that statement and requires a doc-rot repair pass in Phase 2B.
    70	
    71	The engine now has **1219 workspace tests at W5-60 close** (was 816 at the time this paragraph was first written; ~+403 across the W5-49..W5-60 arc) and 7 green gates. That is a floor, not a trophy. The major unresolved problem is that the "fast engine" (`ql-calcgraph`, SIMD region lowering, storage profiles) and the "runtime engine" (`WorkbookRuntime`, per-formula scalar path) still do not form one engine.
    72	
    73	Reference reading already changed the plan:
    74	
    75	- `docs/phase0/references-reading-log.md` corrected the stripe design to Formualizer-style per-row/per-column/block stripes (`CORR-21`).
    76	- Range aggregate caching is a Phase 3/4 feature informed by HyperFormula, not Formualizer (`CORR-22`).
    77	- Scheduling should use Tarjan SCC on dirty subsets (`CORR-23`).
    78	- Graph tests should expose typed accessors, not serialized graph dumps (`CORR-24`).
    79	- Storage eventually needs user and computed overlays (`CORR-25`).
    80	
    81	### 2. What Full Product v1 Means
    82	
    83	The 24-crate workspace is v1 scope. Stubs are not optional decorations; they are reserved product surfaces.
    84	
    85	| Crate | v1 role |
    86	|---|---|
    87	| `ql-types` | shared values, errors, addresses, coercion, date serials, sheet/range types |
    88	| `ql-storage` | workbook, sheets, columns, user/computed overlays, names, tables, style/format metadata |
    89	| `ql-formula-syntax` | lexer, parser, printer, fingerprints, A1/R1C1/localized syntax |
    90	| `ql-formula-semantics` | binding, name resolution, tables, cross-sheet references, aggregate context |
    91	| `ql-functions` | roughly 260 Excel-compatible functions, function metadata, volatility, lazy args |
    92	| `ql-calcgraph` | dependency graph, dirty propagation, SCC scheduling, range deps, aggregate caches |
    93	| `ql-exec` | runtime facade, scalar and SIMD evaluation, plan cache, graph integration |
    94	| `ql-io` | `.qbook` persistence and schema migrations |
    95	| `ql-oplog` | mutation history, replay, future collaborative operation vocabulary |
    96	| `ql-profile` | timings, graph profile exports, observability records |
    97	| `ql-bench` | reproducible perf and scale workloads |
    98	| `ql-io-xlsx` | Excel import/export through calamine and write support |
    99	| `ql-io-ods` | OpenDocument import/export |
   100	| `ql-collab` | multi-user CRDT documents, merge, presence, undo/redo, offline sync |
   101	| `ql-service` | engine-as-service API, transport, auth boundary hooks |
   102	| `ql-bindings-wasm` | browser/worker engine bindings |
   103	| `ql-bindings-node` | IDE and Node integration surface |
   104	| `ql-bindings-c` | stable C ABI |
   105	| `quantbook-py` | Python package for local automation and notebooks |
   106	| `ql-udf` | Python UDF execution, sandboxing, registration, cancellation |
   107	| `ql-sql` | SQL over sheets/tables, Arrow/DuckDB bridge where appropriate |
   108	| `ql-connectors` | external data imports, refresh, credentials boundary |
   109	| `ql-ai` | real AI() implementation, provider boundary, cancellation, provenance |
   110	| `ql-terminal` | terminal-side integration only if it survives product clarification |
   111	
   112	The full v1 means all of these crates either ship real behavior or have a documented product decision removing them. As of this plan, none are removed.
   113	
   114	### 3. Seven Phases At A Glance
   115	
   116	| Phase | Name | Purpose | Estimate | Primary proof |
   117	|---|---|---|---:|---|
   118	| 2B | Correct Runtime Contract | Fix immediate runtime correctness gaps, cache bind plans, prepare named aggregate context, and run the first IDE vertical slice. | 2-4 weeks | IDE can edit formulas through the engine with real diagnostics and op-log persistence. |
   119	| 3 | One Engine | Wire `ql-calcgraph` into `WorkbookRuntime` so runtime and fast engine share graph, storage, invalidation, and scheduling. | 4-8 weeks | Dependency chains, ranges, volatiles, and incremental recompute are graph-driven. |
   120	| 4 | Excel Coverage | Expand parser, semantics, function library, arrays, tables, cross-sheet refs, formats, and xlsx I/O. | 8-16 weeks | Compatibility matrix exists and passes broad Excel corpus coverage. |
   121	| 5 | Collaboration | Make Loro a true multi-user substrate for cells, sheets, names, tables, and presence. | 6-12 weeks | Two offline peers merge deterministically without losing edits. |
   122	| 6 | Product Surfaces | Ship service mode, bindings, connectors, SQL, Python UDFs, and AI(). | 6-10 weeks | IDE, Node, Python, WASM, and service clients run the same engine contract. |
   123	| 7 | Hardening And Ship | Performance, observability, release artifacts, audits, scale tests, and IDE polish. | 4-6 weeks | End-to-end release candidate survives scale, audit, and IDE acceptance. |
   124	
   125	## PART II - Phase Plans
   126	
   127	## Phase 2B - Correct Runtime Contract
   128	
   129	**Purpose:** Make current runtime semantics honest enough for the IDE while preparing the bind and aggregate context that Phase 3 will graph-drive.
   130	
   131	**Entry State Required**
   132	
   133	- Phase 0, Phase 1, Phase 2A, and Phase 2A.3 are green at HEAD `fc977815cd2`.
   134	- `ql-oplog` producer/replay tests pass.
   135	- `docs/phase2/*` are known stale; do not trust their 2A.3 deferral statement.
   136	
   137	**Dependencies**
   138	
   139	- Depends on Phase 2A.3 op-log producer wiring.
   140	- Must not require full calcgraph integration; that is Phase 3.

exec
/bin/zsh -lc "rg -n \"delta|flush_delta|version-vector|V2 V3|per-transport|auto-flush|remaining|poll_remote|wire payload|O\\(\" quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/MASTER-PLAN.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/ide-consumer-contract.md:206:- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 will add WebSocket.
quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/architecture/ide-consumer-contract.md:208:- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
quantbook-engine/docs/architecture/ide-consumer-contract.md:209:- **Receive-side exclusion**: `poll_remote` / `poll_remote_with_limit` do NOT auto-flush by design (audit-locked Phase 5.5 V2 V2 Codex M1 + Opus M1, 2026-05-21). V2 V3 step 1 keeps this exclusion intact; step 2 will wire `poll_remote` into auto-flush safely thanks to the V2 V3 idempotency guard. Until step 2 ships, callers fanning a polled batch onward must invoke explicit `flush_delta_to_transport` (or `flush_to_transport`) after the drain. **Fanout caveat (3+ peers)**: in a hub topology (A↔hub↔B) where each peer's writes should reach the other, the HUB must enable `OnAppend` AND call `flush_delta_to_transport` after each `poll_remote` batch. Symmetric `OnAppend` on both endpoints of a paired transport is safe under V2 V3 step 1 idempotency guard (each side short-circuits when its own state didn't advance).
quantbook-engine/docs/phase5/v1-exit-packet.md:3:status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
quantbook-engine/docs/phase5/v1-exit-packet.md:23:Phase 5.5 V2 V2 (auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5 V2 V3
quantbook-engine/docs/phase5/v1-exit-packet.md:24:step 1 (version-vector delta flush) ✅ SHIPPED 2026-05-21. Phase 5.5
quantbook-engine/docs/phase5/v1-exit-packet.md:25:V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue +
quantbook-engine/docs/phase5/v1-exit-packet.md:120:    pub fn poll_remote(&mut self) -> Result<usize, _>;
quantbook-engine/docs/phase5/v1-exit-packet.md:121:    pub fn poll_remote_with_limit(&mut self, max: usize) -> Result<usize, _>;
quantbook-engine/docs/phase5/v1-exit-packet.md:173:| 5.5 V2 V1 transport wrappers | MEDIUM: poll_remote unbounded + partial-merge ambiguity | HIGH: same | Yes |
quantbook-engine/docs/phase5/v1-exit-packet.md:244:- **Phase 5.5 V2 V2 — auto-flush on append.** ✅ **SHIPPED
quantbook-engine/docs/phase5/v1-exit-packet.md:247:  `OnAppend` triggers flush after every mutator (delta path in
quantbook-engine/docs/phase5/v1-exit-packet.md:248:  V2 V3 step 1); partial-state contract documented for transport-
quantbook-engine/docs/phase5/v1-exit-packet.md:253:- **Phase 5.5 V2 V3 step 1 — version-vector delta flush.** ✅
quantbook-engine/docs/phase5/v1-exit-packet.md:254:  **SHIPPED 2026-05-21**. New `CollabSession::flush_delta_to_transport`
quantbook-engine/docs/phase5/v1-exit-packet.md:256:  reroutes through delta path. Idempotency short-circuit closes
quantbook-engine/docs/phase5/v1-exit-packet.md:258:  + `export_delta_bytes(&VersionVector)`. 9 new integration tests
quantbook-engine/docs/phase5/v1-exit-packet.md:262:- **Phase 5.5 V2 V3 steps 2-6 — Production transport.** Step 2:
quantbook-engine/docs/phase5/v1-exit-packet.md:263:  wire `poll_remote` into auto-flush (now safe with V2 V3 step 1
quantbook-engine/docs/phase5/v1-exit-packet.md:266:  full-arc megaudit. Step 6: V2 V3 exit packet. 3-6 days
quantbook-engine/docs/phase5/v1-exit-packet.md:270:  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2 (✅) + V2 V3.
quantbook-engine/docs/phase5/v1-exit-packet.md:304:- `docs/known-gaps.md` — GAP-C-03 / C-04 / C-05 closed at V1; remaining items.
quantbook-engine/docs/MASTER-PLAN.md:248:   Shipped: session-side `dirty: HashSet<NodeId>` plus the 5 hooks fanning out via `Graph::dependents_for_cell` (stripe + precision) for range deps and a new session-side `cell_to_formulas` reverse index for direct cell deps; `on_set_name` fans out via `name_to_formulas`; `take_dirty()` claims + clears for the future 3.4 SCC scheduler; `range_to_rangeref` converter promotes `Range { start_row: 0, end_row: MAX }` to `RangeRef::WholeColumn` (and symmetric for whole-row) to keep the stripe index O(width) instead of O(height). 10 new tests; full ql-exec suite at 278 tests, workspace at 892. Known limitation: stale Phase 0 stripe entries on re-bind (append-only `Graph`) — filed as GAP-G-01 (performance, not correctness; precision check filters at the read side).  
quantbook-engine/docs/MASTER-PLAN.md:328:   Notes: V1 doesn't handle range-dep formulas with VEQ — they always re-evaluate. The Phase 3.6 aggregate cache already provides O(1) re-eval for unchanged ranges, so this is a small cost.  
quantbook-engine/docs/MASTER-PLAN.md:346:    Audit dispatched: Codex (gpt-5-codex via `codex exec`) reviewed Phase 3.1–3.9 commits independently. Findings: 4 HIGH (H1 range-deps-not-edges, H2 set_name not transitive, H3/H4 append-only-graph rebind staleness), 4 MEDIUM, 3 LOW, 6 test gaps. **Closed in audit commit:** H2 (BFS fanout fix + regression test `h2_set_name_propagates_dirty_transitively`), L1 (architecture doc rewrite), L2 (GAP-G-01 re-classified from performance-only to correctness), T4 (set_name regression test). **Deferred to Phase 4 with documented gaps:** H1 → GAP-G-03 (range-as-scheduler-edge), H3+H4 → GAP-G-01 (now correctness; needs delta-edge graph), M1 → GAP-R-08 (volatile-dependent recompute Excel-canon), M3 → GAP-S-06 (load bounds for formula-only cells). Full audit report: `docs/audits/2026-05-12-phase-3-megaudit.md`.  
quantbook-engine/docs/MASTER-PLAN.md:429:   FN4-01 closure complete (W5-58). Shipped: trig W5-51, SUMIF/COUNTIF W5-53, lookup family W5-54, IFS family + SUMPRODUCT W5-55, text wave 2 W5-56, math completion + hyperbolic W5-57, stats family W5-58. **Phase 4.3 polish wave 1 shipped W5-61 + closed W5-62**: wildcards in SUMIF/COUNTIF/SUMIFS/AVERAGEIF/SEARCH (`?`, `*`, `~` escape; text-cell-only), CONCAT (range-aware, 32K cap), PROPER, CLEAN, CEILING.MATH, FLOOR.MATH, RANK.AVG. Polish remaining (deferred to wave 2 / Phase 4.7+): MODE.MULT (needs spill), CEILING.PRECISE / FLOOR.PRECISE, FN4-03 lazy IF/IFERROR.  
quantbook-engine/docs/MASTER-PLAN.md:434:   Effort: 2-3 weeks (V1 batch + audit closure: ~0.6 day; remaining: 1-2 weeks).
quantbook-engine/docs/MASTER-PLAN.md:545:**Status (2026-05-21): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 step 1 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure). Remaining: 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, 5.8 Phase 5 megaudit (separate).
quantbook-engine/docs/MASTER-PLAN.md:581:5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 + V2 V2 (auto-flush) + V2 V3 step 1 (delta flush) SHIPPED 2026-05-21; V2 V3 steps 2-6 pending.
quantbook-engine/docs/MASTER-PLAN.md:583:   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
quantbook-engine/docs/MASTER-PLAN.md:585:   - **V2 V3 step 1 ✅ SHIPPED 2026-05-21**: per-transport version-vector tracking + new `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. Wire payload is O(per-op delta) instead of O(full state). New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
quantbook-engine/docs/MASTER-PLAN.md:586:   - V2 V3 steps 2-6 pending: poll_remote auto-flush wiring (step 2) + offline-write queue (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5) + exit packet (step 6).
quantbook-engine/docs/MASTER-PLAN.md:732:   References: `.references/formualizer/crates/formualizer-eval/src/engine/delta_edges.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/csr_edges.rs`; `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/hyperformula/src/DependencyGraph/RangeMapping.ts`.  
quantbook-engine/docs/MASTER-PLAN.md:782:- Formualizer is the primary Rust systems reference for Arrow storage, overlays, range stripes, scheduling shape, transactions, bindings, and xlsx backend patterns. Key files: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`, `range_view.rs`, `engine/graph/range_deps.rs`, `engine/scheduler.rs`, `engine/delta_edges.rs`, `engine/csr_edges.rs`, `engine/spill.rs`.

exec
/bin/zsh -lc "git diff --unified=80 b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-collab/src/session.rs b/quantbook-engine/crates/ql-collab/src/session.rs
index f1e8cde3333..160e0e00221 100644
--- a/quantbook-engine/crates/ql-collab/src/session.rs
+++ b/quantbook-engine/crates/ql-collab/src/session.rs
@@ -120,336 +120,369 @@ pub enum CollabSessionError {
     /// `replay_into` on the session's `OpLog` and replay failed at
     /// some op index. The fresh workbook constructed internally was
     /// in a HALF-MERGED state when the error fired and was DROPPED
     /// before the error was returned (the wrapper owns it). The
     /// session's `OpLog` is unaffected (replay reads only).
     ///
     /// Carries the underlying [`ReplayError`] via `#[source]` so
     /// callers can `match err.source()` for the original op index +
     /// diagnostic.
     #[error("replay error: {0}")]
     Replay(#[from] ReplayError),
 }
 
 /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
 /// (Opus-A Scenario E HIGH):** result of
 /// [`CollabSession::rebuild_workbook`]. Combines the replay op count
 /// with the two repair reports so callers can log a single
 /// diagnostic surface.
 ///
 /// `#[non_exhaustive]` per Codex step 5b audit LOW closure: column
 /// repair (Phase 5.3 step 5c) is expected to add another field
 /// (`column_repair: ColumnRepairReport`) — external struct literal
 /// construction is forbidden so future field additions are
 /// non-breaking.
 #[derive(Debug, Clone, Default)]
 #[non_exhaustive]
 pub struct SyncReport {
     /// Total ops applied by `replay_into`. Same as the success
     /// value of `replay_into` itself.
     pub ops_replayed: usize,
     /// Sheet rename-repair pass diagnostics (formulas rewritten,
     /// ambiguous-skipped rules).
     pub sheet_repair: SheetRepairReport,
     /// Table rename-repair pass diagnostics.
     pub table_repair: TableRepairReport,
     /// Column rename-repair pass diagnostics (Phase 5.3 step 5c —
     /// closes Opus-A megaudit V1 LIM #3 HIGH).
     pub column_repair: ColumnRepairReport,
 }
 
 /// Phase 5.3 step 5b audit closure (Opus MEDIUM-2) + step 5c update:
 /// one-line `Display` impl for log-line diagnostic use. Format:
 /// `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`.
 impl std::fmt::Display for SyncReport {
     fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
         write!(
             f,
             "sync: ops={} sheet_rewrites={}(skip={}) table_rewrites={}(skip={}) column_rewrites={}(skip={})",
             self.ops_replayed,
             self.sheet_repair.formulas_rewritten,
             self.sheet_repair.ambiguous_rules_skipped.len(),
             self.table_repair.formulas_rewritten,
             self.table_repair.ambiguous_rules_skipped.len(),
             self.column_repair.formulas_rewritten,
             self.column_repair.ambiguous_rules_skipped.len(),
         )
     }
 }
 
 /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy for
 /// [`CollabSession`]. Determines when (if ever) the session pushes
 /// its current snapshot through the attached transport without an
 /// explicit [`CollabSession::flush_to_transport`] call.
 ///
 /// V2 V2 (this ship) adds two variants. V2 V3 will add a `Threshold`
 /// variant for byte-budget-based batching.
 ///
 /// `#[non_exhaustive]` so adding a `Threshold(usize)` variant later
 /// is non-breaking — callers MUST handle the `_` arm in `match`.
 #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
 #[non_exhaustive]
 pub enum AutoFlushPolicy {
     /// Default. V2 V1 behavior preserved: caller drives flush + poll
     /// explicitly via [`CollabSession::flush_to_transport`] +
     /// [`CollabSession::poll_remote`]. Auto-flush never fires.
     #[default]
     Disabled,
     /// Flush automatically after every public method that mutates the
     /// underlying `LoroDoc`. Triggers on: `append_op`, `merge_bytes`,
     /// `update_presence`, `clear_presence`, `sweep_presence`,
-    /// `undo`, `redo`. Does NOT trigger on:
+    /// `undo`, `redo`.
+    ///
+    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** auto-flush routes
+    /// through [`flush_delta_to_transport`] (delta path) rather than
+    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
+    /// O(per-op delta) instead of O(full state). The idempotency
+    /// short-circuit means a flush after no state change is a true
+    /// no-op (no transport.send invocation) — this closes the V2 V2
+    /// audit echo-loop class.
+    ///
+    /// Does NOT trigger on:
     /// - Accessor methods (read-only).
     /// - Undo-group boundary methods (`start_undo_group` /
     ///   `end_undo_group`) — only their inner appends fire, via
     ///   `append_op`. Each mid-group append produces ONE auto-flush;
     ///   the group is a LOCAL undo unit only (peers see each append
     ///   land independently). Phase 5.5 V2 V2 audit closure (Opus
     ///   L1) — undo-group atomicity-over-wire deferred to V2 V3.
     /// - Transport-lifecycle methods (`attach_transport` etc.).
     /// - `poll_remote` / `poll_remote_with_limit` — **receive-side
     ///   excluded by design** (audit-locked Phase 5.5 V2 V2, Codex
     ///   M1 + Opus M1, 2026-05-21). When a remote feeds you their
     ///   snapshot, your peer-fanout side is responsible for
     ///   batching its own flushes via explicit
     ///   [`CollabSession::flush_to_transport`] after the drain. The
     ///   exclusion exists for two reasons: (1) avoids the echo-loop
     ///   class with two symmetric-OnAppend peers (see caveat
     ///   below); (2) callers polling a high-volume inbound stream
     ///   commonly want to coalesce many merged blobs into one
     ///   outbound flush. V2 V3 with per-transport version vectors
     ///   will revisit (idempotent re-flush of unchanged state is
     ///   safe under deltas).
     ///
     /// If no transport is attached, this is silently a no-op (the
     /// flush hook checks `self.transport.is_some()` first).
     ///
     /// **Partial-state contract on auto-flush error**: if the auto-
     /// flush attempt fails (transport closed, I/O error), the
     /// surrounding mutator (`append_op` etc.) returns
     /// `Err(CollabSessionError::Transport(_))`. The local mutation
     /// has ALREADY been committed to `self.log` (mutate-then-flush
     /// ordering — Loro doesn't support "ungrowing" an op log, V1
     /// limitation H7). Callers MUST treat their local state as
     /// authoritative for the local UI and either retry the flush
     /// (transport recovered) or detach the transport.
     ///
-    /// **Symmetric-OnAppend caveat (Phase 5.5 V2 V2 audit closure,
-    /// 2026-05-21):** in V2 V2, enabling `OnAppend` on BOTH peers of
-    /// a paired transport (e.g. `LoopbackTransport::pair()`) is
-    /// safe today ONLY because `poll_remote` deliberately does not
-    /// auto-flush (see exclusion list above). If a future
-    /// contributor wires `poll_remote` into the auto-flush path
-    /// without also adding a version-vector / "did state advance"
-    /// idempotency guard, a ping-pong echo loop results: A appends
-    /// → A flushes → B polls + merges + auto-flushes (no-op merge,
-    /// but unchanged snapshot back to A) → A polls + merges +
-    /// auto-flushes → etc. Loro deduplicates op-level, but the
-    /// wire payload churns. V2 V3 closes the asymmetry + the
-    /// idempotency guard together.
+    /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
+    /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
+    /// transport is now safe via the V2 V3 idempotency guard. The
+    /// guard short-circuits `flush_delta_to_transport` when no ops
+    /// have been appended since the last successful flush. A
+    /// merged peer-snapshot that didn't actually advance local
+    /// state (Loro CRDT dedupe) leaves the VV unchanged, so the
+    /// subsequent auto-flush is a no-op send. The original V2 V2
+    /// echo-loop concern (each peer re-flushing the same snapshot)
+    /// is closed at the source. V2 V3 step 2 can then safely wire
+    /// `poll_remote` into auto-flush without re-introducing the
+    /// loop.
+    ///
+    /// Note: the `poll_remote*` exclusion above STILL applies in V2
+    /// V3 step 1 — it's wired in step 2 separately. Until step 2,
+    /// callers fanning a polled batch onward must use explicit
+    /// [`flush_delta_to_transport`] or [`flush_to_transport`].
     OnAppend,
 }
 
 /// Per-peer collaboration state holder.
 ///
 /// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
 /// at scaffold time; Phase 5.5 will add the live transport
 /// integration via `Transport::send` / `try_recv`.
 ///
 /// The session is the engine-side handle for one peer's view of a
 /// shared workbook. Multiple peers each hold their own
 /// `CollabSession`, exchange byte blobs via [`crate::Transport`],
 /// and call `merge_bytes` to incorporate remote ops. All sessions
 /// converge to the same `OpLog` content after exchange (per Loro's
 /// CRDT determinism — Phase 5.1 audit Codex V1).
 pub struct CollabSession {
     peer_id: PeerId,
     log: OpLog,
     /// Phase 5.4 V1 — peer-local undo/redo.
     ///
     /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
     /// in DECLARATION order, so this drops LAST (after `log`).
     /// That is safe here because `loro::UndoManager` owns its own
     /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
     /// borrow from `log`'s doc and won't UAF when `log` drops first.
     undo: loro::UndoManager,
     /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
     /// transport. `None` until `attach_transport` is called.
     /// Boxed + `Send` so callers can move sessions between
     /// threads with attached transports.
     ///
     /// V2 V1 scope was explicit-drive (caller invokes flush + poll
     /// on a tick). V2 V2 (2026-05-21) adds `AutoFlushPolicy::OnAppend`
     /// for IDE callers who want every mutator to propagate.
     transport: Option<Box<dyn Transport + Send>>,
     /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy. Default
     /// is `Disabled` so existing V2 V1 callers see no behavior
     /// change. Set via [`set_auto_flush_policy`].
     auto_flush_policy: AutoFlushPolicy,
+    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** tracks the
+    /// `loro::VersionVector` at the time of the last successful
+    /// `flush_to_transport` / `flush_delta_to_transport` call.
+    ///
+    /// `None` means "no successful flush yet" — the next delta-flush
+    /// sends from the empty VV (= all ops the doc has ever seen).
+    ///
+    /// Lifecycle:
+    /// - Initialized `None` in `new` + `from_snapshot`.
+    /// - Reset to `None` on `attach_transport` (a new transport-peer
+    ///   needs the full state from scratch) and `detach_transport`
+    ///   (orphaned VV is meaningless).
+    /// - Updated to `Some(current_vv)` after a successful send via
+    ///   either `flush_to_transport` (full snapshot path) or
+    ///   `flush_delta_to_transport` (V2 V3 delta path).
+    /// - NOT updated on flush failure (`Err`) — caller can retry.
+    last_flushed_vv: Option<loro::VersionVector>,
 }
 
 impl CollabSession {
     /// Construct a fresh session with an empty op log.
     ///
     /// Use this when no shared base snapshot exists yet (the first
     /// peer to open a brand-new workbook). The `peer_id` is wired
     /// through to the underlying `LoroDoc::set_peer_id` so Loro's
     /// CRDT merge metadata attributes this session's appends to
     /// `peer_id` (not Loro's default random per-doc id).
     ///
     /// **Caller pitfalls** (from `OpLog::set_peer_id`):
     /// - Two concurrent sessions MUST use distinct peer ids.
     ///   Duplicate ids corrupt the document via conflicting OpIDs.
     /// - Prefer per-process-random peer ids over user-/device-pinned
     ///   ids unless your transport layer enforces single-ownership.
     /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
     ///   `CollabSessionError::OpLog`.
     /// - **Phase 5.2 D-1 step 4 (Opus step-2 L4 closure):**
     ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
     ///   by the qbook envelope's pre-5.2 u32 → tagged-tuple FormatId
     ///   migration. Active multi-peer sessions MUST use a non-zero
     ///   peer id; **release builds enforce** this here so misuse
     ///   fails loudly in production too.
     ///
     /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
     /// 2026-05-20):** the prior `debug_assert_ne!` was a no-op in
     /// `--release` builds. Now uses `assert!` so the guard fires
     /// regardless of build profile. Centralized in `OpLog::set_peer_id`
     /// too (see ql-oplog) for the lower-level construction path.
     pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
         assert_ne!(
             peer_id.as_u64(),
             0,
             "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
              Active CollabSession peers MUST use a non-zero PeerId."
         );
         let mut log = OpLog::new();
         log.set_peer_id(peer_id.as_u64())?;
         let undo = make_undo_manager(&log);
         Ok(Self {
             peer_id,

exec
/bin/zsh -lc "git diff --unified=80 b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,180p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-oplog/src/log.rs b/quantbook-engine/crates/ql-oplog/src/log.rs
index e2c61175cc7..3a13a896b2d 100644
--- a/quantbook-engine/crates/ql-oplog/src/log.rs
+++ b/quantbook-engine/crates/ql-oplog/src/log.rs
@@ -249,160 +249,193 @@ impl OpLog {
     /// Surfaces `OpLogError::SchemaMismatch` if the `"presence"` map
     /// holds a non-string or container value at `peer_key` (only
     /// reachable if a future writer puts wrong-shape data into the
     /// container; current API only writes strings).
     pub fn presence_get(&self, peer_key: &str) -> Result<Option<String>, OpLogError> {
         let map = self.doc.get_map(PRESENCE_CONTAINER);
         let Some(entry) = map.get(peer_key) else {
             return Ok(None);
         };
         let value = match entry {
             ValueOrContainer::Value(v) => v,
             ValueOrContainer::Container(_) => {
                 return Err(OpLogError::SchemaMismatch(
                     "presence LoroMap holds a container value; expected JSON string",
                 ));
             }
         };
         match value {
             LoroValue::String(s) => Ok(Some(s.to_string())),
             _ => Err(OpLogError::SchemaMismatch(
                 "presence LoroMap holds a non-string LoroValue; expected JSON string",
             )),
         }
     }
 
     /// **Phase 5.6 (2026-05-19):** remove the given peer's presence
     /// entry. Idempotent — deleting a non-existent key is a no-op
     /// (Loro returns Ok). Triggers
     /// `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so the
     /// tombstone propagates AND is excluded from undo.
     pub fn presence_remove(&mut self, peer_key: &str) -> Result<(), OpLogError> {
         let map = self.doc.get_map(PRESENCE_CONTAINER);
         map.delete(peer_key)?;
         self.doc
             .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
         Ok(())
     }
 
     /// **Phase 5.4 V1 (2026-05-19):** construct a Loro `UndoManager`
     /// bound to this log's underlying `LoroDoc`.
     ///
     /// Per Loro 1.12.0 docs (`lib.rs:3708`):
     /// - "Local-only: undo/redo affects only local operations from
     ///   the bound peer; it does not revert remote edits."
     /// - "keep the `peer_id` stable while an `UndoManager` is in
     ///   use."
     ///
     /// Callers MUST construct the manager AFTER `set_peer_id` and
     /// SHOULD NOT change the peer id while it's alive. The returned
     /// manager subscribes to the doc's commit stream; subsequent
     /// `append` / `presence_set` / `presence_remove` calls feed it.
     ///
     /// Presence writes use the `PRESENCE_COMMIT_ORIGIN` origin
     /// (see [`presence_set`]). To exclude them from the undo stack
     /// call `manager.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`
     /// after construction. The `ql_collab::CollabSession`
     /// integration does this automatically.
     pub fn new_undo_manager(&self) -> loro::UndoManager {
         loro::UndoManager::new(&self.doc)
     }
 
     /// **Phase 5.6 (2026-05-19):** list the peer keys currently
     /// represented in the `"presence"` map.
     ///
     /// Order is Loro's iteration order (not stable across versions).
     /// Callers wanting deterministic order should sort the result.
     pub fn presence_peers(&self) -> Vec<String> {
         let map = self.doc.get_map(PRESENCE_CONTAINER);
         let mut out = Vec::with_capacity(map.len());
         map.for_each(|key, _| out.push(key.to_owned()));
         out
     }
 
     /// Export the log to a binary blob suitable for on-disk persistence.
     /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
     /// compressed.
     pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
         Ok(self.doc.export(ExportMode::Snapshot)?)
     }
 
+    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export the delta of
+    /// ops added SINCE the given version vector `from`. Uses
+    /// `ExportMode::updates(&from)`.
+    ///
+    /// `from = &VersionVector::default()` (empty VV) is equivalent to
+    /// `ExportMode::all_updates()` — sends every op the doc has ever
+    /// seen. Use for fresh-peer handshakes.
+    ///
+    /// `from = &self.oplog_vv()` (current VV) produces a payload with
+    /// no new ops — typically an empty / near-empty wire blob. Use
+    /// for "did anything happen since last sync" checks.
+    ///
+    /// Returns the encoded bytes. Loro's `import` transparently
+    /// consumes both `Snapshot` and `Updates` blobs on the receiver
+    /// side, so the wire format is opaque to peers.
+    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
+        Ok(self.doc.export(ExportMode::updates(from))?)
+    }
+
+    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** read the doc's
+    /// current op-log version vector. Cheap (clones an internal
+    /// `VersionVector`). Used by [`crate::CollabSession`] to track
+    /// per-transport "last successfully flushed" state for delta
+    /// exports.
+    ///
+    /// Wait — `CollabSession` lives in `ql-collab` and depends on
+    /// `ql-oplog`, not the other way around. The cross-reference
+    /// above is one-way: `CollabSession::flush_delta_to_transport`
+    /// calls this accessor. No reverse dependency.
+    pub fn oplog_vv(&self) -> loro::VersionVector {
+        self.doc.oplog_vv()
+    }
+
     /// Reconstruct an `OpLog` from a previously-exported snapshot.
     /// If the snapshot doesn't carry our `"ops"` container shape,
     /// subsequent `iter` / `len` calls operate on an empty list
     /// (Loro creates absent root containers on first access).
     pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
         let doc = LoroDoc::new();
         doc.import(bytes)?;
         Ok(Self { doc })
     }
 
     /// **Phase 5.2 D-4 (2026-05-19):** merge another peer's snapshot
     /// into this log via Loro's CRDT merge. Concurrent appends to
     /// the `"ops"` LoroList are preserved in deterministic causal
     /// order (Fugue/origin-based with peer-id tiebreaker per
     /// `loro-internal::container::richtext::tracker::crdt_rope`).
     ///
     /// Typical pattern for multi-peer collaboration:
     /// 1. Both peers start from a shared snapshot (`import_bytes`).
     /// 2. Each peer appends its own ops independently.
     /// 3. Peer A exports its current state via `export_bytes`.
     /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
     ///    contains both peers' ops in causal order.
     /// 5. Replay against a workbook reconstructs the merged state.
     /// 6. `WorkbookRuntime::recompute_all` resolves derived state
     ///    (spills, formula values) from the merged final state.
     ///
     /// Returns the new `len()` after merge.
     pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
         self.doc.import(bytes)?;
         Ok(self.len())
     }
 }
 
 #[cfg(test)]
 mod tests {
     use super::*;
     use crate::wire::{CellWireValue, NamedTargetWire};
 
     fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
         Op::PutValue {
             sheet,
             row,
             col,
             value: CellWireValue::Number(n),
         }
     }
 
     #[test]
     fn new_log_is_empty() {
         let log = OpLog::new();
         assert!(log.is_empty());
         assert_eq!(log.len(), 0);
         assert!(log.iter().next().is_none());
     }
 
     #[test]
     fn append_single_op_round_trips() {
         let mut log = OpLog::new();
         let op = put_value(0, 5, 3, 42.0);
         log.append(op.clone()).unwrap();
         assert_eq!(log.len(), 1);
         let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/phase5/v1-exit-packet.md | sed -n '236,270p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/ide-consumer-contract.md | sed -n '198,212p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   236	  `CollabSession::rebuild_workbook` production-wiring wrapper. The
   237	  D-3 `#NAME?` simple-case from Phase 5.2 still ships as the
   238	  raw-replay-without-repair fallback; production callers route
   239	  through `rebuild_workbook` which atomically replays + repairs.
   240	  See `docs/phase5/5-3-exit-packet.md` + 20 audit transcripts at
   241	  `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked
   242	  at `docs/PHASE-4-V2-BACKLOG.md` Tier H.
   243	
   244	- **Phase 5.5 V2 V2 — auto-flush on append.** ✅ **SHIPPED
   245	  2026-05-21**. `AutoFlushPolicy::{Disabled, OnAppend}` enum on
   246	  `CollabSession` (default `Disabled` preserves V2 V1 behavior).
   247	  `OnAppend` triggers flush after every mutator (delta path in
   248	  V2 V3 step 1); partial-state contract documented for transport-
   249	  failure case. 19 integration tests (14 ship + 5 audit-closure)
   250	  at `crates/ql-collab/tests/auto_flush.rs`. No new external deps;
   251	  no breaking changes to V2 V1 API.
   252	
   253	- **Phase 5.5 V2 V3 step 1 — version-vector delta flush.** ✅
   254	  **SHIPPED 2026-05-21**. New `CollabSession::flush_delta_to_transport`
   255	  + `last_flushed_vv: Option<VersionVector>` field. Auto-flush
   256	  reroutes through delta path. Idempotency short-circuit closes
   257	  V2 V2 audit echo-loop class. New `OpLog` helpers: `oplog_vv()`
   258	  + `export_delta_bytes(&VersionVector)`. 9 new integration tests
   259	  (total 28 at `crates/ql-collab/tests/auto_flush.rs`). No new
   260	  external deps.
   261	
   262	- **Phase 5.5 V2 V3 steps 2-6 — Production transport.** Step 2:
   263	  wire `poll_remote` into auto-flush (now safe with V2 V3 step 1
   264	  idempotency guard). Step 3: offline-write queue. Step 4:
   265	  WebSocket transport impl (+ reconnect / offline sync). Step 5:
   266	  full-arc megaudit. Step 6: V2 V3 exit packet. 3-6 days
   267	  estimated.
   268	
   269	- **Phase 5.7 — IDE vertical slice.** Two-window editing demo.
   270	  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2 (✅) + V2 V3.

 succeeded in 0ms:
   198	### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
   199	
   200	Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:
   201	
   202	- **`ql_collab::CollabSession`** — per-peer session holder. Wraps an `OpLog` + `loro::UndoManager` + optional `Box<dyn Transport>`.
   203	- **`CollabSession::new(peer_id) -> Result<Self, _>`** + **`from_snapshot(peer_id, bytes)`** — construction.
   204	- **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
   205	- **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
   206	- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 will add WebSocket.
   207	- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
   208	- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
   209	- **Receive-side exclusion**: `poll_remote` / `poll_remote_with_limit` do NOT auto-flush by design (audit-locked Phase 5.5 V2 V2 Codex M1 + Opus M1, 2026-05-21). V2 V3 step 1 keeps this exclusion intact; step 2 will wire `poll_remote` into auto-flush safely thanks to the V2 V3 idempotency guard. Until step 2 ships, callers fanning a polled batch onward must invoke explicit `flush_delta_to_transport` (or `flush_to_transport`) after the drain. **Fanout caveat (3+ peers)**: in a hub topology (A↔hub↔B) where each peer's writes should reach the other, the HUB must enable `OnAppend` AND call `flush_delta_to_transport` after each `poll_remote` batch. Symmetric `OnAppend` on both endpoints of a paired transport is safe under V2 V3 step 1 idempotency guard (each side short-circuits when its own state didn't advance).
   210	- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
   211	- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.
   212	

exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/MASTER-PLAN.md | sed -n '540,590p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   540	- Updated legal/provenance notes ⚠️ EXISTS per-source in `.references/` but no top-level summary; deferred.
   541	- `docs/PHASE-4-V2-BACKLOG.md` ✅ (NEW 2026-05-18) — aggregated 14 deferred HIGHs from Phase 4.11+4.12 megaudits.
   542	
   543	## Phase 5 - Multi-User CRDT Collaboration
   544	
   545	**Status (2026-05-21): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 step 1 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure). Remaining: 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, 5.8 Phase 5 megaudit (separate).
   546	
   547	**Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.
   548	
   549	**Entry State Required**
   550	
   551	- Phase 3 graph runtime exists.
   552	- Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.
   553	
   554	**Dependencies**
   555	
   556	- Requires stable operation vocabulary from `ql-oplog`.
   557	- Requires storage semantics for computed versus user state.
   558	- Requires IDE proof surface for multi-user presence.
   559	
   560	**Sub-items**
   561	
   562	1. **5.1 Collaboration Data Model Decision** ✅ SHIPPED 2026-05-19 (`918d7efdd91` + `df52cb44ad2`).
   563	   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
   564	
   565	2. **5.2 `ql-collab` Core Documents** 🟡 IN PROGRESS.
   566	   - ✅ D-2 (`1ca19e2fa37`) AddSheet auto-rename.
   567	   - ✅ D-3 (`e71312d4bcd`) UnknownSheet → #NAME?.
   568	   - ✅ D-4 (`2f217a2067a`) OpLog::merge_bytes + 2-peer spill probe.
   569	   - ✅ 5.2.a scaffold (`66a571b30af`).
   570	   - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
   571	   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
   572	
   573	3. **5.3 Conflict Resolution Semantics** ✅ SHIPPED 2026-05-20. Causality-aware rename-repair pass for sheets + tables + columns. 4 days actual (vs 4-7 day estimate). All 6 steps + 14 audit cycles complete. **14/14 audit cycles caught real bugs.** Workspace tests: 4291 → 4361 (+70). New public API: `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` convenience wrapper. See `docs/phase5/5-3-exit-packet.md` for the closure record + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked at `docs/PHASE-4-V2-BACKLOG.md` Tier H. **Production-visible D-3 closure happens at step 5.7 IDE binding** (rebuild_workbook is shipped as the API entry; IDE has to wire it).
   574	
   575	4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
   576	   - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
   577	   - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
   578	   - V2 V1.1 (`7cbdc689ea9`): RAII `start_undo_group_scoped` returning `UndoGroupGuard` (panic/Err-safe). Codex audit PASS.
   579	   - V2 V2 pending: push/pop listeners (lower priority, speculative).
   580	
   581	5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 + V2 V2 (auto-flush) + V2 V3 step 1 (delta flush) SHIPPED 2026-05-21; V2 V3 steps 2-6 pending.
   582	   - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
   583	   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
   584	   - V2 V2 (`51748b02944` ship + `b7aa4cb7bb9` audit-closure): `AutoFlushPolicy::{Disabled, OnAppend}` enum. Default `Disabled` (V2 V1 behavior); `OnAppend` triggers flush after every mutator.
   585	   - **V2 V3 step 1 ✅ SHIPPED 2026-05-21**: per-transport version-vector tracking + new `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. Wire payload is O(per-op delta) instead of O(full state). New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
   586	   - V2 V3 steps 2-6 pending: poll_remote auto-flush wiring (step 2) + offline-write queue (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5) + exit packet (step 6).
   587	
   588	6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
   589	   - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
   590	   - V2 (`d4b3cdb2dc2`): `sweep_presence` caller-opt-in clean-slate.

exec
/bin/zsh -lc "rg -n \"name = \\\"loro\\\"|name = \\\"loro-internal\\\"|loro =\" quantbook-engine/Cargo.lock quantbook-engine/Cargo.toml quantbook-engine/crates/*/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/Cargo.toml:81:loro = "=1.12.0"
quantbook-engine/Cargo.lock:1449:name = "loro"
quantbook-engine/Cargo.lock:1495:name = "loro-internal"

exec
/bin/zsh -lc "rg -n \"pub struct VersionVector|struct VersionVector|impl.*PartialEq.*VersionVector|type VersionVector|oplog_vv\\(|ExportMode::updates|pub fn updates|all_updates|VersionVector::default\" ~/.cargo/registry/src /Users/sanzhar/.cargo/registry/src 2>/dev/null" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 1408ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:197:    /// let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:416:    /// let u1 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:418:    /// let u2 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:691:    /// [`ExportMode::all_updates`] / [`ExportMode::updates`] for updates.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:699:    /// let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:707:    ///   fetch those missing ranges (e.g., using `export(ExportMode::updates(&doc.oplog_vv()))`) and re-import.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:733:    /// let json = a.export_json_updates(&VersionVector::default(), &a.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:753:    /// let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:754:    /// let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:775:    /// let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:776:    /// let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:887:    pub fn oplog_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:888:        self.doc.oplog_vv()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1274:    /// - [`ExportMode::all_updates()`]: all known ops
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1275:    /// - [`ExportMode::updates(&VersionVector)`]: ops since a specific version
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1277:    /// - [`ExportMode::updates_in_range(..)`]: ops in specific ID spans
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1295:    /// let all = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1298:    /// let vv = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1299:    /// let delta = doc.export(ExportMode::updates(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1516:    /// doc2.import(&doc.export(ExportMode::all_updates()).unwrap()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:549:        let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:566:            None => (VersionVector::default(), None),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:601:        let expected_vv = expected_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:602:        let got_vv = got_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_golden_gen.rs:393:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_golden_gen.rs:394:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:18:- Sync between peers: [`export(ExportMode::updates(&vv))`](struct.LoroDoc.html#method.export) + [`import`](struct.LoroDoc.html#method.import) - Exchange incremental updates (see [`ExportMode::updates`](enum.ExportMode.html#method.updates))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:53:- Incremental updates: [`export(ExportMode::updates(&their_vv))`](struct.LoroDoc.html#method.export) - Send only changes (see [`ExportMode::updates`](enum.ExportMode.html#method.updates))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:108:let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:746:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:747:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:955:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1077:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1084:    let updates_b = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1183:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1201:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1202:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1231:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1293:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1351:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1352:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1386:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1389:    let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1434:        let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1437:        let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1518:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1521:    let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1610:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1706:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1712:    let updates_b = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1904:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1905:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:30:    let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:41:        let updates = doc2.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:45:        let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:237:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:246:        .import(&doc_b.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:457:    let v = doc_0.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:462:    let updates = doc_0.export(ExportMode::updates_owned(v)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/commit_message_test.rs:104:    let changes = doc1.export(loro::ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/commit_message_test.rs:193:    let end_vv = doc1.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:123:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:154:    remote.import(&local.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:158:    local.import(&remote.export(ExportMode::updates(&local.oplog_vv()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:197:    let remote_updates = local.export(ExportMode::updates(&remote.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:24:fn all_updates_snapshot_and_incremental_updates_roundtrip_state() -> LoroResult<()> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:45:    let base_vv = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:53:    let all_updates = source.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:54:    let incremental_updates = source.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:57:    let from_all_updates = LoroDoc::new();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:58:    from_all_updates.import(&all_updates)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:59:    assert_eq!(deep_json(&from_all_updates), deep_json(&source));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:96:    remote.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:102:    doc.import(&remote.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:134:    let base_vv = seed.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:157:    let seed_updates = seed.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:158:    let a_updates = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:159:    let b_updates = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_richtext_unicode.rs:196:    replica.import(&restored.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:38:    let all_updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:39:    let all_meta = LoroDoc::decode_import_blob_meta(&all_updates, false)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:48:    imported.import(&all_updates)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:58:    let first = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(801, 0, 400)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:59:    let middle = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:62:    let last = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:144:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:145:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:165:    let a_update = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:178:    let b_update = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:207:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:212:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:213:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:251:    let first = doc.export(ExportMode::updates_in_range(vec![loro::IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:254:    let second = doc.export(ExportMode::updates_in_range(vec![loro::IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_richtext_advanced.rs:276:    let remote_updates = remote.export(ExportMode::updates(&doc.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_conversion.rs:286:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_conversion.rs:287:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_advanced.rs:150:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/version_frontiers.rs:344:    doc.import(&fork.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/events_subscriptions.rs:311:    let _ = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_functions.rs:129:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:291:    let updates_v1 = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:454:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:455:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:472:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:480:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_value.rs:163:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:197:    assert_eq!(doc.frontiers_to_vv(&v2).unwrap(), doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:244:    assert_eq!(doc.frontiers_to_vv(&v2).unwrap(), doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:269:    let updates = doc.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:272:    assert_eq!(updates_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:275:    let end_counter = *doc.oplog_vv().get(&peer).expect("peer should exist");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:276:    let updates_range = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:283:    assert_eq!(updates_range_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:309:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:310:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:349:    let blob11 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 0, 5)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:350:    let blob12 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 5, 7)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:351:    let blob13 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 6, 12)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:353:    let blob21 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 0, 5)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:354:    let blob22 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 5, 6)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:355:    let blob23 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 6, 12)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:20:    let a_updates = a.export(ExportMode::updates(&b.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:21:    let b_updates = b.export(ExportMode::updates(&a.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:137:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:159:    let base = a.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:161:    let base_vv = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:169:    let a_update = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:175:    let b_update = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:299:    remote.import(&local.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:303:    local.import(&remote.export(ExportMode::updates(&local.oplog_vv()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_large_import_diff.rs:14:    let bob_vv = bob.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_large_import_diff.rs:24:    let updates = alice.export(ExportMode::updates(&bob_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:262:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:263:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:376:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:384:            &doc.export_json_updates_without_peer_compression(&VersionVector::default(), &end)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:480:    let compressed = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/counter.rs:93:    let json_updates = doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/counter.rs:171:    let json_updates = doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:134:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:135:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:311:    let till_v1 = doc.export(ExportMode::updates_till(&v1_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:336:    let empty_range = doc.export(ExportMode::updates_in_range(Vec::<IdSpan>::new()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:362:    let b0 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 0, 1)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:363:    let b1 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 1, 2)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:364:    let b2 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 2, 3)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:390:    let first_vv = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:391:    let first_updates = source.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:396:    let second_updates = source.export(ExportMode::updates(&first_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:433:    let status = fresh.import_with(&source.export(ExportMode::all_updates())?, "sync:full")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:457:    let vv1 = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:465:    let vv2 = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:487:    assert_eq!(snapshot_at_v1.oplog_vv(), vv1);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:490:    updates_till_v2.import(&doc.export(ExportMode::updates_till(&vv2))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:492:    assert_eq!(updates_till_v2.oplog_vv(), vv2);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:493:    updates_till_v2.import(&doc.export(ExportMode::updates(&vv2))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:497:    empty_updates.import(&doc.export(ExportMode::updates_till(&VersionVector::default()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_paths.rs:482:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_paths.rs:574:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:109:    assert_eq!(meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:136:    snapshot_at_doc.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:180:    let first = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(4, 0, 1)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:181:    let second = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(4, 1, 3)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/movable_list_diff_apply.rs:78:    let base_vv = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/movable_list_diff_apply.rs:94:    let updates = remote.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:117:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:118:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:131:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:141:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:427:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:429:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:437:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:446:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_analysis.rs:205:    let exported_from_pending_txn = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_analysis.rs:278:    let latest_updates = doc.export(ExportMode::updates(&shallow.shallow_since_vv().to_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:234:    let end_counter = *doc.oplog_vv().get(&peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:239:    let updates = doc.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:240:    let updates_range = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:263:    assert_eq!(updates_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:267:    assert_eq!(updates_range_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:347:    source.import(&remote.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:349:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:350:    let end = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:26:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:27:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:36:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:45:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:87:    let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:373:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:483:    let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:489:    let updates = doc_b.export(ExportMode::updates(&doc.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:603:        let bytes = doc_1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:631:            .export(ExportMode::updates(&doc_1.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:642:        let bytes = doc_2.export(ExportMode::updates(&vv!(1 => 1))).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:676:    let updates = doc0.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:678:    let bytes = doc1.export(ExportMode::updates(&doc0.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1021:    let updates = doc.export(loro::ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1039:    let updates2 = doc2.export(loro::ExportMode::updates(&doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1125:    let updates = new_doc.export(loro::ExportMode::updates_owned(doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1130:    let updates = doc.export(loro::ExportMode::updates_owned(new_doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1145:    let updates = new_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1169:    let updates = other_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1170:    let vv_before_import = new_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1174:    assert_eq!(new_doc.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1192:    let bytes_a = other_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1193:    let vv = other_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1195:    let bytes_b = other_doc.export(ExportMode::updates(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1198:    let vv_before_import = new_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1202:    assert_eq!(new_doc.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1245:        .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1248:        .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1256:    assert_eq!(doc_a.oplog_vv(), doc_b.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1705:    let bytes = doc.export(loro::ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1826:        .import(&doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1889:    doc.import(&doc2.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1891:    doc2.import(&doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1898:    doc.import(&doc2.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2135:    doc.import(&new_doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2272:        .export(ExportMode::updates(&vv!(0 => 1, 1 => 1)))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2474:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 0, 5)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2477:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 5, 7)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2480:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 6, 12)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2484:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 0, 5)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2487:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 5, 6)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2490:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 6, 12)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:3195:        let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:3288:    new_doc.export_json_updates(&Default::default(), &new_doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:37:    let updates_a = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:48:    let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:60:    let updates_b = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:252:                    .export(ExportMode::updates(&doc2_clone2.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:257:                    .export(ExportMode::updates(&doc1_clone2.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:275:            let update_a = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:279:            let update_b = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/snapshot_at_test.rs:63:    new_doc.import(&doc.export(ExportMode::all_updates()).unwrap())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:14:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:43:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:134:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:224:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:253:            from: Cow::Borrowed(&doc2.oplog_vv()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:276:            .export(loro::ExportMode::updates_owned(new_doc.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:295:    assert_eq!(new_doc.oplog_vv(), new_doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:296:    assert_eq!(new_doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:303:    let bytes = doc.export(ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:305:    assert_eq!(new_doc.oplog_vv(), new_doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:306:    assert_eq!(new_doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:155:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:160:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:252:    let updates = b.export(ExportMode::updates(&a.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:254:    let updates = a.export(ExportMode::updates(&b.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1134:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1136:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1140:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1142:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1199:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1203:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1205:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1223:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1228:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1230:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1325:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1335:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:67:    assert_ne!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:74:    assert_eq!(doc.oplog_vv(), vv!(1 => 12, 2 => 7));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:85:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:94:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:96:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:223:    assert_ne!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:230:    assert_eq!(doc.oplog_vv(), vv!(1 => 12, 0 => 7));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:241:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:147:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:145:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4540:        let exported = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4551:        loro.import(&loro2.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4575:                .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4585:                    .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4609:            .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4613:        let mut vv = doc_a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4617:            updates.push(doc_b.export(ExportMode::updates(&vv)).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4618:            vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4646:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4738:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:633:                    // let updates = new_doc.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:894:    pub fn oplog_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1580:            self.oplog_vv()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1655:        let updates = other.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1725:                let updates = self.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1740:                let bytes = self.export(ExportMode::updates_till(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2421:        let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2472:        let update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2475:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2481:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2498:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2499:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2505:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2509:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2513:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2523:        let json = src.export_json_updates(&Default::default(), &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2526:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2533:            assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2540:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2559:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2579:        let second_json = src.export_json_updates(&first_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2583:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2591:            assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2597:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2620:        let good_suffix_json = src.export_json_updates(&prefix_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2627:        let vv_before_bad_suffix = prefix_dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2639:        assert_eq!(prefix_dst.oplog_vv(), vv_before_bad_suffix);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2645:        assert_eq!(prefix_dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2648:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2657:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2673:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2674:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2680:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2686:        let vv_before_dependency = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2693:        assert_eq!(dst.oplog_vv(), vv_before_dependency);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2698:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2798:        b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2810:        let err = std::panic::catch_unwind(AssertUnwindSafe(|| doc.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag.rs:743:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag.rs:885:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/macros.rs:35:            let mut m = $crate::version::VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:606:        let vv = Rc::new(RefCell::new(VersionVector::default()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/map.rs:58:                                    .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/map.rs:68:                                    .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/tree.rs:142:                                    .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/tree.rs:153:                                    .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:129:                loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:179:            let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:274:                                .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:319:                                .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:325:                            .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:362:                            .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:368:                        .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:373:            let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:407:                            .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:413:                        .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:34:                        let update = c1.export(ExportMode::updates(&c2.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:43:                        let update = c2.export(ExportMode::updates(&c1.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:80:                let _ = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:85:            let buf = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:94:            let buf = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:120:                let _ = loro.export_json_updates(&Default::default(), &loro.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:125:            let json = loro.export_json_updates(&Default::default(), &loro.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:161:                let updates = c2.export(ExportMode::updates(&c1.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:186:        let base_update = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:192:        let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:201:        let incremental_update = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:223:        let base_update = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:229:        let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:239:        let incremental_update = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:66:                        a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:73:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:78:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:100:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:106:                    b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:13:            let mut latest_vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:25:                    updates.push(loro.export(ExportMode::updates(&latest_vv)).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:26:                    latest_vv = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_parallel.rs:81:                    .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/automerge_x100.rs:22:        black_box(loro.export(ExportMode::updates(&v))).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/automerge_x100.rs:23:        v = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/tree.rs:57:        loro.export(ExportMode::all_updates()).unwrap().len()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/tree.rs:75:        loro.export(ExportMode::all_updates()).unwrap().len()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:22:    //         .import(&loro.export(ExportMode::updates(&loro_b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:76:    let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:86:        &loro.oplog_vv(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:105:            loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:110:        let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:27:        let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:30:            &loro.oplog_vv(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:58:        let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:110:    let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:13:    let mut last_vv = actor.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:18:        output.push(actor.export(ExportMode::updates(&last_vv.clone())).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:19:        last_vv = actor.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:6:    let mut latest_vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:18:            let update = loro.export(ExportMode::updates(&latest_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:20:            latest_vv = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/autocommit.rs:17:    let bytes = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:20:    doc2.import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:86:    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:88:    b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1813:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1832:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1853:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/contracts/public_doc.rs:229:    let first_updates = source.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/contracts/public_doc.rs:230:    let second_updates = source.export(ExportMode::updates(&first_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:94:    let v = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:98:    let new_v = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:414:    let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:429:    b.import(&a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:434:    c.import(&b.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:439:    a.import(&c.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:444:    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:486:        .import(&doc_1.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:834:    doc.import(&doc2.export(ExportMode::updates(&doc.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:839:    doc.import(&doc2.export(ExportMode::updates(&doc.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:936:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1265:    let vv1 = doc2.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1267:    let update2 = doc2.export(ExportMode::updates(&vv1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1355:        doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1393:        doc_clone.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1449:        .export_json_updates(&Default::default(), &doc.oplog_vv(), false)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:53:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:79:    let base_updates = base.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:86:    let peer2_updates = peer2.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:95:    let peer3_updates = peer3.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:110:    assert_eq!(&doc.oplog_vv(), vv);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:122:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:124:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:127:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:132:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:143:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:149:    assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:161:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:163:    let version_base = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:169:    let update_peer2 = peer2.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:175:    let update_peer3 = peer3.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:187:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:198:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:204:    assert_eq!(dst.oplog_vv(), expected.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:212:    let vv_before_import = target.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:226:    assert_eq!(target.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:234:    let vv_before_import = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:287:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:297:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:57:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:59:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:62:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:83:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:85:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:88:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:126:            vv: VersionVector::default(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:127:            unparsed_vv: Mutex::new(VersionVector::default()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:721:                let mut expected_vv = ImVersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:1069:                let mut ans_vv = ImVersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:801:        let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:804:        let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:812:        let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:286:            .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:288:        let version1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:290:        let update2 = a.export(ExportMode::updates(&version1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:291:        let version2 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:293:        let update3 = a.export(ExportMode::updates(&version2)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:294:        let version3 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:296:        let update4 = a.export(ExportMode::updates(&version3)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:297:        // let version4 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:299:        let update3_5 = a.export(ExportMode::updates(&version2)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:317:        let version1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:319:        let update2 = a.export(ExportMode::updates(&version1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:320:        let _version2 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:343:        let version_a1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:345:            .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:349:        let update_b1 = b.export(ExportMode::updates(&version_a1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:351:        let version_a1b1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:353:        let update_a2 = a.export(ExportMode::updates(&version_a1b1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:386:        let b_change = b.export(ExportMode::updates(&a.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:410:    //     let version_a12 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:416:    //     let update_b1 = b.export(ExportMode::updates(&version_a12)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:418:    //     let version_a123_b1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:420:    //     let update_a4 = a.export(ExportMode::updates(&version_a123_b1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1723:            let initial_state = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1763:            .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1769:            .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:496:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:564:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:608:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/mermaid.rs:209:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:29:pub struct VersionVector(FxHashMap<PeerID, Counter>);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:269:impl PartialEq for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:281:impl PartialEq for ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:304:pub struct VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:80:    pub fn updates(from: &'a VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:87:    pub fn updates_owned(from: VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:94:    pub fn all_updates() -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:101:    pub fn updates_in_range(spans: impl Into<Cow<'a, [IdSpan]>>) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:141:    pub fn updates_till(vv: &VersionVector) -> ExportMode<'static> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:474:        success: VersionRange::from_vv(&doc.oplog_vv()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:197:    /// let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:416:    /// let u1 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:418:    /// let u2 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:691:    /// [`ExportMode::all_updates`] / [`ExportMode::updates`] for updates.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:699:    /// let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:707:    ///   fetch those missing ranges (e.g., using `export(ExportMode::updates(&doc.oplog_vv()))`) and re-import.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:733:    /// let json = a.export_json_updates(&VersionVector::default(), &a.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:753:    /// let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:754:    /// let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:775:    /// let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:776:    /// let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:887:    pub fn oplog_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:888:        self.doc.oplog_vv()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1274:    /// - [`ExportMode::all_updates()`]: all known ops
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1275:    /// - [`ExportMode::updates(&VersionVector)`]: ops since a specific version
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1277:    /// - [`ExportMode::updates_in_range(..)`]: ops in specific ID spans
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1295:    /// let all = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1298:    /// let vv = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1299:    /// let delta = doc.export(ExportMode::updates(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1516:    /// doc2.import(&doc.export(ExportMode::all_updates()).unwrap()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:549:        let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:566:            None => (VersionVector::default(), None),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:601:        let expected_vv = expected_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_jsonschema_fuzz.rs:602:        let got_vv = got_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_golden_gen.rs:393:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/examples/moon_golden_gen.rs:394:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:18:- Sync between peers: [`export(ExportMode::updates(&vv))`](struct.LoroDoc.html#method.export) + [`import`](struct.LoroDoc.html#method.import) - Exchange incremental updates (see [`ExportMode::updates`](enum.ExportMode.html#method.updates))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:53:- Incremental updates: [`export(ExportMode::updates(&their_vv))`](struct.LoroDoc.html#method.export) - Send only changes (see [`ExportMode::updates`](enum.ExportMode.html#method.updates))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/README.md:108:let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:746:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:747:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:955:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1077:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1084:    let updates_b = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1183:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1201:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1202:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1231:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1293:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1351:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1352:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1386:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1389:    let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1434:        let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1437:        let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1518:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1521:    let schema0 = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1610:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1706:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1712:    let updates_b = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1904:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/moon_transcode.rs:1905:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:30:    let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:41:        let updates = doc2.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/mov.rs:45:        let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:237:        .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:246:        .import(&doc_b.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:457:    let v = doc_0.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/issue.rs:462:    let updates = doc_0.export(ExportMode::updates_owned(v)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/commit_message_test.rs:104:    let changes = doc1.export(loro::ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/commit_message_test.rs:193:    let end_vv = doc1.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:123:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:154:    remote.import(&local.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:158:    local.import(&remote.export(ExportMode::updates(&local.oplog_vv()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_undo.rs:197:    let remote_updates = local.export(ExportMode::updates(&remote.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:24:fn all_updates_snapshot_and_incremental_updates_roundtrip_state() -> LoroResult<()> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:45:    let base_vv = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:53:    let all_updates = source.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:54:    let incremental_updates = source.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:57:    let from_all_updates = LoroDoc::new();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:58:    from_all_updates.import(&all_updates)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:59:    assert_eq!(deep_json(&from_all_updates), deep_json(&source));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:96:    remote.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:102:    doc.import(&remote.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:134:    let base_vv = seed.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:157:    let seed_updates = seed.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:158:    let a_updates = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/sync_import.rs:159:    let b_updates = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_richtext_unicode.rs:196:    replica.import(&restored.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:38:    let all_updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:39:    let all_meta = LoroDoc::decode_import_blob_meta(&all_updates, false)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:48:    imported.import(&all_updates)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:58:    let first = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(801, 0, 400)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:59:    let middle = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/change_store_large_blocks.rs:62:    let last = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:144:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:145:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:165:    let a_update = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_movable.rs:178:    let b_update = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:207:    let updates = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:212:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:213:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:251:    let first = doc.export(ExportMode::updates_in_range(vec![loro::IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_diff.rs:254:    let second = doc.export(ExportMode::updates_in_range(vec![loro::IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_richtext_advanced.rs:276:    let remote_updates = remote.export(ExportMode::updates(&doc.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_conversion.rs:286:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_conversion.rs:287:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_advanced.rs:150:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/version_frontiers.rs:344:    doc.import(&fork.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/events_subscriptions.rs:311:    let _ = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_functions.rs:129:    imported.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:291:    let updates_v1 = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:454:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:455:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:472:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_advanced.rs:480:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_value.rs:163:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:197:    assert_eq!(doc.frontiers_to_vv(&v2).unwrap(), doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:244:    assert_eq!(doc.frontiers_to_vv(&v2).unwrap(), doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:269:    let updates = doc.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:272:    assert_eq!(updates_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:275:    let end_counter = *doc.oplog_vv().get(&peer).expect("peer should exist");
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:276:    let updates_range = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:283:    assert_eq!(updates_range_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:309:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:310:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:349:    let blob11 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 0, 5)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:350:    let blob12 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 5, 7)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:351:    let blob13 = doc_1.export(ExportMode::updates_in_range(vec![IdSpan::new(1, 6, 12)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:353:    let blob21 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 0, 5)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:354:    let blob22 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 5, 6)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_lifecycle.rs:355:    let blob23 = doc_2.export(ExportMode::updates_in_range(vec![IdSpan::new(2, 6, 12)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:20:    let a_updates = a.export(ExportMode::updates(&b.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:21:    let b_updates = b.export(ExportMode::updates(&a.oplog_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:137:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:159:    let base = a.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:161:    let base_vv = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:169:    let a_update = a.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:175:    let b_update = b.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:299:    remote.import(&local.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/smoke.rs:303:    local.import(&remote.export(ExportMode::updates(&local.oplog_vv()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_large_import_diff.rs:14:    let bob_vv = bob.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/text_large_import_diff.rs:24:    let updates = alice.export(ExportMode::updates(&bob_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:262:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:263:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:376:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:384:            &doc.export_json_updates_without_peer_compression(&VersionVector::default(), &end)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/value_encoding.rs:480:    let compressed = doc.export_json_updates(&VersionVector::default(), &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/counter.rs:93:    let json_updates = doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/counter.rs:171:    let json_updates = doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:134:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:135:    let end = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:311:    let till_v1 = doc.export(ExportMode::updates_till(&v1_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:336:    let empty_range = doc.export(ExportMode::updates_in_range(Vec::<IdSpan>::new()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:362:    let b0 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 0, 1)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:363:    let b1 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 1, 2)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:364:    let b2 = source.export(ExportMode::updates_in_range(vec![IdSpan::new(peer, 2, 3)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:390:    let first_vv = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:391:    let first_updates = source.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:396:    let second_updates = source.export(ExportMode::updates(&first_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:433:    let status = fresh.import_with(&source.export(ExportMode::all_updates())?, "sync:full")?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:457:    let vv1 = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:465:    let vv2 = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:487:    assert_eq!(snapshot_at_v1.oplog_vv(), vv1);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:490:    updates_till_v2.import(&doc.export(ExportMode::updates_till(&vv2))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:492:    assert_eq!(updates_till_v2.oplog_vv(), vv2);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:493:    updates_till_v2.import(&doc.export(ExportMode::updates(&vv2))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_export.rs:497:    empty_updates.import(&doc.export(ExportMode::updates_till(&VersionVector::default()))?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_paths.rs:482:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/jsonpath_paths.rs:574:    replica.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:109:    assert_eq!(meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:136:    snapshot_at_doc.import(&doc.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:180:    let first = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(4, 0, 1)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/history_shallow.rs:181:    let second = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(4, 1, 3)]))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/movable_list_diff_apply.rs:78:    let base_vv = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/movable_list_diff_apply.rs:94:    let updates = remote.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:87:    let updates = doc1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:373:    let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:483:    let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:489:    let updates = doc_b.export(ExportMode::updates(&doc.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:603:        let bytes = doc_1.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:631:            .export(ExportMode::updates(&doc_1.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:642:        let bytes = doc_2.export(ExportMode::updates(&vv!(1 => 1))).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:676:    let updates = doc0.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:678:    let bytes = doc1.export(ExportMode::updates(&doc0.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1021:    let updates = doc.export(loro::ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1039:    let updates2 = doc2.export(loro::ExportMode::updates(&doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1125:    let updates = new_doc.export(loro::ExportMode::updates_owned(doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1130:    let updates = doc.export(loro::ExportMode::updates_owned(new_doc.oplog_vv()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1145:    let updates = new_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1169:    let updates = other_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1170:    let vv_before_import = new_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1174:    assert_eq!(new_doc.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1192:    let bytes_a = other_doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1193:    let vv = other_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1195:    let bytes_b = other_doc.export(ExportMode::updates(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1198:    let vv_before_import = new_doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1202:    assert_eq!(new_doc.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1245:        .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1248:        .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1256:    assert_eq!(doc_a.oplog_vv(), doc_b.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1705:    let bytes = doc.export(loro::ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1826:        .import(&doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1889:    doc.import(&doc2.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1891:    doc2.import(&doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:1898:    doc.import(&doc2.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2135:    doc.import(&new_doc.export(loro::ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2272:        .export(ExportMode::updates(&vv!(0 => 1, 1 => 1)))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2474:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 0, 5)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2477:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 5, 7)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2480:        .export(ExportMode::updates_in_range(vec![IdSpan::new(1, 6, 12)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2484:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 0, 5)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2487:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 5, 6)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:2490:        .export(ExportMode::updates_in_range(vec![IdSpan::new(2, 6, 12)]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:3195:        let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/loro_rust_test.rs:3288:    new_doc.export_json_updates(&Default::default(), &new_doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:117:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:118:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:131:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:141:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:427:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:429:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:437:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_history_semantics.rs:446:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:37:    let updates_a = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:48:    let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/perf_import_quadratic.rs:60:    let updates_b = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_analysis.rs:205:    let exported_from_pending_txn = doc.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/doc_analysis.rs:278:    let latest_updates = doc.export(ExportMode::updates(&shallow.shallow_since_vv().to_vv()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:252:                    .export(ExportMode::updates(&doc2_clone2.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:257:                    .export(ExportMode::updates(&doc1_clone2.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:275:            let update_a = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/multi_thread_test.rs:279:            let update_b = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:234:    let end_counter = *doc.oplog_vv().get(&peer).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:239:    let updates = doc.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:240:    let updates_range = doc.export(ExportMode::updates_in_range(vec![IdSpan::new(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:263:    assert_eq!(updates_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:267:    assert_eq!(updates_range_meta.partial_end_vv, doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:347:    source.import(&remote.export(ExportMode::all_updates())?)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:349:    let start = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/storage_encoding.rs:350:    let end = source.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/snapshot_at_test.rs:63:    new_doc.import(&doc.export(ExportMode::all_updates()).unwrap())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:14:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:43:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:134:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/redact_test.rs:224:    let mut json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:253:            from: Cow::Borrowed(&doc2.oplog_vv()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:276:            .export(loro::ExportMode::updates_owned(new_doc.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:295:    assert_eq!(new_doc.oplog_vv(), new_doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:296:    assert_eq!(new_doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:303:    let bytes = doc.export(ExportMode::all_updates());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:305:    assert_eq!(new_doc.oplog_vv(), new_doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/shallow_snapshot_test.rs:306:    assert_eq!(new_doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:26:    let base_updates = base.export(ExportMode::all_updates())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:27:    let base_vv = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:36:    let alice_updates = alice.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/contracts/tree_concurrent_delete_move.rs:45:    let bob_updates = bob.export(ExportMode::updates(&base_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:155:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:160:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:252:    let updates = b.export(ExportMode::updates(&a.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:254:    let updates = a.export(ExportMode::updates(&b.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1134:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1136:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1140:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1142:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1199:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1203:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1205:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1223:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1228:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1230:    let updates = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1325:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/undo_test.rs:1335:    let updates = doc_b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:67:    assert_ne!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:74:    assert_eq!(doc.oplog_vv(), vv!(1 => 12, 2 => 7));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:85:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:94:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:96:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:223:    assert_ne!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:230:    assert_eq!(doc.oplog_vv(), vv!(1 => 12, 0 => 7));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/tests/integration_test/detached_editing_test.rs:241:    assert_eq!(doc.oplog_vv(), doc.state_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:147:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:145:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:633:                    // let updates = new_doc.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:894:    pub fn oplog_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1580:            self.oplog_vv()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1655:        let updates = other.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1725:                let updates = self.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1740:                let bytes = self.export(ExportMode::updates_till(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2421:        let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2472:        let update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2475:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2481:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2498:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2499:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2505:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2509:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2513:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2523:        let json = src.export_json_updates(&Default::default(), &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2526:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2533:            assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2540:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2559:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2579:        let second_json = src.export_json_updates(&first_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2583:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2591:            assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2597:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2620:        let good_suffix_json = src.export_json_updates(&prefix_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2627:        let vv_before_bad_suffix = prefix_dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2639:        assert_eq!(prefix_dst.oplog_vv(), vv_before_bad_suffix);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2645:        assert_eq!(prefix_dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2648:        let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2657:        assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2673:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2674:        let first_vv = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2680:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2686:        let vv_before_dependency = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2693:        assert_eq!(dst.oplog_vv(), vv_before_dependency);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2698:        assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2798:        b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2810:        let err = std::panic::catch_unwind(AssertUnwindSafe(|| doc.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/macros.rs:35:            let mut m = $crate::version::VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:606:        let vv = Rc::new(RefCell::new(VersionVector::default()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:80:    pub fn updates(from: &'a VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:87:    pub fn updates_owned(from: VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:94:    pub fn all_updates() -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:101:    pub fn updates_in_range(spans: impl Into<Cow<'a, [IdSpan]>>) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:141:    pub fn updates_till(vv: &VersionVector) -> ExportMode<'static> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:474:        success: VersionRange::from_vv(&doc.oplog_vv()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4540:        let exported = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4551:        loro.import(&loro2.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4575:                .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4585:                    .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4609:            .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4613:        let mut vv = doc_a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4617:            updates.push(doc_b.export(ExportMode::updates(&vv)).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4618:            vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4646:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4738:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/autocommit.rs:17:    let bytes = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag.rs:743:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag.rs:885:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:20:    doc2.import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:86:    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/richtext.rs:88:    b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/map.rs:58:                                    .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/map.rs:68:                                    .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/contracts/public_doc.rs:229:    let first_updates = source.export(ExportMode::updates(&VersionVector::default()))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/contracts/public_doc.rs:230:    let second_updates = source.export(ExportMode::updates(&first_vv))?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/tree.rs:142:                                    .export(ExportMode::updates(&doc_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/tree.rs:153:                                    .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:94:    let v = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:98:    let new_v = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:414:    let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:429:    b.import(&a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:434:    c.import(&b.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:439:    a.import(&c.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:444:    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:486:        .import(&doc_1.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:834:    doc.import(&doc2.export(ExportMode::updates(&doc.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:839:    doc.import(&doc2.export(ExportMode::updates(&doc.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:936:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1265:    let vv1 = doc2.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1267:    let update2 = doc2.export(ExportMode::updates(&vv1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1355:        doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1393:        doc_clone.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/tests/test.rs:1449:        .export_json_updates(&Default::default(), &doc.oplog_vv(), false)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1813:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1832:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/state/movable_list_state.rs:1853:                .import(&doc.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:129:                loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:179:            let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:274:                                .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:319:                                .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:325:                            .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:362:                            .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:368:                        .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:373:            let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:407:                            .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/text_r.rs:413:                        .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:34:                        let update = c1.export(ExportMode::updates(&c2.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:43:                        let update = c2.export(ExportMode::updates(&c1.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:80:                let _ = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:85:            let buf = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:94:            let buf = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:120:                let _ = loro.export_json_updates(&Default::default(), &loro.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:125:            let json = loro.export_json_updates(&Default::default(), &loro.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:161:                let updates = c2.export(ExportMode::updates(&c1.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:186:        let base_update = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:192:        let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:201:        let incremental_update = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:223:        let base_update = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:229:        let base_vv = doc_b.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/encode.rs:239:        let incremental_update = doc_b.export(ExportMode::updates(&base_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:66:                        a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:73:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:78:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:100:                    a.import(&b.export(ExportMode::updates(&a.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/list.rs:106:                    b.import(&a.export(ExportMode::updates(&b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:13:            let mut latest_vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:25:                    updates.push(loro.export(ExportMode::updates(&latest_vv)).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/benches/pending.rs:26:                    latest_vv = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_parallel.rs:81:                    .export(ExportMode::updates(&loro_b.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/automerge_x100.rs:22:        black_box(loro.export(ExportMode::updates(&v))).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/automerge_x100.rs:23:        v = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/tree.rs:57:        loro.export(ExportMode::all_updates()).unwrap().len()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/tree.rs:75:        loro.export(ExportMode::all_updates()).unwrap().len()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:22:    //         .import(&loro.export(ExportMode::updates(&loro_b.oplog_vv())).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:76:    let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:86:        &loro.oplog_vv(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:105:            loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding.rs:110:        let data = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:27:        let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:30:            &loro.oplog_vv(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:58:        let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/encoding_refactored.rs:110:    let updates = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:13:    let mut last_vv = actor.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:18:        output.push(actor.export(ExportMode::updates(&last_vv.clone())).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/list.rs:19:        last_vv = actor.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:53:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:79:    let base_updates = base.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:86:    let peer2_updates = peer2.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:95:    let peer3_updates = peer3.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:110:    assert_eq!(&doc.oplog_vv(), vv);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:122:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:124:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:127:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:132:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:143:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:149:    assert_eq!(dst.oplog_vv(), src.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:161:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:163:    let version_base = base.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:169:    let update_peer2 = peer2.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:175:    let update_peer3 = peer3.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:187:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:198:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:204:    assert_eq!(dst.oplog_vv(), expected.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:212:    let vv_before_import = target.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:226:    assert_eq!(target.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:234:    let vv_before_import = doc.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:287:    let vv_before_import = dst.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:297:    assert_eq!(dst.oplog_vv(), vv_before_import);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:57:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:59:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:62:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:83:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:85:    let version_base = src.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/op_count.rs:88:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:6:    let mut latest_vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:18:            let update = loro.export(ExportMode::updates(&latest_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/examples/pending.rs:20:            latest_vv = loro.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:496:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:564:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/iter.rs:608:        let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:126:            vv: VersionVector::default(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:127:            unparsed_vv: Mutex::new(VersionVector::default()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:721:                let mut expected_vv = ImVersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/loro_dag.rs:1069:                let mut ans_vv = ImVersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/dag/mermaid.rs:209:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:801:        let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:804:        let bytes = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store/block_encode.rs:812:        let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), true);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:29:pub struct VersionVector(FxHashMap<PeerID, Counter>);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:269:impl PartialEq for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:281:impl PartialEq for ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:304:pub struct VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:286:            .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:288:        let version1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:290:        let update2 = a.export(ExportMode::updates(&version1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:291:        let version2 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:293:        let update3 = a.export(ExportMode::updates(&version2)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:294:        let version3 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:296:        let update4 = a.export(ExportMode::updates(&version3)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:297:        // let version4 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:299:        let update3_5 = a.export(ExportMode::updates(&version2)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:317:        let version1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:319:        let update2 = a.export(ExportMode::updates(&version1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:320:        let _version2 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:343:        let version_a1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:345:            .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:349:        let update_b1 = b.export(ExportMode::updates(&version_a1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:351:        let version_a1b1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:353:        let update_a2 = a.export(ExportMode::updates(&version_a1b1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:386:        let b_change = b.export(ExportMode::updates(&a.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:410:    //     let version_a12 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:416:    //     let update_b1 = b.export(ExportMode::updates(&version_a12)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:418:    //     let version_a123_b1 = a.oplog_vv();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/pending_changes.rs:420:    //     let update_a4 = a.export(ExportMode::updates(&version_a123_b1)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1723:            let initial_state = doc_a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1763:            .export(ExportMode::updates(&doc_a.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:1769:            .export(ExportMode::updates(&doc_a.oplog_vv()))

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '1,95p;250,290p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs | sed -n '680,710p;880,892p;1268,1305p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   680	    /// assert_eq!(restored.get_deep_value(), doc.get_deep_value());
   681	    /// ```
   682	    pub fn from_snapshot(bytes: &[u8]) -> LoroResult<Self> {
   683	        let inner = InnerLoroDoc::from_snapshot(bytes)?;
   684	        inner.start_auto_commit();
   685	        Ok(Self::_new(inner))
   686	    }
   687	
   688	    /// Import data exported by [`LoroDoc::export`].
   689	    ///
   690	    /// Use [`ExportMode::Snapshot`] for full-state snapshots, or
   691	    /// [`ExportMode::all_updates`] / [`ExportMode::updates`] for updates.
   692	    ///
   693	    /// # Example
   694	    /// ```
   695	    /// use loro::{LoroDoc, ExportMode};
   696	    ///
   697	    /// let a = LoroDoc::new();
   698	    /// a.get_text("text").insert(0, "Hello").unwrap();
   699	    /// let updates = a.export(ExportMode::all_updates()).unwrap();
   700	    ///
   701	    /// let b = LoroDoc::new();
   702	    /// b.import(&updates).unwrap();
   703	    /// assert_eq!(a.get_deep_value(), b.get_deep_value());
   704	    /// ```
   705	    /// Pitfalls:
   706	    /// - Missing dependencies: check the returned [`ImportStatus`]. If `pending` is non-empty,
   707	    ///   fetch those missing ranges (e.g., using `export(ExportMode::updates(&doc.oplog_vv()))`) and re-import.
   708	    /// - Auto-commit: `import` finalizes the current transaction before applying incoming data.
   709	    #[inline]
   710	    pub fn import(&self, bytes: &[u8]) -> Result<ImportStatus, LoroError> {
   880	    pub fn with_state<R>(&self, f: impl FnOnce(&mut DocState) -> R) -> R {
   881	        let mut state = self.doc.app_state().lock();
   882	        f(&mut state)
   883	    }
   884	
   885	    /// Get the `VersionVector` version of `OpLog`
   886	    #[inline]
   887	    pub fn oplog_vv(&self) -> VersionVector {
   888	        self.doc.oplog_vv()
   889	    }
   890	
   891	    /// Get the `VersionVector` version of `DocState`
   892	    #[inline]
  1268	    }
  1269	
  1270	    /// Export the document in the given mode.
  1271	    ///
  1272	    /// Common modes:
  1273	    /// - [`ExportMode::Snapshot`]: full state + history
  1274	    /// - [`ExportMode::all_updates()`]: all known ops
  1275	    /// - [`ExportMode::updates(&VersionVector)`]: ops since a specific version
  1276	    /// - [`ExportMode::shallow_snapshot(..)`]: GC’d snapshot starting at frontiers
  1277	    /// - [`ExportMode::updates_in_range(..)`]: ops in specific ID spans
  1278	    ///
  1279	    /// Important notes:
  1280	    /// - Auto-commit: `export` finalizes the current transaction before producing bytes.
  1281	    /// - Shallow snapshots: peers cannot import updates from before the shallow start.
  1282	    /// - Performance: exporting fresh snapshots periodically can reduce import time for new peers.
  1283	    ///
  1284	    /// # Examples
  1285	    /// ```
  1286	    /// use loro::{ExportMode, LoroDoc};
  1287	    ///
  1288	    /// let doc = LoroDoc::new();
  1289	    /// doc.get_text("text").insert(0, "Hello").unwrap();
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

 succeeded in 0ms:
     1	mod frontiers;
     2	pub use frontiers::Frontiers;
     3	
     4	use crate::{
     5	    id::{Counter, ID},
     6	    oplog::AppDag,
     7	    span::{CounterSpan, IdSpan},
     8	    LoroError, PeerID,
     9	};
    10	use loro_common::{HasCounter, HasCounterSpan, HasIdSpan, HasLamportSpan, IdFull, IdSpanVector};
    11	use rustc_hash::FxHashMap;
    12	use serde::{Deserialize, Serialize};
    13	use smallvec::SmallVec;
    14	use std::{
    15	    cmp::Ordering,
    16	    ops::{ControlFlow, Deref, DerefMut},
    17	};
    18	
    19	/// [VersionVector](https://en.wikipedia.org/wiki/Version_vector)
    20	/// is a map from [PeerID] to [Counter]. Its a right-open interval.
    21	///
    22	/// i.e. a [VersionVector] of `{A: 1, B: 2}` means that A has 1 atomic op and B has 2 atomic ops,
    23	/// thus ID of `{client: A, counter: 1}` is out of the range.
    24	//
    25	// NOTE: though normally it doesn't make sense to have an entry with counter = 0, but it can be 0 in certain cases.
    26	// Like, when using start_vv and end_vv to mark the version range, start_vv may have an entry with counter = 0.
    27	#[repr(transparent)]
    28	#[derive(Debug, Clone, Serialize, Deserialize)]
    29	pub struct VersionVector(FxHashMap<PeerID, Counter>);
    30	
    31	#[repr(transparent)]
    32	#[derive(Debug, Clone, Default, PartialEq, Eq)]
    33	pub struct VersionRange(pub(crate) FxHashMap<PeerID, (Counter, Counter)>);
    34	
    35	#[macro_export]
    36	macro_rules! version_range {
    37	    ($($peer:expr => ($start:expr, $end:expr)),* $(,)?) => {{
    38	        let mut map = ::rustc_hash::FxHashMap::default();
    39	        $(
    40	            map.insert($peer, ($start, $end));
    41	        )*
    42	        $crate::version::VersionRange::from_map(map)
    43	    }};
    44	}
    45	
    46	impl VersionRange {
    47	    pub fn new() -> Self {
    48	        Self(Default::default())
    49	    }
    50	
    51	    pub fn from_map(map: FxHashMap<PeerID, (Counter, Counter)>) -> Self {
    52	        Self(map)
    53	    }
    54	
    55	    pub fn iter(&self) -> impl Iterator<Item = (&PeerID, &(Counter, Counter))> + '_ {
    56	        self.0.iter()
    57	    }
    58	
    59	    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&PeerID, &mut (Counter, Counter))> + '_ {
    60	        self.0.iter_mut()
    61	    }
    62	
    63	    pub fn clear(&mut self) {
    64	        self.0.clear()
    65	    }
    66	
    67	    pub fn get(&self, peer: &PeerID) -> Option<&(Counter, Counter)> {
    68	        self.0.get(peer)
    69	    }
    70	
    71	    pub fn insert(&mut self, peer: PeerID, start: Counter, end: Counter) {
    72	        self.0.insert(peer, (start, end));
    73	    }
    74	
    75	    pub fn from_vv(vv: &VersionVector) -> Self {
    76	        let mut ans = Self::new();
    77	        for (peer, counter) in vv.iter() {
    78	            ans.insert(*peer, 0, *counter);
    79	        }
    80	        ans
    81	    }
    82	
    83	    pub fn contains_ops_between(&self, vv_a: &VersionVector, vv_b: &VersionVector) -> bool {
    84	        for span in vv_a.sub_iter(vv_b) {
    85	            if !self.contains_id_span(IdSpan::new(
    86	                span.peer,
    87	                span.counter.start.saturating_sub(1),
    88	                span.counter.end,
    89	            )) {
    90	                return false;
    91	            }
    92	        }
    93	
    94	        for span in vv_b.sub_iter(vv_a) {
    95	            if !self.contains_id_span(IdSpan::new(
   250	    pub fn extend_to_include_last_id(&mut self, id: ID) {
   251	        if let Some(counter) = self.0.get_mut(&id.peer) {
   252	            if *counter <= id.counter {
   253	                *counter = id.counter + 1;
   254	            }
   255	        } else {
   256	            self.set_last(id)
   257	        }
   258	    }
   259	
   260	    pub(crate) fn includes_id(&self, x: ID) -> bool {
   261	        if self.is_empty() {
   262	            return false;
   263	        }
   264	
   265	        self.get(&x.peer).copied().unwrap_or(0) > x.counter
   266	    }
   267	}
   268	
   269	impl PartialEq for VersionVector {
   270	    fn eq(&self, other: &Self) -> bool {
   271	        self.iter()
   272	            .all(|(client, counter)| other.get(client).unwrap_or(&0) == counter)
   273	            && other
   274	                .iter()
   275	                .all(|(client, counter)| self.get(client).unwrap_or(&0) == counter)
   276	    }
   277	}
   278	
   279	impl Eq for VersionVector {}
   280	
   281	impl PartialEq for ImVersionVector {
   282	    fn eq(&self, other: &Self) -> bool {
   283	        self.0
   284	            .iter()
   285	            .all(|(client, counter)| other.0.get(client).unwrap_or(&0) == counter)
   286	            && other
   287	                .0
   288	                .iter()
   289	                .all(|(client, counter)| self.0.get(client).unwrap_or(&0) == counter)
   290	    }

exec
/bin/zsh -lc "rg -n \"fn oplog_vv|oplog_vv\\(&self\\)|VersionVector\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src | head -100" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:40:    InternalString, VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:107:    from_vv: &'a VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:108:    to_vv: &'a VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:143:        before: &crate::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:145:        after: &crate::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:391:    fn start_tracking(&mut self, oplog: &OpLog, vv: &crate::VersionVector, mode: DiffMode);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:396:        vv: Option<&crate::VersionVector>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:443:        _vv: &crate::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:454:        _vv: Option<&crate::VersionVector>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:557:    start_vv: VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:584:    fn start_tracking(&mut self, _oplog: &OpLog, vv: &crate::VersionVector, _mode: DiffMode) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:597:        vv: Option<&crate::VersionVector>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:766:        start_vv: VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:780:                start_vv: VersionVector::new(),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:802:        vv: &crate::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:841:        vv: Option<&crate::VersionVector>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:1204:    fn start_tracking(&mut self, _oplog: &OpLog, vv: &crate::VersionVector, mode: DiffMode) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/diff_calc.rs:1218:        vv: Option<&crate::VersionVector>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:98:        version::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:141:        vv: VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:147:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:174:        fn vv(&self) -> &VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:305:        version_vec: crate::version::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:311:            let mut vv = crate::version::VersionVector::new();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/bfs.rs:351:        fn vv(&self) -> &crate::version::VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:96:        version::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:139:        vv: VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:145:            let mut vv = VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:172:        fn vv(&self) -> &VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:303:        version_vec: crate::version::VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:309:            let mut vv = crate::version::VersionVector::new();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/allocation/dfs.rs:349:        fn vv(&self) -> &crate::version::VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/macros.rs:35:            let mut m = $crate::version::VersionVector::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:35:    version::{shrink_frontiers, Frontiers, ImVersionVector, VersionRange, VersionVectorDiff},
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:37:    VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:846:        start_vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:847:        end_vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:853:            let _temp: Option<VersionVector>;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:894:    pub fn oplog_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:900:    pub fn state_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1642:    pub fn vv_to_frontiers(&self, vv: &VersionVector) -> Frontiers {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1647:    pub fn frontiers_to_vv(&self, frontiers: &Frontiers) -> Option<VersionVector> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2007:    pub fn shallow_since_vv(&self) -> ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2033:    pub fn find_id_spans_between(&self, from: &Frontiers, to: &Frontiers) -> VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2316:        version::{Frontiers, VersionVector},
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2359:        let vv = VersionVector::from_iter([(peer, 1)]);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2614:        let prefix_vv = VersionVector::from_iter([(peer, last_op_counter)]);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/history_cache.rs:31:    OpLog, VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/history_cache.rs:533:        vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/history_cache.rs:768:        vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/history_cache.rs:852:        vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:28:use crate::version::{Frontiers, ImVersionVector, VersionVector};
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:66:    old_vv: VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:420:    pub(crate) fn vv(&self) -> &VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:523:    pub(crate) fn export_change_store_from(&self, vv: &VersionVector, f: &Frontiers) -> Bytes {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:531:        vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:533:        to_vv: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:540:    pub(crate) fn export_blocks_from<W: std::io::Write>(&self, vv: &VersionVector, w: &mut W) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:576:        from: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:578:        to: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:581:        VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:587:                    Rc<RefCell<VersionVector>>,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:606:        let vv = Rc::new(RefCell::new(VersionVector::default()));
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:673:        from: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:674:        to: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:684:        from: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:685:        to: &VersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:773:    pub fn shallow_since_vv(&self) -> &ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:19:/// [VersionVector](https://en.wikipedia.org/wiki/Version_vector)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:22:/// i.e. a [VersionVector] of `{A: 1, B: 2}` means that A has 1 atomic op and B has 2 atomic ops,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:29:pub struct VersionVector(FxHashMap<PeerID, Counter>);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:75:    pub fn from_vv(vv: &VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:83:    pub fn contains_ops_between(&self, vv_a: &VersionVector, vv_b: &VersionVector) -> bool {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:156:/// It's more memory efficient than [VersionVector] when the version vector
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:160:pub struct ImVersionVector(im::HashMap<PeerID, Counter, rustc_hash::FxBuildHasher>);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:162:impl ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:208:        let vv = VersionVector::decode(bytes)?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:212:    pub fn to_vv(&self) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:213:        VersionVector(self.0.iter().map(|(&k, &v)| (k, v)).collect())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:216:    pub fn from_vv(vv: &VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:217:        ImVersionVector(vv.0.iter().map(|(&k, &v)| (k, v)).collect())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:241:    pub fn merge_vv(&mut self, other: &VersionVector) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:269:impl PartialEq for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:279:impl Eq for VersionVector {}
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:281:impl PartialEq for ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:293:impl Eq for ImVersionVector {}
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:295:impl Deref for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:304:pub struct VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:315:impl VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:369:impl PartialOrd for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:411:impl PartialOrd for ImVersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:453:impl DerefMut for VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:459:impl VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:460:    pub fn diff(&self, rhs: &Self) -> VersionVectorDiff {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:461:        let mut ans: VersionVectorDiff = Default::default();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:556:        rhs: &'a ImVersionVector,
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:716:    pub fn includes_vv(&self, other: &VersionVector) -> bool {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:826:    pub fn intersection(&self, other: &VersionVector) -> VersionVector {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:827:        let mut ans = VersionVector::new();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:849:        postcard::from_bytes(bytes).map_err(|_| LoroError::DecodeVersionVectorError)

exec
/bin/zsh -lc "rg -n \"pub enum ExportMode|struct ExportMode|enum ExportMode|all_updates|updates\\(\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src | head -80" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:197:    /// let updates = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:416:    /// let u1 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:418:    /// let u2 = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:691:    /// [`ExportMode::all_updates`] / [`ExportMode::updates`] for updates.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:699:    /// let updates = a.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:707:    ///   fetch those missing ranges (e.g., using `export(ExportMode::updates(&doc.oplog_vv()))`) and re-import.
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:733:    /// let json = a.export_json_updates(&VersionVector::default(), &a.oplog_vv());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:736:    /// b.import_json_updates(json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:744:        self.doc.import_json_updates(json)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:755:    /// let json = doc.export_json_updates(&start, &end);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:758:    pub fn export_json_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:763:        self.doc.export_json_updates(start_vv, end_vv, true)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:785:        self.doc.export_json_updates(start_vv, end_vv, false)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1274:    /// - [`ExportMode::all_updates()`]: all known ops
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1275:    /// - [`ExportMode::updates(&VersionVector)`]: ops since a specific version
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1295:    /// let all = doc.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1299:    /// let delta = doc.export(ExportMode::updates(&vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-1.12.0/src/lib.rs:1516:    /// doc2.import(&doc.export(ExportMode::all_updates()).unwrap()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:633:                    // let updates = new_doc.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:844:    pub fn export_json_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1655:        let updates = other.export(ExportMode::updates(&self.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1725:                let updates = self.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:1987:                ExportMode::Updates { from } => export_fast_updates(self, &from),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2421:        let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2472:        let update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2498:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2505:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2523:        let json = src.export_json_updates(&Default::default(), &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2531:            let err = dst.import_json_updates(json.clone()).unwrap_err();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2539:        dst.import_json_updates(json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2560:        let first_json = src.export_json_updates(&Default::default(), &first_vv, false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2579:        let second_json = src.export_json_updates(&first_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2582:        dst.import_json_updates(first_json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2589:            let err = dst.import_json_updates(second_json.clone()).unwrap_err();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2596:        dst.import_json_updates(second_json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2610:        good_dst.import_json_updates(good_json.clone()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2615:        let prefix_json = src.export_json_updates(&Default::default(), &prefix_vv, false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2620:        let good_suffix_json = src.export_json_updates(&prefix_vv, &src.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2626:        prefix_dst.import_json_updates(prefix_json.clone()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2633:            .import_json_updates(&bad_suffix_json)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2643:        prefix_dst.import_json_updates(good_suffix_json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2652:        let err = dst.import_json_updates(&bad_json).unwrap_err();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2673:        let first_update = src.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2680:        let second_update = src.export(ExportMode::updates(&first_vv)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2717:        let err = dst.import_json_updates(&bad_json).unwrap_err();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2726:        dst.import_json_updates(good_json).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs:2798:        b.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/awareness.rs:231:/// store.subscribe_local_updates(Box::new(|data| {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/awareness.rs:333:    /// let sub = store.subscribe_local_updates(Box::new(move |bytes| {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/awareness.rs:342:    pub fn subscribe_local_updates(&self, callback: LocalEphemeralCallback) -> Subscription {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/awareness.rs:343:        self.inner.subscribe_local_updates(callback)
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/awareness.rs:803:    pub fn subscribe_local_updates(&self, callback: LocalEphemeralCallback) -> Subscription {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:53:pub enum ExportMode<'a> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:80:    pub fn updates(from: &'a VersionVector) -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:94:    pub fn all_updates() -> Self {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:256:        EncodeMode::FastUpdates => fast_snapshot::decode_updates(oplog, body.to_vec().into()),
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:386:pub(crate) fn export_fast_updates(doc: &LoroDoc, vv: &VersionVector) -> Vec<u8> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs:388:        fast_snapshot::encode_updates(doc, vv, ans);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4540:        let exported = loro.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4551:        loro.import(&loro2.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4575:                .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4585:                    .export(ExportMode::updates(&loro.oplog_vv()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4609:            .import(&doc_a.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4617:            updates.push(doc_b.export(ExportMode::updates(&vv)).unwrap());
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4646:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/handler.rs:4738:            .import(&loro.export(ExportMode::all_updates()).unwrap())
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/json_schema.rs:1599:        let json = doc.export_json_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/json_schema.rs:1605:        let json = doc.export_json_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:324:    let mut changes = ChangeStore::decode_snapshot_for_updates(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:346:pub(crate) fn decode_updates(oplog: &mut OpLog, body: Bytes) -> Result<Vec<Change>, LoroError> {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:384:        let err = decode_updates(&mut oplog, Bytes::from_static(&[0x02, 0x01]))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:424:    let changes = decode_updates(&mut oplog, parsed.body.to_vec().into())?;
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:53:    let json = doc.export_json_updates(&Default::default(), &doc.oplog_vv(), false);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:79:    let base_updates = base.export(ExportMode::all_updates()).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:86:    let peer2_updates = peer2.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:95:    let peer3_updates = peer3.export(ExportMode::updates(&base.oplog_vv())).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:122:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:127:    let update_later = src.export(ExportMode::updates(&version_base)).unwrap();
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:161:        .export(ExportMode::updates(&VersionVector::default()))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/tests/import_atomicity.rs:169:    let update_peer2 = peer2.export(ExportMode::updates(&version_base)).unwrap();

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding.rs | sed -n '48,100p;380,392p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    48	///
    49	/// - Exports the state of the target version.
    50	/// - Includes a minimal set of operation history.
    51	#[non_exhaustive]
    52	#[derive(Debug, Clone)]
    53	pub enum ExportMode<'a> {
    54	    /// It contains the full history and the current state of the document.
    55	    Snapshot,
    56	    /// It contains the history since the `from` version vector.
    57	    Updates { from: Cow<'a, VersionVector> },
    58	    /// This mode exports the history in the specified range.
    59	    UpdatesInRange { spans: Cow<'a, [IdSpan]> },
    60	    /// The shallow snapshot only contains the history since the target frontiers
    61	    ShallowSnapshot(Cow<'a, Frontiers>),
    62	    /// The state only snapshot exports the state of the target version
    63	    /// with a minimal set of history (a few ops).
    64	    ///
    65	    /// It's a shallow snapshot with depth=1 at the target version.
    66	    /// If the target version is None, it will use the latest version as the target version.
    67	    StateOnly(Option<Cow<'a, Frontiers>>),
    68	    /// The snapshot at the specified frontiers. It contains the full history
    69	    /// till the target frontiers and the state at the target frontiers.
    70	    SnapshotAt { version: Cow<'a, Frontiers> },
    71	}
    72	
    73	impl<'a> ExportMode<'a> {
    74	    /// It contains the full history and the current state of the document.
    75	    pub fn snapshot() -> Self {
    76	        ExportMode::Snapshot
    77	    }
    78	
    79	    /// It contains the history since the `from` version vector.
    80	    pub fn updates(from: &'a VersionVector) -> Self {
    81	        ExportMode::Updates {
    82	            from: Cow::Borrowed(from),
    83	        }
    84	    }
    85	
    86	    /// It contains the history since the `from` version vector.
    87	    pub fn updates_owned(from: VersionVector) -> Self {
    88	        ExportMode::Updates {
    89	            from: Cow::Owned(from),
    90	        }
    91	    }
    92	
    93	    /// It contains all the history of the document.
    94	    pub fn all_updates() -> Self {
    95	        ExportMode::Updates {
    96	            from: Cow::Owned(Default::default()),
    97	        }
    98	    }
    99	
   100	    /// This mode exports the history in the specified range.
   380	    check_target_version_reachable(doc, frontiers)?;
   381	    encode_with(EncodeMode::FastSnapshot, &mut |ans| {
   382	        shallow_snapshot::encode_snapshot_at(doc, frontiers, ans)
   383	    })
   384	}
   385	
   386	pub(crate) fn export_fast_updates(doc: &LoroDoc, vv: &VersionVector) -> Vec<u8> {
   387	    encode_with(EncodeMode::FastUpdates, &mut |ans| {
   388	        fast_snapshot::encode_updates(doc, vv, ans);
   389	        Ok(())
   390	    })
   391	    .unwrap()
   392	}

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/loro.rs | sed -n '888,904p;1978,1990p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   888	        }
   889	        changes
   890	    }
   891	
   892	    /// Get the version vector of the current OpLog
   893	    #[inline]
   894	    pub fn oplog_vv(&self) -> VersionVector {
   895	        self.oplog.lock().vv().clone()
   896	    }
   897	
   898	    /// Get the version vector of the current [DocState]
   899	    #[inline]
   900	    pub fn state_vv(&self) -> VersionVector {
   901	        let oplog = self.oplog.lock();
   902	        let f = &self.state.lock().frontiers;
   903	        oplog.dag.frontiers_to_vv(f).unwrap()
   904	    }
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

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs | sed -n '416,425p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   416	        let cnt = self.dag.vv().get(&peer).copied().unwrap_or(0);
   417	        ID::new(peer, cnt)
   418	    }
   419	
   420	    pub(crate) fn vv(&self) -> &VersionVector {
   421	        self.dag.vv()
   422	    }
   423	
   424	    pub(crate) fn frontiers(&self) -> &Frontiers {
   425	        self.dag.frontiers()

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '295,302p;453,468p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   295	impl Deref for VersionVector {
   296	    type Target = FxHashMap<PeerID, Counter>;
   297	
   298	    fn deref(&self) -> &Self::Target {
   299	        &self.0
   300	    }
   301	}
   302	
   453	impl DerefMut for VersionVector {
   454	    fn deref_mut(&mut self) -> &mut Self::Target {
   455	        &mut self.0
   456	    }
   457	}
   458	
   459	impl VersionVector {
   460	    pub fn diff(&self, rhs: &Self) -> VersionVectorDiff {
   461	        let mut ans: VersionVectorDiff = Default::default();
   462	        for (client_id, &counter) in self.iter() {
   463	            if let Some(&rhs_counter) = rhs.get(client_id) {
   464	                match counter.cmp(&rhs_counter) {
   465	                    Ordering::Less => {
   466	                        ans.forward.insert(
   467	                            *client_id,
   468	                            CounterSpan {

exec
/bin/zsh -lc "rg -n \"impl Default for VersionVector|fn default\\(\\) -> Self|impl FromIterator.*VersionVector|pub fn new\\(\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
47:    pub fn new() -> Self {
163:    pub fn new() -> Self {
645:    pub fn new() -> Self {
934:impl Default for VersionVector {
935:    fn default() -> Self {
961:impl FromIterator<ID> for VersionVector {
976:impl FromIterator<(PeerID, Counter)> for VersionVector {

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '638,650p;930,940p;970,982p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   638	                    None
   639	                }
   640	            })
   641	            .collect()
   642	    }
   643	
   644	    #[inline]
   645	    pub fn new() -> Self {
   646	        Self(Default::default())
   647	    }
   648	
   649	    /// set the inclusive ending point. target id will be included by self
   650	    #[inline]
   930	        .map(|(peer, counter)| ID::new(peer, counter))
   931	        .collect()
   932	}
   933	
   934	impl Default for VersionVector {
   935	    fn default() -> Self {
   936	        Self::new()
   937	    }
   938	}
   939	
   940	impl From<FxHashMap<PeerID, Counter>> for VersionVector {
   970	        }
   971	
   972	        vv
   973	    }
   974	}
   975	
   976	impl FromIterator<(PeerID, Counter)> for VersionVector {
   977	    fn from_iter<T: IntoIterator<Item = (PeerID, Counter)>>(iter: T) -> Self {
   978	        VersionVector(FxHashMap::from_iter(iter))
   979	    }
   980	}
   981	
   982	// Note: It will be encoded into binary format, so the order of its fields should not be changed.

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs | sed -n '300,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   300	        shallow_root_state_bytes: Bytes::new(),
   301	    };
   302	    if was_detached {
   303	        drop(state);
   304	        doc._checkout_without_emitting(&old_state_frontiers, false, true)
   305	            .unwrap();
   306	        doc.drop_pending_events();
   307	    }
   308	
   309	    snapshot
   310	}
   311	
   312	pub(crate) fn decode_oplog(oplog: &mut OpLog, bytes: &[u8]) -> Result<Vec<Change>, LoroError> {
   313	    let oplog_len = bytes
   314	        .get(0..4)
   315	        .ok_or_else(|| LoroError::DecodeError("decode_oplog: missing length prefix".into()))?;
   316	    let oplog_len = u32::from_le_bytes(
   317	        oplog_len
   318	            .try_into()
   319	            .expect("slice length checked to be exactly 4"),
   320	    ) as usize;
   321	    let oplog_bytes = bytes
   322	        .get(4..4 + oplog_len)
   323	        .ok_or_else(|| LoroError::DecodeError("decode_oplog: invalid oplog length".into()))?;
   324	    let mut changes = ChangeStore::decode_snapshot_for_updates(
   325	        oplog_bytes.to_vec().into(),
   326	        &oplog.arena,
   327	        oplog.vv(),
   328	    )?;
   329	    changes.sort_unstable_by_key(|x| x.lamport);
   330	    Ok(changes)
   331	}
   332	
   333	pub(crate) fn encode_updates<W: std::io::Write>(doc: &LoroDoc, vv: &VersionVector, w: &mut W) {
   334	    let oplog = doc.oplog().lock();
   335	    oplog.export_blocks_from(vv, w);
   336	}
   337	
   338	pub(crate) fn encode_updates_in_range<W: std::io::Write>(
   339	    oplog: &OpLog,
   340	    spans: &[IdSpan],
   341	    w: &mut W,
   342	) {
   343	    oplog.export_blocks_in_range(spans, w);
   344	}
   345	

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs | sed -n '520,545p;668,690p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'rg -n "fn export_change_store_from|export_blocks_from|export_change_store_between|sub_iter|encode_updates" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   520	    }
   521	
   522	    #[inline(always)]
   523	    pub(crate) fn export_change_store_from(&self, vv: &VersionVector, f: &Frontiers) -> Bytes {
   524	        self.change_store
   525	            .export_from(vv, f, self.vv(), self.frontiers())
   526	    }
   527	
   528	    #[inline(always)]
   529	    pub(crate) fn export_change_store_in_range(
   530	        &self,
   531	        vv: &VersionVector,
   532	        f: &Frontiers,
   533	        to_vv: &VersionVector,
   534	        to_frontiers: &Frontiers,
   535	    ) -> Bytes {
   536	        self.change_store.export_from(vv, f, to_vv, to_frontiers)
   537	    }
   538	
   539	    #[inline(always)]
   540	    pub(crate) fn export_blocks_from<W: std::io::Write>(&self, vv: &VersionVector, w: &mut W) {
   541	        self.change_store
   542	            .export_blocks_from(vv, self.shallow_since_vv(), self.vv(), w)
   543	    }
   544	
   545	    #[inline(always)]
   668	        }
   669	    }
   670	
   671	    pub(crate) fn iter_changes_peer_by_peer<'a>(
   672	        &'a self,
   673	        from: &VersionVector,
   674	        to: &VersionVector,
   675	    ) -> impl Iterator<Item = BlockChangeRef> + 'a {
   676	        let spans: Vec<_> = from.diff_iter(to).1.collect();
   677	        spans
   678	            .into_iter()
   679	            .flat_map(move |span| self.change_store.iter_changes(span))
   680	    }
   681	
   682	    pub(crate) fn iter_changes_causally_rev<'a>(
   683	        &'a self,
   684	        from: &VersionVector,
   685	        to: &VersionVector,
   686	    ) -> impl Iterator<Item = BlockChangeRef> + 'a {
   687	        MergedChangeIter::new_change_iter_rev(self, from, to)
   688	    }
   689	
   690	    pub fn get_timestamp_for_next_txn(&self) -> Timestamp {

 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:333:pub(crate) fn encode_updates<W: std::io::Write>(doc: &LoroDoc, vv: &VersionVector, w: &mut W) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:335:    oplog.export_blocks_from(vv, w);
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/encoding/fast_snapshot.rs:338:pub(crate) fn encode_updates_in_range<W: std::io::Write>(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:84:        for span in vv_a.sub_iter(vv_b) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:94:        for span in vv_b.sub_iter(vv_a) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:521:        (self.sub_iter(rhs), rhs.sub_iter(self))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:525:    pub fn sub_iter<'a>(&'a self, rhs: &'a Self) -> impl Iterator<Item = IdSpan> + 'a {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:554:    pub fn sub_iter_im<'a>(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:588:        self.sub_iter(other).chain(other.sub_iter(self))
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs:592:        self.sub_iter(rhs).map(|x| (x.peer, x.counter)).collect()
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:523:    pub(crate) fn export_change_store_from(&self, vv: &VersionVector, f: &Frontiers) -> Bytes {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:540:    pub(crate) fn export_blocks_from<W: std::io::Write>(&self, vv: &VersionVector, w: &mut W) {
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog.rs:542:            .export_blocks_from(vv, self.shallow_since_vv(), self.vv(), w)

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '708,735p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   708	                    *my_end = other_end;
   709	                }
   710	            } else {
   711	                self.0.insert(client_id, other_end);
   712	            }
   713	        }
   714	    }
   715	
   716	    pub fn includes_vv(&self, other: &VersionVector) -> bool {
   717	        match self.partial_cmp(other) {
   718	            Some(ord) => match ord {
   719	                Ordering::Less => false,
   720	                Ordering::Equal => true,
   721	                Ordering::Greater => true,
   722	            },
   723	            None => false,
   724	        }
   725	    }
   726	
   727	    pub fn includes_id(&self, id: ID) -> bool {
   728	        if let Some(end) = self.get(&id.peer) {
   729	            if *end > id.counter {
   730	                return true;
   731	            }
   732	        }
   733	        false
   734	    }
   735	

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '515,540p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   515	        &'a self,
   516	        rhs: &'a Self,
   517	    ) -> (
   518	        impl Iterator<Item = IdSpan> + 'a,
   519	        impl Iterator<Item = IdSpan> + 'a,
   520	    ) {
   521	        (self.sub_iter(rhs), rhs.sub_iter(self))
   522	    }
   523	
   524	    /// Returns the spans that are in `self` but not in `rhs`
   525	    pub fn sub_iter<'a>(&'a self, rhs: &'a Self) -> impl Iterator<Item = IdSpan> + 'a {
   526	        self.iter().filter_map(move |(peer, &counter)| {
   527	            if let Some(&rhs_counter) = rhs.get(peer) {
   528	                if counter > rhs_counter {
   529	                    Some(IdSpan {
   530	                        peer: *peer,
   531	                        counter: CounterSpan {
   532	                            start: rhs_counter,
   533	                            end: counter,
   534	                        },
   535	                    })
   536	                } else {
   537	                    None
   538	                }
   539	            } else if counter > 0 {
   540	                Some(IdSpan {

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/version.rs | sed -n '540,552p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   540	                Some(IdSpan {
   541	                    peer: *peer,
   542	                    counter: CounterSpan {
   543	                        start: 0,
   544	                        end: counter,
   545	                    },
   546	                })
   547	            } else {
   548	                None
   549	            }
   550	        })
   551	    }
   552	

exec
/bin/zsh -lc "rg -n \"pub\\(crate\\) fn export_blocks_from|fn export_blocks_from\" /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store* /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:529:    pub(crate) fn export_blocks_from<W: std::io::Write>(
/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs:529:    pub(crate) fn export_blocks_from<W: std::io::Write>(

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs | sed -n '520,550p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   520	
   521	    pub fn kv_size(&self) -> usize {
   522	        self.external_kv
   523	            .lock()
   524	            .scan(Bound::Unbounded, Bound::Unbounded)
   525	            .map(|(k, v)| k.len() + v.len())
   526	            .sum()
   527	    }
   528	
   529	    pub(crate) fn export_blocks_from<W: std::io::Write>(
   530	        &self,
   531	        start_vv: &VersionVector,
   532	        shallow_since_vv: &ImVersionVector,
   533	        latest_vv: &VersionVector,
   534	        w: &mut W,
   535	    ) {
   536	        let new_store = ChangeStore::new_mem(&self.arena, self.merge_interval.clone());
   537	        for mut span in latest_vv.sub_iter(start_vv) {
   538	            let counter_lower_bound = shallow_since_vv.get(&span.peer).copied().unwrap_or(0);
   539	            span.counter.start = span.counter.start.max(counter_lower_bound);
   540	            span.counter.end = span.counter.end.max(counter_lower_bound);
   541	            if span.counter.start >= span.counter.end {
   542	                continue;
   543	            }
   544	
   545	            // PERF: this can be optimized by reusing the current encoded blocks
   546	            // In the current method, it needs to parse and re-encode the blocks
   547	            for c in self.iter_changes(span) {
   548	                let start = ((start_vv.get(&c.id.peer).copied().unwrap_or(0) - c.id.counter).max(0)
   549	                    as usize)
   550	                    .min(c.atom_len());

exec
/bin/zsh -lc "nl -ba /Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/loro-internal-1.12.0/src/oplog/change_store.rs | sed -n '550,575p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   550	                    .min(c.atom_len());
   551	                let end = ((latest_vv.get(&c.id.peer).copied().unwrap_or(0) - c.id.counter).max(0)
   552	                    as usize)
   553	                    .min(c.atom_len());
   554	
   555	                assert_ne!(start, end);
   556	                let ch = c.slice(start, end);
   557	                new_store.insert_change(ch, false, false);
   558	            }
   559	        }
   560	
   561	        let arena = &self.arena;
   562	        encode_blocks_in_store(new_store, arena, w);
   563	    }
   564	
   565	    pub(crate) fn fork_changes_up_to(
   566	        &self,
   567	        start_vv: &ImVersionVector,
   568	        frontiers: &Frontiers,
   569	        vv: &VersionVector,
   570	    ) -> Bytes {
   571	        let new_store = ChangeStore::new_mem(&self.arena, self.merge_interval.clone());
   572	        for mut span in vv.sub_iter_im(start_vv) {
   573	            let counter_lower_bound = start_vv.get(&span.peer).copied().unwrap_or(0);
   574	            span.counter.start = span.counter.start.max(counter_lower_bound);
   575	            span.counter.end = span.counter.end.max(counter_lower_bound);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,120p;190,250p;270,310p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '970,1028p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   970	        Ok(())
   971	    }
   972	
   973	    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
   974	    /// local op. Loro's `UndoManager` semantically inverts it by
   975	    /// appending an inverse op (NOT by physical removal). Returns
   976	    /// `Ok(true)` if an undo stack item was consumed,
   977	    /// `Ok(false)` if the stack was empty.
   978	    ///
   979	    /// Local-only per Loro's `UndoManager` contract — remote ops
   980	    /// from other peers (merged via `merge_bytes`) are NOT
   981	    /// affected.
   982	    ///
   983	    /// Presence updates are excluded from the undo stack by
   984	    /// construction (see `CollabSession::new`), so cursor movements
   985	    /// don't consume undo slots.
   986	    ///
   987	    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** triggers
   988	    /// auto-flush per [`auto_flush_policy`], but ONLY when
   989	    /// `consumed == true` (an inverse op was actually appended).
   990	    /// `Ok(false)` on an empty stack never attempts the flush, so
   991	    /// a closed transport cannot turn a "nothing to undo" into a
   992	    /// spurious `Err(Transport(_))` (Codex M2 closure). Partial-
   993	    /// state contract on flush failure when `consumed == true`:
   994	    /// the inverse op is already committed to `self.log` — same
   995	    /// shape as `append_op`.
   996	    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
   997	        let consumed = self.undo.undo()?;
   998	        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
   999	        // auto-flush when an undo item was actually consumed. The prior
  1000	        // "flush unconditionally" pattern turned `Ok(false)` into
  1001	        // `Err(Transport(_))` when the transport was closed AND the
  1002	        // undo stack was empty — spurious failure semantics. With the
  1003	        // gate, `undo` on an empty stack stays `Ok(false)` regardless
  1004	        // of transport state (no mutation, no flush attempt).
  1005	        if consumed {
  1006	            self.maybe_auto_flush()?;
  1007	        }
  1008	        Ok(consumed)
  1009	    }
  1010	
  1011	    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
  1012	    /// Returns `Ok(true)` if a redo stack item was consumed,
  1013	    /// `Ok(false)` if the stack was empty.
  1014	    ///
  1015	    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** matches
  1016	    /// [`undo`] — auto-flush fires only when `consumed == true`.
  1017	    /// Partial-state contract on flush failure when consumed:
  1018	    /// the redo's appended op is already in `self.log` (mutate-
  1019	    /// then-flush).
  1020	    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
  1021	        let consumed = self.undo.redo()?;
  1022	        // Phase 5.5 V2 V2 audit closure (Codex M2): gate matches `undo`.
  1023	        if consumed {
  1024	            self.maybe_auto_flush()?;
  1025	        }
  1026	        Ok(consumed)
  1027	    }
  1028	

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '350,412p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   350	        assert_ne!(
   351	            peer_id.as_u64(),
   352	            0,
   353	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   354	             Active CollabSession peers MUST use a non-zero PeerId."
   355	        );
   356	        let mut log = OpLog::new();
   357	        log.set_peer_id(peer_id.as_u64())?;
   358	        let undo = make_undo_manager(&log);
   359	        Ok(Self {
   360	            peer_id,
   361	            log,
   362	            undo,
   363	            transport: None,
   364	            auto_flush_policy: AutoFlushPolicy::Disabled,
   365	            last_flushed_vv: None,
   366	        })
   367	    }
   368	
   369	    /// Construct a session by importing a shared snapshot. Use this
   370	    /// when joining a session that already has history (the second+
   371	    /// peer to open a collaborative workbook).
   372	    ///
   373	    /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
   374	    /// by an earlier `CollabSession::export_bytes` call (typically
   375	    /// from the workbook owner / first peer). After import, this
   376	    /// session's peer id is set to `peer_id` — distinct from the
   377	    /// peer ids carried by the already-imported ops. Imported ops
   378	    /// retain their original peer-id attribution (Loro semantics);
   379	    /// only this session's future appends carry `peer_id`.
   380	    ///
   381	    /// **Caller pitfalls** (same as `CollabSession::new`):
   382	    /// - The new `peer_id` MUST differ from every peer already
   383	    ///   represented in the imported snapshot AND from every other
   384	    ///   concurrent session — see `OpLog::set_peer_id` for details.
   385	    /// - `PeerId(u64::MAX)` is reserved.
   386	    /// - **Phase 5.2 D-1 step 4 audit Codex MEDIUM-2 closure:**
   387	    ///   `PeerId(0)` is `LEGACY_PEER` — debug-asserted just like
   388	    ///   `CollabSession::new`. Snapshot-join sessions also count as
   389	    ///   active sessions and must use a non-zero peer id.
   390	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
   391	        // Step 8 megaudit closure (Opus-B HIGH-1, 2026-05-20):
   392	        // assert! (release-firing) replaces debug_assert_ne!.
   393	        assert_ne!(
   394	            peer_id.as_u64(),
   395	            0,
   396	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   397	             Snapshot-join CollabSession peers MUST use a non-zero PeerId, same as `new`."
   398	        );
   399	        let mut log = OpLog::import_bytes(bytes)?;
   400	        log.set_peer_id(peer_id.as_u64())?;
   401	        let undo = make_undo_manager(&log);
   402	        Ok(Self {
   403	            peer_id,
   404	            log,
   405	            undo,
   406	            transport: None,
   407	            auto_flush_policy: AutoFlushPolicy::Disabled,
   408	            last_flushed_vv: None,
   409	        })
   410	    }
   411	
   412	    /// Stable peer id assigned at session creation.

exec
/bin/zsh -lc 'rg -n "''^#'"\\[test\\]\" quantbook-engine/crates/ql-collab/tests/auto_flush.rs | wc -l" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
      28

exec
/bin/zsh -lc 'git diff --unified=0 b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-collab/tests/auto_flush.rs | rg -n "''^'"\\+fn \"" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'git diff --unified=0 b7aa4cb7bb9..HEAD -- quantbook-engine/crates/ql-collab/tests/auto_flush.rs | rg -n "''^'"\\+\\s*#\\[test\\]|"'^'"\\+fn \"" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
12:+fn delta_flush_first_call_sends_all_ops_with_no_transport_baseline() {
42:+fn delta_flush_idempotency_short_circuits_when_no_state_change() {
74:+fn delta_flush_subsequent_calls_send_only_new_ops() {
114:+fn attach_transport_resets_last_flushed_vv() {
154:+fn flush_to_transport_full_snapshot_path_still_works_and_updates_vv() {
195:+fn on_append_uses_delta_path_under_v2_v3() {
232:+fn delta_flush_with_no_transport_returns_ok_false() {
242:+fn delta_flush_failure_does_not_advance_vv_so_retry_resends() {
283:+fn delta_flush_after_merge_bytes_sends_merged_state_to_third_peer() {

 succeeded in 0ms:
11:+#[test]
12:+fn delta_flush_first_call_sends_all_ops_with_no_transport_baseline() {
41:+#[test]
42:+fn delta_flush_idempotency_short_circuits_when_no_state_change() {
73:+#[test]
74:+fn delta_flush_subsequent_calls_send_only_new_ops() {
113:+#[test]
114:+fn attach_transport_resets_last_flushed_vv() {
153:+#[test]
154:+fn flush_to_transport_full_snapshot_path_still_works_and_updates_vv() {
194:+#[test]
195:+fn on_append_uses_delta_path_under_v2_v3() {
231:+#[test]
232:+fn delta_flush_with_no_transport_returns_ok_false() {
241:+#[test]
242:+fn delta_flush_failure_does_not_advance_vv_so_retry_resends() {
282:+#[test]
283:+fn delta_flush_after_merge_bytes_sends_merged_state_to_third_peer() {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '238,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   238	    /// surrounding mutator (`append_op` etc.) returns
   239	    /// `Err(CollabSessionError::Transport(_))`. The local mutation
   240	    /// has ALREADY been committed to `self.log` (mutate-then-flush
   241	    /// ordering — Loro doesn't support "ungrowing" an op log, V1
   242	    /// limitation H7). Callers MUST treat their local state as
   243	    /// authoritative for the local UI and either retry the flush
   244	    /// (transport recovered) or detach the transport.
   245	    ///
   246	    /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
   247	    /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
   248	    /// transport is now safe via the V2 V3 idempotency guard. The
   249	    /// guard short-circuits `flush_delta_to_transport` when no ops
   250	    /// have been appended since the last successful flush. A
   251	    /// merged peer-snapshot that didn't actually advance local
   252	    /// state (Loro CRDT dedupe) leaves the VV unchanged, so the
   253	    /// subsequent auto-flush is a no-op send. The original V2 V2
   254	    /// echo-loop concern (each peer re-flushing the same snapshot)
   255	    /// is closed at the source. V2 V3 step 2 can then safely wire
   256	    /// `poll_remote` into auto-flush without re-introducing the
   257	    /// loop.
   258	    ///
   259	    /// Note: the `poll_remote*` exclusion above STILL applies in V2
   260	    /// V3 step 1 — it's wired in step 2 separately. Until step 2,

codex
VERDICT: PASS-WITH-FINDINGS

HIGH: none.

MEDIUM: none.

LOW:
1. The delta-size behavior is correct by Loro inspection, but the main regression test does not prove “second flush sends only new ops.” [auto_flush.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:729) claims “Second flush carries DELTA,” but the assertion imports both blobs and only checks final length:
   `fresh.merge_bytes(&_first_bytes).unwrap();`
   `fresh.merge_bytes(&second_bytes).unwrap();`
   `assert_eq!(fresh.len(), 3, ...)`
   A full second payload would also pass.

2. The transport-failure test does not verify “retry resends from the same VV.” [auto_flush.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:896) names that behavior, but the test detaches and reattaches; it even notes: `attach_transport resets last_flushed_vv to None, so this tests a different property than the original intent.` See [auto_flush.rs:916](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:916).

3. “Per-transport” is slightly overstated in docs. The implementation has one checkpoint for the currently attached transport, not durable baselines keyed by transport identity. Evidence: [transport.rs:17](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:17) says `per-transport version-vector tracking`, while [session.rs:318](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:318) is a single `last_flushed_vv`, and [session.rs:647](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:647) resets it on every attach. Correct behavior, but document as “current attached transport baseline.”

Verified:
- VV equality is value equality over peer counters, not reference equality. Loro source: `other.get(client).unwrap_or(&0) == counter` and symmetric reverse check in `/Users/sanzhar/.cargo/.../loro-internal-1.12.0/src/version.rs:269`.
- `VersionVector::default()` is empty. `Default` calls `Self::new()`, and `new()` wraps `Default::default()` map in Loro source.
- `ExportMode::all_updates()` is exactly `Updates { from: Default::default() }`, so first delta flush from empty VV matches all-updates semantics.
- `oplog_vv()` cloning cost is O(peer-count), not O(op-count): Loro locks oplog and returns `self.oplog.lock().vv().clone()`.
- Delta export is real delta by Loro implementation: `encode_updates` calls `oplog.export_blocks_from(vv, w)`, which iterates `latest_vv.sub_iter(start_vv)`.
- `&mut self` on `flush_delta_to_transport` excludes concurrent session mutation during the VV check/encode/send sequence.

I did not run cargo tests, per instruction.
tokens used
156,168
VERDICT: PASS-WITH-FINDINGS

HIGH: none.

MEDIUM: none.

LOW:
1. The delta-size behavior is correct by Loro inspection, but the main regression test does not prove “second flush sends only new ops.” [auto_flush.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:729) claims “Second flush carries DELTA,” but the assertion imports both blobs and only checks final length:
   `fresh.merge_bytes(&_first_bytes).unwrap();`
   `fresh.merge_bytes(&second_bytes).unwrap();`
   `assert_eq!(fresh.len(), 3, ...)`
   A full second payload would also pass.

2. The transport-failure test does not verify “retry resends from the same VV.” [auto_flush.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:896) names that behavior, but the test detaches and reattaches; it even notes: `attach_transport resets last_flushed_vv to None, so this tests a different property than the original intent.` See [auto_flush.rs:916](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:916).

3. “Per-transport” is slightly overstated in docs. The implementation has one checkpoint for the currently attached transport, not durable baselines keyed by transport identity. Evidence: [transport.rs:17](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:17) says `per-transport version-vector tracking`, while [session.rs:318](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:318) is a single `last_flushed_vv`, and [session.rs:647](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:647) resets it on every attach. Correct behavior, but document as “current attached transport baseline.”

Verified:
- VV equality is value equality over peer counters, not reference equality. Loro source: `other.get(client).unwrap_or(&0) == counter` and symmetric reverse check in `/Users/sanzhar/.cargo/.../loro-internal-1.12.0/src/version.rs:269`.
- `VersionVector::default()` is empty. `Default` calls `Self::new()`, and `new()` wraps `Default::default()` map in Loro source.
- `ExportMode::all_updates()` is exactly `Updates { from: Default::default() }`, so first delta flush from empty VV matches all-updates semantics.
- `oplog_vv()` cloning cost is O(peer-count), not O(op-count): Loro locks oplog and returns `self.oplog.lock().vv().clone()`.
- Delta export is real delta by Loro implementation: `encode_updates` calls `oplog.export_blocks_from(vv, w)`, which iterates `latest_vv.sub_iter(start_vv)`.
- `&mut self` on `flush_delta_to_transport` excludes concurrent session mutation during the VV check/encode/send sequence.

I did not run cargo tests, per instruction.
