/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-5 (W4 product shell) -- unit tests for the vscode-free Live-Python node model.
 *
 * Verifies the No-Fallbacks state machine: no focused grid -> "no grid"; focused grid + no kernel ->
 * a single "not started" status node (NO variables); running kernel + nothing published -> status +
 * explicit empty node; running kernel + variables -> status + one sorted A1-formatted node per variable.
 * Pure (no ipykernel / no vscode); runs in the normal mocha suite.
 *
 * NB: the file name MUST start with `quantbook` -- the mocha glob is `out/test/quantbook*.test.js`.
 */

import * as assert from 'assert';

import {
	assemblePublishedVariables,
	buildLivePythonNodes,
	focusedWorkbookLabel,
	type PublishedVariableOnSheet,
	type SheetHandle,
} from '../src/quantbook/shell/livePythonModel';
import type { PublishedRange } from '../src/quantbook/reactiveKernel/publishedCellsStore';

function range(startRow: number, startCol: number, endRow: number, endCol: number, name: string): PublishedRange {
	return { startRow, startCol, endRow, endCol, name };
}

function variable(name: string, sheetName: string, r: PublishedRange): PublishedVariableOnSheet {
	return { name, sheetName, range: r };
}

suite('FE-5 Live-Python model', () => {
	test('no focused grid -> a single "no grid" node (no fabricated data)', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: undefined,
			kernelRunning: false,
			publishedVariables: [],
		});
		assert.strictEqual(nodes.length, 1);
		assert.strictEqual(nodes[0].kind, 'noGrid');
	});

	test('focused grid, no kernel -> only a "not started" status node, NO variables', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: false,
			// Even if variables are erroneously passed, an absent kernel publishes nothing -> they are ignored.
			publishedVariables: [variable('x', 'S0', range(0, 1, 0, 1, 'x'))],
		});
		assert.strictEqual(nodes.length, 1);
		assert.strictEqual(nodes[0].kind, 'kernelStatus');
		if (nodes[0].kind === 'kernelStatus') {
			assert.strictEqual(nodes[0].running, false);
			assert.strictEqual(nodes[0].workbookLabel, 'S0');
			assert.match(nodes[0].label, /not started/);
		}
	});

	test('running kernel, nothing published -> status node + explicit empty node', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [],
		});
		assert.strictEqual(nodes.length, 2);
		assert.strictEqual(nodes[0].kind, 'kernelStatus');
		if (nodes[0].kind === 'kernelStatus') {
			assert.strictEqual(nodes[0].running, true);
			assert.match(nodes[0].label, /running/);
		}
		assert.strictEqual(nodes[1].kind, 'emptyPublished');
	});

	test('running kernel + a single-cell variable -> status + one A1-formatted variable node', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [variable('price', 'S0', range(0, 1, 0, 1, 'price'))],
		});
		assert.strictEqual(nodes.length, 2);
		assert.strictEqual(nodes[0].kind, 'kernelStatus');
		assert.strictEqual(nodes[1].kind, 'variable');
		if (nodes[1].kind === 'variable') {
			assert.strictEqual(nodes[1].name, 'price');
			// 0-based (row 0, col 1) -> 1-based A1 single cell B1, sheet-qualified.
			assert.strictEqual(nodes[1].target, 'S0!B1');
		}
	});

	test('a multi-cell range variable formats as an A1 range target', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [variable('m', 'S0', range(0, 1, 2, 3, 'm'))],
		});
		const varNode = nodes.find((n) => n.kind === 'variable');
		assert.ok(varNode !== undefined && varNode.kind === 'variable');
		assert.strictEqual(varNode.target, 'S0!B1:D3');
	});

	test('variables sort deterministically by (target, name)', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [
				variable('z', 'S0', range(5, 0, 5, 0, 'z')), // A6
				variable('a', 'S0', range(0, 0, 0, 0, 'a')), // A1
				variable('m', 'S1', range(0, 0, 0, 0, 'm')), // S1!A1
			],
		});
		const targets = nodes.filter((n) => n.kind === 'variable').map((n) => (n.kind === 'variable' ? n.target : ''));
		// "S0!A1" < "S0!A6" < "S1!A1" lexicographically.
		assert.deepStrictEqual(targets, ['S0!A1', 'S0!A6', 'S1!A1']);
	});

	test('two variables driving DIFFERENT sheets both appear with their sheet-qualified targets', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [
				variable('onZero', 'S0', range(0, 0, 0, 0, 'onZero')),
				variable('onOne', 'S1', range(1, 1, 1, 1, 'onOne')),
			],
		});
		const byName = new Map(
			nodes.filter((n) => n.kind === 'variable').map((n) => (n.kind === 'variable' ? [n.name, n.target] : ['', ''])),
		);
		assert.strictEqual(byName.get('onZero'), 'S0!A1');
		assert.strictEqual(byName.get('onOne'), 'S1!B2');
	});

	test('node ids are stable + unique per (name, target)', () => {
		const nodes = buildLivePythonNodes({
			focusedWorkbookLabel: 'S0',
			kernelRunning: true,
			publishedVariables: [
				variable('a', 'S0', range(0, 0, 0, 0, 'a')),
				variable('b', 'S0', range(0, 1, 0, 1, 'b')),
			],
		});
		const ids = nodes.map((n) => n.id);
		assert.strictEqual(new Set(ids).size, ids.length, 'all node ids are distinct');
	});
});

suite('FE-5 Live-Python focused-workbook assembly', () => {
	const sheets: SheetHandle[] = [
		{ id: 0, name: 'S0' },
		{ id: 1, name: 'S1' },
		{ id: 2, name: 'S2' },
	];

	test('focusedWorkbookLabel returns the focused sheet name', () => {
		assert.strictEqual(focusedWorkbookLabel(sheets, 1), 'S1');
	});

	test('focusedWorkbookLabel surfaces an out-of-band sheet deletion EXPLICITLY (no fabrication)', () => {
		// The focused sheet was deleted out from under the open grid -> the label must NOT masquerade as a
		// live sheet (No-Fallbacks). It names the id and marks it deleted.
		assert.strictEqual(focusedWorkbookLabel(sheets, 9), 'Sheet 9 (deleted)');
	});

	test('assemblePublishedVariables enumerates EVERY sheet and uses each sheet\'s own name', () => {
		const bySheet = new Map<number, PublishedRange[]>([
			[0, [range(0, 0, 0, 0, 'a')]],
			[2, [range(1, 1, 1, 1, 'c')]],
			// sheet 1 has nothing published -> contributes no variable
		]);
		const vars = assemblePublishedVariables(sheets, (id) => bySheet.get(id) ?? []);
		assert.strictEqual(vars.length, 2);
		const byName = new Map(vars.map((v) => [v.name, v.sheetName]));
		assert.strictEqual(byName.get('a'), 'S0');
		assert.strictEqual(byName.get('c'), 'S2', 'the range on sheet 2 is paired with S2, not S0');
	});

	test('assemblePublishedVariables returns [] when no sheet publishes anything', () => {
		const vars = assemblePublishedVariables(sheets, () => []);
		assert.deepStrictEqual(vars, []);
	});

	test('assemblePublishedVariables preserves the published range coordinates verbatim', () => {
		const r = range(0, 1, 2, 3, 'm');
		const vars = assemblePublishedVariables([{ id: 0, name: 'S0' }], (id) => (id === 0 ? [r] : []));
		assert.strictEqual(vars.length, 1);
		assert.deepStrictEqual(vars[0].range, r);
		assert.strictEqual(vars[0].sheetName, 'S0');
	});
});
