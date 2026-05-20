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
session id: 019e4338-4573-7731-97fe-5593796ff945
--------
user
# Codex audit — Phase 5.2 D-1 step 6 (xlsx FormatId↔numFmtId mapping, multi-peer aware) 2026-05-20

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target:** commit `19f6aa1b008` (Phase 5.2 D-1 step 6).

Predecessor chain: `9a95429b284` (step 5 doc refresh) → `30ef2637d6f` (step 5 audit closures) → `2ae5bfcab28` (step 5 ship — qbook envelope v7→v8) → step 4 ship `6a4b8b0922f`.

Workspace tests at HEAD: **4272** passed / 0 failed. fmt + clippy clean.

## What shipped

Single commit modifying 3 files (372 insertions, 34 deletions):

1. `crates/ql-io-xlsx/src/write/umya_export.rs`:
   - New `XlsxNumFmtTranslation` struct with `build(workbook, cellxfs_roster) → Self` + `translate(fid) → u32` + `info_lost: Vec<(FormatId, u32)>` for non-LEGACY peer reporting.
   - Translation is built over `UNION(workbook.formats() Customs, cellxfs_roster Customs)`. Sorted deterministically via `BTreeSet<FormatId>` (derived Ord: Builtin sorts before Custom; within Custom, by (peer, counter)).
   - 3 `to_legacy_u32().expect("pre-step-6 ...")` panic sites removed:
     - Overlay sort key (uses `xlsx_numfmt.translate(fid)`).
     - `custom_formats` roster (walks `wb.formats()` Customs through the translation).
     - cellXfs roster injection (now consumes `&[(FormatId, u32)]` pre-translated at the caller).
   - `XlsxExportReport.dropped_features` populated for each non-LEGACY peer flatten, using `UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")`.
   - `post_process_zip` + `inject_cell_xfs_into_styles_xml` signatures changed from `&[FormatId]` to `&[(FormatId, u32)]`.

2. `crates/ql-io-xlsx/tests/calamine_smoke.rs`:
   - New test `step6_multi_peer_format_ids_flatten_and_report_on_xlsx_export`: constructs a workbook with non-LEGACY peer ids (42 + 99) + a LEGACY_PEER id; exports to xlsx; verifies export succeeds (was a panic pre-step-6), report carries 2 multi-peer-flatten entries, round-trip preserves format codes (collapsed to LEGACY_PEER on reimport).
   - New test `step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged`: verifies LEGACY_PEER-only workbooks produce 0 multi-peer-flatten entries (byte-stability sanity).

3. `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs`:
   - Updated misleading expect message to reflect post-step-6 reality.

## Audit focus

Step 6 is the last format-id-related work in the D-1 arc. xlsx export is on a frequently-exercised code path; correctness bugs here have higher visibility than envelope or wire-format bugs.

### HIGH-priority correctness invariants

1. **Translation completeness.** `XlsxNumFmtTranslation::build` collects Customs from `workbook.formats()` + `cellxfs_roster`. Does this cover EVERY FormatId the consumers query? The 3 consumers are: overlay sort (per-sheet overlays, subset of cellxfs_roster), custom_formats roster (subset of `workbook.formats()` Customs), cellXfs roster (subset of cellxfs_roster). If any consumer queries a FormatId NOT in either source set, `translate` panics with the `unwrap_or_else` panic message. Construct an adversarial Workbook that triggers this if possible.

2. **Sort-order interaction with FormatId Ord.** Custom FormatIds sort by (peer u64, counter u32) per derive(Ord). Two peers A and B with `A < B` in u64 ordering: A's Customs come first. Within a single peer, counters in order. Is this a stable + sensible numFmtId allocation? Are there pathological orderings (e.g. LEGACY_PEER = 0 always sorts first; non-zero peers come after)?

3. **Byte-stability for LEGACY_PEER-only workbooks.** The claim is "Custom(LEGACY_PEER, c) → c + 164 — identical to pre-step-6 `to_legacy_u32()` output." Verify:
   - For a LEGACY_PEER-only workbook with Customs counter=0, 1, 2: the translation yields 164, 165, 166. ✅ matches pre-step-6.
   - For a LEGACY_PEER-only workbook with Customs counter=5, 7 (non-contiguous from register_at replay): does the translation yield 164, 165 (re-indexed)? OR 169, 171 (preserving counter)? Pre-step-6 yielded the latter (`to_legacy_u32` returns `c + 164`). Post-step-6 yields the former (sequential allocation). This is a byte-incompatibility.

4. **`info_lost` accuracy.** The flattened-id reported should be the actual xlsx numFmtId the export emitted, not some intermediate value. Trace through: peer42 Custom counter=0 → translation puts it at some `next` value → `info_lost.push((fid, next))`. The same `next` value flows to the cellXfs roster, custom_formats roster, and overlay sort. Verify alignment.

5. **`UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")` collision with import side.** The import side uses `UnsupportedFeatureKind::Other(_)` for various unparseable parts. Does the new tag string collide with any existing string in the codebase? If so, downstream consumers filtering on `Other("multi-peer-...")` could get false positives.

### MEDIUM-priority

1. **Test coverage gaps.** The 2 new tests are good but miss:
   - Builtin(n) where n > 163 in a cellxfs_roster (shouldn't be possible post-step-5 audit closure of HIGH-2, but a defensive test would document).
   - A workbook with N peers (e.g. 5) — does the sort produce a sensible order? Currently only 2 distinct peers tested.
   - Round-trip from xlsx → .qbook → xlsx: does the second xlsx export produce 0 multi-peer flatten entries (because import collapsed to LEGACY_PEER)?

2. **The `expect` in `XlsxNumFmtTranslation::build` counter overflow.** Step-5 audit Codex M1 lesson was that `checked_add` panics on programmer-controlled paths are OK only if the invariant truly holds. Here `next` starts at 164 and counts up; `u32::MAX - 164` Customs would be needed to overflow. Unreachable in practice but technically a panic vector.

3. **Translation rebuild stability.** If `build` is called twice on the same workbook with the same cellxfs_roster, do the resulting custom_maps produce identical xlsx numFmtIds? Should be deterministic per BTreeSet ordering, but worth pinning with a test.

### LOW-priority

1. **Docstring on `XlsxNumFmtTranslation`** mentions "round-trip information loss" but doesn't include a concrete example. A `///` example showing `Custom(PeerId(42), 0) → numFmtId 164` would help.

2. **`info_lost` field name** — should it be `multi_peer_flattens` or `lossy_flattens` for clarity? Minor.

3. **`UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")`** — should this be promoted to a real variant `MultiPeerFormatIdFlatten` in `UnsupportedFeatureKind`? The `Other` case is the catch-all per the docstring; the new case is recurrent enough that a real variant might be cleaner.

## What I want from this audit

Same structure as previous audits. HIGH findings: anything reachable from user input or breaks correctness. MEDIUM: gaps + design smells. LOW: polish.

Run thorough analysis. Spawn sub-agents for cross-file invariants. Don't shortcut reasoning. Step 5 audit caught 2 HIGHs reachable from on-disk input (counter overflow + Builtin range) — the same level of scrutiny applies here.

codex
I’ll audit this read-only first: inspect the shipped diff and current implementation, then trace the reachable `FormatId` sources against the export consumers. I’m also going to delegate independent cross-file checks so byte-stability, report semantics, and tag collisions get separate eyes while I work the main path.
  → Inspect commit diff, local instructions, and relevant xlsx export code
  • Trace translation completeness and panic reachability
  • Check byte stability, sort allocation, and reporting alignment
  • Review tests and unsupported-feature tag collisions
  • Synthesize HIGH/MEDIUM/LOW audit findings with evidence
2026-05-20T02:30:44.026899Z ERROR codex_core::tools::router: error=Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.
collab: SpawnAgent
collab: SpawnAgent
collab: SpawnAgent
collab: SpawnAgent
exec
/bin/zsh -lc "sed -n '1,240p' .github/copilot-instructions.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
/bin/zsh -lc 'git show --name-only --format=fuller 19f6aa1b008' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
commit 19f6aa1b00884d68782ded9aacd77f8d3d1f7f83
Author:     steppen0mad <nurtaymergaliyev@gmail.com>
AuthorDate: Wed May 20 03:29:13 2026 +0100
Commit:     steppen0mad <nurtaymergaliyev@gmail.com>
CommitDate: Wed May 20 03:29:13 2026 +0100

    Phase 5.2 D-1 step 6 — xlsx FormatId↔numFmtId mapping (multi-peer aware)
    
    xlsx has a single-u32 numFmtId namespace; .qbook FormatId is peer-aware.
    Step 6 reconciles this asymmetry on export by flattening Custom variants
    into a contiguous numFmtId range starting at 164 (sorted by FormatId's
    derived Ord). On import, every numFmtId becomes Custom(LEGACY_PEER, _)
    via legacy_from_u32 (xlsx has no peer concept to recover) — already
    correct from step 3.
    
    New helper: XlsxNumFmtTranslation in umya_export.rs.
    - Builtin(n) → n (canonical xlsx id, no flattening).
    - Custom(_, _) → sequential xlsx numFmtId starting at FIRST_CUSTOM_FORMAT_ID = 164.
    - Translation built over UNION(wb.formats(), cellxfs_roster) Customs.
    - Tracks non-LEGACY peer flattens in info_lost vec.
    
    Per the no-fallback rule: non-LEGACY peer flattens are reported via
    XlsxExportReport.dropped_features with UnsupportedFeatureKind::Other
    ("multi-peer-format-id-flatten"). The xlsx output is correct; the
    information loss is intrinsic to the xlsx format; explicit reporting
    is the right discipline.
    
    Byte-stability for LEGACY_PEER-only workbooks (single-writer pre-D-1
    default) is preserved: sorted Custom ids are in counter order, so the
    allocator produces Custom(LEGACY_PEER, c) → c + 164 — identical to
    the pre-step-6 to_legacy_u32() output. All existing xlsx round-trip
    tests pass unchanged.
    
    Changes:
    - crates/ql-io-xlsx/src/write/umya_export.rs:
      - New struct XlsxNumFmtTranslation { custom_map, info_lost } with
        build(workbook, cellxfs_roster) + translate(fid) -> u32.
      - 3 sites updated to use the translation, dropping the pre-step-6
        `to_legacy_u32().expect("pre-step-6 ...")` panics:
        - Overlay sort key (sort_by_key uses translation).
        - custom_formats roster (walks wb.formats() Customs).
        - cellXfs roster (now carries (FormatId, u32) tuples).
      - post_process_zip + inject_cell_xfs_into_styles_xml signature
        changed from &[FormatId] to &[(FormatId, u32)].
      - XlsxExportReport.dropped_features populated with multi-peer
        flatten entries.
    - crates/ql-io-xlsx/tests/calamine_smoke.rs:
      - step6_multi_peer_format_ids_flatten_and_report_on_xlsx_export:
        constructs Workbook with PeerId(42), PeerId(99), LEGACY_PEER
        Custom ids; verifies export succeeds (was panic pre-step-6) +
        report carries 2 multi-peer flatten entries + round-trip preserves
        format codes (collapsed to LEGACY_PEER on reimport).
      - step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged:
        verifies LEGACY_PEER-only workbooks produce 0 multi-peer flatten
        entries (byte-stability sanity check).
    - crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:
      - Updated misleading "pre-step-6 xlsx test sees only legacy FormatId"
        expect message to reflect post-step-6 reality (xlsx import always
        produces LEGACY_PEER customs via legacy_from_u32).
    
    Gates: 4272 workspace tests passing (+2 from step 6). fmt + clippy clean.
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs

exec
/bin/zsh -lc 'git show --stat --oneline --decorate --find-renames 19f6aa1b008' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
19f6aa1b008 (HEAD -> feat/quantbook-engine) Phase 5.2 D-1 step 6 — xlsx FormatId↔numFmtId mapping (multi-peer aware)
 .../crates/ql-io-xlsx/src/write/umya_export.rs     | 207 +++++++++++++++++----
 .../crates/ql-io-xlsx/tests/calamine_smoke.rs      | 192 +++++++++++++++++++
 .../tests/opus_a_phase_4_12_ide_proof.rs           |   7 +-
 3 files changed, 372 insertions(+), 34 deletions(-)

exec
/bin/zsh -lc 'git status --short --branch' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 931ms:
## feat/quantbook-engine...origin/feat/quantbook-engine [ahead 320]
?? .codex-d1-step6-audit-prompt.md
?? .codex-d1-step6-audit.out
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

2026-05-20T02:31:10.728316Z ERROR codex_core::tools::router: error=write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open
codex
The local instruction file points at generic VS Code guidance, but this worktree is a Rust engine repo under `quantbook-engine`; I’m treating those project-specific Rust paths as authoritative. The target commit is HEAD, with only untracked local files around it, so I’ll avoid touching the worktree.
exec
/bin/zsh -lc 'rg -n "XlsxNumFmtTranslation|cellxfs_roster|post_process_zip|inject_cell_xfs|to_legacy_u32|FIRST_CUSTOM_FORMAT_ID|UnsupportedFeatureKind::Other|multi-peer-format-id-flatten" quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
22:use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
94:///   `FIRST_CUSTOM_FORMAT_ID = 164`. Order is deterministic: sorted
101:/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
111:struct XlsxNumFmtTranslation {
124:impl XlsxNumFmtTranslation {
129:    /// - `cellxfs_roster` Custom entries (overlay-used FormatIds; these
135:    fn build(workbook: &Workbook, cellxfs_roster: &[FormatId]) -> Self {
142:        for fid in cellxfs_roster {
149:        let mut next = FIRST_CUSTOM_FORMAT_ID;
178:    /// `cellxfs_roster` the translation was built over. Callers in this
240:    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
241:    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
253:    let xlsx_numfmt = XlsxNumFmtTranslation::build(workbook, &cellxfs_roster);
258:                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
413:        // `cellxfs_roster` order (and therefore every cell's emitted
424:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
466:    // (built above over `wb.formats() + cellxfs_roster` Customs). For
468:    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
497:                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
514:    // `fid.to_legacy_u32().expect()` inline; now that translation is
516:    let cellxfs_roster_translated: Vec<(FormatId, u32)> = cellxfs_roster
526:        || !cellxfs_roster_translated.is_empty();
528:        post_process_zip(
535:            &cellxfs_roster_translated,
555:fn post_process_zip(
563:    // The numFmtId comes from XlsxNumFmtTranslation; the FormatId is
566:    cellxfs_roster: &[(FormatId, u32)],
603:                if !cellxfs_roster.is_empty() {
604:                    content = inject_cell_xfs_into_styles_xml(content, cellxfs_roster)?;
1118:/// applyNumberFormat); slots 1..N follow the `cellxfs_roster` order
1122:/// **Phase 5.2 D-1 step 6 (2026-05-20):** `cellxfs_roster` now carries
1124:/// by `XlsxNumFmtTranslation` at the caller. This drops the pre-step-6
1125:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
1127:fn inject_cell_xfs_into_styles_xml(
1129:    cellxfs_roster: &[(FormatId, u32)],
1134:    let count = cellxfs_roster.len() + 1;
1139:    for (_fid, xlsx_num_fmt_id) in cellxfs_roster {

exec
/bin/zsh -lc "sed -n '1,260p' quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! umya-spreadsheet writer — `NewWorkbook` mode.
//!
//! Post-W5-D-15.2 / megaudit closure, this module covers:
//! - Sheets, cell values (Number / Boolean / Text / Error), formula
//!   text + cached values.
//! - Tables export (xl/tables/table*.xml + sheet rels + Content_Types).
//! - Custom format codes export (xl/styles.xml/<numFmts>) +
//!   per-cell format APPLICATION (cellXfs + s="N").
//! - Workbook-scoped + sheet-scoped named ranges (definedNames).
//! - Atomic write-then-rename for concurrent-safe output.
//! - umya 2.2.0 bug workarounds (t="str" on numeric/boolean/error
//!   formula cells, hardcoded #VALUE! sigil, missing date1904 attr).
//!
//! Companion: `update_original` for the `ExportMode::UpdateOriginal`
//! path. Deferred to v2: rels-graph merge + sheet-inline-anchor
//! merge (CF / DV / mergeCells / hyperlinks preservation) — see
//! `update_original.rs` module doc for rationale.

use crate::error::XlsxError;
use crate::options::FormulaCachePolicy;
use crate::report::XlsxExportReport;
use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
use ql_types::{Value, LEGACY_PEER};

/// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
/// 2.2.0 has two correctness bugs we patch via post-process on output:
/// 1. Formula cells write `t="str"` even when the cached value is
///    numeric/boolean (umya's `get_data_type_crate` returns "str"
///    for any cell with a formula, regardless of `raw_value` type).
/// 2. Error cells hardcode `#VALUE!` as the OOXML `<v>` content
///    regardless of the actual `CellErrorType` variant
///    (umya `worksheet.rs:524-526` hardcodes the sigil).
#[derive(Debug, Clone)]
struct CellFix {
    /// A1-style cell reference, e.g. `"C5"`.
    cell_ref: String,
    /// What to patch.
    kind: CellFixKind,
}

#[derive(Debug, Clone)]
enum CellFixKind {
    /// Remove the `t="str"` attribute from this cell. Used for
    /// formula cells whose cached value is numeric. After removal
    /// the cell has default type "n".
    RemoveStrType,
    /// Replace the hardcoded `#VALUE!` sigil with the actual error
    /// sigil. Used only for non-formula error cells (umya emits
    /// `<c r="A1" t="e"><v>#VALUE!</v></c>` regardless of the
    /// actual error variant).
    OverrideErrorSigil(&'static str),
    /// **W5-D-15:** inject `s="N"` into the cell's opening tag.
    /// `N` is the cellXfs index.
    SetStyle(u32),
    /// **W5-D-PM-1 (megaudit Codex HIGH-2 / Opus-A HIGH-1 closure):**
    /// rewrite `t="str"` → `t="e"` on a formula cell whose cached
    /// value is `Value::Error`. umya emits all formula cells with
    /// `t="str"` regardless of cached-value type; for Number/Boolean
    /// we rely on `RemoveStrType` to drop the attr (default "n"
    /// covers both). For Error, the default "n" is wrong — we need
    /// `t="e"` so the consumer parses the `<v>{sigil}</v>` as an
    /// error type, not a string.
    ConvertFormulaToErrorType,
    /// **W5-D-PM-1 (megaudit Codex HIGH-1 closure):** rewrite
    /// `t="str"` → `t="b"` AND `<v>TRUE</v>` / `<v>FALSE</v>` →
    /// `<v>1</v>` / `<v>0</v>` on a formula cell with Boolean
    /// cached value. OOXML wants boolean cells with `t="b"` and
    /// `<v>1|0</v>`.
    ConvertFormulaToBoolType(bool),
}

/// Convert (col, row) (both 0-indexed) to an A1-style ref.
fn cell_ref_a1(row: u32, col: u32) -> String {
    let mut name = String::new();
    let mut c = col + 1; // 1-indexed for the bijective base-26 conversion
    while c > 0 {
        let rem = (c - 1) % 26;
        name.insert(0, (b'A' + rem as u8) as char);
        c = (c - 1) / 26;
    }
    name.push_str(&(row + 1).to_string());
    name
}

/// **Phase 5.2 D-1 step 6 (2026-05-20):** xlsx single-namespace
/// numFmtId translation. xlsx's `numFmtId` is a single `u32` namespace
/// — no peer-id concept. `FormatId::Custom(peer, counter)` variants
/// from multi-peer `.qbook` workbooks must flatten to a single
/// contiguous range on export.
///
/// **Translation:**
/// - `Builtin(n)` → `n` (canonical xlsx built-in id; no flattening).
/// - `Custom(_, _)` → sequential xlsx numFmtId starting at
///   `FIRST_CUSTOM_FORMAT_ID = 164`. Order is deterministic: sorted
///   by `FormatId`'s derived `Ord` (Builtin sorts before Custom; within
///   Custom, by `(peer, counter)`).
///
/// **Byte-stability:** for the LEGACY_PEER-only case (single-writer
/// pre-D-1 default), sorted Custom ids are in counter order, so the
/// allocator produces `Custom(LEGACY_PEER, c) → c + 164` — identical
/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
/// round-trip tests round-trip byte-identically.
///
/// **Information loss reporting:** non-LEGACY peer ids round-trip
/// CORRECTLY through xlsx, but reimporting an xlsx export collapses
/// them to `Custom(LEGACY_PEER, _)` (the legacy_from_u32 path —
/// xlsx has no peer concept to recover). The flattened ids are
/// recorded in `info_lost` so the export caller can surface them via
/// `XlsxExportReport.dropped_features`. Per the no-fallbacks doctrine,
/// the loss is reported rather than silently absorbed.
struct XlsxNumFmtTranslation {
    /// `Custom(peer, counter) → flattened xlsx numFmtId`. Builtin
    /// variants are NOT in this map — the translator returns `n`
    /// directly for `Builtin(n)`.
    custom_map: std::collections::HashMap<FormatId, u32>,
    /// `(original Custom FormatId, flattened xlsx numFmtId)` for any
    /// Custom whose peer ≠ LEGACY_PEER. These are the lossy entries
    /// from the round-trip perspective: xlsx → .qbook recovery
    /// produces `Custom(LEGACY_PEER, _)`, losing the original peer id.
    /// Caller surfaces via `XlsxExportReport.dropped_features`.
    info_lost: Vec<(FormatId, u32)>,
}

impl XlsxNumFmtTranslation {
    /// Build the translation over all Custom FormatIds the export will
    /// reference. The union of:
    /// - `workbook.formats()` Custom entries (the format-table roster
    ///   used by the `<numFmts>` injection).
    /// - `cellxfs_roster` Custom entries (overlay-used FormatIds; these
    ///   may include Customs not in the format table if the overlay was
    ///   set without first registering via `intern`, though this is
    ///   pathological).
    ///
    /// Deterministic ordering via `BTreeSet<FormatId>`.
    fn build(workbook: &Workbook, cellxfs_roster: &[FormatId]) -> Self {
        let mut customs: std::collections::BTreeSet<FormatId> = std::collections::BTreeSet::new();
        for (id, _) in workbook.formats().iter() {
            if id.is_custom() {
                customs.insert(id);
            }
        }
        for fid in cellxfs_roster {
            if fid.is_custom() {
                customs.insert(*fid);
            }
        }
        let mut custom_map = std::collections::HashMap::new();
        let mut info_lost = Vec::new();
        let mut next = FIRST_CUSTOM_FORMAT_ID;
        for fid in customs {
            let xlsx_id = next;
            // Step-5 audit Codex M1 lesson: checked_add guards
            // overflow even on programmer-controlled paths. With
            // u32::MAX - 164 = ~4.3 billion custom formats this fires
            // truly never, but the explicit check documents intent.
            next = next
                .checked_add(1)
                .expect("xlsx custom numFmtId allocator exhausted (u32::MAX entries)");
            custom_map.insert(fid, xlsx_id);
            if let FormatId::Custom(peer, _) = fid {
                if peer != LEGACY_PEER {
                    info_lost.push((fid, xlsx_id));
                }
            }
        }
        Self {
            custom_map,
            info_lost,
        }
    }

    /// Translate `FormatId → xlsx numFmtId`. `Builtin(n)` returns `n`
    /// directly (canonical xlsx id, never needs flattening). `Custom`
    /// looks up the flattened id from the map.
    ///
    /// **Invariant:** the FormatId MUST be in the translation's scope
    /// — either registered in `workbook.formats()` or present in the
    /// `cellxfs_roster` the translation was built over. Callers in this
    /// file query subsets of those two sets, so the lookup never misses
    /// in practice. The expect documents this invariant rather than
    /// being a real panic path.
    fn translate(&self, fid: FormatId) -> u32 {
        match fid {
            FormatId::Builtin(n) => n,
            FormatId::Custom(_, _) => *self.custom_map.get(&fid).unwrap_or_else(|| {
                panic!(
                    "xlsx numFmt translation: unmapped Custom FormatId {fid:?}; \
                     build() must include this id (programmer error in umya_export.rs)"
                )
            }),
        }
    }
}

/// Export a Quantbook `Workbook` to an xlsx file via umya-spreadsheet
/// in `NewWorkbook` mode (generate fresh).
pub(crate) fn export_new_workbook(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
) -> Result<XlsxExportReport, XlsxError> {
    let mut report = XlsxExportReport::default();
    let mut spreadsheet = umya_spreadsheet::new_file_empty_worksheet();

    // Build a quick lookup from (sheet, row, col) → formula text so
    // the per-cell loop can decide whether to write a formula or a
    // value. The `iter_formulas` API gives us only formula-bearing
    // cells; cells without formulas just get the value-only path.
    let mut formula_map: std::collections::HashMap<(u16, u32, u32), String> =
        std::collections::HashMap::new();
    for (sheet, row, col, text) in workbook.iter_formulas() {
        formula_map.insert((sheet, row, col), text.to_string());
    }

    // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
    // sheet ORDER INDEX (which matches the OOXML sheet1.xml, sheet2.xml
    // numbering for fresh-generated workbooks).
    let mut sheet_fixes: Vec<Vec<CellFix>> = Vec::with_capacity(workbook.sheet_count());

    // **W5-D-15:** build a `FormatId → xf_index` dedup map. Index 0
    // is reserved for the default xf (numFmtId=0, no applyNumberFormat).
    // First custom xf gets index 1, next gets 2, etc.
    //
    // **W5-D-15.2 (separate-Opus M-4 closure):** pre-compute the
    // roster across ALL sheets in a single sweep so the order is a
    // function of the set of FormatIds, not of which sheet first
    // touched them. Sort by `FormatId` for byte determinism — the
    // per-sheet intra-sort from W5-D-15.1 fixes intra-sheet but
    // doesn't bound cross-sheet contribution order. BTreeSet handles
    // both at once.
    let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
        std::collections::BTreeSet::new();
    for sheet_id in 0..workbook.sheet_count() as u16 {
        if let Some(sheet) = workbook.sheet(sheet_id) {
            for (_addr, fid) in sheet.format_overlay().iter() {
                sorted_format_ids.insert(fid);
            }
        }
    }
    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
        .iter()
        .enumerate()
        .map(|(i, fid)| (*fid, (i as u32) + 1)) // slot 0 reserved for default
        .collect();

    // **Phase 5.2 D-1 step 6 (2026-05-20):** build the xlsx numFmtId
    // translation. Maps every Custom FormatId (across both wb.formats()
    // and overlays) to a flattened sequential numFmtId starting at 164.
    // Builtins are translated inline by the helper. info_lost surfaces
    // non-LEGACY peer flattens to XlsxExportReport.dropped_features
    // below.
    let xlsx_numfmt = XlsxNumFmtTranslation::build(workbook, &cellxfs_roster);
    for (orig_fid, flattened_id) in &xlsx_numfmt.info_lost {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
                part: "xl/styles.xml".to_string(),
                detail: format!(

exec
/bin/zsh -lc "sed -n '260,620p' quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
                detail: format!(
                    "Custom format id {orig_fid:?} flattened to xlsx numFmtId {flattened_id} \
                     (xlsx single-namespace; reimporting recovers as Custom(LEGACY_PEER, _))"
                ),
            });
    }

    let sheet_count = workbook.sheet_count();
    for sheet_id in 0..sheet_count as u16 {
        let mut fixes: Vec<CellFix> = Vec::new();
        let sheet = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        let sheet_name = sheet.name().to_string();

        // `new_file_empty_worksheet` returns a spreadsheet with no
        // sheets; add each sheet by name. For the first sheet we'd
        // normally also rename the default, but the empty-file
        // variant doesn't have a default sheet, so add fresh.
        spreadsheet
            .new_sheet(&sheet_name)
            .map_err(|e| XlsxError::Export(format!("umya new_sheet({sheet_name}) failed: {e}")))?;

        let bounds = sheet.bounds();
        // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior code
        // `continue`-d for empty-bounds sheets, skipping the
        // `sheet_fixes.push(fixes)` at end of loop. That misaligned
        // the per-sheet fixes vector for any subsequent non-empty
        // sheet — sheet N's fixes landed on sheet N-1's xml. Now the
        // cell-walk is gated on non-empty bounds; format-overlay
        // scheduling + `sheet_fixes.push` run unconditionally.
        let has_cells_to_walk = bounds.row_extent > 0 && bounds.col_extent > 0;
        if has_cells_to_walk {
            let ws = spreadsheet
                .get_sheet_by_name_mut(&sheet_name)
                .ok_or_else(|| {
                    XlsxError::Export(format!(
                        "umya sheet {sheet_name} disappeared after new_sheet"
                    ))
                })?;
            for row in 0..bounds.row_extent {
                for col in 0..bounds.col_extent {
                    let value = sheet.read(row, col);
                    let formula = formula_map.get(&(sheet_id, row, col));

                    let umya_col = col + 1;
                    let umya_row = row + 1;

                    match (formula, &value) {
                        (Some(formula_text), val) => {
                            // **W5-D-14.1 (audit HIGH-1 closure — phase
                            // 1):** umya's `set_value_*` setters internally
                            // call `remove_formula()`, so we apply the
                            // value FIRST then call `set_formula` (which
                            // doesn't touch the raw value).
                            let cell = ws.get_cell_mut((umya_col, umya_row));
                            let cache_written = if formula_cache
                                == FormulaCachePolicy::WriteRecomputed
                                && !matches!(val, Value::Blank)
                            {
                                apply_value_to_cell(cell, val);
                                true
                            } else {
                                false
                            };
                            cell.set_formula(formula_text.as_str());
                            if cache_written {
                                report.formula_caches_written += 1;
                            }
                            // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
                            // umya's writer sets `t="str"` on any formula
                            // cell (`cell_value.rs::get_data_type_crate`
                            // returns "str" for Some(formula) regardless
                            // of raw_value type). Calamine then reads the
                            // `<v>` content as text. Schedule a post-
                            // process fix: remove `t="str"` for cells
                            // whose cached value is numeric/boolean (the
                            // default cell type "n" lets calamine restore
                            // the number).
                            // RemoveStrType handles formula cells with Number
                            // cached values (default cell type "n" round-trips).
                            // Boolean / Error formula cells need DIFFERENT
                            // post-process patches because the default "n"
                            // would still misread the value.
                            if cache_written {
                                match val {
                                    Value::Number(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::RemoveStrType,
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-1 closure):**
                                    // boolean formula cache — rewrite
                                    // `t="str"` → `t="b"` AND `<v>TRUE</v>`
                                    // / `<v>FALSE</v>` → `<v>1</v>` /
                                    // `<v>0</v>`. Without this the cell
                                    // round-trips as text "TRUE"/"FALSE".
                                    Value::Boolean(b) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToBoolType(*b),
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-2 / Opus-A
                                    // HIGH-1 closure):** error formula
                                    // cache — rewrite `t="str"` → `t="e"`.
                                    // The sigil in `<v>` is already correct
                                    // (umya passes our value through). 10 %
                                    // of corpus impacted before the fix.
                                    Value::Error(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToErrorType,
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        (None, Value::Blank) => {
                            // Skip blank cells (no formula, no value).
                        }
                        (None, val) => {
                            let cell = ws.get_cell_mut((umya_col, umya_row));
                            apply_value_to_cell(cell, val);
                            // **W5-D-14.1 (audit HIGH-6 closure):** umya
                            // hardcodes `#VALUE!` for any error cell.
                            // Schedule the actual sigil patch.
                            if let Value::Error(e) = val {
                                fixes.push(CellFix {
                                    cell_ref: cell_ref_a1(row, col),
                                    kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                                });
                            }
                        }
                    }
                    if !matches!(value, Value::Blank) || formula.is_some() {
                        report.cells_written += 1;
                    }
                }
            }
        } // end `if has_cells_to_walk`

        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
        // format overlay entry. MUST run AFTER the cell-walk fixes
        // (RemoveStrType / OverrideErrorSigil) so their needles —
        // which match on the literal `<c r="..." t="..."` prefix —
        // aren't disrupted by an inserted `s="..."` attribute.
        //
        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
        // walked `format_overlay().iter()` directly — HashMap
        // iteration order, which is non-deterministic. The
        // `cellxfs_roster` order (and therefore every cell's emitted
        // `s="N"`) varied run-to-run. Now we sort entries by
        // (FormatId, row, col) so the roster is byte-stable across
        // runs and the per-cell `s="N"` values are deterministic.
        let sheet_view = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
            sheet_view.format_overlay().iter().collect();
        // Phase 5.2 D-1 step 6 (2026-05-20): sort by the xlsx-flattened
        // numFmtId (via the translation built above) + (row, col). The
        // pre-step-6 expect() on `to_legacy_u32()` panicked on
        // non-LEGACY peer Custom ids; the translation handles them
        // by flattening into a single namespace. For LEGACY_PEER-only
        // workbooks (single-writer pre-D-1 default) the sort key
        // values are identical, so byte-stable output is preserved
        // for existing xlsx fixtures.
        overlay_entries.sort_by_key(|a| (xlsx_numfmt.translate(a.1), a.0 .0, a.0 .1));

        for ((row, col), fid) in overlay_entries {
            let xf_index = match format_to_xf_index.get(&fid) {
                Some(idx) => *idx,
                None => continue, // unreachable — roster pre-populated for all FormatIds
            };
            fixes.push(CellFix {
                cell_ref: cell_ref_a1(row, col),
                kind: CellFixKind::SetStyle(xf_index),
            });
        }
        sheet_fixes.push(fixes);
    }

    // Persist to disk.
    umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;

    // **W5-D-14.1 unified post-process pass:** apply workarounds for
    // umya 2.2.0 bugs and limitations. Patches applied:
    //
    // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` (HIGH-2).
    // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` (HIGH-1).
    // 3. `xl/worksheets/sheet{N}.xml`: error sigil sub (HIGH-6).
    // 4. `xl/styles.xml`: inject `<numFmts>` for custom format codes
    //    (HIGH-5 closure — umya doesn't write the custom-format roster).
    // 5. `xl/workbook.xml`: inject `<definedNames>` for workbook +
    //    sheet-scoped names (HIGH-4 closure — names export side).
    // 6. `xl/tables/table{N}.xml` + sheet rels + Content_Types + sheet
    //    `<tableParts>`: write Quantbook tables (HIGH-3 closure).
    let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());

    // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
    // Phase 5.2 D-1 step 6 (2026-05-20): use the xlsx numFmt translation
    // (built above over `wb.formats() + cellxfs_roster` Customs). For
    // LEGACY_PEER-only workbooks the translated numFmtIds match the
    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
    // FormatIds get flattened to the contiguous range with reporting.
    let custom_formats: Vec<(u32, String)> = workbook
        .formats()
        .iter()
        .filter_map(|(id, code)| {
            if id.is_custom() {
                Some((xlsx_numfmt.translate(id), code.to_string()))
            } else {
                None
            }
        })
        .collect();

    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
    // scoped + sheet-scoped names. Each is rendered as the OOXML
    // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
    let defined_names = collect_defined_names(workbook)?;

    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
    // `report.dropped_features` with names that couldn't be rendered
    // (Constant(Error)/Constant(Blank) targets). `collect_defined_names`
    // silently drops these; without this surfacing, NewWorkbook
    // Strict mode never fires for them.
    let dropped_named_count = count_undeserializable_names(workbook);
    for _ in 0..dropped_named_count {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
                part: "xl/workbook.xml".to_string(),
                detail: "named range with Error/Blank constant target cannot \
                         serialize to OOXML formula text"
                    .to_string(),
            });
    }

    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
    // their own `xl/tables/table{N}.xml` parts AND require updates to
    // sheet rels + worksheet `<tableParts>` + `[Content_Types].xml`.
    let tables = collect_table_exports(workbook);

    // Phase 5.2 D-1 step 6: pre-translate the cellxfs roster into
    // (FormatId, xlsx_numFmtId) pairs so post-process doesn't need
    // the translation helper. For each FormatId in the roster, look
    // up its flattened numFmtId. Pre-step-6 the inject site computed
    // `fid.to_legacy_u32().expect()` inline; now that translation is
    // explicit + multi-peer aware.
    let cellxfs_roster_translated: Vec<(FormatId, u32)> = cellxfs_roster
        .iter()
        .map(|&fid| (fid, xlsx_numfmt.translate(fid)))
        .collect();

    let needs_post_process = needs_date1904
        || needs_cell_fixes
        || !custom_formats.is_empty()
        || !defined_names.is_empty()
        || !tables.is_empty()
        || !cellxfs_roster_translated.is_empty();
    if needs_post_process {
        post_process_zip(
            output_path,
            needs_date1904,
            &sheet_fixes,
            &custom_formats,
            &defined_names,
            &tables,
            &cellxfs_roster_translated,
        )?;
    }

    Ok(report)
}

/// Unified post-process pass over the just-written xlsx. Applies all
/// workarounds and roster injections in a single zip walk:
/// - `xl/workbook.xml`: inject `date1904="1"` + `<definedNames>`.
/// - `xl/worksheets/sheet{N}.xml`: per-cell fixes (HIGH-1 / HIGH-6) +
///   `<tableParts>` references for tables anchored to that sheet.
/// - `xl/styles.xml`: inject `<numFmts>` for custom format codes.
/// - `xl/tables/table{N}.xml`: NEW parts for each Quantbook table.
/// - `xl/worksheets/_rels/sheet{N}.xml.rels`: rel entries pointing
///   into the table parts.
/// - `[Content_Types].xml`: `Override` entries for the new table parts.
///
/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
/// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
fn post_process_zip(
    path: &std::path::Path,
    inject_date1904: bool,
    sheet_fixes: &[Vec<CellFix>],
    custom_formats: &[(u32, String)],
    defined_names: &[DefinedNameOut],
    tables: &[TableExport],
    // Phase 5.2 D-1 step 6: each entry is (FormatId, xlsx numFmtId).
    // The numFmtId comes from XlsxNumFmtTranslation; the FormatId is
    // kept alongside for the format_to_xf_index lookup that maps cells
    // to their roster slot.
    cellxfs_roster: &[(FormatId, u32)],
) -> Result<(), XlsxError> {
    use std::io::{Read, Write};

    // Pre-compute per-sheet table groupings: for each Quantbook
    // sheet index, the table ids anchored there. Used to emit
    // `<tableParts>` in the worksheet xml + rels.
    let mut tables_by_sheet: std::collections::HashMap<usize, Vec<&TableExport>> =
        std::collections::HashMap::new();
    for t in tables {
        tables_by_sheet.entry(t.sheet_idx).or_default().push(t);
    }

    let bytes = std::fs::read(path)?;
    let mut reader =
        zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(XlsxError::Zip)?;
    let mut out_buf: Vec<u8> = Vec::new();
    let mut existing_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        for i in 0..reader.len() {
            let mut entry = reader.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            existing_names.insert(name.clone());
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            if name == "xl/workbook.xml" {
                if inject_date1904 {
                    content = inject_date1904_into_workbook_xml(content)?;
                }
                if !defined_names.is_empty() {
                    content = inject_defined_names_into_workbook_xml(content, defined_names)?;
                }
            } else if name == "xl/styles.xml" {
                if !custom_formats.is_empty() {
                    content = inject_custom_formats_into_styles_xml(content, custom_formats)?;
                }
                if !cellxfs_roster.is_empty() {
                    content = inject_cell_xfs_into_styles_xml(content, cellxfs_roster)?;
                }
            } else if name == "[Content_Types].xml" && !tables.is_empty() {
                content = inject_table_overrides_into_content_types(content, tables)?;
            } else if let Some(sheet_idx) = sheet_index_from_path(&name) {
                if let Some(fixes) = sheet_fixes.get(sheet_idx) {
                    if !fixes.is_empty() {
                        content = apply_cell_fixes_to_sheet_xml(content, fixes)?;
                    }
                }
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_parts_into_sheet_xml(content, sheet_tables)?;
                }
            } else if let Some(sheet_idx) = sheet_rels_index_from_path(&name) {
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_rels(content, sheet_tables)?;
                }

exec
/bin/zsh -lc "sed -n '620,980p' quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
                }
            }
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file(name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
        // parts. Each table id N gets its own part file.
        for t in tables {
            let part_name = format!("xl/tables/table{}.xml", t.id);
            let xml = render_table_xml(t);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&part_name, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(xml.as_bytes())?;
        }

        // **W5-D-14.2:** if a sheet has tables but the sheet had no
        // pre-existing rels file (umya doesn't write one for plain
        // sheets), create the rels file from scratch.
        for (sheet_idx, sheet_tables) in &tables_by_sheet {
            // The sheet ID in the umya-generated file is sheet_idx + 1.
            let rels_path = format!("xl/worksheets/_rels/sheet{}.xml.rels", sheet_idx + 1);
            if existing_names.contains(&rels_path) {
                continue;
            }
            let content = render_fresh_sheet_rels(sheet_tables);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&rels_path, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(content.as_bytes())?;
        }

        writer.finish().map_err(XlsxError::Zip)?;
    }
    // **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** atomic write
    // via write-tmp + rename. Concurrent exports to the same
    // `output_path` would otherwise interleave bytes, producing
    // corrupt output (3 of 4 concurrent calls were observed to fail
    // empirically). POSIX `rename` is atomic on the same filesystem.
    atomic_write_to_path(path, &out_buf)?;
    Ok(())
}

/// **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** write `bytes` to
/// `final_path` atomically via tmp + rename. On the same
/// filesystem, `rename(2)` is atomic — concurrent writers either
/// see the old file or the new file, never a partial / interleaved
/// state.
/// Crate-visible wrapper so sibling modules (`update_original`)
/// can use the same atomic-write helper without duplicating code.
pub(crate) fn atomic_write_to_path_public(
    final_path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), XlsxError> {
    atomic_write_to_path(final_path, bytes)
}

fn atomic_write_to_path(final_path: &std::path::Path, bytes: &[u8]) -> Result<(), XlsxError> {
    let parent = final_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let stem = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("ql-output");
    // Use a per-call counter + pid + nanosecond timestamp so
    // concurrent writers don't collide on this tmp path either.
    static WRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = WRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(".{stem}.tmp-{pid}-{n}-{nanos}"));
    std::fs::write(&tmp, bytes)?;
    // `rename` clobbers an existing destination atomically on POSIX.
    // On Windows this may not be atomic-when-target-exists; for our
    // workflow that's acceptable (Windows isn't a target platform
    // for this engine).
    if let Err(e) = std::fs::rename(&tmp, final_path) {
        // Best-effort cleanup of the tmp file on failure.
        let _ = std::fs::remove_file(&tmp);
        return Err(XlsxError::Io(e));
    }
    Ok(())
}

/// Convert `xl/worksheets/sheet5.xml` → `Some(4)` (0-indexed N-1).
/// Returns `None` for any path that isn't a per-sheet worksheet xml.
fn sheet_index_from_path(name: &str) -> Option<usize> {
    let stripped = name.strip_prefix("xl/worksheets/sheet")?;
    let n_str = stripped.strip_suffix(".xml")?;
    n_str.parse::<usize>().ok().and_then(|n| n.checked_sub(1))
}

/// Apply per-cell fixes to one worksheet xml content. Each fix
/// targets a specific cell ref (e.g. `"C5"`) within the sheet.
fn apply_cell_fixes_to_sheet_xml(
    content: Vec<u8>,
    fixes: &[CellFix],
) -> Result<Vec<u8>, XlsxError> {
    let mut text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("worksheet.xml is not valid UTF-8: {e}")))?;
    for fix in fixes {
        match &fix.kind {
            CellFixKind::RemoveStrType => {
                // Pattern: `<c r="C5" t="str">` → `<c r="C5">`.
                // umya always writes attributes in the same order:
                // `r` first, then optional `t`, then optional `s`.
                // The `t="str"` attribute appears immediately after
                // the `r="..."` for formula cells. Match the exact
                // pair `<c r="X1" t="str"`.
                let needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}""#, fix.cell_ref);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::OverrideErrorSigil(sigil) => {
                // Pattern: `<c r="C5" t="e"><v>#VALUE!</v></c>` →
                // `<c r="C5" t="e"><v>SIGIL</v></c>`. The cell ref
                // anchors the match so we only patch the targeted cell.
                let needle = format!(r#"<c r="{}" t="e"><v>#VALUE!</v>"#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}" t="e"><v>{}</v>"#, fix.cell_ref, sigil);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::SetStyle(xf_index) => {
                // Pattern: `<c r="C5"` → `<c r="C5" s="N"`.
                // Anchors on the full `r="..."` attr to avoid
                // collisions with cells whose ref is a prefix
                // (e.g. matching A1 inside AA1's r-attr is prevented
                // by the closing `"`). We insert s="..." immediately
                // after the closing quote of the `r` attr — this
                // works for both `<c r="C5">` AND `<c r="C5"/>` AND
                // `<c r="C5" t="...">` forms.
                let needle = format!(r#"<c r="{}""#, fix.cell_ref);
                if text.contains(&needle) {
                    let replacement = format!(r#"<c r="{}" s="{}""#, fix.cell_ref, xf_index);
                    text = text.replace(&needle, &replacement);
                } else {
                    // **W5-D-15.2 (Codex audit HIGH-4 / separate-Opus
                    // H-1 closure):** umya doesn't emit `<c>` for
                    // value-less cells. Inject a fresh
                    // `<c r="A1" s="N"/>` element into the matching
                    // `<row>` (or create the row if needed) so the
                    // format overlay survives the round-trip.
                    text = insert_style_only_cell(text, &fix.cell_ref, *xf_index)?;
                }
            }
            CellFixKind::ConvertFormulaToErrorType => {
                // **W5-D-PM-1 (megaudit closure):** rewrite
                // `<c r="C5" t="str">` → `<c r="C5" t="e">`.
                // umya emits formula+Error cells with `t="str"` and
                // the correct sigil in `<v>`. Just flip the type.
                let needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let replacement = format!(r#"<c r="{}" t="e""#, fix.cell_ref);
                text = text.replace(&needle, &replacement);
            }
            CellFixKind::ConvertFormulaToBoolType(b) => {
                // **W5-D-PM-1 (megaudit closure):** rewrite
                // `<c r="C5" t="str">...<v>TRUE</v>...</c>` →
                // `<c r="C5" t="b">...<v>1</v>...</c>`.
                // Two passes: type attr + value content. The value
                // content needle anchors on the closing `</c>` end
                // of this specific cell tag to avoid false positives.
                let type_needle = format!(r#"<c r="{}" t="str""#, fix.cell_ref);
                let type_replacement = format!(r#"<c r="{}" t="b""#, fix.cell_ref);
                text = text.replace(&type_needle, &type_replacement);
                // Value content: umya emits `<v>TRUE</v>` or
                // `<v>FALSE</v>`. The patch is scoped to the cell's
                // tag — but `text.replace` is global. Anchor with
                // the cell ref by looking for the cell tag prefix +
                // value pattern between `<v>` and `</v>`.
                let bool_str = if *b { "TRUE" } else { "FALSE" };
                let bool_int = if *b { "1" } else { "0" };
                // Match the entire `<c r="X" t="b"><f>...</f><v>BOOL_STR</v>`
                // sequence and replace the value. The `t="b"` was
                // just set above, so the cell now reads
                // `<c r="X" t="b"><f>...</f><v>BOOL_STR</v>`.
                // We need to find this cell's value element
                // specifically.
                let cell_open = format!(r#"<c r="{}" t="b""#, fix.cell_ref);
                if let Some(open_idx) = text.find(&cell_open) {
                    let after_open = open_idx + cell_open.len();
                    // Find the cell's closing `</c>`.
                    if let Some(close_rel) = text[after_open..].find("</c>") {
                        let cell_end = after_open + close_rel;
                        let body = &text[after_open..cell_end];
                        let v_needle = format!("<v>{}</v>", bool_str);
                        let v_replacement = format!("<v>{}</v>", bool_int);
                        if body.contains(&v_needle) {
                            let new_body = body.replace(&v_needle, &v_replacement);
                            let mut out = String::with_capacity(text.len());
                            out.push_str(&text[..after_open]);
                            out.push_str(&new_body);
                            out.push_str(&text[cell_end..]);
                            text = out;
                        }
                    }
                }
            }
        }
    }
    Ok(text.into_bytes())
}

/// Insert `date1904="1"` into `<workbookPr>`. If the element is
/// missing, insert a fresh `<workbookPr date1904="1"/>` after the
/// opening `<workbook>` tag. UTF-8 text manipulation — OOXML is
/// always UTF-8.
/// **W5-D-15.2:** insert a style-only cell into the worksheet xml's
/// `<sheetData>`. Used when a cell has a format overlay but no
/// value/formula — umya skips emitting such cells, so we synthesize
/// `<c r="A1" s="N"/>` and place it inside the matching `<row r="K">`
/// element (creating the row if needed).
///
/// Excel tolerates non-sorted cells within a row and slightly stale
/// `spans` attributes; we don't bother updating either.
fn insert_style_only_cell(
    text: String,
    cell_ref: &str,
    xf_index: u32,
) -> Result<String, XlsxError> {
    let row_number = match parse_row_number_from_ref(cell_ref) {
        Some(n) => n,
        None => {
            // Malformed cell ref — nothing to do.
            return Ok(text);
        }
    };
    let new_cell = format!(r#"<c r="{}" s="{}"/>"#, cell_ref, xf_index);

    // Case 1: `<row r="K">...</row>` exists — inject before `</row>`.
    let open_attr = format!(r#"<row r="{}""#, row_number);
    if let Some(open_idx) = text.find(&open_attr) {
        // Find the closing `>` of the opening `<row>` tag.
        let after_open = open_idx + open_attr.len();
        let open_end = match text[after_open..].find('>') {
            Some(i) => after_open + i + 1,
            None => {
                return Err(XlsxError::Export(
                    "worksheet xml: malformed <row> opening tag".to_string(),
                ));
            }
        };
        // Self-closing `<row .../>` form (umya rarely emits this but
        // handle defensively): convert to the long form with the cell
        // inside.
        if text[after_open..open_end].ends_with("/>") {
            // Strip the trailing `/>` and replace with `>...new_cell...</row>`.
            let self_close_start = open_end - 2;
            let mut out = String::with_capacity(text.len() + new_cell.len() + 16);
            out.push_str(&text[..self_close_start]);
            out.push('>');
            out.push_str(&new_cell);
            out.push_str("</row>");
            out.push_str(&text[open_end..]);
            return Ok(out);
        }
        // Long-form `<row ...>...</row>`. Find the matching `</row>`.
        if let Some(close_rel) = text[open_end..].find("</row>") {
            let close_idx = open_end + close_rel;
            let mut out = String::with_capacity(text.len() + new_cell.len());
            out.push_str(&text[..close_idx]);
            out.push_str(&new_cell);
            out.push_str(&text[close_idx..]);
            return Ok(out);
        }
        return Err(XlsxError::Export(
            "worksheet xml: <row> opening without matching </row>".to_string(),
        ));
    }

    // Case 2: no `<row r="K">` — synthesize one and insert into
    // `<sheetData>` in row-sorted position.
    //
    // **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** the prior W5-D-15.2
    // version inserted at the END of `<sheetData>` regardless of row
    // order. OOXML schema requires `<row>` elements in ascending `r`
    // order. Excel tolerates non-sorted rows on open but emits a
    // repair dialog on save. Now we scan for the first existing
    // `<row r="L">` where L > K and inject the new row BEFORE it.
    // Fall through to before `</sheetData>` only if no such row
    // exists (all existing rows have r ≤ K).
    let new_row = format!(r#"<row r="{}">{}</row>"#, row_number, new_cell);
    if let Some(insert_before) = find_row_insertion_point(&text, row_number) {
        let mut out = String::with_capacity(text.len() + new_row.len());
        out.push_str(&text[..insert_before]);
        out.push_str(&new_row);
        out.push_str(&text[insert_before..]);
        return Ok(out);
    }
    if let Some(close_idx) = text.rfind("</sheetData>") {
        let mut out = String::with_capacity(text.len() + new_row.len());
        out.push_str(&text[..close_idx]);
        out.push_str(&new_row);
        out.push_str(&text[close_idx..]);
        return Ok(out);
    }
    // `<sheetData/>` self-closing — replace with the long form.
    if let Some(idx) = text.find("<sheetData/>") {
        let mut out = String::with_capacity(text.len() + new_row.len() + 16);
        out.push_str(&text[..idx]);
        out.push_str("<sheetData>");
        out.push_str(&new_row);
        out.push_str("</sheetData>");
        out.push_str(&text[idx + "<sheetData/>".len()..]);
        return Ok(out);
    }

    Err(XlsxError::Export(
        "worksheet xml: missing <sheetData> — cannot inject style-only cell".to_string(),
    ))
}

/// **W5-D-PM-1 (megaudit Codex HIGH-3 closure):** scan a worksheet
/// xml for the first `<row r="L">` where L > `target_row`. Returns
/// the byte index where a new `<row r="target_row">` should be
/// inserted to preserve ascending row order. Returns `None` if no
/// such row exists (caller falls through to inserting before
/// `</sheetData>`).
fn find_row_insertion_point(text: &str, target_row: u32) -> Option<usize> {
    // Walk for every `<row r="N"` occurrence; pick the first N > target_row.
    let mut cursor = 0;
    while let Some(rel) = text[cursor..].find("<row r=\"") {
        let start = cursor + rel;
        let after = start + "<row r=\"".len();
        // Find closing `"`.
        let close_quote = text[after..].find('"')?;
        let n_str = &text[after..after + close_quote];
        if let Ok(n) = n_str.parse::<u32>() {
            if n > target_row {
                return Some(start);
            }
        }
        cursor = after + close_quote;
    }
    None
}

/// Parse the row number from an A1-style cell ref (e.g. `"BC42"` → `42`).
fn parse_row_number_from_ref(cell_ref: &str) -> Option<u32> {
    let bytes = cell_ref.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i == 0 || i == bytes.len() {
        return None;
    }
    cell_ref[i..].parse::<u32>().ok().filter(|n| *n > 0)
}

fn inject_date1904_into_workbook_xml(content: Vec<u8>) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)

exec
/bin/zsh -lc "sed -n '1060,1175p' quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    // Case 1: existing <numFmts> — replace it entirely. (Unlikely
    // since umya doesn't emit any, but handle defensively.)
    //
    // **W5-D-14.2.3 (separate-Opus M-1 closure):** check the
    // non-self-closing `</numFmts>` form FIRST. The self-close `/>`
    // search runs over the FULL remainder of the document, so if
    // `<numFmts>` has self-closing children (`<numFmt ../>`), the
    // `find("/>")` would match the CHILD's `/>` and truncate at the
    // wrong place. Closing-tag form lets us cleanly bracket the
    // outer element.
    if let Some(start) = text.find("<numFmts") {
        let after = start + "<numFmts".len();
        if let Some(close_rel) = text[after..].find("</numFmts>") {
            let end = after + close_rel + "</numFmts>".len();
            let mut out = String::with_capacity(text.len() + numfmts.len());
            out.push_str(&text[..start]);
            out.push_str(&numfmts);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        // Truly self-closing `<numFmts ... />` form: find the FIRST
        // `>` after the tag name and require the preceding byte to be
        // `/`. That bounds the search to the actual element close.
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + numfmts.len());
                out.push_str(&text[..start]);
                out.push_str(&numfmts);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }

    // Case 2: insert after the <styleSheet ...> opening tag.
    if let Some(opening) = text.find("<styleSheet") {
        let end_of_opening = text[opening..]
            .find('>')
            .map(|i| opening + i + 1)
            .ok_or_else(|| {
                XlsxError::Export("styles.xml has malformed <styleSheet>".to_string())
            })?;
        let mut out = String::with_capacity(text.len() + numfmts.len());
        out.push_str(&text[..end_of_opening]);
        out.push_str(&numfmts);
        out.push_str(&text[end_of_opening..]);
        return Ok(out.into_bytes());
    }

    Err(XlsxError::Export(
        "styles.xml missing <styleSheet> root element".to_string(),
    ))
}

/// **W5-D-15 (XLSX-4-03 per-cell format closure):** replace umya's
/// default `<cellXfs>` block with one that enumerates every FormatId
/// referenced by any cell. Slot 0 is the default xf (numFmtId=0, no
/// applyNumberFormat); slots 1..N follow the `cellxfs_roster` order
/// (which matches the `xf_index` values minted at the cell-fix
/// collection site so `<c s="N">` round-trips correctly).
///
/// **Phase 5.2 D-1 step 6 (2026-05-20):** `cellxfs_roster` now carries
/// `(FormatId, xlsx_numFmtId)` pairs — the numFmtId is pre-translated
/// by `XlsxNumFmtTranslation` at the caller. This drops the pre-step-6
/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
/// flatten correctly through the translation.
fn inject_cell_xfs_into_styles_xml(
    content: Vec<u8>,
    cellxfs_roster: &[(FormatId, u32)],
) -> Result<Vec<u8>, XlsxError> {
    let text = String::from_utf8(content)
        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;

    let count = cellxfs_roster.len() + 1;
    let mut block = String::with_capacity(64 * count);
    block.push_str(&format!(r#"<cellXfs count="{}">"#, count));
    // Slot 0: default xf.
    block.push_str(r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#);
    for (_fid, xlsx_num_fmt_id) in cellxfs_roster {
        block.push_str(&format!(
            concat!(
                r#"<xf numFmtId="{}" fontId="0" fillId="0" borderId="0" xfId="0" "#,
                r#"applyNumberFormat="1"/>"#,
            ),
            xlsx_num_fmt_id,
        ));
    }
    block.push_str("</cellXfs>");

    // Case 1: existing <cellXfs> — replace. Closing-tag form first.
    if let Some(start) = text.find("<cellXfs") {
        let after = start + "<cellXfs".len();
        if let Some(close_rel) = text[after..].find("</cellXfs>") {
            let end = after + close_rel + "</cellXfs>".len();
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(&block);
            out.push_str(&text[end..]);
            return Ok(out.into_bytes());
        }
        if let Some(gt_rel) = text[after..].find('>') {
            let end = after + gt_rel + 1;
            if text[after..end].ends_with("/>") {
                let mut out = String::with_capacity(text.len() + block.len());
                out.push_str(&text[..start]);
                out.push_str(&block);
                out.push_str(&text[end..]);
                return Ok(out.into_bytes());
            }
        }
    }

    // Case 2: no existing <cellXfs> — insert at the end of styleSheet
    // (before </styleSheet>). umya always emits a cellXfs block so
    // this path is defensive only.

exec
/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates quantbook-engine/ql*" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 exited 1 in 0ms:
zsh:1: no matches found: quantbook-engine/ql*

exec
/bin/zsh -lc 'git show --unified=80 --find-renames 19f6aa1b008 -- quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
commit 19f6aa1b00884d68782ded9aacd77f8d3d1f7f83
Author: steppen0mad <nurtaymergaliyev@gmail.com>
Date:   Wed May 20 03:29:13 2026 +0100

    Phase 5.2 D-1 step 6 — xlsx FormatId↔numFmtId mapping (multi-peer aware)
    
    xlsx has a single-u32 numFmtId namespace; .qbook FormatId is peer-aware.
    Step 6 reconciles this asymmetry on export by flattening Custom variants
    into a contiguous numFmtId range starting at 164 (sorted by FormatId's
    derived Ord). On import, every numFmtId becomes Custom(LEGACY_PEER, _)
    via legacy_from_u32 (xlsx has no peer concept to recover) — already
    correct from step 3.
    
    New helper: XlsxNumFmtTranslation in umya_export.rs.
    - Builtin(n) → n (canonical xlsx id, no flattening).
    - Custom(_, _) → sequential xlsx numFmtId starting at FIRST_CUSTOM_FORMAT_ID = 164.
    - Translation built over UNION(wb.formats(), cellxfs_roster) Customs.
    - Tracks non-LEGACY peer flattens in info_lost vec.
    
    Per the no-fallback rule: non-LEGACY peer flattens are reported via
    XlsxExportReport.dropped_features with UnsupportedFeatureKind::Other
    ("multi-peer-format-id-flatten"). The xlsx output is correct; the
    information loss is intrinsic to the xlsx format; explicit reporting
    is the right discipline.
    
    Byte-stability for LEGACY_PEER-only workbooks (single-writer pre-D-1
    default) is preserved: sorted Custom ids are in counter order, so the
    allocator produces Custom(LEGACY_PEER, c) → c + 164 — identical to
    the pre-step-6 to_legacy_u32() output. All existing xlsx round-trip
    tests pass unchanged.
    
    Changes:
    - crates/ql-io-xlsx/src/write/umya_export.rs:
      - New struct XlsxNumFmtTranslation { custom_map, info_lost } with
        build(workbook, cellxfs_roster) + translate(fid) -> u32.
      - 3 sites updated to use the translation, dropping the pre-step-6
        `to_legacy_u32().expect("pre-step-6 ...")` panics:
        - Overlay sort key (sort_by_key uses translation).
        - custom_formats roster (walks wb.formats() Customs).
        - cellXfs roster (now carries (FormatId, u32) tuples).
      - post_process_zip + inject_cell_xfs_into_styles_xml signature
        changed from &[FormatId] to &[(FormatId, u32)].
      - XlsxExportReport.dropped_features populated with multi-peer
        flatten entries.
    - crates/ql-io-xlsx/tests/calamine_smoke.rs:
      - step6_multi_peer_format_ids_flatten_and_report_on_xlsx_export:
        constructs Workbook with PeerId(42), PeerId(99), LEGACY_PEER
        Custom ids; verifies export succeeds (was panic pre-step-6) +
        report carries 2 multi-peer flatten entries + round-trip preserves
        format codes (collapsed to LEGACY_PEER on reimport).
      - step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged:
        verifies LEGACY_PEER-only workbooks produce 0 multi-peer flatten
        entries (byte-stability sanity check).
    - crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:
      - Updated misleading "pre-step-6 xlsx test sees only legacy FormatId"
        expect message to reflect post-step-6 reality (xlsx import always
        produces LEGACY_PEER customs via legacy_from_u32).
    
    Gates: 4272 workspace tests passing (+2 from step 6). fmt + clippy clean.
    
    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

diff --git a/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs b/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
index ae04424517e..0894e960231 100644
--- a/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
+++ b/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs
@@ -1,508 +1,646 @@
 //! umya-spreadsheet writer — `NewWorkbook` mode.
 //!
 //! Post-W5-D-15.2 / megaudit closure, this module covers:
 //! - Sheets, cell values (Number / Boolean / Text / Error), formula
 //!   text + cached values.
 //! - Tables export (xl/tables/table*.xml + sheet rels + Content_Types).
 //! - Custom format codes export (xl/styles.xml/<numFmts>) +
 //!   per-cell format APPLICATION (cellXfs + s="N").
 //! - Workbook-scoped + sheet-scoped named ranges (definedNames).
 //! - Atomic write-then-rename for concurrent-safe output.
 //! - umya 2.2.0 bug workarounds (t="str" on numeric/boolean/error
 //!   formula cells, hardcoded #VALUE! sigil, missing date1904 attr).
 //!
 //! Companion: `update_original` for the `ExportMode::UpdateOriginal`
 //! path. Deferred to v2: rels-graph merge + sheet-inline-anchor
 //! merge (CF / DV / mergeCells / hyperlinks preservation) — see
 //! `update_original.rs` module doc for rationale.
 
 use crate::error::XlsxError;
 use crate::options::FormulaCachePolicy;
 use crate::report::XlsxExportReport;
-use ql_storage::{FormatId, NamedTarget, Workbook};
-use ql_types::Value;
+use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
+use ql_types::{Value, LEGACY_PEER};
 
 /// Per-cell fix instruction. **W5-D-14.1 umya-bug workaround:** umya
 /// 2.2.0 has two correctness bugs we patch via post-process on output:
 /// 1. Formula cells write `t="str"` even when the cached value is
 ///    numeric/boolean (umya's `get_data_type_crate` returns "str"
 ///    for any cell with a formula, regardless of `raw_value` type).
 /// 2. Error cells hardcode `#VALUE!` as the OOXML `<v>` content
 ///    regardless of the actual `CellErrorType` variant
 ///    (umya `worksheet.rs:524-526` hardcodes the sigil).
 #[derive(Debug, Clone)]
 struct CellFix {
     /// A1-style cell reference, e.g. `"C5"`.
     cell_ref: String,
     /// What to patch.
     kind: CellFixKind,
 }
 
 #[derive(Debug, Clone)]
 enum CellFixKind {
     /// Remove the `t="str"` attribute from this cell. Used for
     /// formula cells whose cached value is numeric. After removal
     /// the cell has default type "n".
     RemoveStrType,
     /// Replace the hardcoded `#VALUE!` sigil with the actual error
     /// sigil. Used only for non-formula error cells (umya emits
     /// `<c r="A1" t="e"><v>#VALUE!</v></c>` regardless of the
     /// actual error variant).
     OverrideErrorSigil(&'static str),
     /// **W5-D-15:** inject `s="N"` into the cell's opening tag.
     /// `N` is the cellXfs index.
     SetStyle(u32),
     /// **W5-D-PM-1 (megaudit Codex HIGH-2 / Opus-A HIGH-1 closure):**
     /// rewrite `t="str"` → `t="e"` on a formula cell whose cached
     /// value is `Value::Error`. umya emits all formula cells with
     /// `t="str"` regardless of cached-value type; for Number/Boolean
     /// we rely on `RemoveStrType` to drop the attr (default "n"
     /// covers both). For Error, the default "n" is wrong — we need
     /// `t="e"` so the consumer parses the `<v>{sigil}</v>` as an
     /// error type, not a string.
     ConvertFormulaToErrorType,
     /// **W5-D-PM-1 (megaudit Codex HIGH-1 closure):** rewrite
     /// `t="str"` → `t="b"` AND `<v>TRUE</v>` / `<v>FALSE</v>` →
     /// `<v>1</v>` / `<v>0</v>` on a formula cell with Boolean
     /// cached value. OOXML wants boolean cells with `t="b"` and
     /// `<v>1|0</v>`.
     ConvertFormulaToBoolType(bool),
 }
 
 /// Convert (col, row) (both 0-indexed) to an A1-style ref.
 fn cell_ref_a1(row: u32, col: u32) -> String {
     let mut name = String::new();
     let mut c = col + 1; // 1-indexed for the bijective base-26 conversion
     while c > 0 {
         let rem = (c - 1) % 26;
         name.insert(0, (b'A' + rem as u8) as char);
         c = (c - 1) / 26;
     }
     name.push_str(&(row + 1).to_string());
     name
 }
 
+/// **Phase 5.2 D-1 step 6 (2026-05-20):** xlsx single-namespace
+/// numFmtId translation. xlsx's `numFmtId` is a single `u32` namespace
+/// — no peer-id concept. `FormatId::Custom(peer, counter)` variants
+/// from multi-peer `.qbook` workbooks must flatten to a single
+/// contiguous range on export.
+///
+/// **Translation:**
+/// - `Builtin(n)` → `n` (canonical xlsx built-in id; no flattening).
+/// - `Custom(_, _)` → sequential xlsx numFmtId starting at
+///   `FIRST_CUSTOM_FORMAT_ID = 164`. Order is deterministic: sorted
+///   by `FormatId`'s derived `Ord` (Builtin sorts before Custom; within
+///   Custom, by `(peer, counter)`).
+///
+/// **Byte-stability:** for the LEGACY_PEER-only case (single-writer
+/// pre-D-1 default), sorted Custom ids are in counter order, so the
+/// allocator produces `Custom(LEGACY_PEER, c) → c + 164` — identical
+/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
+/// round-trip tests round-trip byte-identically.
+///
+/// **Information loss reporting:** non-LEGACY peer ids round-trip
+/// CORRECTLY through xlsx, but reimporting an xlsx export collapses
+/// them to `Custom(LEGACY_PEER, _)` (the legacy_from_u32 path —
+/// xlsx has no peer concept to recover). The flattened ids are
+/// recorded in `info_lost` so the export caller can surface them via
+/// `XlsxExportReport.dropped_features`. Per the no-fallbacks doctrine,
+/// the loss is reported rather than silently absorbed.
+struct XlsxNumFmtTranslation {
+    /// `Custom(peer, counter) → flattened xlsx numFmtId`. Builtin
+    /// variants are NOT in this map — the translator returns `n`
+    /// directly for `Builtin(n)`.
+    custom_map: std::collections::HashMap<FormatId, u32>,
+    /// `(original Custom FormatId, flattened xlsx numFmtId)` for any
+    /// Custom whose peer ≠ LEGACY_PEER. These are the lossy entries
+    /// from the round-trip perspective: xlsx → .qbook recovery
+    /// produces `Custom(LEGACY_PEER, _)`, losing the original peer id.
+    /// Caller surfaces via `XlsxExportReport.dropped_features`.
+    info_lost: Vec<(FormatId, u32)>,
+}
+
+impl XlsxNumFmtTranslation {
+    /// Build the translation over all Custom FormatIds the export will
+    /// reference. The union of:
+    /// - `workbook.formats()` Custom entries (the format-table roster
+    ///   used by the `<numFmts>` injection).
+    /// - `cellxfs_roster` Custom entries (overlay-used FormatIds; these
+    ///   may include Customs not in the format table if the overlay was
+    ///   set without first registering via `intern`, though this is
+    ///   pathological).
+    ///
+    /// Deterministic ordering via `BTreeSet<FormatId>`.
+    fn build(workbook: &Workbook, cellxfs_roster: &[FormatId]) -> Self {
+        let mut customs: std::collections::BTreeSet<FormatId> = std::collections::BTreeSet::new();
+        for (id, _) in workbook.formats().iter() {
+            if id.is_custom() {
+                customs.insert(id);
+            }
+        }
+        for fid in cellxfs_roster {
+            if fid.is_custom() {
+                customs.insert(*fid);
+            }
+        }
+        let mut custom_map = std::collections::HashMap::new();
+        let mut info_lost = Vec::new();
+        let mut next = FIRST_CUSTOM_FORMAT_ID;
+        for fid in customs {
+            let xlsx_id = next;
+            // Step-5 audit Codex M1 lesson: checked_add guards
+            // overflow even on programmer-controlled paths. With
+            // u32::MAX - 164 = ~4.3 billion custom formats this fires
+            // truly never, but the explicit check documents intent.
+            next = next
+                .checked_add(1)
+                .expect("xlsx custom numFmtId allocator exhausted (u32::MAX entries)");
+            custom_map.insert(fid, xlsx_id);
+            if let FormatId::Custom(peer, _) = fid {
+                if peer != LEGACY_PEER {
+                    info_lost.push((fid, xlsx_id));
+                }
+            }
+        }
+        Self {
+            custom_map,
+            info_lost,
+        }
+    }
+
+    /// Translate `FormatId → xlsx numFmtId`. `Builtin(n)` returns `n`
+    /// directly (canonical xlsx id, never needs flattening). `Custom`
+    /// looks up the flattened id from the map.
+    ///
+    /// **Invariant:** the FormatId MUST be in the translation's scope
+    /// — either registered in `workbook.formats()` or present in the
+    /// `cellxfs_roster` the translation was built over. Callers in this
+    /// file query subsets of those two sets, so the lookup never misses
+    /// in practice. The expect documents this invariant rather than
+    /// being a real panic path.
+    fn translate(&self, fid: FormatId) -> u32 {
+        match fid {
+            FormatId::Builtin(n) => n,
+            FormatId::Custom(_, _) => *self.custom_map.get(&fid).unwrap_or_else(|| {
+                panic!(
+                    "xlsx numFmt translation: unmapped Custom FormatId {fid:?}; \
+                     build() must include this id (programmer error in umya_export.rs)"
+                )
+            }),
+        }
+    }
+}
+
 /// Export a Quantbook `Workbook` to an xlsx file via umya-spreadsheet
 /// in `NewWorkbook` mode (generate fresh).
 pub(crate) fn export_new_workbook(
     workbook: &Workbook,
     output_path: &std::path::Path,
     formula_cache: FormulaCachePolicy,
 ) -> Result<XlsxExportReport, XlsxError> {
     let mut report = XlsxExportReport::default();
     let mut spreadsheet = umya_spreadsheet::new_file_empty_worksheet();
 
     // Build a quick lookup from (sheet, row, col) → formula text so
     // the per-cell loop can decide whether to write a formula or a
     // value. The `iter_formulas` API gives us only formula-bearing
     // cells; cells without formulas just get the value-only path.
     let mut formula_map: std::collections::HashMap<(u16, u32, u32), String> =
         std::collections::HashMap::new();
     for (sheet, row, col, text) in workbook.iter_formulas() {
         formula_map.insert((sheet, row, col), text.to_string());
     }
 
     // **W5-D-14.1 umya-bug workaround**: track per-cell fixes by
     // sheet ORDER INDEX (which matches the OOXML sheet1.xml, sheet2.xml
     // numbering for fresh-generated workbooks).
     let mut sheet_fixes: Vec<Vec<CellFix>> = Vec::with_capacity(workbook.sheet_count());
 
     // **W5-D-15:** build a `FormatId → xf_index` dedup map. Index 0
     // is reserved for the default xf (numFmtId=0, no applyNumberFormat).
     // First custom xf gets index 1, next gets 2, etc.
     //
     // **W5-D-15.2 (separate-Opus M-4 closure):** pre-compute the
     // roster across ALL sheets in a single sweep so the order is a
     // function of the set of FormatIds, not of which sheet first
     // touched them. Sort by `FormatId` for byte determinism — the
     // per-sheet intra-sort from W5-D-15.1 fixes intra-sheet but
     // doesn't bound cross-sheet contribution order. BTreeSet handles
     // both at once.
     let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
         std::collections::BTreeSet::new();
     for sheet_id in 0..workbook.sheet_count() as u16 {
         if let Some(sheet) = workbook.sheet(sheet_id) {
             for (_addr, fid) in sheet.format_overlay().iter() {
                 sorted_format_ids.insert(fid);
             }
         }
     }
     let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
     let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
         .iter()
         .enumerate()
         .map(|(i, fid)| (*fid, (i as u32) + 1)) // slot 0 reserved for default
         .collect();
 
+    // **Phase 5.2 D-1 step 6 (2026-05-20):** build the xlsx numFmtId
+    // translation. Maps every Custom FormatId (across both wb.formats()
+    // and overlays) to a flattened sequential numFmtId starting at 164.
+    // Builtins are translated inline by the helper. info_lost surfaces
+    // non-LEGACY peer flattens to XlsxExportReport.dropped_features
+    // below.
+    let xlsx_numfmt = XlsxNumFmtTranslation::build(workbook, &cellxfs_roster);
+    for (orig_fid, flattened_id) in &xlsx_numfmt.info_lost {
+        report
+            .dropped_features
+            .push(crate::report::UnsupportedFeature {
+                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
+                part: "xl/styles.xml".to_string(),
+                detail: format!(
+                    "Custom format id {orig_fid:?} flattened to xlsx numFmtId {flattened_id} \
+                     (xlsx single-namespace; reimporting recovers as Custom(LEGACY_PEER, _))"
+                ),
+            });
+    }
+
     let sheet_count = workbook.sheet_count();
     for sheet_id in 0..sheet_count as u16 {
         let mut fixes: Vec<CellFix> = Vec::new();
         let sheet = workbook
             .sheet(sheet_id)
             .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
         let sheet_name = sheet.name().to_string();
 
         // `new_file_empty_worksheet` returns a spreadsheet with no
         // sheets; add each sheet by name. For the first sheet we'd
         // normally also rename the default, but the empty-file
         // variant doesn't have a default sheet, so add fresh.
         spreadsheet
             .new_sheet(&sheet_name)
             .map_err(|e| XlsxError::Export(format!("umya new_sheet({sheet_name}) failed: {e}")))?;
 
         let bounds = sheet.bounds();
         // **W5-D-15.1 (Codex audit HIGH-3 closure):** the prior code
         // `continue`-d for empty-bounds sheets, skipping the
         // `sheet_fixes.push(fixes)` at end of loop. That misaligned
         // the per-sheet fixes vector for any subsequent non-empty
         // sheet — sheet N's fixes landed on sheet N-1's xml. Now the
         // cell-walk is gated on non-empty bounds; format-overlay
         // scheduling + `sheet_fixes.push` run unconditionally.
         let has_cells_to_walk = bounds.row_extent > 0 && bounds.col_extent > 0;
         if has_cells_to_walk {
             let ws = spreadsheet
                 .get_sheet_by_name_mut(&sheet_name)
                 .ok_or_else(|| {
                     XlsxError::Export(format!(
                         "umya sheet {sheet_name} disappeared after new_sheet"
                     ))
                 })?;
             for row in 0..bounds.row_extent {
                 for col in 0..bounds.col_extent {
                     let value = sheet.read(row, col);
                     let formula = formula_map.get(&(sheet_id, row, col));
 
                     let umya_col = col + 1;
                     let umya_row = row + 1;
 
                     match (formula, &value) {
                         (Some(formula_text), val) => {
                             // **W5-D-14.1 (audit HIGH-1 closure — phase
                             // 1):** umya's `set_value_*` setters internally
                             // call `remove_formula()`, so we apply the
                             // value FIRST then call `set_formula` (which
                             // doesn't touch the raw value).
                             let cell = ws.get_cell_mut((umya_col, umya_row));
                             let cache_written = if formula_cache
                                 == FormulaCachePolicy::WriteRecomputed
                                 && !matches!(val, Value::Blank)
                             {
                                 apply_value_to_cell(cell, val);
                                 true
                             } else {
                                 false
                             };
                             cell.set_formula(formula_text.as_str());
                             if cache_written {
                                 report.formula_caches_written += 1;
                             }
                             // **W5-D-14.1 (audit HIGH-1 closure — phase 2):**
                             // umya's writer sets `t="str"` on any formula
                             // cell (`cell_value.rs::get_data_type_crate`
                             // returns "str" for Some(formula) regardless
                             // of raw_value type). Calamine then reads the
                             // `<v>` content as text. Schedule a post-
                             // process fix: remove `t="str"` for cells
                             // whose cached value is numeric/boolean (the
                             // default cell type "n" lets calamine restore
                             // the number).
                             // RemoveStrType handles formula cells with Number
                             // cached values (default cell type "n" round-trips).
                             // Boolean / Error formula cells need DIFFERENT
                             // post-process patches because the default "n"
                             // would still misread the value.
                             if cache_written {
                                 match val {
                                     Value::Number(_) => {
                                         fixes.push(CellFix {
                                             cell_ref: cell_ref_a1(row, col),
                                             kind: CellFixKind::RemoveStrType,
                                         });
                                     }
                                     // **W5-D-PM-1 (Codex HIGH-1 closure):**
                                     // boolean formula cache — rewrite
                                     // `t="str"` → `t="b"` AND `<v>TRUE</v>`
                                     // / `<v>FALSE</v>` → `<v>1</v>` /
                                     // `<v>0</v>`. Without this the cell
                                     // round-trips as text "TRUE"/"FALSE".
                                     Value::Boolean(b) => {
                                         fixes.push(CellFix {
                                             cell_ref: cell_ref_a1(row, col),
                                             kind: CellFixKind::ConvertFormulaToBoolType(*b),
                                         });
                                     }
                                     // **W5-D-PM-1 (Codex HIGH-2 / Opus-A
                                     // HIGH-1 closure):** error formula
                                     // cache — rewrite `t="str"` → `t="e"`.
                                     // The sigil in `<v>` is already correct
                                     // (umya passes our value through). 10 %
                                     // of corpus impacted before the fix.
                                     Value::Error(_) => {
                                         fixes.push(CellFix {
                                             cell_ref: cell_ref_a1(row, col),
                                             kind: CellFixKind::ConvertFormulaToErrorType,
                                         });
                                     }
                                     _ => {}
                                 }
                             }
                         }
                         (None, Value::Blank) => {
                             // Skip blank cells (no formula, no value).
                         }
                         (None, val) => {
                             let cell = ws.get_cell_mut((umya_col, umya_row));
                             apply_value_to_cell(cell, val);
                             // **W5-D-14.1 (audit HIGH-6 closure):** umya
                             // hardcodes `#VALUE!` for any error cell.
                             // Schedule the actual sigil patch.
                             if let Value::Error(e) = val {
                                 fixes.push(CellFix {
                                     cell_ref: cell_ref_a1(row, col),
                                     kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                                 });
                             }
                         }
                     }
                     if !matches!(value, Value::Blank) || formula.is_some() {
                         report.cells_written += 1;
                     }
                 }
             }
         } // end `if has_cells_to_walk`
 
         // **W5-D-15:** schedule `s="N"` fixes for every cell with a
         // format overlay entry. MUST run AFTER the cell-walk fixes
         // (RemoveStrType / OverrideErrorSigil) so their needles —
         // which match on the literal `<c r="..." t="..."` prefix —
         // aren't disrupted by an inserted `s="..."` attribute.
         //
         // **W5-D-15.1 (self-audit H-3 closure):** the prior version
         // walked `format_overlay().iter()` directly — HashMap
         // iteration order, which is non-deterministic. The
         // `cellxfs_roster` order (and therefore every cell's emitted
         // `s="N"`) varied run-to-run. Now we sort entries by
         // (FormatId, row, col) so the roster is byte-stable across
         // runs and the per-cell `s="N"` values are deterministic.
         let sheet_view = workbook
             .sheet(sheet_id)
             .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
         let mut overlay_entries: Vec<((u32, u32), FormatId)> =
             sheet_view.format_overlay().iter().collect();
-        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
-        // pre-step-3 `.0` field). Non-LEGACY peer ids can't yet appear
-        // here (step 6 will handle multi-peer xlsx export); expect()
-        // makes the invariant load-bearing for step 6.
-        overlay_entries.sort_by_key(|a| {
-            (
-                a.1.to_legacy_u32()
-                    .expect("pre-step-6 xlsx export sees only legacy FormatId"),
-                a.0 .0,
-                a.0 .1,
-            )
-        });
+        // Phase 5.2 D-1 step 6 (2026-05-20): sort by the xlsx-flattened
+        // numFmtId (via the translation built above) + (row, col). The
+        // pre-step-6 expect() on `to_legacy_u32()` panicked on
+        // non-LEGACY peer Custom ids; the translation handles them
+        // by flattening into a single namespace. For LEGACY_PEER-only
+        // workbooks (single-writer pre-D-1 default) the sort key
+        // values are identical, so byte-stable output is preserved
+        // for existing xlsx fixtures.
+        overlay_entries.sort_by_key(|a| (xlsx_numfmt.translate(a.1), a.0 .0, a.0 .1));
 
         for ((row, col), fid) in overlay_entries {
             let xf_index = match format_to_xf_index.get(&fid) {
                 Some(idx) => *idx,
                 None => continue, // unreachable — roster pre-populated for all FormatIds
             };
             fixes.push(CellFix {
                 cell_ref: cell_ref_a1(row, col),
                 kind: CellFixKind::SetStyle(xf_index),
             });
         }
         sheet_fixes.push(fixes);
     }
 
     // Persist to disk.
     umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
         .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;
 
     // **W5-D-14.1 unified post-process pass:** apply workarounds for
     // umya 2.2.0 bugs and limitations. Patches applied:
     //
     // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` (HIGH-2).
     // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` (HIGH-1).
     // 3. `xl/worksheets/sheet{N}.xml`: error sigil sub (HIGH-6).
     // 4. `xl/styles.xml`: inject `<numFmts>` for custom format codes
     //    (HIGH-5 closure — umya doesn't write the custom-format roster).
     // 5. `xl/workbook.xml`: inject `<definedNames>` for workbook +
     //    sheet-scoped names (HIGH-4 closure — names export side).
     // 6. `xl/tables/table{N}.xml` + sheet rels + Content_Types + sheet
     //    `<tableParts>`: write Quantbook tables (HIGH-3 closure).
     let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
     let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());
 
     // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
-    // Phase 5.2 D-1 step 3: `is_custom()` replaces the pre-step-3
-    // `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter. xlsx export sees only
-    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
-    // returns Some; the expect() makes the invariant load-bearing
-    // for step 6 (multi-peer xlsx export).
+    // Phase 5.2 D-1 step 6 (2026-05-20): use the xlsx numFmt translation
+    // (built above over `wb.formats() + cellxfs_roster` Customs). For
+    // LEGACY_PEER-only workbooks the translated numFmtIds match the
+    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
+    // FormatIds get flattened to the contiguous range with reporting.
     let custom_formats: Vec<(u32, String)> = workbook
         .formats()
         .iter()
         .filter_map(|(id, code)| {
             if id.is_custom() {
-                Some((
-                    id.to_legacy_u32()
-                        .expect("pre-step-6 xlsx export sees only legacy FormatId"),
-                    code.to_string(),
-                ))
+                Some((xlsx_numfmt.translate(id), code.to_string()))
             } else {
                 None
             }
         })
         .collect();
 
     // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
     // scoped + sheet-scoped names. Each is rendered as the OOXML
     // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
     let defined_names = collect_defined_names(workbook)?;
 
     // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
     // `report.dropped_features` with names that couldn't be rendered
     // (Constant(Error)/Constant(Blank) targets). `collect_defined_names`
     // silently drops these; without this surfacing, NewWorkbook
     // Strict mode never fires for them.
     let dropped_named_count = count_undeserializable_names(workbook);
     for _ in 0..dropped_named_count {
         report
             .dropped_features
             .push(crate::report::UnsupportedFeature {
                 kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
                 part: "xl/workbook.xml".to_string(),
                 detail: "named range with Error/Blank constant target cannot \
                          serialize to OOXML formula text"
                     .to_string(),
             });
     }
 
     // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
     // their own `xl/tables/table{N}.xml` parts AND require updates to
     // sheet rels + worksheet `<tableParts>` + `[Content_Types].xml`.
     let tables = collect_table_exports(workbook);
 
+    // Phase 5.2 D-1 step 6: pre-translate the cellxfs roster into
+    // (FormatId, xlsx_numFmtId) pairs so post-process doesn't need
+    // the translation helper. For each FormatId in the roster, look
+    // up its flattened numFmtId. Pre-step-6 the inject site computed
+    // `fid.to_legacy_u32().expect()` inline; now that translation is
+    // explicit + multi-peer aware.
+    let cellxfs_roster_translated: Vec<(FormatId, u32)> = cellxfs_roster
+        .iter()
+        .map(|&fid| (fid, xlsx_numfmt.translate(fid)))
+        .collect();
+
     let needs_post_process = needs_date1904
         || needs_cell_fixes
         || !custom_formats.is_empty()
         || !defined_names.is_empty()
         || !tables.is_empty()
-        || !cellxfs_roster.is_empty();
+        || !cellxfs_roster_translated.is_empty();
     if needs_post_process {
         post_process_zip(
             output_path,
             needs_date1904,
             &sheet_fixes,
             &custom_formats,
             &defined_names,
             &tables,
-            &cellxfs_roster,
+            &cellxfs_roster_translated,
         )?;
     }
 
     Ok(report)
 }
 
 /// Unified post-process pass over the just-written xlsx. Applies all
 /// workarounds and roster injections in a single zip walk:
 /// - `xl/workbook.xml`: inject `date1904="1"` + `<definedNames>`.
 /// - `xl/worksheets/sheet{N}.xml`: per-cell fixes (HIGH-1 / HIGH-6) +
 ///   `<tableParts>` references for tables anchored to that sheet.
 /// - `xl/styles.xml`: inject `<numFmts>` for custom format codes.
 /// - `xl/tables/table{N}.xml`: NEW parts for each Quantbook table.
 /// - `xl/worksheets/_rels/sheet{N}.xml.rels`: rel entries pointing
 ///   into the table parts.
 /// - `[Content_Types].xml`: `Override` entries for the new table parts.
 ///
 /// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
 /// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
 fn post_process_zip(
     path: &std::path::Path,
     inject_date1904: bool,
     sheet_fixes: &[Vec<CellFix>],
     custom_formats: &[(u32, String)],
     defined_names: &[DefinedNameOut],
     tables: &[TableExport],
-    cellxfs_roster: &[FormatId],
+    // Phase 5.2 D-1 step 6: each entry is (FormatId, xlsx numFmtId).
+    // The numFmtId comes from XlsxNumFmtTranslation; the FormatId is
+    // kept alongside for the format_to_xf_index lookup that maps cells
+    // to their roster slot.
+    cellxfs_roster: &[(FormatId, u32)],
 ) -> Result<(), XlsxError> {
     use std::io::{Read, Write};
 
     // Pre-compute per-sheet table groupings: for each Quantbook
     // sheet index, the table ids anchored there. Used to emit
     // `<tableParts>` in the worksheet xml + rels.
     let mut tables_by_sheet: std::collections::HashMap<usize, Vec<&TableExport>> =
         std::collections::HashMap::new();
     for t in tables {
         tables_by_sheet.entry(t.sheet_idx).or_default().push(t);
     }
 
     let bytes = std::fs::read(path)?;
     let mut reader =
         zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(XlsxError::Zip)?;
     let mut out_buf: Vec<u8> = Vec::new();
     let mut existing_names: std::collections::HashSet<String> = std::collections::HashSet::new();
     {
         let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
         for i in 0..reader.len() {
             let mut entry = reader.by_index(i).map_err(XlsxError::Zip)?;
             let name = entry.name().to_string();
             existing_names.insert(name.clone());
             let mut content = Vec::new();
             entry.read_to_end(&mut content)?;
             if name == "xl/workbook.xml" {
                 if inject_date1904 {
                     content = inject_date1904_into_workbook_xml(content)?;
                 }
                 if !defined_names.is_empty() {
                     content = inject_defined_names_into_workbook_xml(content, defined_names)?;
                 }
             } else if name == "xl/styles.xml" {
                 if !custom_formats.is_empty() {
                     content = inject_custom_formats_into_styles_xml(content, custom_formats)?;
                 }
                 if !cellxfs_roster.is_empty() {
                     content = inject_cell_xfs_into_styles_xml(content, cellxfs_roster)?;
                 }
             } else if name == "[Content_Types].xml" && !tables.is_empty() {
                 content = inject_table_overrides_into_content_types(content, tables)?;
             } else if let Some(sheet_idx) = sheet_index_from_path(&name) {
                 if let Some(fixes) = sheet_fixes.get(sheet_idx) {
                     if !fixes.is_empty() {
                         content = apply_cell_fixes_to_sheet_xml(content, fixes)?;
                     }
                 }
                 if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                     content = inject_table_parts_into_sheet_xml(content, sheet_tables)?;
                 }
             } else if let Some(sheet_idx) = sheet_rels_index_from_path(&name) {
                 if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                     content = inject_table_rels(content, sheet_tables)?;
                 }
             }
             let opts = zip::write::FileOptions::default()
                 .compression_method(zip::CompressionMethod::Deflated);
             writer.start_file(name, opts).map_err(XlsxError::Zip)?;
             writer.write_all(&content)?;
         }
 
         // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
         // parts. Each table id N gets its own part file.
         for t in tables {
             let part_name = format!("xl/tables/table{}.xml", t.id);
             let xml = render_table_xml(t);
             let opts = zip::write::FileOptions::default()
                 .compression_method(zip::CompressionMethod::Deflated);
             writer
                 .start_file(&part_name, opts)
                 .map_err(XlsxError::Zip)?;
             writer.write_all(xml.as_bytes())?;
         }
 
         // **W5-D-14.2:** if a sheet has tables but the sheet had no
         // pre-existing rels file (umya doesn't write one for plain
         // sheets), create the rels file from scratch.
         for (sheet_idx, sheet_tables) in &tables_by_sheet {
             // The sheet ID in the umya-generated file is sheet_idx + 1.
             let rels_path = format!("xl/worksheets/_rels/sheet{}.xml.rels", sheet_idx + 1);
@@ -903,182 +1041,185 @@ fn sheet_rels_index_from_path(name: &str) -> Option<usize> {
 /// scaffolding.
 fn inject_custom_formats_into_styles_xml(
     content: Vec<u8>,
     custom_formats: &[(u32, String)],
 ) -> Result<Vec<u8>, XlsxError> {
     let text = String::from_utf8(content)
         .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;
 
     let mut numfmts = String::with_capacity(64 * custom_formats.len());
     numfmts.push_str(&format!(r#"<numFmts count="{}">"#, custom_formats.len()));
     for (id, code) in custom_formats {
         numfmts.push_str(&format!(
             r#"<numFmt numFmtId="{}" formatCode="{}"/>"#,
             id,
             xml_attr_escape(code),
         ));
     }
     numfmts.push_str("</numFmts>");
 
     // Case 1: existing <numFmts> — replace it entirely. (Unlikely
     // since umya doesn't emit any, but handle defensively.)
     //
     // **W5-D-14.2.3 (separate-Opus M-1 closure):** check the
     // non-self-closing `</numFmts>` form FIRST. The self-close `/>`
     // search runs over the FULL remainder of the document, so if
     // `<numFmts>` has self-closing children (`<numFmt ../>`), the
     // `find("/>")` would match the CHILD's `/>` and truncate at the
     // wrong place. Closing-tag form lets us cleanly bracket the
     // outer element.
     if let Some(start) = text.find("<numFmts") {
         let after = start + "<numFmts".len();
         if let Some(close_rel) = text[after..].find("</numFmts>") {
             let end = after + close_rel + "</numFmts>".len();
             let mut out = String::with_capacity(text.len() + numfmts.len());
             out.push_str(&text[..start]);
             out.push_str(&numfmts);
             out.push_str(&text[end..]);
             return Ok(out.into_bytes());
         }
         // Truly self-closing `<numFmts ... />` form: find the FIRST
         // `>` after the tag name and require the preceding byte to be
         // `/`. That bounds the search to the actual element close.
         if let Some(gt_rel) = text[after..].find('>') {
             let end = after + gt_rel + 1;
             if text[after..end].ends_with("/>") {
                 let mut out = String::with_capacity(text.len() + numfmts.len());
                 out.push_str(&text[..start]);
                 out.push_str(&numfmts);
                 out.push_str(&text[end..]);
                 return Ok(out.into_bytes());
             }
         }
     }
 
     // Case 2: insert after the <styleSheet ...> opening tag.
     if let Some(opening) = text.find("<styleSheet") {
         let end_of_opening = text[opening..]
             .find('>')
             .map(|i| opening + i + 1)
             .ok_or_else(|| {
                 XlsxError::Export("styles.xml has malformed <styleSheet>".to_string())
             })?;
         let mut out = String::with_capacity(text.len() + numfmts.len());
         out.push_str(&text[..end_of_opening]);
         out.push_str(&numfmts);
         out.push_str(&text[end_of_opening..]);
         return Ok(out.into_bytes());
     }
 
     Err(XlsxError::Export(
         "styles.xml missing <styleSheet> root element".to_string(),
     ))
 }
 
 /// **W5-D-15 (XLSX-4-03 per-cell format closure):** replace umya's
 /// default `<cellXfs>` block with one that enumerates every FormatId
 /// referenced by any cell. Slot 0 is the default xf (numFmtId=0, no
 /// applyNumberFormat); slots 1..N follow the `cellxfs_roster` order
 /// (which matches the `xf_index` values minted at the cell-fix
 /// collection site so `<c s="N">` round-trips correctly).
+///
+/// **Phase 5.2 D-1 step 6 (2026-05-20):** `cellxfs_roster` now carries
+/// `(FormatId, xlsx_numFmtId)` pairs — the numFmtId is pre-translated
+/// by `XlsxNumFmtTranslation` at the caller. This drops the pre-step-6
+/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
+/// flatten correctly through the translation.
 fn inject_cell_xfs_into_styles_xml(
     content: Vec<u8>,
-    cellxfs_roster: &[FormatId],
+    cellxfs_roster: &[(FormatId, u32)],
 ) -> Result<Vec<u8>, XlsxError> {
     let text = String::from_utf8(content)
         .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;
 
     let count = cellxfs_roster.len() + 1;
     let mut block = String::with_capacity(64 * count);
     block.push_str(&format!(r#"<cellXfs count="{}">"#, count));
     // Slot 0: default xf.
     block.push_str(r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#);
-    for fid in cellxfs_roster {
+    for (_fid, xlsx_num_fmt_id) in cellxfs_roster {
         block.push_str(&format!(
             concat!(
                 r#"<xf numFmtId="{}" fontId="0" fillId="0" borderId="0" xfId="0" "#,
                 r#"applyNumberFormat="1"/>"#,
             ),
-            // Phase 5.2 D-1 step 3: pre-step-6 xlsx export sees only
-            // legacy FormatId; non-LEGACY peer ids can't yet appear.
-            fid.to_legacy_u32()
-                .expect("pre-step-6 xlsx export sees only legacy FormatId"),
+            xlsx_num_fmt_id,
         ));
     }
     block.push_str("</cellXfs>");
 
     // Case 1: existing <cellXfs> — replace. Closing-tag form first.
     if let Some(start) = text.find("<cellXfs") {
         let after = start + "<cellXfs".len();
         if let Some(close_rel) = text[after..].find("</cellXfs>") {
             let end = after + close_rel + "</cellXfs>".len();
             let mut out = String::with_capacity(text.len() + block.len());
             out.push_str(&text[..start]);
             out.push_str(&block);
             out.push_str(&text[end..]);
             return Ok(out.into_bytes());
         }
         if let Some(gt_rel) = text[after..].find('>') {
             let end = after + gt_rel + 1;
             if text[after..end].ends_with("/>") {
                 let mut out = String::with_capacity(text.len() + block.len());
                 out.push_str(&text[..start]);
                 out.push_str(&block);
                 out.push_str(&text[end..]);
                 return Ok(out.into_bytes());
             }
         }
     }
 
     // Case 2: no existing <cellXfs> — insert at the end of styleSheet
     // (before </styleSheet>). umya always emits a cellXfs block so
     // this path is defensive only.
     if let Some(idx) = text.rfind("</styleSheet>") {
         let mut out = String::with_capacity(text.len() + block.len());
         out.push_str(&text[..idx]);
         out.push_str(&block);
         out.push_str(&text[idx..]);
         return Ok(out.into_bytes());
     }
 
     Err(XlsxError::Export(
         "styles.xml missing </styleSheet> close — cannot inject <cellXfs>".to_string(),
     ))
 }
 
 /// One defined name to serialise into `<definedNames>`.
 #[derive(Debug, Clone)]
 struct DefinedNameOut {
     /// Excel-canonical (upper-case) form; the OOXML stores it
     /// case-preserved but Quantbook canonicalizes on insert so this
     /// IS the canonical form.
     name: String,
     /// Target expressed as OOXML formula text
     /// (e.g. `'Sheet1'!$A$1:$B$2` for ranges, `123.4` for numeric
     /// constants, `"hello"` for text constants, raw formula otherwise).
     target: String,
     /// `localSheetId` attribute — `None` for workbook-scoped names.
     /// Sheet-scoped names are deferred (Quantbook's `NameTable` is
     /// workbook-only today); reserved for forward compat.
     local_sheet_id: Option<u16>,
 }
 
 /// Walk Quantbook's `NameTable` and render each name as a
 /// `DefinedNameOut`. Sheet-name lookups go through the workbook's
 /// `Sheet::name()` (case-preserving display).
 /// **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** count named
 /// targets whose `render_named_target` returns None — these will
 /// be silently dropped from the export. The count is used to
 /// populate `XlsxExportReport.dropped_features` so Strict mode can
 /// fire on them.
 fn count_undeserializable_names(workbook: &Workbook) -> usize {
     let mut count = 0;
     for (_name, target) in workbook.names().iter() {
         if render_named_target(workbook, target).is_none() {
             count += 1;
         }
     }
     let sheet_count = workbook.sheet_count();
     for sheet_idx in 0..sheet_count {
         if let Some(sheet) = workbook.sheet(sheet_idx as u16) {
             for (_name, target) in sheet.scoped_names().iter() {
                 if render_named_target(workbook, target).is_none() {

exec
/bin/zsh -lc "git show 30ef2637d6f:quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs | sed -n '210,550p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
                            // cached values (default cell type "n" round-trips).
                            // Boolean / Error formula cells need DIFFERENT
                            // post-process patches because the default "n"
                            // would still misread the value.
                            if cache_written {
                                match val {
                                    Value::Number(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::RemoveStrType,
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-1 closure):**
                                    // boolean formula cache — rewrite
                                    // `t="str"` → `t="b"` AND `<v>TRUE</v>`
                                    // / `<v>FALSE</v>` → `<v>1</v>` /
                                    // `<v>0</v>`. Without this the cell
                                    // round-trips as text "TRUE"/"FALSE".
                                    Value::Boolean(b) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToBoolType(*b),
                                        });
                                    }
                                    // **W5-D-PM-1 (Codex HIGH-2 / Opus-A
                                    // HIGH-1 closure):** error formula
                                    // cache — rewrite `t="str"` → `t="e"`.
                                    // The sigil in `<v>` is already correct
                                    // (umya passes our value through). 10 %
                                    // of corpus impacted before the fix.
                                    Value::Error(_) => {
                                        fixes.push(CellFix {
                                            cell_ref: cell_ref_a1(row, col),
                                            kind: CellFixKind::ConvertFormulaToErrorType,
                                        });
                                    }
                                    _ => {}
                                }
                            }
                        }
                        (None, Value::Blank) => {
                            // Skip blank cells (no formula, no value).
                        }
                        (None, val) => {
                            let cell = ws.get_cell_mut((umya_col, umya_row));
                            apply_value_to_cell(cell, val);
                            // **W5-D-14.1 (audit HIGH-6 closure):** umya
                            // hardcodes `#VALUE!` for any error cell.
                            // Schedule the actual sigil patch.
                            if let Value::Error(e) = val {
                                fixes.push(CellFix {
                                    cell_ref: cell_ref_a1(row, col),
                                    kind: CellFixKind::OverrideErrorSigil(e.sigil()),
                                });
                            }
                        }
                    }
                    if !matches!(value, Value::Blank) || formula.is_some() {
                        report.cells_written += 1;
                    }
                }
            }
        } // end `if has_cells_to_walk`

        // **W5-D-15:** schedule `s="N"` fixes for every cell with a
        // format overlay entry. MUST run AFTER the cell-walk fixes
        // (RemoveStrType / OverrideErrorSigil) so their needles —
        // which match on the literal `<c r="..." t="..."` prefix —
        // aren't disrupted by an inserted `s="..."` attribute.
        //
        // **W5-D-15.1 (self-audit H-3 closure):** the prior version
        // walked `format_overlay().iter()` directly — HashMap
        // iteration order, which is non-deterministic. The
        // `cellxfs_roster` order (and therefore every cell's emitted
        // `s="N"`) varied run-to-run. Now we sort entries by
        // (FormatId, row, col) so the roster is byte-stable across
        // runs and the per-cell `s="N"` values are deterministic.
        let sheet_view = workbook
            .sheet(sheet_id)
            .ok_or_else(|| XlsxError::Export(format!("sheet {sheet_id} missing during export")))?;
        let mut overlay_entries: Vec<((u32, u32), FormatId)> =
            sheet_view.format_overlay().iter().collect();
        // Phase 5.2 D-1 step 3: sort key uses `to_legacy_u32` (was the
        // pre-step-3 `.0` field). Non-LEGACY peer ids can't yet appear
        // here (step 6 will handle multi-peer xlsx export); expect()
        // makes the invariant load-bearing for step 6.
        overlay_entries.sort_by_key(|a| {
            (
                a.1.to_legacy_u32()
                    .expect("pre-step-6 xlsx export sees only legacy FormatId"),
                a.0 .0,
                a.0 .1,
            )
        });

        for ((row, col), fid) in overlay_entries {
            let xf_index = match format_to_xf_index.get(&fid) {
                Some(idx) => *idx,
                None => continue, // unreachable — roster pre-populated for all FormatIds
            };
            fixes.push(CellFix {
                cell_ref: cell_ref_a1(row, col),
                kind: CellFixKind::SetStyle(xf_index),
            });
        }
        sheet_fixes.push(fixes);
    }

    // Persist to disk.
    umya_spreadsheet::writer::xlsx::write(&spreadsheet, output_path)
        .map_err(|e| XlsxError::Export(format!("umya write failed: {e}")))?;

    // **W5-D-14.1 unified post-process pass:** apply workarounds for
    // umya 2.2.0 bugs and limitations. Patches applied:
    //
    // 1. `xl/workbook.xml`: inject `workbookPr/@date1904` (HIGH-2).
    // 2. `xl/worksheets/sheet{N}.xml`: remove `t="str"` (HIGH-1).
    // 3. `xl/worksheets/sheet{N}.xml`: error sigil sub (HIGH-6).
    // 4. `xl/styles.xml`: inject `<numFmts>` for custom format codes
    //    (HIGH-5 closure — umya doesn't write the custom-format roster).
    // 5. `xl/workbook.xml`: inject `<definedNames>` for workbook +
    //    sheet-scoped names (HIGH-4 closure — names export side).
    // 6. `xl/tables/table{N}.xml` + sheet rels + Content_Types + sheet
    //    `<tableParts>`: write Quantbook tables (HIGH-3 closure).
    let needs_date1904 = workbook.date_system() == ql_types::DateSystem::Excel1904;
    let needs_cell_fixes = sheet_fixes.iter().any(|f| !f.is_empty());

    // **W5-D-14.2 (HIGH-5 closure):** collect custom-format codes (≥164).
    // Phase 5.2 D-1 step 3: `is_custom()` replaces the pre-step-3
    // `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter. xlsx export sees only
    // legacy FormatId values pre-step-6, so `to_legacy_u32` always
    // returns Some; the expect() makes the invariant load-bearing
    // for step 6 (multi-peer xlsx export).
    let custom_formats: Vec<(u32, String)> = workbook
        .formats()
        .iter()
        .filter_map(|(id, code)| {
            if id.is_custom() {
                Some((
                    id.to_legacy_u32()
                        .expect("pre-step-6 xlsx export sees only legacy FormatId"),
                    code.to_string(),
                ))
            } else {
                None
            }
        })
        .collect();

    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
    // scoped + sheet-scoped names. Each is rendered as the OOXML
    // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
    let defined_names = collect_defined_names(workbook)?;

    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
    // `report.dropped_features` with names that couldn't be rendered
    // (Constant(Error)/Constant(Blank) targets). `collect_defined_names`
    // silently drops these; without this surfacing, NewWorkbook
    // Strict mode never fires for them.
    let dropped_named_count = count_undeserializable_names(workbook);
    for _ in 0..dropped_named_count {
        report
            .dropped_features
            .push(crate::report::UnsupportedFeature {
                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
                part: "xl/workbook.xml".to_string(),
                detail: "named range with Error/Blank constant target cannot \
                         serialize to OOXML formula text"
                    .to_string(),
            });
    }

    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
    // their own `xl/tables/table{N}.xml` parts AND require updates to
    // sheet rels + worksheet `<tableParts>` + `[Content_Types].xml`.
    let tables = collect_table_exports(workbook);

    let needs_post_process = needs_date1904
        || needs_cell_fixes
        || !custom_formats.is_empty()
        || !defined_names.is_empty()
        || !tables.is_empty()
        || !cellxfs_roster.is_empty();
    if needs_post_process {
        post_process_zip(
            output_path,
            needs_date1904,
            &sheet_fixes,
            &custom_formats,
            &defined_names,
            &tables,
            &cellxfs_roster,
        )?;
    }

    Ok(report)
}

/// Unified post-process pass over the just-written xlsx. Applies all
/// workarounds and roster injections in a single zip walk:
/// - `xl/workbook.xml`: inject `date1904="1"` + `<definedNames>`.
/// - `xl/worksheets/sheet{N}.xml`: per-cell fixes (HIGH-1 / HIGH-6) +
///   `<tableParts>` references for tables anchored to that sheet.
/// - `xl/styles.xml`: inject `<numFmts>` for custom format codes.
/// - `xl/tables/table{N}.xml`: NEW parts for each Quantbook table.
/// - `xl/worksheets/_rels/sheet{N}.xml.rels`: rel entries pointing
///   into the table parts.
/// - `[Content_Types].xml`: `Override` entries for the new table parts.
///
/// **W5-D-14.1** audit HIGH-1 / HIGH-2 / HIGH-6 closure.
/// **W5-D-14.2** audit HIGH-3 / HIGH-4 / HIGH-5 closure.
fn post_process_zip(
    path: &std::path::Path,
    inject_date1904: bool,
    sheet_fixes: &[Vec<CellFix>],
    custom_formats: &[(u32, String)],
    defined_names: &[DefinedNameOut],
    tables: &[TableExport],
    cellxfs_roster: &[FormatId],
) -> Result<(), XlsxError> {
    use std::io::{Read, Write};

    // Pre-compute per-sheet table groupings: for each Quantbook
    // sheet index, the table ids anchored there. Used to emit
    // `<tableParts>` in the worksheet xml + rels.
    let mut tables_by_sheet: std::collections::HashMap<usize, Vec<&TableExport>> =
        std::collections::HashMap::new();
    for t in tables {
        tables_by_sheet.entry(t.sheet_idx).or_default().push(t);
    }

    let bytes = std::fs::read(path)?;
    let mut reader =
        zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).map_err(XlsxError::Zip)?;
    let mut out_buf: Vec<u8> = Vec::new();
    let mut existing_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        for i in 0..reader.len() {
            let mut entry = reader.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            existing_names.insert(name.clone());
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            if name == "xl/workbook.xml" {
                if inject_date1904 {
                    content = inject_date1904_into_workbook_xml(content)?;
                }
                if !defined_names.is_empty() {
                    content = inject_defined_names_into_workbook_xml(content, defined_names)?;
                }
            } else if name == "xl/styles.xml" {
                if !custom_formats.is_empty() {
                    content = inject_custom_formats_into_styles_xml(content, custom_formats)?;
                }
                if !cellxfs_roster.is_empty() {
                    content = inject_cell_xfs_into_styles_xml(content, cellxfs_roster)?;
                }
            } else if name == "[Content_Types].xml" && !tables.is_empty() {
                content = inject_table_overrides_into_content_types(content, tables)?;
            } else if let Some(sheet_idx) = sheet_index_from_path(&name) {
                if let Some(fixes) = sheet_fixes.get(sheet_idx) {
                    if !fixes.is_empty() {
                        content = apply_cell_fixes_to_sheet_xml(content, fixes)?;
                    }
                }
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_parts_into_sheet_xml(content, sheet_tables)?;
                }
            } else if let Some(sheet_idx) = sheet_rels_index_from_path(&name) {
                if let Some(sheet_tables) = tables_by_sheet.get(&sheet_idx) {
                    content = inject_table_rels(content, sheet_tables)?;
                }
            }
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file(name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // **W5-D-14.2 HIGH-3 closure:** emit new xl/tables/table{N}.xml
        // parts. Each table id N gets its own part file.
        for t in tables {
            let part_name = format!("xl/tables/table{}.xml", t.id);
            let xml = render_table_xml(t);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&part_name, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(xml.as_bytes())?;
        }

        // **W5-D-14.2:** if a sheet has tables but the sheet had no
        // pre-existing rels file (umya doesn't write one for plain
        // sheets), create the rels file from scratch.
        for (sheet_idx, sheet_tables) in &tables_by_sheet {
            // The sheet ID in the umya-generated file is sheet_idx + 1.
            let rels_path = format!("xl/worksheets/_rels/sheet{}.xml.rels", sheet_idx + 1);
            if existing_names.contains(&rels_path) {
                continue;
            }
            let content = render_fresh_sheet_rels(sheet_tables);
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer
                .start_file(&rels_path, opts)
                .map_err(XlsxError::Zip)?;
            writer.write_all(content.as_bytes())?;
        }

        writer.finish().map_err(XlsxError::Zip)?;
    }
    // **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** atomic write
    // via write-tmp + rename. Concurrent exports to the same
    // `output_path` would otherwise interleave bytes, producing
    // corrupt output (3 of 4 concurrent calls were observed to fail
    // empirically). POSIX `rename` is atomic on the same filesystem.
    atomic_write_to_path(path, &out_buf)?;
    Ok(())
}

/// **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** write `bytes` to
/// `final_path` atomically via tmp + rename. On the same
/// filesystem, `rename(2)` is atomic — concurrent writers either
/// see the old file or the new file, never a partial / interleaved
/// state.
/// Crate-visible wrapper so sibling modules (`update_original`)
/// can use the same atomic-write helper without duplicating code.
pub(crate) fn atomic_write_to_path_public(
    final_path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), XlsxError> {
    atomic_write_to_path(final_path, bytes)
}

fn atomic_write_to_path(final_path: &std::path::Path, bytes: &[u8]) -> Result<(), XlsxError> {
    let parent = final_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let stem = final_path

exec
/bin/zsh -lc "rg -n \"enum FormatId|struct FormatId|FIRST_CUSTOM_FORMAT_ID|LEGACY_PEER|to_legacy_u32|legacy_from_u32|register_at|formats\\(|format_overlay\\(|FormatId::Builtin|FormatId::Custom\" quantbook-engine/crates" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:111:    /// `FormatTable::register_at` refused the registration — the id is
quantbook-engine/crates/ql-oplog/src/replay.rs:278:    /// id would have panicked at `FormatTable::register_at`'s counter
quantbook-engine/crates/ql-oplog/src/replay.rs:534:            // **W5-80:** route through `FormatTable::register_at` so
quantbook-engine/crates/ql-oplog/src/replay.rs:537:            // by_string fast path; `register_at` is the explicit-id form).
quantbook-engine/crates/ql-oplog/src/replay.rs:541:            // `to_storage()`. The pre-step-4 `legacy_from_u32` migration
quantbook-engine/crates/ql-oplog/src/replay.rs:547:                .register_at(fid, string.as_str())
quantbook-engine/crates/ql-oplog/src/replay.rs:567:                if workbook.formats().lookup(fid).is_none() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1390:            // Custom(LEGACY_PEER, 36) via from_u32_legacy.
quantbook-engine/crates/ql-oplog/src/replay.rs:1400:            wb.formats()
quantbook-engine/crates/ql-oplog/src/replay.rs:1401:                .lookup(ql_storage::FormatId::legacy_from_u32(200)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1421:            wb.formats().lookup(ql_storage::FormatId::Builtin(0)),
quantbook-engine/crates/ql-oplog/src/replay.rs:1445:                        id: ql_storage::FormatId::Builtin(0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1474:            wb.sheet(0).unwrap().format_overlay().get(3, 5),
quantbook-engine/crates/ql-oplog/src/replay.rs:1475:            Some(ql_storage::FormatId::legacy_from_u32(200))
quantbook-engine/crates/ql-oplog/src/replay.rs:1506:        assert_eq!(wb.sheet(0).unwrap().format_overlay().get(3, 5), None);
quantbook-engine/crates/ql-oplog/src/replay.rs:1527:                assert_eq!(id, ql_storage::FormatId::legacy_from_u32(999));
quantbook-engine/crates/ql-oplog/src/replay.rs:1570:            wb.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-oplog/src/replay.rs:1571:            Some(ql_storage::FormatId::Builtin(14))
quantbook-engine/crates/ql-oplog/src/op.rs:17://! | `RegisterFormat`   | `FormatTable::register_at` (W5-80)               |
quantbook-engine/crates/ql-oplog/src/op.rs:115:    /// `FormatTable::register_at`. Emitted when
quantbook-engine/crates/ql-oplog/src/op.rs:119:    /// string fails at `FormatTable::register_at` and surfaces as
quantbook-engine/crates/ql-oplog/src/wire.rs:37:use ql_types::{Address, ErrorValue, PeerId, Range, Value, LEGACY_PEER, MAX_COLUMN, MAX_ROW};
quantbook-engine/crates/ql-oplog/src/wire.rs:283:pub enum FormatIdWire {
quantbook-engine/crates/ql-oplog/src/wire.rs:300:    /// Pre-5.2 encoding: `FormatId` was `pub struct FormatId(pub u32)`.
quantbook-engine/crates/ql-oplog/src/wire.rs:308:    /// - `n >= 164` → `Custom { peer: LEGACY_PEER, counter: n - 164 }`.
quantbook-engine/crates/ql-oplog/src/wire.rs:310:    /// `LEGACY_PEER = PeerId(0)` is the sentinel for "this custom id
quantbook-engine/crates/ql-oplog/src/wire.rs:320:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:332:            ql_storage::FormatId::Builtin(n) => FormatIdWire::Builtin { id: n },
quantbook-engine/crates/ql-oplog/src/wire.rs:333:            ql_storage::FormatId::Custom(peer, counter) => FormatIdWire::Custom { peer, counter },
quantbook-engine/crates/ql-oplog/src/wire.rs:343:            FormatIdWire::Builtin { id } => ql_storage::FormatId::Builtin(id),
quantbook-engine/crates/ql-oplog/src/wire.rs:344:            FormatIdWire::Custom { peer, counter } => ql_storage::FormatId::Custom(peer, counter),
quantbook-engine/crates/ql-oplog/src/wire.rs:439:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:451:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:460:        // Custom(LEGACY_PEER, 0) (legacy-mapped from u32=164) are NOT
quantbook-engine/crates/ql-oplog/src/wire.rs:467:            peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/wire.rs:583:            let storage = ql_storage::FormatId::Builtin(n);
quantbook-engine/crates/ql-oplog/src/wire.rs:608:            let storage = ql_storage::FormatId::Custom(peer, counter);
quantbook-engine/crates/ql-oplog/src/wire.rs:630:                peer: LEGACY_PEER,
quantbook-engine/crates/ql-oplog/src/lib.rs:53:// cycle: `ql_storage::FormatId::Custom(PeerId, _)` (step 3) cannot
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:78:    // legacy_from_u32(164) = Custom { peer: LEGACY_PEER, counter: 0 } —
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:197:                    .register_at(id.to_storage(), string.as_str())
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:198:                    .expect("producer-side register_at must succeed");
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:320:    // any to_legacy_u32 hop.
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:322:        .formats()
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:327:        .formats()
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:337:            a.sheet(sheet_id).unwrap().format_overlay().iter().collect();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:339:            b.sheet(sheet_id).unwrap().format_overlay().iter().collect();
quantbook-engine/crates/ql-types/src/peer.rs:10://!   a forthcoming Cargo cycle: `ql-storage::FormatId::Custom(PeerId, _)`
quantbook-engine/crates/ql-types/src/peer.rs:30://! - `ql_storage::FormatId::Custom(PeerId, u32)` (Phase 5.2 D-1 step 3).
quantbook-engine/crates/ql-types/src/peer.rs:94:/// values `≤ 163` map to `FormatId::Builtin(n)`; values `> 163` map
quantbook-engine/crates/ql-types/src/peer.rs:95:/// to `FormatId::Custom(LEGACY_PEER, n - 164)`. After the migration
quantbook-engine/crates/ql-types/src/peer.rs:97:/// `LEGACY_PEER` only appears in custom format ids inherited from
quantbook-engine/crates/ql-types/src/peer.rs:108:pub const LEGACY_PEER: PeerId = PeerId::new(0);
quantbook-engine/crates/ql-types/src/peer.rs:112:    use super::{PeerId, LEGACY_PEER};
quantbook-engine/crates/ql-types/src/peer.rs:158:        assert_eq!(LEGACY_PEER.as_u64(), 0);
quantbook-engine/crates/ql-types/src/peer.rs:159:        assert_eq!(LEGACY_PEER, PeerId::new(0));
quantbook-engine/crates/ql-storage/src/sheet.rs:33:    /// `workbook.formats().lookup(id)` to get the format-string, parse,
quantbook-engine/crates/ql-storage/src/sheet.rs:65:    pub fn format_overlay(&self) -> &crate::CellFormatOverlay {
quantbook-engine/crates/ql-storage/src/format_overlay.rs:106:        let id = FormatId::Builtin(14);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:114:        assert_eq!(o.set(5, 3, FormatId::Builtin(14)), None);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:116:            o.set(5, 3, FormatId::Builtin(15)),
quantbook-engine/crates/ql-storage/src/format_overlay.rs:117:            Some(FormatId::Builtin(14))
quantbook-engine/crates/ql-storage/src/format_overlay.rs:119:        assert_eq!(o.get(5, 3), Some(FormatId::Builtin(15)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:125:        o.set(5, 3, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:126:        assert_eq!(o.clear(5, 3), Some(FormatId::Builtin(14)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:139:        o.set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:140:        o.set(1, 1, FormatId::Builtin(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:148:        o.set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:149:        o.set(0, 1, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:150:        o.set(0, 2, FormatId::Builtin(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:151:        assert_eq!(o.count_refs(FormatId::Builtin(14)), 2);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:152:        assert_eq!(o.count_refs(FormatId::Builtin(15)), 1);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:153:        // 999 maps to Custom(LEGACY_PEER, 835) under the new shape;
quantbook-engine/crates/ql-storage/src/format_overlay.rs:155:        assert_eq!(o.count_refs(FormatId::legacy_from_u32(999)), 0);
quantbook-engine/crates/ql-storage/src/format_overlay.rs:161:        o.set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:162:        o.set(1, 1, FormatId::Builtin(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:170:        o.set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:171:        o.set(0, 1, FormatId::Builtin(15));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:172:        o.set(1, 0, FormatId::Builtin(16));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:173:        assert_eq!(o.get(0, 0), Some(FormatId::Builtin(14)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:174:        assert_eq!(o.get(0, 1), Some(FormatId::Builtin(15)));
quantbook-engine/crates/ql-storage/src/format_overlay.rs:175:        assert_eq!(o.get(1, 0), Some(FormatId::Builtin(16)));
quantbook-engine/crates/ql-types/src/lib.rs:52:pub use peer::{PeerId, LEGACY_PEER};
quantbook-engine/crates/ql-storage/src/lib.rs:36:pub use format::{FormatId, FormatTable, FormatTableError, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-storage/src/lib.rs:69:        assert_eq!(wb.formats().lookup(FormatId::GENERAL), Some("General"));
quantbook-engine/crates/ql-storage/src/lib.rs:70:        assert_eq!(wb.formats().lookup(FormatId::Builtin(14)), Some("m/d/yyyy"));
quantbook-engine/crates/ql-storage/src/lib.rs:77:        assert_eq!(id, FormatId::Builtin(2));
quantbook-engine/crates/ql-storage/src/lib.rs:84:        // Step 3: first custom = Custom(LEGACY_PEER, 0); legacy u32 = 164.
quantbook-engine/crates/ql-storage/src/lib.rs:85:        assert_eq!(id.to_legacy_u32(), Some(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-storage/src/lib.rs:91:        assert!(s.format_overlay().is_empty());
quantbook-engine/crates/ql-storage/src/lib.rs:97:        s.format_overlay_mut().set(3, 5, FormatId::Builtin(14));
quantbook-engine/crates/ql-storage/src/lib.rs:98:        assert_eq!(s.format_overlay().get(3, 5), Some(FormatId::Builtin(14)));
quantbook-engine/crates/ql-storage/src/lib.rs:100:        assert!(s.format_overlay().get(3, 5).is_none());
quantbook-engine/crates/ql-storage/src/lib.rs:112:        assert_eq!(wb.sheet(s0).unwrap().format_overlay().get(0, 0), Some(id));
quantbook-engine/crates/ql-storage/src/lib.rs:113:        assert_eq!(wb.sheet(s1).unwrap().format_overlay().get(0, 0), None);
quantbook-engine/crates/ql-storage/src/lib.rs:115:        assert_eq!(wb.formats().lookup(id), Some("yyyy-mm-dd"));
quantbook-engine/crates/ql-storage/src/format.rs:12://! `FormatId` changed from `pub struct FormatId(pub u32)` to a tagged
quantbook-engine/crates/ql-storage/src/format.rs:16://! pub enum FormatId {
quantbook-engine/crates/ql-storage/src/format.rs:24://! Single-writer / pre-collab callers use [`LEGACY_PEER`] as the
quantbook-engine/crates/ql-storage/src/format.rs:28://! Migration helper [`FormatId::legacy_from_u32`] converts pre-5.2
quantbook-engine/crates/ql-storage/src/format.rs:42:use ql_types::{PeerId, LEGACY_PEER};
quantbook-engine/crates/ql-storage/src/format.rs:60:/// `FormatId::Builtin(n)` is contractually valid ONLY for
quantbook-engine/crates/ql-storage/src/format.rs:64:/// [`FormatId::legacy_from_u32`] for u32 values that may exceed
quantbook-engine/crates/ql-storage/src/format.rs:65:/// 163** — that helper routes 164+ to `Custom(LEGACY_PEER, n - 164)`.
quantbook-engine/crates/ql-storage/src/format.rs:66:/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
quantbook-engine/crates/ql-storage/src/format.rs:67:/// `legacy_from_u32` round-trip (becomes asymmetric in the
quantbook-engine/crates/ql-storage/src/format.rs:70:pub enum FormatId {
quantbook-engine/crates/ql-storage/src/format.rs:87:    pub const GENERAL: FormatId = FormatId::Builtin(0);
quantbook-engine/crates/ql-storage/src/format.rs:91:        matches!(self, FormatId::Builtin(_))
quantbook-engine/crates/ql-storage/src/format.rs:96:        matches!(self, FormatId::Custom(_, _))
quantbook-engine/crates/ql-storage/src/format.rs:104:    /// single-writer counter starting at `FIRST_CUSTOM_FORMAT_ID = 164`.
quantbook-engine/crates/ql-storage/src/format.rs:108:    /// - `n >= 164` → `Custom(LEGACY_PEER, n - 164)`.
quantbook-engine/crates/ql-storage/src/format.rs:116:    pub fn legacy_from_u32(n: u32) -> Self {
quantbook-engine/crates/ql-storage/src/format.rs:118:            FormatId::Builtin(n)
quantbook-engine/crates/ql-storage/src/format.rs:120:            FormatId::Custom(LEGACY_PEER, n - FIRST_CUSTOM_FORMAT_ID)
quantbook-engine/crates/ql-storage/src/format.rs:128:    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
quantbook-engine/crates/ql-storage/src/format.rs:131:    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
quantbook-engine/crates/ql-storage/src/format.rs:134:    pub fn to_legacy_u32(self) -> Option<u32> {
quantbook-engine/crates/ql-storage/src/format.rs:136:            FormatId::Builtin(n) => Some(n),
quantbook-engine/crates/ql-storage/src/format.rs:137:            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
quantbook-engine/crates/ql-storage/src/format.rs:138:            FormatId::Custom(_, _) => None,
quantbook-engine/crates/ql-storage/src/format.rs:144:/// `FormatId::Builtin(n)` is valid for `n <= FIRST_XLSX_BUILTIN_MAX`;
quantbook-engine/crates/ql-storage/src/format.rs:153:/// Post-5.2: custom ids live in `FormatId::Custom(peer, counter)`;
quantbook-engine/crates/ql-storage/src/format.rs:155:/// `to_legacy_u32` / `legacy_from_u32` conversions only.
quantbook-engine/crates/ql-storage/src/format.rs:156:pub const FIRST_CUSTOM_FORMAT_ID: u32 = 164;
quantbook-engine/crates/ql-storage/src/format.rs:196:/// `FormatTable::new()`) uses [`LEGACY_PEER`]; multi-peer
quantbook-engine/crates/ql-storage/src/format.rs:224:    /// `FIRST_CUSTOM_FORMAT_ID = 164` in the bare-u32 encoding).
quantbook-engine/crates/ql-storage/src/format.rs:227:    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
quantbook-engine/crates/ql-storage/src/format.rs:236:        Self::with_peer(LEGACY_PEER)
quantbook-engine/crates/ql-storage/src/format.rs:242:    /// Custom ids allocated by this instance carry [`LEGACY_PEER`] —
quantbook-engine/crates/ql-storage/src/format.rs:250:    /// [`Self::intern`] produce `FormatId::Custom(peer, counter)`
quantbook-engine/crates/ql-storage/src/format.rs:261:            let fid = FormatId::Builtin(*id);
quantbook-engine/crates/ql-storage/src/format.rs:286:    /// 1. `register_at(Custom(P, 0), "X")` (replay; local peer ≠ P)
quantbook-engine/crates/ql-storage/src/format.rs:295:    /// `LEGACY_PEER`-tagged construction.
quantbook-engine/crates/ql-storage/src/format.rs:306:                FormatId::Custom(p, c) if *p == peer => Some(*c),
quantbook-engine/crates/ql-storage/src/format.rs:359:    /// otherwise allocates a new `FormatId::Custom(local_peer, counter)`
quantbook-engine/crates/ql-storage/src/format.rs:384:        let id = FormatId::Custom(self.local_peer, self.next_custom_counter);
quantbook-engine/crates/ql-storage/src/format.rs:416:    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
quantbook-engine/crates/ql-storage/src/format.rs:431:        if let FormatId::Builtin(n) = id {
quantbook-engine/crates/ql-storage/src/format.rs:441:        if let FormatId::Custom(peer, counter) = id {
quantbook-engine/crates/ql-storage/src/format.rs:463:            FormatId::Builtin(_) => {
quantbook-engine/crates/ql-storage/src/format.rs:475:            FormatId::Custom(peer, _) => {
quantbook-engine/crates/ql-storage/src/format.rs:491:            FormatId::Builtin(_) => {
quantbook-engine/crates/ql-storage/src/format.rs:494:            FormatId::Custom(peer, _) => {
quantbook-engine/crates/ql-storage/src/format.rs:501:        if let FormatId::Custom(peer, counter) = id {
quantbook-engine/crates/ql-storage/src/format.rs:504:                // overflow was pre-validated at the top of `register_at`
quantbook-engine/crates/ql-storage/src/format.rs:510:                    .expect("counter overflow was pre-validated at register_at entry");
quantbook-engine/crates/ql-storage/src/format.rs:528:    /// `counter` component of the resulting `FormatId::Custom(local_peer,
quantbook-engine/crates/ql-storage/src/format.rs:534:    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
quantbook-engine/crates/ql-storage/src/format.rs:547:/// Errors from `register_at` collisions.
quantbook-engine/crates/ql-storage/src/format.rs:564:    /// Attempted to `register_at` a `Custom(local_peer, counter)` where
quantbook-engine/crates/ql-storage/src/format.rs:566:    /// Pre-step-5-audit this was a `panic!` inside `register_at` (via
quantbook-engine/crates/ql-storage/src/format.rs:573:    /// Attempted to `register_at` a `Builtin(n)` where `n > 163`. The
quantbook-engine/crates/ql-storage/src/format.rs:594:        assert_eq!(t.lookup(FormatId::Builtin(14)), Some("m/d/yyyy"));
quantbook-engine/crates/ql-storage/src/format.rs:595:        assert_eq!(t.lookup(FormatId::Builtin(49)), Some("@"));
quantbook-engine/crates/ql-storage/src/format.rs:602:        assert_eq!(t.lookup(FormatId::Builtin(12)), None);
quantbook-engine/crates/ql-storage/src/format.rs:610:        assert_eq!(id, FormatId::Builtin(2));
quantbook-engine/crates/ql-storage/src/format.rs:620:        // FormatTable uses LEGACY_PEER; counter starts at 0.
quantbook-engine/crates/ql-storage/src/format.rs:621:        assert_eq!(id, FormatId::Custom(LEGACY_PEER, 0));
quantbook-engine/crates/ql-storage/src/format.rs:633:            (FormatId::Custom(pa, ca), FormatId::Custom(pb, cb)) => {
quantbook-engine/crates/ql-storage/src/format.rs:651:        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
quantbook-engine/crates/ql-storage/src/format.rs:652:        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
quantbook-engine/crates/ql-storage/src/format.rs:664:    fn register_at_replays_known_id() {
quantbook-engine/crates/ql-storage/src/format.rs:667:        // u32 encoding is `Custom(LEGACY_PEER, 36)` per legacy_from_u32
quantbook-engine/crates/ql-storage/src/format.rs:671:        let id_200 = FormatId::legacy_from_u32(200);
quantbook-engine/crates/ql-storage/src/format.rs:672:        t.register_at(id_200, "REPLAY").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:677:    fn register_at_advances_local_counter_for_own_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:682:        t.register_at(FormatId::Custom(PeerId::new(7), 5), "REPLAY")
quantbook-engine/crates/ql-storage/src/format.rs:686:        assert_eq!(next, FormatId::Custom(PeerId::new(7), 6));
quantbook-engine/crates/ql-storage/src/format.rs:690:    fn register_at_other_peer_does_not_advance_local_counter() {
quantbook-engine/crates/ql-storage/src/format.rs:695:        t.register_at(FormatId::Custom(PeerId::new(99), 5), "FROM_OTHER")
quantbook-engine/crates/ql-storage/src/format.rs:705:    fn register_at_same_id_same_string_is_idempotent() {
quantbook-engine/crates/ql-storage/src/format.rs:707:        t.register_at(FormatId::Builtin(0), "General").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:708:        assert!(t.register_at(FormatId::Builtin(0), "General").is_ok());
quantbook-engine/crates/ql-storage/src/format.rs:712:    fn register_at_id_collision_errors() {
quantbook-engine/crates/ql-storage/src/format.rs:715:            .register_at(FormatId::Builtin(0), "DIFFERENT")
quantbook-engine/crates/ql-storage/src/format.rs:732:        t.register_at(FormatId::Custom(remote_peer, 0), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:744:        assert_eq!(local_id, FormatId::Custom(PeerId::new(0xa), 0));
quantbook-engine/crates/ql-storage/src/format.rs:754:        // Pre-populate Custom(LEGACY_PEER, 0) → "General" via
quantbook-engine/crates/ql-storage/src/format.rs:755:        // register_at (mirrors the LibreOffice import quirk).
quantbook-engine/crates/ql-storage/src/format.rs:756:        t.register_at(FormatId::Custom(LEGACY_PEER, 0), "General")
quantbook-engine/crates/ql-storage/src/format.rs:760:        assert_eq!(t.lookup_string("General"), Some(FormatId::Builtin(0)));
quantbook-engine/crates/ql-storage/src/format.rs:769:    fn register_at_builtin_vs_builtin_same_string_collision_rejects() {
quantbook-engine/crates/ql-storage/src/format.rs:774:        let err = t.register_at(FormatId::Builtin(99), "General").unwrap_err();
quantbook-engine/crates/ql-storage/src/format.rs:779:    fn register_at_string_collision_errors_same_variant_namespace() {
quantbook-engine/crates/ql-storage/src/format.rs:792:        t.register_at(FormatId::Custom(PeerId::new(0xa), 0), "MY_FMT")
quantbook-engine/crates/ql-storage/src/format.rs:795:            .register_at(FormatId::Custom(PeerId::new(0xa), 1), "MY_FMT")
quantbook-engine/crates/ql-storage/src/format.rs:815:        const _: () = assert!(FIRST_CUSTOM_FORMAT_ID > 163);
quantbook-engine/crates/ql-storage/src/format.rs:832:        assert_eq!(FormatId::GENERAL, FormatId::Builtin(0));
quantbook-engine/crates/ql-storage/src/format.rs:838:    fn legacy_from_u32_maps_builtins_and_customs() {
quantbook-engine/crates/ql-storage/src/format.rs:840:        assert_eq!(FormatId::legacy_from_u32(0), FormatId::Builtin(0));
quantbook-engine/crates/ql-storage/src/format.rs:841:        assert_eq!(FormatId::legacy_from_u32(163), FormatId::Builtin(163));
quantbook-engine/crates/ql-storage/src/format.rs:843:            FormatId::legacy_from_u32(164),
quantbook-engine/crates/ql-storage/src/format.rs:844:            FormatId::Custom(LEGACY_PEER, 0)
quantbook-engine/crates/ql-storage/src/format.rs:847:            FormatId::legacy_from_u32(999),
quantbook-engine/crates/ql-storage/src/format.rs:848:            FormatId::Custom(LEGACY_PEER, 999 - 164)
quantbook-engine/crates/ql-storage/src/format.rs:853:    fn to_legacy_u32_round_trips_builtins_and_legacy_customs() {
quantbook-engine/crates/ql-storage/src/format.rs:854:        assert_eq!(FormatId::Builtin(0).to_legacy_u32(), Some(0));
quantbook-engine/crates/ql-storage/src/format.rs:855:        assert_eq!(FormatId::Builtin(163).to_legacy_u32(), Some(163));
quantbook-engine/crates/ql-storage/src/format.rs:856:        assert_eq!(FormatId::Custom(LEGACY_PEER, 0).to_legacy_u32(), Some(164));
quantbook-engine/crates/ql-storage/src/format.rs:858:            FormatId::Custom(LEGACY_PEER, 100).to_legacy_u32(),
quantbook-engine/crates/ql-storage/src/format.rs:864:    fn to_legacy_u32_returns_none_for_non_legacy_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:868:        let id = FormatId::Custom(PeerId::new(42), 7);
quantbook-engine/crates/ql-storage/src/format.rs:869:        assert_eq!(id.to_legacy_u32(), None);
quantbook-engine/crates/ql-storage/src/format.rs:889:            let id = FormatId::legacy_from_u32(n);
quantbook-engine/crates/ql-storage/src/format.rs:890:            assert_eq!(id.to_legacy_u32(), Some(n), "round-trip failed for {n}");
quantbook-engine/crates/ql-storage/src/format.rs:908:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:911:        t.register_at(FormatId::Custom(remote_peer, 0), "X")
quantbook-engine/crates/ql-storage/src/format.rs:913:        t.register_at(FormatId::Custom(remote_peer, 1), "Y")
quantbook-engine/crates/ql-storage/src/format.rs:915:        t.register_at(FormatId::Custom(remote_peer, 3), "Z")
quantbook-engine/crates/ql-storage/src/format.rs:932:        assert_eq!(new_id, FormatId::Custom(remote_peer, 4));
quantbook-engine/crates/ql-storage/src/format.rs:934:        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 0)), Some("X"));
quantbook-engine/crates/ql-storage/src/format.rs:935:        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 1)), Some("Y"));
quantbook-engine/crates/ql-storage/src/format.rs:936:        assert_eq!(t.lookup(FormatId::Custom(remote_peer, 3)), Some("Z"));
quantbook-engine/crates/ql-storage/src/format.rs:944:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:953:        assert_eq!(next, FormatId::Custom(PeerId::new(0xb2), 0));
quantbook-engine/crates/ql-storage/src/format.rs:967:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:972:        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:976:        t.register_at(FormatId::Custom(peer_b, 0), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:979:        assert_eq!(t.lookup(FormatId::Custom(peer_a, 0)), Some("yyyy-mm-dd"));
quantbook-engine/crates/ql-storage/src/format.rs:980:        assert_eq!(t.lookup(FormatId::Custom(peer_b, 0)), Some("yyyy-mm-dd"));
quantbook-engine/crates/ql-storage/src/format.rs:982:        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:988:            .register_at(FormatId::Custom(peer_a, 1), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:1016:        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
quantbook-engine/crates/ql-storage/src/format.rs:1017:        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
quantbook-engine/crates/ql-storage/src/format.rs:1023:            .register_at(FormatId::Custom(PeerId::new(0xb), 0), "yyyy-mm-dd")
quantbook-engine/crates/ql-storage/src/format.rs:1028:            FormatId::Custom(PeerId::new(0xa), 0),
quantbook-engine/crates/ql-storage/src/format.rs:1034:    /// `Custom(LEGACY_PEER, 0)` (which would round-trip to legacy
quantbook-engine/crates/ql-storage/src/format.rs:1041:        let b = FormatId::Builtin(0);
quantbook-engine/crates/ql-storage/src/format.rs:1042:        let c = FormatId::Custom(LEGACY_PEER, 0);
quantbook-engine/crates/ql-storage/src/format.rs:1052:    /// **Opus M2 closure:** pin that `register_at(Builtin(N), s)` does
quantbook-engine/crates/ql-storage/src/format.rs:1056:    fn register_at_builtin_does_not_advance_counter() {
quantbook-engine/crates/ql-storage/src/format.rs:1057:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:1061:        t.register_at(FormatId::Builtin(12), "# ?/?").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:1062:        t.register_at(FormatId::Builtin(38), "[Red]0").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:1066:            "register_at(Builtin(_)) must not advance the custom counter"
quantbook-engine/crates/ql-storage/src/format.rs:1072:    /// **Codex HIGH-1 closure (step 5 audit):** `register_at` must NOT
quantbook-engine/crates/ql-storage/src/format.rs:1079:    fn register_at_counter_overflow_returns_error_not_panic() {
quantbook-engine/crates/ql-storage/src/format.rs:1080:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:1081:        let result = t.register_at(FormatId::Custom(LEGACY_PEER, u32::MAX), "MY_FMT");
quantbook-engine/crates/ql-storage/src/format.rs:1085:                Err(FormatTableError::CounterOverflow { peer }) if peer == LEGACY_PEER
quantbook-engine/crates/ql-storage/src/format.rs:1087:            "expected CounterOverflow(LEGACY_PEER), got {result:?}"
quantbook-engine/crates/ql-storage/src/format.rs:1091:        assert!(t.lookup(FormatId::Custom(LEGACY_PEER, u32::MAX)).is_none());
quantbook-engine/crates/ql-storage/src/format.rs:1094:    /// **Codex HIGH-1 follow-up:** `register_at` with `Custom(remote_peer,
quantbook-engine/crates/ql-storage/src/format.rs:1100:    fn register_at_counter_overflow_check_only_fires_for_local_peer() {
quantbook-engine/crates/ql-storage/src/format.rs:1101:        let mut t = FormatTable::with_peer(LEGACY_PEER);
quantbook-engine/crates/ql-storage/src/format.rs:1103:        t.register_at(FormatId::Custom(remote_peer, u32::MAX), "REMOTE_FMT")
quantbook-engine/crates/ql-storage/src/format.rs:1106:            t.lookup(FormatId::Custom(remote_peer, u32::MAX)),
quantbook-engine/crates/ql-storage/src/format.rs:1113:    /// **Codex HIGH-2 closure (step 5 audit):** `register_at` must reject
quantbook-engine/crates/ql-storage/src/format.rs:1120:    fn register_at_builtin_out_of_range_returns_error() {
quantbook-engine/crates/ql-storage/src/format.rs:1124:        let result = t.register_at(FormatId::Builtin(200), "bogus-builtin");
quantbook-engine/crates/ql-storage/src/format.rs:1130:        let result = t.register_at(FormatId::Builtin(u32::MAX), "bogus");
quantbook-engine/crates/ql-storage/src/format.rs:1136:        t.register_at(FormatId::Builtin(163), "boundary").unwrap();
quantbook-engine/crates/ql-storage/src/format.rs:1137:        assert_eq!(t.lookup(FormatId::Builtin(163)), Some("boundary"));
quantbook-engine/crates/ql-storage/src/workbook.rs:407:    pub fn formats(&self) -> &crate::FormatTable {
quantbook-engine/crates/ql-storage/src/workbook.rs:412:    /// `register_at`. Phase 4.5.D part 4 (W5-80) will route mutations
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:22:use ql_storage::{FormatId, NamedTarget, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:23:use ql_types::{Value, LEGACY_PEER};
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:87:/// — no peer-id concept. `FormatId::Custom(peer, counter)` variants
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:94:///   `FIRST_CUSTOM_FORMAT_ID = 164`. Order is deterministic: sorted
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:98:/// **Byte-stability:** for the LEGACY_PEER-only case (single-writer
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:100:/// allocator produces `Custom(LEGACY_PEER, c) → c + 164` — identical
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:101:/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:106:/// them to `Custom(LEGACY_PEER, _)` (the legacy_from_u32 path —
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:117:    /// Custom whose peer ≠ LEGACY_PEER. These are the lossy entries
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:119:    /// produces `Custom(LEGACY_PEER, _)`, losing the original peer id.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:127:    /// - `workbook.formats()` Custom entries (the format-table roster
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:137:        for (id, _) in workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:149:        let mut next = FIRST_CUSTOM_FORMAT_ID;
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:160:            if let FormatId::Custom(peer, _) = fid {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:161:                if peer != LEGACY_PEER {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:177:    /// — either registered in `workbook.formats()` or present in the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:184:            FormatId::Builtin(n) => n,
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:185:            FormatId::Custom(_, _) => *self.custom_map.get(&fid).unwrap_or_else(|| {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:235:            for (_addr, fid) in sheet.format_overlay().iter() {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:248:    // translation. Maps every Custom FormatId (across both wb.formats()
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:262:                     (xlsx single-namespace; reimporting recovers as Custom(LEGACY_PEER, _))"
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:411:        // walked `format_overlay().iter()` directly — HashMap
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:421:            sheet_view.format_overlay().iter().collect();
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:424:        // pre-step-6 expect() on `to_legacy_u32()` panicked on
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:426:        // by flattening into a single namespace. For LEGACY_PEER-only
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:466:    // (built above over `wb.formats() + cellxfs_roster` Customs). For
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:467:    // LEGACY_PEER-only workbooks the translated numFmtIds match the
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:468:    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:471:        .formats()
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:514:    // `fid.to_legacy_u32().expect()` inline; now that translation is
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1125:/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
quantbook-engine/crates/ql-collab/src/lib.rs:70://!   2's serde-derived `FormatIdWire`); (b) `ql_storage::FormatId::Custom(PeerId, _)`
quantbook-engine/crates/ql-collab/src/lib.rs:76://!   `LEGACY_PEER` sentinel (= `PeerId(0)`) for step 5's qbook
quantbook-engine/crates/ql-io/src/qbook_format.rs:170:///     `FormatId::legacy_from_u32` at load.
quantbook-engine/crates/ql-io/src/qbook_format.rs:172:///     The pre-step-5 `to_legacy_u32().expect("...")` panic sites
quantbook-engine/crates/ql-io/src/qbook_format.rs:178:///       round-trip multi-peer FormatIds (not just LEGACY_PEER ones).
quantbook-engine/crates/ql-io/src/qbook_format.rs:193:///     `LegacyU32(u32)`, migration via `FormatId::legacy_from_u32`
quantbook-engine/crates/ql-io/src/qbook_format.rs:194:///     (n ≤ 163 → `Builtin(n)`; n ≥ 164 → `Custom(LEGACY_PEER, n-164)`).
quantbook-engine/crates/ql-io/src/qbook_format.rs:595:/// Persists ONLY custom entries (`id >= FIRST_CUSTOM_FORMAT_ID`). Built-in
quantbook-engine/crates/ql-io/src/qbook_format.rs:613:///   `14`). Loader migrates via [`FormatId::legacy_from_u32`]:
quantbook-engine/crates/ql-io/src/qbook_format.rs:614:///   `n <= 163` → `Builtin(n)`; `n >= 164` → `Custom(LEGACY_PEER, n-164)`.
quantbook-engine/crates/ql-io/src/qbook_format.rs:637:    /// `LegacyU32` migrates via [`FormatId::legacy_from_u32`].
quantbook-engine/crates/ql-io/src/qbook_format.rs:646:            FormatEntryId::LegacyU32(n) => ql_storage::FormatId::legacy_from_u32(*n),
quantbook-engine/crates/ql-io/src/qbook_format.rs:1208:            let overlay = sheet.format_overlay();
quantbook-engine/crates/ql-io/src/qbook_format.rs:1220:                        // pre-step-5 hit the to_legacy_u32().expect() panic).
quantbook-engine/crates/ql-io/src/qbook_format.rs:1282:    // (id ≥ FIRST_CUSTOM_FORMAT_ID). Built-ins are re-seeded from
quantbook-engine/crates/ql-io/src/qbook_format.rs:1293:            .formats()
quantbook-engine/crates/ql-io/src/qbook_format.rs:1296:            // pre-step-3 `id.0 >= FIRST_CUSTOM_FORMAT_ID` filter.
quantbook-engine/crates/ql-io/src/qbook_format.rs:1311:                    // `id.to_legacy_u32().expect(...)` which would have
quantbook-engine/crates/ql-io/src/qbook_format.rs:1674:    // `Workbook::default()`. `register_at` is idempotent for the
quantbook-engine/crates/ql-io/src/qbook_format.rs:1681:            // - v<8 `LegacyU32(n)` → `FormatId::legacy_from_u32(n)`
quantbook-engine/crates/ql-io/src/qbook_format.rs:1682:            //   (n ≤ 163 → Builtin; n ≥ 164 → Custom(LEGACY_PEER, n-164)).
quantbook-engine/crates/ql-io/src/qbook_format.rs:1685:                .register_at(fid, entry.string.as_str())
quantbook-engine/crates/ql-io/src/qbook_format.rs:1730:            // sheet + immutable on `wb.formats()`).
quantbook-engine/crates/ql-io/src/qbook_format.rs:1737:                wb.formats().iter().map(|(id, _)| id).collect();
quantbook-engine/crates/ql-io/src/qbook_format.rs:3126:            loaded.formats().lookup(ql_storage::FormatId::Builtin(14)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3147:        // Step 3: first custom = Custom(LEGACY_PEER, 0); legacy u32 = 164.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3148:        // Second custom = Custom(LEGACY_PEER, 1); legacy u32 = 165.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3150:            id_a.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3151:            Some(ql_storage::FIRST_CUSTOM_FORMAT_ID)
quantbook-engine/crates/ql-io/src/qbook_format.rs:3154:            id_b.to_legacy_u32(),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3155:            Some(ql_storage::FIRST_CUSTOM_FORMAT_ID + 1)
quantbook-engine/crates/ql-io/src/qbook_format.rs:3160:        assert_eq!(loaded.formats().lookup(id_a), Some("\"⚓\" #,##0.00"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3161:        assert_eq!(loaded.formats().lookup(id_b), Some("0.0000"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3164:            loaded.formats().lookup(ql_storage::FormatId::Builtin(0)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3180:            .set(0, 0, ql_storage::FormatId::Builtin(14)); // m/d/yyyy
quantbook-engine/crates/ql-io/src/qbook_format.rs:3184:            .set(3, 5, ql_storage::FormatId::Builtin(4)); // #,##0.00
quantbook-engine/crates/ql-io/src/qbook_format.rs:3188:            ql_storage::FormatId::Builtin(49),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3194:            loaded.sheet(s0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3195:            Some(ql_storage::FormatId::Builtin(14))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3198:            loaded.sheet(s0).unwrap().format_overlay().get(3, 5),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3199:            Some(ql_storage::FormatId::Builtin(4))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3203:            loaded.sheet(s1).unwrap().format_overlay().get(10, 20),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3204:            Some(ql_storage::FormatId::Builtin(49))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3207:        assert_eq!(loaded.sheet(s0).unwrap().format_overlay().get(10, 20), None);
quantbook-engine/crates/ql-io/src/qbook_format.rs:3227:        let loaded_id = loaded.sheet(s).unwrap().format_overlay().get(2, 1).unwrap();
quantbook-engine/crates/ql-io/src/qbook_format.rs:3229:        assert_eq!(loaded.formats().lookup(loaded_id), Some("\"€\" #,##0.00"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3255:            loaded.formats().lookup(ql_storage::FormatId::Builtin(0)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3259:        for id in ql_storage::FIRST_CUSTOM_FORMAT_ID..(ql_storage::FIRST_CUSTOM_FORMAT_ID + 10) {
quantbook-engine/crates/ql-io/src/qbook_format.rs:3262:                    .formats()
quantbook-engine/crates/ql-io/src/qbook_format.rs:3263:                    .lookup(ql_storage::FormatId::legacy_from_u32(id))
quantbook-engine/crates/ql-io/src/qbook_format.rs:3269:        assert!(loaded.sheet(0).unwrap().format_overlay().is_empty());
quantbook-engine/crates/ql-io/src/qbook_format.rs:3298:        // The v4 envelope's `id = 0` migrates through `legacy_from_u32(0)`
quantbook-engine/crates/ql-io/src/qbook_format.rs:3304:                    id: ql_storage::FormatId::Builtin(0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3412:    /// - `n = 164` (first custom in legacy encoding) → `Custom(LEGACY_PEER, 0)`.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3413:    /// - `n = 200` (mid-range custom) → `Custom(LEGACY_PEER, 36)`.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3460:        // FormatTable: custom entries land under LEGACY_PEER with
quantbook-engine/crates/ql-io/src/qbook_format.rs:3461:        // counter = id - 164 (matches FormatId::legacy_from_u32).
quantbook-engine/crates/ql-io/src/qbook_format.rs:3464:                .formats()
quantbook-engine/crates/ql-io/src/qbook_format.rs:3465:                .lookup(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3467:            "id=164 must migrate to Custom(LEGACY_PEER, 0)"
quantbook-engine/crates/ql-io/src/qbook_format.rs:3471:                .formats()
quantbook-engine/crates/ql-io/src/qbook_format.rs:3472:                .lookup(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 36)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3474:            "id=200 must migrate to Custom(LEGACY_PEER, 36)"
quantbook-engine/crates/ql-io/src/qbook_format.rs:3479:            loaded.formats().lookup(ql_storage::FormatId::Builtin(14)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3484:        let overlay = loaded.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io/src/qbook_format.rs:3487:            Some(ql_storage::FormatId::Builtin(14)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3492:            Some(ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 36)),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3493:            "overlay id=200 must migrate to Custom(LEGACY_PEER, 36)"
quantbook-engine/crates/ql-io/src/qbook_format.rs:3500:    /// `to_legacy_u32().expect(...)` would have panicked on
quantbook-engine/crates/ql-io/src/qbook_format.rs:3517:            ql_storage::FormatId::Custom(ql_types::PeerId::new(42), 0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3530:            loaded.formats().lookup(custom_id),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3536:            loaded.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3609:        assert_eq!(loaded.formats().lookup(custom_id), Some("#,##0.00 USD"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3630:            ql_storage::FormatId::Builtin(14)
quantbook-engine/crates/ql-io/src/qbook_format.rs:3643:        // legacy_from_u32(14) = Builtin(14) — same final FormatId.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3646:            ql_storage::FormatId::Builtin(14)
quantbook-engine/crates/ql-io/src/qbook_format.rs:3649:        // Edge case: legacy id=164 migrates to Custom(LEGACY_PEER, 0).
quantbook-engine/crates/ql-io/src/qbook_format.rs:3658:            ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0)
quantbook-engine/crates/ql-io/src/qbook_format.rs:3668:            ql_storage::FormatId::Builtin(0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3669:            ql_storage::FormatId::Builtin(163),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3670:            ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, 0),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3671:            ql_storage::FormatId::Custom(ql_types::PeerId::new(42), 7),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3689:    /// **Codex HIGH-1 closure:** a v8 envelope with `id = Custom(LEGACY_PEER,
quantbook-engine/crates/ql-io/src/qbook_format.rs:3691:    /// `register_at` panicked at `counter.checked_add(1).expect(...)`
quantbook-engine/crates/ql-io/src/qbook_format.rs:3692:    /// because the FormatTable's local_peer defaults to LEGACY_PEER.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3700:        // v8 envelope with the maximum counter value for LEGACY_PEER.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3701:        // Pre-step-5-audit closure: this panicked register_at.
quantbook-engine/crates/ql-io/src/qbook_format.rs:3734:                    ql_storage::FormatId::Custom(ql_types::LEGACY_PEER, u32::MAX),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3750:    /// `register_at` (step-5-audit closure).
quantbook-engine/crates/ql-io/src/qbook_format.rs:3784:                    ql_storage::FormatId::Builtin(200),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3930:        assert_eq!(loaded.formats().lookup(id_a_same), Some("$#,##0"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3931:        assert_eq!(loaded.formats().lookup(id_a_solo), Some("0.000"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3932:        assert_eq!(loaded.formats().lookup(id_b_same), Some("$#,##0"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:3933:        assert_eq!(loaded.formats().lookup(id_b_solo), Some("0.0000"));
quantbook-engine/crates/ql-io/src/qbook_format.rs:4289:        // FormatId::legacy_from_u32 at load time.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:23:/// **Replay determinism**: uses `FormatTable::register_at` (not
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:36:pub(crate) fn register_custom_formats(
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:44:        if entry.num_fmt_id < ql_storage::FIRST_CUSTOM_FORMAT_ID {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:51:        // to trigger the `FormatTable::register_at` arithmetic
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:67:        // LEGACY_PEER per the migration contract.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:68:        let id = FormatId::legacy_from_u32(entry.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:74:        // `FormatTable::register_at` rejects this with
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:80:        match workbook.formats_mut().register_at(id, &entry.format_code) {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:115:        let baseline = wb.formats().len();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:129:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:132:        assert_eq!(wb.formats().len(), baseline);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:138:        let baseline = wb.formats().len();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:154:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:156:        assert_eq!(wb.formats().len(), baseline + 2);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:159:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:163:            wb.formats().lookup(FormatId::legacy_from_u32(165)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:182:        // `register_at(Custom(LEGACY_PEER, 0), "General")` SUCCEEDS.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:183:        // Both Builtin(0) → "General" and Custom(LEGACY_PEER, 0) →
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:185:        // bind to Custom(LEGACY_PEER, 0); lookup resolves to "General"
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:188:        let baseline = wb.formats().len();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:196:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:202:        assert_eq!(wb.formats().len(), baseline + 1);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:204:        assert_eq!(wb.formats().lookup(FormatId::Builtin(0)), Some("General"));
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:206:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:211:        // the Custom(LEGACY_PEER, 0) registration. The intern lookup
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:215:            FormatId::Builtin(0),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:227:            .register_at(FormatId::legacy_from_u32(164), "yyyy-mm-dd")
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:236:        match register_custom_formats(&mut wb, &idx) {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:247:        // no-op (the register_at impl handles this).
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:256:        register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:258:        register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:260:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:50:        sheet0.format_overlay().get(5, 3)
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:55:        sheet1.format_overlay().get(0, 0)
quantbook-engine/crates/ql-collab/src/session.rs:164:    ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
quantbook-engine/crates/ql-collab/src/session.rs:173:            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
quantbook-engine/crates/ql-collab/src/session.rs:205:    ///   `PeerId(0)` is `LEGACY_PEER` — debug-asserted just like
quantbook-engine/crates/ql-collab/src/session.rs:212:            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:233:    // them with the workbook's FormatTable via `register_at` so the
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:239:        read::styles_import::register_custom_formats(&mut workbook, &style_index)?;
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:275:            // n >= 164 → Custom(LEGACY_PEER, n - 164). Step 6 may
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:278:            // ids land under LEGACY_PEER.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:279:            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:56:        if let Some(existing) = self.workbook.formats().lookup_string(s) {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:65:        // `to_legacy_u32().expect(...)` conversion. The producer
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:70:        let formats = self.workbook.formats();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:71:        let id = FormatId::Custom(formats.local_peer(), formats.next_custom_counter());
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:107:            if self.workbook.formats().lookup(fid).is_none() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:117:                // drop the pre-step-4 to_legacy_u32 expect.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:158:    /// `read_display` for that id. `FormatTable::register_at` rejects
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:175:            .and_then(|s| s.format_overlay().get(row, col))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:182:                .formats()
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:226:            assert_eq!(id2, FormatId::Builtin(2));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:242:            // Step 3: first custom under LEGACY_PEER, counter=0.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:243:            // Round-trips to legacy u32 = 164 (FIRST_CUSTOM_FORMAT_ID).
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:244:            assert_eq!(id.to_legacy_u32(), Some(ql_storage::FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:245:            assert_eq!(id, FormatId::Custom(ql_types::LEGACY_PEER, 0));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:252:                // LEGACY_PEER = Custom { peer: LEGACY_PEER, counter: 0 }.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:256:                        peer: ql_types::LEGACY_PEER,
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:289:            rt.set_cell_format(s, 3, 5, Some(FormatId::Builtin(14)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:294:            wb.sheet(s).unwrap().format_overlay().get(3, 5),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:295:            Some(FormatId::Builtin(14))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:316:            .set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:323:        assert_eq!(wb.sheet(s).unwrap().format_overlay().get(0, 0), None);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:336:        let bad_id = FormatId::legacy_from_u32(9999);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:339:        // legacy_from_u32(9999) = Custom(LEGACY_PEER, 9999 - 164) = 9835.
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:368:            .set(0, 0, FormatId::Builtin(14)); // m/d/yyyy
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:418:            .set(0, 0, FormatId::Builtin(14));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:432:            .set(0, 0, FormatId::Builtin(49)); // @
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:455:        let custom_id = FormatId::legacy_from_u32(ql_storage::FIRST_CUSTOM_FORMAT_ID);
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:457:            replay_wb.formats().lookup(custom_id),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:462:            replay_wb.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:263:    for (id, s) in wb2.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:266:        // Custom(LEGACY_PEER, _) via legacy_from_u32(numFmtId) — xlsx
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:267:        // has no peer-id concept to recover. So to_legacy_u32() still
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:272:                id.to_legacy_u32()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:273:                    .expect("xlsx import always produces LEGACY_PEER customs (legacy_from_u32)"),
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:777:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:895:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:2://! Does register_at handle this gracefully?
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:73:            for (id, c) in res.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:79:            println!("  A1 overlay = {:?}", sheet.format_overlay().get(0, 0));
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:80:            println!("  B1 overlay = {:?}", sheet.format_overlay().get(0, 1));
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:151:        sheet.format_overlay().get(0, 0)
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:156:            .formats()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:157:            .lookup(ql_storage::FormatId::legacy_from_u32(164))
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:160:    // closure for the "General-at-custom-id" case treats register_at
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:163:    // `numFmts` from `wb.formats().iter()` which filters to >= 164;
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs:66:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs:76:        .map(|s| s.format_overlay().len())
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs:109:        .map(|s| s.format_overlay().len())
quantbook-engine/crates/ql-io-xlsx/tests/phase_4_11_corpus_probe.rs:113:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:308:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:334:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:830:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:861:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:866:    let imported_overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:889:    let builtin = FormatId::Builtin(14);
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:907:    let imported_overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:910:        Some(FormatId::Builtin(14)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:956:    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:959:    assert_eq!(result.workbook.formats().lookup(fmt), Some(custom_code));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:972:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:998:    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1024:    // sees only LEGACY_PEER customs, so to_legacy_u32 succeeds).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1025:    let fmt_a_n = fmt_a.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1026:    let fmt_b_n = fmt_b.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1027:    let fmt_c_n = fmt_c.to_legacy_u32().unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1065:        result.workbook.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1069:        result.workbook.sheet(0).unwrap().format_overlay().get(0, 1),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1073:        result.workbook.sheet(1).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1242:        result.workbook.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1253:    // panic the importer via FormatTable::register_at's
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1322:    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1604:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1630:    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1633:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1649:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1684:            .format_overlay()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1690:        result.workbook.sheet(1).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1691:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1727:            .map(|s| !s.format_overlay().is_empty())
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1773:    // xlsx export's `to_legacy_u32().expect(...)` panicked on
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1786:    // LEGACY_PEER. Apply each to a distinct cell.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1789:    assert_eq!(peer42_fmt, FormatId::Custom(PeerId::new(42), 0));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1793:    assert_eq!(peer99_fmt, FormatId::Custom(PeerId::new(99), 0));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1795:    wb.formats_mut().set_local_peer(ql_types::LEGACY_PEER);
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1797:    assert_eq!(legacy_fmt, FormatId::Custom(ql_types::LEGACY_PEER, 0));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1812:    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1813:    // are not LEGACY_PEER.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1844:    // Re-importing should produce 3 Custom(LEGACY_PEER, _) entries
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1860:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1877:    // Every imported Custom must be LEGACY_PEER-tagged (xlsx collapses peers).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1878:    for (id, _) in result.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1879:        if let FormatId::Custom(peer, _) = id {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1882:                ql_types::LEGACY_PEER,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1883:                "xlsx import always recovers as LEGACY_PEER (no peer concept in xlsx); got {peer:?}"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1895:    // The translation maps Custom(LEGACY_PEER, c) → c + 164, identical
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1896:    // to the pre-step-6 to_legacy_u32() output. We verify by running
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1899:    // accidentally treat LEGACY_PEER as non-LEGACY).
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1900:    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1906:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1922:    // Zero multi-peer-flatten entries for a LEGACY_PEER-only workbook.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1936:            "LEGACY_PEER-only workbook must not produce multi-peer-flatten entries; got {drops:#?}"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1952:        .formats()
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1953:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:48:    for (id, c) in r.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:73:        sheet.format_overlay_mut().set(0, 0, FormatId::Builtin(38)); // not pre-populated; renders as color
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:74:        sheet.format_overlay_mut().set(0, 1, FormatId::Builtin(46)); // also not pre-populated
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:75:        sheet.format_overlay_mut().set(0, 2, FormatId::Builtin(9)); // pre-populated "0%"
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:105:        let f = sheet2.format_overlay().get(0, c);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_format_no_overlay.rs:111:            f.and_then(|i| r.workbook.formats().lookup(i))
quantbook-engine/crates/ql-exec/src/workbook_runtime/mod.rs:154:    /// `Workbook::formats()` lookup; `FormatTable::register_at` rejects
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:399:        for (id, code) in first.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:405:            // shows variant + payload (e.g. `Custom(LEGACY_PEER, 36)`).
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:406:            match second.workbook.formats().lookup(id) {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:467:            for ((r, c), fid1) in s1.format_overlay().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:482:                let fid2 = match s2.format_overlay().get(r, c) {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:498:                    let code1 = first.workbook.formats().lookup(fid1);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:499:                    let code2 = second.workbook.formats().lookup(fid2);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:511:                    let code1 = first.workbook.formats().lookup(fid1);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:512:                    let code2 = second.workbook.formats().lookup(fid2);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:675:        sheet.format_overlay_mut().set(0, 4, FormatId::Builtin(14)); // built-in
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:767:    for (id, code) in wb.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:771:        match second.workbook.formats().lookup(id) {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:788:    for ((r, c), fid) in sa.format_overlay().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:789:        let v2 = sb.format_overlay().get(r, c);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:790:        let code_orig = wb.formats().lookup(fid);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:791:        let code_new = v2.and_then(|f| second.workbook.formats().lookup(f));
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:912:                .map(|s| s.format_overlay().len())
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:168:            for (id, code) in r.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:228:    for (id, c) in r.workbook.formats().iter() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:334:    let fmt_date = ql_storage::FormatId::Builtin(14); // built-in
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:358:        let f = sheet2.format_overlay().get(0, c);
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:364:            f.and_then(|i| r.workbook.formats().lookup(i))
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:408:        rt.set_cell_format(0, 0, 0, Some(FormatId::Builtin(14)))
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:438:        loaded_wb.formats().lookup(custom_id),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:444:        loaded_wb.sheet(0).unwrap().format_overlay().get(0, 0),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:445:        Some(FormatId::Builtin(14)),
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:449:        loaded_wb.sheet(0).unwrap().format_overlay().get(1, 0),

exec
/bin/zsh -lc "sed -n '1,230p' quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Workbook-level format-string interning table (Phase 4.5.D part 3,
//! W5-79).
//!
//! `FormatTable` reserves Excel built-in format IDs 0-163 (`Builtin`
//! variant) and allocates custom IDs as `Custom(peer, counter)` tuples
//! (Phase 5.2 D-1 step 3 — was a bare `u32` pre-step-3). Pre-populates
//! the parser-relevant subset of built-ins (mini-spec § 10) so cells
//! with the most common formats resolve without any registration calls.
//!
//! ## Phase 5.2 D-1 step 3 (2026-05-19) — tagged-tuple FormatId
//!
//! `FormatId` changed from `pub struct FormatId(pub u32)` to a tagged
//! enum to support multi-peer CRDT collaboration:
//!
//! ```ignore
//! pub enum FormatId {
//!     Builtin(u32),                  // Excel-canonical ids 0..=163
//!     Custom(PeerId, u32),           // peer-allocated, per-peer counter
//! }
//! ```
//!
//! `FormatTable` carries a `local_peer: PeerId` (set at construction)
//! used by [`FormatTable::intern`] when allocating new custom ids.
//! Single-writer / pre-collab callers use [`LEGACY_PEER`] as the
//! `local_peer`. Multi-peer sessions set their own `PeerId` at attach
//! time (Phase 5.2 D-1 step 4 wiring).
//!
//! Migration helper [`FormatId::legacy_from_u32`] converts pre-5.2
//! bare-u32 ids back to the enum shape for backward-compat loading
//! (used by qbook envelope loader in step 5 and xlsx import in step 6).
//!
//! See:
//! - `docs/architecture/crdt-data-model.md` § D-1 for the design.
//! - `docs/phase5/d-1-starting-checklist.md` for the multi-step plan.
//! - `docs/architecture/2026-05-13-dates-times-formats.md` § 7.1 for
//!   the format-string parser.
//! - `docs/architecture/2026-05-13-format-string-grammar.md` § 10 for
//!   the parser-relevant built-in subset.

use std::collections::HashMap;

use ql_types::{PeerId, LEGACY_PEER};

/// Workbook format id — tagged tuple (Phase 5.2 D-1 step 3 ship).
///
/// Two variants:
/// - `Builtin(u32)` — Excel-canonical ids `0..=163` (stable across
///   peers; no merge collisions possible by construction).
/// - `Custom(PeerId, u32)` — peer-allocated. Each peer's allocator
///   increments its own `counter`; concurrent peers can't collide
///   because the `PeerId` differs (Phase 5.1 audit-locked decision
///   D-1).
///
/// Use [`FormatId::GENERAL`] for the "no custom format" case (= built-in id 0).
///
/// Mirrors `ql_oplog::wire::FormatIdWire`; the wire type is the
/// `Op::RegisterFormat` / `Op::SetCellFormat` payload (step 4).
///
/// **Builtin(n) range invariant (step 3 audit Codex+Opus MEDIUM-1):**
/// `FormatId::Builtin(n)` is contractually valid ONLY for
/// `n <= FIRST_XLSX_BUILTIN_MAX` (= 163). The enum's tuple variant
/// can't enforce this at the type level (Rust syntax limitation), so
/// the invariant is documentary. **Callers MUST use
/// [`FormatId::legacy_from_u32`] for u32 values that may exceed
/// 163** — that helper routes 164+ to `Custom(LEGACY_PEER, n - 164)`.
/// Directly constructing `Builtin(200)` breaks `to_legacy_u32` ↔
/// `legacy_from_u32` round-trip (becomes asymmetric in the
/// storage→u32→storage direction).
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum FormatId {
    /// Excel-canonical built-in format id (`0..=163`).
    Builtin(u32),
    /// Peer-allocated custom format id. The `(peer, counter)` pair
    /// is collision-free across concurrent peers because `peer`
    /// differs (Phase 5.1 audit D-1).
    Custom(PeerId, u32),
}

impl Default for FormatId {
    fn default() -> Self {
        FormatId::GENERAL
    }
}

impl FormatId {
    /// Excel built-in id 0 — "General". Default for cells with no explicit format.
    pub const GENERAL: FormatId = FormatId::Builtin(0);

    /// True iff this is a built-in (Excel-canonical) format id.
    pub const fn is_builtin(self) -> bool {
        matches!(self, FormatId::Builtin(_))
    }

    /// True iff this is a peer-allocated custom format id.
    pub const fn is_custom(self) -> bool {
        matches!(self, FormatId::Custom(_, _))
    }

    /// **Phase 5.2 D-1 step 3 migration helper:** map a pre-5.2 bare
    /// `u32` `FormatId` encoding to the new tagged-tuple form.
    ///
    /// Pre-5.2 encoding: `FormatId(pub u32)`. Values `0..=163` are
    /// Excel built-ins. Values `>=164` were allocated by the pre-5.2
    /// single-writer counter starting at `FIRST_CUSTOM_FORMAT_ID = 164`.
    ///
    /// Mapping:
    /// - `n <= 163` → `Builtin(n)`.
    /// - `n >= 164` → `Custom(LEGACY_PEER, n - 164)`.
    ///
    /// Cross-references `ql_oplog::wire::FormatIdWire::from_u32_legacy`
    /// (the wire-side counterpart shipped at step 2). Both helpers
    /// must agree on the 164 boundary; step 8 megaudit verifies.
    ///
    /// Used by `ql_io::qbook_format` (step 5 envelope loader) and
    /// `ql_io_xlsx` import paths (step 6).
    pub fn legacy_from_u32(n: u32) -> Self {
        if n <= FIRST_XLSX_BUILTIN_MAX {
            FormatId::Builtin(n)
        } else {
            FormatId::Custom(LEGACY_PEER, n - FIRST_CUSTOM_FORMAT_ID)
        }
    }

    /// **Phase 5.2 D-1 step 3:** map this `FormatId` back to the
    /// pre-5.2 bare-`u32` shape, if expressible.
    ///
    /// - `Builtin(n)` → `Some(n)`.
    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
    ///   pre-5.2 saves).
    /// - `Custom(non-legacy-peer, _)` → `None` (a peer other than
    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
    ///   represent it). Step 6's xlsx export decides what to do
    ///   (e.g. flatten by allocation order).
    pub fn to_legacy_u32(self) -> Option<u32> {
        match self {
            FormatId::Builtin(n) => Some(n),
            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
            FormatId::Custom(_, _) => None,
        }
    }
}

/// Lower-bound of Excel's built-in format-id range (inclusive).
/// `FormatId::Builtin(n)` is valid for `n <= FIRST_XLSX_BUILTIN_MAX`;
/// values above this were custom ids in the pre-5.2 single-writer
/// encoding. Mirrors `ql_oplog::wire::wire::FIRST_XLSX_BUILTIN_MAX`.
const FIRST_XLSX_BUILTIN_MAX: u32 = 163;

/// First custom (non-built-in) format id in the pre-5.2 bare-u32
/// encoding. Kept as a public constant because xlsx import / export
/// + qbook envelope migration use this boundary explicitly.
///
/// Post-5.2: custom ids live in `FormatId::Custom(peer, counter)`;
/// `counter` starts at `0`, not 164. This constant remains for
/// `to_legacy_u32` / `legacy_from_u32` conversions only.
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
///
/// Phase 5.2 D-1 step 3: `FormatTable` now carries a `local_peer`
/// (`PeerId`) used when allocating new `Custom` format ids in
/// [`Self::intern`]. Single-writer / pre-collab construction (e.g.
/// `FormatTable::new()`) uses [`LEGACY_PEER`]; multi-peer
/// `CollabSession` callers re-construct with their session's peer
/// at attach time (step 4 wiring).
#[derive(Clone, Debug)]
pub struct FormatTable {
    /// `id → string`. Sparse (only entries that exist).
    by_id: HashMap<FormatId, String>,
    /// `string → Builtin(n)`. Built-in format strings are global —
    /// "General" must always resolve to `Builtin(0)` regardless of
    /// peer. Used by `intern` for built-in lookup (Excel-canonical
    /// strings short-circuit before peer-namespaced lookup).
    ///
    /// Phase 5.2 D-1 step 4 restructure (Codex audit HIGH-2 closure):
    /// was previously a single global `HashMap<String, FormatId>`
    /// that rejected cross-peer same-string allocations. Now split
    /// into separate built-in vs peer-namespaced maps.
    by_builtin_string: HashMap<String, FormatId>,
    /// `(peer, string) → Custom(peer, _)`. Used by `intern` for
    /// per-peer dedup. Two peers interning the same string produce
    /// distinct `Custom` ids with distinct counters — Phase 5.1 D-1
    /// audit-locked design.
    ///
    /// Phase 5.2 D-1 step 4 restructure (Codex audit HIGH-2 closure):
    /// see above.
    by_custom_string: HashMap<(PeerId, String), FormatId>,
    /// Next `Custom(local_peer, _)` counter to hand out. Each peer's
    /// counter is independent; concurrent peers can't collide because
    /// the `PeerId` differs. Starts at `0` (post-5.2; pre-5.2 used
    /// `FIRST_CUSTOM_FORMAT_ID = 164` in the bare-u32 encoding).
    next_custom_counter: u32,
    /// Peer id used when allocating `Custom` ids via `intern`.
    /// Set at construction; defaults to `LEGACY_PEER` (= `PeerId(0)`)
    /// for backward compat with pre-collab single-writer mode.
    /// `CollabSession::attach` (step 7 IDE work) updates this via
    /// [`Self::set_local_peer`] when a multi-peer session takes over.

exec
/bin/zsh -lc "sed -n '230,540p' quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    /// [`Self::set_local_peer`] when a multi-peer session takes over.
    local_peer: PeerId,
}

impl Default for FormatTable {
    fn default() -> Self {
        Self::with_peer(LEGACY_PEER)
    }
}

impl FormatTable {
    /// Fresh table with Excel built-ins (mini-spec § 10 subset) pre-loaded.
    /// Custom ids allocated by this instance carry [`LEGACY_PEER`] —
    /// matching the pre-5.2 single-writer semantics.
    pub fn new() -> Self {
        Self::default()
    }

    /// Phase 5.2 D-1 step 3: fresh table with `peer` set as the
    /// allocator's `local_peer`. Future custom-id allocations via
    /// [`Self::intern`] produce `FormatId::Custom(peer, counter)`
    /// with monotonic per-peer counter.
    pub fn with_peer(peer: PeerId) -> Self {
        let mut t = Self {
            by_id: HashMap::new(),
            by_builtin_string: HashMap::new(),
            by_custom_string: HashMap::new(),
            next_custom_counter: 0,
            local_peer: peer,
        };
        for (id, s) in BUILTIN_FORMATS {
            let fid = FormatId::Builtin(*id);
            t.by_id.insert(fid, (*s).to_string());
            t.by_builtin_string.insert((*s).to_string(), fid);
        }
        t
    }

    /// Phase 5.2 D-1 step 3: peer id used for future custom-id
    /// allocations. Read by `Op::RegisterFormat` producers and by
    /// tests verifying peer-aware allocation.
    pub fn local_peer(&self) -> PeerId {
        self.local_peer
    }

    /// Phase 5.2 D-1 step 3: change the peer id used for future
    /// allocations. Existing entries are NOT relabeled — they keep
    /// the peer they were originally allocated under.
    ///
    /// **Counter resync (step 3 audit Codex HIGH-1 closure):** scans
    /// `by_id` for existing `Custom(peer, _)` entries and sets
    /// `next_custom_counter` to `max(c) + 1` so the new peer's
    /// allocator doesn't overwrite entries already registered for it
    /// (e.g. via replay of a remote peer's `Op::RegisterFormat`).
    /// Without this scan, a sequence like:
    ///
    /// 1. `register_at(Custom(P, 0), "X")` (replay; local peer ≠ P)
    /// 2. `set_local_peer(P)`
    /// 3. `intern("Y")`
    ///
    /// would overwrite the entry at `Custom(P, 0)` (was "X", becomes
    /// "Y") because the counter wasn't reset.
    ///
    /// Step 4 will call this from `CollabSession::attach` when a
    /// multi-peer session takes over from the default
    /// `LEGACY_PEER`-tagged construction.
    pub fn set_local_peer(&mut self, peer: PeerId) {
        self.local_peer = peer;
        // Resync counter to max(existing Custom(peer, c).c) + 1, or 0
        // if no such entry exists. This guarantees subsequent `intern`
        // calls allocate fresh counters past anything replayed for
        // this peer.
        let max_existing = self
            .by_id
            .keys()
            .filter_map(|fid| match fid {
                FormatId::Custom(p, c) if *p == peer => Some(*c),
                _ => None,
            })
            .max();
        // Step-4 audit Codex MEDIUM-1: use checked_add to catch
        // u32::MAX counter overflow (which would wrap to 0 in release
        // and overwrite Custom(peer, 0)). With u32::MAX peer-local
        // custom formats this fires loudly rather than corrupting.
        self.next_custom_counter = max_existing
            .map(|c| {
                c.checked_add(1).expect(
                    "FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)",
                )
            })
            .unwrap_or(0);
    }

    /// Look up the format string for `id`. Returns `None` if the id has
    /// never been registered (which includes most reserved 0-163 ids that
    /// weren't pre-populated by V1 — those land via xlsx import).
    pub fn lookup(&self, id: FormatId) -> Option<&str> {
        self.by_id.get(&id).map(|s| s.as_str())
    }

    /// **Phase 5.2 D-1 step 4 audit Codex HIGH-1 closure:** lookup a
    /// format-string and return the id this peer's `intern(s)` would
    /// return WITHOUT allocating. Mirrors `intern`'s lookup order:
    ///
    /// 1. `by_builtin_string` (Excel canonical strings short-circuit
    ///    globally — same answer for every peer).
    /// 2. `by_custom_string[(local_peer, s)]` (THIS peer's Custom
    ///    dedup; intentionally does NOT find OTHER peers' Customs
    ///    with the same string).
    /// 3. Returns `None` if no existing id — caller `intern_format`
    ///    knows it must emit `Op::RegisterFormat` for the new allocation.
    ///
    /// Used by `WorkbookRuntime::intern_format` to dedupe correctly
    /// under multi-peer semantics. The pre-step-4 producer used
    /// `FormatTable::iter().find(|(_, t)| *t == s)` which returned
    /// ANY id with that string, including remote peers' Customs —
    /// that broke producer/replay symmetry once multi-peer replay
    /// populated `by_id` with other peers' entries.
    pub fn lookup_string(&self, s: &str) -> Option<FormatId> {
        if let Some(id) = self.by_builtin_string.get(s) {
            return Some(*id);
        }
        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
            return Some(*id);
        }
        None
    }

    /// Intern `s`. Returns the existing id if `s` is already present;
    /// otherwise allocates a new `FormatId::Custom(local_peer, counter)`
    /// and stores both directions.
    ///
    /// **Lookup order (Phase 5.2 D-1 step 4 restructure):**
    /// 1. `by_builtin_string` first — Excel built-ins are global; e.g.
    ///    `intern("General")` always returns `Builtin(0)` regardless of
    ///    `local_peer`.
    /// 2. `by_custom_string[(local_peer, s)]` — this peer's own custom
    ///    dedup map. A remote peer's `Custom(other_peer, _)` with the
    ///    same string does NOT short-circuit our allocation.
    /// 3. Allocate fresh `Custom(local_peer, counter)`.
    ///
    /// **Replay determinism:** the allocator is monotonic in insertion
    /// order WITHIN A PEER. As long as the op-log replays
    /// `Op::RegisterFormat` events in the same order they were
    /// originally written, custom ids reconstruct identically. Across
    /// peers, the `peer` component of each `Custom` keeps ids distinct
    /// even when counter values collide.
    pub fn intern(&mut self, s: &str) -> FormatId {
        if let Some(id) = self.by_builtin_string.get(s) {
            return *id;
        }
        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
            return *id;
        }
        let id = FormatId::Custom(self.local_peer, self.next_custom_counter);
        // Step-4 audit Codex MEDIUM-1: checked_add to catch overflow.
        self.next_custom_counter = self
            .next_custom_counter
            .checked_add(1)
            .expect("FormatTable: custom counter exhausted (u32::MAX per-peer custom formats)");
        self.by_id.insert(id, s.to_string());
        self.by_custom_string
            .insert((self.local_peer, s.to_string()), id);
        id
    }

    /// Register `s` at a specific id (typically an Excel built-in or a
    /// replay path). Returns `Err` if the id is already taken with a
    /// different string — that would break round-trip determinism.
    ///
    /// **Replay use case:** `Op::RegisterFormat { id, string }` calls
    /// this to reproduce the original allocator state — including ids
    /// allocated by OTHER peers.
    ///
    /// For ids tagged with `self.local_peer`, advances the local
    /// counter past the registered counter so subsequent `intern`
    /// calls don't collide.
    ///
    /// **Step 4 by_string restructure (Codex step-3 audit HIGH-2
    /// closure):** Custom and Builtin variants use SEPARATE dedup
    /// maps. Two peers can register the same string under their own
    /// `Custom(peer, _)` ids without collision (Phase 5.1 D-1
    /// audit-locked design). Cross-variant string collisions are
    /// allowed too — e.g. LibreOffice writes `<numFmt numFmtId="164"
    /// formatCode="General"/>` (Custom variant) while "General" also
    /// lives at `Builtin(0)`; both coexist.
    pub fn register_at(&mut self, id: FormatId, s: &str) -> Result<(), FormatTableError> {
        // Step 0: pre-validate `id` shape BEFORE any state mutation —
        // Phase 5.2 D-1 step 5 audit Codex HIGH-1 + HIGH-2 closure
        // (2026-05-20). User-controlled load paths (qbook envelope +
        // replay) feed potentially-malformed FormatIds into this fn;
        // panics inside the post-insert counter-advance would leave
        // partial state. Catching shape errors upfront keeps the table
        // consistent under bad input.
        //
        // HIGH-2: `Builtin(n)` is contractually `0..=163` (Excel-canonical
        // built-in format ids). `FormatIdWire::Builtin { id: u32 }` carries
        // no range bound at the type level, so a v8 envelope could smuggle
        // in `Builtin(200)` which would later get dropped on resave (the
        // `is_custom()` filter excludes built-in variants from the formats
        // section). Reject upfront.
        if let FormatId::Builtin(n) = id {
            if n > FIRST_XLSX_BUILTIN_MAX {
                return Err(FormatTableError::BuiltinOutOfRange { id: n });
            }
        }
        // HIGH-1: if this `Custom(local_peer, counter)` would advance the
        // local counter past `u32::MAX`, refuse before mutating. Without
        // this guard, the post-insert `counter.checked_add(1).expect(...)`
        // panicked on `counter == u32::MAX` — directly reachable from a
        // malformed v8 `.qbook` envelope.
        if let FormatId::Custom(peer, counter) = id {
            if peer == self.local_peer
                && counter >= self.next_custom_counter
                && counter.checked_add(1).is_none()
            {
                return Err(FormatTableError::CounterOverflow { peer });
            }
        }
        // Step 1: id-side dedup. If `id` is already present, must map
        // to the same string (else IdCollision — a real corruption).
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
        // Step 2: string-side dedup, routed by variant.
        match id {
            FormatId::Builtin(_) => {
                if let Some(existing_id) = self.by_builtin_string.get(s) {
                    if *existing_id == id {
                        return Ok(());
                    }
                    return Err(FormatTableError::StringCollision {
                        string: s.to_string(),
                        existing_id: *existing_id,
                        attempted_id: id,
                    });
                }
            }
            FormatId::Custom(peer, _) => {
                if let Some(existing_id) = self.by_custom_string.get(&(peer, s.to_string())) {
                    if *existing_id == id {
                        return Ok(());
                    }
                    return Err(FormatTableError::StringCollision {
                        string: s.to_string(),
                        existing_id: *existing_id,
                        attempted_id: id,
                    });
                }
            }
        }
        // Step 3: insert into by_id + the appropriate string map.
        self.by_id.insert(id, s.to_string());
        match id {
            FormatId::Builtin(_) => {
                self.by_builtin_string.insert(s.to_string(), id);
            }
            FormatId::Custom(peer, _) => {
                self.by_custom_string.insert((peer, s.to_string()), id);
            }
        }
        // Step 4: if `id` is a Custom-variant for OUR peer, advance
        // the local counter so subsequent `intern` calls allocate
        // fresh counters past any replayed ones.
        if let FormatId::Custom(peer, counter) = id {
            if peer == self.local_peer && counter >= self.next_custom_counter {
                // Step-4 audit Codex MEDIUM-1 + step-5 audit Codex HIGH-1:
                // overflow was pre-validated at the top of `register_at`
                // (Step 0), so this `checked_add(1)` cannot return None.
                // `expect` documents the invariant rather than introducing
                // a real panic path.
                self.next_custom_counter = counter
                    .checked_add(1)
                    .expect("counter overflow was pre-validated at register_at entry");
            }
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

    /// The counter `intern` will use for the next allocation (the
    /// `counter` component of the resulting `FormatId::Custom(local_peer,
    /// counter)`). Exposed for tests + replay state-check.
    ///
    /// Phase 5.2 D-1 step 3 rename: was `next_custom_id() -> u32` and
    /// returned the full pre-5.2 u32 id. Now returns just the counter
    /// (which is per-peer); the full FormatId is built as
    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
    pub fn next_custom_counter(&self) -> u32 {
        self.next_custom_counter
    }

    /// Iterate `(id, &str)` in arbitrary order. Persistence + op-log
    /// snapshotting consumers must sort by id when wire-stable order

exec
/bin/zsh -lc "sed -n '1,140p' quantbook-engine/crates/ql-storage/src/sheet.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! `Sheet` — a 2D collection of columns + dimension tracking.
//!
//! Per spec Part V §4 Week 2 Days 3-4:
//! - `columns: Vec<ColumnStore>`.
//! - `dimensions: Bounds` tracking the largest (row, col) ever written, conservative.
//! - Open-ended: reading a cell beyond `dimensions` returns `Value::Blank` (matches Excel).

use ql_types::{ColId, RowId, Value};

use crate::column::ColumnStore;
use crate::workbook::{NameTable, NameTableError, NamedTarget};

/// Conservative dimension tracking: max row and max col ever touched. Reads beyond return
/// `Blank` either way; `Bounds` exists for serialization + UI viewport sizing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bounds {
    /// One past the largest row ever written. Zero on an empty sheet.
    pub row_extent: RowId,
    /// One past the largest column ever touched.
    pub col_extent: ColId,
}

/// A single sheet. Columns are independent `ColumnStore`s; the sheet owns them.
#[derive(Clone, Debug, Default)]
pub struct Sheet {
    name: String,
    columns: Vec<ColumnStore>,
    bounds: Bounds,
    chunk_rows: u32,
    /// **W5-79 (Phase 4.5.D part 3):** per-sheet sparse cell-format
    /// overlay. Cells without an entry render via `FormatId::GENERAL`.
    /// Resolution: lookup the id here, then call
    /// `workbook.formats().lookup(id)` to get the format-string, parse,
    /// and render.
    format_overlay: crate::CellFormatOverlay,
    /// **W5-92 (Phase 4.6.D):** sheet-scoped defined names. Lookup
    /// resolves sheet-scoped names first, then falls back to the
    /// workbook-scoped table; this is the storage half of that chain.
    /// `WorkbookEnv::lookup_named_target_for_sheet` (in `ql-exec`)
    /// owns the chain-walking logic. Same canonicalization rules as
    /// the workbook-scoped `NameTable` (ASCII-uppercase canonical).
    scoped_names: NameTable,
}

impl Sheet {
    /// New empty sheet with the given name. Chunk size from env (or default).
    pub fn new(name: impl Into<String>) -> Self {
        Self::with_chunk_rows(name, crate::column::chunk_rows_from_env())
    }

    /// New empty sheet with an explicit chunk size — useful for tests.
    pub fn with_chunk_rows(name: impl Into<String>, chunk_rows: u32) -> Self {
        Self {
            name: name.into(),
            columns: Vec::new(),
            bounds: Bounds::default(),
            chunk_rows,
            format_overlay: crate::CellFormatOverlay::new(),
            scoped_names: NameTable::new(),
        }
    }

    /// **W5-79 (Phase 4.5.D part 3):** read access to the per-sheet
    /// cell-format overlay.
    pub fn format_overlay(&self) -> &crate::CellFormatOverlay {
        &self.format_overlay
    }

    /// **W5-79 (Phase 4.5.D part 3):** mutable access for `set` /
    /// `clear`. Phase 4.5.D part 4 (W5-80) will route mutations through
    /// `WorkbookRuntime::set_cell_format` so they emit
    /// `Op::SetCellFormat`; direct access stays available for the
    /// loader + tests.
    pub fn format_overlay_mut(&mut self) -> &mut crate::CellFormatOverlay {
        &mut self.format_overlay
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// **W5-92 (Phase 4.6.D):** read access to the per-sheet named-target
    /// table. Storage-layer surface only — bind-time chain walking
    /// happens in `ql-exec::env::WorkbookEnv`.
    pub fn scoped_names(&self) -> &NameTable {
        &self.scoped_names
    }

    /// **W5-92 (Phase 4.6.D):** mutable access for loader paths +
    /// op-log replay. Production callers route through
    /// `WorkbookRuntime::set_sheet_scoped_name` (which emits
    /// `Op::SetName { scope: Some(_), .. }`).
    pub fn scoped_names_mut(&mut self) -> &mut NameTable {
        &mut self.scoped_names
    }

    /// **W5-92 (Phase 4.6.D):** register a sheet-scoped name. Mirrors
    /// `Workbook::set_name` (validate, append, propagate generation).
    /// Reserved-name guard still applies (CORR-06 / `AI`); callers see
    /// `NameTableError::Reserved` for those.
    pub fn set_scoped_name(
        &mut self,
        name: &str,
        target: NamedTarget,
    ) -> Result<(), NameTableError> {
        self.scoped_names.set(name, target)
    }

    /// **W5-92 (Phase 4.6.D):** drop a sheet-scoped name. Idempotent
    /// (no-op for unknown names).
    pub fn clear_scoped_name(&mut self, name: &str) {
        self.scoped_names.clear(name);
    }

    /// **Phase 4.6.C (W5-91):** in-place display-name update. Validation
    /// is the caller's responsibility (see `Workbook::rename_sheet` and
    /// `Workbook::validate_sheet_name`). This method is low-level and
    /// loader-only-friendly: it doesn't touch formula text, dependent
    /// names, or any cache; the runtime wrapper owns those concerns.
    pub fn set_name(&mut self, new_name: impl Into<String>) {
        self.name = new_name.into();
    }

    pub fn bounds(&self) -> Bounds {
        self.bounds
    }

    /// Row count per chunk for this sheet. Used by ql-io (W5-6) to record the actual
    /// chunk layout for round-trip. Audit H5 fix (2026-05-12).
    pub fn chunk_rows(&self) -> u32 {
        self.chunk_rows
    }

    pub fn column_count(&self) -> usize {
        self.columns.len()
    }

    /// Borrow a column. None if `col` ≥ existing column count.
    pub fn column(&self, col: ColId) -> Option<&ColumnStore> {
        self.columns.get(col as usize)

exec
/bin/zsh -lc "sed -n '1,120p' quantbook-engine/crates/ql-storage/src/workbook.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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
    /// reservations belong in `is_reserved_name` below.
    #[error("name {0:?} is reserved by the engine and cannot be registered")]
    Reserved(Arc<str>),
}

/// **Phase 4.6.AA (W5-86):** errors from `Workbook::validate_sheet_name`,
/// used by `add_sheet` / `rename_sheet` (Phase 4.6.C). Distinct from
/// `NameTableError` because the validation rules differ (sheet names
/// allow reserved-name-table entries like `AI`; sheet names reject
/// Excel-reserved characters; etc.).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum SheetNameError {
    /// Empty string — Excel canon rejects.
    #[error("sheet name cannot be empty")]
    Empty,

    /// Excel-reserved character in the proposed name. Set: `:`, `\`,
    /// `/`, `?`, `*`, `[`, `]`. xlsx round-trip prerequisite (Phase 4.11).
    #[error("sheet name contains Excel-reserved character {0:?}")]
    ReservedCharacter(char),

    /// Canonical duplicate of an existing sheet name (case-insensitive
    /// comparison per `Workbook::canonical_sheet_name`).
    #[error("sheet name {name:?} is already in use (case-insensitive)")]
    Duplicate { name: String },
}

/// Phase 2A.9 audit M6: the canonical-uppercase reserved-name list. Names
/// here cannot be registered via `NameTable::set` or `Workbook::set_name`.
/// Keep small; document each entry.
fn is_reserved_name(canonical: &str) -> bool {
    matches!(
        canonical,
        // CORR-06 / T4-D05: AI is the reserved sentinel that dispatches to
        // `Error(AINotAvailable)` until the Phase 4+ AI() function ships.
        "AI"
    )
}


exec
/bin/zsh -lc "sed -n '120,280p' quantbook-engine/crates/ql-storage/src/workbook.rs && sed -n '540,590p' quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:

/// **W5-D-PM12-2 (megaudit Opus-A HIGH-4 closure):** does `name` look
/// like an Excel column letter (`K`, `XFC`) or cell reference
/// (`A1`, `XFD1048576`)?
///
/// Helper kept available for the deferred HIGH-4 closure that
/// will reject these names at the producer once the binder's
/// AggregateArg-side literal-range support lands (HIGH-1). The
/// current code path doesn't call this — see `NameTable::set` for
/// the deferred-closure rationale.
#[allow(dead_code)]
fn looks_like_excel_cell_ref(canonical: &str) -> bool {
    let bytes = canonical.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    // Walk letters first.
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    // Excel column max is XFD = 3 letters. Anything else can't be a
    // ref shape.
    if i == 0 || i > 3 {
        return false;
    }
    // Pure-letter case: matches a column-letter token (`K`, `XFC`).
    if i == bytes.len() {
        return true;
    }
    // Letter-then-digits case: cell-ref shape (`A1`, `XFD1048576`).
    let rest = &canonical[i..];
    rest.bytes().all(|b| b.is_ascii_digit())
}

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
/// the save path persists the formula). Cells without an entry here are literals.
///
/// This is the minimum Phase 1 formula-persistence model. Phase 4+ adds:
/// - Calcgraph dependency tracking (computed-overlay separation per CORR-25).
/// - Automatic recompute on dependency change.
/// - Cross-sheet formula references.
///
/// ## Clone semantics
///
/// `Clone` is **shallow with respect to Arrow chunk buffers**: each
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
    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-1 closure (2026-05-20):**
    /// Attempted to `register_at` a `Custom(local_peer, counter)` where
    /// the resulting counter advancement would overflow `u32::MAX`.
    /// Pre-step-5-audit this was a `panic!` inside `register_at` (via
    /// `checked_add(1).expect(...)`) — user-controlled load paths (qbook
    /// envelope + replay) could trigger the panic from on-disk input.
    /// Now surfaces as a recoverable error so loaders can map to
    /// `QbookError::MalformedFormat` / `ReplayError::FormatRejected`.
    CounterOverflow { peer: PeerId },
    /// **Phase 5.2 D-1 step 5 audit Codex HIGH-2 closure (2026-05-20):**
    /// Attempted to `register_at` a `Builtin(n)` where `n > 163`. The
    /// `Builtin` variant is contractually `0..=FIRST_XLSX_BUILTIN_MAX`
    /// (Excel-canonical built-in format ids). `FormatIdWire::Builtin {
    /// id: u32 }` carries no range bound at the type level, so a
    /// malformed v8 `.qbook` envelope or replay op could smuggle in
    /// `Builtin(200)`. Pre-step-5-audit, this loaded successfully but
    /// the save path's `is_custom()` filter dropped the entry from
    /// `formats.entries`; reloading then failed at the overlay-id-not-
    /// registered guard. Validating here makes the load fail loudly at
    /// the original ingestion point.
    BuiltinOutOfRange { id: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]

exec
/bin/zsh -lc "sed -n '1720,1975p' quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    .unwrap();
    // At least one sheet should have at least one populated overlay
    // entry from the fixture's cellXfs roster.
    let any_overlay = (0..result.workbook.sheet_count() as u16).any(|sid| {
        result
            .workbook
            .sheet(sid)
            .map(|s| !s.format_overlay().is_empty())
            .unwrap_or(false)
    });
    assert!(
        any_overlay,
        "libreoffice fixture should populate at least one format_overlay \
         entry (W5-D-15.1 H-2 regression — applyNumberFormat default flipped)"
    );
}

#[test]
fn import_ironcalc_example_fixture_with_recompute_doesnt_panic() {
    // **W5-D-14a:** larger fixture with formulas. Run recompute in
    // best-effort mode. The point is: the pipeline doesn't panic
    // and (whatever formulas the engine supports) recompute makes
    // forward progress. Failures are reported, not fatal.
    let registry = ql_functions::default_registry();
    let opts = XlsxImportOptions {
        recompute: RecomputeMode::BestEffort,
        ..Default::default()
    };
    let result = import_xlsx_path(
        "../../.references/ironcalc/xlsx/tests/example.xlsx",
        &registry,
        opts,
    );
    // Whatever the report says, the import itself should succeed
    // (BestEffort = don't abort on formula failures).
    assert!(
        result.is_ok(),
        "example.xlsx BestEffort import should succeed, got {:?}",
        result.err()
    );
    let result = result.unwrap();
    assert!(result.workbook.sheet_count() > 0);
    // Report exists; whether formula_failures is empty depends on
    // engine fn coverage. Don't assert; just confirm the report is
    // structurally present.
    let _ = result.report.formula_failures.len();
}

// ===== Phase 5.2 D-1 step 6 (2026-05-20) — multi-peer xlsx export =====

#[test]
fn step6_multi_peer_format_ids_flatten_and_report_on_xlsx_export() {
    // **Step 6 closure test:** the property step 6 enables. Pre-step-6
    // xlsx export's `to_legacy_u32().expect(...)` panicked on
    // `Custom(non-LEGACY peer, _)` ids. Post-step-6 the export
    // flattens them into a contiguous xlsx numFmtId range starting at
    // 164 and surfaces the non-LEGACY entries via
    // `XlsxExportReport.dropped_features` (per the no-fallback rule
    // — silent loss is forbidden; explicit reporting is OK).
    use ql_storage::{FormatId, Workbook};
    use ql_types::{PeerId, Value};

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");

    // Allocate two Custom formats under non-LEGACY peers + one under
    // LEGACY_PEER. Apply each to a distinct cell.
    wb.formats_mut().set_local_peer(PeerId::new(42));
    let peer42_fmt = wb.formats_mut().intern("yyyy-mm-dd");
    assert_eq!(peer42_fmt, FormatId::Custom(PeerId::new(42), 0));

    wb.formats_mut().set_local_peer(PeerId::new(99));
    let peer99_fmt = wb.formats_mut().intern("0.0000%");
    assert_eq!(peer99_fmt, FormatId::Custom(PeerId::new(99), 0));

    wb.formats_mut().set_local_peer(ql_types::LEGACY_PEER);
    let legacy_fmt = wb.formats_mut().intern("#,##0.00 USD");
    assert_eq!(legacy_fmt, FormatId::Custom(ql_types::LEGACY_PEER, 0));

    wb.put_at(s, 0, 0, Value::Number(45000.0));
    wb.put_at(s, 1, 0, Value::Number(0.42));
    wb.put_at(s, 2, 0, Value::Number(1234.56));
    let sheet = wb.sheet_mut(s).unwrap();
    sheet.format_overlay_mut().set(0, 0, peer42_fmt);
    sheet.format_overlay_mut().set(1, 0, peer99_fmt);
    sheet.format_overlay_mut().set(2, 0, legacy_fmt);

    let tmp = std::env::temp_dir().join("step6-multi-peer-flatten.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();

    // Pre-step-6 this `export_xlsx_path` call would have PANICKED at
    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
    // are not LEGACY_PEER.
    let report = export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default())
        .expect("step 6: multi-peer xlsx export must succeed (was a panic pre-step-6)");

    // Report must surface the two non-LEGACY peer flattens — silent
    // information loss is forbidden by the no-fallback rule.
    let multi_peer_drops: Vec<&ql_io_xlsx::UnsupportedFeature> = report
        .dropped_features
        .iter()
        .filter(|f| {
            matches!(
                f.kind,
                ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
            )
        })
        .collect();
    assert_eq!(
        multi_peer_drops.len(),
        2,
        "expected 2 multi-peer flatten entries (peer 42 + peer 99); got {}: {multi_peer_drops:#?}",
        multi_peer_drops.len()
    );
    // Each detail string includes the original FormatId Debug form.
    let details: String = multi_peer_drops
        .iter()
        .map(|f| f.detail.as_str())
        .collect::<Vec<_>>()
        .join(" | ");
    assert!(details.contains("Custom(PeerId(42)"));
    assert!(details.contains("Custom(PeerId(99)"));

    // Re-importing should produce 3 Custom(LEGACY_PEER, _) entries
    // (xlsx has no peer concept to recover). The format CODES must
    // round-trip; the peer-ids collapse to LEGACY.
    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .expect("re-import of multi-peer-flattened xlsx must succeed");

    // All 3 original format codes are present in the reimported table.
    let mut imported_codes: Vec<String> = result
        .workbook
        .formats()
        .iter()
        .filter(|(id, _)| id.is_custom())
        .map(|(_, s)| s.to_string())
        .collect();
    imported_codes.sort();
    let mut expected_codes = vec![
        "yyyy-mm-dd".to_string(),
        "0.0000%".to_string(),
        "#,##0.00 USD".to_string(),
    ];
    expected_codes.sort();
    assert_eq!(
        imported_codes, expected_codes,
        "all 3 original format codes must round-trip through xlsx export+import"
    );

    // Every imported Custom must be LEGACY_PEER-tagged (xlsx collapses peers).
    for (id, _) in result.workbook.formats().iter() {
        if let FormatId::Custom(peer, _) = id {
            assert_eq!(
                peer,
                ql_types::LEGACY_PEER,
                "xlsx import always recovers as LEGACY_PEER (no peer concept in xlsx); got {peer:?}"
            );
        }
    }

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn step6_legacy_peer_only_workbook_xlsx_export_byte_unchanged() {
    // **Step 6 byte-stability test:** for the single-writer (pre-D-1)
    // workflow, the xlsx output bytes must be unchanged vs pre-step-6.
    // The translation maps Custom(LEGACY_PEER, c) → c + 164, identical
    // to the pre-step-6 to_legacy_u32() output. We verify by running
    // the export twice and checking that 0 multi-peer-flatten entries
    // appear in either report (so the flattening logic doesn't
    // accidentally treat LEGACY_PEER as non-LEGACY).
    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("S");
    let custom_id = wb.formats_mut().intern("0.0000");
    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
    wb.put_at(s, 0, 0, Value::Number(0.1234));
    wb.sheet_mut(s)
        .unwrap()
        .format_overlay_mut()
        .set(0, 0, custom_id);

    let tmp_a = std::env::temp_dir().join("step6-legacy-only-a.xlsx");
    let tmp_b = std::env::temp_dir().join("step6-legacy-only-b.xlsx");
    let _ = std::fs::remove_file(&tmp_a);
    let _ = std::fs::remove_file(&tmp_b);
    let registry = ql_functions::default_registry();

    let report_a = export_xlsx_path(&wb, &registry, &tmp_a, XlsxExportOptions::default()).unwrap();
    let report_b = export_xlsx_path(&wb, &registry, &tmp_b, XlsxExportOptions::default()).unwrap();

    // Zero multi-peer-flatten entries for a LEGACY_PEER-only workbook.
    for report in [&report_a, &report_b] {
        let drops: Vec<_> = report
            .dropped_features
            .iter()
            .filter(|f| {
                matches!(
                    f.kind,
                    ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
                )
            })
            .collect();
        assert!(
            drops.is_empty(),
            "LEGACY_PEER-only workbook must not produce multi-peer-flatten entries; got {drops:#?}"
        );
    }

    // Re-import survives.
    let result = import_xlsx_path(
        &tmp_a,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let imported_code = result
        .workbook
        .formats()
        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
    assert_eq!(imported_code, Some("0.0000"));

    let _ = std::fs::remove_file(&tmp_a);
    let _ = std::fs::remove_file(&tmp_b);
}

exec
/bin/zsh -lc "sed -n '240,285p' quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
            ..Default::default()
        },
    )
    .unwrap();
    let wb2 = &imported.workbook;
    let v_named = wb2.read(ql_types::Address::new(s2, 0, 0));
    let v_cross = wb2.read(ql_types::Address::new(s2, 1, 0));
    let has_name = wb2.names().lookup_ci("QTotal").is_some();
    println!(
        "[P4] roundtrip: named-range SUM(QTotal) = {v_named:?}, cross-sheet \
        Data!A1+Data!A2 = {v_cross:?}, name preserved = {has_name}"
    );
    if v_named != Value::Number(60.0) {
        println!("[P4 FINDING] named-range SUM lost on roundtrip: {v_named:?}");
    }
    if v_cross != Value::Number(30.0) {
        println!("[P4 FINDING] cross-sheet ref lost on roundtrip: {v_cross:?}");
    }
    if !has_name {
        println!("[P4 FINDING] named range dropped on roundtrip");
    }
    // Was the custom format preserved? Walk the format table directly.
    let mut custom_formats: Vec<(u32, String)> = Vec::new();
    for (id, s) in wb2.formats().iter() {
        // Step 3: `is_custom()` replaces the pre-step-3 `id.0 >= 164` filter.
        // Step 6 (2026-05-20): xlsx import always produces Builtin or
        // Custom(LEGACY_PEER, _) via legacy_from_u32(numFmtId) — xlsx
        // has no peer-id concept to recover. So to_legacy_u32() still
        // succeeds for every imported FormatId. The expect message was
        // updated to reflect post-step-6 reality (was pre-step-6 framing).
        if id.is_custom() {
            custom_formats.push((
                id.to_legacy_u32()
                    .expect("xlsx import always produces LEGACY_PEER customs (legacy_from_u32)"),
                s.to_owned(),
            ));
        }
    }
    println!("[P4] custom formats post-roundtrip: {custom_formats:?}");
    let has_currency_fmt = custom_formats.iter().any(|(_, s)| s.contains("$#,##0"));
    if !has_currency_fmt {
        println!("[P4 FINDING] custom format '$#,##0.00' lost on roundtrip");
    }
    // What format does the cell display now?
    {
        let mut clone = imported.workbook.clone();

exec
/bin/zsh -lc "rg -n \"multi-peer-format-id-flatten|named-range-constant|UnsupportedFeatureKind::Other\\(|Other\\(\" quantbook-engine/crates/ql-io-xlsx quantbook-engine/crates/ql-io quantbook-engine/crates -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"pub fn export|export_new_workbook|ExportMode|XlsxExportReport|dropped_features|Strict\" quantbook-engine/crates/ql-io-xlsx/src quantbook-engine/crates/ql-io-xlsx/tests -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:472:        s.insert(UnsupportedFeatureKind::Other("table-extras"));
quantbook-engine/crates/ql-io-xlsx/src/error.rs:122:    Other(&'static str),
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:320:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("embeddings"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:336:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other(
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:348:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("query-tables"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:355:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("rich-data"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:358:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("printer-settings"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:396:        ("<mergeCells", UnsupportedFeatureKind::Other("mergeCells")),
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:258:                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:497:                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1825:                ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1930:                    ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1825:                ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1930:                    ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:472:        s.insert(UnsupportedFeatureKind::Other("table-extras"));
quantbook-engine/crates/ql-io-xlsx/src/error.rs:122:    Other(&'static str),
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:320:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("embeddings"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:336:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other(
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:348:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("query-tables"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:355:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("rich-data"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:358:        return PartAction::DropAsUnsupported(UnsupportedFeatureKind::Other("printer-settings"));
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:396:        ("<mergeCells", UnsupportedFeatureKind::Other("mergeCells")),
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:258:                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:497:                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),

 succeeded in 0ms:
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:60:/// Probe: Strict UpdateOriginal — if cross-cutting fix puts the error
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:61:/// before `fs::write`, the OUTPUT FILE must NOT exist on Strict err.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:121:    // PRE-CREATE a sentinel file at the output path. After Strict
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:134:            mode: ql_io_xlsx::ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:137:            unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:156:    assert_eq!(pre_len, post_len, "Strict error MUST NOT touch output file");
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:164:/// the export do — drop silently, push to dropped_features, error?
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_misc.rs:184:    println!("dropped_features: {:?}", rep.dropped_features);
quantbook-engine/crates/ql-io-xlsx/src/model.rs:7:/// high-fidelity round-trip via `ExportMode::UpdateOriginal`.
quantbook-engine/crates/ql-io-xlsx/src/model.rs:36:/// `UnsupportedPolicy::Strict` decision.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:6:    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:438:/// Probe H: Strict import — when feature_inventory non-empty but no
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:440:/// and Strict should error.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:466:    // Strict: should error.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:472:            unsupported_policy: UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:481:/// `dropped_features` count includes the rels parts. Make this
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:485:fn dropped_features_vs_feature_inventory_completeness() {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:518:            mode: ExportMode::UpdateOriginal { source: preserve },
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:525:    for d in &ex.dropped_features {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:528:    println!("=== dropped_features grouped ===");
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_cache_policy.rs:69:/// Probe: RecomputeMode::Strict on a formula the engine can't evaluate.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_cache_policy.rs:87:            recompute: RecomputeMode::Strict,
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:45://! struct and the `XlsxError`, `UnsupportedFeatureKind`, `ExportMode`,
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:68:    ExportMode, FormulaCachePolicy, RecomputeMode, UnsupportedPolicy, XlsxExportOptions,
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:72:    FormulaImportFailure, UnsupportedFeature, XlsxExportReport, XlsxImportReport, XlsxWarning,
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:84:/// `ExportMode::UpdateOriginal`.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:141:    // operation. The prior import accepted silently. Strict mode
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:156:    // the visibility. The inventory entry lets Strict mode surface
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:292:    // **W5-D-14b — Phase 2b**: apply UnsupportedPolicy::Strict if any
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:295:    if options.unsupported_policy == UnsupportedPolicy::Strict
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:322:        RecomputeMode::Strict => {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:326:                // Strict mode: any failure is fatal.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:362:/// **W5-D-14e:** `ExportMode::NewWorkbook` wired through
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:364:/// round-trip. `ExportMode::UpdateOriginal` (preserve opaque OOXML
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:366:pub fn export_xlsx_path(
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:371:) -> Result<XlsxExportReport, XlsxError> {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:374:        ExportMode::NewWorkbook => {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:379:            // populated `dropped_features` and never triggered Strict.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:381:            // `report.dropped_features`; we apply Strict here.
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:383:                write::umya_export::export_new_workbook(workbook, out_path, options.formula_cache)?;
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:385:            if !report.dropped_features.is_empty()
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:386:                && options.unsupported_policy == UnsupportedPolicy::Strict
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:388:                let first = report.dropped_features[0].clone();
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:397:        ExportMode::UpdateOriginal { source } => write::update_original::export_update_original(
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:449:            mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:10:    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:125:        mode: ExportMode::NewWorkbook,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:575:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:620:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:681:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:713:    // **W5-D-14.2.2 (Codex audit H-B closure):** in Strict mode, a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:717:    // pass it as preservation, and assert: (1) Strict errors; (2) the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:750:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:753:        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:760:        "expected UnsupportedFeature error in Strict mode, got {res:?}"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:768:        "Strict-mode UpdateOriginal overwrote the destination — H-B regression"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:775:fn w5_d_14_2_2_permissive_update_original_populates_dropped_features() {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:778:    // `dropped_features` with the VBA drop.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:804:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:814:            .dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:817:        "expected dropped_features to contain a Macros entry, got {:?}",
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:818:        report.dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1517:    // mode now honors UnsupportedPolicy::Strict. A workbook with a
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1519:    // OOXML-serialised) must error in Strict mode instead of
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1536:        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1545:        "expected UnsupportedFeature in Strict mode, got {result:?}"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1553:    // UpdateOriginal mode with Strict policy must error when the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1576:        mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1579:        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1591:        "expected ConditionalFormatting UnsupportedFeature in Strict mode, got {result:?}"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1777:    // `XlsxExportReport.dropped_features` (per the no-fallback rule
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1820:        .dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1925:            .dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:23:    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
quantbook-engine/crates/ql-io-xlsx/src/report.rs:69:pub struct XlsxExportReport {
quantbook-engine/crates/ql-io-xlsx/src/report.rs:72:    pub dropped_features: Vec<UnsupportedFeature>,
quantbook-engine/crates/ql-io-xlsx/src/options.rs:20:    /// `ExportMode::UpdateOriginal` to preserve opaque OOXML parts on
quantbook-engine/crates/ql-io-xlsx/src/options.rs:39:    Strict,
quantbook-engine/crates/ql-io-xlsx/src/options.rs:64:    Strict,
quantbook-engine/crates/ql-io-xlsx/src/options.rs:71:    pub mode: ExportMode,
quantbook-engine/crates/ql-io-xlsx/src/options.rs:84:pub enum ExportMode {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:10:    export_xlsx_path, import_xlsx_path, ExportMode, FormulaCachePolicy, RecomputeMode,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:716:        "export.dropped_features = {:?}",
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:717:        exp_report.dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:833:/// Probe 8: UpdateOriginal preservation + Strict policy probe.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:835:/// what survives, what gets dropped, and that Strict actually errors.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:876:            mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:888:        perm_report.dropped_features.len(),
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:891:    for d in &perm_report.dropped_features {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:922:    // UpdateOriginal with Strict — should error if there were drops.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:930:            mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:933:            unsupported_policy: UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:946:/// Strict mode. Build a fake preservation package that contains
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:947:/// `xl/vbaProject.bin` and a comments part; verify Strict errors and
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:948:/// Permissive populates dropped_features.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1009:    // Permissive UpdateOriginal — VBA should land in dropped_features.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1017:            mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1027:        perm.dropped_features
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1034:    // Strict UpdateOriginal — should error.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1042:            mode: ExportMode::UpdateOriginal {
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1045:            unsupported_policy: UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1058:/// Probe 10: NewWorkbook + Strict — does export Strict do anything
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1067:    // silently. Does Strict catch that?
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1080:            mode: ExportMode::NewWorkbook,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1081:            unsupported_policy: UnsupportedPolicy::Strict,
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1087:            "NewWorkbook+Strict OK: cells={} dropped_features={} (Bad-name drop is INVISIBLE!)",
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1089:            rep.dropped_features.len()
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_deep_probe.rs:1091:        Err(e) => println!("NewWorkbook+Strict ERR: {e}"),
quantbook-engine/crates/ql-io-xlsx/src/error.rs:56:    /// [`UnsupportedPolicy`]: `Strict` returns the error, `Permissive`
quantbook-engine/crates/ql-io-xlsx/src/error.rs:116:    /// Strict mode surface the loss and Permissive callers see it
quantbook-engine/crates/ql-io-xlsx/src/error.rs:117:    /// in `dropped_features`.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:1://! **W5-D-14.2 (HIGH-7 closure):** `ExportMode::UpdateOriginal`.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:29://!   `XlsxExportReport.dropped_features`.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:30://! - `Strict`: any drop is a hard error.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:35:use crate::report::{UnsupportedFeature, XlsxExportReport};
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:36:use crate::write::umya_export::export_new_workbook;
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:40:/// Entry point for `ExportMode::UpdateOriginal`. See module doc.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:47:) -> Result<XlsxExportReport, XlsxError> {
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:52:    let mut report = export_new_workbook(workbook, &shadow_path, formula_cache)?;
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:214:    // get clobbered. Without this scan, Strict mode would silently
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:224:    // under `Strict` mode. The contract is "Strict means no-loss";
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:229:                report.dropped_features.extend(dropped);
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:231:            UnsupportedPolicy::Strict => {
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:253:    /// Skip; explicitly drop and surface in `dropped_features`.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:276:/// a `dropped_features` entry. Only the parts that survive via
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:309:    // `dropped_features` is informative.
quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:345:    // connections feature silently dropped without a `dropped_features`
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:14://! Companion: `update_original` for the `ExportMode::UpdateOriginal`
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:21:use crate::report::XlsxExportReport;
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:109:/// `XlsxExportReport.dropped_features`. Per the no-fallbacks doctrine,
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:120:    /// Caller surfaces via `XlsxExportReport.dropped_features`.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:197:pub(crate) fn export_new_workbook(
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:201:) -> Result<XlsxExportReport, XlsxError> {
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:202:    let mut report = XlsxExportReport::default();
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:251:    // non-LEGACY peer flattens to XlsxExportReport.dropped_features
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:256:            .dropped_features
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:488:    // `report.dropped_features` with names that couldn't be rendered
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:491:    // Strict mode never fires for them.
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:495:            .dropped_features
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1212:/// populate `XlsxExportReport.dropped_features` so Strict mode can
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1832:        let report = export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1854:        export_new_workbook(&wb, &tmp, FormulaCachePolicy::WriteRecomputed).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/write/mod.rs:9://! - `ExportMode::UpdateOriginal` — load the preserved original
quantbook-engine/crates/ql-io-xlsx/src/read/feature_inventory.rs:7://! (Permissive mode) or fails (Strict mode).
quantbook-engine/crates/ql-io-xlsx/src/read/convert.rs:111:/// runner mode (`Strict` / `BestEffort` / `Skip`) is dispatched at

exec
/bin/zsh -lc "sed -n '360,400p' quantbook-engine/crates/ql-io-xlsx/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/// Export a `Workbook` to an xlsx file.
///
/// **W5-D-14e:** `ExportMode::NewWorkbook` wired through
/// umya-spreadsheet. Cells + formula text + cached values
/// round-trip. `ExportMode::UpdateOriginal` (preserve opaque OOXML
/// parts from a prior import) lands in a follow-up.
pub fn export_xlsx_path(
    workbook: &Workbook,
    _registry: &FunctionRegistry,
    out: impl AsRef<std::path::Path>,
    options: XlsxExportOptions,
) -> Result<XlsxExportReport, XlsxError> {
    let out_path = out.as_ref();
    match options.mode {
        ExportMode::NewWorkbook => {
            // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** previously
            // NewWorkbook ignored `unsupported_policy`. Things that
            // SHOULD be dropped (Constant(Error)/Constant(Blank)
            // named-target values; future-deferred features) never
            // populated `dropped_features` and never triggered Strict.
            // Now collect drops + enforce policy. The exporter populates
            // `report.dropped_features`; we apply Strict here.
            let mut report =
                write::umya_export::export_new_workbook(workbook, out_path, options.formula_cache)?;
            report.warnings.shrink_to_fit();
            if !report.dropped_features.is_empty()
                && options.unsupported_policy == UnsupportedPolicy::Strict
            {
                let first = report.dropped_features[0].clone();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
            Ok(report)
        }
        ExportMode::UpdateOriginal { source } => write::update_original::export_update_original(
            workbook,
            out_path,
            options.formula_cache,

exec
/bin/zsh -lc "sed -n '40,75p' quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs && sed -n '214,238p' quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/// Entry point for `ExportMode::UpdateOriginal`. See module doc.
pub(crate) fn export_update_original(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
    unsupported_policy: UnsupportedPolicy,
    source: XlsxPreservation,
) -> Result<XlsxExportReport, XlsxError> {
    // Step 1: shadow export to a sibling temp path. Use a unique name
    // so concurrent exports don't collide.
    let shadow_path = sibling_tmp_path(output_path);
    let _shadow_cleanup = ScopedFileGuard::new(&shadow_path);
    let mut report = export_new_workbook(workbook, &shadow_path, formula_cache)?;

    // Step 2: read both packages into memory.
    let shadow_bytes = std::fs::read(&shadow_path)?;

    // Step 3: assemble the final output zip. We walk the shadow first
    // (canonical source-of-truth for Quantbook-owned parts), then
    // overlay any preserved parts from the original.
    let mut shadow_zip = zip::ZipArchive::new(std::io::Cursor::new(shadow_bytes.as_slice()))
        .map_err(XlsxError::Zip)?;
    let mut original_zip =
        zip::ZipArchive::new(std::io::Cursor::new(source.original_bytes.as_slice()))
            .map_err(XlsxError::Zip)?;

    // Enumerate shadow part names. Used in step 3a/3b for precedence
    // decisions.
    let mut shadow_part_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..shadow_zip.len() {
        let entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
        shadow_part_names.insert(entry.name().to_string());
    }

    // Enumerate original part names — used so step 3a can decide
    // whether to skip shadow's version of an "original-wins" part
    // get clobbered. Without this scan, Strict mode would silently
    // permit the loss. Now each inline feature found gets a
    // `dropped` entry that the policy enforcement below honours.
    let inline_drops = scan_inline_features(&source.original_bytes)?;
    dropped.extend(inline_drops);

    // **W5-D-14.2.2 (Codex audit H-B closure):** enforce the
    // unsupported-policy decision BEFORE writing the output. Prior
    // ordering wrote the (lossy) file first and then errored, which
    // could destroy a caller's pre-existing file at `output_path`
    // under `Strict` mode. The contract is "Strict means no-loss";
    // touching the user's destination on a drop violates it.
    if !dropped.is_empty() {
        match unsupported_policy {
            UnsupportedPolicy::Permissive => {
                report.dropped_features.extend(dropped);
            }
            UnsupportedPolicy::Strict => {
                let first = dropped.into_iter().next().unwrap();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }

exec
/bin/zsh -lc "sed -n '1,95p' quantbook-engine/crates/ql-io-xlsx/src/options.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '1,135p' quantbook-engine/crates/ql-io-xlsx/src/error.rs && sed -n '60,80p' quantbook-engine/crates/ql-io-xlsx/src/report.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Options types for xlsx import and export.
//!
//! Public surface for callers to control: recompute behavior on import,
//! how unsupported features are handled, and whether to preserve the
//! original OOXML package for high-fidelity round-trip.

use crate::model::XlsxPreservation;

/// Import-time policy.
#[derive(Debug, Clone, Default)]
pub struct XlsxImportOptions {
    /// What to do when formulas are loaded.
    pub recompute: RecomputeMode,

    /// What to do when unsupported OOXML features are detected.
    pub unsupported_policy: UnsupportedPolicy,

    /// If `true`, retain the raw OOXML package (zip bytes + part index)
    /// in the result's `preservation` field. Required for
    /// `ExportMode::UpdateOriginal` to preserve opaque OOXML parts on
    /// round-trip. Adds memory cost proportional to file size.
    pub preserve_package: bool,
}

/// Whether to recompute formulas after raw-loading the workbook.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecomputeMode {
    /// Recompute every formula; report failures but keep imported
    /// cached values on failure. **Default.** This is the safest mode:
    /// no formula failure destroys the user's ability to inspect or
    /// re-export the workbook.
    #[default]
    BestEffort,

    /// Recompute every formula; on first failure abort the whole
    /// import with an error. Useful for strict CI pipelines that
    /// require full engine support.
    Strict,

    /// Skip recompute entirely. Imported cached values are preserved
    /// as-is. Formulas remain in the workbook as text. Use when the
    /// caller will recompute explicitly later (e.g., in a different
    /// runtime configuration).
    Skip,
}

/// What happens when the importer / exporter detects a feature the
/// engine doesn't model.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum UnsupportedPolicy {
    /// Detect-and-report: every unsupported feature is added to the
    /// import / export report; the operation succeeds. **Default.**
    /// For export: silently drops the feature from the output. For
    /// import: silently ignores the OOXML element. The caller should
    /// inspect the report to know what was lost.
    #[default]
    Permissive,

    /// Detect-and-error: any unsupported feature triggers
    /// [`XlsxError::UnsupportedFeature`]. Useful for round-trip
    /// fidelity verification — the caller doesn't want silent loss.
    Strict,
}

/// Export-time policy.
#[derive(Debug, Clone, Default)]
pub struct XlsxExportOptions {
    /// Generate-new vs update-original mode.
    pub mode: ExportMode,

    /// What to do when unsupported features would be lost.
    pub unsupported_policy: UnsupportedPolicy,

    /// What to do with formula cached values.
    pub formula_cache: FormulaCachePolicy,
}

/// Whether the export generates a new workbook or updates an existing
/// one (from a prior import).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum ExportMode {
    /// Generate a fresh xlsx from Quantbook state. Use for workbooks
    /// that originated in Quantbook (not imported from xlsx). The
    /// generated file contains only what the engine models — no
    /// preservation of features the engine doesn't track. **Default.**
    #[default]
    NewWorkbook,

    /// Patch the original xlsx package, preserving opaque OOXML parts.
    /// The `source` is the `XlsxPreservation` captured during import
    /// (requires `XlsxImportOptions::preserve_package = true`). Use
    /// for round-trip workflows where users edit a workbook that

 succeeded in 0ms:
//! Error types for `ql-io-xlsx`.
//!
//! Single sum type covering import, export, package, XML parse, and
//! engine-integration failures. Per the engine-wide no-fallbacks rule:
//! errors are surfaced loudly with enough context to diagnose, never
//! silently swallowed or replaced with defaults.

use thiserror::Error;

/// Top-level error type for xlsx import / export.
///
/// **Phase 4.11 (W5-D-14):** kept narrow at first ship. Variants will
/// be added as new failure modes surface during the round-trip spine
/// implementation. Each variant should carry enough context (file path,
/// part name, XML element, etc.) to localize the failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum XlsxError {
    /// Filesystem I/O failed (file not found, permission denied, etc.).
    #[error("xlsx file I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The zip archive is malformed or unreadable.
    #[error("xlsx zip archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// Calamine reported a structural error reading a sheet or formula.
    #[error("xlsx calamine error: {0}")]
    Calamine(String),

    /// quick-xml parser surfaced malformed OOXML.
    #[error("xlsx xml parse error at {part}: {source}")]
    XmlParse {
        /// The OOXML part where parsing failed (e.g.
        /// `xl/workbook.xml`).
        part: String,
        /// The underlying quick-xml parse error.
        #[source]
        source: quick_xml::Error,
    },

    /// An OOXML part referenced an unknown attribute or value, or the
    /// XML structure doesn't match Excel's documented schema. Distinct
    /// from `XmlParse` (which is well-formedness) — this is
    /// semantic validity.
    #[error("xlsx malformed OOXML at {part}: {message}")]
    MalformedOoxml {
        /// The OOXML part with the issue.
        part: String,
        /// Human-readable description of what was malformed.
        message: String,
    },

    /// A workbook feature was encountered that the engine cannot
    /// represent. Whether this is fatal depends on
    /// [`UnsupportedPolicy`]: `Strict` returns the error, `Permissive`
    /// records it in the import report and continues.
    #[error("xlsx unsupported feature {feature:?} in {part}: {detail}")]
    UnsupportedFeature {
        /// What kind of feature (CF, DV, comments, drawings, etc.).
        feature: UnsupportedFeatureKind,
        /// The OOXML part that contained the feature.
        part: String,
        /// Additional context (cell range, table name, etc.).
        detail: String,
    },

    /// Export couldn't write the output file (umya or generated path).
    #[error("xlsx export error: {0}")]
    Export(String),

    /// Engine integration failed (bind error, runtime error, op-log
    /// error). The xlsx I/O layer translates these to `XlsxError` so
    /// callers don't need to depend on the engine crates' error types.
    #[error("xlsx engine integration error: {0}")]
    Engine(String),
}

/// Categories of OOXML features the engine doesn't represent.
///
/// Used by [`XlsxError::UnsupportedFeature`] and the
/// import/export reports. The variants here track exactly what the
/// hybrid reader's feature inventory detects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum UnsupportedFeatureKind {
    /// Conditional formatting rules (`xl/worksheets/sheet*.xml`
    /// `<conditionalFormatting>`).
    ConditionalFormatting,
    /// Data validation (`<dataValidations>`).
    DataValidation,
    /// Comments and notes (`xl/comments*.xml`).
    Comments,
    /// Drawings + embedded objects (`xl/drawings/`).
    Drawings,
    /// Images (linked or embedded).
    Images,
    /// Hyperlinks (`<hyperlinks>`).
    Hyperlinks,
    /// Merged cells (`<mergeCells>`).
    MergedCells,
    /// Sheet protection.
    Protection,
    /// Workbook-level external links (`xl/externalLinks/`).
    ExternalLinks,
    /// Pivot tables.
    PivotTables,
    /// VBA macros (`xl/vbaProject.bin`).
    Macros,
    /// **W5-D-PM-3 (megaudit Opus-A HIGH-3 closure):** sheet
    /// visibility state (`state="hidden"` / `"veryHidden"`).
    /// Quantbook's `Sheet` doesn't model state; on
    /// `UpdateOriginal` export we silently lose the attribute
    /// because the shadow's `xl/workbook.xml` replaces the
    /// original's. Recording this in the import inventory lets
    /// Strict mode surface the loss and Permissive callers see it
    /// in `dropped_features`.
    HiddenSheets,
    /// Any other OOXML part not modeled by the engine. Used as a
    /// catch-all so the inventory is exhaustive even for parts we
    /// haven't enumerated yet.
    Other(&'static str),
}
pub struct XlsxWarning {
    /// Where (file path, OOXML part, cell, etc.).
    pub location: String,
    /// What.
    pub message: String,
}

/// Result-side report attached to a successful export.
#[derive(Debug, Clone, Default)]
pub struct XlsxExportReport {
    /// Features the writer couldn't preserve. Each entry is a real
    /// fidelity loss the caller should know about.
    pub dropped_features: Vec<UnsupportedFeature>,

    /// Soft warnings (e.g., umya version compatibility note).
    pub warnings: Vec<XlsxWarning>,

    /// Number of cells written (cells with a value, formula, or both).
    pub cells_written: u64,

    /// Number of formula cached values written.

exec
/bin/zsh -lc "sed -n '1500,1565p' quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
        },
    )
    .unwrap();
    assert!(
        result
            .report
            .feature_inventory
            .counts
            .contains_key(&ql_io_xlsx::UnsupportedFeatureKind::HiddenSheets),
        "expected HiddenSheets in inventory, got {:?}",
        result.report.feature_inventory.counts
    );
}

#[test]
fn w5_d_pm_3_new_workbook_strict_errors_on_constant_error_name() {
    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** NewWorkbook
    // mode now honors UnsupportedPolicy::Strict. A workbook with a
    // named range pointing at `Constant(Error)` (which can't be
    // OOXML-serialised) must error in Strict mode instead of
    // silently dropping the name.
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::{ErrorValue, Value};

    let mut wb = Workbook::new();
    wb.add_sheet("Sheet1");
    wb.set_name(
        "Bad",
        NamedTarget::Constant(Value::Error(ErrorValue::Value)),
    )
    .unwrap();

    let tmp = std::env::temp_dir().join("w5-d-pm-3-strict-name.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    let opts = XlsxExportOptions {
        unsupported_policy: ql_io_xlsx::UnsupportedPolicy::Strict,
        ..Default::default()
    };
    let result = export_xlsx_path(&wb, &registry, &tmp, opts);
    assert!(
        matches!(
            result,
            Err(ql_io_xlsx::XlsxError::UnsupportedFeature { .. })
        ),
        "expected UnsupportedFeature in Strict mode, got {result:?}"
    );
    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_pm_3_update_original_strict_catches_inline_cf() {
    // **W5-D-PM-3 (megaudit self H-2 / Opus-A MEDIUM-1 closure):**
    // UpdateOriginal mode with Strict policy must error when the
    // original's worksheet xml contains inline features that the
    // shadow's xml replaces (CF, DV, mergeCells, hyperlinks).
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let mut original_bytes: Vec<u8> = Vec::new();
    {
        let mut zw = ZipWriter::new(std::io::Cursor::new(&mut original_bytes));
        let opts = FileOptions::default().compression_method(CompressionMethod::Stored);
        zw.start_file("[Content_Types].xml", opts).unwrap();
        zw.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();

exec
/bin/zsh -lc "sed -n '40,260p' quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
/// Entry point for `ExportMode::UpdateOriginal`. See module doc.
pub(crate) fn export_update_original(
    workbook: &Workbook,
    output_path: &std::path::Path,
    formula_cache: FormulaCachePolicy,
    unsupported_policy: UnsupportedPolicy,
    source: XlsxPreservation,
) -> Result<XlsxExportReport, XlsxError> {
    // Step 1: shadow export to a sibling temp path. Use a unique name
    // so concurrent exports don't collide.
    let shadow_path = sibling_tmp_path(output_path);
    let _shadow_cleanup = ScopedFileGuard::new(&shadow_path);
    let mut report = export_new_workbook(workbook, &shadow_path, formula_cache)?;

    // Step 2: read both packages into memory.
    let shadow_bytes = std::fs::read(&shadow_path)?;

    // Step 3: assemble the final output zip. We walk the shadow first
    // (canonical source-of-truth for Quantbook-owned parts), then
    // overlay any preserved parts from the original.
    let mut shadow_zip = zip::ZipArchive::new(std::io::Cursor::new(shadow_bytes.as_slice()))
        .map_err(XlsxError::Zip)?;
    let mut original_zip =
        zip::ZipArchive::new(std::io::Cursor::new(source.original_bytes.as_slice()))
            .map_err(XlsxError::Zip)?;

    // Enumerate shadow part names. Used in step 3a/3b for precedence
    // decisions.
    let mut shadow_part_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..shadow_zip.len() {
        let entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
        shadow_part_names.insert(entry.name().to_string());
    }

    // Enumerate original part names — used so step 3a can decide
    // whether to skip shadow's version of an "original-wins" part
    // (theme, docProps, customXml). Without this check we'd silently
    // replace the original's theme/docProps with umya's stubs even
    // though `classify_part` flags them as Preserve.
    //
    // **W5-D-14.2.3 (separate-Opus H-1 closure).**
    let mut original_part_names: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for i in 0..original_zip.len() {
        let entry = original_zip.by_index(i).map_err(XlsxError::Zip)?;
        original_part_names.insert(entry.name().to_string());
    }

    // Track which original parts we'll preserve so we can merge their
    // Content_Types entries.
    let mut preserved_part_paths: Vec<String> = Vec::new();
    // Track parts we explicitly dropped (security / unsupported) so
    // the report has a faithful picture.
    let mut dropped: Vec<UnsupportedFeature> = Vec::new();

    // Read the original's Content_Types.xml up front so we can pull
    // <Override> entries for preserved parts and merge into shadow's.
    let original_content_types = read_part_as_string(&mut original_zip, "[Content_Types].xml")?;
    let shadow_content_types = read_part_as_string(&mut shadow_zip, "[Content_Types].xml")?;

    let mut out_buf: Vec<u8> = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut out_buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Step 3a: write every shadow part EXCEPT [Content_Types].xml
        // (merged later) AND EXCEPT "original-wins" parts where the
        // original also has them. Original-wins parts get written by
        // step 3b — writing shadow's stub here would clobber the real
        // content.
        //
        // **W5-D-14.2.3 (separate-Opus H-1 closure):** prior version
        // wrote shadow first unconditionally, so for paths shadow ALSO
        // emits (theme1.xml, docProps/app.xml, docProps/core.xml) the
        // original's bytes were dropped — even though `classify_part`
        // marks those paths Preserve. Verified empirically:
        // basic_text.xlsx round-trip lost
        // `<dc:creator>Nicolas Hatcher</dc:creator>` and the original
        // theme1.xml (8390 bytes) was replaced by umya's stub (6518).
        for i in 0..shadow_zip.len() {
            let mut entry = shadow_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                continue;
            }
            if matches!(classify_part(&name), PartAction::Preserve)
                && original_part_names.contains(&name)
            {
                // Original wins; step 3b will emit it.
                continue;
            }
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
            writer.write_all(&content)?;
        }

        // Step 3b: walk the original. Two paths:
        // (1) original-wins parts that ALSO exist in shadow — skipped
        //     in step 3a, write here.
        // (2) parts that aren't in shadow at all — classify_part
        //     decides.
        for i in 0..original_zip.len() {
            let mut entry = original_zip.by_index(i).map_err(XlsxError::Zip)?;
            let name = entry.name().to_string();
            if name == "[Content_Types].xml" {
                continue;
            }
            let action = classify_part(&name);
            let in_shadow = shadow_part_names.contains(&name);

            if in_shadow {
                // Only write original if it's an original-wins
                // (Preserve) path. Otherwise shadow's content was
                // already written in step 3a.
                if matches!(action, PartAction::Preserve) {
                    let mut content = Vec::new();
                    entry.read_to_end(&mut content)?;
                    writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
                    writer.write_all(&content)?;
                    preserved_part_paths.push(name);
                }
                continue;
            }

            match action {
                PartAction::Preserve => {
                    let mut content = Vec::new();
                    entry.read_to_end(&mut content)?;
                    writer.start_file(&name, opts).map_err(XlsxError::Zip)?;
                    writer.write_all(&content)?;
                    preserved_part_paths.push(name);
                }
                PartAction::DropAsUnsupported(kind) => {
                    dropped.push(UnsupportedFeature {
                        kind,
                        part: name.clone(),
                        detail: "UpdateOriginal v1 does not preserve this part type".to_string(),
                    });
                }
                PartAction::DropSilently => {
                    // E.g. duplicate calcChain (we own that), or
                    // already-rendered-by-shadow parts.
                }
                PartAction::OwnedByShadow => {
                    // Shadow's version takes precedence; documentation
                    // branch (we don't hit it in practice because
                    // shadow's membership check above handles the
                    // common case).
                }
            }
        }

        // Step 3c: merge + write [Content_Types].xml.
        let merged_content_types = merge_content_types(
            &shadow_content_types,
            &original_content_types,
            &preserved_part_paths,
        )?;
        writer
            .start_file("[Content_Types].xml", opts)
            .map_err(XlsxError::Zip)?;
        writer.write_all(merged_content_types.as_bytes())?;

        writer.finish().map_err(XlsxError::Zip)?;
    }

    // **W5-D-PM-3 (megaudit self H-2 / Opus-A MEDIUM-1 closure):**
    // scan the ORIGINAL's worksheet xmls for inline-feature
    // signatures (`<conditionalFormatting>`, `<dataValidations>`,
    // `<mergeCells>`, `<hyperlinks>`, `<sheetProtection>`). These
    // are not standalone parts (so `classify_part` never sees them),
    // but the shadow's worksheet xml REPLACES the original's — they
    // get clobbered. Without this scan, Strict mode would silently
    // permit the loss. Now each inline feature found gets a
    // `dropped` entry that the policy enforcement below honours.
    let inline_drops = scan_inline_features(&source.original_bytes)?;
    dropped.extend(inline_drops);

    // **W5-D-14.2.2 (Codex audit H-B closure):** enforce the
    // unsupported-policy decision BEFORE writing the output. Prior
    // ordering wrote the (lossy) file first and then errored, which
    // could destroy a caller's pre-existing file at `output_path`
    // under `Strict` mode. The contract is "Strict means no-loss";
    // touching the user's destination on a drop violates it.
    if !dropped.is_empty() {
        match unsupported_policy {
            UnsupportedPolicy::Permissive => {
                report.dropped_features.extend(dropped);
            }
            UnsupportedPolicy::Strict => {
                let first = dropped.into_iter().next().unwrap();
                return Err(XlsxError::UnsupportedFeature {
                    feature: first.kind,
                    part: first.part,
                    detail: first.detail,
                });
            }
        }
    }

    // **W5-D-PM-4 (megaudit Opus-B HIGH-6 closure):** atomic write
    // via tmp + rename. See `umya_export::atomic_write_to_path`.
    crate::write::umya_export::atomic_write_to_path_public(output_path, &out_buf)?;

    Ok(report)
}

/// What to do with an original-package part during `UpdateOriginal`.
enum PartAction {
    /// Carry the original bytes through verbatim.
    Preserve,
    /// Skip; explicitly drop and surface in `dropped_features`.
    DropAsUnsupported(UnsupportedFeatureKind),
    /// Skip silently (e.g., shadow already covers this part type).
    DropSilently,
    /// Shadow's version takes precedence (e.g., xl/workbook.xml).
    #[allow(dead_code)]
    OwnedByShadow,
}

codex
I’ve traced the main exporter now. One issue outside the listed invariants is already standing out: `export_new_workbook` records the new flattening as `dropped_features`, but the public Strict enforcement paths are asymmetric between NewWorkbook and UpdateOriginal, so I’m checking whether that is now reachable from step 6.
exec
/bin/zsh -lc "sed -n '200,285p' quantbook-engine/crates/ql-io-xlsx/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    let _tables_imported =
        read::tables_import::import_tables(&package, &mut workbook, &sheet_rels_paths)?;

    // **W5-D-PM-3 (megaudit Opus-B HIGH-8 closure):** emit warnings
    // for `<sheet r:id="...">` entries whose r:id doesn't resolve
    // to any entry in `xl/_rels/workbook.xml.rels`. Prior to this,
    // such sheets were silently dropped from the part-path lookup
    // — the user thought their workbook imported when 1+ sheets
    // had no usable worksheet part.
    {
        let sheet_part_paths_check =
            read::sheet_parts::build_sheet_part_paths(&package, &workbook_props)?;
        for (idx, (sheet, part_path)) in workbook_props
            .sheets
            .iter()
            .zip(sheet_part_paths_check.iter())
            .enumerate()
        {
            if part_path.is_empty() {
                report.warnings.push(XlsxWarning {
                    location: format!("sheet[{}] '{}'", idx, sheet.name),
                    message: format!(
                        "sheet r:id={:?} doesn't resolve via xl/_rels/workbook.xml.rels; \
                         sheet content will be empty",
                        sheet.r_id
                    ),
                });
            }
        }
    }

    // **W5-D-14d — Phase 2d**: import styles. Parses `xl/styles.xml`
    // for custom number formats (`numFmtId >= 164`) and registers
    // them with the workbook's FormatTable via `register_at` so the
    // imported id matches the OOXML id exactly (replay-determinism
    // for round-trip). Per-cell application landed in W5-D-15 — see
    // the cell-styles scanner wiring below.
    let style_index = read::styles_xml::parse_styles_xml(&package)?;
    let _custom_formats_registered =
        read::styles_import::register_custom_formats(&mut workbook, &style_index)?;

    // **W5-D-15 — Phase 2d-bis (XLSX-4-03 per-cell format closure):**
    // walk each sheet's worksheet xml, parse `<c r="..." s="N"/>`
    // pairs, and populate `Sheet::format_overlay`. Cells with `s="0"`
    // or absent `s` use General — no overlay entry needed.
    let sheet_part_paths = read::sheet_parts::build_sheet_part_paths(&package, &workbook_props)?;
    for (sheet_idx, part_path) in sheet_part_paths.iter().enumerate() {
        if part_path.is_empty() {
            continue;
        }
        let Some(content) = package.read_part_string(part_path)? else {
            continue;
        };
        let styled_cells = read::cell_styles_xml::parse_cell_styles_xml(&content, part_path)?;
        if styled_cells.is_empty() {
            continue;
        }
        let Some(sheet) = workbook.sheet_mut(sheet_idx as ql_types::SheetId) else {
            continue;
        };
        for (row, col, xf_idx) in styled_cells {
            // Resolve xf_idx → cellXf → numFmtId.
            let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
                continue;
            };
            if !xf.apply_number_format {
                // Cell renders as General — don't populate overlay.
                continue;
            }
            if xf.num_fmt_id == 0 {
                // General format — implicit. No overlay entry.
                continue;
            }
            // Phase 5.2 D-1 step 3: xlsx import uses the legacy
            // u32 → FormatId migration helper. n <= 163 → Builtin(n);
            // n >= 164 → Custom(LEGACY_PEER, n - 164). Step 6 may
            // change xlsx import to allocate non-legacy peer ids
            // (e.g. for collab-aware imports); pre-step-6 all xlsx
            // ids land under LEGACY_PEER.
            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
            sheet.format_overlay_mut().set(row, col, fmt_id);
        }
    }

    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
    // (workbook-scope + sheet-scope) into the engine's `NameTable` /

exec
/bin/zsh -lc "sed -n '1,290p' quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Register parsed OOXML `<numFmt>` entries with the workbook's
//! `FormatTable`.
//!
//! **W5-D-14d scope**: format-code registration only. Per-cell
//! application (reading worksheet `<c r="A1" s="N">` and applying
//! the format from `cellXfs[N].num_fmt_id`) requires worksheet XML
//! parsing the engine doesn't yet do; deferred to a follow-up.
//!
//! The benefit of registering now (without per-cell application) is
//! that the workbook's `FormatTable` correctly carries the user's
//! custom format strings, so when per-cell wiring lands it can just
//! `FormatId(N)` directly without re-allocating ids.

use crate::error::XlsxError;
use crate::read::styles_xml::StyleIndex;
use ql_storage::{FormatId, Workbook};

/// Register every custom `numFmtId` (≥ 164) from the parsed
/// `StyleIndex` with the workbook's `FormatTable`. Reserved ids
/// (0-163) are Excel built-ins handled by the `FormatTable` defaults
/// — skipped here.
///
/// **Replay determinism**: uses `FormatTable::register_at` (not
/// `intern`) so the imported id matches the OOXML id exactly. This
/// is critical for round-trip — exporting back to xlsx writes the
/// same numFmtId attribute we read.
///
/// Returns the count of custom formats registered.
///
/// # Errors
///
/// - `XlsxError::MalformedOoxml` if a registration collides with an
///   existing entry under a different string — that indicates the
///   xlsx has two `<numFmt>` entries claiming the same id with
///   different format codes, which is malformed per OOXML spec.
pub(crate) fn register_custom_formats(
    workbook: &mut Workbook,
    style_index: &StyleIndex,
) -> Result<u64, XlsxError> {
    let mut count: u64 = 0;
    for entry in &style_index.num_fmts {
        // Reserved 0-163 are Excel built-ins — skip; the FormatTable
        // already has them.
        if entry.num_fmt_id < ql_storage::FIRST_CUSTOM_FORMAT_ID {
            continue;
        }
        // **W5-D-PM-2 (megaudit Opus-B HIGH-1 closure):** reject
        // attacker-controlled numFmtIds beyond Excel's plausible
        // ceiling. Excel's legal numFmtId range tops out at ~32767;
        // anything higher is either malformed or a hostile attempt
        // to trigger the `FormatTable::register_at` arithmetic
        // overflow at `format.rs:153` (`self.next_custom_id = id.0 + 1`
        // panics on u32::MAX).
        const MAX_PLAUSIBLE_NUMFMT_ID: u32 = u16::MAX as u32; // 65535
        if entry.num_fmt_id > MAX_PLAUSIBLE_NUMFMT_ID {
            return Err(XlsxError::MalformedOoxml {
                part: "xl/styles.xml".to_string(),
                message: format!(
                    "numFmtId {} exceeds plausible ceiling {} (rejecting to \
                     avoid FormatTable overflow)",
                    entry.num_fmt_id, MAX_PLAUSIBLE_NUMFMT_ID
                ),
            });
        }
        // Phase 5.2 D-1 step 3: xlsx import uses legacy u32 → FormatId
        // migration. Custom xlsx numFmtIds (>= 164) land under
        // LEGACY_PEER per the migration contract.
        let id = FormatId::legacy_from_u32(entry.num_fmt_id);
        // **W5-D-14.1 (audit HIGH-8 closure):** real-world xlsx files
        // from LibreOffice / Google Sheets sometimes emit
        // `<numFmt numFmtId="164" formatCode="General"/>` — a
        // declaration at a custom id (≥ 164) whose format string
        // already exists as a built-in (id 0 = "General"). Quantbook's
        // `FormatTable::register_at` rejects this with
        // `StringCollision`. The Excel behavior is to accept the
        // redundant declaration (the cell using `s` with `numFmtId=164`
        // still renders as General). We treat collisions where the
        // existing string matches as idempotent no-ops; only TRUE
        // string collisions at the same id still error.
        match workbook.formats_mut().register_at(id, &entry.format_code) {
            Ok(()) => {
                count += 1;
            }
            Err(ql_storage::FormatTableError::StringCollision { existing_id, .. }) => {
                // The string is already registered at a DIFFERENT id
                // (typically a built-in). The OOXML file re-declares
                // it at a custom id — semantically redundant but
                // benign. Skip silently; cells referencing the custom
                // id will render via the existing (built-in) format.
                let _ = existing_id;
                continue;
            }
            Err(e) => {
                return Err(XlsxError::MalformedOoxml {
                    part: "xl/styles.xml".to_string(),
                    message: format!(
                        "numFmt registration failed for id {}: {:?}",
                        entry.num_fmt_id, e
                    ),
                });
            }
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::styles_xml::NumFmtEntry;

    #[test]
    fn register_custom_skips_builtins_below_164() {
        let mut wb = Workbook::new();
        let baseline = wb.formats().len();
        let idx = StyleIndex {
            num_fmts: vec![
                NumFmtEntry {
                    num_fmt_id: 0,
                    format_code: "General".to_string(),
                },
                NumFmtEntry {
                    num_fmt_id: 14,
                    format_code: "m/d/yyyy".to_string(),
                },
            ],
            cell_xfs: vec![],
        };
        let n = register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(n, 0, "built-ins must not be re-registered");
        // FormatTable size unchanged.
        assert_eq!(wb.formats().len(), baseline);
    }

    #[test]
    fn register_custom_registers_id_164_and_above() {
        let mut wb = Workbook::new();
        let baseline = wb.formats().len();
        let idx = StyleIndex {
            num_fmts: vec![
                NumFmtEntry {
                    num_fmt_id: 164,
                    format_code: "yyyy-mm-dd".to_string(),
                },
                NumFmtEntry {
                    num_fmt_id: 165,
                    // A format code unique to this workbook (not a
                    // built-in re-definition).
                    format_code: "yyyy-mm-dd hh:mm:ss".to_string(),
                },
            ],
            cell_xfs: vec![],
        };
        let n = register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(n, 2);
        assert_eq!(wb.formats().len(), baseline + 2);
        // Lookup by id should hit.
        assert_eq!(
            wb.formats().lookup(FormatId::legacy_from_u32(164)),
            Some("yyyy-mm-dd")
        );
        assert_eq!(
            wb.formats().lookup(FormatId::legacy_from_u32(165)),
            Some("yyyy-mm-dd hh:mm:ss")
        );
    }

    #[test]
    fn libreoffice_general_at_custom_id_registers_under_custom_namespace() {
        // **W5-D-14.1 (audit HIGH-8 closure) + Phase 5.2 D-1 step 4
        // by_string restructure:** LibreOffice's
        // `libreoffice_888_example.xlsx` declares `<numFmt
        // numFmtId="164" formatCode="General"/>`. The string "General"
        // is already registered at id Builtin(0).
        //
        // Pre-step-4: the second registration collided (single by_string
        // map) and the loader silently skipped it. Test asserted
        // `n == 0` (nothing added).
        //
        // Post-step-4 (this test name + assertion updated): Builtin
        // and Custom variants have separate namespaces, so
        // `register_at(Custom(LEGACY_PEER, 0), "General")` SUCCEEDS.
        // Both Builtin(0) → "General" and Custom(LEGACY_PEER, 0) →
        // "General" coexist. Cells with numFmtId=164 in the cell's xf
        // bind to Custom(LEGACY_PEER, 0); lookup resolves to "General"
        // identically — same render behavior.
        let mut wb = Workbook::new();
        let baseline = wb.formats().len();
        let idx = StyleIndex {
            num_fmts: vec![NumFmtEntry {
                num_fmt_id: 164,
                format_code: "General".to_string(),
            }],
            cell_xfs: vec![],
        };
        let n = register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(
            n, 1,
            "post-step-4 by_string restructure: cross-variant string \
             registration succeeds (Custom and Builtin namespaces are separate)"
        );
        assert_eq!(wb.formats().len(), baseline + 1);
        // Both ids resolve to "General".
        assert_eq!(wb.formats().lookup(FormatId::Builtin(0)), Some("General"));
        assert_eq!(
            wb.formats().lookup(FormatId::legacy_from_u32(164)),
            Some("General")
        );
        // Step-4 audit Codex LOW closure: pin the 4th invariant —
        // `intern("General")` MUST return `Builtin(0)` even after
        // the Custom(LEGACY_PEER, 0) registration. The intern lookup
        // checks by_builtin_string FIRST, so the built-in wins.
        assert_eq!(
            wb.formats_mut().intern("General"),
            FormatId::Builtin(0),
            "intern() must short-circuit to Builtin even when Custom variant exists for same string"
        );
    }

    #[test]
    fn collision_with_existing_format_id_is_malformed_error() {
        // Register id 164 with one string, then try to register the
        // same id with a different string. The second call must
        // fail with MalformedOoxml.
        let mut wb = Workbook::new();
        wb.formats_mut()
            .register_at(FormatId::legacy_from_u32(164), "yyyy-mm-dd")
            .unwrap();
        let idx = StyleIndex {
            num_fmts: vec![NumFmtEntry {
                num_fmt_id: 164,
                format_code: "DIFFERENT".to_string(),
            }],
            cell_xfs: vec![],
        };
        match register_custom_formats(&mut wb, &idx) {
            Err(XlsxError::MalformedOoxml { part, .. }) => {
                assert_eq!(part, "xl/styles.xml");
            }
            other => panic!("expected MalformedOoxml, got {other:?}"),
        }
    }

    #[test]
    fn re_registering_same_id_with_same_string_is_idempotent() {
        // Sanity: registering id 164 with "yyyy-mm-dd" twice is a
        // no-op (the register_at impl handles this).
        let mut wb = Workbook::new();
        let idx = StyleIndex {
            num_fmts: vec![NumFmtEntry {
                num_fmt_id: 164,
                format_code: "yyyy-mm-dd".to_string(),
            }],
            cell_xfs: vec![],
        };
        register_custom_formats(&mut wb, &idx).unwrap();
        // Second call: same id, same string → should succeed.
        register_custom_formats(&mut wb, &idx).unwrap();
        assert_eq!(
            wb.formats().lookup(FormatId::legacy_from_u32(164)),
            Some("yyyy-mm-dd")
        );
    }
}

exec
/bin/zsh -lc "sed -n '250,285p' quantbook-engine/crates/ql-io-xlsx/src/lib.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
        let Some(content) = package.read_part_string(part_path)? else {
            continue;
        };
        let styled_cells = read::cell_styles_xml::parse_cell_styles_xml(&content, part_path)?;
        if styled_cells.is_empty() {
            continue;
        }
        let Some(sheet) = workbook.sheet_mut(sheet_idx as ql_types::SheetId) else {
            continue;
        };
        for (row, col, xf_idx) in styled_cells {
            // Resolve xf_idx → cellXf → numFmtId.
            let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
                continue;
            };
            if !xf.apply_number_format {
                // Cell renders as General — don't populate overlay.
                continue;
            }
            if xf.num_fmt_id == 0 {
                // General format — implicit. No overlay entry.
                continue;
            }
            // Phase 5.2 D-1 step 3: xlsx import uses the legacy
            // u32 → FormatId migration helper. n <= 163 → Builtin(n);
            // n >= 164 → Custom(LEGACY_PEER, n - 164). Step 6 may
            // change xlsx import to allocate non-legacy peer ids
            // (e.g. for collab-aware imports); pre-step-6 all xlsx
            // ids land under LEGACY_PEER.
            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
            sheet.format_overlay_mut().set(row, col, fmt_id);
        }
    }

    // **W5-D-14.2 — Phase 2e (HIGH-4 closure):** register defined names
    // (workbook-scope + sheet-scope) into the engine's `NameTable` /

exec
/bin/zsh -lc 'rg -n "BuiltinOutOfRange|FIRST_XLSX_BUILTIN_MAX|num_fmt_id|legacy_from_u32|register_custom_formats|cell_xfs|applyNumberFormat|apply_number" quantbook-engine/crates/ql-io-xlsx/src/read quantbook-engine/crates/ql-io-xlsx/src/lib.rs quantbook-engine/crates/ql-io-xlsx/tests' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:239:        read::styles_import::register_custom_formats(&mut workbook, &style_index)?;
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:262:            let Some(xf) = style_index.cell_xfs.get(xf_idx as usize) else {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:265:            if !xf.apply_number_format {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:269:            if xf.num_fmt_id == 0 {
quantbook-engine/crates/ql-io-xlsx/src/lib.rs:279:            let fmt_id = ql_storage::FormatId::legacy_from_u32(xf.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs:10://! is the cellXf index (0-based into `StyleIndex::cell_xfs`). The
quantbook-engine/crates/ql-io-xlsx/src/read/cell_styles_xml.rs:12://! `cell_xfs[s].num_fmt_id` + `apply_number_format`.
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:26:  <xf numFmtId="164" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:27:  <xf numFmtId="165" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:104:  <xf numFmtId="164" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs:157:            .lookup(ql_storage::FormatId::legacy_from_u32(164))
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:313:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:335:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:837:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:862:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:869:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1001:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1308:        zw.write_all(b"<?xml version=\"1.0\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cellXfs count=\"2\"><xf numFmtId=\"0\"/><xf numFmtId=\"164\" applyNumberFormat=\"1\"/></cellXfs><numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd\"/></numFmts></styleSheet>").unwrap();
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1633:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1691:        Some(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID)),
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1699:fn w5_d_15_1_libreoffice_apply_number_format_default_true() {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1702:    // the `applyNumberFormat` attribute. Per OOXML spec, default is
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1707:    // numFmtId=166 (custom formats) and NO applyNumberFormat attr.
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1733:         entry (W5-D-15.1 H-2 regression — applyNumberFormat default flipped)"
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1906:    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1953:        .lookup(FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:266:        // Custom(LEGACY_PEER, _) via legacy_from_u32(numFmtId) — xlsx
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs:273:                    .expect("xlsx import always produces LEGACY_PEER customs (legacy_from_u32)"),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:22://!     <xf numFmtId="164" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:23://!     <xf numFmtId="165" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:55:    /// `<c s="N">`. `cell_xfs[N].num_fmt_id` is the numFmtId that
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:57:    pub cell_xfs: Vec<CellXf>,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:66:    pub num_fmt_id: u32,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:79:    pub num_fmt_id: u32,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:80:    /// `applyNumberFormat` attribute (`"1"` / `"true"`). When false,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:82:    /// `num_fmt_id`.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:83:    pub apply_number_format: bool,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:127:                    idx.cell_xfs.push(parse_xf_attrs(&e));
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:143:                        idx.cell_xfs.push(parse_xf_attrs(&e));
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:161:    let mut num_fmt_id: Option<u32> = None;
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:167:            num_fmt_id = val.parse::<u32>().ok();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:172:    let id = num_fmt_id?;
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:177:        num_fmt_id: id,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:183:    let mut num_fmt_id: u32 = 0;
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:185:    // default for `applyNumberFormat` on `<cellXfs>/<xf>` is TRUE
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:190:    // applyNumberFormat attr → format IS applied per the spec).
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:192:    let mut apply_number_format = true;
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:197:            num_fmt_id = val.parse::<u32>().unwrap_or(0);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:198:        } else if key == b"applyNumberFormat" {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:200:            apply_number_format = val == "1" || val.eq_ignore_ascii_case("true");
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:204:        num_fmt_id,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:205:        apply_number_format,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:232:        assert!(idx.cell_xfs.is_empty());
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:262:        assert_eq!(idx.num_fmts[0].num_fmt_id, 164);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:264:        assert_eq!(idx.num_fmts[1].num_fmt_id, 165);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:269:    fn parse_cell_xfs_only_not_cell_style_xfs() {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:279:    <xf numFmtId="164" applyNumberFormat="1"/>
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:280:    <xf numFmtId="165" applyNumberFormat="true"/>
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:286:        assert_eq!(idx.cell_xfs.len(), 3);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:287:        assert_eq!(idx.cell_xfs[0].num_fmt_id, 0);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:289:        // `applyNumberFormat` is `true` when the attr is absent.
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:291:        assert!(idx.cell_xfs[0].apply_number_format);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:292:        assert_eq!(idx.cell_xfs[1].num_fmt_id, 164);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:293:        assert!(idx.cell_xfs[1].apply_number_format);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_xml.rs:295:        assert!(idx.cell_xfs[2].apply_number_format);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:6://! the format from `cellXfs[N].num_fmt_id`) requires worksheet XML
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:36:pub(crate) fn register_custom_formats(
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:44:        if entry.num_fmt_id < ql_storage::FIRST_CUSTOM_FORMAT_ID {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:55:        if entry.num_fmt_id > MAX_PLAUSIBLE_NUMFMT_ID {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:61:                    entry.num_fmt_id, MAX_PLAUSIBLE_NUMFMT_ID
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:68:        let id = FormatId::legacy_from_u32(entry.num_fmt_id);
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:98:                        entry.num_fmt_id, e
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:119:                    num_fmt_id: 0,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:123:                    num_fmt_id: 14,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:127:            cell_xfs: vec![],
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:129:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:142:                    num_fmt_id: 164,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:146:                    num_fmt_id: 165,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:152:            cell_xfs: vec![],
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:154:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:159:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:163:            wb.formats().lookup(FormatId::legacy_from_u32(165)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:191:                num_fmt_id: 164,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:194:            cell_xfs: vec![],
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:196:        let n = register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:206:            wb.formats().lookup(FormatId::legacy_from_u32(164)),
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:227:            .register_at(FormatId::legacy_from_u32(164), "yyyy-mm-dd")
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:231:                num_fmt_id: 164,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:234:            cell_xfs: vec![],
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:236:        match register_custom_formats(&mut wb, &idx) {
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:251:                num_fmt_id: 164,
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:254:            cell_xfs: vec![],
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:256:        register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:258:        register_custom_formats(&mut wb, &idx).unwrap();
quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:260:            wb.formats().lookup(FormatId::legacy_from_u32(164)),

exec
/bin/zsh -lc "sed -n '500,585p' quantbook-engine/crates/ql-oplog/src/replay.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
                ReplayError::InvalidSheet {
                    index,
                    sheet: *id,
                    sheet_count: workbook.sheet_count(),
                },
            )?;
            let canonical = |s: &str| ql_storage::Workbook::canonical_sheet_name(s);
            let cur_c = canonical(&current);
            let old_c = canonical(old_name);
            let new_c = canonical(new_name);
            if cur_c == new_c {
                // Already renamed (snapshot-authoritative path). No-op.
                Ok(())
            } else if cur_c == old_c {
                workbook
                    .rename_sheet(*id, new_name.clone())
                    .map_err(|source| ReplayError::SheetRenameRejected {
                        index,
                        id: *id,
                        old_name: old_name.clone(),
                        new_name: new_name.clone(),
                        source,
                    })?;
                Ok(())
            } else {
                Err(ReplayError::SheetRenameNameMismatch {
                    index,
                    id: *id,
                    expected: old_name.clone(),
                    found: current,
                })
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
            // **W5-80:** require the id to be registered. Catches
            // producer bugs where `SetCellFormat` was emitted without
            // a preceding `RegisterFormat`. `None` means clear.
            if let Some(wire_id) = id {
                // Phase 5.2 D-1 step 4: same wire→storage conversion.
                let fid = wire_id.to_storage();
                if workbook.formats().lookup(fid).is_none() {
                    return Err(ReplayError::FormatNotRegistered { index, id: fid });
                }
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .set(*row, *col, fid);
            } else {
                workbook
                    .sheet_mut(*sheet)
                    .expect("sheet validated above")
                    .format_overlay_mut()
                    .clear(*row, *col);
            }
            Ok(())
        }
        Op::BatchCommit { ops } => {
            for inner_op in ops {

exec
/bin/zsh -lc "sed -n '80,130p' quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs && sed -n '150,200p' quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
            allocated, id,
            "FormatTable::intern allocated a different id than next_custom_counter predicted"
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
                return Err(RuntimeError::UnknownFormatId(fid));
            }
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetCellFormat {
                sheet,
                row,
                col,
                // Phase 5.2 D-1 step 4: Op carries FormatIdWire directly;
                // drop the pre-step-4 to_legacy_u32 expect.
                id: id.map(ql_oplog::FormatIdWire::from_storage),
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
    /// If the cell's format references an id that's missing from the
    /// `FormatTable` (corrupted state — should not happen in practice
    /// because `set_cell_format` refuses unknown ids), falls back to
    /// `General` rendering. If the format string fails to parse,
    /// falls back to `General` and the renderer never errors.
    ///
    /// **W5-84 closure (Codex MEDIUM-2) cache-staleness caveat:** the
    /// `format_cache` is keyed by `FormatId` and populated on first
    /// `read_display` for that id. `FormatTable::register_at` rejects
    /// id→string mutations, so cached entries stay correct for the
    /// runtime's lifetime under the runtime's own append-only
    /// `intern_format` path. HOWEVER, the low-level
    /// `Workbook::formats_mut()` accessor (loader-only by convention but
    /// `pub` for the qbook loader + tests) can register a new id AFTER
    /// `read_display` has cached the General fallback for that id. In
    /// that pathological sequence the cache will continue rendering
    /// General until the runtime is rebuilt. Analogous to the
    /// `WorkbookEnv` date-system caveat documented on
    /// `Workbook::set_date_system`. Tracked as GAP-F-12 in
    /// `docs/known-gaps.md`.
    pub fn read_display(&mut self, sheet: SheetId, row: RowId, col: ColId) -> String {
        let value = self.workbook.read(ql_types::Address::new(sheet, row, col));
        let format_id = self
            .workbook
            .sheet(sheet)
            .and_then(|s| s.format_overlay().get(row, col))
            .unwrap_or(FormatId::GENERAL);
        // Cache lookup. Vacant → resolve via FormatTable + parse + insert.
        let needs_parse = !self.format_cache.contains_key(&format_id);
        if needs_parse {
            let parsed = self
                .workbook
                .formats()
                .lookup(format_id)
                .and_then(|s| format::parse(s).ok());
            // Fall back to General if either lookup or parse failed.
            let parsed = parsed.unwrap_or_else(|| {
                format::parse("General").expect("'General' is a valid format string")
            });
            self.format_cache.insert(format_id, parsed);
        }
        let fmt = self
            .format_cache
            .get(&format_id)
            .expect("just inserted above");
        // V1 EvalContext: workbook's date_system + en-US locale + System now-provider.
        let ctx = EvalContext {
            date_system: self.workbook.date_system(),
            ..EvalContext::default()
        };
        format::render(&value, fmt, &ctx)

exec
/bin/zsh -lc "rg -n \"SetCellFormat|set_cell_format|format_overlay_mut\\(\\)\\.set|FormatIdWire::Builtin|Builtin \\{ id \\}|BuiltinOutOfRange\" quantbook-engine/crates/ql-oplog quantbook-engine/crates/ql-exec quantbook-engine/crates/ql-io -g '*.rs'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "sed -n '330,355p' quantbook-engine/crates/ql-oplog/src/wire.rs && sed -n '570,620p' quantbook-engine/crates/ql-oplog/src/wire.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    pub fn from_storage(id: ql_storage::FormatId) -> Self {
        match id {
            ql_storage::FormatId::Builtin(n) => FormatIdWire::Builtin { id: n },
            ql_storage::FormatId::Custom(peer, counter) => FormatIdWire::Custom { peer, counter },
        }
    }

    /// **Phase 5.2 D-1 step 4 (2026-05-20):** decode the wire shape
    /// into the storage-side [`ql_storage::FormatId`]. Inverse of
    /// [`from_storage`]. Lossless — both types carry the same
    /// information.
    pub fn to_storage(self) -> ql_storage::FormatId {
        match self {
            FormatIdWire::Builtin { id } => ql_storage::FormatId::Builtin(id),
            FormatIdWire::Custom { peer, counter } => ql_storage::FormatId::Custom(peer, counter),
        }
    }
}

/// Map `ErrorValue` to its canonical Excel-style text form (`#REF!`, `#VALUE!`, etc.).
/// Used by both wire-format serialization and the user-visible representation per spec.
pub fn error_to_canonical_text(e: ErrorValue) -> String {
    e.sigil().to_string()
}

/// Parse a canonical Excel-style error sigil back into an `ErrorValue`.
    }

    // ===== Step 4 audit Opus L1 closure =====
    //
    // Direct unit tests for `FormatIdWire::from_storage` /
    // `::to_storage` round-trip across all 4 boundary points. The
    // mechanical match-arm projection is unlikely to regress, but
    // these tests document the lossless-projection contract
    // explicitly so step 5+ callers can rely on it.

    #[test]
    fn from_storage_to_storage_round_trip_for_builtin() {
        for n in [0_u32, 1, 14, 163, u32::MAX] {
            let storage = ql_storage::FormatId::Builtin(n);
            let wire = FormatIdWire::from_storage(storage);
            assert_eq!(
                wire,
                FormatIdWire::Builtin { id: n },
                "from_storage mapping for Builtin({n})"
            );
            assert_eq!(
                wire.to_storage(),
                storage,
                "round-trip storage→wire→storage for Builtin({n})"
            );
        }
    }

    #[test]
    fn from_storage_to_storage_round_trip_for_custom() {
        for (peer_u64, counter) in [
            (0_u64, 0_u32),
            (0, u32::MAX),
            (u64::MAX - 1, 0),
            (u64::MAX - 1, u32::MAX),
            (42, 7),
        ] {
            let peer = PeerId::new(peer_u64);
            let storage = ql_storage::FormatId::Custom(peer, counter);
            let wire = FormatIdWire::from_storage(storage);
            assert_eq!(
                wire,
                FormatIdWire::Custom { peer, counter },
                "from_storage mapping for Custom(PeerId({peer_u64}), {counter})"
            );
            assert_eq!(
                wire.to_storage(),
                storage,
                "round-trip storage→wire→storage for Custom"
            );
        }

 succeeded in 0ms:
quantbook-engine/crates/ql-oplog/src/replay.rs:121:    /// `Op::SetCellFormat` referenced a format id that hasn't been
quantbook-engine/crates/ql-oplog/src/replay.rs:123:    /// BEFORE `SetCellFormat` for any custom id; replay enforces that.
quantbook-engine/crates/ql-oplog/src/replay.rs:286:    /// `FormatIdWire::Builtin { id: u32 }` carries no range bound at the
quantbook-engine/crates/ql-oplog/src/replay.rs:294:    BuiltinOutOfRange { id: u32 },
quantbook-engine/crates/ql-oplog/src/replay.rs:321:            ql_storage::FormatTableError::BuiltinOutOfRange { id } => {
quantbook-engine/crates/ql-oplog/src/replay.rs:322:                FormatRejectedSource::BuiltinOutOfRange { id }
quantbook-engine/crates/ql-oplog/src/replay.rs:554:        Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:562:            // producer bugs where `SetCellFormat` was emitted without
quantbook-engine/crates/ql-oplog/src/replay.rs:1412:            id: crate::FormatIdWire::Builtin { id: 0 },
quantbook-engine/crates/ql-oplog/src/replay.rs:1432:            id: crate::FormatIdWire::Builtin { id: 0 },
quantbook-engine/crates/ql-oplog/src/replay.rs:1455:    fn replay_set_cell_format_binds_overlay() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1462:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1480:    fn replay_set_cell_format_with_none_clears_overlay() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1487:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1495:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1510:    fn replay_set_cell_format_unregistered_id_errors() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1513:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1534:    fn replay_set_cell_format_invalid_sheet_errors() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1536:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1540:            id: Some(crate::FormatIdWire::Builtin { id: 0 }),
quantbook-engine/crates/ql-oplog/src/replay.rs:1553:    fn replay_register_and_set_cell_format_built_in_id_14() {
quantbook-engine/crates/ql-oplog/src/replay.rs:1556:        // SetCellFormat should succeed.
quantbook-engine/crates/ql-oplog/src/replay.rs:1558:        log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/src/replay.rs:1562:            id: Some(crate::FormatIdWire::Builtin { id: 14 }),
quantbook-engine/crates/ql-oplog/src/op.rs:18://! | `SetCellFormat`    | `CellFormatOverlay::set` / `::clear` (W5-80)     |
quantbook-engine/crates/ql-oplog/src/op.rs:140:    SetCellFormat {
quantbook-engine/crates/ql-oplog/src/wire.rs:257:/// `Op::RegisterFormat` / `Op::SetCellFormat`.
quantbook-engine/crates/ql-oplog/src/wire.rs:260:/// - `Builtin { id }` — Excel-canonical built-in format ids (0..=163).
quantbook-engine/crates/ql-oplog/src/wire.rs:317:            FormatIdWire::Builtin { id: n }
quantbook-engine/crates/ql-oplog/src/wire.rs:332:            ql_storage::FormatId::Builtin(n) => FormatIdWire::Builtin { id: n },
quantbook-engine/crates/ql-oplog/src/wire.rs:343:            FormatIdWire::Builtin { id } => ql_storage::FormatId::Builtin(id),
quantbook-engine/crates/ql-oplog/src/wire.rs:395:        let original = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:420:            FormatIdWire::Builtin { id: 0 }
quantbook-engine/crates/ql-oplog/src/wire.rs:429:            FormatIdWire::Builtin { id: 163 }
quantbook-engine/crates/ql-oplog/src/wire.rs:464:        let a = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:465:        let b = FormatIdWire::Builtin { id: 14 };
quantbook-engine/crates/ql-oplog/src/wire.rs:587:                FormatIdWire::Builtin { id: n },
quantbook-engine/crates/ql-oplog/src/wire.rs:627:            FormatIdWire::Builtin { id: 0 },
quantbook-engine/crates/ql-oplog/src/wire.rs:628:            FormatIdWire::Builtin { id: 163 },
quantbook-engine/crates/ql-io/src/qbook_format.rs:176:///     + `Op::SetCellFormat` to carry `FormatIdWire`. The envelope's
quantbook-engine/crates/ql-io/src/qbook_format.rs:3185:        wb.sheet_mut(s1).unwrap().format_overlay_mut().set(
quantbook-engine/crates/ql-io/src/qbook_format.rs:3224:        wb.sheet_mut(s).unwrap().format_overlay_mut().set(2, 1, id);
quantbook-engine/crates/ql-io/src/qbook_format.rs:3748:    /// `FormatIdWire::Builtin { id: u32 }` accepts any u32 at the wire
quantbook-engine/crates/ql-io/src/qbook_format.rs:3788:                    details.contains("BuiltinOutOfRange"),
quantbook-engine/crates/ql-io/src/qbook_format.rs:3789:                    "details must mention BuiltinOutOfRange; got {details:?}"
quantbook-engine/crates/ql-io/src/qbook_format.rs:3792:            other => panic!("expected MalformedFormat(BuiltinOutOfRange), got {other:?}"),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:13://! - [`WorkbookRuntime::set_cell_format`] — bind a cell to a
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:32:    /// `FormatId`, which the caller can pass to [`set_cell_format`].
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:87:    /// clear its binding by passing `None`). Emits `Op::SetCellFormat`
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:95:    pub fn set_cell_format(
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:112:            oplog.append(Op::SetCellFormat {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:152:    /// because `set_cell_format` refuses unknown ids), falls back to
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:282:    fn set_cell_format_emits_op_and_updates_overlay() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:289:            rt.set_cell_format(s, 3, 5, Some(FormatId::Builtin(14)))
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:301:            Op::SetCellFormat {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:302:                id: Some(ql_oplog::FormatIdWire::Builtin { id: 14 }),
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:309:    fn set_cell_format_with_none_clears_overlay_and_emits_op() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:321:            rt.set_cell_format(s, 0, 0, None).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:327:            .any(|o| matches!(o, Op::SetCellFormat { id: None, .. })));
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:331:    fn set_cell_format_unknown_id_is_runtime_error() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:337:        let err = rt.set_cell_format(s, 0, 0, Some(bad_id)).unwrap_err();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:383:        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:401:        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:402:        rt.set_cell_format(s, 0, 1, Some(id)).unwrap();
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:439:    fn intern_and_set_cell_format_replay_round_trip() {
quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs:448:            rt.set_cell_format(s_p, 0, 0, Some(id)).unwrap();
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:87:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:91:        id: Some(ql_oplog::FormatIdWire::Builtin { id: 14 }),
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:94:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:100:    // And clear a binding (Op::SetCellFormat with None on a previously-
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:102:    ops.push(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:200:            Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:209:                        s.format_overlay_mut().set(*row, *col, wire_id.to_storage());
quantbook-engine/crates/ql-oplog/tests/producer_replay_equivalence.rs:315:    // bug in `RegisterFormat` / `SetCellFormat` ordering or id-
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:119:    /// **W5-82 (Phase 4.5.D part 6):** `set_cell_format` was called with
quantbook-engine/crates/ql-exec/src/workbook_runtime/error.rs:122:    /// "RegisterFormat before SetCellFormat" ordering; mirrors replay's
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:245:fn replay_set_cell_format_without_register() {
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:255:    log.append(Op::SetCellFormat {
quantbook-engine/crates/ql-oplog/tests/p412_defensive_oplog_probes.rs:263:    eprintln!("replay_set_cell_format_without_register: {r:?}");
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:408:        rt.set_cell_format(0, 0, 0, Some(FormatId::Builtin(14)))
quantbook-engine/crates/ql-exec/tests/oplog_e2e.rs:413:        rt.set_cell_format(0, 1, 0, Some(custom_id)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:76:        rt.set_cell_format(s2, 0, 0, Some(fmt_id)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:148:    rt.set_cell_format(0, 0, 0, Some(fmt_id)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:330:        rt.set_cell_format(0, 2, 0, Some(fmt_id)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:528:    rt.set_cell_format(s, 1, 0, Some(fmt_id)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1044:    rt.set_cell_format(0, 0, 0, Some(fmt)).unwrap();
quantbook-engine/crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs:1071:    rt.set_cell_format(0, 0, 0, Some(fmt)).unwrap();

codex
There is a more concrete correctness path than sparse counters: multi-peer allows the same format string to exist under different peer ids. The exporter flattens those to distinct xlsx `numFmtId`s with duplicate `formatCode`s, and I’m checking the import side because it currently dedup-skips same-string custom registrations.
exec
/bin/zsh -lc "sed -n '1,190p' quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
//! Probe: two distinct numFmtId values map to the same format code.
//! Does register_at handle this gracefully?

use ql_io_xlsx::{import_xlsx_path, RecomputeMode, XlsxImportOptions};

fn registry() -> ql_functions::FunctionRegistry {
    ql_functions::default_registry()
}

#[test]
#[ignore]
fn two_custom_ids_with_same_format_code() {
    use std::io::Write;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
  <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
</numFmts>
<cellXfs count="3">
  <xf numFmtId="0"/>
  <xf numFmtId="164" applyNumberFormat="1"/>
  <xf numFmtId="165" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"##;
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45001</v></c></row></sheetData></worksheet>"#,
            ),
            ("xl/styles.xml", styles),
        ];
        for (n, c) in parts {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    let src = std::env::temp_dir().join("opus-a-dup-fmt.xlsx");
    std::fs::write(&src, &buf).unwrap();

    let r = import_xlsx_path(
        &src,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    );
    match r {
        Ok(res) => {
            println!("import OK");
            for (id, c) in res.workbook.formats().iter() {
                if id.is_custom() {
                    println!("  id={:?} code={:?}", id, c);
                }
            }
            let sheet = res.workbook.sheet(0).unwrap();
            println!("  A1 overlay = {:?}", sheet.format_overlay().get(0, 0));
            println!("  B1 overlay = {:?}", sheet.format_overlay().get(0, 1));
        }
        Err(e) => println!("import ERR: {e}"),
    }
    let _ = std::fs::remove_file(&src);
}

/// Probe: numFmtId="0" with custom-id (164) re-declaration of "General".
#[test]
#[ignore]
fn libreoffice_general_at_custom_id_round_trip() {
    use std::io::Write;
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        // LibreOffice-style: numFmtId=164 with formatCode="General".
        let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1">
  <numFmt numFmtId="164" formatCode="General"/>
</numFmts>
<cellXfs count="2">
  <xf numFmtId="0"/>
  <xf numFmtId="164" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"##;
        let parts: &[(&str, &str)] = &[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
            ("xl/styles.xml", styles),
        ];
        for (n, c) in parts {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(c.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
    }
    let src = std::env::temp_dir().join("opus-a-lo-general.xlsx");
    std::fs::write(&src, &buf).unwrap();

    let r = import_xlsx_path(
        &src,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    let sheet = r.workbook.sheet(0).unwrap();
    println!(
        "import OK; A1 overlay = {:?}",
        sheet.format_overlay().get(0, 0)
    );
    println!(
        "formats[164] = {:?}",
        r.workbook
            .formats()
            .lookup(ql_storage::FormatId::legacy_from_u32(164))
    );
    // The cell references xf 1 → numFmtId=164. But the styles_import
    // closure for the "General-at-custom-id" case treats register_at
    // as a no-op. So `formats[164]` is None, but the overlay still
    // has FormatId(164). On EXPORT, the umya post-process emits
    // `numFmts` from `wb.formats().iter()` which filters to >= 164;
    // since 164 isn't in the table, the OOXML emit lacks the
    // declaration — and the cell's `s="N"` then references a numFmtId
    // not declared. Excel would render with the built-in 0 default,
    // but the *file* is technically lacking an entry.
    let _ = std::fs::remove_file(&src);
}

exec
/bin/zsh -lc "sed -n '640,720p' quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:

    #[test]
    fn intern_with_distinct_peers_does_not_collide() {
        // Phase 5.1 audit-locked D-1: two peers allocating from
        // counter=0 produce distinct FormatIds because peer differs.
        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
        let id_a = peer_a.intern("SAME_STRING");
        let id_b = peer_b.intern("SAME_STRING");
        // Same string, same counter, distinct peers — still distinct FormatIds.
        assert_ne!(id_a, id_b);
        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
    }

    #[test]
    fn next_custom_counter_advances_on_intern() {
        let mut t = FormatTable::new();
        assert_eq!(t.next_custom_counter(), 0);
        let _ = t.intern("CUSTOM");
        assert_eq!(t.next_custom_counter(), 1);
    }

    #[test]
    fn register_at_replays_known_id() {
        let mut t = FormatTable::new();
        // Step 3 audit Codex+Opus MEDIUM-1 closure: id 200 in legacy
        // u32 encoding is `Custom(LEGACY_PEER, 36)` per legacy_from_u32
        // (NOT `Builtin(200)` — Builtin invariant is 0..=163 per
        // docstring). Test now uses the migration helper to construct
        // the id, matching how real replay would resolve it.
        let id_200 = FormatId::legacy_from_u32(200);
        t.register_at(id_200, "REPLAY").unwrap();
        assert_eq!(t.lookup(id_200), Some("REPLAY"));
    }

    #[test]
    fn register_at_advances_local_counter_for_own_peer() {
        // Replaying an Op::RegisterFormat that allocated under OUR
        // peer must advance our counter so subsequent intern calls
        // don't collide.
        let mut t = FormatTable::with_peer(PeerId::new(7));
        t.register_at(FormatId::Custom(PeerId::new(7), 5), "REPLAY")
            .unwrap();
        // Counter should now be 6 — next intern allocates at counter=6.
        let next = t.intern("AFTER");
        assert_eq!(next, FormatId::Custom(PeerId::new(7), 6));
    }

    #[test]
    fn register_at_other_peer_does_not_advance_local_counter() {
        // A remote peer's Op::RegisterFormat registers an id under
        // THEIR peer; our local counter is unaffected.
        let mut t = FormatTable::with_peer(PeerId::new(7));
        let baseline = t.next_custom_counter();
        t.register_at(FormatId::Custom(PeerId::new(99), 5), "FROM_OTHER")
            .unwrap();
        assert_eq!(
            t.next_custom_counter(),
            baseline,
            "remote peer's allocation must not advance our counter"
        );
    }

    #[test]
    fn register_at_same_id_same_string_is_idempotent() {
        let mut t = FormatTable::new();
        t.register_at(FormatId::Builtin(0), "General").unwrap();
        assert!(t.register_at(FormatId::Builtin(0), "General").is_ok());
    }

    #[test]
    fn register_at_id_collision_errors() {
        let mut t = FormatTable::new();
        let err = t
            .register_at(FormatId::Builtin(0), "DIFFERENT")
            .unwrap_err();
        assert!(matches!(err, FormatTableError::IdCollision { .. }));
    }

    /// Step 4 audit Codex HIGH-1 closure: pin that `lookup_string`

exec
/bin/zsh -lc "sed -n '360,420p' quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs && sed -n '432,470p' quantbook-engine/crates/ql-exec/src/workbook_runtime/formats.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    fn read_display_with_built_in_date_format() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        // 2024-07-04 = serial 45477 in Excel1900.
        wb.put_at(s, 0, 0, Value::Number(45477.0));
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId::Builtin(14)); // m/d/yyyy
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert_eq!(rt.read_display(s, 0, 0), "7/4/2024");
    }

    #[test]
    fn read_display_with_custom_format() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(1234.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Intern then bind via runtime APIs (mirrors IDE-flow).
        let id = rt.intern_format("#,##0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "1,234.50");
    }

    #[test]
    fn read_display_caches_parsed_format() {
        // Render twice; the second call should hit the cache. We can't
        // directly observe cache hits without an accessor, but we can
        // verify the render result is stable and that mutating the
        // overlay between calls produces fresh output (cache stores
        // FormatString per id, not per cell).
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Number(42.0));
        wb.put_at(s, 0, 1, Value::Number(7.5));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let id = rt.intern_format("0.00").unwrap();
        rt.set_cell_format(s, 0, 0, Some(id)).unwrap();
        rt.set_cell_format(s, 0, 1, Some(id)).unwrap();
        assert_eq!(rt.read_display(s, 0, 0), "42.00");
        // Second call against a DIFFERENT cell using the SAME format id —
        // must hit the cached parsed FormatString.
        assert_eq!(rt.read_display(s, 0, 1), "7.50");
    }

    #[test]
    fn read_display_error_value_passes_sigil_through() {
        let mut wb = Workbook::new();
        let s = wb.add_sheet("S");
        wb.put_at(s, 0, 0, Value::Error(ErrorValue::DivZero));
        // Bind to a date format — error sigils ignore the format string.
        wb.sheet_mut(s)
            .unwrap()
            .format_overlay_mut()
            .set(0, 0, FormatId::Builtin(14));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            .set(0, 0, FormatId::Builtin(49)); // @
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        assert_eq!(rt.read_display(s, 0, 0), "hello");
    }

    #[test]
    fn intern_and_set_cell_format_replay_round_trip() {
        // The two new ops must survive replay against a fresh workbook.
        let mut producer_wb = Workbook::new();
        let s_p = producer_wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut log);
            let id = rt.intern_format("\"€\" #,##0.00").unwrap();
            rt.set_cell_format(s_p, 0, 0, Some(id)).unwrap();
        }
        // Replay against a fresh workbook.
        let mut replay_wb = Workbook::new();
        replay_wb.add_sheet("S");
        ql_oplog::replay_into(&log, &mut replay_wb, &reg).unwrap();
        // Format registered.
        let custom_id = FormatId::legacy_from_u32(ql_storage::FIRST_CUSTOM_FORMAT_ID);
        assert_eq!(
            replay_wb.formats().lookup(custom_id),
            Some("\"€\" #,##0.00")
        );
        // Cell overlay restored.
        assert_eq!(
            replay_wb.sheet(0).unwrap().format_overlay().get(0, 0),
            Some(custom_id)
        );
    }
}

exec
/bin/zsh -lc "rg -n \"StringCollision|same string|duplicate|dedup|by_custom_string|lookup\\(.*FormatId::legacy_from_u32\\(165\\)|format_overlay\\(\\).*165\" quantbook-engine/crates/ql-io-xlsx/tests quantbook-engine/crates/ql-storage/src/format.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-storage/src/format.rs:188:/// Workbook-level format-string interning + dedup table.
quantbook-engine/crates/ql-storage/src/format.rs:214:    /// per-peer dedup. Two peers interning the same string produce
quantbook-engine/crates/ql-storage/src/format.rs:220:    by_custom_string: HashMap<(PeerId, String), FormatId>,
quantbook-engine/crates/ql-storage/src/format.rs:256:            by_custom_string: HashMap::new(),
quantbook-engine/crates/ql-storage/src/format.rs:336:    /// 2. `by_custom_string[(local_peer, s)]` (THIS peer's Custom
quantbook-engine/crates/ql-storage/src/format.rs:337:    ///    dedup; intentionally does NOT find OTHER peers' Customs
quantbook-engine/crates/ql-storage/src/format.rs:338:    ///    with the same string).
quantbook-engine/crates/ql-storage/src/format.rs:342:    /// Used by `WorkbookRuntime::intern_format` to dedupe correctly
quantbook-engine/crates/ql-storage/src/format.rs:352:        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
quantbook-engine/crates/ql-storage/src/format.rs:366:    /// 2. `by_custom_string[(local_peer, s)]` — this peer's own custom
quantbook-engine/crates/ql-storage/src/format.rs:367:    ///    dedup map. A remote peer's `Custom(other_peer, _)` with the
quantbook-engine/crates/ql-storage/src/format.rs:368:    ///    same string does NOT short-circuit our allocation.
quantbook-engine/crates/ql-storage/src/format.rs:381:        if let Some(id) = self.by_custom_string.get(&(self.local_peer, s.to_string())) {
quantbook-engine/crates/ql-storage/src/format.rs:391:        self.by_custom_string
quantbook-engine/crates/ql-storage/src/format.rs:409:    /// closure):** Custom and Builtin variants use SEPARATE dedup
quantbook-engine/crates/ql-storage/src/format.rs:410:    /// maps. Two peers can register the same string under their own
quantbook-engine/crates/ql-storage/src/format.rs:449:        // Step 1: id-side dedup. If `id` is already present, must map
quantbook-engine/crates/ql-storage/src/format.rs:450:        // to the same string (else IdCollision — a real corruption).
quantbook-engine/crates/ql-storage/src/format.rs:461:        // Step 2: string-side dedup, routed by variant.
quantbook-engine/crates/ql-storage/src/format.rs:468:                    return Err(FormatTableError::StringCollision {
quantbook-engine/crates/ql-storage/src/format.rs:476:                if let Some(existing_id) = self.by_custom_string.get(&(peer, s.to_string())) {
quantbook-engine/crates/ql-storage/src/format.rs:480:                    return Err(FormatTableError::StringCollision {
quantbook-engine/crates/ql-storage/src/format.rs:495:                self.by_custom_string.insert((peer, s.to_string()), id);
quantbook-engine/crates/ql-storage/src/format.rs:558:    StringCollision {
quantbook-engine/crates/ql-storage/src/format.rs:611:        // Re-intern same string returns same id.
quantbook-engine/crates/ql-storage/src/format.rs:722:    /// the same string MUST NOT short-circuit our local lookup.
quantbook-engine/crates/ql-storage/src/format.rs:741:        // After local peer interns the same string, lookup returns
quantbook-engine/crates/ql-storage/src/format.rs:750:    /// Custom variant with the same string. Built-in lookup is global.
quantbook-engine/crates/ql-storage/src/format.rs:764:    /// same-string-different-id is still rejected as StringCollision.
quantbook-engine/crates/ql-storage/src/format.rs:772:        // Builtin(99) must error with StringCollision (within the
quantbook-engine/crates/ql-storage/src/format.rs:775:        assert!(matches!(err, FormatTableError::StringCollision { .. }));
quantbook-engine/crates/ql-storage/src/format.rs:789:        // to register the same string at two different Custom counters
quantbook-engine/crates/ql-storage/src/format.rs:797:        assert!(matches!(err, FormatTableError::StringCollision { .. }));
quantbook-engine/crates/ql-storage/src/format.rs:960:    /// `by_string` into separate `by_builtin_string` + `by_custom_string`
quantbook-engine/crates/ql-storage/src/format.rs:978:        // Both ids resolve back to the same string.
quantbook-engine/crates/ql-storage/src/format.rs:984:        // Same-peer DIFFERENT-counter same-string is StringCollision
quantbook-engine/crates/ql-storage/src/format.rs:990:        assert!(matches!(err, FormatTableError::StringCollision { .. }));
quantbook-engine/crates/ql-storage/src/format.rs:1008:    /// (Validates the producer-side dedup is peer-scoped.)
quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs:191:/// imported workbook (e.g. user-saved a duplicate). Does the
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:285:    // triggered `StringCollision` because "General" is already at
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:918:fn w5_d_15_round_trip_dedup_shared_format_id() {
quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:941:    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-dedup.xlsx");

exec
/bin/zsh -lc 'cargo test -p ql-io-xlsx --test opus_a_dup_fmt two_custom_ids_with_same_format_code -- --ignored --nocapture' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 succeeded in 4795ms:
   Compiling ql-io-xlsx v0.1.0 (/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.44s
     Running tests/opus_a_dup_fmt.rs (target/debug/deps/opus_a_dup_fmt-ac96a502a5a44825)

running 1 test
import OK
  id=Custom(PeerId(0), 0) code="yyyy-mm-dd"
  A1 overlay = Some(Custom(PeerId(0), 0))
  B1 overlay = Some(Custom(PeerId(0), 1))
test two_custom_ids_with_same_format_code ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s


exec
/bin/zsh -lc "sed -n '180,245p' quantbook-engine/crates/ql-io-xlsx/tests/opus_a_edge_cases.rs && sed -n '900,965p' quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
                }
            }
        }
        Err(e) => {
            println!("Unicode export failed: {e}");
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe C: same custom format code at two different ids in an
/// imported workbook (e.g. user-saved a duplicate). Does the
/// FormatTable handle it idempotently?
#[test]
#[ignore]
fn custom_format_byte_for_byte_preservation_with_special_chars() {
    // Format codes that include characters the OOXML emitter must
    // escape: `<`, `>`, `&`, `"`. Verify the format code string
    // survives identical.
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    let id_amp = wb.formats_mut().intern("#,##0 \"& foo\"");
    let id_lt = wb.formats_mut().intern("0;[<5]0.00");
    let id_quot = wb.formats_mut().intern("0.00 \"x\" 0.00");
    println!("ids: {:?} {:?} {:?}", id_amp, id_lt, id_quot);
    let tmp = std::env::temp_dir().join("opus-a-format-bytes.xlsx");
    let _ = std::fs::remove_file(&tmp);
    export_xlsx_path(&wb, &registry(), &tmp, XlsxExportOptions::default()).unwrap();

    // Dump styles.xml to inspect escapes.
    let bytes = std::fs::read(&tmp).unwrap();
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    let mut styles_xml = String::new();
    if let Ok(mut e) = zip.by_name("xl/styles.xml") {
        e.read_to_string(&mut styles_xml).unwrap();
    }
    println!("--- xl/styles.xml ---\n{}\n", styles_xml);

    let r = import_xlsx_path(
        &tmp,
        &registry(),
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();
    for (id, c) in r.workbook.formats().iter() {
        if id.is_custom() {
            println!("after roundtrip id={:?} code={:?}", id, c);
        }
    }
    let _ = std::fs::remove_file(&tmp);
}

/// Probe D: defined name with a value-only target — verify the
/// engine's NameTable canonicalizes the lookup case-insensitively
/// after round-trip.
#[test]
#[ignore]
fn name_case_round_trip() {
    let mut wb = Workbook::new();
    wb.add_sheet("S1");
    // Mix-case set; lookup case-insensitive.
    wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(7.0)))
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let imported_overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(
        imported_overlay.get(2, 1),
        Some(FormatId::Builtin(14)),
        "built-in formatId 14 did not survive round-trip"
    );

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_round_trip_dedup_shared_format_id() {
    // **W5-D-15:** two cells sharing the same FormatId should reuse
    // the same cellXf slot — the cellXfs roster has exactly one
    // entry past the default.
    use ql_storage::Workbook;
    use ql_types::Value;

    let mut wb = Workbook::new();
    let s = wb.add_sheet("Sheet1");
    // Use a code that's not in the built-in roster so `intern` allocates ≥164.
    let custom_code = "#,##0.00 \"€\"";
    let fmt = wb.formats_mut().intern(custom_code);
    assert!(
        fmt.is_custom(),
        "expected custom format id (>= 164 in legacy u32), got {:?}",
        fmt
    );
    wb.put_at(s, 0, 0, Value::Number(0.42));
    wb.put_at(s, 1, 0, Value::Number(0.55));
    let sheet = wb.sheet_mut(s).unwrap();
    sheet.format_overlay_mut().set(0, 0, fmt);
    sheet.format_overlay_mut().set(1, 0, fmt);

    let tmp = std::env::temp_dir().join("w5-d-15-roundtrip-dedup.xlsx");
    let _ = std::fs::remove_file(&tmp);
    let registry = ql_functions::default_registry();
    export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default()).unwrap();

    let result = import_xlsx_path(
        &tmp,
        &registry,
        XlsxImportOptions {
            recompute: RecomputeMode::Skip,
            ..Default::default()
        },
    )
    .unwrap();

    let overlay = result.workbook.sheet(0).unwrap().format_overlay();
    assert_eq!(overlay.get(0, 0), Some(fmt));
    assert_eq!(overlay.get(1, 0), Some(fmt));
    assert_eq!(result.workbook.formats().lookup(fmt), Some(custom_code));

    let _ = std::fs::remove_file(&tmp);
}

#[test]
fn w5_d_15_2_formula_with_blank_cache_format_overlay_round_trips() {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs | sed -n '64,105p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs | sed -n '90,190p;230,265p;465,525p;1118,1145p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
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

 succeeded in 0ms:
    90	///
    91	/// **Translation:**
    92	/// - `Builtin(n)` → `n` (canonical xlsx built-in id; no flattening).
    93	/// - `Custom(_, _)` → sequential xlsx numFmtId starting at
    94	///   `FIRST_CUSTOM_FORMAT_ID = 164`. Order is deterministic: sorted
    95	///   by `FormatId`'s derived `Ord` (Builtin sorts before Custom; within
    96	///   Custom, by `(peer, counter)`).
    97	///
    98	/// **Byte-stability:** for the LEGACY_PEER-only case (single-writer
    99	/// pre-D-1 default), sorted Custom ids are in counter order, so the
   100	/// allocator produces `Custom(LEGACY_PEER, c) → c + 164` — identical
   101	/// to the pre-step-6 `to_legacy_u32().expect()` output. Existing xlsx
   102	/// round-trip tests round-trip byte-identically.
   103	///
   104	/// **Information loss reporting:** non-LEGACY peer ids round-trip
   105	/// CORRECTLY through xlsx, but reimporting an xlsx export collapses
   106	/// them to `Custom(LEGACY_PEER, _)` (the legacy_from_u32 path —
   107	/// xlsx has no peer concept to recover). The flattened ids are
   108	/// recorded in `info_lost` so the export caller can surface them via
   109	/// `XlsxExportReport.dropped_features`. Per the no-fallbacks doctrine,
   110	/// the loss is reported rather than silently absorbed.
   111	struct XlsxNumFmtTranslation {
   112	    /// `Custom(peer, counter) → flattened xlsx numFmtId`. Builtin
   113	    /// variants are NOT in this map — the translator returns `n`
   114	    /// directly for `Builtin(n)`.
   115	    custom_map: std::collections::HashMap<FormatId, u32>,
   116	    /// `(original Custom FormatId, flattened xlsx numFmtId)` for any
   117	    /// Custom whose peer ≠ LEGACY_PEER. These are the lossy entries
   118	    /// from the round-trip perspective: xlsx → .qbook recovery
   119	    /// produces `Custom(LEGACY_PEER, _)`, losing the original peer id.
   120	    /// Caller surfaces via `XlsxExportReport.dropped_features`.
   121	    info_lost: Vec<(FormatId, u32)>,
   122	}
   123	
   124	impl XlsxNumFmtTranslation {
   125	    /// Build the translation over all Custom FormatIds the export will
   126	    /// reference. The union of:
   127	    /// - `workbook.formats()` Custom entries (the format-table roster
   128	    ///   used by the `<numFmts>` injection).
   129	    /// - `cellxfs_roster` Custom entries (overlay-used FormatIds; these
   130	    ///   may include Customs not in the format table if the overlay was
   131	    ///   set without first registering via `intern`, though this is
   132	    ///   pathological).
   133	    ///
   134	    /// Deterministic ordering via `BTreeSet<FormatId>`.
   135	    fn build(workbook: &Workbook, cellxfs_roster: &[FormatId]) -> Self {
   136	        let mut customs: std::collections::BTreeSet<FormatId> = std::collections::BTreeSet::new();
   137	        for (id, _) in workbook.formats().iter() {
   138	            if id.is_custom() {
   139	                customs.insert(id);
   140	            }
   141	        }
   142	        for fid in cellxfs_roster {
   143	            if fid.is_custom() {
   144	                customs.insert(*fid);
   145	            }
   146	        }
   147	        let mut custom_map = std::collections::HashMap::new();
   148	        let mut info_lost = Vec::new();
   149	        let mut next = FIRST_CUSTOM_FORMAT_ID;
   150	        for fid in customs {
   151	            let xlsx_id = next;
   152	            // Step-5 audit Codex M1 lesson: checked_add guards
   153	            // overflow even on programmer-controlled paths. With
   154	            // u32::MAX - 164 = ~4.3 billion custom formats this fires
   155	            // truly never, but the explicit check documents intent.
   156	            next = next
   157	                .checked_add(1)
   158	                .expect("xlsx custom numFmtId allocator exhausted (u32::MAX entries)");
   159	            custom_map.insert(fid, xlsx_id);
   160	            if let FormatId::Custom(peer, _) = fid {
   161	                if peer != LEGACY_PEER {
   162	                    info_lost.push((fid, xlsx_id));
   163	                }
   164	            }
   165	        }
   166	        Self {
   167	            custom_map,
   168	            info_lost,
   169	        }
   170	    }
   171	
   172	    /// Translate `FormatId → xlsx numFmtId`. `Builtin(n)` returns `n`
   173	    /// directly (canonical xlsx id, never needs flattening). `Custom`
   174	    /// looks up the flattened id from the map.
   175	    ///
   176	    /// **Invariant:** the FormatId MUST be in the translation's scope
   177	    /// — either registered in `workbook.formats()` or present in the
   178	    /// `cellxfs_roster` the translation was built over. Callers in this
   179	    /// file query subsets of those two sets, so the lookup never misses
   180	    /// in practice. The expect documents this invariant rather than
   181	    /// being a real panic path.
   182	    fn translate(&self, fid: FormatId) -> u32 {
   183	        match fid {
   184	            FormatId::Builtin(n) => n,
   185	            FormatId::Custom(_, _) => *self.custom_map.get(&fid).unwrap_or_else(|| {
   186	                panic!(
   187	                    "xlsx numFmt translation: unmapped Custom FormatId {fid:?}; \
   188	                     build() must include this id (programmer error in umya_export.rs)"
   189	                )
   190	            }),
   230	    // both at once.
   231	    let mut sorted_format_ids: std::collections::BTreeSet<FormatId> =
   232	        std::collections::BTreeSet::new();
   233	    for sheet_id in 0..workbook.sheet_count() as u16 {
   234	        if let Some(sheet) = workbook.sheet(sheet_id) {
   235	            for (_addr, fid) in sheet.format_overlay().iter() {
   236	                sorted_format_ids.insert(fid);
   237	            }
   238	        }
   239	    }
   240	    let cellxfs_roster: Vec<FormatId> = sorted_format_ids.iter().copied().collect();
   241	    let format_to_xf_index: std::collections::HashMap<FormatId, u32> = cellxfs_roster
   242	        .iter()
   243	        .enumerate()
   244	        .map(|(i, fid)| (*fid, (i as u32) + 1)) // slot 0 reserved for default
   245	        .collect();
   246	
   247	    // **Phase 5.2 D-1 step 6 (2026-05-20):** build the xlsx numFmtId
   248	    // translation. Maps every Custom FormatId (across both wb.formats()
   249	    // and overlays) to a flattened sequential numFmtId starting at 164.
   250	    // Builtins are translated inline by the helper. info_lost surfaces
   251	    // non-LEGACY peer flattens to XlsxExportReport.dropped_features
   252	    // below.
   253	    let xlsx_numfmt = XlsxNumFmtTranslation::build(workbook, &cellxfs_roster);
   254	    for (orig_fid, flattened_id) in &xlsx_numfmt.info_lost {
   255	        report
   256	            .dropped_features
   257	            .push(crate::report::UnsupportedFeature {
   258	                kind: crate::error::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten"),
   259	                part: "xl/styles.xml".to_string(),
   260	                detail: format!(
   261	                    "Custom format id {orig_fid:?} flattened to xlsx numFmtId {flattened_id} \
   262	                     (xlsx single-namespace; reimporting recovers as Custom(LEGACY_PEER, _))"
   263	                ),
   264	            });
   265	    }
   465	    // Phase 5.2 D-1 step 6 (2026-05-20): use the xlsx numFmt translation
   466	    // (built above over `wb.formats() + cellxfs_roster` Customs). For
   467	    // LEGACY_PEER-only workbooks the translated numFmtIds match the
   468	    // pre-step-6 `to_legacy_u32()` output identically. Multi-peer
   469	    // FormatIds get flattened to the contiguous range with reporting.
   470	    let custom_formats: Vec<(u32, String)> = workbook
   471	        .formats()
   472	        .iter()
   473	        .filter_map(|(id, code)| {
   474	            if id.is_custom() {
   475	                Some((xlsx_numfmt.translate(id), code.to_string()))
   476	            } else {
   477	                None
   478	            }
   479	        })
   480	        .collect();
   481	
   482	    // **W5-D-14.2 (HIGH-4 closure — export side):** collect workbook-
   483	    // scoped + sheet-scoped names. Each is rendered as the OOXML
   484	    // `<definedName name="X" [localSheetId="N"]>target</definedName>`.
   485	    let defined_names = collect_defined_names(workbook)?;
   486	
   487	    // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** populate
   488	    // `report.dropped_features` with names that couldn't be rendered
   489	    // (Constant(Error)/Constant(Blank) targets). `collect_defined_names`
   490	    // silently drops these; without this surfacing, NewWorkbook
   491	    // Strict mode never fires for them.
   492	    let dropped_named_count = count_undeserializable_names(workbook);
   493	    for _ in 0..dropped_named_count {
   494	        report
   495	            .dropped_features
   496	            .push(crate::report::UnsupportedFeature {
   497	                kind: crate::error::UnsupportedFeatureKind::Other("named-range-constant"),
   498	                part: "xl/workbook.xml".to_string(),
   499	                detail: "named range with Error/Blank constant target cannot \
   500	                         serialize to OOXML formula text"
   501	                    .to_string(),
   502	            });
   503	    }
   504	
   505	    // **W5-D-14.2 (HIGH-3 closure):** collect tables. Tables write to
   506	    // their own `xl/tables/table{N}.xml` parts AND require updates to
   507	    // sheet rels + worksheet `<tableParts>` + `[Content_Types].xml`.
   508	    let tables = collect_table_exports(workbook);
   509	
   510	    // Phase 5.2 D-1 step 6: pre-translate the cellxfs roster into
   511	    // (FormatId, xlsx_numFmtId) pairs so post-process doesn't need
   512	    // the translation helper. For each FormatId in the roster, look
   513	    // up its flattened numFmtId. Pre-step-6 the inject site computed
   514	    // `fid.to_legacy_u32().expect()` inline; now that translation is
   515	    // explicit + multi-peer aware.
   516	    let cellxfs_roster_translated: Vec<(FormatId, u32)> = cellxfs_roster
   517	        .iter()
   518	        .map(|&fid| (fid, xlsx_numfmt.translate(fid)))
   519	        .collect();
   520	
   521	    let needs_post_process = needs_date1904
   522	        || needs_cell_fixes
   523	        || !custom_formats.is_empty()
   524	        || !defined_names.is_empty()
   525	        || !tables.is_empty()
  1118	/// applyNumberFormat); slots 1..N follow the `cellxfs_roster` order
  1119	/// (which matches the `xf_index` values minted at the cell-fix
  1120	/// collection site so `<c s="N">` round-trips correctly).
  1121	///
  1122	/// **Phase 5.2 D-1 step 6 (2026-05-20):** `cellxfs_roster` now carries
  1123	/// `(FormatId, xlsx_numFmtId)` pairs — the numFmtId is pre-translated
  1124	/// by `XlsxNumFmtTranslation` at the caller. This drops the pre-step-6
  1125	/// `fid.to_legacy_u32().expect()` panic site; non-LEGACY peer ids
  1126	/// flatten correctly through the translation.
  1127	fn inject_cell_xfs_into_styles_xml(
  1128	    content: Vec<u8>,
  1129	    cellxfs_roster: &[(FormatId, u32)],
  1130	) -> Result<Vec<u8>, XlsxError> {
  1131	    let text = String::from_utf8(content)
  1132	        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;
  1133	
  1134	    let count = cellxfs_roster.len() + 1;
  1135	    let mut block = String::with_capacity(64 * count);
  1136	    block.push_str(&format!(r#"<cellXfs count="{}">"#, count));
  1137	    // Slot 0: default xf.
  1138	    block.push_str(r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#);
  1139	    for (_fid, xlsx_num_fmt_id) in cellxfs_roster {
  1140	        block.push_str(&format!(
  1141	            concat!(
  1142	                r#"<xf numFmtId="{}" fontId="0" fillId="0" borderId="0" xfId="0" "#,
  1143	                r#"applyNumberFormat="1"/>"#,
  1144	            ),
  1145	            xlsx_num_fmt_id,

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/lib.rs | sed -n '250,282p;370,392p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
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
   370	    options: XlsxExportOptions,
   371	) -> Result<XlsxExportReport, XlsxError> {
   372	    let out_path = out.as_ref();
   373	    match options.mode {
   374	        ExportMode::NewWorkbook => {
   375	            // **W5-D-PM-3 (megaudit Opus-A HIGH-2 closure):** previously
   376	            // NewWorkbook ignored `unsupported_policy`. Things that
   377	            // SHOULD be dropped (Constant(Error)/Constant(Blank)
   378	            // named-target values; future-deferred features) never
   379	            // populated `dropped_features` and never triggered Strict.
   380	            // Now collect drops + enforce policy. The exporter populates
   381	            // `report.dropped_features`; we apply Strict here.
   382	            let mut report =
   383	                write::umya_export::export_new_workbook(workbook, out_path, options.formula_cache)?;
   384	            report.warnings.shrink_to_fit();
   385	            if !report.dropped_features.is_empty()
   386	                && options.unsupported_policy == UnsupportedPolicy::Strict
   387	            {
   388	                let first = report.dropped_features[0].clone();
   389	                return Err(XlsxError::UnsupportedFeature {
   390	                    feature: first.kind,
   391	                    part: first.part,
   392	                    detail: first.detail,

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs | sed -n '48,58p;224,238p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    48	    // Step 1: shadow export to a sibling temp path. Use a unique name
    49	    // so concurrent exports don't collide.
    50	    let shadow_path = sibling_tmp_path(output_path);
    51	    let _shadow_cleanup = ScopedFileGuard::new(&shadow_path);
    52	    let mut report = export_new_workbook(workbook, &shadow_path, formula_cache)?;
    53	
    54	    // Step 2: read both packages into memory.
    55	    let shadow_bytes = std::fs::read(&shadow_path)?;
    56	
    57	    // Step 3: assemble the final output zip. We walk the shadow first
    58	    // (canonical source-of-truth for Quantbook-owned parts), then
   224	    // under `Strict` mode. The contract is "Strict means no-loss";
   225	    // touching the user's destination on a drop violates it.
   226	    if !dropped.is_empty() {
   227	        match unsupported_policy {
   228	            UnsupportedPolicy::Permissive => {
   229	                report.dropped_features.extend(dropped);
   230	            }
   231	            UnsupportedPolicy::Strict => {
   232	                let first = dropped.into_iter().next().unwrap();
   233	                return Err(XlsxError::UnsupportedFeature {
   234	                    feature: first.kind,
   235	                    part: first.part,
   236	                    detail: first.detail,
   237	                });
   238	            }

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format.rs | sed -n '128,140p;532,540p;472,482p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   128	    /// - `Custom(LEGACY_PEER, c)` → `Some(c + 164)` (round-trips
   129	    ///   pre-5.2 saves).
   130	    /// - `Custom(non-legacy-peer, _)` → `None` (a peer other than
   131	    ///   LEGACY_PEER allocated this id; pre-5.2 envelopes can't
   132	    ///   represent it). Step 6's xlsx export decides what to do
   133	    ///   (e.g. flatten by allocation order).
   134	    pub fn to_legacy_u32(self) -> Option<u32> {
   135	        match self {
   136	            FormatId::Builtin(n) => Some(n),
   137	            FormatId::Custom(peer, c) if peer == LEGACY_PEER => Some(c + FIRST_CUSTOM_FORMAT_ID),
   138	            FormatId::Custom(_, _) => None,
   139	        }
   140	    }
   472	                    });
   473	                }
   474	            }
   475	            FormatId::Custom(peer, _) => {
   476	                if let Some(existing_id) = self.by_custom_string.get(&(peer, s.to_string())) {
   477	                    if *existing_id == id {
   478	                        return Ok(());
   479	                    }
   480	                    return Err(FormatTableError::StringCollision {
   481	                        string: s.to_string(),
   482	                        existing_id: *existing_id,
   532	    /// returned the full pre-5.2 u32 id. Now returns just the counter
   533	    /// (which is per-peer); the full FormatId is built as
   534	    /// `FormatId::Custom(self.local_peer(), self.next_custom_counter())`.
   535	    pub fn next_custom_counter(&self) -> u32 {
   536	        self.next_custom_counter
   537	    }
   538	
   539	    /// Iterate `(id, &str)` in arbitrary order. Persistence + op-log
   540	    /// snapshotting consumers must sort by id when wire-stable order

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs | sed -n '1770,1815p;1840,1888p;1894,1938p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1770	#[test]
  1771	fn step6_multi_peer_format_ids_flatten_and_report_on_xlsx_export() {
  1772	    // **Step 6 closure test:** the property step 6 enables. Pre-step-6
  1773	    // xlsx export's `to_legacy_u32().expect(...)` panicked on
  1774	    // `Custom(non-LEGACY peer, _)` ids. Post-step-6 the export
  1775	    // flattens them into a contiguous xlsx numFmtId range starting at
  1776	    // 164 and surfaces the non-LEGACY entries via
  1777	    // `XlsxExportReport.dropped_features` (per the no-fallback rule
  1778	    // — silent loss is forbidden; explicit reporting is OK).
  1779	    use ql_storage::{FormatId, Workbook};
  1780	    use ql_types::{PeerId, Value};
  1781	
  1782	    let mut wb = Workbook::new();
  1783	    let s = wb.add_sheet("Sheet1");
  1784	
  1785	    // Allocate two Custom formats under non-LEGACY peers + one under
  1786	    // LEGACY_PEER. Apply each to a distinct cell.
  1787	    wb.formats_mut().set_local_peer(PeerId::new(42));
  1788	    let peer42_fmt = wb.formats_mut().intern("yyyy-mm-dd");
  1789	    assert_eq!(peer42_fmt, FormatId::Custom(PeerId::new(42), 0));
  1790	
  1791	    wb.formats_mut().set_local_peer(PeerId::new(99));
  1792	    let peer99_fmt = wb.formats_mut().intern("0.0000%");
  1793	    assert_eq!(peer99_fmt, FormatId::Custom(PeerId::new(99), 0));
  1794	
  1795	    wb.formats_mut().set_local_peer(ql_types::LEGACY_PEER);
  1796	    let legacy_fmt = wb.formats_mut().intern("#,##0.00 USD");
  1797	    assert_eq!(legacy_fmt, FormatId::Custom(ql_types::LEGACY_PEER, 0));
  1798	
  1799	    wb.put_at(s, 0, 0, Value::Number(45000.0));
  1800	    wb.put_at(s, 1, 0, Value::Number(0.42));
  1801	    wb.put_at(s, 2, 0, Value::Number(1234.56));
  1802	    let sheet = wb.sheet_mut(s).unwrap();
  1803	    sheet.format_overlay_mut().set(0, 0, peer42_fmt);
  1804	    sheet.format_overlay_mut().set(1, 0, peer99_fmt);
  1805	    sheet.format_overlay_mut().set(2, 0, legacy_fmt);
  1806	
  1807	    let tmp = std::env::temp_dir().join("step6-multi-peer-flatten.xlsx");
  1808	    let _ = std::fs::remove_file(&tmp);
  1809	    let registry = ql_functions::default_registry();
  1810	
  1811	    // Pre-step-6 this `export_xlsx_path` call would have PANICKED at
  1812	    // `to_legacy_u32().expect()` because peer42_fmt and peer99_fmt
  1813	    // are not LEGACY_PEER.
  1814	    let report = export_xlsx_path(&wb, &registry, &tmp, XlsxExportOptions::default())
  1815	        .expect("step 6: multi-peer xlsx export must succeed (was a panic pre-step-6)");
  1840	        .join(" | ");
  1841	    assert!(details.contains("Custom(PeerId(42)"));
  1842	    assert!(details.contains("Custom(PeerId(99)"));
  1843	
  1844	    // Re-importing should produce 3 Custom(LEGACY_PEER, _) entries
  1845	    // (xlsx has no peer concept to recover). The format CODES must
  1846	    // round-trip; the peer-ids collapse to LEGACY.
  1847	    let result = import_xlsx_path(
  1848	        &tmp,
  1849	        &registry,
  1850	        XlsxImportOptions {
  1851	            recompute: RecomputeMode::Skip,
  1852	            ..Default::default()
  1853	        },
  1854	    )
  1855	    .expect("re-import of multi-peer-flattened xlsx must succeed");
  1856	
  1857	    // All 3 original format codes are present in the reimported table.
  1858	    let mut imported_codes: Vec<String> = result
  1859	        .workbook
  1860	        .formats()
  1861	        .iter()
  1862	        .filter(|(id, _)| id.is_custom())
  1863	        .map(|(_, s)| s.to_string())
  1864	        .collect();
  1865	    imported_codes.sort();
  1866	    let mut expected_codes = vec![
  1867	        "yyyy-mm-dd".to_string(),
  1868	        "0.0000%".to_string(),
  1869	        "#,##0.00 USD".to_string(),
  1870	    ];
  1871	    expected_codes.sort();
  1872	    assert_eq!(
  1873	        imported_codes, expected_codes,
  1874	        "all 3 original format codes must round-trip through xlsx export+import"
  1875	    );
  1876	
  1877	    // Every imported Custom must be LEGACY_PEER-tagged (xlsx collapses peers).
  1878	    for (id, _) in result.workbook.formats().iter() {
  1879	        if let FormatId::Custom(peer, _) = id {
  1880	            assert_eq!(
  1881	                peer,
  1882	                ql_types::LEGACY_PEER,
  1883	                "xlsx import always recovers as LEGACY_PEER (no peer concept in xlsx); got {peer:?}"
  1884	            );
  1885	        }
  1886	    }
  1887	
  1888	    let _ = std::fs::remove_file(&tmp);
  1894	    // workflow, the xlsx output bytes must be unchanged vs pre-step-6.
  1895	    // The translation maps Custom(LEGACY_PEER, c) → c + 164, identical
  1896	    // to the pre-step-6 to_legacy_u32() output. We verify by running
  1897	    // the export twice and checking that 0 multi-peer-flatten entries
  1898	    // appear in either report (so the flattening logic doesn't
  1899	    // accidentally treat LEGACY_PEER as non-LEGACY).
  1900	    use ql_storage::{FormatId, Workbook, FIRST_CUSTOM_FORMAT_ID};
  1901	    use ql_types::Value;
  1902	
  1903	    let mut wb = Workbook::new();
  1904	    let s = wb.add_sheet("S");
  1905	    let custom_id = wb.formats_mut().intern("0.0000");
  1906	    assert_eq!(custom_id, FormatId::legacy_from_u32(FIRST_CUSTOM_FORMAT_ID));
  1907	    wb.put_at(s, 0, 0, Value::Number(0.1234));
  1908	    wb.sheet_mut(s)
  1909	        .unwrap()
  1910	        .format_overlay_mut()
  1911	        .set(0, 0, custom_id);
  1912	
  1913	    let tmp_a = std::env::temp_dir().join("step6-legacy-only-a.xlsx");
  1914	    let tmp_b = std::env::temp_dir().join("step6-legacy-only-b.xlsx");
  1915	    let _ = std::fs::remove_file(&tmp_a);
  1916	    let _ = std::fs::remove_file(&tmp_b);
  1917	    let registry = ql_functions::default_registry();
  1918	
  1919	    let report_a = export_xlsx_path(&wb, &registry, &tmp_a, XlsxExportOptions::default()).unwrap();
  1920	    let report_b = export_xlsx_path(&wb, &registry, &tmp_b, XlsxExportOptions::default()).unwrap();
  1921	
  1922	    // Zero multi-peer-flatten entries for a LEGACY_PEER-only workbook.
  1923	    for report in [&report_a, &report_b] {
  1924	        let drops: Vec<_> = report
  1925	            .dropped_features
  1926	            .iter()
  1927	            .filter(|f| {
  1928	                matches!(
  1929	                    f.kind,
  1930	                    ql_io_xlsx::UnsupportedFeatureKind::Other("multi-peer-format-id-flatten")
  1931	                )
  1932	            })
  1933	            .collect();
  1934	        assert!(
  1935	            drops.is_empty(),
  1936	            "LEGACY_PEER-only workbook must not produce multi-peer-flatten entries; got {drops:#?}"
  1937	        );
  1938	    }

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/tests/opus_a_dup_fmt.rs | sed -n '1,90p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! Probe: two distinct numFmtId values map to the same format code.
     2	//! Does register_at handle this gracefully?
     3	
     4	use ql_io_xlsx::{import_xlsx_path, RecomputeMode, XlsxImportOptions};
     5	
     6	fn registry() -> ql_functions::FunctionRegistry {
     7	    ql_functions::default_registry()
     8	}
     9	
    10	#[test]
    11	#[ignore]
    12	fn two_custom_ids_with_same_format_code() {
    13	    use std::io::Write;
    14	    let mut buf: Vec<u8> = Vec::new();
    15	    {
    16	        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    17	        let opts =
    18	            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    19	        let styles = r##"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    20	<numFmts count="2">
    21	  <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    22	  <numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
    23	</numFmts>
    24	<cellXfs count="3">
    25	  <xf numFmtId="0"/>
    26	  <xf numFmtId="164" applyNumberFormat="1"/>
    27	  <xf numFmtId="165" applyNumberFormat="1"/>
    28	</cellXfs>
    29	</styleSheet>"##;
    30	        let parts: &[(&str, &str)] = &[
    31	            (
    32	                "[Content_Types].xml",
    33	                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
    34	            ),
    35	            (
    36	                "_rels/.rels",
    37	                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
    38	            ),
    39	            (
    40	                "xl/_rels/workbook.xml.rels",
    41	                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
    42	            ),
    43	            (
    44	                "xl/workbook.xml",
    45	                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
    46	            ),
    47	            (
    48	                "xl/worksheets/sheet1.xml",
    49	                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45001</v></c></row></sheetData></worksheet>"#,
    50	            ),
    51	            ("xl/styles.xml", styles),
    52	        ];
    53	        for (n, c) in parts {
    54	            zw.start_file(*n, opts).unwrap();
    55	            zw.write_all(c.as_bytes()).unwrap();
    56	        }
    57	        zw.finish().unwrap();
    58	    }
    59	    let src = std::env::temp_dir().join("opus-a-dup-fmt.xlsx");
    60	    std::fs::write(&src, &buf).unwrap();
    61	
    62	    let r = import_xlsx_path(
    63	        &src,
    64	        &registry(),
    65	        XlsxImportOptions {
    66	            recompute: RecomputeMode::Skip,
    67	            ..Default::default()
    68	        },
    69	    );
    70	    match r {
    71	        Ok(res) => {
    72	            println!("import OK");
    73	            for (id, c) in res.workbook.formats().iter() {
    74	                if id.is_custom() {
    75	                    println!("  id={:?} code={:?}", id, c);
    76	                }
    77	            }
    78	            let sheet = res.workbook.sheet(0).unwrap();
    79	            println!("  A1 overlay = {:?}", sheet.format_overlay().get(0, 0));
    80	            println!("  B1 overlay = {:?}", sheet.format_overlay().get(0, 1));
    81	        }
    82	        Err(e) => println!("import ERR: {e}"),
    83	    }
    84	    let _ = std::fs::remove_file(&src);
    85	}
    86	
    87	/// Probe: numFmtId="0" with custom-id (164) re-declaration of "General".
    88	#[test]
    89	#[ignore]
    90	fn libreoffice_general_at_custom_id_round_trip() {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs | sed -n '1038,1060p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1038	/// If styles.xml doesn't exist (very unlikely from umya), creates a
  1039	/// minimal one — but this path is exercised only as a defensive
  1040	/// fallback; the real generated styles.xml always contains the
  1041	/// scaffolding.
  1042	fn inject_custom_formats_into_styles_xml(
  1043	    content: Vec<u8>,
  1044	    custom_formats: &[(u32, String)],
  1045	) -> Result<Vec<u8>, XlsxError> {
  1046	    let text = String::from_utf8(content)
  1047	        .map_err(|e| XlsxError::Export(format!("styles.xml is not valid UTF-8: {e}")))?;
  1048	
  1049	    let mut numfmts = String::with_capacity(64 * custom_formats.len());
  1050	    numfmts.push_str(&format!(r#"<numFmts count="{}">"#, custom_formats.len()));
  1051	    for (id, code) in custom_formats {
  1052	        numfmts.push_str(&format!(
  1053	            r#"<numFmt numFmtId="{}" formatCode="{}"/>"#,
  1054	            id,
  1055	            xml_attr_escape(code),
  1056	        ));
  1057	    }
  1058	    numfmts.push_str("</numFmts>");
  1059	
  1060	    // Case 1: existing <numFmts> — replace it entirely. (Unlikely

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format.rs | sed -n '642,656p;784,800p;972,990p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   642	    fn intern_with_distinct_peers_does_not_collide() {
   643	        // Phase 5.1 audit-locked D-1: two peers allocating from
   644	        // counter=0 produce distinct FormatIds because peer differs.
   645	        let mut peer_a = FormatTable::with_peer(PeerId::new(0xa));
   646	        let mut peer_b = FormatTable::with_peer(PeerId::new(0xb));
   647	        let id_a = peer_a.intern("SAME_STRING");
   648	        let id_b = peer_b.intern("SAME_STRING");
   649	        // Same string, same counter, distinct peers — still distinct FormatIds.
   650	        assert_ne!(id_a, id_b);
   651	        assert_eq!(id_a, FormatId::Custom(PeerId::new(0xa), 0));
   652	        assert_eq!(id_b, FormatId::Custom(PeerId::new(0xb), 0));
   653	    }
   654	
   655	    #[test]
   656	    fn next_custom_counter_advances_on_intern() {
   784	        // see `cross_peer_same_string_now_succeeds_after_step4_restructure`
   785	        // and the LibreOffice "redundant General-at-custom-id" pattern
   786	        // in xlsx import.
   787	        //
   788	        // This test pins WITHIN-namespace collision: same-peer trying
   789	        // to register the same string at two different Custom counters
   790	        // is producer corruption.
   791	        let mut t = FormatTable::with_peer(PeerId::new(0xa));
   792	        t.register_at(FormatId::Custom(PeerId::new(0xa), 0), "MY_FMT")
   793	            .unwrap();
   794	        let err = t
   795	            .register_at(FormatId::Custom(PeerId::new(0xa), 1), "MY_FMT")
   796	            .unwrap_err();
   797	        assert!(matches!(err, FormatTableError::StringCollision { .. }));
   798	    }
   799	
   800	    #[test]
   972	        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
   973	            .unwrap();
   974	        // Replay peer B's op for the SAME string. Step 4 by_string
   975	        // restructure: both succeed; ids coexist in by_id.
   976	        t.register_at(FormatId::Custom(peer_b, 0), "yyyy-mm-dd")
   977	            .unwrap();
   978	        // Both ids resolve back to the same string.
   979	        assert_eq!(t.lookup(FormatId::Custom(peer_a, 0)), Some("yyyy-mm-dd"));
   980	        assert_eq!(t.lookup(FormatId::Custom(peer_b, 0)), Some("yyyy-mm-dd"));
   981	        // Same-peer same-string is still idempotent.
   982	        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
   983	            .unwrap();
   984	        // Same-peer DIFFERENT-counter same-string is StringCollision
   985	        // (would produce two distinct Custom(A, _) ids for one string
   986	        // — that IS a producer bug).
   987	        let err = t
   988	            .register_at(FormatId::Custom(peer_a, 1), "yyyy-mm-dd")
   989	            .unwrap_err();
   990	        assert!(matches!(err, FormatTableError::StringCollision { .. }));

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-storage/src/format.rs | sed -n '958,980p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   958	    /// collision-free `Custom(A, 0)` + `Custom(B, 0)` `FormatId`s per
   959	    /// Phase 5.1 D-1 audit-locked design. Step 4 restructured
   960	    /// `by_string` into separate `by_builtin_string` + `by_custom_string`
   961	    /// maps, the latter keyed by `(PeerId, String)`. This test now
   962	    /// ASSERTS the cross-peer same-string registration SUCCEEDS (was
   963	    /// pinned-as-rejection in cycle 4 step-3 audit; inverted in cycle
   964	    /// 5 step 4 ship).
   965	    #[test]
   966	    fn cross_peer_same_string_now_succeeds_after_step4_restructure() {
   967	        let mut t = FormatTable::with_peer(LEGACY_PEER);
   968	        let peer_a = PeerId::new(0xa);
   969	        let peer_b = PeerId::new(0xb);
   970	
   971	        // Replay peer A's op.
   972	        t.register_at(FormatId::Custom(peer_a, 0), "yyyy-mm-dd")
   973	            .unwrap();
   974	        // Replay peer B's op for the SAME string. Step 4 by_string
   975	        // restructure: both succeed; ids coexist in by_id.
   976	        t.register_at(FormatId::Custom(peer_b, 0), "yyyy-mm-dd")
   977	            .unwrap();
   978	        // Both ids resolve back to the same string.
   979	        assert_eq!(t.lookup(FormatId::Custom(peer_a, 0)), Some("yyyy-mm-dd"));
   980	        assert_eq!(t.lookup(FormatId::Custom(peer_b, 0)), Some("yyyy-mm-dd"));

The translate() coverage invariant holds for Custom ids. The remaining work is consolidating the actual findings: duplicate-format round-trip loss, sparse legacy byte regression, and Strict-policy handling.
  ✓ Inspect commit diff, local instructions, and relevant xlsx export code
  ✓ Trace translation completeness and panic reachability
  ✓ Check byte stability, sort allocation, and reporting alignment
  ✓ Review tests and unsupported-feature tag collisions
  → Synthesize HIGH/MEDIUM/LOW audit findings with evidence
codex
**HIGH Findings**

1. **Cross-peer same-string formats can lose formatting on reimport.**  
Valid multi-peer state allows two peers to register the same format code under distinct `FormatId`s: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:966). Step 6 exports those as distinct xlsx `numFmtId`s because translation is keyed by `FormatId`, not by format code: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:470). On import, the first duplicate code registers, the second hits same-peer `StringCollision` and is skipped: [styles_import.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:80). But cell overlays still map `numFmtId=165` to `Custom(LEGACY_PEER, 1)`: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs:279). That id has no registered format code, so display/export later falls back or emits an undeclared style.  
I confirmed the existing ignored probe: only `Custom(PeerId(0), 0)` registered, while B1 overlay became `Custom(PeerId(0), 1)`.

2. **Sparse `LEGACY_PEER` custom counters are reindexed, breaking the claimed byte/id stability.**  
Pre-step-6 `Custom(LEGACY_PEER, c)` exported as `c + 164`: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:134). Current translation starts at 164 and assigns contiguous ids in present-set order: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:149). So a valid replay/qbook-derived table containing only counters 5 and 7 now emits 164 and 165, not 169 and 171. The doc/test claim is only true for dense counters starting at 0: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:98).

3. **Strict export policy is now inconsistent for the new flatten reports.**  
NewWorkbook calls `export_new_workbook` first, writing `out_path`, then errors if `dropped_features` is non-empty: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs:382). A Strict multi-peer export can therefore overwrite/create the destination and still return `Err`. UpdateOriginal has the opposite bug: it calls `export_new_workbook` into a shadow file, keeps its `report.dropped_features`, but Strict only checks the separate original-package `dropped` vector: [update_original.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:52), [update_original.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:226). So Strict UpdateOriginal can succeed while returning multi-peer flatten losses.

**MEDIUM Findings**

- No Custom translation-miss path found. All three `translate(Custom)` consumers are subsets of `workbook.formats()` or `cellxfs_roster`: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:135), [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:516). The caveat is `Builtin(n > 163)`: normal runtime/replay blocks it, but low-level overlay mutation can still make export emit an invalid `numFmtId` directly: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:184).

- `<numFmts>` byte order is still not deterministic. Translated ids are deterministic, but `custom_formats` walks `FormatTable::iter()`, documented as arbitrary HashMap order, then emits in that order: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:539), [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1051).

- Test gaps: active step-6 coverage uses unique codes and counter 0 only: [calamine_smoke.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1787), [calamine_smoke.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1905). It misses cross-peer duplicate codes, sparse legacy counters, Strict policy behavior, and an active xlsx -> qbook -> xlsx gate.

**LOW / Notes**

- `info_lost` alignment is correct: the same `flattened_id` is reported and used for `<numFmt>`/`<cellXfs>` translation.
- `Other("multi-peer-format-id-flatten")` is unique; no collision found.
- The allocator overflow `expect` would need roughly 4.3B custom formats, so I do not consider it reachable in practice.

Verification run: `cargo test -p ql-io-xlsx --test opus_a_dup_fmt two_custom_ids_with_same_format_code -- --ignored --nocapture`.
tokens used
279,067
**HIGH Findings**

1. **Cross-peer same-string formats can lose formatting on reimport.**  
Valid multi-peer state allows two peers to register the same format code under distinct `FormatId`s: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:966). Step 6 exports those as distinct xlsx `numFmtId`s because translation is keyed by `FormatId`, not by format code: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:470). On import, the first duplicate code registers, the second hits same-peer `StringCollision` and is skipped: [styles_import.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/read/styles_import.rs:80). But cell overlays still map `numFmtId=165` to `Custom(LEGACY_PEER, 1)`: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs:279). That id has no registered format code, so display/export later falls back or emits an undeclared style.  
I confirmed the existing ignored probe: only `Custom(PeerId(0), 0)` registered, while B1 overlay became `Custom(PeerId(0), 1)`.

2. **Sparse `LEGACY_PEER` custom counters are reindexed, breaking the claimed byte/id stability.**  
Pre-step-6 `Custom(LEGACY_PEER, c)` exported as `c + 164`: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:134). Current translation starts at 164 and assigns contiguous ids in present-set order: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:149). So a valid replay/qbook-derived table containing only counters 5 and 7 now emits 164 and 165, not 169 and 171. The doc/test claim is only true for dense counters starting at 0: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:98).

3. **Strict export policy is now inconsistent for the new flatten reports.**  
NewWorkbook calls `export_new_workbook` first, writing `out_path`, then errors if `dropped_features` is non-empty: [lib.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/lib.rs:382). A Strict multi-peer export can therefore overwrite/create the destination and still return `Err`. UpdateOriginal has the opposite bug: it calls `export_new_workbook` into a shadow file, keeps its `report.dropped_features`, but Strict only checks the separate original-package `dropped` vector: [update_original.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:52), [update_original.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/update_original.rs:226). So Strict UpdateOriginal can succeed while returning multi-peer flatten losses.

**MEDIUM Findings**

- No Custom translation-miss path found. All three `translate(Custom)` consumers are subsets of `workbook.formats()` or `cellxfs_roster`: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:135), [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:516). The caveat is `Builtin(n > 163)`: normal runtime/replay blocks it, but low-level overlay mutation can still make export emit an invalid `numFmtId` directly: [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:184).

- `<numFmts>` byte order is still not deterministic. Translated ids are deterministic, but `custom_formats` walks `FormatTable::iter()`, documented as arbitrary HashMap order, then emits in that order: [format.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-storage/src/format.rs:539), [umya_export.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/src/write/umya_export.rs:1051).

- Test gaps: active step-6 coverage uses unique codes and counter 0 only: [calamine_smoke.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1787), [calamine_smoke.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-io-xlsx/tests/calamine_smoke.rs:1905). It misses cross-peer duplicate codes, sparse legacy counters, Strict policy behavior, and an active xlsx -> qbook -> xlsx gate.

**LOW / Notes**

- `info_lost` alignment is correct: the same `flattened_id` is reported and used for `<numFmt>`/`<cellXfs>` translation.
- `Other("multi-peer-format-id-flatten")` is unique; no collision found.
- The allocator overflow `expect` would need roughly 4.3B custom formats, so I do not consider it reachable in practice.

Verification run: `cargo test -p ql-io-xlsx --test opus_a_dup_fmt two_custom_ids_with_same_format_code -- --ignored --nocapture`.
