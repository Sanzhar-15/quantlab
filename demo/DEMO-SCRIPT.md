# Quantbook demo script (2026-06-10)

## Pre-demo checklist (do BEFORE anyone is watching)

1. **Switch the IDE to a light theme** (Cmd+K Cmd+T → "Default Light Modern" or similar).
   The whole sheets webview is theme-aware; on a light theme it reads exactly like Google
   Sheets. Dark themes work but look less like the spreadsheet apps people know.
2. The app must be running the relaunched build (the conductor relaunches it at the end of
   the prep session; if in doubt, use the relaunch recipe in `.plans/active/demo-prep.md` §5).
3. Rehearse every beat below once. If a beat misbehaves, cut it from the demo — do not
   improvise un-rehearsed features live.

## Beat 1 — "This is a spreadsheet" (the FE headline)

- Command palette → **"Quantbook: Open Cell Grid"**.
- A real workbook opens: menu bar (File/Edit/View/Insert/Format), toolbar, formula bar,
  canvas grid, and bottom sheet tabs **Returns | Prices | Scratch | +**.
- The **Returns** sheet already tells the quant story: a year of monthly returns
  (percent-formatted) and a live metrics block — **Sharpe, Avg return, Volatility,
  Best/Worst month, Total** — all computed by the native engine.

## Beat 2 — Reactivity (the wow moment)

- Click a return cell (e.g. B5), type a big number like `0.15`, press Enter.
- **Sharpe / Volatility / Best month / Total all recalc instantly.** Point at them.
- Press the toolbar **Undo** — everything snaps back. Redo works too.

## Beat 3 — Quant functions live (Scratch sheet)

- Click the **Scratch** tab. Type into a cell: `=SHARPE(Returns!B2:B13)` — wait, cross-sheet
  ranges are NOT rehearsed; instead seed a few numbers in A1:A5 and type `=AVERAGE(A1:A5)`.
- Better rehearsed beat: start typing `=SU` → the **autocomplete dropdown** appears →
  pick SUM → `=SUM(A1:A5)` → Enter. The formula bar shows the formula, the cell the value.
- Mention: 250+ Excel functions plus native quant functions (SHARPE, MAX_DRAWDOWN) — show
  the **Prices** tab: Max drawdown is computed right there on the price column.

## Beat 4 — It behaves like Excel

- Select the price column numbers (drag B2:B13 on Prices), then **Format → Currency** (menu
  bar) or the toolbar `$` button — the column reformats.
- Right-click a row → **Insert row above** — the rows shift, formulas re-point (this is the
  engine's structural editing, fully audited). Or use the toolbar insert dropdown.
- Click a cell mid-sheet (e.g. B5) → **View → Freeze panes** — scroll: headers stay pinned.
  (View → Unfreeze panes to undo.)
- Sheet tabs: click **+** to add a sheet; double-click a tab to rename it.

## Beat 5 — Graphing data

Option A (interactive builder — the impressive one):
- In the Explorer, right-click **`demo/portfolio.csv`** → "Open With…" → **Visualise**.
- The chart builder opens; build a line chart of `close` over `date` (drag fields onto
  shelves). REHEARSE this — the exact shelf gestures are muscle memory.

Option B (code-driven chart view):
- Open **`demo/portfolio_chart.py`** → press **Ctrl+Q Shift+C** ("Open as Chart") → pick
  `demo/portfolio.csv` as the data source → portfolio curve + SMA(10)/SMA(30) overlays.

## What WORKS since round 5 (demo these — they are real)

- Toolbar styling: **Bold / Italic / Underline / Strikethrough / Align L-C-R / Text color /
  Fill color** — select cells, click, they paint live on the grid. NOTE the honest boundary:
  styling is **session-scoped** (survives a webview reload, NOT an app relaunch; it is not
  saved into the workbook file yet — that engine work is FE-4/FE-5). Don't promise file
  persistence on stage.
- **Find**: Ctrl/Cmd+F or the toolbar Search button → in-sheet find bar (Enter / Shift+Enter
  steps matches, Esc closes).
- **OS clipboard**: copy a range → paste into Excel/Sheets/Numbers (TSV of display values);
  paste TSV from another app into the grid. (A cut pastes ONCE, like Excel.)

## What WORKS since FE-4 (2026-06-10 — these are real, via menu/keyboard NOT the toolbar buttons)

- **Replace-All**: **Ctrl/Cmd+H** → workbook find/replace (formula cells matched on value are listed but
  NOT clobbered unless "in formulas" is on; modal confirm before applying).
- **Sort a range**: select a rect → **right-click → "Sort Range A→Z / Z→A"** (or the palette). REFUSES
  (loud, no writes) if any cell in the rect is a formula — so it never silently corrupts. Number-formats do
  not travel with sorted rows yet (FE-5).
- **Define Name**: select a range → **palette "Quantbook: Define Name…"** or **right-click → Define Name**
  (this was palette-invisible until the `ca0fadd9e23` fix — confirm it shows). Define only; no manager yet.
- **Fill**: **Ctrl/Cmd+D** (down) / **Ctrl/Cmd+R** (right) over a selection — formulas translate their refs.
- **F4** in the formula editor cycles a ref's `$` anchors (`A1→$A$1→A$1→$A1`).

## DO NOT touch during the demo (preview-only; they show a small toast)

- Toolbar **buttons**: **borders / merge / wrap / vertical-align / font selects / filter / zoom /
  decimals / paint-format / print** — clicking shows a neutral "not available in this preview" toast
  (engine-greenfield; FE-5). NOTE: the toolbar **sort** button is also a preview toast, but sort itself
  WORKS via the right-click menu (above) — use that, not the toolbar button, on stage.
- Column/row **resize** is not wired (the resize cursor was removed on purpose).
- Don't switch sheets while a cell editor is open (guarded, but don't tempt it).
- Don't use cross-sheet references in formulas unless rehearsed.

## If something goes wrong

- Webview looks stuck/odd → **Cmd+R** (Developer: Reload Window). The grid re-handshakes
  and repaints from the engine; data is never lost (it lives in the session).
- Grid shows stale values after an op → command palette → "Quantbook: Refresh Cell Grid".
- Check the smoke log for errors: `tail -f ~/quantlab-smoke.log` (filter for Uncaught/TypeError).
