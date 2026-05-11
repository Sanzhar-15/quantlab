/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `defaults.ts` — Phase 5 step 5.C.3.
 *
 * Pure tests. Each case feeds a SchemaInfo to `deriveDefaultSpec` and
 * asserts the chart family/type + encoding picks. Output specs are
 * also passed through `validate()` to confirm they're round-trippable.
 */

import * as assert from 'assert';

import { deriveDefaultSpec, classifyColumn } from '../src/qviz/defaults';
import type { SchemaInfo, SchemaColumn } from '../src/qviz/messageProtocol';
import { validate } from '../src/qviz/validate';

const HASH = 'sha256:' + 'a'.repeat(64);
const NOW = '2026-05-10T00:00:00Z';

function schema(columns: { name: string; dtype: string; nullable?: boolean }[]): SchemaInfo {
	return {
		uri: 'data/x.parquet',
		schema_hash: HASH,
		mtime_ns: 1,
		row_count: 1000,
		columns: columns.map(c => ({
			name: c.name, dtype: c.dtype, nullable: c.nullable ?? false,
		})),
	};
}

// ---------------------------------------------------------------------------
// happy paths
// ---------------------------------------------------------------------------

suite('defaults -- happy paths', () => {

	test('temporal x + numeric y → timeseries.line', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'ts', dtype: 'timestamp[ns]' },
				{ name: 'price', dtype: 'float64' },
				{ name: 'volume', dtype: 'int64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok, `expected ok; got ${r.ok ? '' : r.error}`);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'timeseries');
		assert.strictEqual(r.spec.chart.type, 'line');
		assert.strictEqual(r.spec.chart.encodings.x?.field, 'ts');
		assert.strictEqual(r.spec.chart.encodings.x?.type, 'temporal');
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'price');
		assert.strictEqual(r.spec.chart.encodings.y?.type, 'quantitative');
		assert.deepStrictEqual(r.spec.transforms, []);
		assert.strictEqual(r.spec.provenance.source, 'user-built');
		assert.strictEqual(r.spec.provenance.generator, 'quantlab-visualise/builder');
		assert.strictEqual(r.spec.provenance.generated_at, NOW);
		// Validates against the canonical validator.
		const v = validate(r.spec);
		assert.strictEqual(v.ok, true, `validator rejected default spec: ${v.ok ? '' : JSON.stringify(v.issues)}`);
	});

	test('no temporal but >= 2 numerics → general.scatter', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'a', dtype: 'float64' },
				{ name: 'b', dtype: 'int32' },
				{ name: 'label', dtype: 'utf8' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'general');
		assert.strictEqual(r.spec.chart.type, 'scatter');
		assert.strictEqual(r.spec.chart.encodings.x?.field, 'a');
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'b');
		assert.strictEqual(validate(r.spec).ok, true);
	});

	test('one numeric + nominal returns structured error (no auto-bar)', () => {
		// Step C megaudit D1: the "1 numeric + nominal → bar" default
		// was beyond plan scope and produced specs without an aggregation
		// pipeline. Caller must pick chart manually.
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'category', dtype: 'utf8' },
				{ name: 'count', dtype: 'int64' },
			]),
			nowIso: NOW,
		});
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/no temporal column AND fewer than two numeric/.test(r.error), r.error);
	});

	test('temporal column at any position is picked', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'open', dtype: 'float64' },
				{ name: 'close', dtype: 'float64' },
				{ name: 'ts', dtype: 'timestamp[ns]' },
				{ name: 'volume', dtype: 'int64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		// First temporal column anywhere -> x. First numeric -> y.
		assert.strictEqual(r.spec.chart.encodings.x?.field, 'ts');
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'open');
	});

	test('row_count from schema is forwarded into dataset block when present', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'ts', dtype: 'timestamp[ns]' },
				{ name: 'p', dtype: 'float64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.dataset.row_count, 1000);
	});

});

// ---------------------------------------------------------------------------
// Phase 8 Step A — OHLCV smart-default
// ---------------------------------------------------------------------------

