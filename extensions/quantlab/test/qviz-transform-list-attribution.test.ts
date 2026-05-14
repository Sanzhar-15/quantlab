/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 2 V2 (2026-05-14): jsdom tests for the transform-card
 * produces/drops chip row rendered by `mountTransformList`.
 *
 * Behaviors covered:
 *   - Card renders chip row only when attribution is fresh AND
 *     non-empty for that index.
 *   - Filter / sort / limit / no-op transforms get no chip row.
 *   - Drops > DROPS_VISIBLE_CAP (5) collapse into a "+N more" chip
 *     carrying the full list in its title attribute.
 *   - Stale-attribution gate: when
 *     `state.query.lastData.specHash !== state.spec.currentHash`,
 *     the chip row is suppressed.
 *   - `data-transform-index` attribute is set on every card so the
 *     encoding-shelf badge can scroll to it.
 *
 * Also covers `findColumnDrop` helper semantics.
 */

import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import { mountTransformList } from '../webview/qviz/components/transformList';
import { findColumnDrop } from '../webview/qviz/util/attribution';
import { createStore } from '../webview/qviz/state/store';
import type { QvizSpec, Transform } from '../src/qviz/spec';
import type { TransformAttribution } from '../src/qviz/messageProtocol';

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

function specWith(transforms: readonly Transform[]): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms,
		chart: {
			family: 'general',
			type: 'scatter',
			encodings: {
				x: { field: 'date', type: 'temporal' },
				y: { field: 'close', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-14T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
		},
	};
}

/** Stage a store with `init` + a `dataReceived` carrying the given
 *  attribution. requestStarted+dataReceived ensures the inflight gate
 *  in queryState lets the payload land. */
function stageStore(transforms: readonly Transform[], attribution: readonly TransformAttribution[]): ReturnType<typeof createStore> {
	const store = createStore();
	const spec = specWith(transforms);
	store.dispatch({ type: 'init', fsPath: '/x.qviz.json', spec });
	const sh = store.getState().spec.currentHash!;
	store.dispatch({ type: 'requestStarted', requestId: 1, specHash: sh });
	store.dispatch({
		type: 'dataReceived', requestId: 1, specHash: sh,
		arrow: new Uint8Array(), elapsedMs: 0, cached: false, diagnostics: [],
		attribution,
	});
	return store;
}

suite('findColumnDrop helper', () => {

	test('returns null for absent attribution', () => {
		assert.strictEqual(findColumnDrop('close', null), null);
		assert.strictEqual(findColumnDrop('close', undefined), null);
		assert.strictEqual(findColumnDrop('close', []), null);
	});

	test('returns null when column was never dropped', () => {
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['open', 'high', 'low'],
				availableAfter: ['date', 'close', 'mean_close'] },
		];
		assert.strictEqual(findColumnDrop('volume', attr), null);
	});

	test('returns {index, kind} for the first dropping transform', () => {
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['a', 'b'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		assert.deepStrictEqual(findColumnDrop('close', attr),
			{ index: 1, kind: 'aggregate' });
	});

	test('first-drop-wins on re-introduce + drop again', () => {
		const attr: TransformAttribution[] = [
			{ index: 0, kind: 'window', produces: ['sma'], drops: [],
				availableAfter: ['date', 'close', 'sma'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_sma'], drops: ['close', 'sma'],
				availableAfter: ['date', 'mean_sma'] },
			{ index: 2, kind: 'expr', produces: ['sma'], drops: [],
				availableAfter: ['date', 'mean_sma', 'sma'] },
			{ index: 3, kind: 'aggregate',
				produces: ['avg_sma'], drops: ['mean_sma', 'sma'],
				availableAfter: ['date', 'avg_sma'] },
		];
		assert.deepStrictEqual(findColumnDrop('sma', attr),
			{ index: 1, kind: 'aggregate' });
	});

});

