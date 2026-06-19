/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I (R13 + R14) -- unit tests for the "Errors" diagnostics sidebar.
//   1. classifyErrorCode (R14 distinct-marker classification) -- pure.
//   2. buildDiagnosticsNodes (R13 grouping/ordering/empty-states) -- pure.
//   3. QuantbookDiagnostics.currentDiagnostics / reactiveError (the read API the sidebar consumes) --
//      over the real bridge + the vscode shim, asserting the stored-wins merge matches the Problems emit.
//   4. DiagnosticsTreeProvider getTreeItem / getChildren (R14 icons + the 2-level tree walk + the
//      click-to-reveal command), driving computeInput via a monkeypatched focused panel.

import * as assert from 'assert';

import { Uri, installVscodeShim } from './helpers/vscode-shim';
installVscodeShim();

import {
	buildDiagnosticsNodes,
	classifyErrorCode,
	type DiagnosticsInput,
	type DiagnosticsNode,
} from '../src/quantbook/diagnostics/diagnosticsTreeModel';
import { QuantbookDiagnostics } from '../src/quantbook/diagnostics/quantbookDiagnostics';
import { DiagnosticsTreeProvider, REVEAL_CELL_COMMAND } from '../src/quantbook/shell/DiagnosticsTreeProvider';
import { CellGridPanel } from '../src/quantbook/cellGrid/cellGridPanel';
import type { CellDiagnostic } from '../src/quantbook/diagnostics/diagnosticsLogic';
import type { QuantbookCellSnapshot, SessionInstance } from '../src/quantbook/types';

// ---------------------------------------------------------------------------
// classifyErrorCode (R14 marker classification)
// ---------------------------------------------------------------------------

suite('Wave I -- classifyErrorCode', () => {
	test('python: #PYTHON! and every udf_* code', () => {
		assert.strictEqual(classifyErrorCode('#PYTHON!'), 'python');
		assert.strictEqual(classifyErrorCode('udf_raised'), 'python');
		assert.strictEqual(classifyErrorCode('udf_no_worker'), 'python');
		assert.strictEqual(classifyErrorCode('udf_protocol'), 'python');
		assert.strictEqual(classifyErrorCode('udf_codec'), 'python');
	});
	test('binding: #BINDING!', () => {
		assert.strictEqual(classifyErrorCode('#BINDING!'), 'binding');
	});
	test('calc: the spreadsheet compute errors', () => {
		for (const c of ['#CALC!', '#DIV/0!', '#NUM!', '#VALUE!', '#REF!']) {
			assert.strictEqual(classifyErrorCode(c), 'calc', c);
		}
	});
	test('name: #NAME?', () => {
		assert.strictEqual(classifyErrorCode('#NAME?'), 'name');
	});
	test('parse: formula_parse / formula_bind / bad_* input-rejections', () => {
		assert.strictEqual(classifyErrorCode('formula_parse'), 'parse');
		assert.strictEqual(classifyErrorCode('formula_bind'), 'parse');
		assert.strictEqual(classifyErrorCode('bad_argument'), 'parse');
		assert.strictEqual(classifyErrorCode('bad_cell'), 'parse');
	});
	test('generic: anything unrecognized (shown, never dropped)', () => {
		assert.strictEqual(classifyErrorCode('something_new'), 'generic');
		assert.strictEqual(classifyErrorCode('#WHAT?'), 'generic');
	});
});

// ---------------------------------------------------------------------------
// buildDiagnosticsNodes (R13 grouping / ordering / empty states)
// ---------------------------------------------------------------------------

function cd(row: number, col: number, code: string, message = code): CellDiagnostic {
	return { row, col, code, message };
}

