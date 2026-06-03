# FE Megaudit Fix Re-Audit -- Codex

Date: 2026-06-03  
Branch: `feat/visualise-v1`  
Scope: current working tree, with `docs/fe/2026-06-03-fe-megaudit/FIXES.diff` used only as change context. Product code was not modified.

## Verification Matrix

| ID | Status | Evidence |
|---|---|---|
| F1 formula re-edit drops `=` | RESOLVED | `extensions/quantlab/webview/sheets-webview/index.ts:175-180` now prefixes formula bodies with `=` before filling the editor. |
| F2 panel registry keyed by sheet-id | RESOLVED | `extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:77-100` uses `bySession: Map<SessionInstance, Map<number, CellGridPanel>>`; commands target `focusedLocalPanel()` at `extensions/quantlab/src/commands/quantbookCommands.ts:291-294`, `343-346`, `449-452`, `497-500`, `573-576`, `643-646`. |
| F3 UDF diagnostics dead | RESOLVED | `cellGridPanel.ts:408-458` decorates snapshots before storing/sending; `cellGridPanel.ts:476-489` polls `session.pollEvents(cursor)`, folds diagnostics, advances a per-panel cursor, and calls `attachCellDiagnostics`. |
| F4 session never closed/listeners over-scoped | RESOLVED on normal lifecycle | `cellGridPanel.ts:133-139` registers message/viewstate listeners into `panelDisposables`; `cellGridPanel.ts:156-189` disposes them and closes the `Session` only when the last panel for that session is removed. See MEDIUM issue below for the exception path before this dispose handler is registered. |
| M1 undo re-renders one panel | RESOLVED, with regression noted | `cellGridPanel.ts:581-587` calls `CellGridPanel.refreshSession(this.session)` on commit/undo/redo. See MEDIUM issue below: sibling refresh now cancels active editors. |
| M3 unknown-sheet delta skip+advance | RESOLVED | `cellGridLogic.ts:1157-1176` and `1180-1191` throw `[invalid_state]`; tests at `quantbook-roundtrip.test.ts:7161-7174`. Normal AddSheet remains on the `fullRebuildRequired` path per existing tests. |
| M4 deleted sheet masked as empty | RESOLVED | `cellGridPanel.ts:416-437` logs and shows a one-time visible warning guarded by `deletedSheetWarned`. |
| M5 dropped render/errorReply silent | RESOLVED | `cellGridPanel.ts:498-528` warns/toasts for render non-delivery or rejection; `cellGridPanel.ts:606-621` toasts for `errorReply` rejection as well as non-delivery. |
| M6 refreshAll log-only/disposed miscount | RESOLVED | `cellGridPanel.ts:218-232` counts `ok/failed/skipped`; `cellGridPanel.ts:265-276` returns `skipped` for disposed panels; command paths toast on `failed > 0` at `quantbookCommands.ts:476-480`, `552-556`, `622-626`, `688-692`. |
| M7 palette/font silent fallback | RESOLVED | `canvasGrid.ts:43-53`, `88-99`, `300-331` warn once before fallback. |
| M8 edit reply not correlated | RESOLVED for current serial protocol | `index.ts:157-164` blocks new edits while a commit is pending; `index.ts:207-212` stamps `(sheet,row,col)`; `index.ts:341-350` only clears pending when the reply matches. This is coordinate correlation, not a unique commit id, but the current webview sends one in-flight commit at a time. |
| M9 unbounded rawInput | RESOLVED | `cellGridLogic.ts:273`, `396-405` reject inputs over 8192 chars before parsing/binding. |
| L-g sheet-mismatch putValue dropped | RESOLVED | `cellGridLogic.ts:407-424` now sends a `bad_argument` `errorReply`; test at `quantbook-roundtrip.test.ts:2522-2538`. |
| L-k nonce/coords/build guard | RESOLVED | `utils/webview.ts:5`, `30` uses `crypto.randomBytes`; `cellGridLogic.ts:284-290`, `475-477` sanitize row/col; `esbuild-quantbook-webviews.mjs:53-63` broadens the host-runtime guard. The guard regex does match `../../src/quantbook/types`, but the current imports are `import type` at `index.ts:27`, `canvasGrid.ts:24`, `cellRender.ts:20`, which esbuild erases before resolution; value imports into host code fail intentionally. |
| L-d/L-b/L-e/L-i canvas polish | RESOLVED | Editor padding aligns at `sheets-webview.css:69-73`; scroll/mousemove are rAF-coalesced at `index.ts:120-130`, `288-295`, `358-360`; surrogate backoff is at `gridLayout.ts:160-172`; half-evict cache at `canvasGrid.ts:282-294`; text branch trims at `cellGridLogic.ts:209-222`. |
| S5 new tests | RESOLVED | `classifyCellInput` and formula-error/blank tests are at `quantbook-roundtrip.test.ts:2567-2644`; M3 throw tests at `7157-7174`; surrogate truncate test at `quantbook-sheets-grid-layout.test.ts:113-128`. |
| S6 dormancy labels + drift docstrings | PARTIAL | Dormancy labels were added at `cellGridLogic.ts:489` and `548`, and several type docstrings were corrected (`types.ts:168-174`, `1160-1161`, `1177-1181`, `1198-1200`). Some live helper comments still cite retired `buildHtml`/`renderRows`; see LOW issue below. |

