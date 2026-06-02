/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-0b-1 (2026-06-02) -- unit tests for the bundled sheets-webview pure render
 * helpers (`webview/sheets-webview/cellRender.ts`). In the FE-0b model these are
 * the SOLE renderer (the host posts the raw snapshot; all rendering is
 * client-side), so this suite is the correctness pin the old server/client
 * mirror drift hazard used to need two copies for.
 *
 * Pure functions -- no vscode, no DOM -- so they import + run under plain mocha.
 */

import * as assert from 'assert';

import { computeVisibleRowRange, escapeHtml, formatCellValue, renderRowsHtml, type CellSnapshotEntry } from '../webview/sheets-webview/cellRender';

suite('FE-0b-1 sheets-webview cellRender -- formatCellValue', function () {
	test('number renders its String() form', () => {
		assert.strictEqual(formatCellValue({ kind: 'number', value: 42 }), '42');
		assert.strictEqual(formatCellValue({ kind: 'number', value: -3.5 }), '-3.5');
	});
	test('boolean renders TRUE / FALSE', () => {
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: true }), 'TRUE');
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: false }), 'FALSE');
	});
	test('text renders verbatim; error renders its code; pending is (pending)', () => {
		assert.strictEqual(formatCellValue({ kind: 'text', value: 'hello' }), 'hello');
		assert.strictEqual(formatCellValue({ kind: 'error', value: '#DIV/0!' }), '#DIV/0!');
		assert.strictEqual(formatCellValue({ kind: 'pending' }), '(pending)');
	});
});

suite('FE-0b-1 sheets-webview cellRender -- escapeHtml', function () {
	test('escapes the five HTML-significant characters', () => {
		assert.strictEqual(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
	});
});

suite('FE-0b-1 sheets-webview cellRender -- computeVisibleRowRange', function () {
	test('empty table -> [0,0)', () => {
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 0, 25, 5), { startIdx: 0, endIdx: 0 });
	});
	test('non-positive rowHeight -> whole table (avoids div-by-zero)', () => {
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 100, 0, 5), { startIdx: 0, endIdx: 100 });
	});
	test('top of a tall table windows with overscan', () => {
		// firstVisible=0, visibleCount=ceil(100/25)=4, start=0, end=min(100, 0+4+5)=9
		assert.deepStrictEqual(computeVisibleRowRange(0, 100, 100, 25, 5), { startIdx: 0, endIdx: 9 });
	});
	test('scrolled mid-table windows around the visible rows', () => {
		// scrollTop=250 -> firstVisible=10; start=10-5=5; end=10+4+5=19
		assert.deepStrictEqual(computeVisibleRowRange(250, 100, 100, 25, 5), { startIdx: 5, endIdx: 19 });
	});
	test('endIdx clamps to totalRows near the bottom', () => {
		// firstVisible=floor(2400/25)=96 (< totalRows-1=99, so unclamped); end=min(100, 96+4+5)=100; start=91
		assert.deepStrictEqual(computeVisibleRowRange(2400, 100, 100, 25, 5), { startIdx: 91, endIdx: 100 });
	});
	test('stale large scrollTop after the data SHRINKS clamps to the last rows (no blank grid)', () => {
		// Persistent viewport kept scrollTop=2400 (was ~100 rows) but the data
		// shrank to 10 rows. Without the firstVisible clamp this returned {91,10}
		// -> slice(91,10)=[] + a 2275px top spacer = blank grid. With the clamp:
		// maxFirst=9, firstVisible=min(9,96)=9, start=4, end=min(10, 9+4+5)=10.
		const r = computeVisibleRowRange(2400, 100, 10, 25, 5);
		assert.deepStrictEqual(r, { startIdx: 4, endIdx: 10 });
		assert.ok(r.startIdx <= r.endIdx, 'startIdx never exceeds endIdx');
		assert.ok(r.endIdx - r.startIdx > 0, 'window is non-empty -> grid is not blank');
	});
});

suite('FE-0b-1 sheets-webview cellRender -- renderRowsHtml', function () {
	test('renders row/col cells with the click-to-edit data-* contract', () => {
		const entries: CellSnapshotEntry[] = [{ row: 3, col: 1, value: { kind: 'number', value: 42 } }];
		const html = renderRowsHtml(entries);
		assert.ok(html.includes('<td>3</td><td>1</td>'), 'row/col header cells');
		assert.ok(html.includes('class="cell-value"'), 'cell-value hit-test class');
		assert.ok(html.includes('data-row="3"'), 'data-row');
		assert.ok(html.includes('data-col="1"'), 'data-col');
		assert.ok(html.includes('data-raw-value="42"'), 'data-raw-value = parseable literal');
		assert.ok(html.includes('data-original-kind="number"'), 'data-original-kind');
		assert.ok(html.includes('<span class="kind">[number]</span>'), 'kind annotation');
		assert.ok(!html.includes('data-raw-formula'), 'no formula attr for a pure literal');
	});

	test('HTML-escapes cell text (no injection past the renderer)', () => {
		const entries: CellSnapshotEntry[] = [{ row: 0, col: 0, value: { kind: 'text', value: '<script>x</script>' } }];
		const html = renderRowsHtml(entries);
		assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'text is escaped');
		assert.ok(!html.includes('<script>x</script>'), 'no raw script tag survives');
	});

	test('display uses engine-rendered string but raw-value stays the parseable literal', () => {
		const entries: CellSnapshotEntry[] = [{ row: 1, col: 2, value: { kind: 'number', value: 1234 }, rendered: '$1,234' }];
		const html = renderRowsHtml(entries);
		assert.ok(html.includes('data-original-text="$1,234"'), 'display text = engine-rendered');
		assert.ok(html.includes('data-raw-value="1234"'), 'raw value = value-default (editable literal)');
		assert.ok(html.includes('>$1,234<span class="kind">'), 'visible text = engine-rendered');
	});

	test('formula cells emit data-raw-formula (the edit precedence source)', () => {
		const entries: CellSnapshotEntry[] = [{ row: 0, col: 0, value: { kind: 'number', value: 42 }, formula: 'A1*2' }];
		const html = renderRowsHtml(entries);
		assert.ok(html.includes('data-raw-formula="A1*2"'), 'formula attr present');
	});

	test('diagnostic surfaces as an escaped title tooltip', () => {
		const entries: CellSnapshotEntry[] = [{ row: 0, col: 0, value: { kind: 'error', value: '#CALC!' }, diagnostic: 'boom & <fail>' }];
		const html = renderRowsHtml(entries);
		assert.ok(html.includes('title="boom &amp; &lt;fail&gt;"'), 'diagnostic title escaped');
	});
});
