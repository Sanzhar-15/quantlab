/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `chartChannels.ts` — Phase 5 step F.1.
 *
 * Locks in the UI↔compiler coordination: every chart type's `required`
 * channels in `CHART_CHANNELS` must match what the COMPILER enforces
 * (see `src/qviz/render/timeseries.ts` and `src/qviz/render/general.ts`).
 * Drift between this table and the compilers would let the UI build a
 * spec that fails to render.
 *
 * Note (2026-05-11): the validator no longer enforces completeness — it
 * was relaxed so intermediate column-drag states round-trip cleanly. The
 * "missing required channel" assertions below therefore test STRUCTURAL
 * validation only; compile-time enforcement is covered separately in
 * `qviz-render-{timeseries,general}.test.ts`.
 */

import * as assert from 'assert';

import { validate } from '../src/qviz/validate';
import type { ChartType, QvizSpec, Encoding, Encodings, OhlcvEncoding } from '../src/qviz/spec';
import {
	CHART_CHANNELS,
	channelsForChartType,
	isChannelRequired,
	CHANNEL_LABELS,
	type RegularChannel,
} from '../src/qviz/chartChannels';

function encoding(field: string): Encoding {
	return { field, type: 'quantitative' };
}

function temporalEncoding(field: string): Encoding {
	return { field, type: 'temporal' };
}

function nominalEncoding(field: string): Encoding {
	return { field, type: 'nominal' };
}

function ohlcvEncoding(): OhlcvEncoding {
	return { time: 't', open: 'o', high: 'h', low: 'l', close: 'c' };
}

function buildSpec(t: ChartType, encodings: Encodings): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family: t === 'scatter' || t === 'heatmap' || t === 'pie' ? 'general' : 'timeseries',
			type: t,
			encodings,
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

/** Build a spec with each REQUIRED channel assigned and nothing else. */
function specWithRequiredEncodings(t: Exclude<ChartType, 'candlestick'>): QvizSpec {
	const encodings: { -readonly [K in keyof Encodings]?: Encodings[K] } = {};
	for (const ch of CHART_CHANNELS[t].required) {
		if (ch === 'x' && t === 'line') {
			encodings.x = temporalEncoding('ts');  // line is timeseries; x usually temporal
		} else if (ch === 'color') {
			encodings.color = nominalEncoding('cat');
		} else {
			encodings[ch] = encoding(`f_${ch}`);
		}
	}
	return buildSpec(t, encodings as Encodings);
}

// ---------------------------------------------------------------------------
// per-chart-type validator coordination
// ---------------------------------------------------------------------------

const NON_CANDLESTICK_CHARTS: readonly Exclude<ChartType, 'candlestick'>[] = [
	'line', 'area', 'bar', 'histogram', 'baseline', 'scatter', 'heatmap', 'pie',
];

suite('chartChannels -- structural validation (no encoding completeness)', () => {
	// Smoke-test fix (2026-05-11): the validator no longer enforces
	// per-chart-type encoding completeness ("line requires x and y",
	// "candlestick requires ohlcv", etc.) — those checks moved to
	// the compiler at render time so the protocol doesn't reject
	// intermediate states during column-drag building. The previous
	// "FAIL validation when required channel removed" assertions are
	// gone; the compile-time enforcement is covered in
	// qviz-render-{timeseries,general}.test.ts.

	for (const t of NON_CANDLESTICK_CHARTS) {
		test(`${t}: spec with all required channels validates`, () => {
			const spec = specWithRequiredEncodings(t);
			const r = validate(spec);
			assert.strictEqual(r.ok, true,
				`${t} should validate with required channels: ${
					r.ok === false ? JSON.stringify(r.issues) : ''
				}`);
		});

		test(`${t}: spec missing required channels still STRUCTURALLY validates (compile-time check moved)`, () => {
			const required = CHART_CHANNELS[t].required;
			if (required.length === 0) { return; }
			for (const drop of required) {
				const spec = specWithRequiredEncodings(t);
				const encs: { -readonly [K in keyof Encodings]?: Encodings[K] } = { ...spec.chart.encodings };
				delete encs[drop];
				const r = validate({
					...spec,
					chart: { ...spec.chart, encodings: encs as Encodings },
				});
				assert.strictEqual(r.ok, true,
					`${t} with "${drop}" removed must pass structural validation; ` +
					`completeness enforcement is at compile/render time.`);
			}
		});
	}

	test('candlestick: channelsForChartType returns empty (no regular channels)', () => {
		// channelsForChartType returns [] for candlestick because all of
		// its data flows through the `ohlcv` cluster, not regular x/y
		// channels. This is documenting the CHANNEL MAP shape — the
		// previous test also asserted validator-level ohlcv-rejection,
		// which is now a compile-time check (see comment above).
		assert.deepStrictEqual([...channelsForChartType('candlestick')], []);
		const withOhlcv = buildSpec('candlestick', { ohlcv: ohlcvEncoding() });
		assert.strictEqual(validate(withOhlcv).ok, true,
			'candlestick with ohlcv encoding must validate structurally');
	});

});

// ---------------------------------------------------------------------------
// shape of the mapping (defensive against typos)
// ---------------------------------------------------------------------------

suite('chartChannels -- mapping shape', () => {

	test('every non-candlestick chart type has a CHART_CHANNELS entry', () => {
		for (const t of NON_CANDLESTICK_CHARTS) {
			assert.ok(t in CHART_CHANNELS, `missing entry for ${t}`);
		}
	});

	test('required and optional channels are disjoint', () => {
		for (const t of NON_CANDLESTICK_CHARTS) {
			const req = new Set(CHART_CHANNELS[t].required);
			for (const o of CHART_CHANNELS[t].optional) {
				assert.ok(!req.has(o),
					`${t}: channel ${o} appears in BOTH required and optional`);
			}
		}
	});

	test('every regular channel has a label', () => {
		const channels: RegularChannel[] = [
			'x', 'y', 'y2', 'color', 'size', 'shape', 'facet_row', 'facet_col',
		];
		for (const ch of channels) {
			assert.ok(typeof CHANNEL_LABELS[ch] === 'string' && CHANNEL_LABELS[ch].length > 0,
				`missing label for ${ch}`);
		}
	});

	test('isChannelRequired matches the table', () => {
		for (const t of NON_CANDLESTICK_CHARTS) {
			for (const ch of CHART_CHANNELS[t].required) {
				assert.strictEqual(isChannelRequired(t, ch), true);
			}
			for (const ch of CHART_CHANNELS[t].optional) {
				assert.strictEqual(isChannelRequired(t, ch), false);
			}
		}
		// Candlestick: every channel is "not required" because the
		// UI's candlestick path uses the OHLCV cluster instead.
		assert.strictEqual(isChannelRequired('candlestick', 'x'), false);
	});

});
