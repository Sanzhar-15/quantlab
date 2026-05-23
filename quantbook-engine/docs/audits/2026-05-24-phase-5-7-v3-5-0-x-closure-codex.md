# V3.5.0.X Closure Follow-Up Audit - Codex Lane A

Date: 2026-05-24

Scope: post-closure audit of the V3.5.0.X megaudit closure commits.  This lane focuses on protocol correctness and closure completeness.  I audited the shipped closure commits (`853f4006a75`, `4b22f7e6649`, `3dd571a9bcf`) and cross-checked the current worktree.  At audit start, the worktree already contained follow-up edits from the parallel lane:

- Engine: `quantbook-engine/crates/ql-collab/src/session.rs` and `quantbook-engine/docs/architecture/ide-consumer-contract.md`.
- IDE: `extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts`.

During this audit, those follow-up edits were committed as engine `2691248c3aa` and IDE `3dbb4cfe05d`.  The findings below still distinguish the original V3.5.0.X closure commits from the later follow-up closure commits.

Overall verdict: **PASS-WITH-FINDINGS**.

The main closure intent is correct on the ordinary V3.5 producer paths: replay drops `SetCellFormat` on tombstoned sheets, the live cache walker now tracks tombstones for cell-keyed ops, repaired formulas are preferred in `workbook_snapshot`, sheet commands repaint panels, deferred remote renders are scheduled after typing clears, and undo/redo avoids partial invalidation after remote interleaving.  However, the closure is not fully clean: several protocol and error-surface issues remain.

Findings:

- **CLOSURE-CODEX-MED-1:** The widened cache tombstone walker treats every `Op::RemoveSheet { id }` as a tombstone, but `Workbook::remove_sheet` silently ignores out-of-range ids.  A log such as `RemoveSheet(0), AddSheet(...), PutValue(sheet=0, ...)` is a replay no-op delete followed by a valid write, while the cache walker drops the write forever.  The new tombstone regression tests use `RemoveSheet { id: 0 }` on a fresh session without first adding sheet 0, so they pin this out-of-range cache behavior rather than a valid deleted-sheet sequence.  Valid UI/napi producers likely avoid this, but the cache walker no longer mirrors replay for malformed or manually-appended logs.
- **CLOSURE-CODEX-MED-2:** The four sheet commands call `CellGridPanel.refreshAll()` inside the same `try` block as the engine mutation.  If any `render()` throws, the user sees "Quantbook <op> failed" even though the engine op already succeeded.  This is a misleading error surface and can leave panels partially refreshed.
- **CLOSURE-CODEX-MED-3:** `CellGridPanel.refreshAll()` renders both local and collab panels unconditionally.  The A-HIGH-4 guard only protects `tickPollRemote` merged renders; a sheet command on a local panel can still render an unrelated collab panel mid-edit and destroy the active input.  The target local panel does not have transport presence, but `refreshAll()` reaches collab panels that can have `_presenceRepaintInFlight = true`.
- **CLOSURE-CODEX-MED-4:** `workbook_snapshot` still uses `formula: repaired_formula.or(state.formula)`.  The intended closure source is the rebuilt workbook.  Falling back to the unrepaired cache can mask a future cache-vs-workbook divergence and can emit a formula that the materialized workbook no longer contains.  Prefer `repaired_formula` only, or at least add a visible debug/test assertion for divergence.
- **CLOSURE-CODEX-LOW-1:** In the original shipped IDE closure, the new `render()` calls in `setPresenceTyping(false)` and in the watchdog clear the dirty flag before calling `render()` and are not wrapped in `try/catch`.  If `render()` throws, the deferred render is lost and the timer/callback path can surface as an unhandled exception.  Follow-up IDE commit `3dbb4cfe05d` wraps these two calls; `3dd571a9bcf` does not.
- **CLOSURE-CODEX-LOW-2:** In the original shipped engine closure, `force_clear_snapshot_cache()` clears `last_snapshot` but not `removed_sheets`.  This is test-only and benign for the canonical `force_clear -> rebuild_snapshot_cache` pattern, but it violates the seam's "clean cache state" meaning.  Follow-up engine commit `2691248c3aa` clears `removed_sheets`; `853f4006a75` does not.
- **CLOSURE-CODEX-LOW-3:** Regression coverage is incomplete: no `PutFormula` / `ClearFormula` tombstone tests, no valid `AddSheet -> RemoveSheet -> cell op` tombstone test, no symmetric redo-after-remote-interleave test, and no panel-level mocha/vscode-test coverage for A-HIGH-3/A-HIGH-4.
- **CLOSURE-CODEX-LOW-4:** Documentation and hygiene drift remain: the command-layer comment still says sheet ops intentionally do not re-render panels; the `removed_sheets` field doc says `invalidate_cell` consults the session set although the implementation correctly uses a local tombstone set; the archived plan frontmatter still has stale pre-closure `current_*` fields; and the shipped engine closure introduced section-sign unicode in source comments despite the stated hygiene rule.

