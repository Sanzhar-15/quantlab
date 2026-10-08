/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';

// QL-G-FEAT c1 M6: the omission warning for non-finite equity points / signal prices is the lasting 'run'
// banner. The real loadRunArtifacts, setBanner and renderBanner run; only the collaborators around them
// (history, artifact cache, webview) are stubs.

interface Banner {
	message: string;
	tone?: string;
}

interface RunArtifacts {
	equity: Array<{ t: number; v: number | null }>;
	signals: Array<{ t: number; type: 'entry' | 'exit'; price?: number | null }>;
}

function makeHarness(runs: Record<string, RunArtifacts>, noHistoryEntry: string[] = []) {
	const banners: Banner[] = [];
	const session = {
		key: 'session-1',
		document: { uri: { scheme: 'file', fsPath: '/ws/strategy.py' } },
		webview: {
			postMessage: (message: { type: string; message?: string; tone?: string }) => {
				if (message.type === 'showBanner') {
					banners.push({ message: message.message ?? '', tone: message.tone });
				}
				return true;
			},
		},
	};
	const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
	Object.assign(provider, {
		bannerState: new Map(),
		isSessionActive: () => true,
		getRunArtifacts: async (runId: string) => runs[runId],
		setArtifactCache: () => { /* not under test */ },
		executeWithErrorBoundary: () => { /* the refresh is not under test */ },
		historyState: { getEntry: (runId: string) => noHistoryEntry.includes(runId) ? undefined : { id: runId, type: 'backtest' } },
	});
	const load = (runId: string) => (provider as unknown as { loadRunArtifacts(s: unknown, id: string): Promise<void> }).loadRunArtifacts(session, runId);
	return { load, last: (): Banner => banners[banners.length - 1] };
}

suite('CHART-M6: the run banner keeps the omission warning', () => {
	const NON_FINITE: RunArtifacts = {
		equity: [{ t: 1, v: 100 }, { t: 2, v: null }],
		signals: [{ t: 1, type: 'entry', price: null }, { t: 2, type: 'exit', price: 10 }],
	};
	const FINITE: RunArtifacts = {
		equity: [{ t: 1, v: 100 }, { t: 2, v: 101 }],
		signals: [{ t: 1, type: 'entry', price: 10 }],
	};

	test('a history run with a null equity value and a null signal price: the final banner is a warning holding both counts', async () => {
		const harness = makeHarness({ test: NON_FINITE });
		await harness.load('test');
		assert.deepStrictEqual(harness.last(), {
			message: 'Showing results for backtest run test. 1 equity point(s) and 1 signal price(s) of this run are not finite and are not drawn.',
			tone: 'warning',
		});
	});

	test('loading a fully finite run afterwards shows no warning', async () => {
		const harness = makeHarness({ test: NON_FINITE, finite: FINITE });
		await harness.load('test');
		await harness.load('finite');
		assert.deepStrictEqual(harness.last(), { message: 'Showing results for backtest run finite.', tone: 'info' });
	});

	test('a finite run with no history entry clears the warning left by the run before it', async () => {
		const harness = makeHarness({ test: NON_FINITE, orphan: FINITE }, ['orphan']);
		await harness.load('test');
		assert.strictEqual(harness.last().tone, 'warning');
		await harness.load('orphan');
		assert.deepStrictEqual(harness.last(), { message: '', tone: undefined });
	});

	test('a non-finite run with no history entry still shows the warning', async () => {
		const harness = makeHarness({ test: NON_FINITE }, ['test']);
		await harness.load('test');
		assert.deepStrictEqual(harness.last(), {
			message: '1 equity point(s) and 1 signal price(s) of this run are not finite and are not drawn.',
			tone: 'warning',
		});
	});
});
