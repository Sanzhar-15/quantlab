/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 (Wave 3, 2026-06-09) -- unit tests for the vscode-free data-vscode-context payload builder used by
// the Cell Grid right-click context menu. The webview sets the JSON these produce on the canvas on every
// contextmenu event; VS Code reads it to decide which menus["webview/context"] items show. The event
// wiring (hit-test, attribute write) is operator smoke; this pins the payload SHAPE the package.json
// `when` clauses + the host commands depend on.

import * as assert from 'assert';

import {
	CELL_GRID_CONTEXT_SECTION,
	buildCellContextPayload,
	buildEmptyContextPayload,
} from '../webview/sheets-webview/contextMenuPayload';

const SEL = { anchorRow: 3, anchorCol: 2, focusRow: 5, focusCol: 4 };
const TOKEN = 'wv-abc-123';

suite('W3 contextMenuPayload -- buildCellContextPayload', () => {
	test('carries the section, panel token, authoritative selection, cell, and flags', () => {
		const parsed = JSON.parse(buildCellContextPayload({ row: 4, col: 7 }, SEL, TOKEN, true));
		assert.strictEqual(parsed.webviewSection, CELL_GRID_CONTEXT_SECTION);
		assert.strictEqual(parsed.webviewSection, 'quantbook-grid-cell');
		assert.strictEqual(parsed.preventDefaultContextMenuItems, true);
		assert.strictEqual(parsed.quantbookGridCell, true);
		assert.strictEqual(parsed.panelToken, TOKEN);
		assert.deepStrictEqual(parsed.selection, SEL);
		assert.strictEqual(parsed.hasSelection, true);
		assert.deepStrictEqual(parsed.cell, { row: 4, col: 7 });
	});

	test('hasSelection=false for a single-cell selection; selection still present (collapsed)', () => {
		const collapsed = { anchorRow: 0, anchorCol: 0, focusRow: 0, focusCol: 0 };
		const parsed = JSON.parse(buildCellContextPayload({ row: 0, col: 0 }, collapsed, TOKEN, false));
		assert.strictEqual(parsed.hasSelection, false);
		assert.deepStrictEqual(parsed.selection, collapsed);
		assert.deepStrictEqual(parsed.cell, { row: 0, col: 0 });
	});

	test('is valid JSON (the attribute is consumed by VS Code as a JSON string)', () => {
		assert.doesNotThrow(() => JSON.parse(buildCellContextPayload({ row: 2, col: 3 }, SEL, TOKEN, true)));
	});

	test('emits exactly the expected keys (no leakage)', () => {
		const parsed = JSON.parse(buildCellContextPayload({ row: 9, col: 9 }, SEL, TOKEN, false));
		assert.deepStrictEqual(Object.keys(parsed).sort(), [
			'cell', 'hasSelection', 'panelToken', 'preventDefaultContextMenuItems', 'quantbookGridCell', 'selection', 'webviewSection',
		]);
	});
});

suite('W3 contextMenuPayload -- buildEmptyContextPayload', () => {
	test('suppresses default items but tags NO quantbook section (off-grid right-click shows no grid items)', () => {
		const parsed = JSON.parse(buildEmptyContextPayload());
		assert.strictEqual(parsed.preventDefaultContextMenuItems, true);
		assert.strictEqual(parsed.webviewSection, undefined);
		assert.strictEqual(parsed.quantbookGridCell, undefined);
		assert.strictEqual(parsed.cell, undefined);
	});

	test('is valid JSON', () => {
		assert.doesNotThrow(() => JSON.parse(buildEmptyContextPayload()));
	});
});