## 1. Opus-H1 Closure Verification

### 1.1 replay.rs SetCellFormat guard

Verified.  `crates/ql-oplog/src/replay.rs:728-757` places the new guard after `validate_cell(workbook, *sheet, *row, *col, index)?` and before format-id registration validation and overlay set/clear.  This matches the V3.5.0.3b cell-keyed pattern for `PutValue` at `:415`, `PutFormula` at `:432`, and `ClearFormula` at `:443`.

The guard has no ordinary false positive: it fires only when the target sheet id is already in `Workbook.removed_sheets`.  The only semantic nuance is that `SetCellFormat(Some(unregistered))` on a tombstoned sheet now returns `Ok(())` before format-id validation.  That is consistent with the "cell-keyed writes to tombstoned sheets are silently dropped" policy, but if strict validation on tombstoned writes was desired, the docs/tests should say so explicitly.

### 1.2 cache walker scope widening

Mostly verified for valid in-range deletes:

- `CacheEffect::RemoveSheet { id: u16 }` exists.
- `collect_cache_effects` emits it for `Op::RemoveSheet`.
- `BatchCommit` recursion calls `collect_cache_effects` on each inner op, so nested `RemoveSheet` is covered.
- `apply_cache_effect` extracts `target_sheet` before the main body and returns early for all four cell-keyed variants when the sheet is tombstoned.
- `CacheEffect::RemoveSheet` inserts the id into the tombstone tracker and calls `snapshot.retain(|(sheet, _, _), _| *sheet != id)`.  `HashMap::retain` over tuple keys containing `u16` is straightforward; there is no key-aliasing issue.

Finding CLOSURE-CODEX-MED-1 applies here: `apply_cache_effect` tombstones out-of-range `RemoveSheet` ids unconditionally, but replay ignores out-of-range deletes in `Workbook::remove_sheet`.  Because the cache walker does not track `AddSheet` / sheet existence, it cannot distinguish "valid empty sheet got deleted" from "delete referenced a sheet id that does not exist yet".  That is a cache-vs-replay parity gap.

### 1.3 CollabSession.removed_sheets field maintenance

Verified on normal paths:

- `new()` initializes `removed_sheets` to `HashSet::new()`.
- `from_snapshot()` initializes it empty and then calls `rebuild_snapshot_cache()`.
- `rebuild_snapshot_cache()` builds `fresh` and `fresh_tombstones`, applies effects into the fresh structures, then assigns `self.last_snapshot = fresh` and `self.removed_sheets = fresh_tombstones`.  Because the method has `&mut self`, no external observer can see the intermediate assignment order.
- `append_op()` passes `&mut self.removed_sheets` to `apply_cache_effect` for every collected effect, so multiple effects in a batch mutate the same tombstone set in order.
- `invalidate_cell()` correctly uses a local `local_tombstones` set and does not mutate the session-level tombstone state.
- `discard_pending_ops()` calls `rebuild_snapshot_cache()` and inherits the fix.