## Finding-Not-Resolved

### LOW -- S6 doc drift is only partially fixed

`extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts:793`, `913-914`, `922-923`, `951`

Several comments in the live `extractSheetSnapshot`/diagnostics helpers still name the retired DOM-table `buildHtml`/`renderRows` consumer. The fix added useful dormancy labels and some drift corrections, but S6's docstring cleanup is not complete.

Minimal fix: update the remaining comments to name the live Canvas2D/webview path (`webview/sheets-webview/index.ts`, `canvasGrid.ts`, hover tooltip attachment) and leave `cellGridHtml.ts` retirement itself as documented forward work.

## New-Bug-Introduced

### MEDIUM -- `refreshSession()` on every commit can cancel an active sibling-panel edit

`extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:581-587`  
`extensions/quantlab/webview/sheets-webview/index.ts:132-138`, `196-222`

M1 changed every successful commit/undo/redo to re-render every panel in the session. The webview still treats any inbound `render` as a committed state change and calls `cancelEdit()` unconditionally. With two panels on one session, a commit in panel B now sends a render to panel A and drops panel A's active editor, even if panel A has uncommitted text or a pending commit.

This is a real regression from the M1 fix: before session-wide refresh, sibling commits did not repaint and therefore did not cancel the other panel's editor. It does not corrupt engine state, but it can lose typed-but-not-committed user input and can hide an in-flight editor before its own reply arrives.

Minimal fix: make render application edit-aware. Either queue/merge inbound renders while `editState !== null`, or add commit correlation so only the render that acknowledges the current pending commit clears the editor; unrelated sibling renders should update the backing snapshot without destroying the overlay input.

### MEDIUM -- `CellGridPanel.show()` can leave an untracked panel/listener/session if initial `render()` throws

`extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:126-156`  
`extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:156-191`  
`extensions/quantlab/src/commands/quantbookCommands.ts:231-260`, `389-437`

`show()` creates the VS Code panel, registers message/viewstate listeners, sets HTML, then calls `instance.render()` before the instance is added to `allPanels`/`bySession` and before `panel.onDidDispose` is registered. If the initial render throws, the caller sees an error, but the already-created webview panel remains outside the registry and will not run the F4 cleanup path.

The primary `quantbookCellGrid` command also does not close the freshly-created sample session on this failure path (`quantbookCommands.ts:231-260`). The `quantbookOpen` display-failure catch closes the new session (`quantbookCommands.ts:432-435`), but it can still leave an orphan webview with a message listener bound to a now-closed session because the panel dispose handler was never attached.

Minimal fix: register `onDidDispose`, add the instance to registries, and push the panel subscription before the first `render()`, or wrap the pre-registration setup in `try/catch` that disposes the panel and closes/discards the session exactly once on failure. For `quantbookCellGrid`, explicitly close the new sample session if `CellGridPanel.show()` fails before ownership transfers.

### LOW -- Accumulated diagnostics can attach a stale UDF message to a later non-UDF error in the same cell

`extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:352-360`, `484-489`  
`extensions/quantlab/src/quantbook/cellGrid/cellGridLogic.ts:1006-1039`

The F3 wiring persists diagnostic messages by `"row,col"` across renders and `attachCellDiagnostics()` attaches any stored message to any current `value.kind === 'error'`. A cell that first had a UDF `#CALC!`/`#TIMEOUT!` diagnostic, then later changed to a different error that emits no `cell_diagnostic`, can show the old UDF explanation on the new error.

Minimal fix: carry enough diagnostic metadata to attach only to diagnostic-backed error sigils (for example `#CALC!`/`#TIMEOUT!`), or clear a cell's accumulated diagnostic when a render observes the same cell no longer has a diagnostic-compatible error. The stronger fix is an engine-side diagnostic-clear event.

## Other Adversarial Checks

- F2/F4 normal ref-counting is correct: `disposeAll()` snapshots `allPanels`, each panel removes only its own `(session,sheet)` entry, and `session.close()` runs only when that session's sheet map reaches zero. Sibling panels on other sheets keep the session alive. The Open command creates the new session before disposal, but because it has no panel yet, `disposeAll()` cannot close it.
- Focus tracking is materially improved: `onDidChangeViewState` updates `focusedPanel`, and disposed focused panels are ignored by `focusedLocalPanel()`.
- F3 cursoring is per-panel and non-draining per `SessionInstance.pollEvents(cursor)` docs (`types.ts:1917-1925`), so I do not see double-drain/starvation across sibling panels.
- M3 throw does not break normal AddSheet/full rebuild: real AddSheet paths remain covered by `fullRebuildRequired` tests, while only impossible changed/removed cells for uncached sheets throw.
- M5/M9/L-g do not look over-eager in normal UI flow. The render/error toasts fire only after `postMessage` failure; raw input cap is high enough for ordinary cells; sheet mismatch is a defense path.
- L-b rAF throttling reads the latest scroll/mouse coordinates inside the animation callback, so the final scroll/mouse frame is not dropped.

Verdict: SHIP-WITH-FIXES -- 0 HIGH / 2 MEDIUM / 2 LOW.
