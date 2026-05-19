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
session id: 019e424c-86dc-7452-9abc-4a8629db063e
--------
user
# Codex audit — Phase 5.2 D-1 step 3 (FormatId enum + 241 cascade fixups) 2026-05-19

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

HEAD: `36d580aa723` (doc-only follow-up to `af803f1a3f2`).
**Audit target:** commit `af803f1a3f2` (Phase 5.2 D-1 step 3 — FormatId enum + cascading downstream fixups).
Predecessor chain: `1f83fd5f9a4` (step 2 audit closures) → step 2 ship `135bbb99f75` → step 1.1 `1e383dc9eeb` → step 1 `aaa54d32f4d`.

## What shipped (largest D-1 commit so far)

Single commit, 19 files, +667 / -249 lines. The schema-defining change of the D-1 arc:

**ql-storage (schema):**
- `pub struct FormatId(pub u32)` → `pub enum FormatId { Builtin(u32), Custom(PeerId, u32) }`.
- `FormatTable` carries `local_peer: PeerId` (set at construction; default `LEGACY_PEER`).
- `FormatTable::with_peer(peer)` constructor + `set_local_peer(peer)` setter.
- `FormatTable::intern(s)` allocates `Custom(local_peer, counter)` — counter starts at 0 (was 164 in pre-step-3).
- `FormatTable::next_custom_id() → u32` renamed to `next_custom_counter() → u32`.
- `FormatId::is_builtin()`, `is_custom()`, `GENERAL = Builtin(0)`.
- `FormatId::legacy_from_u32(n)`: migration helper (n≤163 → Builtin(n); n≥164 → Custom(LEGACY_PEER, n-164)).
- `FormatId::to_legacy_u32() → Option<u32>`: inverse (returns None for non-LEGACY Custom ids).
- 8 new tests covering peer-aware allocation, distinct-peer collision-freedom, legacy round-trip.

**ql-oplog (op + replay):**
- `FormatRejectedSource::id` type `u32` → `FormatId`.
- Replay handler for `Op::RegisterFormat { id: u32 }` + `Op::SetCellFormat { id: Option<u32> }` converts via `FormatId::legacy_from_u32`. **Op shape still u32 — step 4 will change to FormatIdWire and drop this conversion.**

**ql-io (qbook envelope):**
- Save: `id.0` → `id.to_legacy_u32().expect("pre-step-4 FormatId must be expressible as legacy u32")`. Filter `id.0 >= FIRST_CUSTOM_FORMAT_ID` → `id.is_custom()`.
- Load: `FormatId(entry.id)` → `FormatId::legacy_from_u32(entry.id)`. HashSet<u32> known-ids → HashSet<FormatId>.

**ql-io-xlsx:**
- Import (styles_import + top-level lib.rs): `FormatId(num_fmt_id)` → `FormatId::legacy_from_u32(num_fmt_id)`.
- Export (umya_export): `id.0` → `id.to_legacy_u32().expect(...)`. Filter → `is_custom()`. Sort key uses legacy u32.

**ql-exec:**
- `RuntimeError::UnknownFormatId(u32)` → `UnknownFormatId(FormatId)`.
- `intern_format` predicts `Custom(local_peer, next_custom_counter)`; Op append uses `to_legacy_u32().expect(...)`. Debug-assert predicted == allocated.

**Tests:** ~50 sites updated across 11 files. `FormatId(N)` → `FormatId::Builtin(N)` (N ≤ 163) or `FormatId::legacy_from_u32(N)` (N ≥ 164). `id.0` print sites → `{:?}` Debug.

## Gates verified