Finding CLOSURE-CODEX-LOW-2 applies to the original shipped closure: `force_clear_snapshot_cache()` is part of the test-fixture cache seam and should clear both cache-walker structures.  Follow-up engine commit `2691248c3aa` now does this; the original closure commit does not.

### 1.4 regression tests

The three new tombstone tests are present and listed by cargo:

- `put_value_on_tombstoned_sheet_is_silently_dropped`
- `set_cell_format_on_tombstoned_sheet_is_silently_dropped`
- `set_cell_format_clear_on_tombstoned_sheet_is_silently_dropped`

They are useful but not sufficient.  They do not cover `PutFormula` or `ClearFormula`, and they do not first create the sheet they delete.  That means they do not prove parity for the valid `AddSheet -> RemoveSheet -> cell-keyed op` sequence.  A stronger set should add:

- `AddSheet -> RemoveSheet -> PutValue/PutFormula/ClearFormula/SetCellFormat`
- `BatchCommit([RemoveSheet, PutFormula])`
- cross-peer merge of valid tombstone-before-cell-op ordering
- cache-vs-rebuild equality after tombstone filtering

`ql-collab` still passes on the follow-up engine code: `111 passed; 0 failed`.

## 2. A-HIGH-2 Closure Verification

### 2.1 formula source change

Verified.  `workbook.formula_at(sheet, row, col)` is the correct accessor on the rebuilt `Workbook`; `crates/ql-storage/src/workbook.rs:1044` is an O(1) lookup into `formula_cells`.  `CollabSession::rebuild_workbook` runs replay and then the sheet/table/column repair passes before returning the `Workbook`, so `formula_at` returns the repaired formula text.

### 2.2 fallback behavior

Finding CLOSURE-CODEX-MED-4 applies.  The closure says formula text should come from the repaired workbook, but the code uses:

```rust
formula: repaired_formula.or(state.formula),
```

The fallback is not needed for the closure's intended source-of-truth.  In ordinary valid logs, cache and workbook should agree except where repair intentionally changes the workbook formula, and the repaired formula wins.  The problematic case is when the workbook has no formula but the cache does.  That is precisely an invariant violation; silently emitting `state.formula` masks it.

Best choice: use only `repaired_formula` for the public snapshot and add a test/debug assertion that detects cache-vs-workbook formula disagreement.  If retaining the fallback is intentional, document the invariant and emit a visible diagnostic when it is exercised.

### 2.3 performance

No performance regression of concern.  `formula_at` is a `HashMap::get` on `(sheet, row, col)`, not a chunk walk.  The added per-cell cost is O(1), so workbook snapshot remains O(cells-in-cache) after the already-required `rebuild_workbook` pass.  For 100k cached cells this is 100k hash lookups, not 100k linear chunk scans.

### 2.4 regression test coverage

The new Rust test `rebuilt_workbook_carries_repaired_formula_but_cache_does_not` proves the important underlying divergence: cache has stale formula text after rename, while rebuilt workbook has repaired text.  It does not directly call the napi `workbook_snapshot` method, so the actual 3-line binding change is pinned by code review rather than test.

Missing coverage:

- unchanged formula still surfaces through `formula_at`
- formula on a tombstoned sheet is filtered out at sheet level
- multi-rename chain `A -> B -> C`
- deleted-sheet references / `#REF!` behavior, which is correctly deferred to V3.6+

### 2.5 IDE integration gap

Acceptable for V3.5.0.X, with a backlog pin.  There is no IDE-facing `appendPutFormula` wrapper today, so a true IDE mocha test for repaired formula rendering would require expanding the public surface.  `.plans/_active.md` correctly lists IDE-facing `appendPutFormula` as a V3.6+ candidate.

## 3. A-HIGH-3 Closure Verification

### 3.1 placement

Verified.  Add/Rename/Delete/Move call the engine operation first, then call `CellGridPanel.refreshAll()`, then log/toast success.

### 3.2 error handling

