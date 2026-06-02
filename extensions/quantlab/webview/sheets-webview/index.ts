/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-0b-1 (2026-06-02) -- bundled sheets webview entry (DOM table).**
 *
 * The cell-grid webview was previously host-built inline HTML: the host called
 * `cellGridHtml.ts:buildHtml(snapshot, {nonce})` and assigned the whole string
 * to `webview.html` on EVERY render (a full document + script reload per commit).
 *
 * FE-0b makes the webview a PERSISTENT bundled (esbuild) module. The host sets
 * `webview.html` ONCE (a thin shell: nonce CSP + `<script src>` + a root div),
 * and pushes data via `postMessage`:
 *   - host -> webview: `{ type: 'render', snapshot }` on first paint + after each
 *     commit; `{ type: 'errorReply', sheet, row, col, code, message }` on a
 *     failed edit.
 *   - webview -> host: `{ type: 'putValue', sheet, row, col, rawInput }`,
 *     `{ type: 'undo' }`, `{ type: 'redo' }` (the UNCHANGED dispatch contract in
 *     `cellGridLogic.ts:dispatchIncomingMessage`), plus `{ type: 'webviewReady' }`
 *     ONCE on load so the host knows the message channel is live and (re)sends the
 *     current snapshot (handshake -- avoids the post-before-load race).
 *
 * **Collab presence/typing is DROPPED here** (it was v1.5-dormant and the host
 * dispatcher already drops `presenceUpdate`/`typing_stroke`). FE-0b-2 replaces
 * the DOM table below with a Canvas2D renderer; this file proves the
 * bundled-webview + message pipeline first.
 *
 * This is a SIDE-EFFECTING entry module (no top-level `export`s) so the esm
 * bundle loads cleanly via a classic `<script nonce src>` tag (mirrors qviz-spec).
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { computeVisibleRowRange, renderRowsHtml } from './cellRender';

/** Minimal VS Code webview API surface (mirrors qviz-spec/index.ts). */
interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

// --- Wire contracts (source of truth: cellGridLogic.ts). Re-declared locally
// so the browser bundle never imports host runtime (`cellGridLogic.ts` pulls
// `session.ts`'s napi binding). Kept byte-compatible with the host envelopes. ---

/** host -> webview: full sheet snapshot to paint. */
interface RenderMessage {
	readonly type: 'render';
	readonly snapshot: QuantbookCellSnapshot;
}
/** host -> webview: a failed edit; decorate the offending cell. */
interface ErrorReplyMessage {
	readonly type: 'errorReply';
	readonly sheet: number;
	readonly row: number;
	readonly col: number;
	readonly code: string;
	readonly message: string;
}

const ROW_HEIGHT = 25;
const OVERSCAN = 5;

// Cache the VS Code API handle on `window`. `acquireVsCodeApi()` may be called
// at most ONCE per webview context and THROWS on a second call. With the
// persistent webview (retainContextWhenHidden) a re-evaluation of this bundle
// (e.g. the "Developer: Reload Webviews" command, or a future HMR path) would
// otherwise throw at module top-level and leave a blank grid. Mirrors the
// qviz-spec guard.
type SheetsWindow = Window & { __sheetsVscodeApi?: VSCodeApi };
const vscode: VSCodeApi = (window as SheetsWindow).__sheetsVscodeApi ?? acquireVsCodeApi();
(window as SheetsWindow).__sheetsVscodeApi = vscode;

// --- Persistent skeleton (built once; render() only repaints the tbody so the
// viewport element -- and therefore scroll position -- survives across commits). ---

const root = document.getElementById('sheets-root');
if (root === null) {
	throw new Error('sheets-webview: #sheets-root missing from DOM');
}
root.innerHTML =
	'<h2 id="sheets-title">Quantbook Cell Grid</h2>' +
	'<div class="meta" id="sheets-meta"></div>' +
	'<div class="empty" id="sheets-empty" hidden>(empty -- no PutValue ops on this sheet)</div>' +
	'<div class="cell-grid-viewport" id="sheets-viewport">' +
	'<table><thead><tr><th>Row</th><th>Col</th><th>Value</th></tr></thead>' +
	'<tbody id="sheets-tbody"></tbody></table></div>';

