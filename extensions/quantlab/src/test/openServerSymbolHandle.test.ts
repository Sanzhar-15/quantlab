/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { ChartViewProvider } from '../views/chart/ChartViewProvider';
import { openServerSymbol } from '../commands/globalStateCommands';
import { etfOrIndexDisplayName, mintServerSymbolHandle } from '../panels/data/serverSymbolHandles';

// HOST review c1 M1: a public command cannot produce an authorised server request from caller-supplied arguments.
// `quantlab.setServerDataSource` is gone; `quantlab.openServerSymbol` takes only a handle DataTreeProvider minted.
// The spy is the chart's reload of an existing session with no per-tab overrides (ChartViewProvider.refreshFromGlobal ->
// reloadData, the step before DataService and ServerApiClient's transport).

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');

class MockMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();
	get<T>(key: string, defaultValue?: T): T {
		return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
	}
	update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);
		return Promise.resolve();
	}
	keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

interface Spy {
	reloads: number;
	changes: number;
	dispose(): void;
}

/** An existing chart session without overrides, wired to the global data source as ChartViewProvider's constructor wires it. */
function chartSessionSpy(globalState: GlobalState): Spy {
	const spy = { reloads: 0, changes: 0 };
	const provider = Object.create(ChartViewProvider.prototype) as Record<string, unknown>;
	Object.assign(provider, {
		sessions: new Map([['session-1', { key: 'session-1', tabInstanceId: 'tab-1' }]]),
		stateManager: { getChartState: () => ({}) },
		refreshToolbar: () => undefined,
		executeWithErrorBoundary: (fn: () => unknown) => fn(),
		reloadData: () => { spy.reloads++; }
	});
	const refreshFromGlobal = (provider as unknown as { refreshFromGlobal(kind: 'dataSource'): void }).refreshFromGlobal.bind(provider);
	const subscription = globalState.onDidChangeDataSource(() => {
		spy.changes++;
		refreshFromGlobal('dataSource');
	});
	return Object.assign(spy, { dispose: () => subscription.dispose() });
}

suite('HOST c1 M1: public QuantLab commands carry no caller-controlled server selection', () => {
	let globalState: GlobalState;

	// The singleton is shared with other suites (they capture it at load): initialize returns the existing one; never reset it.
	setup(() => {
		globalState = GlobalState.initialize({ workspaceState: new MockMemento(), globalState: new MockMemento(), subscriptions: [] } as unknown as vscode.ExtensionContext);
		globalState.setDataSource(undefined);
	});

	test('untrusted arguments are refused by name: nothing changes and no session reloads', async () => {
		const spy = chartSessionSpy(globalState);
		const untrusted: unknown[][] = [
			['AAPL', 'Apple Inc.', 'equities'],
			[{ kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.', assetClass: 'equities' }],
			['00000000-0000-4000-8000-000000000000'],
			[undefined]
		];
		for (const args of untrusted) {
			await assert.rejects((openServerSymbol as (...a: unknown[]) => Promise<void>)(...args), /quantlab\.openServerSymbol refused: its argument is not a handle minted by the QuantLab data tree/);
		}
		assert.strictEqual(globalState.getDataSource(), undefined);
		assert.deepStrictEqual({ changes: spy.changes, reloads: spy.reloads }, { changes: 0, reloads: 0 });
		spy.dispose();
	});

	test('a handle the data tree minted selects its symbol and reloads the session once (trusted UI path)', async () => {
		const spy = chartSessionSpy(globalState);
		const handle = mintServerSymbolHandle('AAPL', 'Apple Inc.', 'equities');
		assert.strictEqual(mintServerSymbolHandle('AAPL', 'Apple Inc.', 'equities'), handle, 'one handle per rendered symbol');
		await openServerSymbol(handle);
		assert.deepStrictEqual(globalState.getDataSource(), { kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.', assetClass: 'equities' });
		assert.deepStrictEqual({ changes: spy.changes, reloads: spy.reloads }, { changes: 1, reloads: 1 });
		spy.dispose();
	});

	test('an ETF or index item without a name (optional in the server contract) is labelled by its ticker', () => {
		assert.strictEqual(etfOrIndexDisplayName('SPY', undefined), 'SPY');
	});

	test('an ETF or index item with a name is labelled by its name', () => {
		assert.strictEqual(etfOrIndexDisplayName('SPY', 'SPDR S&P 500 ETF Trust'), 'SPDR S&P 500 ETF Trust');
	});

	test('wiring: setServerDataSource is gone; openServerSymbol is registered as the handle-only function; every tree site mints', () => {
		const sources = [read('package.json'), read('src/commands/globalStateCommands.ts'), read('src/panels/data/DataTreeProvider.ts')];
		assert.ok(sources.every(text => !/['"]quantlab\.setServerDataSource['"]/.test(text)), 'quantlab.setServerDataSource is still named');
		assert.match(sources[1], /registerCommand\('quantlab\.openServerSymbol', openServerSymbol\)/);
		const tree = sources[2];
		const sites = tree.split(`command: 'quantlab.openServerSymbol'`).slice(1).map(after => after.slice(0, after.indexOf(']') + 1));
		assert.strictEqual(sites.length, 5);
		assert.ok(sites.every(site => /arguments: \[mintServerSymbolHandle\([^]*\)\]$/.test(site)), `a tree site passes raw arguments: ${sites.join(' | ')}`);
	});
});