Finding CLOSURE-CODEX-MED-2 applies.  The refresh is inside the same `try` block as the engine mutation.  If `refreshAll()` throws, the command catch block logs `FATAL addSheet/renameSheet/deleteSheet/moveSheet error` and shows "Quantbook <op> failed", even though the session mutation already happened.

Recommendation: isolate refresh errors from mutation errors.  Either make `refreshAll()` catch per-panel render failures and return `{ refreshed, failed }`, or call it in a second `try/catch` after the mutation success path has already been established.

### 3.3 idempotency

`refreshAll()` iterates both `localPanels` and `collabPanels` and calls `render()` on each.  Repeated calls are intended to be idempotent from a data perspective, but they are not guarded against mid-edit rendering in collab panels.  See CLOSURE-CODEX-MED-3.

### 3.4 cross-window effect

`refreshAll()` only sees panels in the current extension host/window.  Other VS Code windows have separate extension hosts and panel maps.  That is acceptable for a minimal V3.5.0.X closure because local sheet commands mutate the current host's session; multi-window collab visibility should flow through transport/polling.  It should be documented if product expectations become "command in one window repaints every other window immediately".

### 3.5 output channel count

The returned count is accurate only on complete success: it increments after each `render()` call.  If a render throws, no count is returned and the command reports failure.  This is part of CLOSURE-CODEX-MED-2.

## 4. A-HIGH-4 Closure Verification

### 4.1 flag set/clear correctness

For the shipped closure:

- `tickPollRemote` merged branch sets `_pendingRenderAfterTyping = true` iff `_presenceRepaintInFlight` is true and render is skipped.
- The same branch clears `_pendingRenderAfterTyping` before rendering when the guard is false, which correctly supersedes any older deferred render.
- `setPresenceTyping(false)` captures `wasInFlight`, clears the flag, and renders only when the transition was true-to-false, the dirty flag is set, and the panel is not disposed.
- Watchdog follows the same high-level logic.
- Idle branch clears and renders only when pending is set, presence repaint is not in flight, and the panel is not disposed.

### 4.2 race conditions

Finding CLOSURE-CODEX-LOW-1 applies to the original shipped closure.  In `3dd571a9bcf`, `setPresenceTyping(false)` and the watchdog clear `_pendingRenderAfterTyping` before calling `render()` and do not catch render failures.  If `render()` throws, the dirty flag is lost and no retry is scheduled.

Follow-up IDE commit `3dbb4cfe05d` wraps these two calls in `try/catch` and logs failures, which addresses the unhandled-exception part.  It still intentionally keeps the flag cleared; that matches the existing merged/idle branch policy that the next genuine merge will retrigger.

Calling `setPresenceTyping(true)` twice is safe: `wasInFlight` is true on the second call, but the false-transition arm is not entered because `typing` is true.  The watchdog is reset.

Dispose is mostly safe: dispose sets `_disposed = true` before calling `setPresenceTyping(false)`, so deferred render is not fired during teardown.  A synchronous `render()` already in progress is not explicitly cancellable, but JavaScript execution is single-threaded enough that this is a low practical risk.

### 4.3 watchdog interaction

The watchdog checks `_disposed` before firing the deferred render.  It also clears the old timer handle before transitions.  The shipped risk was unguarded `render()` throw, not firing after disposal.

### 4.4 test gap

No mocha/vscode-test coverage was added.  The live smoke procedure is acceptable as a manual validation step for V3.5.0.X, but the regression risk is non-trivial because the behavior spans panel state, webview messaging, timer behavior, and poll ticks.  A refactor could easily remove one of the three dirty-flag clearing paths without a unit failure.

### 4.5 per-call cost

Negligible.  The closure adds a boolean check per tick, not an allocation-heavy path.

## 5. Convergent HIGH Closure Verification

### 5.1 initialization

`new()` sets `pure_local_frontier = true`, which is correct for a fresh session with no remote interleaving.

