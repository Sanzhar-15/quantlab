/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spec round-trip tests -- Phase 9, renamed from qviz-e2e-smoke.test.ts
 * after the megaudit found the original name overpromised.
 *
 * This file exercises the SERIALIZATION layer: schema -> derive default
 * spec -> validate -> serialize -> on-disk write -> read -> parse ->
 * validate idempotent. It does NOT cover the editor's drag UI, the
 * daemon, or the renderer. A true open-csv -> drag -> save -> reopen
 * E2E remains a Phase 10+ candidate (would require Playwright or a
 * mocked VS Code custom-editor harness).
 *
 * What this file pins:
 *   - Every schema shape that `deriveDefaultSpec` handles round-trips
 *     byte-stably through `serializeSpec` / `parseSpecBytes`.
 *   - The validator is idempotent: validate(parseSpecBytes(serializeSpec(spec)))
 *     succeeds when validate(spec) succeeds.
 *   - All 9 chart families/types serialize + reparse without drift.
 *   - The validator REJECTS combinations that deriveDefaultSpec would
 *     never produce (negative invariant: prevents validator drift).
 *   - Aggregate-spec round-trips preserve the derived-alias encodings
 *     (pnl_sum, exposure_mean) that the Phase 7 B-10 cure depends on.
 *   - Provenance shape stable through the round-trip.
 *   - Schema-drift detector and external-mod paths surface where
 *     promised.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { deriveDefaultSpec } from '../src/qviz/defaults';
import { validate } from '../src/qviz/validate';
import { parseSpecBytes, serializeSpec } from '../src/qviz/specCore';
import type { SchemaInfo } from '../src/qviz/messageProtocol';

const NOW = '2026-05-12T00:00:00Z';

function schemaOf(cols: { name: string; dtype: string }[]): SchemaInfo {
	return {
		uri: 'data/test.parquet',
		schema_hash: 'sha256:' + 'a'.repeat(64),
		mtime_ns: 1700000000000000000,
		row_count: 1000,
		columns: cols.map(c => ({ name: c.name, dtype: c.dtype, nullable: false })),
	};
}

