/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 error-surface -- unit tests for the vscode-free core of the Quantbook DiagnosticCollection bridge:
// extracting CURRENTLY error-valued cells from a render snapshot, A1 formatting, deterministic uri
// strings, and virtual-doc rendering. The host bridge (quantbookDiagnostics.ts) is a thin vscode shell
// over these. Runs in the normal mocha suite (no ipykernel / no vscode).

import * as assert from 'assert';

import type { QuantbookCellSnapshot, QuantbookCellValue } from '../src/quantbook/types';
import {
	buildCellDiagnosticsFromSnapshot,
	cellDiagnosticsUriPath,
	columnLabelA1,
	formatCellA1,
	formatCellLocationLabel,
	reactiveDiagnosticsUriPath,
	renderCellDiagnosticsDoc,
	renderReactiveDiagnosticsDoc,
	type CellDiagnostic,
} from '../src/quantbook/diagnostics/diagnosticsLogic';

function entry(row: number, col: number, value: QuantbookCellValue, diagnostic?: string): QuantbookCellSnapshot['entries'][number] {
	const e: { row: number; col: number; value: QuantbookCellValue; diagnostic?: string } = { row, col, value };
	if (diagnostic !== undefined) {
		e.diagnostic = diagnostic;
	}
	return e;
}

function snapshot(entries: QuantbookCellSnapshot['entries']): QuantbookCellSnapshot {
	return { snapshot_format_version: 1, sheet: 0, entries };
}

suite('W2 diagnosticsLogic -- columnLabelA1 + formatCellA1', () => {
	test('columnLabelA1 is bijective base-26', () => {
		assert.strictEqual(columnLabelA1(0), 'A');
		assert.strictEqual(columnLabelA1(25), 'Z');
		assert.strictEqual(columnLabelA1(26), 'AA');
		assert.strictEqual(columnLabelA1(701), 'ZZ');
		assert.strictEqual(columnLabelA1(702), 'AAA');
	});
	test('a negative column is empty (defensive)', () => {
		assert.strictEqual(columnLabelA1(-1), '');
	});
	test('formatCellA1 is 1-based on the row', () => {
		assert.strictEqual(formatCellA1(0, 0), 'A1');
		assert.strictEqual(formatCellA1(4, 2), 'C5');
		assert.strictEqual(formatCellA1(99, 26), 'AA100');
	});
});

suite('W2 diagnosticsLogic -- buildCellDiagnosticsFromSnapshot', () => {
	test('an empty snapshot yields no diagnostics', () => {
		assert.deepStrictEqual(buildCellDiagnosticsFromSnapshot(snapshot([])), []);
	});

	test('non-error cells are ignored', () => {
		const snap = snapshot([
			entry(0, 0, { kind: 'number', value: 42 }),
			entry(0, 1, { kind: 'text', value: 'hi' }),
			entry(1, 0, { kind: 'boolean', value: true }),
			entry(2, 0, { kind: 'pending' }),
		]);
		assert.deepStrictEqual(buildCellDiagnosticsFromSnapshot(snap), []);
	});

	test('an error cell WITH a diagnostic surfaces the diagnostic as the message + the error string as code', () => {
		const snap = snapshot([
			entry(3, 1, { kind: 'error', value: '#PYTHON!' }, 'ValueError: boom'),
		]);
		const out = buildCellDiagnosticsFromSnapshot(snap);
		assert.deepStrictEqual(out, [{ row: 3, col: 1, code: '#PYTHON!', message: 'ValueError: boom' }]);
	});

	test('an error cell WITHOUT a diagnostic falls back to the error string as the message (never empty)', () => {
		const snap = snapshot([
			entry(0, 0, { kind: 'error', value: '#CALC!' }),
		]);
		const out = buildCellDiagnosticsFromSnapshot(snap);
		assert.deepStrictEqual(out, [{ row: 0, col: 0, code: '#CALC!', message: '#CALC!' }]);
	});

	test('an empty-string diagnostic falls back to the error string (no empty message)', () => {
		const snap = snapshot([
			entry(0, 0, { kind: 'error', value: '#REF!' }, ''),
		]);
		const out = buildCellDiagnosticsFromSnapshot(snap);
		assert.deepStrictEqual(out, [{ row: 0, col: 0, code: '#REF!', message: '#REF!' }]);
	});

	test('mixed sheet preserves (row,col)-ascending order and only error cells', () => {
		const snap = snapshot([
			entry(0, 0, { kind: 'number', value: 1 }),
			entry(0, 1, { kind: 'error', value: '#DIV/0!' }, 'division by zero'),
			entry(1, 0, { kind: 'error', value: '#NAME?' }),
			entry(1, 1, { kind: 'text', value: 'ok' }),
		]);
		const out = buildCellDiagnosticsFromSnapshot(snap);
		assert.deepStrictEqual(out, [
			{ row: 0, col: 1, code: '#DIV/0!', message: 'division by zero' },
			{ row: 1, col: 0, code: '#NAME?', message: '#NAME?' },
		]);
	});

	test('a recovered cell (error -> number) is absent on the next extraction (auto-clear)', () => {
		const errored = buildCellDiagnosticsFromSnapshot(snapshot([entry(2, 2, { kind: 'error', value: '#CALC!' })]));
		assert.strictEqual(errored.length, 1);
		const recovered = buildCellDiagnosticsFromSnapshot(snapshot([entry(2, 2, { kind: 'number', value: 7 })]));
		assert.deepStrictEqual(recovered, []);
	});
});