`from_snapshot()` also sets it true.  The doc rationale is acceptable for the normal imported-snapshot path because the new UndoManager has no local undo stack for imported history.  The codebase also documents that the new peer id must differ from peer ids already represented in the snapshot.  If callers violate that and reuse a prior peer id, all bets are already off; the `reborn_session_has_empty_undo_stack` test supports the intended behavior.

### 5.2 maintenance

Verified:

- `append_op()` applies cache effects, then sets `pure_local_frontier = true`, then maybe auto-flushes.
- `merge_bytes()` rebuilds cache, then sets `pure_local_frontier = false`, then maybe auto-flushes.
- `poll_remote_with_limit()` sets false only when `merged > 0`; zero-drain preserves the prior state.
- `discard_pending_ops()` rebuilds cache and sets false.
- Successful `undo()` and `redo()` set true after the cache path completes.  This is reasonable: Loro UndoManager has appended a fresh local inverse/redo op, so the local frontier is pure again.

`merge_bytes()` sets false even when the bytes are Loro-deduped or produce no visible change.  That is conservative and correctness-preserving, but can force a full rebuild on a later undo unnecessarily.

### 5.3 dispatch gate

Verified.  Both undo and redo require the pure-local-frontier flag plus the length-shape check before attempting partial invalidate.  If the gate fails or the op shape is unsupported, the code falls back to `rebuild_snapshot_cache()`, preserving cache invariants.

### 5.4 test coverage

`undo_after_remote_interleave_falls_back_to_full_rebuild` is the right regression for the original convergent bug.  It mirrors the remote-interleave scenario and compares the post-undo cache to a forced full rebuild.

Missing: symmetric redo-after-remote-interleave coverage.  The redo code has the same gate shape but captures the post-redo last op, so it deserves a parallel regression test.  This is covered by CLOSURE-CODEX-LOW-3.

### 5.5 invalidate_cell interaction

Verified.  `pure_local_frontier` only gates undo/redo dispatch.  `invalidate_cell()` still walks the full log for the target cell and uses a local tombstone tracker; it does not consult or mutate the session-level frontier flag.

## 6. Opus-M2 Closure Verification

### 6.1 placement

Verified.  `CellGridPanel.show()` calls `instance.setPresenceTyping(false)` immediately before `instance.render()`.

### 6.2 idempotency

Calling `setPresenceTyping(false)` on a new instance is a no-op for `_presenceRepaintInFlight` because `wasInFlight` is false.  It also clears any prior watchdog handle if present, which is the desired defensive behavior.

### 6.3 attachTransport pattern

`show()` calls `wireAttachment(attachment)` first, then `setPresenceTyping(false)`, then first render.  There is no separate reset inside `wireAttachment` or `attachTransport`.  For the open/attach path, the reset is still covered because it happens after wire-up and before render.  If a future reconnect path reattaches transport without going through `show()`, it should be checked separately; that is not part of the current closure.

## 7. A-LOW-1 Closure Verification

### 7.1 types.ts comments

Verified.  `CellValueJson` and `CellSnapshotJson` now describe napi absence as absent/`undefined`, not `null`, and the interfaces use optional fields.

### 7.2 preventive sweep

Spot-checking the nearby napi-derived TS interfaces found `FormatIdJson` already documents absent/`undefined` alternate fields.  I did not find another same-class `null` drift in the quantbook TS interfaces.

## 8. Cross-Finding Interactions

### 8.1 Opus-H1 widening and IDE

`apply_cache_effect` is private to `crates/ql-collab/src/session.rs`.  Grep found only the intended callers: `append_op`, `rebuild_snapshot_cache`, and `invalidate_cell`.  No direct IDE or external impact from the signature change.

### 8.2 pure_local_frontier and sheet commands

Sheet management commands call `append_op` through napi wrappers.  `append_op` sets `pure_local_frontier = true` after success, so the frontier gate remains consistent.  Sheet ops themselves are non-cell-keyed, so undo/redo falls back to full rebuild as expected.

### 8.3 workbook_snapshot and undo

