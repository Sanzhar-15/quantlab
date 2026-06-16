/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2-0 (2026-06-03) -- bundled sheets webview entry: A1 spreadsheet grid.**
 *
 * Supersedes the FE-0b cell-LIST. The sheet snapshot (sparse populated cells) is painted as a real
 * A1 grid by {@link CanvasGridRenderer} (column-letter band, row-number gutter, corner, gridlines,
 * values, selection box); geometry comes from the pure `gridLayoutA1.ts`. ANY cell -- populated or
 * empty -- is selectable + editable (the host write path is coordinate-addressed, so editing an
 * empty cell creates it). Editing uses a DOM-overlay `<input>` positioned over the active cell.
 * Keyboard: arrows / Tab move the selection; type / F2 / Enter-while-editing drive editing.
 *
 * Layout: a scroller (`#sheets-viewport`, overflow:auto) holds an in-flow `#sheets-spacer` sized to
 * the FULL Excel extent (drives the native scrollbars), an absolute `<canvas>` transformed by the
 * scroll offset to overlay the viewport (redrawn on scroll), and an absolute `#sheets-edit-input` in
 * the scroller's CONTENT layer (so it tracks scroll naturally).
 *
 * **Paint paths** (FE-2-0 Phase 3): a scroll takes the blit fast path ({@link scrollRedraw} -> the
 * renderer's `drawScroll`); a commit `render` / failed `errorReply` damages only the changed A1 rows
 * (`diffSnapshotsA1` / `errorRowsFlippedA1` -> the renderer's `drawDamage`); nav / type / resize / theme
 * full-`redraw()`. The pure blit + damage math lives in `gridBlitA1.ts`; a full redraw is always the
 * correct fallback (taken whenever the pure math declines, or the scroll/size changed since last paint).
 *
 * Wire protocol (**FE-2-0 Phase 2 commit-token** added a per-commit ack; the host `cellGridPanel.ts` +
 * `cellGridLogic.ts` changed to match -- the webview's local message interfaces here MUST stay in sync):
 *   host -> webview: `{type:'render', snapshot}`,
 *                    `{type:'errorReply', sheet,row,col,code,message, commitId?, webviewId?}`,
 *                    `{type:'commitResult', commitId, ok:true, webviewId?}` (Phase 2 -- success ack to THIS panel).
 *   webview -> host: `{type:'putValue', sheet,row,col,rawInput, commitId?, webviewId?}` (Phase 2 -- the token),
 *                    `{type:'undo'}`, `{type:'redo'}`, `{type:'webviewReady'}` (once on load),
 *                    `{type:'toolbarCommand', command}` / `{type:'toolbarCommand', command:'setNumberFormat', preset}`
 *                    (demo-prep 2026-06-10 -- the menu bar + wired toolbar; the host `cellGridPanel.ts` routes
 *                    these to the freeze / structural / save-open / number-format commands).
 *   `webviewId` (megaudit 2026-06-09) is this webview's per-load instance id, echoed by the host so a stale
 *   PRE-reload `commitResult`/`errorReply` is dropped (its reused commitId would otherwise hit a fresh edit).
 *   Resolution: a pending edit closes ONLY on a matching `commitResult`/`errorReply` (by commitId, same
 *   `webviewId`) or the commit-watchdog timeout -- NEVER on a bare `render` (so a sibling render can't false-ack).
 *
 * Side-effecting entry (no top-level exports) so the esm bundle loads via a classic `<script>`.
 */

import type { CellAddrJson, DiagnosticJson, FunctionMetadataJson, NamedRangeJson, NamedRangeTargetJson, NamedTargetJson, QuantbookCellSnapshot } from '../../src/quantbook/types';
import { matchNameForSelection } from '../../src/quantbook/shared/nameMatch';
import { buildRefText, canPointAtRange, insertRefAtCaret, type RefSpan } from '../../src/quantbook/shared/formulaRangePick';
import { clampDisplayString, formatCellValue } from './cellRender';
import {
	buildSignatureLabel,
	extractCompletionPrefix,
	filterFunctions,
	findSignatureContext,
	moveActiveIndex,
	type CompletionFunction,
	type CompletionItem,
} from './formulaIntel';
import { CanvasGridRenderer, type ActiveCell, type PublishedRange } from './canvasGrid';
// Icon overhaul (2026-06-10): every toolbar/menu glyph is a Google Material Symbols outlined icon
// (the design system Google Sheets itself uses) -- see icons.ts for the Apache-2.0 attribution +
// the normalization rules. The old hand-drawn 16px SVGs are gone.
import { ICONS } from './icons';
import { staleTintKeysA1 } from './gridBlitA1';
import { pasteAreaMismatch, planFill, planPaste, type GridClipboard } from './clipboardLogic';
// FE-4 keyboard STATE MACHINE: the pure key->action dispatcher (nav/range/edit/formula). The document
// keydown + onEditKeydown classify through this; the imperative layer below executes the actions.
import { gridKeyDispatch, type GridMode, type KeyModifiers } from './gridKeyDispatch';
// FE-4 F4: pure abs/rel ref-cycle helper (A1 -> $A$1 -> A$1 -> $A1 -> A1) for the formula editor.
import { cycleRefAbsRel } from './f4Logic';
// FE-5 W-R (2026-06-12): the engine is the SOLE style source -- this module is now just the engine-style
// render RESOLVER (the retired session `CellStyleStore` + its persistence are gone). The webview resolves
// each cell's engine `styleId` against the snapshot `styles[]` via `resolveCellStyle` and paints it.
import { resolveCellStyle, type ResolvedCellStyle } from './cellStyleModel';
// Sheet-tabs (2026-06-10): the Excel-style bottom tab strip (presentation only; the host owns mutation).
import { renderSheetTabs, type SheetTabHandlers, type SheetTabInfo } from './sheetTabBar';
// W3 (Wave 3): the pure data-vscode-context payload builder for the native right-click context menu.
import { buildCellContextPayload, buildEmptyContextPayload } from './contextMenuPayload';
import { RenderOrchestrator, type RenderHost, type Viewport } from './renderOrchestrator';
import {
	COL_WIDTH,
	HEADER_HEIGHT,
	MAX_COLS,
	MAX_ROWS,
	ROW_HEIGHT,
	cellContentRect,
	cellRefA1,
	colX,
	frozenColsWidth,
	frozenRowsHeight,
	hitTestViewportFrozen,
	isInExtent,
	publishedNameAt,
	type SelectionRect,
	rowY,
	scrollToReveal,
	selectionRect,
	totalContentHeight,
	totalContentWidth,
} from './gridLayoutA1';

/**
 * **FE-2-0 Phase 1 (C1-MED6, 2026-06-03)** -- client mirror of the host's `MAX_RAW_INPUT_LENGTH`
 * (`cellGrid/cellGridLogic.ts`, kept in sync). The host rejects an over-length `putValue.rawInput`,
 * but we block it BEFORE `postMessage` so a multi-MB payload is never serialized across the bridge
 * (a tampered/buggy editor). On hit we surface a visible error and keep the editor open for the user
 * to shorten -- No-Fallbacks: the bad input is rejected loudly, never silently truncated or dropped.
 */
const MAX_RAW_INPUT_LENGTH = 8192;

/** Minimal VS Code webview API surface (mirrors qviz-spec/index.ts). */
interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

// host -> webview: `{ type: 'render', snapshot }` (the snapshot is validated by `isValidSnapshot`
// at the message boundary before it is applied -- see the message handler below).

/** host -> webview: a failed edit; decorate the offending cell. */
interface ErrorReplyMessage {
	readonly type: 'errorReply';
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
	readonly code: string;
	readonly message: string;
	/** FE-2-0 Phase 2: the commitId of the failed putValue (echoed by the host), so we un-stick exactly
	 * the originating edit. Absent for a non-tokened error. */
	readonly commitId?: number;
	/** megaudit (webview-instance token, 2026-06-09): the originating webview's instance id (echoed by the
	 * host). A reply whose id is present-but != this webview's WEBVIEW_ID is a stale PRE-reload reply and is
	 * dropped before un-stick/tint (the numeric commitId resets on reload and could otherwise collide). */
	readonly webviewId?: string;
}

/** host -> the originating webview: success ack for a tokened commit (FE-2-0 Phase 2 commit-token). */
interface CommitResultMessage {
	readonly type: 'commitResult';
	readonly commitId: number;
	readonly ok: true;
	/** megaudit (webview-instance token, 2026-06-09): the originating webview's instance id (echoed); a
	 * present-but-mismatched id is a stale PRE-reload ack and is dropped before resolvePendingCommit. */
	readonly webviewId?: string;
}

/**
 * host -> the originating webview: the cells a SUCCESSFUL putCells (paste/fill) wrote (megaudit
 * webview-instance token, 2026-06-09). The webview clears each cell's error tint even when stored content
 * did not change. `webviewId` is echoed from the request so a stale post-reload report is dropped; `sheet`
 * scopes the clear to the current sheet. Only success produces this -- a failed putCells reports nothing.
 */
interface CellsWrittenMessage {
	readonly type: 'cellsWritten';
	readonly sheet: number;
	readonly cells: readonly { readonly row: number; readonly col: number }[];
	readonly webviewId?: string;
}

// Cache the VS Code API handle on `window`: acquireVsCodeApi() may be called at most ONCE per
// webview context and throws on a second call (the persistent webview could re-evaluate this bundle).
type SheetsWindow = Window & { __sheetsVscodeApi?: VSCodeApi };
const vscode: VSCodeApi = (window as SheetsWindow).__sheetsVscodeApi ?? acquireVsCodeApi();
(window as SheetsWindow).__sheetsVscodeApi = vscode;

// --- Persistent skeleton (built once). ---
const root = document.getElementById('sheets-root');
if (root === null) {
	throw new Error('sheets-webview: #sheets-root missing from DOM');
}
root.innerHTML =
	'<h2 id="sheets-title">Quantbook Cell Grid</h2>' +
	'<div class="meta" id="sheets-meta"></div>' +
	// Demo-prep (2026-06-10) + menu breadth (toolbar-quality overhaul): the Google-Sheets-style MENU
	// BAR -- the very top row, above the toolbar. Six menus, ONLY functional items (no dead entries):
	// File (save/open), Edit (undo/redo + the clipboard quartet, reusing the context menu's guarded
	// webview actions), View (freeze/unfreeze), Insert (rows/cols + new sheet), Format (number-format
	// presets), Data (the wave-3 Dependencies + Live Python sidebars, via the host bridge's
	// view-reveal commands). A 'Help' menu was DELIBERATELY not added: its only candidate item (a
	// function-list command) does not exist host-side, and a menu of dead entries is worse than no
	// menu (No-Fallbacks). The dropdown panel is built lazily in JS (one shared component with the
	// toolbar dropdowns); the buttons here are just the always-visible bar. ARIA: menubar/menuitem
	// here, menu/menuitem on the dropdown. Buttons never steal focus from the grid (mousedown
	// preventDefault in the delegated handler).
	'<div id="sheets-menubar" class="cell-grid-menubar" role="menubar" aria-label="Spreadsheet menu bar">' +
	'<button type="button" class="qb-menu-btn" data-menu="file" role="menuitem" aria-haspopup="true" aria-expanded="false">File</button>' +
	'<button type="button" class="qb-menu-btn" data-menu="edit" role="menuitem" aria-haspopup="true" aria-expanded="false">Edit</button>' +
	'<button type="button" class="qb-menu-btn" data-menu="view" role="menuitem" aria-haspopup="true" aria-expanded="false">View</button>' +
	'<button type="button" class="qb-menu-btn" data-menu="insert" role="menuitem" aria-haspopup="true" aria-expanded="false">Insert</button>' +
	'<button type="button" class="qb-menu-btn" data-menu="format" role="menuitem" aria-haspopup="true" aria-expanded="false">Format</button>' +
	'<button type="button" class="qb-menu-btn" data-menu="data" role="menuitem" aria-haspopup="true" aria-expanded="false">Data</button>' +
	'</div>' +
	'<div class="sheets-error" id="sheets-error" role="alert" hidden></div>' +
	// UI-parity (2026-06-10) + toolbar-quality overhaul: an Excel/Google-Sheets-style top toolbar
	// rebuilt to SHEETS' OWN inventory, grouping, and order, with Material Symbols glyphs (icons.ts)
	// throughout -- the operator's demo requirement is that the chrome READS like Sheets. WIRED
	// controls: undo/redo (native webview messages), fmt-currency/fmt-percent + the '123' number-
	// format dropdown ('toolbarCommand' setNumberFormat -- the dropdown replaced the old native
	// <select>, unifying the look AND deleting the select's special-case focus machinery), freeze
	// ('toolbarCommand' freezePanes), insert/delete (anchored dropdowns -> the structural
	// 'toolbarCommand's), the sigma functions dropdown (opens the in-cell editor on the active
	// cell prefilled '=FN(' -- see startFunctionInsert), and -- since round 5 (2026-06-10) -- the
	// REAL client-side style controls (B/I/U/S, align L/C/R, text/fill color via the swatch popover;
	// see cellStyleModel) plus Search (the in-sheet find bar). The remainder (print, paint-format,
	// zoom, the decimal pair, font family/size, borders, merge, vertical-align, wrap, filter, sort)
	// is PREVIEW-ONLY: the default arm shows a neutral toast (notifyPreviewOnly) -- the round-5 audit
	// killed the former silent no-op. Buttons carry a `data-cmd` the delegated click handler reads;
	// dropdown anchors carry aria-haspopup/-expanded.
	'<div id="sheets-toolbar" class="cell-grid-toolbar" role="toolbar" aria-label="Spreadsheet toolbar">' +
	'<button type="button" class="cgt-btn" data-cmd="undo" title="Undo (Ctrl+Z)">' + ICONS.undo + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="redo" title="Redo (Ctrl+Y)">' + ICONS.redo + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="print" title="Print">' + ICONS.print + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="paint-format" title="Paint format">' + ICONS.format_paint + '</button>' +
	'<span class="cgt-sep"></span>' +
	// Zoom: Sheets keeps it here, right of the history group. Visual-only ('100%' is the resting
	// label, not live state -- the webview has no zoom model yet).
	'<button type="button" class="cgt-btn cgt-text cgt-zoom" data-cmd="zoom" title="Zoom">100%<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<span class="cgt-sep"></span>' +
	// Number formats: $ and % are WIRED one-click presets (the same setNumberFormat contract as the
	// '123' dropdown); the decimal pair is visual-only (the engine has no per-cell decimal nudge yet).
	'<button type="button" class="cgt-btn" data-cmd="fmt-currency" title="Format as currency">' + ICONS.attach_money + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="fmt-percent" title="Format as percent">' + ICONS.percent + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="decimal-decrease" title="Decrease decimal places">' + ICONS.decimal_decrease + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="decimal-increase" title="Increase decimal places">' + ICONS.decimal_increase + '</button>' +
	// The '123' number-format menu (Sheets' iconic control), WIRED: the shared anchored dropdown
	// (same component as the menubar + insert/delete) whose items post the 6 engine preset ids
	// through the chrome guard. NO 'Scientific' -- the engine preset list does not have it, so
	// offering it would be a dead entry (No-Fallbacks: never offer an action that cannot land).
	'<button type="button" class="cgt-btn cgt-text" data-cmd="numfmt" title="More number formats" aria-haspopup="true" aria-expanded="false">123<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<span class="cgt-sep"></span>' +
	// Font family + size: visual-only (font styling is FE-4/FE-5 engine work); the resting labels
	// mirror Sheets' defaults so the bar reads complete.
	'<button type="button" class="cgt-btn cgt-text cgt-font" data-cmd="font-family" title="Font">Default (Arial)<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<button type="button" class="cgt-btn cgt-text cgt-fontsize" data-cmd="font-size" title="Font size">10</button>' +
	'<span class="cgt-sep"></span>' +
	'<button type="button" class="cgt-btn" data-cmd="bold" title="Bold">' + ICONS.format_bold + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="italic" title="Italic">' + ICONS.format_italic + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="underline" title="Underline">' + ICONS.format_underlined + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="strikethrough" title="Strikethrough">' + ICONS.strikethrough_s + '</button>' +
	'<span class="cgt-sep"></span>' +
	'<button type="button" class="cgt-btn" data-cmd="text-color" title="Text color">' + ICONS.format_color_text + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="fill-color" title="Fill color">' + ICONS.format_color_fill + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="borders" title="Borders">' + ICONS.border_all + '</button>' +
	'<span class="cgt-sep"></span>' +
	'<button type="button" class="cgt-btn" data-cmd="merge" title="Merge cells">' + ICONS.cell_merge + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="align-left" title="Align left">' + ICONS.format_align_left + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="align-center" title="Align center">' + ICONS.format_align_center + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="align-right" title="Align right">' + ICONS.format_align_right + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="vertical-align" title="Vertical align">' + ICONS.vertical_align_bottom + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="wrap" title="Text wrapping">' + ICONS.wrap_text + '</button>' +
	'<span class="cgt-sep"></span>' +
	'<button type="button" class="cgt-btn" data-cmd="freeze" title="Freeze panes at selection">' + ICONS.splitscreen + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="insert" title="Insert row/column" aria-haspopup="true" aria-expanded="false">' + ICONS.add_row_below + '<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<button type="button" class="cgt-btn" data-cmd="delete" title="Delete row/column" aria-haspopup="true" aria-expanded="false">' + ICONS.delete + '<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<span class="cgt-sep"></span>' +
	// The sigma Functions menu, WIRED: each item opens the in-cell editor on the active cell
	// prefilled with '=FN(' (caret at the end, ready for the range) -- see startFunctionInsert.
	'<button type="button" class="cgt-btn" data-cmd="functions" title="Functions" aria-haspopup="true" aria-expanded="false">' + ICONS.functions + '<span class="cgt-dd">' + ICONS.arrow_drop_down + '</span></button>' +
	'<button type="button" class="cgt-btn" data-cmd="filter" title="Create a filter">' + ICONS.filter_alt + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="sort" title="Sort range">' + ICONS.swap_vert + '</button>' +
	'<button type="button" class="cgt-btn" data-cmd="search" title="Find in sheet">' + ICONS.search + '</button>' +
	'</div>' +
	// W-G formula bar: a name box (the active cell's A1 ref) + a field showing that cell's UNDERLYING
	// content (a formula with its leading '=', or the raw literal) -- so selecting a computed cell reveals
	// its formula. W-G-1b: the field is EDITABLE -- focusing it enters an edit (the `readonly` attr is the
	// display-mode default; `beginEditFormula` clears it). Enter commits through the SAME commit machinery
	// as the in-cell editor (single writer); Esc reverts.
	'<div class="cell-grid-formula-bar" id="sheets-formula-bar">' +
	// FE-11: the name box is EDITABLE (Excel's name box) -- `readonly` by default (display: the active
	// cell's A1 ref); focusing it enters an edit. Enter submits (go to a name/ref, or define a name over the
	// selection); Esc/blur reverts. It is a SELF-CONTAINED input -- NOT part of `editState` (it never writes a
	// cell), so it can never be committed-as-a-cell; its only tie to the cell editor is resolving an open one
	// when it takes focus (see the name-box listeners + `resolveEditForNativeSurface`).
	'<input type="text" class="cell-grid-name-box" id="sheets-name-box" readonly spellcheck="false" ' +
	'autocomplete="off" autocorrect="off" autocapitalize="off" ' +
	'aria-label="Name box -- type a defined name or a cell reference like B5 or Sheet2!C3 and press Enter to go there, or select a range and type a new name to define it" ' +
	'title="Name box -- go to a name or reference, or define a name over the selection" />' +
	// FE-11: the name box dropdown -- Excel's "pick a defined name" control. Opens the host Go-To-Name QuickPick
	// (lists every go-to-able name); reuses the existing command via the toolbar bridge (no new data flow).
	'<button type="button" class="cell-grid-name-box-dd" id="sheets-name-box-dropdown" title="Go to a defined name" aria-label="Go to a defined name">' + ICONS.arrow_drop_down + '</button>' +
	// W-G bound-cell name display: an always-visible chip naming the reactive variable that drives the
	// active cell (shown only when the active cell is a published target; `hidden` otherwise).
	'<span class="cell-grid-published-chip" id="sheets-published-chip" hidden></span>' +
	// UI-parity: the Excel/Sheets "fx" function marker just left of the formula input.
	'<span class="cell-grid-fx" aria-hidden="true">fx</span>' +
	'<input id="sheets-formula-input" class="cell-grid-formula-input" type="text" readonly ' +
	'aria-label="Formula bar (selected cell contents)" spellcheck="false" autocomplete="off" ' +
	'autocorrect="off" autocapitalize="off" aria-autocomplete="list" aria-expanded="false" ' +
	'aria-controls="sheets-formula-suggest" />' +
	// W2 formula intelligence: the function-completion dropdown (populated + positioned in JS; hidden by
	// default). A listbox of candidate function names, keyboard-navigable; Enter/Tab inserts the name + '('.
	'<ul id="sheets-formula-suggest" class="cell-grid-formula-suggest" role="listbox" ' +
	'aria-label="Function suggestions" hidden></ul>' +
	'</div>' +
	// W2 formula intelligence: a subtle line UNDER the bar that shows either the inline validation error
	// (parse/bind diagnostic from the engine) or the signature hint (the function's parameter list when the
	// caret is inside FN(...) ). Hidden when there is nothing to show. role=status so a screen reader
	// announces a new validation message without stealing focus.
	'<div id="sheets-formula-hint" class="cell-grid-formula-hint" role="status" hidden></div>' +
	'<div class="cell-grid-viewport" id="sheets-viewport" tabindex="0">' +
	'<div id="sheets-spacer"></div>' +
	'<canvas id="sheets-canvas"></canvas>' +
	'<input id="sheets-edit-input" class="cell-edit-input" type="text" aria-label="Edit cell value" ' +
	'spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" hidden />' +
	'</div>' +
	// Sheet-tabs (2026-06-10): the Excel-style bottom tab strip, a sibling BELOW the viewport. Painted by
	// `renderSheetTabs` from the host's `render` payload (sheets + activeSheet); empty until the first render.
	'<div id="sheets-tab-bar" class="cell-grid-tab-bar" role="tablist" aria-label="Sheets"></div>';

const titleEl = document.getElementById('sheets-title') as HTMLElement;
const metaEl = document.getElementById('sheets-meta') as HTMLElement;
const errorEl = document.getElementById('sheets-error') as HTMLElement;
const nameBoxEl = document.getElementById('sheets-name-box') as HTMLInputElement;
const publishedChipEl = document.getElementById('sheets-published-chip') as HTMLElement;
const formulaInputEl = document.getElementById('sheets-formula-input') as HTMLInputElement;
const viewportEl = document.getElementById('sheets-viewport') as HTMLElement;
// Sheet-tabs (2026-06-10): the bottom tab strip container (painted by `applySheetTabs` on each render).
const tabBarEl = document.getElementById('sheets-tab-bar') as HTMLElement;
// UI-parity (2026-06-10) + demo-prep wiring: the top toolbar and the menu bar above it. The wired
// controls post the HOST CONTRACT message `{type:'toolbarCommand', command}` (or `{..., command:
// 'setNumberFormat', preset}`); the host `cellGridPanel.ts` owns the receiving side. The remaining
// style buttons stay visual-only (engine-greenfield, FE-4/FE-5) -- deliberately NO handler, so a
// click is a quiet no-op, never a console error.
const toolbarEl = document.getElementById('sheets-toolbar') as HTMLElement;
const menubarEl = document.getElementById('sheets-menubar') as HTMLElement;

// ============================================================================================
// Demo-prep (2026-06-10) -- MENU BAR + shared anchored dropdown + toolbar command wiring.
//
// One dropdown COMPONENT serves both surfaces: the Google-Sheets-style menu bar (File / Edit /
// View / Insert / Format / Data) and the toolbar's anchored mini-menus (insert/delete, the '123'
// number-format picker, and the sigma Functions menu -- the latter two added by the toolbar-quality
// overhaul, 2026-06-10). The
// panel is a single lazily-created `position:fixed` element on document.body (the same pattern as
// sheetTabBar.ts's right-click menu), positioned under its anchor, dismissed on click-away /
// Escape / window blur, and rebuilt per open (the item lists are static, so there is no state to
// preserve). ARIA: the panel is role=menu, items role=menuitem; the anchor's `aria-expanded`
// tracks open/close.
//
// FOCUS MODEL (the "buttons must not steal persistent focus" requirement): every mousedown on a
// menubar button, toolbar button, or dropdown item is preventDefault-ed, so keyboard focus stays
// wherever it was (normally #sheets-viewport -- possibly an OPEN cell/formula editor) for the whole
// interaction. Because no blur ever fires, EVERY chrome ACTION must route through
// `runAfterResolvingEdit` (the Codex demo-blocker guard below the commit machinery), which resolves
// any open editor FIRST and then owns the focus hand-back: the grid viewport when the action ran,
// the still-open editor when the action queued behind / was blocked by that editor's commit -- or
// the FRESH editor the action itself opened (the sigma Functions items open the in-cell editor
// prefilled '=FN('; see the guard's doc). The toolbar-quality overhaul (2026-06-10) removed the
// one historical exception: the native number-format <select> (which had to TAKE focus to open its
// picker, and carried its own mousedown gate for it) is now the '123' shared dropdown, so EVERY
// toolbar control preventDefaults its mousedown and the chrome never steals focus, full stop. The
// formula-suggest dropdown (renderCompletion) uses
// the same mousedown-preventDefault pattern; the sheet-tab strip's buttons do not (a tab click may
// move real focus -- the strip sits below the grid and a switch re-renders anyway), but the strip's
// MUTATING commands are nonetheless guarded: every handler in `sheetTabHandlers` except `switchTo`
// wraps its post in `runAfterResolvingEdit` (Codex r3 fix-verify HIGH), and `switchTo` runs the
// same resolver via `requestSheetSwitch`.
//
// KEYBOARD: while a dropdown is open, a capture-phase document keydown owns the keys BEFORE the
// grid's bubble-phase nav handler (focus is still on the viewport, so without the capture gate an
// ArrowDown would move the grid selection under an open menu): Escape closes (and re-focuses the
// grid), Up/Down move the highlight (wrapping, via the same pure `moveActiveIndex` the formula
// completion uses), Home/End jump, Enter/Space activate, Left/Right step between menu-bar menus
// (menubar-opened panels only). Any OTHER key closes the menu and falls through to the grid
// handler (type-to-edit etc. behave as if the menu were never open).
// ============================================================================================

/** The host-contract command ids (cellGridPanel.ts implements the receiving side; keep in sync).
 * `showDepGraph`/`showLivePython` (menu breadth, 2026-06-10) reveal the wave-3 Dependencies /
 * Live Python sidebars via the auto-registered `<viewId>.focus` commands -- see the host
 * whitelist's rationale in cellGridLogic.ts `TOOLBAR_SIMPLE_COMMAND_IDS`. */
type ToolbarCommand =
	| 'freezePanes'
	| 'unfreezePanes'
	| 'insertRowAbove'
	| 'insertRowBelow'
	| 'insertColumnLeft'
	| 'insertColumnRight'
	| 'deleteRow'
	| 'deleteColumn'
	| 'saveAs'
	| 'openWorkbook'
	| 'showDepGraph'
	| 'showLivePython'
	// FE-11: the Data menu's "Name Manager…" / "Go to Name…" + the name box dropdown -- reveal the existing host
	// commands (the host whitelist in cellGridLogic.ts maps these to quantbookNameManager/quantbookGoToName).
	| 'nameManager'
	| 'goToName'
	// FE-8.2: the File menu's "Export to CSV…" -- wires the host quantbookExportCsv command (session.export('csv')).
	| 'exportCsv'
	// FE-Export-XLSX: the File menu's "Export to XLSX…" -- wires quantbookExportXlsx (session.export('xlsx'), whole workbook).
	| 'exportXlsx';

/** The engine's number-format preset ids (the host contract's `setNumberFormat.preset`). There is NO
 * 'Scientific' -- the engine preset list does not have it; offering it would be a dead entry
 * (No-Fallbacks: never offer an action that cannot land). The toolbar-quality overhaul replaced the
 * old native `<select>` with the shared dropdown component, so the runtime membership guard the
 * select needed (`isNumberFormatPreset`) is gone: every picker item now carries a TYPED literal
 * preset straight into {@link postSetNumberFormat}, checked at compile time. */
const NUMBER_FORMAT_PRESETS = ['General', 'Number', 'NumberThousands', 'Currency', 'Percent', 'Date'] as const;
type NumberFormatPreset = (typeof NUMBER_FORMAT_PRESETS)[number];

/** Post a plain toolbar command to the host (the exact contract shape -- no extra fields). */
function postToolbarCommand(command: ToolbarCommand): void {
	vscode.postMessage({ type: 'toolbarCommand', command });
}
/** Post the number-format variant (the contract's only parameterized command). */
function postSetNumberFormat(preset: NumberFormatPreset): void {
	vscode.postMessage({ type: 'toolbarCommand', command: 'setNumberFormat', preset });
}

/** One actionable dropdown entry; `'separator'` draws a thin divider (non-interactive). */
interface MenuItemSpec {
	readonly label: string;
	readonly run: () => void;
}
type MenuEntrySpec = MenuItemSpec | 'separator';

// The toolbar insert/delete mini-menus reuse the same specs the menu bar's Insert menu is built from.
// NOTE (demo-blocker guard, 2026-06-10): every item's `run` here and in MENUBAR_MENUS is the BARE host
// post -- `activateMenuItem` is the ONE seam that routes ALL dropdown/menubar activations through
// `runAfterResolvingEdit` (resolve any open editor first), so no spec wraps itself.
const INSERT_ROW_COL_ITEMS: readonly MenuItemSpec[] = [
	{ label: 'Row above', run: () => postToolbarCommand('insertRowAbove') },
	{ label: 'Row below', run: () => postToolbarCommand('insertRowBelow') },
	{ label: 'Column left', run: () => postToolbarCommand('insertColumnLeft') },
	{ label: 'Column right', run: () => postToolbarCommand('insertColumnRight') },
];
const DELETE_ROW_COL_ITEMS: readonly MenuItemSpec[] = [
	{ label: 'Delete row', run: () => postToolbarCommand('deleteRow') },
	{ label: 'Delete column', run: () => postToolbarCommand('deleteColumn') },
];

// The 6 engine number-format presets, shared by the toolbar's '123' dropdown AND the menubar's
// Format menu (one list, so the two surfaces can never drift). Labels are the user-facing names;
// each run posts the engine's exact preset id. Activation routes through `activateMenuItem` ->
// `runAfterResolvingEdit` like every dropdown item, so no spec wraps itself in the guard.
const NUMBER_FORMAT_MENU_ITEMS: readonly MenuItemSpec[] = [
	{ label: 'General', run: () => postSetNumberFormat('General') },
	{ label: 'Number', run: () => postSetNumberFormat('Number') },
	{ label: 'Number with thousands', run: () => postSetNumberFormat('NumberThousands') },
	{ label: 'Currency', run: () => postSetNumberFormat('Currency') },
	{ label: 'Percent', run: () => postSetNumberFormat('Percent') },
	{ label: 'Date', run: () => postSetNumberFormat('Date') },
];

/**
 * **Sigma Functions menu (toolbar-quality overhaul, 2026-06-10)** -- start a formula edit on the
 * ACTIVE cell prefilled `=FN(` with the caret at the end, ready for the range/arguments. Reuses
 * {@link beginEdit}'s existing type-to-edit entry (its `initialChar` parameter is a plain string
 * prefill -- the single-char name is historical), so the editor opened here is byte-identical to a
 * typed one: same blur-commit baseline (the cell's PRIOR content, so blurring the untouched prefill
 * still commits-or-errors through the normal machinery), same Escape/Enter/commit-token paths, same
 * oversize sentinel. Activation routes through `activateMenuItem` -> `runAfterResolvingEdit`, which
 * resolves any OPEN editor first -- so by the time this runs there is no editor (or the action was
 * queued behind a commit and runs after `resolvePendingCommit` closed it), and `beginEdit`'s M8
 * pending guard cannot decline... but we still VERIFY the editor actually opened rather than assume
 * (No-Fallbacks: a silent no-click would read as a dead menu): `beginEdit` returns void and bails
 * on a null snapshot / an in-flight commit, so a missing editState afterwards is surfaced loud.
 * The caret is then pinned to the end (type-to-edit relies on engine default caret placement for a
 * single char; a multi-char prefill must not gamble on it). The chrome guard's focus logic keeps
 * the keyboard ON this fresh editor (it checks `editState` after the action ran -- see
 * {@link runAfterResolvingEdit}).
 */
function startFunctionInsert(fnName: string): void {
	if (fullSnapshot === null || active === null) {
		// No snapshot yet (the host has not rendered) or no active cell -- there is nothing to edit.
		// Loud, never a silently dead menu item (No-Fallbacks).
		showError('The grid is not ready yet -- select a cell, then pick a function.', 'transient');
		return;
	}
	const prefill = '=' + fnName + '(';
	// Pass the prefill as BOTH the editor's initial value AND its abort-baseline: if the presenter picks a
	// function then clicks/navigates away without completing it, commitEdit aborts rather than writing the
	// incomplete `=SUM(` (which would render a visible #ERROR mid-demo -- round-5 audit stability finding).
	beginEdit(active.row, active.col, prefill, prefill);
	if (editState === null || editState.surface !== 'overlay') {
		// beginEdit declined (a commit raced in between the guard's resolution and this run, or the
		// snapshot vanished). The guard's banners/M8 path own the user-facing story for the race; this
		// console line keeps the decline diagnosable rather than a mystery dead click.
		console.warn('[sheets-webview] function insert "' + fnName + '" could not open the cell editor');
		return;
	}
	// Caret at the END of the prefill (after the '('), so typing continues the argument list.
	editState.editEl.setSelectionRange(prefill.length, prefill.length);
	redraw(); // beginEdit's contract: the CALLER repaints (moves the selection box) -- see its NOTE
}

// The sigma dropdown's items: the 5 Excel staples, then the 2 native quant functions (the wave-1
// engine additions -- the demo's beyond-Excel beat). All open the in-cell editor via
// startFunctionInsert; the function NAMES are the engine's registered ids.
const FUNCTION_INSERT_ITEMS: readonly MenuEntrySpec[] = [
	{ label: 'SUM', run: () => startFunctionInsert('SUM') },
	{ label: 'AVERAGE', run: () => startFunctionInsert('AVERAGE') },
	{ label: 'COUNT', run: () => startFunctionInsert('COUNT') },
	{ label: 'MAX', run: () => startFunctionInsert('MAX') },
	{ label: 'MIN', run: () => startFunctionInsert('MIN') },
	'separator',
	{ label: 'SHARPE', run: () => startFunctionInsert('SHARPE') },
	{ label: 'MAX_DRAWDOWN', run: () => startFunctionInsert('MAX_DRAWDOWN') },
];

// The menu bar's six menus (menu breadth 2026-06-10 added Data; a Help menu was deliberately
// SKIPPED -- its only candidate, a function-list command, does not exist host-side). ONLY
// functional items -- every entry posts a message the host
// implements TODAY (no dead entries that would make the demo look broken). 'New sheet' reuses the
// EXACT message the tab strip's `+` posts (`sheetTabHandlers.add` below: `{type:'sheetCommand',
// command:'add'}`) so both entry points are indistinguishable to the host -- and both run through
// `runAfterResolvingEdit` (this one via `activateMenuItem`, the strip's via its handler wrapper),
// so they share the edit-resolution semantics too.
const MENUBAR_MENUS: ReadonlyArray<{ readonly id: string; readonly entries: readonly MenuEntrySpec[] }> = [
	{
		id: 'file',
		entries: [
			{ label: 'Save As…', run: () => postToolbarCommand('saveAs') },
			{ label: 'Open Workbook…', run: () => postToolbarCommand('openWorkbook') },
			// FE-8.2: data export (CSV), distinct from the .qbook Save above. Single-sheet workbooks only
			// (the engine refuses multi-sheet CSV with a loud error); routed through the same toolbar bridge.
			// FE-Export-XLSX: data export (XLSX) is WHOLE-WORKBOOK (all sheets) -- no single-sheet restriction.
			'separator',
			{ label: 'Export to CSV…', run: () => postToolbarCommand('exportCsv') },
			{ label: 'Export to XLSX…', run: () => postToolbarCommand('exportXlsx') },
		],
	},
	{
		id: 'edit',
		entries: [
			// Undo/redo post the SAME native messages as the toolbar buttons + Ctrl/Cmd+Z|Y (one host path).
			{ label: 'Undo', run: () => vscode.postMessage({ type: 'undo' }) },
			{ label: 'Redo', run: () => vscode.postMessage({ type: 'redo' }) },
			'separator',
			// Menu breadth (2026-06-10): the clipboard quartet reuses EXACTLY the right-click context
			// menu's webview-side actions (`runContextMenuAction` -> copyGridSelection / pasteGridClipboard
			// / clearContextSelection -- the same functions Ctrl/Cmd+C|X|V and Delete drive), so all four
			// entry points are indistinguishable to the grid state. Guarding is inherited: these run via
			// `activateMenuItem` -> `runAfterResolvingEdit`, the SAME guard the host-posted
			// `contextMenuAction` replies route through -- one clipboard path, one edit-race story.
			{ label: 'Cut', run: () => runContextMenuAction('cut') },
			{ label: 'Copy', run: () => runContextMenuAction('copy') },
			{ label: 'Paste', run: () => runContextMenuAction('paste') },
			{ label: 'Clear contents', run: () => runContextMenuAction('clear') },
		],
	},
	{
		id: 'view',
		entries: [
			{ label: 'Freeze panes', run: () => postToolbarCommand('freezePanes') },
			{ label: 'Unfreeze panes', run: () => postToolbarCommand('unfreezePanes') },
		],
	},
	{
		id: 'insert',
		entries: [
			...INSERT_ROW_COL_ITEMS,
			'separator',
			{ label: 'New sheet', run: () => vscode.postMessage({ type: 'sheetCommand', command: 'add' }) },
		],
	},
	{
		id: 'format',
		// The SAME item list as the toolbar's '123' dropdown (one source, no drift).
		entries: NUMBER_FORMAT_MENU_ITEMS,
	},
	{
		id: 'data',
		// Menu breadth (2026-06-10): the wave-3 sidebars. Both are host-side VIEWS (package.json
		// contributes.views, gated `quantbook.hasOpenGrid` -- true here, a grid is open), revealed via
		// the `<viewId>.focus` commands VS Code auto-registers for every contributed view; the host
		// whitelist maps showDepGraph/showLivePython to those exact ids (cellGridLogic.ts). NO other
		// Data items: dep-graph + Live Python are the only genuinely functional candidates today
		// (sort/filter/pivot are engine-greenfield), and dead entries are worse than a short menu.
		entries: [
			{ label: 'Dependencies', run: () => postToolbarCommand('showDepGraph') },
			{ label: 'Live Python', run: () => postToolbarCommand('showLivePython') },
			// FE-11: defined-name management. Both reveal the existing host commands (palette-only before
			// this) via the toolbar-command bridge; they route through `activateMenuItem` ->
			// `runAfterResolvingEdit`, so opening either resolves any open editor first.
			'separator',
			{ label: 'Name Manager…', run: () => postToolbarCommand('nameManager') },
			{ label: 'Go to Name…', run: () => postToolbarCommand('goToName') },
		],
	},
];

/** The open dropdown's state, or null when closed. `menuId` is the menubar menu id, or null for a
 * toolbar-anchored dropdown (Left/Right menu-stepping only applies to menubar panels). `items` is the
 * flattened ACTIONABLE list (separators excluded) in display order; `itemEls` are their buttons (same
 * indexing) for highlight painting; `activeIndex` is the keyboard highlight (-1 = none, the initial
 * state -- like Sheets, nothing is highlighted until hover/arrow). */
interface OpenMenuState {
	readonly anchor: HTMLElement;
	readonly menuId: string | null;
	readonly items: readonly MenuItemSpec[];
	readonly itemEls: readonly HTMLButtonElement[];
	activeIndex: number;
}
// NOTE (the W-G-1b esbuild lesson): these module-level `let`s are only READ inside event callbacks,
// which all fire well after module evaluation -- no pre-init hazard.
let openMenu: OpenMenuState | null = null;
let dropdownEl: HTMLDivElement | null = null;

/** Close the open dropdown (DOM + state + the anchor's open styling/ARIA). Safe when already closed. */
function closeMenuDropdown(): void {
	if (dropdownEl !== null) {
		dropdownEl.remove();
		dropdownEl = null;
	}
	if (openMenu !== null) {
		openMenu.anchor.classList.remove('is-open');
		openMenu.anchor.setAttribute('aria-expanded', 'false');
		openMenu = null;
	}
}

/** Paint the keyboard/hover highlight onto item `idx` (-1 clears). Hover and arrows share this so the
 * two never show competing highlights. */
function setMenuHighlight(idx: number): void {
	if (openMenu === null) {
		return;
	}
	openMenu.activeIndex = idx;
	openMenu.itemEls.forEach((el, i) => {
		el.classList.toggle('is-active', i === idx);
	});
}

/** Activate item `idx`: close FIRST (so a host-triggered re-render never races an open panel), then
 * run the action THROUGH the open-editor guard ({@link runAfterResolvingEdit}) -- the Codex
 * DEMO-BLOCKER fix. This is the ONE seam every dropdown item activates through (toolbar insert/delete
 * mini-menus AND all menubar items: Save As / Open Workbook / Undo / Redo / Freeze / Unfreeze /
 * structural insert-delete / New sheet / Format presets), so a structural command can never execute
 * while a cell/formula editor still holds pre-mutation coordinates. The guard also owns the focus
 * restoration (grid viewport on an immediate run; the still-open editor when the action queued behind
 * / was blocked by its commit) -- the old unconditional `viewportEl.focus()` here is gone because it
 * would have stolen focus from a pending editor the guard deliberately keeps focused. */
function activateMenuItem(idx: number): void {
	if (openMenu === null || idx < 0 || idx >= openMenu.items.length) {
		return;
	}
	const item = openMenu.items[idx];
	closeMenuDropdown();
	runAfterResolvingEdit(item.label, item.run);
}

/**
 * Open (or move) the shared dropdown under `anchor` with `entries`. Replaces any open panel
 * (one-at-a-time, like the tab-strip menu). The panel is `position:fixed` on document.body so it
 * floats over the toolbar/canvas without disturbing the root flex column; after append it is
 * clamped to the window's right edge (a near-edge toolbar anchor must not spill off-screen).
 */
function openMenuDropdown(anchor: HTMLElement, entries: readonly MenuEntrySpec[], menuId: string | null): void {
	closeMenuDropdown();
	const panel = document.createElement('div');
	panel.className = 'qb-menu-dropdown';
	panel.setAttribute('role', 'menu');
	const items: MenuItemSpec[] = [];
	const itemEls: HTMLButtonElement[] = [];
	for (const entry of entries) {
		if (entry === 'separator') {
			const sep = document.createElement('div');
			sep.className = 'qb-menu-sep';
			sep.setAttribute('role', 'separator');
			panel.appendChild(sep);
			continue;
		}
		const idx = items.length;
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'qb-menu-item';
		b.setAttribute('role', 'menuitem');
		b.textContent = entry.label;
		// mousedown preventDefault: keep focus on the grid for the whole interaction (the focus model above).
		b.addEventListener('mousedown', (ev) => {
			ev.preventDefault();
		});
		b.addEventListener('mouseover', () => {
			setMenuHighlight(idx);
		});
		b.addEventListener('click', () => {
			activateMenuItem(idx);
		});
		items.push(entry);
		itemEls.push(b);
		panel.appendChild(b);
	}
	const rect = anchor.getBoundingClientRect();
	panel.style.top = rect.bottom + 2 + 'px';
	document.body.appendChild(panel);
	// Clamp to the window's right edge AFTER append (offsetWidth needs layout). Left edge can't
	// underflow: every anchor sits at x >= the bar padding.
	const left = Math.min(rect.left, Math.max(4, window.innerWidth - panel.offsetWidth - 4));
	panel.style.left = left + 'px';
	dropdownEl = panel;
	openMenu = { anchor, menuId, items, itemEls, activeIndex: -1 };
	anchor.classList.add('is-open');
	anchor.setAttribute('aria-expanded', 'true');
}

/** Open the menubar menu for `btn` (its `data-menu` id). A missing/unknown id is a TEMPLATE bug --
 * surfaced loud (No-Fallbacks), never a silently dead menu. */
function openMenubarMenu(btn: HTMLElement): void {
	const id = btn.getAttribute('data-menu');
	const def = MENUBAR_MENUS.find((m) => m.id === id);
	if (def === undefined) {
		console.error('[sheets-webview] menu bar button has an unknown data-menu id (template bug):', id);
		return;
	}
	openMenuDropdown(btn, def.entries, def.id);
}

// Menu bar: open on MOUSEDOWN (Sheets-feel -- a click-wait feels laggy), toggle-close on the open
// anchor. preventDefault on every mousedown so the buttons never take focus from the grid.
menubarEl.addEventListener('mousedown', (e) => {
	e.preventDefault();
	const btn = (e.target as HTMLElement).closest('.qb-menu-btn') as HTMLElement | null;
	if (btn === null) {
		return;
	}
	if (openMenu !== null && openMenu.anchor === btn) {
		closeMenuDropdown();
		return;
	}
	openMenubarMenu(btn);
});
// Sheets behavior: while a MENUBAR menu is open, hovering a sibling menu button moves the open
// panel there (no click needed). Toolbar-anchored dropdowns (menuId === null) do not hover-move.
menubarEl.addEventListener('mouseover', (e) => {
	if (openMenu === null || openMenu.menuId === null) {
		return;
	}
	const btn = (e.target as HTMLElement).closest('.qb-menu-btn') as HTMLElement | null;
	if (btn === null || btn === openMenu.anchor) {
		return;
	}
	openMenubarMenu(btn);
});

// Click-away dismissal (capture-phase pointerdown, the sheetTabBar pattern). Presses INSIDE the
// panel are left to the item handlers; a press on the OPEN anchor is left to its own toggle logic
// (closing here too would make the anchor's mousedown immediately re-open -- an untoggleable menu);
// a press on a SIBLING menubar button is left to the menubar mousedown (which moves the panel).
document.addEventListener(
	'pointerdown',
	(e) => {
		if (openMenu === null) {
			return;
		}
		const t = e.target;
		if (t instanceof Node) {
			if (dropdownEl !== null && dropdownEl.contains(t)) {
				return;
			}
			if (openMenu.anchor.contains(t)) {
				return;
			}
			if (openMenu.menuId !== null && menubarEl.contains(t)) {
				return;
			}
		}
		closeMenuDropdown();
	},
	true,
);
// A webview losing window focus must not leave a floating panel behind (matches the tab-strip menu).
window.addEventListener('blur', closeMenuDropdown);

// Keyboard ownership while a dropdown is open -- CAPTURE phase so it wins over the grid's
// bubble-phase document nav handler (focus stays on the viewport during the whole interaction, so
// without this an ArrowDown would move the grid selection underneath the open menu).
document.addEventListener(
	'keydown',
	(ev) => {
		if (openMenu === null) {
			return;
		}
		const swallow = (): void => {
			ev.preventDefault();
			ev.stopPropagation();
		};
		switch (ev.key) {
			case 'Escape':
				swallow();
				closeMenuDropdown();
				viewportEl.focus();
				return;
			case 'ArrowDown':
				swallow();
				// The same pure wrap-step the formula completion uses (formulaIntel.moveActiveIndex).
				setMenuHighlight(moveActiveIndex(openMenu.activeIndex, 1, openMenu.items.length));
				return;
			case 'ArrowUp':
				swallow();
				setMenuHighlight(moveActiveIndex(openMenu.activeIndex, -1, openMenu.items.length));
				return;
			case 'Home':
				swallow();
				setMenuHighlight(0);
				return;
			case 'End':
				swallow();
				setMenuHighlight(openMenu.items.length - 1);
				return;
			case 'Enter':
			case ' ':
				swallow();
				if (openMenu.activeIndex >= 0) {
					activateMenuItem(openMenu.activeIndex);
				}
				return;
			case 'ArrowLeft':
			case 'ArrowRight': {
				// Step between menubar menus (wrapping) -- only for a panel opened FROM the menu bar. For a
				// TOOLBAR-anchored dropdown (menuId === null) there are no sibling menus to step to, but the
				// keys must still be SWALLOWED as a no-op (Codex HIGH, 2026-06-10): previously they fell
				// through to the grid's bubble-phase nav handler and moved the SELECTION under the open menu
				// -- exactly the leak this capture-phase gate exists to stop (Up/Down/Home/End above already
				// swallow for both anchor kinds).
				swallow();
				if (openMenu.menuId === null) {
					return;
				}
				const buttons = Array.from(menubarEl.querySelectorAll<HTMLElement>('.qb-menu-btn'));
				const cur = buttons.indexOf(openMenu.anchor);
				if (cur < 0 || buttons.length === 0) {
					return;
				}
				const next = (cur + (ev.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
				openMenubarMenu(buttons[next]);
				return;
			}
			default:
				// Any other key: the menu is no longer what the user is operating -- close it and let the
				// event fall through to the grid handler (type-to-edit etc. behave normally).
				closeMenuDropdown();
				return;
		}
	},
	true,
);

// Toolbar: mousedown preventDefault on the BUTTONS so they never steal focus from the grid. Since
// the toolbar-quality overhaul (2026-06-10) EVERY toolbar control is a `.cgt-btn` -- the old
// number-format <select> (the one control that legitimately took focus, and needed its own
// mousedown gate for it) is now the shared '123' dropdown -- so this blanket preventDefault covers
// the whole bar with no exclusions.
toolbarEl.addEventListener('mousedown', (e) => {
	const btn = (e.target as HTMLElement).closest('.cgt-btn');
	if (btn !== null) {
		e.preventDefault();
	}
});
toolbarEl.addEventListener('click', (e) => {
	const btn = (e.target as HTMLElement).closest('.cgt-btn') as HTMLElement | null;
	if (btn === null) {
		return;
	}
	// Codex DEMO-BLOCKER fix (2026-06-10): every POSTING button below routes through
	// `runAfterResolvingEdit`. The mousedown preventDefault above means clicking chrome NEVER blurs an
	// open cell/formula editor -- so without the guard a command would execute against the host while
	// the editor still held PRE-mutation state, and the editor's LATER blur/commit would post its OLD
	// coordinates into the shifted grid (silent corruption); undo/redo additionally never refocused, so
	// the editor SURVIVED over mutated state. The guard commits/cancels the editor first (or queues the
	// action behind an in-flight commit, dropping it on any failure) and owns the focus restoration --
	// which also gives undo/redo the grid-refocus the other wired buttons already had.
	switch (btn.getAttribute('data-cmd')) {
		case 'undo':
			runAfterResolvingEdit('Undo', () => vscode.postMessage({ type: 'undo' }));
			return;
		case 'redo':
			runAfterResolvingEdit('Redo', () => vscode.postMessage({ type: 'redo' }));
			return;
		case 'fmt-currency':
			runAfterResolvingEdit('number format "Currency"', () => postSetNumberFormat('Currency'));
			return;
		case 'fmt-percent':
			runAfterResolvingEdit('number format "Percent"', () => postSetNumberFormat('Percent'));
			return;
		case 'freeze':
			runAfterResolvingEdit('Freeze panes', () => postToolbarCommand('freezePanes'));
			return;
		case 'numfmt':
			// The '123' number-format menu -- the shared anchored dropdown that REPLACED the old native
			// <select> (toolbar-quality overhaul, 2026-06-10): one dropdown look across the whole chrome,
			// and the select's special-case machinery (its focus-stealing mousedown gate + the hidden
			// '123' placeholder/reset dance) is deleted with it. Toggle semantics + guard inheritance are
			// identical to insert/delete below: OPENING posts nothing, the ITEMS run through
			// `activateMenuItem` -> `runAfterResolvingEdit`.
			if (openMenu !== null && openMenu.anchor === btn) {
				closeMenuDropdown();
			} else {
				openMenuDropdown(btn, NUMBER_FORMAT_MENU_ITEMS, null);
			}
			return;
		case 'functions':
			// The sigma Functions menu (wired): items open the in-cell editor prefilled '=FN(' via
			// startFunctionInsert, through the same activateMenuItem guard seam.
			if (openMenu !== null && openMenu.anchor === btn) {
				closeMenuDropdown();
			} else {
				openMenuDropdown(btn, FUNCTION_INSERT_ITEMS, null);
			}
			return;
		case 'insert':
			// Toggle the anchored mini-menu (same component as the menu bar; menuId null = no hover-move).
			// OPENING a menu posts nothing, so it needs no guard -- the ITEMS go through it on activation
			// (`activateMenuItem`), by which point the editor is resolved exactly once, at the real action.
			if (openMenu !== null && openMenu.anchor === btn) {
				closeMenuDropdown();
			} else {
				openMenuDropdown(btn, INSERT_ROW_COL_ITEMS, null);
			}
			return;
		case 'delete':
			if (openMenu !== null && openMenu.anchor === btn) {
				closeMenuDropdown();
			} else {
				openMenuDropdown(btn, DELETE_ROW_COL_ITEMS, null);
			}
			return;
		// **FE-5 W-R (2026-06-12) / FE-FONT (2026-06-13) -- the toolbar's style controls write to the ENGINE**
		// (the SOLE style source). Each routes through `runAfterResolvingEdit` like every other mutating chrome
		// action (resolve the open editor first), operates on the active selection (or active cell), and POSTs a
		// `setStyle` mutation the host applies via `registerStyle`/`setStyle` + re-renders. Bold/italic/underline/
		// strikethrough toggle with Excel/Sheets semantics (off iff ALL cells already on) -- the host inspects the
		// selection. FE-FONT made the four formerly-dead buttons live: underline/strikethrough are engine boolean
		// toggles, text color opens the same swatch picker as fill (engine `textColor`), and borders opens the
		// border picker (engine per-edge borders -- the FE-only live SET path over the FE-4/FE-5 render).
		case 'bold':
			runAfterResolvingEdit('Bold', () => toggleSelectionStyle('bold'));
			return;
		case 'italic':
			runAfterResolvingEdit('Italic', () => toggleSelectionStyle('italic'));
			return;
		case 'underline':
			runAfterResolvingEdit('Underline', () => toggleSelectionStyle('underline'));
			return;
		case 'strikethrough':
			runAfterResolvingEdit('Strikethrough', () => toggleSelectionStyle('strike'));
			return;
		case 'align-left':
			runAfterResolvingEdit('Align left', () => postStyleMutation({ kind: 'align', value: 'left' }, 'Align left'));
			return;
		case 'align-center':
			runAfterResolvingEdit('Align center', () => postStyleMutation({ kind: 'align', value: 'center' }, 'Align center'));
			return;
		case 'align-right':
			runAfterResolvingEdit('Align right', () => postStyleMutation({ kind: 'align', value: 'right' }, 'Align right'));
			return;
		case 'text-color':
			// **FE-FONT (2026-06-13)**: text color IS now an engine-style attribute (`StyleJson.textColor`),
			// so open the SAME swatch picker as fill -- the chosen swatch POSTs a `setStyle` textColor mutation
			// the host applies + re-renders (the canvas already paints `textColor`). No editor-resolution
			// wrapper here: openColorPicker just opens the popover; the swatch click itself resolves the edit.
			openColorPicker(btn, 'textColor');
			return;
		case 'fill-color':
			// Fill color IS an engine-style attribute -- open the swatch picker; the chosen swatch POSTs a
			// `setStyle` fill mutation the host applies + re-renders.
			openColorPicker(btn, 'fillColor');
			return;
		case 'borders':
			// **FE-FONT (2026-06-13)**: borders are fully engine-backed (FE-4 W4 schema + FE-5 W-R render) --
			// open the border picker (line style + color + edge actions); each edge button POSTs a `border`
			// setStyle mutation the host applies + re-renders. This is the live SET path over the existing render.
			openBorderPicker(btn);
			return;
		case 'search':
			// Round 5: the (previously dead) Search button opens the in-sheet find bar. Round-5 audit
			// (lane B HIGH): it MUST resolve any open editor first like every other chrome control --
			// the toolbar mousedown preventDefault keeps the editor focused through the click, and an
			// unresolved (esp. PENDING) editor would otherwise sit at its old cell while the find jump
			// moves the selection. resolveEditThen directly -- NOT runAfterResolvingEdit -- because its
			// 'ran' focus postlude (viewportEl.focus) would steal the focus openFindBar just gave the
			// find input.
			resolveEditThen({ kind: 'chrome', label: 'Find', run: openFindBar });
			return;
		default:
			// Still visual-only (print / paint-format / zoom / decimal pair / font family+size /
			// merge / vertical-align / wrap / filter / sort): genuinely engine-greenfield or out-of-scope
			// for this preview. Surfaced honestly via a neutral "preview" toast rather than a silent
			// no-op (the round-5 audit's #1 finding -- a click that does nothing reads as fake).
			notifyPreviewOnly(btn.getAttribute('title') ?? 'This control');
			return;
	}
});

// Toolbar-quality overhaul (2026-06-10): the number-format <select> -- and ALL of its special-case
// machinery -- is GONE, replaced by the '123' shared-dropdown anchor handled in the click handler
// above. What was deleted with it, and why it is safe to delete:
//   - the select's mousedown gate (the Codex r3 fix-verify MED): it existed ONLY because a native
//     <select> must TAKE focus to open its picker, which blurred an open editor before the change
//     handler's guard could see it. The dropdown button preventDefaults its mousedown like every
//     other `.cgt-btn` (the blanket toolbar handler above), so the editor is never blurred and the
//     blur-path local-reject hole the gate plugged is structurally unreachable.
//   - the hidden '123' placeholder + reset-after-pick dance (the Codex LOW command-picker fix): a
//     dropdown ITEM fires `activateMenuItem` on every click -- there is no 'change'-only-fires-on-
//     value-CHANGE event model to outsmart, so re-picking the same preset for a new selection just
//     works.
//   - the `isNumberFormatPreset` runtime membership check: dropdown items carry TYPED literal
//     presets straight into postSetNumberFormat (compile-time checked); there is no untyped
//     `select.value` string to validate.
// Guarding is INHERITED, not re-implemented: the items route through `activateMenuItem` ->
// `runAfterResolvingEdit`, the exact seam every menubar/toolbar dropdown item already uses. The
// grid's right-click context menu is now the ONLY native surface, and it keeps
// `resolveEditForNativeSurface` (see its doc -- updated for the select's removal).
const spacerEl = document.getElementById('sheets-spacer') as HTMLElement;
const canvasEl = document.getElementById('sheets-canvas') as HTMLCanvasElement;
const inputEl = document.getElementById('sheets-edit-input') as HTMLInputElement;
// W2 formula intelligence: the completion dropdown (a <ul> listbox) + the hint line (validation error /
// signature). Both are part of the formula bar; populated + toggled by the formula-assist logic below.
const suggestEl = document.getElementById('sheets-formula-suggest') as HTMLUListElement;
const hintEl = document.getElementById('sheets-formula-hint') as HTMLElement;

/**
 * **FE-2-0 Phase 1 (C1-MED3 / C1-MED6, 2026-06-03; re-audit MED-4)** -- the visible in-webview error
 * banner. No-Fallbacks: a bad render / rejected edit is surfaced here (and `console.error`-ed for the
 * render case) -- never silently dropped, never an opaque throw that freezes the grid with no message.
 *
 * The banner has a SOURCE so a valid render cannot HIDE an active edit-validation error (re-audit
 * MED-4): a `'transient'` error (malformed render, un-editable oversize cell) is cleared by the next
 * valid render; an `'edit'` error (the open editor holds an over-length value) is cleared ONLY when
 * that editor resolves -- shortened below the cap, cancelled, or committed -- so a sibling render
 * repainting underneath the editor never masks the still-invalid pending input.
 */
type ErrorSource = 'transient' | 'edit';
let errorSource: ErrorSource | null = null;
function showError(message: string, source: ErrorSource): void {
	// Re-audit finding 4: an active 'edit' banner (the open editor holds an over-length value the user
	// must fix) outranks a 'transient' notice. A malformed render still gets `console.error`-ed at its
	// call site, but it must NOT overwrite the edit banner -- otherwise a later valid render's
	// `clearTransientError()` would clear it and hide the still-invalid pending edit (the MED-4 class).
	if (source === 'transient' && errorSource === 'edit') {
		return;
	}
	errorEl.textContent = message;
	errorEl.hidden = false;
	errorSource = source;
}
function clearError(): void {
	if (!errorEl.hidden) {
		errorEl.hidden = true;
		errorEl.textContent = '';
	}
	errorSource = null;
}
/** Clear only a `'transient'` banner (a valid render supersedes it); preserve an `'edit'` banner. */
function clearTransientError(): void {
	if (errorSource === 'transient') {
		clearError();
	}
}

// **Round 5 (2026-06-10)** -- a subtle, auto-dismissing toast for controls that are intentionally
// preview-only (engine-greenfield / out-of-scope: print, paint-format, borders, merge, wrap, filter,
// sort, font selects, decimals, zoom). Surfaces the gap HONESTLY (No-Fallbacks: never a silent no-op,
// the round-5 audit's #1 finding) while staying unobtrusive -- bottom-right, neutral, fades after ~1.6s,
// one at a time. Distinct from the red `errorEl` banner (reserved for genuine errors / pending-edit).
let previewToastEl: HTMLDivElement | null = null;
let previewToastTimer: ReturnType<typeof setTimeout> | undefined;
function notifyPreviewOnly(label: string): void {
	if (previewToastEl === null) {
		previewToastEl = document.createElement('div');
		previewToastEl.className = 'qb-preview-toast';
		previewToastEl.setAttribute('role', 'status');
		document.body.appendChild(previewToastEl);
	}
	const name = label.replace(/\s*\([^)]*\)\s*$/, '').trim(); // strip a "(Ctrl+...)" suffix from the title
	previewToastEl.textContent = (name.length > 0 ? name : 'This control') + ' is not available in this preview yet.';
	previewToastEl.classList.add('is-visible');
	if (previewToastTimer !== undefined) {
		clearTimeout(previewToastTimer);
	}
	previewToastTimer = setTimeout(() => {
		if (previewToastEl !== null) {
			previewToastEl.classList.remove('is-visible');
		}
	}, 1600);
}

// **Round 5 (2026-06-10) -- global error net (audit finding C1).** The render path is already validated
// (isValidSnapshot + per-entry isRenderableEntry), but ANY uncaught throw in a hot pointer/keyboard
// handler would otherwise leave the canvas mid-frame with NO user signal -- a silently dead grid in the
// middle of a live demo, indistinguishable from "still working". Surface it as a transient banner +
// console.error so the presenter sees recovery guidance instead of a frozen grid. Defensive only: no
// normal path throws uncaught (this is the insurance, not a load-bearing handler). Round-5 audit LOW
// (accepted): showError suppresses a 'transient' under an active 'edit' banner, so an uncaught error
// thrown WHILE an over-limit edit banner is up reaches only the console -- deliberate: the 'edit'
// banner's guidance (shorten the value) outranks generic recovery text, and console.error still fires.
window.addEventListener('error', (e) => {
	console.error('[sheets-webview] uncaught error:', e.error ?? e.message);
	showError('The grid hit an unexpected error -- press Cmd/Ctrl+R to reload if it stops responding.', 'transient');
});
window.addEventListener('unhandledrejection', (e) => {
	console.error('[sheets-webview] unhandled promise rejection:', e.reason);
	showError('The grid hit an unexpected error -- press Cmd/Ctrl+R to reload if it stops responding.', 'transient');
});

const renderer = new CanvasGridRenderer(canvasEl);

/**
 * **FE-5 W-R (2026-06-12) -- ENGINE-backed cell styling.** The engine is the SOLE style source: the
 * toolbar's style controls POST a `setStyle` mutation to the host (which runs `registerStyle`+`setStyle`
 * as a batch + re-renders), and the canvas READS the resolved style off the render snapshot's
 * `styles[]`+`styleId` (see `resolveStyleForCell`). The retired session-scoped `cellStyleModel` store +
 * its `vscode.setState` persistence are GONE -- the engine persists styles to the workbook, and reads +
 * writes both go through it (so a write always renders, never the read/write-split silent miss).
 */

/**
 * **FE-5 W-R (2026-06-12) / FE-FONT (2026-06-13)** -- the wire shape of a `setStyle` mutation (webview ->
 * host). A local mirror of the host's `StyleMutation` (the webview is esbuild-isolated from the host
 * `cellGridLogic` module, so the union is pinned here; the host re-validates it at the trust boundary). The
 * engine-schema attributes: bold/italic/underline/strike toggle, horizontal align, fill color, text color,
 * and per-edge BORDERS. FE-FONT wired the four formerly preview-only buttons (Underline, Strikethrough,
 * Text-color, Borders) through this path; underline/strike fold into the `toggle` prop union.
 */
type RgbWire = { r: number; g: number; b: number };
type BorderStyleWire = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
type BorderEdgeSetWire = 'all' | 'outer' | 'top' | 'bottom' | 'left' | 'right' | 'none';
type StyleMutationWire =
	| { kind: 'toggle'; prop: 'bold' | 'italic' | 'underline' | 'strike' }
	| { kind: 'align'; value: 'left' | 'center' | 'right' | null }
	| { kind: 'fill'; value: RgbWire | null }
	| { kind: 'textColor'; value: RgbWire | null }
	| { kind: 'border'; edges: BorderEdgeSetWire; style: BorderStyleWire; color: RgbWire };

/** The rect a style op applies to: the active range, or the single active cell. `null` when there is
 *  no active cell / snapshot (nothing to style). */
function styleTargetRect(): SelectionRect | null {
	if (fullSnapshot === null || active === null) {
		return null;
	}
	const sel = currentSelection();
	return sel ?? { minRow: active.row, maxRow: active.row, minCol: active.col, maxCol: active.col };
}

/**
 * **FE-5 W-R (2026-06-12)** -- POST a uniform style mutation over the active selection to the host
 * (which applies it via the engine `registerStyle`/`setStyle` napi as one undo unit + re-renders). The
 * host reads each cell's CURRENT engine style, applies the mutation, and persists -- so toggle/align/fill
 * preserve a cell's other attributes (incl. borders). A whole-axis (over-cap) selection is rejected LOUD
 * by the host (a toast), never silently truncated (No-Fallbacks). No local redraw -- the host's re-render
 * carries the new styles back.
 */
function postStyleMutation(mutation: StyleMutationWire, undoLabel: string): void {
	const rect = styleTargetRect();
	if (rect === null || fullSnapshot === null) {
		return;
	}
	vscode.postMessage({
		type: 'setStyle',
		sheet: fullSnapshot.sheet,
		rect: { minRow: rect.minRow, maxRow: rect.maxRow, minCol: rect.minCol, maxCol: rect.maxCol },
		mutation,
		undoLabel,
		webviewId: WEBVIEW_ID,
	});
}

/** Toggle a boolean style (bold/italic/underline/strike) over the current selection via the engine.
 *  FE-FONT (2026-06-13): underline/strike join bold/italic on the engine toggle path. */
function toggleSelectionStyle(prop: 'bold' | 'italic' | 'underline' | 'strike'): void {
	const label = prop === 'bold' ? 'Bold' : prop === 'italic' ? 'Italic' : prop === 'underline' ? 'Underline' : 'Strikethrough';
	postStyleMutation({ kind: 'toggle', prop }, label);
}

/**
 * **FE-5 W-R (2026-06-12)** -- parse a CSS hex color (`#RGB` / `#RRGGBB`, the swatch palette's forms)
 * into an `{r,g,b}` the engine `setStyle` fill takes. Returns `null` for an unparseable string (the
 * caller then drops the op loud rather than sending a malformed fill -- No-Fallbacks). The swatch
 * palette only emits `#RRGGBB`, so this is total over the real inputs; the guard is defense-in-depth.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex);
	if (m3 !== null) {
		return { r: parseInt(m3[1] + m3[1], 16), g: parseInt(m3[2] + m3[2], 16), b: parseInt(m3[3] + m3[3], 16) };
	}
	const m6 = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
	if (m6 !== null) {
		return { r: parseInt(m6[1], 16), g: parseInt(m6[2], 16), b: parseInt(m6[3], 16) };
	}
	return null;
}

/** Sheets-like color palette for the fill swatch popover (greys row + a hue row incl. brand orange). */
const COLOR_SWATCHES: readonly string[] = [
	'#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#ffffff',
	'#e6194b', '#FF7331', '#f1c232', '#6aa84f', '#45818e', '#3d85c6', '#674ea7', '#a64d79', '#cc4125',
];

/**
 * **FE-5 W-R (2026-06-12) / FE-FONT (2026-06-13)** -- open the color swatch popover anchored under `anchor`
 * for either the FILL or the TEXT (glyph) color (`which`). Both are engine-style attributes now (FE-FONT
 * added `textColor`), so this one picker drives both: each swatch + the reset row POSTs the matching
 * `setStyle` mutation (`fill` / `textColor`) through `runAfterResolvingEdit`. Reuses the shared dropdown
 * lifecycle (tracked via `dropdownEl`/`openMenu` so the capture-phase click-away + window-blur + Escape all
 * close it); `items` is empty so the arrow-key menu nav is a no-op.
 */
function openColorPicker(anchor: HTMLElement, which: 'fillColor' | 'textColor'): void {
	if (openMenu !== null && openMenu.anchor === anchor) {
		closeMenuDropdown();
		return;
	}
	closeMenuDropdown();
	// Per-target labels so the swatch aria + the undo step + the reset row all read correctly for fill vs text.
	const isText = which === 'textColor';
	const swatchLabel = isText ? 'Text color' : 'Fill color';
	const setLabel = isText ? 'Text color' : 'Fill color';
	const clearLabel = isText ? 'Automatic text color' : 'No fill';
	const panel = document.createElement('div');
	panel.className = 'qb-color-popover';
	panel.setAttribute('role', 'menu');
	const grid = document.createElement('div');
	grid.className = 'qb-swatch-grid';
	for (const color of COLOR_SWATCHES) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'qb-swatch';
		b.style.background = color;
		b.title = color;
		b.setAttribute('aria-label', swatchLabel + ' ' + color);
		b.addEventListener('mousedown', (ev) => ev.preventDefault());
		b.addEventListener('click', () => {
			closeMenuDropdown();
			const rgb = hexToRgb(color);
			if (rgb === null) {
				// No-Fallbacks: a swatch whose hex doesn't parse is dropped LOUD rather than sending a
				// malformed color (unreachable -- COLOR_SWATCHES is all #RRGGBB -- but never silently coerce).
				console.warn('[sheets-webview] dropped a color swatch with an unparseable hex:', color);
				return;
			}
			runAfterResolvingEdit(setLabel, () => postStyleMutation(
				isText ? { kind: 'textColor', value: rgb } : { kind: 'fill', value: rgb },
				setLabel,
			));
		});
		grid.appendChild(b);
	}
	panel.appendChild(grid);
	const reset = document.createElement('button');
	reset.type = 'button';
	reset.className = 'qb-menu-item qb-color-reset';
	reset.textContent = clearLabel;
	reset.addEventListener('mousedown', (ev) => ev.preventDefault());
	reset.addEventListener('click', () => {
		closeMenuDropdown();
		runAfterResolvingEdit(clearLabel, () => postStyleMutation(
			isText ? { kind: 'textColor', value: null } : { kind: 'fill', value: null },
			clearLabel,
		));
	});
	panel.appendChild(reset);
	const rect = anchor.getBoundingClientRect();
	panel.style.top = rect.bottom + 2 + 'px';
	document.body.appendChild(panel);
	const left = Math.min(rect.left, Math.max(4, window.innerWidth - panel.offsetWidth - 4));
	panel.style.left = left + 'px';
	dropdownEl = panel;
	openMenu = { anchor, menuId: null, items: [], itemEls: [], activeIndex: -1 };
	anchor.classList.add('is-open');
	anchor.setAttribute('aria-expanded', 'true');
}

/**
 * **FE-FONT (2026-06-13)** -- the border picker's STICKY line-style + color, remembered across opens so a
 * user can pick "medium / blue" once then click several edge buttons. Defaults to a thin black border (the
 * Excel default). Both are engine-schema values; `'none'` is NOT a sticky style (clearing is a dedicated
 * action), so the sticky style is the renderable subset.
 */
let borderPickStyle: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double' = 'thin';
let borderPickColor: RgbWire = { r: 0, g: 0, b: 0 };

/** The line-style choices the border picker offers (the engine's renderable border styles). */
const BORDER_STYLE_CHOICES: readonly ('thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double')[] = [
	'thin', 'medium', 'thick', 'dashed', 'dotted', 'double',
];
/** The edge-apply actions the border picker offers: a label + the {@link BorderEdgeSetWire} it posts. */
const BORDER_EDGE_ACTIONS: readonly { label: string; edges: BorderEdgeSetWire }[] = [
	{ label: 'All borders', edges: 'all' },
	{ label: 'Outer border', edges: 'outer' },
	{ label: 'Top border', edges: 'top' },
	{ label: 'Bottom border', edges: 'bottom' },
	{ label: 'Left border', edges: 'left' },
	{ label: 'Right border', edges: 'right' },
];

/**
 * **FE-FONT (2026-06-13)** -- open the BORDERS picker anchored under `anchor`. Borders are fully
 * engine-backed (FE-4 W4 schema + FE-5 W-R render); this is the live SET path. The popover has three rows:
 * (1) a line-STYLE selector (thin..double), (2) a COLOR swatch row (reusing {@link COLOR_SWATCHES}), and
 * (3) the EDGE-action buttons (All / Outer / each side) + a "Clear borders" row. Style + color are STICKY
 * (`borderPickStyle`/`borderPickColor`) so picking them once then clicking several edges applies the same
 * line; each edge button POSTs a `border` `setStyle` mutation through `runAfterResolvingEdit`. "Clear" posts
 * `edges:'none'` (the host clears all 4 edges of every selected cell). Reuses the shared dropdown lifecycle
 * (`dropdownEl`/`openMenu`) so click-away / window-blur / Escape all close it.
 */
function openBorderPicker(anchor: HTMLElement): void {
	if (openMenu !== null && openMenu.anchor === anchor) {
		closeMenuDropdown();
		return;
	}
	closeMenuDropdown();
	const panel = document.createElement('div');
	panel.className = 'qb-color-popover qb-border-popover';
	panel.setAttribute('role', 'menu');

	// Row 1: the line-style selector. Clicking a style sets the sticky style + highlights it (no post -- the
	// edge buttons below carry the action). mousedown preventDefault keeps the open cell editor focused (the
	// toolbar's own mousedown guard chain) so the later edge click resolves it exactly once.
	const styleRow = document.createElement('div');
	styleRow.className = 'qb-border-style-row';
	const styleButtons: HTMLButtonElement[] = [];
	const syncStyleSelection = (): void => {
		for (let i = 0; i < styleButtons.length; i += 1) {
			styleButtons[i].classList.toggle('is-active', BORDER_STYLE_CHOICES[i] === borderPickStyle);
		}
	};
	for (const styleName of BORDER_STYLE_CHOICES) {
		const sb = document.createElement('button');
		sb.type = 'button';
		sb.className = 'qb-menu-item qb-border-style-btn';
		sb.textContent = styleName;
		sb.setAttribute('aria-label', 'Border line style ' + styleName);
		sb.addEventListener('mousedown', (ev) => ev.preventDefault());
		sb.addEventListener('click', () => {
			borderPickStyle = styleName;
			syncStyleSelection();
		});
		styleButtons.push(sb);
		styleRow.appendChild(sb);
	}
	syncStyleSelection();
	panel.appendChild(styleRow);

	// Row 2: the color swatch row -- selecting a swatch sets the sticky color (no post; edges carry it).
	const grid = document.createElement('div');
	grid.className = 'qb-swatch-grid';
	const swatchButtons: { el: HTMLButtonElement; color: string }[] = [];
	const syncColorSelection = (): void => {
		for (const { el, color } of swatchButtons) {
			const rgb = hexToRgb(color);
			const on = rgb !== null && rgb.r === borderPickColor.r && rgb.g === borderPickColor.g && rgb.b === borderPickColor.b;
			el.classList.toggle('is-active', on);
		}
	};
	for (const color of COLOR_SWATCHES) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'qb-swatch';
		b.style.background = color;
		b.title = color;
		b.setAttribute('aria-label', 'Border color ' + color);
		b.addEventListener('mousedown', (ev) => ev.preventDefault());
		b.addEventListener('click', () => {
			const rgb = hexToRgb(color);
			if (rgb === null) {
				// No-Fallbacks: an unparseable swatch is dropped LOUD, never coerced (unreachable; all #RRGGBB).
				console.warn('[sheets-webview] dropped a border color swatch with an unparseable hex:', color);
				return;
			}
			borderPickColor = rgb;
			syncColorSelection();
		});
		swatchButtons.push({ el: b, color });
		grid.appendChild(b);
	}
	syncColorSelection();
	panel.appendChild(grid);

	// Row 3: the edge-apply actions. Each posts a `border` mutation with the sticky style + color. A click
	// CLOSES the popover then applies (matching the swatch/reset idiom) so the user sees the result immediately.
	const edgeWrap = document.createElement('div');
	edgeWrap.className = 'qb-border-edge-actions';
	for (const action of BORDER_EDGE_ACTIONS) {
		const eb = document.createElement('button');
		eb.type = 'button';
		eb.className = 'qb-menu-item';
		eb.textContent = action.label;
		eb.addEventListener('mousedown', (ev) => ev.preventDefault());
		eb.addEventListener('click', () => {
			closeMenuDropdown();
			runAfterResolvingEdit(action.label, () => postStyleMutation(
				{ kind: 'border', edges: action.edges, style: borderPickStyle, color: borderPickColor },
				action.label,
			));
		});
		edgeWrap.appendChild(eb);
	}
	panel.appendChild(edgeWrap);

	// The "Clear borders" reset row -- posts edges:'none' (style/color are ignored by the host on a clear).
	const clear = document.createElement('button');
	clear.type = 'button';
	clear.className = 'qb-menu-item qb-color-reset';
	clear.textContent = 'Clear borders';
	clear.addEventListener('mousedown', (ev) => ev.preventDefault());
	clear.addEventListener('click', () => {
		closeMenuDropdown();
		runAfterResolvingEdit('Clear borders', () => postStyleMutation(
			{ kind: 'border', edges: 'none', style: 'none', color: borderPickColor },
			'Clear borders',
		));
	});
	panel.appendChild(clear);

	const rect = anchor.getBoundingClientRect();
	panel.style.top = rect.bottom + 2 + 'px';
	document.body.appendChild(panel);
	const left = Math.min(rect.left, Math.max(4, window.innerWidth - panel.offsetWidth - 4));
	panel.style.left = left + 'px';
	dropdownEl = panel;
	openMenu = { anchor, menuId: null, items: [], itemEls: [], activeIndex: -1 };
	anchor.classList.add('is-open');
	anchor.setAttribute('aria-expanded', 'true');
}

/** **FE-5 W-R** -- one-time LOUD warning for a cell whose engine `styleId` does not resolve against the
 *  snapshot's `styles[]` table. The engine must register every referenced style, so a miss signals a
 *  binding/threading drift; we render the cell unstyled (visible miss) AND warn once (No-Fallbacks: surface,
 *  never silently paint a default). Mirrors {@link warnSkippedEntry}'s warn-once discipline. */
let warnedUnresolvedStyle = false;
function warnUnresolvedStyle(row: number, col: number, styleId: unknown): void {
	if (warnedUnresolvedStyle) {
		return;
	}
	warnedUnresolvedStyle = true;
	console.warn(
		`[sheets-webview] cell (row=${row}, col=${col}) carries a styleId that does not resolve against the ` +
		`snapshot styles[] table; rendering it UNSTYLED. The engine should register every referenced style -- ` +
		`this signals a snapshot/threading drift. Offending styleId:`,
		styleId,
	);
}

/**
 * **FE-5 W-R (2026-06-12) -- the per-cell render-style SOURCE (engine, the SOLE source).** Resolves one
 * cell's {@link ResolvedCellStyle} (the shape the canvas paints) by resolving the cell's engine `styleId`
 * (carried on the per-cell render ENTRY) against the render snapshot's `styles[]` table via
 * {@link resolveCellStyle}. There is ONE source -- the retired session `cellStyleModel` store is gone, so
 * there is no per-cell source mix to silently fall back to.
 *
 * A STYLE-ONLY blank cell (a fill/border on an otherwise-empty cell -- no value/formula) renders because
 * the host projection (`extractSheetSnapshot`) KEEPS such cells (carrying the `styleId` on a pending
 * entry); the engine emits them (verified). An UNRESOLVED `styleId` (one not in `styles[]`) is a contract
 * violation -- surfaced LOUD (warn-once + render unstyled), NEVER masked with a default (No-Fallbacks).
 * `styles[]` absent (no styles registered yet -- the common case) means no cell is styled.
 */
function resolveStyleForCell(row: number, col: number): ResolvedCellStyle | undefined {
	if (fullSnapshot === null) {
		return undefined;
	}
	// **CLOSURE F5 (2026-06-12) -- No-Fallbacks ordering.** Read the cell's `styleId` FIRST, BEFORE deciding
	// on `styles[]` presence. A cell WITHOUT a styleId is unstyled regardless of the styles table -> return
	// undefined (the common, pre-style-edit case -- no warn). But a cell WITH a styleId while `styles[]` is
	// ABSENT is a CONTRACT VIOLATION (the engine must ship the table with any referenced id); it must route
	// through the LOUD `'unresolved'` -> `warnUnresolvedStyle` path, NOT silently render unstyled. The old
	// `styles === undefined` short-circuit returned undefined before ever reading the styleId, masking that
	// violation. `resolveCellStyle` already returns `'unresolved'` for a present id with an absent table.
	const styleId = renderer.entryAt(row, col)?.styleId;
	if (styleId === undefined) {
		return undefined; // this cell carries no style -> unstyled (no table lookup needed, no warning)
	}
	const styles = fullSnapshot.styles;
	const resolved = resolveCellStyle(styleId, styles);
	if (resolved === 'unresolved') {
		// No-Fallbacks: a styleId the engine never registered is a contract violation -- surface it, do
		// NOT silently paint a default. Render the cell UNSTYLED so the miss is visible + logged.
		warnUnresolvedStyle(row, col, styleId);
		return undefined;
	}
	return resolved;
}

// Bind the renderer's per-cell style lookup ONCE: it reads the live `fullSnapshot` (sheet + styles), so a
// sheet switch (which replaces `fullSnapshot`) needs no rebind. A style edit re-renders via the host.
renderer.setStyleLookup((row, col) => resolveStyleForCell(row, col));

let fullSnapshot: QuantbookCellSnapshot | null = null;
// "row,col" -> "[code] message" for cells whose last edit failed (errorReply). Map preserves the
// structured error text for the hover tooltip.
const errorCells = new Map<string, string>();
// **W-G bound-cell indicator**: the published-target ranges for THIS sheet (host->webview, on every
// `render`). Rebuilt + validated wholesale per render (the host sends the authoritative set), so a sheet
// switch or retraction is reflected without incremental bookkeeping. `publishedRangesKey` is a canonical
// digest used to detect a change between renders -- a change forces a FULL redraw (the damage fast path
// only repaints rows whose VALUE changed, so a stale-only retraction with no value move would otherwise
// not clear the badge). Threaded into every `renderer.draw*` call alongside `errorCells`.
let publishedRanges: PublishedRange[] = [];
let publishedRangesKey = '';
// **FE-5 W-R (2026-06-12) -- engine STYLE TABLE change detector.** A canonical digest of the render
// snapshot's `styles[]` table (the engine `StyleDefJson[]`: each {id:{peer,counter}, style:{...}}), used the
// SAME way as `publishedRangesKey`: a change between renders forces a FULL redraw via `commitSnapshot`'s
// `stylesChanged` gate. The per-cell `styleId` term in the damage diff catches a cell REPOINTED to another
// style, but a style DEFINITION re-edit (an existing id's fill/bold/border changed, no cell's `styleId`
// moved) is a table-level change the row diff cannot see -- so it is detected here. EMPTY string whenever
// the render snapshot does not (yet) carry `styles[]` (the conductor cross-boundary field), which makes
// `stylesChanged` permanently `false` and the gate byte-identical to its pre-W-R behaviour.
let stylesTableKey = '';
// **W-G copy/paste**: the internal grid clipboard (a copied/cut rectangle's underlying content). Set by
// Ctrl/Cmd+C (isCut=false) / Ctrl/Cmd+X (isCut=true), consumed by Ctrl/Cmd+V. `null` = nothing copied.
// Internal-only for v1 (no OS-clipboard interop); persists across renders + sheet switches like Excel.
let gridClipboard: GridClipboard | null = null;
// Round-5 LOW fix (cut-paste echo): a CUT also writes its TSV to the OS clipboard (the cross-app
// bridge). After the cut is CONSUMED by its paste (move complete, internal clipboard cleared), the
// next Ctrl/Cmd+V would fall through to the OS path and re-paste the moved values -- Excel no-ops a
// second paste after a cut, so we must too. `pendingCutOsTsv` remembers the TSV the live cut wrote;
// consumption moves it into `consumedCutOsTsv`, which the OS-paste path treats as "already moved".
// Any NEW copy/cut overwrites the OS clipboard, so both reset then. Round-5 audit notes (deliberate,
// documented): (a) a FAILED later copy/cut leaves the guard ARMED -- correct, because the failed op
// never wrote the OS clipboard, so the consumed cut's TSV is still what a paste would read; (b) a
// byte-identical TSV copied in ANOTHER app while the guard is armed is suppressed too -- accepted, a
// coincidence this narrow (exact TSV match) is overwhelmingly the consumed cut itself.
let pendingCutOsTsv: string | null = null;
let consumedCutOsTsv: string | null = null;
// **W-G fill handle**: drag-to-fill state. `fillSource` is the selection rect captured at the start of a
// fill-handle drag (null = not dragging); `fillPreview` is the rect the fill will cover (source extended
// down/right under the pointer), painted as a dashed outline and passed to every renderer draw call.
// `fillSuppressClick` swallows the click that fires after a fill-drag pointerup (so it doesn't re-select).
let fillSource: SelectionRect | null = null;
let fillPreview: SelectionRect | null = null;
// **FE-3 range-pick / point mode**: while a formula is being edited, a grid press/drag inserts the pressed
// cell/range's A1 reference INTO the formula at the caret (Excel point mode). A thin overlay on the SACRED
// `editState` -- it never writes a cell, never creates/nulls `editState`; it only mutates `editState.editEl`
// value + caret and owns the state below. Independent of the fill handle (the two drags are MUTUALLY EXCLUSIVE:
// a fill needs no open editor, a point needs one), so neither can stamp the other's render channel.
//  - `pointDrag`         : non-null only DURING a press/drag; the drag anchor, the OWNER pointerId (so a
//                          second touch/pen cannot hijack the drag), and a pre-drag snapshot (value /
//                          selection / span) used to REVERT on pointercancel. Mirrors `fillSource`.
//  - `pointPreview`      : the rect to outline while dragging (own render channel). Mirrors `fillPreview`.
//  - `pointInsertedSpan` : the [start,end) span of the ref the LAST point inserted. While set, the next point
//                          REPLACES it (re-point). Cleared on any real keystroke (onEditInput) AND whenever a
//                          new point starts with the caret no longer collapsed at its end (an arrow/click move
//                          or a fresh selection -- neither fires `input`), so the next point APPENDS.
//  - `pointSuppressClick`: swallow the synthetic click after a point press so it does not also re-select.
let pointDrag: { anchor: { row: number; col: number }; pointerId: number; startValue: string; startSelStart: number; startSelEnd: number; startSpan: RefSpan | null } | null = null;
let pointPreview: SelectionRect | null = null;
let pointInsertedSpan: RefSpan | null = null;
let pointSuppressClick = false;
let fillSuppressClick = false;
// Click tolerance (CSS px) for grabbing the fill-handle square at the selection's bottom-right corner.
const FILL_HANDLE_HIT_PX = 5;
// The active (selected) cell -- the FOCUS of the selection. Starts at A1 (like Excel) so the grid
// always shows a selection. `active` is the editable/formula-bar cell; all single-cell logic keys off it.
let active: ActiveCell | null = { row: 0, col: 0 };
// **W-G-2a**: the selection ANCHOR -- the fixed corner of a multi-cell range (shift-click / shift-arrow
// set it; `active` is the moving focus). `null` means the selection is just the single `active` cell
// (today's behavior, unchanged). The range is `selectionRect(anchor, active)`. Edits/Delete/plain-click
// collapse it back to a single cell (range-aware editing is a later increment).
let anchor: ActiveCell | null = null;
// **W-G-2b**: the last selection envelope posted to the host (a `sheet:anchor:focus` key), or `null`
// before the first post. `postSelectionIfChanged` dedupes against this so content-only redraws (an
// `errorReply` realign onto the same cell, a render push that did not move the selection) don't spam
// the host. `null` initial value is read only inside `postSelectionIfChanged`, which is called from
// `redraw()` (well after module load), so there is no pre-init hazard (the W-G-1b lesson).
let lastPostedSelectionKey: string | null = null;

interface EditState {
	// **W-G-1b**: the live editor input + which surface it is. Editing runs in EITHER the in-cell overlay
	// (`inputEl`, positioned over the cell) OR the formula bar (`formulaInputEl`, the always-visible bar) --
	// never both (single-active-editor model). The shared commit machinery (`commitEdit`, the watchdog,
	// `resolvePendingCommit`, the `errorReply` un-stick) operates on `editEl` so there is ONE writer; only the
	// presentation (position/clip/hide vs readOnly-toggle) branches on `surface`.
	readonly editEl: HTMLInputElement;
	readonly surface: 'overlay' | 'formula';
	// **Audit MED-2 (2026-06-05)**: the sheet captured at edit-start. `commitEdit` posts to THIS sheet, not
	// the live `fullSnapshot.sheet`, so an edit can never be mis-targeted if the snapshot's sheet changes
	// while the editor is open (defensive -- a panel's sheet is fixed today, but this removes the coupling).
	readonly sheet: number;
	row: number;
	col: number;
	// The populated entry under the cell at edit-start (formula/value pre-fill); undefined for an empty cell.
	readonly entry?: QuantbookCellSnapshot['entries'][number];
	// **FE-2-0 polish (2026-06-05)**: the cell's PRE-edit content -- the baseline `blur` compares against to
	// commit (changed) vs cancel (unchanged). For F2/click this equals the prefill; for type-to-edit it is the
	// PRIOR content (NOT the injected char -- megaudit MED-1), or the {@link OVERSIZE_BASELINE} sentinel when
	// the prior content is over the editable cap (so it is never built/held).
	readonly initialValue: string;
	// **Round 5 (2026-06-10)** -- set ONLY for a Sigma-functions prefill insert (e.g. `"=SUM("`). If the editor
	// is committed while its value is STILL exactly this untouched prefill (the presenter picked a function
	// then navigated away without completing the range), the commit is aborted instead of writing an
	// incomplete formula that the engine would surface as a visible #ERROR. Undefined for every normal edit.
	readonly prefillBaseline?: string;
	pendingCommit: boolean;
	// FE-2-0 Phase 2 (commit-token): the unique id of THIS in-flight commit, stamped by commitEdit and
	// echoed by the host in `commitResult` (success) / `errorReply` (failure). Replaces the FE megaudit
	// M8 (sheet,row,col) match -- a monotonic token can't collide, and (the HIGH this kills) a bare
	// `render` no longer resolves a pending edit, so a sibling-panel/refresh render can't falsely close
	// this editor. Undefined until commitEdit() fires.
	commitId?: number;
	// Where to move the selection once THIS commit's matching commitResult arrives (Enter=down, Tab=right).
	navAfterCommit?: { dr: number; dc: number };
	// **Megaudit (B2, 2026-06-04)**: the rawInput value of the LAST commit that FAILED (set on a matching
	// `errorReply`). While the editor still holds exactly this string (the user hasn't edited it), a nav key
	// (arrow / Tab / Enter) ABANDONS the edit + navigates instead of re-posting the same failing value --
	// so the user can leave a known-bad cell with the keys they reach for, and Tab can never re-fail-loop.
	// Cleared on any real input edit (so "edited then typed back to the same string" still commits).
	lastFailedRawInput?: string;
	// **Megaudit re-audit (HIGH, 2026-06-04)**: the rawInput posted by the in-flight commit. After the
	// watchdog (or a malformed render) recovers a stalled commit and the user types a correction, a
	// genuinely-LATE success ack must NOT close the editor + discard that typing -- `resolvePendingCommit`
	// only honors a late ack when `editEl.value` still equals this submitted value.
	submittedRawInput?: string;
}
let editState: EditState | null = null;
// **FE-11**: whether the name box is the live editor (the user is typing a name/reference into it). The name
// box is deliberately OUTSIDE `editState` (it never writes a cell -- so it can never be mis-committed as one),
// so this small flag is its entire edit state. Declared BEFORE the `updateFormulaBar()` seed below, which
// reads it (the W-G-1b init-order lesson: esbuild hoists `let` to an undefined `var`, so a later declaration
// would read `undefined` here -- harmlessly falsy, but we keep it correct).
let nameBoxEditing = false;
// **FE-11 v2**: the workbook's defined names, refreshed from every `render` payload (see applyDefinedNames).
// Drives the name box's matched-name display + the inline name dropdown. Declared BEFORE the
// updateFormulaBar() seed below, which now reads it (the same hoisted-`let` init-order rule the
// nameBoxEditing comment above describes -- a later declaration would read `undefined` here).
let definedNames: NamedRangeJson[] = [];
// Seed the formula bar with the initial selection (A1, empty content) before the first render arrives.
// **W-G-1b**: this MUST run AFTER `editState` is initialized -- `updateFormulaBar` now reads `editState`,
// and esbuild down-levels the module-level `let` to a hoisted `var` (undefined until this point), so calling
// it earlier would hit `undefined.surface` (the `!== null` guard does not catch `undefined`).
updateFormulaBar();
// FE-2-0 Phase 2: monotonic source of per-commit ids for the single-cell editor commit token (never reused
// within a webview lifetime). Used ONLY by the editor `putValue` commit path; paste/fill (`putCells`) use the
// host-driven `cellsWritten` report below, not a commit token.
let nextCommitId = 0;
// megaudit (webview-instance token, 2026-06-09): a token minted ONCE per webview load (a NEW value after
// every reload). Stamped on `putCells` (paste/fill) AND `putValue` (the editor commit + the Delete-clear),
// and echoed back by the host in `cellsWritten` / `commitResult` / `errorReply`, so a stale reply from a
// PRE-reload op cannot clear a tint or resolve/un-stick a freshly-reloaded webview's editor (the numeric
// commitId / pending-ack token resets on reload and would otherwise collide with a fresh op). For putCells
// this REPLACES the prior webview-side pending-ack Map (which reset its numeric token on reload and was not
// sheet-scoped): the HOST now authoritatively lists the written cells + sheet on success. A FAILED op
// produces no success message, so a stale tint correctly stays (No-Fallbacks). Uniqueness (not
// cryptographic strength) is the only requirement.
const WEBVIEW_ID = 'wv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
// FE-2-0 Phase 2 (re-audit HIGH): a pending edit now resolves ONLY on a matching commitResult/errorReply
// -- a bare render no longer releases it. So a LOST/dropped/malformed completion would strand the editor
// forever (Escape/blur inert). This watchdog is the recovery net: if neither reply arrives in time, it
// surfaces the unknown status LOUD + un-sticks pendingCommit so Escape/blur/re-edit work again. Generous
// (10s >> any real local-engine round-trip) so it never false-fires on a slow-but-valid commit.
const COMMIT_WATCHDOG_MS = 10000;
let commitWatchdog: ReturnType<typeof setTimeout> | undefined;
function clearCommitWatchdog(): void {
	if (commitWatchdog !== undefined) {
		clearTimeout(commitWatchdog);
		commitWatchdog = undefined;
	}
}
function armCommitWatchdog(commitId: number): void {
	clearCommitWatchdog();
	commitWatchdog = setTimeout(() => {
		commitWatchdog = undefined;
		// Only fire if THIS commit is still unresolved (a late reply may have already resolved it).
		if (editState !== null && editState.pendingCommit && editState.commitId === commitId) {
			editState.pendingCommit = false; // un-stick: re-arm Escape / blur / re-edit
			editState.navAfterCommit = undefined;
			editState.editEl.readOnly = false; // megaudit H1/MED: unlock + refocus so the user can act on the un-stuck editor
			editState.editEl.focus();
			// Deferred-action guard (2026-06-10): the commit's fate is unknown -- do NOT carry out a deferred
			// sheet switch OR chrome action over it (the banner below explains; the user can re-issue it).
			dropDeferredAction('the commit was never confirmed (watchdog timeout)');
			showError(
				'The edit could not be confirmed by the host (no response). It may or may not have been ' +
				'saved -- check the cell value, then press Escape or re-enter it.',
				'transient',
			);
			redraw();
		}
	}, COMMIT_WATCHDOG_MS);
}

// ============================================================================
// Sheet-tabs cross-sheet edit guard (2026-06-10, Codex HIGH).
//
// **INVARIANT: no editor (overlay or formula bar) ever survives a sheet change.** `editState`'s
// row/col/sheet are captured on the OLD sheet; if the editor outlived a switch, a late `commitResult`
// would close/navigate against the NEW sheet using old-sheet coordinates (and the overlay would sit
// over the wrong sheet's cells). Two halves enforce it:
//
//   1. USER-initiated switch (tab-strip click -> `requestSheetSwitch`): resolve the editor FIRST.
//      Not pending -> commit a changed value (Sheets/Excel commit-on-navigation) / cancel an unchanged
//      or known-bad one, then switch. Pending (typical: the tab click's own blur just posted the
//      commit) -> DEFER the switch in the shared deferred-action slot (`pendingEditResolvedAction`,
//      below -- since the Codex demo-blocker fix it also carries chrome actions) until the ack
//      resolves -- never switch under an in-flight commit. The deferred switch is POSTED on commit
//      success (`resolvePendingCommit`) and DROPPED on every failure/unknown path (matched
//      `errorReply`, commit watchdog, malformed-render un-stick) -- each of those already surfaces a
//      visible banner and keeps/reopens the editor on the OLD sheet, so navigating away would orphan it.
//   2. HOST-initiated switch (a `render` whose snapshot.sheet differs -- another panel/command):
//      `applyRender` closes ANY open editor. A non-pending edit is cancelled (its un-committed value
//      cannot survive onto the wrong sheet; this matches Escape/blur-unchanged). A PENDING commit is
//      DETACHED into `detachedCommit` below, then the editor UI is closed: the putValue was already
//      posted (to the sheet captured at edit-start, so it lands on the OLD sheet correctly); only the
//      UI resolution remains, and it must not touch the new sheet. The detached record keeps the
//      outcome VISIBLE (No-Fallbacks -- a posted edit's fate is never silently dropped):
//        - matching `commitResult` ok  -> success; nothing to show, clear the record;
//        - matching `errorReply`       -> LOUD banner: the edit was rejected and NOT saved;
//        - neither within the watchdog -> LOUD banner: the edit's fate is unknown, check that cell.
// ============================================================================

// ============================================================================
// Deferred-action slot (2026-06-10, Codex DEMO-BLOCKER) -- ONE coherent "wait for the edit to
// resolve, then act" story shared by USER sheet switches (the tab strip) and EVERY chrome action
// (toolbar buttons incl. undo/redo, all dropdown + menubar items -- the number-format presets now
// among them, the '123' dropdown having replaced the native select in the toolbar-quality
// overhaul -- the tab strip's sheet commands add/rename/delete/move, and the host-posted
// `contextMenuAction` clipboard replies -- the last two added by the Codex r3 fix-verify round).
// The ONE remaining NATIVE surface that cannot defer its action (the grid's right-click context
// menu -- it cannot be re-opened programmatically at a later resolution point) uses the sibling
// RESOLVE-OR-SUPPRESS resolver instead ({@link resolveEditForNativeSurface}).
//
// WHY chrome actions need it: all chrome controls preventDefault their mousedown so the grid (or an
// OPEN cell/formula editor) keeps focus -- which also means clicking chrome NEVER blurs an open
// editor. Without a guard, "editing B2 -> click toolbar-dropdown 'Delete row'" posted the structural
// command while the editor was still open holding B2's coordinates; the host deleted the row, and the
// editor's LATER blur/commit posted the OLD coordinate -- a silent write into the shifted row (the
// demo-blocker). Toolbar undo/redo were worse: they posted and never refocused, so the editor
// SURVIVED over mutated state. Every chrome action therefore resolves the editor FIRST with EXACTLY
// `requestSheetSwitch`'s edit-resolution semantics -- one resolver (`resolveEditThen`) serves both,
// so there is one deferral story, one supersede rule, and one set of resolution points.
//
// THE SLOT: at most ONE deferred action exists (`pendingEditResolvedAction`), set ONLY while a
// commit is in flight, and consumed/dropped at EVERY commit-resolution point -- the exhaustive set:
//   - `resolvePendingCommit` (matching `commitResult` ok) -> RUN it (the only RUN point);
//   - matched `errorReply` un-stick                       -> DROP it (the rejection banner explains);
//   - the commit watchdog                                 -> DROP it (the unknown-fate banner explains);
//   - the malformed-render un-stick                       -> DROP it (the stale-grid banner explains);
//   - `applyRender`'s HOST-initiated sheet change         -> a deferred USER switch to a DIFFERENT
//     sheet is re-posted (the user's intent stands); a deferred CHROME action is DROPPED LOUDLY --
//     it was aimed at the OLD sheet's selection and must not fire against the new one.
// A chrome action NEVER runs after a failed/unknown commit (No-Fallbacks: the failure banners are the
// story; acting on top of them would mutate state the user was just told is uncertain).
//
// SUPERSEDE rule: a second deferred request while one is queued REPLACES it -- LOUDLY (console.warn
// + the visible banner) whenever a chrome action is involved on either side; silently ONLY for
// sheet-switch-over-sheet-switch (the tab strip's documented "last click wins"). Never a silent
// overwrite of an action the user was promised.
// ============================================================================

/** The two deferrable kinds. `sheetSwitch` posts `{type:'switchSheet'}` on resolution (the tab
 * strip); `chrome` runs a wired chrome control's post (`label` is the human-readable name used by
 * the supersede/drop banners + warns). */
type DeferredEditResolvedAction =
	| { readonly kind: 'sheetSwitch'; readonly sheet: number }
	| { readonly kind: 'chrome'; readonly label: string; readonly run: () => void };

/** The single deferred action awaiting the in-flight commit's resolution (null = none). Set ONLY
 * while a commit is pending; consumed/dropped at every commit-resolution point (see the block
 * comment above). Generalizes the former sheet-switch-only `pendingSheetSwitch`. */
let pendingEditResolvedAction: DeferredEditResolvedAction | null = null;

/** Human-readable name for the supersede/drop banners + console warns. */
function describeDeferredAction(a: DeferredEditResolvedAction): string {
	return a.kind === 'sheetSwitch' ? 'switch to sheet ' + String(a.sheet) : a.label;
}

/** Queue `next` behind the in-flight commit. A supersede is LOUD (console.warn + the existing banner
 * pattern) unless it is the tab strip's documented silent sheet-over-sheet "last click wins" --
 * never a silent overwrite of a queued chrome action (No-Fallbacks). */
function setDeferredAction(next: DeferredEditResolvedAction): void {
	if (
		pendingEditResolvedAction !== null &&
		!(pendingEditResolvedAction.kind === 'sheetSwitch' && next.kind === 'sheetSwitch')
	) {
		const oldDesc = describeDeferredAction(pendingEditResolvedAction);
		const newDesc = describeDeferredAction(next);
		console.warn('[sheets-webview] deferred action superseded before the pending edit resolved:', oldDesc, '->', newDesc);
		showError(
			'"' + oldDesc + '" was superseded by "' + newDesc + '" while an edit was committing; only "' +
			newDesc + '" will run.',
			'transient',
		);
	}
	pendingEditResolvedAction = next;
}

/** Drop the deferred action at a FAILED/unknown commit-resolution point. The caller's banner is the
 * user-facing story (each drop point already shows one); the warn keeps the dropped action
 * diagnosable -- never a silent disappearance. Safe when nothing is queued. */
function dropDeferredAction(reason: string): void {
	if (pendingEditResolvedAction === null) {
		return;
	}
	console.warn(
		'[sheets-webview] dropped the deferred action "' + describeDeferredAction(pendingEditResolvedAction) + '": ' + reason,
	);
	pendingEditResolvedAction = null;
}

/** Execute a deferred (or immediately-runnable) action NOW. The editor is resolved/closed by the
 * time this runs -- callers guarantee it (`resolveEditThen` immediately after cancel/no-editor;
 * `resolvePendingCommit` after the success ack closed the editor). */
function runDeferredActionNow(action: DeferredEditResolvedAction): void {
	if (action.kind === 'sheetSwitch') {
		vscode.postMessage({ type: 'switchSheet', sheet: action.sheet });
	} else {
		action.run();
	}
}

/**
 * THE shared edit resolver (the demo-blocker fix's core): resolve any open editor, then run `action`
 * -- immediately when possible, deferred behind the commit otherwise. Mirrors the original
 * `requestSheetSwitch` semantics EXACTLY (that function now delegates here):
 *   - no editor open                        -> run NOW ('ran');
 *   - editor open, value UNCHANGED or
 *     known-locally-bad (the B2 contract)   -> `cancelEdit()` (Escape/blur-unchanged semantics),
 *                                              repaint, run NOW ('ran');
 *   - editor open, CHANGED, not pending     -> commit through the normal machinery (`commitEdit`)
 *                                              and QUEUE the action ('queued'); a LOCAL reject
 *                                              (over-limit) keeps the editor open with its 'edit'
 *                                              banner and the action does NOT run ('blocked');
 *   - editor already PENDING a commit       -> QUEUE behind that commit ('queued').
 * A queued action resolves at the slot's resolution points (run on success, dropped on every
 * failure/unknown path -- see the block comment above).
 */
function resolveEditThen(action: DeferredEditResolvedAction): 'ran' | 'queued' | 'blocked' {
	if (editState !== null) {
		if (editState.pendingCommit) {
			setDeferredAction(action); // defer behind the in-flight commit (its resolution points consume/drop)
			return 'queued';
		}
		const value = editState.editEl.value;
		const changed = value !== editState.initialValue;
		const knownBad = editState.lastFailedRawInput !== undefined && value === editState.lastFailedRawInput;
		// Round-5 LOW fix: an UNTOUCHED sigma-functions prefill ("=SUM(") reads as `changed` (the cell's
		// prior content is the baseline, not the prefill), but commitEdit would ABORT it via
		// `prefillBaseline` and return false -- which the `changed` arm below would misread as a LOCAL
		// reject ('blocked'), silently dropping the chrome action even though the editor was in fact
		// cancelled. Route it through the cancel arm instead: abandon the prefill AND run the action.
		const untouchedPrefill = editState.prefillBaseline !== undefined && value === editState.prefillBaseline;
		if (changed && !knownBad && !untouchedPrefill) {
			if (commitEdit()) {
				setDeferredAction(action); // committed -> now pending; act when the ack resolves
				return 'queued';
			}
			// LOCAL reject (over-limit): commitEdit surfaced its 'edit' banner and the editor stays open
			// for shortening. Do NOT act -- never run a chrome action / switch sheets over a value the
			// user has just been told to fix (the banner explains; they can re-issue the action after).
			return 'blocked';
		}
		cancelEdit(); // unchanged / known-bad / untouched-prefill -> abandon (Escape/blur-unchanged semantics), then act
		redraw();
	}
	runDeferredActionNow(action);
	return 'ran';
}

/**
 * **The chrome-action guard (Codex DEMO-BLOCKER fix, 2026-06-10).** EVERY wired chrome control --
 * all posting toolbar buttons (incl. undo/redo), every dropdown / menubar item (via
 * `activateMenuItem`, the single dropdown seam -- the number-format presets among them, since the
 * '123' dropdown replaced the old native select), the tab strip's sheet commands
 * (add/rename/delete/moveLeft/moveRight via `sheetTabHandlers`), and the host-posted
 * `contextMenuAction` clipboard replies (Codex r3 fix-verify) -- posts THROUGH this, never
 * directly, so a host mutation can never race an open editor's stale coordinates. Also owns the
 * focus restoration the chrome focus model requires (see the FOCUS MODEL comment up top):
 *   - editor open AFTER the action -> focus IT. Two distinct cases share this arm:
 *       (a) 'queued'/'blocked': the PRE-existing editor owns the interaction (a pending editor is
 *           readOnly and its resolution re-asserts focus; a blocked editor needs the keyboard so
 *           the user can shorten the value). Focus must never land on chrome here.
 *       (b) 'ran' where the ACTION ITSELF opened a fresh editor (the sigma Functions items ->
 *           `startFunctionInsert` -> `beginEdit`): the old unconditional `viewportEl.focus()` on
 *           'ran' would BLUR that brand-new editor, and its blur-commit would write the bare
 *           '=FN(' prefill into the cell -- the exact stale-state class this guard exists to kill.
 *           The resolver cancelled/closed any prior editor before running, so a non-null
 *           `editState` after 'ran' can ONLY be one the action just opened, on purpose.
 *       (Focusing the formula bar while it IS the live editor is a no-op: `beginEditFormula`
 *       early-returns on its own surface.)
 *   - 'ran' with no editor -> keyboard back to the grid viewport (this is what gives undo/redo the
 *     restoration the other wired buttons already had).
 */
function runAfterResolvingEdit(label: string, run: () => void): void {
	const outcome = resolveEditThen({ kind: 'chrome', label, run });
	if (editState !== null) {
		editState.editEl.focus();
	} else if (outcome === 'ran') {
		viewportEl.focus();
	}
}

/**
 * **The NATIVE-surface edit resolver (Codex r3 fix-verify, 2026-06-10).** A chrome surface that is
 * NATIVE -- owned by the browser / VS Code, not by this webview -- cannot route its "action"
 * through the deferred-action slot. Since the toolbar-quality overhaul replaced the number-format
 * <select> (whose native picker was the second such surface; `showPicker()` needs a live user
 * gesture a commit-ack resolution point no longer has) with the shared '123' dropdown, exactly ONE
 * native surface remains:
 *   - the grid's right-click CONTEXT MENU: VS Code shows it from the `data-vscode-context` payload
 *     the moment the `contextmenu` event completes (the injected pre/index.html handler), and there
 *     is no API to re-open it when a queued commit later resolves.
 * Queueing a NO-OP through `resolveEditThen` instead would be actively harmful: the no-op cannot
 * re-open the surface (the user must re-gesture anyway), and setting it would SUPERSEDE -- i.e.
 * destroy, loudly but pointlessly -- a REAL queued action such as a deferred 'Delete row'. So these
 * surfaces get RESOLVE-OR-SUPPRESS: the same edit-resolution branches as {@link resolveEditThen},
 * byte-for-byte on the resolution side, but the cannot-run-now outcomes SUPPRESS the surface (the
 * caller preventDefaults the native default action) instead of queueing:
 *   - no editor open                  -> `true`: the surface may open; nothing to resolve;
 *   - open, UNCHANGED or known-bad    -> `cancelEdit()` + repaint (Escape/blur-unchanged semantics)
 *                                        -> `true`: the surface opens over a RESOLVED grid, in the
 *                                        SAME user gesture (no re-gesture needed);
 *   - open, CHANGED, not pending      -> `commitEdit()` NOW (the typed value is saved, never
 *                                        dropped) -> `false` + a transient banner naming the retry
 *                                        gesture: the surface must not offer mutation over an
 *                                        in-flight commit, and there is nothing to queue (the user
 *                                        has not picked an action yet);
 *       LOCAL reject (over-limit)     -> `false`, no transient banner from here: commitEdit's own
 *                                        'edit' banner explains and the editor stays open + focused
 *                                        for shortening -- exactly the resolver's 'blocked'
 *                                        semantics (and `showError`'s source priority would have
 *                                        suppressed a 'transient' write under the 'edit' banner
 *                                        anyway);
 *   - already PENDING a commit        -> `false` + the banner: suppress; the user re-gestures once
 *                                        the commit resolves (every resolution point -- ack,
 *                                        errorReply, watchdog, malformed render -- re-enables the
 *                                        surface by resolving/un-sticking the editor).
 * `retryHint` is the surface-specific retry gesture, appended to the suppression banner so a shut
 * surface is never silent (No-Fallbacks). The suppressed paths keep/restore focus ON the editor
 * (mirroring `runAfterResolvingEdit`'s 'queued'/'blocked' arms): it owns the interaction until its
 * commit resolves.
 */
function resolveEditForNativeSurface(retryHint: string): boolean {
	if (editState === null) {
		return true;
	}
	if (!editState.pendingCommit) {
		const value = editState.editEl.value;
		const changed = value !== editState.initialValue;
		const knownBad = editState.lastFailedRawInput !== undefined && value === editState.lastFailedRawInput;
		// Round-5 LOW fix (mirrors resolveEditThen byte-for-byte): an untouched sigma prefill must take
		// the cancel arm here too -- commitEdit would abort it (return false) and this function would
		// misreport 'blocked' + suppress the surface over an editor that no longer exists.
		const untouchedPrefill = editState.prefillBaseline !== undefined && value === editState.prefillBaseline;
		if (!changed || knownBad || untouchedPrefill) {
			cancelEdit(); // Escape/blur-unchanged semantics -- identical to resolveEditThen's cancel arm
			redraw();
			return true;
		}
		if (!commitEdit()) {
			// LOCAL reject (over-limit): 'blocked'. The 'edit' banner commitEdit just showed is the story;
			// keep the keyboard on the editor so the user can shorten the value in place.
			editState.editEl.focus();
			return false;
		}
	}
	// A commit is (now) in flight: the editor is readOnly until the host's ack/errorReply/watchdog
	// resolves it. Suppress the surface this once and say how to retry -- never a silent dead control.
	showError('The open edit is still being committed -- ' + retryHint, 'transient');
	editState.editEl.focus();
	return false;
}

/** The in-flight commit whose editor a HOST-initiated sheet change closed (null = none). Carries
 * everything needed to report its outcome after `editState` is gone. */
let detachedCommit: { commitId: number; sheet: number; row: number; col: number } | null = null;
let detachedWatchdog: ReturnType<typeof setTimeout> | undefined;

function clearDetachedCommit(): void {
	detachedCommit = null;
	if (detachedWatchdog !== undefined) {
		clearTimeout(detachedWatchdog);
		detachedWatchdog = undefined;
	}
}

/** Format a detached commit's target for a banner: "B7 on sheet 0" (matches the title's sheet-number
 * convention -- the strip's display names live in the host payload, not here). */
function describeDetachedTarget(d: { sheet: number; row: number; col: number }): string {
	return cellRefA1(d.row, d.col) + ' on sheet ' + String(d.sheet);
}

/** Park the captured in-flight commit in `detachedCommit` + arm its outcome watchdog. Called ONLY from
 * `applyRender`'s sheet-changed path, AFTER `cancelEdit` closed the editor UI (the record is captured
 * from `editState` BEFORE the cancel; ordering matters -- cancelEdit's `clearError` would wipe the
 * superseded-record banner below if this ran first). */
function detachPendingCommit(record: { commitId: number; sheet: number; row: number; col: number }): void {
	if (detachedCommit !== null) {
		// A SECOND sheet change with a SECOND unresolved commit inside one watchdog window (host wedged
		// twice) -- the older record is about to be overwritten, so surface its unknown fate NOW rather
		// than silently dropping it (No-Fallbacks).
		console.warn('[sheets-webview] a detached commit was superseded before resolving:', detachedCommit);
		showError(
			'An earlier edit to ' + describeDetachedTarget(detachedCommit) +
			' was never confirmed by the host. Check that cell.',
			'transient',
		);
	}
	detachedCommit = record;
	if (detachedWatchdog !== undefined) {
		clearTimeout(detachedWatchdog);
	}
	detachedWatchdog = setTimeout(() => {
		detachedWatchdog = undefined;
		if (detachedCommit !== null) {
			// Same recovery contract as the commit watchdog, minus the editor (it is gone): the host never
			// answered, so the edit may or may not have been saved -- say so LOUDLY.
			showError(
				'The edit to ' + describeDetachedTarget(detachedCommit) +
				' (submitted before the sheet switched) was never confirmed by the host. ' +
				'It may or may not have been saved -- check that cell.',
				'transient',
			);
			detachedCommit = null;
		}
	}, COMMIT_WATCHDOG_MS);
}

// --- Viewport / draw ---

// FE-2 BAKEOFF (2026-06-09): the scroll/damage/full-redraw decision is now in the DOM-free shared
// `RenderOrchestrator` (so a benchmark can drive the REAL paint path + a unit test can drive it with a
// fake renderer). `Viewport` + the `prevPaint`/`scrollStateNow`/`scrollUnchangedSince` machinery moved
// THERE; this file keeps only the live DOM seam below (the `RenderHost`). Behavior is byte-identical.
function currentViewport(): Viewport {
	return {
		scrollTop: viewportEl.scrollTop,
		scrollLeft: viewportEl.scrollLeft,
		cssW: viewportEl.clientWidth,
		cssH: viewportEl.clientHeight,
	};
}
/** Pin the absolute canvas over the viewport at the current scroll (the content scrolls under it). */
function applyCanvasTransform(scrollTop: number, scrollLeft: number): void {
	canvasEl.style.transform = 'translate(' + scrollLeft + 'px, ' + scrollTop + 'px)';
}

// FE-2 BAKEOFF: the shared orchestrator instance for THIS webview. It OWNS `prevPaint` (the only paint
// state both fast paths read+write); every other input arrives live through the `RenderHost` getters
// below + the DOM side effects through its callbacks, so the module-level `let` bindings (fullSnapshot,
// active, anchor, publishedRanges, errorCells, fillPreview) stay owned HERE. The host is built once;
// its getters/callbacks close over those bindings, so each call sees the current value -- identical to
// the old in-place closures. `redraw`/`scrollRedraw` below are thin shims onto the orchestrator (kept so
// the ~30 existing call sites in this file are untouched).
const renderHost: RenderHost = {
	renderer,
	errorCells,
	viewport: currentViewport,
	active: () => active,
	selection: currentSelection,
	publishedRanges: () => publishedRanges,
	fillPreview: () => fillPreview,
	pointPreview: () => pointPreview,
	// W3 frozen panes: the renderer is the single source of truth for the (clamped) frozen counts; the
	// orchestrator's blit gate reads them through here. `setFrozen` clamped them, so these are always sane.
	frozenRowCount: () => renderer.frozenRows,
	frozenColCount: () => renderer.frozenCols,
	applyCanvasTransform,
	onAfterFullRedraw: () => {
		updateFormulaBar(); // selection/content changed -> reflect the active cell in the formula bar
		postSelectionIfChanged(); // W-G-2b: report the selection to the host (deduped)
		scheduleHoverTitle(); // W-G name display: a publish retraction repaints here -> refresh the stale hover title
	},
	onAfterScroll: () => {
		scheduleHoverTitle(); // W-G name display: a scroll moves a new cell under a stationary pointer -> refresh the hover title
	},
	onAfterDamage: () => {
		updateFormulaBar();
	},
};
const orchestrator = new RenderOrchestrator(renderHost);

/** Size the in-flow spacer to the full Excel extent (drives the native scrollbars). */
function updateSpacer(): void {
	spacerEl.style.height = totalContentHeight() + 'px';
	spacerEl.style.width = totalContentWidth(renderer.gutterWidthPx) + 'px';
}

/** Full redraw at the current viewport -- the always-correct paint path AND the fallback for both fast
 * paths (nav / type / resize / theme / first paint / any declined fast path route here). FE-2 BAKEOFF:
 * a thin shim onto the shared {@link RenderOrchestrator}, which paints + writes prevPaint and fires the
 * `onAfterFullRedraw` host callback (the formula-bar / selection-post / hover-title triplet). */
function redraw(): void {
	orchestrator.redraw();
}

/**
 * **W-G-2b** -- report the current selection to the host as a `{type:'selection',...}` envelope so the
 * host can track the focused grid's selection (the hook the "bind variable to selected cell" flow
 * consumes). `redraw()` is the single funnel for every focus/anchor change, so calling this there
 * catches them all; the dedupe (against {@link lastPostedSelectionKey}) makes content-only redraws
 * (e.g. an `errorReply` realign onto the same cell) no-ops. The anchor coords collapse to the focus
 * when there is no range, so the host always receives a well-formed rect. No-op until the first
 * snapshot + an active cell exist.
 */
function postSelectionIfChanged(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	const anc = anchor ?? active;
	const key = `${fullSnapshot.sheet}:${anc.row},${anc.col}:${active.row},${active.col}`;
	if (key === lastPostedSelectionKey) {
		return;
	}
	lastPostedSelectionKey = key;
	vscode.postMessage({
		type: 'selection',
		sheet: fullSnapshot.sheet,
		anchorRow: anc.row,
		anchorCol: anc.col,
		focusRow: active.row,
		focusCol: active.col,
	});
}

/**
 * **FE-2-0 Phase 3** -- the scroll fast path: blit the overlap of a pure-axis scroll + repaint only the
 * exposed strip, falling back to a full {@link redraw} whenever the pure math declines (no prior frame,
 * resize/dpr change, diagonal or sub-device-pixel move, or too little reusable area). ONLY the scroll
 * handler calls this: a scroll changes neither the snapshot nor the active cell nor errorCells, so the
 * blitted (shifted) pixels stay correct -- any path that changes content/selection must full-`redraw()`.
 * FE-2 BAKEOFF: a thin shim onto the shared {@link RenderOrchestrator} (the blit/draw decision + the
 * prevPaint write + the `onAfterScroll` hover-title refresh live there now).
 */
function scrollRedraw(): void {
	orchestrator.scrollRedraw();
}

// FE megaudit L-b: coalesce high-frequency scroll events to ONE repaint per animation frame.
let redrawScheduled = false;
function scheduleRedraw(): void {
	if (redrawScheduled) {
		return;
	}
	redrawScheduled = true;
	requestAnimationFrame(() => {
		redrawScheduled = false;
		scrollRedraw();
	});
}

// --- Selection / navigation ---

function clampRow(r: number): number {
	return Math.max(0, Math.min(MAX_ROWS - 1, r));
}
function clampCol(c: number): number {
	return Math.max(0, Math.min(MAX_COLS - 1, c));
}

/** Scroll so the active cell is fully visible below the header band + right of the row gutter.
 * Audit C2-MED2: the tiny-viewport clamp (a viewport narrower/shorter than one cell would otherwise
 * park the cell under the sticky band) lives in the pure {@link scrollToReveal}.
 * **W3 frozen panes**: a cell INSIDE a frozen band is always on screen (pinned) -- never scroll that axis.
 * For a BODY cell, the effective band size = sticky band + the frozen-band pixels, so the cell reveals
 * BELOW/RIGHT of the frozen strip (not under it). With 0 frozen rows/cols this is the pre-W3 behaviour. */
function ensureActiveVisible(): void {
	if (active === null) {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	const fRows = renderer.frozenRows;
	const fCols = renderer.frozenCols;
	// Only scroll the column axis for a BODY column (a frozen column is always visible at its pinned X).
	if (active.col >= fCols) {
		viewportEl.scrollLeft = scrollToReveal(
			colX(active.col, gutterW),
			COL_WIDTH,
			gutterW + frozenColsWidth(fCols),
			viewportEl.scrollLeft,
			viewportEl.clientWidth,
		);
	}
	if (active.row >= fRows) {
		viewportEl.scrollTop = scrollToReveal(
			rowY(active.row),
			ROW_HEIGHT,
			HEADER_HEIGHT + frozenRowsHeight(fRows),
			viewportEl.scrollTop,
			viewportEl.clientHeight,
		);
	}
}

/** Move the selection by (dr,dc), scroll it into view, repaint. No-op while editing. A plain (non-shift)
 *  move COLLAPSES any range back to the single focus cell (W-G-2a). */
function moveActive(dr: number, dc: number): void {
	const base = active ?? { row: 0, col: 0 };
	anchor = null; // a plain move clears the range
	active = { row: clampRow(base.row + dr), col: clampCol(base.col + dc) };
	ensureActiveVisible();
	redraw();
}

/** Set the selection to an absolute (clamped) SINGLE cell + scroll it into view (used after a commit nav
 *  or a known-bad arrow-discard). W-G-2a: clears any anchor -- this is a single-cell landing, and a stale
 *  anchor set by a shift-click during a pending edit would otherwise resurrect as a range on the next
 *  redraw (Codex W-G-2a re-audit LOW). */
function setActiveClamped(row: number, col: number): void {
	anchor = null;
	active = { row: clampRow(row), col: clampCol(col) };
	ensureActiveVisible();
}

/** **Excel nav keys** -- jump the selection to an absolute (clamped) SINGLE cell, scroll it into view, and
 *  repaint. The absolute-landing counterpart of {@link moveActive} (which moves by a delta): Home / End /
 *  Ctrl+Home / Ctrl+End all land on a known cell rather than stepping. Collapses any range (clears the
 *  anchor, via {@link setActiveClamped}) -- these are single-cell landings, matching a plain arrow move. */
function jumpActive(row: number, col: number): void {
	setActiveClamped(row, col);
	redraw();
}

/** **Excel nav keys** -- the last USED cell from the current snapshot's extent: the intersection of the
 *  greatest populated row and the greatest populated column (Excel's Ctrl+End target). An empty / absent
 *  snapshot has no used cells, so this returns A1 `{row:0,col:0}`. Coordinates are clamped to the grid by
 *  the caller's {@link jumpActive}. Computed lazily on keypress (not cached) -- the snapshot can change on
 *  any render, and a stale extent would jump to the wrong cell. */
function usedExtent(): { row: number; col: number } {
	if (fullSnapshot === null || fullSnapshot.entries.length === 0) {
		return { row: 0, col: 0 };
	}
	let maxRow = 0;
	let maxCol = 0;
	for (const e of fullSnapshot.entries) {
		if (e.row > maxRow) {
			maxRow = e.row;
		}
		if (e.col > maxCol) {
			maxCol = e.col;
		}
	}
	return { row: maxRow, col: maxCol };
}

/** **Excel nav keys** -- the number of whole data rows currently visible below the sticky header, for
 *  PageUp / PageDown (which move the active cell by one screenful). At least 1 so a tiny viewport still
 *  advances by a cell rather than stalling. */
function visibleRowSpan(): number {
	const usable = viewportEl.clientHeight - HEADER_HEIGHT;
	return Math.max(1, Math.floor(usable / ROW_HEIGHT));
}

/** **W-G-2a** -- collapse any multi-cell range back to the single focus cell (clear the anchor). */
function collapseSelection(): void {
	anchor = null;
}

/** **W-G-2a** -- extend the selection by moving the FOCUS by (dr,dc), keeping (or establishing) the anchor
 *  at the cell the focus started from. Shift+Arrow drives this; the range is anchor..focus. */
function extendActive(dr: number, dc: number): void {
	const base = active ?? { row: 0, col: 0 };
	if (anchor === null) {
		anchor = base; // the focus's current cell becomes the fixed corner
	}
	active = { row: clampRow(base.row + dr), col: clampCol(base.col + dc) };
	ensureActiveVisible();
	redraw();
}

/** **W-G-2a** -- the current selection rect, or `null` for a single-cell selection. Passed to every
 *  renderer draw call; `null` keeps the single-cell paint path byte-identical to pre-W-G-2a. Returns
 *  `null` for a DEGENERATE range too (anchor === focus -- reachable via shift-click on the current cell
 *  or shift-arrow at a clamped boundary), so a no-op shift gesture never paints a 1-cell "range" box
 *  (Codex W-G-2a LOW). The anchor stays set, so a subsequent shift-extend still grows from it. */
function currentSelection(): SelectionRect | null {
	if (anchor === null || active === null) {
		return null;
	}
	if (anchor.row === active.row && anchor.col === active.col) {
		return null;
	}
	return selectionRect(anchor, active);
}

/**
 * **W-G copy/paste + fill** -- snapshot a grid rectangle's UNDERLYING content into a {@link GridClipboard}
 * (each cell's formula-with-`=` or literal, via {@link priorCellContent}). Shared by copy/cut (the
 * selection) and the fill handle (the drag source). Returns `null` if ANY cell is OVERSIZE: such a cell's
 * value is never materialized, so it cannot be copied -- and silently storing `''` would CLEAR the paste
 * target (No-Fallbacks: the caller surfaces a visible error instead, megaudit HIGH). `sheet` is recorded
 * so a cross-sheet cut clears the correct sheet.
 */
function readRectClipboard(top: number, left: number, rows: number, cols: number, isCut: boolean): GridClipboard | null {
	if (fullSnapshot === null) {
		return null;
	}
	const cells: { rawInput: string }[][] = [];
	for (let r = 0; r < rows; r += 1) {
		const rowCells: { rawInput: string }[] = [];
		for (let c = 0; c < cols; c += 1) {
			const pc = priorCellContent(renderer.entryAt(top + r, left + c));
			if (pc.oversize) {
				return null; // cannot copy an over-cap value (would otherwise silently clear the target)
			}
			rowCells.push({ rawInput: pc.text });
		}
		cells.push(rowCells);
	}
	return { sheet: fullSnapshot.sheet, top, left, rows, cols, cells, isCut };
}

function copyGridSelection(isCut: boolean): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	// A new copy/cut REPLACES whatever was on the internal clipboard, so clear it up front. Otherwise a
	// FAILED copy/cut (an over-cap cell -> readRectClipboard null) would leave a stale prior CUT live, and a
	// later paste would silently move that old source despite the "nothing was copied" message just shown --
	// data loss (No-Fallbacks: a failed op must not leave actionable stale state). (deep-audit HIGH)
	gridClipboard = null;
	const sel = currentSelection();
	const top = sel === null ? active.row : sel.minRow;
	const left = sel === null ? active.col : sel.minCol;
	const rows = sel === null ? 1 : sel.maxRow - sel.minRow + 1;
	const cols = sel === null ? 1 : sel.maxCol - sel.minCol + 1;
	const clip = readRectClipboard(top, left, rows, cols, isCut);
	if (clip === null) {
		showError('A cell in this selection is too large to copy; nothing was copied.', 'transient');
		return;
	}
	gridClipboard = clip;
	// Round 5: ALSO write the selection to the OS clipboard as TSV (display values), so a Quantbook copy
	// can paste into Excel / Google Sheets / Numbers. The internal clipboard above stays the source of
	// truth for an in-grid paste (it preserves formula-ref translation + the cut-move); the OS write is
	// the cross-app bridge only.
	const tsv = buildSelectionTsv(top, left, rows, cols);
	writeOsClipboard(tsv);
	// Round-5 LOW fix (cut-paste echo): arm the consumed-cut guard for a CUT; a plain COPY supersedes
	// any prior cut's TSV on the OS clipboard, so both trackers reset (see their declaration).
	pendingCutOsTsv = isCut ? tsv : null;
	consumedCutOsTsv = null;
}

/** Build a TSV block of the DISPLAY values over a rect (Excel pastes shown text, not formulas). Tabs and
 *  newlines inside a cell are flattened to spaces so they cannot corrupt the row/column structure. */
function buildSelectionTsv(top: number, left: number, rows: number, cols: number): string {
	const lines: string[] = [];
	for (let r = 0; r < rows; r += 1) {
		const rowCells: string[] = [];
		for (let c = 0; c < cols; c += 1) {
			const e = renderer.entryAt(top + r, left + c);
			const disp = e === undefined ? '' : typeof e.rendered === 'string' ? e.rendered : formatCellValue(e.value);
			rowCells.push(disp.replace(/[\t\r\n]+/g, ' '));
		}
		lines.push(rowCells.join('\t'));
	}
	return lines.join('\n');
}

/** Write text to the OS clipboard. The OS clipboard is a SYSTEM BOUNDARY: a permission denial / absent API
 *  must not break the internal copy that already succeeded -- log it (No-Fallbacks: never silently swallow)
 *  and continue. */
function writeOsClipboard(text: string): void {
	try {
		const clip = navigator.clipboard;
		if (clip === undefined) {
			return;
		}
		clip.writeText(text).catch((err) => console.warn('[sheets-webview] OS clipboard write failed:', err));
	} catch (err) {
		console.warn('[sheets-webview] OS clipboard write threw:', err);
	}
}

/**
 * **W-G fill handle** -- the rect a fill drag will cover: the source extended in the DOMINANT axis (down
 * or right) to the dragged cell, growth-only (v1 does not fill up/left). A pure helper of the drag.
 */
function computeFillPreview(source: SelectionRect, dragRow: number, dragCol: number): SelectionRect {
	const downDist = Math.max(0, dragRow - source.maxRow);
	const rightDist = Math.max(0, dragCol - source.maxCol);
	if (downDist >= rightDist) {
		return { minRow: source.minRow, maxRow: source.maxRow + downDist, minCol: source.minCol, maxCol: source.maxCol };
	}
	return { minRow: source.minRow, maxRow: source.maxRow, minCol: source.minCol, maxCol: source.maxCol + rightDist };
}

/**
 * **W-G fill handle** -- on drag end, fill the extension cells (source replicated with relative-ref offset)
 * as ONE atomic `putCells` batch, then select the filled rect (Excel selects the result). No-op when the
 * preview did not extend past the source.
 */
// Returns true iff a fill was actually committed (a real extension). The caller suppresses the post-drag
// click ONLY when true, so a no-op handle tap (no extension) still selects the clicked cell (Lane C).
function applyFill(): boolean {
	if (fullSnapshot === null || fillSource === null || fillPreview === null) {
		return false;
	}
	const src = fillSource;
	const srcRows = src.maxRow - src.minRow + 1;
	const srcCols = src.maxCol - src.minCol + 1;
	const fillRows = fillPreview.maxRow - src.minRow + 1;
	const fillCols = fillPreview.maxCol - src.minCol + 1;
	if (fillRows <= srcRows && fillCols <= srcCols) {
		return false; // no extension
	}
	// Round 5 (audit stability): cap the fill target BEFORE planFill builds the array (mirrors the paste cap +
	// the host's MAX_BATCH_CELLS) so an autoscroll-extended fill can't construct an unbounded cell array.
	if (fillRows * fillCols > MAX_PUT_CELLS) {
		showError('That fill area is too large (' + (fillRows * fillCols).toLocaleString() + ' cells; the limit is ' + MAX_PUT_CELLS.toLocaleString() + '). Drag a smaller range.', 'transient');
		return false;
	}
	const clip = readRectClipboard(src.minRow, src.minCol, srcRows, srcCols, false);
	if (clip === null) {
		showError('A cell in the fill source is too large to fill; nothing was filled.', 'transient');
		return false;
	}
	const cells = planFill(clip, fillRows, fillCols);
	if (cells.length === 0) {
		return false;
	}
	vscode.postMessage({ type: 'putCells', sheet: fullSnapshot.sheet, cells, undoLabel: 'Fill', webviewId: WEBVIEW_ID });
	// Select the filled rect (anchor at the source top-left, focus at the extension's bottom-right).
	anchor = { row: src.minRow, col: src.minCol };
	active = { row: fillPreview.maxRow, col: fillPreview.maxCol };
	ensureActiveVisible();
	return true;
}

/**
 * **W-G copy/paste** -- paste {@link gridClipboard} into the current selection: {@link planPaste} computes
 * the (ref-translated) target writes, which are sent as ONE atomic `putCells` batch (a single undo unit;
 * the host validates extent + applies). A cut is consumed by its paste (move): the clipboard is cleared so
 * a second paste does not re-clear the -- now moved -- source. No-op when nothing is on the clipboard.
 */
// **Round 5 (2026-06-10)** -- webview-side cell cap for paste + fill, mirroring the host's MAX_BATCH_CELLS
// (cellGridLogic). Preflighted BEFORE planPaste/planFill builds the array (audit stability finding).
const MAX_PUT_CELLS = 100_000;
function pasteGridClipboard(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	// Round 5: with no internal Quantbook clipboard, paste from the OS clipboard (TSV from Excel / Sheets /
	// Numbers). A Quantbook copy populates BOTH, so the internal path below wins for in-grid paste (formula
	// refs + cut-move); the OS path is the cross-app bridge for data that originated elsewhere.
	if (gridClipboard === null) {
		pasteFromOsClipboard();
		return;
	}
	// megaudit HIGH: a CUT moves cells, clearing the SOURCE. The source clears are posted to the current
	// sheet's putCells, so a cross-sheet cut would clear the wrong sheet. Refuse it loudly (No-Fallbacks)
	// rather than corrupt the active sheet; a cross-sheet COPY is fine (it never clears the source).
	if (gridClipboard.isCut && gridClipboard.sheet !== fullSnapshot.sheet) {
		showError('Cut-paste across sheets is not supported yet -- copy instead, or paste on the source sheet.', 'transient');
		return;
	}
	const sel = currentSelection();
	const selTop = sel === null ? active.row : sel.minRow;
	const selLeft = sel === null ? active.col : sel.minCol;
	const selRows = sel === null ? 1 : sel.maxRow - sel.minRow + 1;
	const selCols = sel === null ? 1 : sel.maxCol - sel.minCol + 1;
	// megaudit Lane C: refuse a size-mismatched paste (a multi-cell block into a LARGER selection that is not a
	// whole multiple) instead of silently pasting a partial block (No-Fallbacks; Excel "areas not same size").
	if (pasteAreaMismatch(gridClipboard, selRows, selCols)) {
		showError('Cannot paste: the copy and paste areas are not the same size. Select a single cell, or a selection that is a whole multiple of the copied block.', 'transient');
		return;
	}
	// Round 5 (audit stability): cap the paste target BEFORE planPaste builds the cell array, so a paste into
	// a whole-column/whole-sheet selection can't freeze the webview constructing 1M+ cells only for the host
	// to reject them past its own cap. Mirrors the host's MAX_BATCH_CELLS; loud, never a silent truncation.
	if (selRows * selCols > MAX_PUT_CELLS) {
		showError('That paste area is too large (' + (selRows * selCols).toLocaleString() + ' cells; the limit is ' + MAX_PUT_CELLS.toLocaleString() + '). Select a smaller range.', 'transient');
		return;
	}
	const cells = planPaste(gridClipboard, selTop, selLeft, selRows, selCols);
	if (cells.length === 0) {
		return;
	}
	const undoLabel = gridClipboard.isCut ? 'Cut' : 'Paste';
	vscode.postMessage({ type: 'putCells', sheet: fullSnapshot.sheet, cells, undoLabel, webviewId: WEBVIEW_ID });
	if (gridClipboard.isCut) {
		gridClipboard = null;
		// Round-5 LOW fix (cut-paste echo): the cut is consumed -- its TSV still sits on the OS
		// clipboard, so mark it "already moved" and the OS-paste path will no-op on it (Excel semantics).
		consumedCutOsTsv = pendingCutOsTsv;
		pendingCutOsTsv = null;
	}
}

/** Parse an OS-clipboard TSV block into a row-major grid of cell strings (tab = column, newline = row). */
function parseTsv(text: string): string[][] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.split('\n');
	// A trailing newline yields a final empty line -- drop it so paste height matches the visible block.
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.map((line) => line.split('\t'));
}

/**
 * Paste from the OS clipboard (TSV) at the active cell. The OS clipboard is a SYSTEM BOUNDARY: `readText`
 * is permission-gated + async, so failures are caught + logged (No-Fallbacks exception: a system boundary)
 * and degrade to a no-op (the prior behavior when nothing was on the internal clipboard). Pasted cells are
 * LITERAL strings -- a pasted "=SUM(A1:A2)" becomes a formula (host parses rawInput), numbers become
 * numbers, exactly as typing them would.
 */
function pasteFromOsClipboard(): void {
	const clip = navigator.clipboard;
	if (clip === undefined || fullSnapshot === null || active === null) {
		return;
	}
	// Round-5 audit (lane A MED): capture the paste TARGET at Ctrl+V time -- `readText` is async (a
	// permission prompt can stall it), and reading the LIVE active/sheet inside the .then would land
	// the paste wherever the user has navigated to in the meantime (wrong sheet / wrong anchor).
	const targetSheet = fullSnapshot.sheet;
	const top = active.row;
	const left = active.col;
	clip
		.readText()
		.then((text) => {
			if (typeof text !== 'string' || text.length === 0 || fullSnapshot === null || active === null) {
				return;
			}
			// Round-5 audit (lane A MED): the sheet changed while the read was in flight -- the captured
			// target no longer exists on screen. Refuse loudly rather than write to a sheet the user left.
			if (fullSnapshot.sheet !== targetSheet) {
				showError('Paste cancelled: the sheet changed while the clipboard was being read. Paste again on the sheet you want.', 'transient');
				return;
			}
			// Round-5 audit (lane B HIGH): an editor opened while the read was in flight (type-to-edit is
			// one keystroke). Never mutate the grid under an open editor -- the round-3 invariant.
			if (editState !== null) {
				showError('Paste cancelled: finish the open cell edit first, then paste again.', 'transient');
				return;
			}
			// Round-5 LOW fix (cut-paste echo): this TSV is a CONSUMED Quantbook cut -- the move already
			// happened; a second paste must no-op (Excel semantics; a deliberate, documented no-op, not a
			// fallback). Diagnosable via the debug line.
			if (consumedCutOsTsv !== null && text === consumedCutOsTsv) {
				console.warn('[sheets-webview] OS paste skipped: the clipboard still holds an already-consumed cut');
				return;
			}
			const grid = parseTsv(text);
			const rows = grid.length;
			const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
			if (rows === 0 || cols === 0) {
				return;
			}
			if (rows * cols > MAX_PUT_CELLS) {
				showError('That paste is too large (' + (rows * cols).toLocaleString() + ' cells; the limit is ' + MAX_PUT_CELLS.toLocaleString() + ').', 'transient');
				return;
			}
			const cells: { row: number; col: number; rawInput: string }[] = [];
			// Round-5 LOW fix: count cells clipped at the grid edge and SAY so (No-Fallbacks: a paste
			// that silently drops part of the block reads as data loss).
			let clipped = 0;
			for (let r = 0; r < rows; r += 1) {
				for (let c = 0; c < grid[r].length; c += 1) {
					if (top + r < MAX_ROWS && left + c < MAX_COLS) {
						cells.push({ row: top + r, col: left + c, rawInput: grid[r][c] });
					} else {
						clipped += 1;
					}
				}
			}
			if (clipped > 0) {
				showError(
					String(clipped) + (clipped === 1 ? ' cell of the pasted block fell' : ' cells of the pasted block fell') +
					' beyond the grid edge and ' + (clipped === 1 ? 'was' : 'were') + ' not pasted.',
					'transient',
				);
			}
			if (cells.length === 0) {
				return;
			}
			vscode.postMessage({ type: 'putCells', sheet: targetSheet, cells, undoLabel: 'Paste', webviewId: WEBVIEW_ID });
			// Select the pasted block (anchor at the origin, focus at the bottom-right).
			anchor = { row: top, col: left };
			active = { row: clampRow(top + rows - 1), col: clampCol(left + cols - 1) };
			ensureActiveVisible();
			redraw();
		})
		.catch((err) => console.warn('[sheets-webview] OS clipboard read failed:', err));
}

/**
 * **FE-4 Ctrl-D / Ctrl-R (fill down / fill right).** REUSE the shipped fill machinery -- `readRectClipboard`
 * (which reads each source cell's formula TEXT via `priorCellContent`, so a formula's relative refs travel)
 * + `planFill` (which offsets each filled cell's refs by its distance from the source it repeats). NO
 * re-implemented ref translation. Mode-gated by the document keydown handler so they fire ONLY in nav/range
 * mode (an editor can never be open then), and capped by `MAX_PUT_CELLS` exactly like paste/fill-drag.
 *
 * `axis` selects down vs right. Semantics (Excel-faithful):
 *   - a MULTI-cell selection along the fill axis: the TOP row (Ctrl-D) / LEFT column (Ctrl-R) of the
 *     selection is the source; it fills DOWN / RIGHT through the rest of the selection. The other axis of
 *     the selection is filled in parallel (every column of a multi-column Ctrl-D fills down independently).
 *   - a SINGLE cell (no fill-axis extent): Excel fills from the cell ABOVE (Ctrl-D) / to the LEFT (Ctrl-R)
 *     into the active cell. A no-op at the top row (Ctrl-D) / left column (Ctrl-R) -- nothing to fill from.
 *
 * Like `clearActiveCell`, this is a nav-mode mutation that does NOT route through `runAfterResolvingEdit`:
 * the document handler's `editState !== null` early-return guarantees no editor is open here. A pending
 * commit cannot exist either (a pending editor IS an open `editState`).
 */
function fillSelection(axis: 'down' | 'right'): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	const sel = currentSelection();
	// The selection rect (or the single active cell). minRow/minCol is the fill SOURCE origin.
	const minRow = sel === null ? active.row : sel.minRow;
	const minCol = sel === null ? active.col : sel.minCol;
	const maxRow = sel === null ? active.row : sel.maxRow;
	const maxCol = sel === null ? active.col : sel.maxCol;
	const selRows = maxRow - minRow + 1;
	const selCols = maxCol - minCol + 1;

	// Resolve the SOURCE rect (top/left/rows/cols) + the FILL rect (fillRows/fillCols) anchored at the source
	// top-left, both in absolute coordinates. `planFill` returns the cells OUTSIDE the source rect.
	let srcTop: number;
	let srcLeft: number;
	let srcRows: number;
	let srcCols: number;
	let fillRows: number;
	let fillCols: number;
	if (axis === 'down') {
		if (selRows > 1) {
			// Multi-row selection: top row is the source, fill down through the selection.
			srcTop = minRow;
			srcLeft = minCol;
			srcRows = 1;
			srcCols = selCols;
			fillRows = selRows;
			fillCols = selCols;
		} else {
			// Single row (a single cell, or a single-row range): fill from the row ABOVE into it.
			if (minRow === 0) {
				return; // no row above -- nothing to fill from (Excel no-ops)
			}
			srcTop = minRow - 1;
			srcLeft = minCol;
			srcRows = 1;
			srcCols = selCols;
			fillRows = 2; // the source row + the target row below it
			fillCols = selCols;
		}
	} else {
		if (selCols > 1) {
			// Multi-column selection: left column is the source, fill right through the selection.
			srcTop = minRow;
			srcLeft = minCol;
			srcRows = selRows;
			srcCols = 1;
			fillRows = selRows;
			fillCols = selCols;
		} else {
			// Single column (a single cell, or a single-column range): fill from the column to the LEFT into it.
			if (minCol === 0) {
				return; // no column to the left -- nothing to fill from (Excel no-ops)
			}
			srcTop = minRow;
			srcLeft = minCol - 1;
			srcRows = selRows;
			srcCols = 1;
			fillRows = selRows;
			fillCols = 2; // the source column + the target column to its right
		}
	}

	// Cap the fill target BEFORE planFill builds the array (mirrors paste + the fill-drag cap). Loud refusal,
	// never a silent truncation (No-Fallbacks).
	if (fillRows * fillCols > MAX_PUT_CELLS) {
		showError('That fill area is too large (' + (fillRows * fillCols).toLocaleString() + ' cells; the limit is ' + MAX_PUT_CELLS.toLocaleString() + '). Select a smaller range.', 'transient');
		return;
	}
	const clip = readRectClipboard(srcTop, srcLeft, srcRows, srcCols, false);
	if (clip === null) {
		showError('A cell in the fill source is too large to fill; nothing was filled.', 'transient');
		return;
	}
	const cells = planFill(clip, fillRows, fillCols);
	if (cells.length === 0) {
		return; // nothing outside the source -- no-op (e.g. a single cell at row 0 already returned above)
	}
	vscode.postMessage({
		type: 'putCells',
		sheet: fullSnapshot.sheet,
		cells,
		undoLabel: axis === 'down' ? 'Fill down' : 'Fill right',
		webviewId: WEBVIEW_ID,
	});
	redraw();
}

/** **Megaudit (B2)** -- the selection delta for a commit/nav key, or `null` for any other key. Enter and
 * Tab always carry a vector (they commit+move); the arrow keys carry one too, but the editor only ACTS on
 * an arrow when leaving a known-bad cell (see the input keydown handler) -- a normal edit keeps arrows as
 * text-caret movement. Escape is handled separately (cancel). */
function navVector(key: string, shift: boolean): { dr: number; dc: number } | null {
	switch (key) {
		case 'Enter':
			return { dr: 1, dc: 0 }; // Excel: Enter commits + moves down
		case 'Tab':
			return { dr: 0, dc: shift ? -1 : 1 }; // Tab right, Shift+Tab left
		case 'ArrowUp':
			return { dr: -1, dc: 0 };
		case 'ArrowDown':
			return { dr: 1, dc: 0 };
		case 'ArrowLeft':
			return { dr: 0, dc: -1 };
		case 'ArrowRight':
			return { dr: 0, dc: 1 };
		default:
			return null;
	}
}

/** Audit O2-MED3: clear the active cell (Delete/Backspace when NOT editing). The host classifies an
 * empty `rawInput` as `{ kind: 'blank' }` = clear (`cellGridLogic.classifyCellInput`), so this reuses
 * the coordinate-addressed putValue path -- no editState involved (we are not in an edit). */
function clearActiveCell(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	// FE-2-0 Phase 2: optimistically drop this cell's error tint. The blanket `errorCells.clear()` on
	// render is gone (errors are now per-cell), and a Delete carries no editor/commit-token to resolve --
	// so without this a Delete'd cell would keep a stale error tint. Clearing to blank is essentially
	// always valid; if it DOES fail, the host's `errorReply` re-decorates the cell (No-Fallbacks).
	// W-G-2a: Delete clears only the FOCUS cell this increment (range-aware clear is a later increment);
	// collapse any range so the UI doesn't imply a multi-cell clear happened.
	collapseSelection();
	errorCells.delete(active.row + ',' + active.col);
	// megaudit (webview-instance token): stamp WEBVIEW_ID so a stale post-reload errorReply for this Delete
	// (which carries no commitId, only a tint) is dropped by the errorReply guard instead of tinting a fresh cell.
	vscode.postMessage({ type: 'putValue', sheet: fullSnapshot.sheet, row: active.row, col: active.col, rawInput: '', webviewId: WEBVIEW_ID });
	redraw();
}

// --- Overlay editor ---

/** A sentinel `blur` baseline for an over-cap cell reached via type-to-edit. Its runtime value begins with a
 * NUL char (a `\u0000` escape in source, so the file stays plain text) -- a char an `<input>` cannot
 * produce -- so blur always treats the typed value as a CHANGE (and commits it). Used INSTEAD of the real
 * (possibly multi-MB) prior content so that string is never built or held (megaudit MED: keep the oversize
 * defense on the type-to-edit path). Worst case if somehow matched, blur reads "unchanged" and abandons --
 * benign. */
const OVERSIZE_BASELINE = '\u0000-oversize-prior-value';

/**
 * The cell's pre-edit content for {@link beginEdit}: the F2/click prefill AND the `blur` baseline.
 *
 * Returns `oversize:true` (with empty `text`) when the prior value exceeds {@link MAX_RAW_INPUT_LENGTH},
 * determined from the RAW formula/text length BEFORE concatenating/formatting -- so a multi-MB value is
 * NEVER materialized (re-audit HIGH-2 + megaudit MED: the editor cannot host such a value, and we must not
 * build or hold it). Pure; no DOM.
 */
function priorCellContent(entry: QuantbookCellSnapshot['entries'][number] | undefined): { text: string; oversize: boolean } {
	if (entry === undefined) {
		return { text: '', oversize: false };
	}
	if (typeof entry.formula === 'string') {
		// The engine stores formula text VERBATIM, which may or may not carry the leading '=' (the napi
		// putFormula example is "=SUM(...)"; a snapshot may also carry a bare "A1+1"). Emit exactly one '='
		// so neither the editor prefill nor the formula bar double-prefixes (Codex W-G MED). Measure the
		// DISPLAYED length first (startsWith is O(1)) so an over-cap formula is still flagged WITHOUT building
		// the concatenation.
		const hasEq = entry.formula.startsWith('=');
		const displayLen = hasEq ? entry.formula.length : entry.formula.length + 1;
		if (displayLen > MAX_RAW_INPUT_LENGTH) {
			return { text: '', oversize: true };
		}
		return { text: hasEq ? entry.formula : '=' + entry.formula, oversize: false };
	}
	// **FE-5 W-R (2026-06-12)**: a STYLE-ONLY blank cell (a fill/border on an empty cell) is projected as a
	// `pending` entry with a styleId but NO formula -- it has no content, so click-to-edit pre-fills EMPTY
	// (NOT the `(pending)` placeholder, which is for a formula cell still computing -- that carries a
	// `formula`, handled above). Without this, editing a fill-only cell would seed the editor with "(pending)".
	if (entry.value.kind === 'pending') {
		return { text: '', oversize: false };
	}
	// Only a `text` value can realistically be multi-MB; check its raw length before `formatCellValue` builds it.
	if (entry.value.kind === 'text' && entry.value.value.length > MAX_RAW_INPUT_LENGTH) {
		return { text: '', oversize: true };
	}
	const lit = formatCellValue(entry.value);
	if (lit.length > MAX_RAW_INPUT_LENGTH) {
		return { text: '', oversize: true }; // defensive: a pathological number/error projection
	}
	return { text: lit, oversize: false };
}

/**
 * **W-G bound-cell name display** -- show/hide the formula-bar chip naming the reactive variable that
 * drives the active cell. The driving name is read from {@link publishedRanges} (the host->webview
 * published set already carries it) via the pure {@link publishedNameAt}; `null` (no active cell, or the
 * active cell is not a published target) hides the chip. The displayed name + the explanatory title are
 * clamped (C1-HIGH2 cap discipline) so a pathological variable name can neither blow the chip layout nor
 * the native title. Called UNCONDITIONALLY from {@link updateFormulaBar} -- BEFORE its formula-edit /
 * null-active guards -- so the chip never goes stale (e.g. a render that retracts the active cell's
 * publish mid formula-edit still clears it; the chip is metadata, separate from the editable input).
 */
function refreshPublishedChip(): void {
	const name = active === null ? null : publishedNameAt(publishedRanges, active.row, active.col);
	if (name === null) {
		publishedChipEl.hidden = true;
		publishedChipEl.textContent = '';
		publishedChipEl.removeAttribute('title');
		publishedChipEl.removeAttribute('aria-label');
		return;
	}
	const label = clampDisplayString('Driven by reactive variable "' + name + '"');
	publishedChipEl.textContent = clampDisplayString(name);
	publishedChipEl.title = label;
	publishedChipEl.setAttribute('aria-label', label);
	publishedChipEl.hidden = false;
}

/**
 * W-G -- refresh the formula bar from the active cell: its A1 ref in the name box and its UNDERLYING
 * content (a formula with its leading '=' or the raw literal) in the read-only field, so a computed cell
 * reveals its formula. An over-cap value is shown as a placeholder, never materialized (the same oversize
 * discipline as {@link priorCellContent}). Called on every content/selection repaint (`redraw` + the damage
 * fast path); a pure scroll changes neither selection nor content, so the scroll path deliberately omits it.
 *
 * **W-G-1b**: while the formula bar IS the live editor, this is a no-op -- a `redraw()` mid-typing (e.g. an
 * `errorReply` realign) must NOT overwrite the value the user is editing. The active cell is fixed during a
 * formula edit, so the name box need not update either. On edit close, `cancelEdit` nulls `editState` first,
 * then calls this to restore the committed display value. The published-cell chip ({@link refreshPublishedChip})
 * is refreshed first, unconditionally -- it is metadata next to the bar, not the edited value, so it stays
 * correct even while the bar is the live editor.
 */
function updateFormulaBar(): void {
	refreshPublishedChip();
	if (editState !== null && editState.surface === 'formula') {
		return;
	}
	if (active === null) {
		// FE-11: never overwrite the name box while it is the live editor (mirror the formula-bar guard above).
		if (!nameBoxEditing) {
			nameBoxEl.value = '';
		}
		formulaInputEl.value = '';
		return;
	}
	if (!nameBoxEditing) {
		// FE-11 v2: when the selection EXACTLY equals a named range (or single named cell) on this sheet, show
		// the NAME (e.g. `returns`) instead of the A1 ref -- Excel's name-box behavior. matchNameForSelection
		// returns `undefined` when nothing matches (the honest no-match), in which case we show the active
		// cell's A1 ref -- a typed result, NOT an error mask. The matcher normalizes the anchor+active extent.
		const matched = fullSnapshot === null
			? undefined
			: matchNameForSelection(
				{
					sheet: fullSnapshot.sheet,
					anchorRow: (anchor ?? active).row,
					anchorCol: (anchor ?? active).col,
					focusRow: active.row,
					focusCol: active.col,
				},
				definedNames,
			);
		nameBoxEl.value = matched ?? cellRefA1(active.row, active.col);
	}
	const entry = fullSnapshot === null ? undefined : renderer.entryAt(active.row, active.col);
	const content = priorCellContent(entry);
	formulaInputEl.value = content.oversize ? '(value too large to display)' : content.text;
}

/** Open the editor over (row,col). `initialChar` (type-to-edit) replaces the cell content. */
function beginEdit(row: number, col: number, initialChar?: string, prefillBaseline?: string): void {
	if (fullSnapshot === null) {
		return;
	}
	// FE megaudit M8: do NOT start a new edit while a commit is in flight.
	if (editState !== null && editState.pendingCommit) {
		return;
	}
	if (editState !== null) {
		cancelEdit();
	}
	// Select + reveal the cell on ANY entry point (click / F2 / type-to-edit). Megaudit MED-1 (re-audit):
	// this MUST happen BEFORE the oversize bail below -- a CLICK on an over-length cell still SELECTS it (the
	// editor just doesn't open). For F2/type the cell is already active, so this is a no-op there.
	// W-G-2a: editing is single-cell, so collapse any selection range to this focus cell.
	collapseSelection();
	active = { row, col };
	// Audit O2-MED2: F2 / type-to-edit on a scrolled-away active cell must bring it into view first,
	// otherwise the overlay editor opens off-screen (content-layer child positioned at the cell rect).
	ensureActiveVisible();
	const entry = renderer.entryAt(row, col);
	// The cell's content BEFORE this edit -- both the F2/click prefill AND the `blur` baseline.
	// Re-audit HIGH-2 + megaudit MED: a malformed/drifted snapshot can carry a multi-MB value/formula;
	// {@link priorCellContent} returns `oversize:true` WITHOUT building (or holding) that string -- it checks
	// the raw formula/text length first. F2/click on an oversize cell refuses to open the editor + surfaces a
	// visible error (No-Fallbacks); type-to-edit shows just the injected char with a sentinel blur baseline.
	const prior = priorCellContent(entry);
	if (initialChar === undefined && prior.oversize) {
		// F2 / click on an over-cap cell: refuse to OPEN the editor (the cell stays selected + revealed) and
		// surface a visible error -- No-Fallbacks: we never silently truncate the value.
		showError(
			`This cell's value is over the ${MAX_RAW_INPUT_LENGTH}-character editable limit, so it cannot be edited here.`,
			'transient',
		);
		return; // do NOT open the editor (the cell is selected + scrolled into view)
	}
	const prefill: string = initialChar !== undefined ? initialChar : prior.text;
	// The blur baseline. For an over-cap cell reached via type-to-edit we use a sentinel (the prior value is
	// never built/held); it can't equal any in-cap editor value, so blur correctly sees the typed char as a
	// change. Otherwise it is the real prior content (megaudit MED-1: NOT the injected char).
	const initialValue: string = prior.oversize ? OVERSIZE_BASELINE : prior.text;
	// W3 frozen panes (Codex HIGH-2): pin a frozen cell's editor (add back the frozen-axis scroll) so it stays
	// over its pinned cell; a body cell gets the plain content position (unchanged).
	const pos = overlayCellContentPos(row, col);
	inputEl.style.left = pos.left + 'px';
	inputEl.style.top = pos.top + 'px';
	inputEl.style.width = pos.width + 'px';
	inputEl.style.height = pos.height + 'px';
	inputEl.readOnly = false; // megaudit H1: a fresh editor is editable (a prior pending edit set readOnly)
	inputEl.value = prefill;
	inputEl.hidden = false;
	inputEl.style.clipPath = ''; // FE-2-0 polish: start unclipped; updateEditClip below sets it for this cell
	editState = { editEl: inputEl, surface: 'overlay', sheet: fullSnapshot.sheet, row, col, entry, initialValue, prefillBaseline, pendingCommit: false };
	updateEditClip(); // FE-2-0 polish: clip to the body pane (the cell may open partly under a sticky band)
	inputEl.focus();
	if (initialChar === undefined) {
		inputEl.select();
	}
	// NOTE: the call sites (click / F2 / type-to-edit) redraw() right after beginEdit to move the
	// selection box; beginEdit itself does not, to avoid a double paint.
}

function cancelEdit(): void {
	if (editState === null) {
		return;
	}
	const surface = editState.surface; // capture before nulling -- the teardown branch depends on it
	editState = null;
	// FE-3 range-pick: a closing editor ends point mode. Drop any live re-point span + in-flight drag/preview
	// so a later pointerdown cannot replace a stale span or paint a ghost. (pointPreview is normally already
	// null -- a drag ends on its own pointerup -- so the redraw is defensive: it only fires if a drag was
	// interrupted by this non-pointer teardown, e.g. Escape mid-drag.)
	const hadPointPreview = pointPreview !== null;
	pointDrag = null;
	pointInsertedSpan = null;
	pointPreview = null;
	if (hadPointPreview) {
		redraw();
	}
	if (surface === 'overlay') {
		inputEl.hidden = true;
		inputEl.value = '';
		inputEl.readOnly = false; // megaudit H1: clear the pending-commit lock so the next editor is editable
		inputEl.style.clipPath = ''; // FE-2-0 polish: drop any body-pane clip so a future editor starts clean
	} else {
		// W-G-1b formula bar: it is always visible (never hidden). Return it to display mode (readOnly) and
		// restore the committed content via updateFormulaBar -- editState is already null, so its
		// surface guard lets this write through. Do NOT clear/hide it.
		formulaInputEl.readOnly = true;
		// W2 formula intelligence: tear down the dropdown + hint + any pending validate (editState is already
		// nulled, so the assist functions' formulaBarIsEditing() guard reads false -- this is the explicit
		// cleanup). Done before updateFormulaBar so the bar returns to a clean display state.
		teardownFormulaAssist();
		updateFormulaBar();
	}
	clearCommitWatchdog(); // the editor is gone -- no pending commit to recover (re-audit HIGH)
	clearError(); // closing the editor resolves any 'edit'-source banner (re-audit MED-4)
}

/**
 * **W-G-1b** -- enter an edit in the FORMULA BAR (the single-active-editor model: the in-cell overlay stays
 * closed). Mirrors {@link beginEdit}'s FE-megaudit-M8 pending guard + the oversize refusal, but the bar is
 * always-visible, so there is no positioning / show -- it just flips `readOnly` off and becomes the live
 * `editEl`. The bar already shows the active cell's content (via {@link updateFormulaBar}), which is the blur
 * baseline. Triggered by focusing the bar (Excel: focusing the formula bar enters edit).
 */
function beginEditFormula(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	if (editState !== null && editState.surface === 'formula') {
		return; // already the live formula editor (a focus that never left)
	}
	if (editState !== null && editState.pendingCommit) {
		return; // FE megaudit M8: never start a new edit while a commit is in flight
	}
	if (editState !== null) {
		cancelEdit(); // an unchanged overlay edit still open -- close it before the bar takes over
	}
	// W-G-2a: editing the focus cell is single-cell; collapse any range first (repaint to clear the range
	// paint before the edit begins). A no-op when there is no range.
	if (anchor !== null) {
		collapseSelection();
		redraw();
	}
	const entry = renderer.entryAt(active.row, active.col);
	const prior = priorCellContent(entry);
	if (prior.oversize) {
		// Refuse to edit an over-cap value in the bar (No-Fallbacks: never silently truncate). The bar keeps
		// showing the '(value too large...)' placeholder and stays readOnly; the user can still copy it out.
		showError(
			`This cell's value is over the ${MAX_RAW_INPUT_LENGTH}-character editable limit, so it cannot be edited here.`,
			'transient',
		);
		return;
	}
	formulaInputEl.readOnly = false;
	editState = {
		editEl: formulaInputEl,
		surface: 'formula',
		sheet: fullSnapshot.sheet,
		row: active.row,
		col: active.col,
		entry,
		initialValue: prior.text, // the displayed content == the blur baseline (megaudit MED-1: the prior value)
		pendingCommit: false,
	};
	// W2 formula intelligence: the formula bar is now the live editor. Fetch the function catalog (once) for
	// the completion dropdown, and seed the validation + signature hint off the current content (e.g. opening
	// the bar on an already-invalid formula shows its diagnostic). No dropdown opens until the user types.
	ensureFunctionListRequested();
	scheduleValidate();
	updateSignatureHint();
}

// ============================================================================
// FE-11 name box -- the editable Excel-style reference field.
//
// It is a SELF-CONTAINED native input, deliberately OUTSIDE the `editState` single-cell-writer machine: it
// never writes a cell, so it can never be committed-as-a-cell (the trap a third `editState` surface would
// create -- a chrome action resolving it via commitEdit would otherwise write a CELL). Its ONLY tie to the
// cell editor is RESOLVING an open one when it takes focus (a competing native surface -- exactly what
// `resolveEditForNativeSurface` exists for; the same seam the right-click context menu uses).
//
// Enter SUBMITS (post `nameBoxSubmit`; the host routes go-to / define / error). Esc reverts + returns focus to
// the grid. Blur reverts WITHOUT stealing focus (Excel: a name-box blur abandons typed text -- only Enter
// commits; this asymmetry vs the formula bar's blur-commit is intentional, so a blur can never silently
// define a name). The webview NEVER navigates/mutates here -- the host decides, and any resulting `navigateTo`
// re-enters through the existing handler.
// ============================================================================

/** Enter name-box edit mode: flip it editable + select its text for easy overwrite. No-op if already editing
 * or nothing is selected (there is no cell to navigate from / range to define over). */
function beginNameBoxEdit(): void {
	if (nameBoxEditing || fullSnapshot === null || active === null) {
		return;
	}
	nameBoxEditing = true;
	nameBoxEl.readOnly = false;
	nameBoxEl.select();
}

/** Leave name-box edit mode: flip it back to read-only display and restore the active cell's A1 ref. Does NOT
 * move focus (the caller decides). */
function endNameBoxEdit(): void {
	if (!nameBoxEditing) {
		return;
	}
	nameBoxEditing = false;
	nameBoxEl.readOnly = true;
	updateFormulaBar(); // nameBoxEditing is now false, so this writes the display value through
}

/** Abandon the typed text (Esc) and return focus to the grid. */
function revertNameBox(): void {
	endNameBoxEdit();
	viewportEl.focus();
}

/** Submit the name box (Enter): post a `nameBoxSubmit` for the host to route. Empty text reverts. */
function submitNameBox(): void {
	if (!nameBoxEditing) {
		return;
	}
	const text = nameBoxEl.value.trim();
	if (text.length === 0 || fullSnapshot === null || active === null) {
		revertNameBox();
		return;
	}
	const anc = anchor ?? active;
	const sheet = fullSnapshot.sheet;
	const selection = { anchorRow: anc.row, anchorCol: anc.col, focusRow: active.row, focusCol: active.col };
	endNameBoxEdit();
	viewportEl.focus();
	vscode.postMessage({ type: 'nameBoxSubmit', text, sheet, selection });
}

// ============================================================================
// W2 formula intelligence (2026-06-09) -- lightweight assist on the formula bar.
//
// Three affordances, all driven by the pure `formulaIntel.ts` core, all scoped to the FORMULA BAR editor
// (`editState.surface === 'formula'`) so they never interfere with the in-cell overlay edit path:
//   1. an inline validation HINT (debounced `validateFormula` -> the engine's parse/bind diagnostics);
//   2. a function-completion DROPDOWN (`listFunctions` -> a prefix-filtered listbox; Enter/Tab inserts);
//   3. a signature HINT (the function's parameter list when the caret is inside `FN(`).
//
// The dropdown's keyboard handling is interleaved with the SHARED `onEditKeydown` (see the guard at the top
// of that handler): when the dropdown is OPEN, Up/Down/Enter/Tab/Esc drive the LIST (and are swallowed
// before the grid-nav / commit logic); when CLOSED, every key falls through to the existing edit machinery
// unchanged. This preserves Enter-commit-and-move, Esc-revert, Tab-nav, the single-active-editor model, the
// oversize refusal, and the reload-race guards.
// ============================================================================

/** The function catalog (built-ins + UDFs) fetched once from the host after the handshake; null until it
 * arrives. The completion dropdown shows NOTHING until this is populated (No-Fallbacks: no fabricated list). */
let functionCatalog: CompletionFunction[] | null = null;
/** Canonical-name -> metadata, for the signature hint (built alongside `functionCatalog`). */
let functionMetaByName: Map<string, FunctionMetadataJson> = new Map();
/** Set once so we don't spam `listFunctions` requests (one fetch is enough -- the catalog is session-stable). */
let functionListRequested = false;

/** The open completion dropdown's state, or null when closed. `items` is the filtered candidate list;
 * `activeIndex` is the highlighted row (-1 = none); `replaceStart`/`replaceEnd` are the [start,end) offsets
 * in the input value that an accepted completion REPLACES (the typed prefix). */
interface CompletionState {
	items: CompletionItem[];
	activeIndex: number;
	replaceStart: number;
	replaceEnd: number;
}
let completion: CompletionState | null = null;

/** How many completion candidates to render at once (an empty-prefix "show all" is capped to this). */
const MAX_COMPLETION_ITEMS = 50;

/** Debounce (ms) before a formula-bar keystroke triggers `validateFormula` -- keeps the engine off the
 * per-keystroke hot path while staying responsive. */
const VALIDATE_DEBOUNCE_MS = 250;
let validateTimer: ReturnType<typeof setTimeout> | undefined;
/** Monotonic per-request token: a debounced validate stamps the next id; only the reply whose id equals
 * `latestValidateReqId` is applied (a superseded in-flight validate is dropped -- the user kept typing). */
let nextValidateReqId = 0;
let latestValidateReqId = -1;
/** Monotonic token for the one-shot `listFunctions` request (matched in the reply to drop a stale answer). */
let nextFuncReqId = 0;
let latestFuncReqId = -1;

/** Is the formula bar the LIVE editor right now? All assist affordances are gated on this. */
function formulaBarIsEditing(): boolean {
	return editState !== null && editState.surface === 'formula';
}

/** Request the function catalog from the host (once). Called when the formula bar first enters edit -- by
 * then the channel + session are live. Idempotent. */
function ensureFunctionListRequested(): void {
	if (functionListRequested) {
		return;
	}
	functionListRequested = true;
	const reqId = ++nextFuncReqId;
	latestFuncReqId = reqId;
	vscode.postMessage({ type: 'listFunctions', reqId, webviewId: WEBVIEW_ID });
}

/** Close the completion dropdown (state + DOM + ARIA). Safe to call when already closed. */
function closeCompletion(): void {
	if (completion === null && suggestEl.hidden) {
		return;
	}
	completion = null;
	suggestEl.hidden = true;
	suggestEl.replaceChildren();
	formulaInputEl.setAttribute('aria-expanded', 'false');
	formulaInputEl.removeAttribute('aria-activedescendant');
}

/** Paint the dropdown from `completion` (assumed non-null). Renders each candidate as an <li role=option>;
 * the active row gets the `is-active` class + aria-selected. Positions the listbox under the input. */
function renderCompletion(): void {
	if (completion === null) {
		return;
	}
	suggestEl.replaceChildren();
	completion.items.forEach((item, idx) => {
		const li = document.createElement('li');
		li.className = 'cell-grid-suggest-item' + (idx === completion!.activeIndex ? ' is-active' : '');
		li.id = 'sheets-suggest-opt-' + idx;
		li.setAttribute('role', 'option');
		li.setAttribute('aria-selected', idx === completion!.activeIndex ? 'true' : 'false');
		// The matched name (canonical or the alias the user typed toward). A via-alias hit annotates the
		// canonical name so the user knows what it resolves to.
		const nameSpan = document.createElement('span');
		nameSpan.className = 'cell-grid-suggest-name';
		nameSpan.textContent = clampDisplayString(item.matchedName);
		li.appendChild(nameSpan);
		if (item.viaAlias) {
			const aliasNote = document.createElement('span');
			aliasNote.className = 'cell-grid-suggest-note';
			aliasNote.textContent = '= ' + clampDisplayString(item.fn.canonicalName);
			li.appendChild(aliasNote);
		}
		// mousedown (NOT click): fire BEFORE the input's blur so accepting a suggestion does not first
		// commit/cancel the edit via the blur handler. preventDefault keeps focus in the input.
		li.addEventListener('mousedown', ev => {
			ev.preventDefault();
			acceptCompletion(idx);
		});
		suggestEl.appendChild(li);
	});
	suggestEl.hidden = false;
	formulaInputEl.setAttribute('aria-expanded', 'true');
	if (completion.activeIndex >= 0) {
		formulaInputEl.setAttribute('aria-activedescendant', 'sheets-suggest-opt-' + completion.activeIndex);
	} else {
		formulaInputEl.removeAttribute('aria-activedescendant');
	}
}

/**
 * Recompute the completion dropdown from the live input value + caret. Opens/updates it when the caret is on
 * a function-name prefix (non-empty) AND the catalog has candidates; closes it otherwise. Pure decisions
 * (prefix extraction, filtering) come from `formulaIntel.ts`; this only does the DOM + state plumbing.
 *
 * `allowEmptyPrefix` (the explicit Ctrl+Space trigger) shows the full list right after `=`/`(`; the default
 * (typing) requires a >=1-char prefix so the dropdown does not pop on every `=`.
 */
function updateCompletion(allowEmptyPrefix: boolean): void {
	if (!formulaBarIsEditing() || functionCatalog === null) {
		closeCompletion();
		return;
	}
	const value = formulaInputEl.value;
	const caret = formulaInputEl.selectionStart ?? value.length;
	const ctx = extractCompletionPrefix(value, caret);
	if (ctx === null || (ctx.prefix.length === 0 && !allowEmptyPrefix)) {
		closeCompletion();
		return;
	}
	const items = filterFunctions(functionCatalog, ctx.prefix, MAX_COMPLETION_ITEMS);
	if (items.length === 0) {
		closeCompletion();
		return;
	}
	// Preserve the highlighted name across a filter narrowing when it survives; otherwise default to the
	// first item (the closest prefix match), matching editor type-ahead.
	let activeIndex = 0;
	if (completion !== null && completion.activeIndex >= 0 && completion.activeIndex < completion.items.length) {
		const prevName = completion.items[completion.activeIndex].matchedName;
		const found = items.findIndex(it => it.matchedName === prevName);
		if (found >= 0) {
			activeIndex = found;
		}
	}
	completion = { items, activeIndex, replaceStart: ctx.start, replaceEnd: ctx.end };
	renderCompletion();
}

/** Accept the completion at `idx`: replace the typed prefix with the function name + `(`, move the caret
 * inside the parens, close the dropdown, and refresh the validation + signature hint. */
function acceptCompletion(idx: number): void {
	if (completion === null || idx < 0 || idx >= completion.items.length || !formulaBarIsEditing()) {
		return;
	}
	const item = completion.items[idx];
	const value = formulaInputEl.value;
	const insert = item.matchedName + '(';
	const before = value.slice(0, completion.replaceStart);
	const after = value.slice(completion.replaceEnd);
	const next = before + insert + after;
	formulaInputEl.value = next;
	// FE-3 range-pick: accepting a completion rewrote the editor text programmatically (no `input` event), so a
	// live re-point span is now STALE -- clear it so a later grid point inserts fresh, never replaces a span that
	// indexes into the pre-accept text (which would corrupt the formula or throw). Mirrors the F4 (applyRefCycle) fix.
	pointInsertedSpan = null;
	// Caret goes right after the inserted '(' so the user types args next (and the signature hint shows).
	const caret = before.length + insert.length;
	formulaInputEl.setSelectionRange(caret, caret);
	closeCompletion();
	formulaInputEl.focus();
	// The value changed structurally -> re-validate (debounced) + recompute the signature hint.
	scheduleValidate();
	updateSignatureHint();
}

/** Step the dropdown highlight (delta = -1 up / +1 down), wrapping. Re-renders only the affected rows' state
 * via a full repaint (the list is short). No-op when closed. */
function moveCompletion(delta: number): void {
	if (completion === null || completion.items.length === 0) {
		return;
	}
	completion.activeIndex = moveActiveIndex(completion.activeIndex, delta, completion.items.length);
	renderCompletion();
	scrollActiveCompletionIntoView();
}

/** Keep the highlighted dropdown row visible when navigating a long list. */
function scrollActiveCompletionIntoView(): void {
	if (completion === null || completion.activeIndex < 0) {
		return;
	}
	const el = document.getElementById('sheets-suggest-opt-' + completion.activeIndex);
	el?.scrollIntoView({ block: 'nearest' });
}

// --- The validation + signature hint line (shared #sheets-formula-hint, error takes priority) ---

/** The current inline validation message (engine diagnostic), or '' when valid / not validated. */
let validationMessage = '';
/** Is the current hint an ERROR (vs the neutral signature)? Drives the styling + priority. */
let validationIsError = false;

/** Render the hint line: the validation error (if any) takes priority; otherwise the signature hint (if the
 * caret is inside a known FN(). Hidden when there is nothing to show. */
function renderHint(): void {
	if (!formulaBarIsEditing()) {
		hintEl.hidden = true;
		hintEl.textContent = '';
		hintEl.classList.remove('is-error');
		return;
	}
	if (validationMessage.length > 0) {
		hintEl.textContent = clampDisplayString(validationMessage);
		hintEl.classList.toggle('is-error', validationIsError);
		hintEl.hidden = false;
		return;
	}
	const sig = currentSignatureText();
	if (sig.length > 0) {
		hintEl.textContent = clampDisplayString(sig);
		hintEl.classList.remove('is-error');
		hintEl.hidden = false;
		return;
	}
	hintEl.hidden = true;
	hintEl.textContent = '';
	hintEl.classList.remove('is-error');
}

/** Build the signature hint text for the caret's enclosing FN(, or '' when there is none / the function is
 * unknown to the catalog. The current argument (by comma index) is wrapped in brackets for emphasis. */
function currentSignatureText(): string {
	if (functionCatalog === null) {
		return '';
	}
	const value = formulaInputEl.value;
	const caret = formulaInputEl.selectionStart ?? value.length;
	const ctx = findSignatureContext(value, caret);
	if (ctx === null) {
		return '';
	}
	const meta = functionMetaByName.get(ctx.name.toUpperCase());
	if (meta === undefined) {
		return ''; // an unknown name (typo / a name not yet typed in full) -- no signature to show
	}
	const label = buildSignatureLabel(meta.canonicalName, meta.arity);
	const parts = label.params.map((p, i) => (i === ctx.argIndex ? '[' + p + ']' : p));
	if (label.unbounded) {
		// Mark the variadic tail; if the caret is past the listed params, emphasize the trailing '...'.
		const tail = ctx.argIndex >= label.params.length ? '[...]' : '...';
		parts.push(tail);
	}
	return label.name + '(' + parts.join(', ') + ')';
}

/** Recompute + render the signature hint (only meaningful while the formula bar is editing). */
function updateSignatureHint(): void {
	renderHint();
}

/**
 * **Codex HIGH fold**: invalidate any IN-FLIGHT validate request. `latestValidateReqId` is the ONLY id a
 * reply may match (the message arm drops `reqId !== latestValidateReqId`); resetting it to a sentinel that
 * no real reqId equals (-1, while all minted ids are >= 0) means a reply for superseded text is dropped on
 * arrival. Previously the id only advanced inside the debounce timer, so an already-SENT request's reply
 * could still apply after the user edited to a literal / committed / switched sheets before the next
 * keystroke re-scheduled. Also clears the pending timer so a queued send never fires for stale text.
 */
function invalidateValidate(): void {
	if (validateTimer !== undefined) {
		clearTimeout(validateTimer);
		validateTimer = undefined;
	}
	latestValidateReqId = -1;
}

/** Schedule a debounced `validateFormula`. Only fires while the formula bar is the live editor and the
 * value is a formula (`=`-prefixed); a literal value has nothing to validate -> clear any prior message.
 * Codex HIGH fold: every entry point first INVALIDATES any in-flight validate (so a superseded reply is
 * dropped), then re-schedules only when the value is a formula. */
function scheduleValidate(): void {
	invalidateValidate();
	if (!formulaBarIsEditing()) {
		return;
	}
	const value = formulaInputEl.value;
	if (!value.trimStart().startsWith('=')) {
		// A literal value: no formula to validate. Clear any stale error so the hint reflects reality.
		clearValidation();
		return;
	}
	validateTimer = setTimeout(() => {
		validateTimer = undefined;
		if (!formulaBarIsEditing() || editState === null) {
			return;
		}
		const text = formulaInputEl.value;
		if (!text.trimStart().startsWith('=')) {
			clearValidation();
			return;
		}
		// The engine wants the formula BODY without the leading '=' (engine convention). Strip leading
		// whitespace + the '=' (matches the host putValue formula path).
		const body = text.trimStart().slice(1);
		const reqId = ++nextValidateReqId;
		latestValidateReqId = reqId;
		vscode.postMessage({
			type: 'validateFormula',
			sheet: editState.sheet,
			row: editState.row,
			col: editState.col,
			text: body,
			reqId,
			webviewId: WEBVIEW_ID,
		});
	}, VALIDATE_DEBOUNCE_MS);
}

/** Clear the validation message + re-render the hint (the signature may still show). Codex HIGH fold: also
 * invalidate any in-flight validate so a reply for the now-cleared text can't reapply a stale message. */
function clearValidation(): void {
	invalidateValidate();
	if (validationMessage.length === 0 && !validationIsError) {
		renderHint();
		return;
	}
	validationMessage = '';
	validationIsError = false;
	renderHint();
}

/**
 * Apply a `validateFormulaResult` from the host: pick the worst diagnostic as the inline message (or clear
 * on a clean validate). A `ok:false` (the engine threw) is surfaced as an error (No-Fallbacks). Stale
 * (superseded) replies are dropped by the reqId match before this is called.
 *
 * **Codex MED fold (No-Fallbacks at the webview boundary)**: `diagnostics` is taken as `unknown`. When
 * `ok === true` the host contract REQUIRES a `DiagnosticJson[]` (an empty array means valid). A reply that
 * claims `ok:true` but carries a missing / non-array `diagnostics` is a PROTOCOL violation (version skew /
 * tamper) -- it is surfaced as a validation error, NOT silently coerced to `[]` (which would falsely show
 * the formula as valid).
 */
function applyValidationResult(ok: boolean, diagnostics: unknown, error: string | undefined): void {
	if (!formulaBarIsEditing()) {
		// The edit closed while the validate was in flight -- nothing to show.
		clearValidation();
		return;
	}
	if (!ok) {
		validationMessage = error !== undefined && error.length > 0 ? error : 'The formula could not be validated.';
		validationIsError = true;
		renderHint();
		return;
	}
	if (!Array.isArray(diagnostics)) {
		// ok:true MUST carry a diagnostics array. A malformed reply is surfaced, not treated as valid.
		validationMessage = 'The validation reply was malformed (no diagnostics); the formula could not be validated.';
		validationIsError = true;
		renderHint();
		return;
	}
	const list = diagnostics as DiagnosticJson[];
	// Show the first error; else the first warning; else clear (valid). The engine returns diagnostics as
	// DATA (an empty array means valid) -- we never fabricate a problem.
	const err = list.find(d => d !== null && typeof d === 'object' && d.severity === 'error');
	const warn = list.find(d => d !== null && typeof d === 'object' && d.severity === 'warning');
	const pick = err ?? warn;
	if (pick === undefined) {
		clearValidation();
		return;
	}
	validationMessage = '[' + String(pick.code) + '] ' + String(pick.message);
	validationIsError = pick.severity === 'error';
	renderHint();
}

/** Tear down all formula-assist UI (dropdown + hint + pending validate). Called from `cancelEdit` when a
 * formula-bar edit closes so no stale dropdown/hint lingers over a non-editing bar. Codex HIGH fold:
 * `invalidateValidate` resets the validate token so a reply in flight when the edit closed is dropped. */
function teardownFormulaAssist(): void {
	invalidateValidate();
	closeCompletion();
	validationMessage = '';
	validationIsError = false;
	hintEl.hidden = true;
	hintEl.textContent = '';
	hintEl.classList.remove('is-error');
}

/**
 * **W3 frozen panes (Codex HIGH-2)** -- the CONTENT-layer position of the overlay editor for cell
 * `(row, col)`. The overlay `<input>` is a child of the content layer, so an element at content `top=Y`
 * renders at viewport `Y - scrollTop`. A BODY cell wants to scroll with the grid, so its content position
 * IS `cellContentRect` (the pre-W3 behaviour). A FROZEN cell must stay PINNED at its viewport position
 * (`rowY(r)` / `colX(c)`), so we ADD BACK the live scroll on the frozen axis (`+ scrollTop` / `+ scrollLeft`),
 * cancelling the content layer's scroll -- the cell then appears fixed below the header / right of the gutter
 * just like its painted pane. Re-evaluated on every scroll (the `scroll` handler calls `repositionEdit`),
 * so a frozen-cell editor tracks its pinned cell as the body scrolls. With no freeze this returns the bare
 * `cellContentRect` position (byte-identical to the pre-W3 path).
 */
function overlayCellContentPos(row: number, col: number): { left: number; top: number; width: number; height: number } {
	const rect = cellContentRect(row, col, renderer.gutterWidthPx);
	const pinLeft = col < renderer.frozenCols ? viewportEl.scrollLeft : 0;
	const pinTop = row < renderer.frozenRows ? viewportEl.scrollTop : 0;
	return { left: rect.x + pinLeft, top: rect.y + pinTop, width: rect.width, height: rect.height };
}

/** Re-position the open editor over its cell. Audit LOW-7: the gutter width can change on a theme/font
 * change, which shifts every cell's x -- a preserved editor must follow or it misaligns.
 * W-G-1b: only the OVERLAY editor is positioned over a cell; a formula-bar edit is a no-op here.
 * W3 frozen panes: a frozen cell's editor is pinned (see {@link overlayCellContentPos}), so this is also
 * called on every scroll so the pin tracks the live scroll. */
function repositionEdit(): void {
	if (editState === null || editState.surface !== 'overlay') {
		return;
	}
	const pos = overlayCellContentPos(editState.row, editState.col);
	inputEl.style.left = pos.left + 'px';
	inputEl.style.top = pos.top + 'px';
	inputEl.style.width = pos.width + 'px';
	inputEl.style.height = pos.height + 'px';
	updateEditClip(); // a gutter-width change shifts the cell -> recompute the body-pane clip too
}

/**
 * **FE-2-0 polish (2026-06-05) -- clip the open editor to the BODY pane (MED-5).**
 *
 * The overlay `<input>` is a content-layer child positioned at CONTENT coordinates, so it scrolls with the
 * grid; the sticky header (top `HEADER_HEIGHT`) + row gutter (left `gutterWidthPx`) are painted on the
 * pinned canvas. Without clipping, an editor scrolled under a band slides visibly ON TOP of it. A
 * `clip-path` inset hides exactly the portion overlapping the bands -- and unlike hiding the element
 * (`hidden`/`display:none`, which would blur the input and fire the cancel/commit path), `clip-path`
 * PRESERVES focus + the live edit. Only the top/left bands occlude; a cell fully in the body pane gets a
 * zero inset (no-op). Pointer events over a clipped region pass through to the band, as desired.
 *
 * **W3 frozen panes**: the occluding band on each axis = sticky band + the frozen-band pixels. A BODY-cell
 * editor scrolled up/left under the FROZEN strip is clipped at the frozen-band edge (not just the
 * header/gutter), so it never slides visibly over the pinned rows/cols. A FROZEN-cell editor is PINNED
 * (see {@link overlayCellContentPos}), so its on-screen position is `rowY(r)` / `colX(c)` -- above/left of
 * the body-pane band edge, so it is clipped only at the sticky gutter/header edge (clipLeft/clipTop clamp
 * to 0). The on-screen position is derived from the PINNED content position so it stays correct as the body
 * scrolls under a frozen-cell editor.
 */
function updateEditClip(): void {
	// W-G-1b: only the overlay editor is a content-layer child that can slide under a sticky band; a
	// formula-bar edit lives in the fixed bar above the grid and never needs clipping.
	if (editState === null || editState.surface !== 'overlay') {
		return;
	}
	const gutterW = renderer.gutterWidthPx;
	// The input's on-screen position = its CONTENT position - scroll. For a frozen cell the content position
	// adds back the frozen-axis scroll (overlayCellContentPos), so on-screen it lands at the pinned rowY/colX.
	const pos = overlayCellContentPos(editState.row, editState.col);
	const viewX = pos.left - viewportEl.scrollLeft;
	const viewY = pos.top - viewportEl.scrollTop;
	// W3: the occluding band edge depends on which pane the edited cell is in. A BODY cell (col >= fCols /
	// row >= fRows) can scroll under the frozen strip, so it is clipped at `band + frozen-band pixels`. A
	// FROZEN cell lives IN the frozen strip (left of `leftBand` / above `topBand`); clipping it there would
	// wrongly hide a pinned cell, so it is clipped only at the sticky gutter/header edge.
	const leftBand = editState.col < renderer.frozenCols ? gutterW : gutterW + frozenColsWidth(renderer.frozenCols);
	const topBand = editState.row < renderer.frozenRows ? HEADER_HEIGHT : HEADER_HEIGHT + frozenRowsHeight(renderer.frozenRows);
	// Hide the part of the input that lies under the occluding band on each axis (clamped to the input box).
	const clipLeft = Math.max(0, Math.min(pos.width, leftBand - viewX));
	const clipTop = Math.max(0, Math.min(pos.height, topBand - viewY));
	inputEl.style.clipPath = 'inset(' + clipTop + 'px 0px 0px ' + clipLeft + 'px)';
}

/**
 * Commit the edit; `nav` (optional) moves the selection once the matching `commitResult` arrives.
 * **Audit MED-B (2026-06-05)**: returns `true` iff the edit was POSTED (now pending), `false` on a LOCAL
 * reject (no editState/snapshot, already pending, or over-limit). Callers that fire on focus-out (`blur`)
 * use this to fall back to `cancelEdit` -- otherwise a locally-rejected blur would leave a non-pending
 * editor open+blurred and strand the keyboard (the document keyhandler is inert while `editState` is set).
 * The Enter/Tab callers ignore the return: an over-limit value keeps the editor OPEN with the banner so the
 * user can shorten it in place.
 */
function commitEdit(nav?: { dr: number; dc: number }): boolean {
	if (editState === null || fullSnapshot === null) {
		return false;
	}
	if (editState.pendingCommit) {
		return false; // a commit is already in flight
	}
	// Audit C1-MED6: reject an over-length input HERE (visible error, editor stays open for the user to
	// shorten) rather than serialize a multi-MB payload across the bridge for the host to reject anyway.
	// W-G-1b: read from the live editor (`editEl` -- overlay or formula bar), the single committed source.
	const editEl = editState.editEl;
	// Round 5: an untouched Sigma-functions prefill ("=SUM(") must NOT commit -- it is an incomplete formula
	// the engine would surface as a visible #ERROR. The user picked a function then left without completing
	// it -> abort (close the editor, leave the cell unchanged). Covers Enter / Tab / blur / sheet-switch.
	if (editState.prefillBaseline !== undefined && editEl.value === editState.prefillBaseline) {
		cancelEdit();
		return false;
	}
	if (editEl.value.length > MAX_RAW_INPUT_LENGTH) {
		showError(
			`Cell value is ${editEl.value.length} characters, over the ${MAX_RAW_INPUT_LENGTH}-character limit. ` +
			`Shorten it and commit again.`,
			'edit',
		);
		return false;
	}
	clearError();
	// Audit MED-2: post to the sheet captured at edit-start (not the live `fullSnapshot.sheet`).
	const sheet = editState.sheet;
	const row = editState.row;
	const col = editState.col;
	const commitId = ++nextCommitId; // FE-2-0 Phase 2: stamp a unique token for THIS commit
	editState.pendingCommit = true;
	editState.commitId = commitId;
	editState.navAfterCommit = nav;
	editState.lastFailedRawInput = undefined; // megaudit B2: this is a fresh attempt, not the known-bad value
	editState.submittedRawInput = editEl.value; // re-audit HIGH: the value posted (for the late-ack guard)
	// Megaudit H1: lock the input while the commit is in flight, so a keystroke before the ack can't be
	// silently discarded when `resolvePendingCommit` closes the editor. Unlocked on resolve/error/cancel/watchdog.
	editEl.readOnly = true;
	// W2 formula intelligence: a commit is now in flight -- close the dropdown, invalidate any pending/in-flight
	// validate (Codex HIGH: drop a reply that returns after the commit), AND hide the already-rendered
	// validation/signature hint (re-audit LOW: a stale hint should not linger over the pending edit). A
	// successful commit's resolvePendingCommit -> cancelEdit re-establishes a clean bar. teardownFormulaAssist
	// does all three (it invalidates the validate token, closes completion, and hides the hint).
	if (editState.surface === 'formula') {
		teardownFormulaAssist();
	}
	armCommitWatchdog(commitId); // re-audit HIGH: recover the editor if no commitResult/errorReply arrives
	// Pessimistic: keep the input visible/focused until the host responds. FE-2-0 Phase 2: resolution is
	// now driven ONLY by a matching `commitResult` (success -> resolvePendingCommit hides the editor +
	// applies `nav`) or `errorReply` (failure -> decorate the cell + leave the editor open). A bare
	// `render` no longer resolves -- so a sibling-panel render can't falsely close this editor.
	// megaudit (webview-instance token): stamp WEBVIEW_ID so the host echoes it in the commitResult/errorReply
	// and a stale PRE-reload reply (whose reused low commitId could collide -- the counter resets on reload) is
	// dropped instead of resolving this edit.
	vscode.postMessage({ type: 'putValue', sheet, row, col, rawInput: editEl.value, commitId, webviewId: WEBVIEW_ID });
	return true; // posted -> the editor is now pending
}

// **W-G-1b**: the three edit listeners below are SHARED by both edit surfaces -- the in-cell overlay
// (`inputEl`) and the formula bar (`formulaInputEl`) -- and attached to both at the bottom of this block.
// Each early-returns unless the event came from the CURRENTLY-LIVE editor (`ev.target === editState.editEl`),
// so the inactive input is inert. This is what gives the formula bar the full commit/nav/known-bad/late-ack
// behavior through the SAME code (the single-writer requirement) with no second putValue path.

// Re-audit MED-4: clear the over-length ('edit') banner as soon as the user shortens the value back to
// the cap, so the guidance disappears the moment it no longer applies (instead of lingering until the
// next commit/cancel).
function onEditInput(ev: Event): void {
	if (editState === null || ev.target !== editState.editEl) {
		return;
	}
	// FE-3 range-pick: ANY real keystroke ends the live "re-point" target -- the just-pointed ref is no longer
	// what a grid press should replace, so clear the span and the next point APPENDS. (A programmatic point
	// insert sets `.value` without firing `input`, so a point never trips this itself.)
	pointInsertedSpan = null;
	if (errorSource === 'edit' && editState.editEl.value.length <= MAX_RAW_INPUT_LENGTH) {
		clearError();
	}
	// Megaudit re-audit LOW: ANY real edit clears the "known-bad" marker, so a value the user changed (even
	// if changed back to the exact failed string) commits normally on Enter/Tab instead of being treated as
	// "still bad" and abandoned. The arrow/Tab "leave a bad cell" affordance only applies to an UNTOUCHED
	// failure (the moment after it fails); once you start correcting, arrows are caret + Enter commits.
	editState.lastFailedRawInput = undefined;
	// W2 formula intelligence: drive the completion dropdown + debounced validation + signature hint on every
	// keystroke, but ONLY for the formula-bar editor (the in-cell overlay has no assist UI). A 1+ char prefix
	// is required to open the dropdown (allowEmptyPrefix=false) so it does not pop on a bare '='.
	if (editState.surface === 'formula') {
		updateCompletion(false);
		scheduleValidate();
		updateSignatureHint();
	}
}
/**
 * **FE-4 F4** -- cycle the abs/rel anchoring of the ref the caret is on, in the LIVE editor (either surface).
 * Reads `editState.editEl.value` + `selectionStart`, runs the pure {@link cycleRefAbsRel}, and writes the
 * result back + repositions the caret. A no-op (returns false, no write) when the caret is not on a ref --
 * the caller then leaves the key as a passthrough (No-Fallbacks: F4 off a ref does nothing, never guesses).
 *
 * After a rewrite it refreshes the formula-bar assist (validate + signature hint + dropdown) exactly as a
 * keystroke would, since changing `value` programmatically does not fire the `input` event. On the overlay
 * surface there is no assist, so the refresh is a guarded no-op there (the helpers gate on `formulaBarIsEditing`).
 */
function applyRefCycle(): boolean {
	if (editState === null) {
		return false;
	}
	const el = editState.editEl;
	const caret = el.selectionStart ?? el.value.length;
	const result = cycleRefAbsRel(el.value, caret);
	if (result === null) {
		return false; // caret not on a ref -- F4 is a no-op
	}
	el.value = result.formula;
	el.setSelectionRange(result.caretPos, result.caretPos);
	// FE-3 range-pick: F4 rewrote the editor text programmatically (no `input` event), so any live re-point
	// span is now STALE (its offsets index into the pre-F4 text). Clear it so the next grid point inserts fresh
	// instead of replacing a stale span (which would corrupt the formula or throw on an out-of-range end).
	pointInsertedSpan = null;
	// Mirror the `input` path's assist refresh (formula bar only; no-ops on the overlay). The value changed,
	// so a debounced re-validate + signature hint + dropdown re-eval keep the bar's diagnostics in sync.
	if (formulaBarIsEditing()) {
		scheduleValidate();
		updateSignatureHint();
		if (completion !== null) {
			updateCompletion(false);
		}
	}
	return true;
}

/**
 * **FE-3 range-pick / point mode** -- insert (or RE-POINT) the pressed cell/range's A1 reference into the LIVE
 * editor at the caret. Mirrors {@link applyRefCycle}'s value/caret write + assist refresh (setting `.value`
 * programmatically does NOT fire `input`). If a previous point left a live span (`pointInsertedSpan`), this
 * REPLACES it (Excel re-point); otherwise it inserts at the caret. A pointed reference is not a function-name
 * completion context, so any open dropdown is closed. Records the new span so a subsequent point/drag replaces
 * it. Pure-IDE: the cell write still happens only via the single {@link commitEdit} path on Enter/Tab/blur.
 */
function applyPointInsert(rect: SelectionRect): void {
	if (editState === null) {
		return; // defensive -- a point drag cannot outlive its editor (the teardown guards null `pointDrag`)
	}
	const el = editState.editEl;
	const selStart = el.selectionStart ?? el.value.length;
	const selEnd = el.selectionEnd ?? selStart;
	// Replace target: a live re-point span (`pointInsertedSpan`, set once a point has inserted) wins; else, on
	// the FIRST point of a gesture, a non-empty text SELECTION is replaced (Excel re-points a selected ref);
	// else a bare insert at the caret. `selStart` is the insertion offset for the bare-insert case.
	const replaceSpan = pointInsertedSpan ?? (selEnd > selStart ? { start: selStart, end: selEnd } : undefined);
	const result = insertRefAtCaret(el.value, selStart, buildRefText(rect), replaceSpan);
	el.value = result.text;
	el.setSelectionRange(result.caret, result.caret);
	pointInsertedSpan = result.span;
	closeCompletion();
	// Mirror applyRefCycle's assist refresh (formula bar only; no-ops on the overlay). closeCompletion above
	// keeps the dropdown shut -- a ref is not a completion token -- so refresh validate + signature only.
	if (formulaBarIsEditing()) {
		scheduleValidate();
		updateSignatureHint();
	}
}

function onEditKeydown(ev: KeyboardEvent): void {
	// Audit MED-4: while an IME composition is active, Enter/Tab ACCEPT the candidate -- they must not
	// commit/move the cell. Let the input handle composition natively until it completes.
	if (ev.isComposing || ev.keyCode === 229) {
		return;
	}
	if (editState === null || ev.target !== editState.editEl) {
		return;
	}
	// **W2 formula intelligence -- dropdown keyboard interception (CRITICAL).** When the completion dropdown
	// is OPEN (only possible on the formula-bar editor), Up/Down/Enter/Tab/Esc drive the LIST and are
	// swallowed BEFORE the shared edit machinery below (so Enter picks an item instead of committing+moving,
	// Esc closes the list instead of reverting the edit, Tab inserts instead of nav). A non-pending guard:
	// while a commit is in flight the dropdown is force-closed elsewhere, but be defensive and only intercept
	// when not pending. Any key NOT handled here (typing, Home/End, etc.) falls through to the existing logic
	// unchanged, and the dropdown is closed/refreshed by the `input` handler. When the dropdown is CLOSED
	// this whole block is skipped and the edit core behaves exactly as before.
	if (completion !== null && editState.surface === 'formula' && !editState.pendingCommit) {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			moveCompletion(1);
			return;
		}
		if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			moveCompletion(-1);
			return;
		}
		if (ev.key === 'Enter' || ev.key === 'Tab') {
			// Accept the highlighted item. There is always a highlighted item while open (activeIndex defaults
			// to 0), so Enter/Tab here NEVER commits the cell -- the list wins. If somehow nothing is
			// highlighted, fall through to the normal commit/nav path.
			if (completion.activeIndex >= 0) {
				ev.preventDefault();
				acceptCompletion(completion.activeIndex);
				return;
			}
		}
		if (ev.key === 'Escape') {
			// Close the dropdown WITHOUT cancelling the edit (Excel: Esc dismisses the suggestion list first;
			// a second Esc reverts the edit). preventDefault + stop so the edit-Escape below does not also run.
			ev.preventDefault();
			closeCompletion();
			return;
		}
		// Other keys (printable, Backspace, Home/End, Left/Right caret moves) fall through: the input edits
		// natively, then the `input`/`keyup` handlers recompute or close the dropdown.
	}
	// **FE-4 F4 (abs/rel ref cycle).** Classify through the shared dispatcher so the editor-mode F4 is in the
	// table: `formula` mode (the value starts with `=`) -> `cycleRef`; plain `edit` mode -> passthrough (no ref
	// to cycle). Inert while a commit is in flight (the input is readOnly) -- the pending swallow below also
	// guards nav keys; F4 must not mutate a read-only editor either. A no-op cycle (caret off any ref) falls
	// through to native handling (No-Fallbacks: never a silent eat).
	if (ev.key === 'F4' && !editState.pendingCommit) {
		const editMode: GridMode = editState.editEl.value.startsWith('=') ? 'formula' : 'edit';
		const action = gridKeyDispatch(editMode, ev.key, { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey });
		if (action.kind === 'cycleRef') {
			if (applyRefCycle()) {
				ev.preventDefault();
				return;
			}
			// caret not on a ref -- fall through (passthrough); F4 does nothing visible
		}
	}
	if (ev.key === 'Escape') {
		ev.preventDefault();
		// Audit O2-MED1: Escape is inert while a commit is in flight (matches commitEdit/blur). Cancelling
		// here would NOT recall the already-posted putValue but WOULD wipe editState -- enabling a
		// same-cell double-put and dropping the host's pending reply on the floor.
		if (editState.pendingCommit) {
			return;
		}
		cancelEdit();
		redraw();
		viewportEl.focus();
		return;
	}
	if (editState.pendingCommit) {
		// A commit is in flight: the input is readOnly. Megaudit re-audit MED: SWALLOW nav/commit keys so
		// Tab can't tab-order focus OUT of the readOnly input (blur is ignored while pending + the document
		// handler is dead while editing -> the keyboard would be stranded). Inert until the host replies.
		if (navVector(ev.key, ev.shiftKey) !== null) {
			ev.preventDefault();
		}
		return;
	}
	const vec = navVector(ev.key, ev.shiftKey);
	if (vec === null) {
		return; // a normal editing key -- let the <input> handle it
	}
	// **Megaudit B2**: if the editor still holds exactly the value that just FAILED to commit, the user is
	// trying to leave a known-bad cell. ABANDON the edit + navigate on ANY nav key (arrow / Tab / Enter) --
	// never re-post the same failing value (that was the Tab re-fail loop). A CHANGED value falls through
	// and commits (the user fixed it). This is what lets arrows AND Tab "get you out" of a bad formula.
	if (editState.lastFailedRawInput !== undefined && editState.editEl.value === editState.lastFailedRawInput) {
		ev.preventDefault();
		const { row, col } = editState;
		cancelEdit();
		setActiveClamped(row + vec.dr, col + vec.dc);
		redraw();
		viewportEl.focus();
		return;
	}
	if (ev.key.startsWith('Arrow')) {
		// A normal (not-known-bad) edit: arrows move the text caret inside the <input>. (Excel's
		// "enter-mode" arrows-commit-and-move is a deliberate follow-up -- it changes how every edit feels
		// and warrants its own behavioral smoke; not folded into this fix.)
		return;
	}
	ev.preventDefault();
	// Round-5 audit (lane A LOW-MED): capture the coordinates BEFORE the commit -- an untouched
	// sigma-prefill makes commitEdit ABORT via cancelEdit (returns false, editState nulled), and the
	// abandoned key must still NAVIGATE (Enter moves down, Tab right) + refocus the grid, mirroring
	// the known-bad arm above. A `false` with the editor STILL OPEN is the over-limit local reject
	// (its 'edit' banner owns the story; the editor keeps focus for shortening) -- no nav then.
	const fromRow = editState.row;
	const fromCol = editState.col;
	const committed = commitEdit(vec); // Enter = commit + down; Tab = commit + right (Shift+Tab left)
	if (!committed && editState === null) {
		setActiveClamped(fromRow + vec.dr, fromCol + vec.dc);
		redraw();
		viewportEl.focus();
	}
}
function onEditBlur(ev: FocusEvent): void {
	// **FE-2-0 polish (2026-06-05)**: blur COMMITS a changed value (Excel: clicking / Tabbing away saves
	// your edit) but CANCELS an unchanged one. A pending commit is left to resolve on the host reply (as
	// before). NOTE: cancelEdit()/resolvePendingCommit() null `editState` BEFORE hiding the input, so the
	// blur THEY trigger early-returns here (editState === null) -- this only fires on a genuine focus-out.
	if (editState === null || editState.pendingCommit || ev.target !== editState.editEl) {
		return;
	}
	// FE-3 range-pick: a point drag preventDefaults the pointerdown so focus never leaves the editor and this
	// blur should not fire -- but if a platform fires it anyway mid-drag, do NOT commit/cancel under the drag
	// (that would destroy the edit the point is building). pointerup/pointercancel owns the teardown.
	if (pointDrag !== null) {
		return;
	}
	const value = editState.editEl.value;
	const changed = value !== editState.initialValue;
	// Still EXACTLY the value that just failed to commit (untouched since the errorReply): committing would
	// re-post the same rejected value (the B2 re-fail loop). Abandon instead -- mirrors the B2 nav affordance.
	const knownBad = editState.lastFailedRawInput !== undefined && value === editState.lastFailedRawInput;
	if (changed && !knownBad) {
		// Commit a genuine change with NO nav (blur doesn't move the selection).
		if (commitEdit()) {
			return; // posted -> editor is now pending
		}
		// **Audit MED (2026-06-05)**: commitEdit LOCALLY rejected (an over-limit value). We must NOT keep the
		// editor open+blurred (the document keyhandler is inert while editState is set -> stranded keyboard),
		// so we abandon it -- but NOT silently (No-Fallbacks): commitEdit's own 'edit' banner is cleared by
		// cancelEdit below, so re-surface the discard as a 'transient' notice that survives to the next render.
		const len = value.length;
		cancelEdit();
		showError(
			'Edit discarded: the value was ' + len + ' characters, over the ' + MAX_RAW_INPUT_LENGTH +
			'-character limit. Re-open the cell to shorten it.',
			'transient',
		);
		redraw();
		return;
	}
	// Unchanged or known-bad -> abandon the edit outright.
	cancelEdit();
	redraw();
}

