/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit HIGH (Codex, 2026-05-14): tests for
 * `stripInspectorFilterAttribution`. The daemon's `op_aggregate`
 * prepends `inspectorFilters` to `spec.transforms` before compile,
 * so the daemon emits attribution indices for the EFFECTIVE list.
 * Without the helper's adjustment, the webview's
 * `attrByIndex.get(i)` would map card #0 to the first inspector
 * filter (not the user's saved transform #0). Shelf badges and chip
 * rows would point at the wrong transform.
 *
 * The helper is pure (no vscode/IO) so we unit-test it directly.
 */

import * as assert from 'assert';

import { stripInspectorFilterAttribution } from '../src/qviz/attributionTransform';
import type { TransformAttribution } from '../src/qviz/messageProtocol';

suite('stripInspectorFilterAttribution -- megaudit HIGH (Codex)', () => {

	test('returns undefined when input is undefined', () => {
		assert.strictEqual(stripInspectorFilterAttribution(undefined, 0), undefined);
		assert.strictEqual(stripInspectorFilterAttribution(undefined, 2), undefined);
	});

	test('returns input unchanged when filterCount=0', () => {
		const input: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const out = stripInspectorFilterAttribution(input, 0);
		assert.strictEqual(out, input,
			'no inspector filters: identity pass-through');
	});

	test('strips N records and subtracts N from each remaining index', () => {
		// Simulating: 2 inspector filters prepended, then user's
		// saved transforms [groupby, aggregate]. Daemon sees 4
		// transforms total, emits attribution indices 0..3.
		const daemonAttribution: TransformAttribution[] = [
			{ index: 0, kind: 'filter', produces: [], drops: [],
				availableAfter: ['date', 'open', 'high', 'low', 'close'] },
			{ index: 1, kind: 'filter', produces: [], drops: [],
				availableAfter: ['date', 'open', 'high', 'low', 'close'] },
			{ index: 2, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 3, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close', 'open', 'high', 'low'],
				availableAfter: ['date', 'mean_close'] },
		];
		const out = stripInspectorFilterAttribution(daemonAttribution, 2);
		assert.strictEqual(out!.length, 2,
			'after strip: 2 records (the saved transforms)');
		// Index 0 is now the user's groupby (was record at array index 2).
		assert.deepStrictEqual(out![0], {
			index: 0, kind: 'groupby', produces: [], drops: [],
			availableAfter: ['date', 'close'],
		});
		// Index 1 is now the user's aggregate.
		assert.deepStrictEqual(out![1], {
			index: 1, kind: 'aggregate',
			produces: ['mean_close'], drops: ['close', 'open', 'high', 'low'],
			availableAfter: ['date', 'mean_close'],
		});
	});

	test('preserves drops/produces/availableAfter content; only mutates index', () => {
		const input: TransformAttribution[] = [
			{ index: 0, kind: 'filter', produces: [], drops: [], availableAfter: ['a', 'b'] },
			{ index: 1, kind: 'aggregate',
				produces: ['x'], drops: ['a', 'b'], availableAfter: ['x'] },
		];
		const out = stripInspectorFilterAttribution(input, 1);
		assert.strictEqual(out!.length, 1);
		// The aggregate record gets its index decremented by 1; arrays untouched.
		assert.strictEqual(out![0].index, 0);
		assert.strictEqual(out![0].kind, 'aggregate');
		assert.deepStrictEqual(out![0].produces, ['x']);
		assert.deepStrictEqual(out![0].drops, ['a', 'b']);
		assert.deepStrictEqual(out![0].availableAfter, ['x']);
	});

	test('defensive: filterCount > attribution.length returns empty array', () => {
		// Malformed: more filters claimed than records present. Should
		// return [] (provider's downstream filter normalizes to absent).
		const input: TransformAttribution[] = [
			{ index: 0, kind: 'filter', produces: [], drops: [], availableAfter: [] },
		];
		const out = stripInspectorFilterAttribution(input, 3);
		assert.deepStrictEqual(out, [],
			'overflow filterCount yields empty array (not negative-index or crash)');
	});

	test('input is not mutated (caller can re-use)', () => {
		const input: TransformAttribution[] = [
			{ index: 0, kind: 'filter', produces: [], drops: [], availableAfter: ['a'] },
			{ index: 1, kind: 'aggregate',
				produces: ['n'], drops: ['a'], availableAfter: ['n'] },
		];
		const inputBefore = JSON.stringify(input);
		void stripInspectorFilterAttribution(input, 1);
		assert.strictEqual(JSON.stringify(input), inputBefore,
			'input attribution must not be mutated; helper returns a new array');
	});

	test('regression pin: webview attrByIndex lookup now resolves correctly', () => {
		// End-to-end semantics: after the helper, calling
		// attrByIndex.get(spec.transforms.indexOf(my_transform)) should
		// return the daemon's attribution record FOR THAT TRANSFORM.
		// Pre-fix: with N inspector filters, attrByIndex.get(0)
		// returned the first inspector filter record, not the user's
		// transform 0.
		const daemonAttribution: TransformAttribution[] = [
			// 1 inspector filter prepended:
			{ index: 0, kind: 'filter', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			// User's saved transforms:
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const stripped = stripInspectorFilterAttribution(daemonAttribution, 1);
		// Webview builds the map:
		const attrByIndex = new Map<number, TransformAttribution>();
		for (const r of stripped!) {
			attrByIndex.set(r.index, r);
		}
		// User's saved spec has ONE transform (the aggregate).
		// spec.transforms.indexOf(aggregate) === 0.
		const recordForFirstSavedTransform = attrByIndex.get(0);
		assert.ok(recordForFirstSavedTransform,
			'card 0 must resolve to a record after the strip');
		assert.strictEqual(recordForFirstSavedTransform!.kind, 'aggregate',
			'card 0 must resolve to the AGGREGATE (the saved transform), '
			+ 'not the prepended FILTER');
	});

});