- `cargo test --workspace`: **4244** passed (4237 baseline + 7 new step-3 tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
- `cargo build --workspace --tests` clean.
- HEAD blob = disk (599/599 for `format.rs`). No truncation.

## What to check — this is the FOUNDATIONAL audit of the D-1 arc

Errors here cascade through steps 4-7. False negatives compound. Be thorough.

### Critical correctness checks

1. **`legacy_from_u32` ↔ `to_legacy_u32` round-trip.** For all u32 `n`, `FormatId::legacy_from_u32(n).to_legacy_u32() == Some(n)`. Test `legacy_round_trip_through_helpers` at format.rs covers some — verify ALL `u32` values: 0, 1, 163, 164, 165, u32::MAX. Pin via tests.

2. **`FormatId::Builtin(n)` for `n > 163` — is it allowed?** The enum doesn't enforce `n ≤ 163` in `Builtin`. Could a caller construct `FormatId::Builtin(999)` (semantically a custom xlsx-numFmtId)? Should we reject? If allowed, what does `to_legacy_u32()` return? `Some(999)` per current impl. Is that correct or should it return None / panic for out-of-range built-ins?

3. **Boundary mirroring with `FormatIdWire::from_u32_legacy`.** Both `FormatId::legacy_from_u32` (storage) and `FormatIdWire::from_u32_legacy` (wire, shipped at step 2 in `crates/ql-oplog/src/wire.rs`) use the same 163/164 boundary. Verify they agree exactly. Any drift is a step-5 envelope-load-vs-replay divergence waiting to happen.

4. **`register_at` counter-advancement.** When `id = Custom(local_peer, c)` and `c >= next_custom_counter`, advance to `c + 1`. What if `c == next_custom_counter` exactly? Advances by 1 (correct). What if `c < next_custom_counter`? No advance (correct — counter is monotonic). What if `id = Custom(other_peer, c)`? No advance (correct — remote peer's allocation doesn't affect our counter). Pin all 4 cases via tests. Currently only some are pinned.

5. **`set_local_peer(new)` counter semantics.** The counter is single (`next_custom_counter: u32`), not per-peer. If local_peer changes mid-session, the counter does NOT reset. Example: workbook starts LEGACY_PEER, interns "A" → Custom(LEGACY, 0). Counter = 1. `set_local_peer(42)`. Counter still 1. Intern "B" → Custom(42, 1). The peer-42 counter sequence skips 0. Is this intentional, harmful, or just suboptimal? Step 4 wiring will surface the answer.

6. **`to_legacy_u32().expect()` invariants across cascade sites.** Each `expect()` is load-bearing — panic if a non-LEGACY peer FormatId reaches it. Enumerate the expect() sites:
   - `qbook_format.rs:1115` (format_overlay save)
   - `qbook_format.rs:~1192` (FormatEntry save)
   - `umya_export.rs:~292` (overlay sort key)
   - `umya_export.rs:~334` (custom_formats filter)
   - `umya_export.rs:~1001` (cellXfs numFmtId emit)
   - `ql-exec/src/workbook_runtime/formats.rs::intern_format` (Op::RegisterFormat append)
   - `ql-exec/src/workbook_runtime/formats.rs::set_cell_format` (Op::SetCellFormat append)
   Verify each is genuinely safe at step 3 (i.e. step 3 doesn't allow non-LEGACY peer FormatIds anywhere). Cross-check that no test creates a `FormatTable::with_peer(non_LEGACY)` and then exercises these paths.

7. **Producer/replay determinism.** `producer_replay_equivalence.rs` test verifies that running an op-log through producer-side application + through replay produces identical workbooks. With step 3's changes (Op carries u32 legacy id, both sides convert via `legacy_from_u32`), is the determinism preserved? The new `HashMap<FormatId, String>` comparison should catch divergence — verify the test exercises Register + SetCellFormat ops.

8. **`Default for FormatId`.** Was `derive(Default)` returning `FormatId(0)` pre-step-3 (the default for newtype u32). Now `Default` is hand-impl'd returning `Builtin(0)` (= `GENERAL`). Verify any code path that relies on `FormatId::default()` still gets the right value.

9. **`FormatId::GENERAL` semantics.** Was `FormatId(0)` ≡ first slot in the FormatTable. Now `Builtin(0)` ≡ first slot. Verify FormatTable's BUILTIN_FORMATS initialization populates `Builtin(0)` → "General" (not `Custom(_, 0)`).

### Cascade callsite correctness

10. **Search for any `id.0` access still in the codebase.** Step 3 should have eliminated all of them. Run `rg "id\.0[^0-9_a-z]" crates/ --type rust | grep -v "test_\|// "` and verify only test-comment or NUmber(N.0) literals remain.

11. **Search for any `FormatId(N)` tuple-struct construction still in the codebase.** Similar check: `rg "FormatId\(" crates/ --type rust | grep -v "is_a\|\.0\|//"`. Should yield zero hits for the tuple-struct form.

12. **HashMap/HashSet keyed by FormatId.** Verify the `derive(Hash, Eq)` produces a sound hash (Builtin(0) and Custom(_, 0) MUST hash differently). Test `equality_and_hash_consistent_across_variants` covers FormatIdWire — does an equivalent exist for FormatId? Should.

13. **Op-log wire compat across step 3.** A `.qbook` file saved at step 2 (Op::RegisterFormat with id=164) must replay correctly at step 3 via the `legacy_from_u32` conversion. No `oplog.bin` fixtures exist in the repo (Tier D3 work is step 7); verify the legacy conversion path manually via the existing replay tests.

### Forward-readiness for step 4

14. **Step 4 will:** change `Op::RegisterFormat { id: u32 }` → `Op::RegisterFormat { id: FormatIdWire }`. The producer + replay sites currently use `to_legacy_u32().expect()` / `legacy_from_u32`. Step 4 drops these. Verify the substitution is mechanical (no logic changes needed) for each site.

15. **Step 4 also wires `OpLog::set_peer_id(peer)` → calls `FormatTable::set_local_peer(peer)`** so the workbook's format allocator picks up the session's PeerId. Today the FormatTable allocator is LEGACY_PEER unless someone explicitly calls `with_peer(non_LEGACY)`. Check: is there a code path where `OpLog::set_peer_id` is called but `FormatTable::set_local_peer` is not? If so, that's the gap step 4 closes.

## Verdict format

```
[SEV] <one-line summary>
File:Line: <path:line>
Detail: <2-4 sentences>
Recommendation: <PASS | fix now | defer to step N>
```

Severities: HIGH (blocks step 4), MEDIUM (should-fix this cycle), LOW (polish).

Be thorough. This is a foundational schema commit. If nothing is wrong, say PASS explicitly with the reasoning.

Report under 1500 words. Use file:line citations.

codex
I’ll audit the target commit from the local worktree and diff against its parent, then cross-check the invariants in the current files since HEAD is described as doc-only. I’m starting with the project instructions, commit diff, and the relevant format/oplog/export paths.
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
/bin/zsh -lc 'git show --name-only --format=medium af803f1a3f2' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
commit af803f1a3f29ea8d29c92c4bbdfa2a0d2cbdd1ce
Author: steppen0mad <nurtaymergaliyev@gmail.com>
Date:   Tue May 19 23:03:54 2026 +0100

    Phase 5.2 D-1 step 3 — FormatId enum in ql-storage + cascading downstream fixups
    
    Schema change: `pub struct FormatId(pub u32)` → `pub enum FormatId {
    Builtin(u32), Custom(PeerId, u32) }`. Mirrors `FormatIdWire` shape
    shipped at step 2. Phase 5.1 audit-locked decision D-1.
    
    Per the d-1-checklist, step 3 was scoped as "ql-storage change only;
    downstream breaks, fixed in steps 4-6." The project's gates-clean-
    every-commit discipline made that approach untenable — `cargo test
    --workspace` failing for 3+ commits would break CI bisection. So
    this commit ships ql-storage + all 241 cascading callsites across 6
    crates so the workspace stays green throughout the D-1 arc.
    
    ql-storage (the schema-defining crate):
    - FormatId enum + accessors: `is_builtin()`, `is_custom()`, GENERAL
      (= Builtin(0)).
    - FormatId::legacy_from_u32(n): migration helper mirroring
      `FormatIdWire::from_u32_legacy`. Maps n<=163 → Builtin(n);
      n>=164 → Custom(LEGACY_PEER, n-164). Used by qbook envelope
      loader (step 5) and xlsx import.
    - FormatId::to_legacy_u32(): inverse of legacy_from_u32. Returns
      None for non-LEGACY peer Custom ids (unrepresentable in pre-5.2
      envelope). Pre-step-6 callers expect() Some.
    - FormatTable carries `local_peer: PeerId` (set at construction;
      default LEGACY_PEER). `intern(s)` allocates `Custom(local_peer,
      counter)`; counter is per-peer (starts at 0, was 164 in legacy).
      `with_peer(peer)` constructor + `set_local_peer(peer)` setter for
      step 4 CollabSession integration.
    - `next_custom_id() -> u32` renamed to `next_custom_counter() -> u32`
      (semantic: returns the counter component, not full FormatId).
    - `register_at(id, s)` advances local counter when `id =
      Custom(local_peer, c)` and `c >= next_custom_counter`. Other-peer
      ids tracked but don't affect local allocator.
    - 8 new format.rs tests covering: peer-aware intern, distinct-peer
      collision-freedom, legacy_from_u32 boundaries (0/163/164/large),
      to_legacy_u32 round-trip, non-legacy-peer None case.
    
    ql-oplog (op-log + replay):
    - FormatRejectedSource: `id: u32` → `id: ql_storage::FormatId` (also
      existing_id + attempted_id). Error display uses Debug format.
    - Replay handler for Op::RegisterFormat + Op::SetCellFormat converts
      the (still u32 pre-step-4) wire payload through legacy_from_u32.
      Step 4 will drop this conversion when Op variants take FormatIdWire.
    
    ql-io (qbook envelope):
    - Save side: `id.0` (raw u32 access) → `id.to_legacy_u32().expect(...)`.
      `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter → `id.is_custom()`. Expect()
      is load-bearing — step 5 will change the envelope schema to carry
      FormatIdWire directly, dropping the expect.
    - Load side: `FormatId(entry.id)` → `FormatId::legacy_from_u32(entry.id)`.
    - HashSet<u32> known-ids → HashSet<FormatId> (enum derives Hash + Eq).
    
    ql-io-xlsx (xlsx interop):
    - xlsx import (styles_import + top-level): `FormatId(num_fmt_id)` →
      `FormatId::legacy_from_u32(num_fmt_id)`. xlsx custom numFmtIds
      (>=164) land under LEGACY_PEER per the migration contract.
    - xlsx export (umya_export): `id.0` → `id.to_legacy_u32().expect(...)`.
      Sort key + numFmtId emit use the legacy u32. Step 6 will handle
      multi-peer xlsx export properly.
    
    ql-exec (runtime):
    - RuntimeError::UnknownFormatId(u32) → UnknownFormatId(FormatId).
      Error message uses Debug to distinguish Builtin vs Custom variants.
    - intern_format predicts `Custom(local_peer, next_counter)` instead
      of `FormatId(next_custom_id)`. Same Op::RegisterFormat append path
      (u32 wire pre-step-4); to_legacy_u32 expect()s the conversion.
    
    Tests updated:
    - ~50 test sites across 11 files. `FormatId(N)` → `FormatId::Builtin(N)`
      for N <= 163; `FormatId(N)` → `FormatId::legacy_from_u32(N)` for
      N >= 164. `id.0` print sites → `{:?}` Debug format. `.0 >= 164`
      filters → `.is_custom()`.
    - 8 new ql-storage tests pinning peer-aware allocation + collision-
      freedom + legacy round-trip.
    
    Verified:
    - 4244 workspace tests passing (4237 baseline + 7 new step-3 tests).
    - fmt + clippy clean workspace-wide.
    - cargo build --workspace --tests clean.
    - HEAD blob = disk for all touched files (no truncation race).
    
    Audit deferred to fresh session per CLAUDE.md max-2-cycles rule.
    This is cycle 3 of the session (override of the rule was explicit
    per user direction). Steps 4 (Op::RegisterFormat uses FormatIdWire),
    5 (qbook envelope schema bump), 6 (xlsx export), 7 (Tier D3), and
    the mandatory step-3 audit await fresh-session work.
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs
quantbook-engine/crates/ql-io-xlsx/src/lib.rs
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs
quantbook-engine/crates/ql-io/src/qbook_format.rs
quantbook-engine/crates/ql-oplog/src/replay.rs
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs
quantbook-engine/crates/ql-storage/src/format.rs
quantbook-engine/crates/ql-storage/src/format_overlay.rs
quantbook-engine/crates/ql-storage/src/lib.rs

exec
/bin/zsh -lc 'git status --short && git rev-parse HEAD && git rev-parse af803f1a3f2''^ && git show --stat --oneline --decorate --no-renames af803f1a3f2' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 912ms:
?? .codex-d1-step3-audit-prompt.md
?? .codex-d1-step3-audit.out
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
36d580aa723797af03f6d02ad28c33803f1d62a2
1f83fd5f9a40f444aaff28e33255a21783c35a50
af803f1a3f2 Phase 5.2 D-1 step 3 — FormatId enum in ql-storage + cascading downstream fixups
 .../crates/ql-exec/src/workbook_runtime/error.rs   |   9 +-
 .../crates/ql-exec/src/workbook_runtime/formats.rs |  60 +++-
 quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs |   5 +-
 quantbook-engine/crates/ql-io-xlsx/src/lib.rs      |   8 +-
 .../crates/ql-io-xlsx/src/read/styles_import.rs    |  19 +-
 .../crates/ql-io-xlsx/src/write/umya_export.rs     |  33 +-
 .../crates/ql-io-xlsx/tests/calamine_smoke.rs      |  47 +--
 .../crates/ql-io-xlsx/tests/opus_a_deep_probe.rs   |  45 ++-
 .../crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs      |   8 +-
 .../crates/ql-io-xlsx/tests/opus_a_edge_cases.rs   |  12 +-
 .../ql-io-xlsx/tests/opus_a_format_no_overlay.rs   |  12 +-
 .../tests/opus_a_phase_4_12_ide_proof.rs           |  13 +-
 .../ql-io-xlsx/tests/phase_4_11_corpus_probe.rs    |   4 +-
 quantbook-engine/crates/ql-io/src/qbook_format.rs  |  91 +++--
 quantbook-engine/crates/ql-oplog/src/replay.rs     |  51 ++-
 .../ql-oplog/tests/producer_replay_equivalence.rs  |  41 ++-
 quantbook-engine/crates/ql-storage/src/format.rs   | 398 +++++++++++++++++----
 .../crates/ql-storage/src/format_overlay.rs        |  49 +--
 quantbook-engine/crates/ql-storage/src/lib.rs      |  11 +-
 19 files changed, 667 insertions(+), 249 deletions(-)

codex
The root instructions appear to be a generic VS Code template and don’t match this Rust workspace, so I’m treating the repository’s actual Cargo structure as authoritative. The worktree has many untracked notes/assets, but no tracked modifications surfaced in `git status --short`; I’ll avoid touching them.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format.rs | sed -n '260,620p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Workbook-level format-string interning table (Phase 4.5.D part 3,
     2	//! W5-79).
     3	//!
     4	//! `FormatTable` reserves Excel built-in format IDs 0-163 (`Builtin`
     5	//! variant) and allocates custom IDs as `Custom(peer, counter)` tuples
     6	//! (Phase 5.2 D-1 step 3 — was a bare `u32` pre-step-3). Pre-populates
     7	//! the parser-relevant subset of built-ins (mini-spec § 10) so cells
     8	//! with the most common formats resolve without any registration calls.
     9	//!
    10	//! ## Phase 5.2 D-1 step 3 (2026-05-19) — tagged-tuple FormatId
    11	//!
    12	//! `FormatId` changed from `pub struct FormatId(pub u32)` to a tagged
    13	//! enum to support multi-peer CRDT collaboration:
    14	//!
    15	//! ```ignore
    16	//! pub enum FormatId {
    17	//!     Builtin(u32),                  // Excel-canonical ids 0..=163
    18	//!     Custom(PeerId, u32),           // peer-allocated, per-peer counter
    19	//! }
    20	//! ```
    21	//!
    22	//! `FormatTable` carries a `local_peer: PeerId` (set at construction)
    23	//! used by [`FormatTable::intern`] when allocating new custom ids.
    24	//! Single-writer / pre-collab callers use [`LEGACY_PEER`] as the
    25	//! `local_peer`. Multi-peer sessions set their own `PeerId` at attach
    26	//! time (Phase 5.2 D-1 step 4 wiring).
    27	//!
    28	//! Migration helper [`FormatId::legacy_from_u32`] converts pre-5.2
    29	//! bare-u32 ids back to the enum shape for backward-compat loading
    30	//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
    31	//!
    32	//! See:
    33	//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
    34	//! - `docs/phase5/d-1-starting-checklist.md` for the multi-step plan.
    35	//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for
    36	//!   the format-string parser.
    37	//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
    38	//!   the parser-relevant built-in subset.
    39	
    40	use std::collections::HashMap;
    41	
    42	use ql_types::{PeerId, LEGACY_PEER};
    43	
    44	/// Workbook format id — tagged tuple (Phase 5.2 D-1 step 3 ship).
    45	///
    46	/// Two variants:
    47	/// - `Builtin(u32)` — Excel-canonical ids `0..=163` (stable across
    48	///   peers; no merge collisions possible by construction).
    49	/// - `Custom(PeerId, u32)` — peer-allocated. Each peer's allocator
    50	///   increments its own `counter`; concurrent peers can't collide
    51	///   because the `PeerId` differs (Phase 5.1 audit-locked decision
    52	///   D-1).
    53	///
    54	/// Use [`FormatId::GENERAL`] for the "no custom format" case (= built-in id 0).
    55	///
    56	/// Mirrors `ql_oplog::wire::FormatIdWire`; the wire type is the
    57	/// `Op::RegisterFormat` / `Op::SetCellFormat` payload (step 4).
    58	#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
    59	pub enum FormatId {
    60	    /// Excel-canonical built-in format id (`0..=163`).
    61	    Builtin(u32),
    62	    /// Peer-allocated custom format id. The `(peer, counter)` pair
    63	    /// is collision-free across concurrent peers because `peer`
    64	    /// differs (Phase 5.1 audit D-1).
    65	    Custom(PeerId, u32),
    66	}
    67	
    68	impl Default for FormatId {
    69	    fn default() -> Self {
    70	        FormatId::GENERAL
    71	    }
    72	}
    73	
    74	impl FormatId {
    75	    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    76	    pub const GENERAL: FormatId = FormatId::Builtin(0);
    77	
    78	    /// True iff this is a built-in (Excel-canonical) format id.
    79	    pub const fn is_builtin(self) -> bool {
    80	        matches!(self, FormatId::Builtin(_))
    81	    }
    82	
    83	    /// True iff this is a peer-allocated custom format id.
    84	    pub const fn is_custom(self) -> bool {
    85	        matches!(self, FormatId::Custom(_, _))
    86	    }
    87	
    88	    /// **Phase 5.2 D-1 step 3 migration helper:** map a pre-5.2 bare
    89	    /// `u32` `FormatId` encoding to the new tagged-tuple form.
    90	    ///
    91	    /// Pre-5.2 encoding: `FormatId(pub u32)`. Values `0..=163` are
    92	    /// Excel built-ins. Values `>=164` were allocated by the pre-5.2
    93	    /// single-writer counter starting at `FIRST_CUSTOM_FORMAT_ID = 164`.
    94	    ///
    95	    /// Mapping:
    96	    /// - `n <= 163` → `Builtin(n)`.
    97	    /// - `n >= 164` → `Custom(LEGACY_PEER, n - 164)`.
    98	    ///
    99	    /// Cross-references `ql_oplog::wire::FormatIdWire::from_u32_legacy`
   100	    /// (the wire-side counterpart shipped at step 2). Both helpers
   101	    /// must agree on the 164 boundary; step 8 megaudit verifies.
   102	    ///
   103	    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
   104	    /// `ql_io_xlsx` import paths (step 6).
   105	    pub fn legacy_from_u32(n: u32) -> Self {
   106	        if n <= FIRST_XLSX_BUILTIN_MAX {
   107	            FormatId::Builtin(n)
   108	        } else {
   109	            FormatId::Custom(LEGACY_PEER, n - FIRST_CUSTOM_FORMAT_ID)
   110	        }
   111	    }
   112	
   113	    /// **Phase 5.2 D-1 step 3:** map this `FormatId` back to the
   114	    /// pre-5.2 bare-`u32` shape, if expressible.
   115	    ///
   116	    /// - `Builtin(n)` → `Some(n)`.
   117	    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
   118	    ///   pre-5.2 saves).
   119	    /// - `Custom(non-legacy-peer, _)` → `None` (a peer other than
   120	    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
   121	    ///   represent it). Step 6's xlsx export decides what to do
   122	    ///   (e.g. flatten by allocation order).
   123	    pub fn to_legacy_u32(self) -> Option<u32> {
   124	        match self {
   125	            FormatId::Builtin(n) => Some(n),
   126	            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
   127	            FormatId::Custom(_, _) => None,
   128	        }
   129	    }
   130	}
   131	
   132	/// Lower-bound of Excel's built-in format-id range (inclusive).
   133	/// `FormatId::Builtin(n)` is valid for `n <= FIRST_XLSX_BUILTIN_MAX`;
   134	/// values above this were custom ids in the pre-5.2 single-writer
   135	/// encoding. Mirrors `ql_oplog::wire::wire::FIRST_XLSX_BUILTIN_MAX`.
   136	const FIRST_XLSX_BUILTIN_MAX: u32 = 163;
   137	
   138	/// First custom (non-built-in) format id in the pre-5.2 bare-u32
   139	/// encoding. Kept as a public constant because xlsx import / export
   140	/// + qbook envelope migration use this boundary explicitly.
   141	///
   142	/// Post-5.2: custom ids live in `FormatId::Custom(peer, counter)`;
   143	/// `counter` starts at `0`, not 164. This constant remains for
   144	/// `to_legacy_u32` / `legacy_from_u32` conversions only.
   145	pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164;
   146	
   147	/// Excel built-in format strings ship in this table at construction time.
   148	/// Per mini-spec § 10, V1 ships the parser-relevant subset; remaining IDs
   149	/// in the 0-163 range can be added lazily when xlsx import (Phase 4.11)
   150	/// surfaces them.
   151	const BUILTIN_FORMATS: &[(u32, &str)] = &[
   152	    (0, "General"),
   153	    (1, "0"),
   154	    (2, "0.00"),
   155	    (3, "#,##0"),
   156	    (4, "#,##0.00"),
   157	    (9, "0%"),
   158	    (10, "0.00%"),
   159	    (11, "0.00E+00"),
   160	    // id 12 (`"# ?/?"`) — V2 fraction, parser refuses; not pre-registered.
   161	    (14, "m/d/yyyy"),
   162	    (15, "d-mmm-yy"),
   163	    (16, "d-mmm"),
   164	    (17, "mmm-yy"),
   165	    (18, "h:mm AM/PM"),
   166	    (19, "h:mm:ss AM/PM"),
   167	    (20, "h:mm"),
   168	    (21, "h:mm:ss"),
   169	    (22, "m/d/yyyy h:mm"),
   170	    (37, "#,##0 ;(#,##0)"),
   171	    // id 38 — V2 color; parser refuses.
   172	    (45, "mm:ss"),
   173	    // id 46 — V2 elapsed; parser refuses.
   174	    (49, "@"),
   175	];
   176	
   177	/// Workbook-level format-string interning + dedup table.
   178	///
   179	/// Cells reference a `FormatId`; the table resolves the id back to a
   180	/// format string the renderer can parse.
   181	///
   182	/// Phase 5.2 D-1 step 3: `FormatTable` now carries a `local_peer`
   183	/// (`PeerId`) used when allocating new `Custom` format ids in
   184	/// [`Self::intern`]. Single-writer / pre-collab construction (e.g.
   185	/// `FormatTable::new()`) uses [`LEGACY_PEER`]; multi-peer
   186	/// `CollabSession` callers re-construct with their session's peer
   187	/// at attach time (step 4 wiring).
   188	#[derive(Clone, Debug)]
   189	pub struct FormatTable {
   190	    /// `id → string`. Sparse (only entries that exist).
   191	    by_id: HashMap<FormatId, String>,
   192	    /// `string → id`. Used by `intern` for dedup.
   193	    by_string: HashMap<String, FormatId>,
   194	    /// Next `Custom(local_peer, _)` counter to hand out. Each peer's
   195	    /// counter is independent; concurrent peers can't collide because
   196	    /// the `PeerId` differs. Starts at `0` (post-5.2; pre-5.2 used
   197	    /// `FIRST_CUSTOM_FORMAT_ID = 164` in the bare-u32 encoding).
   198	    next_custom_counter: u32,
   199	    /// Peer id used when allocating `Custom` ids via `intern`.
   200	    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
   201	    /// for backward compat with pre-collab single-writer mode.
   202	    /// `CollabSession::attach` (step 4) updates this via
   203	    /// [`Self::set_local_peer`] when a multi-peer session takes over.
   204	    local_peer: PeerId,
   205	}
   206	
   207	impl Default for FormatTable {
   208	    fn default() -> Self {
   209	        Self::with_peer(LEGACY_PEER)
   210	    }
   211	}
   212	
   213	impl FormatTable {
   214	    /// Fresh table with Excel built-ins (mini-spec § 10 subset) pre-loaded.
   215	    /// Custom ids allocated by this instance carry [`LEGACY_PEER`] —
   216	    /// matching the pre-5.2 single-writer semantics.
   217	    pub fn new() -> Self {
   218	        Self::default()
   219	    }
   220	
   221	    /// Phase 5.2 D-1 step 3: fresh table with `peer` set as the
   222	    /// allocator's `local_peer`. Future custom-id allocations via
   223	    /// [`Self::intern`] produce `FormatId::Custom(peer, counter)`
   224	    /// with monotonic per-peer counter.
   225	    pub fn with_peer(peer: PeerId) -> Self {
   226	        let mut t = Self {
   227	            by_id: HashMap::new(),
   228	            by_string: HashMap::new(),
   229	            next_custom_counter: 0,
   230	            local_peer: peer,
   231	        };
   232	        for (id, s) in BUILTIN_FORMATS {
   233	            let fid = FormatId::Builtin(*id);
   234	            t.by_id.insert(fid, (*s).to_string());
   235	            t.by_string.insert((*s).to_string(), fid);
   236	        }
   237	        t
   238	    }
   239	
   240	    /// Phase 5.2 D-1 step 3: peer id used for future custom-id
   241	    /// allocations. Read by `Op::RegisterFormat` producers and by
   242	    /// tests verifying peer-aware allocation.
   243	    pub fn local_peer(&self) -> PeerId {
   244	        self.local_peer
   245	    }
   246	
   247	    /// Phase 5.2 D-1 step 3: change the peer id used for future
   248	    /// allocations. Existing entries are NOT relabeled — they keep
   249	    /// the peer they were originally allocated under.
   250	    ///
   251	    /// Step 4 will call this from `CollabSession::attach` when a
   252	    /// multi-peer session takes over from the default
   253	    /// `LEGACY_PEER`-tagged construction.
   254	    pub fn set_local_peer(&mut self, peer: PeerId) {
   255	        self.local_peer = peer;
   256	    }
   257	
   258	    /// Look up the format string for `id`. Returns `None` if the id has
   259	    /// never been registered (which includes most reserved 0-163 ids that
   260	    /// weren't pre-populated by V1 — those land via xlsx import).

 succeeded in 0ms:
   260	    /// weren't pre-populated by V1 — those land via xlsx import).
   261	    pub fn lookup(&self, id: FormatId) -> Option<&str> {
   262	        self.by_id.get(&id).map(|s| s.as_str())
   263	    }
   264	
   265	    /// Intern `s`. Returns the existing id if `s` is already present;
   266	    /// otherwise allocates a new `FormatId::Custom(local_peer, counter)`
   267	    /// and stores both directions.
   268	    ///
   269	    /// **Replay determinism:** the allocator is monotonic in insertion
   270	    /// order WITHIN A PEER. As long as the op-log replays
   271	    /// `Op::RegisterFormat` events in the same order they were
   272	    /// originally written, custom ids reconstruct identically. Across
   273	    /// peers, the `peer` component of each `Custom` keeps ids distinct
   274	    /// even when counter values collide.
   275	    pub fn intern(&mut self, s: &str) -> FormatId {
   276	        if let Some(id) = self.by_string.get(s) {
   277	            return *id;
   278	        }
   279	        let id = FormatId::Custom(self.local_peer, self.next_custom_counter);
   280	        self.next_custom_counter += 1;
   281	        self.by_id.insert(id, s.to_string());
   282	        self.by_string.insert(s.to_string(), id);
   283	        id
   284	    }
   285	
   286	    /// Register `s` at a specific id (typically an Excel built-in or a
   287	    /// replay path). Returns `Err` if the id is already taken with a
   288	    /// different string — that would break round-trip determinism.
   289	    ///
   290	    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
   291	    /// this to reproduce the original allocator state — including ids
   292	    /// allocated by OTHER peers (post-step-3).
   293	    ///
   294	    /// For ids tagged with `self.local_peer`, advances the local
   295	    /// counter past the registered counter so subsequent `intern`
   296	    /// calls don't collide.
   297	    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
   298	        if let Some(existing) = self.by_id.get(&id) {
   299	            if existing == s {
   300	                return Ok(());
   301	            }
   302	            return Err(FormatTableError::IdCollision {
   303	                id,
   304	                existing: existing.clone(),
   305	                attempted: s.to_string(),
   306	            });
   307	        }
   308	        if let Some(existing_id) = self.by_string.get(s) {
   309	            if *existing_id == id {
   310	                return Ok(());
   311	            }
   312	            return Err(FormatTableError::StringCollision {
   313	                string: s.to_string(),
   314	                existing_id: *existing_id,
   315	                attempted_id: id,
   316	            });
   317	        }
   318	        self.by_id.insert(id, s.to_string());
   319	        self.by_string.insert(s.to_string(), id);
   320	        // If `id` is a Custom-variant for OUR peer, advance the local
   321	        // counter so subsequent `intern` calls allocate fresh counters
   322	        // past any replayed ones.
   323	        if let FormatId::Custom(peer, counter) = id {
   324	            if peer == self.local_peer && counter >= self.next_custom_counter {
   325	                self.next_custom_counter = counter + 1;
   326	            }
   327	        }
   328	        Ok(())
   329	    }
   330	
   331	    /// Total entries — useful for sanity checks, not for hot paths.
   332	    pub fn len(&self) -> usize {
   333	        self.by_id.len()
   334	    }
   335	
   336	    /// True iff the table has no entries (should only be possible if a
   337	    /// caller clears it; default construction loads built-ins).
   338	    pub fn is_empty(&self) -> bool {
   339	        self.by_id.is_empty()
   340	    }
   341	
   342	    /// The counter `intern` will use for the next allocation (the
   343	    /// `counter` component of the resulting `FormatId::Custom(local_peer,
   344	    /// counter)`). Exposed for tests + replay state-check.
   345	    ///
   346	    /// Phase 5.2 D-1 step 3 rename: was `next_custom_id() -> u32` and
   347	    /// returned the full pre-5.2 u32 id. Now returns just the counter
   348	    /// (which is per-peer); the full FormatId is built as
   349	    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
   350	    pub fn next_custom_counter(&self) -> u32 {
   351	        self.next_custom_counter
   352	    }
   353	
   354	    /// Iterate `(id, &str)` in arbitrary order. Persistence + op-log
   355	    /// snapshotting consumers must sort by id when wire-stable order
   356	    /// matters.
   357	    pub fn iter(&self) -> impl Iterator<Item = (FormatId, &str)> {
   358	        self.by_id.iter().map(|(id, s)| (*id, s.as_str()))
   359	    }
   360	}
   361	
   362	/// Errors from `register_at` collisions.
   363	#[derive(Clone, Debug, Eq, PartialEq)]
   364	#[non_exhaustive]
   365	pub enum FormatTableError {
   366	    /// An id is already taken with a different string.
   367	    IdCollision {
   368	        id: FormatId,
   369	        existing: String,
   370	        attempted: String,
   371	    },
   372	    /// A string is already mapped to a different id.
   373	    StringCollision {
   374	        string: String,
   375	        existing_id: FormatId,
   376	        attempted_id: FormatId,
   377	    },
   378	}
   379	
   380	#[cfg(test)]
   381	mod tests {
   382	    use super::*;
   383	
   384	    #[test]
   385	    fn default_pre_populates_builtins() {
   386	        let t = FormatTable::new();
   387	        assert_eq!(t.lookup(FormatId::GENERAL), Some("General"));
   388	        assert_eq!(t.lookup(FormatId::Builtin(14)), Some("m/d/yyyy"));
   389	        assert_eq!(t.lookup(FormatId::Builtin(49)), Some("@"));
   390	    }
   391	
   392	    #[test]
   393	    fn unregistered_builtin_returns_none() {
   394	        // id 12 (fraction) is V2-deferred and NOT pre-populated.
   395	        let t = FormatTable::new();
   396	        assert_eq!(t.lookup(FormatId::Builtin(12)), None);
   397	    }
   398	
   399	    #[test]
   400	    fn intern_existing_returns_same_id() {
   401	        let mut t = FormatTable::new();
   402	        let id = t.intern("0.00");
   403	        // "0.00" pre-loaded as Builtin(2).
   404	        assert_eq!(id, FormatId::Builtin(2));
   405	        // Re-intern same string returns same id.
   406	        assert_eq!(t.intern("0.00"), id);
   407	    }
   408	
   409	    #[test]
   410	    fn intern_new_allocates_custom_id_for_local_peer() {
   411	        let mut t = FormatTable::new();
   412	        let id = t.intern("\"€\" #,##0.00");
   413	        // Step 3: custom ids are Custom(local_peer, counter). Default
   414	        // FormatTable uses LEGACY_PEER; counter starts at 0.
   415	        assert_eq!(id, FormatId::Custom(LEGACY_PEER, 0));
   416	        // Stored both directions.
   417	        assert_eq!(t.lookup(id), Some("\"€\" #,##0.00"));
   418	        assert_eq!(t.intern("\"€\" #,##0.00"), id);
   419	    }
   420	
   421	    #[test]
   422	    fn intern_two_distinct_strings_get_sequential_counters() {
   423	        let mut t = FormatTable::new();
   424	        let a = t.intern("CUSTOM_A");
   425	        let b = t.intern("CUSTOM_B");
   426	        match (a, b) {
   427	            (FormatId::Custom(pa, ca), FormatId::Custom(pb, cb)) => {
   428	                assert_eq!(pa, pb, "same FormatTable allocates under same peer");
   429	                assert_eq!(cb, ca + 1, "counters monotonic");
   430	            }
   431	            other => panic!("expected two Custom ids, got {other:?}"),
   432	        }
   433	    }
   434	
   435	    #[test]
   436	    fn intern_with_distinct_peers_does_not_collide() {
   437	        // Phase 5.1 audit-locked D-1: two peers allocating from
   438	        // counter=0 produce distinct FormatIds because peer differs.
   439	        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
   440	        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
   441	        let id_a = peer_a.intern("SAME_STRING");
   442	        let id_b = peer_b.intern("SAME_STRING");
   443	        // Same string, same counter, distinct peers — still distinct FormatIds.
   444	        assert_ne!(id_a, id_b);
   445	        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
   446	        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
   447	    }
   448	
   449	    #[test]
   450	    fn next_custom_counter_advances_on_intern() {
   451	        let mut t = FormatTable::new();
   452	        assert_eq!(t.next_custom_counter(), 0);
   453	        let _ = t.intern("CUSTOM");
   454	        assert_eq!(t.next_custom_counter(), 1);
   455	    }
   456	
   457	    #[test]
   458	    fn register_at_replays_known_id() {
   459	        let mut t = FormatTable::new();
   460	        // Step 3: ids land as Builtin or Custom variants; register_at
   461	        // accepts either.
   462	        t.register_at(FormatId::Builtin(200), "REPLAY").unwrap();
   463	        assert_eq!(t.lookup(FormatId::Builtin(200)), Some("REPLAY"));
   464	    }
   465	
   466	    #[test]
   467	    fn register_at_advances_local_counter_for_own_peer() {
   468	        // Replaying an Op::RegisterFormat that allocated under OUR
   469	        // peer must advance our counter so subsequent intern calls
   470	        // don't collide.
   471	        let mut t = FormatTable::with_peer(PeerId::new(7));
   472	        t.register_at(FormatId::Custom(PeerId::new(7), 5), "REPLAY")
   473	            .unwrap();
   474	        // Counter should now be 6 — next intern allocates at counter=6.
   475	        let next = t.intern("AFTER");
   476	        assert_eq!(next, FormatId::Custom(PeerId::new(7), 6));
   477	    }
   478	
   479	    #[test]
   480	    fn register_at_other_peer_does_not_advance_local_counter() {
   481	        // A remote peer's Op::RegisterFormat registers an id under
   482	        // THEIR peer; our local counter is unaffected.
   483	        let mut t = FormatTable::with_peer(PeerId::new(7));
   484	        let baseline = t.next_custom_counter();
   485	        t.register_at(FormatId::Custom(PeerId::new(99), 5), "FROM_OTHER")
   486	            .unwrap();
   487	        assert_eq!(
   488	            t.next_custom_counter(),
   489	            baseline,
   490	            "remote peer's allocation must not advance our counter"
   491	        );
   492	    }
   493	
   494	    #[test]
   495	    fn register_at_same_id_same_string_is_idempotent() {
   496	        let mut t = FormatTable::new();
   497	        t.register_at(FormatId::Builtin(0), "General").unwrap();
   498	        assert!(t.register_at(FormatId::Builtin(0), "General").is_ok());
   499	    }
   500	
   501	    #[test]
   502	    fn register_at_id_collision_errors() {
   503	        let mut t = FormatTable::new();
   504	        let err = t
   505	            .register_at(FormatId::Builtin(0), "DIFFERENT")
   506	            .unwrap_err();
   507	        assert!(matches!(err, FormatTableError::IdCollision { .. }));
   508	    }
   509	
   510	    #[test]
   511	    fn register_at_string_collision_errors() {
   512	        let mut t = FormatTable::new();
   513	        // "General" is already at Builtin(0); registering it at a different id errors.
   514	        let err = t
   515	            .register_at(FormatId::Builtin(200), "General")
   516	            .unwrap_err();
   517	        assert!(matches!(err, FormatTableError::StringCollision { .. }));
   518	    }
   519	
   520	    #[test]
   521	    fn intern_does_not_advance_for_repeats() {
   522	        let mut t = FormatTable::new();
   523	        let _ = t.intern("once");
   524	        let n1 = t.next_custom_counter();
   525	        let _ = t.intern("once");
   526	        assert_eq!(
   527	            t.next_custom_counter(),
   528	            n1,
   529	            "repeat intern must not advance counter"
   530	        );
   531	    }
   532	
   533	    #[test]
   534	    fn first_custom_id_is_past_builtins() {
   535	        const _: () = assert!(FIRST_CUSTOM_FORMAT_ID > 163);
   536	    }
   537	
   538	    #[test]
   539	    fn iter_returns_all_entries() {
   540	        let mut t = FormatTable::new();
   541	        let _ = t.intern("CUSTOM");
   542	        let mut count = 0;
   543	        for (id, s) in t.iter() {
   544	            assert!(!s.is_empty(), "id {id:?} has empty string");
   545	            count += 1;
   546	        }
   547	        assert_eq!(count, t.len());
   548	    }
   549	
   550	    #[test]
   551	    fn general_is_builtin_zero() {
   552	        assert_eq!(FormatId::GENERAL, FormatId::Builtin(0));
   553	        assert!(FormatId::GENERAL.is_builtin());
   554	        assert!(!FormatId::GENERAL.is_custom());
   555	    }
   556	
   557	    #[test]
   558	    fn legacy_from_u32_maps_builtins_and_customs() {
   559	        // Mirrors `FormatIdWire::from_u32_legacy` (step 2 ship).
   560	        assert_eq!(FormatId::legacy_from_u32(0), FormatId::Builtin(0));
   561	        assert_eq!(FormatId::legacy_from_u32(163), FormatId::Builtin(163));
   562	        assert_eq!(
   563	            FormatId::legacy_from_u32(164),
   564	            FormatId::Custom(LEGACY_PEER, 0)
   565	        );
   566	        assert_eq!(
   567	            FormatId::legacy_from_u32(999),
   568	            FormatId::Custom(LEGACY_PEER, 999 - 164)
   569	        );
   570	    }
   571	
   572	    #[test]
   573	    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
   574	        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
   575	        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
   576	        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
   577	        assert_eq!(
   578	            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
   579	            Some(264)
   580	        );
   581	    }
   582	
   583	    #[test]
   584	    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
   585	        // A Custom id tagged with a non-LEGACY peer can't be
   586	        // expressed in the pre-5.2 bare-u32 envelope. xlsx export
   587	        // (step 6) decides what to do.
   588	        let id = FormatId::Custom(PeerId::new(42), 7);
   589	        assert_eq!(id.to_legacy_u32(), None);
   590	    }
   591	
   592	    #[test]
   593	    fn legacy_round_trip_through_helpers() {
   594	        for n in [0_u32, 1, 14, 163, 164, 165, 999, 10_000] {
   595	            let id = FormatId::legacy_from_u32(n);
   596	            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
   597	        }
   598	    }
   599	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/wire.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
    37	use ql_types::{Address, ErrorValue, PeerId, Range, Value, LEGACY_PEER, MAX_COLUMN, MAX_ROW};
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

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1,260p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
   125	    #[error("replay set-cell-format references unregistered format id {id} at op index {index}")]
   126	    FormatNotRegistered { index: usize, id: u32 },
   127	
   128	    /// **W5-91 (Phase 4.6.C):** `Op::RenameSheet` referenced a sheet
   129	    /// whose current name matches neither `old_name` nor `new_name`
   130	    /// (i.e. the replay state has diverged from what the op recorded).
   131	    /// Surfaces a clean error rather than silently renaming a different
   132	    /// sheet.
   133	    #[error(
   134	        "replay rename-sheet name mismatch at op index {index}: sheet {id} \
   135	         expected current name {expected:?}, found {found:?}"
   136	    )]
   137	    SheetRenameNameMismatch {
   138	        index: usize,
   139	        id: SheetId,
   140	        expected: String,
   141	        found: String,
   142	    },
   143	
   144	    /// **W5-91 (Phase 4.6.C):** `Workbook::rename_sheet` refused the
   145	    /// new name (duplicate, reserved character, empty).
   146	    #[error(
   147	        "replay rename-sheet rejected at op index {index}: sheet {id} \
   148	         from {old_name:?} to {new_name:?} ({source})"
   149	    )]
   150	    SheetRenameRejected {
   151	        index: usize,
   152	        id: SheetId,
   153	        old_name: String,
   154	        new_name: String,
   155	        #[source]
   156	        source: ql_storage::SheetNameError,
   157	    },
   158	
   159	    /// **W5-93 (Phase 4.6.E closure):** `Op::AddSheet` carried a name
   160	    /// that fails `Workbook::validate_sheet_name` — empty, duplicate
   161	    /// under canonical comparison, or an Excel-reserved character.
   162	    /// Codex HIGH-1 closed: pre-W5-93 the replay path silently
   163	    /// accepted any name, so an op log produced against a buggy
   164	    /// storage path could let conflicting sheets enter replay state.
   165	    #[error("replay add-sheet rejected at op index {index}: name {name:?} ({source})")]
   166	    SheetNameRejected {
   167	        index: usize,
   168	        name: String,
   169	        #[source]
   170	        source: ql_storage::SheetNameError,
   171	    },
   172	
   173	    /// **W5-118 (Phase 4.8.H):** `CreateTable` op references invariants
   174	    /// the producer should have validated. Catches snapshot-vs-replay
   175	    /// divergence (e.g. snapshot already has the table; another producer
   176	    /// raced).
   177	    #[error("replay create-table rejected at op index {index}: {reason}")]
   178	    TableCreateRejected {
   179	        index: usize,
   180	        name: String,
   181	        reason: &'static str,
   182	    },
   183	
   184	    /// **W5-118 (Phase 4.8.H):** `DropTable` op references a missing
   185	    /// table. Surfaces snapshot-vs-replay divergence loudly per
   186	    /// no-fallbacks doctrine.
   187	    #[error("replay drop-table at op index {index}: table {name:?} not found")]
   188	    TableNotFound { index: usize, name: String },
   189	
   190	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op references a column
   191	    /// that doesn't exist in the target table (case-insensitive). Either
   192	    /// the source column was already dropped/renamed before this op, or
   193	    /// the op log has diverged from the snapshot.
   194	    #[error(
   195	        "replay rename-column at op index {index}: table {table:?} \
   196	         has no column {column:?}"
   197	    )]
   198	    TableColumnNotFound {
   199	        index: usize,
   200	        table: String,
   201	        column: String,
   202	    },
   203	
   204	    /// **W5-121 (Phase 4.8.I.2):** `RenameColumn` op was rejected by a
   205	    /// validation rule (target name already in the table, empty, etc.).
   206	    /// `reason` is a static string describing which invariant fired.
   207	    #[error("replay rename-column rejected at op index {index}: table {table:?} column {column:?} ({reason})")]
   208	    TableColumnRejected {
   209	        index: usize,
   210	        table: String,
   211	        column: String,
   212	        reason: &'static str,
   213	    },
   214	
   215	    /// **W5-122 (Phase 4.8.J):** `ResizeTable` op was rejected by a
   216	    /// validation rule (arithmetic mismatch, trailing-columns
   217	    /// mismatch, column-name collision, footprint overlap, etc.).
   218	    /// `reason` is a static string describing which invariant fired.
   219	    #[error("replay resize-table rejected at op index {index}: table {name:?} ({reason})")]
   220	    TableResizeRejected {
   221	        index: usize,
   222	        name: String,
   223	        reason: &'static str,
   224	    },
   225	
   226	    /// **W5-146 (Phase 4.9.J):** `Op::SetLocale` wire value didn't
   227	    /// match any known locale code. Mirrors qbook v7's
   228	    /// `QbookError::UnknownLocale` (W5-145) — a forward-compat
   229	    /// op-log file with an unrecognized locale string surfaces this
   230	    /// instead of silently substituting EnUs (closes Sonnet L-10).
   231	    /// Captures the offending string for the IDE diagnostic.
   232	    #[error("replay unknown locale at op index {index}: {found:?}")]
   233	    UnknownLocale { index: usize, found: String },
   234	
   235	    /// **W5-151 (Phase 4.9.O MEDIUM-2 closure):** `Op::SetReferenceMode`
   236	    /// wire value didn't match `A1` or `R1C1`. Per design § 4.9.J,
   237	    /// the forward-compat path captures unknown strings into
   238	    /// `ReferenceModeWire::Unknown(_)` and replay surfaces this
   239	    /// distinct error rather than letting the op silently no-op.
   240	    /// Parallels `UnknownLocale` above.
   241	    #[error("replay unknown reference mode at op index {index}: {found:?}")]
   242	    UnknownReferenceMode { index: usize, found: String },
   243	}
   244	
   245	/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
   246	/// so `ReplayError` can stay `Clone + std::error::Error` without
   247	/// borrowing into the table.
   248	///
   249	/// Phase 5.2 D-1 step 3: `id` / `existing_id` / `attempted_id` are now
   250	/// `ql_storage::FormatId` (tagged tuple) rather than the pre-step-3
   251	/// `u32`. Display formatting uses the FormatId's `Debug` impl so error
   252	/// messages identify both built-in and peer-allocated custom variants.
   253	#[derive(Clone, Debug, thiserror::Error)]
   254	#[non_exhaustive]
   255	pub enum FormatRejectedSource {
   256	    #[error("format id {id:?} already bound to {existing:?}, can't re-bind to {attempted:?}")]
   257	    IdCollision {
   258	        id: ql_storage::FormatId,
   259	        existing: String,
   260	        attempted: String,

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '245,460p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   245	/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
   246	/// so `ReplayError` can stay `Clone + std::error::Error` without
   247	/// borrowing into the table.
   248	///
   249	/// Phase 5.2 D-1 step 3: `id` / `existing_id` / `attempted_id` are now
   250	/// `ql_storage::FormatId` (tagged tuple) rather than the pre-step-3
   251	/// `u32`. Display formatting uses the FormatId's `Debug` impl so error
   252	/// messages identify both built-in and peer-allocated custom variants.
   253	#[derive(Clone, Debug, thiserror::Error)]
   254	#[non_exhaustive]
   255	pub enum FormatRejectedSource {
   256	    #[error("format id {id:?} already bound to {existing:?}, can't re-bind to {attempted:?}")]
   257	    IdCollision {
   258	        id: ql_storage::FormatId,
   259	        existing: String,
   260	        attempted: String,
   261	    },
   262	    #[error(
   263	        "format string {string:?} already at id {existing_id:?}, can't bind to id {attempted_id:?}"
   264	    )]
   265	    StringCollision {
   266	        string: String,
   267	        existing_id: ql_storage::FormatId,
   268	        attempted_id: ql_storage::FormatId,
   269	    },
   270	}
   271	
   272	impl From<ql_storage::FormatTableError> for FormatRejectedSource {
   273	    fn from(e: ql_storage::FormatTableError) -> Self {
   274	        match e {
   275	            ql_storage::FormatTableError::IdCollision {
   276	                id,
   277	                existing,
   278	                attempted,
   279	            } => FormatRejectedSource::IdCollision {
   280	                id,
   281	                existing,
   282	                attempted,
   283	            },
   284	            ql_storage::FormatTableError::StringCollision {
   285	                string,
   286	                existing_id,
   287	                attempted_id,
   288	            } => FormatRejectedSource::StringCollision {
   289	                string,
   290	                existing_id,
   291	                attempted_id,
   292	            },
   293	            _ => unreachable!(
   294	                "FormatTableError gained a variant — extend FormatRejectedSource::From"
   295	            ),
   296	        }
   297	    }
   298	}
   299	
   300	/// Replay every op in `log` against `workbook` in append order.
   301	///
   302	/// Returns the total count of ops applied on success. On failure, the
   303	/// workbook is in a partial state — `ReplayError::At { index, .. }` tells
   304	/// the caller how far replay got.
   305	///
   306	/// The `registry` parameter is held for API symmetry with `WorkbookRuntime`
   307	/// and is unused in 2A.3.a (replay persists formula text without
   308	/// re-evaluating; callers drive evaluation through `recompute_all`).
   309	pub fn replay_into(
   310	    log: &OpLog,
   311	    workbook: &mut Workbook,
   312	    _registry: &FunctionRegistry,
   313	) -> Result<usize, ReplayError> {
   314	    let mut count = 0;
   315	    for (index, op_result) in log.iter().enumerate() {
   316	        let op = op_result.map_err(|e| ReplayError::Deserialize(index, e))?;
   317	        apply_op(&op, workbook, index)?;
   318	        count += 1;
   319	    }
   320	    Ok(count)
   321	}
   322	
   323	/// Recursive helper. `index` is the op's position in the outer log (or
   324	/// the synthetic position of the enclosing BatchCommit for nested ops —
   325	/// 2A.3.a flattens by reporting the parent's index for nested failures).
   326	fn apply_op(op: &Op, workbook: &mut Workbook, index: usize) -> Result<(), ReplayError> {
   327	    match op {
   328	        Op::PutValue {
   329	            sheet,
   330	            row,
   331	            col,
   332	            value,
   333	        } => {
   334	            validate_cell(workbook, *sheet, *row, *col, index)?;
   335	            let v: Value = value
   336	                .to_value()
   337	                .map_err(|source| ReplayError::ValueDecode { index, source })?;
   338	            workbook.put_at(*sheet, *row, *col, v);
   339	            Ok(())
   340	        }
   341	        Op::PutFormula {
   342	            sheet,
   343	            row,
   344	            col,
   345	            text,
   346	        } => {
   347	            validate_cell(workbook, *sheet, *row, *col, index)?;
   348	            workbook.put_formula(*sheet, *row, *col, text.as_str());
   349	            Ok(())
   350	        }
   351	        Op::ClearFormula { sheet, row, col } => {
   352	            // clear_formula is idempotent on missing entries; we still
   353	            // validate bounds so a corrupted op-log can't sneak past.
   354	            validate_cell(workbook, *sheet, *row, *col, index)?;
   355	            workbook.clear_formula(*sheet, *row, *col);
   356	            Ok(())
   357	        }
   358	        Op::SetName {
   359	            scope,
   360	            name,
   361	            target,
   362	        } => {
   363	            let target = target
   364	                .to_target(name)
   365	                .map_err(|source| ReplayError::NamedTargetDecode { index, source })?;
   366	            match scope {
   367	                None => {
   368	                    // Workbook-scoped (historical path).
   369	                    workbook.set_name(name, target).map_err(|source| {
   370	                        ReplayError::NameRejected {
   371	                            index,
   372	                            name: name.clone(),
   373	                            source,
   374	                        }
   375	                    })?;
   376	                }
   377	                Some(sheet) => {
   378	                    // **W5-92 (Phase 4.6.D):** sheet-scoped. Validate sheet
   379	                    // first so an unknown id surfaces as InvalidSheet, not
   380	                    // a panicking out-of-bounds index.
   381	                    let sheet_count = workbook.sheet_count();
   382	                    let sheet_ref =
   383	                        workbook
   384	                            .sheet_mut(*sheet)
   385	                            .ok_or(ReplayError::InvalidSheet {
   386	                                index,
   387	                                sheet: *sheet,
   388	                                sheet_count,
   389	                            })?;
   390	                    sheet_ref.set_scoped_name(name, target).map_err(|source| {
   391	                        ReplayError::NameRejected {
   392	                            index,
   393	                            name: name.clone(),
   394	                            source,
   395	                        }
   396	                    })?;
   397	                }
   398	            }
   399	            Ok(())
   400	        }
   401	        Op::AddSheet { name, chunk_rows } => {
   402	            // **W5-93 (Phase 4.6.E closure):** route through the fallible
   403	            // `try_add_sheet_with_chunk_rows` and surface a clean
   404	            // `ReplayError::SheetNameRejected` on validation failure.
   405	            // Codex HIGH-1 flagged that the prior infallible path
   406	            // silently accepted duplicate-canonical names + reserved
   407	            // characters at the replay boundary too.
   408	            //
   409	            // **Phase 5.2 D-2 closure (2026-05-19):** auto-rename on
   410	            // duplicate-canonical-name. Phase 5 multi-peer scenario:
   411	            // peer A and peer B both call `add_sheet("S")` locally;
   412	            // each producer-side validates against its own snapshot
   413	            // (no collision visible); both emit
   414	            // `Op::AddSheet { name: "S", ... }`; merged log has both.
   415	            // First replay succeeds; second hits the duplicate guard.
   416	            // Pre-D-2 we rejected the second op (worse UX than Google
   417	            // Sheets, which auto-renames to S(2)). Now we walk
   418	            // `<name>(2)`, `<name>(3)`, … until we find a free name.
   419	            // `Empty` + `ReservedCharacter` still reject — auto-rename
   420	            // only resolves the collaboration-collision case.
   421	            let mut chosen = name.clone();
   422	            let mut suffix = 2u32;
   423	            const AUTO_RENAME_CEILING: u32 = 10_000;
   424	            loop {
   425	                match workbook.try_add_sheet_with_chunk_rows(chosen.clone(), *chunk_rows) {
   426	                    Ok(_) => return Ok(()),
   427	                    Err(ql_storage::SheetNameError::Duplicate { .. }) => {
   428	                        chosen = format!("{name}({suffix})");
   429	                        suffix += 1;
   430	                        if suffix > AUTO_RENAME_CEILING {
   431	                            // Pathological: more than 10k sheets all
   432	                            // share the same base name (impossible in
   433	                            // realistic workbooks; max sheets per
   434	                            // workbook is 65,535). Surface a clean
   435	                            // error rather than loop forever.
   436	                            return Err(ReplayError::SheetNameRejected {
   437	                                index,
   438	                                name: name.clone(),
   439	                                source: ql_storage::SheetNameError::Duplicate {
   440	                                    name: name.clone(),
   441	                                },
   442	                            });
   443	                        }
   444	                    }
   445	                    Err(other) => {
   446	                        return Err(ReplayError::SheetNameRejected {
   447	                            index,
   448	                            name: name.clone(),
   449	                            source: other,
   450	                        });
   451	                    }
   452	                }
   453	            }
   454	        }
   455	        Op::RenameSheet {
   456	            id,
   457	            old_name,
   458	            new_name,
   459	        } => {
   460	            // **W5-91 (Phase 4.6.C):** snapshot-vs-replay reconciliation

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs | sed -n '1,240p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Format API for `WorkbookRuntime`.
     2	//!
     3	//! Tier D1 Step 3.1 (2026-05-18): extracted from `mod.rs` per
     4	//! `docs/architecture/workbook-runtime-split-design.md`. Three
     5	//! methods covering the producer-side format surface — table
     6	//! interning, per-cell binding, and display rendering. Pure code
     7	//! move; no behavior change.
     8	//!
     9	//! Methods:
    10	//! - [`WorkbookRuntime::intern_format`] — register a format string
    11	//!   in the workbook's `FormatTable` and emit `Op::RegisterFormat`
    12	//!   if (and only if) a new id was allocated. Idempotent.
    13	//! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
    14	//!   `FormatId` (or clear via `None`). Refuses unknown ids
    15	//!   (`RuntimeError::UnknownFormatId`).
    16	//! - [`WorkbookRuntime::read_display`] — read a cell and render it
    17	//!   through its `FormatId` binding (or General if unbound).
    18	//!   Memoizes parsed `FormatString` per id in
    19	//!   `WorkbookRuntime::format_cache`.
    20	
    21	use ql_functions::format;
    22	use ql_oplog::Op;
    23	use ql_storage::FormatId;
    24	use ql_types::{ColId, EvalContext, RowId, SheetId};
    25	
    26	use super::{validate_cell, RuntimeError, WorkbookRuntime};
    27	
    28	impl<'a> WorkbookRuntime<'a> {
    29	    /// **W5-82 (Phase 4.5.D part 6):** intern a number-format string into
    30	    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
    31	    /// op log if (and only if) the call allocated a NEW id. Returns the
    32	    /// `FormatId`, which the caller can pass to [`set_cell_format`].
    33	    ///
    34	    /// Idempotent on repeated calls with the same string — the second
    35	    /// call returns the same id without emitting a duplicate op. This
    36	    /// keeps the op log compact and replay deterministic.
    37	    ///
    38	    /// Direct callers of `Workbook::formats_mut().intern()` bypass the
    39	    /// op log silently; that path is documented as low-level and intended
    40	    /// for the qbook loader + tests + engine-internal reconstruction.
    41	    pub fn intern_format(&mut self, s: &str) -> Result<FormatId, RuntimeError> {
    42	        // Check whether the table already knows this string. If so, no
    43	        // new id is allocated and we MUST NOT emit `RegisterFormat`
    44	        // (idempotent path).
    45	        if let Some(existing) = self.workbook.formats().iter().find(|(_, t)| *t == s) {
    46	            return Ok(existing.0);
    47	        }
    48	        // New string — predict the id the table will allocate so we can
    49	        // emit the op BEFORE mutating (append-before-mutate ordering,
    50	        // matching set_name / set_value).
    51	        //
    52	        // Phase 5.2 D-1 step 3: FormatTable now allocates under its
    53	        // `local_peer`. Predicted id is `Custom(local_peer, counter)`.
    54	        // Pre-step-4 the Op still carries a bare-u32 id; convert via
    55	        // `to_legacy_u32`. At step 3 all FormatTables default to
    56	        // LEGACY_PEER so the conversion always succeeds; the
    57	        // expect() makes the invariant load-bearing for step 4.
    58	        let formats = self.workbook.formats();
    59	        let id = FormatId::Custom(formats.local_peer(), formats.next_custom_counter());
    60	        if let Some(oplog) = self.oplog.as_deref_mut() {
    61	            oplog.append(Op::RegisterFormat {
    62	                id: id.to_legacy_u32().expect(
    63	                    "pre-step-4 FormatTable peer must be LEGACY_PEER so Op u32 is expressible",
    64	                ),
    65	                string: s.to_owned(),
    66	            })?;
    67	        }
    68	        let allocated = self.workbook.formats_mut().intern(s);
    69	        debug_assert_eq!(
    70	            allocated, id,
    71	            "FormatTable::intern allocated a different id than next_custom_counter predicted"
    72	        );
    73	        Ok(allocated)
    74	    }
    75	
    76	    /// **W5-82 (Phase 4.5.D part 6):** bind a cell to a `FormatId` (or
    77	    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
    78	    /// to the op log. Sheet/row/col are validated; `id = Some(...)` that
    79	    /// references an unknown id is REFUSED (matching replay's
    80	    /// `FormatNotRegistered` semantic — producer-side enforcement is
    81	    /// the cleaner spot for the check).
    82	    ///
    83	    /// Direct callers of `Sheet::format_overlay_mut()` bypass the op
    84	    /// log silently; that path is documented as low-level.
    85	    pub fn set_cell_format(
    86	        &mut self,
    87	        sheet: SheetId,
    88	        row: RowId,
    89	        col: ColId,
    90	        id: Option<FormatId>,
    91	    ) -> Result<(), RuntimeError> {
    92	        validate_cell(self.workbook, sheet, row, col)?;
    93	        // Producer-side gatekeeping: refuse `Some(id)` referencing an
    94	        // unregistered format. Replay does the same check (W5-80) so
    95	        // an op log that ever reaches the wire is well-formed.
    96	        if let Some(fid) = id {
    97	            if self.workbook.formats().lookup(fid).is_none() {
    98	                return Err(RuntimeError::UnknownFormatId(fid));
    99	            }
   100	        }
   101	        if let Some(oplog) = self.oplog.as_deref_mut() {
   102	            oplog.append(Op::SetCellFormat {
   103	                sheet,
   104	                row,
   105	                col,
   106	                // Phase 5.2 D-1 step 3: Op still carries bare-u32
   107	                // (step 4 will change to FormatIdWire). Convert.
   108	                id: id.map(|f| {
   109	                    f.to_legacy_u32()
   110	                        .expect("pre-step-4 FormatId must be expressible as legacy u32")
   111	                }),
   112	            })?;
   113	        }
   114	        // Apply the mutation. After append-success this cannot fail.
   115	        let overlay = self
   116	            .workbook
   117	            .sheet_mut(sheet)
   118	            .expect("validate_cell guards sheet bounds")
   119	            .format_overlay_mut();
   120	        match id {
   121	            Some(fid) => {
   122	                overlay.set(row, col, fid);
   123	            }
   124	            None => {
   125	                overlay.clear(row, col);
   126	            }
   127	        }
   128	        Ok(())
   129	    }
   130	
   131	    /// **W5-82 (Phase 4.5.D part 6):** read a cell and render it through
   132	    /// its `FormatId` binding (or `General` if unbound). Returns the
   133	    /// final display string the IDE would show. The runtime's
   134	    /// `EvalContext` (date system, locale, now-provider) drives
   135	    /// date/time rendering.
   136	    ///
   137	    /// Lookup chain per call:
   138	    ///   1. cell's raw `Value` (cheap; lives on the storage hot path)
   139	    ///   2. format id from sheet's `CellFormatOverlay` (None → General)
   140	    ///   3. parsed `FormatString` from `format_cache` (parse + insert on miss)
   141	    ///   4. `format::render(&value, &fmt, &ctx)` → `String`
   142	    ///
   143	    /// If the cell's format references an id that's missing from the
   144	    /// `FormatTable` (corrupted state — should not happen in practice
   145	    /// because `set_cell_format` refuses unknown ids), falls back to
   146	    /// `General` rendering. If the format string fails to parse,
   147	    /// falls back to `General` and the renderer never errors.
   148	    ///
   149	    /// **W5-84 closure (Codex MEDIUM-2) cache-staleness caveat:** the
   150	    /// `format_cache` is keyed by `FormatId` and populated on first
   151	    /// `read_display` for that id. `FormatTable::register_at` rejects
   152	    /// id→string mutations, so cached entries stay correct for the
   153	    /// runtime's lifetime under the runtime's own append-only
   154	    /// `intern_format` path. HOWEVER, the low-level
   155	    /// `Workbook::formats_mut()` accessor (loader-only by convention but
   156	    /// `pub` for the qbook loader + tests) can register a new id AFTER
   157	    /// `read_display` has cached the General fallback for that id. In
   158	    /// that pathological sequence the cache will continue rendering
   159	    /// General until the runtime is rebuilt. Analogous to the
   160	    /// `WorkbookEnv` date-system caveat documented on
   161	    /// `Workbook::set_date_system`. Tracked as GAP-F-12 in
   162	    /// `docs/known-gaps.md`.
   163	    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
   164	        let value = self.workbook.read(ql_types::Address::new(sheet, row, col));
   165	        let format_id = self
   166	            .workbook
   167	            .sheet(sheet)
   168	            .and_then(|s| s.format_overlay().get(row, col))
   169	            .unwrap_or(FormatId::GENERAL);
   170	        // Cache lookup. Vacant → resolve via FormatTable + parse + insert.
   171	        let needs_parse = !self.format_cache.contains_key(&format_id);
   172	        if needs_parse {
   173	            let parsed = self
   174	                .workbook
   175	                .formats()
   176	                .lookup(format_id)
   177	                .and_then(|s| format::parse(s).ok());
   178	            // Fall back to General if either lookup or parse failed.
   179	            let parsed = parsed.unwrap_or_else(|| {
   180	                format::parse("General").expect("'General' is a valid format string")
   181	            });
   182	            self.format_cache.insert(format_id, parsed);
   183	        }
   184	        let fmt = self
   185	            .format_cache
   186	            .get(&format_id)
   187	            .expect("just inserted above");
   188	        // V1 EvalContext: workbook's date_system + en-US locale + System now-provider.
   189	        let ctx = EvalContext {
   190	            date_system: self.workbook.date_system(),
   191	            ..EvalContext::default()
   192	        };
   193	        format::render(&value, fmt, &ctx)
   194	    }
   195	}
   196	
   197	#[cfg(test)]
   198	mod tests {
   199	    use ql_functions::default_registry;
   200	    use ql_oplog::{Op, OpLog};
   201	    use ql_storage::{FormatId, Workbook};
   202	    use ql_types::{ErrorValue, Value};
   203	
   204	    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
   205	
   206	    // ===== W5-82 / Phase 4.5.D part 6 — format runtime wrappers =====
   207	
   208	    #[test]
   209	    fn intern_format_returns_existing_builtin_id_no_oplog_op() {
   210	        let mut wb = Workbook::new();
   211	        let reg = default_registry();
   212	        let mut log = OpLog::new();
   213	        {
   214	            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
   215	            // "General" is built-in id 0; pre-populated by FormatTable::default().
   216	            let id = rt.intern_format("General").unwrap();
   217	            assert_eq!(id, FormatId::GENERAL);
   218	            let id2 = rt.intern_format("0.00").unwrap();
   219	            assert_eq!(id2, FormatId::Builtin(2));
   220	        }
   221	        // No RegisterFormat ops should have been emitted — both strings
   222	        // are pre-populated built-ins.
   223	        let ops: Vec<_> = log.iter().collect();
   224	        assert_eq!(ops.len(), 0, "built-ins must not emit RegisterFormat ops");
   225	    }
   226	
   227	    #[test]
   228	    fn intern_format_new_string_emits_register_op() {
   229	        let mut wb = Workbook::new();
   230	        let reg = default_registry();
   231	        let mut log = OpLog::new();
   232	        {
   233	            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
   234	            let id = rt.intern_format("\"€\" #,##0.00").unwrap();
   235	            // Step 3: first custom under LEGACY_PEER, counter=0.
   236	            // Round-trips to legacy u32 = 164 (FIRST_CUSTOM_FORMAT_ID).
   237	            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
   238	            assert_eq!(id, FormatId::Custom(ql_types::LEGACY_PEER, 0));
   239	        }
   240	        let ops: Vec<_> = log.iter().collect::<Result<_, _>>().unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs | sed -n '1,160p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `WorkbookRuntime` error + result types.
     2	//!
     3	//! Extracted from `workbook_runtime.rs` as **Tier D1 Step 1** per
     4	//! `docs/architecture/workbook-runtime-split-design.md`. Contains:
     5	//! - [`RuntimeError`] — top-level error enum for the runtime pipeline.
     6	//! - [`RecomputeFailure`] — per-cell structural failure during a
     7	//!   recompute pass.
     8	//! - [`RecomputeResult`] — aggregate outcome of `recompute_all` /
     9	//!   `recompute_dirty`.
    10	//!
    11	//! No behavior changes — pure code move. The types remain in the
    12	//! `crate::workbook_runtime` module path via `pub use` in
    13	//! `crate::workbook_runtime::mod` so all existing callers compile
    14	//! unchanged.
    15	
    16	use std::sync::Arc;
    17	
    18	use ql_formula_syntax::{LexError, ParseError, PrintError};
    19	use ql_types::{ColId, RowId, SheetId};
    20	
    21	use crate::plan::BindError;
    22	
    23	/// Errors from the runtime pipeline. Each upstream stage's error wraps cleanly.
    24	/// Phase 2A.6 audit H1/L4 (2026-05-12) added `InvalidSheet` so callers that pass
    25	/// a sheet id outside the workbook's range get a clean error instead of a panic
    26	/// from `Workbook::put_at`. Phase 2A.6 audit H4 added `ConflictingOps` for
    27	/// the `WorkbookTransaction` mixed-kind-on-same-cell case.
    28	#[derive(Debug, thiserror::Error)]
    29	#[non_exhaustive]
    30	pub enum RuntimeError {
    31	    // Phase 2A.11 audit M16: switched from `{0:?}` debug formatters to `{0}`
    32	    // Display now that LexError + BindError implement thiserror::Error with
    33	    // user-facing strings. IDE error display reads cleanly: "lex error:
    34	    // unexpected character: '@'" instead of "lex error: UnexpectedChar('@')".
    35	    #[error("lex error: {0}")]
    36	    Lex(LexError),
    37	
    38	    #[error("parse error: {0}")]
    39	    Parse(#[from] ParseError),
    40	
    41	    /// **W5-147 (Phase 4.9.K):** the canonicalize step of `set_formula`
    42	    /// (per design § 4.4) failed. This happens when the parsed AST
    43	    /// contains an intermediate `Expr::R1C1Ref` with a relative axis
    44	    /// that the printer can't resolve, or a malformed R1C1 axis. In
    45	    /// practice the bind site always has a cell anchor, so the only
    46	    /// reachable case is a hand-built AST with `AxisSpec::Abs(0)` —
    47	    /// effectively impossible from `set_formula` since the lexer
    48	    /// already rejects it as `MalformedR1C1`. Kept as a typed error
    49	    /// for defense-in-depth.
    50	    #[error("print error: {0}")]
    51	    Print(#[from] PrintError),
    52	
    53	    #[error("bind error: {0}")]
    54	    Bind(BindError),
    55	
    56	    #[error("invalid sheet {sheet}: workbook has {sheet_count} sheets")]
    57	    InvalidSheet { sheet: SheetId, sheet_count: usize },
    58	
    59	    /// Phase 2A.7 audit H1: row/col outside the Excel grid (MAX_ROW = 1,048,575;
    60	    /// MAX_COLUMN = 16,383). Surfaces at buffer time so `Sheet::put` doesn't
    61	    /// panic mid-commit. `why` describes which bound was exceeded.
    62	    #[error("invalid cell (sheet={sheet}, row={row}, col={col}): {why}")]
    63	    InvalidCell {
    64	        sheet: SheetId,
    65	        row: RowId,
    66	        col: ColId,
    67	        why: &'static str,
    68	    },
    69	
    70	    #[error(
    71	        "conflicting transaction ops on cell (sheet={sheet}, row={row}, col={col}): \
    72	         a value and a formula were both buffered for this cell in the same transaction"
    73	    )]
    74	    ConflictingOps {
    75	        sheet: SheetId,
    76	        row: RowId,
    77	        col: ColId,
    78	    },
    79	
    80	    /// Phase 2A.3.b (2026-05-12): the producer-side append into an attached
    81	    /// op log failed (serde_json refused the wire value — e.g. NaN/Inf — or
    82	    /// Loro surfaced an internal error). Producer order is append-then-mutate:
    83	    /// when this fires, the workbook is unchanged. Callers attaching an op
    84	    /// log handle the error; callers that don't attach one never see this
    85	    /// variant.
    86	    #[error("op log error: {0}")]
    87	    OpLog(#[from] ql_oplog::OpLogError),
    88	
    89	    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
    90	    /// the name in the workbook's `NameTable`. Currently the only
    91	    /// `NameTableError` variant is `Reserved` (per CORR-06 the `AI` name is
    92	    /// engine-reserved); see `ql_storage::NameTableError` for additional
    93	    /// variants when they land.
    94	    #[error("name table error: {0}")]
    95	    Name(#[from] ql_storage::NameTableError),
    96	
    97	    /// **W5-91 (Phase 4.6.C):** sheet-name validation refused — empty
    98	    /// string, Excel-reserved character, or canonical duplicate.
    99	    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
   100	    /// `add_sheet` variants that validate).
   101	    #[error("sheet name rejected: {0}")]
   102	    SheetName(#[from] ql_storage::SheetNameError),
   103	
   104	    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
   105	    /// called with `chunk_rows == 0`. `Sheet::with_chunk_rows` accepts it
   106	    /// silently, then the first cell write panics deep inside the column
   107	    /// store. Pre-validating at the runtime entry refuses the value cleanly
   108	    /// before any op-log append, so a bad input can't poison a workbook.
   109	    #[error("invalid chunk_rows {0}: must be > 0 (engine default is 16384)")]
   110	    InvalidChunkRows(u32),
   111	
   112	    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
   113	    /// called with the workbook already at `SheetId::MAX` (65,535) sheets.
   114	    /// `Workbook::add_sheet_with_chunk_rows` panics in that case; the
   115	    /// runtime now refuses before any op-log append.
   116	    #[error("workbook has {current} sheets; cannot add another (limit {max})")]
   117	    TooManySheets { current: u32, max: u32 },
   118	
   119	    /// **W5-82 (Phase 4.5.D part 6):** `set_cell_format` was called with
   120	    /// `Some(FormatId)` referencing an id that hasn't been registered
   121	    /// in the workbook's `FormatTable`. Producer-side enforcement of the
   122	    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
   123	    /// `FormatNotRegistered`. Callers should obtain the id via
   124	    /// `intern_format` (which handles registration automatically).
   125	    ///
   126	    /// Phase 5.2 D-1 step 3: payload changed from `u32` to
   127	    /// `ql_storage::FormatId` (tagged tuple) — error messages now
   128	    /// distinguish `Builtin(n)` from `Custom(peer, counter)` rather
   129	    /// than only carrying the legacy u32.
   130	    #[error("format id {0:?} is not registered in the workbook FormatTable")]
   131	    UnknownFormatId(ql_storage::FormatId),
   132	
   133	    /// **W5-106-AUDIT (Codex MEDIUM closure):** recompute_dirty's
   134	    /// fixed-point loop hit its MAX_ITERATIONS bound with cells still
   135	    /// dirty. Signals a runaway spill shape transition or workbook
   136	    /// misconfiguration; the recompute result is partial.
   137	    #[error("recompute_dirty hit iteration cap with cells still dirty")]
   138	    RecomputeIterationCap,
   139	
   140	    /// **W5-118 (Phase 4.8.H):** `create_table` was rejected by a
   141	    /// validation rule. `reason` is a static string describing which
   142	    /// invariant fired (uniqueness, overlap, empty column name, ...).
   143	    #[error("table {name:?} create rejected: {reason}")]
   144	    TableCreateRejected { name: String, reason: &'static str },
   145	
   146	    /// **W5-118 (Phase 4.8.H):** `drop_table` was called on a name
   147	    /// that doesn't exist.
   148	    #[error("table {0:?} not found")]
   149	    TableNotFound(String),
   150	
   151	    /// **W5-121 (Phase 4.8.I.2):** `rename_column` referenced a column
   152	    /// name (case-insensitive) that does not exist in the target table.
   153	    #[error("table {table:?} has no column {column:?}")]
   154	    TableColumnNotFound { table: String, column: String },
   155	
   156	    /// **W5-121 (Phase 4.8.I.2):** `rename_column` was rejected by a
   157	    /// validation rule (target column name already in the table, empty,
   158	    /// etc.). `reason` is a static string describing which invariant
   159	    /// fired.
   160	    #[error("table {table:?} column {column:?} rejected: {reason}")]

exec
/bin/zsh -lc 'rg -n "FormatIdWire|from_u32_legacy|FIRST_CUSTOM_FORMAT_ID|FIRST_XLSX_BUILTIN_MAX" quantbook-engine/crates/ql-oplog/src/wire.rs quantbook-engine/crates/ql-oplog/src -S' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/wire.rs:283:pub enum FormatIdWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:289:/// conventions. Built-in format ids occupy `0..=FIRST_XLSX_BUILTIN_MAX`;
quantbook-engine/crates/ql-oplog/src/wire.rs:292:/// ids; the step-5 envelope-migration `from_u32_legacy` reads it back.
quantbook-engine/crates/ql-oplog/src/wire.rs:293:const FIRST_XLSX_BUILTIN_MAX: u32 = 163;
quantbook-engine/crates/ql-oplog/src/wire.rs:295:impl FormatIdWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:301:    /// Values `0..=FIRST_XLSX_BUILTIN_MAX` are Excel-canonical built-in
quantbook-engine/crates/ql-oplog/src/wire.rs:302:    /// format ids. Values `>= FIRST_XLSX_BUILTIN_MAX + 1` were allocated
quantbook-engine/crates/ql-oplog/src/wire.rs:304:    /// `FIRST_XLSX_BUILTIN_MAX + 1 = 164`.
quantbook-engine/crates/ql-oplog/src/wire.rs:315:    pub fn from_u32_legacy(n: u32) -> Self {
quantbook-engine/crates/ql-oplog/src/wire.rs:316:        if n <= FIRST_XLSX_BUILTIN_MAX {
quantbook-engine/crates/ql-oplog/src/wire.rs:317:            FormatIdWire::Builtin { id: n }
quantbook-engine/crates/ql-oplog/src/wire.rs:319:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:321:                counter: n - (FIRST_XLSX_BUILTIN_MAX + 1),
quantbook-engine/crates/ql-oplog/src/wire.rs:358:    //! Phase 5.2 D-1 step 2 (2026-05-19): tests for `FormatIdWire`.
quantbook-engine/crates/ql-oplog/src/wire.rs:365:    //! - `from_u32_legacy` migration boundaries (0, 163, 164, large).
quantbook-engine/crates/ql-oplog/src/wire.rs:373:        let original = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:376:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:382:        let original = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:389:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:394:    fn from_u32_legacy_maps_zero_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:397:            FormatIdWire::from_u32_legacy(0),
quantbook-engine/crates/ql-oplog/src/wire.rs:398:            FormatIdWire::Builtin { id: 0 }
quantbook-engine/crates/ql-oplog/src/wire.rs:403:    fn from_u32_legacy_maps_163_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:406:            FormatIdWire::from_u32_legacy(163),
quantbook-engine/crates/ql-oplog/src/wire.rs:407:            FormatIdWire::Builtin { id: 163 }
quantbook-engine/crates/ql-oplog/src/wire.rs:412:    fn from_u32_legacy_maps_164_to_custom_counter_zero() {
quantbook-engine/crates/ql-oplog/src/wire.rs:415:            FormatIdWire::from_u32_legacy(164),
quantbook-engine/crates/ql-oplog/src/wire.rs:416:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:424:    fn from_u32_legacy_maps_large_to_custom() {
quantbook-engine/crates/ql-oplog/src/wire.rs:427:            FormatIdWire::from_u32_legacy(999),
quantbook-engine/crates/ql-oplog/src/wire.rs:428:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:442:        let a = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:443:        let b = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:444:        let c = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:450:        let mut set: HashSet<FormatIdWire> = HashSet::new();
quantbook-engine/crates/ql-oplog/src/wire.rs:460:        // Verify same-counter different-peer FormatIdWires are not equal.
quantbook-engine/crates/ql-oplog/src/wire.rs:461:        let a = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:465:        let b = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:480:        // FormatIdWire will live inside `Op::RegisterFormat` (step 4).
quantbook-engine/crates/ql-oplog/src/wire.rs:483:        let original = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:488:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:507:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:518:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:531:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:543:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/lib.rs:48:pub use wire::{CellWireValue, FormatIdWire, NamedTargetWire, WireDecodeError};
quantbook-engine/crates/ql-oplog/src/replay.rs:509:            // bare `u32` (step 4 will change to `FormatIdWire`); convert
quantbook-engine/crates/ql-oplog/src/wire.rs:283:pub enum FormatIdWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:289:/// conventions. Built-in format ids occupy `0..=FIRST_XLSX_BUILTIN_MAX`;
quantbook-engine/crates/ql-oplog/src/wire.rs:292:/// ids; the step-5 envelope-migration `from_u32_legacy` reads it back.
quantbook-engine/crates/ql-oplog/src/wire.rs:293:const FIRST_XLSX_BUILTIN_MAX: u32 = 163;
quantbook-engine/crates/ql-oplog/src/wire.rs:295:impl FormatIdWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:301:    /// Values `0..=FIRST_XLSX_BUILTIN_MAX` are Excel-canonical built-in
quantbook-engine/crates/ql-oplog/src/wire.rs:302:    /// format ids. Values `>= FIRST_XLSX_BUILTIN_MAX + 1` were allocated
quantbook-engine/crates/ql-oplog/src/wire.rs:304:    /// `FIRST_XLSX_BUILTIN_MAX + 1 = 164`.
quantbook-engine/crates/ql-oplog/src/wire.rs:315:    pub fn from_u32_legacy(n: u32) -> Self {
quantbook-engine/crates/ql-oplog/src/wire.rs:316:        if n <= FIRST_XLSX_BUILTIN_MAX {
quantbook-engine/crates/ql-oplog/src/wire.rs:317:            FormatIdWire::Builtin { id: n }
quantbook-engine/crates/ql-oplog/src/wire.rs:319:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:321:                counter: n - (FIRST_XLSX_BUILTIN_MAX + 1),
quantbook-engine/crates/ql-oplog/src/wire.rs:358:    //! Phase 5.2 D-1 step 2 (2026-05-19): tests for `FormatIdWire`.
quantbook-engine/crates/ql-oplog/src/wire.rs:365:    //! - `from_u32_legacy` migration boundaries (0, 163, 164, large).
quantbook-engine/crates/ql-oplog/src/wire.rs:373:        let original = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:376:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:382:        let original = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:389:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:394:    fn from_u32_legacy_maps_zero_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:397:            FormatIdWire::from_u32_legacy(0),
quantbook-engine/crates/ql-oplog/src/wire.rs:398:            FormatIdWire::Builtin { id: 0 }
quantbook-engine/crates/ql-oplog/src/wire.rs:403:    fn from_u32_legacy_maps_163_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:406:            FormatIdWire::from_u32_legacy(163),
quantbook-engine/crates/ql-oplog/src/wire.rs:407:            FormatIdWire::Builtin { id: 163 }
quantbook-engine/crates/ql-oplog/src/wire.rs:412:    fn from_u32_legacy_maps_164_to_custom_counter_zero() {
quantbook-engine/crates/ql-oplog/src/wire.rs:415:            FormatIdWire::from_u32_legacy(164),
quantbook-engine/crates/ql-oplog/src/wire.rs:416:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:424:    fn from_u32_legacy_maps_large_to_custom() {
quantbook-engine/crates/ql-oplog/src/wire.rs:427:            FormatIdWire::from_u32_legacy(999),
quantbook-engine/crates/ql-oplog/src/wire.rs:428:            FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:442:        let a = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:443:        let b = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:444:        let c = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:450:        let mut set: HashSet<FormatIdWire> = HashSet::new();
quantbook-engine/crates/ql-oplog/src/wire.rs:460:        // Verify same-counter different-peer FormatIdWires are not equal.
quantbook-engine/crates/ql-oplog/src/wire.rs:461:        let a = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:465:        let b = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:480:        // FormatIdWire will live inside `Op::RegisterFormat` (step 4).
quantbook-engine/crates/ql-oplog/src/wire.rs:483:        let original = FormatIdWire::Custom {
quantbook-engine/crates/ql-oplog/src/wire.rs:488:        let back: FormatIdWire = serde_json::from_str(&json).unwrap();
quantbook-engine/crates/ql-oplog/src/wire.rs:507:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:518:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:531:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);
quantbook-engine/crates/ql-oplog/src/wire.rs:543:        let result: Result<FormatIdWire, _> = serde_json::from_str(json);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/wire.rs | sed -n '270,345p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '490,535p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   490	                        source,
   491	                    })?;
   492	                Ok(())
   493	            } else {
   494	                Err(ReplayError::SheetRenameNameMismatch {
   495	                    index,
   496	                    id: *id,
   497	                    expected: old_name.clone(),
   498	                    found: current,
   499	                })
   500	            }
   501	        }
   502	        Op::RegisterFormat { id, string } => {
   503	            // **W5-80:** route through `FormatTable::register_at` so
   504	            // collisions surface as `FormatRejected` (rather than the
   505	            // panic-on-duplicate behavior `intern` would have via the
   506	            // by_string fast path; `register_at` is the explicit-id form).
   507	            //
   508	            // Phase 5.2 D-1 step 3: `Op::RegisterFormat.id` is still a
   509	            // bare `u32` (step 4 will change to `FormatIdWire`); convert
   510	            // through the legacy migration helper. Pre-step-4 callers
   511	            // ALL went through the LEGACY_PEER path so this conversion
   512	            // is lossless for existing saved data.
   513	            let fid = ql_storage::FormatId::legacy_from_u32(*id);
   514	            workbook
   515	                .formats_mut()
   516	                .register_at(fid, string.as_str())
   517	                .map_err(|e| ReplayError::FormatRejected {
   518	                    index,
   519	                    source: e.into(),
   520	                })?;
   521	            Ok(())
   522	        }
   523	        Op::SetCellFormat {
   524	            sheet,
   525	            row,
   526	            col,
   527	            id,
   528	        } => {
   529	            validate_cell(workbook, *sheet, *row, *col, index)?;
   530	            // **W5-80:** require the id to be registered. Catches
   531	            // producer bugs where `SetCellFormat` was emitted without
   532	            // a preceding `RegisterFormat`. `None` means clear.
   533	            if let Some(raw_id) = id {
   534	                // Phase 5.2 D-1 step 3: same legacy conversion as
   535	                // RegisterFormat above. Step 4 changes Op shape.

 succeeded in 0ms:
   270	///
   271	/// ```text
   272	/// {"kind": "builtin", "id": 14}
   273	/// {"kind": "custom", "peer": 42, "counter": 7}
   274	/// ```
   275	///
   276	/// The collision-freedom guarantee (Phase 5.1 audit-locked decision D-1)
   277	/// comes from the `Custom` variant carrying the originating peer's id:
   278	/// two concurrent peers with distinct `peer` values can both allocate
   279	/// `counter = 0` without colliding because the full `FormatId` differs
   280	/// in its `peer` component.
   281	#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
   282	#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
   283	pub enum FormatIdWire {
   284	    Builtin { id: u32 },
   285	    Custom { peer: PeerId, counter: u32 },
   286	}
   287	
   288	/// First xlsx custom-format `numFmtId`, mirroring Excel + OpenFormula
   289	/// conventions. Built-in format ids occupy `0..=FIRST_XLSX_BUILTIN_MAX`;
   290	/// custom format ids start at `FIRST_XLSX_CUSTOM_NUMFMT = 164`. Pre-5.2
   291	/// `.qbook` saves used this boundary to allocate single-writer custom
   292	/// ids; the step-5 envelope-migration `from_u32_legacy` reads it back.
   293	const FIRST_XLSX_BUILTIN_MAX: u32 = 163;
   294	
   295	impl FormatIdWire {
   296	    /// **Phase 5.2 D-1 step 2 migration helper (born here, used by step
   297	    /// 5's qbook envelope loader):** map a pre-5.2 bare-`u32` `FormatId`
   298	    /// encoding to the new tagged-tuple wire shape.
   299	    ///
   300	    /// Pre-5.2 encoding: `FormatId` was `pub struct FormatId(pub u32)`.
   301	    /// Values `0..=FIRST_XLSX_BUILTIN_MAX` are Excel-canonical built-in
   302	    /// format ids. Values `>= FIRST_XLSX_BUILTIN_MAX + 1` were allocated
   303	    /// by the engine's single-writer custom counter, starting at
   304	    /// `FIRST_XLSX_BUILTIN_MAX + 1 = 164`.
   305	    ///
   306	    /// Migration mapping:
   307	    /// - `n <= 163` → `Builtin { id: n }`.
   308	    /// - `n >= 164` → `Custom { peer: LEGACY_PEER, counter: n - 164 }`.
   309	    ///
   310	    /// `LEGACY_PEER = PeerId(0)` is the sentinel for "this custom id
   311	    /// was allocated by a pre-collab single-writer save"; per Phase
   312	    /// 5.2.b's distinct-peer-id requirement, no live peer should use
   313	    /// peer-id 0, so legacy ids can't collide with custom ids allocated
   314	    /// by an active session.
   315	    pub fn from_u32_legacy(n: u32) -> Self {
   316	        if n <= FIRST_XLSX_BUILTIN_MAX {
   317	            FormatIdWire::Builtin { id: n }
   318	        } else {
   319	            FormatIdWire::Custom {
   320	                peer: LEGACY_PEER,
   321	                counter: n - (FIRST_XLSX_BUILTIN_MAX + 1),
   322	            }
   323	        }
   324	    }
   325	}
   326	
   327	/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
   328	/// Used by both wire-format serialization and the user-visible representation per spec.
   329	pub fn error_to_canonical_text(e: ErrorValue) -> String {
   330	    e.sigil().to_string()
   331	}
   332	
   333	/// Parse a canonical Excel-style error sigil back into an `ErrorValue`.
   334	/// `None` for unrecognized inputs (callers map to a typed decode error).
   335	pub fn parse_canonical_error_text(s: &str) -> Option<ErrorValue> {
   336	    Some(match s {
   337	        "#REF!" => ErrorValue::Ref,
   338	        "#VALUE!" => ErrorValue::Value,
   339	        "#N/A" => ErrorValue::NA,
   340	        "#DIV/0!" => ErrorValue::DivZero,
   341	        "#NULL!" => ErrorValue::Null,
   342	        "#NUM!" => ErrorValue::Num,
   343	        "#NAME?" => ErrorValue::Name,
   344	        "#SPILL!" => ErrorValue::Spill,
   345	        "#CALC!" => ErrorValue::Calc,

exec
/bin/zsh -lc "rg -n \"RegisterFormat|SetCellFormat|FormatNotRegistered|legacy_from_u32|to_legacy_u32|FormatId::Builtin\\(200\\)|Builtin\\([2-9][0-9][0-9]\\)\" quantbook-engine/crates -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:121:    /// `Op::SetCellFormat` referenced a format id that hasn't been
quantbook-engine/crates/ql-oplog/src/replay.rs:122:    /// registered yet. The producer SHOULD always emit `RegisterFormat`
quantbook-engine/crates/ql-oplog/src/replay.rs:123:    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
quantbook-engine/crates/ql-oplog/src/replay.rs:126:    FormatNotRegistered { index: usize, id: u32 },
quantbook-engine/crates/ql-oplog/src/replay.rs:502:        Op::RegisterFormat { id, string } => {
quantbook-engine/crates/ql-oplog/src/replay.rs:508:            // Phase 5.2 D-1 step 3: `Op::RegisterFormat.id` is still a
quantbook-engine/crates/ql-oplog/src/replay.rs:513:            let fid = ql_storage::FormatId::legacy_from_u32(*id);
quantbook-engine/crates/ql-oplog/src/replay.rs:523:        Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:531:            // producer bugs where `SetCellFormat` was emitted without
quantbook-engine/crates/ql-oplog/src/replay.rs:532:            // a preceding `RegisterFormat`. `None` means clear.
quantbook-engine/crates/ql-oplog/src/replay.rs:535:                // RegisterFormat above. Step 4 changes Op shape.
quantbook-engine/crates/ql-oplog/src/replay.rs:536:                let fid = ql_storage::FormatId::legacy_from_u32(*raw_id);
quantbook-engine/crates/ql-oplog/src/replay.rs:538:                    return Err(ReplayError::FormatNotRegistered { index, id: *raw_id });
quantbook-engine/crates/ql-oplog/src/replay.rs:1358:        log.append(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1368:            // Step 3: replayed Op::RegisterFormat with id=200 routes
quantbook-engine/crates/ql-oplog/src/replay.rs:1369:            // through legacy_from_u32 → Custom(LEGACY_PEER, 200-164=36).
quantbook-engine/crates/ql-oplog/src/replay.rs:1371:                .lookup(ql_storage::FormatId::legacy_from_u32(200)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1381:        log.append(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1391:            // Step 3: id=0 → Builtin(0) via legacy_from_u32.
quantbook-engine/crates/ql-oplog/src/replay.rs:1402:        log.append(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1428:        log.append(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1433:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1446:            // Step 3: Op id=200 → Custom(LEGACY_PEER, 36) via legacy_from_u32.
quantbook-engine/crates/ql-oplog/src/replay.rs:1447:            Some(ql_storage::FormatId::legacy_from_u32(200))
quantbook-engine/crates/ql-oplog/src/replay.rs:1454:        log.append(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1459:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1467:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1483:        // Op references id 999 but no RegisterFormat preceded it.
quantbook-engine/crates/ql-oplog/src/replay.rs:1485:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1496:            Err(ReplayError::FormatNotRegistered { index, id }) => {
quantbook-engine/crates/ql-oplog/src/replay.rs:1500:            other => panic!("expected FormatNotRegistered, got {other:?}"),
quantbook-engine/crates/ql-oplog/src/replay.rs:1507:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1526:        // an explicit RegisterFormat (id 14 is pre-populated). Just
quantbook-engine/crates/ql-oplog/src/replay.rs:1527:        // SetCellFormat should succeed.
quantbook-engine/crates/ql-oplog/src/replay.rs:1529:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/op.rs:17://! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
quantbook-engine/crates/ql-oplog/src/op.rs:18://! | `SetCellFormat`    | `CellFormatOverlay::set` / `::clear` (W5-80)     |
quantbook-engine/crates/ql-oplog/src/op.rs:121:    RegisterFormat { id: u32, string: String },
quantbook-engine/crates/ql-oplog/src/op.rs:127:    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
quantbook-engine/crates/ql-oplog/src/op.rs:128:    SetCellFormat {
quantbook-engine/crates/ql-oplog/src/wire.rs:257:/// `Op::RegisterFormat` / `Op::SetCellFormat`.
quantbook-engine/crates/ql-oplog/src/wire.rs:480:        // FormatIdWire will live inside `Op::RegisterFormat` (step 4).
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:78:    ops.push(Op::RegisterFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:83:    // RegisterFormat needed; the built-in is pre-seeded by
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:85:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:92:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:98:    // And clear a binding (Op::SetCellFormat with None on a previously-
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:100:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:191:            Op::RegisterFormat { id, string } => {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:196:                    .register_at(ql_storage::FormatId::legacy_from_u32(*id), string.as_str())
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:199:            Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:211:                            ql_storage::FormatId::legacy_from_u32(*raw_id),
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:318:    // bug in `RegisterFormat` / `SetCellFormat` ordering or id-
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:323:    // any to_legacy_u32 hop.
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:254:    // RegisterFormat).
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:255:    log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-storage/src/sheet.rs:72:    /// `Op::SetCellFormat`; direct access stays available for the
quantbook-engine/crates/ql-storage/src/format_overlay.rs:155:        assert_eq!(o.count_refs(FormatId::legacy_from_u32(999)), 0);
quantbook-engine/crates/ql-io/src/qbook_format.rs:1112:                        // still uses bare-u32 ids. `to_legacy_u32()`
quantbook-engine/crates/ql-io/src/qbook_format.rs:1119:                            .to_legacy_u32()
quantbook-engine/crates/ql-io/src/qbook_format.rs:1196:                    .to_legacy_u32()
quantbook-engine/crates/ql-io/src/qbook_format.rs:1533:                    ql_storage::FormatId::legacy_from_u32(entry.id),
quantbook-engine/crates/ql-io/src/qbook_format.rs:1573:        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
quantbook-engine/crates/ql-io/src/qbook_format.rs:1584:            // converts `entry.id` via `legacy_from_u32` before query.
quantbook-engine/crates/ql-io/src/qbook_format.rs:1601:                let fid = ql_storage::FormatId::legacy_from_u32(entry.id);
quantbook-engine/crates/ql-io/src/qbook_format.rs:2999:            id_a.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3003:            id_b.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3112:                    .lookup(ql_storage::FormatId::legacy_from_u32(id))
quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:11://!   in the workbook's `FormatTable` and emit `Op::RegisterFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:30:    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:43:        // new id is allocated and we MUST NOT emit `RegisterFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:55:        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:61:            oplog.append(Op::RegisterFormat {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:62:                id: id.to_legacy_u32().expect(
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:77:    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:80:    /// `FormatNotRegistered` semantic — producer-side enforcement is
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:102:            oplog.append(Op::SetCellFormat {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:109:                    f.to_legacy_u32()
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:221:        // No RegisterFormat ops should have been emitted — both strings
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:224:        assert_eq!(ops.len(), 0, "built-ins must not emit RegisterFormat ops");
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:237:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:243:            Op::RegisterFormat { id, string } => {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:248:            other => panic!("expected RegisterFormat, got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:287:            .any(|o| matches!(o, Op::SetCellFormat { id: Some(14), .. })));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:309:            .any(|o| matches!(o, Op::SetCellFormat { id: None, .. })));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:318:        let bad_id = FormatId::legacy_from_u32(9999);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:321:        // legacy_from_u32(9999) = Custom(LEGACY_PEER, 9999 - 164) = 9835.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:437:        let custom_id = FormatId::legacy_from_u32(ql_storage::FIRST_CUSTOM_FORMAT_ID);
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:122:    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:123:    /// `FormatNotRegistered`. Callers should obtain the id via
quantbook-engine/crates/ql-storage/src/format.rs:28://! Migration helper [`FormatId::legacy_from_u32`] converts pre-5.2
quantbook-engine/crates/ql-storage/src/format.rs:57:/// `Op::RegisterFormat` / `Op::SetCellFormat` payload (step 4).
quantbook-engine/crates/ql-storage/src/format.rs:105:    pub fn legacy_from_u32(n: u32) -> Self {
quantbook-engine/crates/ql-storage/src/format.rs:123:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/crates/ql-storage/src/format.rs:144:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/crates/ql-storage/src/format.rs:241:    /// allocations. Read by `Op::RegisterFormat` producers and by
quantbook-engine/crates/ql-storage/src/format.rs:271:    /// `Op::RegisterFormat` events in the same order they were
quantbook-engine/crates/ql-storage/src/format.rs:290:    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
quantbook-engine/crates/ql-storage/src/format.rs:462:        t.register_at(FormatId::Builtin(200), "REPLAY").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:463:        assert_eq!(t.lookup(FormatId::Builtin(200)), Some("REPLAY"));
quantbook-engine/crates/ql-storage/src/format.rs:468:        // Replaying an Op::RegisterFormat that allocated under OUR
quantbook-engine/crates/ql-storage/src/format.rs:481:        // A remote peer's Op::RegisterFormat registers an id under
quantbook-engine/crates/ql-storage/src/format.rs:515:            .register_at(FormatId::Builtin(200), "General")
quantbook-engine/crates/ql-storage/src/format.rs:558:    fn legacy_from_u32_maps_builtins_and_customs() {
quantbook-engine/crates/ql-storage/src/format.rs:560:        assert_eq!(FormatId::legacy_from_u32(0), FormatId::Builtin(0));
quantbook-engine/crates/ql-storage/src/format.rs:561:        assert_eq!(FormatId::legacy_from_u32(163), FormatId::Builtin(163));
quantbook-engine/crates/ql-storage/src/format.rs:563:            FormatId::legacy_from_u32(164),
quantbook-engine/crates/ql-storage/src/format.rs:567:            FormatId::legacy_from_u32(999),
quantbook-engine/crates/ql-storage/src/format.rs:573:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/crates/ql-storage/src/format.rs:574:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/crates/ql-storage/src/format.rs:575:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/crates/ql-storage/src/format.rs:576:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/crates/ql-storage/src/format.rs:578:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/crates/ql-storage/src/format.rs:584:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:589:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/crates/ql-storage/src/format.rs:595:            let id = FormatId::legacy_from_u32(n);
quantbook-engine/crates/ql-storage/src/format.rs:596:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/crates/ql-types/src/peer.rs:31://! - `ql_oplog::wire::FormatIdWire` + `Op::RegisterFormat/SetCellFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:156:    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:                id.to_legacy_u32()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:157:            .lookup(ql_storage::FormatId::legacy_from_u32(164))
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1633:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1691:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:279:            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:68:        let id = FormatId::legacy_from_u32(entry.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:159:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:163:            wb.formats().lookup(FormatId::legacy_from_u32(165)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:197:            .register_at(FormatId::legacy_from_u32(164), "yyyy-mm-dd")
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:230:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:292:        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:298:                a.1.to_legacy_u32()
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:340:    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:349:                    id.to_legacy_u32()
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1003:            fid.to_legacy_u32()

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '1348,1538p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/replay.rs | sed -n '533,555p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '1,240p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   533	            if let Some(raw_id) = id {
   534	                // Phase 5.2 D-1 step 3: same legacy conversion as
   535	                // RegisterFormat above. Step 4 changes Op shape.
   536	                let fid = ql_storage::FormatId::legacy_from_u32(*raw_id);
   537	                if workbook.formats().lookup(fid).is_none() {
   538	                    return Err(ReplayError::FormatNotRegistered { index, id: *raw_id });
   539	                }
   540	                workbook
   541	                    .sheet_mut(*sheet)
   542	                    .expect("sheet validated above")
   543	                    .format_overlay_mut()
   544	                    .set(*row, *col, fid);
   545	            } else {
   546	                workbook
   547	                    .sheet_mut(*sheet)
   548	                    .expect("sheet validated above")
   549	                    .format_overlay_mut()
   550	                    .clear(*row, *col);
   551	            }
   552	            Ok(())
   553	        }
   554	        Op::BatchCommit { ops } => {
   555	            for inner_op in ops {

 succeeded in 0ms:
  1348	            }
  1349	            other => panic!("expected NameRejected, got {other:?}"),
  1350	        }
  1351	    }
  1352	
  1353	    // ===== W5-80 / Phase 4.5.D part 4 — format op tests =====
  1354	
  1355	    #[test]
  1356	    fn replay_register_format_installs_custom_id() {
  1357	        let mut log = OpLog::new();
  1358	        log.append(Op::RegisterFormat {
  1359	            id: 200,
  1360	            string: "\"€\" #,##0.00".to_owned(),
  1361	        })
  1362	        .unwrap();
  1363	
  1364	        let mut wb = fresh_workbook_with_one_sheet();
  1365	        let reg = default_registry();
  1366	        replay_into(&log, &mut wb, &reg).unwrap();
  1367	        assert_eq!(
  1368	            // Step 3: replayed Op::RegisterFormat with id=200 routes
  1369	            // through legacy_from_u32 → Custom(LEGACY_PEER, 200-164=36).
  1370	            wb.formats()
  1371	                .lookup(ql_storage::FormatId::legacy_from_u32(200)),
  1372	            Some("\"€\" #,##0.00")
  1373	        );
  1374	    }
  1375	
  1376	    #[test]
  1377	    fn replay_register_format_idempotent_for_existing_builtin() {
  1378	        // Re-registering an Excel built-in at its canonical id is a no-op
  1379	        // (pre-populated by Workbook::default). Replay must not error.
  1380	        let mut log = OpLog::new();
  1381	        log.append(Op::RegisterFormat {
  1382	            id: 0,
  1383	            string: "General".to_owned(),
  1384	        })
  1385	        .unwrap();
  1386	
  1387	        let mut wb = fresh_workbook_with_one_sheet();
  1388	        let reg = default_registry();
  1389	        replay_into(&log, &mut wb, &reg).unwrap();
  1390	        assert_eq!(
  1391	            // Step 3: id=0 → Builtin(0) via legacy_from_u32.
  1392	            wb.formats().lookup(ql_storage::FormatId::Builtin(0)),
  1393	            Some("General")
  1394	        );
  1395	    }
  1396	
  1397	    #[test]
  1398	    fn replay_register_format_id_collision_errors() {
  1399	        // Built-in id 0 is "General"; registering a DIFFERENT string at
  1400	        // id 0 must surface as `FormatRejected`.
  1401	        let mut log = OpLog::new();
  1402	        log.append(Op::RegisterFormat {
  1403	            id: 0,
  1404	            string: "WRONG".to_owned(),
  1405	        })
  1406	        .unwrap();
  1407	
  1408	        let mut wb = fresh_workbook_with_one_sheet();
  1409	        let reg = default_registry();
  1410	        match replay_into(&log, &mut wb, &reg) {
  1411	            Err(ReplayError::FormatRejected { index, source }) => {
  1412	                assert_eq!(index, 0);
  1413	                assert!(matches!(
  1414	                    source,
  1415	                    FormatRejectedSource::IdCollision {
  1416	                        id: ql_storage::FormatId::Builtin(0),
  1417	                        ..
  1418	                    }
  1419	                ));
  1420	            }
  1421	            other => panic!("expected FormatRejected, got {other:?}"),
  1422	        }
  1423	    }
  1424	
  1425	    #[test]
  1426	    fn replay_set_cell_format_binds_overlay() {
  1427	        let mut log = OpLog::new();
  1428	        log.append(Op::RegisterFormat {
  1429	            id: 200,
  1430	            string: "0.000".to_owned(),
  1431	        })
  1432	        .unwrap();
  1433	        log.append(Op::SetCellFormat {
  1434	            sheet: 0,
  1435	            row: 3,
  1436	            col: 5,
  1437	            id: Some(200),
  1438	        })
  1439	        .unwrap();
  1440	
  1441	        let mut wb = fresh_workbook_with_one_sheet();
  1442	        let reg = default_registry();
  1443	        replay_into(&log, &mut wb, &reg).unwrap();
  1444	        assert_eq!(
  1445	            wb.sheet(0).unwrap().format_overlay().get(3, 5),
  1446	            // Step 3: Op id=200 → Custom(LEGACY_PEER, 36) via legacy_from_u32.
  1447	            Some(ql_storage::FormatId::legacy_from_u32(200))
  1448	        );
  1449	    }
  1450	
  1451	    #[test]
  1452	    fn replay_set_cell_format_with_none_clears_overlay() {
  1453	        let mut log = OpLog::new();
  1454	        log.append(Op::RegisterFormat {
  1455	            id: 200,
  1456	            string: "0.000".to_owned(),
  1457	        })
  1458	        .unwrap();
  1459	        log.append(Op::SetCellFormat {
  1460	            sheet: 0,
  1461	            row: 3,
  1462	            col: 5,
  1463	            id: Some(200),
  1464	        })
  1465	        .unwrap();
  1466	        // Now clear via id=None.
  1467	        log.append(Op::SetCellFormat {
  1468	            sheet: 0,
  1469	            row: 3,
  1470	            col: 5,
  1471	            id: None,
  1472	        })
  1473	        .unwrap();
  1474	
  1475	        let mut wb = fresh_workbook_with_one_sheet();
  1476	        let reg = default_registry();
  1477	        replay_into(&log, &mut wb, &reg).unwrap();
  1478	        assert_eq!(wb.sheet(0).unwrap().format_overlay().get(3, 5), None);
  1479	    }
  1480	
  1481	    #[test]
  1482	    fn replay_set_cell_format_unregistered_id_errors() {
  1483	        // Op references id 999 but no RegisterFormat preceded it.
  1484	        let mut log = OpLog::new();
  1485	        log.append(Op::SetCellFormat {
  1486	            sheet: 0,
  1487	            row: 0,
  1488	            col: 0,
  1489	            id: Some(999),
  1490	        })
  1491	        .unwrap();
  1492	
  1493	        let mut wb = fresh_workbook_with_one_sheet();
  1494	        let reg = default_registry();
  1495	        match replay_into(&log, &mut wb, &reg) {
  1496	            Err(ReplayError::FormatNotRegistered { index, id }) => {
  1497	                assert_eq!(index, 0);
  1498	                assert_eq!(id, 999);
  1499	            }
  1500	            other => panic!("expected FormatNotRegistered, got {other:?}"),
  1501	        }
  1502	    }
  1503	
  1504	    #[test]
  1505	    fn replay_set_cell_format_invalid_sheet_errors() {
  1506	        let mut log = OpLog::new();
  1507	        log.append(Op::SetCellFormat {
  1508	            sheet: 99,
  1509	            row: 0,
  1510	            col: 0,
  1511	            id: Some(0),
  1512	        })
  1513	        .unwrap();
  1514	
  1515	        let mut wb = fresh_workbook_with_one_sheet();
  1516	        let reg = default_registry();
  1517	        match replay_into(&log, &mut wb, &reg) {
  1518	            Err(ReplayError::InvalidSheet { sheet, .. }) => assert_eq!(sheet, 99),
  1519	            other => panic!("expected InvalidSheet, got {other:?}"),
  1520	        }
  1521	    }
  1522	
  1523	    #[test]
  1524	    fn replay_register_and_set_cell_format_built_in_id_14() {
  1525	        // Common path: cells using a built-in m/d/yyyy format don't need
  1526	        // an explicit RegisterFormat (id 14 is pre-populated). Just
  1527	        // SetCellFormat should succeed.
  1528	        let mut log = OpLog::new();
  1529	        log.append(Op::SetCellFormat {
  1530	            sheet: 0,
  1531	            row: 0,
  1532	            col: 0,
  1533	            id: Some(14),
  1534	        })
  1535	        .unwrap();
  1536	
  1537	        let mut wb = fresh_workbook_with_one_sheet();
  1538	        let reg = default_registry();

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
    77	    // Register a custom format id (164 = first custom).
    78	    ops.push(Op::RegisterFormat {
    79	        id: 164,
    80	        string: "\"€\" #,##0.00".to_owned(),
    81	    });
    82	    // Bind a cell on sheet 0 to a built-in id 14 (m/d/yyyy) — no
    83	    // RegisterFormat needed; the built-in is pre-seeded by
    84	    // `FormatTable::default()`.
    85	    ops.push(Op::SetCellFormat {
    86	        sheet: 0,
    87	        row: 0,
    88	        col: 0,
    89	        id: Some(14),
    90	    });
    91	    // Bind another cell to the custom id.
    92	    ops.push(Op::SetCellFormat {
    93	        sheet: 0,
    94	        row: 1,
    95	        col: 0,
    96	        id: Some(164),
    97	    });
    98	    // And clear a binding (Op::SetCellFormat with None on a previously-
    99	    // bound cell). Tests the clear path.
   100	    ops.push(Op::SetCellFormat {
   101	        sheet: 0,
   102	        row: 0,
   103	        col: 0,
   104	        id: None,
   105	    });
   106	    // **W5-93 (Phase 4.6.E closure):** sheet-scoped name on sheet 0.
   107	    // Codex MEDIUM-3 + Sonnet M.2: the pre-W5-93 realistic sequence
   108	    // only exercised `scope: None`, so a missing or wrong scope branch
   109	    // in replay would have passed the equivalence test silently.
   110	    ops.push(Op::SetName {
   111	        scope: Some(0),
   112	        name: "ScopedRate".to_owned(),
   113	        target: NamedTargetWire::Constant {
   114	            value: CellWireValue::Number(0.42),
   115	        },
   116	    });
   117	    // And on sheet 1 (Inventory).
   118	    ops.push(Op::SetName {
   119	        scope: Some(1),
   120	        name: "WarehouseBin".to_owned(),
   121	        target: NamedTargetWire::Cell {
   122	            sheet: 1,
   123	            row: 0,
   124	            col: 0,
   125	        },
   126	    });
   127	    ops
   128	}
   129	
   130	/// Mocks the producer side by applying ops directly to a workbook via the
   131	/// same APIs that replay uses internally. In 2A.3.b this becomes the
   132	/// real `WorkbookRuntime` + `WorkbookTransaction` calls; the public
   133	/// invariant is unchanged.
   134	fn apply_producer_side(ops: &[Op], wb: &mut Workbook) {
   135	    for op in ops {
   136	        match op {
   137	            Op::PutValue {
   138	                sheet,
   139	                row,
   140	                col,
   141	                value,
   142	            } => {
   143	                let v = value.to_value().unwrap();
   144	                wb.put_at(*sheet, *row, *col, v);
   145	            }
   146	            Op::PutFormula {
   147	                sheet,
   148	                row,
   149	                col,
   150	                text,
   151	            } => {
   152	                wb.put_formula(*sheet, *row, *col, text.as_str());
   153	            }
   154	            Op::ClearFormula { sheet, row, col } => {
   155	                wb.clear_formula(*sheet, *row, *col);
   156	            }
   157	            Op::SetName {
   158	                scope,
   159	                name,
   160	                target,
   161	            } => {
   162	                let t = target.to_target(name).unwrap();
   163	                match scope {
   164	                    None => {
   165	                        wb.set_name(name, t).unwrap();
   166	                    }
   167	                    Some(sheet) => {
   168	                        // W5-92 (Phase 4.6.D): sheet-scoped name; producer
   169	                        // mirrors replay by routing through Sheet::set_scoped_name.
   170	                        wb.sheet_mut(*sheet)
   171	                            .expect("producer-side sheet lookup must succeed")
   172	                            .set_scoped_name(name, t)
   173	                            .expect("producer-side set_scoped_name must succeed");
   174	                    }
   175	                }
   176	            }
   177	            Op::AddSheet { name, chunk_rows } => {
   178	                wb.add_sheet_with_chunk_rows(name.clone(), *chunk_rows);
   179	            }
   180	            Op::RenameSheet {
   181	                id,
   182	                old_name: _,
   183	                new_name,
   184	            } => {
   185	                // W5-91: producer side calls `Workbook::rename_sheet`
   186	                // directly here (the formula-text rewrite happens at the
   187	                // `WorkbookRuntime` layer, above the op-log boundary).
   188	                wb.rename_sheet(*id, new_name.clone())
   189	                    .expect("producer-side rename_sheet must succeed");
   190	            }
   191	            Op::RegisterFormat { id, string } => {
   192	                // Step 3: convert Op's u32 to the new FormatId enum
   193	                // shape via the legacy migration helper. Mirrors
   194	                // ql_oplog::replay's handler.
   195	                wb.formats_mut()
   196	                    .register_at(ql_storage::FormatId::legacy_from_u32(*id), string.as_str())
   197	                    .expect("producer-side register_at must succeed");
   198	            }
   199	            Op::SetCellFormat {
   200	                sheet,
   201	                row,
   202	                col,
   203	                id,
   204	            } => {
   205	                let s = wb.sheet_mut(*sheet).expect("sheet exists");
   206	                match id {
   207	                    Some(raw_id) => {
   208	                        s.format_overlay_mut().set(
   209	                            *row,
   210	                            *col,
   211	                            ql_storage::FormatId::legacy_from_u32(*raw_id),
   212	                        );
   213	                    }
   214	                    None => {
   215	                        s.format_overlay_mut().clear(*row, *col);
   216	                    }
   217	                }
   218	            }
   219	            Op::BatchCommit { ops } => {
   220	                apply_producer_side(ops, wb);
   221	            }
   222	            // **W5-118 (Phase 4.8.H), W5-119 (Phase 4.8.I), W5-121
   223	            // (Phase 4.8.I.2), W5-122 (Phase 4.8.J):** producer-side
   224	            // equivalence for table ops would require mirroring the
   225	            // WorkbookRuntime validation here. Not exercised by
   226	            // `realistic_op_sequence` today; assert unreachable so a
   227	            // future addition forces a test author to mirror the
   228	            // producer logic.
   229	            Op::CreateTable { .. }
   230	            | Op::DropTable { .. }
   231	            | Op::RenameTable { .. }
   232	            | Op::RenameColumn { .. }
   233	            | Op::ResizeTable { .. } => {
   234	                unreachable!(
   235	                    "realistic_op_sequence doesn't emit table ops yet; \
   236	                     update apply_producer_side when adding table coverage"
   237	                )
   238	            }
   239	            // **W5-146 (Phase 4.9.J):** workbook-scope reference mode /
   240	            // locale. Pure metadata; mirror replay by calling the

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '240,360p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   240	            // locale. Pure metadata; mirror replay by calling the
   241	            // matching `Workbook` setter directly.
   242	            Op::SetReferenceMode { mode } => {
   243	                // **W5-151 (4.9.O MEDIUM-2):** `to_runtime` is now
   244	                // fallible (mirroring LocaleWire); `realistic_op_sequence`
   245	                // never emits Unknown.
   246	                wb.set_reference_mode(
   247	                    mode.clone()
   248	                        .to_runtime()
   249	                        .expect("realistic_op_sequence never emits unknown reference modes"),
   250	                );
   251	            }
   252	            Op::SetLocale { locale } => {
   253	                wb.set_locale(
   254	                    locale
   255	                        .clone()
   256	                        .to_runtime()
   257	                        .expect("realistic_op_sequence never emits unknown locales"),
   258	                );
   259	            }
   260	            _ => unreachable!(
   261	                "Op gained a variant — extend apply_producer_side when adding op coverage"
   262	            ),
   263	        }
   264	    }
   265	}
   266	
   267	/// Observational equality: compare two workbooks by cell-by-cell read,
   268	/// formula text, sheet count, sheet names, and NameTable contents.
   269	fn assert_workbooks_observationally_equal(a: &Workbook, b: &Workbook) {
   270	    assert_eq!(a.sheet_count(), b.sheet_count(), "sheet counts differ");
   271	    for sheet_id in 0..(a.sheet_count() as u16) {
   272	        let sa = a.sheet(sheet_id).expect("sheet exists in a");
   273	        let sb = b.sheet(sheet_id).expect("sheet exists in b");
   274	        assert_eq!(sa.name(), sb.name(), "sheet {sheet_id} name differs");
   275	        // Compare bounds + every cell within them. Outside-bounds cells
   276	        // are uniformly Blank, so bound-equality + within-bounds-equality
   277	        // suffices.
   278	        let bounds_a = sa.bounds();
   279	        let bounds_b = sb.bounds();
   280	        let row_extent = bounds_a.row_extent.max(bounds_b.row_extent);
   281	        let col_extent = bounds_a.col_extent.max(bounds_b.col_extent);
   282	        for row in 0..row_extent {
   283	            for col in 0..col_extent {
   284	                let va = sa.read(row, col);
   285	                let vb = sb.read(row, col);
   286	                assert_eq!(
   287	                    va, vb,
   288	                    "cell (sheet={sheet_id}, row={row}, col={col}) value differs: {va:?} vs {vb:?}"
   289	                );
   290	                let fa = a
   291	                    .formula_at(sheet_id, row, col)
   292	                    .map(|s| s.as_ref().to_owned());
   293	                let fb = b
   294	                    .formula_at(sheet_id, row, col)
   295	                    .map(|s| s.as_ref().to_owned());
   296	                assert_eq!(
   297	                    fa, fb,
   298	                    "cell (sheet={sheet_id}, row={row}, col={col}) formula differs: {fa:?} vs {fb:?}"
   299	                );
   300	            }
   301	        }
   302	    }
   303	    // NameTable: compare lengths and per-name lookups.
   304	    let names_a = a.names();
   305	    let names_b = b.names();
   306	    assert_eq!(names_a.len(), names_b.len(), "name table lengths differ");
   307	    for (name, _) in names_a.iter() {
   308	        let target_a = names_a.lookup_ci(name).expect("present in a");
   309	        let target_b = names_b
   310	            .lookup_ci(name)
   311	            .unwrap_or_else(|| panic!("name {name:?} present in a but not in b"));
   312	        assert_eq!(target_a, target_b, "name {name:?} target differs");
   313	    }
   314	
   315	    // **W5-84 closure (Sonnet MEDIUM D.3):** FormatTable + per-sheet
   316	    // CellFormatOverlay must also be compared so a producer/replay
   317	    // divergence in format ops surfaces here (rather than letting a
   318	    // bug in `RegisterFormat` / `SetCellFormat` ordering or id-
   319	    // prediction slip through with matching cell values but mismatched
   320	    // formats).
   321	    // Step 3: HashMap keyed by FormatId (enum) rather than u32 — the
   322	    // FormatId enum derives Hash + Eq, so this works directly without
   323	    // any to_legacy_u32 hop.
   324	    let formats_a: std::collections::HashMap<ql_storage::FormatId, String> = a
   325	        .formats()
   326	        .iter()
   327	        .map(|(id, s)| (id, s.to_owned()))
   328	        .collect();
   329	    let formats_b: std::collections::HashMap<ql_storage::FormatId, String> = b
   330	        .formats()
   331	        .iter()
   332	        .map(|(id, s)| (id, s.to_owned()))
   333	        .collect();
   334	    assert_eq!(
   335	        formats_a, formats_b,
   336	        "FormatTable contents differ between producer and replay"
   337	    );
   338	    for sheet_id in 0..(a.sheet_count() as u16) {
   339	        let overlay_a: std::collections::HashMap<(u32, u32), ql_storage::FormatId> =
   340	            a.sheet(sheet_id).unwrap().format_overlay().iter().collect();
   341	        let overlay_b: std::collections::HashMap<(u32, u32), ql_storage::FormatId> =
   342	            b.sheet(sheet_id).unwrap().format_overlay().iter().collect();
   343	        assert_eq!(
   344	            overlay_a, overlay_b,
   345	            "CellFormatOverlay differs on sheet {sheet_id}"
   346	        );
   347	
   348	        // **W5-93 (Phase 4.6.E closure):** per-sheet `scoped_names`
   349	        // also has to be compared so a producer/replay divergence
   350	        // in `Op::SetName { scope: Some(_), .. }` ordering or
   351	        // routing surfaces here. Codex MEDIUM-3 + Sonnet M.3: the
   352	        // pre-W5-93 comparator skipped scoped_names entirely, so a
   353	        // missed routing branch in replay would have passed silently.
   354	        let scoped_a = a.sheet(sheet_id).unwrap().scoped_names();
   355	        let scoped_b = b.sheet(sheet_id).unwrap().scoped_names();
   356	        assert_eq!(
   357	            scoped_a.len(),
   358	            scoped_b.len(),
   359	            "sheet {sheet_id} scoped_names lengths differ"
   360	        );

codex
The core enum helpers match the stated 163/164 boundary, and replay converts both `RegisterFormat` and `SetCellFormat` through `legacy_from_u32`. I’m now checking the save/export `expect()` paths and searching for stale tuple/newtype assumptions.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io/src/qbook_format.rs | sed -n '1088,1212p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io/src/qbook_format.rs | sed -n '1518,1615p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1088	/// is what callers want).
  1089	fn write_workbook_to_dir(wb: &Workbook, name: &str, dir: &Path) -> Result<(), QbookError> {
  1090	    fs::create_dir_all(dir)?;
  1091	    let sheets_dir = dir.join("sheets");
  1092	    fs::create_dir_all(&sheets_dir)?;
  1093	
  1094	    // Build the envelope.
  1095	    let mut sheet_envelopes: Vec<SheetEnvelope> = Vec::new();
  1096	    for sheet_id in 0..(wb.sheet_count() as SheetId) {
  1097	        let sheet = wb.sheet(sheet_id).expect("sheet_count was wrong");
  1098	        let bounds = sheet.bounds();
  1099	        // **W5-81 (Phase 4.5.D part 5):** serialize the per-sheet cell-format
  1100	        // overlay if it has any entries. Sorted by (row, col) for diffability.
  1101	        let format_overlay = {
  1102	            let overlay = sheet.format_overlay();
  1103	            if overlay.is_empty() {
  1104	                None
  1105	            } else {
  1106	                let mut entries: Vec<FormatOverlayEntry> = overlay
  1107	                    .iter()
  1108	                    .map(|((r, c), fid)| FormatOverlayEntry {
  1109	                        row: r,
  1110	                        col: c,
  1111	                        // Phase 5.2 D-1 step 3: pre-step-5 envelope
  1112	                        // still uses bare-u32 ids. `to_legacy_u32()`
  1113	                        // returns None only for non-LEGACY peer ids,
  1114	                        // which can't exist pre-step-4 (no multi-peer
  1115	                        // producer yet). expect() makes the invariant
  1116	                        // load-bearing — step 5 changes the envelope
  1117	                        // schema to carry FormatIdWire directly.
  1118	                        id: fid
  1119	                            .to_legacy_u32()
  1120	                            .expect("pre-step-4 FormatId must be expressible as legacy u32"),
  1121	                    })
  1122	                    .collect();
  1123	                entries.sort_by_key(|e| (e.row, e.col));
  1124	                Some(entries)
  1125	            }
  1126	        };
  1127	        sheet_envelopes.push(SheetEnvelope {
  1128	            id: sheet_id,
  1129	            name: sheet.name().to_owned(),
  1130	            chunk_rows: sheet_chunk_rows(sheet),
  1131	            row_extent: bounds.row_extent,
  1132	            col_extent: bounds.col_extent,
  1133	            format_overlay,
  1134	        });
  1135	    }
  1136	
  1137	    // Phase 2A.8: serialize the workbook's NameTable. Sorted ascending by
  1138	    // (scope, name) for deterministic on-disk diffs (workbook-scoped first
  1139	    // since `None < Some` under derive(Ord); then by name). Omitted (None)
  1140	    // when both workbook-scoped table AND every sheet's scoped_names table
  1141	    // are empty, so v1-reader compatibility round-trips cleanly for the
  1142	    // empty-names common case.
  1143	    //
  1144	    // **W5-92 (Phase 4.6.D):** collects workbook-scoped names first, then
  1145	    // sheet-scoped names from each sheet's `scoped_names` table. The
  1146	    // `scope` field on `NamedEntry` distinguishes the two; legacy v1-v4
  1147	    // readers emit only the workbook-scoped entries (no per-sheet names
  1148	    // existed pre-v5).
  1149	    let names_section = {
  1150	        let mut entries: Vec<NamedEntry> = Vec::new();
  1151	        for (name, target) in wb.names().iter() {
  1152	            entries.push(NamedEntry {
  1153	                name: name.as_ref().to_owned(),
  1154	                target: NamedTargetWire::from_target(target),
  1155	                scope: None,
  1156	            });
  1157	        }
  1158	        for sheet_id in 0..wb.sheet_count() as ql_types::SheetId {
  1159	            if let Some(sheet) = wb.sheet(sheet_id) {
  1160	                for (name, target) in sheet.scoped_names().iter() {
  1161	                    entries.push(NamedEntry {
  1162	                        name: name.as_ref().to_owned(),
  1163	                        target: NamedTargetWire::from_target(target),
  1164	                        scope: Some(sheet_id),
  1165	                    });
  1166	                }
  1167	            }
  1168	        }
  1169	        if entries.is_empty() {
  1170	            None
  1171	        } else {
  1172	            // Deterministic ordering: workbook-scoped (scope=None) entries
  1173	            // first, then sheet-scoped grouped by sheet id; within each
  1174	            // group, names sorted ascending.
  1175	            entries.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));
  1176	            Some(NamesSection { entries })
  1177	        }
  1178	    };
  1179	
  1180	    // **W5-81 (Phase 4.5.D part 5):** serialize custom FormatTable entries
  1181	    // (id ≥ FIRST_CUSTOM_FORMAT_ID). Built-ins are re-seeded from
  1182	    // `FormatTable::default()` on load and aren't persisted. None if the
  1183	    // table has no custom entries (typical for built-in-only workbooks).
  1184	    let formats_section = {
  1185	        let mut entries: Vec<FormatEntry> = wb
  1186	            .formats()
  1187	            .iter()
  1188	            // Phase 5.2 D-1 step 3: `id.is_custom()` replaces the
  1189	            // pre-step-3 `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter.
  1190	            // Persist only custom (peer-allocated) entries; built-ins
  1191	            // re-seed from `FormatTable::default()` on load.
  1192	            .filter(|(id, _)| id.is_custom())
  1193	            .map(|(id, s)| FormatEntry {
  1194	                // Same expect-pattern as the format_overlay save above.
  1195	                id: id
  1196	                    .to_legacy_u32()
  1197	                    .expect("pre-step-4 FormatId must be expressible as legacy u32"),
  1198	                string: s.to_owned(),
  1199	            })
  1200	            .collect();
  1201	        if entries.is_empty() {
  1202	            None
  1203	        } else {
  1204	            entries.sort_by_key(|e| e.id);
  1205	            Some(FormatsSection { entries })
  1206	        }
  1207	    };
  1208	
  1209	    // **W5-123 (Phase 4.8.L):** serialize `TableTable` if non-empty.
  1210	    // Sorted ascending by canonical (uppercase) name for deterministic
  1211	    // diffs. Empty TableTable → `None` so v1-v5 readers don't see an
  1212	    // unexpected `[[tables]]` block that they'd misinterpret (the

 succeeded in 0ms:
  1518	    // a no-op for the default (A1 / EnUs) case.
  1519	    wb.set_reference_mode(reference_mode);
  1520	    wb.set_locale(locale);
  1521	    // **W5-81 (Phase 4.5.D part 5):** apply the envelope's FormatsSection.
  1522	    // v4 envelopes carry custom format entries (id ≥ 164); v1-v3 don't.
  1523	    // Built-ins 0-163 are already in the FormatTable from
  1524	    // `Workbook::default()`. `register_at` is idempotent for the
  1525	    // pre-seeded builtins; mismatches surface as `MalformedFormat`.
  1526	    if let Some(ref fs) = envelope.formats {
  1527	        for entry in &fs.entries {
  1528	            // Phase 5.2 D-1 step 3: pre-step-5 envelopes carry
  1529	            // bare-u32 ids. Convert via the legacy migration helper:
  1530	            // n <= 163 → Builtin(n); n >= 164 → Custom(LEGACY_PEER, n - 164).
  1531	            wb.formats_mut()
  1532	                .register_at(
  1533	                    ql_storage::FormatId::legacy_from_u32(entry.id),
  1534	                    entry.string.as_str(),
  1535	                )
  1536	                .map_err(|err| QbookError::MalformedFormat {
  1537	                    id: entry.id,
  1538	                    details: format!("{err:?}"),
  1539	                })?;
  1540	        }
  1541	    }
  1542	    let sheets_dir = path.join("sheets");
  1543	    for (expected_id, sheet_env) in envelope.sheets.iter().enumerate() {
  1544	        if sheet_env.id as usize != expected_id {
  1545	            return Err(QbookError::NonSequentialSheetIds {
  1546	                expected: expected_id as u16,
  1547	                found: sheet_env.id,
  1548	            });
  1549	        }
  1550	        // W5-93 (Phase 4.6.E closure): route through the fallible variant
  1551	        // so a malformed `.qbook` (hand-edited duplicate name, reserved
  1552	        // char, empty) surfaces as `QbookError::MalformedSheet` rather
  1553	        // than a process-killing panic. Previously the loader silently
  1554	        // accepted any name.
  1555	        let sheet_id = wb
  1556	            .try_add_sheet_with_chunk_rows(sheet_env.name.clone(), sheet_env.chunk_rows)
  1557	            .map_err(|source| QbookError::MalformedSheet {
  1558	                sheet_id: sheet_env.id,
  1559	                name: sheet_env.name.clone(),
  1560	                source,
  1561	            })?;
  1562	        assert_eq!(
  1563	            sheet_id as usize, expected_id,
  1564	            "Workbook::try_add_sheet_with_chunk_rows returned non-sequential id — programmer error in ql-storage"
  1565	        );
  1566	
  1567	        // **W5-81 (Phase 4.5.D part 5):** apply the per-sheet cell-format
  1568	        // overlay. v4 envelopes carry `format_overlay`; v1-v3 don't.
  1569	        //
  1570	        // **W5-84 closure (Codex MEDIUM-3):** the loader now VALIDATES
  1571	        // that each overlay id resolves in the workbook's `FormatTable`,
  1572	        // matching the runtime + replay contract (which both surface
  1573	        // `UnknownFormatId` / `FormatNotRegistered` on bad ids). A
  1574	        // corrupted `.qbook` binding a cell to an unregistered id no
  1575	        // longer falls through to silent General fallback at render
  1576	        // time — it now surfaces `MalformedFormatOverlay` at load.
  1577	        if let Some(ref overlay_entries) = sheet_env.format_overlay {
  1578	            // Snapshot the set of registered ids BEFORE the overlay
  1579	            // mutation so we don't borrow `wb` twice (mutable on the
  1580	            // sheet + immutable on `wb.formats()`).
  1581	            //
  1582	            // Phase 5.2 D-1 step 3: HashSet keys are now `FormatId`
  1583	            // (the enum) rather than `u32`. Overlay-entry lookup
  1584	            // converts `entry.id` via `legacy_from_u32` before query.
  1585	            let known_ids: std::collections::HashSet<ql_storage::FormatId> =
  1586	                wb.formats().iter().map(|(id, _)| id).collect();
  1587	            let sheet_mut = wb.sheet_mut(sheet_id).expect("just-added sheet must exist");
  1588	            for entry in overlay_entries {
  1589	                // Bounds-check to mirror the cell-record validation
  1590	                // below — out-of-range coordinates surface as
  1591	                // `MalformedFormatOverlay` rather than silently binding
  1592	                // a sentinel address.
  1593	                if entry.row > MAX_ROW || entry.col > MAX_COLUMN {
  1594	                    return Err(QbookError::MalformedFormatOverlay {
  1595	                        sheet: sheet_id,
  1596	                        row: entry.row,
  1597	                        col: entry.col,
  1598	                        why: "out-of-range row/col",
  1599	                    });
  1600	                }
  1601	                let fid = ql_storage::FormatId::legacy_from_u32(entry.id);
  1602	                if !known_ids.contains(&fid) {
  1603	                    return Err(QbookError::MalformedFormatOverlay {
  1604	                        sheet: sheet_id,
  1605	                        row: entry.row,
  1606	                        col: entry.col,
  1607	                        why: "format id not registered in FormatTable",
  1608	                    });
  1609	                }
  1610	                sheet_mut
  1611	                    .format_overlay_mut()
  1612	                    .set(entry.row, entry.col, fid);
  1613	            }
  1614	        }
  1615	

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs | sed -n '270,365p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   270	                }
   271	            }
   272	        } // end `if has_cells_to_walk`
   273	
   274	        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
   275	        // format overlay entry. MUST run AFTER the cell-walk fixes
   276	        // (RemoveStrType / OverrideErrorSigil) so their needles —
   277	        // which match on the literal `<c r="..." t="..."` prefix —
   278	        // aren't disrupted by an inserted `s="..."` attribute.
   279	        //
   280	        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
   281	        // walked `format_overlay().iter()` directly — HashMap
   282	        // iteration order, which is non-deterministic. The
   283	        // `cellxfs_roster` order (and therefore every cell's emitted
   284	        // `s="N"`) varied run-to-run. Now we sort entries by
   285	        // (FormatId, row, col) so the roster is byte-stable across
   286	        // runs and the per-cell `s="N"` values are deterministic.
   287	        let sheet_view = workbook
   288	            .sheet(sheet_id)
   289	            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
   290	        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
   291	            sheet_view.format_overlay().iter().collect();
   292	        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
   293	        // pre-step-3 `.0` field). Non-LEGACY peer ids can't yet appear
   294	        // here (step 6 will handle multi-peer xlsx export); expect()
   295	        // makes the invariant load-bearing for step 6.
   296	        overlay_entries.sort_by_key(|a| {
   297	            (
   298	                a.1.to_legacy_u32()
   299	                    .expect("pre-step-6 xlsx export sees only legacy FormatId"),
   300	                a.0 .0,
   301	                a.0 .1,
   302	            )
   303	        });
   304	
   305	        for ((row, col), fid) in overlay_entries {
   306	            let xf_index = match format_to_xf_index.get(&fid) {
   307	                Some(idx) => *idx,
   308	                None => continue, // unreachable — roster pre-populated for all FormatIds
   309	            };
   310	            fixes.push(CellFix {
   311	                cell_ref: cell_ref_a1(row, col),
   312	                kind: CellFixKind::SetStyle(xf_index),
   313	            });
   314	        }
   315	        sheet_fixes.push(fixes);
   316	    }
   317	
   318	    // Persist to disk.
   319	    umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
   320	        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;
   321	
   322	    // **W5-D-14.1 unified post-process pass:** apply workarounds for
   323	    // umya 2.2.0 bugs and limitations. Patches applied:
   324	    //
   325	    // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` (HIGH-2).
   326	    // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` (HIGH-1).
   327	    // 3. `xl/worksheets/sheet{N}.xml`: error sigil sub (HIGH-6).
   328	    // 4. `xl/styles.xml`: inject `<numFmts>` for custom format codes
   329	    //    (HIGH-5 closure — umya doesn't write the custom-format roster).
   330	    // 5. `xl/workbook.xml`: inject `<definedNames>` for workbook +
   331	    //    sheet-scoped names (HIGH-4 closure — names export side).
   332	    // 6. `xl/tables/table{N}.xml` + sheet rels + Content_Types + sheet
   333	    //    `<tableParts>`: write Quantbook tables (HIGH-3 closure).
   334	    let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
   335	    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
   336	
   337	    // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
   338	    // Phase 5.2 D-1 step 3: `is_custom()` replaces the pre-step-3
   339	    // `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter. xlsx export sees only
   340	    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
   341	    // returns Some; the expect() makes the invariant load-bearing
   342	    // for step 6 (multi-peer xlsx export).
   343	    let custom_formats: Vec<(u32, String)> = workbook
   344	        .formats()
   345	        .iter()
   346	        .filter_map(|(id, code)| {
   347	            if id.is_custom() {
   348	                Some((
   349	                    id.to_legacy_u32()
   350	                        .expect("pre-step-6 xlsx export sees only legacy FormatId"),
   351	                    code.to_string(),
   352	                ))
   353	            } else {
   354	                None
   355	            }
   356	        })
   357	        .collect();
   358	
   359	    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
   360	    // scoped + sheet-scoped names. Each is rendered as the OOXML
   361	    // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
   362	    let defined_names = collect_defined_names(workbook)?;
   363	
   364	    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
   365	    // `report.dropped_features` with names that couldn't be rendered

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs | sed -n '984,1012p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   984	    content: Vec<u8>,
   985	    cellxfs_roster: &[FormatId],
   986	) -> Result<Vec<u8>, XlsxError> {
   987	    let text = String::from_utf8(content)
   988	        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;
   989	
   990	    let count = cellxfs_roster.len() + 1;
   991	    let mut block = String::with_capacity(64 * count);
   992	    block.push_str(&format!(r#"<cellXfs count="{}">"#, count));
   993	    // Slot 0: default xf.
   994	    block.push_str(r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#);
   995	    for fid in cellxfs_roster {
   996	        block.push_str(&format!(
   997	            concat!(
   998	                r#"<xf numFmtId="{}" fontId="0" fillId="0" borderId="0" xfId="0" "#,
   999	                r#"applyNumberFormat="1"/>"#,
  1000	            ),
  1001	            // Phase 5.2 D-1 step 3: pre-step-6 xlsx export sees only
  1002	            // legacy FormatId; non-LEGACY peer ids can't yet appear.
  1003	            fid.to_legacy_u32()
  1004	                .expect("pre-step-6 xlsx export sees only legacy FormatId"),
  1005	        ));
  1006	    }
  1007	    block.push_str("</cellXfs>");
  1008	
  1009	    // Case 1: existing <cellXfs> — replace. Closing-tag form first.
  1010	    if let Some(start) = text.find("<cellXfs") {
  1011	        let after = start + "<cellXfs".len();
  1012	        if let Some(close_rel) = text[after..].find("</cellXfs>") {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/lib.rs | sed -n '250,295p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   250	        let Some(content) = package.read_part_string(part_path)? else {
   251	            continue;
   252	        };
   253	        let styled_cells = read::cell_styles_xml::parse_cell_styles_xml(&content, part_path)?;
   254	        if styled_cells.is_empty() {
   255	            continue;
   256	        }
   257	        let Some(sheet) = workbook.sheet_mut(sheet_idx as ql_types::SheetId) else {
   258	            continue;
   259	        };
   260	        for (row, col, xf_idx) in styled_cells {
   261	            // Resolve xf_idx → cellXf → numFmtId.
   262	            let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
   263	                continue;
   264	            };
   265	            if !xf.apply_number_format {
   266	                // Cell renders as General — don't populate overlay.
   267	                continue;
   268	            }
   269	            if xf.num_fmt_id == 0 {
   270	                // General format — implicit. No overlay entry.
   271	                continue;
   272	            }
   273	            // Phase 5.2 D-1 step 3: xlsx import uses the legacy
   274	            // u32 → FormatId migration helper. n <= 163 → Builtin(n);
   275	            // n >= 164 → Custom(LEGACY_PEER, n - 164). Step 6 may
   276	            // change xlsx import to allocate non-legacy peer ids
   277	            // (e.g. for collab-aware imports); pre-step-6 all xlsx
   278	            // ids land under LEGACY_PEER.
   279	            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
   280	            sheet.format_overlay_mut().set(row, col, fmt_id);
   281	        }
   282	    }
   283	
   284	    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
   285	    // (workbook-scope + sheet-scope) into the engine's `NameTable` /
   286	    // `Sheet::scoped_names`. Names whose target text doesn't match
   287	    // the simple-address subset fall back to `NamedTarget::Formula`
   288	    // (deferred to the bind-aware parser).
   289	    let _names_registered =
   290	        read::names_import::register_defined_names(&mut workbook, &workbook_props)?;
   291	
   292	    // **W5-D-14b — Phase 2b**: apply UnsupportedPolicy::Strict if any
   293	    // unsupported features were detected. Permissive mode just
   294	    // leaves the inventory in the report.
   295	    if options.unsupported_policy == UnsupportedPolicy::Strict

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs | sed -n '50,85p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    50	        // anything higher is either malformed or a hostile attempt
    51	        // to trigger the `FormatTable::register_at` arithmetic
    52	        // overflow at `format.rs:153` (`self.next_custom_id = id.0 + 1`
    53	        // panics on u32::MAX).
    54	        const MAX_PLAUSIBLE_NUMFMT_ID: u32 = u16::MAX as u32; // 65535
    55	        if entry.num_fmt_id > MAX_PLAUSIBLE_NUMFMT_ID {
    56	            return Err(XlsxError::MalformedOoxml {
    57	                part: "xl/styles.xml".to_string(),
    58	                message: format!(
    59	                    "numFmtId {} exceeds plausible ceiling {} (rejecting to \
    60	                     avoid FormatTable overflow)",
    61	                    entry.num_fmt_id, MAX_PLAUSIBLE_NUMFMT_ID
    62	                ),
    63	            });
    64	        }
    65	        // Phase 5.2 D-1 step 3: xlsx import uses legacy u32 → FormatId
    66	        // migration. Custom xlsx numFmtIds (>= 164) land under
    67	        // LEGACY_PEER per the migration contract.
    68	        let id = FormatId::legacy_from_u32(entry.num_fmt_id);
    69	        // **W5-D-14.1 (audit HIGH-8 closure):** real-world xlsx files
    70	        // from LibreOffice / Google Sheets sometimes emit
    71	        // `<numFmt numFmtId="164" formatCode="General"/>` — a
    72	        // declaration at a custom id (≥ 164) whose format string
    73	        // already exists as a built-in (id 0 = "General"). Quantbook's
    74	        // `FormatTable::register_at` rejects this with
    75	        // `StringCollision`. The Excel behavior is to accept the
    76	        // redundant declaration (the cell using `s` with `numFmtId=164`
    77	        // still renders as General). We treat collisions where the
    78	        // existing string matches as idempotent no-ops; only TRUE
    79	        // string collisions at the same id still error.
    80	        match workbook.formats_mut().register_at(id, &entry.format_code) {
    81	            Ok(()) => {
    82	                count += 1;
    83	            }
    84	            Err(ql_storage::FormatTableError::StringCollision { existing_id, .. }) => {
    85	                // The string is already registered at a DIFFERENT id

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format_overlay.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Sparse per-sheet cell-format overlay (Phase 4.5.D part 3, W5-79).
     2	//!
     3	//! Cells with a non-General format live in this overlay; cells without an
     4	//! entry render via `FormatId::GENERAL` semantics.
     5	//!
     6	//! Per design doc § 7.2: most cells have General format, so a per-cell
     7	//! `Option<FormatId>` field would cost 8 bytes × N cells, mostly None.
     8	//! The sparse map keyed by `(RowId, ColId)` costs proportional to the
     9	//! number of cells with actual custom formats — a small fraction in
    10	//! typical workbooks.
    11	//!
    12	//! **V1 design choice (W5-79):** single `HashMap<(RowId, ColId),
    13	//! FormatId>` per sheet. The design doc § 7.2 sketches a chunk-based
    14	//! shape; benchmarking decides if that's worth the structural complexity.
    15	//! For now, a flat map is correct + simple, and the per-sheet shape
    16	//! mirrors how `NameTable` lives on the workbook (a flat map that scales
    17	//! to ~50k entries without trouble).
    18	
    19	use std::collections::HashMap;
    20	
    21	use ql_types::{ColId, RowId};
    22	
    23	use crate::format::FormatId;
    24	
    25	/// Sparse per-sheet `(row, col) → FormatId` overlay.
    26	///
    27	/// Cells absent from the overlay render via `FormatId::GENERAL`.
    28	#[derive(Clone, Debug, Default)]
    29	pub struct CellFormatOverlay {
    30	    entries: HashMap<(RowId, ColId), FormatId>,
    31	}
    32	
    33	impl CellFormatOverlay {
    34	    /// Empty overlay.
    35	    pub fn new() -> Self {
    36	        Self::default()
    37	    }
    38	
    39	    /// Read the format-id at `(row, col)`. `None` ≡ render via
    40	    /// `FormatId::GENERAL`.
    41	    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId> {
    42	        self.entries.get(&(row, col)).copied()
    43	    }
    44	
    45	    /// Set the format-id at `(row, col)`. Returns the prior id at that
    46	    /// cell, if any.
    47	    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId) -> Option<FormatId> {
    48	        self.entries.insert((row, col), id)
    49	    }
    50	
    51	    /// Clear the entry at `(row, col)`. Cell falls back to
    52	    /// `FormatId::GENERAL`. Returns the cleared id, if any.
    53	    pub fn clear(&mut self, row: RowId, col: ColId) -> Option<FormatId> {
    54	        self.entries.remove(&(row, col))
    55	    }
    56	
    57	    /// Number of entries currently in the overlay.
    58	    pub fn len(&self) -> usize {
    59	        self.entries.len()
    60	    }
    61	
    62	    /// True iff no cells carry a custom format.
    63	    pub fn is_empty(&self) -> bool {
    64	        self.entries.is_empty()
    65	    }
    66	
    67	    /// Wipe the entire overlay.
    68	    pub fn clear_all(&mut self) {
    69	        self.entries.clear();
    70	    }
    71	
    72	    /// Iterate `((row, col), FormatId)` entries. Order is `HashMap`
    73	    /// iteration order; persistence consumers should sort.
    74	    pub fn iter(&self) -> impl Iterator<Item = ((RowId, ColId), FormatId)> + '_ {
    75	        self.entries.iter().map(|(addr, id)| (*addr, *id))
    76	    }
    77	
    78	    /// Count entries that reference `id`. Used by FormatTable compaction
    79	    /// (Phase 4.10 / GAP-F-07) to decide if an id has zero refs and can
    80	    /// be reclaimed.
    81	    pub fn count_refs(&self, id: FormatId) -> usize {
    82	        self.entries.values().filter(|fid| **fid == id).count()
    83	    }
    84	}
    85	
    86	#[cfg(test)]
    87	mod tests {
    88	    use super::*;
    89	
    90	    #[test]
    91	    fn default_is_empty() {
    92	        let o = CellFormatOverlay::new();
    93	        assert!(o.is_empty());
    94	        assert_eq!(o.len(), 0);
    95	    }
    96	
    97	    #[test]
    98	    fn get_miss_returns_none() {
    99	        let o = CellFormatOverlay::new();
   100	        assert_eq!(o.get(0, 0), None);
   101	    }
   102	
   103	    #[test]
   104	    fn set_then_get() {
   105	        let mut o = CellFormatOverlay::new();
   106	        let id = FormatId::Builtin(14);
   107	        assert_eq!(o.set(5, 3, id), None);
   108	        assert_eq!(o.get(5, 3), Some(id));
   109	    }
   110	
   111	    #[test]
   112	    fn set_overwrites_and_returns_prior() {
   113	        let mut o = CellFormatOverlay::new();
   114	        assert_eq!(o.set(5, 3, FormatId::Builtin(14)), None);
   115	        assert_eq!(
   116	            o.set(5, 3, FormatId::Builtin(15)),
   117	            Some(FormatId::Builtin(14))
   118	        );
   119	        assert_eq!(o.get(5, 3), Some(FormatId::Builtin(15)));
   120	    }
   121	
   122	    #[test]
   123	    fn clear_removes_entry() {
   124	        let mut o = CellFormatOverlay::new();
   125	        o.set(5, 3, FormatId::Builtin(14));
   126	        assert_eq!(o.clear(5, 3), Some(FormatId::Builtin(14)));
   127	        assert_eq!(o.get(5, 3), None);
   128	    }
   129	
   130	    #[test]
   131	    fn clear_missing_returns_none() {
   132	        let mut o = CellFormatOverlay::new();
   133	        assert_eq!(o.clear(999, 999), None);
   134	    }
   135	
   136	    #[test]
   137	    fn clear_all_wipes_overlay() {
   138	        let mut o = CellFormatOverlay::new();
   139	        o.set(0, 0, FormatId::Builtin(14));
   140	        o.set(1, 1, FormatId::Builtin(15));
   141	        o.clear_all();
   142	        assert!(o.is_empty());
   143	    }
   144	
   145	    #[test]
   146	    fn count_refs_returns_match_count() {
   147	        let mut o = CellFormatOverlay::new();
   148	        o.set(0, 0, FormatId::Builtin(14));
   149	        o.set(0, 1, FormatId::Builtin(14));
   150	        o.set(0, 2, FormatId::Builtin(15));
   151	        assert_eq!(o.count_refs(FormatId::Builtin(14)), 2);
   152	        assert_eq!(o.count_refs(FormatId::Builtin(15)), 1);
   153	        // 999 maps to Custom(LEGACY_PEER, 835) under the new shape;
   154	        // never registered, so count is 0.
   155	        assert_eq!(o.count_refs(FormatId::legacy_from_u32(999)), 0);
   156	    }
   157	
   158	    #[test]
   159	    fn iter_returns_all_entries() {
   160	        let mut o = CellFormatOverlay::new();
   161	        o.set(0, 0, FormatId::Builtin(14));
   162	        o.set(1, 1, FormatId::Builtin(15));
   163	        let collected: Vec<_> = o.iter().collect();
   164	        assert_eq!(collected.len(), 2);
   165	    }
   166	
   167	    #[test]
   168	    fn distinct_addresses_isolated() {
   169	        let mut o = CellFormatOverlay::new();
   170	        o.set(0, 0, FormatId::Builtin(14));
   171	        o.set(0, 1, FormatId::Builtin(15));
   172	        o.set(1, 0, FormatId::Builtin(16));
   173	        assert_eq!(o.get(0, 0), Some(FormatId::Builtin(14)));
   174	        assert_eq!(o.get(0, 1), Some(FormatId::Builtin(15)));
   175	        assert_eq!(o.get(1, 0), Some(FormatId::Builtin(16)));
   176	        assert_eq!(o.get(1, 1), None);
   177	    }
   178	}

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/lib.rs | sed -n '1,120p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `ql-storage` — Workbook, Sheet, ColumnStore, SparseOverlay.
     2	//!
     3	//! Per spec Part V §4 Week 2 Days 3-4. Phase 0 minimum, with Phase 2A
     4	//! extensions to `Workbook`:
     5	//! - [`workbook`] — top-level `Workbook` + `NameTable` (real HashMap-backed
     6	//!   storage since Phase 2A.1; canonicalizing-on-write since Phase 2A.6).
     7	//! - [`sheet`] — per-sheet `Sheet` + conservative `Bounds` tracking.
     8	//! - [`column`] — `ColumnStore`: chunked Arrow base + per-chunk sparse overlay; default
     9	//!   chunk size 16,384 rows (`QBOOK_CHUNK_ROWS` env override).
    10	//! - [`overlay`] — `SparseOverlay`: per-chunk `BTreeMap<RowId, Value>`; overlay-first reads.
    11	//!
    12	//! Design locks (from spec): chunk-replace, not cell-mutate. Result columns from recompute
    13	//! swap whole chunks via `ColumnStore::replace_chunk`; cell-level writes go through the
    14	//! overlay (`ColumnStore::put`) and are never applied to the base array directly.
    15	//!
    16	//! # Stability
    17	//!
    18	//! Pre-0.2.0 the public API surface is in flux. Error enums carry
    19	//! `#[non_exhaustive]` (`FormatTableError`, `NameTableError`,
    20	//! `SheetNameError`, `SpillBlockError`) — downstream consumers must
    21	//! include a `_` arm when matching across crate boundaries. Data
    22	//! enums (`NamedTarget`, `TotalsFunction`) are exhaustive by design;
    23	//! variant additions are MAJOR-version events because every
    24	//! dispatcher (wire-format, replay, runtime) must gain a new arm.
    25	
    26	pub mod column;
    27	pub mod format;
    28	pub mod format_overlay;
    29	pub mod overlay;
    30	pub mod sheet;
    31	pub mod spill;
    32	pub mod tables;
    33	pub mod workbook;
    34	
    35	pub use column::{chunk_rows_from_env, ColumnStore, DEFAULT_CHUNK_ROWS};
    36	pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
    37	pub use format_overlay::CellFormatOverlay;
    38	pub use overlay::SparseOverlay;
    39	pub use sheet::{Bounds, Sheet};
    40	pub use spill::{SpillAnchorTable, SpillBlockError, SpillNotFoundError, SpillShape};
    41	pub use tables::{TableColumn, TableMetadata, TableTable, TotalsFunction};
    42	pub use workbook::{NameTable, NameTableError, NamedTarget, SheetNameError, Workbook};
    43	
    44	#[cfg(test)]
    45	mod tests {
    46	    use super::*;
    47	    use ql_types::{Address, Value};
    48	
    49	    #[test]
    50	    fn end_to_end_minimum_workbook_read_write() {
    51	        // The smallest E2E that touches every module: workbook → sheet → column → overlay.
    52	        let mut wb = Workbook::new();
    53	        let s = wb.add_sheet_with_chunk_rows("Sheet1", 16);
    54	        wb.put(Address::new(s, 0, 0), Value::Number(42.0));
    55	        assert_eq!(wb.read(Address::new(s, 0, 0)), Value::Number(42.0));
    56	        // Confirms re-exports compile + integration is wired.
    57	        let _: SparseOverlay = SparseOverlay::new();
    58	        let _: ColumnStore = ColumnStore::new();
    59	        let _: Sheet = Sheet::new("t");
    60	        let _: NameTable = NameTable::new();
    61	        let _: Bounds = Bounds::default();
    62	    }
    63	
    64	    // ===== W5-79 / Phase 4.5.D part 3 — FormatTable + overlay integration =====
    65	
    66	    #[test]
    67	    fn workbook_default_has_format_table_with_builtins() {
    68	        let wb = Workbook::new();
    69	        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
    70	        assert_eq!(wb.formats().lookup(FormatId::Builtin(14)), Some("m/d/yyyy"));
    71	    }
    72	
    73	    #[test]
    74	    fn workbook_intern_returns_existing_builtin_id() {
    75	        let mut wb = Workbook::new();
    76	        let id = wb.formats_mut().intern("0.00");
    77	        assert_eq!(id, FormatId::Builtin(2));
    78	    }
    79	
    80	    #[test]
    81	    fn workbook_intern_new_string_allocates_custom_id() {
    82	        let mut wb = Workbook::new();
    83	        let id = wb.formats_mut().intern("\"⚓\" #,##0");
    84	        // Step 3: first custom = Custom(LEGACY_PEER, 0); legacy u32 = 164.
    85	        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
    86	    }
    87	
    88	    #[test]
    89	    fn sheet_format_overlay_starts_empty() {
    90	        let s = Sheet::new("Sheet1");
    91	        assert!(s.format_overlay().is_empty());
    92	    }
    93	
    94	    #[test]
    95	    fn sheet_format_overlay_set_and_clear_round_trip() {
    96	        let mut s = Sheet::new("Sheet1");
    97	        s.format_overlay_mut().set(3, 5, FormatId::Builtin(14));
    98	        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId::Builtin(14)));
    99	        s.format_overlay_mut().clear(3, 5);
   100	        assert!(s.format_overlay().get(3, 5).is_none());
   101	    }
   102	
   103	    #[test]
   104	    fn workbook_independent_sheets_have_independent_overlays() {
   105	        let mut wb = Workbook::new();
   106	        let s0 = wb.add_sheet_with_chunk_rows("A", 16);
   107	        let s1 = wb.add_sheet_with_chunk_rows("B", 16);
   108	        // Compose: set a format on A:(0,0) via the table + overlay APIs.
   109	        let id = wb.formats_mut().intern("yyyy-mm-dd");
   110	        wb.sheet_mut(s0).unwrap().format_overlay_mut().set(0, 0, id);
   111	        // Sheet B should not see the entry.
   112	        assert_eq!(wb.sheet(s0).unwrap().format_overlay().get(0, 0), Some(id));
   113	        assert_eq!(wb.sheet(s1).unwrap().format_overlay().get(0, 0), None);
   114	        // FormatTable lookup resolves back to the source string.
   115	        assert_eq!(wb.formats().lookup(id), Some("yyyy-mm-dd"));
   116	    }
   117	}

exec
/bin/zsh -lc "rg -n \"with_peer\\(|set_local_peer\\(|local_peer\\(\\)\" quantbook-engine/crates --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/format.rs:209:        Self::with_peer(LEGACY_PEER)
quantbook-engine/crates/ql-storage/src/format.rs:225:    pub fn with_peer(peer: PeerId) -> Self {
quantbook-engine/crates/ql-storage/src/format.rs:254:    pub fn set_local_peer(&mut self, peer: PeerId) {
quantbook-engine/crates/ql-storage/src/format.rs:349:    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
quantbook-engine/crates/ql-storage/src/format.rs:410:    fn intern_new_allocates_custom_id_for_local_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:439:        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
quantbook-engine/crates/ql-storage/src/format.rs:440:        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
quantbook-engine/crates/ql-storage/src/format.rs:471:        let mut t = FormatTable::with_peer(PeerId::new(7));
quantbook-engine/crates/ql-storage/src/format.rs:483:        let mut t = FormatTable::with_peer(PeerId::new(7));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:59:        let id = FormatId::Custom(formats.local_peer(), formats.next_custom_counter());

exec
/bin/zsh -lc "rg -n \"id\\.0["'^0-9_a-z]" quantbook-engine/crates --type rust' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-io/src/qbook_format.rs:1189:            // pre-step-3 `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:52:        // overflow at `format.rs:153` (`self.next_custom_id = id.0 + 1`
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:264:        // Step 3: `is_custom()` replaces the pre-step-3 `id.0 >= 164` filter.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1254:    // `next_custom_id = id.0 + 1` overflow.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:339:    // `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter. xlsx export sees only

exec
/bin/zsh -lc "rg -n \"FormatId\\(\" quantbook-engine/crates --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/wire.rs:300:    /// Pre-5.2 encoding: `FormatId` was `pub struct FormatId(pub u32)`.
quantbook-engine/crates/ql-storage/src/format.rs:12://! `FormatId` changed from `pub struct FormatId(pub u32)` to a tagged
quantbook-engine/crates/ql-storage/src/format.rs:91:    /// Pre-5.2 encoding: `FormatId(pub u32)`. Values `0..=163` are
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:162:    // has FormatId(164). On EXPORT, the umya post-process emits
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:12://! `FormatId(N)` directly without re-allocating ids.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:131:    UnknownFormatId(ql_storage::FormatId),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:98:                return Err(RuntimeError::UnknownFormatId(fid));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:324:            RuntimeError::UnknownFormatId(fid) if fid == bad_id

exec
/bin/zsh -lc "rg -n \"FormatId::Builtin\\((16[4-9]|1[7-9][0-9]|[2-9][0-9]{2,}|[1-9][0-9]{3,})\\)\" quantbook-engine/crates --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/format.rs:462:        t.register_at(FormatId::Builtin(200), "REPLAY").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:463:        assert_eq!(t.lookup(FormatId::Builtin(200)), Some("REPLAY"));
quantbook-engine/crates/ql-storage/src/format.rs:515:            .register_at(FormatId::Builtin(200), "General")

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
    19	//! resulting blob includes the full state plus history; suitable for
    20	//! `oplog.bin` on-disk persistence (Phase 2A.3.c).
    21	//!
    22	//! `import_bytes` reconstructs an `OpLog` from such a blob. The reader
    23	//! probes the `"ops"` LoroList; if absent (or the wrong shape), the
    24	//! import returns `OpLogError::SchemaMismatch`.
    25	
    26	use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
    27	
    28	use crate::error::OpLogError;
    29	use crate::op::Op;
    30	
    31	/// The Loro container name our ops live under. Hard-coded; Phase 5+
    32	/// CRDT-level refactoring may add more containers (versions, peer state,
    33	/// etc.) but `"ops"` is reserved.
    34	const OPS_CONTAINER: &str = "ops";
    35	
    36	/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
    37	/// ephemeral presence map (cursor + selection + typing indicator).
    38	/// Per the audit-closed Phase 5.1 design at
    39	/// `docs/architecture/crdt-data-model.md` § Presence container.
    40	/// Keys are peer-id strings; values are opaque JSON blobs (the
    41	/// typed `PresenceState` encoding lives in `ql_collab::presence`).
    42	const PRESENCE_CONTAINER: &str = "presence";
    43	
    44	/// **Phase 5.4 V1 (2026-05-19):** commit-origin tag for presence
    45	/// writes. `ql_collab::CollabSession` wires this to Loro's
    46	/// `UndoManager::add_exclude_origin_prefix` so cursor movements
    47	/// don't pollute the undo stack. Exported as `pub` so the higher-
    48	/// layer (ql-collab) can reference the same string constant.
    49	///
    50	/// **Reserved-namespace convention:** trailing `":"` so the prefix
    51	/// `presence:` only matches deliberately-namespaced origins (e.g.
    52	/// a future `presence:typing` would also be excluded; an
    53	/// independent `"presence-foo"` origin would NOT). This protects
    54	/// against accidental over-exclusion as more origins land
    55	/// (Codex+Opus 5.4 V1 audit findings A4/M5).
    56	pub const PRESENCE_COMMIT_ORIGIN: &str = "presence:";
    57	
    58	/// Append-only operation log backed by Loro.
    59	///
    60	/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
    61	/// to reconstruct from a persisted snapshot. Mutations go through `append`;
    62	/// reads through `iter` / `len` / `is_empty`.
    63	pub struct OpLog {
    64	    doc: LoroDoc,
    65	}
    66	
    67	impl std::fmt::Debug for OpLog {
    68	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    69	        f.debug_struct("OpLog")
    70	            .field("len", &self.len())
    71	            .field("doc", &"<LoroDoc>")
    72	            .finish()
    73	    }
    74	}
    75	
    76	impl Default for OpLog {
    77	    fn default() -> Self {
    78	        Self::new()
    79	    }
    80	}
    81	
    82	impl OpLog {
    83	    /// Construct an empty log.
    84	    pub fn new() -> Self {
    85	        Self {
    86	            doc: LoroDoc::new(),
    87	        }
    88	    }
    89	
    90	    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    91	    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    92	    /// underlying Loro doc.
    93	    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
    94	        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
    95	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
    96	        list.push(LoroValue::from(json.as_str()))?;
    97	        self.doc.commit();
    98	        Ok(())
    99	    }
   100	
   101	    /// Iterate the log in append order. Each yielded item is a
   102	    /// `Result<Op, OpLogError>` — a deserialization failure yields
   103	    /// `Err(OpLogError::Deserialize { index, source })` and iteration
   104	    /// continues (no short-circuit). Callers wanting fail-fast can use
   105	    /// `iter().collect::<Result<Vec<_>, _>>()`.
   106	    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
   107	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   108	        let len = list.len();
   109	        (0..len).map(move |index| {
   110	            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
   111	                "ops LoroList lost an entry between len() and get()",
   112	            ))?;
   113	            let value = match entry {
   114	                ValueOrContainer::Value(v) => v,
   115	                ValueOrContainer::Container(_) => {
   116	                    return Err(OpLogError::SchemaMismatch(
   117	                        "ops LoroList holds a container; expected JSON-string values",
   118	                    ));
   119	                }
   120	            };
   121	            let s = match value {
   122	                LoroValue::String(s) => s,
   123	                _ => {
   124	                    return Err(OpLogError::SchemaMismatch(
   125	                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
   126	                    ));
   127	                }
   128	            };
   129	            serde_json::from_str::<Op>(&s)
   130	                .map_err(|source| OpLogError::Deserialize { index, source })
   131	        })
   132	    }
   133	
   134	    /// Number of ops currently visible in the `"ops"` LoroList.
   135	    ///
   136	    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
   137	    /// (was a cached `usize` field through 5.6). Codex 5.4 V1 audit
   138	    /// HIGH found the cache became stale after `loro::UndoManager`
   139	    /// retracted ops from the visible list. Returning Loro's
   140	    /// authoritative count is correct by construction; per-call
   141	    /// cost is one container handle lookup + a length read.
   142	    pub fn len(&self) -> usize {
   143	        self.doc.get_list(OPS_CONTAINER).len()
   144	    }
   145	
   146	    /// True iff `len() == 0`.
   147	    pub fn is_empty(&self) -> bool {
   148	        self.len() == 0
   149	    }
   150	
   151	    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
   152	    ///
   153	    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
   154	    /// to wire its stable `PeerId` through to Loro so concurrent
   155	    /// appends carry the right origin in the CRDT merge metadata.
   156	    ///
   157	    /// Loro takes `&self` (interior mutability), so this method is
   158	    /// `&self` too. Calling it twice with the same id leaves the
   159	    /// peer id unchanged but is NOT a strict no-op at Loro's
   160	    /// internal layer: Loro re-stores the atom and emits a
   161	    /// `peer_id_change_subs` notification each call. Avoid calling
   162	    /// repeatedly in hot paths.
   163	    ///
   164	    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
   165	    /// 1. NEVER reuse the same peer id across concurrent writers
   166	    ///    (multiple tabs / devices for the same user). Duplicate peer
   167	    ///    ids corrupt the document via conflicting OpIDs.
   168	    /// 2. Avoid pinning a peer id to a stable user/device identity
   169	    ///    unless you also enforce single-ownership locking. Prefer a
   170	    ///    per-process-random peer id.
   171	    /// 3. Setting peer id AFTER an import is safe — existing imported
   172	    ///    ops retain their original peer ids; only this log's future
   173	    ///    appends use the new id.
   174	    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
   175	    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
   176	    /// 5. **Phase 5.4 V1 (2026-05-19):** if a `loro::UndoManager`
   177	    ///    (constructed via [`new_undo_manager`]) is alive, Loro
   178	    ///    SILENTLY CLEARS its undo + redo stacks on the peer-id
   179	    ///    change (`loro-internal::undo:654-662`). Callers must
   180	    ///    treat post-construction peer-id changes as undo-stack-
   181	    ///    invalidating events.
   182	    ///
   183	    /// Signature note: `&mut self` (Phase 5.4 V1 audit closure)
   184	    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
   185	    /// `&mut` prevents accidental peer-id changes through a shared
   186	    /// `&OpLog` (`CollabSession::op_log()`) which would silently
   187	    /// clear an attached `UndoManager`'s stacks per pitfall 5.
   188	    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
   189	        self.doc.set_peer_id(peer)?;
   190	        Ok(())
   191	    }
   192	
   193	    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
   194	    pub fn peer_id(&self) -> u64 {
   195	        self.doc.peer_id()
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
   207	    /// `peer_key` from any peer (including the same peer in a different
   208	    /// session) replaces the previous value at merge time. Concurrent
   209	    /// `presence_set` calls for DIFFERENT `peer_key`s are independent
   210	    /// and both survive merge.
   211	    ///
   212	    /// Triggers `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so
   213	    /// the write is durable through `export_bytes` / `merge_bytes`
   214	    /// immediately AND is excluded from `UndoManager` (Phase 5.4
   215	    /// V1 wires `add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`).
   216	    pub fn presence_set(&mut self, peer_key: &str, json: &str) -> Result<(), OpLogError> {
   217	        let map = self.doc.get_map(PRESENCE_CONTAINER);
   218	        map.insert(peer_key, LoroValue::from(json))?;
   219	        self.doc
   220	            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));

exec
/bin/zsh -lc 'rg -n "set_peer_id|peer_id|PeerId|LEGACY_PEER|CollabSession|FormatTable" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-exec quantbook-engine/crates/ql-storage --type rust' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:111:    /// `FormatTable::register_at` refused the registration — the id is
quantbook-engine/crates/ql-oplog/src/replay.rs:245:/// Wrapper around `ql_storage::FormatTableError` that owns its strings,
quantbook-engine/crates/ql-oplog/src/replay.rs:272:impl From<ql_storage::FormatTableError> for FormatRejectedSource {
quantbook-engine/crates/ql-oplog/src/replay.rs:273:    fn from(e: ql_storage::FormatTableError) -> Self {
quantbook-engine/crates/ql-oplog/src/replay.rs:275:            ql_storage::FormatTableError::IdCollision {
quantbook-engine/crates/ql-oplog/src/replay.rs:284:            ql_storage::FormatTableError::StringCollision {
quantbook-engine/crates/ql-oplog/src/replay.rs:294:                "FormatTableError gained a variant — extend FormatRejectedSource::From"
quantbook-engine/crates/ql-oplog/src/replay.rs:503:            // **W5-80:** route through `FormatTable::register_at` so
quantbook-engine/crates/ql-oplog/src/replay.rs:511:            // ALL went through the LEGACY_PEER path so this conversion
quantbook-engine/crates/ql-oplog/src/replay.rs:1369:            // through legacy_from_u32 → Custom(LEGACY_PEER, 200-164=36).
quantbook-engine/crates/ql-oplog/src/replay.rs:1446:            // Step 3: Op id=200 → Custom(LEGACY_PEER, 36) via legacy_from_u32.
quantbook-engine/crates/ql-storage/src/format_overlay.rs:78:    /// Count entries that reference `id`. Used by FormatTable compaction
quantbook-engine/crates/ql-storage/src/format_overlay.rs:153:        // 999 maps to Custom(LEGACY_PEER, 835) under the new shape;
quantbook-engine/crates/ql-oplog/src/op.rs:17://! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
quantbook-engine/crates/ql-oplog/src/op.rs:115:    /// `FormatTable::register_at`. Emitted when
quantbook-engine/crates/ql-oplog/src/op.rs:119:    /// string fails at `FormatTable::register_at` and surfaces as
quantbook-engine/crates/ql-oplog/src/op.rs:126:    /// `FormatTable` at replay time; an unknown id surfaces as
quantbook-engine/crates/ql-storage/src/workbook.rs:312:    formats: crate::FormatTable,
quantbook-engine/crates/ql-storage/src/workbook.rs:407:    pub fn formats(&self) -> &crate::FormatTable {
quantbook-engine/crates/ql-storage/src/workbook.rs:415:    pub fn formats_mut(&mut self) -> &mut crate::FormatTable {
quantbook-engine/crates/ql-oplog/src/wire.rs:37:use ql_types::{Address, ErrorValue, PeerId, Range, Value, LEGACY_PEER, MAX_COLUMN, MAX_ROW};
quantbook-engine/crates/ql-oplog/src/wire.rs:269:/// (`PeerId` is `#[serde(transparent)]`).
quantbook-engine/crates/ql-oplog/src/wire.rs:285:    Custom { peer: PeerId, counter: u32 },
quantbook-engine/crates/ql-oplog/src/wire.rs:308:    /// - `n >= 164` → `Custom { peer: LEGACY_PEER, counter: n - 164 }`.
quantbook-engine/crates/ql-oplog/src/wire.rs:310:    /// `LEGACY_PEER = PeerId(0)` is the sentinel for "this custom id
quantbook-engine/crates/ql-oplog/src/wire.rs:320:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:367:    //!   in step 3's `FormatTable`).
quantbook-engine/crates/ql-oplog/src/wire.rs:383:            peer: PeerId::new(42),
quantbook-engine/crates/ql-oplog/src/wire.rs:417:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:429:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:438:        // Custom(LEGACY_PEER, 0) (legacy-mapped from u32=164) are NOT
quantbook-engine/crates/ql-oplog/src/wire.rs:445:            peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:462:            peer: PeerId::new(1),
quantbook-engine/crates/ql-oplog/src/wire.rs:466:            peer: PeerId::new(2),
quantbook-engine/crates/ql-oplog/src/wire.rs:482:        // PeerId + counter values without overflow or truncation.
quantbook-engine/crates/ql-oplog/src/wire.rs:484:            peer: PeerId::new(0xdead_beef_cafe_babe),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:11://!   in the workbook's `FormatTable` and emit `Op::RegisterFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:30:    /// the workbook's `FormatTable` and emit `Op::RegisterFormat` to the
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:52:        // Phase 5.2 D-1 step 3: FormatTable now allocates under its
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:55:        // `to_legacy_u32`. At step 3 all FormatTables default to
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:56:        // LEGACY_PEER so the conversion always succeeds; the
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:63:                    "pre-step-4 FormatTable peer must be LEGACY_PEER so Op u32 is expressible",
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:71:            "FormatTable::intern allocated a different id than next_custom_counter predicted"
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:144:    /// `FormatTable` (corrupted state — should not happen in practice
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:151:    /// `read_display` for that id. `FormatTable::register_at` rejects
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:170:        // Cache lookup. Vacant → resolve via FormatTable + parse + insert.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:215:            // "General" is built-in id 0; pre-populated by FormatTable::default().
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:235:            // Step 3: first custom under LEGACY_PEER, counter=0.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:238:            assert_eq!(id, FormatId::Custom(ql_types::LEGACY_PEER, 0));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:321:        // legacy_from_u32(9999) = Custom(LEGACY_PEER, 9999 - 164) = 9835.
quantbook-engine/crates/ql-oplog/src/lib.rs:50:// Phase 5.2 D-1 step 1.1 (2026-05-19) — re-export `ql_types::PeerId`
quantbook-engine/crates/ql-oplog/src/lib.rs:51:// for ergonomics. PeerId lived briefly at `ql_oplog::PeerId` in step 1
quantbook-engine/crates/ql-oplog/src/lib.rs:53:// cycle: `ql_storage::FormatId::Custom(PeerId, _)` (step 3) cannot
quantbook-engine/crates/ql-oplog/src/lib.rs:55:// depends on `ql-storage`. PeerId moved to `ql_types` (the true
quantbook-engine/crates/ql-oplog/src/lib.rs:57:// like `ql_collab::CollabSession` (which already imports from
quantbook-engine/crates/ql-oplog/src/lib.rs:59:pub use ql_types::PeerId;
quantbook-engine/crates/ql-storage/src/lib.rs:19://! `#[non_exhaustive]` (`FormatTableError`, `NameTableError`,
quantbook-engine/crates/ql-storage/src/lib.rs:36:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-storage/src/lib.rs:64:    // ===== W5-79 / Phase 4.5.D part 3 — FormatTable + overlay integration =====
quantbook-engine/crates/ql-storage/src/lib.rs:84:        // Step 3: first custom = Custom(LEGACY_PEER, 0); legacy u32 = 164.
quantbook-engine/crates/ql-storage/src/lib.rs:114:        // FormatTable lookup resolves back to the source string.
quantbook-engine/crates/ql-oplog/src/log.rs:45:/// writes. `ql_collab::CollabSession` wires this to Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:153:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:154:    /// to wire its stable `PeerId` through to Loro so concurrent
quantbook-engine/crates/ql-oplog/src/log.rs:161:    /// `peer_id_change_subs` notification each call. Avoid calling
quantbook-engine/crates/ql-oplog/src/log.rs:164:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
quantbook-engine/crates/ql-oplog/src/log.rs:184:    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
quantbook-engine/crates/ql-oplog/src/log.rs:186:    /// `&OpLog` (`CollabSession::op_log()`) which would silently
quantbook-engine/crates/ql-oplog/src/log.rs:188:    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:189:        self.doc.set_peer_id(peer)?;
quantbook-engine/crates/ql-oplog/src/log.rs:193:    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
quantbook-engine/crates/ql-oplog/src/log.rs:194:    pub fn peer_id(&self) -> u64 {
quantbook-engine/crates/ql-oplog/src/log.rs:195:        self.doc.peer_id()
quantbook-engine/crates/ql-oplog/src/log.rs:202:    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
quantbook-engine/crates/ql-oplog/src/log.rs:271:    /// - "keep the `peer_id` stable while an `UndoManager` is in
quantbook-engine/crates/ql-oplog/src/log.rs:274:    /// Callers MUST construct the manager AFTER `set_peer_id` and
quantbook-engine/crates/ql-oplog/src/log.rs:282:    /// after construction. The `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:467:    fn set_peer_id_changes_doc_peer_id() {
quantbook-engine/crates/ql-oplog/src/log.rs:469:        let before = log.peer_id();
quantbook-engine/crates/ql-oplog/src/log.rs:470:        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:471:        assert_eq!(log.peer_id(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-oplog/src/log.rs:472:        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
quantbook-engine/crates/ql-oplog/src/log.rs:476:    fn set_peer_id_after_import_works() {
quantbook-engine/crates/ql-oplog/src/log.rs:479:        origin.set_peer_id(11).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:489:        reborn.set_peer_id(22).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:490:        assert_eq!(reborn.peer_id(), 22);
quantbook-engine/crates/ql-oplog/src/log.rs:498:        assert_eq!(reborn.peer_id(), 22);
quantbook-engine/crates/ql-oplog/src/log.rs:560:        base.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:564:        peer_a.set_peer_id(10).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:570:        peer_b.set_peer_id(20).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:578:        // Exactly one value survives — LWW by (lamport, peer_id).
quantbook-engine/crates/ql-oplog/src/log.rs:610:    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
quantbook-engine/crates/ql-oplog/src/log.rs:615:        let result = log.set_peer_id(u64::MAX);
quantbook-engine/crates/ql-storage/src/format.rs:4://! `FormatTable` reserves Excel built-in format IDs 0-163 (`Builtin`
quantbook-engine/crates/ql-storage/src/format.rs:18://!     Custom(PeerId, u32),           // peer-allocated, per-peer counter
quantbook-engine/crates/ql-storage/src/format.rs:22://! `FormatTable` carries a `local_peer: PeerId` (set at construction)
quantbook-engine/crates/ql-storage/src/format.rs:23://! used by [`FormatTable::intern`] when allocating new custom ids.
quantbook-engine/crates/ql-storage/src/format.rs:24://! Single-writer / pre-collab callers use [`LEGACY_PEER`] as the
quantbook-engine/crates/ql-storage/src/format.rs:25://! `local_peer`. Multi-peer sessions set their own `PeerId` at attach
quantbook-engine/crates/ql-storage/src/format.rs:42:use ql_types::{PeerId, LEGACY_PEER};
quantbook-engine/crates/ql-storage/src/format.rs:49:/// - `Custom(PeerId, u32)` — peer-allocated. Each peer's allocator
quantbook-engine/crates/ql-storage/src/format.rs:51:///   because the `PeerId` differs (Phase 5.1 audit-locked decision
quantbook-engine/crates/ql-storage/src/format.rs:65:    Custom(PeerId, u32),
quantbook-engine/crates/ql-storage/src/format.rs:97:    /// - `n >= 164` → `Custom(LEGACY_PEER, n - 164)`.
quantbook-engine/crates/ql-storage/src/format.rs:109:            FormatId::Custom(LEGACY_PEER, n - FIRST_CUSTOM_FORMAT_ID)
quantbook-engine/crates/ql-storage/src/format.rs:117:    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
quantbook-engine/crates/ql-storage/src/format.rs:120:    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
quantbook-engine/crates/ql-storage/src/format.rs:126:            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
quantbook-engine/crates/ql-storage/src/format.rs:182:/// Phase 5.2 D-1 step 3: `FormatTable` now carries a `local_peer`
quantbook-engine/crates/ql-storage/src/format.rs:183:/// (`PeerId`) used when allocating new `Custom` format ids in
quantbook-engine/crates/ql-storage/src/format.rs:185:/// `FormatTable::new()`) uses [`LEGACY_PEER`]; multi-peer
quantbook-engine/crates/ql-storage/src/format.rs:186:/// `CollabSession` callers re-construct with their session's peer
quantbook-engine/crates/ql-storage/src/format.rs:189:pub struct FormatTable {
quantbook-engine/crates/ql-storage/src/format.rs:196:    /// the `PeerId` differs. Starts at `0` (post-5.2; pre-5.2 used
quantbook-engine/crates/ql-storage/src/format.rs:200:    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
quantbook-engine/crates/ql-storage/src/format.rs:202:    /// `CollabSession::attach` (step 4) updates this via
quantbook-engine/crates/ql-storage/src/format.rs:204:    local_peer: PeerId,
quantbook-engine/crates/ql-storage/src/format.rs:207:impl Default for FormatTable {
quantbook-engine/crates/ql-storage/src/format.rs:209:        Self::with_peer(LEGACY_PEER)
quantbook-engine/crates/ql-storage/src/format.rs:213:impl FormatTable {
quantbook-engine/crates/ql-storage/src/format.rs:215:    /// Custom ids allocated by this instance carry [`LEGACY_PEER`] —
quantbook-engine/crates/ql-storage/src/format.rs:225:    pub fn with_peer(peer: PeerId) -> Self {
quantbook-engine/crates/ql-storage/src/format.rs:243:    pub fn local_peer(&self) -> PeerId {
quantbook-engine/crates/ql-storage/src/format.rs:251:    /// Step 4 will call this from `CollabSession::attach` when a
quantbook-engine/crates/ql-storage/src/format.rs:253:    /// `LEGACY_PEER`-tagged construction.
quantbook-engine/crates/ql-storage/src/format.rs:254:    pub fn set_local_peer(&mut self, peer: PeerId) {
quantbook-engine/crates/ql-storage/src/format.rs:297:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/crates/ql-storage/src/format.rs:302:            return Err(FormatTableError::IdCollision {
quantbook-engine/crates/ql-storage/src/format.rs:312:            return Err(FormatTableError::StringCollision {
quantbook-engine/crates/ql-storage/src/format.rs:365:pub enum FormatTableError {
quantbook-engine/crates/ql-storage/src/format.rs:386:        let t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:395:        let t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:401:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:411:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:414:        // FormatTable uses LEGACY_PEER; counter starts at 0.
quantbook-engine/crates/ql-storage/src/format.rs:415:        assert_eq!(id, FormatId::Custom(LEGACY_PEER, 0));
quantbook-engine/crates/ql-storage/src/format.rs:423:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:428:                assert_eq!(pa, pb, "same FormatTable allocates under same peer");
quantbook-engine/crates/ql-storage/src/format.rs:439:        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
quantbook-engine/crates/ql-storage/src/format.rs:440:        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
quantbook-engine/crates/ql-storage/src/format.rs:445:        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
quantbook-engine/crates/ql-storage/src/format.rs:446:        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
quantbook-engine/crates/ql-storage/src/format.rs:451:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:459:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:471:        let mut t = FormatTable::with_peer(PeerId::new(7));
quantbook-engine/crates/ql-storage/src/format.rs:472:        t.register_at(FormatId::Custom(PeerId::new(7), 5), "REPLAY")
quantbook-engine/crates/ql-storage/src/format.rs:476:        assert_eq!(next, FormatId::Custom(PeerId::new(7), 6));
quantbook-engine/crates/ql-storage/src/format.rs:483:        let mut t = FormatTable::with_peer(PeerId::new(7));
quantbook-engine/crates/ql-storage/src/format.rs:485:        t.register_at(FormatId::Custom(PeerId::new(99), 5), "FROM_OTHER")
quantbook-engine/crates/ql-storage/src/format.rs:496:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:503:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:507:        assert!(matches!(err, FormatTableError::IdCollision { .. }));
quantbook-engine/crates/ql-storage/src/format.rs:512:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:517:        assert!(matches!(err, FormatTableError::StringCollision { .. }));
quantbook-engine/crates/ql-storage/src/format.rs:522:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:540:        let mut t = FormatTable::new();
quantbook-engine/crates/ql-storage/src/format.rs:564:            FormatId::Custom(LEGACY_PEER, 0)
quantbook-engine/crates/ql-storage/src/format.rs:568:            FormatId::Custom(LEGACY_PEER, 999 - 164)
quantbook-engine/crates/ql-storage/src/format.rs:576:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/crates/ql-storage/src/format.rs:578:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/crates/ql-storage/src/format.rs:588:        let id = FormatId::Custom(PeerId::new(42), 7);
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:154:    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:121:    /// in the workbook's `FormatTable`. Producer-side enforcement of the
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:130:    #[error("format id {0:?} is not registered in the workbook FormatTable")]
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:436:    // FormatTable: the custom entry survived.
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:472:        "read_display through reloaded FormatTable + overlay must match producer"
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:75:    // FormatTable + CellFormatOverlay paths.
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:84:    // `FormatTable::default()`.
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:315:    // **W5-84 closure (Sonnet MEDIUM D.3):** FormatTable + per-sheet
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:336:        "FormatTable contents differ between producer and replay"

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/op.rs | sed -n '100,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   121	    RegisterFormat { id: u32, string: String },
   122	
   123	    /// Set or clear a cell's format id. Mirrors
   124	    /// `CellFormatOverlay::set` (when `id` is `Some`) and `::clear`
   125	    /// (when `id` is `None`). The id MUST resolve in the workbook's
   126	    /// `FormatTable` at replay time; an unknown id surfaces as
   127	    /// `ReplayError::FormatNotRegistered`. Shipped W5-80.
   128	    SetCellFormat {
   129	        sheet: SheetId,
   130	        row: RowId,
   131	        col: ColId,
   132	        /// `None` ⇒ clear the overlay entry (cell falls back to General).
   133	        /// `Some(id)` ⇒ bind the cell to that format id.
   134	        id: Option<u32>,
   135	    },
   136	
   137	    /// One transaction's ops applied atomically at replay time. Produced
   138	    /// by `WorkbookTransaction::commit` in 2A.3.b. Replay applies each
   139	    /// inner op in order; on failure, replay reports the inner op's
   140	    /// index relative to the BatchCommit's parent index. No implicit

exec
/bin/zsh -lc "rg -n \"set_peer_id|CollabSession|formats_mut\\(\\).*set_local_peer|set_local_peer\\(\" quantbook-engine/crates --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc 'find quantbook-engine/crates -maxdepth 2 -name Cargo.toml -print | sort' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-ai/Cargo.toml
quantbook-engine/crates/ql-bench/Cargo.toml
quantbook-engine/crates/ql-bindings-c/Cargo.toml
quantbook-engine/crates/ql-bindings-node/Cargo.toml
quantbook-engine/crates/ql-bindings-wasm/Cargo.toml
quantbook-engine/crates/ql-calcgraph/Cargo.toml
quantbook-engine/crates/ql-collab/Cargo.toml
quantbook-engine/crates/ql-connectors/Cargo.toml
quantbook-engine/crates/ql-exec/Cargo.toml
quantbook-engine/crates/ql-formula-semantics/Cargo.toml
quantbook-engine/crates/ql-formula-syntax/Cargo.toml
quantbook-engine/crates/ql-functions/Cargo.toml
quantbook-engine/crates/ql-io-ods/Cargo.toml
quantbook-engine/crates/ql-io-xlsx/Cargo.toml
quantbook-engine/crates/ql-io/Cargo.toml
quantbook-engine/crates/ql-oplog/Cargo.toml
quantbook-engine/crates/ql-profile/Cargo.toml
quantbook-engine/crates/ql-service/Cargo.toml
quantbook-engine/crates/ql-sql/Cargo.toml
quantbook-engine/crates/ql-storage/Cargo.toml
quantbook-engine/crates/ql-terminal/Cargo.toml
quantbook-engine/crates/ql-types/Cargo.toml
quantbook-engine/crates/ql-udf/Cargo.toml
quantbook-engine/crates/quantbook-py/Cargo.toml

 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/lib.rs:57:// like `ql_collab::CollabSession` (which already imports from
quantbook-engine/crates/ql-oplog/src/log.rs:45:/// writes. `ql_collab::CollabSession` wires this to Loro's
quantbook-engine/crates/ql-oplog/src/log.rs:153:    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:164:    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
quantbook-engine/crates/ql-oplog/src/log.rs:184:    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
quantbook-engine/crates/ql-oplog/src/log.rs:186:    /// `&OpLog` (`CollabSession::op_log()`) which would silently
quantbook-engine/crates/ql-oplog/src/log.rs:188:    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:189:        self.doc.set_peer_id(peer)?;
quantbook-engine/crates/ql-oplog/src/log.rs:274:    /// Callers MUST construct the manager AFTER `set_peer_id` and
quantbook-engine/crates/ql-oplog/src/log.rs:282:    /// after construction. The `ql_collab::CollabSession`
quantbook-engine/crates/ql-oplog/src/log.rs:467:    fn set_peer_id_changes_doc_peer_id() {
quantbook-engine/crates/ql-oplog/src/log.rs:470:        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:472:        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
quantbook-engine/crates/ql-oplog/src/log.rs:476:    fn set_peer_id_after_import_works() {
quantbook-engine/crates/ql-oplog/src/log.rs:479:        origin.set_peer_id(11).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:489:        reborn.set_peer_id(22).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:560:        base.set_peer_id(1).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:564:        peer_a.set_peer_id(10).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:570:        peer_b.set_peer_id(20).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:610:    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
quantbook-engine/crates/ql-oplog/src/log.rs:615:        let result = log.set_peer_id(u64::MAX);
quantbook-engine/crates/ql-storage/src/format.rs:186:/// `CollabSession` callers re-construct with their session's peer
quantbook-engine/crates/ql-storage/src/format.rs:202:    /// `CollabSession::attach` (step 4) updates this via
quantbook-engine/crates/ql-storage/src/format.rs:251:    /// Step 4 will call this from `CollabSession::attach` when a
quantbook-engine/crates/ql-storage/src/format.rs:254:    pub fn set_local_peer(&mut self, peer: PeerId) {
quantbook-engine/crates/ql-types/src/peer.rs:33://! - `ql_oplog::OpLog::set_peer_id` — wires through to Loro's
quantbook-engine/crates/ql-types/src/peer.rs:34://!   `LoroDoc::set_peer_id` so concurrent appends carry the right
quantbook-engine/crates/ql-types/src/peer.rs:36://! - `ql_collab::CollabSession` + `ql_collab::presence` (Phase 5.2.a
quantbook-engine/crates/ql-types/src/peer.rs:44:/// the lifetime of a `CollabSession`; the user-facing tooling
quantbook-engine/crates/ql-types/src/peer.rs:64:    /// (`LoroDoc::set_peer_id` takes `u64`).
quantbook-engine/crates/ql-collab/src/undo.rs:4://! `UndoManager` and exposes it through `CollabSession`. Per
quantbook-engine/crates/ql-collab/src/undo.rs:17://! [`crate::CollabSession`] exposes:
quantbook-engine/crates/ql-collab/src/undo.rs:38://! `PRESENCE_COMMIT_ORIGIN`. `CollabSession::new` and
quantbook-engine/crates/ql-collab/src/undo.rs:56://!   `OpLog::set_peer_id` is callable but doing so mid-stream
quantbook-engine/crates/ql-collab/src/undo.rs:60://! directly on `CollabSession` and `loro::UndoManager` is
quantbook-engine/crates/ql-collab/src/lib.rs:18://! - [`session`] — `CollabSession`: per-peer state holder that
quantbook-engine/crates/ql-collab/src/lib.rs:25://!   added `CollabSession` typed transport methods
quantbook-engine/crates/ql-collab/src/lib.rs:47://! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
quantbook-engine/crates/ql-collab/src/lib.rs:49://!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/lib.rs:54://!   `CollabSessionError::Undo(loro::LoroError)` variant added.
quantbook-engine/crates/ql-collab/src/lib.rs:60://!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
quantbook-engine/crates/ql-collab/src/lib.rs:62://!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
quantbook-engine/crates/ql-collab/src/lib.rs:98:pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
quantbook-engine/crates/ql-collab/src/transport.rs:7://! `CollabSession` exposes 5 typed transport methods
quantbook-engine/crates/ql-collab/src/transport.rs:26://! That's enough to plumb a `CollabSession::export_bytes` →
quantbook-engine/crates/ql-collab/src/transport.rs:27://! transport → remote `CollabSession::merge_bytes` flow. The
quantbook-engine/crates/ql-collab/src/transport.rs:92:/// that exercise `CollabSession::append_op` without needing a
quantbook-engine/crates/ql-collab/src/transport.rs:99:    /// inspect this to verify their `CollabSession` calls emit the
quantbook-engine/crates/ql-collab/src/transport.rs:149:/// Wire two `CollabSession`s together for tests like:
quantbook-engine/crates/ql-collab/src/transport.rs:152:/// let session_a = CollabSession::new(PeerId::new(1))?;
quantbook-engine/crates/ql-collab/src/transport.rs:153:/// let session_b = CollabSession::new(PeerId::new(2))?;
quantbook-engine/crates/ql-collab/src/transport.rs:157:/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/crates/ql-collab/src/session.rs:1://! `CollabSession` — per-peer collaboration state holder.
quantbook-engine/crates/ql-collab/src/session.rs:16://!   `CollabSession::{attach,detach,has}_transport` +
quantbook-engine/crates/ql-collab/src/session.rs:25://! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
quantbook-engine/crates/ql-collab/src/session.rs:30://! - `CollabSession::new(peer_id)` — fresh session with an empty
quantbook-engine/crates/ql-collab/src/session.rs:32://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
quantbook-engine/crates/ql-collab/src/session.rs:33://!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/session.rs:35://! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
quantbook-engine/crates/ql-collab/src/session.rs:58:/// the number of blobs `CollabSession::poll_remote` drains per
quantbook-engine/crates/ql-collab/src/session.rs:70:    assert_send::<CollabSession>();
quantbook-engine/crates/ql-collab/src/session.rs:73:/// Errors emitted by `CollabSession` operations.
quantbook-engine/crates/ql-collab/src/session.rs:76:pub enum CollabSessionError {
quantbook-engine/crates/ql-collab/src/session.rs:121:/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
quantbook-engine/crates/ql-collab/src/session.rs:125:pub struct CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:147:impl CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:152:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
quantbook-engine/crates/ql-collab/src/session.rs:156:    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
quantbook-engine/crates/ql-collab/src/session.rs:162:    ///   `CollabSessionError::OpLog`.
quantbook-engine/crates/ql-collab/src/session.rs:163:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:165:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:180:    /// by an earlier `CollabSession::export_bytes` call (typically
quantbook-engine/crates/ql-collab/src/session.rs:187:    /// **Caller pitfalls** (same as `CollabSession::new`):
quantbook-engine/crates/ql-collab/src/session.rs:190:    ///   concurrent session — see `OpLog::set_peer_id` for details.
quantbook-engine/crates/ql-collab/src/session.rs:192:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:194:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:213:    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:222:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:228:    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:236:    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:291:    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
quantbook-engine/crates/ql-collab/src/session.rs:293:    /// - `CollabSessionError::Transport` if `Transport::send`
quantbook-engine/crates/ql-collab/src/session.rs:303:    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:329:    /// as `CollabSessionError::Transport` — any merges before
quantbook-engine/crates/ql-collab/src/session.rs:331:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:349:    ) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:367:                Err(other) => return Err(CollabSessionError::Transport(other)),
quantbook-engine/crates/ql-collab/src/session.rs:380:    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:391:    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:409:    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:426:    /// construction (see `CollabSession::new`), so cursor movements
quantbook-engine/crates/ql-collab/src/session.rs:428:    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:435:    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:466:    /// `CollabSession` shell).
quantbook-engine/crates/ql-collab/src/session.rs:480:    /// `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
quantbook-engine/crates/ql-collab/src/session.rs:497:    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:556:    /// The guard implements `Deref<Target = CollabSession>` +
quantbook-engine/crates/ql-collab/src/session.rs:557:    /// `DerefMut`, so all of `CollabSession`'s methods are
quantbook-engine/crates/ql-collab/src/session.rs:561:    /// returns `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`).
quantbook-engine/crates/ql-collab/src/session.rs:562:    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:578:    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:586:    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:601:    /// Returns `Err(CollabSessionError::Presence(PresenceError::PeerKeyParse))`
quantbook-engine/crates/ql-collab/src/session.rs:605:    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:615:impl std::fmt::Debug for CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:617:        f.debug_struct("CollabSession")
quantbook-engine/crates/ql-collab/src/session.rs:628:/// [`CollabSession::start_undo_group_scoped`]. `Drop` calls
quantbook-engine/crates/ql-collab/src/session.rs:634:/// Implements `Deref<Target = CollabSession>` + `DerefMut`, so
quantbook-engine/crates/ql-collab/src/session.rs:635:/// all `CollabSession` methods are callable directly on the
quantbook-engine/crates/ql-collab/src/session.rs:638:    session: &'a mut CollabSession,
quantbook-engine/crates/ql-collab/src/session.rs:650:    type Target = CollabSession;
quantbook-engine/crates/ql-collab/src/session.rs:651:    fn deref(&self) -> &CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:657:    fn deref_mut(&mut self) -> &mut CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:701:        let s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:709:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:722:        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:732:        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:740:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:748:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:751:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:765:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:775:        // CollabSession but never passed to LoroDoc::set_peer_id, so
quantbook-engine/crates/ql-collab/src/session.rs:779:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:796:        let mut origin = CollabSession::new(PeerId::new(11)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:805:        let mut reborn = CollabSession::from_snapshot(PeerId::new(22), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:820:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:860:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:863:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:868:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:894:        fn make_pair() -> (CollabSession, CollabSession) {
quantbook-engine/crates/ql-collab/src/session.rs:895:            let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:897:            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:899:            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:934:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:937:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:942:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:965:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1010:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1031:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1071:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1075:            matches!(err, CollabSessionError::Undo(_)),
quantbook-engine/crates/ql-collab/src/session.rs:1089:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1109:        fn try_op(s: &mut CollabSession) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:1114:            // We use a contrived CollabSession-error to exercise
quantbook-engine/crates/ql-collab/src/session.rs:1116:            return Err(CollabSessionError::OpLog(
quantbook-engine/crates/ql-collab/src/session.rs:1126:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1145:        // invoke CollabSession methods directly on the guard
quantbook-engine/crates/ql-collab/src/session.rs:1147:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1162:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1181:            let is_err = matches!(&result, Err(CollabSessionError::Undo(_)));
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
quantbook-engine/crates/ql-collab/src/session.rs:1493:                Err(CollabSessionError::Transport(TransportError::Closed))
quantbook-engine/crates/ql-collab/src/session.rs:1505:        // Closed only after queue drains; CollabSession::poll_remote
quantbook-engine/crates/ql-collab/src/session.rs:1510:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1514:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1541:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1544:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1572:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1598:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1614:        // Phase 5.5 V1 integration: drive two CollabSessions
quantbook-engine/crates/ql-collab/src/session.rs:1622:        let base = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1625:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1626:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1657:        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1676:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1702:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1714:        let mut origin = CollabSession::new(PeerId::new(0xa)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1720:        let mut reborn = CollabSession::from_snapshot(PeerId::new(0xa), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1739:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1753:        let result = CollabSession::new(PeerId::new(u64::MAX));
quantbook-engine/crates/ql-collab/src/session.rs:1755:            matches!(result, Err(CollabSessionError::OpLog(_))),
quantbook-engine/crates/ql-collab/src/session.rs:1759:        let origin = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1761:        let result = CollabSession::from_snapshot(PeerId::new(u64::MAX), &bytes);
quantbook-engine/crates/ql-collab/src/session.rs:1763:            matches!(result, Err(CollabSessionError::OpLog(_))),
quantbook-engine/crates/ql-collab/src/presence.rs:31://! [`crate::CollabSession::clear_presence`] after
quantbook-engine/crates/ql-collab/src/presence.rs:32://! [`crate::CollabSession::from_snapshot`] and re-
quantbook-engine/crates/ql-collab/src/presence.rs:45://! `OpLog::set_peer_id` and `CollabSession::new`.
quantbook-engine/crates/ql-collab/src/presence.rs:51://!   [`crate::CollabSession::peer_presence`].

exec
/bin/zsh -lc 'rg -n "set_peer_id|PeerId|CollabSession" quantbook-engine/crates/ql-collab --type rust' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/undo.rs:4://! `UndoManager` and exposes it through `CollabSession`. Per
quantbook-engine/crates/ql-collab/src/undo.rs:17://! [`crate::CollabSession`] exposes:
quantbook-engine/crates/ql-collab/src/undo.rs:38://! `PRESENCE_COMMIT_ORIGIN`. `CollabSession::new` and
quantbook-engine/crates/ql-collab/src/undo.rs:56://!   `OpLog::set_peer_id` is callable but doing so mid-stream
quantbook-engine/crates/ql-collab/src/undo.rs:60://! directly on `CollabSession` and `loro::UndoManager` is
quantbook-engine/crates/ql-collab/src/lib.rs:12://! - `PeerId` — re-exported from [`ql_types::PeerId`] (Phase 5.2 D-1
quantbook-engine/crates/ql-collab/src/lib.rs:13://!   step 1.1, 2026-05-19; originally `ql_collab::peer::PeerId` at
quantbook-engine/crates/ql-collab/src/lib.rs:14://!   5.2.a, briefly relocated to `ql_oplog::PeerId` at step 1, finally
quantbook-engine/crates/ql-collab/src/lib.rs:15://!   at `ql_types::PeerId` after the step-1 Codex audit caught a
quantbook-engine/crates/ql-collab/src/lib.rs:18://! - [`session`] — `CollabSession`: per-peer state holder that
quantbook-engine/crates/ql-collab/src/lib.rs:25://!   added `CollabSession` typed transport methods
quantbook-engine/crates/ql-collab/src/lib.rs:47://! - **Phase 5.2.b (2026-05-19, `ef056f50bee`):** `CollabSession::new`
quantbook-engine/crates/ql-collab/src/lib.rs:49://!   `Result<Self, CollabSessionError>`. Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/lib.rs:54://!   `CollabSessionError::Undo(loro::LoroError)` variant added.
quantbook-engine/crates/ql-collab/src/lib.rs:60://!   `ql_oplog::OpLog::set_peer_id` signature changed from `&self`
quantbook-engine/crates/ql-collab/src/lib.rs:62://!   `CollabSession::op_log()` (`&OpLog`) which would silently clear
quantbook-engine/crates/ql-collab/src/lib.rs:65://! - **Phase 5.2 D-1 step 1 (2026-05-19, `aaa54d32f4d`):** `PeerId`
quantbook-engine/crates/ql-collab/src/lib.rs:66://!   moved from `ql_collab::peer::PeerId` to `ql_oplog::peer::PeerId`.
quantbook-engine/crates/ql-collab/src/lib.rs:69://!   caught (a) PeerId lacked `Serialize`/`Deserialize` (blocks step
quantbook-engine/crates/ql-collab/src/lib.rs:70://!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
quantbook-engine/crates/ql-collab/src/lib.rs:72://!   making `ql-storage -> ql-oplog` for PeerId would loop). Step 1.1
quantbook-engine/crates/ql-collab/src/lib.rs:73://!   moved PeerId to `ql_types::PeerId` (the true dependency floor —
quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/crates/ql-collab/src/lib.rs:77://!   migration. `ql_collab::PeerId` now re-exports `ql_types::PeerId`.
quantbook-engine/crates/ql-collab/src/lib.rs:79://!   **Back-compat surface:** `use ql_collab::PeerId;` keeps working
quantbook-engine/crates/ql-collab/src/lib.rs:81://!   `use ql_collab::peer::PeerId;` (the old module path) was broken
quantbook-engine/crates/ql-collab/src/lib.rs:84://!   already using `ql_collab::PeerId` (the re-export).
quantbook-engine/crates/ql-collab/src/lib.rs:91:// PeerId actually lives in `ql_types` post step 1.1, but ql-collab
quantbook-engine/crates/ql-collab/src/lib.rs:92:// re-exports via `ql_oplog::PeerId` (itself a re-export) to avoid
quantbook-engine/crates/ql-collab/src/lib.rs:94:// callers using `use ql_collab::PeerId;` resolve identically.
quantbook-engine/crates/ql-collab/src/lib.rs:95:pub use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/lib.rs:98:pub use session::{CollabSession, CollabSessionError, UndoGroupGuard};
quantbook-engine/crates/ql-collab/src/transport.rs:7://! `CollabSession` exposes 5 typed transport methods
quantbook-engine/crates/ql-collab/src/transport.rs:26://! That's enough to plumb a `CollabSession::export_bytes` →
quantbook-engine/crates/ql-collab/src/transport.rs:27://! transport → remote `CollabSession::merge_bytes` flow. The
quantbook-engine/crates/ql-collab/src/transport.rs:92:/// that exercise `CollabSession::append_op` without needing a
quantbook-engine/crates/ql-collab/src/transport.rs:99:    /// inspect this to verify their `CollabSession` calls emit the
quantbook-engine/crates/ql-collab/src/transport.rs:149:/// Wire two `CollabSession`s together for tests like:
quantbook-engine/crates/ql-collab/src/transport.rs:152:/// let session_a = CollabSession::new(PeerId::new(1))?;
quantbook-engine/crates/ql-collab/src/transport.rs:153:/// let session_b = CollabSession::new(PeerId::new(2))?;
quantbook-engine/crates/ql-collab/src/transport.rs:157:/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/crates/ql-collab/src/presence.rs:31://! [`crate::CollabSession::clear_presence`] after
quantbook-engine/crates/ql-collab/src/presence.rs:32://! [`crate::CollabSession::from_snapshot`] and re-
quantbook-engine/crates/ql-collab/src/presence.rs:43://! another by sharing the same `PeerId`) is undefined behavior
quantbook-engine/crates/ql-collab/src/presence.rs:45://! `OpLog::set_peer_id` and `CollabSession::new`.
quantbook-engine/crates/ql-collab/src/presence.rs:51://!   [`crate::CollabSession::peer_presence`].
quantbook-engine/crates/ql-collab/src/presence.rs:58:use ql_oplog::PeerId;
quantbook-engine/crates/ql-collab/src/presence.rs:142:    /// back into a `PeerId`. Indicates that another producer wrote
quantbook-engine/crates/ql-collab/src/presence.rs:153:/// Format a `PeerId` as its presence-map key.
quantbook-engine/crates/ql-collab/src/presence.rs:158:pub(crate) fn peer_key(peer: PeerId) -> String {
quantbook-engine/crates/ql-collab/src/presence.rs:162:/// Parse a presence-map key back into a `PeerId`.
quantbook-engine/crates/ql-collab/src/presence.rs:166:pub(crate) fn parse_peer_key(key: &str) -> Result<PeerId, PresenceError> {
quantbook-engine/crates/ql-collab/src/presence.rs:171:    Ok(PeerId::new(raw))
quantbook-engine/crates/ql-collab/src/presence.rs:218:        let p = PeerId::new(0x1234_5678_9abc_def0);
quantbook-engine/crates/ql-collab/src/session.rs:1://! `CollabSession` — per-peer collaboration state holder.
quantbook-engine/crates/ql-collab/src/session.rs:16://!   `CollabSession::{attach,detach,has}_transport` +
quantbook-engine/crates/ql-collab/src/session.rs:25://! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
quantbook-engine/crates/ql-collab/src/session.rs:30://! - `CollabSession::new(peer_id)` — fresh session with an empty
quantbook-engine/crates/ql-collab/src/session.rs:32://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
quantbook-engine/crates/ql-collab/src/session.rs:33://!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
quantbook-engine/crates/ql-collab/src/session.rs:35://! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
quantbook-engine/crates/ql-collab/src/session.rs:52:use ql_oplog::{Op, OpLog, OpLogError, PeerId, PRESENCE_COMMIT_ORIGIN};
quantbook-engine/crates/ql-collab/src/session.rs:58:/// the number of blobs `CollabSession::poll_remote` drains per
quantbook-engine/crates/ql-collab/src/session.rs:70:    assert_send::<CollabSession>();
quantbook-engine/crates/ql-collab/src/session.rs:73:/// Errors emitted by `CollabSession` operations.
quantbook-engine/crates/ql-collab/src/session.rs:76:pub enum CollabSessionError {
quantbook-engine/crates/ql-collab/src/session.rs:115:/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
quantbook-engine/crates/ql-collab/src/session.rs:121:/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
quantbook-engine/crates/ql-collab/src/session.rs:125:pub struct CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:126:    peer_id: PeerId,
quantbook-engine/crates/ql-collab/src/session.rs:147:impl CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:152:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
quantbook-engine/crates/ql-collab/src/session.rs:156:    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
quantbook-engine/crates/ql-collab/src/session.rs:161:    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
quantbook-engine/crates/ql-collab/src/session.rs:162:    ///   `CollabSessionError::OpLog`.
quantbook-engine/crates/ql-collab/src/session.rs:163:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:165:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:180:    /// by an earlier `CollabSession::export_bytes` call (typically
quantbook-engine/crates/ql-collab/src/session.rs:187:    /// **Caller pitfalls** (same as `CollabSession::new`):
quantbook-engine/crates/ql-collab/src/session.rs:190:    ///   concurrent session — see `OpLog::set_peer_id` for details.
quantbook-engine/crates/ql-collab/src/session.rs:191:    /// - `PeerId(u64::MAX)` is reserved.
quantbook-engine/crates/ql-collab/src/session.rs:192:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:194:        log.set_peer_id(peer_id.as_u64())?;
quantbook-engine/crates/ql-collab/src/session.rs:205:    pub fn peer_id(&self) -> PeerId {
quantbook-engine/crates/ql-collab/src/session.rs:213:    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:222:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:228:    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:236:    /// let session = CollabSession::from_snapshot(peer_id, &bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:291:    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
quantbook-engine/crates/ql-collab/src/session.rs:293:    /// - `CollabSessionError::Transport` if `Transport::send`
quantbook-engine/crates/ql-collab/src/session.rs:303:    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:329:    /// as `CollabSessionError::Transport` — any merges before
quantbook-engine/crates/ql-collab/src/session.rs:331:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:349:    ) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:367:                Err(other) => return Err(CollabSessionError::Transport(other)),
quantbook-engine/crates/ql-collab/src/session.rs:376:    /// Uses the session's `PeerId` as the map key (16-hex
quantbook-engine/crates/ql-collab/src/session.rs:380:    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:391:    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:409:    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:426:    /// construction (see `CollabSession::new`), so cursor movements
quantbook-engine/crates/ql-collab/src/session.rs:428:    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:435:    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:466:    /// `CollabSession` shell).
quantbook-engine/crates/ql-collab/src/session.rs:480:    /// `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
quantbook-engine/crates/ql-collab/src/session.rs:497:    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:556:    /// The guard implements `Deref<Target = CollabSession>` +
quantbook-engine/crates/ql-collab/src/session.rs:557:    /// `DerefMut`, so all of `CollabSession`'s methods are
quantbook-engine/crates/ql-collab/src/session.rs:561:    /// returns `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`).
quantbook-engine/crates/ql-collab/src/session.rs:562:    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:578:    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:586:    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:601:    /// Returns `Err(CollabSessionError::Presence(PresenceError::PeerKeyParse))`
quantbook-engine/crates/ql-collab/src/session.rs:602:    /// if a key in the map can't be parsed as a `PeerId` (only
quantbook-engine/crates/ql-collab/src/session.rs:605:    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:615:impl std::fmt::Debug for CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:617:        f.debug_struct("CollabSession")
quantbook-engine/crates/ql-collab/src/session.rs:628:/// [`CollabSession::start_undo_group_scoped`]. `Drop` calls
quantbook-engine/crates/ql-collab/src/session.rs:634:/// Implements `Deref<Target = CollabSession>` + `DerefMut`, so
quantbook-engine/crates/ql-collab/src/session.rs:635:/// all `CollabSession` methods are callable directly on the
quantbook-engine/crates/ql-collab/src/session.rs:638:    session: &'a mut CollabSession,
quantbook-engine/crates/ql-collab/src/session.rs:650:    type Target = CollabSession;
quantbook-engine/crates/ql-collab/src/session.rs:651:    fn deref(&self) -> &CollabSession {
quantbook-engine/crates/ql-collab/src/session.rs:657:    fn deref_mut(&mut self) -> &mut CollabSession {
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
quantbook-engine/crates/ql-collab/src/session.rs:775:        // CollabSession but never passed to LoroDoc::set_peer_id, so
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
quantbook-engine/crates/ql-collab/src/session.rs:894:        fn make_pair() -> (CollabSession, CollabSession) {
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
quantbook-engine/crates/ql-collab/src/session.rs:1075:            matches!(err, CollabSessionError::Undo(_)),
quantbook-engine/crates/ql-collab/src/session.rs:1089:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1109:        fn try_op(s: &mut CollabSession) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:1114:            // We use a contrived CollabSession-error to exercise
quantbook-engine/crates/ql-collab/src/session.rs:1116:            return Err(CollabSessionError::OpLog(
quantbook-engine/crates/ql-collab/src/session.rs:1126:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1145:        // invoke CollabSession methods directly on the guard
quantbook-engine/crates/ql-collab/src/session.rs:1147:        let mut s = CollabSession::new(PeerId::new(7)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1149:        assert_eq!(guard.peer_id(), PeerId::new(7), "Deref reads work");
quantbook-engine/crates/ql-collab/src/session.rs:1162:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1181:            let is_err = matches!(&result, Err(CollabSessionError::Undo(_)));
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
quantbook-engine/crates/ql-collab/src/session.rs:1493:                Err(CollabSessionError::Transport(TransportError::Closed))
quantbook-engine/crates/ql-collab/src/session.rs:1505:        // Closed only after queue drains; CollabSession::poll_remote
quantbook-engine/crates/ql-collab/src/session.rs:1510:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1514:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1541:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1544:            let other = CollabSession::new(PeerId::new(2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1572:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1598:        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1614:        // Phase 5.5 V1 integration: drive two CollabSessions
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
quantbook-engine/crates/ql-collab/src/session.rs:1755:            matches!(result, Err(CollabSessionError::OpLog(_))),
quantbook-engine/crates/ql-collab/src/session.rs:1759:        let origin = CollabSession::new(PeerId::new(1)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1761:        let result = CollabSession::from_snapshot(PeerId::new(u64::MAX), &bytes);
quantbook-engine/crates/ql-collab/src/session.rs:1763:            matches!(result, Err(CollabSessionError::OpLog(_))),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '120,230p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   120	/// shared workbook. Multiple peers each hold their own
   121	/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
   122	/// and call `merge_bytes` to incorporate remote ops. All sessions
   123	/// converge to the same `OpLog` content after exchange (per Loro's
   124	/// CRDT determinism — Phase 5.1 audit Codex V1).
   125	pub struct CollabSession {
   126	    peer_id: PeerId,
   127	    log: OpLog,
   128	    /// Phase 5.4 V1 — peer-local undo/redo.
   129	    ///
   130	    /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
   131	    /// in DECLARATION order, so this drops LAST (after `log`).
   132	    /// That is safe here because `loro::UndoManager` owns its own
   133	    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
   134	    /// borrow from `log`'s doc and won't UAF when `log` drops first.
   135	    undo: loro::UndoManager,
   136	    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
   137	    /// transport. `None` until `attach_transport` is called.
   138	    /// Boxed + `Send` so callers can move sessions between
   139	    /// threads with attached transports.
   140	    ///
   141	    /// V2 V1 scope: caller drives flush + poll explicitly
   142	    /// (no auto-flush on append). V2 V2 / V3 will add
   143	    /// auto-flush + version-vector delta exports.
   144	    transport: Option<Box<dyn Transport + Send>>,
   145	}
   146	
   147	impl CollabSession {
   148	    /// Construct a fresh session with an empty op log.
   149	    ///
   150	    /// Use this when no shared base snapshot exists yet (the first
   151	    /// peer to open a brand-new workbook). The `peer_id` is wired
   152	    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
   153	    /// CRDT merge metadata attributes this session's appends to
   154	    /// `peer_id` (not Loro's default random per-doc id).
   155	    ///
   156	    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
   157	    /// - Two concurrent sessions MUST use distinct peer ids.
   158	    ///   Duplicate ids corrupt the document via conflicting OpIDs.
   159	    /// - Prefer per-process-random peer ids over user-/device-pinned
   160	    ///   ids unless your transport layer enforces single-ownership.
   161	    /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
   162	    ///   `CollabSessionError::OpLog`.
   163	    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
   164	        let mut log = OpLog::new();
   165	        log.set_peer_id(peer_id.as_u64())?;
   166	        let undo = make_undo_manager(&log);
   167	        Ok(Self {
   168	            peer_id,
   169	            log,
   170	            undo,
   171	            transport: None,
   172	        })
   173	    }
   174	
   175	    /// Construct a session by importing a shared snapshot. Use this
   176	    /// when joining a session that already has history (the second+
   177	    /// peer to open a collaborative workbook).
   178	    ///
   179	    /// `bytes` is a `LoroDoc::export(ExportMode::Snapshot)` produced
   180	    /// by an earlier `CollabSession::export_bytes` call (typically
   181	    /// from the workbook owner / first peer). After import, this
   182	    /// session's peer id is set to `peer_id` — distinct from the
   183	    /// peer ids carried by the already-imported ops. Imported ops
   184	    /// retain their original peer-id attribution (Loro semantics);
   185	    /// only this session's future appends carry `peer_id`.
   186	    ///
   187	    /// **Caller pitfalls** (same as `CollabSession::new`):
   188	    /// - The new `peer_id` MUST differ from every peer already
   189	    ///   represented in the imported snapshot AND from every other
   190	    ///   concurrent session — see `OpLog::set_peer_id` for details.
   191	    /// - `PeerId(u64::MAX)` is reserved.
   192	    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
   193	        let mut log = OpLog::import_bytes(bytes)?;
   194	        log.set_peer_id(peer_id.as_u64())?;
   195	        let undo = make_undo_manager(&log);
   196	        Ok(Self {
   197	            peer_id,
   198	            log,
   199	            undo,
   200	            transport: None,
   201	        })
   202	    }
   203	
   204	    /// Stable peer id assigned at session creation.
   205	    pub fn peer_id(&self) -> PeerId {
   206	        self.peer_id
   207	    }
   208	
   209	    /// Append a local op. Delegates to `OpLog::append`. Phase 5.5
   210	    /// will additionally push the appended bytes through the
   211	    /// attached `Transport`; 5.2.a leaves transport integration to
   212	    /// the caller.
   213	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
   214	        self.log.append(op)?;
   215	        Ok(())
   216	    }
   217	
   218	    /// Merge a remote peer's snapshot into this session's log. Loro's
   219	    /// CRDT preserves both peers' concurrent appends in deterministic
   220	    /// causal order (Fugue/origin-based with peer-id tiebreaker per
   221	    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
   222	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
   223	        Ok(self.log.merge_bytes(bytes)?)
   224	    }
   225	
   226	    /// Produce a Loro snapshot blob suitable for transport to other
   227	    /// peers OR for `.qbook/oplog.bin` persistence.
   228	    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
   229	        Ok(self.log.export_bytes()?)
   230	    }

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/workbook.rs | sed -n '300,425p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
   361	    /// `EvalContext` (and therefore the `DateSystem`) at construction.
   362	    /// Mutating the workbook's date system AFTER a `WorkbookEnv` has been
   363	    /// constructed will produce a stale eval context until a fresh
   364	    /// `WorkbookEnv` is created. Today every recompute path constructs
   365	    /// a fresh `WorkbookEnv`, so normal evaluation is safe; callers that
   366	    /// hold a long-lived `WorkbookEnv` across `set_date_system` must
   367	    /// rebuild it. Treat this method as loader-only.
   368	    pub fn set_date_system(&mut self, system: ql_types::DateSystem) {
   369	        self.date_system = system;
   370	    }
   371	
   372	    /// **W5-133 (Phase 4.9.A):** the workbook's formula-text
   373	    /// reference mode (`A1` or `R1C1`). Default `A1`. Phase 4.9
   374	    /// design doc § 1 + § 4.4.
   375	    pub fn reference_mode(&self) -> ql_types::ReferenceMode {
   376	        self.reference_mode
   377	    }
   378	
   379	    /// **W5-133 (Phase 4.9.A):** set the workbook's reference mode.
   380	    /// Used by the `.qbook` loader (v7) and by
   381	    /// `WorkbookRuntime::set_reference_mode` (4.9.K). Switching mode
   382	    /// does NOT rewrite stored formula text — storage canon stays A1.
   383	    /// Only display + input transforms change.
   384	    pub fn set_reference_mode(&mut self, mode: ql_types::ReferenceMode) {
   385	        self.reference_mode = mode;
   386	    }
   387	
   388	    /// **W5-133 (Phase 4.9.A):** the workbook's locale. Default
   389	    /// `EnUs`. Used by the lexer + printer for separator + decimal
   390	    /// rules; see `ql-formula-syntax::locale_data` for the per-locale
   391	    /// data tables.
   392	    pub fn locale(&self) -> ql_types::Locale {
   393	        self.locale
   394	    }
   395	
   396	    /// **W5-133 (Phase 4.9.A):** set the workbook's locale. Used by
   397	    /// the `.qbook` loader (v7) and by `WorkbookRuntime::set_locale`
   398	    /// (4.9.K). Switching locale does NOT rewrite stored formula text
   399	    /// — storage canon stays EN separators. Only display + input
   400	    /// transforms change.
   401	    pub fn set_locale(&mut self, locale: ql_types::Locale) {
   402	        self.locale = locale;
   403	    }
   404	
   405	    /// **W5-79 (Phase 4.5.D part 3):** read access to the workbook's
   406	    /// format-string interning table.
   407	    pub fn formats(&self) -> &crate::FormatTable {
   408	        &self.formats
   409	    }
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

exec
/bin/zsh -lc "rg -n \"WorkbookRuntime::with_oplog|with_oplog\\(|WorkbookRuntime\" quantbook-engine/crates/ql-collab quantbook-engine/crates/ql-exec quantbook-engine/crates/ql-service --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-exec/src/env.rs:405:/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
quantbook-engine/crates/ql-exec/src/loader.rs:9://! 2. `let mut rt = WorkbookRuntime::new(&mut wb, &registry);`
quantbook-engine/crates/ql-exec/src/loader.rs:35:use crate::workbook_runtime::{RecomputeResult, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/loader.rs:48:/// `WorkbookRuntime::recompute_all`); intra-workbook formula→formula
quantbook-engine/crates/ql-exec/src/loader.rs:62:        let mut runtime = WorkbookRuntime::new(&mut workbook, registry);
quantbook-engine/crates/ql-exec/src/loader.rs:95:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:164:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:196:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:244:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:298:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:348:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/loader.rs:400:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:16://!   `on_add_sheet`) wired through `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:66://!         └─ constructs WorkbookRuntime per edit (per-edit borrow window)
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:720:        // `WorkbookRuntime::set_formula`), which calls
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:962:    /// `WorkbookRuntime::set_value`. Phase 3.3 (2026-05-12): the hook
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:981:    /// `WorkbookRuntime::set_formula`. Ensures the cell has a node,
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1028:    /// `WorkbookRuntime::clear_formula`. Phase 3.2: drops the cell's
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1064:    /// `WorkbookRuntime::set_name`. Phase 3.3 (2026-05-12): marks all
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1099:    /// `WorkbookRuntime::add_sheet`. Phase 3.1 stub still: bumps
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1108:    /// `WorkbookRuntime::drop_table`. Walks `table_to_formulas[name]`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1122:    /// **W5-155** wired this hook into `WorkbookRuntime::drop_table`.
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1154:    /// `WorkbookRuntime::rename_table`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1245:    /// `WorkbookRuntime::rename_column`. The runtime has already:
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1308:    /// `WorkbookRuntime::resize_table`. The runtime has already
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1321:    /// `WorkbookRuntime::reextract_table_readers` — the
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1352:    /// last bind. Used by `WorkbookRuntime::reextract_table_readers`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1448:    /// Used by `WorkbookRuntime::reextract_spill_footprint_readers`
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1566:    /// `pub`. This method is only safe as part of `WorkbookRuntime`'s
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1597:    /// (notably `WorkbookRuntime`'s spill-writeback path) that need to
quantbook-engine/crates/ql-exec/src/calcgraph_session.rs:1616:    /// of `WorkbookRuntime`'s spill-mutation choreography.
quantbook-engine/crates/ql-exec/src/transaction.rs:77:/// via `WorkbookRuntime::transaction`), buffer writes via `put_value` and
quantbook-engine/crates/ql-exec/src/transaction.rs:85:/// via `WorkbookRuntime::with_oplog`). When attached, `commit` produces a
quantbook-engine/crates/ql-exec/src/transaction.rs:116:    /// `WorkbookRuntime::with_oplog`.
quantbook-engine/crates/ql-exec/src/transaction.rs:117:    pub fn with_oplog(
quantbook-engine/crates/ql-exec/src/transaction.rs:132:    /// `WorkbookRuntime::transaction` to pass through the runtime's
quantbook-engine/crates/ql-exec/src/transaction.rs:838:        use crate::WorkbookRuntime;
quantbook-engine/crates/ql-exec/src/transaction.rs:841:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/transaction.rs:893:            let tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/transaction.rs:910:            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/transaction.rs:936:            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/transaction.rs:959:            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/transaction.rs:968:        use crate::WorkbookRuntime;
quantbook-engine/crates/ql-exec/src/transaction.rs:973:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/transaction.rs:1016:            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/plan_cache.rs:5://! [`crate::WorkbookRuntime`] and is shared into spawned
quantbook-engine/crates/ql-exec/src/plan_cache.rs:77:/// `WorkbookRuntime::cache_stats()` and surfaced through `ql-profile`.
quantbook-engine/crates/ql-exec/src/plan_cache.rs:106:/// `WorkbookRuntime::with_plan_cache_disabled` — not yet implemented; the
quantbook-engine/crates/ql-exec/src/plan_cache.rs:146:    /// claimed `WorkbookRuntime::set_formula` uses this method — it
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:26:use ql_exec::{CalcgraphSession, WorkbookRuntime};
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:43:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:69:                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/benches/a3_10k_dirty_recompute.rs:89:                let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:309:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:326:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:340:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:356:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:366:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:390:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:411:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:445:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:469:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/names.rs:489:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/plan.rs:597:/// Production callers (`WorkbookRuntime`, `WorkbookTransaction`,
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
quantbook-engine/crates/ql-exec/src/lib.rs:14://!   `WorkbookRuntime`; `PlanCacheStats` for ql-profile observability.
quantbook-engine/crates/ql-exec/src/lib.rs:37://!   `recompute_dirty`) — `WorkbookRuntime` live-formula facade
quantbook-engine/crates/ql-exec/src/lib.rs:87://! submodules — each adds an `impl<'a> WorkbookRuntime<'a>` block to
quantbook-engine/crates/ql-exec/src/lib.rs:106://! Public API is unchanged: every method stays on `WorkbookRuntime`
quantbook-engine/crates/ql-exec/src/lib.rs:152:pub use workbook_runtime::{RecomputeFailure, RecomputeResult, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs:351:/// `WorkbookRuntime::set_formula` evaluates BEFORE storing the formula,
quantbook-engine/crates/ql-exec/tests/reference_fns_step3_e2e.rs:395:/// `WorkbookRuntime::volatile_set`). This test exercises a different
quantbook-engine/crates/ql-exec/src/eval_result.rs:25://! - **W5-102+ (Phase 4.7.J):** `WorkbookRuntime::set_formula` adopts
quantbook-engine/crates/ql-exec/src/eval_result.rs:51:/// **Cell-boundary contract (Phase 4.7.J):** `WorkbookRuntime::set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1://! Table mutation API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:9://! - [`WorkbookRuntime::create_table`] (W5-118) — register a new
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:12://! - [`WorkbookRuntime::drop_table`] (W5-118) — drop a table,
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:15://! - [`WorkbookRuntime::rename_table`] (W5-119) — rename + rewrite
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:18://! - [`WorkbookRuntime::rename_column`] (W5-121) — rename a column
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:20://! - [`WorkbookRuntime::resize_table`] (W5-122) — change a table's
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:35:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:37:impl<'a> WorkbookRuntime<'a> {
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1311:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1328:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1336:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1353:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1371:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1376:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1385:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1669:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1681:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1698:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1712:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1729:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1739:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/tables.rs:1745:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:5://! 2A.3.b wires the engine's real producer (WorkbookRuntime + WorkbookTransaction)
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:10://! The replay side runs `WorkbookRuntime::recompute_all` after replay because
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:14:use ql_exec::{load_workbook_and_recompute, WorkbookRuntime, WorkbookTransaction};
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:92:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:125:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:145:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:162:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:186:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:200:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:220:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:232:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:250:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:274:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:282:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:312:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:324:    save_workbook_with_oplog(&producer_wb, &producer_oplog, "e2e", &path).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:327:    let (_loaded_wb, loaded_oplog) = load_workbook_with_oplog(&path).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:338:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:350:    let (loaded_wb_alone, _) = load_workbook_with_oplog(&path).unwrap();
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:372:        let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:405:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:420:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:424:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:468:    let mut rt = WorkbookRuntime::new(&mut loaded_wb_mut, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:515:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:561:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:582:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:589:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:609:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:628:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:655:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:692:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:712:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:752:        let mut rt = WorkbookRuntime::new(&mut replay_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:774:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:905:        let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut producer_oplog);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:957:        let mut rt = WorkbookRuntime::new(&mut producer_wb, &reg);
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:979:        let mut rt = WorkbookRuntime::new(&mut reloaded, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:1://! `WorkbookRuntime` — the live-formula facade per Phase 1 W5-10.
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:49:// `impl<'a> WorkbookRuntime<'a>` block extending the same struct
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:129:/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:133:pub struct WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:161:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:182:    pub fn with_oplog(
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:1://! Format API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:10://! - [`WorkbookRuntime::intern_format`] — register a format string
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:13://! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:16://! - [`WorkbookRuntime::read_display`] — read a cell and render it
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:19://!   `WorkbookRuntime::format_cache`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:26:use super::{validate_cell, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:28:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:204:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:214:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:233:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:258:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:274:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:302:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:317:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:336:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:352:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:362:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:381:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:402:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:416:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:428:            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:11://! WorkbookRuntime + op-log + recompute path rather than the binder /
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:14:use ql_exec::{eval_scalar_with_cache, CellEnv, NoAggregateCache, WorkbookEnv, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:21:// Structured-ref args via WorkbookRuntime::create_table
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:27:) -> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:29:    let mut rt = WorkbookRuntime::new(wb, reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:196:    // WorkbookRuntime::set_formula. Recompute. Assert B1 = TRUE.
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:204:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:224:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:241:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:250:    // WorkbookRuntime::set_formula canonicalizes via print_with(EnUs);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:281:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step5_cross_cutting.rs:364:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:1://! Sheet mutation API for `WorkbookRuntime`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:10://! - [`WorkbookRuntime::add_sheet`] (W5-92) — append a new sheet,
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:12://! - [`WorkbookRuntime::rename_sheet`] (W5-91) — rename by id,
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:22:use super::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:62:impl<'a> WorkbookRuntime<'a> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:233:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:247:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:276:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:284:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:301:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:313:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/sheets.rs:324:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:866:    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:880:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:906:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:933:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:964:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:997:        let mut rt = WorkbookRuntime::new(&mut loaded, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1019:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1046:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1077:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1103:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1134:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1161:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1192:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1236:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1269:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1299:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1320:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1341:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1367:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1402:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1416:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1431:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1455:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1479:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:1500:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2547:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2567:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2572:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2637:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2661:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2672:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:2686:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3221:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3240:            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3271:        // Hand-write the formula text directly. `WorkbookRuntime::set_formula`
quantbook-engine/crates/ql-exec/src/workbook_runtime/recompute.rs:3292:            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
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
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:25:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs:50:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:20:use ql_exec::WorkbookRuntime;
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:31:fn try_set_formula(rt: &mut WorkbookRuntime, row: u32, col: u32, text: &str) -> String {
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:105:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:150:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:213:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:227:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:242:    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut session);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:257:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:275:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:308:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:338:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:354:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:366:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:375:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:388:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:406:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/p412_function_arg_fuzz.rs:424:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1686:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:1692:            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2004:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2019:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2033:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2053:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2076:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2092:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:2112:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3148:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3177:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3197:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3218:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/cells.rs:3463:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:21:use ql_exec::{CalcgraphSession, RuntimeError, WorkbookRuntime};
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:47:        let mut rt = WorkbookRuntime::with_oplog_and_graph(&mut wb, &reg, &mut oplog, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:117:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:144:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:208:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:239:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:278:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:301:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:358:        let mut rt2 = WorkbookRuntime::new(&mut replayed, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:410:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:427:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:463:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:494:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:524:    let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:549:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:571:        let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:604:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:634:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:642:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:664:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:688:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:705:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:721:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:742:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:773:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:785:        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:807:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:827:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:850:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:883:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:913:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
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
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1181:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1184:    println!("[I21] If WorkbookRuntime exposes no delete_sheet API, that's a Phase 4 IDE gap.");
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1194:    let mut rt = WorkbookRuntime::new(&mut wb, &reg);
quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs:93:            // WorkbookRuntime::set_formula). For this test, the stored
quantbook-engine/crates/ql-exec/tests/reference_fns_step4_e2e.rs:294:/// divergence pattern as `=ISFORMULA(A1)`. `WorkbookRuntime::set_formula`
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
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:1://! `WorkbookRuntime` error + result types.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:89:    /// Phase 2B.5 (2026-05-12): `WorkbookRuntime::set_name` couldn't register
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:99:    /// Surfaces from `WorkbookRuntime::rename_sheet` (and future
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:104:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:112:    /// Phase 2B.7 audit H1 (2026-05-12): `WorkbookRuntime::add_sheet` was
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:188:/// Outcome of a single failed cell during `WorkbookRuntime::recompute_all`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:214:/// Aggregate outcome of `WorkbookRuntime::recompute_all`.
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
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:261:        save_workbook_with_oplog(&wb, &oplog, "ide-roundtrip", &path).unwrap();
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:267:    let (reloaded_wb, reloaded_oplog) = load_workbook_with_oplog(&path).unwrap();
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:321:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:332:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:356:        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
quantbook-engine/crates/ql-exec/tests/ide_simulation.rs:362:    let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs | sed -n '90,160p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    90	/// `WorkbookTransaction` can call the same validator at buffer time.
    91	///
    92	/// **Tier D1 Step 3.3 doc-attachment fix:** this doc block was
    93	/// previously misattached to a `rewrite_formula_text_for_sheet_rename`
    94	/// helper that lived between this comment and `validate_cell`. The
    95	/// helper moved to `sheets.rs` along with `rename_sheet`, so the doc
    96	/// now reaches its intended target.
    97	pub(crate) fn validate_cell(
    98	    workbook: &Workbook,
    99	    sheet: SheetId,
   100	    row: RowId,
   101	    col: ColId,
   102	) -> Result<(), RuntimeError> {
   103	    validate_sheet(workbook, sheet)?;
   104	    if row > MAX_ROW {
   105	        return Err(RuntimeError::InvalidCell {
   106	            sheet,
   107	            row,
   108	            col,
   109	            why: "row exceeds MAX_ROW (1,048,575)",
   110	        });
   111	    }
   112	    if col > MAX_COLUMN {
   113	        return Err(RuntimeError::InvalidCell {
   114	            sheet,
   115	            row,
   116	            col,
   117	            why: "col exceeds MAX_COLUMN (16,383)",
   118	        });
   119	    }
   120	    Ok(())
   121	}
   122	
   123	/// Live-formula facade. Wraps a `&mut Workbook` + `&FunctionRegistry`.
   124	///
   125	/// Construct one per session of cell edits. Re-creating per call is cheap (the
   126	/// struct holds borrows, no heap state of its own).
   127	///
   128	/// Phase 2A.3.b (2026-05-12): optionally attach an `OpLog` via
   129	/// `WorkbookRuntime::with_oplog`. When attached, `set_value` and `set_formula`
   130	/// emit ops into the log in append-before-mutate order. `transaction()`
   131	/// re-borrows the op-log handle into the returned transaction so a single op
   132	/// log records both individual edits and batched commits cohesively.
   133	pub struct WorkbookRuntime<'a> {
   134	    workbook: &'a mut Workbook,
   135	    registry: &'a FunctionRegistry,
   136	    /// Optional op-log sink. When `Some`, all producer methods append before
   137	    /// mutating the workbook so a failing append leaves the workbook
   138	    /// unchanged. When `None`, the runtime behaves exactly as Phase 1 W5-10.
   139	    oplog: Option<&'a mut OpLog>,
   140	    /// Phase 2B.3 bind-plan cache. Lives for the runtime's lifetime;
   141	    /// successive `set_formula` and `recompute_all` calls hit the cache
   142	    /// for unchanged formula text under the same NameTable generation.
   143	    /// See `crate::plan_cache` module docs for the invalidation contract.
   144	    plan_cache: PlanCache,
   145	    /// Phase 3.1 (2026-05-12) optional calcgraph session. When `Some`,
   146	    /// every mutation method calls the corresponding hook on the
   147	    /// session AFTER the workbook mutation succeeds. Phase 3.1 hooks
   148	    /// are stubs (counter bumps + cell-index updates); Phase 3.3 wires
   149	    /// dirty propagation through the same surface. See
   150	    /// `crate::calcgraph_session` module docs for the ownership model.
   151	    graph: Option<&'a mut crate::CalcgraphSession>,
   152	    /// **W5-82 (Phase 4.5.D part 6):** parsed `FormatString` cache keyed
   153	    /// by `FormatId`. `read_display` populates on-demand from
   154	    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
   155	    /// id→string mutations, so cache entries stay stable for the
   156	    /// runtime's lifetime. A new `RegisterFormat` op merely inserts a
   157	    /// new entry; no invalidation needed.
   158	    format_cache: std::collections::HashMap<FormatId, FormatString>,
   159	}
   160	

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/transaction.rs | sed -n '96,145p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    96	    /// Phase 2A.3.b: optional op-log sink. `commit` emits a single
    97	    /// `BatchCommit` at the end of pass 2 when this is `Some` and there is
    98	    /// at least one buffered op.
    99	    oplog: Option<&'a mut OpLog>,
   100	}
   101	
   102	impl<'a> WorkbookTransaction<'a> {
   103	    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
   104	        Self {
   105	            workbook,
   106	            registry,
   107	            ops: Vec::new(),
   108	            cell_kinds: HashMap::new(),
   109	            oplog: None,
   110	        }
   111	    }
   112	
   113	    /// Phase 2A.3.b: construct a transaction that records its commit as a
   114	    /// single `Op::BatchCommit` in the supplied op log. Useful when the
   115	    /// caller wants ad-hoc transactions outside an enclosing
   116	    /// `WorkbookRuntime::with_oplog`.
   117	    pub fn with_oplog(
   118	        workbook: &'a mut Workbook,
   119	        registry: &'a FunctionRegistry,
   120	        oplog: &'a mut OpLog,
   121	    ) -> Self {
   122	        Self {
   123	            workbook,
   124	            registry,
   125	            ops: Vec::new(),
   126	            cell_kinds: HashMap::new(),
   127	            oplog: Some(oplog),
   128	        }
   129	    }
   130	
   131	    /// Phase 2A.3.b: internal forwarding constructor used by
   132	    /// `WorkbookRuntime::transaction` to pass through the runtime's
   133	    /// (possibly absent) op-log handle via `Option::as_deref_mut`. Public
   134	    /// callers should prefer `new` or `with_oplog`.
   135	    pub fn with_optional_oplog(
   136	        workbook: &'a mut Workbook,
   137	        registry: &'a FunctionRegistry,
   138	        oplog: Option<&'a mut OpLog>,
   139	    ) -> Self {
   140	        Self {
   141	            workbook,
   142	            registry,
   143	            ops: Vec::new(),
   144	            cell_kinds: HashMap::new(),
   145	            oplog,

exec
/bin/zsh -lc "rg -n \"set_local_peer|local_peer|formats_mut\\(\\)\\.set|peer_id\\(\\)\" quantbook-engine/crates/ql-exec quantbook-engine/crates/ql-collab quantbook-engine/crates/ql-service --type rust" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/session.rs:702:        assert_eq!(s.peer_id(), PeerId::new(1));
quantbook-engine/crates/ql-collab/src/session.rs:733:        assert_eq!(reborn.peer_id(), PeerId::new(2));
quantbook-engine/crates/ql-collab/src/session.rs:778:        // appear as the underlying log's peer_id().
quantbook-engine/crates/ql-collab/src/session.rs:780:        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-collab/src/session.rs:781:        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-collab/src/session.rs:785:    fn from_snapshot_overrides_imported_peer_id() {
quantbook-engine/crates/ql-collab/src/session.rs:789:        // attribution (Loro semantics), but log.peer_id() reflects
quantbook-engine/crates/ql-collab/src/session.rs:806:        assert_eq!(reborn.op_log().peer_id(), 22);
quantbook-engine/crates/ql-collab/src/session.rs:815:        assert_eq!(reborn.op_log().peer_id(), 22);
quantbook-engine/crates/ql-collab/src/session.rs:1149:        assert_eq!(guard.peer_id(), PeerId::new(7), "Deref reads work");
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:53:        // `local_peer`. Predicted id is `Custom(local_peer, counter)`.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:59:        let id = FormatId::Custom(formats.local_peer(), formats.next_custom_counter());

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/constructors.rs | sed -n '1,180p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"pub fn (new|with_oplog|with_graph|with_oplog_and_graph|transaction)\\(\" quantbook-engine/crates/ql-exec/src/workbook_runtime -S" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
nl: quantbook-engine/crates/ql-exec/src/workbook_runtime/constructors.rs: No such file or directory

 succeeded in 0ms:
quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs:42:    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:162:    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:182:    pub fn with_oplog(
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:204:    pub fn with_graph(
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:225:    pub fn with_oplog_and_graph(

exec
/bin/zsh -lc 'ls quantbook-engine/crates/ql-exec/src/workbook_runtime' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
cells.rs
config.rs
error.rs
formats.rs
mod.rs
names.rs
recompute.rs
sheets.rs
tables.rs
validate.rs

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs | sed -n '160,245p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   160	
   161	impl<'a> WorkbookRuntime<'a> {
   162	    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
   163	        Self {
   164	            workbook,
   165	            registry,
   166	            oplog: None,
   167	            plan_cache: PlanCache::new(),
   168	            format_cache: std::collections::HashMap::new(),
   169	            graph: None,
   170	        }
   171	    }
   172	
   173	    /// Phase 2A.3.b: construct a runtime that records every mutation to the
   174	    /// supplied `OpLog`. Producer-replay equivalence: replaying the resulting
   175	    /// log against a fresh workbook (then calling `recompute_all` to
   176	    /// materialize formula values) reproduces the same observable state.
   177	    ///
   178	    /// See module docs for the documented limitations: `set_value(Value::Blank)`
   179	    /// emits no `PutValue` (CellWireValue lacks a Blank variant in 2A.3.b);
   180	    /// NaN/Inf in number values fail serde_json serialization and surface as
   181	    /// `RuntimeError::OpLog`.
   182	    pub fn with_oplog(
   183	        workbook: &'a mut Workbook,
   184	        registry: &'a FunctionRegistry,
   185	        oplog: &'a mut OpLog,
   186	    ) -> Self {
   187	        Self {
   188	            workbook,
   189	            registry,
   190	            oplog: Some(oplog),
   191	            plan_cache: PlanCache::new(),
   192	            format_cache: std::collections::HashMap::new(),
   193	            graph: None,
   194	        }
   195	    }
   196	
   197	    /// Phase 3.1 (2026-05-12): construct a runtime that fires calcgraph
   198	    /// mutation hooks on every producer method. Phase 3.1 hooks are
   199	    /// stubs (counter bumps + cell-index updates) — they accumulate
   200	    /// state that Phase 3.3 will turn into real dirty propagation and
   201	    /// edge updates. Today's recompute_all still walks formulas in
   202	    /// HashMap order; Phase 3.4 replaces it with a Tarjan-SCC-scheduled
   203	    /// graph walk.
   204	    pub fn with_graph(
   205	        workbook: &'a mut Workbook,
   206	        registry: &'a FunctionRegistry,
   207	        graph: &'a mut crate::CalcgraphSession,
   208	    ) -> Self {
   209	        Self {
   210	            workbook,
   211	            registry,
   212	            oplog: None,
   213	            plan_cache: PlanCache::new(),
   214	            format_cache: std::collections::HashMap::new(),
   215	            graph: Some(graph),
   216	        }
   217	    }
   218	
   219	    /// Phase 3.1 (2026-05-12): construct a runtime with BOTH an attached
   220	    /// op log and an attached calcgraph session. The combined-attachment
   221	    /// constructor mirrors the IDE pattern (open file → load oplog +
   222	    /// rebuild graph → hand both to the runtime per edit). Order of
   223	    /// operations per mutation: lex+parse+bind → op-log append → workbook
   224	    /// mutation → graph hook.
   225	    pub fn with_oplog_and_graph(
   226	        workbook: &'a mut Workbook,
   227	        registry: &'a FunctionRegistry,
   228	        oplog: &'a mut OpLog,
   229	        graph: &'a mut crate::CalcgraphSession,
   230	    ) -> Self {
   231	        Self {
   232	            workbook,
   233	            registry,
   234	            oplog: Some(oplog),
   235	            plan_cache: PlanCache::new(),
   236	            format_cache: std::collections::HashMap::new(),
   237	            graph: Some(graph),
   238	        }
   239	    }
   240	
   241	    /// Phase 2B.3: snapshot of cumulative bind-plan-cache observability
   242	    /// since this runtime was constructed. Includes hit count, miss
   243	    /// count, entry count, and convenience hit-rate.
   244	    pub fn cache_stats(&self) -> PlanCacheStats {
   245	        self.plan_cache.stats()

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-exec/src/workbook_runtime/validate.rs | sed -n '35,52p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    35	    ///
    36	    /// Phase 2A.3.b (2026-05-12): if the runtime was constructed with
    37	    /// `with_oplog`, the transaction inherits the op-log handle via
    38	    /// `Option::as_deref_mut` (re-borrowed for the transaction's shorter
    39	    /// lifetime). The runtime is borrow-frozen while the transaction is
    40	    /// alive, so a single op log records both individual edits and batched
    41	    /// commits without aliasing.
    42	    pub fn transaction(&mut self) -> WorkbookTransaction<'_> {
    43	        WorkbookTransaction::with_optional_oplog(
    44	            self.workbook,
    45	            self.registry,
    46	            self.oplog.as_deref_mut(),
    47	        )
    48	    }
    49	
    50	    /// Phase 2B.7 (2026-05-12) — dry-run formula validation for IDE
    51	    /// on-keystroke diagnostics. Runs the full lex → parse → bind → eval
    52	    /// pipeline against the current workbook state, returns the would-be

codex
The stale newtype searches are clean for code: remaining `id.0` and `FormatId(...)` hits are comments or the runtime error variant, not tuple-field access/construction. One real invariant concern is emerging: the public `Builtin(u32)` variant permits values above 163, and the persistence/export filters treat those as built-ins rather than custom format definitions.
exec
/bin/zsh -lc 'cargo test -p ql-storage format::tests -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'cargo test -p ql-oplog producer_replay_equivalence -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'cargo test -p ql-oplog wire::tests::from_u32_legacy_maps_164_to_custom_counter_zero wire::tests::from_u32_legacy_maps_large_to_custom -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 exited 1 in 275ms:
error: unexpected argument 'wire::tests::from_u32_legacy_maps_large_to_custom' found

Usage: cargo test [OPTIONS] [TESTNAME] [-- [ARGS]...]

For more information, try '--help'.

 succeeded in 390ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.09s
     Running unittests src/lib.rs (target/debug/deps/ql_storage-c262bd5f7a61a196)

running 21 tests
test format::tests::first_custom_id_is_past_builtins ... ok
test format::tests::general_is_builtin_zero ... ok
test format::tests::legacy_from_u32_maps_builtins_and_customs ... ok
test format::tests::intern_existing_returns_same_id ... ok
test format::tests::iter_returns_all_entries ... ok
test format::tests::intern_two_distinct_strings_get_sequential_counters ... ok
test format::tests::default_pre_populates_builtins ... ok
test format::tests::legacy_round_trip_through_helpers ... ok
test format::tests::intern_does_not_advance_for_repeats ... ok
test format::tests::intern_new_allocates_custom_id_for_local_peer ... ok
test format::tests::intern_with_distinct_peers_does_not_collide ... ok
test format::tests::next_custom_counter_advances_on_intern ... ok
test format::tests::register_at_id_collision_errors ... ok
test format::tests::register_at_advances_local_counter_for_own_peer ... ok
test format::tests::register_at_other_peer_does_not_advance_local_counter ... ok
test format::tests::register_at_replays_known_id ... ok
test format::tests::register_at_same_id_same_string_is_idempotent ... ok
test format::tests::to_legacy_u32_returns_none_for_non_legacy_peer ... ok
test format::tests::to_legacy_u32_round_trips_builtins_and_legacy_customs ... ok
test format::tests::register_at_string_collision_errors ... ok
test format::tests::unregistered_builtin_returns_none ... ok

test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 165 filtered out; finished in 0.00s


 succeeded in 16441ms:
   Compiling ql-storage v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage)
   Compiling ql-oplog v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-oplog)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 4.78s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 62 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


codex
Targeted `ql-storage` format tests pass, including the shipped round-trip coverage. My first `ql-oplog` filter was too narrow and selected zero tests; I’m rerunning with the actual test names/filters so the replay coverage claim is checked rather than inferred.
exec
/bin/zsh -lc "rg -n \"#\\[test\\]|fn .*equivalence|fn .*wire|from_u32_legacy\" quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs quantbook-engine/crates/ql-oplog/src/wire.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:374:#[test]
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:421:#[test]
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:448:#[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:292:/// ids; the step-5 envelope-migration `from_u32_legacy` reads it back.
quantbook-engine/crates/ql-oplog/src/wire.rs:315:    pub fn from_u32_legacy(n: u32) -> Self {
quantbook-engine/crates/ql-oplog/src/wire.rs:365:    //! - `from_u32_legacy` migration boundaries (0, 163, 164, large).
quantbook-engine/crates/ql-oplog/src/wire.rs:371:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:380:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:393:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:394:    fn from_u32_legacy_maps_zero_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:397:            FormatIdWire::from_u32_legacy(0),
quantbook-engine/crates/ql-oplog/src/wire.rs:402:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:403:    fn from_u32_legacy_maps_163_to_builtin() {
quantbook-engine/crates/ql-oplog/src/wire.rs:406:            FormatIdWire::from_u32_legacy(163),
quantbook-engine/crates/ql-oplog/src/wire.rs:411:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:412:    fn from_u32_legacy_maps_164_to_custom_counter_zero() {
quantbook-engine/crates/ql-oplog/src/wire.rs:415:            FormatIdWire::from_u32_legacy(164),
quantbook-engine/crates/ql-oplog/src/wire.rs:423:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:424:    fn from_u32_legacy_maps_large_to_custom() {
quantbook-engine/crates/ql-oplog/src/wire.rs:427:            FormatIdWire::from_u32_legacy(999),
quantbook-engine/crates/ql-oplog/src/wire.rs:435:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:456:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:472:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:502:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:514:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:525:    #[test]
quantbook-engine/crates/ql-oplog/src/wire.rs:538:    #[test]

exec
/bin/zsh -lc 'cargo test -p ql-oplog producer_and_replay_match_for_realistic_sequence -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
exec
/bin/zsh -lc 'cargo test -p ql-oplog from_u32_legacy_maps -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 352ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.06s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 4 tests
test wire::format_id_wire_tests::from_u32_legacy_maps_163_to_builtin ... ok
test wire::format_id_wire_tests::from_u32_legacy_maps_zero_to_builtin ... ok
test wire::format_id_wire_tests::from_u32_legacy_maps_large_to_custom ... ok
test wire::format_id_wire_tests::from_u32_legacy_maps_164_to_custom_counter_zero ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 58 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


 succeeded in 377ms:
    Blocking waiting for file lock on artifact directory
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.08s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 62 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs | sed -n '368,465p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   368	                "scoped name {name:?} on sheet {sheet_id} target differs"
   369	            );
   370	        }
   371	    }
   372	}
   373	
   374	#[test]
   375	fn producer_and_replay_produce_observationally_equivalent_workbooks() {
   376	    let ops = realistic_op_sequence();
   377	
   378	    // Producer side: direct mutations.
   379	    let mut producer_wb = Workbook::new();
   380	    producer_wb.add_sheet("S"); // sheet 0 pre-exists (matches the test setup).
   381	    apply_producer_side(&ops, &mut producer_wb);
   382	
   383	    // Replay side: build an OpLog, replay against an empty workbook with
   384	    // the same pre-existing sheet 0.
   385	    let mut log = OpLog::new();
   386	    for op in &ops {
   387	        log.append(op.clone()).unwrap();
   388	    }
   389	    let mut replay_wb = Workbook::new();
   390	    replay_wb.add_sheet("S");
   391	    let reg = default_registry();
   392	    let count = replay_into(&log, &mut replay_wb, &reg).unwrap();
   393	    assert_eq!(count, ops.len());
   394	
   395	    // Observational equality.
   396	    assert_workbooks_observationally_equal(&producer_wb, &replay_wb);
   397	
   398	    // Sanity-spot-check some cells / names by hand.
   399	    assert_eq!(
   400	        replay_wb.read(Address::new(0, 2, 2)),
   401	        Value::Number(22.0),
   402	        "spot-check: (2,2) in the 5x5 paste block"
   403	    );
   404	    assert_eq!(
   405	        replay_wb.formula_at(0, 5, 0).map(|s| s.as_ref()),
   406	        Some("A1 + B2 + C3"),
   407	        "spot-check: formula at (5, 0) survived round-trip"
   408	    );
   409	    assert!(matches!(
   410	        replay_wb.names().lookup_ci("TaxRate"),
   411	        Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
   412	    ));
   413	    assert_eq!(replay_wb.sheet_count(), 2);
   414	    assert_eq!(
   415	        replay_wb.read(Address::new(1, 0, 0)),
   416	        Value::text("widget"),
   417	        "spot-check: text value on second sheet"
   418	    );
   419	}
   420	
   421	#[test]
   422	fn binary_export_then_replay_equivalent_to_in_memory_replay() {
   423	    // Verifies that going through the binary persistence layer doesn't
   424	    // change replay results.
   425	    let ops = realistic_op_sequence();
   426	
   427	    let mut log = OpLog::new();
   428	    for op in &ops {
   429	        log.append(op.clone()).unwrap();
   430	    }
   431	
   432	    // In-memory replay → workbook A.
   433	    let mut wb_in_memory = Workbook::new();
   434	    wb_in_memory.add_sheet("S");
   435	    let reg = default_registry();
   436	    replay_into(&log, &mut wb_in_memory, &reg).unwrap();
   437	
   438	    // Binary round-trip → restored log → replay → workbook B.
   439	    let bytes = log.export_bytes().unwrap();
   440	    let restored = OpLog::import_bytes(&bytes).unwrap();
   441	    let mut wb_via_disk = Workbook::new();
   442	    wb_via_disk.add_sheet("S");
   443	    replay_into(&restored, &mut wb_via_disk, &reg).unwrap();
   444	
   445	    assert_workbooks_observationally_equal(&wb_in_memory, &wb_via_disk);
   446	}
   447	
   448	#[test]
   449	fn batch_commit_replay_equivalent_to_flat_replay() {
   450	    // Two op logs: one with ops flat, the other wrapping the same ops in
   451	    // a single BatchCommit. Both should produce the same workbook state.
   452	    let flat_ops = vec![
   453	        Op::PutValue {
   454	            sheet: 0,
   455	            row: 0,
   456	            col: 0,
   457	            value: CellWireValue::Number(1.0),
   458	        },
   459	        Op::PutValue {
   460	            sheet: 0,
   461	            row: 0,
   462	            col: 1,
   463	            value: CellWireValue::Number(2.0),
   464	        },
   465	        Op::PutFormula {

exec
/bin/zsh -lc 'cargo test -p ql-oplog replay_equivalence -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 312ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.05s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 62 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


exec
/bin/zsh -lc 'cargo test -p ql-oplog producer_and_replay_produce_observationally_equivalent_workbooks -- --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 306ms:
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.05s
     Running unittests src/lib.rs (target/debug/deps/ql_oplog-d9ed1c8203a17f38)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 62 filtered out; finished in 0.00s

     Running tests/p412_defensive_oplog_probes.rs (target/debug/deps/p412_defensive_oplog_probes-9f4c8029c3f77304)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/producer_replay_equivalence.rs (target/debug/deps/producer_replay_equivalence-8740345e5fd92e2e)

running 1 test
test producer_and_replay_produce_observationally_equivalent_workbooks ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.01s


exec
/bin/zsh -lc 'git diff --check af803f1a3f2..HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
exec
/bin/zsh -lc 'git diff --stat af803f1a3f2..HEAD && git diff --name-only af803f1a3f2..HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
 .../docs/phase5/d-1-starting-checklist.md          | 24 +++++++++++++++-------
 1 file changed, 17 insertions(+), 7 deletions(-)
quantbook-engine/docs/phase5/d-1-starting-checklist.md

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs | sed -n '80,120p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    80	        match workbook.formats_mut().register_at(id, &entry.format_code) {
    81	            Ok(()) => {
    82	                count += 1;
    83	            }
    84	            Err(ql_storage::FormatTableError::StringCollision { existing_id, .. }) => {
    85	                // The string is already registered at a DIFFERENT id
    86	                // (typically a built-in). The OOXML file re-declares
    87	                // it at a custom id — semantically redundant but
    88	                // benign. Skip silently; cells referencing the custom
    89	                // id will render via the existing (built-in) format.
    90	                let _ = existing_id;
    91	                continue;
    92	            }
    93	            Err(e) => {
    94	                return Err(XlsxError::MalformedOoxml {
    95	                    part: "xl/styles.xml".to_string(),
    96	                    message: format!(
    97	                        "numFmt registration failed for id {}: {:?}",
    98	                        entry.num_fmt_id, e
    99	                    ),
   100	                });
   101	            }
   102	        }
   103	    }
   104	    Ok(count)
   105	}
   106	
   107	#[cfg(test)]
   108	mod tests {
   109	    use super::*;
   110	    use crate::read::styles_xml::NumFmtEntry;
   111	
   112	    #[test]
   113	    fn register_custom_skips_builtins_below_164() {
   114	        let mut wb = Workbook::new();
   115	        let baseline = wb.formats().len();
   116	        let idx = StyleIndex {
   117	            num_fmts: vec![
   118	                NumFmtEntry {
   119	                    num_fmt_id: 0,
   120	                    format_code: "General".to_string(),

codex
[HIGH] `set_local_peer` can make the next `intern` reuse an existing id
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:254`
Detail: `set_local_peer` only swaps the peer; it does not scan existing `Custom(new_peer, c)` entries or keep per-peer counters. If replay/import registered `Custom(P, 0)` while local peer was different, then `set_local_peer(P)` leaves `next_custom_counter` unchanged and `intern` can allocate `Custom(P, 0)`, overwriting `by_id` while leaving stale `by_string` aliases. This is worse than the “skips 0” case: it can corrupt the format table.
Recommendation: fix now

[HIGH] Same-string concurrent custom formats are rejected across peers
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:308`
Detail: `register_at` rejects a string already mapped to another id, even if the ids are collision-free `Custom(peer, counter)` values. Two peers can independently allocate the same format code as `Custom(A, 0)` and `Custom(B, 0)`; replaying both currently fails with `StringCollision`. The producer/replay test covers one custom id, not this merged-peer case.
Recommendation: fix now

[MEDIUM] `Builtin(n > 163)` is representable and downstream treats it inconsistently
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:59`
Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
Recommendation: fix now

[MEDIUM] The pre-step-4 `expect()` invariant is public-API fragile
File:Line: `quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:62`
Detail: Repo production paths still default to `LEGACY_PEER`; searches show non-legacy `with_peer` usage only in `ql-storage` tests. But `FormatTable::with_peer` / `set_local_peer` are public, so step 3 does allow non-LEGACY `FormatId`s before the qbook/op/xlsx schemas can carry them. Runtime append, qbook save, and xlsx export can panic if that API is used early.
Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx

[LOW] Requested `u32::MAX` edge is not pinned
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:593`
Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
Recommendation: fix now

PASS notes: storage and wire legacy boundaries agree exactly (`0..=163` builtin, `>=164` legacy custom), `Default`/`GENERAL` resolve to `Builtin(0)`, stale `id.0` and tuple-construction code hits are gone, and targeted tests passed for `ql-storage` format tests, `ql-oplog` legacy wire boundary tests, and the producer/replay equivalence test.
tokens used
143,819
[HIGH] `set_local_peer` can make the next `intern` reuse an existing id
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:254`
Detail: `set_local_peer` only swaps the peer; it does not scan existing `Custom(new_peer, c)` entries or keep per-peer counters. If replay/import registered `Custom(P, 0)` while local peer was different, then `set_local_peer(P)` leaves `next_custom_counter` unchanged and `intern` can allocate `Custom(P, 0)`, overwriting `by_id` while leaving stale `by_string` aliases. This is worse than the “skips 0” case: it can corrupt the format table.
Recommendation: fix now

[HIGH] Same-string concurrent custom formats are rejected across peers
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:308`
Detail: `register_at` rejects a string already mapped to another id, even if the ids are collision-free `Custom(peer, counter)` values. Two peers can independently allocate the same format code as `Custom(A, 0)` and `Custom(B, 0)`; replaying both currently fails with `StringCollision`. The producer/replay test covers one custom id, not this merged-peer case.
Recommendation: fix now

[MEDIUM] `Builtin(n > 163)` is representable and downstream treats it inconsistently
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:59`
Detail: The docs define `Builtin` as `0..=163`, but the public enum allows `FormatId::Builtin(200)`, and tests currently register it. `to_legacy_u32()` returns `Some(200)`, while `is_custom()` is false, so qbook/xlsx custom-format rosters skip the string at save/export (`qbook_format.rs:1192`, `umya_export.rs:347`). That can produce overlays or XLSX style ids with no persisted format definition.
Recommendation: fix now

[MEDIUM] The pre-step-4 `expect()` invariant is public-API fragile
File:Line: `quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:62`
Detail: Repo production paths still default to `LEGACY_PEER`; searches show non-legacy `with_peer` usage only in `ql-storage` tests. But `FormatTable::with_peer` / `set_local_peer` are public, so step 3 does allow non-LEGACY `FormatId`s before the qbook/op/xlsx schemas can carry them. Runtime append, qbook save, and xlsx export can panic if that API is used early.
Recommendation: defer to step 4 for oplog, step 5 for qbook, step 6 for xlsx

[LOW] Requested `u32::MAX` edge is not pinned
File:Line: `quantbook-engine/crates/ql-storage/src/format.rs:593`
Detail: `legacy_from_u32(u32::MAX).to_legacy_u32()` should round-trip, but the current test stops at `10_000`. Also consider checked arithmetic for arbitrary `Custom(LEGACY_PEER, c)` and `register_at(Custom(local, c))` at `u32::MAX`.
Recommendation: fix now

PASS notes: storage and wire legacy boundaries agree exactly (`0..=163` builtin, `>=164` legacy custom), `Default`/`GENERAL` resolve to `Builtin(0)`, stale `id.0` and tuple-construction code hits are gone, and targeted tests passed for `ql-storage` format tests, `ql-oplog` legacy wire boundary tests, and the producer/replay equivalence test.