// W-G-1b: attach the shared edit listeners to BOTH surfaces. The overlay (`inputEl`) and the formula bar
// (`formulaInputEl`) run the same commit/nav/blur logic; each handler keys off `editState.editEl`, so only
// the live editor acts. Focusing the formula bar enters an edit (Excel: the formula bar is an edit surface).
inputEl.addEventListener('input', onEditInput);
inputEl.addEventListener('keydown', onEditKeydown);
inputEl.addEventListener('blur', onEditBlur);
formulaInputEl.addEventListener('input', onEditInput);
formulaInputEl.addEventListener('keydown', onEditKeydown);
formulaInputEl.addEventListener('blur', onEditBlur);
formulaInputEl.addEventListener('focus', () => {
	beginEditFormula();
});
// FE-11 name box -- DEDICATED listeners (it must NOT use the shared onEditInput/onEditKeydown/onEditBlur,
// which write cells). On focus, resolve any open cell editor first (a competing native surface); on Enter
// submit; on Esc revert + refocus the grid; on blur revert WITHOUT stealing focus.
nameBoxEl.addEventListener('focus', () => {
	// resolveEditForNativeSurface returns false ONLY when a cell commit is in flight: then it has already
	// re-focused the cell editor, so we just decline to open the name box until that commit resolves.
	if (!resolveEditForNativeSurface('click the name box again once the edit is saved.')) {
		return;
	}
	beginNameBoxEdit();
});
nameBoxEl.addEventListener('keydown', ev => {
	if (!nameBoxEditing) {
		return;
	}
	if (ev.key === 'Enter') {
		ev.preventDefault();
		ev.stopPropagation();
		submitNameBox();
	} else if (ev.key === 'Escape') {
		ev.preventDefault();
		ev.stopPropagation();
		revertNameBox();
	}
});
nameBoxEl.addEventListener('blur', () => {
	// Excel: a name-box blur ABANDONS the typed text (only Enter commits). submit/revert already cleared
	// `nameBoxEditing` before moving focus, so this fires only for a focus that left WITHOUT Enter/Esc
	// (clicking a cell, a menu, opening a QuickPick). endNameBoxEdit does NOT steal focus (it goes where the
	// user clicked).
	if (nameBoxEditing) {
		endNameBoxEdit();
	}
});
// FE-11 v2: the name box dropdown opens an INLINE list of the workbook + current-sheet defined names
// (replacing the old host Go-To-Name QuickPick round-trip; the QuickPick is still reachable via the Data
// menu's "Go to Name..."). It reuses the shared, audited openMenuDropdown: the capture-phase keydown (gated
// on openMenu) owns Arrow/Enter/Esc so nothing leaks to grid nav, click-away / window-blur dismiss, and each
// item runs through runAfterResolvingEdit (an open cell editor resolves first). Selecting a name posts the
// SAME nameBoxSubmit the typed path uses (host routeNameBoxSubmit -> navigate-name), so there is ONE
// navigation code path.