`workbook_snapshot` is napi-only and not called by `undo()` itself.  IDE consumers calling `workbook_snapshot` after undo get a fresh `rebuild_workbook` and therefore repaired formula text.  The fallback concern in CLOSURE-CODEX-MED-4 still applies if cache/workbook diverge.

### 8.4 deferred render and refreshAll

Finding CLOSURE-CODEX-MED-3 applies.  The target local panel for sheet commands does not have collab transport presence, so the local target panel's `_presenceRepaintInFlight` should normally be false.  But `CellGridPanel.refreshAll()` also renders collab panels.  A local sheet command can therefore bypass the A-HIGH-4 mid-edit guard on an unrelated collab panel in the same extension host.

Recommendation: either make `refreshAll()` respect a render guard, or add a targeted refresh that only repaints panels belonging to the mutated session and defers guarded collab renders.

## 9. Documentation Accuracy

### 9.1 audit-closures subsection

The closure subsection accurately describes the main shipped code changes.  Drift:

- It does not mention the out-of-range `RemoveSheet` cache-vs-replay parity gap from CLOSURE-CODEX-MED-1.
- It describes `repaired_formula.or(state.formula)` as defensive; I consider that an invariant-masking fallback unless additional diagnostics are added.
- It does not mention that `refreshAll()` can render collab panels mid-edit.

### 9.2 closures table claims

The file/test claims match the shipped closure commits at a high level:

- Opus-H1: replay guard plus cache walker tombstone tracking and three tests are present.
- Opus-M2: `setPresenceTyping(false)` in `show()` is present.
- A-HIGH-2: binding reads `workbook.formula_at` and the Rust divergence test exists.
- A-HIGH-3: all four commands call `refreshAll()`.
- A-HIGH-4: `_pendingRenderAfterTyping` and the four set/clear sites exist.
- Convergent HIGH: `pure_local_frontier` and the undo regression test exist.
- A-LOW-1: comments are updated.

### 9.3 Rule 4 terminus claim

No Rule 4 failure found:

- `CacheEffect::RemoveSheet { id: u16 }` is primitive composition.
- `CollabSession.removed_sheets: HashSet<u16>` has a positive Send+Sync per-field walk in its docstring.
- `CollabSession.pure_local_frontier: bool` has a positive Send+Sync per-field walk in its docstring.

`CollabSession` remains not generally Sync because of existing transport internals; the new fields do not introduce new negative-trait claims.

### 9.4 backlog table

The V3.5.1+ backlog captures the original deferrals.  It should be extended with the findings from this closure audit:

- valid-sheet tombstone cache/replay parity and tests
- sheet-command refresh error isolation
- refreshAll respecting mid-edit guard or targeting mutated sessions only
- workbookSnapshot formula fallback diagnostic/removal
- redo-after-remote-interleave regression test
- PutFormula/ClearFormula tombstone regression tests

### 9.5 test count claims

The ql-collab count claim is correct: post-closure is 111, up from the 106 audit baseline.  The five listed tests are present.  IDE mocha count is a 346-test quantbook suite, but I could not confirm 346 passing in this sandbox because six localhost/relay tests fail with environment-level `EPERM`; see Section 11.

## 10. Plan Archive and _active.md

### 10.1 archive status

The archived plan frontmatter status is `done`.

### 10.2 active reset

`.plans/_active.md` is reset and contains useful V3.6+ entry-candidate notes: format table cache, format-aware rendering, per-cell op-index, UndoManager `on_pop`, incremental WorkbookSnapshot deltas, `#REF!`, `Op::RestoreSheet`, sheet-tabs redesign, IDE-facing `appendPutFormula`, and V3.5.1+ polish.

### 10.3 Opus Section F preservation

The V3.6 entry-readiness packet is preserved by reference in the archive and summarized in `_active.md`.

Drift: archive frontmatter lines for `current_engine_head`, `current_ide_head`, `current_mocha_count`, and `current_ql_collab_tests` still describe the audit-in-progress pre-closure state even though the status line says closures shipped.  This is doc hygiene, not runtime risk.

## 11. Engine and IDE Test Verification

