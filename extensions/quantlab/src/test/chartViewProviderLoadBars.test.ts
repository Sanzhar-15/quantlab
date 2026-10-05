/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import * as vscodeShim from '../../test/helpers/vscode-shim';
import 'mocha';
import * as assert from 'assert';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { OhlcvBar } from '../types/chart';

// QL-DATA DT-3 / CHART-u (CHARTS-visible): ChartViewProvider keeps no bar
// slot. refreshVisualization without `data` re-reads the bars through
// loadBars every time; with `data` it fetches nothing; a failed load is shown
// on the chart instead of rejecting into the debounced caller (no catch there).

function makeToken(state: { cancelled: boolean }) {
	return {
		get isCancellationRequested(): boolean { return state.cancelled; },
		onCancellationRequested: () => ({ dispose(): void { /* no listeners kept */ } })
	};
}

/** The shim has no CancellationTokenSource; this suite installs a minimal one. */
class FakeCancellationTokenSource {
	private readonly state = { cancelled: false };
	readonly token = makeToken(this.state);
	cancel(): void { this.state.cancelled = true; }
	dispose(): void { /* nothing held */ }
}

const BARS: OhlcvBar[] = [
	{ t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
	{ t: 2000, o: 1.5, h: 3, l: 1, c: 2.5, v: 20 }
];

interface Posted {
	type: string;
	detail?: string;
}

interface Harness {
	refresh(data?: OhlcvBar[]): Promise<void>;
	loadBarsCalls(): number;
	posted: Posted[];
}

function makeHarness(dataSource: unknown, loadBars: () => Promise<{ data: OhlcvBar[] }>): Harness {
	const posted: Posted[] = [];
	let calls = 0;
	let vizRequestId = 0;
	const session = {
		key: 'session-1',
		document: { uri: { scheme: 'file', fsPath: '/ws/strategy.py' } },
		webview: { postMessage: (message: Posted) => { posted.push(message); return true; } }
	};
	// Object.create skips the class-field initializers (their singletons need
	// the real VS Code runtime); the collaborators refreshVisualization reads
	// up to the view-only branch are stubbed below.
	const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
	Object.assign(provider, {
		sessions: new Map([[session.key, session]]),
		chartStateStore: {
			nextVizRequestId: () => ++vizRequestId,
			isVizRequestCurrent: (_key: string, id: number) => id === vizRequestId
		},
		parameterExtractor: { extract: () => ({ parameters: [] }) },
		complexityAnalyzer: { analyze: () => ({ level: 'viewOnly', score: 0, reasons: [] }) },
		visualizationDetector: { detect: () => ({ hasVisualization: false }) },
		buildToolbarState: () => ({ dataSource, timeframe: '1D', complexity: { level: 'viewOnly', score: 0, reasons: [] }, hasVisualization: false, viewOnly: true, mode: 'strategy' }),
		loadBars: async () => {
			calls++;
			return loadBars();
		}
	});
	const refreshVisualization = (provider as unknown as {
		refreshVisualization(session: unknown, data?: OhlcvBar[]): Promise<void>;
	}).refreshVisualization.bind(provider);
	return {
		refresh: (data?: OhlcvBar[]) => refreshVisualization(session, data),
		loadBarsCalls: () => calls,
		posted
	};
}

const SERVER_SOURCE = { kind: 'server', symbol: 'TEST', displayName: 'TEST' };

suite('CHART-u: ChartViewProvider keeps no bar slot (DT-3)', () => {
	const shimExports = vscodeShim as unknown as Record<string, unknown>;
	const hadTokenSource = Object.prototype.hasOwnProperty.call(shimExports, 'CancellationTokenSource');
	const previousTokenSource = shimExports.CancellationTokenSource;

	suiteSetup(() => {
		shimExports.CancellationTokenSource = FakeCancellationTokenSource;
	});

	suiteTeardown(() => {
		if (hadTokenSource) {
			shimExports.CancellationTokenSource = previousTokenSource;
		} else {
			delete shimExports.CancellationTokenSource;
		}
	});

	test('without data, every refresh re-reads the bars through loadBars', async () => {
		// NEGATIVE CONTROL: re-add a bar slot (`data ?? this.dataCache.get(session.key)`,
		// filled by reloadData or by loadBars' result) -> the refreshes read the
		// slot instead -> loadBars calls < 2 -> RED.
		const harness = makeHarness(SERVER_SOURCE, async () => ({ data: BARS }));
		await harness.refresh();
		await harness.refresh();
		assert.strictEqual(harness.loadBarsCalls(), 2, `expected 2 loadBars calls, made ${harness.loadBarsCalls()}`);
		assert.strictEqual(harness.posted.filter(m => m.type === 'setVisualization').length, 2, 'both refreshes drew');
	});

	test('with data, a refresh fetches nothing', async () => {
		// NEGATIVE CONTROL: call loadBars unconditionally (ignore `data`) ->
		// loadBars calls === 1 -> RED.
		const harness = makeHarness(SERVER_SOURCE, async () => ({ data: BARS }));
		await harness.refresh(BARS);
		assert.strictEqual(harness.loadBarsCalls(), 0);
		assert.strictEqual(harness.posted.filter(m => m.type === 'setVisualization').length, 1);
	});

	test('a failed bars load is shown on the chart, not rejected into the debounce', async () => {
		// NEGATIVE CONTROL: remove the try/catch around loadBars in
		// refreshVisualization -> refresh() rejects with 'upstream:503' -> RED.
		const harness = makeHarness(SERVER_SOURCE, async () => { throw new Error('upstream:503'); });
		await harness.refresh();
		const errors = harness.posted.filter(m => m.type === 'showError');
		assert.strictEqual(errors.length, 1, 'one showError posted');
		assert.strictEqual(errors[0].detail, 'upstream:503');
	});

	test('with no data source selected, nothing is fetched or drawn', async () => {
		// NEGATIVE CONTROL: drop the `!toolbar.dataSource` guard -> loadBars is
		// called -> calls === 1 -> RED.
		const harness = makeHarness(undefined, async () => ({ data: BARS }));
		await harness.refresh();
		assert.strictEqual(harness.loadBarsCalls(), 0);
		assert.deepStrictEqual(harness.posted, []);
	});
});
