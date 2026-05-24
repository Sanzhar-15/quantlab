# Phase 5.7 V3.6 Documentation Audit - Codex Lane A

Verdict: FAIL

## Summary

The documentation is not optimal or complete. The current repo heads and the latest test counts are partly present in the newest plan and memory index text, but the docs still contain active onboarding traps:

- The IDE consumer contract references a V3.6 surface section that does not exist.
- The next-session handoff file is materially stale and points at already-completed work.
- The active plan frontmatter is not a reliable current-state record because it uses "this commit" placeholders, preserves an obsolete `ql-collab-ws` count convention, and still lists the D4 audit as pending.
- Source-facing Rust and TypeScript docstrings still describe pre-D4 behavior for locale and format parsing even though the implementation changed.

Validated current heads:

- Engine HEAD: `e7931a74d0db0319aa40e8e6d5d68ac18806cbc3`
- IDE HEAD: `b76b8266bebf7e0b3efc5d711d3cdc4d1fa1439d`

Validated tests where possible:

- `ql-collab`: `136 passed; 0 failed` via `cargo test -p ql-collab --release --features test-fixtures --lib`
- `ql-oplog`: lib suite `67 passed; 0 failed` via `cargo test -p ql-oplog --release`; the full package also reports additional integration tests beyond the 67-lib-suite ground truth.
- `ql-collab-ws`: `cargo test -p ql-collab-ws --release -- --list` shows `10` lib tests, `2` relay tests, `30` transport tests, and `2` doctests. The current documented ground-truth convention is therefore `40` for lib + transport. Runtime execution was blocked by sandbox socket permission failures in relay tests.
- IDE mocha quantbook suite: execution reached the expected 354 tests, but this sandbox produced socket `EPERM` failures in relay-backed cases (`348 passing`, `6 failing`). Treat the user-provided `354 passing` ground truth as the main-environment value.

## HIGH findings

1. Missing V3.6 IDE consumer surface section

Scope: `docs/architecture/ide-consumer-contract.md`, cross-referenced from `.plans/_active.md`.

Evidence:

- `.plans/_active.md:28` says the active plan is a "Sister-section to `docs/architecture/ide-consumer-contract.md § 4.1.z6`".
- Searching `docs/architecture/ide-consumer-contract.md` finds no `§ 4.1.z6` and no `#### V3.6` section.
- Current V3.6 content is instead appended inside the V3.5 area, for example `docs/architecture/ide-consumer-contract.md:1468`, `1485`, and `1531-1554`.

Why this matters: the user explicitly called out `§ 4.1.z6` as expected. V3.5 has `§ 4.1.z5`, but V3.6 has no corresponding consumer-surface spec even after V3.6.0.5 D4 shipped. This is the largest structural documentation gap.

Suggested closure: add a dedicated `§ 4.1.z6` section covering V3.6 D1-D4 shipped surfaces, D5-D9 pending/conditional surfaces, R-V3.6-1..13, and the shipped audit transcript table. Leave `§ 4.1.z5` as historical V3.5 material.

2. Next-session handoff is dangerously stale

Scope: `/home/sanzhar/.claude/.../memory/current_work.md` as mirrored at `/Users/sanzhar/OrbStack/ubuntu/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md`.

Evidence:

- `current_work.md:3` frontmatter still describes V3.6.0.5 D4 at engine `5b3017c70d2`, IDE `d7cb01557d4`, `ql-collab` `134/134`, and six cycles.
- `current_work.md:8-11` still titles the handoff as a V3.4.0.1 decision-lock handoff and points to V3.4.0.2.
- `current_work.md:21-23` state table repeats stale heads and stale `ql-collab` `134/134`.
- `current_work.md:133-168` "First three commands" expects the old D4 heads and old test count.
- `current_work.md:176-196` recommends the V3.6.0.X audit-of-D4 closure even though that work shipped at engine `e7931a74d0d` and IDE `b76b8266beb`.
- `current_work.md:999-1015` audit transcript inventory only reaches V3.3 and says 27 total, which is not the current V3.6 audit surface.

