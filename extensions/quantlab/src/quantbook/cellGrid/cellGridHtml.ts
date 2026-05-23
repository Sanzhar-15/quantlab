/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.2.a scaffold (2026-05-22) -- pure HTML-building
 * functions for the cell-grid webview.
 *
 * Phase 5.7 V3.2.b.2 (2026-05-22) -- extended to support a nonced
 * inline script for click-to-edit cell flow. Backwards-compatible: when
 * called WITHOUT the `nonce` option (e.g. the V3.2.a HTML-rendering
 * mocha tests), the output is identical to the V3.2.a static version
 * (no script tag, narrow CSP).
 *
 * Split from `cellGridPanel.ts` so unit tests can import + exercise
 * these without pulling the `vscode` module (which is host-only and
 * would force every test file to install the vscode shim).
 *
 * Pure functions only -- no `this`, no side effects, no `vscode`
 * import. The host-side panel logic lives in `cellGridPanel.ts`.
 */

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../types';

/**
 * V3.2.b.2 (2026-05-22): optional render options.
 *
 * - `nonce`: when provided, the rendered HTML widens its CSP to allow
 *   an inline `<script nonce="...">` and embeds the V3.2.b cell-edit
 *   script. Per V3.2.b.1 plan decision B2: 32-char alphanumeric,
 *   regenerated each `render()` call by the host.
 *
 * When `nonce` is OMITTED, the HTML stays at V3.2.a's static-table
 * shape with the narrow `default-src 'none'; style-src 'unsafe-inline'`
 * CSP. This preserves the V3.2.a contract for any caller that wants
 * read-only rendering (e.g. test fixtures, future preview surfaces).
 */
export interface CellGridHtmlOptions {
	readonly nonce?: string;
}

/**
 * Build the webview HTML for a cell-snapshot.
 *
 * **CSP** (V3.2.a baseline): `default-src 'none'; style-src 'unsafe-inline'`.
 * Inline styles are required for VS Code theme colour variables.
 *
 * **CSP** (V3.2.b.2 with `options.nonce` set): widens to add
 * `script-src 'nonce-${nonce}'`. The nonce-scoped `<script>` carries
 * the click-to-edit logic + message-channel wiring.
 *
 * **Sanity**: the same nonce value is used in BOTH the CSP header AND
 * the `<script nonce="...">` attribute. The browser/webview rejects the
 * script if the values diverge; this function guarantees they're the
 * same by reading from a single local.
 */