/**
 * FE-11 v2: the inline name-dropdown entries -- the scope-visible defined names (workbook-scoped + names
 * scoped to the active sheet), in the engine's listing order. constant/formula names are INCLUDED
 * (Excel-faithful); picking one surfaces the host's loud "no cell to go to" toast via the existing routing.
 * An empty list yields a single non-actionable "(No defined names)" entry so the affordance is discoverable
 * (No-Fallbacks: never a silently dead button).
 */
function buildNameDropdownEntries(): MenuEntrySpec[] {
	const sheet = fullSnapshot === null ? undefined : fullSnapshot.sheet;
	const visible = sheet === undefined
		? []
		: definedNames.filter((n) => n.scope === undefined || n.scope === sheet);
	// Dedupe by spelling: a workbook name and a sheet-scoped name can share a name (e.g. "DUP"). Bare-name
	// navigation (the posted nameBoxSubmit -> routeNameBoxSubmit) resolves the SHADOWING winner -- the
	// sheet-scoped one on this sheet -- so list each spelling ONCE (Excel does the same), preferring the
	// sheet-scoped entry; otherwise two identical labels would both jump to the same shadowed target. The Map
	// preserves the engine's listing order (workbook first), and re-setting a key keeps that position.
	const bySpelling = new Map<string, NamedRangeJson>();
	for (const n of visible) {
		const key = n.name.toUpperCase();
		const existing = bySpelling.get(key);
		if (existing === undefined || (existing.scope === undefined && n.scope === sheet)) {
			bySpelling.set(key, n);
		}
	}
	const deduped = [...bySpelling.values()];
	if (deduped.length === 0) {
		// A non-actionable placeholder (clicking it just dismisses the menu) -- not a masked error.
		return [{ label: '(No defined names)', run: () => { /* nothing to navigate to */ } }];
	}
	return deduped.map((n) => ({ label: n.name, run: () => navigateToNameFromDropdown(n.name) }));
}

