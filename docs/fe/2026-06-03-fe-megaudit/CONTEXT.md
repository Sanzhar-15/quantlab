# FE Megaudit — shared context (read first)

Repo: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab`, branch `feat/visualise-v1`,
HEAD `1c8c8e366b2`. This is a **read-only audit** of the landed Quantbook FE work (FE-0a + FE-0b).
**Do NOT edit, write (except your own findings file), commit, or run non-read-only commands on the
repo.** You MAY run `tsc`/build/tests read-only via the mac bridge if useful, but do not change code.

## What the FE is (one screen)
Quantbook = an Excel-like spreadsheet inside a VS Code extension (the `quantlab` extension), backed
by a Rust engine over napi. The FE work just landed:
- **FE-0a** — migrated the cell grid from the collaborative `CollabSession` to the owning
  **single-writer `Session`** (napi). Added sheet ops + `.qbook` save/open commands.
- **FE-0b** — replaced the host-built inline-HTML DOM-table webview with a **persistent bundled
  (esbuild) webview** (FE-0b-1) and then an **own Canvas2D renderer + DOM-overlay editor**
  (FE-0b-2+3). Glide Data Grid was the MIT pattern donor; nothing vendored.

The grid is a LIST of populated cells (one display-row per snapshot `entry`) across 3 fixed columns —
Row, Col, Value — only Value editable. (A true 2D sheet is the deferred FE-2.)

## Architecture / data flow
- Host (`cellGridPanel.ts`): owns the `vscode.WebviewPanel`, binds a `Session`, mounts a one-time
  shell HTML (nonce CSP + `<script src>` bundle + `#sheets-root`), and on each commit pushes
  `postMessage({type:'render', snapshot})`. A `readyWatchdog` surfaces a loud error if the bundle
  never loads. Reads the snapshot via the incremental delta path (`acquireWorkbookSnapshotViaDelta`).
- Dispatch (`cellGridLogic.ts`): `dispatchIncomingMessage(raw, deps)` handles `putValue`
  (->setValue/setFormula + recalc), `undo`/`redo`; drops dormant collab `presenceUpdate`/`typing_stroke`.
  Also: `extractSheetSnapshot`, `acquireWorkbookSnapshotViaDelta`, `computeVisibleRange` (HOST copy,
  arg order differs from the webview's), `classifyCellInput`, `parseCellRawInput`, sheet quickpick builders.
- Webview bundle (`webview/sheets-webview/`): `index.ts` (entry: scroller+spacer+transform-translated
  absolute canvas + content-anchored `<input>` editor; click->hitTestViewport->edit; Enter=putValue;
  hover->canvas.title), `canvasGrid.ts` (`CanvasGridRenderer`: HiDPI, palette/measure caches, draw),
  `gridLayout.ts` (PURE: columns, cellContentRect, hitTestContent/hitTestViewport, truncateToWidth),
  `cellRender.ts` (formatCellValue + computeVisibleRowRange). Bundled by
  `esbuild-quantbook-webviews.mjs` (SEPARATE from the shared `esbuild-webview.mjs`; a no-host-runtime
  onResolve guard; emits to `dist/webview/quantbook/`, which is gitignored).
- Session consumer (`session.ts`): the napi `Session` wrapper (createWorkbookSession, setValue,
  setFormula, recalc, listSheets/addSheet/renameSheet/deleteSheet/moveSheet, save/open, snapshot/delta,
  undo/redo). 1258 lines — the FFI boundary.

## Audit surface (read the CURRENT files; the diff shows what FE changed)
Primary (as-built):
- `extensions/quantlab/src/quantbook/cellGrid/{cellGridPanel.ts (446), cellGridLogic.ts (1214), cellGridHtml.ts (788, DEAD/retired)}`
- `extensions/quantlab/webview/sheets-webview/{index.ts (303), canvasGrid.ts (279), gridLayout.ts (161), cellRender.ts (88), sheets-webview.css (71)}`
- `extensions/quantlab/src/quantbook/session.ts (1258)`, `extensions/quantlab/src/commands/quantbookCommands.ts (684)`, `extensions/quantlab/src/quantbook/types.ts`
- `extensions/quantlab/esbuild-quantbook-webviews.mjs (68)`, `extensions/esbuild-webview-common.mjs (97, SHARED by 7 extensions)`
- Tests: `extensions/quantlab/test/{quantbook-roundtrip.test.ts, quantbook-session.test.ts, quantbook-sheets-grid-layout.test.ts, quantbook-sheets-webview-render.test.ts, quantbook-udf-worker.test.ts}`
Reference: the cumulative FE diff is at `docs/fe/2026-06-03-fe-megaudit/cumulative-fe.diff` (BASE `552d32796d3`..HEAD).

## Hard project rules to audit against
- **No-Fallbacks (HARD RULE):** errors must be VISIBLE, never swallowed. No try/catch that hides an
  error or returns a default; no `value || default` masking missing state; no silent retries/drops;
  no "graceful degradation". The ONLY exception is explicit user-facing error surfacing at system
  boundaries — and even then the underlying error must be logged. Flag every violation.
- Read before concluding; cite `file:line`; give a concrete failure + a minimal fix for each finding.

## Known/expected (don't re-report as novel)
- 1 pre-existing failing test: `quantbook V2.3 ... V2.8 closure: production cdylib without
  BlockingTransportFixture` — needs a production cdylib variant; unrelated to FE. NOT a finding.
- `cellGridHtml.ts` is dead (no live caller) but kept in-tree with ~60 test refs — its retirement is a
  KNOWN deferred cleanup. You may assess RISK of keeping it, but "it's dead code" alone is known.
- `dist/webview` is gitignored (built artifact, intentional).
- The webview esbuild build is run via `npm run build:webviews:quantbook` on the MAC host (esbuild is
  darwin-native; the Linux VM has a wrong-platform binary). It is intentionally NOT chained into `tsc compile`.

## Your output
Write your full findings to `docs/fe/2026-06-03-fe-megaudit/<LANE-ID>.md` (you'll be told your lane id),
structured by severity (HIGH / MEDIUM / LOW) with `file:line`, concrete failure, and minimal fix. Then
return a SHORT summary as your final message: your lane id, a one-line verdict, counts (H/M/L), and the
1-line titles of your HIGHs + top MEDs. Keep the returned summary under ~400 words; the detail goes in the file.
