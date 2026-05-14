/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit F1 (2026-05-13): pin the contract of
 * `mapDaemonCapsForInit` — the snake_case (daemon JSON) -> camelCase
 * (webview protocol) capability transform extracted from
 * `VisualiseSpecProvider` to a sibling helper module. Without these
 * tests a future refactor could quietly swap two camel keys
 * (e.g. `previewOffset: !!raw.column_stats`) and every existing test
 * would still pass.
 */

import * as assert from 'assert';

import { mapDaemonCapsForInit } from '../src/qviz/capabilitiesTransform';
import type { DaemonCapabilitiesData } from '../src/qviz/daemon-client';

function baseRaw(): DaemonCapabilitiesData {
	return {
		daemon_version: 7,
		transform_kinds: ['filter', 'aggregate'],
		unsupported: [],
		chart_families: ['timeseries', 'general'],
	};
}

suite('capabilitiesTransform -- mapDaemonCapsForInit', () => {

	test('missing inspector bag is omitted, not normalized to {}', () => {
		const out = mapDaemonCapsForInit(baseRaw());
		assert.strictEqual(out.daemonVersion, 7);
		assert.deepStrictEqual(out.transformKinds, ['filter', 'aggregate']);
		assert.deepStrictEqual(out.chartFamilies, ['timeseries', 'general']);
		// "absent" vs "all-false" is load-bearing for the toggle's
		// disabled state — must not be silently coerced to {}.
		assert.strictEqual(out.inspector, undefined);
	});

	test('all-three flags true round-trip exactly', () => {
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			inspector: {
				preview_offset: true,
				column_stats: true,
				aggregate_filters: true,
			},
		};
		const out = mapDaemonCapsForInit(raw);
		assert.deepStrictEqual(out.inspector, {
			previewOffset: true,
			columnStats: true,
			aggregateFilters: true,
		});
	});

	test('all-three flags false round-trip as explicit false (not undefined)', () => {
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			inspector: {
				preview_offset: false,
				column_stats: false,
				aggregate_filters: false,
			},
		};
		const out = mapDaemonCapsForInit(raw);
		assert.strictEqual(out.inspector?.previewOffset, false);
		assert.strictEqual(out.inspector?.columnStats, false);
		assert.strictEqual(out.inspector?.aggregateFilters, false);
	});

	// Defense against swap bugs (`previewOffset: !!raw.column_stats`):
	// for each individual flag, set it true and confirm exactly the
	// matching camel key fires.
	for (const [snake, camel] of [
		['preview_offset', 'previewOffset'],
		['column_stats', 'columnStats'],
		['aggregate_filters', 'aggregateFilters'],
	] as const) {
		test(`partial-truthy: only ${snake} -> only ${camel}`, () => {
			const raw: DaemonCapabilitiesData = {
				...baseRaw(),
				inspector: {
					preview_offset: false,
					column_stats: false,
					aggregate_filters: false,
					[snake]: true,
				} as unknown as DaemonCapabilitiesData['inspector'],
			};
			const out = mapDaemonCapsForInit(raw);
			const insp = out.inspector!;
			for (const k of ['previewOffset', 'columnStats', 'aggregateFilters'] as const) {
				const expected = k === camel;
				assert.strictEqual(
					insp[k], expected,
					`expected ${k}=${expected} when only ${snake} was true; got ${insp[k]}`,
				);
			}
		});
	}

	test('chart_families filtered to known set (legacy values dropped)', () => {
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			chart_families: ['timeseries', 'general', 'legacy'] as ('timeseries' | 'general')[],
		};
		const out = mapDaemonCapsForInit(raw);
		assert.deepStrictEqual(out.chartFamilies, ['timeseries', 'general']);
	});

	test('chart_families empty array survives + inspector absent stays absent', () => {
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			chart_families: [],
		};
		const out = mapDaemonCapsForInit(raw);
		assert.deepStrictEqual(out.chartFamilies, []);
		assert.strictEqual(out.inspector, undefined);
	});

	test('inspector === null is treated as absent (not a crash, not a coerce)', () => {
		// Defense in depth: `DaemonCapabilitiesData.inspector` is
		// optionally-typed, but a misbehaving daemon could emit
		// `{"inspector": null}` over JSON. The old inline code would
		// have crashed on `daemonInspector.preview_offset`. The helper
		// must treat null exactly like missing.
		const raw = {
			...baseRaw(),
			inspector: null,
		} as unknown as DaemonCapabilitiesData;
		const out = mapDaemonCapsForInit(raw);
		assert.strictEqual(out.inspector, undefined);
	});

	test('Front 2: transform_attribution_v1=true is translated to transformAttributionV1', () => {
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			transform_attribution_v1: true,
		};
		const out = mapDaemonCapsForInit(raw);
		assert.strictEqual(out.transformAttributionV1, true);
	});

	test('Front 2: transform_attribution_v1 absent leaves transformAttributionV1 absent', () => {
		// Pre-Front-2 daemon. Field omitted entirely; the camelCase
		// shape must also omit it (not emit as `false`, since absence
		// and explicit-false carry the same renderer fallback semantics
		// but we keep the shape minimal).
		const out = mapDaemonCapsForInit(baseRaw());
		assert.ok(!('transformAttributionV1' in out),
			'transformAttributionV1 must be absent on the camelCase output');
	});

	test('Front 2: transform_attribution_v1=false also omits the camel field', () => {
		// Explicit-false from the daemon is rare but possible. We treat
		// it as "not supported", same as absent.
		const raw: DaemonCapabilitiesData = {
			...baseRaw(),
			transform_attribution_v1: false,
		};
		const out = mapDaemonCapsForInit(raw);
		assert.ok(!('transformAttributionV1' in out));
	});

});