/**
 * FE-11 v2: navigate to a defined name picked from the inline dropdown by posting the SAME nameBoxSubmit the
 * typed name-box path uses (the host's routeNameBoxSubmit resolves an existing name -> navigate-name). The
 * selection is carried only to satisfy the host's payload contract; navigation ignores it. Loud + non-acting
 * if there is no live selection to post from (defensive -- the grid always has an active cell once loaded).
 */
function navigateToNameFromDropdown(name: string): void {
	if (fullSnapshot === null || active === null) {
		console.warn('[sheets-webview] name dropdown: no active selection to navigate from.');
		return;
	}
	const anc = anchor ?? active;
	vscode.postMessage({
		type: 'nameBoxSubmit',
		text: name,
		sheet: fullSnapshot.sheet,
		selection: { anchorRow: anc.row, anchorCol: anc.col, focusRow: active.row, focusCol: active.col },
	});
}

const nameBoxDropdownEl = document.getElementById('sheets-name-box-dropdown') as HTMLButtonElement;
nameBoxDropdownEl.addEventListener('click', () => {
	// Toggle on the open anchor (mirror the menu bar's open/close); otherwise open the inline name list.
	if (openMenu !== null && openMenu.anchor === nameBoxDropdownEl) {
		closeMenuDropdown();
		return;
	}
	openMenuDropdown(nameBoxDropdownEl, buildNameDropdownEntries(), null);
});
// W2 formula intelligence -- explicit trigger + caret-tracking + focus-out cleanup on the FORMULA BAR only.
// Ctrl/Cmd+Space opens the dropdown with the full list (the empty-prefix affordance) at the caret. This is a
// keydown (it must preventDefault before the browser inserts a space) and runs BEFORE onEditKeydown's
// dropdown block on the same target, so it's registered first below.
formulaInputEl.addEventListener('keydown', ev => {
	if ((ev.ctrlKey || ev.metaKey) && (ev.key === ' ' || ev.code === 'Space') && formulaBarIsEditing()) {
		ev.preventDefault();
		updateCompletion(true); // allowEmptyPrefix -> show all functions at the caret
	}
});
// A caret move via arrow keys / Home / End / a mouse click inside the input does NOT fire `input`, so refresh
// the signature hint (and re-evaluate the dropdown, which closes if the caret left a name token) on keyup +
// click. Guarded to the formula-bar editor. The dropdown's own Up/Down are already handled (and returned) in
// onEditKeydown, so a keyup for those arrives with the dropdown still open -- updateCompletion preserves it.
function refreshAssistOnCaretMove(): void {
	if (!formulaBarIsEditing()) {
		return;
	}
	updateSignatureHint();
	// Only RE-EVALUATE the dropdown for caret moves while it is already open (so a Left/Right that leaves the
	// name token closes it). Do NOT auto-open on a bare caret move -- opening is driven by typing / Ctrl+Space.
	if (completion !== null) {
		updateCompletion(false);
	}
}
formulaInputEl.addEventListener('keyup', ev => {
	if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
		refreshAssistOnCaretMove();
	}
});
formulaInputEl.addEventListener('click', () => {
	refreshAssistOnCaretMove();
});
// Focus-out: close the dropdown (and cancel any pending validate) so it never lingers over a non-focused
// bar. A click ON a suggestion preventDefaults its mousedown so focus never leaves -> this does not fire for
// an accept. The shared onEditBlur (registered above) still runs to commit/cancel the edit itself; this only
// tears down the assist OVERLAY. Use a capture-phase-safe ordering: this listener is added AFTER onEditBlur,
// but both fire on the same blur; closing the dropdown here is independent of the commit/cancel decision.
formulaInputEl.addEventListener('blur', () => {
	closeCompletion();
});