suite('W2 diagnosticsLogic -- uri paths (deterministic + per-session)', () => {
	test('cell uri path embeds the session tag + sheet', () => {
		assert.deepStrictEqual(cellDiagnosticsUriPath('s1', 0), { authority: 'workbook', path: '/s1/sheet/0' });
		assert.deepStrictEqual(cellDiagnosticsUriPath('s2', 3), { authority: 'workbook', path: '/s2/sheet/3' });
	});
	test('two sessions on the same sheet id get distinct paths (no collision)', () => {
		const a = cellDiagnosticsUriPath('s1', 0);
		const b = cellDiagnosticsUriPath('s2', 0);
		assert.notStrictEqual(a.path, b.path);
	});
	test('reactive uri path is per-session', () => {
		assert.deepStrictEqual(reactiveDiagnosticsUriPath('s1'), { authority: 'workbook', path: '/s1/reactive' });
		assert.notStrictEqual(reactiveDiagnosticsUriPath('s1').path, reactiveDiagnosticsUriPath('s2').path);
	});
});

suite('W2 diagnosticsLogic -- location label + doc rendering', () => {
	test('formatCellLocationLabel anchors on the numeric sheet id + A1', () => {
		assert.strictEqual(formatCellLocationLabel(0, 0, 1), 'Sheet 0 B1');
		assert.strictEqual(formatCellLocationLabel(2, 4, 2), 'Sheet 2 C5');
	});

	test('renderCellDiagnosticsDoc lists each error cell with A1 + code + message', () => {
		const diags: CellDiagnostic[] = [
			{ row: 0, col: 1, code: '#DIV/0!', message: 'division by zero' },
			{ row: 1, col: 0, code: '#NAME?', message: '#NAME?' },
		];
		const doc = renderCellDiagnosticsDoc(0, diags);
		assert.ok(doc.includes('Quantbook errors -- Sheet 0'));
		assert.ok(doc.includes('B1\t[#DIV/0!] division by zero'));
		assert.ok(doc.includes('A2\t[#NAME?] #NAME?'));
	});

	test('renderCellDiagnosticsDoc on an empty list says no current errors', () => {
		const doc = renderCellDiagnosticsDoc(1, []);
		assert.ok(doc.includes('No current errors on this sheet.'));
	});

	test('renderReactiveDiagnosticsDoc lists each reactive message', () => {
		const doc = renderReactiveDiagnosticsDoc(['NameError: x is not defined']);
		assert.ok(doc.includes('reactive kernel (workbook-level)'));
		assert.ok(doc.includes('* NameError: x is not defined'));
	});

	test('renderReactiveDiagnosticsDoc on an empty list says no current reactive errors', () => {
		assert.ok(renderReactiveDiagnosticsDoc([]).includes('No current reactive errors.'));
	});
});