Contrast:

- `MEMORY.md:2` has the correct current summary: engine `e7931a74d0d`, IDE `b76b8266beb`, `ql-collab` `136/136`, IDE mocha `354/354`, `ql-collab-ws` `40/40`, eight cycles, and next D5.

Why this matters: this file is a handoff document. It is stale in the exact sections a next agent would run first.

Suggested closure: rewrite `current_work.md` around the current post-audit-of-D4 state, delete or archive old first-command blocks, and make D5 the single recommended next sub-step.

3. Active plan frontmatter is not a reliable current-state source

Scope: `.plans/_active.md`.

Evidence:

- `.plans/_active.md:9` sets `current_engine_head` to a "this commit" placeholder with an older predecessor hash, not the actual current `e7931a74d0d`.
- `.plans/_active.md:10` does the same for `current_ide_head`, rather than naming `b76b8266beb`.
- `.plans/_active.md:13` says `ql-collab-ws` is `42 / 42 (10 lib + 30 ws + 2 V3.1.a relay)`. Current requested ground truth is `40` for `10 lib + 30 transport`; `--list` confirms the separate `2` relay tests and `2` doctests.
- `.plans/_active.md:337-339` still lists the V3.6.0.X audit of D4 as pending, while `.plans/_active.md:335` says the D4 audit shipped.
- `.plans/_active.md:14` says the current engine workspace result is an "all 30 test suites pass (V3.5 baseline)" value, which is stale wording for a V3.6 current-state field.

Why this matters: this is the highest-priority active plan body. Its frontmatter should be copy-safe and machine-checkable. Placeholder "this commit" language becomes false as soon as another commit lands.

Suggested closure: replace placeholders with exact hashes, set `current_ql_collab_ws_tests` to the current convention or explicitly document the `40 + 2 relay + 2 doctest` split, remove D4 from pending audits, and update the workspace baseline wording with a current verification date.

## MEDIUM findings

1. MASTER-PLAN V3.6 status is append-only and internally stale

Scope: `docs/MASTER-PLAN.md`.

Evidence:

- `docs/MASTER-PLAN.md:547` contains the entire V3.6 history in one very long status line.
- The same line still includes earlier claims such as D4 using `date_system: DateSystemJson` and only `9` documented V3.6 risks, even though `.plans/_active.md:302-314` documents `R-V3.6-1..13` and the current D4 shape is `dateSystem: String`.
- `docs/MASTER-PLAN.md:5` and `docs/MASTER-PLAN.md:21` still present a 2026-05-13 W5-60 handoff as the global current engine reference, which reads as current unless the reader already knows the history.

Suggested closure: split the V3.6 line into a short current status plus dated sub-bullets. Update the risk count to 13, update the date-system field name and wire shape, and replace "THIS commit" language with exact hashes.

2. IDE consumer contract contradicts itself on shipped vs deferred risks

Scope: `docs/architecture/ide-consumer-contract.md`.

Evidence:

- `docs/architecture/ide-consumer-contract.md:1542` marks R-V3.5-4 closed at D4 plus the D4 audit closures.
- `docs/architecture/ide-consumer-contract.md:1543` then says format-aware `buildHtml` rendering is still deferred to V3.6.0.5 D4, which has shipped.
- `docs/architecture/ide-consumer-contract.md:1533` labels Loro UndoManager callback wiring as a V3.6+ deferral, while `docs/architecture/ide-consumer-contract.md:1554` says the undo/redo semantic mismatch shipped at V3.6.0.2 D1.
- `docs/architecture/ide-consumer-contract.md:1550` still lists format-aware `buildHtml` rendering in backlog/deferred surface language.

Suggested closure: mark D4 format-aware rendering as shipped, move any remaining write-path or UI-formatting gaps to D5+ or V3.7 explicitly, and add a supersession note for the historical UndoManager deferral.

