# FE Megaudit — FIX RE-AUDIT (architectural / cross-cutting lane: Opus)

**Date:** 2026-06-03
**Branch:** `feat/visualise-v1` (Batch 1 @ `e6730e7a3ff`; Batch 2 in the working tree, confirmed `git status` = M on all touched files)
**Base:** `1c8c8e366b2` (pre-fix). Method: read the ACTUAL working-tree files (not just FIXES.diff), trace concrete multi-panel / multi-session / rapid-edit / Open-replace sequences against the lifecycle (F2/F4), diagnostics (F3), and edit-state-machine (M8) code. Read-only — no code changed.

**Verdict: SHIP. 0 HIGH / 0 MEDIUM / 3 LOW (all pre-existing-class or forward; none introduced by the fixes is worse than the bug it replaced).**

All 5 HIGH + 9 MED + the LOW cluster are genuinely resolved. The lifecycle refactor is correct: no double-close, no sibling-session premature close, the Open path closes displaced sessions exactly once and never the new session, panel-scoped listeners are disposed, `focusedPanel` is tracked + cleared on dispose, switch-sheet registers correctly under `bySession`. F3 diagnostics drain is side-effect-free, per-panel-cursor-correct, bounded, and load-guarded. M8 cannot stick the editor on any reachable path. The new bugs I went hunting for are not present; the three LOWs below are minor and forward.

---

## (1) Per-finding verification

### HIGH — all RESOLVED

- **F1 (formula re-edit drops `=`) — RESOLVED.** `index.ts:180`: `inputEl.value = typeof entry.formula === 'string' ? '=' + entry.formula : formatCellValue(entry.value)`. The `=` is re-prefixed, so a no-op re-submit re-routes to `setFormula` (dispatch `cellGridLogic.ts:454` checks `trimStart().startsWith('=')`). Regression test present (`quantbook-roundtrip.test.ts:2503,6215`). The text branch trims (`classifyCellInput:222`, `text: trimmed`), tested at `:2590`.

- **F2 (registry keyed by sheet-id) — RESOLVED.** `cellGridPanel.ts:77-79`: `allPanels: Set` + `bySession: Map<SessionInstance, Map<number, CellGridPanel>>` + `focusedPanel`. `show()` (`:95-101`) reveals an existing panel **only when `bySession.get(session)?.get(sheet)` matches** — a different session sharing a sheet id now mints its own panel. Commands target `focusedLocalPanel()` (`:294,346,452,500,576,646`), tracked via `onDidChangeViewState` (`:135-139`). The single-writer model holds across multiple sessions.

- **F3 (dead UDF diagnostics) — RESOLVED + correct.** `render()` → `drainAndAttachDiagnostics()` (`:443,476-490`): `pollEvents(this.eventCursor)` → `buildCellDiagnosticMessages(page.events, this.sheet)` folded into `accumulatedDiagnostics` (last-wins) → `eventCursor = page.nextCursor` → `attachCellDiagnostics`. Stored snapshot is the **decorated** one (`:457`). `pollEvents` is load-guarded (`loader.ts:356`), so the call can't be `undefined` at runtime. Side-effect analysis below confirms no shared-cache mutation.

- **F4 (session never closed + listener over-scoped) — RESOLVED + correct.** Listeners now collected in a panel-local `panelDisposables` array (`:133-139`) and disposed in `onDidDispose` (`:163-165`) — extension-lifetime leak gone. `session.close()` is ref-counted: called only when the session's last panel disposes (`:175-188`, gated on `sheetMapNow.size === 0`). Double-close / sibling-close analysis below confirms exactly-once.

- **F5 (bundle not in aggregate build) — documented forward-work** per the re-audit brief (cellGridHtml retirement + F5 aggregate wiring DEFERRED). The runtime `readyWatchdog` (`:536-546`) still fails LOUD after 6 s if the bundle is missing. Not re-litigated here.

### MEDIUM — all RESOLVED

