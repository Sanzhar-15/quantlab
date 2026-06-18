/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-6 / R18 Wave E (2026-06-18) -- the SQL-query sidebar webview bundle.
//
// A thin DOM client: it builds the editor UI inside the provider-supplied `#sql-root`, persists the SQL +
// target draft across hide/show (vscode.getState/setState), and exchanges messages with
// `SqlQueryViewProvider`. ALL execution/validation lives host-side (the provider + the engine); this file
// never parses SQL or ranges -- it ships the raw strings and renders the host's reply.

interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;

interface AvailableTable {
	name: string;
	kind: 'sheet' | 'table';
	sheet?: number;
}
interface PersistState {
	sql: string;
	target: string;
}

const vscode = acquireVsCodeApi();

const root = document.getElementById('sql-root');
if (root === null) {
	throw new Error('sql-query webview: #sql-root is missing');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

// --- build the DOM (the provider HTML only supplies #sql-root) ---
const tablesLabel = el('div', 'sql-section-label', 'Available tables');
const tablesList = el('ul', 'sql-tables');
const sqlLabel = el('div', 'sql-section-label', 'Query');
const sqlText = el('textarea', 'sql-text');
sqlText.placeholder = 'SELECT A, B FROM Sheet1 WHERE A > 100';
sqlText.rows = 6;
sqlText.spellcheck = false;
const targetLabel = el('div', 'sql-section-label', 'Target range');
const targetRow = el('div', 'sql-target-row');
const targetInput = el('input', 'sql-target');
targetInput.type = 'text';
targetInput.placeholder = 'A1:C10';
const useSelBtn = el('button', 'sql-btn sql-btn-secondary', 'Use selection');
targetRow.append(targetInput, useSelBtn);
const buttonRow = el('div', 'sql-button-row');
const runBtn = el('button', 'sql-btn sql-btn-primary', 'Run');
const clearBtn = el('button', 'sql-btn sql-btn-secondary', 'Clear results');
buttonRow.append(runBtn, clearBtn);
const statusEl = el('div', 'sql-status');
const noteEl = el(
	'div',
	'sql-note',
	'Results are written into the target range as plain cells. The query is re-runnable this session but is not saved with the workbook.',
);

root.append(tablesLabel, tablesList, sqlLabel, sqlText, targetLabel, targetRow, buttonRow, statusEl, noteEl);

// --- draft persistence (survives the view being hidden) ---
const saved = vscode.getState() as PersistState | undefined;
if (saved !== undefined && saved !== null) {
	if (typeof saved.sql === 'string') {
		sqlText.value = saved.sql;
	}
	if (typeof saved.target === 'string') {
		targetInput.value = saved.target;
	}
}
function persist(): void {
	vscode.setState({ sql: sqlText.value, target: targetInput.value });
}
sqlText.addEventListener('input', persist);
targetInput.addEventListener('input', persist);

function setStatus(text: string, kind: 'info' | 'error' | 'warn' | 'ok'): void {
	statusEl.textContent = text;
	statusEl.className = `sql-status sql-status-${kind}`;
}

function insertAtCaret(area: HTMLTextAreaElement, text: string): void {
	const start = area.selectionStart;
	const end = area.selectionEnd;
	area.value = area.value.slice(0, start) + text + area.value.slice(end);
	const pos = start + text.length;
	area.selectionStart = pos;
	area.selectionEnd = pos;
	area.focus();
	persist();
}

function renderTables(tables: AvailableTable[] | undefined, tablesError: string | undefined): void {
	tablesList.replaceChildren();
	if (tablesError !== undefined) {
		tablesList.append(el('li', 'sql-tables-msg', `Could not read tables: ${tablesError}`));
		return;
	}
	if (tables === undefined || tables.length === 0) {
		tablesList.append(el('li', 'sql-tables-msg', 'No sheets or tables.'));
		return;
	}
	for (const t of tables) {
		const li = el('li', 'sql-table-item');
		li.append(el('span', 'sql-table-name', t.name), el('span', 'sql-table-kind', t.kind));
		li.title = `Click to insert "${t.name}" into the query`;
		li.addEventListener('click', () => insertAtCaret(sqlText, t.name));
		tablesList.append(li);
	}
}

let hasGridState = false;
let running = false;
function applyEnabled(): void {
	sqlText.disabled = !hasGridState;
	targetInput.disabled = !hasGridState;
	useSelBtn.disabled = !hasGridState;
	// Run/Clear are additionally disabled while a run/clear is in flight, so a double-click can't fire a
	// second request before the host's runResult returns.
	runBtn.disabled = !hasGridState || running;
	clearBtn.disabled = !hasGridState || running;
}

runBtn.addEventListener('click', () => {
	if (running || !hasGridState) {
		return;
	}
	running = true;
	applyEnabled();
	setStatus('Running query...', 'info');
	vscode.postMessage({ type: 'runSql', sql: sqlText.value, target: targetInput.value });
});
clearBtn.addEventListener('click', () => {
	if (running || !hasGridState) {
		return;
	}
	running = true;
	applyEnabled();
	setStatus('Clearing results...', 'info');
	vscode.postMessage({ type: 'clearResults' });
});
useSelBtn.addEventListener('click', () => {
	if (!hasGridState) {
		return;
	}
	vscode.postMessage({ type: 'useSelection' });
});

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data;
	if (msg === null || typeof msg !== 'object') {
		return;
	}
	switch (msg.type) {
		case 'state': {
			const hasGrid = msg.hasGrid === true;
			hasGridState = hasGrid;
			applyEnabled();
			if (!hasGrid) {
				renderTables(undefined, undefined);
				setStatus('Open a sheet to run a SQL query.', 'info');
				return;
			}
			renderTables(msg.tables as AvailableTable[] | undefined, msg.tablesError as string | undefined);
			if (targetInput.value.trim() === '' && typeof msg.defaultTarget === 'string') {
				targetInput.value = msg.defaultTarget;
				persist();
			}
			// Don't clobber a lingering error/result message with "Ready." -- only seed it when blank.
			if (statusEl.textContent === '') {
				setStatus('Ready.', 'info');
			}
			break;
		}
		case 'target': {
			if (typeof msg.defaultTarget === 'string') {
				targetInput.value = msg.defaultTarget;
				persist();
			}
			break;
		}
		case 'runResult': {
			running = false;
			applyEnabled();
			if (msg.ok === true) {
				if (typeof msg.warning === 'string' && msg.warning !== '') {
					setStatus(msg.warning, 'warn');
				} else if (msg.cleared === true) {
					setStatus('Results cleared.', 'ok');
				} else if (msg.cleared === false) {
					setStatus('No results to clear.', 'info');
				} else {
					const where = typeof msg.target === 'string' ? ` into ${msg.target}` : '';
					setStatus(`Query complete${where}.`, 'ok');
				}
			} else {
				setStatus(typeof msg.error === 'string' ? msg.error : 'Query failed.', 'error');
			}
			break;
		}
	}
});

// Tell the host we're mounted so it pushes the initial state (focused grid, default target, table list).
vscode.postMessage({ type: 'ready' });