suite('transform-list chip row -- Front 2 V2', () => {
	setup(() => { resetDom(); });

	test('card with no attribution: no chip row, no data-transform-index missing', () => {
		const root = mkRoot();
		const store = createStore();
		store.dispatch({
			type: 'init', fsPath: '/x.qviz.json',
			spec: specWith([{ kind: 'filter', column: 'close', op: '>', value: 100 }]),
		});
		const handle = mountTransformList(root, store);

		const card = root.querySelector('.qviz-transform-card');
		assert.ok(card, 'card rendered');
		assert.strictEqual((card as HTMLElement).dataset.transformIndex, '0',
			'data-transform-index always present for click-to-scroll');
		const chipRow = card!.querySelector('.qviz-form-attribution');
		assert.strictEqual(chipRow, null, 'no attribution => no chip row');

		handle.dispose();
	});

	test('card with empty produces/drops (filter): no chip row', () => {
		const root = mkRoot();
		const store = stageStore(
			[{ kind: 'filter', column: 'close', op: '>', value: 100 }],
			[{ index: 0, kind: 'filter', produces: [], drops: [],
				availableAfter: ['date', 'open', 'high', 'low', 'close'] }],
		);
		const handle = mountTransformList(root, store);

		const card = root.querySelector('.qviz-transform-card');
		const chipRow = card!.querySelector('.qviz-form-attribution');
		assert.strictEqual(chipRow, null,
			'no-op transform (no produces, no drops) -> no chip row');

		handle.dispose();
	});

	test('card with produces only (window): single Produces section', () => {
		const root = mkRoot();
		const store = stageStore(
			[{ kind: 'window', column: 'close', fn: 'rolling_mean',
				window: 3, order_by: 'date', as: 'sma' }],
			[{ index: 0, kind: 'window', produces: ['sma'], drops: [],
				availableAfter: ['date', 'close', 'sma'] }],
		);
		const handle = mountTransformList(root, store);

		const chipRow = root.querySelector('.qviz-form-attribution');
		assert.ok(chipRow, 'chip row mounted');
		const sections = chipRow!.querySelectorAll('.qviz-form-attribution-section');
		assert.strictEqual(sections.length, 1, 'only Produces section');
		assert.match(sections[0].textContent!, /Produces:/);
		const chips = chipRow!.querySelectorAll('.qviz-form-attribution-chip');
		assert.strictEqual(chips.length, 1);
		assert.strictEqual(chips[0].textContent, 'sma');

		handle.dispose();
	});

	test('card with drops only: single Drops section', () => {
		// Synthetic case -- aggregate with only ['date'] groupby is the
		// nearest real shape, but contrived. For test purposes use a
		// hand-crafted record.
		const root = mkRoot();
		const store = stageStore(
			[{ kind: 'filter', column: 'close', op: '>', value: 100 }],
			[{ index: 0, kind: 'filter', produces: [], drops: ['intermediate'],
				availableAfter: ['date', 'close'] }],
		);
		const handle = mountTransformList(root, store);

		const chipRow = root.querySelector('.qviz-form-attribution');
		assert.ok(chipRow);
		const sections = chipRow!.querySelectorAll('.qviz-form-attribution-section');
		assert.strictEqual(sections.length, 1);
		assert.match(sections[0].textContent!, /Drops:/);

		handle.dispose();
	});

	test('card with both (aggregate): Produces + Drops sections', () => {
		const root = mkRoot();
		const store = stageStore(
			[
				{ kind: 'groupby', columns: ['date'] },
				{ kind: 'aggregate', aggs: [
					{ column: 'close', fn: 'mean', as: 'mean_close' },
				] },
			],
			[
				{ index: 0, kind: 'groupby', produces: [], drops: [],
					availableAfter: ['date', 'close'] },
				{ index: 1, kind: 'aggregate',
					produces: ['mean_close'], drops: ['close', 'open', 'high', 'low'],
					availableAfter: ['date', 'mean_close'] },
			],
		);
		const handle = mountTransformList(root, store);

		const cards = root.querySelectorAll('.qviz-transform-card');
		assert.strictEqual(cards.length, 2);
		// groupby is no-op -> no chip row
		assert.strictEqual(cards[0].querySelector('.qviz-form-attribution'), null);
		// aggregate has both
		const aggRow = cards[1].querySelector('.qviz-form-attribution');
		assert.ok(aggRow);
		const sections = aggRow!.querySelectorAll('.qviz-form-attribution-section');
		assert.strictEqual(sections.length, 2);
		const labels = Array.from(sections).map(s =>
			s.querySelector('.qviz-form-attribution-label')!.textContent);
		assert.deepStrictEqual(labels, ['Produces: ', 'Drops: ']);

		handle.dispose();
	});

	test('drops > 5 collapse into "+N more" with title carrying full list', () => {
		const dropped = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
		const root = mkRoot();
		const store = stageStore(
			[{ kind: 'aggregate', aggs: [
				{ column: 'c1', fn: 'count', as: 'n' },
			] }],
			[{ index: 0, kind: 'aggregate', produces: ['n'], drops: dropped,
				availableAfter: ['n'] }],
		);
		const handle = mountTransformList(root, store);

		const dropSection = root.querySelectorAll('.qviz-form-attribution-section')[1];
		const chips = dropSection.querySelectorAll('.qviz-form-attribution-chip');
		// 5 visible + 1 "+N more" = 6
		assert.strictEqual(chips.length, 6);
		const more = dropSection.querySelector('.qviz-form-attribution-chip--more');
		assert.ok(more, '+N more chip rendered');
		assert.strictEqual(more!.textContent, '+2 more');
		// Title carries the overflow list.
		assert.strictEqual((more as HTMLElement).title, 'c6, c7');

		handle.dispose();
	});

	test('stale attribution: lastData.specHash != currentHash hides chip row', () => {
		// Stage attribution, then edit the spec so the hash diverges.
		// The next render must NOT show chips because the attribution
		// belongs to the prior spec.
		const root = mkRoot();
		const store = stageStore(
			[
				{ kind: 'aggregate', aggs: [
					{ column: 'close', fn: 'mean', as: 'mean_close' },
				] },
			],
			[
				{ index: 0, kind: 'aggregate',
					produces: ['mean_close'], drops: ['close', 'open', 'high', 'low'],
					availableAfter: ['date', 'mean_close'] },
			],
		);
		// Sanity: chips are visible BEFORE the spec edit.
		const handle = mountTransformList(root, store);
		assert.ok(root.querySelector('.qviz-form-attribution'),
			'chips visible against fresh attribution');
		// User edits the spec: insert a filter before the aggregate.
		// (upsertTransform at index 0 INSERTS by repurposing the slot;
		// our test setup with one transform means index 0 *appends* is
		// out of bounds. Instead use upsertTransform on the existing
		// aggregate to mutate it -- that advances spec.currentHash.)
		store.dispatch({
			type: 'upsertTransform', index: 0,
			transform: { kind: 'aggregate', aggs: [
				{ column: 'volume', fn: 'sum', as: 'total_volume' },
			] },
		});
		// Now spec.currentHash !== lastData.specHash.
		assert.notStrictEqual(
			store.getState().spec.currentHash,
			store.getState().query.lastData!.specHash,
			'spec edit must have advanced the hash',
		);
		// Renderer re-runs; chips must hide.
		const chipsAfter = root.querySelector('.qviz-form-attribution');
		assert.strictEqual(chipsAfter, null,
			'stale attribution must NOT render chips');

		handle.dispose();
	});

	test('every card has data-transform-index for click-to-scroll', () => {
		const root = mkRoot();
		const store = stageStore(
			[
				{ kind: 'filter', column: 'close', op: '>', value: 0 },
				{ kind: 'groupby', columns: ['date'] },
				{ kind: 'aggregate', aggs: [
					{ column: 'close', fn: 'mean', as: 'mc' },
				] },
			],
			[
				{ index: 0, kind: 'filter', produces: [], drops: [],
					availableAfter: ['date', 'close'] },
				{ index: 1, kind: 'groupby', produces: [], drops: [],
					availableAfter: ['date', 'close'] },
				{ index: 2, kind: 'aggregate', produces: ['mc'], drops: ['close'],
					availableAfter: ['date', 'mc'] },
			],
		);
		const handle = mountTransformList(root, store);

		const cards = Array.from(root.querySelectorAll<HTMLElement>('.qviz-transform-card'));
		assert.strictEqual(cards.length, 3);
		assert.deepStrictEqual(
			cards.map(c => c.dataset.transformIndex),
			['0', '1', '2'],
		);

		handle.dispose();
	});

});