3. Rust and TypeScript surface docstrings still describe pre-D4 behavior

Scope:

- `crates/ql-bindings-node/src/lib.rs`
- `extensions/quantlab/src/quantbook/types.ts`

Evidence:

- `crates/ql-bindings-node/src/lib.rs:559-565` says `CellSnapshotJson.rendered` uses `eval_context.locale = EnUs` and that locale-aware rendering is deferred. The implementation uses `workbook.locale()` at `crates/ql-bindings-node/src/lib.rs:1659-1663`.
- `crates/ql-bindings-node/src/lib.rs:587-589` says `format::parse` runs once per cell per snapshot with no cache. The implementation builds and uses a per-snapshot parsed-format cache at `crates/ql-bindings-node/src/lib.rs:1665-1680` and `1800-1810`.
- `crates/ql-bindings-node/src/lib.rs:562-564` documents the JS snapshot field as `date_system`, while the exposed TypeScript field is camelCase `dateSystem` at `extensions/quantlab/src/quantbook/types.ts:255`.
- `extensions/quantlab/src/quantbook/types.ts:123-127` repeats the stale `EnUs` locale statement.
- `extensions/quantlab/src/quantbook/types.ts:143-145` repeats the stale no-cache statement.
- `extensions/quantlab/src/quantbook/types.ts:232-237` tells consumers to build a `Map` from `formats` for D4 rendering, but D4 shipped engine-provided `rendered` output for the IDE consumer path.

Suggested closure: update both Rust and TS docs to say rendering uses workbook locale, format parsing is cached per snapshot, JS uses `dateSystem`, and IDE consumers should prefer `rendered` while treating `formats` as registry/debug/future direct-rendering data.

4. CollabSession field docs mostly exist but include stale Rule 4 walks

Scope: `crates/ql-collab/src/session.rs`.

Evidence:

- All eight requested fields are documented with Rule 4 walks: `last_snapshot` at `session.rs:658-675`, `removed_sheets` at `678-713`, `pending_undo_cells` at `715-757`, `inside_group` at `759-781`, `undo_merge_interval_ms` at `783-802`, `format_table_cache` at `804-854`, `cell_op_index` at `856-898`, and `sheet_op_index` at `900-927`.
- `session.rs:658-675` says `CellState` is a composition of two `Option<T>` fields. `CellState` now has three fields, including `format`, at `session.rs:94-107`.
- `session.rs:882-889` says the undo/redo partial-invalidate path is read-only on the op index. The implementation-level docs for `rebuild_op_indices_only` at `session.rs:1862-1892` explain that undo/redo must rebuild indices after Loro retract compaction.

Suggested closure: update `last_snapshot` to mention all three `CellState` fields and update the op-index invariant to include post-undo/redo index rebuilds before partial invalidation.

5. ql-oplog variant overview is stale and DateSystemWire lacks the promised explicit safety walk

Scope: `crates/ql-oplog/src/op.rs`.

Evidence:

- `crates/ql-oplog/src/op.rs:10-19` lists only older variants through `BatchCommit`. It omits later variants such as `RenameSheet`, `RemoveSheet`, `MoveSheet`, `SetReferenceMode`, `SetLocale`, and `SetDateSystem`.
- `Op::SetDateSystem` itself is documented at `crates/ql-oplog/src/op.rs:415-439`, so the new variant is not undocumented.
- `DateSystemWire` is documented at `crates/ql-oplog/src/op.rs:562-571`, but the text does not include the explicit Rule 4 Send+Sync walk that the plan/audit trail claims was part of the closure standard.

Suggested closure: update the module-level variant table and add a short explicit Rule 4 statement to `DateSystemWire` or the `SetDateSystem` variant block.

6. V3.6 risk register exists in the plan but has no corresponding contract home

Scope: `.plans/_active.md` and `docs/architecture/ide-consumer-contract.md`.

Evidence:

- `.plans/_active.md:302-314` documents exactly 13 risks, `R-V3.6-1` through `R-V3.6-13`.
- `docs/architecture/ide-consumer-contract.md` has no V3.6 risk-register section because `§ 4.1.z6` is absent.
- `docs/architecture/ide-consumer-contract.md:1532` mentions `R-V3.6-10`; `docs/architecture/ide-consumer-contract.md:1542` indirectly mentions `R-V3.6-11/12/13` in an audit-of-D4 closure sentence, but there is no consumer-facing status table.

Suggested closure: put the V3.6 risks in the new `§ 4.1.z6` section, or explicitly state that the plan is the only risk-register authority and link to the exact plan anchors.

## LOW findings

1. Audit transcript naming is inconsistent across V3.6.0.2 through V3.6.0.5

Scope: `docs/audits/`.

Evidence:

- Present files include `2026-05-24-phase-5-7-v3-6-0-2-codex.md`, `2026-05-23-phase-5-7-v3-6-0-3-{codex,opus}.md`, `2026-05-23-phase-5-7-v3-6-0-4-{codex,opus}.md`, and `2026-05-24-phase-5-7-v3-6-0-5-{codex,opus}.md`.
- The 0.3 and 0.4 transcript headers match 2026-05-23; the 0.5 headers match 2026-05-24. The 0.2 Codex file has a 2026-05-24 filename but no explicit audit-date line in the first header block.

Suggested closure: document the naming convention. Prefer filename date = audit execution date; if work spans midnight, put the work window in the header.

2. V3.6.0.2 has no standalone Opus transcript

Scope: `docs/audits/`.

Evidence:

- The requested V3.6 transcript set is present except for a `2026-05-24-phase-5-7-v3-6-0-2-opus.md` file.
- `.plans/_active.md:332` says the Opus Lane B review was inline in the commit/plan body.

Suggested closure: either extract the inline Opus review into a small standalone transcript for symmetry, or add a stub transcript that points to the exact commit/plan lines containing the inline review.

3. Memory index is current at the top but too dense and preserves stale historical counts

Scope: `/Users/sanzhar/OrbStack/ubuntu/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/MEMORY.md`.

Evidence:

- `MEMORY.md:2` starts with the correct current post-audit state.
- The same line then embeds long historical chains containing older `ql-collab 134/134`, older `ql-collab-ws 42/42`, and older D4/D5/D6 descriptors.

Suggested closure: keep `MEMORY.md:2` as a short current pointer and move detailed historical chains into archival notes.

4. Historical ql-collab-ws 42/42 values are not clearly marked as old-count-convention values

Scope: `.plans/_active.md`, `docs/architecture/ide-consumer-contract.md`, memory docs.

Evidence:

- `.plans/_active.md:13` uses `42 / 42` as current.
- `docs/architecture/ide-consumer-contract.md:1749` and `1794` preserve `42 / 42` historical V3.5 cumulative values.
- The current requested convention is `40` for `10 lib + 30 transport`; `--list` confirms the extra `2` relay tests are a separate bucket.

Suggested closure: update current-state fields to `40/40` and label historical `42/42` values as "old convention including relay tests" if they must remain.

5. One TypeScript JSDoc link is likely weak under TypeDoc

Scope: `extensions/quantlab/src/quantbook/types.ts`.

Evidence:

- Most `{@link ...}` targets resolve to exported interfaces or methods.
- `types.ts:822` references `{@link QuantbookCellSnapshot.entries[].value}`. TypeDoc often does not resolve bracketed array-property paths reliably.

Suggested closure: link to `QuantbookCellSnapshot` or introduce a named cell-entry interface and link to that property.

6. Active plan body is becoming an audit ledger

Scope: `.plans/_active.md`.

Evidence:

- `.plans/_active.md:3` is already a very large historical synopsis.
- `.plans/_active.md:331-335` now carries shipped audit transcript pointers for V3.6.0.2 through V3.6.0.5 and will continue growing through D5-D9 and the phase-termination audit.

