/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 2 (2026-05-14): direct unit tests for the
 * `describeColumnDrop(field, attribution)` helper. The helper produces
 * the " -- dropped by transform #N (kind)" suffix that renderer error
 * messages append when a missing-column error fires.
 *
 * Behaviors covered:
 *   - empty / null / undefined attribution → empty suffix (back-compat)
 *   - first-drop wins for multi-drop chains
 *   - column never dropped → empty suffix
 *   - exact format of the suffix string
 */

import * as assert from 'assert';
import { describeColumnDrop } from '../src/qviz/render/attribution';
import type { TransformAttribution } from '../src/qviz/messageProtocol';

suite('describeColumnDrop', () => {

	test('null attribution returns empty suffix', () => {
		assert.strictEqual(describeColumnDrop('close', null), '');
	});

	test('undefined attribution returns empty suffix', () => {
		assert.strictEqual(describeColumnDrop('close', undefined), '');
	});

	test('empty attribution array returns empty suffix', () => {
		assert.strictEqual(describeColumnDrop('close', []), '');
	});

	test('column not dropped anywhere returns empty suffix (typo case)', () => {
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['open', 'high', 'low', 'close'],
				availableAfter: ['date', 'mean_close'] },
		];
		assert.strictEqual(describeColumnDrop('closepricee_typo', attr), '');
	});

	test('single-drop attribution returns formatted suffix', () => {
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'groupby',
				produces: [], drops: [], availableAfter: ['date', 'close'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['open', 'high', 'low', 'close', 'volume'],
				availableAfter: ['date', 'mean_close'] },
		];
		assert.strictEqual(
			describeColumnDrop('close', attr),
			' -- dropped by transform #1 (aggregate)',
		);
	});

	test('first-drop wins for multi-drop chains', () => {
		// "sma" produced by window at #0, dropped by aggregate at #2,
		// re-introduced as a synthetic alias by a hypothetical #3, dropped
		// again at #4. First-drop attribution cites #2.
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'window',
				produces: ['sma'], drops: [], availableAfter: ['date', 'close', 'sma'] },
			{ index: 1, kind: 'groupby',
				produces: [], drops: [], availableAfter: ['date', 'close', 'sma'] },
			{ index: 2, kind: 'aggregate',
				produces: ['mean_sma'], drops: ['close', 'sma'],
				availableAfter: ['date', 'mean_sma'] },
			{ index: 3, kind: 'expr',
				produces: ['sma'], drops: [], availableAfter: ['date', 'mean_sma', 'sma'] },
			{ index: 4, kind: 'aggregate',
				produces: ['avg_sma'], drops: ['mean_sma', 'sma'],
				availableAfter: ['date', 'avg_sma'] },
		];
		assert.strictEqual(
			describeColumnDrop('sma', attr),
			' -- dropped by transform #2 (aggregate)',
			'first drop in pipeline order wins',
		);
	});

	test('suffix format: index is numeric (not stringified twice), kind is bare', () => {
		const attr: TransformAttribution[] = [
			{ index: 42, kind: 'filter',
				produces: [], drops: ['ghost_col'], availableAfter: [] },
		];
		const s = describeColumnDrop('ghost_col', attr);
		assert.ok(s.includes('#42'), 'index must appear with # prefix');
		assert.ok(s.includes('(filter)'), 'kind must appear in parens');
		assert.ok(s.startsWith(' -- '), 'suffix must start with a separator');
	});

	test('suffix appended cleanly to typical error message (integration shape)', () => {
		const attr: TransformAttribution[] = [
			{ index: 1, kind: 'aggregate',
				produces: ['n'], drops: ['close'], availableAfter: ['date', 'n'] },
		];
		const base = "encodings.y.field='close' not in column data";
		const full = base + describeColumnDrop('close', attr);
		assert.strictEqual(
			full,
			"encodings.y.field='close' not in column data -- dropped by transform #1 (aggregate)",
		);
	});

});