- **M1 (undo re-renders one panel) — RESOLVED.** `onCommit` → `CellGridPanel.refreshSession(this.session)` (`:582`), which iterates `bySession.get(session).values()` (`:213-216`) — every panel of the mutating session repaints, covering sibling-sheet dependents. No re-entrancy (render does not call onCommit).
- **M3 (delta unknown-sheet skip+advance) — RESOLVED + correctly gated.** `mergeWorkbookDelta` throws `[invalid_state]` on `sheet === undefined` for both `changedCells` (`:1169-1175`) and `removedCells` (`:1185-1190`). The `fullRebuildRequired` path returns BEFORE `mergeWorkbookDelta` is ever called (`acquireWorkbookSnapshotViaDelta:1278-1283`), so a legitimate AddSheet/full-rebuild never reaches the throw. Tests `:7161,7169`.
- **M4 (deleted-sheet masked) — RESOLVED.** One-time `showWarningMessage` guarded by `deletedSheetWarned` (`:416-432`), re-armed when the sheet reappears (`:436`).
- **M5 (dropped render silent) — RESOLVED.** `postRenderIfReady` toasts on `!delivered` and on rejection (`:509-528`); errorReply rejection arm now also toasts (`:614-621`). Symmetric with the non-delivery arm.
- **M6 (refreshAll log-only + disposed miscount) — RESOLVED.** `safeRender` returns `'ok'|'failed'|'skipped'` (`:265-277`); disposed panels return `'skipped'` and are not counted as refreshed. The four sheet commands toast on `failed > 0` (`quantbookCommands.ts:478,554,624,690`).
- **M7 (palette/font silent fallback) — RESOLVED.** `warnMissingThemeVar` warn-once in `readPalette` (`:308`), `readFonts` (`:328`), `resolveDpr` (`:95`).
- **M8 (in-flight edit reply not correlated) — RESOLVED.** `EditState.commitSheet/Row/Col` stamped at `commitEdit` (`index.ts:210-212`); errorReply clears `pendingCommit` ONLY on a coord match (`:341-351`); `beginEdit` blocks while `pendingCommit` (`:162-164`). Stuck-editor analysis below.
- **M9 (unbounded rawInput) — RESOLVED.** `MAX_RAW_INPUT_LENGTH = 8192` cap with `bad_argument` errorReply before the napi parse (`cellGridLogic.ts:396-406`).

### LOW — all RESOLVED (spot-checked)

- **L-g** sheet-mismatch now sends a `bad_argument` errorReply (`:407-424`) — un-sticks the editor.
- **L-k** nonce: `crypto.randomBytes(16).toString('base64url')` (`utils/webview.ts:30`); errorReply coords sanitized via `sanitizeCoord` (`:284-290`, used at `:380-381,400-401,419-420,476-477`); esbuild guard broadened (`esbuild-quantbook-webviews.mjs:53`) — false-positive analysis below.
- **L-d** editor padding `2px 7px` + `box-sizing:border-box` + 1px border = 8px left, matching canvas `CELL_PAD = 8` (`sheets-webview.css:62,73`; `canvasGrid.ts:28`). Text jump resolved.
- **L-b** scroll + mousemove rAF-throttled (`index.ts:121-130,288-296,360`); reads the latest offset/coords inside the rAF callback — no dropped final frame (analysis below).
- **L-e** surrogate-safe truncate (`gridLayout.ts:165-171`); test `:115`.
- **L-i** `measureCache` half-evicts oldest (`canvasGrid.ts:283-295`).
- **L-l** the ESM bundle is loaded with `type="module"` (`cellGridPanel.ts:659`) — consistency hazard closed.

### Tests (S5) — present
`classifyCellInput` (`:2567`), formula-error dispatch path (`:2503,6215`), `extractSheetSnapshot` blank-throw (`:2629`), M3 throw (`:7161,7169`), L-e surrogate (grid-layout `:115`). M9-cap has no dedicated test, but the brief's S5 scope did not list it — not a gap.

---

## (2) New-bug hunt (the adversarial part)

### F2/F4 lifecycle — CLEAN