suite('defaults -- OHLCV smart-default (Phase 8 Step A)', () => {

	test('temporal + open/high/low/close → timeseries.candlestick', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/ohlcv.parquet',
			schema: schema([
				{ name: 'time', dtype: 'timestamp[ns]' },
				{ name: 'open', dtype: 'float64' },
				{ name: 'high', dtype: 'float64' },
				{ name: 'low', dtype: 'float64' },
				{ name: 'close', dtype: 'float64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok, `expected ok; got ${r.ok ? '' : r.error}`);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'timeseries');
		assert.strictEqual(r.spec.chart.type, 'candlestick');
		const ohlcv = r.spec.chart.encodings.ohlcv;
		assert.ok(ohlcv, 'encodings.ohlcv must be present');
		assert.deepStrictEqual({ ...ohlcv }, {
			time: 'time', open: 'open', high: 'high', low: 'low', close: 'close',
		});
		// Validator round-trip — spec must load cleanly in the editor.
		const v = validate(r.spec);
		assert.ok(v.ok, `validator should accept candlestick default; got ${v.ok ? '' : JSON.stringify(v.issues)}`);
	});

	test('volume column included in ohlcv encoding when present and numeric', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/ohlcv.parquet',
			schema: schema([
				{ name: 'time', dtype: 'timestamp[ns]' },
				{ name: 'open', dtype: 'float64' },
				{ name: 'high', dtype: 'float64' },
				{ name: 'low', dtype: 'float64' },
				{ name: 'close', dtype: 'float64' },
				{ name: 'volume', dtype: 'int64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.type, 'candlestick');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.volume, 'volume');
	});

	test('case-insensitive OHLCV names are detected (Open/HIGH/Low/Close)', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/ohlcv.parquet',
			schema: schema([
				{ name: 'Timestamp', dtype: 'timestamp[ns]' },
				{ name: 'Open', dtype: 'float64' },
				{ name: 'HIGH', dtype: 'float64' },
				{ name: 'Low', dtype: 'float64' },
				{ name: 'Close', dtype: 'float64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.type, 'candlestick');
		// The original column names (preserved case) are what gets wired
		// into the encoding — DuckDB / the daemon won't lowercase them.
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.open, 'Open');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.high, 'HIGH');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.low, 'Low');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.close, 'Close');
	});

	test('missing one OHLC column falls through to line (no false-positive candlestick)', () => {
		// Only open/high/low (no close) + temporal → MUST NOT trigger
		// candlestick. Falls back to temporal+numeric line.
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'time', dtype: 'timestamp[ns]' },
				{ name: 'open', dtype: 'float64' },
				{ name: 'high', dtype: 'float64' },
				{ name: 'low', dtype: 'float64' },
				// no 'close'
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.type, 'line');
		// Encoding uses first numeric (open) as y.
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'open');
	});

	test('OHLC names present but no temporal column → falls through to scatter', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'open', dtype: 'float64' },
				{ name: 'high', dtype: 'float64' },
				{ name: 'low', dtype: 'float64' },
				{ name: 'close', dtype: 'float64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		// No temporal column → can't elect candlestick; ≥2 numerics → scatter.
		assert.strictEqual(r.spec.chart.type, 'scatter');
	});

	test('R-3 mitigation: a non-financial schema with a `close` column does NOT trigger candlestick', () => {
		// Survey data with a `close_date` column. The user's `close` column
		// is a string date, not numeric. detectOhlcvColumns requires
		// quantitative dtype on all four OHLC cols, so this case falls
		// through to line.
		const r = deriveDefaultSpec({
			datasetUri: 'data/survey.parquet',
			schema: schema([
				{ name: 'time', dtype: 'timestamp[ns]' },
				{ name: 'open', dtype: 'float64' },   // numeric so far
				{ name: 'high', dtype: 'float64' },
				{ name: 'low', dtype: 'float64' },
				{ name: 'close', dtype: 'utf8' },     // string — NOT numeric
				{ name: 'responses', dtype: 'int64' },
			]),
			nowIso: NOW,
		});
		assert.ok(r.ok);
		if (!r.ok) { return; }
		// Must not be candlestick (close column failed the numeric check).
		assert.notStrictEqual(r.spec.chart.type, 'candlestick');
		assert.strictEqual(r.spec.chart.type, 'line');
	});

});

// ---------------------------------------------------------------------------
// failure paths
// ---------------------------------------------------------------------------

suite('defaults -- failure paths', () => {

	test('empty schema returns an actionable error', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([]),
			nowIso: NOW,
		});
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/no columns/.test(r.error), `unexpected error: ${r.error}`);
	});

	test('all-string schema returns an actionable error', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([
				{ name: 'a', dtype: 'utf8' },
				{ name: 'b', dtype: 'utf8' },
			]),
			nowIso: NOW,
		});
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(/no temporal column AND fewer than two numeric/.test(r.error), r.error);
	});

	test('single column (numeric only) returns an actionable error', () => {
		const r = deriveDefaultSpec({
			datasetUri: 'data/x.parquet',
			schema: schema([{ name: 'a', dtype: 'float64' }]),
			nowIso: NOW,
		});
		assert.strictEqual(r.ok, false);
	});

});

// ---------------------------------------------------------------------------
// dtype classification
// ---------------------------------------------------------------------------

suite('defaults -- classifyColumn', () => {

	function col(dtype: string): SchemaColumn {
		return { name: 'x', dtype, nullable: false };
	}

	test('temporal: every timestamp variant', () => {
		assert.strictEqual(classifyColumn(col('timestamp[ns]')), 'temporal');
		assert.strictEqual(classifyColumn(col('timestamp[us]')), 'temporal');
		assert.strictEqual(classifyColumn(col('timestamp[ms]')), 'temporal');
		assert.strictEqual(classifyColumn(col('timestamp[s]')), 'temporal');
		assert.strictEqual(classifyColumn(col('timestamp[ns, tz=UTC]')), 'temporal');
		assert.strictEqual(classifyColumn(col('date32[day]')), 'temporal');
		assert.strictEqual(classifyColumn(col('date64[ms]')), 'temporal');
	});

	test('quantitative: int / float / decimal', () => {
		for (const d of ['int8', 'int16', 'int32', 'int64', 'uint8', 'uint64', 'float32', 'float64', 'double', 'decimal128(10, 2)']) {
			assert.strictEqual(classifyColumn(col(d)), 'quantitative', `dtype=${d}`);
		}
	});

	test('nominal: strings + bool + dictionary', () => {
		for (const d of ['utf8', 'large_utf8', 'string', 'bool', 'boolean', 'dictionary<string, int32>']) {
			assert.strictEqual(classifyColumn(col(d)), 'nominal', `dtype=${d}`);
		}
	});

	test('unknown dtype falls through to nominal', () => {
		assert.strictEqual(classifyColumn(col('struct<...>')), 'nominal');
		assert.strictEqual(classifyColumn(col('list<int64>')), 'nominal');
		assert.strictEqual(classifyColumn(col('weird-future-type')), 'nominal');
	});

});
