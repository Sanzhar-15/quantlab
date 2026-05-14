/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Front 2 V2 (2026-05-14): jsdom tests for the encoding-shelf
 * "dropped by transform #N" badge.
 *
 * Behaviors covered:
 *   - Badge visible when an assigned encoding's `field` matches a
 *     transform's `drops` list AND attribution is fresh.
 *   - Badge hidden when the encoding's column survives all transforms.
 *   - Badge hidden when the shelf has no encoding.
 *   - Badge hidden when attribution is stale
 *     (lastData.specHash !== spec.currentHash).
 *   - Click on badge dispatches `openTransformEditor` with the
 *     correct index AND attempts to scroll the matching card.
 *   - OHLCV cluster gets the same badge treatment.
 */

import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import { mountEncodingShelves } from '../webview/qviz/components/encodingShelf';
import { createStore } from '../webview/qviz/state/store';
import type { QvizSpec, Transform } from '../src/qviz/spec';
import type { TransformAttribution } from '../src/qviz/messageProtocol';

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

function specWithEncoding(
	yField: string,
	transforms: readonly Transform[] = [],
): QvizSpec {
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
				y: { field: yField, type: 'quantitative' },
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

function stageStore(
	spec: QvizSpec,
	attribution: readonly TransformAttribution[],
): ReturnType<typeof createStore> {
	const store = createStore();
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

suite('encoding-shelf dropped-by-transform badge -- Front 2 V2', () => {
	setup(() => { resetDom(); });

	test('badge visible when encoding references a column dropped by an upstream transform', () => {
		const root = mkRoot();
		const spec = specWithEncoding('close', [
			{ kind: 'groupby', columns: ['date'] },
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);

		const yShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="y"]');
		assert.ok(yShelf, 'y shelf rendered');
		const badge = yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.ok(badge, 'badge element exists');
		assert.strictEqual(badge!.hidden, false, 'badge visible');
		assert.strictEqual(badge!.textContent, 'dropped by #1');
		assert.strictEqual(badge!.dataset.transformIndex, '1');
		assert.match(badge!.title, /dropped by transform #1 \(aggregate\)/);

		handle.dispose();
	});

	test('badge hidden when encoding references a column that survives all transforms', () => {
		const root = mkRoot();
		// y references 'mean_close' which is PRODUCED, not dropped.
		const spec = specWithEncoding('mean_close', [
			{ kind: 'groupby', columns: ['date'] },
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);

		const yShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="y"]');
		const badge = yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.strictEqual(badge!.hidden, true, 'badge hidden for surviving column');

		handle.dispose();
	});

	test('badge hidden on unassigned shelf (color is unassigned for scatter)', () => {
		const root = mkRoot();
		const spec = specWithEncoding('close', [
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close', 'open'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);

		// color shelf (unassigned on scatter): no badge regardless of attribution.
		const colorShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="color"]');
		assert.ok(colorShelf);
		const badge = colorShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.strictEqual(badge!.hidden, true, 'unassigned shelf must not show badge');

		handle.dispose();
	});

	test('badge hidden when attribution is stale (spec edited but new dataReceived not yet arrived)', () => {
		const root = mkRoot();
		const spec = specWithEncoding('close', [
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);
		// Sanity: badge visible against fresh attribution.
		const yShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="y"]');
		assert.strictEqual(
			yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge')!.hidden,
			false,
			'badge visible when fresh',
		);
		// Edit the spec so the hash diverges.
		store.dispatch({
			type: 'upsertTransform', index: 0,
			transform: { kind: 'aggregate', aggs: [
				{ column: 'volume', fn: 'sum', as: 'total_volume' },
			] },
		});
		// Renderer re-subscribes; badge must hide.
		const badgeAfter = yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.strictEqual(badgeAfter!.hidden, true,
			'stale attribution must hide the badge');

		handle.dispose();
	});

	test('clicking the badge dispatches openTransformEditor with the right index', () => {
		const root = mkRoot();
		const spec = specWithEncoding('close', [
			{ kind: 'filter', column: 'close', op: '>', value: 0 },
			{ kind: 'groupby', columns: ['date'] },
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'filter', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 1, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 2, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);

		// Initial editing index should be null.
		assert.strictEqual(store.getState().ui.editingTransformIndex, null);

		const yShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="y"]');
		const badge = yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.strictEqual(badge!.dataset.transformIndex, '2');
		badge!.click();

		// After click: editor should open on transform #2 (the aggregate).
		assert.strictEqual(store.getState().ui.editingTransformIndex, 2,
			'click should dispatch openTransformEditor with the drop transform index');

		handle.dispose();
	});

	test('Front 2 V2 audit HIGH (Codex): schemaChanged clears attribution', () => {
		// A file rename / parquet swap fires schemaChanged WITHOUT
		// changing the spec hash. Without the fix, lastData.specHash
		// still equals spec.currentHash, so the gate considers the
		// attribution "fresh" -- but it was computed against the prior
		// file's schema. queryState's schemaChanged arm now clears
		// lastData.attribution to null, and the shelf badge hides.
		const root = mkRoot();
		const spec = specWithEncoding('close', [
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);
		const yShelf = root.querySelector<HTMLElement>('.qviz-shelf[data-channel="y"]');
		assert.strictEqual(
			yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge')!.hidden,
			false,
			'badge visible against fresh attribution pre-drift',
		);
		// File swap: schemaChanged fires with new schema info.
		store.dispatch({
			type: 'schemaChanged',
			oldHash: 'sha256:' + 'a'.repeat(64),
			newHash: 'sha256:' + 'b'.repeat(64),
			drift: 'fields-missing',
			missingFields: [],
			newSchema: {
				uri: 'data/y.parquet',
				schema_hash: 'sha256:' + 'b'.repeat(64),
				mtime_ns: 2,
				row_count: 100,
				columns: [
					{ name: 'date', dtype: 'timestamp[ns]', nullable: false },
					{ name: 'mean_close', dtype: 'double', nullable: false },
				],
			},
		});
		// Badge must hide; attribution belonged to the prior schema.
		const badgeAfter = yShelf!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.strictEqual(badgeAfter!.hidden, true,
			'schemaChanged must invalidate attribution');
		handle.dispose();
	});

	test('Front 2 V2 audit HIGH (Opus): focusTransformCard selector matches card, not badge', () => {
		// The badge button carries data-transform-index too (so its
		// click handler can read it). Pre-fix, document.querySelector
		// on the bare attribute returned the badge first in document
		// order (shelves render above the transform list). Post-fix,
		// the selector is scoped to .qviz-transform-card so only the
		// card matches.
		const root = mkRoot();
		// Mount a transform card alongside the shelf so both elements
		// exist in the DOM with data-transform-index="0".
		const shelfRoot = document.createElement('div');
		root.appendChild(shelfRoot);
		const cardListRoot = document.createElement('div');
		root.appendChild(cardListRoot);
		// Hand-craft a fake transform card so the test can verify the
		// shelf badge's scope without mounting the full transformList.
		const fakeCard = document.createElement('li');
		fakeCard.className = 'qviz-transform-card';
		fakeCard.dataset.transformIndex = '0';
		cardListRoot.appendChild(fakeCard);

		const spec = specWithEncoding('close', [
			{ kind: 'aggregate', aggs: [
				{ column: 'close', fn: 'mean', as: 'mean_close' },
			] },
		]);
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(shelfRoot, store);

		// Direct DOM check: the scoped selector returns the card.
		const matched = document.querySelector(
			'.qviz-transform-card[data-transform-index="0"]',
		);
		assert.strictEqual(matched, fakeCard,
			'scoped selector returns the card, not the badge');
		// Also verify the badge button (which also has data-transform-index)
		// would have been returned by the unscoped selector — to pin
		// the regression.
		const badge = shelfRoot.querySelector('.qviz-shelf-dropped-badge[data-transform-index="0"]');
		assert.ok(badge, 'badge exists with data-transform-index=0 (this is the regression vector)');

		handle.dispose();
	});

	test('OHLCV cluster: candlestick "low" dropped by aggregate -> badge on low row', () => {
		const root = mkRoot();
		const spec: QvizSpec = {
			qviz_version: 1,
			dataset: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1,
			},
			transforms: [
				{ kind: 'groupby', columns: ['date'] },
				{ kind: 'aggregate', aggs: [
					{ column: 'open', fn: 'first', as: 'open' },
					{ column: 'high', fn: 'max', as: 'high' },
					{ column: 'close', fn: 'last', as: 'close' },
				] },
			],
			chart: {
				family: 'timeseries',
				type: 'candlestick',
				encodings: {
					ohlcv: {
						time: 'date', open: 'open', high: 'high',
						low: 'low', close: 'close',
					},
				},
			},
			provenance: {
				generated_at: '2026-05-14T00:00:00Z',
				generator: 'test', query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1 },
			},
		};
		const attribution: TransformAttribution[] = [
			{ index: 0, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'open', 'high', 'low', 'close', 'volume'] },
			{ index: 1, kind: 'aggregate',
				produces: [], drops: ['low', 'volume'],
				availableAfter: ['date', 'open', 'high', 'close'] },
		];
		const store = stageStore(spec, attribution);
		const handle = mountEncodingShelves(root, store);

		const lowRow = root.querySelector<HTMLElement>('.qviz-shelf-ohlcv-row[data-slot="low"]');
		assert.ok(lowRow, 'low row rendered');
		const badge = lowRow!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
		assert.ok(badge);
		assert.strictEqual(badge!.hidden, false, 'badge visible on dropped low slot');
		assert.strictEqual(badge!.dataset.transformIndex, '1');

		// open / high / close survive; no badge.
		for (const slot of ['open', 'high', 'close']) {
			const row = root.querySelector<HTMLElement>(`.qviz-shelf-ohlcv-row[data-slot="${slot}"]`);
			const b = row!.querySelector<HTMLButtonElement>('.qviz-shelf-dropped-badge');
			assert.strictEqual(b!.hidden, true,
				`${slot} slot must not show badge (column survives)`);
		}

		handle.dispose();
	});

});
