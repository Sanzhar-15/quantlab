/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Round 5 (2026-06-10) -- unit tests for the pure client-side cell-style model
 * (`webview/sheets-webview/cellStyleModel.ts`). The engine has no cell-style storage, so this
 * webview-owned map is the sole source of bold/italic/underline/strike/align/color styling; the
 * canvas paints from it and the toolbar mutates it. These pin the correctness-critical pure logic the
 * UI depends on: the Excel toggle semantics (off only if ALL on), the giant-selection clamp, and the
 * setState serialize/deserialize round-trip (incl. defensive rejection of a foreign blob).
 */

import * as assert from 'assert';

import { CellStyleStore, MAX_STYLE_CELLS, isEmptyStyle, type StyleRect } from '../webview/sheets-webview/cellStyleModel';

const cell = (row: number, col: number): StyleRect => ({ minRow: row, maxRow: row, minCol: col, maxCol: col });
const rect = (minRow: number, minCol: number, maxRow: number, maxCol: number): StyleRect => ({ minRow, maxRow, minCol, maxCol });

suite('round-5 cellStyleModel -- isEmptyStyle', function () {
	test('an object with no set field is empty', () => {
		assert.strictEqual(isEmptyStyle({}), true);
		assert.strictEqual(isEmptyStyle({ bold: false }), true);
	});
	test('any set field makes it non-empty', () => {
		assert.strictEqual(isEmptyStyle({ bold: true }), false);
		assert.strictEqual(isEmptyStyle({ halign: 'center' }), false);
		assert.strictEqual(isEmptyStyle({ textColor: '#000000' }), false);
	});
});

suite('round-5 cellStyleModel -- toggleBool (Excel semantics)', function () {
	test('toggling on an unstyled cell turns it on', () => {
		const s = new CellStyleStore();
		assert.strictEqual(s.toggleBool(0, cell(1, 1), 'bold'), true);
		assert.strictEqual(s.get(0, 1, 1)?.bold, true);
	});

	test('toggling a fully-on selection turns the WHOLE selection off', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, rect(0, 0, 1, 1), 'bold'); // all 4 cells bold
		assert.strictEqual(s.toggleBool(0, rect(0, 0, 1, 1), 'bold'), false); // now all off
		assert.strictEqual(s.get(0, 0, 0), undefined);
		assert.strictEqual(s.get(0, 1, 1), undefined);
	});

	test('toggling a PARTIALLY-on selection turns the whole selection on (not off)', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, cell(0, 0), 'bold'); // only A1 bold
		assert.strictEqual(s.toggleBool(0, rect(0, 0, 1, 1), 'bold'), true); // partial -> all on
		assert.strictEqual(s.get(0, 1, 1)?.bold, true);
		assert.strictEqual(s.get(0, 0, 0)?.bold, true);
	});

	test('a cell whose last style is toggled off is dropped from the map', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, cell(2, 2), 'italic');
		assert.strictEqual(s.size, 1);
		s.toggleBool(0, cell(2, 2), 'italic');
		assert.strictEqual(s.size, 0, 'an emptied cell must be deleted, not stored as {}');
	});

	test('styles are keyed per sheet (no cross-sheet bleed)', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, cell(1, 1), 'bold');
		assert.strictEqual(s.get(1, 1, 1), undefined, 'sheet 1 must not see sheet 0 styling');
	});
});

suite('round-5 cellStyleModel -- align + color + clear', function () {
	test('setAlign sets and clears', () => {
		const s = new CellStyleStore();
		s.setAlign(0, cell(0, 0), 'right');
		assert.strictEqual(s.get(0, 0, 0)?.halign, 'right');
		s.setAlign(0, cell(0, 0), null);
		assert.strictEqual(s.get(0, 0, 0), undefined);
	});

	test('setColor for text and fill are independent', () => {
		const s = new CellStyleStore();
		s.setColor(0, cell(0, 0), 'fillColor', '#FF7331');
		s.setColor(0, cell(0, 0), 'textColor', '#ffffff');
		assert.strictEqual(s.get(0, 0, 0)?.fillColor, '#FF7331');
		assert.strictEqual(s.get(0, 0, 0)?.textColor, '#ffffff');
		s.setColor(0, cell(0, 0), 'fillColor', null);
		assert.strictEqual(s.get(0, 0, 0)?.fillColor, undefined);
		assert.strictEqual(s.get(0, 0, 0)?.textColor, '#ffffff', 'clearing fill must not touch text color');
	});

	test('clear removes every style in the rect', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, rect(0, 0, 1, 1), 'bold');
		s.clear(0, rect(0, 0, 1, 1));
		assert.strictEqual(s.size, 0);
	});
});

suite('round-5 cellStyleModel -- clampRect (giant-selection guard)', function () {
	test('a within-limit rect is unchanged', () => {
		const r = rect(0, 0, 9, 9); // 100 cells
		const { rect: out, clamped } = CellStyleStore.clampRect(r);
		assert.strictEqual(clamped, false);
		assert.deepStrictEqual(out, r);
	});

	test('a whole-column selection is clamped to <= MAX_STYLE_CELLS, shrinking toward the top', () => {
		const r = rect(0, 0, 1_048_575, 0); // a full column (>1M cells)
		const { rect: out, clamped } = CellStyleStore.clampRect(r);
		assert.strictEqual(clamped, true);
		assert.ok(CellStyleStore.rectCellCount(out) <= MAX_STYLE_CELLS);
		assert.strictEqual(out.minRow, 0, 'clamp keeps the top-left origin');
		assert.strictEqual(out.minCol, 0);
		assert.strictEqual(out.maxCol, 0);
	});
});

suite('round-5 cellStyleModel -- serialize / deserialize', function () {
	test('round-trips a populated store', () => {
		const s = new CellStyleStore();
		s.toggleBool(0, cell(1, 1), 'bold');
		s.setAlign(0, cell(2, 3), 'center');
		s.setColor(0, cell(4, 4), 'fillColor', '#FF7331');
		const restored = CellStyleStore.deserialize(s.serialize());
		assert.strictEqual(restored.get(0, 1, 1)?.bold, true);
		assert.strictEqual(restored.get(0, 2, 3)?.halign, 'center');
		assert.strictEqual(restored.get(0, 4, 4)?.fillColor, '#FF7331');
		assert.strictEqual(restored.size, 3);
	});

	test('deserialize of a foreign / malformed blob yields an empty store (defensive)', () => {
		assert.strictEqual(CellStyleStore.deserialize(null).size, 0);
		assert.strictEqual(CellStyleStore.deserialize({ version: 99, cells: {} }).size, 0);
		assert.strictEqual(CellStyleStore.deserialize('garbage').size, 0);
		assert.strictEqual(CellStyleStore.deserialize({ version: 1, cells: { 'k': 'not-an-object' } }).size, 0);
	});

	test('deserialize sanitizes field types (a bogus halign is dropped, not trusted)', () => {
		const restored = CellStyleStore.deserialize({ version: 1, cells: { '0|0|0': { halign: 'diagonal', bold: 'yes' } } });
		// Neither a bogus halign nor a non-boolean bold survives -> the cell is empty -> not stored.
		assert.strictEqual(restored.size, 0);
	});
});