### 11.1 ql-collab

Requested command could not run exactly because the `mac` wrapper is not installed:

```text
zsh:1: command not found: mac
```

Equivalent direct command passed:

```text
test result: ok. 111 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Note: this ran on the same code that later landed in follow-up engine commit `2691248c3aa`, not on the original closure commit alone.

### 11.2 new test listing

The following new tests are listed by cargo:

- `session::tests::put_value_on_tombstoned_sheet_is_silently_dropped`
- `session::tests::rebuilt_workbook_carries_repaired_formula_but_cache_does_not`
- `session::tests::set_cell_format_clear_on_tombstoned_sheet_is_silently_dropped`
- `session::tests::set_cell_format_on_tombstoned_sheet_is_silently_dropped`
- `session::tests::undo_after_remote_interleave_falls_back_to_full_rebuild`

### 11.3 IDE mocha

`npm test` from `extensions/quantlab` compiled but failed due sandbox network restrictions:

```text
1333 passing
25 pending
6 failing
```

All six failures are localhost/relay startup failures:

- four `listen EPERM: operation not permitted 127.0.0.1`
- two relay processes exiting before ready

The quantbook-only suite reports:

```text
340 passing
6 failing
```

Those six are the same network/relay failures.  Running quantbook mocha with the V2.3 websocket and V3.1 relay suites inverted passes:

```text
328 passing
```

Therefore I could not confirm "346 passing" in this sandbox.  I did not find evidence of a V3.5.0.X closure regression in the non-network subset.

### 11.4 other crates

Release lib tests passed:

- `ql-oplog`: 67 passed, 0 failed
- `ql-storage`: 199 passed, 0 failed
- `ql-exec`: 636 passed, 0 failed

## 12. Hygiene and Commit Quality

### 12.1 tracked-clean status

Tracked files are clean after the parallel follow-up commits (`2691248c3aa`, `3dbb4cfe05d`) landed.  There are many unrelated untracked files in the parent repos, and this transcript adds the requested untracked audit file until it is committed.

### 12.2 commit messages

The closure commit messages are descriptive and match the local convention:

- `853f4006a75 feat(quantbook): Phase 5.7 V3.5.0.X megaudit closures (engine) -- 5 HIGH + 1 MED + 1 LOW closed in-cycle`
- `4b22f7e6649 docs(5.7): archive V3.5 plan to _archive/ + reset _active.md`
- `3dd571a9bcf feat(quantbook): Phase 5.7 V3.5.0.X megaudit closures (IDE) -- A-HIGH-3 + A-HIGH-4 + Opus-M2 + A-LOW-1`

### 12.3 unicode hygiene

IDE changed files are ASCII-clean in the checked scan.  The shipped engine closure is not strictly ASCII-clean: `git show 853f4006a75` shows added source comments containing section signs, including the `workbook_snapshot` formula comment and the ql-collab test comment referencing the Codex reproduction section.  The broader docs already contain non-ASCII symbols, but source-comment additions violate the stated "no smart quotes / em-dashes / Greek / section signs in source" hygiene rule if applied strictly.

## 13. Final Verdict

Verdict: **PASS-WITH-FINDINGS**.

The shipped closures fix the primary bugs they targeted on the normal V3.5 operation paths.  I do not recommend calling the closure cycle a hard fail.  However, the closure is not complete enough to call clean:

- cache tombstone tracking does not exactly mirror replay for out-of-range `RemoveSheet`
- sheet-command repainting misreports render failures as mutation failures
- sheet-command repainting can bypass the mid-edit guard on collab panels
- workbookSnapshot keeps an invariant-masking formula fallback
- some test-only and documentation seams remain loose
- IDE mocha could not be fully verified in this sandbox because localhost/relay tests are environment-blocked

The most important fixes before relying on this as a V3.6 base are CLOSURE-CODEX-MED-1 through CLOSURE-CODEX-MED-4.  The rest can be V3.5.1+ backlog if the orchestrator accepts the residual risk.