suite('Wave I -- buildDiagnosticsNodes', () => {
	test('no focused grid -> a single noGrid node', () => {
		const nodes = buildDiagnosticsNodes({ hasFocusedGrid: false, sheets: [], reactiveError: undefined });
		assert.deepStrictEqual(nodes.map(n => n.kind), ['noGrid']);
	});

	test('focused grid with no errors -> a single noErrors node', () => {
		const nodes = buildDiagnosticsNodes({ hasFocusedGrid: true, sheets: [], reactiveError: undefined });
		assert.deepStrictEqual(nodes.map(n => n.kind), ['noErrors']);
	});

	test('a sheet with errors -> a sheetGroup whose children are the cell errors', () => {
		const input: DiagnosticsInput = {
			hasFocusedGrid: true,
			reactiveError: undefined,
			sheets: [{ sheet: 0, sheetName: 'Returns', diagnostics: [cd(0, 0, '#CALC!'), cd(2, 1, '#PYTHON!', 'Traceback...')] }],
		};
		const nodes = buildDiagnosticsNodes(input);
		assert.strictEqual(nodes.length, 1);
		const group = nodes[0];
		assert.strictEqual(group.kind, 'sheetGroup');
		if (group.kind !== 'sheetGroup') { return; }
		assert.strictEqual(group.label, 'Returns');
		assert.strictEqual(group.errorCount, 2);
		assert.deepStrictEqual(group.children.map(c => c.kind), ['cellError', 'cellError']);
		const first = group.children[0];
		assert.strictEqual(first.kind, 'cellError');
		if (first.kind !== 'cellError') { return; }
		assert.strictEqual(first.label, 'A1: #CALC!');
		assert.strictEqual(first.errorClass, 'calc');
	});

	test('cell errors are sorted by row then col within a sheet', () => {
		const input: DiagnosticsInput = {
			hasFocusedGrid: true,
			reactiveError: undefined,
			sheets: [{ sheet: 0, sheetName: 'S', diagnostics: [cd(2, 0, '#CALC!'), cd(0, 3, '#REF!'), cd(0, 1, '#NUM!')] }],
		};
		const group = buildDiagnosticsNodes(input)[0];
		assert.strictEqual(group.kind, 'sheetGroup');
		if (group.kind !== 'sheetGroup') { return; }
		assert.deepStrictEqual(
			group.children.map(c => (c.kind === 'cellError' ? `${c.row},${c.col}` : '?')),
			['0,1', '0,3', '2,0'],
		);
	});

	test('multiple sheets -> groups sorted by sheet id ascending', () => {
		const input: DiagnosticsInput = {
			hasFocusedGrid: true,
			reactiveError: undefined,
			sheets: [
				{ sheet: 5, sheetName: 'Late', diagnostics: [cd(0, 0, '#CALC!')] },
				{ sheet: 1, sheetName: 'Early', diagnostics: [cd(0, 0, '#CALC!')] },
			],
		};
		const nodes = buildDiagnosticsNodes(input);
		assert.deepStrictEqual(nodes.map(n => (n.kind === 'sheetGroup' ? n.sheet : -1)), [1, 5]);
	});

	test('a tombstoned/unknown sheet (no name) falls back to "Sheet <id>"', () => {
		const input: DiagnosticsInput = {
			hasFocusedGrid: true,
			reactiveError: undefined,
			sheets: [{ sheet: 7, sheetName: undefined, diagnostics: [cd(0, 0, '#CALC!')] }],
		};
		const group = buildDiagnosticsNodes(input)[0];
		assert.strictEqual(group.kind === 'sheetGroup' ? group.label : '', 'Sheet 7');
	});

	test('a reactive error leads, and suppresses the noErrors node even with no cell errors', () => {
		const nodes = buildDiagnosticsNodes({ hasFocusedGrid: true, sheets: [], reactiveError: 'kernel died' });
		assert.deepStrictEqual(nodes.map(n => n.kind), ['reactiveError']);
		const r = nodes[0];
		assert.strictEqual(r.kind === 'reactiveError' ? r.message : '', 'kernel died');
	});

	test('reactive error + cell errors -> reactive first, then the sheet group, no noErrors', () => {
		const nodes = buildDiagnosticsNodes({
			hasFocusedGrid: true,
			reactiveError: 'kernel died',
			sheets: [{ sheet: 0, sheetName: 'S', diagnostics: [cd(0, 0, '#CALC!')] }],
		});
		assert.deepStrictEqual(nodes.map(n => n.kind), ['reactiveError', 'sheetGroup']);
	});

	test('a sheet present but with zero diagnostics is not grouped (-> noErrors)', () => {
		const nodes = buildDiagnosticsNodes({
			hasFocusedGrid: true,
			reactiveError: undefined,
			sheets: [{ sheet: 0, sheetName: 'S', diagnostics: [] }],
		});
		assert.deepStrictEqual(nodes.map(n => n.kind), ['noErrors']);
	});
});