// --- Canvas pointer: single click SELECTS, double click EDITS (FE-2-0 polish 2026-06-05) ---

/** Hit-test a pointer event against the body grid; returns the (row,col) or null (band / gutter / empty). */
function hitTestCanvas(ev: MouseEvent): { row: number; col: number } | null {
	if (fullSnapshot === null) {
		return null;
	}
	const rect = canvasEl.getBoundingClientRect();
	// W3 frozen panes: thread the pinned counts so a click in a frozen band maps to the pinned cell (no
	// scroll added on that axis); 0/0 reduces to the pre-W3 hit-test.
	return hitTestViewportFrozen(
		ev.clientX - rect.left,
		ev.clientY - rect.top,
		viewportEl.scrollLeft,
		viewportEl.scrollTop,
		renderer.gutterWidthPx,
		renderer.frozenRows,
		renderer.frozenCols,
	);
}

/**
 * **W-G fill handle** -- is `ev` over the fill-handle square (the selection's bottom-right corner)? The
 * handle is painted at the bottom-right pixel corner of the selection (or the active cell); a press within
 * {@link FILL_HANDLE_HIT_PX} of it starts a fill drag instead of a selection click.
 */
function isOnFillHandle(ev: MouseEvent): boolean {
	if (active === null) {
		return false;
	}
	const sel = currentSelection();
	const brRow = sel === null ? active.row : sel.maxRow;
	const brCol = sel === null ? active.col : sel.maxCol;
	const rect = canvasEl.getBoundingClientRect();
	// W3 frozen panes: the handle is painted at the bottom-right corner of (brRow, brCol). A FROZEN corner
	// cell paints at its pinned position (no scroll on the frozen axis), so the hit-test must use the SAME
	// effective scroll the paint used, or the handle would be unreachable when the corner cell is frozen.
	const effScrollLeft = brCol < renderer.frozenCols ? 0 : viewportEl.scrollLeft;
	const effScrollTop = brRow < renderer.frozenRows ? 0 : viewportEl.scrollTop;
	const cornerX = colX(brCol + 1, renderer.gutterWidthPx) - effScrollLeft;
	const cornerY = rowY(brRow + 1) - effScrollTop;
	return Math.abs(ev.clientX - rect.left - cornerX) <= FILL_HANDLE_HIT_PX
		&& Math.abs(ev.clientY - rect.top - cornerY) <= FILL_HANDLE_HIT_PX;
}

