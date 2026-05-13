/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pattern B (post-smoke builder-coherence pass, 2026-05-13).
 *
 * Pins the shared `schemaEncoding` module's dtype-to-encoding-type
 * inference. The historical `defaults.ts:classifyColumn` was the only
 * channel-blind classifier in the codebase; this module makes it the
 * single source of truth and adds `inferEncodingTypeForChannel` as
 * the seam for future channel-aware heuristics.
 *
 * Tests cover the full pyarrow dtype matrix the schema can carry,
 * including the Vega-Lite temporal trap cases Codex flagged (don't
 * auto-classify utf8 as temporal even if values look date-like).
 */

import * as assert from 'assert';

import {
	classifyColumn,
	inferEncodingTypeForChannel,
} from '../src/qviz/schemaEncoding';
import type { SchemaColumn, SchemaInfo } from '../src/qviz/messageProtocol';

function col(name: string, dtype: string, nullable = false): SchemaColumn {
	return { name, dtype, nullable };
}

function schema(cols: SchemaColumn[]): SchemaInfo {
	return {
		uri: 'data/x.parquet',
		schema_hash: 'sha256:' + 'a'.repeat(64),
		mtime_ns: 1,
		row_count: 100,
		columns: cols,
	};
}

suite('schemaEncoding -- classifyColumn', () => {

	test('timestamp[ms/ns/us/s] all classify as temporal', () => {
		for (const dt of [
			'timestamp[ms]', 'timestamp[ns]', 'timestamp[us]', 'timestamp[s]',
			'timestamp[ms, tz=UTC]', 'timestamp[ns, tz=America/New_York]',
		]) {
			assert.strictEqual(
				classifyColumn(col('t', dt)), 'temporal',
				`dtype ${dt} must be temporal`,
			);
		}
	});

	test('date32[day] and date64[ms] classify as temporal', () => {
		assert.strictEqual(classifyColumn(col('d', 'date32[day]')), 'temporal');
		assert.strictEqual(classifyColumn(col('d', 'date64[ms]')), 'temporal');
	});

	test('integer types classify as quantitative', () => {
		for (const dt of [
			'int8', 'int16', 'int32', 'int64',
			'uint8', 'uint16', 'uint32', 'uint64',
		]) {
			assert.strictEqual(
				classifyColumn(col('n', dt)), 'quantitative',
				`dtype ${dt} must be quantitative`,
			);
		}
	});

	test('float / decimal types classify as quantitative', () => {
		for (const dt of [
			'float16', 'float32', 'float64', 'double', 'half_float',
			'decimal(10,2)', 'decimal128(38,8)',
		]) {
			assert.strictEqual(
				classifyColumn(col('f', dt)), 'quantitative',
				`dtype ${dt} must be quantitative`,
			);
		}
	});

	test('string / bool / dictionary classify as nominal', () => {
		for (const dt of [
			'utf8', 'large_utf8', 'string',
			'bool', 'boolean',
			'dictionary<utf8, int32>',
		]) {
			assert.strictEqual(
				classifyColumn(col('s', dt)), 'nominal',
				`dtype ${dt} must be nominal`,
			);
		}
	});

	test('unknown dtypes default to nominal', () => {
		assert.strictEqual(classifyColumn(col('x', 'binary')), 'nominal');
		assert.strictEqual(classifyColumn(col('x', 'list<int32>')), 'nominal');
		assert.strictEqual(classifyColumn(col('x', 'struct<a:int32>')), 'nominal');
	});

	test('dtype matching is case-insensitive', () => {
		// Audit defense — Codex flagged that pyarrow can emit
		// capitalized dtype strings depending on serialization
		// path. Pin the case-insensitive classifier contract.
		assert.strictEqual(classifyColumn(col('t', 'TIMESTAMP[ms]')), 'temporal');
		assert.strictEqual(classifyColumn(col('n', 'Int64')), 'quantitative');
		assert.strictEqual(classifyColumn(col('s', 'UTF8')), 'nominal');
	});

	test('Vega-Lite trap: utf8 with date-like values is NOT auto-classified as temporal', () => {
		// The classifier looks at dtype ONLY, never the values.
		// This is the Codex-flagged trap: a utf8 column with
		// "2026-05-13" values would be a `string` to schemaEncoding
		// but a temporal to the user. Surfacing that as a UI
		// mismatch chip is Pattern E's job; we never auto-coerce.
		const c = col('possibly_date', 'utf8');
		assert.strictEqual(classifyColumn(c), 'nominal');
	});

});

suite('schemaEncoding -- inferEncodingTypeForChannel', () => {

	test('returns classified type for known column on each channel', () => {
		const sch = schema([
			col('time', 'timestamp[ms]'),
			col('close', 'float64'),
			col('symbol', 'utf8'),
		]);
		for (const ch of ['x', 'y', 'y2', 'color', 'size', 'shape', 'facet_row', 'facet_col'] as const) {
			assert.strictEqual(
				inferEncodingTypeForChannel(sch, 'time', ch), 'temporal',
				`channel ${ch} on time column must infer temporal`,
			);
			assert.strictEqual(
				inferEncodingTypeForChannel(sch, 'close', ch), 'quantitative',
			);
			assert.strictEqual(
				inferEncodingTypeForChannel(sch, 'symbol', ch), 'nominal',
			);
		}
	});

	test('returns null for unknown column name', () => {
		const sch = schema([col('time', 'timestamp[ms]')]);
		assert.strictEqual(
			inferEncodingTypeForChannel(sch, 'nonexistent', 'x'), null,
		);
	});

});

suite('schemaEncoding -- back-compat re-export from defaults.ts', () => {

	test('classifyColumn re-exported via defaults.ts maintains identity', async () => {
		const fromShared = (await import('../src/qviz/schemaEncoding')).classifyColumn;
		const fromDefaults = (await import('../src/qviz/defaults')).classifyColumn;
		assert.strictEqual(
			fromShared, fromDefaults,
			'defaults.ts must re-export the same classifyColumn function reference',
		);
	});

});
