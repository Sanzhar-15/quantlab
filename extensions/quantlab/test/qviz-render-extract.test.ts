/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	convertColumnToMs,
	convertToMs,
	ExtractError,
	extractColumnsFromJsonRows,
} from '../src/qviz/render/extract';

suite('qviz column extraction -- temporal unit handling', () => {

	test('ISO string is parsed via Date.parse', () => {
		const ms = convertToMs('2026-04-30T12:00:00Z', 'iso');
		assert.strictEqual(ms, Date.parse('2026-04-30T12:00:00Z'));
	});

	test('ms is identity', () => {
		assert.strictEqual(convertToMs(1_700_000_000_000, 'ms'), 1_700_000_000_000);
	});

	test('us is divided by 1000', () => {
		assert.strictEqual(convertToMs(1_700_000_000_000_000, 'us'), 1_700_000_000_000);
	});

	test('ns is divided by 1_000_000', () => {
		assert.strictEqual(convertToMs(1_700_000_000_000_000_000, 'ns'), 1_700_000_000_000);
	});

	test('ns as bigint avoids overflow', () => {
		const ns: bigint = 1_700_000_000_000_000_000n;
		assert.strictEqual(convertToMs(ns, 'ns'), 1_700_000_000_000);
	});

	test('iso requires string', () => {
		assert.throws(
			() => convertToMs(123, 'iso'),
			(e: Error) => e instanceof ExtractError && /expected ISO string/.test(e.message)
		);
	});

	test('ns requires number/bigint/string', () => {
		assert.throws(
			() => convertToMs(true as unknown, 'ns'),
			(e: Error) => e instanceof ExtractError && /expected number/.test(e.message)
		);
	});

	test('unparseable iso rejected', () => {
		assert.throws(
			() => convertToMs('not a date', 'iso'),
			(e: Error) => e instanceof ExtractError && /unparseable ISO/.test(e.message)
		);
	});

	test('non-finite ms rejected', () => {
		assert.throws(
			() => convertToMs(Infinity, 'ms'),
			(e: Error) => e instanceof ExtractError && /non-finite/.test(e.message)
		);
	});

});

suite('qviz column extraction -- extractColumnsFromJsonRows', () => {

	test('extracts temporal + numeric + string columns', () => {
		const rows = [
			{ ts: '2026-01-01T00:00:00Z', value: 10, name: 'a' },
			{ ts: '2026-01-01T00:00:01Z', value: 20, name: 'b' },
			{ ts: '2026-01-01T00:00:02Z', value: 30, name: 'c' },
		];
		const cols = extractColumnsFromJsonRows(rows, [
			{ name: 'ts', kind: 'temporal', temporalUnit: 'iso' },
			{ name: 'value', kind: 'numeric' },
			{ name: 'name', kind: 'string' },
		]);
		assert.strictEqual((cols.ts as number[])[0], Date.parse('2026-01-01T00:00:00Z'));
		assert.strictEqual((cols.value as number[])[1], 20);
		assert.strictEqual((cols.name as string[])[2], 'c');
	});

	test('preserves null values in numeric columns', () => {
		const rows = [{ v: 1 }, { v: null }, { v: 3 }];
		const cols = extractColumnsFromJsonRows(rows, [{ name: 'v', kind: 'numeric' }]);
		assert.deepStrictEqual(cols.v, [1, null, 3]);
	});

	test('parses numeric strings (DuckDB sometimes emits them)', () => {
		const rows = [{ v: '1.5' }, { v: '2' }, { v: 'not-a-number' }];
		const cols = extractColumnsFromJsonRows(rows, [{ name: 'v', kind: 'numeric' }]);
		assert.deepStrictEqual(cols.v, [1.5, 2, null]);
	});

	test('preserves nulls in temporal extraction', () => {
		const rows = [
			{ ts: '2026-01-01T00:00:00Z' },
			{ ts: null },
			{ ts: '2026-01-01T00:00:02Z' },
		];
		const cols = extractColumnsFromJsonRows(rows, [
			{ name: 'ts', kind: 'temporal', temporalUnit: 'iso' },
		]);
		assert.strictEqual((cols.ts as (number | null)[])[1], null);
	});

	test('ns timestamps from binary path get converted to ms', () => {
		const rows = [
			{ t: 1_700_000_000_000_000_000 },
			{ t: 1_700_000_001_000_000_000 },
		];
		const cols = extractColumnsFromJsonRows(rows, [
			{ name: 't', kind: 'temporal', temporalUnit: 'ns' },
		]);
		assert.strictEqual((cols.t as number[])[0], 1_700_000_000_000);
		assert.strictEqual((cols.t as number[])[1], 1_700_000_001_000);
	});

});

suite('qviz column extraction -- convertColumnToMs', () => {

	test('converts ns column to ms preserving null', () => {
		const ns = [1_700_000_000_000_000_000, null, 1_700_000_001_000_000_000];
		const ms = convertColumnToMs(ns, 'ns');
		assert.deepStrictEqual(ms, [1_700_000_000_000, null, 1_700_000_001_000]);
	});

	test('throws on unit=iso (per-row only)', () => {
		assert.throws(
			() => convertColumnToMs(['2026-01-01T00:00:00Z'] as unknown as number[], 'iso'),
			(e: Error) => e instanceof ExtractError && /per-row only/.test(e.message)
		);
	});

	test('handles bigint ns values', () => {
		const ns: (bigint | null)[] = [1_700_000_000_000_000_000n, null];
		const ms = convertColumnToMs(ns, 'ns');
		assert.deepStrictEqual(ms, [1_700_000_000_000, null]);
	});

});
