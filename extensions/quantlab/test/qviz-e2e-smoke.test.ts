/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end smoke test — Phase 9 step C.
 *
 * Drives the full "open csv → derive default spec → validate → save →
 * reload" pipeline that the Phase 9 brief calls out. Without VS Code's
 * webview host we can't drag columns through the builder UI directly,
 * but we CAN exercise every other phase: schema-driven default
 * derivation (Phase 8 Step A OHLCV smart-default + the line/scatter
 * fall-throughs), runtime validation, JSON serialization, on-disk
 * round-trip, and re-parse. A regression in any of those stages would
 * make a real saved .qviz.json fail to reopen.
 *
 * Tests:
 *   1. OHLCV parquet → candlestick spec → validates → serializes →
 *      reparses to a byte-for-byte identical AST.
 *   2. Temporal+numeric schema → line spec → round-trip identical.
 *   3. Numeric-only schema → scatter spec → round-trip identical.
 *   4. Saved file on tmp disk reloads to the same spec object.
 *   5. After load, the spec passes through `validate` again unchanged
 *      (idempotent on the on-disk format).
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

suite('Phase 9 — end-to-end smoke (open → derive → validate → save → reopen)', () => {

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

		// Round-trip via the JSON serializer.
		const bytes = serializeSpec(r.spec);
		const reparsed = parseSpecBytes(bytes, '<test>');
		// Normalize via JSON to drop `undefined` slots the validator adds
		// for absent optional fields — those are structurally equivalent
		// to the original (deriveDefault omits the key entirely).
		assert.strictEqual(
			JSON.stringify(reparsed),
			JSON.stringify(r.spec),
			'serialize → parse should yield a structurally-identical spec',
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

			// Re-running validate on the reloaded spec must still pass —
			// idempotent on the on-disk format.
			const v2 = validate(reparsed);
			assert.strictEqual(v2.ok, true,
				`reloaded spec should still validate cleanly`);

			// Re-serializing the reloaded spec yields the same bytes —
			// stable canonical form. This is the contract that lets the
			// drift-detection compare on-disk bytes safely.
			const bytes2 = serializeSpec(reparsed);
			assert.deepStrictEqual(
				Array.from(bytes2), Array.from(bytes),
				'serialize → parse → serialize should be byte-stable',
			);
		} finally {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
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
		];
		for (const uri of uris) {
			const r = deriveDefaultSpec({ datasetUri: uri, schema, nowIso: NOW });
			assert.strictEqual(r.ok, true, `derive failed for ${uri}`);
			if (!r.ok) { continue; }
			assert.strictEqual(r.spec.dataset.uri, uri,
				`dataset URI should round-trip exactly for ${uri}`);
			const reparsed = parseSpecBytes(serializeSpec(r.spec), '<test>');
			assert.strictEqual(reparsed.dataset.uri, uri);
		}
	});
});
