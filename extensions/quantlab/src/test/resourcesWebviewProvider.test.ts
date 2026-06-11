/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { installVscodeShim, _commandsExecuted, _errorMessagesSnapshot, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { ResourcesWebviewProvider } from '../panels/resources/ResourcesWebviewProvider';
import { ResourcesCatalogService } from '../panels/resources/ResourcesCatalogService';
import { CatalogState, ClientSection, ResourceTool } from '../types/resources';

// Megaudit W6.1 regression suite (H19 / H20 / H21 / H22 / M37): the Resources
// panel provider seam -- tool-click routing, Retry force-fetch, no-target
// feedback, and error surfacing. The catalog service is stubbed; messages are
// driven through the captured onDidReceiveMessage handler (the public seam).

class StubCatalogService {
	catalogToReturn: CatalogState | null = null;
	throwOnGetCatalog: Error | null = null;
	getCatalogCalls: (boolean | undefined)[] = [];

	async getCatalog(forceRefresh?: boolean): Promise<CatalogState | null> {
		this.getCatalogCalls.push(forceRefresh);
		if (this.throwOnGetCatalog) {
			throw this.throwOnGetCatalog;
		}
		return this.catalogToReturn;
	}

	getToolById(toolId: string): ResourceTool | undefined {
		for (const cat of [...(this.catalogToReturn?.statistics ?? []), ...(this.catalogToReturn?.strategy ?? [])]) {
			const tool = cat.tools.find(t => t.id === toolId);
			if (tool) { return tool; }
		}
		return undefined;
	}

	isOfflineResource(toolId: string): boolean {
		return toolId.startsWith('offline-');
	}

	getSectionForTool(toolId: string): ClientSection | null {
		if (this.catalogToReturn?.statistics.some(c => c.tools.some(t => t.id === toolId))) { return 'stats'; }
		if (this.catalogToReturn?.strategy.some(c => c.tools.some(t => t.id === toolId))) { return 'strategy'; }
		return null;
	}
}

function makeTool(id: string, implemented = true): ResourceTool {
	return { id, label: `Label ${id}`, description: `Description ${id}`, tier: 'essential', implemented, cross_ref: null };
}

function makeCatalog(overrides?: Partial<CatalogState>): CatalogState {
	return {
		version: '1.0',
		statistics: [{
			id: 'stat-cat', label: 'Stationarity', description: '', order: 1, icon: 'graph',
			context_hints: ['any'], tools: [makeTool('kpss')],
		}],
		strategy: [{
			id: 'strat-cat', label: 'Strategy Analysis', description: '', order: 1, icon: 'beaker',
			context_hints: ['any'], tools: [makeTool('sharpe-ratio'), makeTool('walk-forward-pro')],
		}],
		workflows: [],
		fetchedAt: Date.now(),
		...overrides,
	};
}

const stubService = new StubCatalogService();
let messageHandler: ((message: unknown) => void) | undefined;
let postedMessages: { type: string;[key: string]: unknown }[] = [];

function makeFakeWebviewView(): vscode.WebviewView {
	const fakeWebview = {
		options: {},
		html: '',
		cspSource: 'test-csp',
		asWebviewUri: (uri: vscode.Uri): vscode.Uri => uri,
		onDidReceiveMessage: (cb: (message: unknown) => void): vscode.Disposable => {
			messageHandler = cb;
			return { dispose: (): void => { /* no-op */ } };
		},
		postMessage: (message: unknown): Thenable<boolean> => {
			postedMessages.push(message as { type: string });
			return Promise.resolve(true);
		},
	};
	return {
		webview: fakeWebview,
		onDidDispose: (_cb: () => void): vscode.Disposable => ({ dispose: (): void => { /* no-op */ } }),
	} as unknown as vscode.WebviewView;
}

async function dispatch(message: unknown): Promise<void> {
	assert.ok(messageHandler, 'webview message handler not captured');
	messageHandler(message);
	// handleMessage is fire-and-forget; let the microtask chain settle.
	await new Promise(resolve => setImmediate(resolve));
}

suite('ResourcesWebviewProvider (W6.1: H19/H20/H21/H22/M37)', () => {
	let provider: ResourcesWebviewProvider;

	suiteSetup(() => {
		provider = ResourcesWebviewProvider.initialize(
			vscode.Uri.file('/test-extension'),
			stubService as unknown as ResourcesCatalogService,
		);
	});

	setup(() => {
		_resetShimState();
		stubService.catalogToReturn = makeCatalog();
		stubService.throwOnGetCatalog = null;
		stubService.getCatalogCalls = [];
		postedMessages = [];
		messageHandler = undefined;
		provider.resolveWebviewView(
			makeFakeWebviewView(),
			{} as vscode.WebviewViewResolveContext,
			{} as vscode.CancellationToken,
		);
	});

	test('H20: ready does NOT force-refresh; requestCatalog (Retry) DOES', async () => {
		await dispatch({ type: 'ready' });
		assert.deepStrictEqual(stubService.getCatalogCalls, [undefined], 'ready must not bypass the cache');

		await dispatch({ type: 'requestCatalog' });
		assert.deepStrictEqual(
			stubService.getCatalogCalls, [undefined, true],
			'Retry (requestCatalog) must force a fresh server fetch',
		);
		assert.ok(postedMessages.some(m => m.type === 'setCatalog'), 'catalog must be re-sent after Retry');
	});

	test('H19: sharpe-ratio (strategy section, TOOL_ID_MAP-bound) routes to the Stats view, not Backtest', async () => {
		await dispatch({ type: 'toolClick', toolId: 'sharpe-ratio' });

		const executed = _commandsExecuted();
		const statsCall = executed.find(c => c.command === 'quantlab.openStatsTest');
		assert.ok(statsCall, 'sharpe-ratio must dispatch quantlab.openStatsTest');
		assert.deepStrictEqual(statsCall.args, ['sharpe-ratio']);
		assert.ok(
			!executed.some(c => c.command === 'quantlab.action.openResource'),
			'sharpe-ratio must NOT route to the Action/Backtest surface',
		);
	});

	test('stats-section tools still route to the Stats view', async () => {
		await dispatch({ type: 'toolClick', toolId: 'kpss' });
		const executed = _commandsExecuted();
		assert.ok(
			executed.some(c => c.command === 'quantlab.openStatsTest' && c.args[0] === 'kpss'),
			'stats tools must dispatch quantlab.openStatsTest',
		);
	});

	test('H21: strategy tool click with no active editor/tab warns instead of doing nothing', async () => {
		// Shim has no activeTextEditor and no tabGroups -- the no-target state.
		await dispatch({ type: 'toolClick', toolId: 'walk-forward-pro' });

		const warnings = _errorMessagesSnapshot();
		assert.strictEqual(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
		assert.ok(
			warnings[0].includes('needs an open file'),
			`warning must say what the tool needs, got: ${warnings[0]}`,
		);
		assert.ok(
			!_commandsExecuted().some(c => c.command === 'quantlab.action.openResource'),
			'no action dispatch may happen without a target',
		);
	});

	test('H22: getCatalog failure is logged AND surfaced as catalogUnavailable', async () => {
		stubService.throwOnGetCatalog = new Error('boom: network down');
		const errors: unknown[][] = [];
		const originalConsoleError = console.error;
		console.error = (...args: unknown[]): void => { errors.push(args); };
		try {
			await dispatch({ type: 'ready' });
		} finally {
			console.error = originalConsoleError;
		}

		const unavailable = postedMessages.find(m => m.type === 'catalogUnavailable');
		assert.ok(unavailable, 'webview must receive a visible catalogUnavailable error state');
		assert.ok(
			errors.some(args => args.some(a => a instanceof Error && a.message.includes('boom'))),
			'the underlying error must be logged (No-Fallbacks)',
		);
	});

	test('M37: offline-only catalog sends an offline indicator after setCatalog', async () => {
		stubService.catalogToReturn = makeCatalog({ version: 'offline' });
		await dispatch({ type: 'ready' });

		const types = postedMessages.map(m => m.type);
		const setIdx = types.indexOf('setCatalog');
		const errIdx = types.indexOf('catalogError');
		assert.ok(setIdx !== -1, 'setCatalog must still be sent');
		assert.ok(errIdx > setIdx, 'offline banner must follow the catalog');
		const banner = postedMessages[errIdx] as { errorType?: string };
		assert.strictEqual(banner.errorType, 'offline');
	});

	test('stale cached catalog still produces the stale-cache banner', async () => {
		stubService.catalogToReturn = makeCatalog({ fetchedAt: Date.now() - 25 * 60 * 60 * 1000 });
		await dispatch({ type: 'ready' });

		const banner = postedMessages.find(m => m.type === 'catalogError') as { errorType?: string } | undefined;
		assert.ok(banner, 'stale-cache banner must be sent');
		assert.strictEqual(banner.errorType, 'stale-cache');
	});
});