- **Double-close?** No. `session.close()` fires only inside the last-panel branch (`:175-188`), reached only when `sheetMapNow.get(sheet) === instance` AND `sheetMapNow.size === 0` after deleting this panel's entry. Each panel deletes its own `(session,sheet)` key exactly once. For a 2-panel session, the first dispose leaves size 1 (no close); the second hits size 0 (one close). Exactly-once.
- **Sibling-session premature close?** No. Closing is keyed on the session's own `sheetMap` reaching empty, not on any global panel count. A session with a live sibling sheet stays open.
- **Open command — displaced closed once, new never closed?** Traced `quantbookCommands.ts:419-437`: `disposeAll()` snapshots `Array.from(allPanels)` then disposes each → each session's last-panel `onDidDispose` closes it once. The NEW session is created by `openWorkbookFromQbook` (distinct napi object), has no registered panel when `disposeAll` runs, so it is untouched; it is then shown fresh. `closeSessionQuietly(session,…)` is invoked only on the NEW session in the catch arms (`:434`). No path closes a displaced session twice, and the new session is closed at most once (only on display error). The prior "manual close of displaced sessions" that would have double-closed is correctly gone (comment `:419-425`).
- **Panel-scoped listeners disposed / no late fire?** Yes — `onDidReceiveMessage` and `onDidChangeViewState` are in `panelDisposables`, disposed in `onDidDispose` (`:163-165`). `_disposed = true` is set first (`:159`) so any racing post early-returns.
- **`focusedPanel` staleness?** Cleared to `undefined` on dispose of the focused panel (`:167-169`); `focusedLocalPanel()` additionally re-checks `focusedPanel._disposed` (`:299`). No stale-ref command target.
- **switch-sheet registration under `bySession`?** Correct — `show(session, newSheet)` finds no existing entry, mints a panel, `sheetMap.set(newSheet, instance)`; the session now owns 2 panels and the F4 ref-count is honored.

### F3 diagnostics wiring — CLEAN

- **Side effects on the shared delta cache / other consumers?** None. `extractSheetSnapshot` builds a fresh `entries` array of new objects (`cellGridLogic.ts:808-942`) — it does not alias the shared `DeltaSnapshotCache` cell objects; `attachCellDiagnostics` returns a `{...snapshot, entries}` copy (`:1039`). So per-panel diagnostic attachment never mutates the per-session shared cache that a sibling panel rides. `pollEvents` is a non-draining cursor read (contract `types.ts:1751`), so two panels' independent cursors neither double-drain nor starve each other.
- **Cursor correctness / no double-drain / no missed events?** Per-panel `eventCursor` starts `0n`, advances to `page.nextCursor` each render (`:488`). Each render folds only events since the cursor. Correct.
- **`accumulatedDiagnostics` infinite growth?** Bounded by the number of distinct `(row,col)` cells that ever emitted a diagnostic on this sheet (keyed map, last-wins). It is monotonic (a recovered cell keeps a map entry but `attachCellDiagnostics` only surfaces it on a CURRENTLY error-valued cell, so no stale tooltip). Practically bounded; see LOW-1.
- **Safe when pollEvents unsupported?** `pollEvents` is load-guarded (`loader.ts:356`) — a stale cdylib fails at the binding boundary, so `render()` never calls a missing method.
- **Hot-path perf?** One extra `pollEvents` napi round-trip + a small map fold per render. `render()` is already user-action-gated (commit / refresh / reveal), not a continuous loop. Acceptable.

### M8 edit state machine — CLEAN (no stuck editor on any reachable path)

Enumerated every `putValue` outcome from a real webview (which always posts `sheet === fullSnapshot.sheet`, finite int row/col):
1. **Success** → `recalcDirtyChecked` → `onCommit` → `refreshSession` → render posted → `applyRender` → `cancelEdit()` clears `editState` (incl. `pendingCommit`). Unstuck.
2. **Engine throw** → `onError` errorReply with `sheet=req.sheet, row=sanitizeCoord(req.row), col=sanitizeCoord(req.col)`. Since the webview sends finite non-negative int coords, `sanitizeCoord` is identity, so `commitSheet/Row/Col` match → `pendingCommit = false` → editor open for correction. Unstuck.
3. **L-g sheet-mismatch** → errorReply (structurally unreachable from the real single-sheet webview, but still replies). Unstuck.
4. **M9 over-limit / non-string rawInput** → `bad_argument` errorReply with matching sanitized coords → unstuck.

Every reachable `putValue` produces either a `render` (clears) or a coord-matched `errorReply` (un-sticks). The only way `pendingCommit` could persist is if the dispatching panel's OWN `render()` throws so no render reaches the webview — but then `onCommit` reports `failed > 0` and toasts (`:582-587`), i.e. it is surfaced, not silent. `beginEdit` blocking while pending (`:162-164`) prevents the interleave that M8 targeted. No stuck-editor regression.

### M3 throw — does not break the normal delta path
Confirmed above: throw is unreachable on a legitimate AddSheet/full-rebuild (the `fullRebuildRequired` branch returns first). Only a genuine engine↔IDE contract drift trips it. Correct.