const titleEl = document.getElementById('sheets-title') as HTMLElement;
const metaEl = document.getElementById('sheets-meta') as HTMLElement;
const emptyEl = document.getElementById('sheets-empty') as HTMLElement;
const viewportEl = document.getElementById('sheets-viewport') as HTMLElement;
const tbodyEl = document.getElementById('sheets-tbody') as HTMLElement;

let fullSnapshot: QuantbookCellSnapshot | null = null;
let activeInput: HTMLInputElement | null = null;
let activeCell: HTMLElement | null = null;

/**
 * Repaint the visible window of `fullSnapshot.entries` into the tbody, sandwiched
 * between top/bottom spacer rows that preserve the full table's scroll geometry.
 * Mid-edit guard: skipped while an edit `<input>` is open (repainting would
 * clobber it + lose unsaved text); the post-commit render() resets edit state
 * BEFORE calling this, so a successful commit still repaints.
 */
function repaintForScroll(): void {
	if (activeInput !== null) {
		return;
	}
	if (fullSnapshot === null) {
		return;
	}
	const entries = fullSnapshot.entries;
	const range = computeVisibleRowRange(viewportEl.scrollTop, viewportEl.clientHeight, entries.length, ROW_HEIGHT, OVERSCAN);
	const visible = entries.slice(range.startIdx, range.endIdx);
	const topHeight = range.startIdx * ROW_HEIGHT;
	const bottomHeight = (entries.length - range.endIdx) * ROW_HEIGHT;
	const topSpacer = '<tr class="cell-grid-spacer-top" style="height: ' + topHeight + 'px;"><td colspan="3" aria-hidden="true"></td></tr>';
	const bottomSpacer = '<tr class="cell-grid-spacer-bottom" style="height: ' + bottomHeight + 'px;"><td colspan="3" aria-hidden="true"></td></tr>';
	tbodyEl.innerHTML = topSpacer + renderRowsHtml(visible) + bottomSpacer;
}

/** Apply a fresh snapshot: update title/meta, reset edit state, repaint. */
function applyRender(snapshot: QuantbookCellSnapshot): void {
	fullSnapshot = snapshot;
	// A render means a committed state change (or first paint): any in-flight
	// edit input is now stale -- drop it so the repaint shows the new values.
	activeInput = null;
	activeCell = null;
	titleEl.textContent = 'Quantbook Cell Grid -- Sheet ' + String(snapshot.sheet);
	metaEl.textContent = 'snapshot_format_version=' + String(snapshot.snapshot_format_version) + '; entries=' + String(snapshot.entries.length);
	const isEmpty = snapshot.entries.length === 0;
	emptyEl.hidden = !isEmpty;
	viewportEl.hidden = isEmpty;
	if (isEmpty) {
		tbodyEl.innerHTML = '';
		return;
	}
	repaintForScroll();
}

// --- Click-to-edit ---

function endEdit(commit: boolean): void {
	if (activeInput === null || activeCell === null) {
		return;
	}
	const cell = activeCell;
	const input = activeInput;
	const raw = input.value;
	activeInput = null;
	activeCell = null;
	if (commit) {
		// Pessimistic: leave the input in place + post to host. The host will
		// either send a fresh `render` (success -> applyRender repaints + drops
		// the input) or an `errorReply` (failure -> decorate the cell, input
		// stays for correction). Keep both refs so errorReply can find the cell.
		activeInput = input;
		activeCell = cell;
		vscode.postMessage({
			type: 'putValue',
			sheet: fullSnapshot !== null ? fullSnapshot.sheet : 0,
			row: Number(cell.getAttribute('data-row')),
			col: Number(cell.getAttribute('data-col')),
			rawInput: raw,
		});
		return;
	}
	// Cancel (Escape / blur): restore the cell's prior text + kind annotation.
	cell.innerHTML = '';
	cell.appendChild(document.createTextNode(cell.getAttribute('data-original-text') || ''));
	const kindSpan = document.createElement('span');
	kindSpan.className = 'kind';
	kindSpan.appendChild(document.createTextNode('[' + (cell.getAttribute('data-original-kind') || '') + ']'));
	cell.appendChild(kindSpan);
	cell.classList.remove('cell-edit-error');
	cell.removeAttribute('title');
}