Suggested closure: keep `.plans/_active.md` as current execution state and move shipped audit details to a dedicated V3.6 audit ledger document.

## INFO findings

1. Commit hash references checked cleanly

Scope: Tier 1 docs, V3.6 audit transcripts, and memory docs.

Result:

- All commit-looking hashes checked against the relevant engine or IDE repo resolved.
- False positives such as `0000000000000000`, `4294967295`, and cargo-registry path fragments were not treated as commit references.

2. R-V3.5 statuses are mostly current but need supersession cleanup

Scope: `docs/architecture/ide-consumer-contract.md:1537-1545`.

Result:

- The list covers `R-V3.5-1` through `R-V3.5-7`.
- The current statuses are mostly plausible: R1 documented, R2 closed, R3 accepted, R4 closed, R5 closed, R6 closed, R7 documented.
- The problem is stale trailing language under R5 and nearby backlog text, not total absence of status coverage.

3. D-decision status is broadly correct in the plan

Scope: `.plans/_active.md`.

Result:

- D1, D2, D3, and D4 are marked shipped.
- D5-D9 remain pending or conditional.
- The shipped sub-step mapping is consistent in the plan: D1 = V3.6.0.2, D2 = V3.6.0.3, D3 = V3.6.0.4, D4 = V3.6.0.5.

4. V3.6 audit transcripts requested by the prompt are present, except the known V3.6.0.2 Opus asymmetry

Scope: `docs/audits/`.

Result:

- Codex and Opus transcripts exist for V3.6.0.3, V3.6.0.4, and V3.6.0.5.
- A Codex transcript exists for V3.6.0.2.
- The missing V3.6.0.2 Opus file is documented as inline rather than standalone.

5. Markdown and prose references need a second pass after `§ 4.1.z6` exists

Scope: Tier 1 docs.

Result:

- The most important broken prose reference is the plan's reference to nonexistent `§ 4.1.z6`.
- A full markdown anchor validation should be rerun after the V3.6 section is created, because many current references are prose section names rather than stable markdown anchors.

## Coverage gaps identified

- I could not execute `ql-collab-ws` fully in this sandbox because relay socket binds failed with `PermissionDenied`/`EPERM`. I verified the test inventory with `--list` instead.
- I could not verify IDE mocha as `354 passing` in this sandbox because the relay-backed tests hit `listen EPERM: operation not permitted 127.0.0.1`. The suite did enumerate the expected 354 tests before reporting `348 passing`, `6 failing`.
- I did not run the full engine workspace "all 30 test suites" claim. The audited docs should not keep that claim as current unless it is revalidated.
- I did not compile TypeDoc output, so the `{@link QuantbookCellSnapshot.entries[].value}` issue is a likely documentation-link weakness rather than a confirmed generated-link failure.
- The user-provided `/home/sanzhar/.claude/...` memory path does not exist directly on this macOS host; the matching files were audited through the OrbStack mirror under `/Users/sanzhar/OrbStack/ubuntu/home/sanzhar/.claude/...`.

## Plan body / docs drift identified

- Current heads are known but not cleanly represented in `.plans/_active.md` frontmatter.
- `ql-collab-ws` current test count convention drifted from `42/42` to `40/40`, but some current docs still use the old convention.
- V3.6.0.X audit-of-D4 is simultaneously shipped and pending in the active plan.
- V3.6 risk count is 13 in the active plan but older MASTER-PLAN text still preserves a 9-risk statement.
- D4 date-system and rendering details changed, but Rust and TypeScript docstrings still preserve pre-closure statements about `date_system`, `EnUs`, and no parsed-format cache.
- V3.5 historical deferral language was not superseded after V3.6.0.2 and V3.6.0.5 shipped.
- The missing `§ 4.1.z6` section is the core structural blocker: without it, V3.6 status is scattered across the active plan, MASTER-PLAN, V3.5 contract paragraphs, and audit transcripts.