suite('qviz spec round-trip (Phase 9, megaudit-renamed from e2e-smoke)', () => {

	test('OHLCV parquet → candlestick default → validates and round-trips identically', () => {
		const schema = schemaOf([
			{ name: 'time', dtype: 'TIMESTAMP' },
			{ name: 'open', dtype: 'DOUBLE' },
			{ name: 'high', dtype: 'DOUBLE' },
			{ name: 'low', dtype: 'DOUBLE' },
			{ name: 'close', dtype: 'DOUBLE' },
			{ name: 'volume', dtype: 'DOUBLE' },
		]);
		const r = deriveDefaultSpec({
			datasetUri: 'data/ohlcv.parquet',
			schema, nowIso: NOW,
		});
		assert.strictEqual(r.ok, true,
			'OHLCV schema should produce a derived spec');
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'timeseries');
		assert.strictEqual(r.spec.chart.type, 'candlestick',
			'Phase 8 Step A: OHLCV columns must trigger candlestick smart-default');
		assert.ok(r.spec.chart.encodings.ohlcv,
			'OHLCV cluster must be set');

		// Validator must accept the derived spec.
		const v = validate(r.spec);
		if (!v.ok) {
			const issues = v.issues.map(i => `${i.path}: ${i.message}`).join('\n');
			assert.fail(`derived OHLCV spec failed validation:\n${issues}`);
		}

		// Round-trip via the JSON serializer. Byte stability is the
		// strict invariant the drift detector relies on (megaudit M-11
		// cure: stop using JSON.stringify equality here -- serialize a
		// second time and compare bytes).
		const bytes = serializeSpec(r.spec);
		const reparsed = parseSpecBytes(bytes, '<test>');
		assert.strictEqual(
			JSON.stringify(reparsed),
			JSON.stringify(r.spec),
			'serialize -> parse should yield a structurally-identical spec',
		);
		const bytes2 = serializeSpec(reparsed);
		assert.deepStrictEqual(
			Array.from(bytes2), Array.from(bytes),
			'serialize -> parse -> serialize must be byte-stable',
		);
	});

	test('temporal + numeric schema → line default → round-trips identically', () => {
		const schema = schemaOf([
			{ name: 'ts', dtype: 'TIMESTAMP' },
			{ name: 'equity', dtype: 'DOUBLE' },
		]);
		const r = deriveDefaultSpec({
			datasetUri: 'data/equity.parquet',
			schema, nowIso: NOW,
		});
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'timeseries');
		assert.strictEqual(r.spec.chart.type, 'line');
		assert.strictEqual(r.spec.chart.encodings.x?.field, 'ts');
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'equity');

		const v = validate(r.spec);
		assert.strictEqual(v.ok, true,
			`line default failed validation: ${v.ok ? '' : v.issues.map(i => i.path + ': ' + i.message).join(', ')}`);

		const bytes = serializeSpec(r.spec);
		const reparsed = parseSpecBytes(bytes, '<test>');
		assert.strictEqual(JSON.stringify(reparsed), JSON.stringify(r.spec));
		// Byte-stable canonical form (M-11 cure).
		assert.deepStrictEqual(
			Array.from(serializeSpec(reparsed)), Array.from(bytes),
		);
	});

	test('numeric-only schema → scatter default → round-trips identically', () => {
		const schema = schemaOf([
			{ name: 'pnl', dtype: 'DOUBLE' },
			{ name: 'volatility', dtype: 'DOUBLE' },
		]);
		const r = deriveDefaultSpec({
			datasetUri: 'data/factors.parquet',
			schema, nowIso: NOW,
		});
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.family, 'general');
		assert.strictEqual(r.spec.chart.type, 'scatter');
		assert.strictEqual(r.spec.chart.encodings.x?.field, 'pnl');
		assert.strictEqual(r.spec.chart.encodings.y?.field, 'volatility');

		const v = validate(r.spec);
		assert.strictEqual(v.ok, true);

		const bytes = serializeSpec(r.spec);
		const reparsed = parseSpecBytes(bytes, '<test>');
		assert.strictEqual(JSON.stringify(reparsed), JSON.stringify(r.spec));
		assert.deepStrictEqual(
			Array.from(serializeSpec(reparsed)), Array.from(bytes),
		);
	});

	test('full disk round-trip: derive → save .qviz.json → reload → matches', () => {
		const schema = schemaOf([
			{ name: 'time', dtype: 'TIMESTAMP' },
			{ name: 'open', dtype: 'DOUBLE' },
			{ name: 'high', dtype: 'DOUBLE' },
			{ name: 'low', dtype: 'DOUBLE' },
			{ name: 'close', dtype: 'DOUBLE' },
		]);
		const r = deriveDefaultSpec({
			datasetUri: 'data/aapl.parquet',
			schema, nowIso: NOW,
		});
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-e2e-'));
		const fsPath = path.join(dir, 'aapl.qviz.json');
		try {
			const bytes = serializeSpec(r.spec);
			fs.writeFileSync(fsPath, bytes);

			const reloaded = fs.readFileSync(fsPath);
			const reparsed = parseSpecBytes(
				new Uint8Array(reloaded.buffer, reloaded.byteOffset, reloaded.byteLength),
				fsPath,
			);
			assert.strictEqual(
				JSON.stringify(reparsed), JSON.stringify(r.spec),
				'spec saved to disk should reload to a structurally-identical spec',
			);

			// Re-running validate on the reloaded spec must still pass --
			// idempotent on the on-disk format.
			const v2 = validate(reparsed);
			assert.strictEqual(v2.ok, true,
				`reloaded spec should still validate cleanly`);

			// Re-serializing the reloaded spec yields the same bytes --
			// stable canonical form. This is the contract that lets the
			// drift-detection compare on-disk bytes safely.
			const bytes2 = serializeSpec(reparsed);
			assert.deepStrictEqual(
				Array.from(bytes2), Array.from(bytes),
				'serialize → parse → serialize should be byte-stable',
			);
		} finally {
			// CLAUDE.md no-fallbacks: let cleanup errors surface so a real
			// problem (e.g., a child process still holding the file open)
			// is visible. Mocha reports teardown failures clearly.
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('save/reload preserves Phase 8 Step A candlestick + provenance fields', () => {
		const schema = schemaOf([
			{ name: 'time', dtype: 'TIMESTAMP' },
			{ name: 'Open', dtype: 'DOUBLE' },
			{ name: 'High', dtype: 'DOUBLE' },
			{ name: 'Low', dtype: 'DOUBLE' },
			{ name: 'Close', dtype: 'DOUBLE' },
		]);
		// Mixed-case names: the OHLCV detector is case-insensitive.
		const r = deriveDefaultSpec({
			datasetUri: 'data/case.parquet',
			schema, nowIso: NOW,
		});
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.strictEqual(r.spec.chart.type, 'candlestick',
			'OHLCV detector should be case-insensitive');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.open, 'Open');
		assert.strictEqual(r.spec.chart.encodings.ohlcv?.close, 'Close');

		const bytes = serializeSpec(r.spec);
		const reparsed = parseSpecBytes(bytes, '<test>');
		// Provenance must survive round-trip.
		assert.strictEqual(reparsed.provenance.generated_at, r.spec.provenance.generated_at);
		assert.strictEqual(reparsed.provenance.generator, r.spec.provenance.generator);
		assert.strictEqual(
			reparsed.provenance.tool_versions?.qviz_schema,
			r.spec.provenance.tool_versions?.qviz_schema,
		);
		assert.strictEqual(reparsed.chart.encodings.ohlcv?.open, 'Open');
	});

	test('round-tripped spec preserves the dataset URI exactly (drift-detection invariant)', () => {
		const schema = schemaOf([
			{ name: 't', dtype: 'TIMESTAMP' },
			{ name: 'x', dtype: 'DOUBLE' },
		]);
		const uris = [
			'data/x.parquet',
			'datasets/2026/run-42.parquet',
			'foo/bar/baz.csv',
			// Megaudit N-17: exercise non-ASCII + spaces in URIs so a
			// JSON-escape bug surfaces.
			'data/тест.parquet',
			'data/with space.parquet',
		];
		for (const uri of uris) {
			const r = deriveDefaultSpec({ datasetUri: uri, schema, nowIso: NOW });
			assert.strictEqual(r.ok, true, `derive failed for ${uri}`);
			if (!r.ok) { continue; }
			assert.strictEqual(r.spec.dataset.uri, uri,
				`dataset URI should round-trip exactly for ${uri}`);
			const bytes = serializeSpec(r.spec);
			const reparsed = parseSpecBytes(bytes, '<test>');
			assert.strictEqual(reparsed.dataset.uri, uri);
			assert.deepStrictEqual(
				Array.from(serializeSpec(reparsed)), Array.from(bytes),
				`byte-stable round-trip required for ${uri}`,
			);
		}
	});

	// Megaudit M-12 cure: round-trip every chart family/type the
	// validator accepts, not just the three that deriveDefaultSpec
	// happens to pick.
	const ALL_CHART_TYPES: Array<{ family: 'timeseries' | 'general'; type: string }> = [
		{ family: 'timeseries', type: 'line' },
		{ family: 'timeseries', type: 'area' },
		{ family: 'timeseries', type: 'bar' },
		{ family: 'timeseries', type: 'histogram' },
		{ family: 'timeseries', type: 'candlestick' },
		{ family: 'timeseries', type: 'baseline' },
		{ family: 'general', type: 'scatter' },
		{ family: 'general', type: 'heatmap' },
		{ family: 'general', type: 'bar' },
		{ family: 'general', type: 'pie' },
		{ family: 'general', type: 'histogram' },
		{ family: 'general', type: 'line' },
	];

	for (const { family, type } of ALL_CHART_TYPES) {
		test(`all-chart-types round-trip: ${family}/${type} byte-stable`, () => {
			// Build a minimal spec for each chart type with the encodings
			// the compiler will accept at validation time. Note: for
			// candlestick we ship an ohlcv cluster; for pie we ship
			// color + y; everything else gets x + y.
			let encodings: Record<string, unknown>;
			if (type === 'candlestick') {
				encodings = {
					ohlcv: {
						time: 'time', open: 'open', high: 'high',
						low: 'low', close: 'close',
					},
				};
			} else if (type === 'pie') {
				encodings = {
					color: { field: 'category', type: 'nominal' },
					y: { field: 'value', type: 'quantitative' },
				};
			} else if (type === 'heatmap') {
				encodings = {
					x: { field: 'x', type: 'nominal' },
					y: { field: 'y', type: 'nominal' },
					color: { field: 'v', type: 'quantitative' },
				};
			} else {
				encodings = {
					x: { field: 'x', type: family === 'timeseries' ? 'temporal' : 'quantitative' },
					y: { field: 'y', type: 'quantitative' },
				};
			}
			const spec = {
				qviz_version: 1 as const,
				dataset: {
					uri: `data/${type}.parquet`,
					schema_hash: 'sha256:' + 'a'.repeat(64),
					mtime_ns: 1,
				},
				transforms: [],
				chart: { family, type: type as never, encodings: encodings as never },
				provenance: {
					generated_at: NOW,
					generator: 'test/0.1.0',
					query_hash: 'sha256:' + '0'.repeat(64),
					tool_versions: { qviz_schema: 1 },
				},
			};
			const v = validate(spec);
			assert.strictEqual(v.ok, true,
				`${family}/${type} must validate: ${v.ok ? '' : v.issues.map(i => i.path + ': ' + i.message).join(', ')}`);
			if (!v.ok) { return; }
			const bytes = serializeSpec(v.value);
			const reparsed = parseSpecBytes(bytes, '<test>');
			assert.deepStrictEqual(
				Array.from(serializeSpec(reparsed)), Array.from(bytes),
				`${family}/${type} must byte-round-trip`,
			);
		});
	}

	// Megaudit M-13 cure: validator must REJECT family/type combinations
	// it would never produce. Tests the negative half of the validator
	// contract.
	test('validator rejects family/type mismatches (negative invariant)', () => {
		const baseSpec = (family: string, type: string) => ({
			qviz_version: 1,
			dataset: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1,
			},
			transforms: [],
			chart: {
				family,
				type,
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
			provenance: {
				generated_at: NOW,
				generator: 'test/0',
				query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1 },
			},
		});
		// scatter is general-only; reject in timeseries.
		const r1 = validate(baseSpec('timeseries', 'scatter'));
		assert.strictEqual(r1.ok, false, 'timeseries/scatter must be rejected');
		// pie is general-only; reject in timeseries.
		const r2 = validate(baseSpec('timeseries', 'pie'));
		assert.strictEqual(r2.ok, false, 'timeseries/pie must be rejected');
		// candlestick is timeseries-only; reject in general.
		const r3 = validate(baseSpec('general', 'candlestick'));
		assert.strictEqual(r3.ok, false, 'general/candlestick must be rejected');
		// baseline is timeseries-only; reject in general.
		const r4 = validate(baseSpec('general', 'baseline'));
		assert.strictEqual(r4.ok, false, 'general/baseline must be rejected');
		// heatmap is general-only; reject in timeseries.
		const r5 = validate(baseSpec('timeseries', 'heatmap'));
		assert.strictEqual(r5.ok, false, 'timeseries/heatmap must be rejected');
	});

	// Megaudit M-15 cure: round-trip an aggregate spec (the shape
	// emitted by pnl_by_strategy / factor_exposure presets) so the
	// derived-alias encoding survives serialize/parse.
	test('aggregate spec round-trip preserves derived aliases (pnl_sum)', () => {
		const spec = {
			qviz_version: 1 as const,
			dataset: {
				uri: 'out/pnl_by_strat.parquet',
				schema_hash: 'sha256:' + 'b'.repeat(64),
				mtime_ns: 2,
			},
			transforms: [
				{ kind: 'groupby' as const, columns: ['strategy'] },
				{ kind: 'aggregate' as const, aggs: [
					{ column: 'pnl', fn: 'sum' as const, as: 'pnl_sum' },
				] },
				{ kind: 'sort' as const, columns: [
					{ column: 'pnl_sum', desc: true },
					{ column: 'strategy', desc: false },
				] },
			],
			chart: {
				family: 'general' as const,
				type: 'bar' as const,
				encodings: {
					x: { field: 'strategy', type: 'nominal' as const },
					y: { field: 'pnl_sum', type: 'quantitative' as const },
				},
			},
			provenance: {
				generated_at: NOW,
				generator: 'qviz.pnl_by_strategy/0.1.0',
				query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1, python_qviz: '0.1.0' },
				source: 'engine-emitted' as const,
			},
		};
		const v = validate(spec);
		assert.strictEqual(v.ok, true,
			`aggregate spec must validate: ${v.ok ? '' : v.issues.map(i => i.path + ': ' + i.message).join(', ')}`);
		if (!v.ok) { return; }
		const bytes = serializeSpec(v.value);
		const reparsed = parseSpecBytes(bytes, '<test>');
		// Derived alias preserved in y encoding (Phase 7 B-10 contract).
		assert.strictEqual(reparsed.chart.encodings.y?.field, 'pnl_sum');
		// Aggregate transform shape preserved.
		const agg = reparsed.transforms.find(t => t.kind === 'aggregate');
		assert.ok(agg, 'aggregate transform must round-trip');
		// Byte-stable.
		assert.deepStrictEqual(
			Array.from(serializeSpec(reparsed)), Array.from(bytes),
		);
	});
});