function beginEdit(cell: HTMLElement): void {
	if (activeInput !== null) {
		endEdit(false);
	}
	// Precedence: formula source > parseable raw value > displayed text. A cell
	// with both a formula and a value has two raw representations; the formula is
	// the authoritative edit source (it's what the user typed).
	let rawValue = cell.getAttribute('data-raw-formula');
	if (rawValue === null) {
		rawValue = cell.getAttribute('data-raw-value');
	}
	if (rawValue === null) {
		rawValue = cell.getAttribute('data-original-text') || '';
	}
	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'cell-edit-input';
	input.value = rawValue;
	input.setAttribute('aria-label', 'Edit cell value');
	cell.innerHTML = '';
	cell.appendChild(input);
	cell.classList.remove('cell-edit-error');
	cell.removeAttribute('title');
	activeInput = input;
	activeCell = cell;
	input.addEventListener('keydown', ev => {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			endEdit(true);
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			endEdit(false);
		}
	});
	input.addEventListener('blur', () => {
		// Conservative: blur cancels; Enter explicitly commits. Avoids accidental
		// commits when the user clicks elsewhere.
		if (activeInput === input) {
			endEdit(false);
		}
	});
	input.focus();
	input.select();
}

document.addEventListener('click', ev => {
	let target = ev.target as Node | null;
	while (target && target !== document.body) {
		const el = target as HTMLElement;
		if (el.classList && el.classList.contains('cell-value') && el.getAttribute('data-row') !== null) {
			if (activeCell !== el) {
				beginEdit(el);
			}
			return;
		}
		target = target.parentNode;
	}
});

// --- Undo / redo (webview-scoped; mid-edit lets the browser handle text-undo) ---

document.addEventListener('keydown', ev => {
	if (activeInput !== null) {
		return;
	}
	const isMeta = ev.metaKey || ev.ctrlKey;
	if (!isMeta) {
		return;
	}
	const key = ev.key.toLowerCase();
	if (key === 'z' && !ev.shiftKey) {
		ev.preventDefault();
		vscode.postMessage({ type: 'undo' });
		return;
	}
	if ((key === 'z' && ev.shiftKey) || key === 'y') {
		ev.preventDefault();
		vscode.postMessage({ type: 'redo' });
		return;
	}
});

// --- Inbound host messages ---

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data as { type?: unknown } | null;
	if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
		return;
	}
	if (msg.type === 'render') {
		const rm = msg as RenderMessage;
		applyRender(rm.snapshot);
		return;
	}
	if (msg.type === 'errorReply') {
		const er = msg as ErrorReplyMessage;
		const sel = '.cell-value[data-row="' + Number(er.row) + '"][data-col="' + Number(er.col) + '"]';
		const cell = document.querySelector(sel);
		if (cell !== null) {
			cell.classList.add('cell-edit-error');
			cell.setAttribute('title', '[' + String(er.code) + '] ' + String(er.message));
		}
		return;
	}
	console.warn('[sheets-webview] unknown inbound message type:', msg.type);
});

viewportEl.addEventListener('scroll', repaintForScroll);

// Handshake: announce the channel is live so the host (re)sends the snapshot.
// Sent AFTER all listeners are wired so the host's reply is never missed.
vscode.postMessage({ type: 'webviewReady' });
