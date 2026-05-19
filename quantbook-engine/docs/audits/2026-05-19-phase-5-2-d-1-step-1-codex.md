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
session id: 019e41ef-c96d-71f2-bf05-6d0ac182ab19
--------
user
# Codex audit — Phase 5.2 D-1 step 1 (move PeerId to ql-oplog) 2026-05-19

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

HEAD: `aaa54d32f4d` (Phase 5.2 D-1 step 1).
Predecessor: `6eba27a374d` (handoff completeness audit closure).

## What shipped

Single commit (6 files: 1 rename + 5 mods + 33 insertions / 20 deletions). Moves `ql-collab::peer::PeerId` to `ql-oplog::peer::PeerId`. `ql-collab` re-exports `ql_oplog::PeerId` for back-compat. Step 1 of 7 in the D-1 schema-breaking arc.

**Why:** D-1's new `FormatId::Custom(PeerId, u32)` variant lives in `ql-storage` (or transits through `ql-oplog::wire`). `ql-oplog` must remain the dependency floor (Tier D2 lock at `e15e8908742`); a `ql-oplog → ql-collab` reverse dep would break that. Moving PeerId down to the op-log layer where it belongs prepares the substrate.

Files changed:
- `crates/ql-oplog/src/peer.rs` — NEW (rename from ql-collab side; ~102 LOC, 3 unit tests).
- `crates/ql-oplog/src/lib.rs` — declare `pub mod peer` + `pub use peer::PeerId`.
- `crates/ql-oplog/src/log.rs` — doc cross-ref `ql_collab::PeerId::Display` → `crate::PeerId`.
- `crates/ql-collab/src/lib.rs` — `pub mod peer` removed; new `pub use ql_oplog::PeerId` back-compat line. Module-layout docstring updated.
- `crates/ql-collab/src/presence.rs` — `use crate::peer::PeerId` → `use ql_oplog::PeerId`.
- `crates/ql-collab/src/session.rs` — same; folded into the existing `use ql_oplog::{...}` import line.

## Gates verified

- `cargo test --workspace`: **4222** passed, 0 failed (baseline + post-move identical — 3 peer tests moved with the file, not duplicated).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo build --workspace`: clean (verifies ql-oplog → ql-collab → ql-exec → ql-io-xlsx compile chain holds).
- `git -C . show HEAD:<file> | wc -l` matches disk for peer.rs, session.rs, collab/lib.rs — no truncation-race incident.

## What to check

This is a **schema-breaking arc step 1**. Issues here propagate forward.

1. **Dependency-direction integrity.** Is `ql-oplog`'s Cargo.toml still free of any `ql-collab` reverse dep? `ql-collab/Cargo.toml` MUST still depend on `ql-oplog`. The architectural lock at Tier D2 (`e15e8908742`) MUST hold post-move.

2. **External callers.** Search the workspace for any direct use of `ql_collab::peer::PeerId` (the path itself — module access) outside `ql-collab` internals. The back-compat `ql_collab::PeerId` re-export covers `use ql_collab::PeerId;` but `use ql_collab::peer::PeerId;` would now fail. Are there any?

3. **Test coverage preserved.** The 3 peer-module tests (`round_trips_through_u64`, `display_is_16_hex_chars`, `equality_and_hash_consistent`) live in `crates/ql-oplog/src/peer.rs` post-move. Run `cargo test -p ql-oplog peer::` and confirm they all pass.

4. **Stability docstring honesty.** `ql-collab/src/lib.rs` Stability section's new bullet says the move is "back-compat — external callers unchanged." Is that strictly true? Are there any `pub use ql_collab::peer::*` patterns or any other usage that breaks?

5. **Doc-comment staleness.** `ql-oplog/src/peer.rs` docstring references the move. `ql-collab/src/lib.rs` docstring references the re-export. Are both internally consistent? Any leftover `ql_collab::PeerId` mentions in code that should now say `ql_oplog::PeerId` (other than the deliberate back-compat references)?

6. **LEGACY_PEER deferral.** The d-1-checklist (step 1 description) recommends "Pick one in step 1" for the LEGACY_PEER sentinel (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The shipped commit DEFERS this to step 5 (qbook envelope) with the rationale "no current use site." Is this defensible, or should the constant be added now for forward consistency?

7. **Forward-readiness for step 2.** Step 2 introduces `FormatIdWire` in `ql-oplog::wire`. Does the current `ql-oplog::wire` module have any structural issues (existing types, serde derives, error types) that step 2 will trip on?

## Verdict format

For each finding, output:

```
[SEV] <one-line summary>
File:Line: <path:line>
Detail: <2-4 sentences>
Recommendation: <PASS | fix now | defer to step N>
```

Severities: HIGH (blocks step 2), MEDIUM (should-fix this cycle), LOW (polish).

Be thorough. Multi-step schema-breaking arc — false positives are cheap; false negatives compound. If nothing is wrong, say PASS explicitly.

codex
I’ll audit this as a code review against the shipped commit and the forward D-1 constraints. I’ll first read the moved code, Cargo edges, checklist context, and then run the targeted searches/tests so the verdict is grounded in the tree.
  → Inspect commit diff, Cargo dependency edges, and relevant module docs
  • Search for broken public paths and stale references
  • Run targeted ql-oplog peer tests and inspect wire readiness
  • Produce severity-ranked verdict in requested format
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
/bin/zsh -lc 'git show --stat --oneline --decorate HEAD && git show --name-status --format=short HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
aaa54d32f4d (HEAD -> feat/quantbook-engine) Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer
 quantbook-engine/crates/ql-collab/src/lib.rs       | 14 +++++++---
 quantbook-engine/crates/ql-collab/src/presence.rs  |  2 +-
 quantbook-engine/crates/ql-collab/src/session.rs   |  3 +--
 quantbook-engine/crates/ql-oplog/src/lib.rs        |  2 ++
 quantbook-engine/crates/ql-oplog/src/log.rs        |  2 +-
 .../crates/{ql-collab => ql-oplog}/src/peer.rs     | 30 +++++++++++++---------
 6 files changed, 33 insertions(+), 20 deletions(-)
commit aaa54d32f4df63274cef3a340049488b3a659a2a
Author: steppen0mad <nurtaymergaliyev@gmail.com>

    Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer

M	quantbook-engine/crates/ql-collab/src/lib.rs
M	quantbook-engine/crates/ql-collab/src/presence.rs
M	quantbook-engine/crates/ql-collab/src/session.rs
M	quantbook-engine/crates/ql-oplog/src/lib.rs
M	quantbook-engine/crates/ql-oplog/src/log.rs
R067	quantbook-engine/crates/ql-collab/src/peer.rs	quantbook-engine/crates/ql-oplog/src/peer.rs

exec
/bin/zsh -lc 'git status --short && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 907ms:
?? .codex-d1-step1-audit-prompt.md
?? .codex-d1-step1-audit.out
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
aaa54d32f4df63274cef3a340049488b3a659a2a

codex
The tree is on `feat/quantbook-engine` at the expected HEAD. There are unrelated untracked audit/session artifacts in the outer worktree; I’ll ignore them and review only the committed phase files plus relevant checklist/wire context.
exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/crates/ql-oplog/src/peer.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Per-peer identifier for Phase 5 collaboration.
//!
//! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
//! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
//! so the op-log layer (where ops are tagged with peer-of-origin) can
//! reference it without a reverse `ql-oplog → ql-collab` dep. `ql-collab`
//! re-exports `ql_oplog::PeerId` to keep its public surface stable.
//!
//! `PeerId` is a thin newtype around `u64` matching Loro's native peer-id
//! type. Stable per-session; the user-facing collaboration tooling decides
//! how to assign IDs (random vs user-derived vs server-allocated).
//!
//! Used by:
//! - [`crate::OpLog::set_peer_id`] — wires through to Loro's
//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
//!   origin in the CRDT merge metadata (Phase 5.2.b).
//! - `ql_collab::CollabSession` — attached at session-create time
//!   and passed to `OpLog::set_peer_id`. Re-exported as
//!   `ql_collab::PeerId` for back-compat.
//! - `ql_collab::presence` — keys the `"presence"` `LoroMap` in
//!   16-hex `Display` form so each peer's cursor position lives at
//!   its own slot (Phase 5.6 V1 at `c677e244704`).
//! - Phase 5 D-1 (in progress) — the `FormatId::Custom(PeerId, u32)`
//!   variant will use this type for collision-free format-id
//!   allocation across peers.

/// Per-peer collaboration identifier.
///
/// Wraps a `u64` to match Loro's native peer-id type. Stable for
/// the lifetime of a `CollabSession`; the user-facing tooling
/// decides assignment policy. Two concurrent peers MUST have
/// distinct ids — duplicate peer ids corrupt the document via
/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
/// then closed by Phase 5.2.b wiring). Prefer per-process-random
/// allocation unless your server enforces uniqueness explicitly.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
pub struct PeerId(pub u64);

impl PeerId {
    /// Construct a `PeerId` from the raw u64.
    pub const fn new(id: u64) -> Self {
        Self(id)
    }

    /// Unwrap to the raw `u64`. Used at the Loro boundary
    /// (`LoroDoc::set_peer_id` takes `u64`).
    pub const fn as_u64(self) -> u64 {
        self.0
    }
}

impl From<u64> for PeerId {
    fn from(id: u64) -> Self {
        Self(id)
    }
}

impl From<PeerId> for u64 {
    fn from(p: PeerId) -> Self {
        p.0
    }
}

impl std::fmt::Display for PeerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 16-hex-char form keeps display compact and easy to spot in logs.
        write!(f, "{:016x}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::PeerId;

    #[test]
    fn round_trips_through_u64() {
        let p = PeerId::new(0xdead_beef_cafe_babe);
        assert_eq!(p.as_u64(), 0xdead_beef_cafe_babe);
        assert_eq!(u64::from(p), 0xdead_beef_cafe_babe);
        assert_eq!(PeerId::from(0xdead_beef_cafe_babe_u64), p);
    }

    #[test]
    fn display_is_16_hex_chars() {
        let p = PeerId::new(0x1234);
        assert_eq!(format!("{p}"), "0000000000001234");
    }

    #[test]
    fn equality_and_hash_consistent() {
        use std::collections::HashSet;
        let a = PeerId::new(42);
        let b = PeerId::new(42);
        let c = PeerId::new(43);
        assert_eq!(a, b);
        assert_ne!(a, c);
        let mut set: HashSet<PeerId> = HashSet::new();
        set.insert(a);
        assert!(set.contains(&b));
        assert!(!set.contains(&c));
    }
}

exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/crates/ql-collab/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
//! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
//!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
//!   Stable per-session identifier; wraps Loro's `u64`.
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
//! - **Phase 5.2 D-1 step 1 (2026-05-19):** `PeerId` moved from
//!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
//!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
//!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
//!   external callers using `ql_collab::PeerId` keep working.

pub mod presence;
pub mod session;
pub mod transport;
pub mod undo;

pub use ql_oplog::PeerId;

pub use presence::{PresenceError, PresenceState};
pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
pub use undo::UndoManager;

exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/crates/ql-oplog/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! `ql-oplog` — Loro-backed operation log for the Quantbook engine.
//!
//! Phase 2A.3.a (2026-05-12): scaffolding. Per Round 7 architectural lock
//! T1-D05, Loro is reserved for the op log layer only — no other crate
//! depends on it. CRDT semantics (inter-peer merge) are reserved for Phase
//! 5+ multi-user work; Phase 2A.3 uses Loro as the persistence + future-
//! CRDT-merge substrate.
//!
//! ## Surface
//!
//! - [`Op`] — the engine's mutation vocabulary (one variant per recordable
//!   Workbook mutation).
//! - [`OpLog`] — append-only log with `append`, `iter`, `len`, `is_empty`,
//!   `export_bytes`, `import_bytes`.
//! - [`replay_into`] — applies a log against a [`ql_storage::Workbook`].
//! - [`OpLogError`], [`ReplayError`] — error surfaces (thiserror-derived).
//!
//! ## Scope
//!
//! 2A.3.a (2026-05-12) shipped the crate itself + tests. 2A.3.b wired
//! `WorkbookRuntime` / `WorkbookTransaction` to emit ops. 2A.3.c (this
//! commit) adds `oplog.bin` persistence alongside the `.qbook/` envelope
//! via [`persistence::save_workbook_with_oplog`] /
//! [`persistence::load_workbook_with_oplog`].
//!
//! # Stability
//!
//! Pre-0.2.0 the public API surface is in flux. `Op` carries
//! `#[non_exhaustive]` because Phase 5 (CRDT collaboration) will
//! add new op variants for sheet-scoped names, table mutations,
//! presence, and undo grouping — downstream replayers must include
//! a `_` arm. Error enums (`OpLogError`, `PersistenceError`,
//! `ReplayError`, `FormatRejectedSource`) also carry the marker.
//! Wire enums (`ReferenceModeWire`, `LocaleWire`) are exhaustive by
//! design; variant additions are MAJOR-version events because the
//! wire format and producer/replay sites are updated in lockstep.

pub mod error;
pub mod log;
pub mod op;
pub mod peer;
pub mod replay;
pub mod wire;

pub use error::OpLogError;
pub use log::{OpLog, PRESENCE_COMMIT_ORIGIN};
pub use op::{LocaleWire, Op, ReferenceModeWire};
pub use peer::PeerId;
pub use replay::{replay_into, ReplayError};
pub use wire::{CellWireValue, NamedTargetWire, WireDecodeError};

// **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure**: the
// `persistence` module (save_workbook_with_oplog / load_workbook_with_oplog
// / PersistenceError) moved to `ql-io::oplog_persistence`. The move
// inverts the prior `ql-oplog → ql-io` dependency so Phase 5 CRDT
// integration sees `ql-oplog` as a dependency floor.
//
// External callers that previously imported `ql_oplog::save_workbook_with_oplog`
// (etc.) now import from `ql_io` instead. The on-disk file shape is
// unchanged: `oplog.bin` sidecar inside `.qbook/` directories.

exec
/bin/zsh -lc "sed -n '1,180p' quantbook-engine/crates/ql-oplog/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
[package]
name = "ql-oplog"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lib]
path = "src/lib.rs"

[dependencies]
# Phase 2A.3.a (2026-05-12): Loro op log scaffolding. Per Round 7 architectural
# lock T1-D05, Loro is reserved for the op log layer only — no other crate
# depends on it. CRDT semantics are reserved for Phase 5+ multi-user work;
# Phase 2A.3 uses Loro as the persistence + future-CRDT-merge substrate.
ql-types     = { path = "../ql-types" }
ql-storage   = { path = "../ql-storage" }
ql-functions = { path = "../ql-functions" }
# **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure:** `ql-io`
# removed. Wire-vocabulary types (`CellWireValue`, `NamedTargetWire`)
# moved to `ql-oplog::wire`; persistence functions
# (`save_workbook_with_oplog`, `load_workbook_with_oplog`,
# `PersistenceError`) moved to `ql-io::oplog_persistence`. Phase 5
# CRDT integration now sees `ql-oplog` as a dependency floor.
loro         = { workspace = true }
serde        = { workspace = true }
serde_json   = { workspace = true }
thiserror    = { workspace = true }

exec
/bin/zsh -lc "sed -n '1,180p' quantbook-engine/crates/ql-collab/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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

exec
/bin/zsh -lc "rg -n \"LEGACY_PEER|PeerId\\(0\\)|PeerId\\(u64::MAX|FormatIdWire|FormatId|d-1|D-1|Custom\\(\" quantbook-engine -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:349:- **Scope:** Quantbook's `FormatId` only models numFmt. v2 extends
quantbook-engine/docs/MASTER-PLAN.md:503:    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.
quantbook-engine/docs/MASTER-PLAN.md:505:11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
quantbook-engine/docs/MASTER-PLAN.md:508:    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/MASTER-PLAN.md:545:**Status (2026-05-19): Phase 5 V1 COMPLETE.** Canonical record: `docs/phase5/v1-exit-packet.md`. Remaining: D-1 (multi-day), 5.3 conflict resolution, 5.5 V2 V2/V3 production transport, 5.7 IDE slice, 5.8 megaudit. D-1 fresh-session entry: `docs/phase5/d-1-starting-checklist.md`.
quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 pending (multi-day).
quantbook-engine/docs/MASTER-PLAN.md:571:   - ⏳ D-1 (FormatId tagged tuple, multi-day) — see `docs/phase5/d-1-starting-checklist.md`.
quantbook-engine/docs/MASTER-PLAN.md:590:7. **5.7 Collaboration IDE Vertical Slice** — future. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
quantbook-engine/docs/MASTER-PLAN.md:614:- `docs/phase5/d-1-starting-checklist.md` ✅ (D-1 fresh-session entry).
quantbook-engine/docs/MASTER-PLAN.md:615:- `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
quantbook-engine/docs/MASTER-PLAN.md:617:- Protocol/versioning notes — pending D-1 + 5.5 V2 V2/V3 work.
quantbook-engine/docs/phase5/v1-exit-packet.md:3:status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. D-1 (FormatId tagged tuple, multi-day) is the next major Phase 5.2 item; 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 also remain.
quantbook-engine/docs/phase5/v1-exit-packet.md:7:successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
quantbook-engine/docs/phase5/v1-exit-packet.md:20:Phase 5.2 D-1 (FormatId tagged tuple, schema-breaking, multi-day)
quantbook-engine/docs/phase5/v1-exit-packet.md:41:| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
quantbook-engine/docs/phase5/v1-exit-packet.md:154:| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ⏳ PENDING (multi-day, schema-breaking, queued for next session) |
quantbook-engine/docs/phase5/v1-exit-packet.md:217:- **Phase 5.2 D-1 — FormatId tagged tuple.** Schema-breaking
quantbook-engine/docs/phase5/v1-exit-packet.md:218:  change to `FormatId` (currently `u32` newtype) → tagged tuple
quantbook-engine/docs/phase5/v1-exit-packet.md:219:  `{ Builtin(u32), Custom(PeerId, u32) }`. Touches `ql-storage`,
quantbook-engine/docs/phase5/v1-exit-packet.md:224:  `Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`. Wire-format
quantbook-engine/docs/phase5/v1-exit-packet.md:239:  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
quantbook-engine/docs/phase5/v1-exit-packet.md:257:  with D-1 schema work (it's the discriminator the loader uses to
quantbook-engine/docs/phase5/v1-exit-packet.md:272:- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/phase5/v1-exit-packet.md:280:ships as a usable surface for Phase 5.7 IDE integration. D-1 is the
quantbook-engine/docs/architecture/crdt-data-model.md:541:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/architecture/crdt-data-model.md:557:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/architecture/crdt-data-model.md:561:pub enum FormatId {
quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/architecture/crdt-data-model.md:573:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/architecture/crdt-data-model.md:578:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/architecture/crdt-data-model.md:709:5. **Format id collision** — **DESIGN RESOLVED in 5.1 by D-1;
quantbook-engine/docs/architecture/crdt-data-model.md:710:   IMPLEMENTATION PENDING** (above). `FormatId` switches from
quantbook-engine/docs/architecture/crdt-data-model.md:711:   `u32` to a tagged tuple (Builtin | Custom(peer_id, counter))
quantbook-engine/docs/architecture/crdt-data-model.md:712:   in Phase 5.2 D-1 (next-session multi-day arc; see
quantbook-engine/docs/architecture/crdt-data-model.md:713:   `docs/phase5/d-1-starting-checklist.md`). Schema bump
quantbook-engine/docs/phase5/entry-plan.md:3:status: SUPERSEDED-BY-EXIT-PACKET — Phase 5 V1 COMPLETE 2026-05-19. See `docs/phase5/v1-exit-packet.md` for the canonical session record. D-1 (multi-day) is the next major Phase 5.2 item; 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 also remain. D-1 fresh-session entry: `docs/phase5/d-1-starting-checklist.md`.
quantbook-engine/docs/phase5/entry-plan.md:6:successor: docs/phase5/v1-exit-packet.md (closeout) + docs/phase5/d-1-starting-checklist.md (D-1 entry)
quantbook-engine/docs/phase5/entry-plan.md:60:> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/phase5/entry-plan.md:114:| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/phase5/entry-plan.md:115:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/phase5/entry-plan.md:128:> (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/docs/phase5/entry-plan.md:135:   needs magic bytes + version header (Tier D3). Bundle into D-1
quantbook-engine/docs/phase5/entry-plan.md:136:   tagged-tuple FormatId schema work (next session).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:2:title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:3:status: DRAFT — entry point for the multi-day D-1 implementation arc
quantbook-engine/docs/phase5/d-1-starting-checklist.md:6:design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/phase5/d-1-starting-checklist.md:9:# Phase 5.2 D-1 — fresh-session starting checklist
quantbook-engine/docs/phase5/d-1-starting-checklist.md:11:D-1 is the **next major Phase 5.2 item** — multi-day, schema-breaking. After D-1, Phase 5 still has 5.3 (conflict resolution), 5.5 V2 V2/V3 (production transport), 5.7 (IDE vertical slice), and 5.8 (megaudit) ahead. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:15:Change `FormatId` from `pub struct FormatId(pub u32)` to a tagged tuple:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:18:pub enum FormatId {
quantbook-engine/docs/phase5/d-1-starting-checklist.md:20:    Custom(PeerId, u32),     // peer-allocated custom format ids
quantbook-engine/docs/phase5/d-1-starting-checklist.md:24:Each peer's allocator increments only its own `Custom` counter; concurrent peers can't collide. Bumps the `.qbook` envelope schema. Backwards-compat: old files with `u32` ids load as `Builtin(n)` if `n ≤ 163`, else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:28:Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:39:  - `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`
quantbook-engine/docs/phase5/d-1-starting-checklist.md:41:  - `FormatTable::register_at(&mut self, id: FormatId, s: &str)` signature stays; logic updates to handle both variants.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:42:  - `FormatTable::intern(&mut self, s: &str) -> FormatId` — needs peer-id context. Either: (a) add `intern_with_peer(peer: PeerId, s: &str)`; or (b) make FormatTable peer-aware via a `peer_id: PeerId` field set at construction.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:44:  - `FormatTable::iter()` — iterator over `(FormatId, &str)`. Signature stays.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:46:- `crates/ql-storage/src/lib.rs` — re-exports `FormatId`. Stays.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:47:- `crates/ql-storage/src/sheet.rs` — `format_overlay: CellFormatOverlay`. CellFormatOverlay stores `FormatId` directly. Update its `set(row, col, FormatId)` value type (already `FormatId`, but underlying serde / Hash etc. needs reverification).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:53:  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatId, string: String }`. Since FormatId is not currently in ql-oplog (it lives in ql-storage), need to introduce a wire-format type:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:54:    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:57:  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:58:  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:65:  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LEGACY_PEER, n - 164)`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:66:  - **Sentinel `LEGACY_PEER` constant proposal:** `pub const LEGACY_PEER: PeerId = PeerId::new(0)` in `ql-oplog::peer` (the new home for PeerId per D-1 step 1). PeerId(0) is a reserved sentinel — Loro accepts it as a valid peer-id but Phase 5.2.b documents that "two concurrent sessions MUST use distinct peer ids," so production callers will avoid 0; LegacyPeer claiming 0 is safe. Alternative: `PeerId(u64::MAX - 1)` (Loro rejects MAX itself but MAX-1 is valid). Pick one in step 1.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:70:- `crates/ql-io-xlsx/src/read/styles_import.rs` + `read/cell_styles_xml.rs` + `read/styles_xml.rs` — read xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`. Also `ql-io-xlsx/src/lib.rs:231-275` for the top-level import wiring.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:71:- `crates/ql-io-xlsx/src/write/umya_export.rs` — emit xlsx `cellXfs` from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`. (Note: there is NO `write/cell_styles_xml.rs`; the cell-styles XML is generated by `umya_export.rs` post-processing — checked 2026-05-19.)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:75:- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:76:- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:80:- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:81:- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:92:- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:94:### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:96:- Add `ql-oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. This is the "destination shape" for Op variants.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:98:- Add `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` (the migration helper).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:99:- Tests: round-trip FormatIdWire through serde JSON.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:100:- Commit: `Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:102:### Step 3: Change `ql-storage::FormatId` to the tagged tuple (2-3 hours)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:108:- Commit: `Phase 5.2 D-1 step 3 — FormatId enum in ql-storage (breaks downstream)`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:110:### Step 4: Update `Op::RegisterFormat` / `Op::SetCellFormat` to use FormatIdWire (1-2 hours)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:115:- Commit: `Phase 5.2 D-1 step 4 — Op wire format uses FormatIdWire`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:120:- Old-format loader: detect schema version, migrate `u32` → `FormatId` via legacy mapping.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:122:- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:126:- Flatten `FormatId` → xlsx `numFmtId` on export.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:127:- Inflate xlsx `numFmtId` → `FormatId::Builtin(n)` on import.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:129:- Commit: `Phase 5.2 D-1 step 6 — xlsx numFmtId ↔ FormatId mapping`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:133:- Bundle with D-1 per the entry plan. Add a 4-byte magic header + u32 schema version to `oplog.bin`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:134:- This is the discriminator the loader uses to know whether to apply legacy FormatId migration.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:139:- 2-way Codex + Opus audit of the full D-1 arc. Multi-step schema change is exactly the kind of cycle the audit-discipline rule was written for.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:146:Before starting D-1, verify:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:153:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:166:- **Loro UndoManager peer-id binding:** if D-1 changes how `FormatTable::peer_id` is set after construction, may interact with the 5.4 V1 audit's set_peer_id silent-clear footgun. The fix at 5.4 V1 made `OpLog::set_peer_id` `&mut self`; if D-1 needs to bump format-allocator peer-id mid-session, plan for the undo-stack clear as a documented side-effect.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:167:- **Tier C2 (BatchCommit depth guard)**: still pending but low priority. Not blocking D-1.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:171:D-1 ships when:
quantbook-engine/docs/phase5/d-1-starting-checklist.md:173:1. `FormatId` is the tagged tuple in `ql-storage`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:176:4. xlsx round-trip preserves all FormatId variants correctly.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:179:7. `v1-exit-packet.md` updated to reflect D-1 ✅ shipped, leaving 5.3 + 5.5 V2 V2/V3 + 5.7 + 5.8 as remaining Phase 5 items.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:181:After D-1 ships, Phase 5 is **~80% complete** (5.1 + 5.2 + 5.4 + 5.5 V1 + 5.5 V2 V1 + 5.6 + 5.6 V2 + Tier D3). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 WebSocket transport, 5.7 IDE vertical slice, 5.8 megaudit.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:1:# Separate-Opus audit: W5-D-14.2 (4 HIGH closures)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:56:- Why it matters: in v1, Quantbook's `apply_value_to_cell` doesn't apply per-cell styles (all error cells get default style 0), so empirically the patch matches. But the moment per-cell style application lands (W5-D-14 followups + Phase 4.12), styled error cells will silently corrupt to `#VALUE!` on export. Same defect applies to the `t="str"` removal.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:151:### L-11: Style codes ≥ 164 are written but no lower-bound check on max format id. If a user manages to register `FormatId(u32::MAX)`, the export emits `<numFmt numFmtId="4294967295" .../>` which is valid u32 but exceeds OOXML reasonable range (Excel limits ≤ ~32767). Edge case.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:1:# separate-Opus audit: W5-D-15 (Phase 4.11 XLSX-4-03 per-cell format APPLICATION)
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:4:Scope: per-cell `(row, col) → FormatId` round-trip closure.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:12:W5-D-15.1 self-audit H-2/H-3 patches partially applied — flagged where
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:16:The user's self-audit (`docs/audits/2026-05-18-w5-d-15-self.md`)
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:34:  1. Sheet bounds = (0,0) — entire W5-D-15 overlay walk SKIPPED by the
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:38:     (0,0) → bounds (1,1)): the W5-D-15 walk runs and schedules a
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:78:  committed parser uses `false` as the default. The W5-D-15 wiring at
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:91:  this to `true` per a W5-D-15.1 closure. The committed code has the
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:116:  FormatId>`. Rust's `HashMap` uses randomized `RandomState`; the
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:118:  processes. The W5-D-15 code mints `xf_index = roster.len() + 1` for
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:119:  the FIRST occurrence of each FormatId — so the (FormatId →
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:124:  on re-import (the FormatId mapping survives via numFmtId), but:
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:138:  `HashMap<FormatId, u32>` + `Vec<FormatId>` to a `BTreeMap<FormatId,
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:139:  u32>` (or post-walk sort the roster by FormatId before assigning
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:202:  1. The formula text is dropped (pre-existing umya/W5-D-14e
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:203:     behavior). Pre-W5-D-15 problem; not a W5-D-15 regression but
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:205:  2. NEW with W5-D-15: any overlay entry on this cell is also
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:207:     match. The W5-D-15 commit message claims "formats round-trip"
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:288:  Vec accumulates FormatIds in the order they're FIRST seen across
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:290:  each sheet the sort is `(FormatId, row, col)`. So intra-sheet
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:291:  determinism is fine, but if sheet 0 has FormatId 165, sheet 1 has
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:292:  FormatId 164, the roster ends up `[165, 164]` (because 165 is seen
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:295:  deterministic — but it diverges from what a `BTreeMap<FormatId,
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:298:  consistency one. The H-3 sort by (FormatId, row, col) inside a
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:302:  BTreeMap<FormatId, u32>. Or, post-pass, sort `cellxfs_roster` by
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:303:  FormatId and rewrite all `xf_index` assignments accordingly. The
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:335:  against `MAX_ROW`/`MAX_COLUMN` and emit warnings. The W5-D-15
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:350:- What's wrong: the W5-D-15 default slot 0 has no
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:353:  (General)" on re-import. The W5-D-15 import wiring at
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:371:  `export_new_workbook`, which is the W5-D-15 path. `xl/styles.xml`
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:421:  `s` attrs, the parser emits both. The W5-D-15 wiring at lib.rs
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:431:  `overlay.get(...) == Some(FormatId(N))`. A bug that ALSO populates
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:484:- The W5-D-15 wiring at `lib.rs:178-213` correctly skips `s="0"` and
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:488:  with the same FormatId share one cellXf slot (verified by
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:495:  introduced; W5-D-14.1's HIGH-9 closure is preserved.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:499:- The W5-D-15 `inject_cell_xfs_into_styles_xml` correctly uses the
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:501:  the W5-D-14.2.3 closure.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:503:  (W5-D-14d); the FormatId values flow verbatim through round-trip.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:512:has partial W5-D-15.1 self-audit fixes applied). Findings noted where
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:515:- **Scenario 1** (3 cells, 2 FormatIds): styles.xml has
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:517:  Cells get `s="1"` (FormatId 14) and `s="2"` (FormatId 164).
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:522:  (umya's default — the W5-D-15 injector ran AND wrote 1 entry +
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:554:- **Scenario 11** (pure overlay, no put_at, bounds=(0,0)): W5-D-15
quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:566:3. H-3 — sort the workbook-level `cellxfs_roster` by FormatId for
quantbook-engine/docs/architecture/ide-consumer-contract.md:209:**D-1 pending:** `FormatId` is still `u32` (per ql-storage::FormatId); Phase 5.2 D-1 will switch it to a tagged tuple `{ Builtin(u32) | Custom(PeerId, u32) }`. IDE callers that observe FormatId today (e.g. cell-format-id lookups) will need to handle both variants post-D-1.
quantbook-engine/crates/ql-functions/src/scalar_fns.rs:3512:    // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus LOW-1 closure):**
quantbook-engine/crates/ql-functions/src/scalar_fns.rs:3514:    // W5-D-11.1 `extract_quartile_q` and W5-D-12 SUBTOTAL guards. The
quantbook-engine/crates/ql-functions/src/scalar_fns.rs:3654:/// - **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-1 closure):**
quantbook-engine/crates/ql-functions/src/scalar_fns.rs:7759:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-1 closure):**
quantbook-engine/crates/ql-storage/src/sheet.rs:31:    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
quantbook-engine/crates/ql-oplog/src/replay.rs:502:            let fid = ql_storage::FormatId(*id);
quantbook-engine/crates/ql-oplog/src/replay.rs:523:                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/crates/ql-oplog/src/replay.rs:1355:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1375:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1426:            Some(ql_storage::FormatId(200))
quantbook-engine/crates/ql-oplog/src/replay.rs:1521:            Some(ql_storage::FormatId(14))
quantbook-engine/crates/ql-io/src/qbook_format.rs:568:/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/crates/ql-io/src/qbook_format.rs:1513:                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
quantbook-engine/crates/ql-io/src/qbook_format.rs:1551:        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/crates/ql-io/src/qbook_format.rs:1586:                    ql_storage::FormatId(entry.id),
quantbook-engine/crates/ql-io/src/qbook_format.rs:2950:            loaded.formats().lookup(ql_storage::FormatId(14)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:2980:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:2996:            .set(0, 0, ql_storage::FormatId(14)); // m/d/yyyy
quantbook-engine/crates/ql-io/src/qbook_format.rs:3000:            .set(3, 5, ql_storage::FormatId(4)); // #,##0.00
quantbook-engine/crates/ql-io/src/qbook_format.rs:3004:            .set(10, 20, ql_storage::FormatId(49)); // @
quantbook-engine/crates/ql-io/src/qbook_format.rs:3010:            Some(ql_storage::FormatId(14))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3014:            Some(ql_storage::FormatId(4))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3019:            Some(ql_storage::FormatId(49))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3070:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3076:                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3160:        // at an unregistered FormatId must surface as
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:62://! - **Phase 5.2 D-1 step 1 (2026-05-19):** `PeerId` moved from
quantbook-engine/crates/ql-collab/src/lib.rs:64://!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:308:The original draft said "each cell can carry `format_id: Option<FormatId>`" — but Quantbook storage is **columnar** (Arrow chunks + sparse overlays at `crates/ql-storage/src/column.rs`), not row-based with per-cell structs. There's no `Cell` type to attach `format_id` to. Concrete redesign:
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:317:    by_id: IndexMap<FormatId, String>,
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:318:    by_string: HashMap<String, FormatId>,
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:322:    pub fn intern(&mut self, s: &str) -> FormatId;
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:323:    pub fn lookup(&self, id: FormatId) -> Option<&str>;
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:324:    pub fn builtin_general() -> FormatId;  // id = 0 by convention
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:338:    // Each chunk is `HashMap<(RowId, ColId), FormatId>` keyed by intra-chunk addr.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:339:    chunks: Vec<HashMap<(RowId, ColId), FormatId>>,
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:343:    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId>;  // None ≡ General
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:344:    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId);
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:349:**Why sparse**: most cells have General format. Storing `Option<FormatId>` per cell would cost 8 bytes × N cells, mostly None. The sparse overlay costs only proportional to the number of cells that ACTUALLY have a custom format.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:354:- `Op::RegisterFormat { id: FormatId, string: String }` — written when `FormatTable::intern` allocates a NEW id. Idempotent on replay (intern returns the same id given the same string).
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:355:- `Op::SetCellFormat { sheet: SheetId, row: RowId, col: ColId, id: FormatId }` — written when `CellFormatOverlay::set` is called.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:447:- [ ] DTF-4-04: cell `format_id: Option<FormatId>` field + workbook-level dedup; storage round-trip test.
quantbook-engine/docs/architecture/2026-05-13-dates-times-formats.md:489:- Is the `format_id: Option<FormatId>` storage design sound? Any concern with the dedup table being workbook-level?
quantbook-engine/crates/ql-storage/src/format_overlay.rs:4://! entry render via `FormatId::GENERAL` semantics.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:7://! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:13://! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
quantbook-engine/crates/ql-storage/src/format_overlay.rs:23:use crate::format::FormatId;
quantbook-engine/crates/ql-storage/src/format_overlay.rs:25:/// Sparse per-sheet `(row, col) → FormatId` overlay.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:27:/// Cells absent from the overlay render via `FormatId::GENERAL`.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:30:    entries: HashMap<(RowId, ColId), FormatId>,
quantbook-engine/crates/ql-storage/src/format_overlay.rs:40:    /// `FormatId::GENERAL`.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:41:    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:47:    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:52:    /// `FormatId::GENERAL`. Returns the cleared id, if any.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:53:    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:72:    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
quantbook-engine/crates/ql-storage/src/format_overlay.rs:74:    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:81:    pub fn count_refs(&self, id: FormatId) -> usize {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:106:        let id = FormatId(14);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:114:        assert_eq!(o.set(5, 3, FormatId(14)), None);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:115:        assert_eq!(o.set(5, 3, FormatId(15)), Some(FormatId(14)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:116:        assert_eq!(o.get(5, 3), Some(FormatId(15)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:122:        o.set(5, 3, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:123:        assert_eq!(o.clear(5, 3), Some(FormatId(14)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:136:        o.set(0, 0, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:137:        o.set(1, 1, FormatId(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:145:        o.set(0, 0, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:146:        o.set(0, 1, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:147:        o.set(0, 2, FormatId(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:148:        assert_eq!(o.count_refs(FormatId(14)), 2);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:149:        assert_eq!(o.count_refs(FormatId(15)), 1);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:150:        assert_eq!(o.count_refs(FormatId(999)), 0);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:156:        o.set(0, 0, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:157:        o.set(1, 1, FormatId(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:165:        o.set(0, 0, FormatId(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:166:        o.set(0, 1, FormatId(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:167:        o.set(1, 0, FormatId(16));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:168:        assert_eq!(o.get(0, 0), Some(FormatId(14)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:169:        assert_eq!(o.get(0, 1), Some(FormatId(15)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:170:        assert_eq!(o.get(1, 0), Some(FormatId(16)));
quantbook-engine/crates/ql-functions/src/registry.rs:493:    // **W5-D-10 (Phase 4.10 — V1 260 closeout — error function
quantbook-engine/crates/ql-functions/src/registry.rs:823:    // **W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics):**
quantbook-engine/crates/ql-functions/src/registry.rs:837:    // **W5-D-12 (Phase 4.10 — V1 260 sealer):** SUBTOTAL — conditional
quantbook-engine/crates/ql-functions/src/registry.rs:889:    // **W5-D-1 (Wave 3 distributions batch — normal)**: NORM.DIST /
quantbook-engine/crates/ql-functions/src/registry.rs:902:    // divergences as W5-D-1 (Booleans coerced to 0/1 vs IronCalc rejects).
quantbook-engine/crates/ql-functions/src/registry.rs:913:    // coercion-frontend divergences as W5-D-1 / W5-D-2.
quantbook-engine/crates/ql-functions/src/registry.rs:945:    // functions; CONFIDENCE.* reuses standard_normal() (W5-D-1) +
quantbook-engine/crates/ql-functions/src/registry.rs:1046:        // W5-D-1 (Wave 3 distributions batch — normal): NORM.DIST,
quantbook-engine/crates/ql-functions/src/registry.rs:1066:        // statrs::function::gamma + CONFIDENCE.* reusing W5-D-1/W5-D-2
quantbook-engine/crates/ql-functions/src/registry.rs:1084:        // W5-D-10 (Phase 4.10 — V1 260 closeout — error function
quantbook-engine/crates/ql-functions/src/registry.rs:1087:        // W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics):
quantbook-engine/crates/ql-functions/src/registry.rs:1092:        // W5-D-12 (Phase 4.10 — V1 260 sealer): SUBTOTAL = 1 — range-
quantbook-engine/crates/ql-oplog/src/peer.rs:4://! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
quantbook-engine/crates/ql-oplog/src/peer.rs:23://! - Phase 5 D-1 (in progress) — the `FormatId::Custom(PeerId, u32)`
quantbook-engine/docs/phase4/exit-packet.md:40:| 4.10 | Function library (260 fns) | ✅ | V1-260 hit at `5d117724f27`; `W5-D-13.1` phase megaudit caught 6 HIGHs |
quantbook-engine/docs/phase4/exit-packet.md:41:| 4.11 | XLSX I/O | ✅ | 11 commits W5-D-14a → W5-D-15.2; 5-way parallel megaudit closed 17/20 HIGHs |
quantbook-engine/docs/phase4/exit-packet.md:70:- `ql-storage::{Workbook, Sheet, FormatTable, FormatId, NameTable, NamedTarget, TableTable, TableMetadata, CellFormatOverlay, FIRST_CUSTOM_FORMAT_ID}`
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:275:            // **W5-D-12 (Phase 4.10 V1-260 sealer) — Codex HIGH-001
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:281:            // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure):**
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:284:            // gap the W5-D-12 closure caught only for SUBTOTAL. Per
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:354:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:359:    /// W5-D-12 SUBTOTAL closure should have had but didn't, scaled to
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:364:    /// pre-W5-D-13.1 build would fail every one of these with
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:379:        // SUBTOTAL(9, Sales) = SUM(Sales) = 6. The Codex W5-D-12
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:483:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-002
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:515:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:520:    /// exactly why the W5-D-12 closure shipped a SUBTOTAL-only fix
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:540:        // **Empty as of W5-D-13.1** — every range-aware-registered fn
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:556:            "W5-D-13.1 invariant: every range-aware fn must be admitted to \
quantbook-engine/docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:14://!   `FormatId` (or clear via `None`). Refuses unknown ids
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:15://!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:17://!   through its `FormatId` binding (or General if unbound).
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:23:use ql_storage::FormatId;
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:32:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:51:        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:66:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:80:        id: Option<FormatId>,
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:88:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:117:    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:135:    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:154:            .unwrap_or(FormatId::GENERAL);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:186:    use ql_storage::{FormatId, Workbook};
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:202:            assert_eq!(id, FormatId::GENERAL);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:204:            assert_eq!(id2, FormatId(2));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:256:            rt.set_cell_format(s, 3, 5, Some(FormatId(14))).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:261:            Some(FormatId(14))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:278:            .set(0, 0, FormatId(14));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:299:            .set_cell_format(s, 0, 0, Some(FormatId(9999)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:301:        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:313:        // No overlay entry → FormatId::GENERAL → integer renders without decimal.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:326:            .set(0, 0, FormatId(14)); // m/d/yyyy
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:376:            .set(0, 0, FormatId(14));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:390:            .set(0, 0, FormatId(49)); // @
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:413:        let custom_id = FormatId(ql_storage::FIRST_CUSTOM_FORMAT_ID);
quantbook-engine/crates/ql-functions/src/financial_fns.rs:1696:///   `1 + rate > 0`; `rate <= -1` → `#NUM!`). **W5-D-13.1 megaudit
quantbook-engine/crates/ql-functions/src/financial_fns.rs:1722:    // **W5-D-13.1 megaudit Opus LOW-3 closure:** require `1 + rate > 0`
quantbook-engine/crates/ql-functions/src/financial_fns.rs:2987:        // rate = 1.5/10 = 0.15; period-1 DDB = 2400 * 0.15 = 360.
quantbook-engine/crates/ql-functions/src/financial_fns.rs:3551:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus LOW-3 closure):**
quantbook-engine/crates/ql-functions/src/financial_fns.rs:3573:        // **W5-D-13.1 megaudit Opus LOW-3 closure:** rate ∈ (-1, 0)
quantbook-engine/crates/ql-collab/src/session.rs:161:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/crates/ql-collab/src/session.rs:191:    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/crates/ql-collab/src/session.rs:1751:        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:193:                    .register_at(ql_storage::FormatId(*id), string.as_str())
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:206:                            .set(*row, *col, ql_storage::FormatId(*raw_id));
quantbook-engine/crates/ql-storage/src/lib.rs:36:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-storage/src/lib.rs:69:        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/crates/ql-storage/src/lib.rs:70:        assert_eq!(wb.formats().lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/crates/ql-storage/src/lib.rs:77:        assert_eq!(id, FormatId(2));
quantbook-engine/crates/ql-storage/src/lib.rs:96:        s.format_overlay_mut().set(3, 5, FormatId(14));
quantbook-engine/crates/ql-storage/src/lib.rs:97:        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:568:   108	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:593:   133	    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1608:   722	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2196:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:50:- Why it matters: in v1 NewWorkbook mode, umya never emits any of these three elements pre-injection, so Case 1 never fires — empirically safe. But it's a latent corruption bomb: any future refactor that has umya emit `<numFmts>`/`<definedNames>`/`<tableParts>` (e.g., adopting a newer umya version that handles custom formats natively, or extending to UpdateOriginal with sheet-xml surgery) will silently produce invalid xlsx files.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2197:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:79:- What's wrong: classify_part returns `DropSilently` for `xl/calcChain.xml`, so `preserved_part_paths` doesn't include it. The merge logic at line 303 (`if !preserved_set.contains(normalised.as_str()) { continue; }`) skips it correctly. **No defect today.** Flagging because the design conflates "preserved" with "Content_Types-merged" — future divergence (e.g. someone adds a part that needs DropSilently but its Override should still be carried) requires both lists.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2198:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:123:- The function uses `existing_names` to decide whether to emit a fresh sheet-rels file. If a future change extends post-process to add entries to `existing_names` after the read but before the rels emission, the dedup could miss. Minor maintenance concern.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2199:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:50:- Why it matters: in v1 NewWorkbook mode, umya never emits any of these three elements pre-injection, so Case 1 never fires — empirically safe. But it's a latent corruption bomb: any future refactor that has umya emit `<numFmts>`/`<definedNames>`/`<tableParts>` (e.g., adopting a newer umya version that handles custom formats natively, or extending to UpdateOriginal with sheet-xml surgery) will silently produce invalid xlsx files.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2200:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:79:- What's wrong: classify_part returns `DropSilently` for `xl/calcChain.xml`, so `preserved_part_paths` doesn't include it. The merge logic at line 303 (`if !preserved_set.contains(normalised.as_str()) { continue; }`) skips it correctly. **No defect today.** Flagging because the design conflates "preserved" with "Content_Types-merged" — future divergence (e.g. someone adds a part that needs DropSilently but its Override should still be carried) requires both lists.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2201:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:123:- The function uses `existing_names` to decide whether to emit a fresh sheet-rels file. If a future change extends post-process to add entries to `existing_names` after the read but before the rels emission, the dedup could miss. Minor maintenance concern.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2204:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2205:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:174:  placeholder sheets for future content). For these, every format
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2206:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:361:  short-circuit so future maintainers don't get confused.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2207:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:373:  works. But there's no test asserting it. A future change to
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2208:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:459:  future emitter changes.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2209:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2210:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:174:  placeholder sheets for future content). For these, every format
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2211:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:361:  short-circuit so future maintainers don't get confused.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2212:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:373:  works. But there's no test asserting it. A future change to
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2213:quantbook-engine/docs/audits/2026-05-18-w5-d-15-opus.md:459:  future emitter changes.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2323:quantbook-engine/docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2381:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:511:docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2396:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2424:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:575:docs/audits/2026-05-17-w5-d-1-codex.md:60:Severity rationale: Runtime behavior is correct, but the misleading comments are exactly where future distribution ports will look for precedent. This can cause regressions toward IronCalc's stricter Boolean behavior or incorrect error-class assumptions.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2450:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:612:docs/audits/2026-05-18-w5-d-14-2-opus.md:50:- Why it matters: in v1 NewWorkbook mode, umya never emits any of these three elements pre-injection, so Case 1 never fires — empirically safe. But it's a latent corruption bomb: any future refactor that has umya emit `<numFmts>`/`<definedNames>`/`<tableParts>` (e.g., adopting a newer umya version that handles custom formats natively, or extending to UpdateOriginal with sheet-xml surgery) will silently produce invalid xlsx files.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2451:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:613:docs/audits/2026-05-18-w5-d-14-2-opus.md:79:- What's wrong: classify_part returns `DropSilently` for `xl/calcChain.xml`, so `preserved_part_paths` doesn't include it. The merge logic at line 303 (`if !preserved_set.contains(normalised.as_str()) { continue; }`) skips it correctly. **No defect today.** Flagging because the design conflates "preserved" with "Content_Types-merged" — future divergence (e.g. someone adds a part that needs DropSilently but its Override should still be carried) requires both lists.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2452:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:614:docs/audits/2026-05-18-w5-d-14-2-opus.md:123:- The function uses `existing_names` to decide whether to emit a fresh sheet-rels file. If a future change extends post-process to add entries to `existing_names` after the read but before the rels emission, the dedup could miss. Minor maintenance concern.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2459:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:711:docs/audits/2026-05-17-w5-d-11-opus.md:53:4. **No NaN-k pin for either.** While my compiled probe confirmed both kernels reject NaN k via `(0..=1).contains(&NaN) == false` and the engine's `to_number_strict_skip_blank` already maps NaN-bypassing `Value::Number(NaN)` to `#NUM!` upstream, **the test suite does not pin the NaN-k behavior**. Pinning it would harden the implementation against a future refactor that bypasses the `(range).contains` rejection (e.g. if someone re-orders the checks).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2460:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:712:docs/audits/2026-05-17-w5-d-11-opus.md:57:**Severity rationale:** No correctness bug — the behavior is correct under the current code path. But the missing pins mean a future refactor could silently change behavior without test failure. NaN-k in particular: a refactor that moves the bound check below the `pos.floor() as usize` cast (which is `0` for NaN, not a panic in safe-cast Rust) would silently return `sorted[0]` instead of `#NUM!` — a real correctness regression that would slip through.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2461:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:713:docs/audits/2026-05-17-w5-d-11-opus.md:65:**Detail:** Per Codex's documentation review (citing Microsoft TRUNC + QUARTILE.INC docs), Excel truncates a fractional `quart` argument toward zero (TRUNC, not FLOOR). The current implementation uses `n.trunc() as i64` — **correct per Microsoft canon**. But the test suite only pins the positive-fractional case (`quartile_inc_q_truncates_toward_zero`: 2.9 → 2). The negative-fractional case (e.g. `quartile_inc(arr, -0.5)` should return the minimum, NOT `#NUM!`) is NOT pinned. A naive future refactor to `n.floor() as i64` (a plausible misreading of "truncated") would silently change behavior on a sliver of input space without test failure.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2462:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:714:docs/audits/2026-05-17-w5-d-11-opus.md:80:**Severity rationale:** Pure test-coverage gap. The code is correct per Microsoft canon (verified via Codex consultation of Microsoft TRUNC doc). LOW because no behavioral bug — but worth pinning to defend against a future TRUNC→FLOOR refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2463:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:715:docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2464:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:716:docs/audits/2026-05-17-w5-d-11-opus.md:174:**Severity rationale:** Doc precision; no functional impact. Flagged because future maintainers might rely on the "NaN can't reach here" guarantee in a refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2465:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:717:docs/audits/2026-05-17-w5-d-11-opus.md:196:LOW-5 (sort_asc consolidation) is out of scope — defer to a future polish pass.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2513:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:787:docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2514:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:788:docs/audits/2026-05-18-w5-d-15-opus.md:174:  placeholder sheets for future content). For these, every format
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2515:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:789:docs/audits/2026-05-18-w5-d-15-opus.md:361:  short-circuit so future maintainers don't get confused.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2516:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:790:docs/audits/2026-05-18-w5-d-15-opus.md:373:  works. But there's no test asserting it. A future change to
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2517:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:791:docs/audits/2026-05-18-w5-d-15-opus.md:459:  future emitter changes.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2592:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:906:docs/audits/2026-05-17-w5-d-1-opus.md:94:**Impact:** Behavioral inconsistency with the port source (IronCalc) **on the most-used arg type** (Boolean in numeric position). When IronCalc fixtures are eventually built to cross-check NORM.* — which is the natural next step for Wave 3 cohort-wide regression testing — they will diverge silently OR force re-port. Catching the divergence in documentation NOW means the future fixture-author knows where to expect deltas.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2593:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:907:docs/audits/2026-05-17-w5-d-1-opus.md:183:**Recommendation:** soften the claim to: "the underlying distribution math reduces to identical `statrs::Normal::{pdf,cdf,inverse_cdf}` calls for any pair of inputs that successfully coerce to the same f64 — coercion divergences (see HIGH-O-2) are the only behavioral delta." This is the truth and matches what a future maintainer needs to know.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2594:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:908:docs/audits/2026-05-17-w5-d-1-opus.md:281:1. **Dead code is hidden complexity.** A future reader sees `match standard_normal() { Ok(d) => d, Err(e) => return Value::Error(e) }` and wonders under what circumstances `standard_normal()` can fail. The answer is "never in this codebase" — that fact should be visible.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2595:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:909:docs/audits/2026-05-17-w5-d-1-opus.md:286:(a) **Document explicitly that this path is defensive / dead.** Add a comment above each `match normal_with(...)` saying: "Defensive: Normal::new can fail on NaN mean / Inf-NaN sd, both excluded by upstream sanitize_f64 + the sd > 0 check. The map_err is unreachable but kept to match IronCalc's structure and to fail loudly if a future refactor weakens the upstream guards."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2596:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:910:docs/audits/2026-05-17-w5-d-1-opus.md:288:(b) **Replace with `.expect()`** to assert the invariant explicitly. `let dist = normal_with(mean, sd).expect("upstream sanitize_f64 + sd>0 check guarantees Normal::new succeeds");` makes the invariant load-bearing. If a future refactor breaks it, the panic surfaces in the test suite immediately rather than silently returning `#NUM!` for an unintended path.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2597:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:911:docs/audits/2026-05-17-w5-d-1-opus.md:314:This is correct (Excel: NORM.INV(0, ...) → #NUM!; NORM.INV(1, ...) → #NUM!). But the comment in tests doesn't make explicit why we reject the closed-interval endpoints that statrs allows. The risk is: if a future refactor weakens our pre-check from `<=` / `>=` to `<` / `>` (allowing `p == 0.0` / `p == 1.0` through), the test would then call `dist.inverse_cdf(0.0)` which returns `-Infinity` (not panic actually — let me re-read). statrs's source `if !(0.0..=1.0).contains(&x)` → for `x = 0.0`, `0.0..=1.0` DOES contain 0.0, so no panic. Compute: `erfc_inv(0)` = `+inf`. `mean - (sd * sqrt(2) * inf)` = `-inf`. Then `finite_or_num(-inf) → #NUM!`. So weakening our pre-check to `<` / `>` would still produce `#NUM!` from the finite-check at the end — but for the wrong reason (statrs returning `±inf` rather than us rejecting at the gate). The test would still pass with `Value::Error(ErrorValue::Num)`, but the failure mode would have shifted from "domain check" to "post-hoc Inf-filter."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2598:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:912:docs/audits/2026-05-17-w5-d-1-opus.md:380:**Severity rationale:** MEDIUM. Not a bug, but the safety net `finite_or_num` exists specifically for this case and is never invoked by any test. Pinning the boundary tells future maintainers that the contract is "finite or #NUM!, no Inf leaks."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2599:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:913:docs/audits/2026-05-17-w5-d-1-opus.md:388:**Detail:** We ported the first 4 functions from IronCalc's `normal.rs` (NORM.DIST, NORM.S.DIST, NORM.INV, NORM.S.INV) and left out the other 2 (CONFIDENCE.NORM, CONFIDENCE.T). The matrix doesn't track them as deferred. The audit prompt explicitly asks (Item 20) to verify they're tracked as future work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2600:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:914:docs/audits/2026-05-17-w5-d-1-opus.md:408:### MEDIUM-O-9 — Module docstring lists future fns ("T.* / CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*") but doesn't mention statrs's actual capability surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2601:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:915:docs/audits/2026-05-17-w5-d-1-opus.md:412:**Detail:** Both the workspace Cargo.toml comment and the module docstring promise that the statrs dep enables the future distributions:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2602:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:916:docs/audits/2026-05-17-w5-d-1-opus.md:428:However, this is **not load-bearingly documented**. A future statrs upgrade (0.19.0+) might gate, say, `GAMMA` or `BETA` behind a feature, and our `default-features = false` would silently strip it. The Cargo.toml comment claims the dep enables those fns; that promise has no test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2603:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:917:docs/audits/2026-05-17-w5-d-1-opus.md:430:**Recommendation:** either (a) add explicit feature opt-ins as IronCalc does (`features = []` — explicit, not just default-stripped), making it obvious if statrs ever gates a distribution; or (b) add a comment noting that statrs 0.18.0 does not gate distributions and a future upgrade MUST re-verify the surface before claiming a Wave 3 distribution is enabled. IronCalc uses `features = []` explicitly:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2665:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1025:docs/audits/2026-05-17-w5-d-10-codex.md:32:Severity rationale: Documentation/test-comment only. It can mislead future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2692:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1063:docs/audits/2026-05-17-w5-d-12-opus.md:88:- **Detail:** The engine coerces `Boolean(true)` → 1 → AVERAGE and `Boolean(false)` → 0 → #VALUE!. This matches IronCalc (`cast.rs::cast_to_number` lines 155-161: `CalcResult::Boolean(f) => if f { Ok(1.0) } else { Ok(0.0) }`). But **Excel's own canon rejects Boolean function_num: `=SUBTOTAL(TRUE, A1:A4)` returns #VALUE! in Excel.** The engine matches IronCalc here, not Excel. This is fine, but **the coverage entry does not flag this as an Excel divergence**, while it's pinned by a test that locks in the IronCalc-equivalent behavior. A future Excel-canon enforcement pass would need to break this test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2693:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1064:docs/audits/2026-05-17-w5-d-12-opus.md:104:- **Detail:** Both engine `scalar_fns::counta` and IronCalc `subtotal_counta` count errors (engine: `!matches!(v, Value::Blank).count()` includes Error; IronCalc: `String | Number | Boolean | Error => counta += 1`). Behavior matches. **However**, this is NOT pinned by any SUBTOTAL test — the `subtotal_counta_function_num_3` test only covers `[1, "skip", 2, blank, 3]` (no error). A future refactor of `scalar_fns::counta` to skip errors would silently break compatibility with IronCalc + Excel canon (Excel COUNTA does count errors) and the engine-wide aggregate convention. Probe-verified: `SUBTOTAL(3, [1, #DIV/0!, 3]) = ?`. **Not tested** in the new SUBTOTAL block (probe-confirmed = 3.0 — passes through to counta which counts the error).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2694:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1065:docs/audits/2026-05-18-w5-d-14-codex.md:293:**Subject:** Comments path prefix can overmatch future comment-related parts
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2773:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1145:docs/audits/2026-05-17-w5-d-11-codex.md:29:Detail: The test comment says it verifies that `PERCENTILE` registers to the same function as `PERCENTILE.INC` and `QUARTILE` registers to `QUARTILE.INC`, but the assertions at lines 716-729 only check `lookup_range_aware(...).is_some()`. A future regression that mapped `PERCENTILE` to `percentile_exc` or `QUARTILE` to `quartile_exc` would still pass this e2e test as long as all six names remained registered.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2884:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1290:docs/audits/2026-05-18-w5-d-15-codex.md:161:`Style::default()`. But this is a sharp edge: any future row/column/cell
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2923:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1337:docs/audits/2026-05-18-w5-d-14-2-self.md:181:  (`update_original.rs:163-171`) is uncovered by tests. If a future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2968:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1429:docs/audits/2026-05-17-w5-d-12-codex.md:47:**Severity rationale:** Documentation-only drift, but it can mislead future audits of the function_num 7/8 dispatch table.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3017:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1529:docs/audits/2026-05-18-w5-d-14-opus.md:565:**Recommendation:** If future work needs byte-identical exports, sort formulas
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3018:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1530:docs/audits/2026-05-18-w5-d-14-opus.md:592:canonical, but formulas stored by direct callers (tests, future op-log
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3092:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1617:docs/audits/2026-05-18-w5-d-15-self.md:23:  the column empty for future data entry. The format is real
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3093:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1618:docs/audits/2026-05-18-w5-d-15-self.md:99:  block, so case-2 never fires today. A future refactor (e.g.,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3094:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1619:docs/audits/2026-05-18-w5-d-15-self.md:129:  no test asserts this — a future change to UpdateOriginal that
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3106:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1634:docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3183:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1717:docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3208:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1750:docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3320:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:511:docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3335:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3363:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:575:docs/audits/2026-05-17-w5-d-1-codex.md:60:Severity rationale: Runtime behavior is correct, but the misleading comments are exactly where future distribution ports will look for precedent. This can cause regressions toward IronCalc's stricter Boolean behavior or incorrect error-class assumptions.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3389:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:612:docs/audits/2026-05-18-w5-d-14-2-opus.md:50:- Why it matters: in v1 NewWorkbook mode, umya never emits any of these three elements pre-injection, so Case 1 never fires — empirically safe. But it's a latent corruption bomb: any future refactor that has umya emit `<numFmts>`/`<definedNames>`/`<tableParts>` (e.g., adopting a newer umya version that handles custom formats natively, or extending to UpdateOriginal with sheet-xml surgery) will silently produce invalid xlsx files.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3390:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:613:docs/audits/2026-05-18-w5-d-14-2-opus.md:79:- What's wrong: classify_part returns `DropSilently` for `xl/calcChain.xml`, so `preserved_part_paths` doesn't include it. The merge logic at line 303 (`if !preserved_set.contains(normalised.as_str()) { continue; }`) skips it correctly. **No defect today.** Flagging because the design conflates "preserved" with "Content_Types-merged" — future divergence (e.g. someone adds a part that needs DropSilently but its Override should still be carried) requires both lists.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3391:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:614:docs/audits/2026-05-18-w5-d-14-2-opus.md:123:- The function uses `existing_names` to decide whether to emit a fresh sheet-rels file. If a future change extends post-process to add entries to `existing_names` after the read but before the rels emission, the dedup could miss. Minor maintenance concern.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3398:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:711:docs/audits/2026-05-17-w5-d-11-opus.md:53:4. **No NaN-k pin for either.** While my compiled probe confirmed both kernels reject NaN k via `(0..=1).contains(&NaN) == false` and the engine's `to_number_strict_skip_blank` already maps NaN-bypassing `Value::Number(NaN)` to `#NUM!` upstream, **the test suite does not pin the NaN-k behavior**. Pinning it would harden the implementation against a future refactor that bypasses the `(range).contains` rejection (e.g. if someone re-orders the checks).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3399:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:712:docs/audits/2026-05-17-w5-d-11-opus.md:57:**Severity rationale:** No correctness bug — the behavior is correct under the current code path. But the missing pins mean a future refactor could silently change behavior without test failure. NaN-k in particular: a refactor that moves the bound check below the `pos.floor() as usize` cast (which is `0` for NaN, not a panic in safe-cast Rust) would silently return `sorted[0]` instead of `#NUM!` — a real correctness regression that would slip through.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3400:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:713:docs/audits/2026-05-17-w5-d-11-opus.md:65:**Detail:** Per Codex's documentation review (citing Microsoft TRUNC + QUARTILE.INC docs), Excel truncates a fractional `quart` argument toward zero (TRUNC, not FLOOR). The current implementation uses `n.trunc() as i64` — **correct per Microsoft canon**. But the test suite only pins the positive-fractional case (`quartile_inc_q_truncates_toward_zero`: 2.9 → 2). The negative-fractional case (e.g. `quartile_inc(arr, -0.5)` should return the minimum, NOT `#NUM!`) is NOT pinned. A naive future refactor to `n.floor() as i64` (a plausible misreading of "truncated") would silently change behavior on a sliver of input space without test failure.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3401:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:714:docs/audits/2026-05-17-w5-d-11-opus.md:80:**Severity rationale:** Pure test-coverage gap. The code is correct per Microsoft canon (verified via Codex consultation of Microsoft TRUNC doc). LOW because no behavioral bug — but worth pinning to defend against a future TRUNC→FLOOR refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3402:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:715:docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3403:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:716:docs/audits/2026-05-17-w5-d-11-opus.md:174:**Severity rationale:** Doc precision; no functional impact. Flagged because future maintainers might rely on the "NaN can't reach here" guarantee in a refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3404:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:717:docs/audits/2026-05-17-w5-d-11-opus.md:196:LOW-5 (sort_asc consolidation) is out of scope — defer to a future polish pass.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3452:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:787:docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3453:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:788:docs/audits/2026-05-18-w5-d-15-opus.md:174:  placeholder sheets for future content). For these, every format
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3454:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:789:docs/audits/2026-05-18-w5-d-15-opus.md:361:  short-circuit so future maintainers don't get confused.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3455:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:790:docs/audits/2026-05-18-w5-d-15-opus.md:373:  works. But there's no test asserting it. A future change to
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3456:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:791:docs/audits/2026-05-18-w5-d-15-opus.md:459:  future emitter changes.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3531:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:906:docs/audits/2026-05-17-w5-d-1-opus.md:94:**Impact:** Behavioral inconsistency with the port source (IronCalc) **on the most-used arg type** (Boolean in numeric position). When IronCalc fixtures are eventually built to cross-check NORM.* — which is the natural next step for Wave 3 cohort-wide regression testing — they will diverge silently OR force re-port. Catching the divergence in documentation NOW means the future fixture-author knows where to expect deltas.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3532:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:907:docs/audits/2026-05-17-w5-d-1-opus.md:183:**Recommendation:** soften the claim to: "the underlying distribution math reduces to identical `statrs::Normal::{pdf,cdf,inverse_cdf}` calls for any pair of inputs that successfully coerce to the same f64 — coercion divergences (see HIGH-O-2) are the only behavioral delta." This is the truth and matches what a future maintainer needs to know.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3533:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:908:docs/audits/2026-05-17-w5-d-1-opus.md:281:1. **Dead code is hidden complexity.** A future reader sees `match standard_normal() { Ok(d) => d, Err(e) => return Value::Error(e) }` and wonders under what circumstances `standard_normal()` can fail. The answer is "never in this codebase" — that fact should be visible.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3534:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:909:docs/audits/2026-05-17-w5-d-1-opus.md:286:(a) **Document explicitly that this path is defensive / dead.** Add a comment above each `match normal_with(...)` saying: "Defensive: Normal::new can fail on NaN mean / Inf-NaN sd, both excluded by upstream sanitize_f64 + the sd > 0 check. The map_err is unreachable but kept to match IronCalc's structure and to fail loudly if a future refactor weakens the upstream guards."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3535:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:910:docs/audits/2026-05-17-w5-d-1-opus.md:288:(b) **Replace with `.expect()`** to assert the invariant explicitly. `let dist = normal_with(mean, sd).expect("upstream sanitize_f64 + sd>0 check guarantees Normal::new succeeds");` makes the invariant load-bearing. If a future refactor breaks it, the panic surfaces in the test suite immediately rather than silently returning `#NUM!` for an unintended path.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3536:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:911:docs/audits/2026-05-17-w5-d-1-opus.md:314:This is correct (Excel: NORM.INV(0, ...) → #NUM!; NORM.INV(1, ...) → #NUM!). But the comment in tests doesn't make explicit why we reject the closed-interval endpoints that statrs allows. The risk is: if a future refactor weakens our pre-check from `<=` / `>=` to `<` / `>` (allowing `p == 0.0` / `p == 1.0` through), the test would then call `dist.inverse_cdf(0.0)` which returns `-Infinity` (not panic actually — let me re-read). statrs's source `if !(0.0..=1.0).contains(&x)` → for `x = 0.0`, `0.0..=1.0` DOES contain 0.0, so no panic. Compute: `erfc_inv(0)` = `+inf`. `mean - (sd * sqrt(2) * inf)` = `-inf`. Then `finite_or_num(-inf) → #NUM!`. So weakening our pre-check to `<` / `>` would still produce `#NUM!` from the finite-check at the end — but for the wrong reason (statrs returning `±inf` rather than us rejecting at the gate). The test would still pass with `Value::Error(ErrorValue::Num)`, but the failure mode would have shifted from "domain check" to "post-hoc Inf-filter."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3537:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:912:docs/audits/2026-05-17-w5-d-1-opus.md:380:**Severity rationale:** MEDIUM. Not a bug, but the safety net `finite_or_num` exists specifically for this case and is never invoked by any test. Pinning the boundary tells future maintainers that the contract is "finite or #NUM!, no Inf leaks."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3538:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:913:docs/audits/2026-05-17-w5-d-1-opus.md:388:**Detail:** We ported the first 4 functions from IronCalc's `normal.rs` (NORM.DIST, NORM.S.DIST, NORM.INV, NORM.S.INV) and left out the other 2 (CONFIDENCE.NORM, CONFIDENCE.T). The matrix doesn't track them as deferred. The audit prompt explicitly asks (Item 20) to verify they're tracked as future work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3539:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:914:docs/audits/2026-05-17-w5-d-1-opus.md:408:### MEDIUM-O-9 — Module docstring lists future fns ("T.* / CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*") but doesn't mention statrs's actual capability surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3540:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:915:docs/audits/2026-05-17-w5-d-1-opus.md:412:**Detail:** Both the workspace Cargo.toml comment and the module docstring promise that the statrs dep enables the future distributions:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3541:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:916:docs/audits/2026-05-17-w5-d-1-opus.md:428:However, this is **not load-bearingly documented**. A future statrs upgrade (0.19.0+) might gate, say, `GAMMA` or `BETA` behind a feature, and our `default-features = false` would silently strip it. The Cargo.toml comment claims the dep enables those fns; that promise has no test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3542:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:917:docs/audits/2026-05-17-w5-d-1-opus.md:430:**Recommendation:** either (a) add explicit feature opt-ins as IronCalc does (`features = []` — explicit, not just default-stripped), making it obvious if statrs ever gates a distribution; or (b) add a comment noting that statrs 0.18.0 does not gate distributions and a future upgrade MUST re-verify the surface before claiming a Wave 3 distribution is enabled. IronCalc uses `features = []` explicitly:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3604:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1025:docs/audits/2026-05-17-w5-d-10-codex.md:32:Severity rationale: Documentation/test-comment only. It can mislead future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3631:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1063:docs/audits/2026-05-17-w5-d-12-opus.md:88:- **Detail:** The engine coerces `Boolean(true)` → 1 → AVERAGE and `Boolean(false)` → 0 → #VALUE!. This matches IronCalc (`cast.rs::cast_to_number` lines 155-161: `CalcResult::Boolean(f) => if f { Ok(1.0) } else { Ok(0.0) }`). But **Excel's own canon rejects Boolean function_num: `=SUBTOTAL(TRUE, A1:A4)` returns #VALUE! in Excel.** The engine matches IronCalc here, not Excel. This is fine, but **the coverage entry does not flag this as an Excel divergence**, while it's pinned by a test that locks in the IronCalc-equivalent behavior. A future Excel-canon enforcement pass would need to break this test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3632:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1064:docs/audits/2026-05-17-w5-d-12-opus.md:104:- **Detail:** Both engine `scalar_fns::counta` and IronCalc `subtotal_counta` count errors (engine: `!matches!(v, Value::Blank).count()` includes Error; IronCalc: `String | Number | Boolean | Error => counta += 1`). Behavior matches. **However**, this is NOT pinned by any SUBTOTAL test — the `subtotal_counta_function_num_3` test only covers `[1, "skip", 2, blank, 3]` (no error). A future refactor of `scalar_fns::counta` to skip errors would silently break compatibility with IronCalc + Excel canon (Excel COUNTA does count errors) and the engine-wide aggregate convention. Probe-verified: `SUBTOTAL(3, [1, #DIV/0!, 3]) = ?`. **Not tested** in the new SUBTOTAL block (probe-confirmed = 3.0 — passes through to counta which counts the error).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3633:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1065:docs/audits/2026-05-18-w5-d-14-codex.md:293:**Subject:** Comments path prefix can overmatch future comment-related parts
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3745:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1290:docs/audits/2026-05-18-w5-d-15-codex.md:161:`Style::default()`. But this is a sharp edge: any future row/column/cell
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3784:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1337:docs/audits/2026-05-18-w5-d-14-2-self.md:181:  (`update_original.rs:163-171`) is uncovered by tests. If a future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3829:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1429:docs/audits/2026-05-17-w5-d-12-codex.md:47:**Severity rationale:** Documentation-only drift, but it can mislead future audits of the function_num 7/8 dispatch table.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3878:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1529:docs/audits/2026-05-18-w5-d-14-opus.md:565:**Recommendation:** If future work needs byte-identical exports, sort formulas
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3879:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1530:docs/audits/2026-05-18-w5-d-14-opus.md:592:canonical, but formulas stored by direct callers (tests, future op-log
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3953:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1617:docs/audits/2026-05-18-w5-d-15-self.md:23:  the column empty for future data entry. The format is real
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3954:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1618:docs/audits/2026-05-18-w5-d-15-self.md:99:  block, so case-2 never fires today. A future refactor (e.g.,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3955:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1619:docs/audits/2026-05-18-w5-d-15-self.md:129:  no test asserts this — a future change to UpdateOriginal that
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3967:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1634:docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4044:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1717:docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4069:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1750:docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4171:quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:60:Severity rationale: Runtime behavior is correct, but the misleading comments are exactly where future distribution ports will look for precedent. This can cause regressions toward IronCalc's stricter Boolean behavior or incorrect error-class assumptions.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4172:quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:60:Severity rationale: Runtime behavior is correct, but the misleading comments are exactly where future distribution ports will look for precedent. This can cause regressions toward IronCalc's stricter Boolean behavior or incorrect error-class assumptions.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4173:quantbook-engine/docs/audits/2026-05-17-w5-d-10-codex.md:32:Severity rationale: Documentation/test-comment only. It can mislead future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4175:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4176:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:53:4. **No NaN-k pin for either.** While my compiled probe confirmed both kernels reject NaN k via `(0..=1).contains(&NaN) == false` and the engine's `to_number_strict_skip_blank` already maps NaN-bypassing `Value::Number(NaN)` to `#NUM!` upstream, **the test suite does not pin the NaN-k behavior**. Pinning it would harden the implementation against a future refactor that bypasses the `(range).contains` rejection (e.g. if someone re-orders the checks).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4177:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:57:**Severity rationale:** No correctness bug — the behavior is correct under the current code path. But the missing pins mean a future refactor could silently change behavior without test failure. NaN-k in particular: a refactor that moves the bound check below the `pos.floor() as usize` cast (which is `0` for NaN, not a panic in safe-cast Rust) would silently return `sorted[0]` instead of `#NUM!` — a real correctness regression that would slip through.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4178:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:65:**Detail:** Per Codex's documentation review (citing Microsoft TRUNC + QUARTILE.INC docs), Excel truncates a fractional `quart` argument toward zero (TRUNC, not FLOOR). The current implementation uses `n.trunc() as i64` — **correct per Microsoft canon**. But the test suite only pins the positive-fractional case (`quartile_inc_q_truncates_toward_zero`: 2.9 → 2). The negative-fractional case (e.g. `quartile_inc(arr, -0.5)` should return the minimum, NOT `#NUM!`) is NOT pinned. A naive future refactor to `n.floor() as i64` (a plausible misreading of "truncated") would silently change behavior on a sliver of input space without test failure.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4179:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:80:**Severity rationale:** Pure test-coverage gap. The code is correct per Microsoft canon (verified via Codex consultation of Microsoft TRUNC doc). LOW because no behavioral bug — but worth pinning to defend against a future TRUNC→FLOOR refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4180:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4181:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:174:**Severity rationale:** Doc precision; no functional impact. Flagged because future maintainers might rely on the "NaN can't reach here" guarantee in a refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4182:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:196:LOW-5 (sort_asc consolidation) is out of scope — defer to a future polish pass.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4183:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:53:4. **No NaN-k pin for either.** While my compiled probe confirmed both kernels reject NaN k via `(0..=1).contains(&NaN) == false` and the engine's `to_number_strict_skip_blank` already maps NaN-bypassing `Value::Number(NaN)` to `#NUM!` upstream, **the test suite does not pin the NaN-k behavior**. Pinning it would harden the implementation against a future refactor that bypasses the `(range).contains` rejection (e.g. if someone re-orders the checks).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4184:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:57:**Severity rationale:** No correctness bug — the behavior is correct under the current code path. But the missing pins mean a future refactor could silently change behavior without test failure. NaN-k in particular: a refactor that moves the bound check below the `pos.floor() as usize` cast (which is `0` for NaN, not a panic in safe-cast Rust) would silently return `sorted[0]` instead of `#NUM!` — a real correctness regression that would slip through.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4185:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:65:**Detail:** Per Codex's documentation review (citing Microsoft TRUNC + QUARTILE.INC docs), Excel truncates a fractional `quart` argument toward zero (TRUNC, not FLOOR). The current implementation uses `n.trunc() as i64` — **correct per Microsoft canon**. But the test suite only pins the positive-fractional case (`quartile_inc_q_truncates_toward_zero`: 2.9 → 2). The negative-fractional case (e.g. `quartile_inc(arr, -0.5)` should return the minimum, NOT `#NUM!`) is NOT pinned. A naive future refactor to `n.floor() as i64` (a plausible misreading of "truncated") would silently change behavior on a sliver of input space without test failure.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4186:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:80:**Severity rationale:** Pure test-coverage gap. The code is correct per Microsoft canon (verified via Codex consultation of Microsoft TRUNC doc). LOW because no behavioral bug — but worth pinning to defend against a future TRUNC→FLOOR refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4187:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4188:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:174:**Severity rationale:** Doc precision; no functional impact. Flagged because future maintainers might rely on the "NaN can't reach here" guarantee in a refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4189:quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:196:LOW-5 (sort_asc consolidation) is out of scope — defer to a future polish pass.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4190:quantbook-engine/docs/audits/2026-05-17-w5-d-11-codex.md:29:Detail: The test comment says it verifies that `PERCENTILE` registers to the same function as `PERCENTILE.INC` and `QUARTILE` registers to `QUARTILE.INC`, but the assertions at lines 716-729 only check `lookup_range_aware(...).is_some()`. A future regression that mapped `PERCENTILE` to `percentile_exc` or `QUARTILE` to `quartile_exc` would still pass this e2e test as long as all six names remained registered.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4316:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4329:quantbook-engine/docs/audits/2026-05-17-w5-d-10-codex.md:32:Severity rationale: Documentation/test-comment only. It can mislead future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4354:quantbook-engine/docs/audits/2026-05-17-w5-d-11-codex.md:29:Detail: The test comment says it verifies that `PERCENTILE` registers to the same function as `PERCENTILE.INC` and `QUARTILE` registers to `QUARTILE.INC`, but the assertions at lines 716-729 only check `lookup_range_aware(...).is_some()`. A future regression that mapped `PERCENTILE` to `percentile_exc` or `QUARTILE` to `quartile_exc` would still pass this e2e test as long as all six names remained registered.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4355:quantbook-engine/docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4406:quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:293:**Subject:** Comments path prefix can overmatch future comment-related parts
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4468:quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:293:**Subject:** Comments path prefix can overmatch future comment-related parts
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4529:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:88:- **Detail:** The engine coerces `Boolean(true)` → 1 → AVERAGE and `Boolean(false)` → 0 → #VALUE!. This matches IronCalc (`cast.rs::cast_to_number` lines 155-161: `CalcResult::Boolean(f) => if f { Ok(1.0) } else { Ok(0.0) }`). But **Excel's own canon rejects Boolean function_num: `=SUBTOTAL(TRUE, A1:A4)` returns #VALUE! in Excel.** The engine matches IronCalc here, not Excel. This is fine, but **the coverage entry does not flag this as an Excel divergence**, while it's pinned by a test that locks in the IronCalc-equivalent behavior. A future Excel-canon enforcement pass would need to break this test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4530:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:104:- **Detail:** Both engine `scalar_fns::counta` and IronCalc `subtotal_counta` count errors (engine: `!matches!(v, Value::Blank).count()` includes Error; IronCalc: `String | Number | Boolean | Error => counta += 1`). Behavior matches. **However**, this is NOT pinned by any SUBTOTAL test — the `subtotal_counta_function_num_3` test only covers `[1, "skip", 2, blank, 3]` (no error). A future refactor of `scalar_fns::counta` to skip errors would silently break compatibility with IronCalc + Excel canon (Excel COUNTA does count errors) and the engine-wide aggregate convention. Probe-verified: `SUBTOTAL(3, [1, #DIV/0!, 3]) = ?`. **Not tested** in the new SUBTOTAL block (probe-confirmed = 3.0 — passes through to counta which counts the error).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4531:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:88:- **Detail:** The engine coerces `Boolean(true)` → 1 → AVERAGE and `Boolean(false)` → 0 → #VALUE!. This matches IronCalc (`cast.rs::cast_to_number` lines 155-161: `CalcResult::Boolean(f) => if f { Ok(1.0) } else { Ok(0.0) }`). But **Excel's own canon rejects Boolean function_num: `=SUBTOTAL(TRUE, A1:A4)` returns #VALUE! in Excel.** The engine matches IronCalc here, not Excel. This is fine, but **the coverage entry does not flag this as an Excel divergence**, while it's pinned by a test that locks in the IronCalc-equivalent behavior. A future Excel-canon enforcement pass would need to break this test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4532:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:104:- **Detail:** Both engine `scalar_fns::counta` and IronCalc `subtotal_counta` count errors (engine: `!matches!(v, Value::Blank).count()` includes Error; IronCalc: `String | Number | Boolean | Error => counta += 1`). Behavior matches. **However**, this is NOT pinned by any SUBTOTAL test — the `subtotal_counta_function_num_3` test only covers `[1, "skip", 2, blank, 3]` (no error). A future refactor of `scalar_fns::counta` to skip errors would silently break compatibility with IronCalc + Excel canon (Excel COUNTA does count errors) and the engine-wide aggregate convention. Probe-verified: `SUBTOTAL(3, [1, #DIV/0!, 3]) = ?`. **Not tested** in the new SUBTOTAL block (probe-confirmed = 3.0 — passes through to counta which counts the error).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4777:quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4781:quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4827:quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4828:quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4829:quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:565:**Recommendation:** If future work needs byte-identical exports, sort formulas
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4830:quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:592:canonical, but formulas stored by direct callers (tests, future op-log
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4831:quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:565:**Recommendation:** If future work needs byte-identical exports, sort formulas
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4832:quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:592:canonical, but formulas stored by direct callers (tests, future op-log
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4845:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:23:  the column empty for future data entry. The format is real
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4846:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:99:  block, so case-2 never fires today. A future refactor (e.g.,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4847:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:129:  no test asserts this — a future change to UpdateOriginal that
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4848:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:23:  the column empty for future data entry. The format is real
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4849:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:99:  block, so case-2 never fires today. A future refactor (e.g.,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4850:quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:129:  no test asserts this — a future change to UpdateOriginal that
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4855:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:181:  (`update_original.rs:163-171`) is uncovered by tests. If a future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4856:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:181:  (`update_original.rs:163-171`) is uncovered by tests. If a future
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4871:quantbook-engine/docs/audits/2026-05-17-w5-d-12-codex.md:47:**Severity rationale:** Documentation-only drift, but it can mislead future audits of the function_num 7/8 dispatch table.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4881:quantbook-engine/docs/audits/2026-05-17-w5-d-12-codex.md:47:**Severity rationale:** Documentation-only drift, but it can mislead future audits of the function_num 7/8 dispatch table.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4892:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4894:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4899:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:94:**Impact:** Behavioral inconsistency with the port source (IronCalc) **on the most-used arg type** (Boolean in numeric position). When IronCalc fixtures are eventually built to cross-check NORM.* — which is the natural next step for Wave 3 cohort-wide regression testing — they will diverge silently OR force re-port. Catching the divergence in documentation NOW means the future fixture-author knows where to expect deltas.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4900:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:183:**Recommendation:** soften the claim to: "the underlying distribution math reduces to identical `statrs::Normal::{pdf,cdf,inverse_cdf}` calls for any pair of inputs that successfully coerce to the same f64 — coercion divergences (see HIGH-O-2) are the only behavioral delta." This is the truth and matches what a future maintainer needs to know.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4901:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:281:1. **Dead code is hidden complexity.** A future reader sees `match standard_normal() { Ok(d) => d, Err(e) => return Value::Error(e) }` and wonders under what circumstances `standard_normal()` can fail. The answer is "never in this codebase" — that fact should be visible.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4902:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:286:(a) **Document explicitly that this path is defensive / dead.** Add a comment above each `match normal_with(...)` saying: "Defensive: Normal::new can fail on NaN mean / Inf-NaN sd, both excluded by upstream sanitize_f64 + the sd > 0 check. The map_err is unreachable but kept to match IronCalc's structure and to fail loudly if a future refactor weakens the upstream guards."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4903:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:288:(b) **Replace with `.expect()`** to assert the invariant explicitly. `let dist = normal_with(mean, sd).expect("upstream sanitize_f64 + sd>0 check guarantees Normal::new succeeds");` makes the invariant load-bearing. If a future refactor breaks it, the panic surfaces in the test suite immediately rather than silently returning `#NUM!` for an unintended path.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4904:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:314:This is correct (Excel: NORM.INV(0, ...) → #NUM!; NORM.INV(1, ...) → #NUM!). But the comment in tests doesn't make explicit why we reject the closed-interval endpoints that statrs allows. The risk is: if a future refactor weakens our pre-check from `<=` / `>=` to `<` / `>` (allowing `p == 0.0` / `p == 1.0` through), the test would then call `dist.inverse_cdf(0.0)` which returns `-Infinity` (not panic actually — let me re-read). statrs's source `if !(0.0..=1.0).contains(&x)` → for `x = 0.0`, `0.0..=1.0` DOES contain 0.0, so no panic. Compute: `erfc_inv(0)` = `+inf`. `mean - (sd * sqrt(2) * inf)` = `-inf`. Then `finite_or_num(-inf) → #NUM!`. So weakening our pre-check to `<` / `>` would still produce `#NUM!` from the finite-check at the end — but for the wrong reason (statrs returning `±inf` rather than us rejecting at the gate). The test would still pass with `Value::Error(ErrorValue::Num)`, but the failure mode would have shifted from "domain check" to "post-hoc Inf-filter."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4905:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:380:**Severity rationale:** MEDIUM. Not a bug, but the safety net `finite_or_num` exists specifically for this case and is never invoked by any test. Pinning the boundary tells future maintainers that the contract is "finite or #NUM!, no Inf leaks."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4906:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:388:**Detail:** We ported the first 4 functions from IronCalc's `normal.rs` (NORM.DIST, NORM.S.DIST, NORM.INV, NORM.S.INV) and left out the other 2 (CONFIDENCE.NORM, CONFIDENCE.T). The matrix doesn't track them as deferred. The audit prompt explicitly asks (Item 20) to verify they're tracked as future work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4907:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:408:### MEDIUM-O-9 — Module docstring lists future fns ("T.* / CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*") but doesn't mention statrs's actual capability surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4908:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:412:**Detail:** Both the workspace Cargo.toml comment and the module docstring promise that the statrs dep enables the future distributions:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4909:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:428:However, this is **not load-bearingly documented**. A future statrs upgrade (0.19.0+) might gate, say, `GAMMA` or `BETA` behind a feature, and our `default-features = false` would silently strip it. The Cargo.toml comment claims the dep enables those fns; that promise has no test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4910:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:430:**Recommendation:** either (a) add explicit feature opt-ins as IronCalc does (`features = []` — explicit, not just default-stripped), making it obvious if statrs ever gates a distribution; or (b) add a comment noting that statrs 0.18.0 does not gate distributions and a future upgrade MUST re-verify the surface before claiming a Wave 3 distribution is enabled. IronCalc uses `features = []` explicitly:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4911:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:94:**Impact:** Behavioral inconsistency with the port source (IronCalc) **on the most-used arg type** (Boolean in numeric position). When IronCalc fixtures are eventually built to cross-check NORM.* — which is the natural next step for Wave 3 cohort-wide regression testing — they will diverge silently OR force re-port. Catching the divergence in documentation NOW means the future fixture-author knows where to expect deltas.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4912:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:183:**Recommendation:** soften the claim to: "the underlying distribution math reduces to identical `statrs::Normal::{pdf,cdf,inverse_cdf}` calls for any pair of inputs that successfully coerce to the same f64 — coercion divergences (see HIGH-O-2) are the only behavioral delta." This is the truth and matches what a future maintainer needs to know.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4913:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:281:1. **Dead code is hidden complexity.** A future reader sees `match standard_normal() { Ok(d) => d, Err(e) => return Value::Error(e) }` and wonders under what circumstances `standard_normal()` can fail. The answer is "never in this codebase" — that fact should be visible.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4914:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:286:(a) **Document explicitly that this path is defensive / dead.** Add a comment above each `match normal_with(...)` saying: "Defensive: Normal::new can fail on NaN mean / Inf-NaN sd, both excluded by upstream sanitize_f64 + the sd > 0 check. The map_err is unreachable but kept to match IronCalc's structure and to fail loudly if a future refactor weakens the upstream guards."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4915:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:288:(b) **Replace with `.expect()`** to assert the invariant explicitly. `let dist = normal_with(mean, sd).expect("upstream sanitize_f64 + sd>0 check guarantees Normal::new succeeds");` makes the invariant load-bearing. If a future refactor breaks it, the panic surfaces in the test suite immediately rather than silently returning `#NUM!` for an unintended path.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4916:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:314:This is correct (Excel: NORM.INV(0, ...) → #NUM!; NORM.INV(1, ...) → #NUM!). But the comment in tests doesn't make explicit why we reject the closed-interval endpoints that statrs allows. The risk is: if a future refactor weakens our pre-check from `<=` / `>=` to `<` / `>` (allowing `p == 0.0` / `p == 1.0` through), the test would then call `dist.inverse_cdf(0.0)` which returns `-Infinity` (not panic actually — let me re-read). statrs's source `if !(0.0..=1.0).contains(&x)` → for `x = 0.0`, `0.0..=1.0` DOES contain 0.0, so no panic. Compute: `erfc_inv(0)` = `+inf`. `mean - (sd * sqrt(2) * inf)` = `-inf`. Then `finite_or_num(-inf) → #NUM!`. So weakening our pre-check to `<` / `>` would still produce `#NUM!` from the finite-check at the end — but for the wrong reason (statrs returning `±inf` rather than us rejecting at the gate). The test would still pass with `Value::Error(ErrorValue::Num)`, but the failure mode would have shifted from "domain check" to "post-hoc Inf-filter."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4917:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:380:**Severity rationale:** MEDIUM. Not a bug, but the safety net `finite_or_num` exists specifically for this case and is never invoked by any test. Pinning the boundary tells future maintainers that the contract is "finite or #NUM!, no Inf leaks."
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4918:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:388:**Detail:** We ported the first 4 functions from IronCalc's `normal.rs` (NORM.DIST, NORM.S.DIST, NORM.INV, NORM.S.INV) and left out the other 2 (CONFIDENCE.NORM, CONFIDENCE.T). The matrix doesn't track them as deferred. The audit prompt explicitly asks (Item 20) to verify they're tracked as future work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4919:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:408:### MEDIUM-O-9 — Module docstring lists future fns ("T.* / CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*") but doesn't mention statrs's actual capability surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4920:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:412:**Detail:** Both the workspace Cargo.toml comment and the module docstring promise that the statrs dep enables the future distributions:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4921:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:428:However, this is **not load-bearingly documented**. A future statrs upgrade (0.19.0+) might gate, say, `GAMMA` or `BETA` behind a feature, and our `default-features = false` would silently strip it. The Cargo.toml comment claims the dep enables those fns; that promise has no test.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4922:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:430:**Recommendation:** either (a) add explicit feature opt-ins as IronCalc does (`features = []` — explicit, not just default-stripped), making it obvious if statrs ever gates a distribution; or (b) add a comment noting that statrs 0.18.0 does not gate distributions and a future upgrade MUST re-verify the surface before claiming a Wave 3 distribution is enabled. IronCalc uses `features = []` explicitly:
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5306:quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:161:`Style::default()`. But this is a sharp edge: any future row/column/cell
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:5527:quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:161:`Style::default()`. But this is a sharp edge: any future row/column/cell
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7973:   104	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7974:   105	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7978:   109	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:3://! - **W5-D-1**: NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV —
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:21://! - **W5-D-10 (this commit, Phase 4.10 V1-260 closeout)**: ERF /
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:57://! - **CONFIDENCE.NORM** → reuses NORM standard normal (W5-D-1
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:71://! **W5-D-1 (normal):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:151://!   canon and BINOM.DIST; W5-D-13.1 megaudit Opus MEDIUM-2 closure
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:217://! W5-D-1.1 closure of Opus HIGH-O-1; matches the 132 other arity
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:299://! ## IronCalc divergences (W5-D-1.1 doc closure of Opus HIGH-O-2)
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:315://! coercion-policy change, out of W5-D-1 scope.
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:361:/// **W5-D-1.1 closure (Opus MEDIUM-O-5 / CLAUDE.md "No Fallbacks"
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:379:/// **W5-D-1.1 closure (Opus MEDIUM-O-5):** `.expect()` asserts the
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:516:/// rule (W5-D-1.1 closure pattern).
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:700:/// (W5-D-1.1 closure pattern).
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:1147:    // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-2 closure):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:1181:    // **W5-D-13.1 megaudit Opus MEDIUM-2 closure (p=1 short-circuit):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:1458:/// **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-3 closure):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:1766:// Reuse `standard_normal()` (W5-D-1) and `students_t_with(df)`
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:1847:// W5-D-10 (Phase 4.10 V1-260 closeout): Error function family
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:2449:        // W5-D-1 NORM.* test-shape convention.
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:2610:        // over-arity per W5-D-1 NORM.* convention.
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:2714:        // over-arity per W5-D-1 NORM.* convention.
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:4152:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-2 closure):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:5207:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-3 closure):**
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:5257:        // **W5-D-13.1 (Codex HIGH-3 closure):** the same subnormal-
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:6137:    // ===== W5-D-10 (Phase 4.10 V1-260 closeout) — ERF / ERFC family =====
quantbook-engine/crates/ql-functions/src/distribution_fns.rs:6231:        // **W5-D-10.1 (Opus LOW-2 closure):** the 2-arg form must
quantbook-engine/crates/ql-exec/src/plan.rs:481:            // **W5-D-12 (Phase 4.10 V1-260 sealer) — Codex HIGH-001
quantbook-engine/crates/ql-exec/src/plan.rs:489:            // **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex
quantbook-engine/crates/ql-exec/src/plan.rs:491:            // admitted by the W5-D-12 closure; the same systemic gap
quantbook-engine/crates/ql-exec/src/plan.rs:522:            // Phase 4.10 order-statistics fns (W5-D-11) — take 1
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:153:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:158:    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/crates/ql-storage/src/format.rs:17:/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
quantbook-engine/crates/ql-storage/src/format.rs:20:pub struct FormatId(pub u32);
quantbook-engine/crates/ql-storage/src/format.rs:22:impl FormatId {
quantbook-engine/crates/ql-storage/src/format.rs:24:    pub const GENERAL: FormatId = FormatId(0);
quantbook-engine/crates/ql-storage/src/format.rs:63:/// Cells reference a `FormatId`; the table resolves the id back to a
quantbook-engine/crates/ql-storage/src/format.rs:68:    by_id: HashMap<FormatId, String>,
quantbook-engine/crates/ql-storage/src/format.rs:70:    by_string: HashMap<String, FormatId>,
quantbook-engine/crates/ql-storage/src/format.rs:83:            let fid = FormatId(*id);
quantbook-engine/crates/ql-storage/src/format.rs:100:    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/crates/ql-storage/src/format.rs:112:    pub fn intern(&mut self, s: &str) -> FormatId {
quantbook-engine/crates/ql-storage/src/format.rs:116:        let id = FormatId(self.next_custom_id);
quantbook-engine/crates/ql-storage/src/format.rs:129:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/crates/ql-storage/src/format.rs:178:    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
quantbook-engine/crates/ql-storage/src/format.rs:189:        id: FormatId,
quantbook-engine/crates/ql-storage/src/format.rs:196:        existing_id: FormatId,
quantbook-engine/crates/ql-storage/src/format.rs:197:        attempted_id: FormatId,
quantbook-engine/crates/ql-storage/src/format.rs:208:        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/crates/ql-storage/src/format.rs:209:        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/crates/ql-storage/src/format.rs:210:        assert_eq!(t.lookup(FormatId(49)), Some("@"));
quantbook-engine/crates/ql-storage/src/format.rs:217:        assert_eq!(t.lookup(FormatId(12)), None);
quantbook-engine/crates/ql-storage/src/format.rs:224:        assert_eq!(id, FormatId(2));
quantbook-engine/crates/ql-storage/src/format.rs:233:        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-storage/src/format.rs:258:        t.register_at(FormatId(200), "REPLAY").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:259:        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
quantbook-engine/crates/ql-storage/src/format.rs:262:        assert_eq!(next, FormatId(201));
quantbook-engine/crates/ql-storage/src/format.rs:268:        t.register_at(FormatId(0), "General").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:269:        assert!(t.register_at(FormatId(0), "General").is_ok());
quantbook-engine/crates/ql-storage/src/format.rs:275:        let err = t.register_at(FormatId(0), "DIFFERENT").unwrap_err();
quantbook-engine/crates/ql-storage/src/format.rs:283:        let err = t.register_at(FormatId(200), "General").unwrap_err();
quantbook-engine/crates/ql-storage/src/format.rs:319:        assert_eq!(FormatId::GENERAL, FormatId(0));
quantbook-engine/crates/ql-functions/Cargo.toml:14:# **W5-D-1 (Wave 3 distributions batch):** statrs ports IronCalc's
quantbook-engine/docs/audits/2026-05-13-w5-68-codex-dates-prompt.md:94:Doc proposes `cell.format_id: Option<FormatId>` + `Workbook::formats: IndexMap<String, FormatString>`. **Verify:**
quantbook-engine/docs/audits/2026-05-13-w5-68-codex-dates-prompt.md:97:2. `FormatId` storage cost — `Option<u32>` per cell adds 8 bytes. For 1M cells that's 8MB. Acceptable, but worth a perf note.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:395:    use ql_storage::FormatId;
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:444:        Some(FormatId(14)),
quantbook-engine/crates/ql-functions/tests/coverage.rs:383:    // W5-D-10 (Phase 4.10 — V1 260 closeout — error function family).
quantbook-engine/crates/ql-functions/tests/coverage.rs:388:        "W5-D-10; unit tests pin closed-form ERF(0)=0, ERF(1)≈0.84270, ERF(2)≈0.99532, odd-function property ERF(-x)=-ERF(x), large-x → 1 limit, 2-arg definite-integral form ERF(a,b)=ERF(b)-ERF(a), swap anti-symmetry, text/error/arity. VARIADIC 1-2 args.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:392:        "W5-D-10; **alias of ERF (1-arg form)** — Excel 2010 renamed for naming consistency. Pin alias parity at 6 x-values + strict 1-arg (rejects 2-arg integral form) + text/arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:396:        "W5-D-10; unit tests pin closed-form ERFC(0)=1, complement identity ERFC(x)+ERF(x)=1 across [-2, 3], ERFC(1)≈0.15730, large-positive → 0, large-negative → 2 (statrs stable rational approximation; no naive 1-erf(x) cancellation), text/error/arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:400:        "W5-D-10; **alias of ERFC** — Excel 2010 renamed for naming consistency. Pin alias parity at 6 x-values + arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:402:    // W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics).
quantbook-engine/crates/ql-functions/tests/coverage.rs:409:        "W5-D-11; unit tests pin Microsoft example (k=0.3 on {1..4} → 1.9), k=0 → min, k=1 → max, k=0.5 on odd count → median, unsorted-input parity, single-element early return, k<0 and k>1 → #NUM!, NaN k → #NUM! (panic-safety; W5-D-11.1 closure), empty → #NUM! (via all-Blank range), text in range → #VALUE! (engine-wide W5-58 strict convention; diverges from Microsoft skip-text canon), Blank in range skipped, error/text k propagation, Boolean k coerces TRUE→1/FALSE→0, arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:413:        "W5-D-11; unit tests pin Microsoft example (k=0.25 on {1..4} → 1.25), k at lower bound 1/(n+1) → min, k at upper bound n/(n+1) → max, k below 1/(n+1) or above n/(n+1) → #NUM! (Excel exclusive-bounds canon), k=0 and k=1 rejected, NaN k → #NUM! (panic-safety; W5-D-11.1 closure), unsorted-input parity, n=1 single-point valid range, empty → #NUM!, text in range → #VALUE! (W5-58 strict), Blank in range skipped (W5-D-11.1 closure), Boolean k coerces TRUE→1/FALSE→0 (both fall outside EXC bounds → #NUM!), text/error k propagation, arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:417:        "W5-D-11; **legacy alias of PERCENTILE.INC** (Excel 2010+ canon — same shared kernel, registered separately for name-equivalence). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:421:        "W5-D-11; unit tests pin q=0 → min, q=2 → median (sample {1..8} → 4.5), q=4 → max, algebraic equivalence with PERCENTILE.INC(arr, q/4) for q in {0..4}, q truncates toward zero per Microsoft TRUNC canon (2.9 → 2; W5-D-11.1: q=-0.5/-0.99 → minimum, q=-1.01 → #NUM!), q<0 or q>4 (post-truncation) → #NUM!, NaN q → #NUM! (W5-D-11.1 Codex MEDIUM-001 closure: prevents saturating NaN→0 cast bypassing bound check), empty → #NUM!, text in range → #VALUE! (W5-58 strict), text/error q propagation, arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:425:        "W5-D-11; unit tests pin Microsoft example (q=2 on {1,2,4,7,8,9,10,12} → 7.5), algebraic equivalence with PERCENTILE.EXC(arr, q/4) for q in {1,2,3}, q=0 and q=4 → #NUM! (Microsoft canon), small-array exclusive-bounds propagation (n=2: q=1 and q=3 → #NUM!), NaN q → #NUM! (W5-D-11.1 closure), empty → #NUM!, text in range → #VALUE! (W5-58 strict), text/error q propagation, arity.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:429:        "W5-D-11; **legacy alias of QUARTILE.INC** (Excel 2010+ canon — same shared kernel, registered separately). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test.",
quantbook-engine/crates/ql-functions/tests/coverage.rs:431:    // W5-D-12 (Phase 4.10 — V1 260 sealer) — SUBTOTAL: conditional
quantbook-engine/crates/ql-functions/tests/coverage.rs:435:        "W5-D-12; conditional aggregate dispatcher routing function_num ∈ {1..=11, 101..=111} to AVERAGE/COUNT/COUNTA/MAX/MIN/PRODUCT/STDEV.S/STDEV.P/SUM/VAR.S/VAR.P. Unit tests pin: all 11 function_num routes against textbook anchors (STDEV.S of {2,4,4,4,5,5,7,9} = sqrt(32/7) ≈ 2.138; STDEV.P of same = 2.0; VAR.S = 32/7; VAR.P = 4.0); 101 and 109 normalize to 1 and 9 respectively (v1 has no hidden-row metadata); fractional function_num truncates toward zero (9.7 → 9; 9.99 → 9; 0.5 → invalid); function_num ∉ {1..=11, 101..=111} → #VALUE! (0, 12, 100, 112, -1 covered); NaN function_num → #NUM! (error-code consistency per W5-D-11.1 pattern, NOT panic-safety since Rust ≥1.45 saturating cast is already panic-safe); text function_num → #VALUE! (including parseable `\"9\"` — engine W5-58 strict diverges from IronCalc lenient `cast_to_number` parse); error function_num propagates; Boolean function_num coerces (TRUE → 1 = AVG; FALSE → 0 = invalid) — matches IronCalc, diverges from Excel which rejects Boolean function_num; multiple ranges concatenate; scalar data args supported; COUNTA counts errors in range; COUNT skips errors in range; error in data range propagates via dispatched kernel (SUM/AVG path); empty numeric data for AVERAGE → #DIV/0!; arity. **v1 divergences** documented in module block: (1) 101..=111 normalize to 1..=11 because engine has no hidden-row metadata; (2) nested SUBTOTAL calls in arg ranges are NOT skipped (engine evaluates args before dispatch — AST not available). **W5-D-12.1 binder admission (PARTIAL — not a full literal-range lift):** added to `is_aggregate_function` so NAMED-RANGE args (`SUBTOTAL(9, SalesRange)`) bind through `AggregateNameRef`; literal range refs (`SUBTOTAL(9, A1:A10)`) remain unbindable per the engine-wide `AggregateArg`-side deferral at `plan.rs:706-731` (same gap affects standalone `SUM(A1:A10)` — NOT SUBTOTAL-specific). e2e tests cover scalar-args (`SUBTOTAL(9, 1, 2, 3)`) + 109-normalizes (`SUBTOTAL(109, 10, 20, 30)`) + invalid-fn-num (`SUBTOTAL(12, ...)`) through the real binder + dispatcher. Invariant pinned in `workbook_runtime.rs::is_aggregate_function_lists_only_registered_aggregates`. **W5-D-12.1 (Opus HIGH-002 closure) inherited-divergence notes** from dispatched scalar aggregates: (a) text in data → #VALUE! engine vs skip IronCalc/Excel; (b) Boolean in data → coerced 1/0 engine vs skip IronCalc/Excel; (c) Blank scalar in data → skipped engine vs pushed-as-0.0 IronCalc (affects PRODUCT); (d) PRODUCT of empty → 0 engine vs 1.0 IronCalc multiplicative identity. IronCalc reference: `.references/ironcalc/base/src/functions/subtotal.rs` (line-by-line dispatch shape matches; only row-visibility + nested-skip + data-coercion semantics differ).",
quantbook-engine/crates/ql-functions/tests/coverage.rs:788:    // W5-D-1 (Wave 3 distributions batch — normal). NORM.DIST / NORM.S.DIST
quantbook-engine/crates/ql-functions/tests/coverage.rs:797:        "distribution fn (W5-D-1) — covered by distribution_fns unit \
quantbook-engine/crates/ql-functions/tests/coverage.rs:805:        "distribution fn (W5-D-1) — covered by distribution_fns unit \
quantbook-engine/crates/ql-functions/tests/coverage.rs:811:        "distribution fn (W5-D-1) — covered by distribution_fns unit \
quantbook-engine/crates/ql-functions/tests/coverage.rs:818:        "distribution fn (W5-D-1) — covered by distribution_fns unit \
quantbook-engine/crates/ql-functions/tests/coverage.rs:824:    // statrs::StudentsT backing. Same coverage shape as W5-D-1: per-fn
quantbook-engine/crates/ql-functions/tests/coverage.rs:870:    // coverage shape as W5-D-1 / W5-D-2: per-fn unit tests + e2e
quantbook-engine/crates/ql-functions/tests/coverage.rs:1035:    // CONFIDENCE.* reuses W5-D-1/W5-D-2 helpers. Per-fn ≥8 tests.
quantbook-engine/crates/ql-functions/tests/coverage.rs:1100:         Reuses W5-D-1 standard_normal helper.",
quantbook-engine/crates/ql-functions/src/range_fns.rs:1651:// ===== W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics) =====
quantbook-engine/crates/ql-functions/src/range_fns.rs:1660:// algorithm. **W5-D-11.1 (Opus LOW-4 closure):** anchor values cross-
quantbook-engine/crates/ql-functions/src/range_fns.rs:1666:// reference Opus verified during the W5-D-11 audit.)
quantbook-engine/crates/ql-functions/src/range_fns.rs:1690:/// last. **W5-D-11.1 (Opus LOW-6 closure):** NaN can't reach the **data
quantbook-engine/crates/ql-functions/src/range_fns.rs:1762:/// **W5-D-11.1 (Codex MEDIUM-001 closure):** NaN `quart` must be
quantbook-engine/crates/ql-functions/src/range_fns.rs:1903:// ===== W5-D-12 (Phase 4.10 — V1 260 sealer — SUBTOTAL) =====
quantbook-engine/crates/ql-functions/src/range_fns.rs:1929:// **W5-D-12.1 (binder admission — partial; NOT a full literal-range
quantbook-engine/crates/ql-functions/src/range_fns.rs:1948://   W5-D-11.1 `extract_quartile_q`).
quantbook-engine/crates/ql-functions/src/range_fns.rs:1953:// **W5-D-12.1 (Opus HIGH-002 closure) — engine-IronCalc/Excel
quantbook-engine/crates/ql-functions/src/range_fns.rs:1975:/// dispatcher. See module-level W5-D-12 block for the canon discussion
quantbook-engine/crates/ql-functions/src/range_fns.rs:4686:    // === W5-D-11 (Phase 4.10 — V1 260 closeout — order statistics) ===
quantbook-engine/crates/ql-functions/src/range_fns.rs:4699:        // → 1 + 0.9*(2-1) = 1.9. (**W5-D-11.1 (Opus LOW-3 closure):**
quantbook-engine/crates/ql-functions/src/range_fns.rs:4979:    // ---- W5-D-11.1 closures: extra PERCENTILE.EXC scalar-arg pins
quantbook-engine/crates/ql-functions/src/range_fns.rs:5189:    // ---- W5-D-11.1 closures: QUARTILE.INC scalar-arg pins
quantbook-engine/crates/ql-functions/src/range_fns.rs:5392:    // ---- W5-D-11.1 closures: QUARTILE.EXC scalar-arg pins
quantbook-engine/crates/ql-functions/src/range_fns.rs:5430:    // === W5-D-12 (Phase 4.10 — V1 260 sealer — SUBTOTAL) ===
quantbook-engine/crates/ql-functions/src/range_fns.rs:5622:        // **W5-D-12.1 (Opus LOW-002 closure):** the `is_nan()` guard
quantbook-engine/crates/ql-functions/src/range_fns.rs:5628:        // established by `extract_quartile_q` (W5-D-11.1 Codex
quantbook-engine/crates/ql-functions/src/range_fns.rs:5640:        // **W5-D-12.1 (Opus MEDIUM-002 closure):** IronCalc lenient-
quantbook-engine/crates/ql-functions/src/range_fns.rs:5652:        // **W5-D-12.1 (Opus MEDIUM-003 closure):** COUNTA counts errors
quantbook-engine/crates/ql-functions/src/range_fns.rs:5665:        // **W5-D-12.1 (Opus MEDIUM-003 closure):** dual pin —
quantbook-engine/crates/ql-functions/src/range_fns.rs:5717:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-4 closure):**
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:695:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-002 / Opus
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2150:        // **W5-D-13.1 megaudit closure**: prior comment claimed ATAN2
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2153:        // W5-D-13.1 letters>3+digit Ident-fallback now makes ATAN2,
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2166:        // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Codex HIGH-002 / Opus
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2193:        // **W5-D-13.1 closure:** SUMXMY2 has 6-letter prefix — also
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2214:        // **W5-D-13.1 closure:** DAYS360 has 4-letter prefix `DAYS`
quantbook-engine/crates/ql-formula-syntax/src/lexer.rs:2226:        // **W5-D-13.1 closure guard:** `$ATAN2` has the leading-$
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:120:    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:126:    UnknownFormatId(u32),
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:554:    // **W5-D-10 (Phase 4.10 — V1 260 closeout):** end-to-end dispatch
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:574:    // letter-leading dotted-ident path). **W5-D-10.1 (Codex LOW +
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:704:    // **W5-D-11 (Phase 4.10 — V1 260 closeout):** smoke-check registry
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:713:    //    2010+ canon). **W5-D-11.1 (Codex LOW-001 closure):**
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:769:    // **W5-D-12 (Phase 4.10 — V1 260 sealer):** smoke-check registry
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:781:    // **W5-D-12.1 (Codex HIGH-001 closure):** prove SUBTOTAL actually
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:795:    // **W5-D-12.1 (Codex HIGH-001 closure):** verify the 101..=111
quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs:807:    // **W5-D-12.1 (Codex HIGH-001 closure):** invalid function_num →
quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs:1://! **W5-D-1.1 (Opus MEDIUM-O-1 closure):** end-to-end dispatch tests
quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs:144:    // **W5-D-1.1 (Opus HIGH-O-1 closure):** arity mismatch returns
quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs:154:// Same shape as W5-D-1 e2e tests: confirm the dotted-name parser
quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs:604:    // **W5-D-13.1 (Phase 4.10 V1-260 megaudit Opus MEDIUM-2 closure):**
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closing-megaudit-codex.md:3013:   388	/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:499:docs/phase5/entry-plan.md:3:status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; Phase 5.2.b PeerId → LoroDoc wiring SHIPPED (`ef056f50bee`); D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:505:docs/phase5/entry-plan.md:104:| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:506:docs/phase5/entry-plan.md:105:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:510:docs/audits/2026-05-17-w5-d-5-opus.md:33:Pattern prediction: W5-D-1=2H/9M/10L, W5-D-2=0H/3M/6L, W5-D-3=0H/3M/6L, W5-D-4=1H/3M/5L. Expected for W5-D-5 (all-continuous, mature variadic + parameterization-conversion harness): 0H, 2-4M, 3-6L. Result lands at 0H/2M/6L — at the low end of the predicted band, consistent with the pattern that later batches inherit better infrastructure from earlier audit closures.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:511:docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:513:docs/audits/2026-05-17-w5-d-5-opus.md:153:10. **Reuse of `standard_normal()` (W5-D-1) and `students_t_with` (W5-D-2)**: confidence_norm line 1718, confidence_t line 1759. Pure reuse — no duplicated dist construction. `.expect()` invariants in the constructor helpers hold (α=0.05 well within (0,1), df=size-1 >= 1 from size.trunc()>=2 pre-check).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:544:docs/audits/2026-05-19-phase-5-1-consolidated.md:168:   - 4 post-audit decisions added (D-1 format-id, D-2 add-
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:546:docs/audits/2026-05-19-phase-5-1-consolidated.md:189:2. The 4 audit-locked design decisions (D-1 through D-4) must
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:575:docs/audits/2026-05-17-w5-d-1-codex.md:60:Severity rationale: Runtime behavior is correct, but the misleading comments are exactly where future distribution ports will look for precedent. This can cause regressions toward IronCalc's stricter Boolean behavior or incorrect error-class assumptions.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:582:docs/audits/2026-05-19-phase-5-2-b-opus.md:63:Net: the wiring itself is sound. Bulk of issues are documentation/test-coverage-strength concerns, not correctness bugs. MED-1 + MED-2 + MED-3 are the highest-leverage fixes.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:612:docs/audits/2026-05-18-w5-d-14-2-opus.md:50:- Why it matters: in v1 NewWorkbook mode, umya never emits any of these three elements pre-injection, so Case 1 never fires — empirically safe. But it's a latent corruption bomb: any future refactor that has umya emit `<numFmts>`/`<definedNames>`/`<tableParts>` (e.g., adopting a newer umya version that handles custom formats natively, or extending to UpdateOriginal with sheet-xml surgery) will silently produce invalid xlsx files.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:613:docs/audits/2026-05-18-w5-d-14-2-opus.md:79:- What's wrong: classify_part returns `DropSilently` for `xl/calcChain.xml`, so `preserved_part_paths` doesn't include it. The merge logic at line 303 (`if !preserved_set.contains(normalised.as_str()) { continue; }`) skips it correctly. **No defect today.** Flagging because the design conflates "preserved" with "Content_Types-merged" — future divergence (e.g. someone adds a part that needs DropSilently but its Override should still be carried) requires both lists.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:614:docs/audits/2026-05-18-w5-d-14-2-opus.md:123:- The function uses `existing_names` to decide whether to emit a fresh sheet-rels file. If a future change extends post-process to add entries to `existing_names` after the read but before the rels emission, the dedup could miss. Minor maintenance concern.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:615:docs/audits/2026-05-18-w5-d-14-2-opus.md:143:- Only checks `xl/theme/*` PREFIX presence. Doesn't compare bytes. Missing the H-1 regression because the assertion is too lenient.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:626:docs/audits/2026-05-19-handoff-audit-codex.md:452:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:654:docs/audits/2026-05-19-handoff-audit-codex.md:1817:docs/phase5/entry-plan.md:3:status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:691:docs/audits/2026-05-19-handoff-audit-codex.md:3332:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:703:docs/audits/2026-05-19-handoff-audit-codex.md:4147:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:707:docs/audits/2026-05-19-handoff-audit-codex.md:4172:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:711:docs/audits/2026-05-17-w5-d-11-opus.md:53:4. **No NaN-k pin for either.** While my compiled probe confirmed both kernels reject NaN k via `(0..=1).contains(&NaN) == false` and the engine's `to_number_strict_skip_blank` already maps NaN-bypassing `Value::Number(NaN)` to `#NUM!` upstream, **the test suite does not pin the NaN-k behavior**. Pinning it would harden the implementation against a future refactor that bypasses the `(range).contains` rejection (e.g. if someone re-orders the checks).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:712:docs/audits/2026-05-17-w5-d-11-opus.md:57:**Severity rationale:** No correctness bug — the behavior is correct under the current code path. But the missing pins mean a future refactor could silently change behavior without test failure. NaN-k in particular: a refactor that moves the bound check below the `pos.floor() as usize` cast (which is `0` for NaN, not a panic in safe-cast Rust) would silently return `sorted[0]` instead of `#NUM!` — a real correctness regression that would slip through.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:713:docs/audits/2026-05-17-w5-d-11-opus.md:65:**Detail:** Per Codex's documentation review (citing Microsoft TRUNC + QUARTILE.INC docs), Excel truncates a fractional `quart` argument toward zero (TRUNC, not FLOOR). The current implementation uses `n.trunc() as i64` — **correct per Microsoft canon**. But the test suite only pins the positive-fractional case (`quartile_inc_q_truncates_toward_zero`: 2.9 → 2). The negative-fractional case (e.g. `quartile_inc(arr, -0.5)` should return the minimum, NOT `#NUM!`) is NOT pinned. A naive future refactor to `n.floor() as i64` (a plausible misreading of "truncated") would silently change behavior on a sliver of input space without test failure.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:714:docs/audits/2026-05-17-w5-d-11-opus.md:80:**Severity rationale:** Pure test-coverage gap. The code is correct per Microsoft canon (verified via Codex consultation of Microsoft TRUNC doc). LOW because no behavioral bug — but worth pinning to defend against a future TRUNC→FLOOR refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:715:docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:716:docs/audits/2026-05-17-w5-d-11-opus.md:174:**Severity rationale:** Doc precision; no functional impact. Flagged because future maintainers might rely on the "NaN can't reach here" guarantee in a refactor.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:717:docs/audits/2026-05-17-w5-d-11-opus.md:196:LOW-5 (sort_asc consolidation) is out of scope — defer to a future polish pass.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:787:docs/audits/2026-05-18-w5-d-15-opus.md:50:  future entries"). This is REAL application state. After the W5-D-15
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:788:docs/audits/2026-05-18-w5-d-15-opus.md:174:  placeholder sheets for future content). For these, every format
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:789:docs/audits/2026-05-18-w5-d-15-opus.md:361:  short-circuit so future maintainers don't get confused.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:790:docs/audits/2026-05-18-w5-d-15-opus.md:373:  works. But there's no test asserting it. A future change to
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:791:docs/audits/2026-05-18-w5-d-15-opus.md:459:  future emitter changes.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:792:docs/audits/2026-05-17-w5-d-10-opus.md:53:### LOW-3 — Cosmetic: e2e comment overclaims W5-D-2 lexer involvement for `ERF.PRECISE`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:793:docs/audits/2026-05-17-w5-d-10-opus.md:57:> PRECISE aliases (dotted names work through the W5-D-2 digit-leading-segment lexer + the regular dotted-ident path)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:794:docs/audits/2026-05-17-w5-d-10-opus.md:59:`ERF.PRECISE` and `ERFC.PRECISE` do **not** have a digit-leading segment; both pre/post-dot segments are pure alpha. The dotted-ident path alone suffices; the W5-D-2 digit-leading extension is unrelated for these names. The test still validates the right thing (case-insensitive dotted dispatch) — the framing is just slightly imprecise. Tighten the comment to:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:831:docs/audits/2026-05-17-reference-tier-audit-summary.md:139:| Misc MEDIUMs (ROW(1×3) test, walker doc, matrix counts, args.len()!=1 boundary, Range.values dead, design § 5.6 shape() drift) | — | MED-1/3/4/6/8/9 | **LOW** | Reconciled down — doc-only or unreachable-today concerns. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:906:docs/audits/2026-05-17-w5-d-1-opus.md:94:**Impact:** Behavioral inconsistency with the port source (IronCalc) **on the most-used arg type** (Boolean in numeric position). When IronCalc fixtures are eventually built to cross-check NORM.* — which is the natural next step for Wave 3 cohort-wide regression testing — they will diverge silently OR force re-port. Catching the divergence in documentation NOW means the future fixture-author knows where to expect deltas.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:907:docs/audits/2026-05-17-w5-d-1-opus.md:183:**Recommendation:** soften the claim to: "the underlying distribution math reduces to identical `statrs::Normal::{pdf,cdf,inverse_cdf}` calls for any pair of inputs that successfully coerce to the same f64 — coercion divergences (see HIGH-O-2) are the only behavioral delta." This is the truth and matches what a future maintainer needs to know.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:908:docs/audits/2026-05-17-w5-d-1-opus.md:281:1. **Dead code is hidden complexity.** A future reader sees `match standard_normal() { Ok(d) => d, Err(e) => return Value::Error(e) }` and wonders under what circumstances `standard_normal()` can fail. The answer is "never in this codebase" — that fact should be visible.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:909:docs/audits/2026-05-17-w5-d-1-opus.md:286:(a) **Document explicitly that this path is defensive / dead.** Add a comment above each `match normal_with(...)` saying: "Defensive: Normal::new can fail on NaN mean / Inf-NaN sd, both excluded by upstream sanitize_f64 + the sd > 0 check. The map_err is unreachable but kept to match IronCalc's structure and to fail loudly if a future refactor weakens the upstream guards."
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:910:docs/audits/2026-05-17-w5-d-1-opus.md:288:(b) **Replace with `.expect()`** to assert the invariant explicitly. `let dist = normal_with(mean, sd).expect("upstream sanitize_f64 + sd>0 check guarantees Normal::new succeeds");` makes the invariant load-bearing. If a future refactor breaks it, the panic surfaces in the test suite immediately rather than silently returning `#NUM!` for an unintended path.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:911:docs/audits/2026-05-17-w5-d-1-opus.md:314:This is correct (Excel: NORM.INV(0, ...) → #NUM!; NORM.INV(1, ...) → #NUM!). But the comment in tests doesn't make explicit why we reject the closed-interval endpoints that statrs allows. The risk is: if a future refactor weakens our pre-check from `<=` / `>=` to `<` / `>` (allowing `p == 0.0` / `p == 1.0` through), the test would then call `dist.inverse_cdf(0.0)` which returns `-Infinity` (not panic actually — let me re-read). statrs's source `if !(0.0..=1.0).contains(&x)` → for `x = 0.0`, `0.0..=1.0` DOES contain 0.0, so no panic. Compute: `erfc_inv(0)` = `+inf`. `mean - (sd * sqrt(2) * inf)` = `-inf`. Then `finite_or_num(-inf) → #NUM!`. So weakening our pre-check to `<` / `>` would still produce `#NUM!` from the finite-check at the end — but for the wrong reason (statrs returning `±inf` rather than us rejecting at the gate). The test would still pass with `Value::Error(ErrorValue::Num)`, but the failure mode would have shifted from "domain check" to "post-hoc Inf-filter."
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:912:docs/audits/2026-05-17-w5-d-1-opus.md:380:**Severity rationale:** MEDIUM. Not a bug, but the safety net `finite_or_num` exists specifically for this case and is never invoked by any test. Pinning the boundary tells future maintainers that the contract is "finite or #NUM!, no Inf leaks."
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:913:docs/audits/2026-05-17-w5-d-1-opus.md:388:**Detail:** We ported the first 4 functions from IronCalc's `normal.rs` (NORM.DIST, NORM.S.DIST, NORM.INV, NORM.S.INV) and left out the other 2 (CONFIDENCE.NORM, CONFIDENCE.T). The matrix doesn't track them as deferred. The audit prompt explicitly asks (Item 20) to verify they're tracked as future work.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:914:docs/audits/2026-05-17-w5-d-1-opus.md:408:### MEDIUM-O-9 — Module docstring lists future fns ("T.* / CHISQ.* / F.* / BINOM.* / POISSON.* / GAMMA.* / BETA.*") but doesn't mention statrs's actual capability surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:915:docs/audits/2026-05-17-w5-d-1-opus.md:412:**Detail:** Both the workspace Cargo.toml comment and the module docstring promise that the statrs dep enables the future distributions:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:916:docs/audits/2026-05-17-w5-d-1-opus.md:428:However, this is **not load-bearingly documented**. A future statrs upgrade (0.19.0+) might gate, say, `GAMMA` or `BETA` behind a feature, and our `default-features = false` would silently strip it. The Cargo.toml comment claims the dep enables those fns; that promise has no test.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:917:docs/audits/2026-05-17-w5-d-1-opus.md:430:**Recommendation:** either (a) add explicit feature opt-ins as IronCalc does (`features = []` — explicit, not just default-stripped), making it obvious if statrs ever gates a distribution; or (b) add a comment noting that statrs 0.18.0 does not gate distributions and a future upgrade MUST re-verify the surface before claiming a Wave 3 distribution is enabled. IronCalc uses `features = []` explicitly:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1023:docs/audits/2026-05-17-w5-d-10-codex.md:23:comment says the aliases exercise the W5-D-2 digit-leading-segment lexer path.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1024:docs/audits/2026-05-17-w5-d-10-codex.md:30:W5-D-2 digit-leading reference.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1025:docs/audits/2026-05-17-w5-d-10-codex.md:32:Severity rationale: Documentation/test-comment only. It can mislead future
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1063:docs/audits/2026-05-17-w5-d-12-opus.md:88:- **Detail:** The engine coerces `Boolean(true)` → 1 → AVERAGE and `Boolean(false)` → 0 → #VALUE!. This matches IronCalc (`cast.rs::cast_to_number` lines 155-161: `CalcResult::Boolean(f) => if f { Ok(1.0) } else { Ok(0.0) }`). But **Excel's own canon rejects Boolean function_num: `=SUBTOTAL(TRUE, A1:A4)` returns #VALUE! in Excel.** The engine matches IronCalc here, not Excel. This is fine, but **the coverage entry does not flag this as an Excel divergence**, while it's pinned by a test that locks in the IronCalc-equivalent behavior. A future Excel-canon enforcement pass would need to break this test.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1064:docs/audits/2026-05-17-w5-d-12-opus.md:104:- **Detail:** Both engine `scalar_fns::counta` and IronCalc `subtotal_counta` count errors (engine: `!matches!(v, Value::Blank).count()` includes Error; IronCalc: `String | Number | Boolean | Error => counta += 1`). Behavior matches. **However**, this is NOT pinned by any SUBTOTAL test — the `subtotal_counta_function_num_3` test only covers `[1, "skip", 2, blank, 3]` (no error). A future refactor of `scalar_fns::counta` to skip errors would silently break compatibility with IronCalc + Excel canon (Excel COUNTA does count errors) and the engine-wide aggregate convention. Probe-verified: `SUBTOTAL(3, [1, #DIV/0!, 3]) = ?`. **Not tested** in the new SUBTOTAL block (probe-confirmed = 3.0 — passes through to counta which counts the error).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1065:docs/audits/2026-05-18-w5-d-14-codex.md:293:**Subject:** Comments path prefix can overmatch future comment-related parts
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1144:docs/audits/2026-05-17-w5-d-11-codex.md:25:Subject: E2E alias-parity test only checks presence
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1145:docs/audits/2026-05-17-w5-d-11-codex.md:29:Detail: The test comment says it verifies that `PERCENTILE` registers to the same function as `PERCENTILE.INC` and `QUARTILE` registers to `QUARTILE.INC`, but the assertions at lines 716-729 only check `lookup_range_aware(...).is_some()`. A future regression that mapped `PERCENTILE` to `percentile_exc` or `QUARTILE` to `quartile_exc` would still pass this e2e test as long as all six names remained registered.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1274:docs/audits/2026-05-17-w5-d-3-opus.md:140:misses the opportunity to actually verify F-pdf math. The W5-D-1/W5-D-2
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1277:docs/audits/2026-05-17-w5-d-3-opus.md:244:This is a **consistent gap from W5-D-1 / W5-D-2** (same pattern there).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1279:docs/audits/2026-05-17-w5-d-3-opus.md:255:prior W5-D-1/W5-D-2 batches' choices. Listing for trend visibility,
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1285:docs/audits/2026-05-17-w5-d-3-opus.md:427:  5_10`). Consistent with W5-D-1 / W5-D-2.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1290:docs/audits/2026-05-18-w5-d-15-codex.md:161:`Style::default()`. But this is a sharp edge: any future row/column/cell
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1337:docs/audits/2026-05-18-w5-d-14-2-self.md:181:  (`update_original.rs:163-171`) is uncovered by tests. If a future
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1429:docs/audits/2026-05-17-w5-d-12-codex.md:47:**Severity rationale:** Documentation-only drift, but it can mislead future audits of the function_num 7/8 dispatch table.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1437:docs/audits/2026-05-17-w5-d-2-opus.md:5:HEAD before W5-D-2: `b7b4682a666` (W5-D-1.1 audit transcripts).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1443:docs/audits/2026-05-17-w5-d-2-opus.md:60:The W5-D-1.1 closure for HIGH-O-2 (per the docstring at line 41-61) explicitly added an "IronCalc divergences" table at module level — establishing the pattern that *module-level canon docs are first-class*. W5-D-2 didn't follow this pattern.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1446:docs/audits/2026-05-17-w5-d-2-opus.md:75:Detail: The "Arg coercion" section says numeric args are coerced via `to_number_strict`, the `cumulative` flag via `to_logical`, and arity → `#VALUE!`. This was written for W5-D-1 NORM.* fns; it happens to also apply verbatim to W5-D-2 T.* fns. But:
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1448:docs/audits/2026-05-17-w5-d-2-opus.md:93:Detail: The W5-D-1 NORM.* pattern for arity tests covers both under- and over-arity (e.g., `norm_s_dist_arity_mismatch_returns_value` at line 596 tests `[Value::number(0.0)]` AND `[Value::number(0.0), Value::Boolean(true), Value::number(1.0)]` — both 1-arg and 3-arg). T.DIST.2T and T.INV.2T arity tests in W5-D-2 follow this pattern (each has 3 sub-asserts including the over case). T.DIST, T.DIST.RT, and T.INV only test the under case.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1449:docs/audits/2026-05-17-w5-d-2-opus.md:171:- **Registry count 209** verified — `default_registry_has_expected_count` test passes. The count comment at registry.rs:921-927 correctly accounts for W5-D-1 (+4) + W5-D-2 (+5) = +9 over the 200 pre-W5-D-1 baseline.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1465:docs/audits/2026-05-19-phase-5-2-b-codex.md:3612:docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1496:docs/audits/2026-05-19-phase-5-2-b-codex.md:4483:docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1509:docs/audits/2026-05-19-phase-5-2-b-codex.md:5059:-*label* (used in presence and FormatId D-1), not a Loro merge-rule
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1529:docs/audits/2026-05-18-w5-d-14-opus.md:565:**Recommendation:** If future work needs byte-identical exports, sort formulas
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1530:docs/audits/2026-05-18-w5-d-14-opus.md:592:canonical, but formulas stored by direct callers (tests, future op-log
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1617:docs/audits/2026-05-18-w5-d-15-self.md:23:  the column empty for future data entry. The format is real
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1618:docs/audits/2026-05-18-w5-d-15-self.md:99:  block, so case-2 never fires today. A future refactor (e.g.,
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1619:docs/audits/2026-05-18-w5-d-15-self.md:129:  no test asserts this — a future change to UpdateOriginal that
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1630:docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:420:1. **Math kernel correctness**: All 38 Wave 3 distribution fns and the 22 closeout-batch fns produce correct results on textbook anchors and degrade gracefully on degenerate inputs. The W5-D-1.1, W5-D-4.1, W5-D-5.1, W5-D-7.1, W5-D-8.1, W5-D-11.1, W5-D-12.1 closures all correctly addressed their per-batch audit findings at the code level.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1634:docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1717:docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1750:docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2269:    16	//! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2456:   465	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2556:    93	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2580:   117	    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2776:   104	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2777:   105	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2790:   118	> (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2873:    81	| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2875:    83	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:3001:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:74://! UUIDs, but cannot generate them. Depending on the kind of UUID you'd like to work with, there
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:3044:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/raw-cpuid-11.6.0/src/lib.rs:2498:               to signal the processor that an interrupt is pending and that the \
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:3045:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/raw-cpuid-11.6.0/src/lib.rs:2651:        /// Pending Break Enable. The processor supports the use of the FERR#/PBE# pin when the processor is in the stop-clock state (STPCLK# is asserted) to signal the processor that an interrupt is pending and that the processor should return to normal operation to handle the interrupt. Bit 10 (PBE enable) in the IA32_MISC_ENABLE MSR enables this capability.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:3731:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/scopeguard-1.2.0/src/lib.rs:71://! In this example, the scope guard owns a file and ensures pending writes are
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:3732:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/scopeguard-1.2.0/src/lib.rs:126://! fn insertion_sort_first<T>(v: &mut Vec<T>)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10483:/bin/zsh -lc "rg -n \"presence|Presence|5\\.6|FormatId|D-1|UUID|peer-IDs|Phase 5\\.6\" docs/architecture/crdt-data-model.md docs/phase5/entry-plan.md docs/known-gaps.md docs/MASTER-PLAN.md crates/ql-collab/src/peer.rs crates/ql-collab/src/lib.rs crates/ql-collab/src/presence.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10486:crates/ql-collab/src/peer.rs:16://! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10530:docs/phase5/entry-plan.md:3:status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; Phase 5.2.b PeerId → LoroDoc wiring SHIPPED (`ef056f50bee`); D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10532:docs/phase5/entry-plan.md:50:> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10533:docs/phase5/entry-plan.md:104:| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10534:docs/phase5/entry-plan.md:105:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10536:docs/phase5/entry-plan.md:118:> (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10537:docs/phase5/entry-plan.md:125:   needs magic bytes + version header (Tier D3). Bundle into D-1
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10538:docs/phase5/entry-plan.md:126:   tagged-tuple FormatId schema work (next session).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10539:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10540:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10556:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10558:docs/architecture/crdt-data-model.md:470:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10559:docs/architecture/crdt-data-model.md:474:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10560:docs/architecture/crdt-data-model.md:486:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10561:docs/architecture/crdt-data-model.md:491:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10565:docs/architecture/crdt-data-model.md:622:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10566:docs/architecture/crdt-data-model.md:623:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10569:docs/MASTER-PLAN.md:503:    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10570:docs/MASTER-PLAN.md:505:11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10571:docs/MASTER-PLAN.md:508:    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:1:# W5-D-10 Opus Audit: ERF / ERF.PRECISE / ERFC / ERFC.PRECISE
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:5:Scope: 5-file W5-D-10 commit (uncommitted at audit time). HEAD before: `89c2cb70806`.
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:10:W5-D-10 is **clean and ready to commit**. All 4 functions are mathematically correct, match IronCalc semantics exactly (`erf(y) - erf(x)` for the 2-arg form, strict 1-arg for the three other shapes), use the appropriate statrs API (separate `erf` / `erfc` — not naive `1 - erf(x)`), route through `finite_or_num` defense-in-depth, and propagate errors per the engine's documented coercion divergence (`to_number_strict` accepts Booleans, IronCalc rejects them — same as every other Wave 3 distribution).
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:95:Coercion divergence is the engine-wide one (`to_number_strict` accepts Boolean as 0/1; IronCalc's `get_number_no_bools` rejects). Already documented for every prior distribution function. Not new for W5-D-10.
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:121:- Module docstring: W5-D-10 entry added (W5-D-5 entry updated to remove the now-obsolete `(this commit, CLOSES Wave 3)` tag). ✓
quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:130:The W5-D-10 register block is inserted between W5-D-9 (base conversion) and Phase 4.10.D (W5-166 combinatorics). Out of chronological order with respect to the lower-W5-numbered block immediately below it, but registration order has no functional effect (hash map lookup), and the comment block clearly marks W5-D-10 as a Phase 4.10 V1-260 closeout entry. No issue.
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:24:use ql_storage::{FormatId, NamedTarget, Workbook};
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3234:crates/ql-io/src/qbook_format.rs:2515:            loaded.formats().lookup(ql_storage::FormatId(14)),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3237:crates/ql-io/src/qbook_format.rs:2545:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3239:crates/ql-io/src/qbook_format.rs:2635:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3240:crates/ql-io/src/qbook_format.rs:2641:                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3242:crates/ql-oplog/src/replay.rs:730:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3243:crates/ql-oplog/src/replay.rs:750:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3320:crates/ql-storage/src/lib.rs:55:        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3321:crates/ql-storage/src/lib.rs:56:        assert_eq!(wb.formats().lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3374:crates/ql-storage/src/format.rs:100:    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3375:crates/ql-storage/src/format.rs:207:        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3376:crates/ql-storage/src/format.rs:208:        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3377:crates/ql-storage/src/format.rs:209:        assert_eq!(t.lookup(FormatId(49)), Some("@"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3378:crates/ql-storage/src/format.rs:216:        assert_eq!(t.lookup(FormatId(12)), None);
quantbook-engine/docs/audits/2026-05-14-phase-4.7.B-codex-review.txt:3380:crates/ql-storage/src/format.rs:258:        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:30:| H-2 | `current_work.md` step 4 "first cycle = Tier D2" but D2 shipped | Opus + self | ✅ FIXED — step 4 now recommends Phase 5.2 D-1 |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:53:| D-1 | `FormatId` tagged tuple (Phase 5.2.b) | Phase 5.1 audit | Multi-day schema-breaking work; needs its own session + parallel Codex+Opus audit per discipline rule |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:54:| Tier D3 | `oplog.bin` magic bytes + version header | original v2 backlog | Codex correctly identifies this is still open; bundle into D-1 schema work (same wire-format-bump cycle) |
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:68:in the rewrite commit). It points cleanly at Phase 5.2 D-1 (FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:452:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1033:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1049:   448	**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1053:   452	pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1055:   454	    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1065:   464	  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1070:   469	  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1071:   470	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1201:   600	5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1202:   601	   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1203:   602	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1654:    14	//! - Phase 5 D-1 (deferred) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1817:docs/phase5/entry-plan.md:3:status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1900:docs/architecture/crdt-data-model.md:448:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1901:docs/architecture/crdt-data-model.md:454:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1919:docs/architecture/crdt-data-model.md:600:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1937:docs/MASTER-PLAN.md:503:    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1938:docs/MASTER-PLAN.md:505:11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1939:docs/MASTER-PLAN.md:508:    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2012:5a204a5be30 W5-D-14a / Phase 4.11 XLSX — calamine grid reader + recompute pipeline
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2013:f17af11d804 W5-D-1 / Engine Phase 4.11 — Wave 3 distributions batch (normal) + W5-D-1.1 audit closures
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2703:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2717:   446	**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2721:   450	pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2723:   452	    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2733:   462	  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2738:   467	  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2739:   468	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2863:   592	5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2864:   593	   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2865:   594	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3332:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3378:    49	> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3505:+> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3558:+> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3636:5a204a5be30 W5-D-14a / Phase 4.11 XLSX — calamine grid reader + recompute pipeline
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3637:f17af11d804 W5-D-1 / Engine Phase 4.11 — Wave 3 distributions batch (normal) + W5-D-1.1 audit closures
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:3833:    14	//! - Phase 5 D-1 (deferred) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4144:- HIGH, T1, `/home/sanzhar/.claude/.../memory/current_work.md:1` and `/home/sanzhar/.claude/.../MEMORY.md:1`: both requested handoff memory files are missing here; `~/.claude/projects` is also absent. Cannot verify frontmatter, first-5-minutes steps, or MEMORY index. Recreate/sync them and set current handoff to final HEAD `055bb7f3e0c`, tests `4160`, next cycle `Phase 5.2.b / D-1 FormatId tagged tuple + D3 oplog header/versioning`, not Tier D2.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4147:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4169:- HIGH, T1, `/home/sanzhar/.claude/.../memory/current_work.md:1` and `/home/sanzhar/.claude/.../MEMORY.md:1`: both requested handoff memory files are missing here; `~/.claude/projects` is also absent. Cannot verify frontmatter, first-5-minutes steps, or MEMORY index. Recreate/sync them and set current handoff to final HEAD `055bb7f3e0c`, tests `4160`, next cycle `Phase 5.2.b / D-1 FormatId tagged tuple + D3 oplog header/versioning`, not Tier D2.
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4172:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-13-w5-68-codex-dates-review.txt:41:7. **`FormatId` storage plan does not match existing storage shape.**  
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:1543:    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4106:crates/ql-io/src/qbook_format.rs:355:/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:4844:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5023:    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5029:    UnknownFormatId(u32),
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5176:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:5181:    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8045:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8054:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8064:        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8079:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8093:        id: Option<FormatId>,
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8101:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8130:    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8148:    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-14-phase-4.7-design-codex-review.txt:8167:            .unwrap_or(FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5372:        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5551:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:6286:docs/audits/.codex-w5-d-14-audit-prompt.md:51:- `src/read/tables_import.rs` — orchestrate table import.
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1711:crates/ql-storage/src/lib.rs:26:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1722:crates/ql-storage/src/format.rs:129:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:2980:crates/ql-exec/src/workbook_runtime.rs:41:use ql_storage::{FormatId, SpillShape, Workbook};
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7196:  1508	        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:7231:  1543	                    ql_storage::FormatId(entry.id),
quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:8065:  1470	                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
quantbook-engine/docs/audits/2026-05-17-w5-d-5-opus.md:33:Pattern prediction: W5-D-1=2H/9M/10L, W5-D-2=0H/3M/6L, W5-D-3=0H/3M/6L, W5-D-4=1H/3M/5L. Expected for W5-D-5 (all-continuous, mature variadic + parameterization-conversion harness): 0H, 2-4M, 3-6L. Result lands at 0H/2M/6L — at the low end of the predicted band, consistent with the pattern that later batches inherit better infrastructure from earlier audit closures.
quantbook-engine/docs/audits/2026-05-17-w5-d-5-opus.md:55:This is the same shape of doc-drift caught in earlier audits (W5-D-1 had a similar stale-deferred-row in the financial section). Recommending the implementing Opus do a final `grep -n "GAMMA\|GAMMALN" docs/compat/excel-matrix.md` after editing such rows in future batches.
quantbook-engine/docs/audits/2026-05-17-w5-d-5-opus.md:153:10. **Reuse of `standard_normal()` (W5-D-1) and `students_t_with` (W5-D-2)**: confidence_norm line 1718, confidence_t line 1759. Pure reuse — no duplicated dist construction. `.expect()` invariants in the constructor helpers hold (α=0.05 well within (0,1), df=size-1 >= 1 from size.trunc()>=2 pre-check).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:43:**Closure (design D-1):** `FormatId` switches to
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:44:`Builtin(u32) | Custom(PeerId, u32)` tagged tuple. Wire-
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:168:   - 4 post-audit decisions added (D-1 format-id, D-2 add-
quantbook-engine/docs/audits/2026-05-19-phase-5-1-consolidated.md:189:2. The 4 audit-locked design decisions (D-1 through D-4) must
quantbook-engine/docs/compat/excel-matrix.md:86:| PERCENTILE.INC | ✅ | 17 | 4.10 V1-260 (W5-D-11) | W5-D-11: k-th percentile, inclusive bounds. Range-aware; array sort + linear interpolation at position `k * (n − 1)`. Microsoft canon (k ∈ [0, 1]; out-of-range → #NUM!). Microsoft example anchor (k=0.3 on {1..4} → 1.9). Empty after coercion → #NUM! (matches LARGE/SMALL/MEDIAN). **Engine divergence**: Text values in range raise #VALUE! per the W5-58 strict convention; Microsoft canon skips text. Blanks skipped. NaN k → #NUM! (panic-safety pinned via W5-D-11.1 closure). IronCalc does NOT ship — original port. |
quantbook-engine/docs/compat/excel-matrix.md:87:| PERCENTILE.EXC | ✅ | 16 | 4.10 V1-260 (W5-D-11) | W5-D-11: k-th percentile, exclusive bounds. Position formula `k * (n + 1) − 1` with the additional Excel canon constraint `1/(n+1) ≤ k ≤ n/(n+1)` (else #NUM!). Microsoft anchor (k=0.25 on {1..4} → 1.25). For n=1 only k=0.5 is valid. Same engine-divergence on text → #VALUE! as PERCENTILE.INC. NaN k → #NUM!. Boolean k coerces (TRUE→1.0/FALSE→0.0; both fall outside EXC bounds for any n ≥ 1 → #NUM!). IronCalc does NOT ship — original port. |
quantbook-engine/docs/compat/excel-matrix.md:88:| PERCENTILE | ✅ | 1 | 4.10 V1-260 (W5-D-11) | W5-D-11: legacy alias of PERCENTILE.INC (Excel 2010+ convention — same shared kernel, registered separately for name-equivalence). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test, not just `is_some()`. |
quantbook-engine/docs/compat/excel-matrix.md:89:| QUARTILE.INC | ✅ | 15 | 4.10 V1-260 (W5-D-11) | W5-D-11: quartile via `PERCENTILE.INC(arr, q/4)` for q ∈ {0, 1, 2, 3, 4}. Truncates fractional `quart` toward zero per Microsoft TRUNC canon (verified against Microsoft TRUNC + QUARTILE.INC docs; pinned by W5-D-11.1 closure with q=-0.5 → minimum, q=-0.99 → minimum, q=-1.01 → #NUM!). q outside → #NUM!. NaN q → #NUM! (W5-D-11.1 Codex MEDIUM-001 closure: explicit guard prevents `NaN.trunc() as i64` saturating to 0). Algebraic equivalence with PERCENTILE.INC pinned. Same engine-divergence on text → #VALUE! as PERCENTILE.INC. IronCalc does NOT ship — original port. |
quantbook-engine/docs/compat/excel-matrix.md:90:| QUARTILE.EXC | ✅ | 12 | 4.10 V1-260 (W5-D-11) | W5-D-11: quartile via `PERCENTILE.EXC(arr, q/4)` for q ∈ {1, 2, 3}. q = 0 or q = 4 → #NUM! (Microsoft canon — use .INC for min/max). Microsoft anchor ({1,2,4,7,8,9,10,12} q=2 → 7.5). Small-array EXC-bound propagation pinned (n=2: q=1, q=3 → #NUM!). NaN q → #NUM!. Same engine-divergence on text → #VALUE! as PERCENTILE.EXC. IronCalc does NOT ship — original port. |
quantbook-engine/docs/compat/excel-matrix.md:91:| QUARTILE | ✅ | 1 | 4.10 V1-260 (W5-D-11) | W5-D-11: legacy alias of QUARTILE.INC (Excel 2010+ convention). **W5-D-11.1 (Codex LOW-001 closure):** alias-parity verified via fn-pointer address comparison in the W5-D-11 e2e dispatch test. |
quantbook-engine/docs/compat/excel-matrix.md:102:| NORM.DIST | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: normal PDF/CDF via `statrs::Normal` (pinned 0.18.0; matches IronCalc's pin). 4 args; `cumulative=TRUE` → CDF, `FALSE` → PDF. `sd <= 0` → `#NUM!`. Text args → `#VALUE!`. Error propagation. LibreOffice anchors pinned. |
quantbook-engine/docs/compat/excel-matrix.md:103:| NORM.S.DIST | ✅ | 8 | Wave 3 D-1 (W5-D-1) | W5-D-1: standard normal (mean=0, sd=1) PDF/CDF; 2 args. Same error semantics. LibreOffice Φ(z) anchors at z=0, 1, -2, 8 pinned. |
quantbook-engine/docs/compat/excel-matrix.md:104:| NORM.INV | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: inverse normal CDF; 3 args. `0 < prob < 1` strict; `sd > 0` strict. Else `#NUM!`. CI-upper anchor at p=0.975 (≈1.95996398) pinned; inverse-of-CDF round-trip verified. |
quantbook-engine/docs/compat/excel-matrix.md:105:| NORM.S.INV | ✅ | 9 | Wave 3 D-1 (W5-D-1) | W5-D-1: standard-normal inverse CDF; 1 arg. Same domain. |
quantbook-engine/docs/compat/excel-matrix.md:134:| CONFIDENCE.NORM | ✅ | 10 | Wave 3 D-5 (W5-D-5) | W5-D-5: normal-CI half-width `z(1-α/2)·σ/√n`. 3 args. `0 < α < 1` strict, `σ > 0`, `size.floor() ≥ 1`. Size uses `.floor()` (matches IronCalc). Reuses W5-D-1 `standard_normal()` helper. |
quantbook-engine/docs/compat/excel-matrix.md:177:| SIN / COS / TAN / ASIN / ACOS / ATAN / ATAN2 | ✅ | 13 | 4.3 V2 | W5-51; ATAN2 uses Excel `(x, y)` arg order (not Rust's `(y, x)`); ATAN2(0,0)→#DIV/0!; ASIN/ACOS domain `|x|>1`→#NUM!; TAN(π/2) returns huge-finite (Excel canon, not error). **W5-D-13.1 megaudit closure (Codex HIGH-002 / Opus HIGH-2):** ATAN2 was previously unreachable from formula source (`ATAN2(1,1)` lex-errored with `ColumnTooLarge("ATAN")` — 4-letter prefix exceeded the 3-letter column-ref limit). The W5-D-13.1 lexer letters>3+digit Ident-fallback now emits `Ident("ATAN2")` so the parser dispatches correctly. |
quantbook-engine/docs/compat/excel-matrix.md:191:| SUMX2MY2 / SUMX2PY2 / SUMXMY2 | ✅ | 9 | 4.10.D | W5-166: paired array sum-of-squares variants. RangeAwareFn; both args must be ranges; W5-60 strict 2D-shape check (shape mismatch → #VALUE!). Non-numeric cells coerce to 0 (lenient, matches IronCalc canon). Errors in either array propagate. **W5-D-13.1 megaudit closure (Codex HIGH-002 / Opus HIGH-2):** SUMXMY2 was previously unreachable from formula source (`SUMXMY2(...)` lex-errored with `ColumnTooLarge("SUMXMY")`). The W5-D-13.1 lexer letters>3+digit Ident-fallback fixed it. SUMX2MY2 / SUMX2PY2 were already reachable via the W5-D-9 letters-digits-letters extension. Also admitted to `is_aggregate_function` in W5-D-13.1 for named-range arg support. |
quantbook-engine/docs/compat/excel-matrix.md:193:| SUBTOTAL | ⚠️ | 31 | 4.10 V1-260 sealer (W5-D-12) | W5-D-12: conditional aggregate dispatcher. Range-aware; routes function_num ∈ {1..=11, 101..=111} to AVERAGE/COUNT/COUNTA/MAX/MIN/PRODUCT/STDEV.S/STDEV.P/SUM/VAR.S/VAR.P. **v1 divergences (documented)**: (1) 101..=111 normalize to 1..=11 because the engine has no hidden-row metadata; (2) nested SUBTOTAL calls in arg ranges are NOT skipped (engine evaluates args before dispatch — AST not available); (3) inherited from dispatched aggregates: text in data → #VALUE! (vs IronCalc/Excel skip); Boolean in data → coerced 1/0 (vs skip); Blank scalar → skipped (vs IronCalc push-as-0); PRODUCT of empty → 0 (vs 1.0 multiplicative identity). function_num truncates toward zero. NaN function_num → #NUM! (error-code consistency, not panic-safety). Boolean function_num coerces TRUE→1/FALSE→0 (IronCalc match, Excel-divergent). Text function_num always → #VALUE! (engine W5-58 strict, vs IronCalc lenient parse). **W5-D-12.1 binder admission is PARTIAL**: named-range args (`SUBTOTAL(9, SalesRange)`) work; literal range args (`SUBTOTAL(9, A1:A10)`) do NOT bind in v1 — same engine-wide `AggregateArg`-side deferral that affects standalone `SUM(A1:A10)`. Scalar args + named ranges supported. IronCalc reference: `subtotal.rs` line-by-line on dispatch shape; row-visibility + nested-skip + data-coercion semantics differ. **CLOSES Phase 4.10 V1-260 at 260 registered fns.** 🟡 = partial: numeric work shipped, literal-range-arg lift pending engine-wide. |
quantbook-engine/docs/compat/excel-matrix.md:231:| DATE / TIME / DATEVALUE / TIMEVALUE | ✅ | 125 | 4.5 (W5-75 + W5-76) | W5-D-13.1 matrix drift closure: all 4 registered via `register_context_aware` (date_fns module). 125 date/time unit tests cover the whole 4.5 family (this row + the next 5). |
quantbook-engine/docs/compat/excel-matrix.md:232:| YEAR / MONTH / DAY / HOUR / MINUTE / SECOND | ✅ | (see DATE row) | 4.5 (W5-75 + W5-76) | W5-D-13.1: all 6 registered; tests counted in DATE row. |
quantbook-engine/docs/compat/excel-matrix.md:233:| WEEKDAY / WEEKNUM / ISOWEEKNUM | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: all 3 registered; tests counted in DATE row. |
quantbook-engine/docs/compat/excel-matrix.md:234:| DAYS / DAYS360 / NETWORKDAYS / NETWORKDAYS.INTL | ⚠️ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: DAYS, DAYS360, NETWORKDAYS registered. **NETWORKDAYS.INTL not registered** (locale-aware variant — defer). DAYS360 was previously also blocked at lex time (4-letter prefix); W5-D-13.1 lexer Ident-fallback closure makes it reachable from source text. |
quantbook-engine/docs/compat/excel-matrix.md:235:| WORKDAY / WORKDAY.INTL | ⚠️ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: WORKDAY registered. **WORKDAY.INTL not registered** (locale-aware variant — defer). |
quantbook-engine/docs/compat/excel-matrix.md:236:| EDATE / EOMONTH | ✅ | (see DATE row) | 4.5 (W5-75) | W5-D-13.1: both registered; tests counted in DATE row. |
quantbook-engine/docs/compat/excel-matrix.md:237:| DATEDIF | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: registered. Excel-specific; leap-month edge cases covered in date_fns tests. |
quantbook-engine/docs/compat/excel-matrix.md:238:| YEARFRAC | ✅ | (see DATE row) | 4.5 V2 (W5-75) | W5-D-13.1: registered. Multiple day-count bases supported via the `basis` arg. |
quantbook-engine/docs/compat/excel-matrix.md:258:| TRANSPOSE | ✅ | 12 | 4.7.N (W5-107) | W5-D-13.1 matrix drift closure: registered via `register_unified` (array-returning Unified-ABI). Returns array; spills via the cell-boundary write_spill path. Admitted to `is_aggregate_function` since W5-107 for named-range/Range arg support. |
quantbook-engine/docs/compat/excel-matrix.md:328:| ERF | ✅ | 10 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: Gauss error function via `statrs::function::erf::erf`. VARIADIC 1-2 args. With 1 arg: returns `erf(x)`; 2 args: definite-integral `erf(b) - erf(a)`. Closed-form anchors: `ERF(0)=0`, `ERF(1)≈0.84270`, `ERF(2)≈0.99532`. Odd-function symmetry pinned. |
quantbook-engine/docs/compat/excel-matrix.md:329:| ERF.PRECISE | ✅ | 4 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: alias of ERF (1-arg form). Excel 2010 PRECISE variant. Pin alias parity at 6 x-values. Rejects 2-arg form. |
quantbook-engine/docs/compat/excel-matrix.md:330:| ERFC | ✅ | 8 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: complementary error function via `statrs::function::erf::erfc`. `ERFC(x) = 1 - ERF(x)` identity pinned. statrs uses stable rational approximation (no cancellation at large positive x). |
quantbook-engine/docs/compat/excel-matrix.md:331:| ERFC.PRECISE | ✅ | 2 | 4.10 V1-260 closeout (W5-D-10) | W5-D-10: alias of ERFC. Excel 2010 PRECISE variant. Alias parity pinned. |
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:9468:   556	/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex.md:11192:crates/ql-exec/src/workbook_runtime.rs:431:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-codex.md:1:# W5-D-14.2 HIGH Findings
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:1:# W5-D-11 Opus Audit: PERCENTILE.INC / PERCENTILE.EXC / PERCENTILE / QUARTILE.INC / QUARTILE.EXC / QUARTILE
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:5:Scope: 5-file W5-D-11 batch (uncommitted at audit time). HEAD before: `6c8582700f1`. Files audited:
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:6:- `crates/ql-functions/src/range_fns.rs` — W5-D-11 block (lines 1651-1876 impl + 4537-5096 tests).
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:13:- `cargo test -p ql-functions` → **1755 passed, 0 failed** (includes all 51 new W5-D-11 unit tests).
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:24:W5-D-11 is **mathematically correct and committable**. The position formulas are right (`k*(n−1)` for INC; `k*(n+1)−1` for EXC), bound checks are correct, no panic risk on NaN/Inf k (both kernels' `(lo..=up).contains(&k)` rejects NaN cleanly), no usize-overflow risk for realistic arrays, the QUARTILE wrappers delegate consistently to PERCENTILE.* via `k = q/4`, the legacy `PERCENTILE` / `QUARTILE` aliases register to the `.INC` variant per Excel 2010+ canon, and the e2e test verifies case-insensitive dotted-name dispatch.
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:155:**Recommendation:** Leave as-is for W5-D-11 itself (out of scope), but flag for a future polish pass / consolidation.
quantbook-engine/docs/audits/2026-05-17-w5-d-11-opus.md:187:**Commit W5-D-11 as-is** (no HIGH blockers, no correctness bugs found). Address the 1 MEDIUM and 6 LOW items in a single follow-up `.1` closure commit:
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:1:# W5-D-1 Codex Audit: NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:4:Scope: uncommitted W5-D-1 distribution-function batch on `feat/quantbook-engine`
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:92:Detail: The W5-D-1 scope does not include `ql-exec`, but the worktree currently has a formatting-only change splitting `deps.cells.push(...)` across lines. It is unrelated to the distribution batch and should not ride along with this commit if W5-D-1 is intended to stay narrowly scoped.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:94:Recommendation: Keep this change out of the W5-D-1 commit, or explicitly document that it is pre-existing/unrelated if the working tree is not being committed as a single batch.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:96:Severity rationale: Low because there is no behavior change, but it increases review noise and violates the stated W5-D-1 file scope.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:107:- `CONFIDENCE.NORM` and `CONFIDENCE.T` remain out of W5-D-1 scope; they are present in the IronCalc source after the four NORM functions but are not registered or implemented in this batch.
quantbook-engine/crates/ql-io-xlsx/Cargo.toml:13:# **Phase 4.11 architecture** (locked W5-D-14, 2026-05-18):
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:1://! **W5-D-14.2 (HIGH-7 closure):** `ExportMode::UpdateOriginal`.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:80:    // **W5-D-14.2.3 (separate-Opus H-1 closure).**
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:112:        // **W5-D-14.2.3 (separate-Opus H-1 closure):** prior version
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:220:    // **W5-D-14.2.2 (Codex audit H-B closure):** enforce the
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:265:/// **W5-D-14.2.2 (Codex audit H-A closure):** any part that is
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:297:    // **W5-D-14.2.3 (separate-Opus H-3 closure):** the prior code
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:342:    // **W5-D-14.2.3 (separate-Opus H-3 closure):** the prior code
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:353:    // `xl/cellMetadata.xml` is a single file too (W5-D-14.2.3 H-3 fix).
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:619:/// **W5-D-14.2 self-audit HIGH-1 fix:** the counter MUST be
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:18:**Subject:** Cross-cutting binder admission gap. Same root cause as W5-D-12 Codex HIGH-001, but the closure only patched SUBTOTAL; the systemic issue affects 27 OTHER range-aware fns registered through W5-D-1..W5-D-11.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:25:**Detail:** The Codex W5-D-12 HIGH-001 audit caught that SUBTOTAL wasn't in `is_aggregate_function`. The closure added it. But the SAME bug applies to every range-aware fn that takes a range arg and isn't already admitted. Concretely, set-difference between registered range-aware fns and `is_aggregate_function` admissions:
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:41:**Severity rationale:** Real bind-time correctness bug. 28 user-facing fns silently broken for named-range usage. Same severity as the W5-D-12 closure that warranted HIGH-001 at that batch level.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:141:The W5-D-11.1 / W5-D-12.1 closures added explicit `is_nan()` guards in `extract_quartile_q` and SUBTOTAL function_num extraction. The Phase 4.10 should apply the SAME defensive pattern consistently — add `is_nan()` guards in the W5-D-9 helpers for consistency and forward-defense.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:145:**Severity rationale:** Not a current correctness bug (sanitize_f64 catches NaN upstream). But MEDIUM because (a) the defensive pattern is inconsistent across Phase 4.10 — some places have explicit guards, others rely on implicit upstream behavior; (b) a future refactor could silently break it; (c) the W5-D-12.1 closure documented this as a forward-lesson but didn't retroactively apply it.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:153:**Where:** `docs/MASTER-PLAN.md` — the W5-D-12.1 ship marker paragraph.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-self.md:191:1. **Cross-cutting registry/binder gaps** like the `is_aggregate_function` admission: only the LAST batch (W5-D-12) flagged it, and only for the single fn the batch was about. The systemic issue across 27 earlier-shipped fns went unflagged for the entire arc.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:3://! Post-W5-D-15.2 / megaudit closure, this module covers:
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:22:use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:25:/// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:52:    /// **W5-D-15:** inject `s="N"` into the cell's opening tag.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:105:    // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:110:    // **W5-D-15:** build a `FormatId → xf_index` dedup map. Index 0
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:114:    // **W5-D-15.2 (separate-Opus M-4 closure):** pre-compute the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:116:    // function of the set of FormatIds, not of which sheet first
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:117:    // touched them. Sort by `FormatId` for byte determinism — the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:118:    // per-sheet intra-sort from W5-D-15.1 fixes intra-sheet but
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:121:    let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:130:    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:131:    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:154:        // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior code
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:180:                            // **W5-D-14.1 (audit HIGH-1 closure — phase
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:199:                            // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:256:                            // **W5-D-14.1 (audit HIGH-6 closure):** umya
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:274:        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:280:        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:285:        // (FormatId, row, col) so the roster is byte-stable across
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:290:        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:297:                None => continue, // unreachable — roster pre-populated for all FormatIds
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:311:    // **W5-D-14.1 unified post-process pass:** apply workarounds for
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:326:    // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:339:    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:362:    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:399:/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:400:/// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:408:    cellxfs_roster: &[FormatId],
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:470:        // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:483:        // **W5-D-14.2:** if a sheet has tables but the sheet had no
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:608:                    // **W5-D-15.2 (Codex audit HIGH-4 / separate-Opus
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:678:/// **W5-D-15.2:** insert a style-only cell into the worksheet xml's
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:744:    // **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** the prior W5-D-15.2
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:873:/// **W5-D-14.2 HIGH-5 closure:** inject `<numFmts>` into styles.xml.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:905:    // **W5-D-14.2.3 (separate-Opus M-1 closure):** check the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:957:/// **W5-D-15 (XLSX-4-03 per-cell format closure):** replace umya's
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:958:/// default `<cellXfs>` block with one that enumerates every FormatId
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:965:    cellxfs_roster: &[FormatId],
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1171:/// **W5-D-14.2.3 (separate-Opus M-11 closure):** also quote sheet
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1223:/// **W5-D-14.2 HIGH-4 closure (export side):** inject `<definedNames>`
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1306:/// **W5-D-14.2 HIGH-3 closure:** one table to emit.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1322:    /// **W5-D-14.2 self-audit HIGH-2 fix.**
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1359:        // **W5-D-14.2 self-audit HIGH-2 fix:** the autoFilter range
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1452:/// **W5-D-14.2.2 (Codex audit H-E closure):** the prior mapping
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1642:            // **W5-D-14.1 (audit HIGH-6 closure):** use umya's
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1680:        // re-import via the W5-D-14a calamine path. Values should
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-codex.md:24:- Detail: `is_aggregate_function` is the bind-time admission gate for named ranges. Function args bind under `BindContext::AggregateArg` only if `is_aggregate_function(name)` returns true; otherwise named ranges hit `BindError::NamedRangeInScalarContext` at `plan.rs:857`. The registry has 50 `register_range_aware` functions, but only 22 are admitted. The missing 28 are: `CORREL`, `COUNTBLANK`, `COVARIANCE.P`, `COVARIANCE.S`, `INTERCEPT`, `IRR`, `MAXIFS`, `MINIFS`, `MIRR`, `NPV`, `PEARSON`, `PERCENTILE`, `PERCENTILE.EXC`, `PERCENTILE.INC`, `QUARTILE`, `QUARTILE.EXC`, `QUARTILE.INC`, `RSQ`, `SLOPE`, `STEYX`, `SUMX2MY2`, `SUMX2PY2`, `SUMXMY2`, `TEXTJOIN`, `XIRR`, `XLOOKUP`, `XMATCH`, `XNPV`. This includes every Phase 4.10 closeout range-aware function the megaudit prompt called out except `SUBTOTAL`, which was added in W5-D-12.1.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-codex.md:90:- W5-D audit trail: git log shows W5-D-1 through W5-D-12 ship/audit commit pairs, and the audit docs glob contains Codex + Opus files for all 12 batches.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-codex.md:92:- NaN-to-integer casts in the W5-D-9/W5-D-11/W5-D-12 hot spots look safe: percentile kernels reject NaN through range `contains` before `as usize` at `crates/ql-functions/src/range_fns.rs:1707` and `crates/ql-functions/src/range_fns.rs:1732`; `extract_quartile_q` has an explicit NaN guard at `crates/ql-functions/src/range_fns.rs:1771`; `SUBTOTAL` guards NaN before `as i64` at `crates/ql-functions/src/range_fns.rs:1982`; `parse_places_arg` and DEC2 input collection go through `to_number_strict` before casts at `crates/ql-functions/src/scalar_fns.rs:3480` and `crates/ql-functions/src/scalar_fns.rs:3494`; discrete distribution indexes explicitly reject NaN at `crates/ql-functions/src/distribution_fns.rs:338`.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:1:# W5-D-14 XLSX Round-Trip Spine — Adversarial Opus Audit
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:4:Head at audit: `13b64488dc0` (W5-D-14e — umya exporter, NewWorkbook mode)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:10:The W5-D-14e commit message claims **"Phase 4.11 round-trip spine: CLOSED"** and the
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:53:write side; the OOXML scanner work in W5-D-14b/c/d is solid as an import
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:116:W5-D-14e ("round-trip spine") was to round-trip formulas. The test surface
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:156:1904 workbook. The W5-D-14b commit explicitly added `date1904` parsing for
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:169:**Detail:** The W5-D-14c commit says (XLSX-4-03): "tables ✅, formats ✅,
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:170:names parsed (NameTable wiring W5-D-15)". Tables are claimed to be part of
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:211:**Detail:** Same shape as H-3. The W5-D-14d import side parses `<numFmt>`
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:220:Workbook registered `FormatId(164)="yyyy-mm-dd"` pre-export. Post-roundtrip
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:221:reimport sees `None` for `FormatId(164)`.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:227:   `formats().lookup(FormatId(164)) == Some("yyyy-mm-dd")`.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:228:3. Note: per-cell `<c s="N">` application is admittedly W5-D-14 follow-up
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:235:on; losing it across save defeats the W5-D-14d work.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:294:format-code string ("General") as built-in `FormatId(0)`. Our
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:295:`FormatTable::register_at(FormatId(164), "General")` fails with
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:296:`StringCollision { string: "General", existing_id: FormatId(0), attempted_id: FormatId(164) }`.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:306:  existing_id: FormatId(0), attempted_id: FormatId(164) }" }
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:314:   is admittedly W5-D-14 follow-up).
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:342:> paths) we'd need to follow the workbook rels; W5-D-14c uses the 1:1
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:343:> ordering which covers the standard case. Tracked as a W5-D-14 follow-up
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:660:| `styles_xml.rs:180` | `num_fmt_id = val.parse::<u32>().unwrap_or(0)` | LOAD-BEARING: silently maps malformed numFmtId to General (FormatId 0) |
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:741:> This is O(rows * cols) and inefficient for large sparse sheets; W5-D-14e
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:830:admitted as W5-D-14 follow-up so the field is just placeholder. Annoyance:
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:1012:W5-D-14a–e shipped a solid IMPORT side and a SCAFFOLDING export side. The
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:1025:Suggested re-framing of W5-D-14e in MASTER-PLAN: "round-trip spine half-
quantbook-engine/docs/audits/2026-05-18-w5-d-14-opus.md:1035:W5-D-14 series did not undergo this in advance, per the user's framing.
quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs:3://! **W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format
quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs:11://! caller maps that to a `FormatId` via
quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:3://! **W5-D-14e (this commit):** `umya_export` writes `NewWorkbook`
quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:12://! - Per-cell styles (FormatId → numFmtId via cellXfs).
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2533:crates/ql-storage/src/lib.rs:24:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:2541:crates/ql-storage/src/format.rs:129:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:3493:crates/ql-exec/src/workbook_runtime.rs:1014:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:3495:crates/ql-exec/src/workbook_runtime.rs:1061:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.F-codex-review.txt:3558:crates/ql-exec/src/workbook_runtime.rs:4985:        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:134:| `ROWS`/`COLUMNS` u32 underflow on non-normalized Range | MED-1 | LOW-3 | **MEDIUM** | Codex's framing emphasizes public-API reachability. Take higher. |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:139:| Misc MEDIUMs (ROW(1×3) test, walker doc, matrix counts, args.len()!=1 boundary, Range.values dead, design § 5.6 shape() drift) | — | MED-1/3/4/6/8/9 | **LOW** | Reconciled down — doc-only or unreachable-today concerns. |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:204:| Various MEDIUMs (doc lies, design divergence, untested paths) | — | MED-1 through 10 | mixed | Some are doc-fixes, some real but small. Cherry-pick. |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:260:| Stale doc-comment citation (step3_e2e vs step4_e2e) | (not flagged) | S4-MED-1 | **LOW** | Doc-only. |
quantbook-engine/docs/audits/2026-05-17-reference-tier-audit-summary.md:276:| **S4-MED-1 (Codex)** | Design § 2.5 FORMULATEXT(SUM(A1:A3)) outdated | (Pending in this cycle — design doc § 2.5 update.) |
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:783:    31	    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5355:    41	use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5534:   220	    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5540:   226	    UnknownFormatId(u32),
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5687:   373	    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:5692:   378	    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:6246:   359	            let fid = ql_storage::FormatId(*id);
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:6267:   380	                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7177:   341	/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7355:    78	| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8761:  1255	                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8788:  1282	        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:8823:  1317	                    ql_storage::FormatId(entry.id),
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9212:   875	            Some(ql_storage::FormatId(14))
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9644:   173	                    .register_at(ql_storage::FormatId(*id), string.as_str())
quantbook-engine/docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:9657:   186	                            .set(*row, *col, ql_storage::FormatId(*raw_id));
quantbook-engine/docs/audits/2026-05-17-w5-d-3-opus.md:140:misses the opportunity to actually verify F-pdf math. The W5-D-1/W5-D-2
quantbook-engine/docs/audits/2026-05-17-w5-d-3-opus.md:244:This is a **consistent gap from W5-D-1 / W5-D-2** (same pattern there).
quantbook-engine/docs/audits/2026-05-17-w5-d-3-opus.md:255:prior W5-D-1/W5-D-2 batches' choices. Listing for trend visibility,
quantbook-engine/docs/audits/2026-05-17-w5-d-3-opus.md:326:  the module docstring (lines 130-150) per the W5-D-1.1 HIGH-O-2 closure.
quantbook-engine/docs/audits/2026-05-17-w5-d-3-opus.md:427:  5_10`). Consistent with W5-D-1 / W5-D-2.
quantbook-engine/crates/ql-io-xlsx/src/read/tables_import.rs:19:/// **W5-D-14c**: this is the table-side closure of Phase 4.11
quantbook-engine/crates/ql-io-xlsx/src/read/tables_import.rs:26:/// **W5-D-14.1 (audit HIGH-9 / Opus H-7 closure):** the prior
quantbook-engine/crates/ql-io-xlsx/src/read/sheet_parts.rs:3://! **W5-D-14.1 (audit HIGH-9 closure):** the prior W5-D-14c
quantbook-engine/crates/ql-io-xlsx/src/read/sheet_parts.rs:49:/// **W5-D-15:** companion to `build_sheet_rels_paths` — returns the
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:1:# W5-D-14 Phase 4.11 audit — self (integration pass)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:5:**Scope:** Whole-W5-D-14 audit complementing parallel Codex + separate-Opus audits.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:10:**5 HIGH severity round-trip gaps found.** The W5-D-14e commit message
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:66:**Severity rationale:** HIGH. The W5-D-14b commit explicitly added `set_date_system` on import. Not propagating it on export is a one-line miss with a 4-year-difference impact on date serials. Phase 4.11 acceptance XLSX-4-03 requires "date systems survive" implicitly via "formats survive".
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:78:**Severity rationale:** HIGH. Tables are first-class Phase 4.8 territory. The W5-D-14c commit message states "Closes Phase 4.11 acceptance XLSX-4-03 (tables-side)" — that claim covers IMPORT only. Round-trip is what the user cares about; export tables = lost data on user's first save.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:82:**Subject:** Workbook-scoped + sheet-scoped names are parsed on import (W5-D-14b) but not written on export. Re-import finds no names.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:88:Note: W5-D-14b commit message accurately notes "scoped names PARSED but not yet registered with the engine NameTable (W5-D-15)". So the import side is also incomplete — names are read but not wired. The compound effect is that names are silently lost on BOTH sides.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:96:**Subject:** `xl/styles.xml/<numFmts>` custom format codes (numFmtId ≥ 164) are parsed on import (W5-D-14d) but not written on export. Re-import finds id 164 unregistered.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:108:**Severity rationale:** HIGH. W5-D-14d commit message claims "the workbook's FormatTable correctly carries the user's custom format strings, so when per-cell wiring lands it can just FormatId(N) directly without re-allocating ids." This is true for the in-memory state but FALSE for round-trip — the codes are lost on export.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:130:**Detail:** Documented in the source as a v1 limitation ("for files with non-standard layouts ... we'd need to follow the workbook rels"). But Phase 4.11 W5-D-14c claims tables round-trip "where supported" without quantifying what "supported" means. Real workbooks generated by LibreOffice / Google Sheets / pandas / openpyxl may not match the 1:1 mapping.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:154:**Detail:** The W5-D-14a comment acknowledges this: "ISO-8601 string forms — preserve as text for now; W5-D-14b adds a parsing pass to convert these to serial-date numbers using the workbook's date system." But W5-D-14b did NOT add this parsing pass. The deferral is documented in the comment but never implemented.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:156:**Recommendation:** Add a date-string parsing pass in `data_to_value` using `chrono` (already a transitive dep via umya). Or accept the lossy behavior and update the W5-D-14a comment to clarify it's a permanent v1 divergence.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:162:**Subject:** `tests/calamine_smoke.rs::round_trip_ironcalc_basic_text_preserves_sheet_count` is the ONLY round-trip smoke test for W5-D-14. It asserts `sheet_count` preservation only, not cell values, not metadata, not anything else.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:164:**Where:** `crates/ql-io-xlsx/tests/calamine_smoke.rs` (the new test added in W5-D-14e).
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:166:**Detail:** A test named "preserves" that asserts only sheet count is a documentation lie. A future refactor that drops all cell values on export would PASS this test. Per the W5-D-13.1 audit-discipline Rule 3 ("lex+parse+bind+eval coverage"), round-trip tests must assert SEMANTIC equivalence end-to-end.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:205:**Subject:** The W5-D-14b commit message says "scoped names PARSED but not yet registered with the engine NameTable (W5-D-15)". The Phase 4.11 plan says scope names contribute to acceptance XLSX-4-03. They don't — they're parsed and dropped on the floor.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:209:**Recommendation:** Either wire the NameTable registration (W5-D-15 scope) or remove the "names parsed" claim from W5-D-14b acceptance progress.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:216:- W5-D-14a: import cells ✓ (tested)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:217:- W5-D-14b: import dates ✓ (tested via fixture)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:218:- W5-D-14c: import tables ✓ (tested via fixture)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:219:- W5-D-14d: import format codes ✓ (tested)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:220:- W5-D-14e: export cells ✓ (round-trip values)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-self.md:226:This mirrors the W5-D-13.1 megaudit pattern where the Phase 4.10 V1-260 megaudit caught cross-batch issues the per-batch audits missed. W5-D-14 is the second instance of the same audit-discipline blind spot in three months.
quantbook-engine/docs/audits/2026-05-17-w5180-w5182-depreciation-opus.md:300:  depreciation against a period-1-truncated book value.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-consolidated.md:92:- Undocumented test PeerId(0) → PeerId(100) change (not
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:4:**Phase scope:** 11 commits W5-D-14a → W5-D-15.2 (`c0a496e3627` →
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:66:  (W5-D-15.2 commit `f941195608b` — REGRESSION I introduced).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:109:- Original sources: Opus-B HIGH-2, self M-6 (W5-D-15.2 deferred).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:124:- What's wrong: the shadow tmp path is now unique per-call (W5-D-14.2.1
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:227:- Fix: enumerate every FormatId referenced by any `format_overlay`
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:277:- Fix: rewrite module docs to reflect post-W5-D-15.2 reality.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:290:- Codex MEDIUM-1 / W5-D-14.2.3 M-11 follow-up: R1C1-style sheet names
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:328:- W5-D-14.2.3 M-11 (`quote_sheet_name`) catches `A1`, `Sheet1`,
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:330:- W5-D-15.1 H-3 (cellxfs roster determinism) verified across
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-consolidated.md:361:  W5-D-14.2.3 but extreme corners untested).
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:15:/// (W5-D-15.1 / W5-D-15.2 fix area).
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:62:/// (W5-D-14.2.2 H-B closure claim.)
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:1:# W5-D-1 — separate-Opus audit (Wave 3 distributions batch — normal)
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:4:**Subject:** W5-D-1 implementation commit (working-tree, pre-commit). First batch of Wave 3 distributions: NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV. Backed by `statrs = "=0.18.0"` (matching IronCalc's pin). All four are scalar-tier registrations.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:5:**Auditor:** separate-Opus (4.7, 1M-context). Independent of the parallel Codex audit running concurrently (Codex output at `docs/audits/2026-05-17-w5-d-1-codex.md` was NOT read before writing these findings).
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:92:The current depreciation batch matrix entries (DB, VDB, etc.) explicitly call out the divergence from IronCalc when one exists — e.g., the "AVERAGEA / MAXA / MINA" row at line 95 documents `Boolean → 1/0` + `Text → 0` divergence from base AVERAGE behavior. The W5-D-1 rows should follow the same pattern.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:132:**This entire dispatch path is unexercised for W5-D-1.** All 35 tests call `norm_dist(&[Value::number(2.0), ...])` directly — they prove the kernel math is correct but say nothing about the formula path.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:400:| CONFIDENCE.NORM | ❌ | 0 | Wave 3 D-1 follow-on | IronCalc's normal.rs:198. Defer to next W5-D-N batch — depends on NORM.S.INV (now landed). Trivial 3-arg port. |
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:450:### LOW-O-1 — Unrelated rustfmt cosmetic hunk in `calcgraph_session.rs` bundled with W5-D-1 diff.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:462:This is a pure rustfmt rewrap (line length boundary), unrelated to W5-D-1 normal-distribution work. Including it in the W5-D-1 commit dilutes blame for that file and makes the commit-as-unit-of-meaning fuzzier.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:464:**Recommendation:** stash the rustfmt change to a separate fixup commit (`fmt: rewrap deps.cells.push to multi-line`), or — if it was caused by `cargo fmt --all` running over the workspace — drop the change before committing W5-D-1.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:593:**Recommendation:** normalize the 4 entries to a consistent "(W5-D-1) — anchor: X; LibreOffice: Y; domain: Z; error class: E; arity: A" pattern. Small readability win.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:621:**Detail:** Not a W5-D-1 issue per se, but W5-D-1 added another paragraph to an already-massive accumulating comment. The comment is now ~70 lines of phase history before the single `assert_eq!(r.len(), 204);` line. Maintenance burden is becoming notable. Recommend factoring the phase history to a separate doc or simply allowing the test name + commit history to carry the audit trail. Each new wave appends another block; by Wave 5 this'll be 150+ lines for one assert.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:632:**Severity rationale:** LOW. Cosmetic; the comment is correct, just verbose. Out-of-scope for W5-D-1 strictly but flagged because W5-D-1 made it worse.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:640:2. **The complexity of the W5-D-1 batch is almost entirely in the boundaries**: the coercion frontend (HIGH-O-2), the arity error class (HIGH-O-1), the dead `Normal::new` map_err (MEDIUM-O-5), the formula-string dispatch path (MEDIUM-O-1), and the docstring honesty (MEDIUM-O-2). The math kernel is a 1-liner per fn that statrs owns.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:646:5. **No conformance fixtures from Excel-engine reference suites** (e.g., XLSX golden-master tests against actual Excel outputs) — but this is a project-wide gap, not a W5-D-1 issue. IronCalc has the same shape and uses statrs-output as the canon; we inherit that. If we ever do build conformance fixtures, NORM.* will need 4-fn entries.
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:650:## Suggested commit-message addendum for W5-D-1 closure
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:652:If this audit is the basis for a W5-D-1.1 closure commit, the message should call out:
quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:670:**Total: 21 findings.** Output file: `docs/audits/2026-05-17-w5-d-1-opus.md`.
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs:3://! **W5-D-14a:** minimum viable conversion — sheets + cells + formula
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs:5://! mapping (those land in subsequent W5-D-14 commits).
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs:14:/// **W5-D-14a:** does NOT perform formula recompute. The caller (the
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs:109:/// **W5-D-14a:** this is the bridge between the xlsx import path and
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1011:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1036:    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1779:   112	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1804:   137	    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2501:   106	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2502:   107	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2506:   111	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2515:   120	> (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/crates/ql-io-xlsx/src/read/names_import.rs:1://! **W5-D-14.2 (HIGH-4 closure — import side):** wire OOXML
quantbook-engine/crates/ql-io-xlsx/src/read/names_import.rs:131:    // **W5-D-14.2.3 (separate-Opus M-4 closure):** scan for an
quantbook-engine/crates/ql-io-xlsx/src/read/names_import.rs:287:        // **W5-D-14.2.3 (separate-Opus M-4 closure):** `''`-escaped
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:64:let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1659:   456	            let fid = ql_storage::FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:1680:   477	                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2569:    14	//!   `FormatId` (or clear via `None`). Refuses unknown ids
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2570:    15	//!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2572:    17	//!   through its `FormatId` binding (or General if unbound).
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2578:    23	use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2587:    32	    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2596:    41	    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2606:    51	        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2621:    66	    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2635:    80	        id: Option<FormatId>,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2643:    88	                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2672:   117	    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2690:   135	    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2709:   154	            .unwrap_or(FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2741:   186	    use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2757:   202	            assert_eq!(id, FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:2759:   204	            assert_eq!(id2, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3899:     4	//! entry render via `FormatId::GENERAL` semantics.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3902:     7	//! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3908:    13	//! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3918:    23	use crate::format::FormatId;
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3920:    25	/// Sparse per-sheet `(row, col) → FormatId` overlay.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3922:    27	/// Cells absent from the overlay render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3925:    30	    entries: HashMap<(RowId, ColId), FormatId>,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3935:    40	    /// `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3936:    41	    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3942:    47	    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3947:    52	    /// `FormatId::GENERAL`. Returns the cleared id, if any.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3948:    53	    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3967:    72	    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3969:    74	    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:3976:    81	    pub fn count_refs(&self, id: FormatId) -> usize {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4001:   106	        let id = FormatId(14);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4009:   114	        assert_eq!(o.set(5, 3, FormatId(14)), None);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4010:   115	        assert_eq!(o.set(5, 3, FormatId(15)), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4011:   116	        assert_eq!(o.get(5, 3), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4017:   122	        o.set(5, 3, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4018:   123	        assert_eq!(o.clear(5, 3), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4031:   136	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4032:   137	        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4040:   145	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4041:   146	        o.set(0, 1, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4042:   147	        o.set(0, 2, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4043:   148	        assert_eq!(o.count_refs(FormatId(14)), 2);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4044:   149	        assert_eq!(o.count_refs(FormatId(15)), 1);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4045:   150	        assert_eq!(o.count_refs(FormatId(999)), 0);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4051:   156	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4052:   157	        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4060:   165	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4061:   166	        o.set(0, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4062:   167	        o.set(1, 0, FormatId(16));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4063:   168	        assert_eq!(o.get(0, 0), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4064:   169	        assert_eq!(o.get(0, 1), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4065:   170	        assert_eq!(o.get(1, 0), Some(FormatId(16)));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4087:    17	/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4090:    20	pub struct FormatId(pub u32);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4092:    22	impl FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4094:    24	    pub const GENERAL: FormatId = FormatId(0);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4133:    63	/// Cells reference a `FormatId`; the table resolves the id back to a
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4138:    68	    by_id: HashMap<FormatId, String>,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4140:    70	    by_string: HashMap<String, FormatId>,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4153:    83	            let fid = FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4170:   100	    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4182:   112	    pub fn intern(&mut self, s: &str) -> FormatId {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4186:   116	        let id = FormatId(self.next_custom_id);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4199:   129	    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4248:   178	    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4259:   189	        id: FormatId,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4266:   196	        existing_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4267:   197	        attempted_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4278:   208	        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4279:   209	        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4280:   210	        assert_eq!(t.lookup(FormatId(49)), Some("@"));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4287:   217	        assert_eq!(t.lookup(FormatId(12)), None);
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4294:   224	        assert_eq!(id, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4303:   233	        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4328:   258	        t.register_at(FormatId(200), "REPLAY").unwrap();
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4329:   259	        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:10062:   153	    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:10067:   158	    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11400:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.
quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:11418:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-prompt.md:30:- `crates/ql-exec/src/workbook_runtime.rs` (intern_format + set_cell_format + read_display + format_cache field + UnknownFormatId error + 14 tests).
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-prompt.md:61:**B.6** Cache behavior + EvalContext threading from runtime's read_display: the format_cache stores `FormatString` per `FormatId`; the EvalContext uses workbook's date_system. Verify both threading through W5-82 + W5-83 tests don't break for non-default contexts.
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-prompt.md:101:**F.3** set_cell_format unknown-id rejection: `Some(FormatId(9999))` returns `RuntimeError::UnknownFormatId(9999)` BEFORE any oplog mutation.
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-prompt.md:129:**H.4** GAP-F-07 (FormatTable compaction): when a cell's format is overridden, the old FormatId stays in the table. `count_refs` exists to support compaction but no compaction is wired yet. Is this risk documented in `known-gaps.md`? Should W5-84 update the GAP entry?
quantbook-engine/crates/ql-io-xlsx/src/read/feature_inventory.rs:21:/// **W5-D-14b:** detection by part-path heuristics. False positives
quantbook-engine/crates/ql-io-xlsx/src/read/feature_inventory.rs:59:    // merged cells, sheet protection). W5-D-14b detection: open each
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs:8://! **W5-D-14a (this commit)** — minimum viable grid: sheets + cells +
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs:10://! inventory land in subsequent W5-D-14 commits.
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs:60:    /// reconciliation step (W5-D-14 follow-up) makes the OOXML view
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs:150:///   distinguishes them visually; format mapping is W5-D-14b work.
quantbook-engine/crates/ql-io-xlsx/src/read/calamine_grid.rs:164:        // ISO-8601 string forms — preserve as text for now; W5-D-14b
quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs:7://! sheet-scoped names. Per the W5-D-14 plan, the OOXML scanner is
quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs:19:/// **W5-D-14b**: not all fields are consumed by the import pipeline
quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs:21:/// W5-D-14c (table imports cross-reference sheet positions) and
quantbook-engine/crates/ql-io-xlsx/src/read/workbook_xml.rs:22:/// W5-D-15 (named-range resolution into the engine's `NameTable`).
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:112:### S4-MED-1 — Doc-comment claims test is in `reference_fns_step3_e2e` but actual test is in `reference_fns_step4_e2e`
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:317:### S4-MED-10 — Cross-sheet test uses sheet name `S1` instead of design-doc's `Sheet1`/`Sheet2`
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:333:### S4-MED-11 — Empty-string formula edge case unreachable but undefended
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:542:| 24. Doc-comments vs impl drift | YES | Multiple drifts: S4-MED-1 (test file path), S4-HIGH-3 (module header), S4-MED-5 (`is_reference_aware_function`), S4-LOW-12 (test doc). |
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:558:| S4-MED-1 | MEDIUM | Doc-comment cites `reference_fns_step3_e2e` but test is in `reference_fns_step4_e2e` |
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:567:| S4-MED-10 | MEDIUM | Cross-sheet test uses `S1` instead of design-doc's `Sheet2` |
quantbook-engine/docs/audits/2026-05-17-rt-step-4-opus.md:568:| S4-MED-11 | MEDIUM | Empty-string formula edge case unreachable but undefended |
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:69:So the fix from the per-batch audit (W5-D-14.1 HIGH-6) only works for the **value-only** Error cell path (the `(None, val)` arm). The **formula+Error** arm is broken.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:169:- `formats().lookup(FormatId(164)) = None` — because `styles_import` treats the redundant General registration as a benign no-op (W5-D-14.1 HIGH-8 closure at `styles_import.rs:63-71`).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:170:- BUT `sheet.format_overlay().get(0,0) = Some(FormatId(164))` — `cell_styles_xml.rs` populates the overlay from the cellXf `numFmtId` attribute even when the `numFmt` declaration was skipped.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:172:On **export**, `collect_defined_names`-style logic in `umya_export.rs:287-297` filters `workbook.formats()` to `id.0 >= 164`. Since id 164 isn't in the table, no `<numFmt>` is emitted. But every cell with `format_overlay(0,0) = FormatId(164)` gets `<c s="N">` and the cellXf injection block at `umya_export.rs:780-789` emits `<xf numFmtId="164" applyNumberFormat="1"/>` — referencing an undefined numFmtId.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:174:**Two-custom-ids-same-code variant** (`two_custom_ids_with_same_format_code`): a workbook with `numFmt 164="yyyy-mm-dd"` AND `numFmt 165="yyyy-mm-dd"` → after import only 164 registers (165 → StringCollision benign no-op); but cell `<c r="B1" s="2">` produces `format_overlay(0,1) = FormatId(165)`. On export, no `<numFmt numFmtId="165">` is written.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:394:- **Per-cell format overlay** — 59387 / 59387 overlay entries across the corpus round-trip at the same (sheet, row, col) with the same FormatId AND matching format code strings.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:402:- **Strict + `UpdateOriginal` does NOT touch pre-existing output file on error** — confirmed via sentinel-file probe (W5-D-14.2.2 H-B claim holds).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:403:- **Sheet-with-only-blank-overlay-cells followed by a normal sheet** — overlay alignment preserved (W5-D-15.1 Codex HIGH-3 closure verified).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:405:- **LibreOffice's `numFmt 164="General"` redundant declaration** — doesn't error import (W5-D-14.1 HIGH-8 closure verified); but see HIGH-4.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-a.md:424:The per-batch audits missed HIGH-1, HIGH-2, HIGH-3, HIGH-4, HIGH-5 because each batch tested its own slice (W5-D-14.1 tested value-only error cells; W5-D-15 tested overlay-only; W5-D-14b parsed sheet state; W5-D-14.2 closed `unsupported_policy` flow only in `UpdateOriginal`). The megaudit picks up the cross-cutting consequences.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:155:        r.workbook.formats().lookup(ql_storage::FormatId(164))
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:160:    // has FormatId(164). On EXPORT, the umya post-process emits
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:3://! **Focus for W5-D-14d**: minimal but useful — extract custom number
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:37://! application (W5-D-14 follow-up via worksheet XML scan) can map
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:73:/// `numFmtId` reference for W5-D-14d; alignment / borders / fonts
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:120:                // **W5-D-15.1 (self-audit H-2 root-cause closure):**
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:184:    // **W5-D-15.1 (self-audit H-2 closure):** the OOXML schema
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:288:        // **W5-D-15.1 (self-audit H-2 closure):** OOXML default for
quantbook-engine/docs/audits/2026-05-17-w5183-vdb-opus.md:371:// rate = 1.5/10 = 0.15; period-1 DDB = 2400 * 0.15 = 360.
quantbook-engine/docs/audits/2026-05-17-w5183-vdb-opus.md:378:**Fix:** Reword: `overlap [0, 0.875] = 0.875 of the period-1 DDB amount = 0.875 × 360 = 315.00`.
quantbook-engine/crates/ql-io-xlsx/src/read/mod.rs:3://! **W5-D-14a:** calamine grid path live.
quantbook-engine/crates/ql-io-xlsx/src/read/mod.rs:4://! **W5-D-14b (this commit):** OOXML scanner foundation — package
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:27:| CONV-1 | `OpLog::set_peer_id` docstring claim "Idempotent — no-op" overstates Loro behavior (Loro always re-stores + emits notification; only the observable peer_id is unchanged) | Codex LOW#1 | Opus MED-1 | ✅ FIXED — docstring softened to "leaves peer id unchanged but NOT a strict no-op"; warns against hot-path repeats |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:48:| Opus LOW-2 | Undocumented PeerId(0) → PeerId(100) change in merge test | KEPT — change is benign; comment added to D-4 audit closure if a future reader asks |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:55:**Phase 5 D-1 (FormatId tagged tuple) gets a small simplification.**
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-consolidated.md:56:With 5.2.b in place, the FormatId allocator can read `log.peer_id()` instead of taking PeerId as a parameter — the OpLog now authoritatively knows its own peer id. Implementation detail, not a design change. The D-1 author should know `OpLog::peer_id()` is reliable.
quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:592:| `FormatTable`, `FormatId`, `FormatTableError`, `FIRST_CUSTOM_FORMAT_ID` | Stable. `#[non_exhaustive]` on `FormatTableError`. |
quantbook-engine/docs/audits/2026-05-17-w5-d-10-codex.md:1:# Codex Audit - W5-D-10 Phase 4.10 V1-260 Closeout: ERF / ERFC
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1574:    25	pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1606:    57	        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1607:    58	        assert_eq!(wb.formats().lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1614:    65	        assert_eq!(id, FormatId(2));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1633:    84	        s.format_overlay_mut().set(3, 5, FormatId(14));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1634:    85	        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1830:crates/ql-storage/src/format_overlay.rs:30:    entries: HashMap<(RowId, ColId), FormatId>,
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1831:crates/ql-storage/src/format_overlay.rs:41:    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1832:crates/ql-storage/src/format_overlay.rs:47:    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1833:crates/ql-storage/src/format_overlay.rs:53:    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-14-phase-4.7.H-codex-review.txt:1834:crates/ql-storage/src/format_overlay.rs:74:    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:12:- Read post-change `docs/architecture/crdt-data-model.md` § ql-collab + § D-1, `docs/phase5/entry-plan.md` full.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:24:**MED-1 — `OpLog::set_peer_id` docstring lies about idempotence** (`crates/ql-oplog/src/log.rs:135-136`).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:50:- LOW-2: undocumented PeerId(0)→PeerId(100) test change.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:57:Phase 5 D-1 (FormatId tagged tuple) — 5.2.b enables a small simplification: the FormatId allocator can read `log.peer_id()` instead of taking PeerId as a parameter, since the OpLog now authoritatively knows its own peer id.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:63:Net: the wiring itself is sound. Bulk of issues are documentation/test-coverage-strength concerns, not correctness bugs. MED-1 + MED-2 + MED-3 are the highest-leverage fixes.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:4://! **W5-D-14a (Phase 4.11 round-trip spine):** prove that the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:18:    // **W5-D-14a smoke test.** Open the smallest IronCalc fixture and
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:47:    // **W5-D-14a:** with `preserve_package = true`, the preservation
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:49:    // be populated in W5-D-14 follow-up commits (OOXML scanner).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:71:    // **W5-D-14b smoke test:** the OOXML scanner parses
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:93:    // **W5-D-14b smoke test:** basic_text.xlsx is a minimal fixture
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:111:    // **W5-D-14e end-to-end round-trip smoke**: import an xlsx,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:138:    // **W5-D-14.1 (audit HIGH-1 closure):** umya's `set_value_*`
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:181:        "formula at C1 should survive round-trip (W5-D-14.1 HIGH-1 closure)"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:194:    // **W5-D-14.1 (audit HIGH-2 closure):** umya 2.2.0 doesn't expose
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:222:        "date1904 should round-trip (W5-D-14.1 HIGH-2 closure)"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:229:    // **W5-D-14.1 (audit HIGH-6 closure):** error values now export
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:282:    // **W5-D-14.1 (audit HIGH-8 closure):** LibreOffice's
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:306:    // **W5-D-14.2 (HIGH-5 closure):** custom format codes (numFmtId >= 164)
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:308:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:315:    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-custom-format.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:347:    // **W5-D-14.2 (HIGH-4 closure):** workbook-scope name targeting a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:357:    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-name-cell.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:391:    // **W5-D-14.2 (HIGH-4 closure):** workbook-scope name targeting a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:400:    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-name-range.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:436:    // **W5-D-14.2 self-audit L-6 closure:** sheet-scope name targeting
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:448:    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-scoped-name.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:489:    // **W5-D-14.2 (HIGH-3 closure):** Quantbook tables export to
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:524:    let tmp = std::env::temp_dir().join("w5-d-14-2-roundtrip-table.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:559:    // **W5-D-14.2 (HIGH-7 closure):** import a real fixture WITH
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:572:    let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-theme.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:599:    // **W5-D-14.2 (HIGH-7 closure):** UpdateOriginal must also write
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:617:    let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-edit.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:650:    // **W5-D-14.2.3 (separate-Opus H-1 closure):** the prior assertion
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:678:    let tmp = std::env::temp_dir().join("w5-d-14-2-3-theme-bytes.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:713:    // **W5-D-14.2.2 (Codex audit H-B closure):** in Strict mode, a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:741:    let tmp = std::env::temp_dir().join("w5-d-14-2-2-strict-no-overwrite.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:776:    // **W5-D-14.2.2 (Codex audit H-A/H-B closure):** Permissive mode
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:797:    let tmp = std::env::temp_dir().join("w5-d-14-2-2-permissive-vba.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:826:    // **W5-D-15 (Phase 4.11 XLSX-4-03 closure):** a cell with an
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:828:    // re-import, ending up at the same (row, col) with a FormatId
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:830:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:843:    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-cell-fmt.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:865:    // Cell at (0, 0) still references that FormatId via the overlay.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:870:        "expected (0,0) to have the custom FormatId after round-trip"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:878:    // **W5-D-15:** built-in formatId 14 ("m/d/yyyy") is in the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:882:    use ql_storage::{FormatId, Workbook};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:889:    let builtin = FormatId(14);
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:892:    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-builtin-fmt.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:910:        Some(FormatId(14)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:919:    // **W5-D-15:** two cells sharing the same FormatId should reuse
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:941:    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-dedup.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:966:    // **W5-D-15.2 (separate-Opus H-5 closure):** a formula cell whose
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:972:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:984:    let tmp = std::env::temp_dir().join("w5-d-15-2-formula-blank.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1010:    // **W5-D-15.2 (separate-Opus M-4 closure):** with two sheets
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1011:    // contributing different FormatIds in different orders, the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1012:    // `<cellXfs>` roster MUST be ordered by FormatId, not by
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1013:    // sheet-encounter order. Sort by FormatId via BTreeSet pre-walk.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    // Sheet 0 contributes formats in c, b order (greater FormatIds first).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1044:    let tmp = std::env::temp_dir().join("w5-d-15-2-cross-sheet-det.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1057:    // Re-import must still resolve each cell to its original FormatId,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1073:    // match the FormatId order (a, b, c) regardless of which sheet
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1093:        "cellXfs not sorted by FormatId (M-4 regression): positions A={}, B={}, C={}",
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1180:    // **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** W5-D-15.2's
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1593:    // **W5-D-15.2 (Codex audit HIGH-4 / self-audit H-1 closure):** a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1597:    // such cells; W5-D-15.2 pre-touches them via `get_cell_mut` so
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1599:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1611:    let tmp = std::env::temp_dir().join("w5-d-15-2-blank-overlay.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1628:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1637:    // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior export
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1644:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1658:    let tmp = std::env::temp_dir().join("w5-d-15-1-empty-then-styled.xlsx");
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1686:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1695:    // **W5-D-15.1 (self-audit H-2 closure):** LibreOffice-generated
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1728:         entry (W5-D-15.1 H-2 regression — applyNumberFormat default flipped)"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1734:    // **W5-D-14a:** larger fixture with formulas. Run recompute in
quantbook-engine/docs/audits/2026-05-17-w5-d-11-codex.md:1:# Codex Audit - W5-D-11 Phase 4.10 V1-260 Closeout
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:4://! **W5-D-14d scope**: format-code registration only. Per-cell
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:12://! `FormatId(N)` directly without re-allocating ids.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:16:use ql_storage::{FormatId, Workbook};
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:65:        let id = FormatId(entry.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:66:        // **W5-D-14.1 (audit HIGH-8 closure):** real-world xlsx files
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:155:        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:157:            wb.formats().lookup(FormatId(165)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:164:        // **W5-D-14.1 (audit HIGH-8 closure):** LibreOffice's
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:191:            .register_at(FormatId(164), "yyyy-mm-dd")
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:223:        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:5:**Phase scope:** 11 commits `c0a496e3627` → `f941195608b` (W5-D-14 →
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:6:W5-D-15.2).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:21:  (W5-D-14e follow-ups): Tables / styles / named ranges round-trip.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:23:  validation preservation."** This was true at the W5-D-14e ship.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:24:  After W5-D-14.2 (tables, styles, names, UpdateOriginal all shipped)
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:25:  and W5-D-15 (per-cell formats), only CF/DV preservation remains
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:32:- Suggested fix: rewrite the module doc to reflect post-W5-D-15.2
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:38:  in W5-D-15.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:40:  ... per-cell application (W5-D-14 follow-up via worksheet XML
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:77:  `report.dropped_features`. This is the W5-D-13.1-style "audit
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:93:  - Overlay (row, col) → FormatId mapping (the COUNT matches but the
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:112:### M-1: Audit-discipline gap — W5-D-14a..e (commits `c0a496e3627` through `13b64488dc0`) have no per-batch audit docs
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:117:  2026-05-18 with W5-D-14a. Per the rule, each W5-D-14X commit
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:118:  should have its own 3-way audit. Instead, the W5-D-14a..e batches
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:119:  were rolled up into a single `w5-d-14-*.md` audit AFTER W5-D-14e
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:122:  cheaper to fix). The 9 HIGHs found after W5-D-14e would have been
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:168:### M-4: Each W5-D-14.X audit closure DELETED prior probe code without a doc record of what the probe asserted
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:170:- File: per the W5-D-14-self.md description: "Built a self-audit probe
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:202:- `docs/audits/2026-05-18-w5-d-15-codex.md` etc.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:204:  HIGHs or was clean. A `2026-05-18-w5-d-15-codex-3H-2M-1L.md`
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:219:  (e.g., "W5-D-15.2 / closures (H-1 blank-cell + H-5 formula-blank +
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:244:  discipline from W5-D-14 onward.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-self.md:268:ls docs/audits/2026-05-18-w5-d-1*
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:758:  2850	            .unwrap_or(FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1601:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2166:docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:440:    // impt = -[(1+rate)^(period-1)*(pv*rate+pmt)-pmt]
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:441:    // ipmt = FV(rate, period-1, payment, pv, type) * rate
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:621:./docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:773:./docs/architecture/2026-05-13-dates-times-formats.md:308:The original draft said "each cell can carry `format_id: Option<FormatId>`" — but Quantbook storage is **columnar** (Arrow chunks + sparse overlays at `crates/ql-storage/src/column.rs`), not row-based with per-cell structs. There's no `Cell` type to attach `format_id` to. Concrete redesign:
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:775:./docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:806:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1601:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:815:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2166:docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1554:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7355:    78	| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:4920:.references/ironcalc/base/src/functions/financial.rs:119:    // ipmt = FV(rate, period-1, payment, pv, type) * rate
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:6747:   118	    // impt = -[(1+rate)^(period-1)*(pv*rate+pmt)-pmt]
quantbook-engine/docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:6748:   119	    // ipmt = FV(rate, period-1, payment, pv, type) * rate
quantbook-engine/crates/ql-io-xlsx/src/read/rels.rs:19://! **W5-D-14c**: parsed for table → sheet ownership resolution. The
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:3437:crates/ql-exec/src/workbook_runtime.rs:436:    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-15-phase-4.9-closing-megaudit-codex-retry.md:3488:crates/ql-exec/src/workbook_runtime.rs:2660:    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-self.md:89:  - `2026-05-18-w5-d-15-codex.md`
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-codex.txt:162:The cache is keyed only by `FormatId` and inserts on first `read_display`
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:9:use ql_storage::{FormatId, NamedTarget, Workbook};
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:334:    let fmt_date = ql_storage::FormatId(14); // built-in
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:35://! ## First batch (W5-D-14): round-trip spine with feature inventory
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:59:// Submodules for the read and write implementations land in W5-D-14
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:103:/// **W5-D-14a (Phase 4.11 round-trip spine):** minimum viable import
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:106:/// feature inventory land in subsequent W5-D-14 commits per the plan.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:118:/// **W5-D-14a:** calamine grid → Workbook + recompute pass.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:119:/// **W5-D-14b:** OOXML scanner — `xl/workbook.xml` for date system +
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:129:    // **W5-D-14b — Phase 0**: build the OOXML package handle. Shared
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:134:    // **W5-D-14b — Phase 0a**: parse `xl/workbook.xml` for the date
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:166:    // **W5-D-14b — Phase 0b**: scan for unsupported OOXML features.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:182:    // **W5-D-14b — Phase 2a**: apply workbook-level properties from
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:187:    // **W5-D-14c — Phase 2c**: import tables. Walks each sheet's
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:193:    // **W5-D-14.1 (audit HIGH-9 closure):** the sheet → rels-path map
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:231:    // **W5-D-14d — Phase 2d**: import styles. Parses `xl/styles.xml`
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:235:    // for round-trip). Per-cell application landed in W5-D-15 — see
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:241:    // **W5-D-15 — Phase 2d-bis (XLSX-4-03 per-cell format closure):**
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:273:            let fmt_id = ql_storage::FormatId(xf.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:278:    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:286:    // **W5-D-14b — Phase 2b**: apply UnsupportedPolicy::Strict if any
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:356:/// **W5-D-14e:** `ExportMode::NewWorkbook` wired through
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:407:        // **W5-D-14a:** import path now wired through calamine. A
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:419:        // **W5-D-14b:** invalid bytes (not a zip) surface as a
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:420:        // structured xlsx error. After W5-D-14b the OOXML scanner
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:422:        // `Calamine` (pre-W5-D-14b ordering).
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:433:        // **W5-D-14.2 (HIGH-7 closure):** UpdateOriginal with empty
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:448:        let tmp = std::env::temp_dir().join("w5-d-14-2-update-original-empty.xlsx");
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-design.md:5:Phase 4.11 shipped over 11 commits (W5-D-14a → W5-D-15.2), with
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-design.md:11:   misalignment (Codex HIGH-3 in W5-D-15.1) was an interaction
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-design.md:12:   between W5-D-14.2's introduction of `sheet_fixes` and W5-D-15's
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-design.md:21:4. **Real-world fixture coverage.** The W5-D-13.1 megaudit precedent
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-design.md:40:formula text drift, overlay `(row, col) → FormatId` preservation,
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:13:However, v2 will be painful unless three architectural smells are paid down first: (a) a fast-growing **substring-XML-mutation post-process layer** (W5-D-14.1+) that is now load-bearing for date1904, definedNames, custom numFmts, cellXfs, tableParts, sheet rels, Content_Types overrides, and per-cell `s="N"` injection — see HIGH-2; (b) **`XlsxPreservation.known_parts` is dead** (declared `pub`, never populated, never read) — see HIGH-3; (c) **three independent A1 parsers** plus three different `Event::Start`/`Empty` patterns across XML modules — small but compounding (see MEDIUM-1, MEDIUM-2). None block shipping; all should land before the v2 rels-merge work because v2 will touch the same modules.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:21:`write/umya_export.rs::post_process_zip` (function starts at L343) is the second pass over the umya-generated zip. As of W5-D-15.2 it patches eight different parts via string-find/replace:
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:32:- W5-D-14.2.3 M-1 closure (numFmts/definedNames/tableParts close-form ordering)
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:33:- W5-D-15.2 H-1/H-5 (`<c>` element synthesis for value-less styled cells)
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:34:- W5-D-15.1 H-2 (`cellXfs`/`<xf>` Start-vs-Empty event handling)
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:54:The field is `pub`, so we've committed the shape to callers. The module doc at `model.rs:13-14` claims "the actual fields are filled in by the W5-D-14 implementation"; that never happened. Phase 4.11 instead reads `source.original_bytes` directly in `update_original.rs` and re-parses on demand.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:62:`crates/ql-io-xlsx/src/error.rs:71-75` declares a `Reconciliation { message: String }` variant intended for "hybrid-reader disagreement between calamine and OOXML scanner". `grep -rn "Reconciliation" crates/ql-io-xlsx/src/` returns ONLY the declaration. The hybrid reader's reconciliation step described in `calamine_grid.rs:60-62` ("the OOXML view authoritative ... reconciliation step (W5-D-14 follow-up)") never landed; calamine's sheet order is now used unchanged (`convert.rs:33`).
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:93:W5-D-15.1 H-2 closure caught a real bug here: `read/styles_xml.rs` previously only matched `<xf>` as `Event::Empty`, dropping LibreOffice's long-form `<xf>...</xf>` elements. The stack-element design works but the duplicated attribute parsing is fragile — `workbook_xml.rs` extracts the same `date1904`/`r:id`/etc. attributes in both arms.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:166:- `read/cell_styles_xml.rs:3-5`: "W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format application)"
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:167:- `read/sheet_parts.rs:3-16`: "W5-D-14.1 (audit HIGH-9 closure)" — long explanation of what the PRIOR code did wrong, not what the current code DOES
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:168:- `read/styles_xml.rs:32-38`: still refers to W5-D-14d as the "current commit"
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:193:`read/cell_styles_xml.rs:3-5` claims "W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format application)", but the module was later modified in W5-D-15.1/W5-D-15.2 for LibreOffice compatibility. The header attribution is the original commit, not the most-recent author of behavior.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:201:Today there's no scheduling mechanism. The CI signal "all 177 fixtures round-trip with counts-equivalent" would catch regressions like W5-D-15.1's empty-sheet misalignment in seconds.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:207:The 28 E2E tests are interleaved by feature (date1904, custom format, table, scoped name, UpdateOriginal, format overlay, etc.) with W5-D-X commit tags as their only grouping signal. A maintainer trying to find "all tests covering tables" has to grep by W5-D-14.2 in test names — fine for now, brittle as tests accumulate.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:233:Audit grep shows every `ql_storage::` / `ql_types::` / `ql_exec::` reference resolves to a published symbol (`Workbook`, `FormatId`, `FormatTable`, `NamedTarget`, `TableMetadata`, `TableColumn`, `TotalsFunction`, `SheetId`, `Value`, `DateSystem`, `MAX_ROW`, `MAX_COLUMN`, `WorkbookRuntime`, `FunctionRegistry`, `default_registry`). No `pub(crate)` reach-ins. Boundary discipline is good. No cycles. `ql-io-xlsx` is leaf-ish — only `ql-exec` (via the recompute pipeline) pulls in any heavy engine machinery.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:237:`pub fn import_xlsx_bytes` at `lib.rs:112-290` is 178 lines. It orchestrates 12 distinct phases (W5-D-14b Phase 0 → Phase 4) inline. While each phase is well-commented, the sequential dispatch is logic that doesn't belong at the public API layer — it should live in `read::pipeline::import` or similar so `lib.rs` reads as a thin facade.
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:461:crates/ql-oplog/src/replay.rs:1264:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:462:crates/ql-oplog/src/replay.rs:1284:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:511:crates/ql-io/src/qbook_format.rs:2874:            loaded.formats().lookup(ql_storage::FormatId(14)),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:514:crates/ql-io/src/qbook_format.rs:2904:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:516:crates/ql-io/src/qbook_format.rs:2994:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:517:crates/ql-io/src/qbook_format.rs:3000:                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:2900:   417	    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:2905:   422	    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-15-phase-4.8-closure-verify-codex.md:4281:crates/ql-exec/src/workbook_runtime.rs:41:use ql_storage::{FormatId, SpillShape, Workbook};
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:474:docs/phase5/entry-plan.md:112:| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:570:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:580:docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:885:docs/audits/2026-05-19-phase-5-5-v1-codex.md:2506:   111	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:991:docs/audits/2026-05-19-phase-5-4-v1-codex.md:2396:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:995:docs/audits/2026-05-19-phase-5-4-v1-codex.md:3335:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:999:docs/audits/2026-05-19-phase-5-4-v1-codex.md:4175:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1002:docs/audits/2026-05-19-phase-5-4-v1-codex.md:4316:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1018:docs/audits/2026-05-19-phase-5-4-v1-codex.md:7978:   109	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1218:     /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1249:     /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1886:         // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2546:   132	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2576:   162	    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2781:   107	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2782:   108	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2786:   112	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/crates/ql-io-xlsx/src/error.rs:12:/// **Phase 4.11 (W5-D-14):** kept narrow at first ship. Variants will
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:5:HEAD before W5-D-2: `b7b4682a666` (W5-D-1.1 audit transcripts).
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:22:to the W5-D-1 pattern. The biggest concern is **MEDIUM-O-1**: the
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:60:The W5-D-1.1 closure for HIGH-O-2 (per the docstring at line 41-61) explicitly added an "IronCalc divergences" table at module level — establishing the pattern that *module-level canon docs are first-class*. W5-D-2 didn't follow this pattern.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:75:Detail: The "Arg coercion" section says numeric args are coerced via `to_number_strict`, the `cumulative` flag via `to_logical`, and arity → `#VALUE!`. This was written for W5-D-1 NORM.* fns; it happens to also apply verbatim to W5-D-2 T.* fns. But:
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:82:Severity rationale: MEDIUM. The doc gap is real but not safety-critical — fn-level docs cover it. Flagged MEDIUM (not LOW) because the module docstring is the *organizing layer* of the file and the W5-D-1.1 closure of HIGH-O-2 set the precedent that cross-cutting policy lives at module level.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:93:Detail: The W5-D-1 NORM.* pattern for arity tests covers both under- and over-arity (e.g., `norm_s_dist_arity_mismatch_returns_value` at line 596 tests `[Value::number(0.0)]` AND `[Value::number(0.0), Value::Boolean(true), Value::number(1.0)]` — both 1-arg and 3-arg). T.DIST.2T and T.INV.2T arity tests in W5-D-2 follow this pattern (each has 3 sub-asserts including the over case). T.DIST, T.DIST.RT, and T.INV only test the under case.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:98:Severity rationale: LOW. The arity-check `if args.len() != N` is symmetric — verifying the under case implicitly verifies the over case (same branch). But the test-shape convention from W5-D-1 says cover both; this is consistency drift.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:129:It matches IronCalc line-for-line, which has the same dead defense. Per W5-D-1.1 IronCalc-parity principle, leaving it is correct.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:144:The W5-D-1 e2e set has similar gaps (4 fns × 3-4 e2e each = 13 total), so this is consistent with the prior pattern.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:163:- **Arity convention `#VALUE!` matches W5-D-1.1 closure of Opus HIGH-O-1.** Verified all 5 T.* fns return `Value::Error(ErrorValue::Value)` for arity mismatch — both in impl and in unit/e2e tests.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:171:- **Registry count 209** verified — `default_registry_has_expected_count` test passes. The count comment at registry.rs:921-927 correctly accounts for W5-D-1 (+4) + W5-D-2 (+5) = +9 over the 200 pre-W5-D-1 baseline.
quantbook-engine/docs/audits/2026-05-17-w5-d-2-opus.md:182:- **Documented IronCalc divergences:** the Boolean / parseable-text coercion divergence (W5-D-1.1) carries over correctly to T.* via the shared `to_number_strict` / `to_logical` helpers. T.*-specific divergences (df-truncation, clamp behavior, abs return) are *intentional matches* to IronCalc, not divergences. The module docstring's W5-D-1.1 closure documentation needs extending (MEDIUM-O-3) but the underlying code behavior is correct.
quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:1:# W5-D-12 (Phase 4.10 V1-260 sealer — SUBTOTAL) — Opus audit
quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:11:The single most serious finding: **`HIGH-001` — three of the four newly-added e2e tests are FAILING in the working tree** (`e2e_subtotal_sum_range_dispatch`, `e2e_subtotal_average_range_dispatch`, `e2e_subtotal_109_equivalent_to_sum_range`). They were labelled "W5-D-12.1 Codex HIGH-001 closure" in their comments, but the underlying closure is **incomplete** — adding `"SUBTOTAL"` to `is_aggregate_function` is necessary but NOT sufficient. Literal `Expr::RangeRef` is rejected by the binder unconditionally outside `BindContext::ReferenceArg`, including in `BindContext::AggregateArg`. The author was aware of this limitation (workbook_runtime.rs line 11875 explicitly notes `"Literal SUM(A1:A3) over a Range needs aggregate-arg binding which v1 routes via named ranges only"`), yet committed tests that exercise exactly the unsupported path. As a result `cargo test --workspace` fails — this is not a fly-by issue.
quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:22:- **Where:** `crates/ql-exec/tests/region_mul2_e2e.rs` lines 779-832 (the three tests after `e2e_subtotal_registered`). These are present in the working tree's `git diff` and labelled `"W5-D-12.1 (Codex HIGH-001 closure)"` in their comments. The audit prompt only mentioned `e2e_subtotal_registered`, but the diff contains four e2e tests; the prompt undersells the surface area.
quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:54:  3. **Soften the HIGH-001 closure language** in the W5-D-12 module comment and the coverage entry. Replace "Codex HIGH-001 closure" claims with a note that admission to `is_aggregate_function` is in place but AggregateArg-side literal `Expr::RangeRef` lifting is deferred (consistent with the existing `RT-V1` documented gap at `plan.rs:380-383`).
quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:62:- **Detail:** The entry asserts `**W5-D-12.1 (Codex HIGH-001 closure):** admitted to `is_aggregate_function` so range args bind as `AggregateNameRef`; invariant test in `workbook_runtime.rs::is_aggregate_function_lists_only_registered_aggregates` extended to include SUBTOTAL.` — which describes a real, applied change. But the framing implies the literal-range-arg path is also fixed, when in reality it remains broken (see HIGH-001). The matrix entry has the same overclaim with the assertion `**CLOSES Phase 4.10 V1-260 at 260 registered fns**` and `Range-aware`. The label of "closure" is too strong.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:59:/// roster only contains FormatIds that came from overlays, so this
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:65:    use ql_storage::FormatId;
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:73:        sheet.format_overlay_mut().set(0, 0, FormatId(38)); // not pre-populated; renders as color
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:74:        sheet.format_overlay_mut().set(0, 1, FormatId(46)); // also not pre-populated
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:75:        sheet.format_overlay_mut().set(0, 2, FormatId(9)); // pre-populated "0%"
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:181:- `get`: `Option<FormatId>`.
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:256:`format_id: FormatId`. All four fields round-trip through TOML without
quantbook-engine/docs/audits/2026-05-13-phase-4.5-closing-megaudit-sonnet.md:302:`format_cache: HashMap<FormatId, FormatString>` is stable because
quantbook-engine/docs/audits/2026-05-18-phase-4-11-architecture-codex.md:12:For W5-D-14, choose a round-trip spine rather than minimal import or read-only-full. The first batch should prove this vertical loop: import common cells/formulas/cached values, recover date system and scoped names from OOXML, detect styles/tables/CF/DV even if not all are implemented, recompute through `WorkbookRuntime`, and export a minimal/generated workbook or update formula caches in the original workbook with a visible report. This catches write-side integration bugs early while avoiding a false sense of safety from an importer that silently drops the very metadata Phase 4.11 says must survive where supported.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-architecture-codex.md:42:- Treat direct styles XML as authoritative for `numFmtId`, `cellXfs`, and the style-index to Quantbook `FormatId` map.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-architecture-codex.md:65:Do not roll-own the writer first. A custom writer is the only route to complete control, but Quantbook does not yet store enough OOXML detail to make complete control useful. Without an opaque preservation strategy, a roll-own writer would produce clean but lossy workbooks. With opaque preservation, it becomes a package patcher and XML rewriter, which is a larger project than needed for W5-D-14.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-architecture-codex.md:76:Recommended W5-D-14 scope: round-trip spine with feature inventory. Among the three options, this is closest to "Round-trip slice", but it should include a mandatory OOXML manifest/report scaffold so unsupported metadata is detected from day one.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-architecture-codex.md:233:- `StylesXmlReader`: returns `numFmtId` registrations and `xf` to Quantbook `FormatId` mappings.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:1:# W5-D-15 Audit Findings
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:30:can silently assign the wrong `FormatId` or skip the style as out of range.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:99:silently loses those post-process patches on the later sheet. For W5-D-15
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:136:determinism. Sorting overlays by `(FormatId, row, col)` or assigning XFs by
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:137:sorted `FormatId` would close this.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:155:So umya normally has two cell XFs, not one. The W5-D-15 replacement emits
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:167:The emitted W5-D-15 XFs use `xfId="0"`. OOXML defines `xfId` in `cellXfs`
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:176:(`cell_format.rs:262-278`), so this is not newly introduced by W5-D-15.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:195:The three W5-D-15 E2E tests cover custom, built-in, and dedup for
quantbook-engine/docs/audits/2026-05-18-w5-d-15-codex.md:237:  no overlays does not get the W5-D-15 replacement block.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:439:/// with the SAME FormatId AND the format code string for that id
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:613:    use ql_storage::{FormatId, TableColumn, TableMetadata, TotalsFunction};
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:673:        sheet.format_overlay_mut().set(0, 4, FormatId(14)); // built-in
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:476:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:480:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:84:### MEDIUM-001 — IronCalc divergence on Boolean function_num is undocumented but pinned
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:481:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:90:- **Severity rationale:** Documented divergence is preferable to undocumented behavior; the test pins a real choice between two reference implementations.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:482:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:145:### L-8: `register_defined_names` ignores name canonicalization mismatch — user inputs lower-case `mycell`, engine stores `MYCELL`, on round-trip the imported `<definedName name="MYCELL">` is registered as `MYCELL` (case discarded). Lossy by design but undocumented in the import path.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:523:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:613:quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:245:**Subject:** `GettingData` error collapse is undocumented
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:616:quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-opus.md:50:- LOW-2: undocumented PeerId(0)→PeerId(100) test change.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:879:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:2396:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:900:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:3335:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:917:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4175:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:919:quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:4316:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1327:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:470:### LOW-O-2 — `=` strict-pin on statrs is tighter than IronCalc's, undocumented.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1328:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:599:### LOW-O-9 — `to_logical` accepts text `"true"`/`"false"` (trimmed, ASCII case-fold); divergence from IronCalc text-bool behavior is undocumented.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1335:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:570:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1337:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:580:docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1343:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:991:docs/audits/2026-05-19-phase-5-4-v1-codex.md:2396:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1344:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:995:docs/audits/2026-05-19-phase-5-4-v1-codex.md:3335:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1345:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:999:docs/audits/2026-05-19-phase-5-4-v1-codex.md:4175:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1347:quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1002:docs/audits/2026-05-19-phase-5-4-v1-codex.md:4316:quantbook-engine/docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1864:  1423	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2280:  1423	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2441:   108	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2442:   109	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2446:   113	| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2979:         // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3049: | GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3051: | GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3176: > - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3230: | 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3231: | 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3236: | 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 SHIPPED `c677e244704`** — `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 follow-up: load-time presence-eviction sweep + presence-changed callbacks. Known V1 limitation: presence persists across `.qbook` save/load (Codex 5.6 audit MED-1). |
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3245: > (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3252:    needs magic bytes + version header (Tier D3). Bundle into D-1
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:3253:    tagged-tuple FormatId schema work (next session).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4687:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:228:    // that's the size of the smallest group in a hyphenated UUID.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4688:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:357:            Err(Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4689:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:358:                group: 4,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4690:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:366:            Err(Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4691:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:367:                group: 3,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4692:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:383:            Err(Error(ErrorKind::ParseGroupCount { count: 2 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4693:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:388:            Err(Error(ErrorKind::ParseGroupCount { count: 3 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4694:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:393:            Err(Error(ErrorKind::ParseGroupCount { count: 4 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4695:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:398:            Err(Error(ErrorKind::ParseGroupCount { count: 3 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4696:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:419:            Err(Error(ErrorKind::ParseGroupCount { count: 3 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4697:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:424:            Err(Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4698:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:425:                group: 1,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4699:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:431:        // // (group, found, expecting)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4700:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:435:            Err(Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4701:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:436:                group: 4,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4702:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:475:            Err(Error(ErrorKind::ParseGroupCount { count: 1 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4703:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:493:            Err(Error(ErrorKind::ParseGroupCount { count: 2 }))
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4704:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:498:            Err(Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4705:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/parser.rs:499:                group: 3,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4719:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/external/serde_support.rs:479:                &format!("{}", de::value::Error::custom("UUID parsing failed: invalid group length in group 4: expected 12, found 12")),
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4720:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/external/serde_support.rs:602:                &format!("{}", de::value::Error::custom("UUID parsing failed: invalid group length in group 4: expected 12, found 12")),
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4721:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/external/serde_support.rs:726:                &format!("{}", de::value::Error::custom("UUID parsing failed: invalid group length in group 4: expected 12, found 14")),
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4722:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/external/serde_support.rs:848:                &format!("{}", de::value::Error::custom("UUID parsing failed: invalid group length in group 4: expected 12, found 12")),
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4738:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:206:    let groups = [(0, 8), (9, 13), (14, 18), (19, 23), (24, 36)];
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4739:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:209:    let mut group_idx = 0;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4740:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:211:    while group_idx < 5 {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4741:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:212:        let (start, end) = groups[group_idx];
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4742:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:222:        if group_idx < 4 {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4743:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/fmt.rs:225:        group_idx += 1;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4745:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:21://! formatted as a hex string in five groups. UUIDs are used to assign unique
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4746:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:27://! separated into groups by hyphens.
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4747:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:601:    /// * The first field value represents the first group of (eight) hex
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4748:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:604:    /// * The second field value represents the second group of (four) hex
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4749:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:607:    /// * The third field value represents the third group of (four) hex digits,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4750:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/lib.rs:611:    /// * The last field value represents the last two groups of four and twelve
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4758:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:19:    /// A hyphenated [`Uuid`] didn't contain 5 groups
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4759:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:22:    ParseGroupCount { count: usize },
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4760:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:23:    /// A hyphenated [`Uuid`] had a group that wasn't the right length
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4761:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:26:    ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4762:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:27:        group: usize,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4763:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:70:        let mut group_bounds = [0; 4];
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4764:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:85:                // While we search, also count group breaks
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4765:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:87:                    group_bounds[hyphen_count] = index;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4766:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:108:            // 5 groups (4 hyphen splits).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4767:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:109:            Error(ErrorKind::ParseGroupCount {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4768:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:113:            // There are 5 groups, one of them has an incorrect length
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4769:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:116:                if group_bounds[i] != BLOCK_STARTS[i + 1] - 1 {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4770:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:117:                    return Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4771:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:118:                        group: i,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4772:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:119:                        len: group_bounds[i] - BLOCK_STARTS[i],
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4773:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:125:            // The last group must be too long
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4774:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:126:            Error(ErrorKind::ParseGroupLength {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4775:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:127:                group: 4,
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4776:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:154:            ErrorKind::ParseGroupCount { count } => {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4777:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:155:                write!(f, "invalid group count: expected 5, found {}", count)
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4778:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:157:            ErrorKind::ParseGroupLength { group, len, .. } => {
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4779:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:158:                let expected = [8, 4, 4, 4, 12][group];
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4780:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:161:                    "invalid group length in group {}: expected {}, found {}",
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:4781:/Users/sanzhar/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/uuid-1.23.1/src/error.rs:162:                    group, expected, len
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10913:    11	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:10971:  1423	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11103:     4	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11128:     7	        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:141:?? docs/audits/.codex-w5-d-1-prompt.md
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:867:crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1114:crates/ql-exec/src/workbook_runtime/mod.rs:190:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1267:crates/ql-exec/src/workbook_runtime/validate.rs:436:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1272:crates/ql-exec/src/workbook_runtime/validate.rs:441:    /// W5-D-12 SUBTOTAL closure should have had but didn't, scaled to
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1277:crates/ql-exec/src/workbook_runtime/validate.rs:446:    /// pre-W5-D-13.1 build would fail every one of these with
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1279:crates/ql-exec/src/workbook_runtime/validate.rs:597:    /// **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1284:crates/ql-exec/src/workbook_runtime/validate.rs:602:    /// exactly why the W5-D-12 closure shipped a SUBTOTAL-only fix
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1329:crates/ql-exec/src/workbook_runtime/formats.rs:32:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1338:crates/ql-exec/src/workbook_runtime/formats.rs:66:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1348:crates/ql-exec/src/workbook_runtime/formats.rs:117:    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1366:crates/ql-exec/src/workbook_runtime/formats.rs:135:    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:1634:crates/ql-exec/src/workbook_runtime/error.rs:120:    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:2961:crates/ql-exec/src/workbook_runtime/formats.rs:15://!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:2966:crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:2968:crates/ql-exec/src/workbook_runtime/formats.rs:88:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:2976:crates/ql-exec/src/workbook_runtime/formats.rs:301:        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:3710:crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:4045:crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:4062:crates/ql-exec/src/workbook_runtime/formats.rs:23:use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:4085:crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:4315:    use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5065:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5213:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5218:    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5371://!   `FormatId` (or clear via `None`). Refuses unknown ids
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5372://!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5374://!   through its `FormatId` binding (or General if unbound).
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5380:use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5389:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5398:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5408:        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5423:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5437:        id: Option<FormatId>,
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5445:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5804:crates/ql-exec/src/workbook_runtime/formats.rs:29: -> pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> { :: **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5805:crates/ql-exec/src/workbook_runtime/formats.rs:66: -> pub fn set_cell_format( :: **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5923:crates/ql-exec/src/workbook_runtime/validate.rs:436: -> fn w5_d_13_1_subtotal_named_range_binds_and_evaluates() { :: **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex HIGH-001,
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:5924:crates/ql-exec/src/workbook_runtime/validate.rs:597: -> fn every_range_aware_fn_is_admitted_to_is_aggregate_function() { :: **W5-D-13.1 (Phase 4.10 V1-260 megaudit closure — Codex MEDIUM-003
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7748:    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7754:    UnknownFormatId(u32),
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:7957:    42	use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:8105:   190	    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-18-tier-d1-codex.md:8110:   195	    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-opus-a.md:173:`ctx.locale`; or the `format_cache` keyed by `FormatId` is locale-blind
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:1:# W5-D-14 XLSX Round-Trip Spine Audit - Codex
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:15:  - custom format round-trip: `FormatId(164)` re-imported as `None`.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:33:**Severity rationale:** **Phase 4.11 ship blocker.** Formula text round-trip is an explicit W5-D-14 user-facing contract; the default export path destroys it for formula cells that also carry cached values.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:55:**Recommendation:** Either downgrade W5-D-14 to a lossy NewWorkbook cell-layer exporter in docs/commit messaging, or implement `UpdateOriginal` before claiming round-trip spine closure. Export must honor `UnsupportedPolicy::Strict` and populate `dropped_features` for every modelled or inventoried feature it cannot write.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:65:**Detail:** Defined names are parsed into `WorkbookProperties` but never registered into `Workbook::names()` or sheet scoped name tables. A compiled probe against IronCalc `defined_names_for_unit_test.xlsx` imported `workbook.names().len() == 0`. Table metadata can be inserted/imported, but NewWorkbook export writes no table OOXML; a compiled table probe re-imported with `table_after=false`. Custom `FormatId(164)` round-tripped as `None`. Public rustdoc says "Sheets, cells, formulas, names, tables, formats all loaded," which is not true for names and not true for export.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:69:**Severity rationale:** **Phase 4.11 ship blocker if W5-D-14 claims "round-trip spine closed."** This may be an acceptable follow-up only if the shipped contract is explicitly downgraded.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:117:**Recommendation:** Parse worksheet cell style ids and apply `FormatId`s to the per-sheet overlay. Parse `xf` attributes on both `Start` and `Empty` events, with tests for alignment/protection child elements.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:213:**Detail:** The plan says W5-D-14 ships named ranges, minimal styles, `UpdateOriginal`, feature inventory strict export, semantic round-trip equivalence, and golden fixtures for scoped names/date1904/tables/unsupported features. The implementation and tests do not match that plan.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:215:**Recommendation:** Update the active plan to split "cell-layer NewWorkbook exporter" from "round-trip preservation spine," or move the missing items back into W5-D-14 closure criteria.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:237:**Detail:** The comment says ISO forms will be converted in W5-D-14b, but the current code stores them as text. I did not find a known-gap entry tying this to a later milestone.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-codex.md:289:**Severity rationale:** Edge-case correctness issue; not the main W5-D-14 contract failure.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:1:# Self-audit: W5-D-15 (Phase 4.11 XLSX-4-03 per-cell format APPLICATION)
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:6:FormatId`. Three new E2E tests covering custom-code + built-in +
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:57:  format codes are interned in the FormatTable (W5-D-14d works), but
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:72:  HashMap iteration order. The first FormatId encountered gets
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:80:  digest. Round-trip is semantically correct (FormatId mapping
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:82:- Suggested fix: sort `cellxfs_roster` by `FormatId` before
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:83:  assigning xf indices, OR collect into a `BTreeMap<FormatId,
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:126:- What's wrong: the W5-D-15 commit message claims "Per-cell style
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:178:### L-3: cellxfs_roster sorting by FormatId would make audit-trail clearer
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:214:  None for cells with FormatId::GENERAL semantics.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:216:  FormatId share one cellXf slot — verified by
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:228:  defensive `/>` second pattern from the M-1 closure of W5-D-14.2.3.
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:229:- The Cow-based sheet-name parse from W5-D-14.2.3 isn't touched by
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:249:Forward plan if HIGHs confirmed: ship W5-D-15.1 with:
quantbook-engine/docs/audits/2026-05-18-w5-d-15-self.md:253:- Sort cellxfs_roster by FormatId for byte determinism.
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:379:?? docs/audits/.codex-w5-d-1-prompt.md
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2662:456:            let fid = ql_storage::FormatId(*id);
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:2683:477:                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:3374:crates/ql-storage/src/format_overlay.rs:7://! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4732:crates/ql-exec/src/workbook_runtime.rs:5464:        // SUBTOTAL(9, Sales) = SUM(Sales) = 6. The Codex W5-D-12
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4747:crates/ql-exec/src/workbook_runtime.rs:5625:        // **Empty as of W5-D-13.1** — every range-aware-registered fn
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:4749:crates/ql-exec/src/workbook_runtime.rs:5641:            "W5-D-13.1 invariant: every range-aware fn must be admitted to \
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:6531:crates/ql-exec/src/workbook_runtime.rs:43:use ql_storage::{FormatId, SpillShape, Workbook};
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:7345:395:    use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:7358:408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:7647:395:    use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-18-tier-c1-codex.md:7660:408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:5:**Scope:** Whole-phase adversarial review of the 12-batch closeout arc on `feat/quantbook-engine` through HEAD `5d117724f27` (impl HEAD `517bcab08b7`). Per-batch audits already shipped (24 transcripts: Codex + Opus × W5-D-1..W5-D-12). This pass looks for what the per-batch audits could not see.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:16:**The phase is NOT complete or correct as shipped.** Four HIGH findings — all engine-boundary correctness regressions invisible at the per-batch level because the per-batch audits had no cross-batch view. The most consequential: **31 registered range-aware fns are unreachable through their advertised named-range / range-arg path** (binder admission gap), **3 registered scalar / range-aware fns are unreachable from formula text at all** (lexer regression for 4+letter-prefix-trailing-digit names), and **the W5-D-12 Codex HIGH-001 closure is overclaimed** — the recommended e2e test that would have caught the named-range binder hole was NEVER added even though both Codex W5-D-12 AND Opus W5-D-12 audits told the implementer to add it.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:28:**Subject:** Cross-cutting `is_aggregate_function` admission hole identical in shape to W5-D-12 Codex HIGH-001 but never extended to the rest of the range-aware family.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:32:**Detail:** The binder consults `is_aggregate_function(name)` to decide whether a Function's args bind under `BindContext::AggregateArg` (which lifts a `NameRef → Range` to `ExprPlan::AggregateNameRef`) versus `BindContext::Scalar` (which rejects with `BindError::NamedRangeInScalarContext`). W5-D-12 caught and "fixed" this for SUBTOTAL, but the SAME omission affects every other range-aware fn that is NOT yet in the `is_aggregate_function` enumeration.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:70:**Why the per-batch audits missed it:** W5-D-6 (COVARIANCE), W5-D-7 (XNPV/XIRR), W5-D-11 (PERCENTILE/QUARTILE) all shipped without anyone running the lex+bind+eval pipeline against a named-range arg. Most range-aware fn e2e tests are `assert!(registry.lookup_range_aware(name).is_some())` registry-lookup smoke tests (see `region_mul2_e2e.rs:364, 389, 445, 774, 823`) which prove the symbol is registered but NOT that the binder routes range args to it. The W5-D-12 Codex audit caught the gap for SUBTOTAL specifically; nobody generalized the finding.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:78:4. Codex's recommendation in W5-D-12 HIGH-001 said `add a runtime e2e such as SUBTOTAL(9, Sales) over a named range returning the same value as SUM(Sales)`. That was never done for SUBTOTAL either — see HIGH-4 below.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:138:### HIGH-3 — W5-D-12 Codex HIGH-001 closure is incomplete: the recommended e2e test was never added
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:140:**Subject:** The W5-D-12.1 commit claimed to close Codex HIGH-001 (SUBTOTAL admission gap) but the closure shipped without the recommended end-to-end test, leaving the supposedly-fixed code path unverified.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:142:**Where:** `crates/ql-exec/tests/region_mul2_e2e.rs:779-814` (`e2e_subtotal_scalar_args_dispatch`, `e2e_subtotal_109_normalizes_to_sum`, `e2e_subtotal_invalid_function_num_is_value_error`); `docs/audits/2026-05-17-w5-d-12-codex.md:19-20`; `docs/audits/2026-05-17-w5-d-12-opus.md` HIGH-003.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:144:**Detail:** Codex W5-D-12 HIGH-001 recommendation reads: "Add `\"SUBTOTAL\"` to `is_aggregate_function()`, extend the `is_aggregate_function_lists_only_registered_aggregates` invariant to include it, **and add a runtime e2e such as `SUBTOTAL(9, Sales)` over a named range returning the same value as `SUM(Sales)`**." Opus W5-D-12 HIGH-003 reinforced this: "There is zero end-to-end evidence that SUBTOTAL actually works for ANY input from the engine boundary."
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:146:The W5-D-12.1 closure shipped (a) the `is_aggregate_function` name addition (verified at `plan.rs:487`), (b) the invariant-test extension (verified at `workbook_runtime.rs:5206`), and (c) three e2e tests — but all three use SCALAR data args (`SUBTOTAL(9, 1, 2, 3)`, `SUBTOTAL(109, 10, 20, 30)`, `SUBTOTAL(12, 1, 2, 3)`). NONE of them exercise a named-range arg. The actual binder-admission path that the HIGH-001 fix was supposed to enable is STILL untested.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:156:**Why this is HIGH and not "follow-up MEDIUM":** The audit-discipline rule explicitly says "all closures applied in-commit per the `.1` convention" (per MEMORY.md). The W5-D-12.1 commit message claims it closed HIGH-001. The closure as shipped is materially incomplete — code change without test armor that proves the code change does the thing it claims. The header comment in the `e2e_subtotal_scalar_args_dispatch` test even says "W5-D-12.1 (Codex HIGH-001 closure)" while exercising the wrong code path. **The closure is mislabeled as well as incomplete.**
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:185:**Subject:** The audit discipline rule from MEMORY.md ("parallel Codex + Opus per batch") was followed mechanically across W5-D-1..W5-D-12, but neither auditor (per batch) consistently constructed the lex+parse+bind+eval pipeline for range-args. The two HIGHs above (binder gap, lexer regression) are both caught by a single end-to-end test that the per-batch audit framework didn't require.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:190:- W5-D-11 Opus (PERCENTILE/QUARTILE): the audit comment at line 22 explicitly says "the e2e test verifies case-insensitive dotted-name dispatch" — i.e. registry lookup, NOT actual binder routing.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:191:- W5-D-12 Codex DID identify the binder gap (HIGH-001) but only for SUBTOTAL. The pattern was NOT retrofit-applied to W5-D-6 / W5-D-7 / W5-D-11.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:286:**Recommendation:** No code change required; the divergences are mostly correct. But: add a cross-batch "distribution domain corner table" in `distribution_fns.rs` module docstring summarizing for each distribution: (a) the Microsoft canon, (b) the engine's domain check, (c) any divergences. The W5-D-1.1 HIGH-O-2 closure set the precedent that "module-level canon docs are first-class". Wave 3 has 38 fns shipped without this consolidating table.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:294:**Subject:** The W5-D-12 module block documents "nested SUBTOTAL calls in arg ranges are NOT skipped (engine evaluates args before dispatch — AST not available)". This is a real divergence from Excel canon. There is no test asserting the engine's behavior.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:296:**Where:** `range_fns.rs:1924-1972` (W5-D-12 SUBTOTAL block comment).
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:350:**Detail:** The upstream `to_number_strict` calls `sanitize_f64` which rejects NaN with `ErrorValue::Num`. So `parse_places_arg` cannot receive NaN through the standard coercion chain — the defense is already in place at the boundary. But the W5-D-11.1 closure pattern (added `is_nan()` to `extract_quartile_q`) and the W5-D-12 closure pattern (added `is_nan()` to SUBTOTAL function_num) both added defense-in-depth at the consuming-fn level. Consistency would put the same guard in `parse_places_arg`.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:358:### LOW-2 — Test count drift in matrix entries vs actual test counts (W5-D-11 Opus already flagged; partial fix landed)
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:360:**Subject:** Per the W5-D-11 Opus audit LOW-2, matrix test counts had off-by-one drift (PERCENTILE.INC 15→16, QUARTILE.INC 10→11). The W5-D-12 Codex audit LOW-001 also flagged "SUBTOTAL lists 25 tests, actually 28". Some closures applied; verify the rest didn't drift again.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:420:1. **Math kernel correctness**: All 38 Wave 3 distribution fns and the 22 closeout-batch fns produce correct results on textbook anchors and degrade gracefully on degenerate inputs. The W5-D-1.1, W5-D-4.1, W5-D-5.1, W5-D-7.1, W5-D-8.1, W5-D-11.1, W5-D-12.1 closures all correctly addressed their per-batch audit findings at the code level.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:440:- HIGH-3: add the missing SUBTOTAL named-range e2e test that Codex W5-D-12 HIGH-001 originally recommended.
quantbook-engine/docs/audits/2026-05-17-phase-4-10-megaudit-opus.md:455:Recommend a `W5-D-13` or `V1-260-CLOSEOUT` followup commit pair (one impl, one audit transcript) that addresses HIGH-1 through HIGH-4 before re-claiming "Phase 4.10 V1-260 SHIPPED" in the MASTER-PLAN.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1085:crates/ql-storage/src/format_overlay.rs:41:    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1086:crates/ql-storage/src/format_overlay.rs:47:    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1087:crates/ql-storage/src/format_overlay.rs:53:    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1091:crates/ql-storage/src/format_overlay.rs:74:    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1092:crates/ql-storage/src/format_overlay.rs:81:    pub fn count_refs(&self, id: FormatId) -> usize {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1171:crates/ql-storage/src/format.rs:100:    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1172:crates/ql-storage/src/format.rs:112:    pub fn intern(&mut self, s: &str) -> FormatId {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1173:crates/ql-storage/src/format.rs:129:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1177:crates/ql-storage/src/format.rs:178:    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:1251:crates/ql-exec/src/workbook_runtime.rs:2744:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:4002:   118	    // impt = -[(1+rate)^(period-1)*(pv*rate+pmt)-pmt]
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:4003:   119	    // ipmt = FV(rate, period-1, payment, pv, type) * rate
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6800:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6802:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6836:docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6943:crates/ql-exec/src/workbook_runtime.rs:2769:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7381:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:621:./docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7383:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7394:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:775:./docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7398:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:806:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1601:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7399:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7405:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:815:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2166:docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7466:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1554:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7355:    78	| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7468:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7598:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1601:docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7599:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7681:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:2166:docs/architecture/2026-05-13-dates-times-formats.md:365:When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.
quantbook-engine/docs/audits/2026-05-18-phase-4-11-megaudit-codex.md:106:The W5-D-14.2.3 comment says cell-reference-shaped sheet names including `A1`, `R1C1`, and `XFD1048576` are quoted. The implementation only detects `^[A-Za-z]+\\d+$`, so it catches `A1`, `Sheet1`, and `XFD1048576`, but not `R1C1`.
quantbook-engine/docs/audits/2026-05-17-w5-d-12-codex.md:1:# Codex Audit — W5-D-12 (Phase 4.10 V1-260 sealer: SUBTOTAL)
quantbook-engine/docs/audits/2026-05-17-w5-d-12-codex.md:33:**Detail:** The matrix lists `SUBTOTAL` with 25 tests, but the W5-D-12 block currently contains 28 `subtotal_*` unit tests. `cargo test -p ql-functions subtotal` ran 28 matching unit tests successfully.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:1:# Self-audit: W5-D-14.2 (4 of 9 remaining HIGH closures)
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:65:  a follow-up batch — out of scope for W5-D-14.2.
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:221:both worth closing before declaring W5-D-14.2 final; the MEDIUMs are
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:225:before deciding whether to ship a `W5-D-14.3` closure batch or
quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:226:defer everything to a `W5-D-15` named follow-up.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:381:docs/architecture/crdt-data-model.md:454:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:382:docs/architecture/crdt-data-model.md:624:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:406:docs/audits/2026-05-19-handoff-audit-codex.md:1033:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:407:docs/audits/2026-05-19-handoff-audit-codex.md:1203:   602	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:432:docs/audits/2026-05-19-handoff-audit-codex.md:1898:docs/architecture/crdt-data-model.md:432:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:433:docs/audits/2026-05-19-handoff-audit-codex.md:1920:docs/architecture/crdt-data-model.md:602:   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:435:docs/audits/2026-05-19-handoff-audit-codex.md:2703:   432	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:436:docs/audits/2026-05-19-handoff-audit-codex.md:2865:   594	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:619:docs/audits/2026-05-19-phase-5-1-codex.md:11400:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:620:docs/audits/2026-05-19-phase-5-1-codex.md:11418:  `intern_format` predicts `next_custom_id` before logging (`crates/ql-exec/src/workbook_runtime/formats.rs:51`). Two peers from the same base can both emit `RegisterFormat { id: N, string: different }`. Replay calls `register_at` (`crates/ql-oplog/src/replay.rs:451`), and `register_at` rejects same id/different string as `IdCollision` (`crates/ql-storage/src/format.rs:129`). Cleanest fix: make custom format ids globally unique, e.g. `Builtin(u32) | Custom { peer_id, counter }` or a widened `u128`/UUID. Wire impact: `RegisterFormat.id`, `SetCellFormat.id`, `FormatId(pub u32)`, and persisted qbook/xlsx mapping need a schema bump or compatibility layer.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1006:    16	//! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1379:   124	   needs magic bytes + version header (Tier D3). Bundle into D-1
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1380:   125	   tagged-tuple FormatId schema work (next session).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3612:docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3628:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3747:docs/audits/2026-05-19-handoff-audit-consolidated.md:53:| D-1 | `FormatId` tagged tuple (Phase 5.2.b) | Phase 5.1 audit | Multi-day schema-breaking work; needs its own session + parallel Codex+Opus audit per discipline rule |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3761:docs/audits/2026-05-18-w5-d-15-opus.md:358:  set General format". Not breaking, but worth tracking.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3769:docs/audits/2026-05-17-w5-d-10-opus.md:10:W5-D-10 is **clean and ready to commit**. All 4 functions are mathematically correct, match IronCalc semantics exactly (`erf(y) - erf(x)` for the 2-arg form, strict 1-arg for the three other shapes), use the appropriate statrs API (separate `erf` / `erfc` — not naive `1 - erf(x)`), route through `finite_or_num` defense-in-depth, and propagate errors per the engine's documented coercion divergence (`to_number_strict` accepts Booleans, IronCalc rejects them — same as every other Wave 3 distribution).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3770:docs/audits/2026-05-17-w5-d-10-opus.md:103:### CNI-4 — statrs API: separate `erfc`, not `1 - erf`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3861:docs/audits/.codex-w5-d-11-prompt.md:132:### Sort stability
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3878:docs/audits/2026-05-17-w5-d-1-codex.md:8:No HIGH correctness findings found in the implementation. The four functions use the expected `statrs::distribution::Normal` APIs (`Normal::new`, `cdf`, `pdf`, `inverse_cdf`), enforce the Excel/IronCalc numeric domains, route non-finite statrs outputs through `#NUM!`, and register at scalar tier. Workspace dependency pinning is exact (`=0.18.0`) with `default-features = false`, and `ql-functions` consumes it through `{ workspace = true }`.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3879:docs/audits/2026-05-17-w5-d-1-codex.md:102:- `Normal::new(mean, sd)`, `cdf(x)`, `pdf(x)`, and `inverse_cdf(p)` are the correct `statrs 0.18.0` APIs. `inverse_cdf` would panic outside `[0,1]`, but both inverse functions check the stricter Excel domain `(0,1)` before calling it.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3881:docs/audits/.codex-w5-d-1-prompt.md:32:1. **statrs API verification:** `Normal::new(mean, sd)`, `cdf(x)`, `pdf(x)`, `inverse_cdf(p)`. Verify the impl uses the right methods.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3906:docs/audits/.codex-w5-d-14-audit-prompt.md:20:  - `c0a496e3627` — W5-D-14 scaffolding (deps + public API + types)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3907:docs/audits/.codex-w5-d-14-audit-prompt.md:37:- `src/lib.rs` — public API + import_xlsx_path/bytes +
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3908:docs/audits/.codex-w5-d-14-audit-prompt.md:191:- Public-API rustdoc accuracy.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3920:docs/audits/.codex-w5-d-10-prompt.md:39:1. **statrs API usage**: `erf(f64) -> f64`, `erfc(f64) -> f64`. Both
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:3944:docs/audits/2026-05-17-reference-tier-audit-summary.md:134:| `ROWS`/`COLUMNS` u32 underflow on non-normalized Range | MED-1 | LOW-3 | **MEDIUM** | Codex's framing emphasizes public-API reachability. Take higher. |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4082:docs/audits/2026-05-18-phase-4-11-megaudit-opus-c.md:237:`pub fn import_xlsx_bytes` at `lib.rs:112-290` is 178 lines. It orchestrates 12 distinct phases (W5-D-14b Phase 0 → Phase 4) inline. While each phase is well-commented, the sequential dispatch is logic that doesn't belong at the public API layer — it should live in `read::pipeline::import` or similar so `lib.rs` reads as a thin facade.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4115:docs/audits/2026-05-18-w5-d-14-codex.md:31:**Recommendation:** Use umya's formula-result API that does not clear formulas (`set_formula_result_default` / equivalent), or build a `CellValue` that sets formula and cached raw value without calling the public value setters. Add a tracked test for formula + cached number, bool, text, error, and blank cache.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4116:docs/audits/2026-05-18-w5-d-14-codex.md:77:**Detail:** `Value::Error(e)` is written with `cell.set_value_string(e.sigil())`. That forces an OOXML string cell. A compiled probe re-imported `Value::Error(ErrorValue::DivZero)` as `Value::Text("#DIV/0!")`. The code comment says umya will produce `t="e"`, but the API being called is the string setter; umya has separate typed/error-guessing paths.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4117:docs/audits/2026-05-18-w5-d-14-codex.md:151:**Detail:** `recompute_loaded_workbook` calls `WorkbookRuntime::recompute_all()` directly. It translates returned failures into `FormulaImportFailure`, but if the runtime panics on an adversarial formula or engine bug, the panic propagates through the import API. That contradicts the "BestEffort reports failures and keeps imported cached values" behavior.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4118:docs/audits/2026-05-18-w5-d-14-codex.md:277:**Severity rationale:** This is mostly API/documentation drift while `UpdateOriginal` remains unimplemented.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4119:docs/audits/2026-05-18-w5-d-14-codex.md:285:**Detail:** A probe exporting `Workbook::new()` returned `Ok` and re-imported as a zero-sheet workbook. Excel workbooks normally require at least one sheet, and the current API does not say whether zero-sheet xlsx output is valid or intentionally supported.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4177:docs/audits/2026-05-18-w5-d-14-opus.md:60:### H-1 — Exporter clobbers every formula it writes (umya API misuse)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4178:docs/audits/2026-05-18-w5-d-14-opus.md:147:   verify the exact API (check `umya_spreadsheet::structs::WorkbookProperties::set_date1904`).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4179:docs/audits/2026-05-18-w5-d-14-opus.md:189:   a Table API (`umya_spreadsheet::structs::Table`) — check.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4180:docs/audits/2026-05-18-w5-d-14-opus.md:224:1. Wire `workbook.formats().iter()` into umya's stylesheet API. umya tracks
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4181:docs/audits/2026-05-18-w5-d-14-opus.md:225:   number formats via `StyleSheet::add_number_format` (verify exact API).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4182:docs/audits/2026-05-18-w5-d-14-opus.md:259:**Recommendation:** Use umya's `set_error(sigil)` API
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4183:docs/audits/2026-05-18-w5-d-14-opus.md:270:3. Stop offering `Value::Error` round-trip in the public API contract.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4184:docs/audits/2026-05-18-w5-d-14-opus.md:315:2. **Allow ALIAS registration** in `FormatTable` (a new API that maps a
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4185:docs/audits/2026-05-18-w5-d-14-opus.md:585:- Direct API: `crates/ql-storage/src/workbook.rs:830-853` (`put_formula`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4186:docs/audits/2026-05-18-w5-d-14-opus.md:586:  doc says "formula body WITHOUT the leading `=`" but the API doesn't
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4187:docs/audits/2026-05-18-w5-d-14-opus.md:590:import strips `=` defensively. But the direct API `wb.put_formula(s, 0, 0, "=A1")`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4188:docs/audits/2026-05-18-w5-d-14-opus.md:616:### M-3 — `convert.rs` uses `catch_unwind` when fallible API is available
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4189:docs/audits/2026-05-18-w5-d-14-opus.md:831:public API contains a dead field.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4190:docs/audits/2026-05-18-w5-d-14-opus.md:834:the field until then. Public-API ergonomic.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4191:docs/audits/2026-05-18-w5-d-14-opus.md:836:**Severity rationale:** Minor API hygiene.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4192:docs/audits/2026-05-18-w5-d-14-opus.md:952:**Where:** Public API surface.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4193:docs/audits/2026-05-18-w5-d-14-opus.md:1066:1. **Fix H-1 (formula clobber)** — single-line API order change in the
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4222:docs/audits/2026-05-17-w5-d-1-opus.md:444:**Severity rationale:** MEDIUM. The Cargo.toml comment makes a forward-looking promise that depends on statrs's feature stability. If we ship a Wave 3 cohort and a follow-on `statrs` patch (the project pins `=0.18.0` so this requires a deliberate bump) gates a distribution, the comment becomes a lie. Cheap to harden now.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4223:docs/audits/2026-05-17-w5-d-1-opus.md:474:**Detail:** IronCalc pins `statrs = "0.18.0"` (semver-compatible, allowing 0.18.x patch updates). We pin `=0.18.0` (exact). This is intentional — our project-wide convention is `=X.Y.Z` strict pins for reproducibility — but the module docstring says "Both projects use the `statrs` crate (pinned to 0.18.0 across both)" implying parity. The pins are NOT exactly the same: ours is strict-equal, theirs is caret. If IronCalc upgrades to 0.18.5 and our `=0.18.0` doesn't, behavioral parity drifts the moment statrs ships a behavioral bugfix patch.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4261:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:6802:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4266:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7383:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4267:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7399:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4268:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7468:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4270:docs/audits/2026-05-16-phase-4.10-wave-2-closing-megaudit-codex.md:7599:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4304:docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4337:docs/audits/2026-05-18-w5-d-14-self.md:51:**Recommendation:** Use a different umya API — `Cell::get_cell_value_mut().set_value_and_data_type(...)` with `CellValue::set_error(...)` or equivalent. Verify the round-trip restores `ErrorValue` correctly.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4338:docs/audits/2026-05-18-w5-d-14-self.md:64:**Recommendation:** Add `if workbook.date_system() == DateSystem::Excel1904 { spreadsheet.workbook_mut().set_date1904(true); }` (or equivalent umya API) before write.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4339:docs/audits/2026-05-18-w5-d-14-self.md:76:**Recommendation:** Iterate `workbook.tables().iter()` (if available; see `TableTable::iter()`) and call umya's table-add API for each. umya supports `Worksheet::tables_mut()` / `add_table(Table)`. Verify the round-trip restores `TableMetadata` semantically equivalent to the original.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4340:docs/audits/2026-05-18-w5-d-14-self.md:90:**Recommendation:** Iterate `workbook.names().iter()` and call umya's defined-names API for each workbook-scoped entry. For sheet-scoped: iterate each sheet's `scoped_names()`. Set `localSheetId` on the umya defined-name to match.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4341:docs/audits/2026-05-18-w5-d-14-self.md:106:**Recommendation:** Add a styles-write step to the exporter. umya exposes a styles-add API on the workbook level.
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4342:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:623:./docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4346:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:807:./docs/audits/2026-05-16-phase-4.8.G.3-closing-megaudit-codex.md:1602:docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4348:docs/audits/2026-05-16-phase-4.10-pre-review-codex.md:1556:./docs/audits/2026-05-14-phase-4.6-closing-megaudit-codex.txt:7357:    80	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4483:docs/phase5/entry-plan.md:104:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4814: //! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:5059:-*label* (used in presence and FormatId D-1), not a Loro merge-rule
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:19:HEAD: `2e945454cb5` (docs(phase5): session-end handoff refresh + D-1 starting checklist).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:24:1. Created NEW `docs/phase5/d-1-starting-checklist.md` (268 lines) — fresh-session entry for D-1.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:38:2. `quantbook-engine/docs/phase5/d-1-starting-checklist.md`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:40:4. `quantbook-engine/docs/architecture/crdt-data-model.md` § D-1 (lines 432-475 approximately)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:41:5. `quantbook-engine/docs/known-gaps.md` (look for GAP-C-03, GAP-C-04, GAP-C-05 + D-1 references)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:50:### Tier 2 — d-1-starting-checklist accuracy
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:53:- `crates/ql-storage/src/format.rs` — `pub struct FormatId(pub u32)` at line 20.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:57:- `crates/ql-io-xlsx/src/read/styles_import.rs` — numFmtId → FormatId mapping.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:58:- `crates/ql-io-xlsx/src/write/umya_export.rs` + `cell_styles_xml.rs` — emit cellXfs from FormatId.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:81:- Does the D-1 checklist explain the `LegacyPeer` sentinel constant clearly enough? (It's mentioned but not defined.)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:83:- Is there a clear "stop here, this is a multi-day arc" signal in the D-1 checklist, or could the next Claude end up shipping a half-implementation again?
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:271:2e945454cb5 docs(phase5): session-end handoff refresh + D-1 starting checklist
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:285:  • Verify D-1 checklist code touchpoints
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:294:/bin/zsh -lc "nl -ba quantbook-engine/docs/phase5/d-1-starting-checklist.md | sed -n '1,340p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:297:     2	title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:298:     3	status: DRAFT — entry point for the multi-day D-1 implementation arc
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:301:     6	design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:304:     9	# Phase 5.2 D-1 — fresh-session starting checklist
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:306:    11	D-1 is the last major Phase 5 item before the 5.8 megaudit. Multi-day, schema-breaking. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:310:    15	Change `FormatId` from `pub struct FormatId(pub u32)` to a tagged tuple:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:313:    18	pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:315:    20	    Custom(PeerId, u32),     // peer-allocated custom format ids
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:319:    24	Each peer's allocator increments only its own `Custom` counter; concurrent peers can't collide. Bumps the `.qbook` envelope schema. Backwards-compat: old files with `u32` ids load as `Builtin(n)` if `n ≤ 163`, else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:323:    28	Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:334:    39	  - `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:336:    41	  - `FormatTable::register_at(&mut self, id: FormatId, s: &str)` signature stays; logic updates to handle both variants.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:337:    42	  - `FormatTable::intern(&mut self, s: &str) -> FormatId` — needs peer-id context. Either: (a) add `intern_with_peer(peer: PeerId, s: &str)`; or (b) make FormatTable peer-aware via a `peer_id: PeerId` field set at construction.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:339:    44	  - `FormatTable::iter()` — iterator over `(FormatId, &str)`. Signature stays.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:341:    46	- `crates/ql-storage/src/lib.rs` — re-exports `FormatId`. Stays.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:342:    47	- `crates/ql-storage/src/sheet.rs` — `format_overlay: CellFormatOverlay`. CellFormatOverlay stores `FormatId` directly. Update its `set(row, col, FormatId)` value type (already `FormatId`, but underlying serde / Hash etc. needs reverification).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:348:    53	  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatId, string: String }`. Since FormatId is not currently in ql-oplog (it lives in ql-storage), need to introduce a wire-format type:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:349:    54	    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:352:    57	  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:353:    58	  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:360:    65	  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LegacyPeer, n - 164)`. Need a sentinel `LegacyPeer` constant.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:364:    69	- `crates/ql-io-xlsx/src/read/styles_import.rs` — reads xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:365:    70	- `crates/ql-io-xlsx/src/write/umya_export.rs` + `cell_styles_xml.rs` — emit xlsx numFmtId from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:369:    74	- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:370:    75	- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:374:    79	- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:375:    80	- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:386:    91	- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:388:    93	### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:390:    95	- Add `ql-oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. This is the "destination shape" for Op variants.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:392:    97	- Add `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` (the migration helper).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:393:    98	- Tests: round-trip FormatIdWire through serde JSON.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:394:    99	- Commit: `Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:396:   101	### Step 3: Change `ql-storage::FormatId` to the tagged tuple (2-3 hours)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:402:   107	- Commit: `Phase 5.2 D-1 step 3 — FormatId enum in ql-storage (breaks downstream)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:404:   109	### Step 4: Update `Op::RegisterFormat` / `Op::SetCellFormat` to use FormatIdWire (1-2 hours)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:409:   114	- Commit: `Phase 5.2 D-1 step 4 — Op wire format uses FormatIdWire`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:414:   119	- Old-format loader: detect schema version, migrate `u32` → `FormatId` via legacy mapping.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:416:   121	- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:420:   125	- Flatten `FormatId` → xlsx `numFmtId` on export.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:421:   126	- Inflate xlsx `numFmtId` → `FormatId::Builtin(n)` on import.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:423:   128	- Commit: `Phase 5.2 D-1 step 6 — xlsx numFmtId ↔ FormatId mapping`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:427:   132	- Bundle with D-1 per the entry plan. Add a 4-byte magic header + u32 schema version to `oplog.bin`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:428:   133	- This is the discriminator the loader uses to know whether to apply legacy FormatId migration.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:433:   138	- 2-way Codex + Opus audit of the full D-1 arc. Multi-step schema change is exactly the kind of cycle the audit-discipline rule was written for.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:440:   145	Before starting D-1, verify:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:447:   152	- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:452:   157	- **Loro UndoManager peer-id binding:** if D-1 changes how `FormatTable::peer_id` is set after construction, may interact with the 5.4 V1 audit's set_peer_id silent-clear footgun. The fix at 5.4 V1 made `OpLog::set_peer_id` `&mut self`; if D-1 needs to bump format-allocator peer-id mid-session, plan for the undo-stack clear as a documented side-effect.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:453:   158	- **Tier C2 (BatchCommit depth guard)**: still pending but low priority. Not blocking D-1.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:457:   162	D-1 ships when:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:459:   164	1. `FormatId` is the tagged tuple in `ql-storage`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:462:   167	4. xlsx round-trip preserves all FormatId variants correctly.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:465:   170	7. `v1-exit-packet.md` updated to reflect D-1 ✅ shipped, leaving 5.3 + 5.5 V2 V2/V3 + 5.7 + 5.8 as remaining Phase 5 items.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:467:   172	After D-1 ships, Phase 5 is **~80% complete** (5.1 + 5.2 + 5.4 + 5.5 V1 + 5.5 V2 V1 + 5.6 + 5.6 V2 + Tier D3). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 WebSocket transport, 5.7 IDE vertical slice, 5.8 megaudit.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:472:     3	status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. D-1 (FormatId tagged tuple, multi-day) is the only remaining major Phase 5 item before the 5.8 megaudit.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:476:     7	successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:489:    20	Phase 5.2 D-1 (FormatId tagged tuple, schema-breaking, multi-day)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:510:    41	| 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:623:   154	| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ⏳ PENDING (multi-day, schema-breaking, queued for next session) |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:685:   216	- **Phase 5.2 D-1 — FormatId tagged tuple.** Schema-breaking
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:686:   217	  change to `FormatId` (currently `u32` newtype) → tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:687:   218	  `{ Builtin(u32), Custom(PeerId, u32) }`. Touches `ql-storage`,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:692:   223	  `Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`. Wire-format
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:707:   238	  1 week. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:725:   256	  with D-1 schema work (it's the discriminator the loader uses to
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:738:     3	status: SUPERSEDED-BY-EXIT-PACKET — Phase 5 V1 COMPLETE 2026-05-19. See `docs/phase5/v1-exit-packet.md` for the canonical session record. D-1 (multi-day) is the only remaining major Phase 5 item; see `docs/phase5/d-1-starting-checklist.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:741:     6	successor: docs/phase5/v1-exit-packet.md (closeout) + docs/phase5/d-1-starting-checklist.md (D-1 entry)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:795:    60	> - Tier D3 (oplog.bin magic bytes + version header): pending — bundle into D-1 schema work.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:849:   114	| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:850:   115	| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:863:   128	> (oplog.bin schema versioning) remains open — bundle into D-1 schema
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:870:   135	   needs magic bytes + version header (Tier D3). Bundle into D-1
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:871:   136	   tagged-tuple FormatId schema work (next session).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1041:   271	- `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1049:   279	ships as a usable surface for Phase 5.7 IDE integration. D-1 is the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1053:/bin/zsh -lc "rg -n \"D-1|Format-id|FormatId|tagged|LegacyPeer|5\\.6|sweep_presence|V2 V1|D1\\.a|4222|93210e|2e945\" quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1068:quantbook-engine/docs/architecture/crdt-data-model.md:542:### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1069:quantbook-engine/docs/architecture/crdt-data-model.md:558:**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1071:quantbook-engine/docs/architecture/crdt-data-model.md:562:pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1072:quantbook-engine/docs/architecture/crdt-data-model.md:574:  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1073:quantbook-engine/docs/architecture/crdt-data-model.md:579:  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1074:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1076:quantbook-engine/docs/architecture/crdt-data-model.md:710:5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1077:quantbook-engine/docs/architecture/crdt-data-model.md:711:   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1082:quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:349:- **Scope:** Quantbook's `FormatId` only models numFmt. v2 extends
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1083:quantbook-engine/docs/known-gaps.md:81:| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1084:quantbook-engine/docs/known-gaps.md:83:| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1172:    81	| GAP-F-07 | `FormatTable` GC / compaction not implemented. Sparse format-overlay (Phase 4.5.D) interns format strings into a workbook-level `FormatTable`. When cells change format, the old `FormatId` entry is NOT garbage-collected. Long-lived workbooks that cycle through many formats grow the table. **Decision (W5-68 design doc § 7.5):** deferred — typical workbooks don't cycle formats; a compaction pass lands in Phase 4.10 or on explicit user request. | Filed at design time (W5-68); no code yet | Engine | Engine Phase 4.10 |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1174:    83	| GAP-F-12 | `WorkbookRuntime::format_cache` can stale if `Workbook::formats_mut()` mutates the FormatTable AFTER `read_display` has cached the General fallback for a (then-unknown) id. The cache is keyed by `FormatId`; cache entries stay correct as long as mutations go through `WorkbookRuntime::intern_format` (the documented append-before-mutate path). Direct low-level mutation through `formats_mut()` (loader / tests only) on a live runtime is the pathological sequence. Analogous to the `WorkbookEnv` date-system staleness caveat documented at `Workbook::set_date_system`. **Decision (W5-84):** documented in the `read_display` docstring; cache-invalidation API deferred until profiling shows a real-world hit. | Filed W5-84 mega-audit closure (Codex MEDIUM-2) | Engine | Engine Phase 4.10 polish or earlier if IDE forces it |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1595:   542	### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1611:   558	**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1615:   562	pub enum FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1617:   564	    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1627:   574	  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1632:   579	  `FormatId::Builtin(n)` if `n ≤ 163` or
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:1633:   580	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2005:/bin/zsh -lc "rg -n \"ql-collab|CollabSession|Presence|Undo|Transport|Phase 5|5\\.4|5\\.5|5\\.6|4222|v1-exit|D-1|FormatId|Loopback|sweep_presence\" quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/MASTER-PLAN.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2011:quantbook-engine/docs/MASTER-PLAN.md:503:    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2012:quantbook-engine/docs/MASTER-PLAN.md:505:11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2013:quantbook-engine/docs/MASTER-PLAN.md:508:    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2031:/bin/zsh -lc 'rg -n "docs/audits/2026-05-19|phase-5|tier-d1|exit-packet|d-1-starting" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2059:quantbook-engine/docs/phase5/entry-plan.md:3:status: SUPERSEDED-BY-EXIT-PACKET — Phase 5 V1 COMPLETE 2026-05-19. See `docs/phase5/v1-exit-packet.md` for the canonical session record. D-1 (multi-day) is the only remaining major Phase 5 item; see `docs/phase5/d-1-starting-checklist.md`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2061:quantbook-engine/docs/phase5/entry-plan.md:6:successor: docs/phase5/v1-exit-packet.md (closeout) + docs/phase5/d-1-starting-checklist.md (D-1 entry)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2065:quantbook-engine/docs/phase5/d-1-starting-checklist.md:5:predecessor: docs/phase5/v1-exit-packet.md
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2066:quantbook-engine/docs/phase5/d-1-starting-checklist.md:11:D-1 is the last major Phase 5 item before the 5.8 megaudit. Multi-day, schema-breaking. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2067:quantbook-engine/docs/phase5/d-1-starting-checklist.md:152:- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2068:quantbook-engine/docs/phase5/d-1-starting-checklist.md:170:7. `v1-exit-packet.md` updated to reflect D-1 ✅ shipped, leaving 5.3 + 5.5 V2 V2/V3 + 5.7 + 5.8 as remaining Phase 5 items.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2071:quantbook-engine/docs/phase5/v1-exit-packet.md:7:successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2099:    17	/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2102:    20	pub struct FormatId(pub u32);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2104:    22	impl FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2106:    24	    pub const GENERAL: FormatId = FormatId(0);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2145:    63	/// Cells reference a `FormatId`; the table resolves the id back to a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2150:    68	    by_id: HashMap<FormatId, String>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2152:    70	    by_string: HashMap<String, FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2165:    83	            let fid = FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2182:   100	    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2194:   112	    pub fn intern(&mut self, s: &str) -> FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2198:   116	        let id = FormatId(self.next_custom_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2211:   129	    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2260:   178	    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2271:   189	        id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2278:   196	        existing_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2279:   197	        attempted_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2290:   208	        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2291:   209	        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2292:   210	        assert_eq!(t.lookup(FormatId(49)), Some("@"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2299:   217	        assert_eq!(t.lookup(FormatId(12)), None);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2306:   224	        assert_eq!(id, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2315:   233	        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2340:   258	        t.register_at(FormatId(200), "REPLAY").unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2341:   259	        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2569:    31	    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:2985:/bin/zsh -lc 'rg -n "FormatOverlay|format_overlay|FormatId|formats|WORKBOOK_SCHEMA_VERSION|u32" quantbook-engine/crates/ql-io/src/qbook_format.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3013:568:/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3039:1513:                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3041:1551:        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3051:1586:                    ql_storage::FormatId(entry.id),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3065:2950:            loaded.formats().lookup(ql_storage::FormatId(14)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3076:2980:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3079:2996:            .set(0, 0, ql_storage::FormatId(14)); // m/d/yyyy
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3081:3000:            .set(3, 5, ql_storage::FormatId(4)); // #,##0.00
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3083:3004:            .set(10, 20, ql_storage::FormatId(49)); // @
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3085:3010:            Some(ql_storage::FormatId(14))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3087:3014:            Some(ql_storage::FormatId(4))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3089:3019:            Some(ql_storage::FormatId(49))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3097:3070:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3098:3076:                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3109:3160:        // at an unregistered FormatId must surface as
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3401:   568	/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3607:     4	//! entry render via `FormatId::GENERAL` semantics.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3610:     7	//! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3616:    13	//! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3626:    23	use crate::format::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3628:    25	/// Sparse per-sheet `(row, col) → FormatId` overlay.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3630:    27	/// Cells absent from the overlay render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3633:    30	    entries: HashMap<(RowId, ColId), FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3643:    40	    /// `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3644:    41	    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3650:    47	    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3655:    52	    /// `FormatId::GENERAL`. Returns the cleared id, if any.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3656:    53	    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3675:    72	    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3677:    74	    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3684:    81	    pub fn count_refs(&self, id: FormatId) -> usize {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3709:   106	        let id = FormatId(14);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3717:   114	        assert_eq!(o.set(5, 3, FormatId(14)), None);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3718:   115	        assert_eq!(o.set(5, 3, FormatId(15)), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3719:   116	        assert_eq!(o.get(5, 3), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3725:   122	        o.set(5, 3, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3726:   123	        assert_eq!(o.clear(5, 3), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3739:   136	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3740:   137	        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3748:   145	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3749:   146	        o.set(0, 1, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3750:   147	        o.set(0, 2, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3751:   148	        assert_eq!(o.count_refs(FormatId(14)), 2);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3752:   149	        assert_eq!(o.count_refs(FormatId(15)), 1);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3753:   150	        assert_eq!(o.count_refs(FormatId(999)), 0);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3759:   156	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3760:   157	        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3768:   165	        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3769:   166	        o.set(0, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3770:   167	        o.set(1, 0, FormatId(16));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3771:   168	        assert_eq!(o.get(0, 0), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3772:   169	        assert_eq!(o.get(0, 1), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3773:   170	        assert_eq!(o.get(1, 0), Some(FormatId(16)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3784:     4	//! **W5-D-14d scope**: format-code registration only. Per-cell
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3792:    12	//! `FormatId(N)` directly without re-allocating ids.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3796:    16	use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3845:    65	        let id = FormatId(entry.num_fmt_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3846:    66	        // **W5-D-14.1 (audit HIGH-8 closure):** real-world xlsx files
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3935:   155	        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3937:   157	            wb.formats().lookup(FormatId(165)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3944:   164	        // **W5-D-14.1 (audit HIGH-8 closure):** LibreOffice's
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:3971:   191	            .register_at(FormatId(164), "yyyy-mm-dd")
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4003:   223	        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4012:     3	//! Post-W5-D-15.2 / megaudit closure, this module covers:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4031:    22	use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4034:    25	/// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4061:    52	    /// **W5-D-15:** inject `s="N"` into the cell's opening tag.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4114:   105	    // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4119:   110	    // **W5-D-15:** build a `FormatId → xf_index` dedup map. Index 0
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4123:   114	    // **W5-D-15.2 (separate-Opus M-4 closure):** pre-compute the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4125:   116	    // function of the set of FormatIds, not of which sheet first
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4126:   117	    // touched them. Sort by `FormatId` for byte determinism — the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4127:   118	    // per-sheet intra-sort from W5-D-15.1 fixes intra-sheet but
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4130:   121	    let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4139:   130	    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4140:   131	    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4163:   154	        // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior code
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4189:   180	                            // **W5-D-14.1 (audit HIGH-1 closure — phase
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4208:   199	                            // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4265:   256	                            // **W5-D-14.1 (audit HIGH-6 closure):** umya
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4283:   274	        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4289:   280	        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4294:   285	        // (FormatId, row, col) so the roster is byte-stable across
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4299:   290	        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4306:   297	                None => continue, // unreachable — roster pre-populated for all FormatIds
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4320:   311	    // **W5-D-14.1 unified post-process pass:** apply workarounds for
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4352:    14	//!   `FormatId` (or clear via `None`). Refuses unknown ids
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4353:    15	//!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4355:    17	//!   through its `FormatId` binding (or General if unbound).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4361:    23	use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4370:    32	    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4379:    41	    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4389:    51	        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4404:    66	    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4418:    80	        id: Option<FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4426:    88	                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4455:   117	    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4473:   135	    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4492:   154	            .unwrap_or(FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4524:   186	    use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4540:   202	            assert_eq!(id, FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4542:   204	            assert_eq!(id2, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4594:   256	            rt.set_cell_format(s, 3, 5, Some(FormatId(14))).unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4612:quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:12://! - Per-cell styles (FormatId → numFmtId via cellXfs).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4622:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:873:/// **W5-D-14.2 HIGH-5 closure:** inject `<numFmts>` into styles.xml.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4632:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:958:/// default `<cellXfs>` block with one that enumerates every FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4675:quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:73:/// `numFmtId` reference for W5-D-14d; alignment / borders / fonts
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4729:quantbook-engine/crates/ql-io-xlsx/src/lib.rs:231:    // **W5-D-14d — Phase 2d**: import styles. Parses `xl/styles.xml`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4736:quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:12://! - Per-cell styles (FormatId → numFmtId via cellXfs).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4746:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:873:/// **W5-D-14.2 HIGH-5 closure:** inject `<numFmts>` into styles.xml.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4756:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:958:/// default `<cellXfs>` block with one that enumerates every FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4797:   231	    // **W5-D-14d — Phase 2d**: import styles. Parses `xl/styles.xml`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4801:   235	    // for round-trip). Per-cell application landed in W5-D-15 — see
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4807:   241	    // **W5-D-15 — Phase 2d-bis (XLSX-4-03 per-cell format closure):**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4839:   273	            let fmt_id = ql_storage::FormatId(xf.num_fmt_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4844:   278	    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4858:     3	//! **W5-D-15 (Phase 4.11 XLSX-4-03 closure — per-cell format
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:4866:    11	//! caller maps that to a `FormatId` via
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5048:     3	//! **Focus for W5-D-14d**: minimal but useful — extract custom number
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5082:    37	//! application (W5-D-14 follow-up via worksheet XML scan) can map
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5118:    73	/// `numFmtId` reference for W5-D-14d; alignment / borders / fonts
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5165:   120	                // **W5-D-15.1 (self-audit H-2 root-cause closure):**
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5229:   184	    // **W5-D-15.1 (self-audit H-2 closure):** the OOXML schema
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5282:   362	    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5319:   399	/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5320:   400	/// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5328:   408	    cellxfs_roster: &[FormatId],
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5390:   470	        // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5404:   873	/// **W5-D-14.2 HIGH-5 closure:** inject `<numFmts>` into styles.xml.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5436:   905	    // **W5-D-14.2.3 (separate-Opus M-1 closure):** check the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5488:   957	/// **W5-D-15 (XLSX-4-03 per-cell format closure):** replace umya's
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5489:   958	/// default `<cellXfs>` block with one that enumerates every FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5496:   965	    cellxfs_roster: &[FormatId],
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5808:/bin/zsh -lc 'rg -n "RegisterFormat|SetCellFormat|FormatId|FormatRejected|FormatNotRegistered|format" quantbook-engine/crates/ql-oplog/src/replay.rs quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/crates/ql-oplog/src/lib.rs quantbook-engine/crates/ql-oplog/src/log.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5835:quantbook-engine/crates/ql-oplog/src/replay.rs:502:            let fid = ql_storage::FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5841:quantbook-engine/crates/ql-oplog/src/replay.rs:523:                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5849:quantbook-engine/crates/ql-oplog/src/replay.rs:1355:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5852:quantbook-engine/crates/ql-oplog/src/replay.rs:1375:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5863:quantbook-engine/crates/ql-oplog/src/replay.rs:1426:            Some(ql_storage::FormatId(200))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5882:quantbook-engine/crates/ql-oplog/src/replay.rs:1521:            Some(ql_storage::FormatId(14))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:5965:    17	//! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6047:/bin/zsh -lc "rg -n \"FormatId|FIRST_CUSTOM_FORMAT_ID|RegisterFormat|SetCellFormat|FormatRejected|FormatNotRegistered|UnknownFormatId|MalformedFormat|format_overlay|cell_xfs|num_fmt_id|numFmtId\" quantbook-engine/crates --glob '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6062:quantbook-engine/crates/ql-oplog/src/replay.rs:502:            let fid = ql_storage::FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6067:quantbook-engine/crates/ql-oplog/src/replay.rs:523:                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6072:quantbook-engine/crates/ql-oplog/src/replay.rs:1355:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6074:quantbook-engine/crates/ql-oplog/src/replay.rs:1375:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6083:quantbook-engine/crates/ql-oplog/src/replay.rs:1426:            Some(ql_storage::FormatId(200))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6097:quantbook-engine/crates/ql-oplog/src/replay.rs:1521:            Some(ql_storage::FormatId(14))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6112:quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:193:                    .register_at(ql_storage::FormatId(*id), string.as_str())
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6115:quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:206:                            .set(*row, *col, ql_storage::FormatId(*raw_id));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6122:quantbook-engine/crates/ql-storage/src/sheet.rs:31:    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6130:quantbook-engine/crates/ql-storage/src/format_overlay.rs:4://! entry render via `FormatId::GENERAL` semantics.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6131:quantbook-engine/crates/ql-storage/src/format_overlay.rs:7://! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6132:quantbook-engine/crates/ql-storage/src/format_overlay.rs:13://! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6133:quantbook-engine/crates/ql-storage/src/format_overlay.rs:23:use crate::format::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6134:quantbook-engine/crates/ql-storage/src/format_overlay.rs:25:/// Sparse per-sheet `(row, col) → FormatId` overlay.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6135:quantbook-engine/crates/ql-storage/src/format_overlay.rs:27:/// Cells absent from the overlay render via `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6136:quantbook-engine/crates/ql-storage/src/format_overlay.rs:30:    entries: HashMap<(RowId, ColId), FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6137:quantbook-engine/crates/ql-storage/src/format_overlay.rs:40:    /// `FormatId::GENERAL`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6138:quantbook-engine/crates/ql-storage/src/format_overlay.rs:41:    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6139:quantbook-engine/crates/ql-storage/src/format_overlay.rs:47:    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6140:quantbook-engine/crates/ql-storage/src/format_overlay.rs:52:    /// `FormatId::GENERAL`. Returns the cleared id, if any.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6141:quantbook-engine/crates/ql-storage/src/format_overlay.rs:53:    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6142:quantbook-engine/crates/ql-storage/src/format_overlay.rs:72:    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6143:quantbook-engine/crates/ql-storage/src/format_overlay.rs:74:    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6144:quantbook-engine/crates/ql-storage/src/format_overlay.rs:81:    pub fn count_refs(&self, id: FormatId) -> usize {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6145:quantbook-engine/crates/ql-storage/src/format_overlay.rs:106:        let id = FormatId(14);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6146:quantbook-engine/crates/ql-storage/src/format_overlay.rs:114:        assert_eq!(o.set(5, 3, FormatId(14)), None);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6147:quantbook-engine/crates/ql-storage/src/format_overlay.rs:115:        assert_eq!(o.set(5, 3, FormatId(15)), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6148:quantbook-engine/crates/ql-storage/src/format_overlay.rs:116:        assert_eq!(o.get(5, 3), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6149:quantbook-engine/crates/ql-storage/src/format_overlay.rs:122:        o.set(5, 3, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6150:quantbook-engine/crates/ql-storage/src/format_overlay.rs:123:        assert_eq!(o.clear(5, 3), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6151:quantbook-engine/crates/ql-storage/src/format_overlay.rs:136:        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6152:quantbook-engine/crates/ql-storage/src/format_overlay.rs:137:        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6153:quantbook-engine/crates/ql-storage/src/format_overlay.rs:145:        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6154:quantbook-engine/crates/ql-storage/src/format_overlay.rs:146:        o.set(0, 1, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6155:quantbook-engine/crates/ql-storage/src/format_overlay.rs:147:        o.set(0, 2, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6156:quantbook-engine/crates/ql-storage/src/format_overlay.rs:148:        assert_eq!(o.count_refs(FormatId(14)), 2);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6157:quantbook-engine/crates/ql-storage/src/format_overlay.rs:149:        assert_eq!(o.count_refs(FormatId(15)), 1);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6158:quantbook-engine/crates/ql-storage/src/format_overlay.rs:150:        assert_eq!(o.count_refs(FormatId(999)), 0);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6159:quantbook-engine/crates/ql-storage/src/format_overlay.rs:156:        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6160:quantbook-engine/crates/ql-storage/src/format_overlay.rs:157:        o.set(1, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6161:quantbook-engine/crates/ql-storage/src/format_overlay.rs:165:        o.set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6162:quantbook-engine/crates/ql-storage/src/format_overlay.rs:166:        o.set(0, 1, FormatId(15));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6163:quantbook-engine/crates/ql-storage/src/format_overlay.rs:167:        o.set(1, 0, FormatId(16));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6164:quantbook-engine/crates/ql-storage/src/format_overlay.rs:168:        assert_eq!(o.get(0, 0), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6165:quantbook-engine/crates/ql-storage/src/format_overlay.rs:169:        assert_eq!(o.get(0, 1), Some(FormatId(15)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6166:quantbook-engine/crates/ql-storage/src/format_overlay.rs:170:        assert_eq!(o.get(1, 0), Some(FormatId(16)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6167:quantbook-engine/crates/ql-storage/src/format.rs:17:/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6168:quantbook-engine/crates/ql-storage/src/format.rs:20:pub struct FormatId(pub u32);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6169:quantbook-engine/crates/ql-storage/src/format.rs:22:impl FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6170:quantbook-engine/crates/ql-storage/src/format.rs:24:    pub const GENERAL: FormatId = FormatId(0);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6172:quantbook-engine/crates/ql-storage/src/format.rs:63:/// Cells reference a `FormatId`; the table resolves the id back to a
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6173:quantbook-engine/crates/ql-storage/src/format.rs:68:    by_id: HashMap<FormatId, String>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6174:quantbook-engine/crates/ql-storage/src/format.rs:70:    by_string: HashMap<String, FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6177:quantbook-engine/crates/ql-storage/src/format.rs:83:            let fid = FormatId(*id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6178:quantbook-engine/crates/ql-storage/src/format.rs:100:    pub fn lookup(&self, id: FormatId) -> Option<&str> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6181:quantbook-engine/crates/ql-storage/src/format.rs:112:    pub fn intern(&mut self, s: &str) -> FormatId {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6182:quantbook-engine/crates/ql-storage/src/format.rs:116:        let id = FormatId(self.next_custom_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6184:quantbook-engine/crates/ql-storage/src/format.rs:129:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6185:quantbook-engine/crates/ql-storage/src/format.rs:178:    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6186:quantbook-engine/crates/ql-storage/src/format.rs:189:        id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6187:quantbook-engine/crates/ql-storage/src/format.rs:196:        existing_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6188:quantbook-engine/crates/ql-storage/src/format.rs:197:        attempted_id: FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6189:quantbook-engine/crates/ql-storage/src/format.rs:208:        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6190:quantbook-engine/crates/ql-storage/src/format.rs:209:        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6191:quantbook-engine/crates/ql-storage/src/format.rs:210:        assert_eq!(t.lookup(FormatId(49)), Some("@"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6192:quantbook-engine/crates/ql-storage/src/format.rs:217:        assert_eq!(t.lookup(FormatId(12)), None);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6193:quantbook-engine/crates/ql-storage/src/format.rs:224:        assert_eq!(id, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6194:quantbook-engine/crates/ql-storage/src/format.rs:233:        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6197:quantbook-engine/crates/ql-storage/src/format.rs:258:        t.register_at(FormatId(200), "REPLAY").unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6198:quantbook-engine/crates/ql-storage/src/format.rs:259:        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6199:quantbook-engine/crates/ql-storage/src/format.rs:262:        assert_eq!(next, FormatId(201));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6200:quantbook-engine/crates/ql-storage/src/format.rs:268:        t.register_at(FormatId(0), "General").unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6201:quantbook-engine/crates/ql-storage/src/format.rs:269:        assert!(t.register_at(FormatId(0), "General").is_ok());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6202:quantbook-engine/crates/ql-storage/src/format.rs:275:        let err = t.register_at(FormatId(0), "DIFFERENT").unwrap_err();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6203:quantbook-engine/crates/ql-storage/src/format.rs:283:        let err = t.register_at(FormatId(200), "General").unwrap_err();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6205:quantbook-engine/crates/ql-storage/src/format.rs:319:        assert_eq!(FormatId::GENERAL, FormatId(0));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6207:quantbook-engine/crates/ql-storage/src/lib.rs:36:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6209:quantbook-engine/crates/ql-storage/src/lib.rs:69:        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6210:quantbook-engine/crates/ql-storage/src/lib.rs:70:        assert_eq!(wb.formats().lookup(FormatId(14)), Some("m/d/yyyy"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6211:quantbook-engine/crates/ql-storage/src/lib.rs:77:        assert_eq!(id, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6216:quantbook-engine/crates/ql-storage/src/lib.rs:96:        s.format_overlay_mut().set(3, 5, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6217:quantbook-engine/crates/ql-storage/src/lib.rs:97:        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId(14)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6223:quantbook-engine/crates/ql-collab/src/peer.rs:17://! - Phase 5 D-1 (pending) — the `FormatId::Custom { peer, counter }`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6230:quantbook-engine/crates/ql-io/src/qbook_format.rs:568:/// overlay — `(row, col)` ↦ FormatId. Sorted by `(row, col)` on save
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6237:quantbook-engine/crates/ql-io/src/qbook_format.rs:1513:                .register_at(ql_storage::FormatId(entry.id), entry.string.as_str())
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6240:quantbook-engine/crates/ql-io/src/qbook_format.rs:1551:        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6247:quantbook-engine/crates/ql-io/src/qbook_format.rs:1586:                    ql_storage::FormatId(entry.id),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6248:quantbook-engine/crates/ql-io/src/qbook_format.rs:2950:            loaded.formats().lookup(ql_storage::FormatId(14)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6251:quantbook-engine/crates/ql-io/src/qbook_format.rs:2980:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6254:quantbook-engine/crates/ql-io/src/qbook_format.rs:2996:            .set(0, 0, ql_storage::FormatId(14)); // m/d/yyyy
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6256:quantbook-engine/crates/ql-io/src/qbook_format.rs:3000:            .set(3, 5, ql_storage::FormatId(4)); // #,##0.00
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6258:quantbook-engine/crates/ql-io/src/qbook_format.rs:3004:            .set(10, 20, ql_storage::FormatId(49)); // @
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6260:quantbook-engine/crates/ql-io/src/qbook_format.rs:3010:            Some(ql_storage::FormatId(14))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6262:quantbook-engine/crates/ql-io/src/qbook_format.rs:3014:            Some(ql_storage::FormatId(4))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6264:quantbook-engine/crates/ql-io/src/qbook_format.rs:3019:            Some(ql_storage::FormatId(49))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6269:quantbook-engine/crates/ql-io/src/qbook_format.rs:3070:            loaded.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6271:quantbook-engine/crates/ql-io/src/qbook_format.rs:3076:                loaded.formats().lookup(ql_storage::FormatId(id)).is_none(),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6282:quantbook-engine/crates/ql-io/src/qbook_format.rs:3160:        // at an unregistered FormatId must surface as
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6292:quantbook-engine/crates/ql-io-xlsx/src/lib.rs:273:            let fmt_id = ql_storage::FormatId(xf.num_fmt_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6294:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:9:use ql_storage::{FormatId, NamedTarget, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6299:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:334:    let fmt_date = ql_storage::FormatId(14); // built-in
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6327:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:155:        r.workbook.formats().lookup(ql_storage::FormatId(164))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6329:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:160:    // has FormatId(164). On EXPORT, the umya post-process emits
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6331:quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:12://! - Per-cell styles (FormatId → numFmtId via cellXfs).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6333:quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs:11://! caller maps that to a `FormatId` via
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6342:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:306:    // **W5-D-14.2 (HIGH-5 closure):** custom format codes (numFmtId >= 164)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6343:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:308:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6344:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6345:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6346:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:828:    // re-import, ending up at the same (row, col) with a FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6347:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:830:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6348:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6350:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6351:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:865:    // Cell at (0, 0) still references that FormatId via the overlay.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6353:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6354:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:870:        "expected (0,0) to have the custom FormatId after round-trip"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6355:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:882:    use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6356:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:889:    let builtin = FormatId(14);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6359:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:910:        Some(FormatId(14)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6360:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:919:    // **W5-D-15:** two cells sharing the same FormatId should reuse
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6367:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:972:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6370:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6371:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1011:    // contributing different FormatIds in different orders, the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6372:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1012:    // `<cellXfs>` roster MUST be ordered by FormatId, not by
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6373:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1013:    // sheet-encounter order. Sort by FormatId via BTreeSet pre-walk.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6374:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    // Sheet 0 contributes formats in c, b order (greater FormatIds first).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6378:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1057:    // Re-import must still resolve each cell to its original FormatId,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6383:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1073:    // match the FormatId order (a, b, c) regardless of which sheet
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6388:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1093:        "cellXfs not sorted by FormatId (M-4 regression): positions A={}, B={}, C={}",
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6398:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1599:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6402:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1628:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6403:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1644:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6408:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1686:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6414:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:22:use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6415:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:110:    // **W5-D-15:** build a `FormatId → xf_index` dedup map. Index 0
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6417:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:116:    // function of the set of FormatIds, not of which sheet first
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6418:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:117:    // touched them. Sort by `FormatId` for byte determinism — the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6419:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:121:    let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6421:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:130:    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6422:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:131:    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6424:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:285:        // (FormatId, row, col) so the roster is byte-stable across
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6425:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:290:        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6427:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:297:                None => continue, // unreachable — roster pre-populated for all FormatIds
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6429:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:408:    cellxfs_roster: &[FormatId],
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6432:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:958:/// default `<cellXfs>` block with one that enumerates every FormatId
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6435:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:965:    cellxfs_roster: &[FormatId],
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6439:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:59:/// roster only contains FormatIds that came from overlays, so this
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6440:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:65:    use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6441:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:73:        sheet.format_overlay_mut().set(0, 0, FormatId(38)); // not pre-populated; renders as color
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6442:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:74:        sheet.format_overlay_mut().set(0, 1, FormatId(46)); // also not pre-populated
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6443:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:75:        sheet.format_overlay_mut().set(0, 2, FormatId(9)); // pre-populated "0%"
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6457:quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:73:/// `numFmtId` reference for W5-D-14d; alignment / borders / fonts
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6492:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:439:/// with the SAME FormatId AND the format code string for that id
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6495:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:613:    use ql_storage::{FormatId, TableColumn, TableMetadata, TotalsFunction};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6500:quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:673:        sheet.format_overlay_mut().set(0, 4, FormatId(14)); // built-in
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6506:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:12://! `FormatId(N)` directly without re-allocating ids.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6507:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:16:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6516:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:65:        let id = FormatId(entry.num_fmt_id);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6526:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:155:        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6527:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:157:            wb.formats().lookup(FormatId(165)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6531:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:191:            .register_at(FormatId(164), "yyyy-mm-dd")
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6536:quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:223:        assert_eq!(wb.formats().lookup(FormatId(164)), Some("yyyy-mm-dd"));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6537:quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:42:use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6538:quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:153:    /// by `FormatId`. `read_display` populates on-demand from
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6540:quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:158:    format_cache: std::collections::HashMap<FormatId, FormatString>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6541:quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:24:use ql_storage::{FormatId, NamedTarget, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6543:quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:395:    use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6544:quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:408:        rt.set_cell_format(0, 0, 0, Some(FormatId(14))).unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6546:quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:444:        Some(FormatId(14)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6549:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:14://!   `FormatId` (or clear via `None`). Refuses unknown ids
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6550:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:15://!   (`RuntimeError::UnknownFormatId`).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6551:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:17://!   through its `FormatId` binding (or General if unbound).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6552:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:23:use ql_storage::FormatId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6554:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:32:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6555:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:41:    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6557:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:51:        let id = FormatId(self.workbook.formats().next_custom_id());
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6559:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:66:    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6563:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:80:        id: Option<FormatId>,
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6564:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:88:                return Err(RuntimeError::UnknownFormatId(fid.0));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6567:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:117:    /// its `FormatId` binding (or `General` if unbound). Returns the
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6568:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:135:    /// `format_cache` is keyed by `FormatId` and populated on first
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6570:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:154:            .unwrap_or(FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6571:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:186:    use ql_storage::{FormatId, Workbook};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6572:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:202:            assert_eq!(id, FormatId::GENERAL);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6573:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:204:            assert_eq!(id2, FormatId(2));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6580:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:256:            rt.set_cell_format(s, 3, 5, Some(FormatId(14))).unwrap();
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6582:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:261:            Some(FormatId(14))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6585:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:278:            .set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6588:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:299:            .set_cell_format(s, 0, 0, Some(FormatId(9999)))
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6589:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:301:        assert!(matches!(err, RuntimeError::UnknownFormatId(9999)));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6590:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:313:        // No overlay entry → FormatId::GENERAL → integer renders without decimal.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6592:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:326:            .set(0, 0, FormatId(14)); // m/d/yyyy
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6594:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:376:            .set(0, 0, FormatId(14));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6596:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:390:            .set(0, 0, FormatId(49)); // @
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6597:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:413:        let custom_id = FormatId(ql_storage::FIRST_CUSTOM_FORMAT_ID);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6599:quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:120:    /// `Some(FormatId)` referencing an id that hasn't been registered
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6602:quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:126:    UnknownFormatId(u32),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6645:quantbook-engine/docs/phase5/d-1-starting-checklist.md:148:- [ ] `cargo test --workspace` reports **4222** passed.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6646:quantbook-engine/docs/phase5/d-1-starting-checklist.md:149:- [ ] `cargo fmt --all -- --check` clean.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6647:quantbook-engine/docs/phase5/d-1-starting-checklist.md:150:- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6658:quantbook-engine/docs/audits/2026-05-17-w5-d-10-opus.md:6:Workspace gates run by auditor: `cargo build --workspace` ok, `cargo clippy --workspace --all-targets -- -D warnings` clean, `cargo fmt -- --check` clean, all 24 new unit tests pass, registry count test passes (253), coverage tests pass (3/3), `e2e_erf_erfc_through_dispatcher` passes.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:6690:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7109:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:11:The single most serious finding: **`HIGH-001` — three of the four newly-added e2e tests are FAILING in the working tree** (`e2e_subtotal_sum_range_dispatch`, `e2e_subtotal_average_range_dispatch`, `e2e_subtotal_109_equivalent_to_sum_range`). They were labelled "W5-D-12.1 Codex HIGH-001 closure" in their comments, but the underlying closure is **incomplete** — adding `"SUBTOTAL"` to `is_aggregate_function` is necessary but NOT sufficient. Literal `Expr::RangeRef` is rejected by the binder unconditionally outside `BindContext::ReferenceArg`, including in `BindContext::AggregateArg`. The author was aware of this limitation (workbook_runtime.rs line 11875 explicitly notes `"Literal SUM(A1:A3) over a Range needs aggregate-arg binding which v1 routes via named ranges only"`), yet committed tests that exercise exactly the unsupported path. As a result `cargo test --workspace` fails — this is not a fly-by issue.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7110:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:25:  - `cargo test --workspace`:
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7111:quantbook-engine/docs/audits/2026-05-17-w5-d-12-opus.md:191:1. **First**: Revert OR rewrite the 3 failing e2e tests to use a path that actually binds (cell-args list, OR named-range setup via WorkbookRuntime). Re-run `cargo test --workspace` to a clean green.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:7112:quantbook-engine/docs/audits/2026-05-17-w5-d-1-codex.md:30:- Local statrs source: `~/.cargo/registry/src/.../statrs-0.18.0/src/distribution/normal.rs`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:8188:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-self.md:11:Gates passing: 4101 workspace tests, cargo fmt, cargo clippy
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10812:quantbook-engine/docs/phase5/v1-exit-packet.md:223:  `Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`. Wire-format
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10813:quantbook-engine/docs/phase5/d-1-starting-checklist.md:24:Each peer's allocator increments only its own `Custom` counter; concurrent peers can't collide. Bumps the `.qbook` envelope schema. Backwards-compat: old files with `u32` ids load as `Builtin(n)` if `n ≤ 163`, else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10814:quantbook-engine/docs/phase5/d-1-starting-checklist.md:40:  - `pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164` → either remove or repurpose.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10815:quantbook-engine/docs/phase5/d-1-starting-checklist.md:65:  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LegacyPeer, n - 164)`. Need a sentinel `LegacyPeer` constant.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10816:quantbook-engine/docs/phase5/d-1-starting-checklist.md:69:- `crates/ql-io-xlsx/src/read/styles_import.rs` — reads xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10817:quantbook-engine/crates/ql-storage/src/lib.rs:36:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10819:quantbook-engine/docs/architecture/crdt-data-model.md:580:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10824:quantbook-engine/crates/ql-storage/src/format.rs:233:        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10828:quantbook-engine/docs/phase4/exit-packet.md:70:- `ql-storage::{Workbook, Sheet, FormatTable, FormatId, NameTable, NamedTarget, TableTable, TableMetadata, CellFormatOverlay, FIRST_CUSTOM_FORMAT_ID}`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10831:quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:413:        let custom_id = FormatId(ql_storage::FIRST_CUSTOM_FORMAT_ID);
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10832:quantbook-engine/docs/audits/2026-05-18-w5-d-14-2-opus.md:153:### L-12: `intern("0%")` (built-in code at id 9) called by user-side: collides with built-in. The `FIRST_CUSTOM_FORMAT_ID >= 164` filter at line 229 skips it. If `FormatTable::intern` happens to return an id < 164, no export emission. That assumes `intern` always returns ≥ 164 for never-seen codes; let me trust the storage-side test coverage.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10833:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:10562:docs/architecture/crdt-data-model.md:492:  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10840:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1071:   470	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10841:quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:2739:   468	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10842:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:22:use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10855:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:308:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10856:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10857:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10858:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:830:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10859:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10860:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10861:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10864:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:972:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10865:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10866:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1599:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10868:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1628:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10869:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1644:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10871:quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1686:        Some(FormatId(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10876:quantbook-engine/docs/audits/2026-05-18-phase-4-12-megaudit-opus-c.md:592:| `FormatTable`, `FormatId`, `FormatTableError`, `FIRST_CUSTOM_FORMAT_ID` | Stable. `#[non_exhaustive]` on `FormatTableError`. |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10878:quantbook-engine/docs/audits/2026-05-15-phase-4.9-design-review-codex.md:1711:crates/ql-storage/src/lib.rs:26:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10887:quantbook-engine/docs/audits/2026-05-19-phase-5-1-codex.md:4303:   233	        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10906:quantbook-engine/docs/phase5/d-1-starting-checklist.md:139:- Verify clean-checkout `cargo check` (don't trust pre-commit hook gates alone — the index-padding race struck twice this session).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10907:quantbook-engine/docs/phase5/d-1-starting-checklist.md:156:- **Index-padding race:** struck 3 times this session. Mitigation: never `--no-verify`; re-stage + retry on `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Large-file edits trigger it most.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10919:quantbook-engine/docs/audits/2026-05-17-w5-d-1-opus.md:466:**Severity rationale:** LOW. Cosmetic; tests still pass either way. But aligning with `git_index_padding_race` memory ("cargo fmt × git add race corrupts staged blob") — these unrelated fmt churns are exactly the kind of thing that fails precommit hooks and needs a re-stage.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:10968:quantbook-engine/crates/ql-collab/src/session.rs:162:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11115:quantbook-engine/crates/ql-collab/src/session.rs:1752:        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11236:quantbook-engine/docs/phase5/d-1-starting-checklist.md:58:  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11237:quantbook-engine/docs/phase5/d-1-starting-checklist.md:69:- `crates/ql-io-xlsx/src/read/styles_import.rs` — reads xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11238:quantbook-engine/docs/phase5/d-1-starting-checklist.md:157:- **Loro UndoManager peer-id binding:** if D-1 changes how `FormatTable::peer_id` is set after construction, may interact with the 5.4 V1 audit's set_peer_id silent-clear footgun. The fix at 5.4 V1 made `OpLog::set_peer_id` `&mut self`; if D-1 needs to bump format-allocator peer-id mid-session, plan for the undo-stack clear as a documented side-effect.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11245:quantbook-engine/docs/phase5/entry-plan.md:114:| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11246:quantbook-engine/docs/phase5/entry-plan.md:115:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold shipped `66a571b30af` (PeerId + CollabSession + Transport); D-2 / D-3 / D-4 closures shipped (`1ca19e2fa37` / `e71312d4bcd` / `2f217a2067a`); 5.2.b PeerId → LoroDoc wiring shipped `ef056f50bee`; D-1 (FormatId tagged tuple, schema-breaking) pending. |
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11475:  → Verify D-1 checklist code touchpoints
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11480:The touchpoint sweep confirms the named D-1 files mostly exist, but the xlsx write helper named in the checklist does not: the `cellXfs` injection lives inside `write/umya_export.rs`, while `cell_styles_xml.rs` is under `read/`. I’m also checking referenced commits so the handoff doesn’t send the next window to missing SHAs.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11484:2e945454cb5 docs(phase5): session-end handoff refresh + D-1 starting checklist
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11501:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:532:docs/audits/2026-05-19-handoff-audit-consolidated.md:70:options (Phase 5.4 undo, 5.5 transport, 5.6 presence) if D-1 feels
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11508:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:544:docs/audits/2026-05-19-phase-5-1-consolidated.md:168:   - 4 post-audit decisions added (D-1 format-id, D-2 add-
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11510:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:546:docs/audits/2026-05-19-phase-5-1-consolidated.md:189:2. The 4 audit-locked design decisions (D-1 through D-4) must
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11515:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:582:docs/audits/2026-05-19-phase-5-2-b-opus.md:63:Net: the wiring itself is sound. Bulk of issues are documentation/test-coverage-strength concerns, not correctness bugs. MED-1 + MED-2 + MED-3 are the highest-leverage fixes.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11521:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:621:docs/audits/2026-05-19-handoff-audit-codex.md:50:Read `docs/architecture/crdt-data-model.md`. The 4 audit-locked decisions D-1, D-2, D-3, D-4 are documented in sections. Verify whether each is marked with its shipped status + commit hash. D-2/D-3/D-4 are shipped (see commit list above); D-1 is pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11526:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:626:docs/audits/2026-05-19-handoff-audit-codex.md:452:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11552:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:652:docs/audits/2026-05-19-handoff-audit-codex.md:1788:/bin/zsh -lc "rg -n \"pending|DRAFT|not yet started|Next: Tier D2|Tier D2|Phase 5|5\\.2|66a571b30af|4160|4149|D-1|D-2|D-3|D-4|audit pending\" docs/phase5/entry-plan.md docs/architecture/crdt-data-model.md docs/MASTER-PLAN.md docs/PHASE-4-V2-BACKLOG.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11554:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:654:docs/audits/2026-05-19-handoff-audit-codex.md:1817:docs/phase5/entry-plan.md:3:status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11591:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:691:docs/audits/2026-05-19-handoff-audit-codex.md:3332:     3	status: ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (`66a571b30af`); D-2/D-3/D-4 shipped; D-1 (FormatId tagged tuple) pending.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11603:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:703:docs/audits/2026-05-19-handoff-audit-codex.md:4147:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11605:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:705:docs/audits/2026-05-19-handoff-audit-codex.md:4153:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11607:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:707:docs/audits/2026-05-19-handoff-audit-codex.md:4172:- MEDIUM, T2, `docs/phase5/entry-plan.md:3`: at requested commit `66a571b30af`, status was stale `DRAFT`; current HEAD fixed it. Recommended status: `ACTIVE — Phase 5.1 design AUDIT-CLOSED (2026-05-19); Phase 5.2.a scaffold SHIPPED (66a571b30af); D-2/D-3/D-4 shipped; D-1 FormatId tagged tuple + oplog.bin version header pending.`
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11609:quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:709:docs/audits/2026-05-19-handoff-audit-codex.md:4178:- MEDIUM, T3, `docs/architecture/crdt-data-model.md:432`, `:480`, `:504`, `:539`: current HEAD has the D-1/D-2/D-3/D-4 status markers. At `66a571b30af`, D-2/D-3/D-4 were missing shipped markers; `055bb7f3e0c` fixed this.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11695:/bin/zsh -lc 'rg -o "`[0-9a-f]{10,12}`|[0-9a-f]{10,12}" quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed '"'s/.*://; s/"'`//g'"' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11703:/bin/zsh -lc "setopt NO_NOMATCH; rg -o '[0-9a-f]{10,12}' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*://' | sort -u | while read sha; do if git cat-file -e \""'$sha''^{commit}" 2>/dev/null; then echo "OK $sha"; else echo "MISSING $sha"; fi; done' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11793:  ✓ Verify D-1 checklist code touchpoints
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11839:   710	5. **Format id collision** — **CLOSED in 5.1 by D-1** (above).
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11840:   711	   `FormatId` switches from `u32` to a tagged tuple
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11841:   712	   (Builtin | Custom(peer_id, counter)) in Phase 5.2. Schema
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11944:/bin/zsh -lc "rg -o 'docs/audits/[A-Za-z0-9_./{}*,-]+' quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/docs/architecture/crdt-data-model.md quantbook-engine/docs/known-gaps.md quantbook-engine/docs/PHASE-4-V2-BACKLOG.md quantbook-engine/docs/MASTER-PLAN.md | sed 's/.*:docs/docs/' | sort -u" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12126:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:147) says latest HEAD is `93210e43567`, but actual HEAD is `2e945454cb5`. Fix the pre-flight line and add `2e945454cb5` to the relevant handoff commit inventory.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12127:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:70) references `crates/ql-io-xlsx/src/write/cell_styles_xml.rs`, which does not exist. Fix to point at `write/umya_export.rs` for export `cellXfs`, plus `read/styles_xml.rs`, `read/cell_styles_xml.rs`, and `src/lib.rs:231-275` for import mapping.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12129:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12133:- [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:3), [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:3), and [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:11) overstate D-1 as the only/last major Phase 5 item. Fix to “next major 5.2 item”; 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 remain.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12135:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:65) mentions `LegacyPeer` but never defines its value or owning module. Add the exact sentinel constant proposal, e.g. `pub const LEGACY_PEER_ID: PeerId = PeerId(0)` or another explicit reserved value.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12136:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:148) lists bare cargo commands. `docs/process/audit-protocol.md` has the `mac zsh -lc 'export PATH=...'` pattern at lines 195-203; link it or inline it.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12137:- Index-padding incident counts conflict: [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:184) says 2, [line 265](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:265) says 3, and [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:139) says twice. Pick one count and list all incidents.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12154:- Core D-1 code touchpoints exist: `FormatId`, `Op::RegisterFormat`, `format_overlay`, qbook schema/overlay encoding, xlsx import/export logic, and runtime format APIs.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12160:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:147) says latest HEAD is `93210e43567`, but actual HEAD is `2e945454cb5`. Fix the pre-flight line and add `2e945454cb5` to the relevant handoff commit inventory.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12161:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:70) references `crates/ql-io-xlsx/src/write/cell_styles_xml.rs`, which does not exist. Fix to point at `write/umya_export.rs` for export `cellXfs`, plus `read/styles_xml.rs`, `read/cell_styles_xml.rs`, and `src/lib.rs:231-275` for import mapping.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12163:- [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:710) says “Format id collision — CLOSED in 5.1 by D-1” while [D-1 itself](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:544) is pending. Fix wording to “design resolved; implementation pending.”
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12167:- [entry-plan.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/entry-plan.md:3), [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:3), and [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:11) overstate D-1 as the only/last major Phase 5 item. Fix to “next major 5.2 item”; 5.3, 5.5 V2 V2/V3, 5.7, and 5.8 remain.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12169:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:65) mentions `LegacyPeer` but never defines its value or owning module. Add the exact sentinel constant proposal, e.g. `pub const LEGACY_PEER_ID: PeerId = PeerId(0)` or another explicit reserved value.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12170:- [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:148) lists bare cargo commands. `docs/process/audit-protocol.md` has the `mac zsh -lc 'export PATH=...'` pattern at lines 195-203; link it or inline it.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12171:- Index-padding incident counts conflict: [v1-exit-packet.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:184) says 2, [line 265](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/v1-exit-packet.md:265) says 3, and [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:139) says twice. Pick one count and list all incidents.
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:12188:- Core D-1 code touchpoints exist: `FormatId`, `Op::RegisterFormat`, `format_overlay`, qbook schema/overlay encoding, xlsx import/export logic, and runtime format APIs.

codex
The first pass confirms the dependency direction is intact in Cargo manifests: `ql-oplog` does not depend on `ql-collab`, while `ql-collab` still depends on `ql-oplog`. I’m now narrowing the searches to code-only path breakage and the current `wire` surface.
  ✓ Inspect commit diff, Cargo dependency edges, and relevant module docs
  → Search for broken public paths and stale references
  • Run targeted ql-oplog peer tests and inspect wire readiness
  • Produce severity-ranked verdict in requested format
exec
/bin/zsh -lc "rg -n \"ql_collab::PeerId|ql_oplog::PeerId|crate::PeerId|PeerId\" quantbook-engine/crates/ql-oplog/src quantbook-engine/crates/ql-collab/src -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:62://! - **Phase 5.2 D-1 step 1 (2026-05-19):** `PeerId` moved from
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-collab/src/lib.rs:64://!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
quantbook-engine/crates/ql-collab/src/lib.rs:65://!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
quantbook-engine/crates/ql-collab/src/lib.rs:66://!   external callers using `ql_collab::PeerId` keep working.
quantbook-engine/crates/ql-collab/src/lib.rs:73:pub use ql_oplog::PeerId;
quantbook-engine/crates/ql-oplog/src/peer.rs:3://! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
quantbook-engine/crates/ql-oplog/src/peer.rs:4://! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
quantbook-engine/crates/ql-oplog/src/peer.rs:7://! re-exports `ql_oplog::PeerId` to keep its public surface stable.
quantbook-engine/crates/ql-oplog/src/peer.rs:9://! `PeerId` is a thin newtype around `u64` matching Loro's native peer-id
quantbook-engine/crates/ql-oplog/src/peer.rs:19://!   `ql_collab::PeerId` for back-compat.
quantbook-engine/crates/ql-oplog/src/peer.rs:23://! - Phase 5 D-1 (in progress) — the `FormatId::Custom(PeerId, u32)`
quantbook-engine/crates/ql-oplog/src/peer.rs:37:pub struct PeerId(pub u64);
quantbook-engine/crates/ql-oplog/src/peer.rs:39:impl PeerId {
quantbook-engine/crates/ql-oplog/src/peer.rs:40:    /// Construct a `PeerId` from the raw u64.
quantbook-engine/crates/ql-oplog/src/peer.rs:52:impl From<u64> for PeerId {
quantbook-engine/crates/ql-oplog/src/peer.rs:58:impl From<PeerId> for u64 {
quantbook-engine/crates/ql-oplog/src/peer.rs:59:    fn from(p: PeerId) -> Self {
quantbook-engine/crates/ql-oplog/src/peer.rs:64:impl std::fmt::Display for PeerId {
quantbook-engine/crates/ql-oplog/src/peer.rs:73:    use super::PeerId;
quantbook-engine/crates/ql-oplog/src/peer.rs:77:        let p = PeerId::new(0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-oplog/src/peer.rs:80:        assert_eq!(PeerId::from(0xdead_beef_cafe_babe_u64), p);
quantbook-engine/crates/ql-oplog/src/peer.rs:85:        let p = PeerId::new(0x1234);
quantbook-engine/crates/ql-oplog/src/peer.rs:92:        let a = PeerId::new(42);
quantbook-engine/crates/ql-oplog/src/peer.rs:93:        let b = PeerId::new(42);
quantbook-engine/crates/ql-oplog/src/peer.rs:94:        let c = PeerId::new(43);
quantbook-engine/crates/ql-oplog/src/peer.rs:97:        let mut set: HashSet<PeerId> = HashSet::new();
quantbook-engine/crates/ql-collab/src/transport.rs:152:/// let session_a = CollabSession::new(PeerId::new(1))?;
quantbook-engine/crates/ql-collab/src/transport.rs:153:/// let session_b = CollabSession::new(PeerId::new(2))?;
quantbook-engine/crates/ql-collab/src/presence.rs:43://! another by sharing the same `PeerId`) is undefined behavior
quantbook-engine/crates/ql-collab/src/presence.rs:58:use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/presence.rs:142:    /// back into a `PeerId`. Indicates that another producer wrote
quantbook-engine/crates/ql-collab/src/presence.rs:153:/// Format a `PeerId` as its presence-map key.
quantbook-engine/crates/ql-collab/src/presence.rs:158:pub(crate) fn peer_key(peer: PeerId) -> String {
quantbook-engine/crates/ql-collab/src/presence.rs:162:/// Parse a presence-map key back into a `PeerId`.
quantbook-engine/crates/ql-collab/src/presence.rs:166:pub(crate) fn parse_peer_key(key: &str) -> Result<PeerId, PresenceError> {
quantbook-engine/crates/ql-collab/src/presence.rs:171:    Ok(PeerId::new(raw))
quantbook-engine/crates/ql-collab/src/presence.rs:218:        let p = PeerId::new(0x1234_5678_9abc_def0);
quantbook-engine/crates/ql-oplog/src/lib.rs:48:pub use peer::PeerId;
quantbook-engine/crates/ql-collab/src/session.rs:52:use ql_oplog::{Op, OpLog, OpLogError, PeerId, PRESENCE_COMMIT_ORIGIN};
quantbook-engine/crates/ql-collab/src/session.rs:115:/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
quantbook-engine/crates/ql-collab/src/session.rs:126:    peer_id: PeerId,
quantbook-engine/crates/ql-collab/src/session.rs:161:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/crates/ql-collab/src/session.rs:163:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:191:    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/crates/ql-collab/src/session.rs:192:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:205:    pub fn peer_id(&self) -> PeerId {
quantbook-engine/crates/ql-collab/src/session.rs:376:    /// Uses the session's `PeerId` as the map key (16-hex
quantbook-engine/crates/ql-collab/src/session.rs:391:    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:602:    /// if a key in the map can't be parsed as a `PeerId` (only
quantbook-engine/crates/ql-collab/src/session.rs:605:    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:701:        let s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:702:        assert_eq!(s.peer_id(), PeerId::new(1));
quantbook-engine/crates/ql-collab/src/session.rs:709:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:722:        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:732:        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:733:        assert_eq!(reborn.peer_id(), PeerId::new(2));
quantbook-engine/crates/ql-collab/src/session.rs:740:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:748:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:751:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:765:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:774:        // Regression: prior to Phase 5.2.b the PeerId was stored on
quantbook-engine/crates/ql-collab/src/session.rs:777:        // per-doc peer id. After 5.2.b the configured PeerId MUST
quantbook-engine/crates/ql-collab/src/session.rs:779:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:786:        // The origin session writes ops under PeerId(11). The reborn
quantbook-engine/crates/ql-collab/src/session.rs:787:        // session imports the snapshot but uses its own PeerId(22)
quantbook-engine/crates/ql-collab/src/session.rs:790:        // the reborn's configured PeerId.
quantbook-engine/crates/ql-collab/src/session.rs:796:        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:805:        let mut reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:820:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:822:        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
quantbook-engine/crates/ql-collab/src/session.rs:836:        let read = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:839:        assert_eq!(peers, vec![PeerId::new(7)]);
quantbook-engine/crates/ql-collab/src/session.rs:844:        let read2 = s.peer_presence(PeerId::new(7)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:850:        assert_eq!(s.peer_presence(PeerId::new(7)).unwrap(), None);
quantbook-engine/crates/ql-collab/src/session.rs:860:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:863:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:868:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:878:        let a = peer_a.peer_presence(PeerId::new(0x0a)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:880:        let b = peer_a.peer_presence(PeerId::new(0x0b)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:885:        assert_eq!(peers, vec![PeerId::new(0x0a), PeerId::new(0x0b)]);
quantbook-engine/crates/ql-collab/src/session.rs:895:            let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:897:            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:899:            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:934:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:937:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:942:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:945:            peer_b.peer_presence(PeerId::new(0xaa)).unwrap().is_some(),
quantbook-engine/crates/ql-collab/src/session.rs:955:            peer_b.peer_presence(PeerId::new(0xaa)).unwrap(),
quantbook-engine/crates/ql-collab/src/session.rs:965:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1010:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1031:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1071:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1089:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1126:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1147:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1149:        assert_eq!(guard.peer_id(), PeerId::new(7), "Deref reads work");
quantbook-engine/crates/ql-collab/src/session.rs:1162:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1196:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1208:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1230:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1244:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1254:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1274:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1298:        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1304:        let reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1322:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1325:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1328:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1359:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1369:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1378:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1389:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1396:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1405:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1428:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1432:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1453:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1456:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1458:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1483:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1510:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1514:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1541:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1544:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1572:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1598:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1622:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1625:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1626:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1657:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1676:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1689:        assert_eq!(s.peer_presence(PeerId::new(1)).unwrap(), None);
quantbook-engine/crates/ql-collab/src/session.rs:1690:        assert_eq!(s.peer_presence(PeerId::new(2)).unwrap(), None);
quantbook-engine/crates/ql-collab/src/session.rs:1702:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1714:        let mut origin = CollabSession::new(PeerId::new(0xa)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1720:        let mut reborn = CollabSession::from_snapshot(PeerId::new(0xa), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1739:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1751:        // PeerId(u64::MAX) is Loro's reserved sentinel; both
quantbook-engine/crates/ql-collab/src/session.rs:1753:        let result = CollabSession::new(PeerId::new(u64::MAX));
quantbook-engine/crates/ql-collab/src/session.rs:1759:        let origin = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1761:        let result = CollabSession::from_snapshot(PeerId::new(u64::MAX), &bytes);
quantbook-engine/crates/ql-oplog/src/log.rs:154:    /// to wire its stable `PeerId` through to Loro so concurrent
quantbook-engine/crates/ql-oplog/src/log.rs:202:    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the

exec
/bin/zsh -lc 'find quantbook-engine/crates/ql-oplog/src/wire -maxdepth 2 -type f -print | sort' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
find: quantbook-engine/crates/ql-oplog/src/wire: No such file or directory

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/crates/ql-oplog/src/wire/mod.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 1 in 0ms:
sed: quantbook-engine/crates/ql-oplog/src/wire/mod.rs: No such file or directory

exec
/bin/zsh -lc "rg -n \"ql_collab::peer::PeerId|ql_collab::peer|pub use ql_collab::peer|use ql_collab::\\{["'^'"\\n}]*peer|crate::peer::PeerId|super::peer::PeerId|mod peer|pub mod peer\" quantbook-engine/crates quantbook-engine/tests quantbook-engine/examples quantbook-engine/benches -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 2 in 0ms:
rg: quantbook-engine/tests: No such file or directory (os error 2)
rg: quantbook-engine/examples: No such file or directory (os error 2)
rg: quantbook-engine/benches: No such file or directory (os error 2)
quantbook-engine/crates/ql-oplog/src/lib.rs:41:pub mod peer;
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/crates/ql-oplog/src/op.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
    /// `Workbook::rename_sheet`. Carries `old_name` for replay-time
    /// validation (snapshot-vs-replay reconciliation: if the snapshot
    /// already has the new name, replay no-ops gracefully when current
    /// canonical matches the new name). Per design doc § 3.1, the
    /// producer-side runtime rewrites all stored formula text BEFORE
    /// emitting this op (and emits `Op::PutFormula` ops for each
    /// rewritten cell in the same BatchCommit), so replay-on-top-of-
    /// snapshot OR replay-from-empty both produce correct state.
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
    RegisterFormat { id: u32, string: String },

    /// Set or clear a cell's format id. Mirrors
    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
    /// (when `id` is `None`). The id MUST resolve in the workbook's
    /// `FormatTable` at replay time; an unknown id surfaces as
    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
    SetCellFormat {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        /// `None` ⇒ clear the overlay entry (cell falls back to General).
        /// `Some(id)` ⇒ bind the cell to that format id.
        id: Option<u32>,
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
    /// no cell mutations, no formula re-bind).
    ///
    /// Unknown wire values (forward-compat) → `ReplayError::UnknownReferenceMode`
    /// per design § 4.9.J. The serde representation rejects unknowns at
    /// deserialize time via the standard enum-of-unit-variants path.
    SetReferenceMode { mode: ReferenceModeWire },

    /// **W5-146 (Phase 4.9.J):** workbook-scope locale change.
    /// Serialized as a short string `"en"` / `"de"` / `"fr"`. Mirrors
    /// the qbook envelope's `LocaleWire` (W5-145 / qbook v7). Unknown
    /// wire values surface `ReplayError::UnknownLocale` per design

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/crates/ql-oplog/src/log.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! `OpLog` — Loro-backed append-only operation log.
//!
//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
//! JSON-encoded strings inside a single Loro `LoroList` container named
//! `"ops"`. Each `OpLog::append` call serializes the `Op`, pushes a string
//! into the list, and commits the Loro doc.
//!
//! ## Why JSON-in-Loro
//!
//! Per Round 7 architectural lock T1-D05, Loro is reserved for the op log
//! layer. Phase 2A.3.a aims for minimum viable scaffolding — full CRDT
//! semantics (LoroMap-per-op with typed fields) is reserved for Phase 5+
//! when inter-peer merging becomes load-bearing. The JSON layer is
//! invisible to callers: they see typed `Op` values via `iter`.
//!
//! ## Persistence
//!
//! `export_bytes` produces a `Vec<u8>` via `ExportMode::Snapshot`. The
//! resulting blob includes the full state plus history; suitable for
//! `oplog.bin` on-disk persistence (Phase 2A.3.c).
//!
//! `import_bytes` reconstructs an `OpLog` from such a blob. The reader
//! probes the `"ops"` LoroList; if absent (or the wrong shape), the
//! import returns `OpLogError::SchemaMismatch`.

use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};

use crate::error::OpLogError;
use crate::op::Op;

/// The Loro container name our ops live under. Hard-coded; Phase 5+
/// CRDT-level refactoring may add more containers (versions, peer state,
/// etc.) but `"ops"` is reserved.
const OPS_CONTAINER: &str = "ops";

/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
/// ephemeral presence map (cursor + selection + typing indicator).
/// Per the audit-closed Phase 5.1 design at
/// `docs/architecture/crdt-data-model.md` § Presence container.
/// Keys are peer-id strings; values are opaque JSON blobs (the
/// typed `PresenceState` encoding lives in `ql_collab::presence`).
const PRESENCE_CONTAINER: &str = "presence";

/// **Phase 5.4 V1 (2026-05-19):** commit-origin tag for presence
/// writes. `ql_collab::CollabSession` wires this to Loro's
/// `UndoManager::add_exclude_origin_prefix` so cursor movements
/// don't pollute the undo stack. Exported as `pub` so the higher-
/// layer (ql-collab) can reference the same string constant.
///
/// **Reserved-namespace convention:** trailing `":"` so the prefix
/// `presence:` only matches deliberately-namespaced origins (e.g.
/// a future `presence:typing` would also be excluded; an
/// independent `"presence-foo"` origin would NOT). This protects
/// against accidental over-exclusion as more origins land
/// (Codex+Opus 5.4 V1 audit findings A4/M5).
pub const PRESENCE_COMMIT_ORIGIN: &str = "presence:";

/// Append-only operation log backed by Loro.
///
/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
/// to reconstruct from a persisted snapshot. Mutations go through `append`;
/// reads through `iter` / `len` / `is_empty`.
pub struct OpLog {
    doc: LoroDoc,
}

impl std::fmt::Debug for OpLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpLog")
            .field("len", &self.len())
            .field("doc", &"<LoroDoc>")
            .finish()
    }
}

impl Default for OpLog {
    fn default() -> Self {
        Self::new()
    }
}

impl OpLog {
    /// Construct an empty log.
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
    /// appends carry the right origin in the CRDT merge metadata.
    ///
    /// Loro takes `&self` (interior mutability), so this method is
    /// `&self` too. Calling it twice with the same id leaves the
    /// peer id unchanged but is NOT a strict no-op at Loro's
    /// internal layer: Loro re-stores the atom and emits a
    /// `peer_id_change_subs` notification each call. Avoid calling
    /// repeatedly in hot paths.
    ///
    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
    /// 1. NEVER reuse the same peer id across concurrent writers
    ///    (multiple tabs / devices for the same user). Duplicate peer
    ///    ids corrupt the document via conflicting OpIDs.
    /// 2. Avoid pinning a peer id to a stable user/device identity
    ///    unless you also enforce single-ownership locking. Prefer a
    ///    per-process-random peer id.
    /// 3. Setting peer id AFTER an import is safe — existing imported
    ///    ops retain their original peer ids; only this log's future
    ///    appends use the new id.
    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
    /// 5. **Phase 5.4 V1 (2026-05-19):** if a `loro::UndoManager`
    ///    (constructed via [`new_undo_manager`]) is alive, Loro
    ///    SILENTLY CLEARS its undo + redo stacks on the peer-id
    ///    change (`loro-internal::undo:654-662`). Callers must
    ///    treat post-construction peer-id changes as undo-stack-
    ///    invalidating events.
    ///
    /// Signature note: `&mut self` (Phase 5.4 V1 audit closure)
    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
    /// `&mut` prevents accidental peer-id changes through a shared
    /// `&OpLog` (`CollabSession::op_log()`) which would silently
    /// clear an attached `UndoManager`'s stacks per pitfall 5.
    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
        self.doc.set_peer_id(peer)?;
        Ok(())
    }

    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
    pub fn peer_id(&self) -> u64 {
        self.doc.peer_id()
    }

    /// **Phase 5.6 (2026-05-19):** write the given peer's presence blob
    /// into the `"presence"` LoroMap.
    ///
    /// `peer_key` is a string identifier (typically the 16-hex form of
    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
    /// This layer doesn't interpret the bytes.
    ///
    /// LWW semantics per peer: a later `presence_set` for the same
    /// `peer_key` from any peer (including the same peer in a different
    /// session) replaces the previous value at merge time. Concurrent
    /// `presence_set` calls for DIFFERENT `peer_key`s are independent
    /// and both survive merge.
    ///
    /// Triggers `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so
    /// the write is durable through `export_bytes` / `merge_bytes`
    /// immediately AND is excluded from `UndoManager` (Phase 5.4
    /// V1 wires `add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`).
    pub fn presence_set(&mut self, peer_key: &str, json: &str) -> Result<(), OpLogError> {
        let map = self.doc.get_map(PRESENCE_CONTAINER);
        map.insert(peer_key, LoroValue::from(json))?;
        self.doc
            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
        Ok(())
    }

    /// **Phase 5.6 (2026-05-19):** read the given peer's presence blob.
    /// Returns `None` if the peer has no presence entry.
    ///
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

exec
/bin/zsh -lc "sed -n '1,220p' quantbook-engine/docs/phase5/d-1-starting-checklist.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
---
title: Phase 5.2 D-1 — fresh-session starting checklist (FormatId tagged tuple)
status: DRAFT — entry point for the multi-day D-1 implementation arc
date: 2026-05-19
predecessor: docs/phase5/v1-exit-packet.md
design_ref: docs/architecture/crdt-data-model.md § "D-1: Format-id wire format changes"
---

# Phase 5.2 D-1 — fresh-session starting checklist

D-1 is the **next major Phase 5.2 item** — multi-day, schema-breaking. After D-1, Phase 5 still has 5.3 (conflict resolution), 5.5 V2 V2/V3 (production transport), 5.7 (IDE vertical slice), and 5.8 (megaudit) ahead. This doc is a runway for the next session — assumes you've read `v1-exit-packet.md` for context.

## TL;DR

Change `FormatId` from `pub struct FormatId(pub u32)` to a tagged tuple:

```rust
pub enum FormatId {
    Builtin(u32),            // Excel-canonical ids 0–163
    Custom(PeerId, u32),     // peer-allocated custom format ids
}
```

Each peer's allocator increments only its own `Custom` counter; concurrent peers can't collide. Bumps the `.qbook` envelope schema. Backwards-compat: old files with `u32` ids load as `Builtin(n)` if `n ≤ 163`, else `Custom(LegacyPeer, n - 164)`.

## Audit-locked design (do not re-litigate)

Already audit-closed at Phase 5.1 (`918d7efdd91` + `df52cb44ad2`). Source: Opus H-1 + Codex V4 independent confirmations. The "Why tagged tuple over UUID" reasoning is in `crdt-data-model.md` § D-1.

**DO NOT** debate the design choice. The schema shape is locked. Implementation is the next session's job.

## Touchpoint inventory (verified 2026-05-19)

Sites that need updating, grouped by crate:

### `ql-storage` (the heart of the change)

- `crates/ql-storage/src/format.rs`:
  - `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`
  - `pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164` → either remove or repurpose.
  - `FormatTable::register_at(&mut self, id: FormatId, s: &str)` signature stays; logic updates to handle both variants.
  - `FormatTable::intern(&mut self, s: &str) -> FormatId` — needs peer-id context. Either: (a) add `intern_with_peer(peer: PeerId, s: &str)`; or (b) make FormatTable peer-aware via a `peer_id: PeerId` field set at construction.
  - `FormatTable::next_custom_id(&self) -> u32` becomes `next_custom_id(&self, peer: PeerId) -> u32` (per-peer counter).
  - `FormatTable::iter()` — iterator over `(FormatId, &str)`. Signature stays.

- `crates/ql-storage/src/lib.rs` — re-exports `FormatId`. Stays.
- `crates/ql-storage/src/sheet.rs` — `format_overlay: CellFormatOverlay`. CellFormatOverlay stores `FormatId` directly. Update its `set(row, col, FormatId)` value type (already `FormatId`, but underlying serde / Hash etc. needs reverification).
- `crates/ql-storage/src/format_overlay.rs` (if exists) — same as above.

### `ql-oplog` (wire format)

- `crates/ql-oplog/src/op.rs`:
  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatId, string: String }`. Since FormatId is not currently in ql-oplog (it lives in ql-storage), need to introduce a wire-format type:
    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary.
    - Option B (couple): make ql-oplog depend on ql-storage. Currently doesn't — Tier D2 made ql-oplog the dependency floor.
    - **Recommend Option A.** Matches the pattern of `CellWireValue` / `NamedTargetWire` already in `ql_oplog::wire`.
  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.

### `ql-io` (persistence envelope)

- `crates/ql-io/src/qbook_format.rs`:
  - Cell-format-id encoding in the envelope JSON. Old: bare u32 number. New: tagged variant (e.g. `{"Builtin": 14}` or `{"Custom": [peer_hex, counter]}`).
  - **Schema bump:** `WORKBOOK_SCHEMA_VERSION` increments.
  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LEGACY_PEER, n - 164)`.
  - **Sentinel `LEGACY_PEER` constant proposal:** `pub const LEGACY_PEER: PeerId = PeerId::new(0)` in `ql-oplog::peer` (the new home for PeerId per D-1 step 1). PeerId(0) is a reserved sentinel — Loro accepts it as a valid peer-id but Phase 5.2.b documents that "two concurrent sessions MUST use distinct peer ids," so production callers will avoid 0; LegacyPeer claiming 0 is safe. Alternative: `PeerId(u64::MAX - 1)` (Loro rejects MAX itself but MAX-1 is valid). Pick one in step 1.

### `ql-io-xlsx` (xlsx interop)

- `crates/ql-io-xlsx/src/read/styles_import.rs` + `read/cell_styles_xml.rs` + `read/styles_xml.rs` — read xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`. Also `ql-io-xlsx/src/lib.rs:231-275` for the top-level import wiring.
- `crates/ql-io-xlsx/src/write/umya_export.rs` — emit xlsx `cellXfs` from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`. (Note: there is NO `write/cell_styles_xml.rs`; the cell-styles XML is generated by `umya_export.rs` post-processing — checked 2026-05-19.)

### `ql-exec` (runtime + replay)

- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).

### Tests

- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.

## Step-by-step execution plan (recommended order)

This is the suggested order to keep the codebase in a compile-clean intermediate state after each step:

### Step 1: Introduce `PeerId` at ql-oplog layer (1-2 hours)

- Move `ql-collab::peer::PeerId` to `ql-oplog::peer::PeerId` (or copy-then-re-export to avoid breaking ql-collab callers).
- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.
- Verify gates green.
- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.

### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours)

- Add `ql-oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. This is the "destination shape" for Op variants.
- Do NOT yet change `Op::RegisterFormat.id` — keep as u32 for compilation.
- Add `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` (the migration helper).
- Tests: round-trip FormatIdWire through serde JSON.
- Commit: `Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire`.

### Step 3: Change `ql-storage::FormatId` to the tagged tuple (2-3 hours)

- Update `format.rs` enum definition + all internal logic (`register_at`, `intern`, `lookup`, etc.).
- `FormatTable` may need a `peer_id: PeerId` field set at construction.
- All ql-storage tests pass.
- ql-exec / ql-io / ql-io-xlsx will likely fail to compile at this point — that's expected, fix in subsequent steps.
- Commit: `Phase 5.2 D-1 step 3 — FormatId enum in ql-storage (breaks downstream)`.

### Step 4: Update `Op::RegisterFormat` / `Op::SetCellFormat` to use FormatIdWire (1-2 hours)

- Wire-format bump in Op enum.
- Update producer (`ql-exec::workbook_runtime::formats`) + replay (`ql-oplog::replay`) to use the new shape.
- Tests update.
- Commit: `Phase 5.2 D-1 step 4 — Op wire format uses FormatIdWire`.

### Step 5: Backwards-compat in `qbook_format` (2-3 hours)

- Schema version bump.
- Old-format loader: detect schema version, migrate `u32` → `FormatId` via legacy mapping.
- Tests: load a fixture saved at the old schema, verify successful migration.
- Commit: `Phase 5.2 D-1 step 5 — qbook envelope schema bump + legacy loader`.

### Step 6: xlsx export / import (1-2 hours)

- Flatten `FormatId` → xlsx `numFmtId` on export.
- Inflate xlsx `numFmtId` → `FormatId::Builtin(n)` on import.
- Tests: existing xlsx round-trip tests should pass.
- Commit: `Phase 5.2 D-1 step 6 — xlsx numFmtId ↔ FormatId mapping`.

### Step 7: Tier D3 — oplog.bin magic bytes + version header (1 hour)

- Bundle with D-1 per the entry plan. Add a 4-byte magic header + u32 schema version to `oplog.bin`.
- This is the discriminator the loader uses to know whether to apply legacy FormatId migration.
- Commit: `Tier D3 — oplog.bin magic bytes + schema version header`.

### Step 8: Audit (mandatory per discipline rule)

- 2-way Codex + Opus audit of the full D-1 arc. Multi-step schema change is exactly the kind of cycle the audit-discipline rule was written for.
- Verify clean-checkout `cargo check` (don't trust pre-commit hook gates alone — the index-padding race struck twice this session).

**Estimated total: 10-14 hours = ~2 working days.** Step 5 (backwards-compat) is the riskiest; allocate time for old `.qbook` fixture tests.

## Pre-flight checklist

Before starting D-1, verify:

- [ ] HEAD is at the most recent commit on `feat/quantbook-engine` (`2e945454cb5` as of 2026-05-19 session-end — `93210e43567` is the D1.a closure preceding the doc-refresh commit).
- [ ] `cargo test --workspace` reports **4222** passed.
- [ ] `cargo fmt --all -- --check` clean.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] No uncommitted source files (`git status --short | grep -v '^??'` empty).
- [ ] You've read `v1-exit-packet.md` (10 min) and `crdt-data-model.md` § D-1 (5 min).

**Cargo invocation pattern (Linux VM → Mac host):** cargo is NOT on PATH on the Linux VM where Claude runs. ALL cargo commands MUST go through the `mac` bridge:

```bash
mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && cargo <command>'
```

See user memory `orbstack_mac_bridge.md`. Direct `cargo` invocations from the Linux side will fail with command-not-found.

## Forward gotchas

- **Index-padding race:** struck **3 times** this session (2 truncation incidents on `session.rs` + 1+ pre-commit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on doc commits — see `v1-exit-packet.md` § Index-padding race incidents). Mitigation: never `--no-verify`; re-stage + retry. Large-file edits (`cells.rs` at 5,217 LOC, `session.rs` at 1,768 LOC) trigger it most reliably. **Verify every commit's HEAD blob matches disk** via `git -C . show HEAD:path | wc -l` — the 2 truncation incidents would have shipped silently otherwise.
- **Loro UndoManager peer-id binding:** if D-1 changes how `FormatTable::peer_id` is set after construction, may interact with the 5.4 V1 audit's set_peer_id silent-clear footgun. The fix at 5.4 V1 made `OpLog::set_peer_id` `&mut self`; if D-1 needs to bump format-allocator peer-id mid-session, plan for the undo-stack clear as a documented side-effect.
- **Tier C2 (BatchCommit depth guard)**: still pending but low priority. Not blocking D-1.

## Definition of done

D-1 ships when:

1. `FormatId` is the tagged tuple in `ql-storage`.
2. `Op::RegisterFormat` + `Op::SetCellFormat` use the new wire format.
3. `.qbook` envelope schema bumped + old-schema files load via legacy migration.
4. xlsx round-trip preserves all FormatId variants correctly.
5. All 4222+ workspace tests pass; fmt + clippy clean.
6. 2-way Codex + Opus audit run + closures committed.
7. `v1-exit-packet.md` updated to reflect D-1 ✅ shipped, leaving 5.3 + 5.5 V2 V2/V3 + 5.7 + 5.8 as remaining Phase 5 items.

After D-1 ships, Phase 5 is **~80% complete** (5.1 + 5.2 + 5.4 + 5.5 V1 + 5.5 V2 V1 + 5.6 + 5.6 V2 + Tier D3). Remaining: 5.3 conflict resolution, 5.5 V2 V2/V3 WebSocket transport, 5.7 IDE vertical slice, 5.8 megaudit.

exec
/bin/zsh -lc "sed -n '1,320p' quantbook-engine/crates/ql-oplog/src/wire.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! On-wire vocabulary for `Op` mutations.
//!
//! Tier D2 (2026-05-19, Phase 4.12 Opus-C HIGH-3 closure, gated by
//! Phase 5.1 audit): these types moved from `ql-io::qbook_format` into
//! `ql-oplog` so `ql-oplog::Op` no longer depends on `ql-io`. Phase 5
//! CRDT integration wants `ql-oplog` as a dependency floor; this move
//! inverts the prior `ql-oplog → ql-io` dependency.
//!
//! `ql-io` re-exports `CellWireValue` and `NamedTargetWire` so external
//! callers (`ql-exec`, `ql-io-xlsx` tests) compile unchanged.
//!
//! ## Contents
//!
//! - [`CellWireValue`] — serializable mirror of `ql_types::Value`. Phase
//!   2A.8 added the `Pending` variant for formula-bearing cells whose
//!   saved value is `Value::Blank` (so the v2 reader knows to recompute
//!   rather than treating it as a real `#NULL!`).
//! - [`NamedTargetWire`] — serializable mirror of
//!   `ql_storage::NamedTarget`. Tagged enum on the wire for schema
//!   robustness.
//! - [`WireDecodeError`] — new in Tier D2: a small error type owned by
//!   `ql-oplog` so `CellWireValue::to_value` and
//!   `NamedTargetWire::to_target` don't return `ql_io::QbookError`.
//!   `ql-io::QbookError` wraps `WireDecodeError` via `#[from]` so the
//!   existing `.qbook` load path surfaces decode failures with the same
//!   call shape as before.
//! - [`error_to_canonical_text`] and `parse_canonical_error_text` —
//!   round-trip helpers between `ErrorValue` and its Excel-canon string
//!   form.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use ql_storage::NamedTarget;
use ql_types::{Address, ErrorValue, Range, Value, MAX_COLUMN, MAX_ROW};

/// Errors emitted while decoding wire-format types back into runtime
/// values. Phase 4.12 Opus-C HIGH-3 / Tier D2 (2026-05-19) closure: a
/// small `ql-oplog`-owned error type so wire decoders don't reach into
/// `ql-io`. `ql_io::QbookError` wraps this via `#[from]` so existing
/// callers see the same chain when decoding `.qbook` cells.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum WireDecodeError {
    /// `CellWireValue::Error(s)` where `s` doesn't parse via
    /// `parse_canonical_error_text`. Loud — see no-fallbacks rule.
    #[error("unknown error sigil {sigil:?}")]
    UnknownErrorSigil { sigil: String },

    /// `NamedTargetWire::Cell.row` exceeds `MAX_ROW`.
    #[error("named cell row {row} exceeds MAX_ROW {max} (name: {name:?})")]
    CellRowOutOfRange { name: String, row: u32, max: u32 },

    /// `NamedTargetWire::Cell.col` exceeds `MAX_COLUMN`.
    #[error("named cell col {col} exceeds MAX_COLUMN {max} (name: {name:?})")]
    CellColOutOfRange { name: String, col: u32, max: u32 },

    /// One of `NamedTargetWire::Range.{start,end}_{row,col}` exceeds
    /// its corresponding `MAX_*` constant.
    #[error("named range {label} {value} exceeds max {max} (name: {name:?})")]
    RangeAxisOutOfRange {
        name: String,
        label: &'static str,
        value: u32,
        max: u32,
    },

    /// `NamedTargetWire::Constant.value.to_value()` failed (unknown
    /// error sigil inside a named constant).
    #[error("named constant decode failed (name: {name:?}): {detail}")]
    ConstantDecode { name: String, detail: String },
}

/// Wire-format mirror of `ql_types::Value`. Phase 1 W5-6 doesn't add Serialize to
/// ql-types directly (keeps the types crate lean); the wire-encoding lives
/// here in `ql-oplog`.
///
/// Phase 2A.8 (megaudit M11): added `Pending` variant for formula-bearing cells
/// whose saved value would be `Value::Blank` (because the formula hasn't been
/// evaluated yet, or its result really is Blank). Previously this case was
/// encoded as `Error("#NULL!")`, conflating "not yet evaluated" with a real
/// Excel `#NULL!` error. The v2 reader recognizes `Pending` as "needs
/// recompute"; for v1 files, the loader auto-rewrites `Error(#NULL!)` to
/// `Pending` when the same cell has a `formula` field.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum CellWireValue {
    Number(f64),
    Boolean(bool),
    Text(String),
    /// Stored as the canonical "#REF!" / "#VALUE!" / etc. text form.
    Error(String),
    /// Formula-bearing cell with no evaluated value. Recompute resolves it.
    Pending,
}

impl CellWireValue {
    /// Project a runtime `Value` into the wire shape, or `None` for `Blank`
    /// (which is encoded as the absence of a `CellRecord` entry on disk).
    pub fn from_value(v: &Value) -> Option<Self> {
        match v {
            Value::Blank => None,
            Value::Number(n) => Some(CellWireValue::Number(*n)),
            Value::Boolean(b) => Some(CellWireValue::Boolean(*b)),
            Value::Text(s) => Some(CellWireValue::Text(s.as_ref().to_owned())),
            Value::Error(e) => Some(CellWireValue::Error(error_to_canonical_text(*e))),
        }
    }

    /// Decode the wire value into a `ql_types::Value`. `Pending` decodes to
    /// `Value::Blank` — the cell is in a transient state until recompute runs.
    pub fn to_value(&self) -> Result<Value, WireDecodeError> {
        match self {
            CellWireValue::Number(n) => Ok(Value::number(*n)),
            CellWireValue::Boolean(b) => Ok(Value::Boolean(*b)),
            CellWireValue::Text(s) => Ok(Value::text(s.as_str())),
            CellWireValue::Error(s) => match parse_canonical_error_text(s) {
                Some(e) => Ok(Value::Error(e)),
                None => Err(WireDecodeError::UnknownErrorSigil {
                    sigil: s.to_owned(),
                }),
            },
            CellWireValue::Pending => Ok(Value::Blank),
        }
    }

    /// True iff this is the Phase 2A.8 Pending sentinel (formula-bearing cell
    /// with no evaluated value).
    pub fn is_pending(&self) -> bool {
        matches!(self, CellWireValue::Pending)
    }
}

/// Wire-format mirror of `ql_storage::NamedTarget`. Each variant is tagged
/// explicitly so the on-disk shape is self-describing and survives schema bumps.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NamedTargetWire {
    /// `NamedTarget::Cell` — single-cell anchor at `$Sheet!$Row,$Col`.
    Cell { sheet: u16, row: u32, col: u32 },
    /// `NamedTarget::Range` — rectangular range.
    Range {
        sheet: u16,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
    /// `NamedTarget::Constant(Value)` — reuses the cell wire-value vocabulary.
    Constant { value: CellWireValue },
    /// `NamedTarget::Formula(Arc<str>)` — raw formula source (without `=`).
    Formula { source: String },
}

impl NamedTargetWire {
    /// Project a runtime `NamedTarget` into the wire shape for serialization.
    pub fn from_target(t: &NamedTarget) -> Self {
        match t {
            NamedTarget::Cell(addr) => NamedTargetWire::Cell {
                sheet: addr.sheet,
                row: addr.row,
                col: addr.col,
            },
            NamedTarget::Range(r) => NamedTargetWire::Range {
                sheet: r.sheet,
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            },
            NamedTarget::Constant(v) => NamedTargetWire::Constant {
                // NamedTarget::Constant(Value::Blank) is unusual but valid; map
                // to Number(0.0) sentinel? No — preserve the variant by emitting
                // Error("BLANK_SENTINEL")? Also wrong. The cleanest answer: refuse
                // to serialize Blank constants — the user shouldn't have one,
                // and we'd round-trip-lose it anyway.
                //
                // In practice, `from_value(&Value::Blank)` returns None. So to
                // serialize a Blank constant we'd need a dedicated wire variant.
                // For Phase 2A.8 we deny it at save time via the conversion
                // helper below; this match arm assumes from_value returns Some.
                value: CellWireValue::from_value(v).unwrap_or(CellWireValue::Pending),
            },
            NamedTarget::Formula(src) => NamedTargetWire::Formula {
                source: src.as_ref().to_owned(),
            },
        }
    }

    /// Decode the wire shape back into a `NamedTarget`. Carries the name only
    /// for error reporting; the caller embeds the result in a `NameTable`.
    pub fn to_target(&self, name_for_error: &str) -> Result<NamedTarget, WireDecodeError> {
        match self {
            NamedTargetWire::Cell { sheet, row, col } => {
                if *row > MAX_ROW {
                    return Err(WireDecodeError::CellRowOutOfRange {
                        name: name_for_error.to_owned(),
                        row: *row,
                        max: MAX_ROW,
                    });
                }
                if *col > MAX_COLUMN {
                    return Err(WireDecodeError::CellColOutOfRange {
                        name: name_for_error.to_owned(),
                        col: *col,
                        max: MAX_COLUMN,
                    });
                }
                Ok(NamedTarget::Cell(Address::new(*sheet, *row, *col)))
            }
            NamedTargetWire::Range {
                sheet,
                start_row,
                start_col,
                end_row,
                end_col,
            } => {
                for (label, v, max) in [
                    ("start_row", *start_row, MAX_ROW),
                    ("start_col", *start_col, MAX_COLUMN),
                    ("end_row", *end_row, MAX_ROW),
                    ("end_col", *end_col, MAX_COLUMN),
                ] {
                    if v > max {
                        return Err(WireDecodeError::RangeAxisOutOfRange {
                            name: name_for_error.to_owned(),
                            label,
                            value: v,
                            max,
                        });
                    }
                }
                Ok(NamedTarget::Range(Range::new(
                    *sheet, *start_row, *start_col, *end_row, *end_col,
                )))
            }
            NamedTargetWire::Constant { value } => {
                let v = value
                    .to_value()
                    .map_err(|e| WireDecodeError::ConstantDecode {
                        name: name_for_error.to_owned(),
                        detail: e.to_string(),
                    })?;
                Ok(NamedTarget::Constant(v))
            }
            NamedTargetWire::Formula { source } => {
                Ok(NamedTarget::Formula(Arc::from(source.as_str())))
            }
        }
    }
}

/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
/// Used by both wire-format serialization and the user-visible representation per spec.
pub fn error_to_canonical_text(e: ErrorValue) -> String {
    e.sigil().to_string()
}

/// Parse a canonical Excel-style error sigil back into an `ErrorValue`.
/// `None` for unrecognized inputs (callers map to a typed decode error).
pub fn parse_canonical_error_text(s: &str) -> Option<ErrorValue> {
    Some(match s {
        "#REF!" => ErrorValue::Ref,
        "#VALUE!" => ErrorValue::Value,
        "#N/A" => ErrorValue::NA,
        "#DIV/0!" => ErrorValue::DivZero,
        "#NULL!" => ErrorValue::Null,
        "#NUM!" => ErrorValue::Num,
        "#NAME?" => ErrorValue::Name,
        "#SPILL!" => ErrorValue::Spill,
        "#CALC!" => ErrorValue::Calc,
        "#DISCONNECTED!" => ErrorValue::Disconnected,
        "#BINDING!" => ErrorValue::Binding,
        "#TIMEOUT!" => ErrorValue::Timeout,
        "#PERMISSION!" => ErrorValue::Permission,
        "#AI_NOT_AVAILABLE_V1" => ErrorValue::AINotAvailable,
        "#CIRC!" => ErrorValue::Circ,
        _ => return None,
    })
}

exec
/bin/zsh -lc 'rg --files quantbook-engine/crates/ql-oplog/src | sort' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/error.rs
quantbook-engine/crates/ql-oplog/src/lib.rs
quantbook-engine/crates/ql-oplog/src/log.rs
quantbook-engine/crates/ql-oplog/src/op.rs
quantbook-engine/crates/ql-oplog/src/peer.rs
quantbook-engine/crates/ql-oplog/src/replay.rs
quantbook-engine/crates/ql-oplog/src/wire.rs

exec
/bin/zsh -lc "rg -n \"ql_collab::peer::PeerId|ql_collab::peer|pub use ql_collab::peer|use ql_collab::\\{["'^'"\\n}]*peer|crate::peer::PeerId|super::peer::PeerId|mod peer|pub mod peer\" quantbook-engine -g '"'!target'"' -g '"'!docs/audits/**'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:1799:    45	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2507:    44	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5443:use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-1-codex.md:5813:pub mod peer;
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-oplog/src/lib.rs:41:pub mod peer;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:506:    46	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:1108:    42	pub mod peer;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:7943:   388	pub mod peer;        // PeerId newtype (u64 wrapper)
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:417:    31	pub mod peer;
quantbook-engine/docs/audits/2026-05-19-handoff-audit-codex.md:1276:    39	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:565:pub mod peer;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:947:use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1715:    48	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:2467:   415	pub mod peer;        // PeerId newtype (u64 wrapper)
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1137: use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2465:    51	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:7958:    57	pub mod peer;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:980:   455	pub mod peer;        // PeerId newtype (u64 wrapper)
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:11931:    62	pub mod peer;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1131:    44	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:1420:   367	pub mod peer;        // PeerId newtype (u64 wrapper)
quantbook-engine/docs/audits/2026-05-19-phase-5-2-b-codex.md:4742:    31	pub mod peer;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1520:    52	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:1936:    52	use crate::peer::PeerId;
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:2355:    59	pub mod peer;

exec
/bin/zsh -lc "sed -n '540,590p' quantbook-engine/docs/architecture/crdt-data-model.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:

### D-1: Format-id wire format changes — `FormatId = { peer_id, counter }`

**Status:** ⏳ PENDING — multi-day schema-breaking work; queued for next session.

**Source:** Opus H-1 + Codex V4 (independent confirmations).

The pre-audit design left format-id collision resolution as
open question 5 ("Phase 5.3 may switch to UUID"). Audit
verified the collision is a real bug: two peers concurrently
calling `intern_format("X")` and `intern_format("Y")` both
predict next-id N from the same workbook base, both emit
`Op::RegisterFormat { id: N, string: <different> }`. Replay's
`FormatTable::register_at` rejects the second with
`FormatRejectedSource::IdCollision`. Result: replay fails
deterministically rather than merging cleanly.

**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
tagged tuple:

```rust
pub enum FormatId {
    Builtin(u32),        // Excel-canonical ids 0–163 (unchanged)
    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
}
```

Each peer's allocator increments only its own `Custom` counter;
two peers can't collide. Built-in ids stay `u32` for round-trip
with Excel's id space.

**Schema impact:**
- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
  signature, `.qbook` envelope cell-format-id encoding, xlsx
  `cellXfs` numFmtId mapping all change.
- Wire-format bump: `WORKBOOK_SCHEMA_VERSION` increments.
- Backwards compat: old `.qbook` files with `u32` ids load as
  `FormatId::Builtin(n)` if `n ≤ 163` or
  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
  for migration. (Phase 5.2 designs the migration path.)

**Why not UUID?** UUIDs are bigger (128-bit), opaque to humans,
and don't carry the peer-of-origin information that
collaboration tooling wants. The tagged tuple gives the same
collision-freedom with better debuggability.

### D-2: AddSheet name collision — auto-rename in 5.2

**Status:** ✅ SHIPPED at commit `1ca19e2fa37` (2026-05-19) — `Op::AddSheet` replay handler now auto-renames to `<name>(2)`, `<name>(3)`, … on `SheetNameError::Duplicate` with `AUTO_RENAME_CEILING = 10_000`. `Empty` + `ReservedCharacter` still reject. Cross-ref `crates/ql-oplog/src/replay.rs`.


exec
/bin/zsh -lc "rg -n \"ql_collab::PeerId|ql_oplog::PeerId|ql_collab::peer::PeerId|ql_collab::peer|ql_oplog::peer::PeerId|crate::PeerId\" quantbook-engine -g '"'!target'"' -g '"'!docs/audits/**'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
quantbook-engine/docs/phase5/d-1-starting-checklist.md:90:- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.
quantbook-engine/docs/audits/2026-05-19-phase-5-6-v1-codex.md:2148:   175	    /// `ql_collab::PeerId::Display`); `json` is an opaque blob — the
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v1-codex.md:984:   182	    /// `ql_collab::PeerId::Display`); `json` is an opaque blob — the
quantbook-engine/crates/ql-oplog/src/peer.rs:3://! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
quantbook-engine/crates/ql-oplog/src/peer.rs:4://! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
quantbook-engine/crates/ql-oplog/src/peer.rs:7://! re-exports `ql_oplog::PeerId` to keep its public surface stable.
quantbook-engine/crates/ql-oplog/src/peer.rs:19://!   `ql_collab::PeerId` for back-compat.
quantbook-engine/crates/ql-oplog/src/log.rs:202:    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
quantbook-engine/crates/ql-collab/src/presence.rs:58:use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-collab/src/lib.rs:64://!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
quantbook-engine/crates/ql-collab/src/lib.rs:65://!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
quantbook-engine/crates/ql-collab/src/lib.rs:66://!   external callers using `ql_collab::PeerId` keep working.
quantbook-engine/crates/ql-collab/src/lib.rs:73:pub use ql_oplog::PeerId;
quantbook-engine/docs/audits/2026-05-19-handoff-completeness-audit-codex.md:384:    89	- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.

exec
/bin/zsh -lc "rg -n \"ql_collab::peer::PeerId|ql_collab::peer|pub use ql_collab::peer|crate::peer::PeerId|super::peer::PeerId|pub mod peer|mod peer\" quantbook-engine/crates -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/lib.rs:41:pub mod peer;
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation

exec
/bin/zsh -lc "rg -n \"ql_collab::PeerId|ql_oplog::PeerId|ql_collab::peer::PeerId|ql_collab::peer|ql_oplog::peer::PeerId|crate::PeerId\" quantbook-engine/crates -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"ql-oplog|ql_oplog|path = \\\"\\.\\./ql-oplog\\\"|package = \\\"ql-oplog\\\"\" quantbook-engine/crates/ql-collab/Cargo.toml quantbook-engine/crates/ql-collab/src -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"ql-collab|ql_collab|path = \\\"\\.\\./ql-collab\\\"|package = \\\"ql-collab\\\"\" quantbook-engine/crates/ql-oplog/Cargo.toml quantbook-engine/crates/ql-oplog/src -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/peer.rs:3://! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
quantbook-engine/crates/ql-oplog/src/peer.rs:4://! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
quantbook-engine/crates/ql-oplog/src/peer.rs:7://! re-exports `ql_oplog::PeerId` to keep its public surface stable.
quantbook-engine/crates/ql-oplog/src/peer.rs:19://!   `ql_collab::PeerId` for back-compat.
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-collab/src/lib.rs:64://!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
quantbook-engine/crates/ql-collab/src/lib.rs:65://!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
quantbook-engine/crates/ql-collab/src/lib.rs:66://!   external callers using `ql_collab::PeerId` keep working.
quantbook-engine/crates/ql-collab/src/lib.rs:73:pub use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/presence.rs:58:use ql_oplog::PeerId;
quantbook-engine/crates/ql-oplog/src/log.rs:202:    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the

 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/peer.rs:3://! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
quantbook-engine/crates/ql-oplog/src/peer.rs:6://! reference it without a reverse `ql-oplog → ql-collab` dep. `ql-collab`
quantbook-engine/crates/ql-oplog/src/peer.rs:17://! - `ql_collab::CollabSession` — attached at session-create time
quantbook-engine/crates/ql-oplog/src/peer.rs:19://!   `ql_collab::PeerId` for back-compat.
quantbook-engine/crates/ql-oplog/src/peer.rs:20://! - `ql_collab::presence` — keys the `"presence"` `LoroMap` in
quantbook-engine/crates/ql-oplog/src/log.rs:41:/// typed `PresenceState` encoding lives in `ql_collab::presence`).
quantbook-engine/crates/ql-oplog/src/log.rs:45:/// writes. `ql_collab::CollabSession` wires this to Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:48:/// layer (ql-collab) can reference the same string constant.
quantbook-engine/crates/ql-oplog/src/log.rs:153:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:203:    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
quantbook-engine/crates/ql-oplog/src/log.rs:282:    /// after construction. The `ql_collab::CollabSession`

 succeeded in 0ms:
quantbook-engine/crates/ql-collab/Cargo.toml:16:# ql-oplog (the dependency floor post Tier D2) for OpLog + Op +
quantbook-engine/crates/ql-collab/Cargo.toml:19:ql-oplog     = { path = "../ql-oplog" }
quantbook-engine/crates/ql-collab/src/lib.rs:7://! is the layer above ql-oplog that orchestrates multi-peer
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:57://!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-collab/src/lib.rs:65://!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
quantbook-engine/crates/ql-collab/src/lib.rs:73:pub use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/presence.rs:58:use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/presence.rs:139:    OpLog(#[from] ql_oplog::OpLogError),
quantbook-engine/crates/ql-collab/src/session.rs:3://! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
quantbook-engine/crates/ql-collab/src/session.rs:52:use ql_oplog::{Op, OpLog, OpLogError, PeerId, PRESENCE_COMMIT_ORIGIN};
quantbook-engine/crates/ql-collab/src/session.rs:239:    /// ql_oplog::replay_into(session.op_log(), &mut wb, &reg)?;
quantbook-engine/crates/ql-collab/src/session.rs:688:    use ql_oplog::CellWireValue;
quantbook-engine/crates/ql-collab/src/session.rs:1117:                ql_oplog::OpLogError::SchemaMismatch("forced error for test"),

exec
/bin/zsh -lc "rg -n \"ql_io::qbook_format|ql-io::qbook_format|ValueWire|CellWireValue|NamedTargetWire|FormatIdWire|WireDecodeError\" quantbook-engine/crates/ql-oplog/src -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:78:    /// Decoding the on-wire `CellWireValue` failed (e.g., unknown error sigil).
quantbook-engine/crates/ql-oplog/src/replay.rs:81:    /// `ql_io::QbookError` to `crate::wire::WireDecodeError` so replay
quantbook-engine/crates/ql-oplog/src/replay.rs:88:        source: crate::wire::WireDecodeError,
quantbook-engine/crates/ql-oplog/src/replay.rs:91:    /// Decoding the on-wire `NamedTargetWire` failed.
quantbook-engine/crates/ql-oplog/src/replay.rs:94:    /// `ql_io::QbookError` to `crate::wire::WireDecodeError`.
quantbook-engine/crates/ql-oplog/src/replay.rs:99:        source: crate::wire::WireDecodeError,
quantbook-engine/crates/ql-oplog/src/replay.rs:1094:    use crate::wire::{CellWireValue, NamedTargetWire};
quantbook-engine/crates/ql-oplog/src/replay.rs:1121:            value: CellWireValue::Number(42.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1188:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1189:                value: CellWireValue::Number(0.21),
quantbook-engine/crates/ql-oplog/src/replay.rs:1228:                    value: CellWireValue::Number(7.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1254:            value: CellWireValue::Number(1.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1262:            value: CellWireValue::Number(2.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1292:            value: CellWireValue::Number(1.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1318:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1319:                value: CellWireValue::Number(42.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1692:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1693:                value: CellWireValue::Number(0.21),
quantbook-engine/crates/ql-oplog/src/replay.rs:1718:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1719:                value: CellWireValue::Number(0.10),
quantbook-engine/crates/ql-oplog/src/replay.rs:1741:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1742:                value: CellWireValue::Number(1.0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1763:            target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/replay.rs:1764:                value: CellWireValue::Number(42.0),
quantbook-engine/crates/ql-oplog/src/op.rs:28://! - `ValueWire` and `NamedTargetWire` are reused from
quantbook-engine/crates/ql-oplog/src/op.rs:29://!   `ql_io::qbook_format` (Phase 2A.8 shipped them). Sharing the
quantbook-engine/crates/ql-oplog/src/op.rs:36:use crate::wire::{CellWireValue, NamedTargetWire};
quantbook-engine/crates/ql-oplog/src/op.rs:49:        value: CellWireValue,
quantbook-engine/crates/ql-oplog/src/op.rs:90:        target: NamedTargetWire,
quantbook-engine/crates/ql-oplog/src/wire.rs:4://! Phase 5.1 audit): these types moved from `ql-io::qbook_format` into
quantbook-engine/crates/ql-oplog/src/wire.rs:9://! `ql-io` re-exports `CellWireValue` and `NamedTargetWire` so external
quantbook-engine/crates/ql-oplog/src/wire.rs:14://! - [`CellWireValue`] — serializable mirror of `ql_types::Value`. Phase
quantbook-engine/crates/ql-oplog/src/wire.rs:18://! - [`NamedTargetWire`] — serializable mirror of
quantbook-engine/crates/ql-oplog/src/wire.rs:21://! - [`WireDecodeError`] — new in Tier D2: a small error type owned by
quantbook-engine/crates/ql-oplog/src/wire.rs:22://!   `ql-oplog` so `CellWireValue::to_value` and
quantbook-engine/crates/ql-oplog/src/wire.rs:23://!   `NamedTargetWire::to_target` don't return `ql_io::QbookError`.
quantbook-engine/crates/ql-oplog/src/wire.rs:24://!   `ql-io::QbookError` wraps `WireDecodeError` via `#[from]` so the
quantbook-engine/crates/ql-oplog/src/wire.rs:46:pub enum WireDecodeError {
quantbook-engine/crates/ql-oplog/src/wire.rs:47:    /// `CellWireValue::Error(s)` where `s` doesn't parse via
quantbook-engine/crates/ql-oplog/src/wire.rs:52:    /// `NamedTargetWire::Cell.row` exceeds `MAX_ROW`.
quantbook-engine/crates/ql-oplog/src/wire.rs:56:    /// `NamedTargetWire::Cell.col` exceeds `MAX_COLUMN`.
quantbook-engine/crates/ql-oplog/src/wire.rs:60:    /// One of `NamedTargetWire::Range.{start,end}_{row,col}` exceeds
quantbook-engine/crates/ql-oplog/src/wire.rs:70:    /// `NamedTargetWire::Constant.value.to_value()` failed (unknown
quantbook-engine/crates/ql-oplog/src/wire.rs:88:pub enum CellWireValue {
quantbook-engine/crates/ql-oplog/src/wire.rs:98:impl CellWireValue {
quantbook-engine/crates/ql-oplog/src/wire.rs:104:            Value::Number(n) => Some(CellWireValue::Number(*n)),
quantbook-engine/crates/ql-oplog/src/wire.rs:105:            Value::Boolean(b) => Some(CellWireValue::Boolean(*b)),
quantbook-engine/crates/ql-oplog/src/wire.rs:106:            Value::Text(s) => Some(CellWireValue::Text(s.as_ref().to_owned())),
quantbook-engine/crates/ql-oplog/src/wire.rs:107:            Value::Error(e) => Some(CellWireValue::Error(error_to_canonical_text(*e))),
quantbook-engine/crates/ql-oplog/src/wire.rs:113:    pub fn to_value(&self) -> Result<Value, WireDecodeError> {
quantbook-engine/crates/ql-oplog/src/wire.rs:115:            CellWireValue::Number(n) => Ok(Value::number(*n)),
quantbook-engine/crates/ql-oplog/src/wire.rs:116:            CellWireValue::Boolean(b) => Ok(Value::Boolean(*b)),
quantbook-engine/crates/ql-oplog/src/wire.rs:117:            CellWireValue::Text(s) => Ok(Value::text(s.as_str())),
quantbook-engine/crates/ql-oplog/src/wire.rs:118:            CellWireValue::Error(s) => match parse_canonical_error_text(s) {
quantbook-engine/crates/ql-oplog/src/wire.rs:120:                None => Err(WireDecodeError::UnknownErrorSigil {
quantbook-engine/crates/ql-oplog/src/wire.rs:124:            CellWireValue::Pending => Ok(Value::Blank),
quantbook-engine/crates/ql-oplog/src/wire.rs:131:        matches!(self, CellWireValue::Pending)
quantbook-engine/crates/ql-oplog/src/wire.rs:139:pub enum NamedTargetWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:151:    Constant { value: CellWireValue },
quantbook-engine/crates/ql-oplog/src/wire.rs:156:impl NamedTargetWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:160:            NamedTarget::Cell(addr) => NamedTargetWire::Cell {
quantbook-engine/crates/ql-oplog/src/wire.rs:165:            NamedTarget::Range(r) => NamedTargetWire::Range {
quantbook-engine/crates/ql-oplog/src/wire.rs:172:            NamedTarget::Constant(v) => NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/wire.rs:183:                value: CellWireValue::from_value(v).unwrap_or(CellWireValue::Pending),
quantbook-engine/crates/ql-oplog/src/wire.rs:185:            NamedTarget::Formula(src) => NamedTargetWire::Formula {
quantbook-engine/crates/ql-oplog/src/wire.rs:193:    pub fn to_target(&self, name_for_error: &str) -> Result<NamedTarget, WireDecodeError> {
quantbook-engine/crates/ql-oplog/src/wire.rs:195:            NamedTargetWire::Cell { sheet, row, col } => {
quantbook-engine/crates/ql-oplog/src/wire.rs:197:                    return Err(WireDecodeError::CellRowOutOfRange {
quantbook-engine/crates/ql-oplog/src/wire.rs:204:                    return Err(WireDecodeError::CellColOutOfRange {
quantbook-engine/crates/ql-oplog/src/wire.rs:212:            NamedTargetWire::Range {
quantbook-engine/crates/ql-oplog/src/wire.rs:226:                        return Err(WireDecodeError::RangeAxisOutOfRange {
quantbook-engine/crates/ql-oplog/src/wire.rs:238:            NamedTargetWire::Constant { value } => {
quantbook-engine/crates/ql-oplog/src/wire.rs:241:                    .map_err(|e| WireDecodeError::ConstantDecode {
quantbook-engine/crates/ql-oplog/src/wire.rs:247:            NamedTargetWire::Formula { source } => {
quantbook-engine/crates/ql-oplog/src/lib.rs:50:pub use wire::{CellWireValue, NamedTargetWire, WireDecodeError};
quantbook-engine/crates/ql-oplog/src/log.rs:343:    use crate::wire::{CellWireValue, NamedTargetWire};
quantbook-engine/crates/ql-oplog/src/log.rs:350:            value: CellWireValue::Number(n),
quantbook-engine/crates/ql-oplog/src/log.rs:390:                target: NamedTargetWire::Constant {
quantbook-engine/crates/ql-oplog/src/log.rs:391:                    value: CellWireValue::Number(0.21),

exec
/bin/zsh -lc "sed -n '1,160p' quantbook-engine/crates/ql-storage/Cargo.toml" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '1,280p' quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
[package]
name = "ql-storage"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lib]
path = "src/lib.rs"

[dependencies]
ql-types     = { path = "../ql-types" }
arrow-array  = { workspace = true }
arrow-schema = { workspace = true }
# Phase 2A.9 audit M6: `NameTableError` uses thiserror::Error for ergonomic
# Display + std::error::Error. Consistent with QbookError / RuntimeError /
# LoadAndRecomputeError which already use thiserror.
thiserror    = { workspace = true }

[dev-dependencies]
proptest = { workspace = true }

 succeeded in 0ms:
//! Workbook-level format-string interning table (Phase 4.5.D part 3,
//! W5-79).
//!
//! `FormatTable` reserves Excel built-in format IDs 0-163 and allocates
//! custom IDs from 164 upward. Pre-populates the parser-relevant subset
//! of built-ins (mini-spec § 10) so cells with the most common formats
//! resolve without any registration calls.
//!
//! See:
//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for the
//!   design.
//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
//!   the parser-relevant built-in subset.

use std::collections::HashMap;

/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
/// for the "no custom format" case (built-in id 0).
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FormatId(pub u32);

impl FormatId {
    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    pub const GENERAL: FormatId = FormatId(0);
}

/// First custom (non-built-in) format id. IDs 0-163 are reserved for
/// Excel's built-in table per OOXML / mini-spec § 10.
pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164;

/// Excel built-in format strings ship in this table at construction time.
/// Per mini-spec § 10, V1 ships the parser-relevant subset; remaining IDs
/// in the 0-163 range can be added lazily when xlsx import (Phase 4.11)
/// surfaces them.
const BUILTIN_FORMATS: &[(u32, &str)] = &[
    (0, "General"),
    (1, "0"),
    (2, "0.00"),
    (3, "#,##0"),
    (4, "#,##0.00"),
    (9, "0%"),
    (10, "0.00%"),
    (11, "0.00E+00"),
    // id 12 (`"# ?/?"`) — V2 fraction, parser refuses; not pre-registered.
    (14, "m/d/yyyy"),
    (15, "d-mmm-yy"),
    (16, "d-mmm"),
    (17, "mmm-yy"),
    (18, "h:mm AM/PM"),
    (19, "h:mm:ss AM/PM"),
    (20, "h:mm"),
    (21, "h:mm:ss"),
    (22, "m/d/yyyy h:mm"),
    (37, "#,##0 ;(#,##0)"),
    // id 38 — V2 color; parser refuses.
    (45, "mm:ss"),
    // id 46 — V2 elapsed; parser refuses.
    (49, "@"),
];

/// Workbook-level format-string interning + dedup table.
///
/// Cells reference a `FormatId`; the table resolves the id back to a
/// format string the renderer can parse.
#[derive(Clone, Debug)]
pub struct FormatTable {
    /// `id → string`. Sparse (only entries that exist).
    by_id: HashMap<FormatId, String>,
    /// `string → id`. Used by `intern` for dedup.
    by_string: HashMap<String, FormatId>,
    /// Next custom id to hand out. Always >= [`FIRST_CUSTOM_FORMAT_ID`].
    next_custom_id: u32,
}

impl Default for FormatTable {
    fn default() -> Self {
        let mut t = Self {
            by_id: HashMap::new(),
            by_string: HashMap::new(),
            next_custom_id: FIRST_CUSTOM_FORMAT_ID,
        };
        for (id, s) in BUILTIN_FORMATS {
            let fid = FormatId(*id);
            t.by_id.insert(fid, (*s).to_string());
            t.by_string.insert((*s).to_string(), fid);
        }
        t
    }
}

impl FormatTable {
    /// Fresh table with Excel built-ins (mini-spec § 10 subset) pre-loaded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up the format string for `id`. Returns `None` if the id has
    /// never been registered (which includes most reserved 0-163 ids that
    /// weren't pre-populated by V1 — those land via xlsx import).
    pub fn lookup(&self, id: FormatId) -> Option<&str> {
        self.by_id.get(&id).map(|s| s.as_str())
    }

    /// Intern `s`. Returns the existing id if `s` is already present;
    /// otherwise allocates a new custom id (≥ [`FIRST_CUSTOM_FORMAT_ID`])
    /// and stores both directions.
    ///
    /// **Replay determinism:** the allocator is monotonic in insertion
    /// order. As long as the op-log replays `Op::RegisterFormat` events
    /// in the same order they were originally written, custom ids
    /// reconstruct identically.
    pub fn intern(&mut self, s: &str) -> FormatId {
        if let Some(id) = self.by_string.get(s) {
            return *id;
        }
        let id = FormatId(self.next_custom_id);
        self.next_custom_id += 1;
        self.by_id.insert(id, s.to_string());
        self.by_string.insert(s.to_string(), id);
        id
    }

    /// Register `s` at a specific id (typically an Excel built-in or a
    /// replay path). Returns `Err` if the id is already taken with a
    /// different string — that would break round-trip determinism.
    ///
    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
    /// this to reproduce the original allocator state.
    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
        if let Some(existing) = self.by_id.get(&id) {
            if existing == s {
                return Ok(());
            }
            return Err(FormatTableError::IdCollision {
                id,
                existing: existing.clone(),
                attempted: s.to_string(),
            });
        }
        if let Some(existing_id) = self.by_string.get(s) {
            if *existing_id == id {
                return Ok(());
            }
            return Err(FormatTableError::StringCollision {
                string: s.to_string(),
                existing_id: *existing_id,
                attempted_id: id,
            });
        }
        self.by_id.insert(id, s.to_string());
        self.by_string.insert(s.to_string(), id);
        if id.0 >= self.next_custom_id {
            self.next_custom_id = id.0 + 1;
        }
        Ok(())
    }

    /// Total entries — useful for sanity checks, not for hot paths.
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    /// True iff the table has no entries (should only be possible if a
    /// caller clears it; default construction loads built-ins).
    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    /// The id `intern` will allocate on its next miss. Exposed for tests
    /// + replay state-check.
    pub fn next_custom_id(&self) -> u32 {
        self.next_custom_id
    }

    /// Iterate `(id, &str)` in arbitrary order. Persistence + op-log
    /// snapshotting consumers must sort by id when wire-stable order
    /// matters.
    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
        self.by_id.iter().map(|(id, s)| (*id, s.as_str()))
    }
}

/// Errors from `register_at` collisions.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum FormatTableError {
    /// An id is already taken with a different string.
    IdCollision {
        id: FormatId,
        existing: String,
        attempted: String,
    },
    /// A string is already mapped to a different id.
    StringCollision {
        string: String,
        existing_id: FormatId,
        attempted_id: FormatId,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pre_populates_builtins() {
        let t = FormatTable::new();
        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
        assert_eq!(t.lookup(FormatId(14)), Some("m/d/yyyy"));
        assert_eq!(t.lookup(FormatId(49)), Some("@"));
    }

    #[test]
    fn unregistered_builtin_returns_none() {
        // id 12 (fraction) is V2-deferred and NOT pre-populated.
        let t = FormatTable::new();
        assert_eq!(t.lookup(FormatId(12)), None);
    }

    #[test]
    fn intern_existing_returns_same_id() {
        let mut t = FormatTable::new();
        let id = t.intern("0.00");
        assert_eq!(id, FormatId(2));
        // Re-intern same string returns same id.
        assert_eq!(t.intern("0.00"), id);
    }

    #[test]
    fn intern_new_allocates_custom_id() {
        let mut t = FormatTable::new();
        let id = t.intern("\"€\" #,##0.00");
        assert_eq!(id, FormatId(FIRST_CUSTOM_FORMAT_ID));
        // Stored both directions.
        assert_eq!(t.lookup(id), Some("\"€\" #,##0.00"));
        assert_eq!(t.intern("\"€\" #,##0.00"), id);
    }

    #[test]
    fn intern_two_distinct_strings_get_sequential_ids() {
        let mut t = FormatTable::new();
        let a = t.intern("CUSTOM_A");
        let b = t.intern("CUSTOM_B");
        assert_eq!(b.0, a.0 + 1);
    }

    #[test]
    fn next_custom_id_advances_on_intern() {
        let mut t = FormatTable::new();
        assert_eq!(t.next_custom_id(), FIRST_CUSTOM_FORMAT_ID);
        let _ = t.intern("CUSTOM");
        assert_eq!(t.next_custom_id(), FIRST_CUSTOM_FORMAT_ID + 1);
    }

    #[test]
    fn register_at_replays_known_id() {
        let mut t = FormatTable::new();
        t.register_at(FormatId(200), "REPLAY").unwrap();
        assert_eq!(t.lookup(FormatId(200)), Some("REPLAY"));
        // Next intern should land at 201 (past the manual registration).
        let next = t.intern("ANOTHER");
        assert_eq!(next, FormatId(201));
    }

    #[test]
    fn register_at_same_id_same_string_is_idempotent() {
        let mut t = FormatTable::new();
        t.register_at(FormatId(0), "General").unwrap();
        assert!(t.register_at(FormatId(0), "General").is_ok());
    }

    #[test]
    fn register_at_id_collision_errors() {
        let mut t = FormatTable::new();
        let err = t.register_at(FormatId(0), "DIFFERENT").unwrap_err();
        assert!(matches!(err, FormatTableError::IdCollision { .. }));
    }

    #[test]
    fn register_at_string_collision_errors() {

exec
/bin/zsh -lc "rg -n \"ql-storage|ql_storage|path = \\\"\\.\\./ql-storage\\\"\" quantbook-engine/crates/ql-oplog/Cargo.toml quantbook-engine/crates/ql-oplog/src -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/Cargo.toml:18:ql-storage   = { path = "../ql-storage" }
quantbook-engine/crates/ql-oplog/src/replay.rs:44:use ql_storage::Workbook;
quantbook-engine/crates/ql-oplog/src/replay.rs:108:        source: ql_storage::NameTableError,
quantbook-engine/crates/ql-oplog/src/replay.rs:156:        source: ql_storage::SheetNameError,
quantbook-engine/crates/ql-oplog/src/replay.rs:170:        source: ql_storage::SheetNameError,
quantbook-engine/crates/ql-oplog/src/replay.rs:245:/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
quantbook-engine/crates/ql-oplog/src/replay.rs:267:impl From<ql_storage::FormatTableError> for FormatRejectedSource {
quantbook-engine/crates/ql-oplog/src/replay.rs:268:    fn from(e: ql_storage::FormatTableError) -> Self {
quantbook-engine/crates/ql-oplog/src/replay.rs:270:            ql_storage::FormatTableError::IdCollision {
quantbook-engine/crates/ql-oplog/src/replay.rs:279:            ql_storage::FormatTableError::StringCollision {
quantbook-engine/crates/ql-oplog/src/replay.rs:422:                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
quantbook-engine/crates/ql-oplog/src/replay.rs:434:                                source: ql_storage::SheetNameError::Duplicate {
quantbook-engine/crates/ql-oplog/src/replay.rs:470:            let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
quantbook-engine/crates/ql-oplog/src/replay.rs:502:            let fid = ql_storage::FormatId(*id);
quantbook-engine/crates/ql-oplog/src/replay.rs:523:                let fid = ql_storage::FormatId(*raw_id);
quantbook-engine/crates/ql-oplog/src/replay.rs:691:    workbook: &mut ql_storage::Workbook,
quantbook-engine/crates/ql-oplog/src/replay.rs:753:    workbook: &mut ql_storage::Workbook,
quantbook-engine/crates/ql-oplog/src/replay.rs:761:    use ql_storage::TableColumn;
quantbook-engine/crates/ql-oplog/src/replay.rs:795:        ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, new_rows, new_cols)
quantbook-engine/crates/ql-oplog/src/replay.rs:941:    use ql_storage::{TableColumn, TableMetadata};
quantbook-engine/crates/ql-oplog/src/replay.rs:1002:        ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, rows, cols)
quantbook-engine/crates/ql-oplog/src/replay.rs:1096:    use ql_storage::NamedTarget;
quantbook-engine/crates/ql-oplog/src/replay.rs:1355:            wb.formats().lookup(ql_storage::FormatId(200)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1375:            wb.formats().lookup(ql_storage::FormatId(0)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1426:            Some(ql_storage::FormatId(200))
quantbook-engine/crates/ql-oplog/src/replay.rs:1521:            Some(ql_storage::FormatId(14))
quantbook-engine/crates/ql-oplog/src/replay.rs:1704:            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.21
quantbook-engine/crates/ql-oplog/src/replay.rs:1729:            Some(ql_storage::NamedTarget::Constant(Value::Number(n))) if n == 0.10
quantbook-engine/crates/ql-oplog/src/wire.rs:19://!   `ql_storage::NamedTarget`. Tagged enum on the wire for schema
quantbook-engine/crates/ql-oplog/src/wire.rs:36:use ql_storage::NamedTarget;
quantbook-engine/crates/ql-oplog/src/wire.rs:135:/// Wire-format mirror of `ql_storage::NamedTarget`. Each variant is tagged
quantbook-engine/crates/ql-oplog/src/lib.rs:15://! - [`replay_into`] — applies a log against a [`ql_storage::Workbook`].

exec
/bin/zsh -lc 'cargo metadata --format-version 1 --no-deps' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 265ms:
{"packages":[{"name":"ql-ai","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-ai#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_ai","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-ai/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-ai/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-bench","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"arrow-array","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=58.3.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"arrow-schema","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=58.3.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"criterion","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.8.2","kind":null,"rename":null,"optional":false,"uses_default_features":false,"features":["html_reports"],"target":null,"registry":null},{"name":"num_cpus","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.17.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_bench","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["custom-build"],"crate_types":["bin"],"name":"build-script-build","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench/build.rs","edition":"2021","doc":false,"doctest":false,"test":false}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-storage","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"arrow-array","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=58.3.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"arrow-schema","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=58.3.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"proptest","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.8.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_storage","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-types","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_types","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"coercion_matrix","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types/tests/coercion_matrix.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-bindings-c","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-c#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_bindings_c","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-c/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-c/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-bindings-node","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-node#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_bindings_node","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-node/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-node/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-bindings-wasm","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-wasm#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_bindings_wasm","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-wasm/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-wasm/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-calcgraph","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"ql-formula-syntax","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"siphasher","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.1","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"criterion","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.8.2","kind":"dev","rename":null,"optional":false,"uses_default_features":false,"features":["html_reports"],"target":null,"registry":null},{"name":"proptest","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.8.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_calcgraph","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["bench"],"crate_types":["bin"],"name":"dirty_og05","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph/benches/dirty_og05.rs","edition":"2021","doc":false,"doctest":false,"test":false},{"kind":["bench"],"crate_types":["bin"],"name":"prefix_sum_a5","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph/benches/prefix_sum_a5.rs","edition":"2021","doc":false,"doctest":false,"test":false},{"kind":["bench"],"crate_types":["bin"],"name":"region_split_merge","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph/benches/region_split_merge.rs","edition":"2021","doc":false,"doctest":false,"test":false}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-formula-syntax","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_formula_syntax","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_b_pinpoint","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/tests/p412_b_pinpoint.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_b_threaded_depth_probe","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/tests/p412_b_threaded_depth_probe.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_defensive_fuzz_probes","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-collab","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"loro","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.12.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-functions","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"},{"name":"ql-oplog","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"},{"name":"serde","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.228","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":["derive"],"target":null,"registry":null},{"name":"serde_json","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.149","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_collab","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-functions","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"statrs","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.18.0","kind":null,"rename":null,"optional":false,"uses_default_features":false,"features":[],"target":null,"registry":null},{"name":"proptest","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.8.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_functions","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"coverage","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/tests/coverage.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"per_function_overrides","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/tests/per_function_overrides.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-oplog","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"loro","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.12.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-functions","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"serde","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.228","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":["derive"],"target":null,"registry":null},{"name":"serde_json","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.149","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_oplog","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_defensive_oplog_probes","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"producer_replay_equivalence","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-connectors","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-connectors#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_connectors","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-connectors/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-connectors/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-exec","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"arrow-array","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=58.3.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"multiversion","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.8.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-calcgraph","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph"},{"name":"ql-formula-syntax","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax"},{"name":"ql-functions","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"},{"name":"ql-io","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io"},{"name":"ql-oplog","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"criterion","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.8.2","kind":"dev","rename":null,"optional":false,"uses_default_features":false,"features":["html_reports"],"target":null,"registry":null},{"name":"proptest","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.8.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-profile","source":null,"req":"*","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile"},{"name":"tempfile","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=3.27.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_exec","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"distribution_fns_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/distribution_fns_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"error_precedence","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/error_precedence.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"ide_simulation","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/ide_simulation.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"oplog_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_phase_4_12_cross_features","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_function_arg_fuzz","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"phase_5_2_d4_spill_2peer_probe","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_fns_coverage_extensions","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_fns_coverage_extensions.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_fns_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_fns_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_fns_step3_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_fns_step4_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_fns_step5_cross_cutting","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"reference_tier_dispatcher_smoke","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/reference_tier_dispatcher_smoke.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"region_mul2_e2e","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/tests/region_mul2_e2e.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["bench"],"crate_types":["bin"],"name":"a3_10k_dirty_recompute","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs","edition":"2021","doc":false,"doctest":false,"test":false},{"kind":["bench"],"crate_types":["bin"],"name":"og02_chunk_sweep","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/benches/og02_chunk_sweep.rs","edition":"2021","doc":false,"doctest":false,"test":false},{"kind":["bench"],"crate_types":["bin"],"name":"og02_mul2","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/benches/og02_mul2.rs","edition":"2021","doc":false,"doctest":false,"test":false},{"kind":["bench"],"crate_types":["bin"],"name":"og04_scalar_1m","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/benches/og04_scalar_1m.rs","edition":"2021","doc":false,"doctest":false,"test":false}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-io","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"ql-oplog","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"serde","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.228","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":["derive"],"target":null,"registry":null},{"name":"serde_json","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.149","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"toml","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.9.7","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"tempfile","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=3.27.0","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_io","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"p412_qbook_corruption_probes","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/tests/p412_qbook_corruption_probes.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-profile","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"ql-calcgraph","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"serde","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.228","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":["derive"],"target":null,"registry":null},{"name":"serde_json","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=1.0.149","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_profile","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-formula-semantics","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-semantics#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_formula_semantics","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-semantics/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-semantics/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-io-ods","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-ods#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_io_ods","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-ods/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-ods/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-io-xlsx","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[{"name":"calamine","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.34.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"ql-exec","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec"},{"name":"ql-functions","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions"},{"name":"ql-storage","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage"},{"name":"ql-types","source":null,"req":"*","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types"},{"name":"quick-xml","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.36.2","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"thiserror","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.0.18","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"umya-spreadsheet","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=2.2.0","kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null},{"name":"zip","source":"registry+https://github.com/rust-lang/crates.io-index","req":"=0.6.6","kind":null,"rename":null,"optional":false,"uses_default_features":false,"features":["deflate"],"target":null,"registry":null},{"name":"ql-io","source":null,"req":"*","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io"},{"name":"ql-oplog","source":null,"req":"*","kind":"dev","rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog"}],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_io_xlsx","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"calamine_smoke","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_cache_policy","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_cache_policy.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_deep_probe","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_dup_fmt","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_edge_cases","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_error_cell_probe","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_error_cell_probe.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_format_no_overlay","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_misc","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_phase_4_12_ide_proof","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"opus_a_text_edge","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/opus_a_text_edge.rs","edition":"2021","doc":false,"doctest":false,"test":true},{"kind":["test"],"crate_types":["bin"],"name":"phase_4_11_corpus_probe","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs","edition":"2021","doc":false,"doctest":false,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-service","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-service#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_service","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-service/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-service/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-sql","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-sql#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_sql","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-sql/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-sql/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-terminal","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-terminal#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_terminal","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-terminal/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-terminal/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"ql-udf","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-udf#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"ql_udf","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-udf/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-udf/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"},{"name":"quantbook-py","version":"0.1.0","id":"path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/quantbook-py#0.1.0","license":"MIT OR Apache-2.0","license_file":null,"description":null,"source":null,"dependencies":[],"targets":[{"kind":["lib"],"crate_types":["lib"],"name":"quantbook_py","src_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/quantbook-py/src/lib.rs","edition":"2021","doc":true,"doctest":true,"test":true}],"features":{},"manifest_path":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/quantbook-py/Cargo.toml","metadata":null,"publish":[],"authors":[],"categories":[],"keywords":[],"readme":null,"repository":null,"homepage":null,"documentation":null,"edition":"2021","links":null,"default_run":null,"rust_version":"1.85"}],"workspace_members":["path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-ai#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-c#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-node#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bindings-wasm#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-connectors#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-semantics#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-ods#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-service#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-sql#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-terminal#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-udf#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/quantbook-py#0.1.0"],"workspace_default_members":["path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-types#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-syntax#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-formula-semantics#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-functions#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-calcgraph#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-exec#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-bench#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-profile#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog#0.1.0","path+file:///Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-terminal#0.1.0"],"resolve":null,"target_directory":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/target","build_directory":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/target","version":1,"workspace_root":"/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine","metadata":null}

codex
The code-only path search shows no live `ql_collab::peer::PeerId` or `crate::peer::PeerId` users outside the intentional docs in `ql-collab/src/lib.rs`. I did find one forward-design concern: `ql-storage` still sits below `ql-oplog`, so future `ql_storage::FormatId` cannot directly import `ql_oplog::PeerId` without creating a cycle; I’m checking whether that affects step 2 or should be called out for step 3.
  ✓ Inspect commit diff, Cargo dependency edges, and relevant module docs
  ✓ Search for broken public paths and stale references
  → Run targeted ql-oplog peer tests and inspect wire readiness
  • Produce severity-ranked verdict in requested format
exec
/bin/zsh -lc 'cargo test -p ql-oplog peer::' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/src/lib.rs | sed -n '1,100p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/peer.rs | sed -n '1,130p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/wire.rs | sed -n '1,280p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/op.rs | sed -n '20,45p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-storage/src/format.rs | sed -n '1,70p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 283ms:
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
    12	//! - `PeerId` — re-exported from [`ql_oplog::PeerId`] (Phase 5.2 D-1
    13	//!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
    14	//!   Stable per-session identifier; wraps Loro's `u64`.
    15	//! - [`session`] — `CollabSession`: per-peer state holder that
    16	//!   wraps an `OpLog`, manages local appends, and exposes
    17	//!   `merge_bytes` + `export_bytes` for transport integration.
    18	//! - [`transport`] — `Transport` trait + 2 impls: `NoopTransport`
    19	//!   (test stub) and `LoopbackTransport` (Phase 5.5 V1 ship
    20	//!   2026-05-19 — in-process paired endpoints for 2-peer
    21	//!   round-trip tests). Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05`)
    22	//!   added `CollabSession` typed transport methods
    23	//!   (attach/detach/flush/poll). Phase 5.5 V2 V2 / V3 pending —
    24	//!   auto-flush + version-vector deltas + WebSocket impl.
    25	//! - [`presence`] — per-peer ephemeral cursor + selection state
    26	//!   (Phase 5.6 V1 ship 2026-05-19). `PresenceState` JSON-encoded
    27	//!   into the shared `LoroDoc`'s `"presence"` LoroMap (LWW per key).
    28	//! - [`undo`] — peer-local undo/redo via Loro's `UndoManager`.
    29	//!   V1 ship 2026-05-19 (`89c02b9d83e`): 7 undo/redo methods.
    30	//!   V2 V1 (`6138a7203f6` + `e199a5fda5a`): atomic grouping +
    31	//!   merge-interval. V2 V1.1: RAII `start_undo_group_scoped`
    32	//!   returning `UndoGroupGuard`. V2 V2 pending — push/pop
    33	//!   listeners.
    34	//!
    35	//! ## Stability
    36	//!
    37	//! Pre-0.2.0: the public API is in flux. Phase 5.2.b through 5.7
    38	//! will populate the reserved modules and may shift trait shapes.
    39	//! No `#[non_exhaustive]` on enums yet — locked at Phase 5.8
    40	//! megaudit per the engine audit-discipline rule.
    41	//!
    42	//! ### Pre-stability API changes (logged)
    43	//!
    44	//! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
    45	//!   return type changed from `Self` to
    46	//!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
    47	//!   fallible (`u64::MAX` is reserved), so the constructor must
    48	//!   propagate the error. Internal-only at the time of the change;
    49	//!   no external callers.
    50	//! - **Phase 5.4 V1 (2026-05-19, `89c02b9d83e` + audit closure):**
    51	//!   `CollabSessionError::Undo(loro::LoroError)` variant added.
    52	//!   Exposes `loro::LoroError` in the public error surface — pre-0.2.0
    53	//!   this couples consumers to the loro crate version; a stable API
    54	//!   would wrap it in a ql-collab-owned error. Will be re-typed
    55	//!   before 0.2.0.
    56	//! - **Phase 5.4 V1 audit closure (2026-05-19):**
    57	//!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
    58	//!   to `&mut self`. Prevents accidental peer-id changes through
    59	//!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
    60	//!   an attached `UndoManager`'s stacks per Loro's internal
    61	//!   subscription behavior (`loro-internal::undo:654-662`).
    62	//! - **Phase 5.2 D-1 step 1 (2026-05-19):** `PeerId` moved from
    63	//!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
    64	//!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
    65	//!   a re-export of `ql_oplog::PeerId` — public surface unchanged,
    66	//!   external callers using `ql_collab::PeerId` keep working.
    67	
    68	pub mod presence;
    69	pub mod session;
    70	pub mod transport;
    71	pub mod undo;
    72	
    73	pub use ql_oplog::PeerId;
    74	
    75	pub use presence::{PresenceError, PresenceState};
    76	pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
    77	pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
    78	pub use undo::UndoManager;

 succeeded in 280ms:
     1	//! Per-peer identifier for Phase 5 collaboration.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
     4	//! **Phase 5.2 D-1 step 1 (2026-05-19):** moved to `ql_oplog::PeerId`
     5	//! so the op-log layer (where ops are tagged with peer-of-origin) can
     6	//! reference it without a reverse `ql-oplog → ql-collab` dep. `ql-collab`
     7	//! re-exports `ql_oplog::PeerId` to keep its public surface stable.
     8	//!
     9	//! `PeerId` is a thin newtype around `u64` matching Loro's native peer-id
    10	//! type. Stable per-session; the user-facing collaboration tooling decides
    11	//! how to assign IDs (random vs user-derived vs server-allocated).
    12	//!
    13	//! Used by:
    14	//! - [`crate::OpLog::set_peer_id`] — wires through to Loro's
    15	//!   `LoroDoc::set_peer_id` so concurrent appends carry the right
    16	//!   origin in the CRDT merge metadata (Phase 5.2.b).
    17	//! - `ql_collab::CollabSession` — attached at session-create time
    18	//!   and passed to `OpLog::set_peer_id`. Re-exported as
    19	//!   `ql_collab::PeerId` for back-compat.
    20	//! - `ql_collab::presence` — keys the `"presence"` `LoroMap` in
    21	//!   16-hex `Display` form so each peer's cursor position lives at
    22	//!   its own slot (Phase 5.6 V1 at `c677e244704`).
    23	//! - Phase 5 D-1 (in progress) — the `FormatId::Custom(PeerId, u32)`
    24	//!   variant will use this type for collision-free format-id
    25	//!   allocation across peers.
    26	
    27	/// Per-peer collaboration identifier.
    28	///
    29	/// Wraps a `u64` to match Loro's native peer-id type. Stable for
    30	/// the lifetime of a `CollabSession`; the user-facing tooling
    31	/// decides assignment policy. Two concurrent peers MUST have
    32	/// distinct ids — duplicate peer ids corrupt the document via
    33	/// conflicting OpIDs (Loro pitfall, surfaced by Phase 5.1 audit
    34	/// then closed by Phase 5.2.b wiring). Prefer per-process-random
    35	/// allocation unless your server enforces uniqueness explicitly.
    36	#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Ord, PartialOrd)]
    37	pub struct PeerId(pub u64);
    38	
    39	impl PeerId {
    40	    /// Construct a `PeerId` from the raw u64.
    41	    pub const fn new(id: u64) -> Self {
    42	        Self(id)
    43	    }
    44	
    45	    /// Unwrap to the raw `u64`. Used at the Loro boundary
    46	    /// (`LoroDoc::set_peer_id` takes `u64`).
    47	    pub const fn as_u64(self) -> u64 {
    48	        self.0
    49	    }
    50	}
    51	
    52	impl From<u64> for PeerId {
    53	    fn from(id: u64) -> Self {
    54	        Self(id)
    55	    }
    56	}
    57	
    58	impl From<PeerId> for u64 {
    59	    fn from(p: PeerId) -> Self {
    60	        p.0
    61	    }
    62	}
    63	
    64	impl std::fmt::Display for PeerId {
    65	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    66	        // 16-hex-char form keeps display compact and easy to spot in logs.
    67	        write!(f, "{:016x}", self.0)
    68	    }
    69	}
    70	
    71	#[cfg(test)]
    72	mod tests {
    73	    use super::PeerId;
    74	
    75	    #[test]
    76	    fn round_trips_through_u64() {
    77	        let p = PeerId::new(0xdead_beef_cafe_babe);
    78	        assert_eq!(p.as_u64(), 0xdead_beef_cafe_babe);
    79	        assert_eq!(u64::from(p), 0xdead_beef_cafe_babe);
    80	        assert_eq!(PeerId::from(0xdead_beef_cafe_babe_u64), p);
    81	    }
    82	
    83	    #[test]
    84	    fn display_is_16_hex_chars() {
    85	        let p = PeerId::new(0x1234);
    86	        assert_eq!(format!("{p}"), "0000000000001234");
    87	    }
    88	
    89	    #[test]
    90	    fn equality_and_hash_consistent() {
    91	        use std::collections::HashSet;
    92	        let a = PeerId::new(42);
    93	        let b = PeerId::new(42);
    94	        let c = PeerId::new(43);
    95	        assert_eq!(a, b);
    96	        assert_ne!(a, c);
    97	        let mut set: HashSet<PeerId> = HashSet::new();
    98	        set.insert(a);
    99	        assert!(set.contains(&b));
   100	        assert!(!set.contains(&c));
   101	    }
   102	}

 succeeded in 272ms:
     1	//! On-wire vocabulary for `Op` mutations.
     2	//!
     3	//! Tier D2 (2026-05-19, Phase 4.12 Opus-C HIGH-3 closure, gated by
     4	//! Phase 5.1 audit): these types moved from `ql-io::qbook_format` into
     5	//! `ql-oplog` so `ql-oplog::Op` no longer depends on `ql-io`. Phase 5
     6	//! CRDT integration wants `ql-oplog` as a dependency floor; this move
     7	//! inverts the prior `ql-oplog → ql-io` dependency.
     8	//!
     9	//! `ql-io` re-exports `CellWireValue` and `NamedTargetWire` so external
    10	//! callers (`ql-exec`, `ql-io-xlsx` tests) compile unchanged.
    11	//!
    12	//! ## Contents
    13	//!
    14	//! - [`CellWireValue`] — serializable mirror of `ql_types::Value`. Phase
    15	//!   2A.8 added the `Pending` variant for formula-bearing cells whose
    16	//!   saved value is `Value::Blank` (so the v2 reader knows to recompute
    17	//!   rather than treating it as a real `#NULL!`).
    18	//! - [`NamedTargetWire`] — serializable mirror of
    19	//!   `ql_storage::NamedTarget`. Tagged enum on the wire for schema
    20	//!   robustness.
    21	//! - [`WireDecodeError`] — new in Tier D2: a small error type owned by
    22	//!   `ql-oplog` so `CellWireValue::to_value` and
    23	//!   `NamedTargetWire::to_target` don't return `ql_io::QbookError`.
    24	//!   `ql-io::QbookError` wraps `WireDecodeError` via `#[from]` so the
    25	//!   existing `.qbook` load path surfaces decode failures with the same
    26	//!   call shape as before.
    27	//! - [`error_to_canonical_text`] and `parse_canonical_error_text` —
    28	//!   round-trip helpers between `ErrorValue` and its Excel-canon string
    29	//!   form.
    30	
    31	use std::sync::Arc;
    32	
    33	use serde::{Deserialize, Serialize};
    34	use thiserror::Error;
    35	
    36	use ql_storage::NamedTarget;
    37	use ql_types::{Address, ErrorValue, Range, Value, MAX_COLUMN, MAX_ROW};
    38	
    39	/// Errors emitted while decoding wire-format types back into runtime
    40	/// values. Phase 4.12 Opus-C HIGH-3 / Tier D2 (2026-05-19) closure: a
    41	/// small `ql-oplog`-owned error type so wire decoders don't reach into
    42	/// `ql-io`. `ql_io::QbookError` wraps this via `#[from]` so existing
    43	/// callers see the same chain when decoding `.qbook` cells.
    44	#[derive(Clone, Debug, Error, PartialEq, Eq)]
    45	#[non_exhaustive]
    46	pub enum WireDecodeError {
    47	    /// `CellWireValue::Error(s)` where `s` doesn't parse via
    48	    /// `parse_canonical_error_text`. Loud — see no-fallbacks rule.
    49	    #[error("unknown error sigil {sigil:?}")]
    50	    UnknownErrorSigil { sigil: String },
    51	
    52	    /// `NamedTargetWire::Cell.row` exceeds `MAX_ROW`.
    53	    #[error("named cell row {row} exceeds MAX_ROW {max} (name: {name:?})")]
    54	    CellRowOutOfRange { name: String, row: u32, max: u32 },
    55	
    56	    /// `NamedTargetWire::Cell.col` exceeds `MAX_COLUMN`.
    57	    #[error("named cell col {col} exceeds MAX_COLUMN {max} (name: {name:?})")]
    58	    CellColOutOfRange { name: String, col: u32, max: u32 },
    59	
    60	    /// One of `NamedTargetWire::Range.{start,end}_{row,col}` exceeds
    61	    /// its corresponding `MAX_*` constant.
    62	    #[error("named range {label} {value} exceeds max {max} (name: {name:?})")]
    63	    RangeAxisOutOfRange {
    64	        name: String,
    65	        label: &'static str,
    66	        value: u32,
    67	        max: u32,
    68	    },
    69	
    70	    /// `NamedTargetWire::Constant.value.to_value()` failed (unknown
    71	    /// error sigil inside a named constant).
    72	    #[error("named constant decode failed (name: {name:?}): {detail}")]
    73	    ConstantDecode { name: String, detail: String },
    74	}
    75	
    76	/// Wire-format mirror of `ql_types::Value`. Phase 1 W5-6 doesn't add Serialize to
    77	/// ql-types directly (keeps the types crate lean); the wire-encoding lives
    78	/// here in `ql-oplog`.
    79	///
    80	/// Phase 2A.8 (megaudit M11): added `Pending` variant for formula-bearing cells
    81	/// whose saved value would be `Value::Blank` (because the formula hasn't been
    82	/// evaluated yet, or its result really is Blank). Previously this case was
    83	/// encoded as `Error("#NULL!")`, conflating "not yet evaluated" with a real
    84	/// Excel `#NULL!` error. The v2 reader recognizes `Pending` as "needs
    85	/// recompute"; for v1 files, the loader auto-rewrites `Error(#NULL!)` to
    86	/// `Pending` when the same cell has a `formula` field.
    87	#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
    88	pub enum CellWireValue {
    89	    Number(f64),
    90	    Boolean(bool),
    91	    Text(String),
    92	    /// Stored as the canonical "#REF!" / "#VALUE!" / etc. text form.
    93	    Error(String),
    94	    /// Formula-bearing cell with no evaluated value. Recompute resolves it.
    95	    Pending,
    96	}
    97	
    98	impl CellWireValue {
    99	    /// Project a runtime `Value` into the wire shape, or `None` for `Blank`
   100	    /// (which is encoded as the absence of a `CellRecord` entry on disk).
   101	    pub fn from_value(v: &Value) -> Option<Self> {
   102	        match v {
   103	            Value::Blank => None,
   104	            Value::Number(n) => Some(CellWireValue::Number(*n)),
   105	            Value::Boolean(b) => Some(CellWireValue::Boolean(*b)),
   106	            Value::Text(s) => Some(CellWireValue::Text(s.as_ref().to_owned())),
   107	            Value::Error(e) => Some(CellWireValue::Error(error_to_canonical_text(*e))),
   108	        }
   109	    }
   110	
   111	    /// Decode the wire value into a `ql_types::Value`. `Pending` decodes to
   112	    /// `Value::Blank` — the cell is in a transient state until recompute runs.
   113	    pub fn to_value(&self) -> Result<Value, WireDecodeError> {
   114	        match self {
   115	            CellWireValue::Number(n) => Ok(Value::number(*n)),
   116	            CellWireValue::Boolean(b) => Ok(Value::Boolean(*b)),
   117	            CellWireValue::Text(s) => Ok(Value::text(s.as_str())),
   118	            CellWireValue::Error(s) => match parse_canonical_error_text(s) {
   119	                Some(e) => Ok(Value::Error(e)),
   120	                None => Err(WireDecodeError::UnknownErrorSigil {
   121	                    sigil: s.to_owned(),
   122	                }),
   123	            },
   124	            CellWireValue::Pending => Ok(Value::Blank),
   125	        }
   126	    }
   127	
   128	    /// True iff this is the Phase 2A.8 Pending sentinel (formula-bearing cell
   129	    /// with no evaluated value).
   130	    pub fn is_pending(&self) -> bool {
   131	        matches!(self, CellWireValue::Pending)
   132	    }
   133	}
   134	
   135	/// Wire-format mirror of `ql_storage::NamedTarget`. Each variant is tagged
   136	/// explicitly so the on-disk shape is self-describing and survives schema bumps.
   137	#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
   138	#[serde(tag = "kind", rename_all = "lowercase")]
   139	pub enum NamedTargetWire {
   140	    /// `NamedTarget::Cell` — single-cell anchor at `$Sheet!$Row,$Col`.
   141	    Cell { sheet: u16, row: u32, col: u32 },
   142	    /// `NamedTarget::Range` — rectangular range.
   143	    Range {
   144	        sheet: u16,
   145	        start_row: u32,
   146	        start_col: u32,
   147	        end_row: u32,
   148	        end_col: u32,
   149	    },
   150	    /// `NamedTarget::Constant(Value)` — reuses the cell wire-value vocabulary.
   151	    Constant { value: CellWireValue },
   152	    /// `NamedTarget::Formula(Arc<str>)` — raw formula source (without `=`).
   153	    Formula { source: String },
   154	}
   155	
   156	impl NamedTargetWire {
   157	    /// Project a runtime `NamedTarget` into the wire shape for serialization.
   158	    pub fn from_target(t: &NamedTarget) -> Self {
   159	        match t {
   160	            NamedTarget::Cell(addr) => NamedTargetWire::Cell {
   161	                sheet: addr.sheet,
   162	                row: addr.row,
   163	                col: addr.col,
   164	            },
   165	            NamedTarget::Range(r) => NamedTargetWire::Range {
   166	                sheet: r.sheet,
   167	                start_row: r.start_row,
   168	                start_col: r.start_col,
   169	                end_row: r.end_row,
   170	                end_col: r.end_col,
   171	            },
   172	            NamedTarget::Constant(v) => NamedTargetWire::Constant {
   173	                // NamedTarget::Constant(Value::Blank) is unusual but valid; map
   174	                // to Number(0.0) sentinel? No — preserve the variant by emitting
   175	                // Error("BLANK_SENTINEL")? Also wrong. The cleanest answer: refuse
   176	                // to serialize Blank constants — the user shouldn't have one,
   177	                // and we'd round-trip-lose it anyway.
   178	                //
   179	                // In practice, `from_value(&Value::Blank)` returns None. So to
   180	                // serialize a Blank constant we'd need a dedicated wire variant.
   181	                // For Phase 2A.8 we deny it at save time via the conversion
   182	                // helper below; this match arm assumes from_value returns Some.
   183	                value: CellWireValue::from_value(v).unwrap_or(CellWireValue::Pending),
   184	            },
   185	            NamedTarget::Formula(src) => NamedTargetWire::Formula {
   186	                source: src.as_ref().to_owned(),
   187	            },
   188	        }
   189	    }
   190	
   191	    /// Decode the wire shape back into a `NamedTarget`. Carries the name only
   192	    /// for error reporting; the caller embeds the result in a `NameTable`.
   193	    pub fn to_target(&self, name_for_error: &str) -> Result<NamedTarget, WireDecodeError> {
   194	        match self {
   195	            NamedTargetWire::Cell { sheet, row, col } => {
   196	                if *row > MAX_ROW {
   197	                    return Err(WireDecodeError::CellRowOutOfRange {
   198	                        name: name_for_error.to_owned(),
   199	                        row: *row,
   200	                        max: MAX_ROW,
   201	                    });
   202	                }
   203	                if *col > MAX_COLUMN {
   204	                    return Err(WireDecodeError::CellColOutOfRange {
   205	                        name: name_for_error.to_owned(),
   206	                        col: *col,
   207	                        max: MAX_COLUMN,
   208	                    });
   209	                }
   210	                Ok(NamedTarget::Cell(Address::new(*sheet, *row, *col)))
   211	            }
   212	            NamedTargetWire::Range {
   213	                sheet,
   214	                start_row,
   215	                start_col,
   216	                end_row,
   217	                end_col,
   218	            } => {
   219	                for (label, v, max) in [
   220	                    ("start_row", *start_row, MAX_ROW),
   221	                    ("start_col", *start_col, MAX_COLUMN),
   222	                    ("end_row", *end_row, MAX_ROW),
   223	                    ("end_col", *end_col, MAX_COLUMN),
   224	                ] {
   225	                    if v > max {
   226	                        return Err(WireDecodeError::RangeAxisOutOfRange {
   227	                            name: name_for_error.to_owned(),
   228	                            label,
   229	                            value: v,
   230	                            max,
   231	                        });
   232	                    }
   233	                }
   234	                Ok(NamedTarget::Range(Range::new(
   235	                    *sheet, *start_row, *start_col, *end_row, *end_col,
   236	                )))
   237	            }
   238	            NamedTargetWire::Constant { value } => {
   239	                let v = value
   240	                    .to_value()
   241	                    .map_err(|e| WireDecodeError::ConstantDecode {
   242	                        name: name_for_error.to_owned(),
   243	                        detail: e.to_string(),
   244	                    })?;
   245	                Ok(NamedTarget::Constant(v))
   246	            }
   247	            NamedTargetWire::Formula { source } => {
   248	                Ok(NamedTarget::Formula(Arc::from(source.as_str())))
   249	            }
   250	        }
   251	    }
   252	}
   253	
   254	/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
   255	/// Used by both wire-format serialization and the user-visible representation per spec.
   256	pub fn error_to_canonical_text(e: ErrorValue) -> String {
   257	    e.sigil().to_string()
   258	}
   259	
   260	/// Parse a canonical Excel-style error sigil back into an `ErrorValue`.
   261	/// `None` for unrecognized inputs (callers map to a typed decode error).
   262	pub fn parse_canonical_error_text(s: &str) -> Option<ErrorValue> {
   263	    Some(match s {
   264	        "#REF!" => ErrorValue::Ref,
   265	        "#VALUE!" => ErrorValue::Value,
   266	        "#N/A" => ErrorValue::NA,
   267	        "#DIV/0!" => ErrorValue::DivZero,
   268	        "#NULL!" => ErrorValue::Null,
   269	        "#NUM!" => ErrorValue::Num,
   270	        "#NAME?" => ErrorValue::Name,
   271	        "#SPILL!" => ErrorValue::Spill,
   272	        "#CALC!" => ErrorValue::Calc,
   273	        "#DISCONNECTED!" => ErrorValue::Disconnected,
   274	        "#BINDING!" => ErrorValue::Binding,
   275	        "#TIMEOUT!" => ErrorValue::Timeout,
   276	        "#PERMISSION!" => ErrorValue::Permission,
   277	        "#AI_NOT_AVAILABLE_V1" => ErrorValue::AINotAvailable,
   278	        "#CIRC!" => ErrorValue::Circ,
   279	        _ => return None,
   280	    })

 succeeded in 280ms:
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

 succeeded in 278ms:
     1	//! Workbook-level format-string interning table (Phase 4.5.D part 3,
     2	//! W5-79).
     3	//!
     4	//! `FormatTable` reserves Excel built-in format IDs 0-163 and allocates
     5	//! custom IDs from 164 upward. Pre-populates the parser-relevant subset
     6	//! of built-ins (mini-spec § 10) so cells with the most common formats
     7	//! resolve without any registration calls.
     8	//!
     9	//! See:
    10	//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for the
    11	//!   design.
    12	//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
    13	//!   the parser-relevant built-in subset.
    14	
    15	use std::collections::HashMap;
    16	
    17	/// Type-tag wrapper around the u32 format index. Use `FormatId::GENERAL`
    18	/// for the "no custom format" case (built-in id 0).
    19	#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
    20	pub struct FormatId(pub u32);
    21	
    22	impl FormatId {
    23	    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    24	    pub const GENERAL: FormatId = FormatId(0);
    25	}
    26	
    27	/// First custom (non-built-in) format id. IDs 0-163 are reserved for
    28	/// Excel's built-in table per OOXML / mini-spec § 10.
    29	pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164;
    30	
    31	/// Excel built-in format strings ship in this table at construction time.
    32	/// Per mini-spec § 10, V1 ships the parser-relevant subset; remaining IDs
    33	/// in the 0-163 range can be added lazily when xlsx import (Phase 4.11)
    34	/// surfaces them.
    35	const BUILTIN_FORMATS: &[(u32, &str)] = &[
    36	    (0, "General"),
    37	    (1, "0"),
    38	    (2, "0.00"),
    39	    (3, "#,##0"),
    40	    (4, "#,##0.00"),
    41	    (9, "0%"),
    42	    (10, "0.00%"),
    43	    (11, "0.00E+00"),
    44	    // id 12 (`"# ?/?"`) — V2 fraction, parser refuses; not pre-registered.
    45	    (14, "m/d/yyyy"),
    46	    (15, "d-mmm-yy"),
    47	    (16, "d-mmm"),
    48	    (17, "mmm-yy"),
    49	    (18, "h:mm AM/PM"),
    50	    (19, "h:mm:ss AM/PM"),
    51	    (20, "h:mm"),
    52	    (21, "h:mm:ss"),
    53	    (22, "m/d/yyyy h:mm"),
    54	    (37, "#,##0 ;(#,##0)"),
    55	    // id 38 — V2 color; parser refuses.
    56	    (45, "mm:ss"),
    57	    // id 46 — V2 elapsed; parser refuses.
    58	    (49, "@"),
    59	];
    60	
    61	/// Workbook-level format-string interning + dedup table.
    62	///
    63	/// Cells reference a `FormatId`; the table resolves the id back to a
    64	/// format string the renderer can parse.
    65	#[derive(Clone, Debug)]
    66	pub struct FormatTable {
    67	    /// `id → string`. Sparse (only entries that exist).
    68	    by_id: HashMap<FormatId, String>,
    69	    /// `string → id`. Used by `intern` for dedup.
    70	    by_string: HashMap<String, FormatId>,

 succeeded in 422ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.10s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-c1cdc5dab039fc91)

running 3 tests
test peer::tests::display_is_16_hex_chars ... ok
test peer::tests::round_trips_through_u64 ... ok
test peer::tests::equality_and_hash_consistent ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 49 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-009eac2017092277)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-63182d846430fb75)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


exec
/bin/zsh -lc "nl -ba crates/ql-oplog/Cargo.toml | sed -n '1,60p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-collab/Cargo.toml | sed -n '1,60p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-storage/Cargo.toml | sed -n '1,50p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba docs/phase5/d-1-starting-checklist.md | sed -n '48,104p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '216,224p;553,584p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/lib.rs | sed -n '38,55p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 293ms:
     1	[package]
     2	name = "ql-oplog"
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
    13	# Phase 2A.3.a (2026-05-12): Loro op log scaffolding. Per Round 7 architectural
    14	# lock T1-D05, Loro is reserved for the op log layer only — no other crate
    15	# depends on it. CRDT semantics are reserved for Phase 5+ multi-user work;
    16	# Phase 2A.3 uses Loro as the persistence + future-CRDT-merge substrate.
    17	ql-types     = { path = "../ql-types" }
    18	ql-storage   = { path = "../ql-storage" }
    19	ql-functions = { path = "../ql-functions" }
    20	# **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure:** `ql-io`
    21	# removed. Wire-vocabulary types (`CellWireValue`, `NamedTargetWire`)
    22	# moved to `ql-oplog::wire`; persistence functions
    23	# (`save_workbook_with_oplog`, `load_workbook_with_oplog`,
    24	# `PersistenceError`) moved to `ql-io::oplog_persistence`. Phase 5
    25	# CRDT integration now sees `ql-oplog` as a dependency floor.
    26	loro         = { workspace = true }
    27	serde        = { workspace = true }
    28	serde_json   = { workspace = true }
    29	thiserror    = { workspace = true }

 succeeded in 290ms:
     1	[package]
     2	name = "ql-collab"
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
    13	# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
    14	# closed design at `docs/architecture/crdt-data-model.md`,
    15	# ql-collab is the Phase 5 collaboration crate. Depends on
    16	# ql-oplog (the dependency floor post Tier D2) for OpLog + Op +
    17	# merge_bytes. ql-storage gives us Workbook for replay
    18	# integration; ql-functions provides the registry needed by replay.
    19	ql-oplog     = { path = "../ql-oplog" }
    20	ql-storage   = { path = "../ql-storage" }
    21	ql-functions = { path = "../ql-functions" }
    22	thiserror    = { workspace = true }
    23	# Phase 5.6 (2026-05-19) — presence state serde + JSON encoding for
    24	# Loro's `presence` LoroMap (per-peer ephemeral cursor / selection).
    25	serde        = { workspace = true }
    26	serde_json   = { workspace = true }
    27	# Phase 5.4 V1 (2026-05-19) — direct dep on `loro::UndoManager`
    28	# wrapped by `CollabSession` for peer-local undo/redo.
    29	loro         = { workspace = true }

 succeeded in 283ms:
     1	[package]
     2	name = "ql-storage"
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
    13	ql-types     = { path = "../ql-types" }
    14	arrow-array  = { workspace = true }
    15	arrow-schema = { workspace = true }
    16	# Phase 2A.9 audit M6: `NameTableError` uses thiserror::Error for ergonomic
    17	# Display + std::error::Error. Consistent with QbookError / RuntimeError /
    18	# LoadAndRecomputeError which already use thiserror.
    19	thiserror    = { workspace = true }
    20	
    21	[dev-dependencies]
    22	proptest = { workspace = true }

 succeeded in 287ms:
    48	- `crates/ql-storage/src/format_overlay.rs` (if exists) — same as above.
    49	
    50	### `ql-oplog` (wire format)
    51	
    52	- `crates/ql-oplog/src/op.rs`:
    53	  - `Op::RegisterFormat { id: u32, string: String }` → `Op::RegisterFormat { id: FormatId, string: String }`. Since FormatId is not currently in ql-oplog (it lives in ql-storage), need to introduce a wire-format type:
    54	    - Option A (clean): add `ql-oplog::FormatIdWire` that mirrors the tagged tuple, with `from_storage`/`to_storage` conversions at the boundary.
    55	    - Option B (couple): make ql-oplog depend on ql-storage. Currently doesn't — Tier D2 made ql-oplog the dependency floor.
    56	    - **Recommend Option A.** Matches the pattern of `CellWireValue` / `NamedTargetWire` already in `ql_oplog::wire`.
    57	  - `Op::SetCellFormat { sheet, row, col, id: FormatId }` (currently has `id: FormatId` per the audit doc) — sync to new shape.
    58	  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.
    59	
    60	### `ql-io` (persistence envelope)
    61	
    62	- `crates/ql-io/src/qbook_format.rs`:
    63	  - Cell-format-id encoding in the envelope JSON. Old: bare u32 number. New: tagged variant (e.g. `{"Builtin": 14}` or `{"Custom": [peer_hex, counter]}`).
    64	  - **Schema bump:** `WORKBOOK_SCHEMA_VERSION` increments.
    65	  - Backwards-compat migration in the loader: if envelope schema version < N, read `u32` and convert to `FormatId::Builtin(n)` for `n ≤ 163` else `FormatId::Custom(LEGACY_PEER, n - 164)`.
    66	  - **Sentinel `LEGACY_PEER` constant proposal:** `pub const LEGACY_PEER: PeerId = PeerId::new(0)` in `ql-oplog::peer` (the new home for PeerId per D-1 step 1). PeerId(0) is a reserved sentinel — Loro accepts it as a valid peer-id but Phase 5.2.b documents that "two concurrent sessions MUST use distinct peer ids," so production callers will avoid 0; LegacyPeer claiming 0 is safe. Alternative: `PeerId(u64::MAX - 1)` (Loro rejects MAX itself but MAX-1 is valid). Pick one in step 1.
    67	
    68	### `ql-io-xlsx` (xlsx interop)
    69	
    70	- `crates/ql-io-xlsx/src/read/styles_import.rs` + `read/cell_styles_xml.rs` + `read/styles_xml.rs` — read xlsx's `cellXfs[i].numFmtId` (u32). The import maps `numFmtId` → `FormatId`. For non-Loro source files, all formats are `Builtin(n)` if `n ≤ 163` else `Custom(LegacyPeer, n - 164)`. Also `ql-io-xlsx/src/lib.rs:231-275` for the top-level import wiring.
    71	- `crates/ql-io-xlsx/src/write/umya_export.rs` — emit xlsx `cellXfs` from `FormatId`. Need a flattening function `FormatId → u32` for xlsx round-trip. Custom format ids need a stable mapping: probably `id_to_xlsx_numFmtId(format_id) = FIRST_XLSX_CUSTOM_NUMFMT + sequence_of_appearance`. (Note: there is NO `write/cell_styles_xml.rs`; the cell-styles XML is generated by `umya_export.rs` post-processing — checked 2026-05-19.)
    72	
    73	### `ql-exec` (runtime + replay)
    74	
    75	- `crates/ql-exec/src/workbook_runtime/formats.rs` — `intern_format(s: &str) -> FormatId` and `set_cell_format(sheet, row, col, format_id: FormatId)`. Both methods need peer-id context (from the runtime's attached OpLog → CollabSession). Update signatures or make peer-id implicit via a field.
    76	- `crates/ql-exec/src/workbook_runtime/error.rs` — `RuntimeError::FormatRejected` already exists; may need new variants for cross-peer FormatId collisions (shouldn't happen by construction, but defensive).
    77	
    78	### Tests
    79	
    80	- `crates/ql-exec/tests/oplog_e2e.rs` + `phase_5_2_d4_spill_2peer_probe.rs` — wire-format round-trip tests; update for new FormatId shape.
    81	- `crates/ql-io-xlsx/tests/opus_a_*.rs` — many tests reference FormatId; should still pass with the new shape since they don't observe the wire format directly.
    82	
    83	## Step-by-step execution plan (recommended order)
    84	
    85	This is the suggested order to keep the codebase in a compile-clean intermediate state after each step:
    86	
    87	### Step 1: Introduce `PeerId` at ql-oplog layer (1-2 hours)
    88	
    89	- Move `ql-collab::peer::PeerId` to `ql-oplog::peer::PeerId` (or copy-then-re-export to avoid breaking ql-collab callers).
    90	- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.
    91	- Verify gates green.
    92	- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.
    93	
    94	### Step 2: Introduce `FormatIdWire` in ql-oplog (1-2 hours)
    95	
    96	- Add `ql-oplog::wire::FormatIdWire` enum mirroring the planned tagged tuple. This is the "destination shape" for Op variants.
    97	- Do NOT yet change `Op::RegisterFormat.id` — keep as u32 for compilation.
    98	- Add `FormatIdWire::from_u32_legacy(n: u32) -> FormatIdWire` (the migration helper).
    99	- Tests: round-trip FormatIdWire through serde JSON.
   100	- Commit: `Phase 5.2 D-1 step 2 — introduce FormatIdWire in ql-oplog::wire`.
   101	
   102	### Step 3: Change `ql-storage::FormatId` to the tagged tuple (2-3 hours)
   103	
   104	- Update `format.rs` enum definition + all internal logic (`register_at`, `intern`, `lookup`, etc.).

 succeeded in 283ms:
   216	### Presence container: `"presence"` LoroMap (per-peer ephemeral)
   217	
   218	**Phase 5.6 V1 ✅ shipped at `c677e244704` (2026-05-19).**
   219	Holds the per-peer cursor + selection + typing indicator. Keys
   220	are `ql_collab::PeerId` in 16-hex `Display` form (the audit
   221	during 5.6 V1 deviated from the pre-implementation "UUIDs"
   222	language since PeerId is u64-native to match Loro's PeerID type);
   223	values are JSON blobs with `{sheet, row, col, selection_end_row,
   224	selection_end_col, typing: bool}`.
   553	`FormatTable::register_at` rejects the second with
   554	`FormatRejectedSource::IdCollision`. Result: replay fails
   555	deterministically rather than merging cleanly.
   556	
   557	**Resolution:** Phase 5.2 changes `FormatId` from `u32` to a
   558	tagged tuple:
   559	
   560	```rust
   561	pub enum FormatId {
   562	    Builtin(u32),        // Excel-canonical ids 0–163 (unchanged)
   563	    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
   564	}
   565	```
   566	
   567	Each peer's allocator increments only its own `Custom` counter;
   568	two peers can't collide. Built-in ids stay `u32` for round-trip
   569	with Excel's id space.
   570	
   571	**Schema impact:**
   572	- `Op::RegisterFormat.id`, `Op::SetCellFormat.id`,
   573	  `ql_storage::FormatId`, `Workbook::formats_mut().intern`
   574	  signature, `.qbook` envelope cell-format-id encoding, xlsx
   575	  `cellXfs` numFmtId mapping all change.
   576	- Wire-format bump: `WORKBOOK_SCHEMA_VERSION` increments.
   577	- Backwards compat: old `.qbook` files with `u32` ids load as
   578	  `FormatId::Builtin(n)` if `n ≤ 163` or
   579	  `FormatId::Custom(LegacyPeer, n - FIRST_CUSTOM_FORMAT_ID)`
   580	  for migration. (Phase 5.2 designs the migration path.)
   581	
   582	**Why not UUID?** UUIDs are bigger (128-bit), opaque to humans,
   583	and don't carry the peer-of-origin information that
   584	collaboration tooling wants. The tagged tuple gives the same

 succeeded in 279ms:
    38	pub mod error;
    39	pub mod log;
    40	pub mod op;
    41	pub mod peer;
    42	pub mod replay;
    43	pub mod wire;
    44	
    45	pub use error::OpLogError;
    46	pub use log::{OpLog, PRESENCE_COMMIT_ORIGIN};
    47	pub use op::{LocaleWire, Op, ReferenceModeWire};
    48	pub use peer::PeerId;
    49	pub use replay::{replay_into, ReplayError};
    50	pub use wire::{CellWireValue, NamedTargetWire, WireDecodeError};
    51	
    52	// **Tier D2 (2026-05-19) — Phase 4.12 Opus-C HIGH-3 closure**: the
    53	// `persistence` module (save_workbook_with_oplog / load_workbook_with_oplog
    54	// / PersistenceError) moved to `ql-io::oplog_persistence`. The move
    55	// inverts the prior `ql-oplog → ql-io` dependency so Phase 5 CRDT

exec
/bin/zsh -lc "nl -ba crates/ql-oplog/src/log.rs | sed -n '196,206p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 235ms:
   196	    }
   197	
   198	    /// **Phase 5.6 (2026-05-19):** write the given peer's presence blob
   199	    /// into the `"presence"` LoroMap.
   200	    ///
   201	    /// `peer_key` is a string identifier (typically the 16-hex form of
   202	    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
   203	    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
   204	    /// This layer doesn't interpret the bytes.
   205	    ///
   206	    /// LWW semantics per peer: a later `presence_set` for the same

exec
/bin/zsh -lc "rg -n \"PeerId\" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/docs/phase5/d-1-starting-checklist.md quantbook-engine/docs/architecture/crdt-data-model.md -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/crdt-data-model.md:220:are `ql_collab::PeerId` in 16-hex `Display` form (the audit
quantbook-engine/docs/architecture/crdt-data-model.md:222:language since PeerId is u64-native to match Loro's PeerID type);
quantbook-engine/docs/architecture/crdt-data-model.md:454:pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
quantbook-engine/docs/architecture/crdt-data-model.md:460:pub use peer::PeerId;
quantbook-engine/docs/architecture/crdt-data-model.md:486:scaffold's known limitation — `PeerId` stored as a label only — was
quantbook-engine/docs/architecture/crdt-data-model.md:489:`PeerId` now propagates to `LoroDoc::set_peer_id`, so Loro's CRDT
quantbook-engine/docs/architecture/crdt-data-model.md:563:    Custom(PeerId, u32), // Phase 5 custom ids: peer-id + per-peer counter
quantbook-engine/docs/phase5/d-1-starting-checklist.md:20:    Custom(PeerId, u32),     // peer-allocated custom format ids
quantbook-engine/docs/phase5/d-1-starting-checklist.md:39:  - `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`
quantbook-engine/docs/phase5/d-1-starting-checklist.md:42:  - `FormatTable::intern(&mut self, s: &str) -> FormatId` — needs peer-id context. Either: (a) add `intern_with_peer(peer: PeerId, s: &str)`; or (b) make FormatTable peer-aware via a `peer_id: PeerId` field set at construction.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:43:  - `FormatTable::next_custom_id(&self) -> u32` becomes `next_custom_id(&self, peer: PeerId) -> u32` (per-peer counter).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:58:  - `PeerId` needs to be accessible at this layer for the `Custom(PeerId, u32)` variant. Either: (a) move `ql-collab::PeerId` down to `ql-oplog::PeerId`; (b) introduce a copy at ql-oplog level. **Recommend (a)** since PeerId is a Loro-native u64 — fits naturally at the op log layer.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:66:  - **Sentinel `LEGACY_PEER` constant proposal:** `pub const LEGACY_PEER: PeerId = PeerId::new(0)` in `ql-oplog::peer` (the new home for PeerId per D-1 step 1). PeerId(0) is a reserved sentinel — Loro accepts it as a valid peer-id but Phase 5.2.b documents that "two concurrent sessions MUST use distinct peer ids," so production callers will avoid 0; LegacyPeer claiming 0 is safe. Alternative: `PeerId(u64::MAX - 1)` (Loro rejects MAX itself but MAX-1 is valid). Pick one in step 1.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:87:### Step 1: Introduce `PeerId` at ql-oplog layer (1-2 hours)
quantbook-engine/docs/phase5/d-1-starting-checklist.md:89:- Move `ql-collab::peer::PeerId` to `ql-oplog::peer::PeerId` (or copy-then-re-export to avoid breaking ql-collab callers).
quantbook-engine/docs/phase5/d-1-starting-checklist.md:90:- `ql-collab` re-exports `ql_oplog::PeerId` to keep its public surface stable.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:92:- Commit: `Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer`.
quantbook-engine/docs/phase5/d-1-starting-checklist.md:105:- `FormatTable` may need a `peer_id: PeerId` field set at construction.

exec
/bin/zsh -lc "rg -n \"ql_collab::|ql-collab|ql_collab\" quantbook-engine/crates -g '"'!target'"'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/peer.rs:3://! **Phase 5.2.a (2026-05-19):** introduced as `ql_collab::PeerId`.
quantbook-engine/crates/ql-oplog/src/peer.rs:6://! reference it without a reverse `ql-oplog → ql-collab` dep. `ql-collab`
quantbook-engine/crates/ql-oplog/src/peer.rs:17://! - `ql_collab::CollabSession` — attached at session-create time
quantbook-engine/crates/ql-oplog/src/peer.rs:19://!   `ql_collab::PeerId` for back-compat.
quantbook-engine/crates/ql-oplog/src/peer.rs:20://! - `ql_collab::presence` — keys the `"presence"` `LoroMap` in
quantbook-engine/crates/ql-oplog/src/log.rs:41:/// typed `PresenceState` encoding lives in `ql_collab::presence`).
quantbook-engine/crates/ql-oplog/src/log.rs:45:/// writes. `ql_collab::CollabSession` wires this to Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:48:/// layer (ql-collab) can reference the same string constant.
quantbook-engine/crates/ql-oplog/src/log.rs:153:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:203:    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
quantbook-engine/crates/ql-oplog/src/log.rs:282:    /// after construction. The `ql_collab::CollabSession`
quantbook-engine/crates/ql-collab/Cargo.toml:2:name = "ql-collab"
quantbook-engine/crates/ql-collab/Cargo.toml:13:# **Phase 5.2.a (2026-05-19) — ql-collab scaffold.** Per the audit-
quantbook-engine/crates/ql-collab/Cargo.toml:15:# ql-collab is the Phase 5 collaboration crate. Depends on
quantbook-engine/crates/ql-collab/src/lib.rs:1://! `ql-collab` — Phase 5 multi-user CRDT collaboration crate.
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1, 2026-05-19; originally `ql_collab::peer::PeerId` at 5.2.a).
quantbook-engine/crates/ql-collab/src/lib.rs:54://!   would wrap it in a ql-collab-owned error. Will be re-typed
quantbook-engine/crates/ql-collab/src/lib.rs:63://!   `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId` (preparation
quantbook-engine/crates/ql-collab/src/lib.rs:64://!   for `FormatId::Custom(PeerId, u32)`). `ql_collab::PeerId` is now
quantbook-engine/crates/ql-collab/src/lib.rs:66://!   external callers using `ql_collab::PeerId` keep working.

exec
/bin/zsh -lc "nl -ba docs/architecture/crdt-data-model.md | sed -n '444,464p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 264ms:
   444	the new transport path handles the multi-peer case. Both call
   445	the same `replay_into` internally.
   446	
   447	## `ql-collab` crate scope
   448	
   449	**Phase 5 V1 COMPLETE 2026-05-19.** Current 5-module surface (verified against `crates/ql-collab/src/lib.rs`):
   450	
   451	```rust
   452	// crates/ql-collab/src/lib.rs
   453	
   454	pub mod peer;        // PeerId newtype (u64 wrapper, 16-hex Display)
   455	pub mod presence;    // PresenceState + per-peer LoroMap (5.6 V1+V2)
   456	pub mod session;     // CollabSession + UndoGroupGuard (5.2.a..5.5 V2 V1)
   457	pub mod transport;   // Transport trait + NoopTransport + LoopbackTransport (5.5 V1+V2 V1)
   458	pub mod undo;        // pub use loro::UndoManager (5.4 V1+V2 V1+V2 V1.1)
   459	
   460	pub use peer::PeerId;
   461	pub use presence::{PresenceError, PresenceState};
   462	pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
   463	pub use transport::{LoopbackTransport, NoopTransport, Transport, TransportError};
   464	pub use undo::UndoManager;

codex
The targeted `cargo test -p ql-oplog peer::` gate passes: all 3 moved peer tests ran and succeeded. I’m consolidating now; the only step-2 code concern I see is that `PeerId` has no serde story yet, which matters for a serde-derived `FormatIdWire`.
  ✓ Inspect commit diff, Cargo dependency edges, and relevant module docs
  ✓ Search for broken public paths and stale references
  ✓ Run targeted ql-oplog peer tests and inspect wire readiness
  → Produce severity-ranked verdict in requested format
codex
No HIGH dependency-direction issue found. The step-1 move compiles and the targeted peer tests pass, but I found a few forward-risk items to close before step 2 hardens the wire API.

[HIGH] `PeerId` has no serde representation for `FormatIdWire`
File:Line: [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/peer.rs:36)
Detail: Step 2 plans a serde round-trip-tested `FormatIdWire` with `Custom(PeerId, u32)`. Current `PeerId` derives only copy/hash/order traits, so a normally-derived `Serialize`/`Deserialize` on `FormatIdWire` will fail unless step 2 adds manual serde or first gives `PeerId` a deliberate wire shape. This is also the right moment to decide whether peer ids serialize as raw `u64` or 16-hex strings.
Recommendation: fix now

[MEDIUM] `ql_collab::peer::PeerId` path is broken despite “public surface unchanged”
File:Line: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:62)
Detail: Workspace code has no live `ql_collab::peer::PeerId`, `ql_collab::peer::*`, or `crate::peer::PeerId` users. But `pub mod peer` was a public module, so external callers using `ql_collab::peer::PeerId` do break. The doc is accurate only for `ql_collab::PeerId`, not for the old module path.
Recommendation: fix now

[MEDIUM] `LEGACY_PEER` deferral to step 5 is too late for the written plan
File:Line: [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:66)
Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
Recommendation: fix now

[MEDIUM] `ql-storage::FormatId` still cannot directly use `ql_oplog::PeerId`
File:Line: [Cargo.toml](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/Cargo.toml:18)
Detail: `ql-oplog` already depends on `ql-storage`, while `ql-storage` has no `ql-oplog` dependency. If step 3 literally makes `ql_storage::FormatId::Custom(ql_oplog::PeerId, u32)`, Cargo will form a cycle. Decide before step 2 whether `PeerId` must move further down, such as `ql-types`, or whether storage will use a storage-owned/shared peer-id type with conversions at the wire boundary.
Recommendation: fix now

[LOW] D-1 checklist has stale dependency text for `ql-oplog`
File:Line: [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:55)
Detail: It says making `ql-oplog` depend on `ql-storage` is “Option B” and “currently doesn’t.” Current Cargo already has `ql-oplog -> ql-storage`. This matters because it hides the real ownership problem above.
Recommendation: fix now

[LOW] Architecture doc still shows `ql-collab` exporting `pub mod peer`
File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
Detail: The section says it was verified against `crates/ql-collab/src/lib.rs`, but now shows a stale 5-module surface with `pub mod peer` and `pub use peer::PeerId`. Current code has no `peer` module and re-exports `ql_oplog::PeerId`.
Recommendation: fix now

[LOW] Existing `op.rs` wire doc still names old `ql_io::qbook_format`
File:Line: [op.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/op.rs:28)
Detail: The code imports `CellWireValue` and `NamedTargetWire` from `crate::wire`, but the doc still says `ValueWire`/`NamedTargetWire` are reused from `ql_io::qbook_format`. Not a behavior risk, but it is stale in the exact area step 2 will edit.
Recommendation: defer to step 2

PASS confirmations:
- `ql-oplog/Cargo.toml` has no `ql-collab` dependency; `ql-collab/Cargo.toml` still depends on `ql-oplog`.
- No workspace code uses `ql_collab::peer::PeerId` or `ql_collab::peer::*`.
- `cargo test -p ql-oplog peer::` passed: 3 passed, 0 failed.
- `ql-oplog::wire` is otherwise structurally ready for `FormatIdWire`: serde/thiserror are already present, and `WireDecodeError` is extensible.
tokens used
106,735
No HIGH dependency-direction issue found. The step-1 move compiles and the targeted peer tests pass, but I found a few forward-risk items to close before step 2 hardens the wire API.

[HIGH] `PeerId` has no serde representation for `FormatIdWire`
File:Line: [peer.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/peer.rs:36)
Detail: Step 2 plans a serde round-trip-tested `FormatIdWire` with `Custom(PeerId, u32)`. Current `PeerId` derives only copy/hash/order traits, so a normally-derived `Serialize`/`Deserialize` on `FormatIdWire` will fail unless step 2 adds manual serde or first gives `PeerId` a deliberate wire shape. This is also the right moment to decide whether peer ids serialize as raw `u64` or 16-hex strings.
Recommendation: fix now

[MEDIUM] `ql_collab::peer::PeerId` path is broken despite “public surface unchanged”
File:Line: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/lib.rs:62)
Detail: Workspace code has no live `ql_collab::peer::PeerId`, `ql_collab::peer::*`, or `crate::peer::PeerId` users. But `pub mod peer` was a public module, so external callers using `ql_collab::peer::PeerId` do break. The doc is accurate only for `ql_collab::PeerId`, not for the old module path.
Recommendation: fix now

[MEDIUM] `LEGACY_PEER` deferral to step 5 is too late for the written plan
File:Line: [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:66)
Detail: The checklist says “Pick one in step 1,” and step 2 already calls for `FormatIdWire::from_u32_legacy(n)`. That helper needs the sentinel before the qbook envelope migration in step 5. Deferring because there is no current use site is understandable, but it creates a likely duplicate/inline sentinel in step 2.
Recommendation: fix now

[MEDIUM] `ql-storage::FormatId` still cannot directly use `ql_oplog::PeerId`
File:Line: [Cargo.toml](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/Cargo.toml:18)
Detail: `ql-oplog` already depends on `ql-storage`, while `ql-storage` has no `ql-oplog` dependency. If step 3 literally makes `ql_storage::FormatId::Custom(ql_oplog::PeerId, u32)`, Cargo will form a cycle. Decide before step 2 whether `PeerId` must move further down, such as `ql-types`, or whether storage will use a storage-owned/shared peer-id type with conversions at the wire boundary.
Recommendation: fix now

[LOW] D-1 checklist has stale dependency text for `ql-oplog`
File:Line: [d-1-starting-checklist.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/phase5/d-1-starting-checklist.md:55)
Detail: It says making `ql-oplog` depend on `ql-storage` is “Option B” and “currently doesn’t.” Current Cargo already has `ql-oplog -> ql-storage`. This matters because it hides the real ownership problem above.
Recommendation: fix now

[LOW] Architecture doc still shows `ql-collab` exporting `pub mod peer`
File:Line: [crdt-data-model.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/crdt-data-model.md:449)
Detail: The section says it was verified against `crates/ql-collab/src/lib.rs`, but now shows a stale 5-module surface with `pub mod peer` and `pub use peer::PeerId`. Current code has no `peer` module and re-exports `ql_oplog::PeerId`.
Recommendation: fix now

[LOW] Existing `op.rs` wire doc still names old `ql_io::qbook_format`
File:Line: [op.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog/src/op.rs:28)
Detail: The code imports `CellWireValue` and `NamedTargetWire` from `crate::wire`, but the doc still says `ValueWire`/`NamedTargetWire` are reused from `ql_io::qbook_format`. Not a behavior risk, but it is stale in the exact area step 2 will edit.
Recommendation: defer to step 2

PASS confirmations:
- `ql-oplog/Cargo.toml` has no `ql-collab` dependency; `ql-collab/Cargo.toml` still depends on `ql-oplog`.
- No workspace code uses `ql_collab::peer::PeerId` or `ql_collab::peer::*`.
- `cargo test -p ql-oplog peer::` passed: 3 passed, 0 failed.
- `ql-oplog::wire` is otherwise structurally ready for `FormatIdWire`: serde/thiserror are already present, and `WireDecodeError` is extensible.