### M1 refreshSession-on-every-commit — no re-entrancy / acceptable perf
`render` → `postRenderIfReady` (async postMessage); render does not call `onCommit`, so no synchronous recursion. `refreshSession` iterates only the mutating session's panels (typically 1), not all panels. Fine.

### M9 / L-g / M5 — no over-eager rejection or toast spam under normal use
`retainContextWhenHidden:true` keeps the channel live, so `!delivered`/reject is rare. Toasts fire only on a genuinely broken channel — the No-Fallbacks intent. See LOW-2 for the storm caveat.

### esbuild guard regex — NO false-positive on the current tree
`HOST_RUNTIME_FILTER = /(^|\/)(session|loader)(\.d\.ts|\.[cm]?[jt]sx?)?$|\/src\/quantbook\/|\.(node|dylib|so|dll)$/`. The `/src/quantbook/` alternative WOULD match the resolved path of `../../src/quantbook/types`. The build is safe **only because all three webview imports of that module are `import type`** (verified: `index.ts:27`, `cellRender.ts:20`, `canvasGrid.ts:24` — grep found zero non-type imports), and esbuild erases type-only imports before `onResolve` runs, so the guard is never consulted for them. Operator-confirmed green build is consistent. Latent footgun: adding a *value* import from `src/quantbook/` would fail the build — but that is the guard's intended job, not a false-positive. No issue.

### L-b rAF throttle — no dropped final frame
`scheduleRedraw` reads `viewportEl.scrollTop/Left` INSIDE the rAF callback via `redraw()` (`index.ts:108-114,121-130`), so the last frame always paints the final scroll offset. `ResizeObserver` (`:364`) and `errorReply`/`render` (`:329,352`) call `redraw()` directly (un-throttled), so a resize or a host message always forces a fresh paint. No stale-final-frame.

---

## New bugs introduced — NONE (HIGH/MED). LOW observations only

- **LOW-1 — `accumulatedDiagnostics` is never pruned (monotonic).** `cellGridPanel.ts:360,485-487`. A cell that diagnosed once then recovered keeps a map entry forever (display is correct — `attachCellDiagnostics` gates on current error value). Bounded by distinct error cells per sheet; not a leak in practice. *Minimal fix (optional):* on a render where a key's cell is no longer error-valued, `accumulatedDiagnostics.delete(key)`. Forward.
- **LOW-2 — M5 dropped-render / errorReply-reject toasts have no dedup.** `cellGridPanel.ts:513,522,609,617`. On a persistently broken channel under a rapid-commit storm, each render/reply can raise a toast (one per failed post). The precondition (broken `retainContextWhenHidden` channel) is the rare No-Fallbacks case the fix intends to surface, so this is acceptable, but a `warnedStaleOnce` guard (mirroring `deletedSheetWarned`) would prevent spam. Forward.
- **LOW-3 — esbuild guard correctness depends on `import type` discipline (latent).** `esbuild-quantbook-webviews.mjs:53`. Not a current bug (all imports are type-only), but the `/src/quantbook/` alternative means any future value-import from that path fails the build with the host-runtime message even when it is a pure type/const move. That is by-design but worth a one-line lint/doc note for the next editor. Forward.

None of the three is a regression caused by the fixes; each is a minor property of an otherwise-correct fix.

---

## Verified clean (re-confirmed at source)
- Lifecycle: no double-close, no sibling premature close, Open closes displaced-once / new-never, panel-scoped listener disposal, focusedPanel clear-on-dispose, switch-sheet registration.
- F3: per-panel cursor correctness, no shared-cache mutation, bounded accumulation, load-guarded `pollEvents`.
- M8: no stuck editor / lost edit / wrong-decoration on any reachable sequence.
- M3 throw gated to genuine contract drift only.
- M1 no re-entrancy; refreshSession scoped to the mutating session.
- esbuild guard: no false-positive on the current (all-`import type`) tree.
- L-b: latest-offset read in rAF; direct redraw on resize/host-message — no stale final frame.
- L-d pad alignment, L-e surrogate, L-i half-evict, L-k nonce/coord-sanitize, L-l `type="module"`.

---

## Verdict

**SHIP — 0 HIGH / 0 MEDIUM / 3 LOW.** Every megaudit finding in scope is correctly resolved; the lifecycle, diagnostics, and edit-state refactors introduce no new HIGH/MED bug. The three LOWs are forward polish on otherwise-correct fixes.
