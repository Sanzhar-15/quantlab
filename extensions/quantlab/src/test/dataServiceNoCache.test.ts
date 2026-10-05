/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataService } from '../core/engine/DataService';
import { ServerApiClient, ServerBar } from '../core/server/ServerApiClient';

// QL-DATA DT-3: the extension keeps NO market-data cache. The one bars cache
// lives in the host's main data module (Q-3), so DataService reads through
// to the transport on every call, and ChartViewProvider keeps no bar slot.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const DAY_MS = 24 * 60 * 60 * 1000;

function serverBar(t: number, i: number, timestamp?: string): ServerBar {
	return {
		symbol: 'TEST',
		timestamp: timestamp ?? new Date(t).toISOString(),
		open: 100 + i,
		high: 101 + i,
		low: 99 + i,
		close: 100.5 + i,
		volume: 1000 + i
	};
}

/** The text between each `Map<` and its matching `>` (nested generics included). */
function mapTypeArguments(source: string): string[] {
	const out: string[] = [];
	const re = /\bMap\s*</g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		while (i < source.length && depth > 0) {
			if (source[i] === '<') { depth++; }
			if (source[i] === '>') { depth--; }
			i++;
		}
		out.push(source.slice(start, i - 1));
	}
	return out;
}

/** OhlcvBar plus every interface/type in the file whose body names a bar-holding type. */
function barHoldingTypes(source: string): string[] {
	const types = new Set<string>(['OhlcvBar', 'ServerBar', 'MarketDataResult']);
	const decls: [string, string][] = [];
	const re = /\b(?:interface|type)\s+(\w+)[^{=]*[{=]([^}]*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		decls.push([m[1], m[2]]);
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const [name, body] of decls) {
			if (!types.has(name) && Array.from(types).some(t => new RegExp(`\\b${t}\\b`).test(body))) {
				types.add(name);
				grew = true;
			}
		}
	}
	return Array.from(types);
}

suite('DT-3: DataService holds no market-data cache', () => {
	let calls = 0;
	let nextBars: () => ServerBar[] = () => [];
	const originalGetInstance = ServerApiClient.getInstance;
	const fakeClient = {
		getBars: async (): Promise<ServerBar[]> => {
			calls++;
			return nextBars();
		}
	} as unknown as ServerApiClient;

	suiteSetup(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = () => fakeClient;
	});

	suiteTeardown(() => {
		(ServerApiClient as unknown as { getInstance(): ServerApiClient }).getInstance = originalGetInstance;
		DataService.resetInstance();
		_resetShimState();
	});

	setup(() => {
		calls = 0;
		_resetShimState();
		DataService.resetInstance();
		const end = Date.now();
		nextBars = () => [0, 1, 2].map(i => serverBar(end - (2 - i) * DAY_MS, i));
	});

	test('two identical server reads make two transport calls', async () => {
		// NEGATIVE CONTROL: re-enable the server-bars cache in getOHLCVFromServer
		// (getFromCache/setCache keyed on symbol+timeframe+range) -> the second
		// read is served from memory -> calls === 1 -> RED.
		const range = { start: new Date(Date.now() - 10 * DAY_MS).toISOString(), end: new Date().toISOString() };
		const service = DataService.getInstance();
		const first = await service.getOHLCVFromServer('TEST', '1D', range);
		const second = await service.getOHLCVFromServer('TEST', '1D', range);
		assert.strictEqual(first.data.length, 3);
		assert.strictEqual(second.data.length, 3);
		assert.strictEqual(calls, 2, `expected 2 transport calls, made ${calls}`);
	});

	test('concurrent identical server reads are not deduplicated in the extension', async () => {
		// NEGATIVE CONTROL: restore the `inflight` map (concurrent reads of one
		// key share a single promise) -> calls === 1 -> RED.
		const range = { start: new Date(Date.now() - 10 * DAY_MS).toISOString(), end: new Date().toISOString() };
		const service = DataService.getInstance();
		await Promise.all([
			service.getOHLCVFromServer('TEST', '1D', range),
			service.getOHLCVFromServer('TEST', '1D', range)
		]);
		assert.strictEqual(calls, 2, `expected 2 transport calls, made ${calls}`);
	});

	test('a changed local CSV is re-read even when its mtime and size are unchanged', async () => {
		// NEGATIVE CONTROL: restore the file-bars cache in loadCsvFile (keyed on
		// path+mtimeMs+size) or the result cache in getOHLCVFromFile -> the second
		// load returns the stale open of 100 -> RED.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-dt3-'));
		const file = path.join(dir, 'bars.csv');
		const csv = (open: string) => [
			'timestamp,open,high,low,close,volume',
			`2024-01-01T00:00:00Z,${open},301,99,100.5,1000`,
			'2024-01-02T00:00:00Z,100,301,99,100.5,1000'
		].join('\n');
		try {
			fs.writeFileSync(file, csv('100'));
			const before = fs.statSync(file);
			const service = DataService.getInstance();
			const first = await service.getOHLCVFromFile(file);
			assert.strictEqual(first.data[0].o, 100);

			fs.writeFileSync(file, csv('200'));
			fs.utimesSync(file, before.atime, before.mtime);
			const after = fs.statSync(file);
			assert.strictEqual(after.size, before.size, 'fixture keeps the size');
			// utimes takes whole milliseconds; mtimeMs can carry a sub-millisecond part the restore cannot write back.
			assert.strictEqual(Math.trunc(after.mtimeMs), Math.trunc(before.mtimeMs), 'fixture keeps the mtime');

			const second = await service.getOHLCVFromFile(file);
			assert.strictEqual(second.data[0].o, 200, 'the second load must re-read the file');
		} finally {
			fs.unlinkSync(file);
			fs.rmdirSync(dir);
		}
	});

	test('an unparseable server timestamp is an error, not a NaN bar', async () => {
		// NEGATIVE CONTROL: restore the old fallback in normalizeTimestamp
		// (`return new Date(timestamp).getTime()` when the UTC parse fails, no
		// throw) -> the read resolves with a NaN-time bar -> RED.
		nextBars = () => [serverBar(0, 0, 'not-a-timestamp')];
		await assert.rejects(
			() => DataService.getInstance().getOHLCVFromServer('TEST', '1D', {
				start: new Date(Date.now() - 10 * DAY_MS).toISOString(),
				end: new Date().toISOString()
			}),
			/Unparseable bar timestamp in server response: 'not-a-timestamp'/
		);
	});

	test('no Map member of DataService or ChartViewProvider holds bars (structural)', () => {
		// NEGATIVE CONTROL: re-add `private readonly dataCache = new Map<string, OhlcvBar[]>();`
		// to ChartViewProvider (or `cache = new Map<string, CacheEntry>()` with
		// `interface CacheEntry { data: OhlcvBar[] }` to DataService) -> the
		// offender list is non-empty -> RED.
		for (const rel of ['src/core/engine/DataService.ts', 'src/views/chart/ChartViewProvider.ts']) {
			const source = fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');
			const barTypes = barHoldingTypes(source);
			// Members only (one-tab indent with a modifier): a Map local to a method body is not a cache.
			const members = source.split('\n').filter(line => /^\t(?:(?:private|protected|public|readonly|static)\s+)+\w+/.test(line)).join('\n');
			const offenders = mapTypeArguments(members).filter(args =>
				barTypes.some(t => new RegExp(`\\b${t}\\b`).test(args))
			);
			assert.deepStrictEqual(offenders, [], `${rel} holds bars in a Map: ${offenders.join(' | ')}`);
		}
	});
});