export function buildHtml(
	snapshot: QuantbookCellSnapshot,
	options: CellGridHtmlOptions = {},
): string {
	const nonce = options.nonce;
	// V3.3.0.4: virtualization scaffold.  Render only the first
	// VIRT_INITIAL_ROWS entries server-side + inline the FULL snapshot
	// as JSON in a `<script type="application/json">` data block.
	// The webview's scroll handler reads the JSON + re-renders the
	// visible subset on scroll.  Non-nonce path (V3.2.a read-only)
	// still renders ALL rows (no scroll handler exists there).
	//
	// VIRT_INITIAL_ROWS is the initial visible-row count baked into
	// the server-side HTML.  Picked to cover typical viewport
	// (80vh / 25px ~= 25-30 rows) + overscan (5 rows).  Webview
	// adjusts immediately on first scroll-event to actual
	// `viewport.clientHeight`.
	const VIRT_INITIAL_ROWS = 40;
	const VIRT_ROW_HEIGHT_PX = 25;
	const isVirtualized = nonce !== undefined && snapshot.entries.length > VIRT_INITIAL_ROWS;
	const visibleEntries = isVirtualized
		? snapshot.entries.slice(0, VIRT_INITIAL_ROWS)
		: snapshot.entries;
	const rows = renderRows(visibleEntries, nonce !== undefined);
	const meta = `snapshot_format_version=${snapshot.snapshot_format_version}; entries=${snapshot.entries.length}${isVirtualized ? ` (virtualized; initial window ${VIRT_INITIAL_ROWS})` : ''}`;
	// V3.3.0.4: spacer rows preserve scroll geometry of the FULL
	// table.  Top spacer = startIdx * rowHeight (0 on initial paint
	// since we start at index 0).  Bottom spacer = (totalRows -
	// endIdx) * rowHeight.  As the user scrolls, the webview script
	// updates BOTH spacer heights + replaces the middle row group.
	const topSpacerHeight = 0;
	const bottomSpacerHeight = isVirtualized
		? (snapshot.entries.length - VIRT_INITIAL_ROWS) * VIRT_ROW_HEIGHT_PX
		: 0;
	const spacerTopRow = `<tr class="cell-grid-spacer-top" data-spacer-height="${topSpacerHeight}" style="height: ${topSpacerHeight}px;"><td colspan="3" aria-hidden="true"></td></tr>`;
	const spacerBottomRow = `<tr class="cell-grid-spacer-bottom" data-spacer-height="${bottomSpacerHeight}" style="height: ${bottomSpacerHeight}px;"><td colspan="3" aria-hidden="true"></td></tr>`;
	const tableBody = snapshot.entries.length === 0
		? '<div class="empty">(empty -- no PutValue ops on this sheet)</div>'
		: `<div class="cell-grid-viewport"><table><thead><tr><th>Row</th><th>Col</th><th>Value</th></tr></thead><tbody data-virt-row-height="${VIRT_ROW_HEIGHT_PX}" data-virt-total-rows="${snapshot.entries.length}">${spacerTopRow}${rows}${spacerBottomRow}</tbody></table></div>`;
	// V3.3.0.4: inline the full snapshot as JSON so the webview can
	// re-render rows on scroll without a host round-trip.  Wrapped in
	// a `<script type="application/json">` block which the browser
	// does NOT execute (CSP `script-src 'nonce-...'` blocks unnonced
	// scripts; this one carries no nonce + non-JS type).  The webview
	// script reads it via `document.getElementById('cell-grid-data').textContent`.
	//
	// Only emitted when nonce is provided (V3.2.b/c mode).  V3.2.a
	// read-only path renders all rows directly + no script accesses
	// the data block.
	//
	// HTML-escapes any "</" sequence in the JSON to avoid premature
	// script-tag termination if cell text contains literal
	// `</script>`.  serde_json::to_string already escapes "/" but we
	// belt-and-suspenders here.
	const snapshotJsonRaw = JSON.stringify(snapshot);
	const snapshotJsonSafe = snapshotJsonRaw.replace(/<\/(script)/gi, '<\\/$1');
	const snapshotDataBlock = nonce !== undefined
		? `<script id="cell-grid-data" type="application/json">${snapshotJsonSafe}</script>`
		: '';
	const body = tableBody;
	// CSS is built from an array of per-rule strings. Each array entry
	// is a TS string on a tab-indented source line (hygiene-compliant),
	// concatenated with `\n` so the rendered HTML has one CSS rule per
	// line for readability. V3.2.c may move the CSS to an
	// asWebviewUri-loaded `.css` file when remote-op propagation lands +
	// the inline stylesheet starts to grow.
	//
	// V3.2.b.2 adds the `.cell-edit-error` decoration (red border +
	// background tint, theme-aware) and the `.cell-value` cursor hint
	// to signal click-to-edit affordance. These rules are NO-OPS when
	// the nonce option is omitted (no script attaches the click handler
	// in that path).
	const css = [
		'body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }',
		'h2 { margin-top: 0; }',
		'table { border-collapse: collapse; width: auto; }',
		'th, td { padding: 4px 12px; border: 1px solid var(--vscode-panel-border); text-align: left; }',
		'th { background: var(--vscode-toolbar-hoverBackground); font-weight: 600; }',
		'.meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }',
		'.empty { color: var(--vscode-descriptionForeground); font-style: italic; }',
		'.kind { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 8px; }',
		'.cell-value { cursor: cell; }',
		'.cell-value.cell-edit-error { border: 2px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }',
		'.cell-edit-input { width: 8em; font-family: var(--vscode-editor-font-family); font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder); padding: 2px 4px; box-sizing: border-box; }',
		// V3.3.0.4 virtualization geometry:
		'.cell-grid-viewport { max-height: 80vh; overflow-y: auto; border: 1px solid var(--vscode-panel-border); }',
		'.cell-grid-viewport thead th { position: sticky; top: 0; z-index: 1; }',
		'.cell-grid-spacer-top, .cell-grid-spacer-bottom { padding: 0; border: none; }',
		'.cell-grid-spacer-top td, .cell-grid-spacer-bottom td { padding: 0; border: none; }',
	].join('\n');
	// CSP: narrow by default; widen `script-src` only when a nonce was
	// passed in (V3.2.b.2). The CSP string never substitutes user-
	// controlled content -- only the nonce, which is alphanumeric per
	// `buildPanelNonce` in cellGridPanel.ts.
	const cspParts = ['default-src \'none\'', 'style-src \'unsafe-inline\''];
	if (nonce !== undefined) {
		cspParts.push(`script-src 'nonce-${nonce}'`);
	}
	const csp = cspParts.join('; ') + ';';
	const scriptTag = nonce !== undefined
		? `<script nonce="${nonce}">${buildClientScript(snapshot.sheet)}</script>`
		: '';
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Quantbook Cell Grid</title>
<style>${css}</style>
</head>
<body>
<h2>Quantbook Cell Grid -- Sheet ${escapeHtml(String(snapshot.sheet))}</h2>
<div class="meta">${escapeHtml(meta)}</div>
${body}
${snapshotDataBlock}
${scriptTag}
</body>
</html>`;
}

function renderRows(
	entries: QuantbookCellSnapshot['entries'],
	editable: boolean,
): string {
	return entries
		.map(e => {
			const valueStr = formatCellValue(e.value);
			// V3.2.b.2: cells gain `data-row` / `data-col` attributes when
			// editable so the client script can identify which cell was
			// clicked. The `.cell-value` class is the hit-test target.
			//
			// `data-sheet` is NOT added here -- it's a panel-level
			// constant (one panel = one sheet) baked into the script's
			// `SHEET` const, so emitting it per-cell would be redundant
			// + a drift surface.
			//
			// `data-original-text` captures the rendered display text so
			// the Escape-cancel path can restore it without consulting
			// the snapshot (which the client doesn't hold a copy of).
			// V3.3.0.X audit closure (LOW-1, 2026-05-23, convergent
			// Codex L3 + Opus L1): defense-in-depth coerce row/col
			// to Number().  Engine-typed `e.row` / `e.col` are
			// already u32 integers per the V3.2.a JSON shape, but
			// the literal claim in the V3.3.0.X audit was "all
			// attribute values are escaped" -- making that claim
			// true.  `Number(non-numeric)` returns NaN, which
			// interpolates as `"NaN"` (a valid CSS-selector +
			// HTML-attribute value with no XSS surface).
			const rowSafe = Number(e.row);
			const colSafe = Number(e.col);
			const dataAttrs = editable
				? ` data-row="${rowSafe}" data-col="${colSafe}" data-original-text="${escapeHtml(valueStr)}" data-original-kind="${escapeHtml(e.value.kind)}"`
				: '';
			const cellClass = editable ? 'cell-value' : '';
			return `<tr><td>${rowSafe}</td><td>${colSafe}</td><td class="${cellClass}"${dataAttrs}>${escapeHtml(valueStr)}<span class="kind">[${escapeHtml(e.value.kind)}]</span></td></tr>`;
		})
		.join('');
}

/**
 * Render a cell value for display. Type-narrowed via the
 * {@link QuantbookCellValue} tagged-union; the `switch` is
 * exhaustive (TS infers `never` in any unreachable branch as a
 * compile-time correctness pin).
 */
export function formatCellValue(value: QuantbookCellValue): string {
	switch (value.kind) {
		case 'number':
			return String(value.value);
		case 'boolean':
			return value.value ? 'TRUE' : 'FALSE';
		case 'text':
			return value.value;
		case 'error':
			return value.value;
		case 'pending':
			return '(pending)';
	}
}

/**
 * Build the inline client script body that runs INSIDE the webview.
 *
 * V3.2.b.2: this script implements:
 *   - Click on `.cell-value` -> replace text with `<input>` containing
 *     the current value; focus it; select the text.
 *   - Enter on the input -> postMessage `{type:'putValue', sheet, row,
 *     col, rawInput}`. Input stays in place (pessimistic; waits for
 *     `refresh` re-render from host).
 *   - Escape on the input -> remove input, restore original text.
 *   - Blur on the input -> same as Escape (conservative: blur cancels;
 *     user must explicitly Enter to commit. Avoids accidental commits
 *     when clicking elsewhere on the grid).
 *   - Incoming `errorReply` -> add `.cell-edit-error` class to the
 *     target cell + set `title="[code] message"`. Keeps the input in
 *     place for user correction.
 *   - Incoming `refresh` -> no-op at the script level. The host
 *     re-renders the entire HTML via `webview.html = ...`, which blows
 *     away THIS script + state and starts fresh.
 *   - Unknown incoming type -> console.warn (visible in webview
 *     devtools) + ignore. Per V3.2.b.1 B1.
 *
 * The script is returned as a string literal embedded into the HTML
 * template; the host wraps it in `<script nonce="${nonce}">...</script>`.
 *
 * `sheetForClient` is baked in as the script's `SHEET` constant so the
 * webview never has to ask the host for the sheet number -- one panel
 * = one sheet.
 *
 * **DO NOT** use ES6 template literals inside this string -- the outer
 * template literal will swallow them. ASCII string concatenation only.
 *
 * **V3.3.0.4 + V3.3.0.X drift hazard (2026-05-22)**: the client script
 * includes `formatCellValueClient` + `renderRowsClient`, which are
 * MIRRORS of the server-side `formatCellValue` (line 212) +
 * `renderRows` (line 152) helpers.  The mirrors exist because the
 * inline webview script cannot import modules.  Any future change to
 * the server-side formatter MUST also update the client mirror:
 *   - V3.x backlog (V3.2.d Opus MEDIUM-3) routes non-finite numbers
 *     to `'#NUM!'`; the client mirror must match.
 *   - V3.x text/boolean/error append paths must mirror the
 *     server-side display string.
 *   - V3.x escaping changes (e.g., RTL-override stripping) must mirror.
 * The drift surface is silent: client + server disagreement produces
 * cells that LOOK right on initial paint but change on scroll, or vice
 * versa.  V3.x can close this by code-generating the client mirror
 * from the server formatter via a build step OR by passing the
 * pre-formatted value through the snapshot data block instead of
 * re-formatting client-side.
 */
function buildClientScript(sheetForClient: number): string {
	// `sheetForClient` is interpolated via `String()` to coerce to its
	// numeric literal -- can't be a user-controlled value at this
	// layer (the caller passed a u16 from a typed snapshot) but the
	// explicit String() makes the intent obvious.
	const sheetLit = String(Math.floor(sheetForClient));
	return [
		'(function () {',
		'  var vscode = acquireVsCodeApi();',
		'  var SHEET = ' + sheetLit + ';',
		'  var activeInput = null;',
		'  var activeCell = null;',
		'',
		'  function endEdit(commit) {',
		'    if (activeInput === null || activeCell === null) { return; }',
		'    var cell = activeCell;',
		'    var input = activeInput;',
		'    var raw = input.value;',
		'    activeInput = null;',
		'    activeCell = null;',
		'    if (commit) {',
		'      // Pessimistic: leave input in place + post to host. Host',
		'      // will either rebuild the entire HTML (refresh path) or',
		'      // send errorReply (failure path).  Keep both `cell` and',
		'      // `input` references so errorReply can decorate the cell',
		'      // without needing to re-query the DOM.',
		'      activeInput = input;',
		'      activeCell = cell;',
		'      vscode.postMessage({',
		'        type: \'putValue\',',
		'        sheet: SHEET,',
		'        row: Number(cell.getAttribute(\'data-row\')),',
		'        col: Number(cell.getAttribute(\'data-col\')),',
		'        rawInput: raw',
		'      });',
		'      return;',
		'    }',
		'    // Cancel path (Escape / blur): restore the cell\'s prior',
		'    // text + kind annotation.',
		'    cell.innerHTML = \'\';',
		'    cell.appendChild(document.createTextNode(cell.getAttribute(\'data-original-text\') || \'\'));',
		'    var kindSpan = document.createElement(\'span\');',
		'    kindSpan.className = \'kind\';',
		'    kindSpan.appendChild(document.createTextNode(\'[\' + (cell.getAttribute(\'data-original-kind\') || \'\') + \']\'));',
		'    cell.appendChild(kindSpan);',
		'    cell.classList.remove(\'cell-edit-error\');',
		'    cell.removeAttribute(\'title\');',
		'  }',
		'',
		'  function beginEdit(cell) {',
		'    if (activeInput !== null) { endEdit(false); }',
		'    var originalText = cell.getAttribute(\'data-original-text\') || \'\';',
		'    var input = document.createElement(\'input\');',
		'    input.type = \'text\';',
		'    input.className = \'cell-edit-input\';',
		'    input.value = originalText;',
		'    input.setAttribute(\'aria-label\', \'Edit cell value\');',
		'    cell.innerHTML = \'\';',
		'    cell.appendChild(input);',
		'    cell.classList.remove(\'cell-edit-error\');',
		'    cell.removeAttribute(\'title\');',
		'    activeInput = input;',
		'    activeCell = cell;',
		'    input.addEventListener(\'keydown\', function (ev) {',
		'      if (ev.key === \'Enter\') {',
		'        ev.preventDefault();',
		'        endEdit(true);',
		'      } else if (ev.key === \'Escape\') {',
		'        ev.preventDefault();',
		'        endEdit(false);',
		'      }',
		'    });',
		'    input.addEventListener(\'blur\', function () {',
		'      // Conservative: blur cancels.  Enter explicitly commits.',
		'      // Without this, clicking outside the grid would commit',
		'      // stale text + surprise the user.',
		'      if (activeInput === input) { endEdit(false); }',
		'    });',
		'    input.focus();',
		'    input.select();',
		'  }',
		'',
		'  document.addEventListener(\'click\', function (ev) {',
		'    var target = ev.target;',
		'    while (target && target !== document.body) {',
		'      if (target.classList && target.classList.contains(\'cell-value\') && target.getAttribute(\'data-row\') !== null) {',
		'        if (activeCell !== target) {',
		'          beginEdit(target);',
		'        }',
		'        return;',
		'      }',
		'      target = target.parentNode;',
		'    }',
		'  });',
		'',
		'  window.addEventListener(\'message\', function (event) {',
		'    var msg = event.data;',
		'    if (!msg || typeof msg !== \'object\' || typeof msg.type !== \'string\') {',
		'      return;',
		'    }',
		'    if (msg.type === \'errorReply\') {',
		'      var sel = \'.cell-value[data-row="\' + Number(msg.row) + \'"][data-col="\' + Number(msg.col) + \'"]\';',
		'      var cell = document.querySelector(sel);',
		'      if (cell !== null) {',
		'        cell.classList.add(\'cell-edit-error\');',
		'        cell.setAttribute(\'title\', \'[\' + String(msg.code) + \'] \' + String(msg.message));',
		'      }',
		'      return;',
		'    }',
		'    if (msg.type === \'refresh\') {',
		'      // No-op: the host rebuilds webview.html in full on',
		'      // refresh, so this script + state get torn down.',
		'      return;',
		'    }',
		'    console.warn(\'[cellGrid] unknown inbound message type:\', msg.type);',
		'  });',
		'',
		'  // V3.4.0.3 (2026-05-23) -- undo/redo keyboard wiring.',
		'  //',
		'  // Bind a document-level keydown listener that maps:',
		'  //   (Cmd|Ctrl)+Z (no Shift)         -> postMessage({type:\'undo\'})',
		'  //   (Cmd|Ctrl)+Shift+Z OR Ctrl+Y    -> postMessage({type:\'redo\'})',
		'  //',
		'  // **Mid-edit guard via activeInput** (mirrors V3.3.0.4 scroll',
		'  // guard pattern, per V3.4.0.1 D4): when the user is typing in a',
		'  // cell <input>, Cmd-Z should undo the TEXT INPUT (browser',
		'  // default behaviour), NOT the workbook state.  Skip the',
		'  // preventDefault + postMessage if activeInput is non-null and',
		'  // let the browser handle the keystroke.  After Enter/Escape',
		'  // tears down the input, activeInput becomes null and the next',
		'  // Cmd-Z triggers the workbook undo path.',
		'  //',
		'  // **Webview-scope only** (mirrors V3.2.b click-to-edit): the',
		'  // listener fires only while the webview has focus.  VS Code',
		'  // command-palette Cmd-Z + editor Cmd-Z continue to work for',
		'  // those surfaces; the webview\'s keystrokes don\'t leak out.',
		'  document.addEventListener(\'keydown\', function (ev) {',
		'    if (activeInput !== null) {',
		'      // Mid-edit: let the browser handle text-undo.  Do NOT',
		'      // preventDefault; do NOT post the workbook undo envelope.',
		'      return;',
		'    }',
		'    var isMeta = ev.metaKey || ev.ctrlKey;',
		'    if (!isMeta) { return; }',
		'    var key = ev.key.toLowerCase();',
		'    // Cmd/Ctrl-Z without Shift = undo.',
		'    if (key === \'z\' && !ev.shiftKey) {',
		'      ev.preventDefault();',
		'      vscode.postMessage({ type: \'undo\' });',
		'      return;',
		'    }',
		'    // Cmd/Ctrl-Shift-Z = redo (Mac convention).',
		'    // Ctrl-Y = redo (Win/Linux convention).',
		'    if ((key === \'z\' && ev.shiftKey) || key === \'y\') {',
		'      ev.preventDefault();',
		'      vscode.postMessage({ type: \'redo\' });',
		'      return;',
		'    }',
		'  });',
		'',
		'  // V3.3.0.4 virtualization: scroll-driven row swap.',
		'  //',
		'  // Reads the full snapshot from the inline `<script id="cell-grid-data"',
		'  // type="application/json">` block, computes the visible-row range on',
		'  // each scroll event, and repaints the `<tbody>` content between the',
		'  // top/bottom spacer rows.  No host round-trip per scroll tick.',
		'  //',
		'  // Mid-edit safety: if `activeInput` is non-null (user is typing in a',
		'  // cell), the repaint is SKIPPED for that scroll tick.  Repainting',
		'  // tbody would clobber the input element + lose unsaved text.  The',
		'  // user must commit/cancel before scroll-induced repaints resume.',
		'  var dataBlock = document.getElementById(\'cell-grid-data\');',
		'  var FULL_SNAPSHOT = null;',
		'  if (dataBlock !== null) {',
		'    try {',
		'      FULL_SNAPSHOT = JSON.parse(dataBlock.textContent || \'{"entries":[]}\');',
		'    } catch (e) {',
		'      console.warn(\'[cellGrid] failed to parse snapshot data block:\', e);',
		'    }',
		'  }',
		'',
		'  var viewport = document.querySelector(\'.cell-grid-viewport\');',
		'  var tbody = viewport !== null ? viewport.querySelector(\'tbody\') : null;',
		'  var ROW_HEIGHT = 25;',
		'  var OVERSCAN = 5;',
		'',
		'  function htmlEscape(s) {',
		'    return String(s).replace(/[&<>"\\u0027]/g, function (c) {',
		'      if (c === \'&\') return \'&amp;\';',
		'      if (c === \'<\') return \'&lt;\';',
		'      if (c === \'>\') return \'&gt;\';',
		'      if (c === \'"\') return \'&quot;\';',
		'      return \'&#39;\';',
		'    });',
		'  }',
		'',
		'  function formatCellValueClient(value) {',
		'    if (value.kind === \'number\') return String(value.value);',
		'    if (value.kind === \'boolean\') return value.value ? \'TRUE\' : \'FALSE\';',
		'    if (value.kind === \'text\') return value.value;',
		'    if (value.kind === \'error\') return value.value;',
		'    return \'(pending)\';',
		'  }',
		'',
		'  function renderRowsClient(entries) {',
		'    var html = \'\';',
		'    for (var i = 0; i < entries.length; i += 1) {',
		'      var e = entries[i];',
		'      var valueStr = formatCellValueClient(e.value);',
		'      var kind = e.value.kind;',
		'      // V3.3.0.X audit closure (LOW-1): defense-in-depth Number()',
		'      // coercion mirrors the server renderer (cellGridHtml.ts).',
		'      // Number(non-numeric) -> NaN -> "NaN" literal in the',
		'      // attribute; no XSS surface even if a tampered data block',
		'      // injects non-numeric row/col.',
		'      var rowSafe = Number(e.row);',
		'      var colSafe = Number(e.col);',
		'      html += \'<tr><td>\' + rowSafe + \'</td><td>\' + colSafe +',
		'        \'</td><td class="cell-value" data-row="\' + rowSafe +',
		'        \'" data-col="\' + colSafe +',
		'        \'" data-original-text="\' + htmlEscape(valueStr) +',
		'        \'" data-original-kind="\' + htmlEscape(kind) + \'">\' +',
		'        htmlEscape(valueStr) +',
		'        \'<span class="kind">[\' + htmlEscape(kind) + \']</span></td></tr>\';',
		'    }',
		'    return html;',
		'  }',
		'',
		'  function computeRange(scrollTop, viewportHeight, totalRows) {',
		'    if (totalRows === 0) { return { startIdx: 0, endIdx: 0 }; }',
		'    if (ROW_HEIGHT <= 0) { return { startIdx: 0, endIdx: totalRows }; }',
		'    var firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT));',
		'    var visibleCount = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT));',
		'    var startIdx = Math.max(0, firstVisible - OVERSCAN);',
		'    var endIdx = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);',
		'    return { startIdx: startIdx, endIdx: endIdx };',
		'  }',
		'',
		'  function repaintForScroll() {',
		'    if (activeInput !== null) { return; }', // mid-edit guard
		'    if (FULL_SNAPSHOT === null || viewport === null || tbody === null) { return; }',
		'    var entries = FULL_SNAPSHOT.entries || [];',
		'    var range = computeRange(viewport.scrollTop, viewport.clientHeight, entries.length);',
		'    var visible = entries.slice(range.startIdx, range.endIdx);',
		'    var topHeight = range.startIdx * ROW_HEIGHT;',
		'    var bottomHeight = (entries.length - range.endIdx) * ROW_HEIGHT;',
		'    var topSpacer = \'<tr class="cell-grid-spacer-top" data-spacer-height="\' + topHeight +',
		'      \'" style="height: \' + topHeight + \'px;"><td colspan="3" aria-hidden="true"></td></tr>\';',
		'    var bottomSpacer = \'<tr class="cell-grid-spacer-bottom" data-spacer-height="\' + bottomHeight +',
		'      \'" style="height: \' + bottomHeight + \'px;"><td colspan="3" aria-hidden="true"></td></tr>\';',
		'    tbody.innerHTML = topSpacer + renderRowsClient(visible) + bottomSpacer;',
		'  }',
		'',
		'  if (viewport !== null) {',
		'    viewport.addEventListener(\'scroll\', repaintForScroll);',
		'    // Initial paint after geometry is known (viewport.clientHeight is',
		'    // only valid after layout).  rAF defers to after first paint.',
		'    requestAnimationFrame(repaintForScroll);',
		'  }',
		'}());',
	].join('\n');
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => {
		switch (c) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case '\'': return '&#39;';
			default: return c;
		}
	});
}
