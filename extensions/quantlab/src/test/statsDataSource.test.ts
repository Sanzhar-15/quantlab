/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//  Megaudit 2026-06-11 W7-C regression suite:
//    M132 -- stats data-source resolution must refuse honestly (no silent
//            localFile fallback onto a path that does not exist) and prefer
//            the active Data-panel selection;
//    M45  -- the 'pp' stationarity tool must not claim to be Phillips-Perron
//            (statsmodels has no PP; it runs ADF with t-stat lag selection);
//    M102 -- qviz-spec.css active/primary buttons use the brand accent chain.

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import {
	resolveEffectiveStatsSource,
	NO_DATA_SOURCE_NOTICE,
	SERVER_BAR_COLUMNS,
} from '../views/stats/StatsViewProvider';
import { DataSourceDescriptor } from '../types/market';
import { getTestById } from '../stats/StatsCatalog';

// out/src/test -> extension root
const extensionRoot = path.resolve(__dirname, '..', '..', '..');

function read(relPath: string): string {
	return fs.readFileSync(path.join(extensionRoot, relPath), 'utf8');
}

suite('stats data-source resolution (M132)', () => {
	const never = (_p: string): boolean => false;
	const always = (_p: string): boolean => true;

	test('active server symbol wins regardless of local files', () => {
		const active: DataSourceDescriptor = { kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.' };
		const r = resolveEffectiveStatsSource(active, '/no/such/file.csv', never);
		assert.deepStrictEqual(r.source, active);
		assert.strictEqual(r.reason, undefined);
	});

	test('active local file that exists is used as-is', () => {
		const active: DataSourceDescriptor = { kind: 'localFile', filePath: '/data/x.csv', displayName: 'x.csv' };
		const r = resolveEffectiveStatsSource(active, '/editor/y.csv', always);
		assert.deepStrictEqual(r.source, active);
	});

	test('active local file that is GONE refuses with the path (no silent skip)', () => {
		const active: DataSourceDescriptor = { kind: 'localFile', filePath: '/data/gone.csv', displayName: 'gone.csv' };
		const r = resolveEffectiveStatsSource(active, '/editor/y.csv', never);
		assert.strictEqual(r.source, undefined);
		assert.ok(r.reason !== undefined, 'a refusal must carry a reason');
		assert.ok(r.reason.includes('/data/gone.csv'), 'reason must name the missing file');
		assert.ok(r.reason.includes(NO_DATA_SOURCE_NOTICE), 'reason must include the how-to notice');
	});

	test('no active source + editor file on disk -> the editor file', () => {
		const r = resolveEffectiveStatsSource(undefined, '/editor/prices.csv', always);
		assert.deepStrictEqual(r.source, {
			kind: 'localFile',
			filePath: '/editor/prices.csv',
			displayName: 'prices.csv',
		});
	});

	test('no active source + NO editor file -> honest refusal (the old code fabricated a localFile descriptor here)', () => {
		const r = resolveEffectiveStatsSource(undefined, '/virtual/does-not-exist.csv', never);
		assert.strictEqual(r.source, undefined);
		assert.strictEqual(r.reason, NO_DATA_SOURCE_NOTICE);
	});

	test('SERVER_BAR_COLUMNS mirrors the numeric ServerBar fields', () => {
		assert.deepStrictEqual(
			SERVER_BAR_COLUMNS.map(c => c.name),
			['open', 'high', 'low', 'close', 'volume'],
		);
		for (const c of SERVER_BAR_COLUMNS) {
			assert.strictEqual(c.dtype, 'float64');
		}
	});
});

suite('pp test label honesty (M45)', () => {
	test(`StatsCatalog 'pp' no longer claims Phillips-Perron`, () => {
		const def = getTestById('pp');
		assert.ok(def, `catalog entry 'pp' must exist (routing id is unchanged)`);
		assert.strictEqual(def.label, 'ADF (t-stat autolag)');
		assert.ok(
			def.description.includes('Phillips-Perron pending'),
			'description must say PP is pending, not implemented',
		);
	});

	test('stationarity.py pp_test result is labeled as ADF, not Phillips-Perron', () => {
		const py = read('python/stats/tests/stationarity.py');
		assert.ok(
			py.includes(`'testName': 'ADF (t-stat autolag)'`),
			'pp_test must label its output as ADF (t-stat autolag)',
		);
		assert.ok(
			!py.includes(`'testName': 'Phillips-Perron Test'`),
			'pp_test must not label ADF output as Phillips-Perron',
		);
		assert.ok(
			py.includes(`'testId': 'pp'`),
			`the routing id 'pp' must stay (runner.py keys on it)`,
		);
	});
});

suite('qviz-spec accent chain (M102)', () => {
	const css = read('webview/qviz-spec/qviz-spec.css');

	test('qviz-spec.css defines the canonical --ql-accent chain', () => {
		assert.match(css, /--ql-accent:\s*var\(--vscode-quantlabAccent,\s*#FF7331\)/);
		assert.doesNotMatch(css, /--ql-accent:\s*#/, 'must not clobber --ql-accent with a plain hex');
	});

	test('qviz-spec.css has no line-comment syntax (// drops the next rule when bundled)', () => {
		assert.doesNotMatch(css, /^\s*\/\/(?!.*\*\/)/m, 'use /* */ comments only in css');
	});

	for (const selector of [
		'.qviz-chart-type-button--active',
		'.qviz-inspector-toggle--active',
		'.qviz-inspector-retry',
		'.qviz-col-filter-btn--active',
		'.qviz-histogram-preset-btn',
	]) {
		test(`${selector} uses the brand accent, not --vscode-button-background`, () => {
			const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const m = new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(css);
			assert.ok(m, `rule ${selector} must exist in qviz-spec.css`);
			assert.ok(m[0].includes('var(--ql-accent)'), `${selector} must use var(--ql-accent)`);
			assert.ok(
				!m[0].includes('--vscode-button-background'),
				`${selector} must not use --vscode-button-background`,
			);
		});
	}
});