// ---------------------------------------------------------------------------
// QuantbookDiagnostics read API (currentDiagnostics / reactiveError)
// ---------------------------------------------------------------------------

function errorSnapshot(sheet: number, errors: Array<{ row: number; col: number; code: string; diagnostic?: string }>): QuantbookCellSnapshot {
	return {
		snapshot_format_version: 1,
		sheet,
		entries: errors.map(e => ({ row: e.row, col: e.col, value: { kind: 'error' as const, value: e.code }, diagnostic: e.diagnostic })),
	};
}

suite('Wave I -- QuantbookDiagnostics read API', () => {
	test('an unseen session reports no diagnostics and no reactive error (no tag allocated)', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		assert.deepStrictEqual(diag.currentDiagnostics(session), []);
		assert.strictEqual(diag.reactiveError(session), undefined);
		diag.dispose();
	});

	test('stored cell errors surface, grouped by sheet, sheet id ascending', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		diag.setSheetCellDiagnostics(session, 2, errorSnapshot(2, [{ row: 0, col: 0, code: '#CALC!', diagnostic: 'cap' }]));
		diag.setSheetCellDiagnostics(session, 0, errorSnapshot(0, [{ row: 1, col: 1, code: '#PYTHON!', diagnostic: 'boom' }]));
		const out = diag.currentDiagnostics(session);
		assert.deepStrictEqual(out.map(s => s.sheet), [0, 2]);
		assert.deepStrictEqual(out[0].diagnostics[0], { row: 1, col: 1, code: '#PYTHON!', message: 'boom' });
		diag.dispose();
	});

	test('a sticky input-rejection on a DIFFERENT cell coexists with a stored error', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		diag.setSheetCellDiagnostics(session, 0, errorSnapshot(0, [{ row: 0, col: 0, code: '#CALC!' }]));
		diag.setCellErrorReply(session, 0, 5, 5, 'formula_parse', 'unexpected token');
		const diags = diag.currentDiagnostics(session)[0].diagnostics;
		assert.strictEqual(diags.length, 2);
		assert.ok(diags.some(d => d.row === 0 && d.col === 0 && d.code === '#CALC!'));
		assert.ok(diags.some(d => d.row === 5 && d.col === 5 && d.code === 'formula_parse'));
		diag.dispose();
	});

	test('a stored error supersedes a sticky on the SAME cell (stored wins), and the read does not mutate', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		// First a sticky rejection on (0,0)...
		diag.setCellErrorReply(session, 0, 0, 0, 'formula_parse', 'bad');
		// ...then a stored error lands on the same cell.
		diag.setSheetCellDiagnostics(session, 0, errorSnapshot(0, [{ row: 0, col: 0, code: '#CALC!', diagnostic: 'cap' }]));
		const firstRead = diag.currentDiagnostics(session)[0].diagnostics;
		assert.strictEqual(firstRead.length, 1, 'stored wins -> exactly one diagnostic on the cell');
		assert.strictEqual(firstRead[0].code, '#CALC!');
		// A second read returns the same (the read is pure; it must not have dropped/duplicated anything).
		const secondRead = diag.currentDiagnostics(session)[0].diagnostics;
		assert.deepStrictEqual(secondRead, firstRead);
		diag.dispose();
	});

	test('reactiveError getter reflects set/clear', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		diag.setReactiveError(session, 'kernel crashed');
		assert.strictEqual(diag.reactiveError(session), 'kernel crashed');
		diag.clearReactiveError(session);
		assert.strictEqual(diag.reactiveError(session), undefined);
		diag.dispose();
	});

	test('clearSessionAll wipes the read API for the session', () => {
		const diag = new QuantbookDiagnostics();
		const session = {} as SessionInstance;
		diag.setSheetCellDiagnostics(session, 0, errorSnapshot(0, [{ row: 0, col: 0, code: '#CALC!' }]));
		diag.setReactiveError(session, 'x');
		diag.clearSessionAll(session);
		assert.deepStrictEqual(diag.currentDiagnostics(session), []);
		assert.strictEqual(diag.reactiveError(session), undefined);
		diag.dispose();
	});
});