// W-G fill handle: a pointer press on the handle starts a drag-to-fill (pointer events so setPointerCapture
// keeps move/up firing if the pointer leaves the canvas). A press elsewhere is left to the click handler.
canvasEl.addEventListener('pointerdown', ev => {
	// megaudit Lane C: ignore a re-entrant pointerdown while a drag is already in flight (a second touch /
	// stylus). It must not reset the suppress flag, restart the drag, or rebind `fillSource` to a different
	// rect -- the first pointer owns the drag until its pointerup/pointercancel. FE-3: a point drag is the same
	// single-owner contract, so a press while EITHER drag is live is ignored.
	if (fillSource !== null || pointDrag !== null) {
		return;
	}
	// megaudit MED: clear any leftover suppress flag at the START of every interaction so it can never
	// linger to swallow a later legitimate click (on platforms where preventDefault below already
	// suppresses the drag's own synthetic click, the flag would otherwise never be consumed). FE-3 clears the
	// point suppress flag for the same reason.
	fillSuppressClick = false;
	pointSuppressClick = false;
	// FE-3 range-pick / point mode: when a formula IS being edited and the caret sits at a ref-insertion
	// position, a grid press points a reference INTO the formula instead of selecting. Runs BEFORE the fill
	// guard (which bails on an open editor). preventDefault keeps focus in the editor (no blur-commit) and
	// setPointerCapture keeps move/up firing off-canvas -- exactly the fill handle's mechanism.
	if (editState !== null && !editState.pendingCommit && ev.button === 0) {
		const el = editState.editEl;
		const selStart = el.selectionStart ?? el.value.length;
		const selEnd = el.selectionEnd ?? selStart;
		// FE-3 re-point validity: the "replace the last-pointed ref" span (`pointInsertedSpan`) is only live while
		// the caret is still COLLAPSED exactly at its end (a fresh point immediately after a point). A caret move
		// (arrow key / click inside the input) or a new text selection does NOT fire `input`, so onEditInput never
		// cleared the span -- drop it HERE so this point inserts fresh / replaces the SELECTION, never silently
		// overwrites a ref the user navigated away from (`=SUM(B2,)` + ArrowRight + point C3 must APPEND, not
		// replace B2). Done before capturing `startSpan` so the cancel snapshot matches.
		if (pointInsertedSpan !== null && !(selStart === selEnd && selStart === pointInsertedSpan.end)) {
			pointInsertedSpan = null;
		}
		const hit = hitTestCanvas(ev);
		if (hit !== null && !isOnFillHandle(ev) && canPointAtRange(el.value, selStart, selEnd)) {
			ev.preventDefault();
			pointDrag = { anchor: hit, pointerId: ev.pointerId, startValue: el.value, startSelStart: selStart, startSelEnd: selEnd, startSpan: pointInsertedSpan };
			const rect = selectionRect(hit, hit);
			applyPointInsert(rect);
			pointPreview = rect;
			canvasEl.setPointerCapture(ev.pointerId);
			redraw();
			return;
		}
		// editing but not an eligible point press -> fall through; the fill guard below bails (editState!==null),
		// then the click handler reselects (committing the edit via blur), exactly as before.
	}
	if (editState !== null || active === null || !isOnFillHandle(ev)) {
		return;
	}
	ev.preventDefault();
	const sel = currentSelection();
	fillSource = sel ?? { minRow: active.row, maxRow: active.row, minCol: active.col, maxCol: active.col };
	fillPreview = fillSource;
	canvasEl.setPointerCapture(ev.pointerId);
});
canvasEl.addEventListener('pointermove', ev => {
	// FE-3 point mode: extend the pointed range to the cell under the pointer, rewriting the inserted ref.
	if (pointDrag !== null) {
		if (ev.pointerId !== pointDrag.pointerId) {
			return; // a second touch/pen is NOT the drag owner -- the first pointer owns the drag, ignore its moves
		}
		if (editState === null) {
			pointDrag = null; // the editor vanished mid-drag (defensive) -- abandon without finalizing
			pointPreview = null;
			redraw();
			return;
		}
		const phit = hitTestCanvas(ev);
		// A move into a band (phit===null) snaps the preview + ref back to the single anchor cell, so a release
		// there points just the anchor (mirrors the fill handler's band snap-back).
		const rect = phit === null ? selectionRect(pointDrag.anchor, pointDrag.anchor) : selectionRect(pointDrag.anchor, phit);
		if (
			pointPreview === null ||
			rect.minRow !== pointPreview.minRow || rect.maxRow !== pointPreview.maxRow ||
			rect.minCol !== pointPreview.minCol || rect.maxCol !== pointPreview.maxCol
		) {
			applyPointInsert(rect);
			pointPreview = rect;
			redraw();
		}
		return;
	}
	if (fillSource === null) {
		return;
	}
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		// megaudit Lane C: the pointer left the grid into a header/gutter band -- snap the preview back to the
		// source so RELEASING here is a visible no-op (a cancel), not a commit of the last in-grid extent.
		if (
			fillPreview === null ||
			fillPreview.minRow !== fillSource.minRow || fillPreview.maxRow !== fillSource.maxRow ||
			fillPreview.minCol !== fillSource.minCol || fillPreview.maxCol !== fillSource.maxCol
		) {
			fillPreview = fillSource;
			redraw();
		}
		return;
	}
	const next = computeFillPreview(fillSource, hit.row, hit.col);
	if (fillPreview === null || next.minRow !== fillPreview.minRow || next.maxRow !== fillPreview.maxRow || next.minCol !== fillPreview.minCol || next.maxCol !== fillPreview.maxCol) {
		fillPreview = next;
		redraw();
	}
});
canvasEl.addEventListener('pointerup', ev => {
	// FE-3 point mode: finalize the pointed reference at the RELEASE cell (authoritative, mirrors fill), keep
	// the editor open + focused, and swallow the synthesized post-drag click so it does not re-select.
	if (pointDrag !== null) {
		if (ev.pointerId !== pointDrag.pointerId) {
			return; // not the drag owner -- a foreign pointer's up must not finalize the first pointer's drag
		}
		canvasEl.releasePointerCapture?.(ev.pointerId);
		if (editState !== null) {
			const releaseHit = hitTestCanvas(ev);
			const rect = releaseHit === null ? selectionRect(pointDrag.anchor, pointDrag.anchor) : selectionRect(pointDrag.anchor, releaseHit);
			applyPointInsert(rect);
			editState.editEl.focus(); // re-assert focus (the pointer-capture target was the canvas)
		}
		pointDrag = null;
		pointPreview = null;
		pointSuppressClick = true;
		redraw();
		return;
	}
	if (fillSource === null) {
		return;
	}
	canvasEl.releasePointerCapture?.(ev.pointerId);
	// Lane C final audit: a pointerup can fire over a header/gutter band (or at a position the last
	// pointermove never reported), so re-evaluate the RELEASE position here -- it is authoritative for what
	// commits. A release outside the grid snaps back to the source (cancel, no extension); an in-grid release
	// recomputes the extent from the actual release cell. Closes the "release-over-band commits a stale
	// preview" hole that the pointermove snap-back alone did not cover.
	const releaseHit = hitTestCanvas(ev);
	fillPreview = releaseHit === null ? fillSource : computeFillPreview(fillSource, releaseHit.row, releaseHit.col);
	const filled = applyFill();
	fillSource = null;
	fillPreview = null;
	// Lane C: suppress the synthesized post-drag click ONLY when a fill actually committed; a no-op handle
	// tap must let its click through to select the cell.
	fillSuppressClick = filled;
	redraw();
});
// megaudit MED: if the drag is CANCELED (pointercancel -- a touch/pen hijack, a system overlay), there is
// no pointerup, so clear the drag state here too. Otherwise `fillSource`/`fillPreview` stay set (a frozen
// preview, and a later unrelated pointerup would apply an unintended fill). No fill is committed on a
// cancel. (Only pointercancel, NOT lostpointercapture -- the latter also fires on the normal post-pointerup
// release and could race applyFill.)
canvasEl.addEventListener('pointercancel', ev => {
	// FE-3 point mode: a hijacked point drag REVERTS the editor to its pre-drag state (no half-pointed ref is
	// left behind); the editor stays open so the user can re-point. Mirrors the fill cancel (which commits
	// nothing) but must also undo the text we already inserted on pointerdown.
	if (pointDrag !== null) {
		if (ev.pointerId !== pointDrag.pointerId) {
			return; // not the drag owner -- a foreign pointer's cancel must not abort the first pointer's drag
		}
		if (editState !== null) {
			const el = editState.editEl;
			el.value = pointDrag.startValue;
			el.setSelectionRange(pointDrag.startSelStart, pointDrag.startSelEnd); // restore the FULL pre-drag selection
			pointInsertedSpan = pointDrag.startSpan;
			el.focus(); // re-assert focus (defensive: if a platform fired blur despite the pointerdown preventDefault)
			closeCompletion();
			if (formulaBarIsEditing()) {
				scheduleValidate();
				updateSignatureHint();
			}
		}
		pointDrag = null;
		pointPreview = null;
		redraw();
		return;
	}
	if (fillSource === null) {
		return;
	}
	fillSource = null;
	fillPreview = null;
	redraw();
});

// Single click SELECTS the cell (Excel). It does NOT open the editor -- double-click / F2 / type-to-edit do.
// If an editor was open, the focus-out it caused already committed/cancelled it via the blur handler above;
// here we only move the selection. (A pending commit keeps its editor; the click still just reselects.)
canvasEl.addEventListener('click', ev => {
	if (pointSuppressClick) {
		pointSuppressClick = false; // FE-3 point mode: swallow the click synthesized after a point press/drag
		return;
	}
	if (fillSuppressClick) {
		fillSuppressClick = false; // W-G fill handle: swallow the click synthesized after a fill drag
		return;
	}
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		return;
	}
	// W-G-2a: Shift+click EXTENDS the selection -- the click cell becomes the focus, the anchor stays (or is
	// established at the prior focus). A plain click COLLAPSES to the single clicked cell.
	if (ev.shiftKey) {
		if (anchor === null) {
			anchor = active ?? { row: hit.row, col: hit.col };
		}
	} else {
		anchor = null;
	}
	active = { row: hit.row, col: hit.col };
	redraw();
});

// Double click opens the editor on the cell (Excel). beginEdit re-asserts the selection + reveal; it bails
// if a commit is still in flight (M8), consistent with every other edit entry point.
canvasEl.addEventListener('dblclick', ev => {
	// FE-3 range-pick: while an editor is OPEN, a dblclick must NOT open a new cell editor -- two rapid point
	// clicks synthesize a dblclick, and beginEdit() would cancelEdit() the in-progress formula (dropping it).
	// Editing is single-cell; to edit another cell the user commits first (Enter/Tab/click-away). Excel-aligned.
	if (editState !== null) {
		return;
	}
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		return;
	}
	beginEdit(hit.row, hit.col);
	redraw();
});

// ============================================================================================
// W3 (Wave 3, 2026-06-09) -- NATIVE RIGHT-CLICK CONTEXT MENU.
//
// **SHARED-FILE FLAG (conductor):** this is the ONE additive W3 block in index.ts (the frozen-panes lead
// also edits this file for paint/layout). It is event-handler-only -- it touches NO paint/layout code and
// no module state beyond the existing selection (`active`/`anchor`) it reuses for the click-to-select.
//
// Mechanism: on `contextmenu` we hit-test the clicked cell and set `data-vscode-context` (a JSON string)
// on the canvas. VS Code reads that attribute and shows the `menus["webview/context"]` items contributed
// in package.json (gated on `webviewId == 'quantlab.quantbookCellGrid'` + the section). On the LET-THROUGH
// path we do NOT call `preventDefault()`: the native menu needs the default contextmenu to proceed;
// `preventDefaultContextMenuItems` in the payload suppresses VS Code's own built-in items. The pure payload
// builder is contextMenuPayload.ts.
//
// **Codex r3 fix-verify BLOCKER (2026-06-10) -- the menu may only open over a RESOLVED editor.** The
// payload is a LIVE hand-off: the host runs structural insert/delete directly from it (and the clipboard
// items post `{type:'contextMenuAction'}` back into write paths), so priming it while an editor is still
// open re-creates the demo-blocker stale-coordinate class -- the host mutates, then the editor's later
// blur-commit posts its PRE-mutation row/col into the shifted grid. The webview cannot defer the HOST's
// menu (VS Code shows it the instant this event completes; nothing can re-open it at a later commit-ack),
// so the editor is resolved AT MENU TIME via {@link resolveEditForNativeSurface}: unchanged/known-bad ->
// cancelled (Escape semantics) and the menu proceeds over the resolved grid; CHANGED -> committed NOW and
// the menu is SUPPRESSED this once; PENDING -> suppressed likewise. Suppression = `ev.preventDefault()`:
// the injected webview script (src/vs/workbench/contrib/webview/browser/pre/index.html, the contextmenu
// forwarder) returns early on `e.defaultPrevented` -- "extension code has already handled this event" --
// so VS Code never posts `did-context-menu` and no menu shows. The resolver's banner tells the user to
// right-click again (No-Fallbacks: a suppressed menu is explained, never a silently dead right-click).
// ============================================================================================
canvasEl.addEventListener('contextmenu', ev => {
	const hit = hitTestCanvas(ev);
	if (hit === null) {
		// A right-click on the sticky header band / row gutter / corner / empty space: no target cell ->
		// tag NO quantbook section so none of the grid menu items appear (No-Fallbacks: never offer an
		// action with no cell to act on). VS Code still reads the attribute for `preventDefaultContextMenuItems`.
		// An open editor is deliberately NOT resolved here: the empty payload offers NO mutations, so there
		// is no stale-coordinate risk -- and cancelling/committing an edit for an empty menu would be a
		// surprising side effect of a band right-click (a LEFT band click leaves the editor alone too).
		canvasEl.setAttribute('data-vscode-context', buildEmptyContextPayload());
		return;
	}
	// Codex r3 fix-verify BLOCKER: resolve any open editor BEFORE priming the live payload (see the block
	// comment above). `false` = the editor could not be resolved synchronously (its changed value is now
	// committing, or a commit was already in flight): suppress the native menu this once and clear the
	// payload to the empty (no-mutations) shape as defense-in-depth -- if some future VS Code build showed
	// a menu despite `defaultPrevented`, it would offer NO grid actions rather than stale-coordinate ones.
	if (!resolveEditForNativeSurface('right-click again once it settles to open the menu.')) {
		ev.preventDefault(); // pre/index.html honors defaultPrevented -> no native menu for this click
		canvasEl.setAttribute('data-vscode-context', buildEmptyContextPayload());
		return;
	}
	// From here down the editor is RESOLVED (none was open, or it was cancelled above), so the selection
	// reads below -- `currentSelection()` / `active` / `anchor`, possibly moved by the click-to-select --
	// are settled state, and the payload they produce stays correct for the menu VS Code is about to show.
	// Excel semantics: right-clicking OUTSIDE the current selection moves the selection to the clicked
	// cell (so the menu acts on what the user just clicked); right-clicking INSIDE a multi-cell selection
	// keeps it (so "Delete Row" removes the whole selected band). This keeps the host-tracked selection --
	// which the insert/delete + clipboard commands act on -- consistent with the right-clicked cell.
	const sel = currentSelection();
	const insideSelection =
		sel !== null &&
		hit.row >= sel.minRow && hit.row <= sel.maxRow &&
		hit.col >= sel.minCol && hit.col <= sel.maxCol;
	if (!insideSelection) {
		anchor = null;
		active = { row: hit.row, col: hit.col };
		redraw();
	}
	// Codex W3 HIGH-1: carry the AUTHORITATIVE selection (the anchor+focus AFTER the click-to-select above)
	// directly in the payload, so the insert/delete command plans from THIS rect rather than the
	// async-updated host selection (which a fast menu command could read stale -> wrong band). `active` is
	// non-null here (set above or pre-existing). The anchor collapses to the focus when there is no range.
	// Codex W3 HIGH-2: carry WEBVIEW_ID so the host routes the command to the EXACT panel that raised the
	// menu (not merely the focused one). `hasSelection` (advisory, for labelling) is the post-click state.
	const focusCell = active ?? { row: hit.row, col: hit.col };
	const anchorCell = anchor ?? focusCell;
	const selectionPayload = {
		anchorRow: anchorCell.row,
		anchorCol: anchorCell.col,
		focusRow: focusCell.row,
		focusCol: focusCell.col,
	};
	canvasEl.setAttribute(
		'data-vscode-context',
		buildCellContextPayload(hit, selectionPayload, WEBVIEW_ID, currentSelection() !== null),
	);
});

