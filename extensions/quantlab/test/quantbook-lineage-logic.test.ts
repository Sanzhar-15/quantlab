/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave L2 (R23 SQL->cell lineage) -- pure unit tests for `lineageLogic` (the vscode-free core of the
// "Show Cell Lineage" command). The command (quantbookCommands.ts) is a thin vscode shell over these;
// it resolves the focused cell, calls `session.cellLineage`, and renders the LineagePresentation.
// Runs in the normal mocha suite (no engine, no vscode).

import * as assert from 'assert';
import { formatCellLineage, lineageBlockA1 } from '../src/quantbook/cellGrid/lineageLogic';
import type { CellLineageJson } from '../src/quantbook/types';

// Produced block C1:C2 (sheet 0, rows 0..1, col 2), 2 cells produced.
const queryBlock = (overrides: Partial<CellLineageJson> = {}): CellLineageJson => ({
	sourceId: 'q1',
	kind: 'query',
	revision: 0n,
	sql: 'SELECT A FROM S ORDER BY A',
	producedSheet: 0,
	producedStartRow: 0,
	producedStartCol: 2,
	producedEndRow: 1,
	producedEndCol: 2,
	producedCells: 2,
	...overrides,
});

const publishedBlock = (overrides: Partial<CellLineageJson> = {}): CellLineageJson => ({
	sourceId: 'prices',
	kind: 'published',
	revision: 0n,
	producedSheet: 0,
	producedStartRow: 0,
	producedStartCol: 0,
	producedEndRow: 0,
	producedEndCol: 2,
	producedCells: 3,
	...overrides,
});

suite('Wave L2 lineageLogic -- lineageBlockA1', () => {
	test('1x1 block -> a single cell ref', () => {
		assert.strictEqual(
			lineageBlockA1(queryBlock({ producedStartRow: 0, producedEndRow: 0, producedStartCol: 2, producedEndCol: 2 })),
			'C1',
		);
	});

	test('multi-cell block -> a range ref (top-left:bottom-right)', () => {
		assert.strictEqual(lineageBlockA1(queryBlock()), 'C1:C2');
	});

	test('rectangular block spans rows and columns', () => {
		assert.strictEqual(
			lineageBlockA1(queryBlock({ producedStartRow: 0, producedStartCol: 0, producedEndRow: 3, producedEndCol: 1 })),
			'A1:B4',
		);
	});
});

suite('Wave L2 lineageLogic -- formatCellLineage', () => {
	test('null lineage -> explicit "no lineage" message, no reveal (No-Fallbacks)', () => {
		const p = formatCellLineage(null, 'B7');
		assert.match(p.summary, /B7 has no lineage/);
		assert.strictEqual(p.detail, p.summary);
		assert.strictEqual(p.reveal, undefined);
	});

	test('query cell -> summary names the query + block, detail carries the SQL, reveal = block top-left', () => {
		const p = formatCellLineage(queryBlock(), 'C1');
		assert.strictEqual(p.summary, 'C1: SQL query "q1" -> block C1:C2 (2 cells).');
		assert.ok(p.detail.includes('SELECT A FROM S ORDER BY A'), 'detail must carry the SQL text');
		assert.deepStrictEqual(p.reveal, { sheet: 0, row: 0, col: 2 });
	});

	test('query cell with a single produced cell uses the singular "cell"', () => {
		const p = formatCellLineage(
			queryBlock({ producedEndRow: 0, producedCells: 1 }),
			'C1',
		);
		assert.strictEqual(p.summary, 'C1: SQL query "q1" -> block C1 (1 cell).');
	});

	test('query cell with missing SQL -> a loud "(no SQL recorded)" marker, never "undefined"', () => {
		const p = formatCellLineage(queryBlock({ sql: undefined }), 'C1');
		assert.ok(p.detail.includes('(no SQL recorded)'), 'missing SQL must be marked explicitly');
		assert.ok(!p.detail.includes('undefined'), 'must not leak a literal "undefined"');
	});

	test('query cell with empty-string SQL -> the same loud marker', () => {
		const p = formatCellLineage(queryBlock({ sql: '' }), 'C1');
		assert.ok(p.detail.includes('(no SQL recorded)'));
	});

	test('published cell -> summary names the dataset, detail carries NO SQL, reveal present', () => {
		const p = formatCellLineage(publishedBlock(), 'B1');
		assert.strictEqual(p.summary, 'B1: published dataset "prices" -> block A1:C1 (3 cells).');
		assert.ok(p.detail.startsWith(p.summary), 'detail leads with the summary');
		assert.ok(!p.detail.includes('SQL'), 'published detail must not mention SQL');
		assert.deepStrictEqual(p.reveal, { sheet: 0, row: 0, col: 0 });
	});

	test('published cell with a single produced cell uses the singular "cell"', () => {
		const p = formatCellLineage(
			publishedBlock({ producedEndCol: 0, producedCells: 1 }),
			'A1',
		);
		assert.strictEqual(p.summary, 'A1: published dataset "prices" -> block A1 (1 cell).');
	});

	test('detail reports the lineage revision (advances on refresh) for query and published', () => {
		const q = formatCellLineage(queryBlock({ revision: 3n }), 'C1');
		assert.ok(q.detail.includes('Revision: 3'), 'query detail must report the revision');
		const pub = formatCellLineage(publishedBlock({ revision: 5n }), 'B1');
		assert.ok(pub.detail.includes('Revision: 5'), 'published detail must report the revision');
		// A fresh (revision 0) cell still reports it explicitly -- never omitted.
		assert.ok(formatCellLineage(queryBlock(), 'C1').detail.includes('Revision: 0'));
	});

	test('an unrecognized kind throws -- never silently rendered as a dataset (No-Fallbacks)', () => {
		// The napi boundary delivers a raw string; a future/garbled kind must fail loud.
		const bogus = queryBlock({ kind: 'mystery' as unknown as 'query' });
		assert.throws(() => formatCellLineage(bogus, 'C1'), /unrecognized lineage kind/);
	});
});