// ---------------------------------------------------------------------------
// DiagnosticsTreeProvider (R14 icons + tree walk + reveal command)
// ---------------------------------------------------------------------------

const noopSub = (_l: () => void): { dispose(): void } => ({ dispose: () => { /* no-op */ } });

function provider(source: {
	currentDiagnostics: (s: SessionInstance) => { sheet: number; diagnostics: CellDiagnostic[] }[];
	reactiveError: (s: SessionInstance) => string | undefined;
}): DiagnosticsTreeProvider {
	return new DiagnosticsTreeProvider(source, noopSub, noopSub);
}

/** Read the icon id off a returned TreeItem (the shim ThemeIcon carries `.id`). */
function iconId(item: { iconPath?: unknown }): string | undefined {
	return (item.iconPath as { id?: string } | undefined)?.id;
}

suite('Wave I -- DiagnosticsTreeProvider', () => {
	const emptySource = { currentDiagnostics: () => [], reactiveError: () => undefined };

	test('getTreeItem maps each error class to a distinct icon (R14 markers)', () => {
		const p = provider(emptySource);
		const cases: Array<{ errorClass: string; icon: string }> = [
			{ errorClass: 'python', icon: 'flame' },
			{ errorClass: 'binding', icon: 'plug' },
			{ errorClass: 'calc', icon: 'symbol-operator' },
			{ errorClass: 'name', icon: 'question' },
			{ errorClass: 'parse', icon: 'edit' },
			{ errorClass: 'generic', icon: 'error' },
		];
		for (const c of cases) {
			const node = {
				kind: 'cellError' as const, id: 'x', label: 'A1: #X', sheet: 0, row: 0, col: 0,
				code: '#X', message: 'm', errorClass: c.errorClass as never,
			};
			assert.strictEqual(iconId(p.getTreeItem(node)), c.icon, c.errorClass);
		}
	});

	test('getTreeItem: a cellError tooltip carries the full [code] message (R14 traceback)', () => {
		const p = provider(emptySource);
		const node = {
			kind: 'cellError' as const, id: 'x', label: 'B2: #PYTHON!', sheet: 0, row: 1, col: 1,
			code: '#PYTHON!', message: 'Traceback (most recent call last):\n  ZeroDivisionError', errorClass: 'python' as const,
		};
		const item = p.getTreeItem(node);
		assert.strictEqual(item.tooltip, '[#PYTHON!] Traceback (most recent call last):\n  ZeroDivisionError');
		assert.strictEqual(item.description, 'Traceback (most recent call last):', 'description is the first line only');
	});

	test('getTreeItem: sheetGroup is expanded with an error count; leaves are non-collapsible', () => {
		const p = provider(emptySource);
		const group = p.getTreeItem({ kind: 'sheetGroup', id: 'g', label: 'Returns', sheet: 0, errorCount: 3, children: [] });
		assert.strictEqual(group.collapsibleState, 2 /* Expanded */);
		assert.strictEqual(group.description, '3 errors');
		assert.strictEqual(iconId(group), 'warning');
		const leaf = p.getTreeItem({ kind: 'noErrors', id: 'n', label: 'No errors in this workbook' });
		assert.strictEqual(leaf.collapsibleState, 0 /* None */);
		assert.strictEqual(iconId(leaf), 'pass');
	});

	test('getChildren(sheetGroup) returns its children; a leaf returns []', () => {
		const p = provider(emptySource);
		const child: DiagnosticsNode = { kind: 'cellError', id: 'c', label: 'A1: #CALC!', sheet: 0, row: 0, col: 0, code: '#CALC!', message: 'm', errorClass: 'calc' };
		const group: DiagnosticsNode = { kind: 'sheetGroup', id: 'g', label: 'S', sheet: 0, errorCount: 1, children: [child] };
		assert.deepStrictEqual(p.getChildren(group), [child]);
		assert.deepStrictEqual(p.getChildren(child), []);
	});

	test('getChildren(root) with no focused grid -> a noGrid node', () => {
		const original = CellGridPanel.focusedLocalPanel;
		try {
			(CellGridPanel as unknown as { focusedLocalPanel: () => undefined }).focusedLocalPanel = () => undefined;
			const roots = provider(emptySource).getChildren();
			assert.deepStrictEqual(roots.map(n => n.kind), ['noGrid']);
		} finally {
			(CellGridPanel as unknown as { focusedLocalPanel: typeof original }).focusedLocalPanel = original;
		}
	});

	test('focused path: groups the focused session diagnostics and wires the reveal command by reference', () => {
		const original = CellGridPanel.focusedLocalPanel;
		const session = { listSheets: () => [{ id: 0, name: 'Returns' }] } as unknown as SessionInstance;
		try {
			(CellGridPanel as unknown as { focusedLocalPanel: () => { session: SessionInstance; sheet: number } }).focusedLocalPanel =
				() => ({ session, sheet: 0 });
			const p = provider({
				currentDiagnostics: (s) => (s === session ? [{ sheet: 0, diagnostics: [cd(1, 2, '#PYTHON!', 'boom')] }] : []),
				reactiveError: () => undefined,
			});
			const roots = p.getChildren();
			assert.deepStrictEqual(roots.map(n => n.kind), ['sheetGroup']);
			const group = roots[0];
			assert.strictEqual(group.kind === 'sheetGroup' ? group.label : '', 'Returns');
			const child = p.getChildren(group)[0];
			// getTreeItem on the cell error must wire the reveal command with the SAME session object + coords.
			const item = p.getTreeItem(child);
			assert.strictEqual(item.command?.command, REVEAL_CELL_COMMAND);
			assert.strictEqual(item.command?.arguments?.[0], session, 'session is passed by reference');
			assert.deepStrictEqual(item.command?.arguments?.slice(1), [0, 1, 2], '[sheet, row, col]');
		} finally {
			(CellGridPanel as unknown as { focusedLocalPanel: typeof original }).focusedLocalPanel = original;
		}
	});

	test('a built node keeps its OWN session after focus flips to another workbook (Codex MED-1)', () => {
		const original = CellGridPanel.focusedLocalPanel;
		const sessionA = { listSheets: () => [{ id: 0, name: 'A' }] } as unknown as SessionInstance;
		const sessionB = { listSheets: () => [{ id: 0, name: 'B' }] } as unknown as SessionInstance;
		const setFocus = (s: SessionInstance) => {
			(CellGridPanel as unknown as { focusedLocalPanel: () => { session: SessionInstance; sheet: number } }).focusedLocalPanel =
				() => ({ session: s, sheet: 0 });
		};
		try {
			const p = provider({
				currentDiagnostics: (s) =>
					s === sessionA ? [{ sheet: 0, diagnostics: [cd(0, 0, '#CALC!')] }]
						: s === sessionB ? [{ sheet: 0, diagnostics: [cd(9, 9, '#REF!')] }]
							: [],
				reactiveError: () => undefined,
			});
			// Build for workbook A, capture A's cell-error node.
			setFocus(sessionA);
			const groupA = p.getChildren()[0];
			const childA = p.getChildren(groupA)[0];
			// Focus flips to workbook B and the tree rebuilds (stamping B's nodes). A's OLD node must keep A.
			setFocus(sessionB);
			p.getChildren();
			const item = p.getTreeItem(childA);
			assert.strictEqual(item.command?.arguments?.[0], sessionA, 'the node built for A must still reveal workbook A, not B');
		} finally {
			(CellGridPanel as unknown as { focusedLocalPanel: typeof original }).focusedLocalPanel = original;
		}
	});
});

// Reference Uri so the shim import is retained even if a future edit drops its only use.
void Uri;