// W3 (Wave 3): host -> webview bridge for the clipboard menu items. Cut/Copy/Paste/Clear Contents live in
// the WEBVIEW (the grid clipboard + the active-cell clear are webview state), so the native menu's host
// commands post `{type:'contextMenuAction', action}` down to the focused panel's webview, which routes to
// the SAME functions as the Ctrl/Cmd+C/X/V/Delete keystrokes. Declared here next to the menu wiring; the
// dispatch arm is added to the `message` listener below (one place owns inbound routing).
type ContextMenuAction = 'cut' | 'copy' | 'paste' | 'clear';
function runContextMenuAction(action: ContextMenuAction): void {
	switch (action) {
		case 'copy':
			copyGridSelection(false);
			return;
		case 'cut':
			copyGridSelection(true);
			return;
		case 'paste':
			pasteGridClipboard();
			return;
		case 'clear':
			// Codex W3 MED-3: the menu keeps a multi-cell selection (right-click inside it), so "Clear
			// Contents" must clear the WHOLE selection -- otherwise the label overstates what happened. A
			// single-cell selection routes to the existing single-cell clear (byte-identical to Delete).
			clearContextSelection();
			return;
		default: {
			// No-Fallbacks: an unknown action from the host is a wiring bug, not a silent no-op.
			const unreachable: never = action;
			console.warn('[sheets-webview] ignored unknown contextMenuAction:', unreachable);
		}
	}
}

// Codex W3 re-audit MED: the webview-side cap on a single "Clear Contents" batch, mirroring the host's
// `MAX_BATCH_CELLS` (cellGridLogic.ts). Preflighted before the array is built so an oversize selection is
// refused with a visible message instead of materializing a huge array.
const CLEAR_SELECTION_MAX_CELLS = 100_000;

/**
 * **W3 (Codex MED-3)** -- "Clear Contents" over the current selection. Clears every cell in the selection
 * rect as ONE atomic `putCells` batch (a single undo unit; the host applies via `Session.batch`), so the
 * action matches the visible selection. A single-cell selection delegates to {@link clearActiveCell} (the
 * existing Delete path) so the simple case is unchanged. Each cleared cell drops its optimistic error tint
 * (the host's `cellsWritten` ack confirms; an `errorReply` re-decorates on failure -- No-Fallbacks).
 */
function clearContextSelection(): void {
	if (fullSnapshot === null || active === null) {
		return;
	}
	const sel = currentSelection();
	if (sel === null) {
		clearActiveCell();
		return;
	}
	// Codex W3 re-audit MED: PREFLIGHT the cell count BEFORE materializing the array, so a pathologically
	// large selection surfaces a visible error here rather than building a huge array + hanging the webview
	// (the host's MAX_BATCH_CELLS rejection would otherwise only fire after the array exists). Mirrors the
	// host cap (cellGridLogic.MAX_BATCH_CELLS = 100_000); No-Fallbacks -- a refused clear is a clear message.
	const cellCount = (sel.maxRow - sel.minRow + 1) * (sel.maxCol - sel.minCol + 1);
	if (cellCount > CLEAR_SELECTION_MAX_CELLS) {
		showError(`The selection is too large to clear at once (${cellCount} cells; max ${CLEAR_SELECTION_MAX_CELLS}). Select a smaller range.`, 'transient');
		return;
	}
	const cells: { row: number; col: number; rawInput: string }[] = [];
	for (let r = sel.minRow; r <= sel.maxRow; r += 1) {
		for (let c = sel.minCol; c <= sel.maxCol; c += 1) {
			errorCells.delete(r + ',' + c);
			cells.push({ row: r, col: c, rawInput: '' });
		}
	}
	vscode.postMessage({ type: 'putCells', sheet: fullSnapshot.sheet, cells, undoLabel: 'Clear Contents', webviewId: WEBVIEW_ID });
	redraw();
}

// Hover tooltip: surface a cell's errorReply message or its engine diagnostic via the native `title`.
// FE megaudit L-b: coalesce mousemove to ONE hit-test per animation frame.
let lastHoverTitle = '';
let hoverClientX = 0;
let hoverClientY = 0;
let hoverScheduled = false;
function updateHoverTitle(): void {
	hoverScheduled = false;
	let title = '';
	if (fullSnapshot !== null) {
		const rect = canvasEl.getBoundingClientRect();
		const hit = hitTestViewportFrozen(
			hoverClientX - rect.left,
			hoverClientY - rect.top,
			viewportEl.scrollLeft,
			viewportEl.scrollTop,
			renderer.gutterWidthPx,
			renderer.frozenRows,
			renderer.frozenCols,
		);
		if (hit !== null) {
			const entry = renderer.entryAt(hit.row, hit.col);
			const key = hit.row + ',' + hit.col;
			// Audit C1-HIGH2: cap the tooltip string (a pathological diagnostic/error message shouldn't
			// stall the native `title` rendering).
			const errPart = clampDisplayString(
				errorCells.get(key) ?? (entry && typeof entry.diagnostic === 'string' ? entry.diagnostic : ''),
			);
			// W-G bound-cell name display: if this cell is a published target, add a line naming the reactive
			// variable that drives it. Each part is clamped first (so a pathological diagnostic/name never
			// builds a huge join), then the COMPOSED title is clamped once more so the whole string still
			// honors the single C1-HIGH2 cap (Codex LOW) -- realistic short errors keep both lines intact.
			const drivenBy = publishedNameAt(publishedRanges, hit.row, hit.col);
			const pubPart = drivenBy === null ? '' : clampDisplayString('Driven by reactive variable "' + drivenBy + '"');
			title = clampDisplayString([errPart, pubPart].filter(part => part.length > 0).join('\n'));
		}
	}
	if (title !== lastHoverTitle) {
		canvasEl.title = title;
		lastHoverTitle = title;
	}
}
// Coalesce a native-title recompute to ONE hit-test per animation frame. Called on pointer move AND
// (W-G bound-cell name display, Codex MED) after any repaint -- a publish retraction (-> redraw) or a
// scroll (-> scrollRedraw) can move a different cell, or a now-unpublished cell, under a STATIONARY
// pointer, so the title must be recomputed from the last pointer position, not only on the next move.
// Safe to call from redraw()/scrollRedraw(): both run well after module load, so `hoverScheduled` (a
// module `let` initialized above) is always defined by then (the W-G-1b init-order lesson).
function scheduleHoverTitle(): void {
	if (hoverScheduled) {
		return;
	}
	hoverScheduled = true;
	requestAnimationFrame(updateHoverTitle);
}
canvasEl.addEventListener('mousemove', ev => {
	hoverClientX = ev.clientX;
	hoverClientY = ev.clientY;
	scheduleHoverTitle();
});

// --- Keyboard: navigation + type-to-edit + undo/redo (only when NOT editing) ---

// ---- Round 5 (2026-06-10): in-sheet Find (Ctrl/Cmd+F + the toolbar Search button) --------------------
// A floating find bar over the grid. Scans the CURRENT sheet's snapshot entries (display string AND the
// underlying formula) for a case-insensitive substring, collects matches row-major, and jumps the
// selection to each (Enter / Shift+Enter step; Escape closes). Webview-only -- the snapshot is already in
// memory, so no host round-trip. Wiring the previously-dead Search button was the audit's #1 cheap win.
let findBarEl: HTMLDivElement | null = null;
let findInputEl: HTMLInputElement | null = null;
let findCountEl: HTMLSpanElement | null = null;
let findMatches: ActiveCell[] = [];
let findIndex = -1;

function buildFindBar(): void {
	const bar = document.createElement('div');
	bar.className = 'qb-find-bar';
	const input = document.createElement('input');
	input.className = 'qb-find-input';
	input.type = 'text';
	input.placeholder = 'Find in sheet';
	input.setAttribute('aria-label', 'Find in sheet');
	input.spellcheck = false;
	const count = document.createElement('span');
	count.className = 'qb-find-count';
	const mkBtn = (glyph: string, title: string, onClick: () => void): HTMLButtonElement => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'qb-find-btn';
		b.title = title;
		b.setAttribute('aria-label', title);
		b.textContent = glyph;
		b.addEventListener('mousedown', (e) => e.preventDefault());
		b.addEventListener('click', onClick);
		return b;
	};
	const prev = mkBtn('\u2191', 'Previous match (Shift+Enter)', () => stepFind(-1));
	const next = mkBtn('\u2193', 'Next match (Enter)', () => stepFind(1));
	const close = mkBtn('\u2715', 'Close (Esc)', () => closeFindBar());
	bar.append(input, count, prev, next, close);
	input.addEventListener('input', () => runFind(input.value));
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			stepFind(e.shiftKey ? -1 : 1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeFindBar();
		} else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
			// Round-5 LOW fix: a SECOND Ctrl/Cmd+F while the find input is focused must not fall through
			// to the webview default (the document handler ignores find-bar targets on purpose) -- it
			// re-selects the query, the browser-find convention.
			e.preventDefault();
			input.select();
		}
	});
	document.body.appendChild(bar);
	findBarEl = bar;
	findInputEl = input;
	findCountEl = count;
}

function openFindBar(): void {
	if (findBarEl === null || findInputEl === null) {
		buildFindBar();
	}
	if (findBarEl === null || findInputEl === null) {
		return; // unreachable (buildFindBar sets both) -- keeps strict-null-checks happy without `!`
	}
	// Round-5 LOW fix: anchor the bar under the live chrome (menu bar + toolbar + formula bar) instead
	// of the former hardcoded `top: 92px` -- the viewport's rect IS that boundary, whatever the chrome
	// stack currently measures (theme/zoom/density changes included).
	findBarEl.style.top = String(Math.round(viewportEl.getBoundingClientRect().top) + 8) + 'px';
	findBarEl.classList.add('is-visible');
	findInputEl.focus();
	findInputEl.select();
	runFind(findInputEl.value);
}

function closeFindBar(): void {
	if (findBarEl !== null) {
		findBarEl.classList.remove('is-visible');
	}
	findMatches = [];
	findIndex = -1;
	viewportEl.focus();
}

function runFind(queryRaw: string): void {
	const q = queryRaw.trim().toLowerCase();
	findMatches = [];
	findIndex = -1;
	if (q.length > 0 && fullSnapshot !== null) {
		for (const e of fullSnapshot.entries) {
			const disp = (typeof e.rendered === 'string' ? e.rendered : formatCellValue(e.value)).toLowerCase();
			const formula = typeof e.formula === 'string' ? e.formula.toLowerCase() : '';
			if (disp.includes(q) || formula.includes(q)) {
				findMatches.push({ row: e.row, col: e.col });
			}
		}
		findMatches.sort((a, b) => a.row - b.row || a.col - b.col);
		if (findMatches.length > 0) {
			findIndex = 0;
			gotoFindMatch();
		}
	}
	updateFindCount();
}

function stepFind(dir: number): void {
	if (findMatches.length === 0) {
		return;
	}
	// Round-5 audit (lane B HIGH): the find bar's prev/next buttons preventDefault their mousedown, so an
	// OPEN editor keeps focus through the click -- stepping must resolve it first (cancel-if-unchanged
	// / commit-and-queue), exactly like every other chrome action, or the jump moves the selection out
	// from under it. With no editor this runs synchronously (the common case).
	resolveEditThen({
		kind: 'chrome',
		label: 'Find next',
		run: () => {
			findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
			gotoFindMatch();
			updateFindCount();
		},
	});
}

function gotoFindMatch(): void {
	const m = findMatches[findIndex];
	if (m === undefined) {
		return;
	}
	// Round-5 audit (lane B HIGH, the narrow window): never move the selection while an editor exists
	// (a PENDING one survives the find input's focus-steal blur -- onEditBlur early-returns on
	// pendingCommit). The match list + count still update; the jump simply doesn't happen until the
	// editor resolves and the user steps again.
	if (editState !== null) {
		return;
	}
	anchor = null;
	active = { row: m.row, col: m.col };
	ensureActiveVisible();
	redraw();
}

function updateFindCount(): void {
	if (findCountEl === null) {
		return;
	}
	const q = findInputEl?.value.trim() ?? '';
	findCountEl.textContent =
		q.length === 0 ? '' : findMatches.length === 0 ? 'No results' : findIndex + 1 + ' of ' + findMatches.length;
}

document.addEventListener('keydown', ev => {
	// **FE-5 W-F (2026-06-12) -- F3 / Shift-F3 = find next / previous (the browser-find convention).**
	// Handled BEFORE every other guard so it works regardless of focus (grid, formula bar, or the find input)
	// -- F3 is an unambiguous dedicated key. Steps the FE-4 find hit list with wrap (`stepFind` resolves any
	// open editor first, exactly like the find bar's prev/next buttons). A no-op (but still preventDefaulted,
	// so the browser's native find never opens) when there are no matches. Shift-F3 steps backward.
	if (ev.key === 'F3') {
		ev.preventDefault();
		stepFind(ev.shiftKey ? -1 : 1);
		return;
	}
	// W-G: the formula bar input is focusable (read-only, but selectable so a formula can be copied out).
	// Its keystrokes bubble to this document handler -- ignore them, or arrows/Delete/printable keys would
	// drive grid navigation / clear / type-to-edit on the active cell while the user is in the formula bar
	// (Codex W-G HIGH). Copy (Ctrl+C of a selected formula) still works: the browser handles it natively.
	if (ev.target === formulaInputEl) {
		return;
	}
	// FE-11: the name box input is focusable + editable. Like the formula bar (above), its keystrokes bubble
	// to this document handler -- ignore them, or arrows/Backspace/printable keys would drive grid nav / clear
	// / type-to-edit the active cell while the user is typing a NAME (the same Codex W-G HIGH class, and a
	// silent-cell-write hazard since the name box is NOT in `editState`, so the `editState !== null` guard
	// below does NOT catch it). Enter/Escape are handled (and stopPropagation'd) by the name box's own
	// listener; F3 above is intentionally focus-independent, matching the formula bar.
	if (ev.target === nameBoxEl) {
		return;
	}
	// Round 5: the find bar owns its own keys (Enter/Shift+Enter/Esc) -- never drive grid nav from them.
	if (findBarEl !== null && ev.target instanceof Node && findBarEl.contains(ev.target)) {
		return;
	}
	if (editState !== null) {
		return; // the editor has its own handler
	}
	// W1 formula-intel: if the completion dropdown is showing, it owns the keyboard (its keys are intercepted
	// on the editor's own handler). `completion` is only non-null during a formula edit, so `editState !== null`
	// above already covers this -- but guard explicitly so a future change that can leave `completion` set
	// outside an edit never lets a nav key fire underneath an open dropdown.
	if (completion !== null) {
		return;
	}
	// megaudit Lane C: ignore document shortcuts (undo/redo, copy/cut/paste, nav, type-to-edit) WHILE a
	// fill-handle drag is in flight. A Ctrl+X mid-drag would replace the clipboard and silently discard a
	// pending CUT; arrow/nav keys would move the selection under the drag. The drag owns input until
	// pointerup/pointercancel clears `fillSource`.
	if (fillSource !== null) {
		return;
	}
	// Audit MED-1: ignore IME composition / dead-key keystrokes (keyCode 229 or `isComposing`). Without
	// this, the FIRST composition keystroke would open the editor pre-filled with a raw intermediate char
	// and `preventDefault()` would suppress the real composed text -- breaking CJK/accented type-to-edit.
	if (ev.isComposing || ev.keyCode === 229) {
		return;
	}
	// **FE-4 keyboard STATE MACHINE.** The guards above own WHETHER this key reaches the keyboard core (the
	// formula-bar bubble, the find-bar key ownership, the `editState`/`completion`/`fillSource` early-returns,
	// and IME). Past them, we are in a NAV-LIKE mode -- `range` if a multi-cell selection exists, else `nav`.
	// The pure `gridKeyDispatch` CLASSIFIES the key into a descriptive action; the switch below EXECUTES it
	// through the unchanged machinery. This is the post-guard flat-switch refactored into one tested table.
	const mode: GridMode = currentSelection() !== null ? 'range' : 'nav';
	const mods: KeyModifiers = { meta: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey };
	const action = gridKeyDispatch(mode, ev.key, mods);
	switch (action.kind) {
		case 'nav':
			// W-G-2a: Shift+Arrow EXTENDS the range (anchor stays, focus moves); a plain arrow/Enter/Tab
			// COLLAPSES + moves. `extend` is true only for the shift-arrows (Enter/Tab carry extend:false).
			ev.preventDefault();
			(action.extend ? extendActive : moveActive)(action.dr, action.dc);
			return;
		case 'jump':
			// Ctrl+Home -> A1; End / Ctrl+End -> the last used cell; plain Home -> column A of the current row.
			ev.preventDefault();
			if (action.target === 'a1') {
				jumpActive(0, 0);
			} else if (action.target === 'usedEnd') {
				const end = usedExtent();
				jumpActive(end.row, end.col);
			} else {
				jumpActive(active === null ? 0 : active.row, 0);
			}
			return;
		case 'pageMove':
			// Move the active cell by one screenful of rows (+ scroll into view, via moveActive). Mirrors the
			// arrow path; clamps at the grid edge.
			ev.preventDefault();
			moveActive(action.dir * visibleRowSpan(), 0);
			return;
		case 'collapse':
			// W-G-2a: collapse a multi-cell range back to the focus cell. In `nav` mode there is no anchor, so
			// this is a no-op that does NOT preventDefault (preserving the shipped Escape arm exactly).
			if (anchor !== null) {
				ev.preventDefault();
				collapseSelection();
				redraw();
			}
			return;
		case 'beginEdit':
			// F2 (char undefined) opens the editor with the prior content; type-to-edit (char set) seeds it.
			// PreventDefault semantics preserved EXACTLY from the shipped flat switch: F2 preventDefaulted
			// UNCONDITIONALLY (then edited only when `active !== null`); type-to-edit preventDefaulted ONLY when
			// `active !== null` (so a printable key with no active cell fell through to the browser). `active` is
			// never null in normal operation, but this keeps the divergence byte-identical.
			if (action.char === undefined) {
				ev.preventDefault(); // F2: unconditional, matching the shipped `case 'F2'`
				if (active !== null) {
					beginEdit(active.row, active.col);
					redraw();
				}
			} else if (active !== null) {
				ev.preventDefault(); // type-to-edit: only when there is a cell to seed (the shipped tail guard)
				beginEdit(active.row, active.col, action.char);
				redraw();
			}
			return;
		case 'clear':
			// Audit O2-MED3: clear the selected cell. preventDefault is load-bearing for Backspace -- otherwise
			// it triggers webview history-back navigation.
			ev.preventDefault();
			clearActiveCell();
			return;
		case 'copy':
			// W-G copy/paste: reached only when NOT editing + NOT in the formula bar (guarded above), so a
			// native text copy inside an input is unaffected.
			ev.preventDefault();
			copyGridSelection(false);
			return;
		case 'cut':
			ev.preventDefault();
			copyGridSelection(true);
			return;
		case 'paste':
			ev.preventDefault();
			pasteGridClipboard();
			return;
		case 'find':
			// Round 5: Ctrl/Cmd+F opens the in-sheet find bar (the VS Code editor find has no meaning over a
			// canvas grid).
			ev.preventDefault();
			openFindBar();
			return;
		case 'undo':
			ev.preventDefault();
			vscode.postMessage({ type: 'undo' });
			return;
		case 'redo':
			ev.preventDefault();
			vscode.postMessage({ type: 'redo' });
			return;
		case 'fillDown':
			// FE-4: Ctrl/Cmd+D fills down over the selection (multi-row) or from the cell above (single cell).
			ev.preventDefault();
			fillSelection('down');
			return;
		case 'fillRight':
			// FE-4: Ctrl/Cmd+R fills right over the selection (multi-col) or from the cell to the left (single).
			ev.preventDefault();
			fillSelection('right');
			return;
		case 'passthrough':
			// No-Fallbacks: an unhandled key (an unbound meta combo, an alt chord, a non-printable key like a
			// bare Shift, or a printable char with no active cell) is left for the browser -- NEVER preventDefaulted.
			return;
		case 'commitMove':
		case 'editEscape':
		case 'editArrow':
		case 'cycleRef':
			// UNREACHABLE in a nav-like mode: these are editor-only action kinds (`onEditKeydown` handles them).
			// The dispatcher never returns them for `nav`/`range`. Throw loudly if a future change makes one
			// reachable here (No-Fallbacks: a silent drop would eat a key). Casing them explicitly lets the
			// `default` below narrow to `never`, proving the union is exhausted at compile time.
			throw new Error('[sheets-webview] editor-only grid action reached the document keydown switch: ' + action.kind);
		default:
			assertNeverAction(action);
	}
});

/** Compile-time exhaustiveness guard for the document keydown action switch: every {@link GridAction} kind
 *  is cased above, so `action` narrows to `never` here. If a future change adds a kind the switch misses,
 *  TypeScript flags it AND it throws loudly at runtime (No-Fallbacks: no silent drop). */
function assertNeverAction(action: never): never {
	throw new Error('[sheets-webview] unhandled grid action in the document keydown switch: ' + JSON.stringify(action));
}

// --- Inbound host messages ---

/**
 * Audit C1-MED3: validate a host `render` payload before applying it. The host is trusted, but a
 * binding/version drift or a tampered bundle could deliver a non-conforming object; `applyRender`
 * would then throw opaquely (e.g. `snapshot.entries.length` on undefined) and leave the grid frozen
 * with no explanation. We accept only the pinned shape (`snapshot_format_version === 1`, numeric
 * sheet, array entries) and otherwise surface a visible error (No-Fallbacks -- not a silent return).
 */
function isValidSnapshot(snapshot: unknown): snapshot is QuantbookCellSnapshot {
	if (typeof snapshot !== 'object' || snapshot === null) {
		return false;
	}
	const s = snapshot as { snapshot_format_version?: unknown; sheet?: unknown; entries?: unknown };
	// `sheet` threads into `commitEdit`'s putValue, so require a finite non-negative integer (a NaN/string
	// would post garbage to the host). Per-entry coord/value validation happens in `renderer.setSnapshot`
	// (Codex HIGH-1) -- it skip+warns malformed entries rather than dropping the whole render.
	return (
		s.snapshot_format_version === 1 &&
		typeof s.sheet === 'number' &&
		Number.isInteger(s.sheet) &&
		s.sheet >= 0 &&
		Array.isArray(s.entries)
	);
}

/**
 * Apply a fresh snapshot: update title/meta + spacer, then full-redraw. **FE-2-0 Phase 2 (commit-token):
 * a bare `render` NO LONGER resolves a pending commit** -- it only refreshes the snapshot + repaints; an
 * open editor (pending or not) is PRESERVED and the canvas repaints underneath it. Pending edits resolve
 * ONLY on a matching `commitResult` (success -> {@link resolvePendingCommit}) / `errorReply` (failure),
 * keyed by the unique commitId. This kills the sibling-render false-ack HIGH (a render from a sibling
 * panel / session refresh can't close or mis-resolve this editor) AND the errorCells-clear-on-idle-render
 * + (sheet,row,col) false-match items -- errorCells is now mutated only by a matching reply.
 */
/**
 * **W-G bound-cell indicator** -- rebuild {@link publishedRanges} from a `render` message's `publishedCells`
 * field, validating each item at the trust boundary (mirrors the host selection-drop discipline: a
 * malformed / out-of-extent / mis-ordered item is DROPPED with a `console.warn`, never blanking the grid
 * or throwing). The host sends the authoritative set for this sheet on every render, so we rebuild
 * wholesale. Returns whether the validated set CHANGED since the last render -- the caller forces a FULL
 * redraw on a change, because the damage fast path repaints only rows whose VALUE moved and a stale-only
 * retraction (badge clears, no value change) would otherwise leave the marker on screen.
 */
function rebuildPublishedRanges(raw: unknown): boolean {
	const coordOk = (v: unknown, max: number): v is number =>
		typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < max;
	const next: PublishedRange[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (item === null || typeof item !== 'object') {
				console.warn('[sheets-webview] dropped a non-object publishedCells item:', item);
				continue;
			}
			const pr = item as { startRow?: unknown; startCol?: unknown; endRow?: unknown; endCol?: unknown; name?: unknown };
			if (
				coordOk(pr.startRow, MAX_ROWS) && coordOk(pr.endRow, MAX_ROWS) &&
				coordOk(pr.startCol, MAX_COLS) && coordOk(pr.endCol, MAX_COLS) &&
				pr.startRow <= pr.endRow && pr.startCol <= pr.endCol &&
				typeof pr.name === 'string' && pr.name.length > 0
			) {
				next.push({ startRow: pr.startRow, startCol: pr.startCol, endRow: pr.endRow, endCol: pr.endCol, name: pr.name });
			} else {
				console.warn('[sheets-webview] dropped a malformed publishedCells item:', item);
			}
		}
	} else if (raw !== undefined) {
		console.warn('[sheets-webview] render.publishedCells was not an array; ignoring:', raw);
	}
	const key = next.map(r => r.startRow + ':' + r.startCol + ':' + r.endRow + ':' + r.endCol + ':' + r.name).join('|');
	const changed = key !== publishedRangesKey;
	publishedRanges = next;
	publishedRangesKey = key;
	return changed;
}

/**
 * **FE-5 W-R (2026-06-12)** -- detect a change in the render snapshot's engine STYLE TABLE between renders,
 * updating {@link stylesTableKey}. Returns whether the table changed (the caller forces a FULL redraw on a
 * change -- see the `stylesTableKey` docstring for WHY the per-cell `styleId` damage term is insufficient).
 *
 * The render snapshot's `styles` field is the engine style table (`QuantbookCellSnapshot.styles`, projected
 * by the host's `extractSheetSnapshot`); it is read defensively (it is absent until the first style is
 * registered). When ABSENT, the digest is the empty string -- no engine styles, no table change. When
 * PRESENT, the digest is `peer:counter=<style>` per registered style joined in array order (the engine
 * sorts `styles[]` by `StyleId`, so equal tables produce equal digests); a re-edited style DEFINITION
 * changes the digest even though no cell's `styleId` moved. This is NOT a fallback: an absent table is the
 * genuine "no engine styles" state, and the digest reflects exactly what was sent.
 */
function stylesTableChanged(snapshot: QuantbookCellSnapshot): boolean {
	const styles = (snapshot as { styles?: unknown }).styles;
	let key = '';
	if (Array.isArray(styles)) {
		const parts: string[] = [];
		for (const def of styles) {
			if (def === null || typeof def !== 'object') {
				continue;
			}
			const id = (def as { id?: { peer?: unknown; counter?: unknown } }).id;
			const style = (def as { style?: unknown }).style;
			// Include the style VALUE in the digest (not just the id): a definition re-edit keeps the same id
			// but changes the style payload, and that re-color must force a repaint. JSON of the small style
			// object is a stable canonical form (the engine emits a fixed key set per style).
			const idKey = id === null || id === undefined ? '?' : String(id.peer) + ':' + String(id.counter);
			parts.push(idKey + '=' + JSON.stringify(style ?? null));
		}
		key = parts.join('|');
	}
	const changed = key !== stylesTableKey;
	stylesTableKey = key;
	return changed;
}

function applyRender(snapshot: QuantbookCellSnapshot, publishedChanged: boolean, stylesChanged: boolean, structuralChanged: boolean = false, tablesChanged: boolean = false): void {
	// Re-audit MED-4: a valid render supersedes a TRANSIENT banner (malformed-render / un-editable cell)
	// but must NOT hide an active 'edit' banner -- a sibling render repaints under an open editor whose
	// over-length value is still invalid; clearing it would mask the bad pending state until next commit.
	clearTransientError();
	const prevSnapshot = fullSnapshot; // captured BEFORE replacement for the Phase 3 damage diff
	fullSnapshot = snapshot;
	renderer.setSnapshot(snapshot);

	// Megaudit MED: `errorCells` is keyed by (row,col) for the CURRENT sheet only. Clear it when the
	// snapshot's sheet changes (a Switch Sheet), else a failed A1 on sheet 0 would keep tinting A1 after
	// switching to sheet 1. (A sheet change also makes `diffSnapshotsA1` return null -> full redraw below.)
	const sheetChanged = prevSnapshot !== null && prevSnapshot.sheet !== snapshot.sheet;
	if (sheetChanged) {
		errorCells.clear();
		// **Sheet-tabs cross-sheet edit guard (2026-06-10, Codex HIGH)** -- the INVARIANT (see the guard
		// block above `pendingEditResolvedAction`): NO editor survives a sheet change. This supersedes the earlier
		// Codex-MED fold, which only cancelled a NON-pending FORMULA-BAR edit -- a non-pending OVERLAY
		// editor and ANY pending edit (both surfaces) survived with old-sheet row/col, so a late
		// `commitResult` could close/navigate against the NEW sheet using old-sheet coordinates, and the
		// overlay sat over the wrong sheet's cells. Now:
		//   - PENDING commit: DETACH it (the putValue is already posted to the sheet captured at
		//     edit-start, so the write itself targets the OLD sheet correctly; `detachedCommit` keeps its
		//     ack/error/timeout outcome VISIBLE -- No-Fallbacks), then close the editor UI. The old
		//     re-audit-MED concern (cancelEdit drops the late ack) is answered by the detached record,
		//     which now OWNS that late reply instead of `editState`.
		//   - NOT pending: cancel outright (both surfaces). The un-committed value cannot survive onto a
		//     different sheet; this matches the Escape/blur-unchanged contract. (A USER-initiated switch
		//     never reaches here with a changed value -- `requestSheetSwitch` commits it first; this path
		//     is another panel/command switching the sheet under us.)
		// cancelEdit on the formula surface tears down the assist UI itself; for the overlay/no-editor
		// cases the explicit teardown below clears the dropdown/hint + invalidates an in-flight validate
		// keyed to the old coords (the original Codex-MED fold). The pending record is captured BEFORE
		// cancelEdit (which nulls editState) and parked AFTER it (whose clearError would wipe the
		// detach path's superseded-record banner).
		const hadFormulaEditor = formulaBarIsEditing();
		const pendingToDetach =
			editState !== null && editState.pendingCommit && editState.commitId !== undefined
				? { commitId: editState.commitId, sheet: editState.sheet, row: editState.row, col: editState.col }
				: null;
		if (editState !== null) {
			cancelEdit();
		}
		if (!hadFormulaEditor) {
			teardownFormulaAssist();
		}
		if (pendingToDetach !== null) {
			detachPendingCommit(pendingToDetach);
		}
		// A deferred action overtaken by this HOST-initiated sheet change. A USER sheet switch: honor
		// the click if it targeted a DIFFERENT sheet than the one we just landed on (their intent
		// stands); clear it either way so it can't fire later against yet another state. A CHROME
		// action (demo-blocker slot): DROP IT LOUDLY -- it was aimed at the OLD sheet's host-tracked
		// selection, and this switch just replaced both the active sheet and the selection (reset to
		// A1 above), so running it now would mutate the WRONG sheet. Never silently (No-Fallbacks).
		if (pendingEditResolvedAction !== null) {
			const act = pendingEditResolvedAction;
			pendingEditResolvedAction = null;
			if (act.kind === 'sheetSwitch') {
				if (act.sheet !== snapshot.sheet) {
					vscode.postMessage({ type: 'switchSheet', sheet: act.sheet });
				}
			} else {
				console.warn('[sheets-webview] dropped the deferred action "' + act.label + '": the sheet changed before its edit resolved');
				showError(
					'"' + act.label + '" was cancelled: the sheet changed before the pending edit resolved. ' +
					'Re-issue it on the sheet you want it to act on.',
					'transient',
				);
			}
		}
		// Round-5 audit (lanes A+B MED): the find bar's matches are coordinates on the PREVIOUS sheet --
		// stepping them on the new sheet would jump the selection to stale cross-sheet coordinates and
		// the "N of M" count would lie. Close it (only if it is actually open, so a sheet change never
		// steals focus through closeFindBar's viewport refocus when find was never used).
		if (findBarEl !== null && findBarEl.classList.contains('is-visible')) {
			closeFindBar();
		}
		// Sheet-tabs (2026-06-10): a switch to a DIFFERENT sheet resets the active cell to A1 and scrolls to
		// the top-left, so the new sheet never inherits the previous sheet's selection or scroll (the
		// stale-state guard -- the UI-state analog of the corruption class). The full redraw below paints the
		// A1 selection; `updateFormulaBar` + `postSelectionIfChanged` run after it (gated on `sheetChanged`)
		// so the formula bar + the host's focused-cell reflect the new sheet's A1.
		active = { row: 0, col: 0 };
		anchor = null;
		viewportEl.scrollTop = 0;
		viewportEl.scrollLeft = 0;
	} else if (errorCells.size > 0) {
		// FE-2-0 polish (2026-06-05): clear a STALE tint when the cell's STORED content changed between
		// renders -- i.e. a real write landed (a sibling panel / a recompute FIXED the cell this panel had
		// tinted from a rejected edit). This is the ONLY errorCells mutation a render performs, and it touches
		// neither the editor nor the commit resolution (it only deletes a red tint) -- so the Phase 2 "a bare
		// render never resolves a pending commit / can't false-ack a sibling" invariant holds. The open-editor
		// cell is deliberately NOT exempt: a sibling fixing the cell you're editing SHOULD drop its tint
		// (audit MED-A: exempting it left the tint permanent, and the editor covers the cell anyway).
		for (const key of staleTintKeysA1(prevSnapshot, snapshot, errorCells.keys())) {
			errorCells.delete(key);
		}
	}

	// Audit LOW-3: do NOT refreshTheme() here -- a render is not a theme change. Theme/font changes are
	// handled by the body-class MutationObserver (and the initial read is in the renderer constructor);
	// refreshing per render needlessly cleared the measure cache + recomputed the gutter every snapshot.
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent =
		'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	updateSpacer();

	// **FE-2-0 Phase 3 / FE-2 BAKEOFF** -- the paint decision now lives in the shared orchestrator:
	// damage fast path (a prior frame at the SAME scroll, dpr fresh, published set unchanged -> repaint
	// ONLY the A1 rows whose paint changed via `diffSnapshotsA1`); else a full `redraw()` (the
	// always-correct fallback, taken on the first render, a sheet switch, or any scroll/size change since
	// the last paint). The non-paint prep above (set fullSnapshot, clear/stale-tint errorCells, title/meta,
	// spacer) stays here -- those are DOM/binding writes this file owns. `commitSnapshot` fires the
	// `onAfterDamage` host callback (the formula-bar follow) on the damage path.
	// A4 (2026-06-13): a STRUCTURAL render (insert/delete rows/cols) shifts cell A1 coordinates, which the
	// absolute-keyed damage diff can mis-repaint for a MOVED styled cell -> force the full-redraw path the same
	// way a published-set change does (the orchestrator's first boolean IS the "force full redraw" gate).
	// Tables wave (2026-06-13): `tablesChanged` (a create/drop/move/resize/header-totals-toggle render) rides the
	// SAME gate -- a table change touches no per-cell entry, so the damage diff misses it and the band/border
	// would stay stale until a later full redraw.
	orchestrator.commitSnapshot(prevSnapshot, snapshot, publishedChanged || structuralChanged || tablesChanged, stylesChanged);
	// Sheet-tabs (2026-06-10): after a sheet switch repaints, sync the formula bar to the new sheet's A1
	// and report the reset selection to the host (deduped via `lastPostedSelectionKey`, so a same-sheet
	// render is a no-op). Gated on `sheetChanged` so a normal content render is untouched.
	if (sheetChanged) {
		updateFormulaBar();
		postSelectionIfChanged();
	}
}

/**
 * **FE-2-0 Phase 2 (commit-token)** -- resolve the in-flight edit whose token matches a host
 * `commitResult` success ack: clear that cell's error tint (the commit succeeded), close the editor, and
 * apply the queued post-commit nav. The host posts the session-wide `render` (snapshot updated) BEFORE
 * this ack on the SAME FIFO channel, so in the normal path the committed value is already on screen when
 * the editor closes. **Re-audit MED:** if THIS panel's render failed (threw -> `onCommit`'s failed-count
 * "run Refresh" toast; or non-delivered -> `postRenderIfReady`'s non-delivery toast), the canvas is
 * briefly stale after the editor closes -- but the host has ALREADY surfaced a visible "refresh" warning
 * in both those cases, so the staleness is explained + recoverable (it is not silent). Ignores a
 * non-matching id (a stale ack / an ack for a different in-flight edit).
 */
function resolvePendingCommit(commitId: number): void {
	// Megaudit MED: match on commitId EVEN IF `pendingCommit` was already cleared by the 10s watchdog -- a
	// genuinely-late success ack must still close the editor + apply the nav (the prior `!pendingCommit`
	// guard dropped it on the floor, leaving the editor open under a false "could not confirm" banner).
	if (editState === null || editState.commitId !== commitId) {
		return;
	}
	// Re-audit HIGH: if the watchdog (or a malformed-render) already recovered this edit (`pendingCommit`
	// cleared) and the user has since typed a correction, a genuinely-LATE success ack must NOT close the
	// editor + discard that typing. Only honor a late ack when the editor still shows the submitted value.
	// (On the normal fast path `pendingCommit` is still true, so this is skipped.)
	if (!editState.pendingCommit && editState.editEl.value !== editState.submittedRawInput) {
		return;
	}
	clearCommitWatchdog(); // resolved -- cancel the recovery net (cancelEdit below also clears it)
	const row = editState.row;
	const col = editState.col;
	const nav = editState.navAfterCommit;
	errorCells.delete(row + ',' + col); // success -> this cell is no longer errored (per-cell, not blanket)
	cancelEdit();
	if (nav !== undefined) {
		setActiveClamped(row + nav.dr, col + nav.dc);
	}
	redraw();
	viewportEl.focus(); // megaudit LOW: keep keyboard focus on the grid so arrow-nav continues after a commit
	// Deferred-action slot (2026-06-10): the commit this action was deferred behind has now RESOLVED
	// successfully and the editor is closed -- carry out the user's queued intent: a tab-strip sheet
	// switch (the host's switch render then resets selection to A1), or a chrome action (structural /
	// undo / redo / format / file command -- the demo-blocker guard). This is the ONLY point a deferred
	// action RUNS; every failure/unknown resolution point drops it instead. The nav/redraw above ran on
	// the still-current sheet, so the action posts against that settled state, AFTER the committed value
	// (FIFO on the postMessage channel) -- the exact ordering the corruption fix requires.
	if (pendingEditResolvedAction !== null) {
		const act = pendingEditResolvedAction;
		pendingEditResolvedAction = null;
		runDeferredActionNow(act);
	}
}

/**
 * **Sheet-tabs cross-sheet edit guard (2026-06-10, Codex HIGH)** -- the USER-initiated half of the
 * "no editor survives a sheet change" invariant (see the guard block above
 * `pendingEditResolvedAction`). Since the Codex demo-blocker fix the body is a one-line delegation to
 * {@link resolveEditThen} (the shared resolver -- chrome actions run the SAME semantics through
 * `runAfterResolvingEdit`); behavior is unchanged:
 *   - PENDING commit (the typical tab-click case: the strip uses `click`, so the editor's `blur`
 *     already fired and posted a changed value): DEFER the switch until the ack resolves. Posted on
 *     success (`resolvePendingCommit`); dropped, with the existing visible banners, on `errorReply` /
 *     watchdog / malformed-render recovery (each keeps or reopens the editor on the OLD sheet).
 *     Last click wins if the user clicks another tab while still deferred (silent for
 *     sheet-over-sheet; LOUD if it supersedes a queued chrome action -- see `setDeferredAction`).
 *   - Open, NOT pending (reachable when focus was not in the editor, so no blur ran): Sheets/Excel
 *     commit-on-navigation -- commit a changed value (then defer the switch behind it exactly as
 *     above); cancel an unchanged or known-bad one (the B2 "abandon a failing value on nav" contract)
 *     and switch immediately. A LOCAL commit reject (over-limit) keeps the editor open with its
 *     'edit' banner and does NOT switch -- never silently discard the user's typed value.
 * The outcome is deliberately ignored: a tab click moves real focus to the tab button (the strip does
 * not preventDefault its mousedown), so the chrome guard's focus restoration does not apply here.
 */
function requestSheetSwitch(id: number): void {
	resolveEditThen({ kind: 'sheetSwitch', sheet: id });
}

// Sheet-tabs (2026-06-10): the strip's interactions post to the host (which owns ALL sheet mutation).
// `switchSheet` switches the active sheet in place (via `requestSheetSwitch`, which first resolves any
// open editor -- the cross-sheet edit guard); `sheetCommand` runs add/rename/delete/move on a tab.
//
// **Codex r3 fix-verify HIGH (2026-06-10): the five MUTATING commands route through the shared chrome
// guard** (`runAfterResolvingEdit`), closing the last unguarded posting controls: previously they posted
// `sheetCommand` directly, so e.g. '+' or 'Delete' could fire while a blur-commit was still in flight
// (a tab click moves real focus, so the editor's blur posts FIRST, then the click lands mid-commit) and
// were never dropped on `errorReply`/watchdog like every other action. Wrapping at THIS seam covers all
// of sheetTabBar.ts's call sites in one place ('+' click, double-click rename, and the right-click menu's
// Rename/Delete/Move Left/Move Right -- the strip stays presentation-only and guard-free by design; see
// the `SheetTabHandlers` contract note there). Per-command effects under the guard:
//   - add/delete change the ACTIVE sheet host-side -> the resulting render takes `applyRender`'s
//     HOST-initiated sheet-change path (editor invariant, A1 reset) exactly as before; the guard's job
//     here is only that the POST never fires over an unresolved commit and drops on commit failure;
//   - a queued command can be superseded (loudly) by a later queued action -- e.g. tab-click(switch) then
//     fast double-click(rename) while a commit is pending keeps only the rename, which is the user's
//     last expressed intent (the documented last-gesture-wins of the slot);
//   - `switchTo` deliberately stays on `requestSheetSwitch` (the `sheetSwitch` deferred KIND, not
//     `chrome`): a deferred SWITCH survives a host-initiated sheet change by re-posting (the user's
//     destination stands), whereas a chrome action must drop there -- and the switch path also skips the
//     guard's viewport re-focus (a tab click moves real focus to the tab button by design).
const sheetTabHandlers: SheetTabHandlers = {
	switchTo: (id) => requestSheetSwitch(id),
	add: () => runAfterResolvingEdit('add sheet', () => vscode.postMessage({ type: 'sheetCommand', command: 'add' })),
	rename: (id) => runAfterResolvingEdit('rename sheet', () => vscode.postMessage({ type: 'sheetCommand', command: 'rename', sheet: id })),
	remove: (id) => runAfterResolvingEdit('delete sheet', () => vscode.postMessage({ type: 'sheetCommand', command: 'delete', sheet: id })),
	moveLeft: (id) => runAfterResolvingEdit('move sheet left', () => vscode.postMessage({ type: 'sheetCommand', command: 'moveLeft', sheet: id })),
	moveRight: (id) => runAfterResolvingEdit('move sheet right', () => vscode.postMessage({ type: 'sheetCommand', command: 'moveRight', sheet: id })),
};

/**
 * **Sheet-tabs** -- paint the bottom strip from a `render` payload's `sheets` + `activeSheet`. Validates
 * the shape defensively (No-Fallbacks: a malformed list is logged + the strip left untouched, never a
 * silently wrong strip). A well-formed empty list paints just the `+`. Called on every `render`.
 */
function applySheetTabs(sheetsRaw: unknown, activeRaw: unknown): void {
	if (!Array.isArray(sheetsRaw) || typeof activeRaw !== 'number') {
		if (sheetsRaw !== undefined) {
			console.warn('[sheets-webview] render payload had a malformed sheets/activeSheet; tab strip not updated.');
		}
		return;
	}
	const sheets: SheetTabInfo[] = [];
	for (const s of sheetsRaw) {
		if (s !== null && typeof s === 'object'
			&& typeof (s as { id?: unknown }).id === 'number'
			&& typeof (s as { name?: unknown }).name === 'string') {
			sheets.push({ id: (s as { id: number }).id, name: (s as { name: string }).name });
		}
	}
	renderSheetTabs(tabBarEl, sheets, activeRaw, sheetTabHandlers);
}

/** FE-11 v2: a non-negative integer grid index (a sheet id / row / col). */
function isGridIndex(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** FE-11 v2: a well-formed {@link CellAddrJson} (sheet/row/col are non-negative integers). */
function isCellAddr(c: unknown): c is CellAddrJson {
	return c !== null && typeof c === 'object'
		&& isGridIndex((c as { sheet?: unknown }).sheet)
		&& isGridIndex((c as { row?: unknown }).row)
		&& isGridIndex((c as { col?: unknown }).col);
}

/** FE-11 v2: a well-formed {@link NamedRangeTargetJson} (sheet + four bounds are non-negative integers). */
function isRangeTarget(r: unknown): r is NamedRangeTargetJson {
	return r !== null && typeof r === 'object'
		&& isGridIndex((r as { sheet?: unknown }).sheet)
		&& isGridIndex((r as { startRow?: unknown }).startRow)
		&& isGridIndex((r as { startCol?: unknown }).startCol)
		&& isGridIndex((r as { endRow?: unknown }).endRow)
		&& isGridIndex((r as { endCol?: unknown }).endCol);
}

/**
 * FE-11 v2: deep-validate ONE defined-name entry from the (untrusted) render payload. Returns the typed
 * {@link NamedRangeJson} or `undefined` if malformed. The discriminated target union is validated TO its
 * payload: a `cell`/`range` target MUST carry a well-formed coordinate object, so the pure matcher (which
 * trusts the NamedRangeJson type) can never deref a null/NaN coordinate; `constant`/`formula` need only a
 * valid kind (the dropdown lists them by name; the matcher ignores them). `scope`, if present, MUST be a
 * non-negative integer sheet id -- a malformed scope REJECTS the entry rather than coercing it to workbook
 * scope (which would mis-show a sheet-scoped name on the wrong sheet). No-Fallbacks: bad data is dropped +
 * counted, never silently reshaped.
 */
function parseDefinedName(n: unknown): NamedRangeJson | undefined {
	if (n === null || typeof n !== 'object') {
		return undefined;
	}
	const name = (n as { name?: unknown }).name;
	const target = (n as { target?: unknown }).target;
	if (typeof name !== 'string' || target === null || typeof target !== 'object') {
		return undefined;
	}
	const kind = (target as { kind?: unknown }).kind;
	let validTarget: NamedTargetJson | undefined;
	if (kind === 'cell' && isCellAddr((target as { cell?: unknown }).cell)) {
		validTarget = { kind: 'cell', cell: (target as { cell: CellAddrJson }).cell };
	} else if (kind === 'range' && isRangeTarget((target as { range?: unknown }).range)) {
		validTarget = { kind: 'range', range: (target as { range: NamedRangeTargetJson }).range };
	} else if (kind === 'constant' || kind === 'formula') {
		// No grid extent (the matcher never matches these); keep the original target for the dropdown listing.
		validTarget = target as NamedTargetJson;
	}
	if (validTarget === undefined) {
		return undefined; // unknown kind, or a cell/range with a malformed coordinate payload
	}
	const scopeRaw = (n as { scope?: unknown }).scope;
	let scope: number | undefined;
	if (scopeRaw === undefined) {
		scope = undefined;
	} else if (isGridIndex(scopeRaw)) {
		scope = scopeRaw;
	} else {
		return undefined; // a malformed scope -> reject the entry (do NOT coerce to workbook scope)
	}
	return { name, target: validTarget, scope };
}

/**
 * **FE-11 v2** -- store the workbook's defined names from a `render` payload's `names`, for the name box's
 * matched-name display + inline dropdown. Validates defensively (No-Fallbacks: a malformed entry is skipped
 * + the batch count logged, never trusted blindly -- so the pure matcher never derefs a bad payload; a
 * non-array payload leaves the prior list untouched). A well-formed empty array clears the list. Called on
 * every `render`.
 */
function applyDefinedNames(namesRaw: unknown): void {
	if (!Array.isArray(namesRaw)) {
		if (namesRaw !== undefined) {
			console.warn('[sheets-webview] render payload had a malformed names list (not an array); names not updated.');
		}
		return;
	}
	const valid: NamedRangeJson[] = [];
	let skipped = 0;
	for (const n of namesRaw) {
		const parsed = parseDefinedName(n);
		if (parsed === undefined) {
			skipped++;
			continue;
		}
		valid.push(parsed);
	}
	if (skipped > 0) {
		console.warn(`[sheets-webview] render names list had ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'}; skipped (name box not updated for them).`);
	}
	definedNames = valid;
}

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data as { type?: unknown } | null;
	if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
		return;
	}
	if (msg.type === 'render') {
		const snapshot = (msg as { snapshot?: unknown }).snapshot;
		if (!isValidSnapshot(snapshot)) {
			const detail =
				snapshot && typeof snapshot === 'object'
					? 'snapshot_format_version=' + String((snapshot as { snapshot_format_version?: unknown }).snapshot_format_version)
					: typeof snapshot;
			console.error('[sheets-webview] dropped a malformed render snapshot:', snapshot);
			showError('The host sent a cell-grid snapshot this view cannot render (' + detail + '). The grid was not updated.', 'transient');
			// Re-audit MED-3: a malformed render must not strand an in-flight commit. We can't apply the
			// snapshot, but we MUST release the editor from `pendingCommit` so Escape/blur/re-edit work
			// again (otherwise the editor is permanently uncancellable). The commit's true fate is unknown
			// -- the banner says the update was dropped; the user can re-check + re-commit.
			if (editState !== null) {
				// Re-audit #2/#3 MED: a malformed render means the grid is STALE (this snapshot was dropped),
				// unlike the watchdog case (where the valid render already arrived). CLEAR the commit token
				// UNCONDITIONALLY -- whether the commit is still pending OR was already recovered by the
				// watchdog (pendingCommit already false) -- so NO genuinely-late `commitResult`/`errorReply`
				// can auto-close the editor (which would clear this "grid was not updated" warning + mask the
				// stale grid). The editor stays open with the warning; the user re-commits (fresh commitId)
				// or Escapes. The pending-specific un-stick stays conditional on `pendingCommit`.
				editState.commitId = undefined;
				editState.submittedRawInput = undefined;
				if (editState.pendingCommit) {
					editState.pendingCommit = false;
					editState.navAfterCommit = undefined;
					// Deferred-action guard (2026-06-10): this commit's fate is unknown (the grid is stale) --
					// drop any deferred sheet switch OR chrome action rather than act on top of the warning.
					dropDeferredAction('the commit fate is unknown (malformed render)');
					editState.editEl.readOnly = false; // megaudit H1: unlock the editor we just un-stuck
					// W-G-1b (Codex MED): refocus the un-stuck editor, mirroring the watchdog + errorReply
					// recovery paths. The document keyhandler is inert while `editState !== null`, so without
					// this an editor un-stuck after a blur-commit (focus already left the input) would strand
					// the keyboard until a mouse click. Matters most for the formula bar (a bare bar gives no
					// visual "still editing" cue); also closes the same latent gap for the overlay.
					editState.editEl.focus();
					clearCommitWatchdog(); // we un-stuck manually -- the watchdog is no longer needed
				}
			}
			return;
		}
		// W-G bound-cell indicator: validate + rebuild the published-cell badges for this sheet BEFORE
		// applying the snapshot, so the same render paints both. A change in the set forces a full redraw.
		const publishedChanged = rebuildPublishedRanges((msg as { publishedCells?: unknown }).publishedCells);
		// FE-5 W-R: detect an engine STYLE-TABLE change (definition re-edit) the per-cell styleId damage term
		// cannot see -> forces a full redraw. Always `false` until the conductor threads `snapshot.styles[]`.
		const stylesChanged = stylesTableChanged(snapshot);
		// A4 (2026-06-13): the host flags a render that follows a STRUCTURAL op (insert/delete rows/cols). On a
		// structural op every cell at/after the cut shifts its A1 coordinate, but the webview's damage diff keys
		// by ABSOLUTE coordinate, so a styled cell that MOVED row 5->6 can fail to repaint with its style under
		// the partial diff. Treat it like `publishedChanged`/`stylesChanged` -> force the full-redraw path. The
		// flag is read defensively (a non-boolean from a drifting host wire is treated as `false`, not an error
		// here -- a missing flag is the genuine "non-structural render" state, matching the pre-A4 behaviour).
		const structuralChanged = (msg as { structuralChanged?: unknown }).structuralChanged === true;
		// Tables wave (2026-06-13): the host flags a render that follows a TABLE-LIST change (create/drop/move/
		// resize a table or toggle header/totals). A table change touches NO per-cell `entry`, so the damage diff
		// returns `[]` and `drawDamage([])` no-ops -- the table band/border would stay STALE until a later full
		// redraw. Treat it like `publishedChanged`/`stylesChanged`/`structuralChanged` -> force the full-redraw
		// path. Read defensively (a non-`true` value is the genuine "no table change" state, matching pre-tables
		// behaviour -- not a masked error).
		const tablesChanged = (msg as { tablesChanged?: unknown }).tablesChanged === true;
		applyRender(snapshot, publishedChanged, stylesChanged, structuralChanged, tablesChanged);
		// Sheet-tabs (2026-06-10): repaint the bottom strip from the live sheet list + active id the host
		// carries on every render. Done after applyRender so a sheet-switch render updates the grid AND the
		// active-tab highlight together.
		applySheetTabs((msg as { sheets?: unknown }).sheets, (msg as { activeSheet?: unknown }).activeSheet);
		// FE-11 v2: refresh the defined-names list (matched-name display + inline name dropdown). After
		// applyRender so the box re-evaluates against the just-applied selection/sheet; the explicit
		// updateFormulaBar() makes a names-only render (e.g. after a define, which touches no cell) update the box.
		applyDefinedNames((msg as { names?: unknown }).names);
		updateFormulaBar();
		return;
	}
	if (msg.type === 'commitResult') {
		// FE-2-0 Phase 2: the host's success ack for a tokened commit -- resolve exactly that edit.
		// Megaudit MED: require `ok === true` AND an integer commitId -- a `{ ok:false }` or NaN-id ack must
		// NOT resolve an edit as successful (it would close the editor + nav as if the write landed).
		const cr = msg as CommitResultMessage;
		// megaudit (webview-instance token, 2026-06-09) -- reload-race guard: a commitResult from a PRE-reload
		// generation carries the OLD instance id, and its numeric commitId (reset to 0 on reload) could collide
		// with a fresh edit's token -> drop it so a stale ack can't resolve/close the wrong edit. Present-but-
		// mismatched only; absent webviewId = the pre-token wire / tests, processed as before (back-compat).
		if (cr.webviewId !== undefined && cr.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (cr.ok === true && typeof cr.commitId === 'number' && Number.isInteger(cr.commitId)) {
			// Sheet-tabs cross-sheet guard (2026-06-10): a commit DETACHED by a sheet change resolves here,
			// never through the (closed) editor -- the write landed on its old sheet; nothing to show or
			// navigate (commitIds are unique per webview lifetime, so this can never shadow a live edit).
			if (detachedCommit !== null && cr.commitId === detachedCommit.commitId) {
				clearDetachedCommit();
				return;
			}
			resolvePendingCommit(cr.commitId);
		} else {
			// A malformed ack (version skew / tamper) must NOT be silently dropped -- surface it (No-Fallbacks).
			// The editor stays pending until the watchdog recovers it.
			console.warn('[sheets-webview] ignored a malformed commitResult (need ok:true + integer commitId):', cr);
		}
		return;
	}
	if (msg.type === 'cellsWritten') {
		// megaudit (webview-instance token, 2026-06-09): the host's report of the cells a SUCCESSFUL putCells
		// (paste/fill) wrote. Clear each listed cell's error tint even when stored content did not change (a
		// content-identical render would miss it). Drop the report unless it carries THIS webview's instance id
		// (a stale post-reload report carries the old id) AND the CURRENT sheet (a cross-sheet report would
		// clear the wrong sheet's tint -- errorCells is keyed row,col only). Only a SUCCESS produces this
		// message, so clearing here can never mask a failed write (No-Fallbacks).
		const cw = msg as CellsWrittenMessage;
		if (cw.webviewId !== WEBVIEW_ID || fullSnapshot === null || cw.sheet !== fullSnapshot.sheet || !Array.isArray(cw.cells)) {
			return;
		}
		let cleared = false;
		for (const cell of cw.cells) {
			if (cell && typeof cell.row === 'number' && typeof cell.col === 'number' && errorCells.delete(cell.row + ',' + cell.col)) {
				cleared = true;
			}
		}
		if (cleared) {
			redraw();
		}
		return;
	}
	if (msg.type === 'validateFormulaResult') {
		// W2 formula intelligence: the host's reply to a debounced validateFormula. Drop a stale reply (a
		// later keystroke already superseded it -> its reqId != the latest we sent) or a reply from a PRE-
		// reload generation (webviewId mismatch) so an outdated diagnostic can't flash. Present-but-mismatched
		// webviewId only; absent = pre-token wire / tests.
		const vr = msg as {
			reqId?: unknown; ok?: unknown; diagnostics?: unknown; error?: unknown; webviewId?: unknown;
		};
		if (typeof vr.webviewId === 'string' && vr.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (typeof vr.reqId !== 'number' || vr.reqId !== latestValidateReqId) {
			return; // a superseded (stale) validate -- the user kept typing
		}
		// Codex MED: pass `diagnostics` RAW (unknown) so applyValidationResult can No-Fallbacks-reject an
		// `ok:true` reply that lacks a real array (rather than this pre-coercing a bad value to []/valid).
		applyValidationResult(
			vr.ok === true,
			vr.diagnostics,
			typeof vr.error === 'string' ? vr.error : undefined,
		);
		return;
	}
	if (msg.type === 'functionList') {
		// W2 formula intelligence: the host's reply with the function catalog for completions. Drop a stale /
		// pre-reload reply. On `ok:false` (the engine threw), leave the catalog null so no dropdown ever opens
		// (No-Fallbacks: no fabricated list); surface the reason on the console.
		const fl = msg as {
			reqId?: unknown; ok?: unknown; functions?: unknown; error?: unknown; webviewId?: unknown;
		};
		if (typeof fl.webviewId === 'string' && fl.webviewId !== WEBVIEW_ID) {
			return;
		}
		if (typeof fl.reqId !== 'number' || fl.reqId !== latestFuncReqId) {
			return;
		}
		if (fl.ok !== true || !Array.isArray(fl.functions)) {
			console.warn('[sheets-webview] listFunctions failed; completions disabled:', fl.error);
			// Allow a future re-request (e.g. the next time the bar is focused) by re-arming the flag.
			functionListRequested = false;
			return;
		}
		const metas = fl.functions as FunctionMetadataJson[];
		// Build the lean completion list + the by-name metadata map for the signature hint. Defensive: skip a
		// malformed entry rather than throw on the whole catalog.
		const catalog: CompletionFunction[] = [];
		const byName = new Map<string, FunctionMetadataJson>();
		const wellFormed: { meta: FunctionMetadataJson; aliases: string[] }[] = [];
		for (const meta of metas) {
			if (meta === null || typeof meta !== 'object' || typeof meta.canonicalName !== 'string' || meta.canonicalName.length === 0) {
				continue;
			}
			const aliases = Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === 'string') : [];
			catalog.push({
				canonicalName: meta.canonicalName,
				displayName: typeof meta.displayName === 'string' ? meta.displayName : undefined,
				aliases,
			});
			wellFormed.push({ meta, aliases });
		}
		// **Codex LOW fold**: index canonical names FIRST (a canonical name always wins), THEN aliases (so the
		// signature hint resolves when a completion inserted an alias, e.g. `AVG(` -> AVERAGE's signature).
		// Two-pass so a canonical name that collides with another function's alias is never shadowed; an
		// alias-vs-alias collision is first-wins (deterministic given the engine sorts ascending by name).
		for (const { meta } of wellFormed) {
			byName.set(meta.canonicalName.toUpperCase(), meta);
		}
		for (const { meta, aliases } of wellFormed) {
			for (const alias of aliases) {
				const key = alias.toUpperCase();
				if (!byName.has(key)) {
					byName.set(key, meta);
				}
			}
		}
		functionCatalog = catalog;
		functionMetaByName = byName;
		// If the bar is already editing, refresh the affordances now that the catalog is live (the user may
		// have typed a prefix before the catalog arrived).
		if (formulaBarIsEditing()) {
			updateCompletion(false);
			updateSignatureHint();
		}
		return;
	}
	if (msg.type === 'errorReply') {
		const er = msg as ErrorReplyMessage;
		// megaudit (webview-instance token, 2026-06-09) -- reload-race guard: a stale PRE-reload errorReply
		// carries the OLD instance id; its commitId (reset on reload) could un-stick a fresh edit, and its
		// (sheet,row,col) could tint a live cell. Drop it before BOTH the tint and the un-stick below.
		// Present-but-mismatched only; absent = the pre-token wire / tests (processed as before).
		if (er.webviewId !== undefined && er.webviewId !== WEBVIEW_ID) {
			return;
		}
		// Sheet-tabs cross-sheet guard (2026-06-10): a commit DETACHED by a sheet change FAILED. Its editor
		// is closed and its cell is on the OLD sheet (the tint below is sheet-guarded and would skip it),
		// so without this branch the rejection would be SILENT (No-Fallbacks). Report it LOUDLY; the value
		// was not saved and cannot be re-opened for correction across the sheet boundary.
		if (detachedCommit !== null && typeof er.commitId === 'number' && er.commitId === detachedCommit.commitId) {
			showError(
				'The edit to ' + describeDetachedTarget(detachedCommit) +
				' (submitted before the sheet switched) was rejected and NOT saved -- [' +
				String(er.code) + '] ' + String(er.message) + '. Switch back to re-enter it.',
				'transient',
			);
			clearDetachedCommit();
			return; // fully handled -- this reply belongs to the closed (detached) editor
		}
		const prevErrorKeys = new Set(errorCells.keys()); // Phase 3: for the error-tint flip diff
		let activeMoved = false; // re-audit LOW: a selection realign below needs a FULL redraw, not a tint-flip damage
		// Megaudit MED + re-audit LOW: only tint when sheet/row/col are REAL integers (NOT `Number()`-coerced
		// -- `''`/`null` would coerce to 0 and wrongly tint A1) AND the sheet is the CURRENT one AND the coord
		// is in the A1 extent. A stale/cross-sheet/malformed reply must never tint. The un-stick below is
		// independent of whether we tint (it keys only on commitId).
		const tintable =
			fullSnapshot !== null &&
			typeof er.sheet === 'number' && er.sheet === fullSnapshot.sheet &&
			typeof er.row === 'number' && typeof er.col === 'number' &&
			isInExtent(er.row, er.col);
		if (tintable) {
			errorCells.set(er.row + ',' + er.col, '[' + String(er.code) + '] ' + String(er.message));
		}
		// FE-2-0 Phase 2: un-stick the in-flight edit ONLY when the reply's commitId matches THIS edit's
		// token (replaces the M8 (sheet,row,col) match -- a unique token can't collide). The matched edit
		// stays OPEN for correction + re-commit; the cell is decorated above regardless of the match.
		// Match the normal in-flight case (pendingCommit) OR a genuinely-LATE failure after the watchdog
		// recovered the edit, but ONLY if the user hasn't edited since submit (re-audit #2 LOW -- mirrors
		// the success-ack guard in resolvePendingCommit). A late error on an edited value just tints; an
		// edit recovered via a MALFORMED render cleared its commitId above, so it won't match here either.
		if (
			editState !== null &&
			typeof er.commitId === 'number' &&
			editState.commitId === er.commitId &&
			(editState.pendingCommit || editState.editEl.value === editState.submittedRawInput)
		) {
			editState.pendingCommit = false;
			editState.navAfterCommit = undefined; // the commit failed -- do not advance the selection
			// Deferred-action guard (2026-06-10): the commit this action was deferred behind FAILED and the
			// editor reopens below for correction -- a sheet switch would orphan it onto the wrong sheet,
			// and a chrome action must NEVER run on top of a rejected commit. Drop it (the rejection
			// banner below explains; the user can re-click the tab / re-issue the action).
			dropDeferredAction('the commit was rejected (errorReply)');
			editState.lastFailedRawInput = editState.editEl.value; // megaudit B2: a nav key may now leave the bad cell
			editState.editEl.readOnly = false; // H1: unlock for correction
			clearCommitWatchdog(); // the host responded (with a failure) -- no recovery needed
			// **Audit LOW (2026-06-05)**: realign the selection with the editor demanding attention. A
			// blur-commit can fail AFTER a click moved `active` to another cell -- without this, the editor
			// refocuses on the failed cell while the selection box paints the clicked one (keyboard edits would
			// apply to the editor's cell, not the painted selection). Put `active` back on the edited cell.
			// re-audit LOW: if this actually MOVES the selection, the tint-flip damage path below is
			// insufficient (it wouldn't clear the old selection box / draw the new one), so force a full redraw.
			if (active === null || active.row !== editState.row || active.col !== editState.col) {
				activeMoved = true;
			}
			// W-G-2a: this is a single-cell realign onto the failed edit cell; clear any anchor a shift-click
			// set while the commit was pending, else it would resurrect as a range on the redraw below
			// (Codex W-G-2a re-audit LOW). Edits are single-cell, so collapsing here is always correct.
			// Codex re-audit #3: clearing the anchor REMOVES a painted range -- but the row-only `drawDamage`
			// fast path below clips to the error rows and can't erase range fill on other rows. So if a range
			// was visible, force the full-redraw path (treat it like an `activeMoved`).
			if (currentSelection() !== null) {
				activeMoved = true;
			}
			anchor = null;
			active = { row: editState.row, col: editState.col };
			ensureActiveVisible();
			updateEditClip(); // megaudit LOW: ensureActiveVisible may have scrolled -- re-clip the still-open editor
			// Megaudit B2: refocus + select so a retype REPLACES the bad value, and surface the way out
			// (the user reflexively tries arrows/Tab -- those now leave the cell; spell it out anyway).
			editState.editEl.focus();
			editState.editEl.select();
			showError(
				'Cell rejected -- [' + String(er.code) + '] ' + String(er.message) +
				'. Fix it and press Enter, or press Esc / an arrow key to discard.',
				'edit',
			);
		}
		// **FE-2-0 Phase 3 / FE-2 BAKEOFF** -- damage only the rows whose error tint FLIPPED (the rare
		// failed-edit path), at the same scroll; else a full `redraw()`. Re-erroring an already-tinted cell
		// flips nothing -> [] -> a no-op (the tint + the tooltip-on-hover are already correct). The gate +
		// the `errorRowsFlippedA1` diff live in the orchestrator now; `activeMoved` (the selection-realign
		// decision, computed above from this file's edit/selection state) forces the full path.
		orchestrator.commitErrorDamage(prevErrorKeys, activeMoved);
		return;
	}
	if (msg.type === 'freeze') {
		// **W3 frozen panes** -- the host's "Freeze Panes at Selection" / "Unfreeze" command. Set the pinned
		// row/col counts and FULL-redraw (the geometry changed; the damage/blit fast paths assume a stable
		// freeze). `renderer.setFrozen` CLAMPS to sane integers in `[0, MAX-1]` (defence in depth at the trust
		// boundary). **Codex MED-1 (No-Fallbacks)**: a MALFORMED envelope (rows/cols not finite numbers) is a
		// host/webview WIRING bug, not a freeze of 0 -- so surface it LOUD and leave the CURRENT freeze state
		// UNCHANGED rather than silently unfreezing (which would mask the bug + lose the user's freeze).
		// **Codex MED-4**: require non-negative INTEGERS, not merely finite numbers. The host always sends
		// `Math.floor`-ed counts, so a fractional value (e.g. 1.5) is a wiring bug -- `clampFrozenCount` would
		// silently coerce it to 0 (a stealth unfreeze). Reject it LOUD + leave the freeze unchanged, same as
		// a non-finite value (No-Fallbacks: surface the bad wire, don't mask it as "freeze 0").
		const fz = msg as { rows?: unknown; cols?: unknown };
		if (
			typeof fz.rows !== 'number' || !Number.isInteger(fz.rows) || fz.rows < 0 ||
			typeof fz.cols !== 'number' || !Number.isInteger(fz.cols) || fz.cols < 0
		) {
			console.warn('[sheets-webview] dropped a malformed freeze message (rows/cols must be non-negative integers):', msg);
			showError('The host sent a malformed Freeze Panes command; the freeze was not changed.', 'transient');
			return;
		}
		renderer.setFrozen(fz.rows, fz.cols);
		// A freeze shifts every cell's pane, so an open overlay editor must be re-pinned + its clip recomputed
		// (a frozen cell's editor pins; a cell now under a frozen band clips there). repositionEdit handles both.
		repositionEdit();
		redraw();
		return;
	}
	if (msg.type === 'contextMenuAction') {
		// W3 (Wave 3): the native context menu's clipboard items (Cut/Copy/Paste/Clear Contents) run host
		// commands that post this down to the focused panel's webview, where the clipboard state lives. Route
		// to the SAME functions as the keyboard shortcuts. A malformed action is dropped loud (No-Fallbacks).
		const action = (msg as { action?: unknown }).action;
		if (action === 'cut' || action === 'copy' || action === 'paste' || action === 'clear') {
			// Codex r3 fix-verify BLOCKER (defense-in-depth half): route the reply through the shared chrome
			// guard, labelled like every other chrome action. The contextmenu handler above already ensures
			// the menu only OPENS over a resolved editor -- but this reply arrives ASYNC (menu click -> host
			// command -> postMessage), and an editor can re-open in the gap (the native menu does not trap
			// the webview's keyboard state machine), so the write paths behind paste/clear must not trust
			// that gap. The guard resolves any such editor first, queues the action behind an in-flight
			// commit, and drops it on commit failure -- identical semantics to the toolbar/menubar items.
			runAfterResolvingEdit('context menu "' + action + '"', () => runContextMenuAction(action));
		} else {
			console.warn('[sheets-webview] ignored contextMenuAction with a bad action:', action);
		}
		return;
	}
	if (msg.type === 'navigateTo') {
		// **FE-5 W-F (2026-06-12) -- host->webview "select + reveal cell" handler.**
		//
		// WIRE SHAPE: `{ type: 'navigateTo', row: number, col: number }` -- 0-based grid coordinates on the
		// CURRENTLY-ACTIVE sheet (the host switches the sheet via a normal `render` BEFORE posting this when
		// the target is on another sheet; this handler does NOT switch sheets). Selects the single cell at
		// (row, col), clears any range anchor, scrolls it into view, and repaints -- the absolute-landing nav
		// identical to a Ctrl+Home/End jump, surfaced as a message.
		//
		// **REUSABLE CONTRACT (downstream):** the FE-5 Name Manager's "Go-To" reuses THIS exact message to
		// jump to a named range's anchor cell. Keep it a clean select-and-reveal of a single (row, col); do NOT
		// special-case find vs name-manager here. Coordinates are validated at the trust boundary (finite
		// non-negative integers in the Excel extent) and DROPPED loud on a violation (No-Fallbacks: a bad
		// coordinate must not silently land on A1 via a `Number()` coercion).
		//
		// **Edit-race guard (preserve the FE-4 invariant):** route through `runAfterResolvingEdit` so an open
		// editor is resolved (cancel-if-unchanged / commit-and-queue) BEFORE the selection jumps out from under
		// it -- exactly like `stepFind` and every other chrome action. With no editor this runs synchronously.
		const nav = msg as { row?: unknown; col?: unknown };
		if (
			typeof nav.row !== 'number' || !Number.isInteger(nav.row) || nav.row < 0 || nav.row >= MAX_ROWS ||
			typeof nav.col !== 'number' || !Number.isInteger(nav.col) || nav.col < 0 || nav.col >= MAX_COLS
		) {
			console.warn('[sheets-webview] dropped a malformed navigateTo (row/col must be in-extent integers):', msg);
			return;
		}
		const targetRow = nav.row;
		const targetCol = nav.col;
		runAfterResolvingEdit('navigate to cell', () => {
			jumpActive(targetRow, targetCol);
			// Keep the host + formula bar in sync with the landed selection (a host-driven nav is a real
			// selection change the host should hear back, deduped by `postSelectionIfChanged`).
			updateFormulaBar();
			postSelectionIfChanged();
			viewportEl.focus(); // return keyboard focus to the grid so arrow-nav continues from the landing
		});
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

// **Megaudit B1**: pin the canvas to the viewport SYNCHRONOUSLY on every scroll event. The canvas is an
// absolutely-positioned child of the scroller, so it scrolls natively with the content; the compensating
// `translate(scrollLeft, scrollTop)` MUST be written in the scroll event, not deferred to the rAF -- else
// the sticky header/gutter (painted at canvas-local 0) lag the native scroll by up to one frame and visibly
// shake. The expensive blit/redraw stays rAF-coalesced via scheduleRedraw (the body's <=1-frame latency is
// imperceptible; a jittering sticky band is not). The content-anchored `<input>` scrolls with the content,
// so {@link updateEditClip} is called SYNCHRONOUSLY below (FE-2-0 polish 2026-06-05, resolving the former
// MED-5) to clip the open editor to the body pane as it scrolls under the sticky header/gutter bands.
viewportEl.addEventListener('scroll', () => {
	applyCanvasTransform(viewportEl.scrollTop, viewportEl.scrollLeft);
	// FE-2-0 polish: keep the open editor's body-pane clip in lockstep with the scroll (SYNCHRONOUSLY, like
	// the canvas pin above) so the editor never momentarily slides un-clipped over the sticky bands.
	// W3 frozen panes (Codex HIGH-2): repositionEdit re-PINS a frozen-cell editor as the body scrolls (it adds
	// back the live frozen-axis scroll); for a body-cell editor it writes the same content position (a no-op)
	// and re-clips. So this both pins the frozen case and keeps the body-pane clip in lockstep.
	if (editState !== null) {
		repositionEdit();
	}
	scheduleRedraw();
});

// Repaint on viewport resize. Megaudit (Opus-1): route through the SAME coalescing scheduler as scroll so a
// simultaneous resize+scroll is ONE rAF, not two competing repaints. `scrollRedraw` resize()s first and
// falls back to a full draw whenever the backing store changed (it does on a real resize), so a pure resize
// still fully repaints; a same-size "resize" with no scroll delta cleanly no-ops to a full draw.
if (typeof ResizeObserver !== 'undefined') {
	new ResizeObserver(() => scheduleRedraw()).observe(viewportEl);
}

// Full redraw on theme change: refresh the cached palette/fonts/gutter, reposition an open editor (the
// gutter width may have changed -> every cell's x shifts, Audit LOW-7), re-size the spacer, repaint.
new MutationObserver(() => {
	renderer.refreshTheme();
	repositionEdit();
	updateSpacer();
	redraw();
	// Audit re-audit LOW: watch the theme-id/kind attributes too, not just `class`. VS Code switches
	// between themes of the SAME kind (e.g. Dark+ -> another dark theme) by changing `data-vscode-theme-id`
	// + the CSS vars WITHOUT changing the `vscode-dark` body class; a `class`-only observer would miss it
	// and (now that applyRender no longer refreshes per render) leave the palette/fonts stale.
}).observe(document.body, {
	attributes: true,
	attributeFilter: ['class', 'data-vscode-theme-id', 'data-vscode-theme-kind', 'data-vscode-theme-name'],
});

// Initial spacer sizing (before the first render).
updateSpacer();

// Handshake: announce the channel is live so the host (re)sends the snapshot. W3 (Codex HIGH-2): carry
// this webview's instance token so the host can map `panelToken -> CellGridPanel` and route a context-menu
// command to the EXACT panel that raised the menu (not merely the focused one). Re-sent on every reload
// (WEBVIEW_ID is regenerated per load), so the host's map always reflects the live token.
vscode.postMessage({ type: 'webviewReady', webviewId: WEBVIEW_ID });
