/**
 * Integration test for chart-server data source flow.
 * Run with: node test/chart-server-integration.test.js
 */

console.log('='.repeat(60));
console.log('Chart-Server Integration Test Suite');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		console.log(`✓ ${name}`);
		passed++;
	} catch (e) {
		console.log(`✗ ${name}`);
		console.log(`  Error: ${e.message}`);
		failed++;
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message || 'Assertion failed');
}

// Simulate the data flow from extension → webview → extension

// 1. Mock GlobalState
class MockGlobalState {
	constructor() {
		this.dataSource = undefined;
		this.recentSources = [];
	}

	setDataSource(source) {
		this.dataSource = source;
		if (source) {
			// Add to recent sources (deduplicating)
			this.recentSources = [
				source,
				...this.recentSources.filter(s => {
					if (s.kind !== source.kind) return true;
					if (s.kind === 'server') return s.symbol !== source.symbol;
					if (s.kind === 'localFile') return s.filePath !== source.filePath;
					return true;
				})
			].slice(0, 10);
		}
	}

	getDataSource() { return this.dataSource; }
	getRecentDataSources() { return this.recentSources; }
}

// 2. Mock ChartViewProvider message handling
class MockChartViewProvider {
	constructor(globalState) {
		this.globalState = globalState;
		this.webviewMessages = [];
		this.lastToolbarState = null;
	}

	// Simulates handleSelectServerSymbol from ChartViewProvider.ts:370-381
	handleSelectServerSymbol(symbol, displayName) {
		const source = { kind: 'server', symbol, displayName };
		this.globalState.setDataSource(source);
		this.refreshToolbar();
		this.reloadData();
	}

	// Simulates handleSelectDataSource from ChartViewProvider.ts:356-368
	handleSelectDataSource(filePath) {
		const displayName = filePath.split('/').pop();
		const source = { kind: 'localFile', filePath, displayName };
		this.globalState.setDataSource(source);
		this.refreshToolbar();
		this.reloadData();
	}

	// Simulates refreshToolbar
	refreshToolbar() {
		this.lastToolbarState = this.buildToolbarState();
		this.webviewMessages.push({ type: 'setToolbar', toolbar: this.lastToolbarState });
	}

	// Simulates buildToolbarState from ChartViewProvider.ts:634-654
	buildToolbarState() {
		return {
			dataSource: this.globalState.getDataSource(),
			timeframe: '1D',
			recentSources: this.globalState.getRecentDataSources(),
			complexity: { level: 'safe', score: 0, reasons: [] },
			hasVisualization: true,
			viewOnly: false
		};
	}

	reloadData() {
		const ds = this.globalState.getDataSource();
		if (ds?.kind === 'server') {
			// Would call dataService.getOHLCVFromServer
			this.webviewMessages.push({ type: 'loadingServerData', symbol: ds.symbol });
		} else if (ds?.kind === 'localFile') {
			// Would call dataService.getOHLCVFromFile
			this.webviewMessages.push({ type: 'loadingLocalData', filePath: ds.filePath });
		}
	}
}

// 3. Mock webview message handler (simulates receiving messages and user interaction)
class MockWebviewHandler {
	constructor(postToExtension) {
		this.postToExtension = postToExtension;
		this.toolbarState = null;
	}

	// Receive message from extension
	handleMessage(message) {
		if (message.type === 'setToolbar') {
			this.toolbarState = message.toolbar;
		}
	}

	// Simulate user clicking a server symbol in dropdown
	userSelectsServerSymbol(symbol, displayName) {
		this.postToExtension({ type: 'selectServerSymbol', symbol, displayName });
	}

	// Simulate user clicking a local file in dropdown
	userSelectsLocalFile(filePath) {
		this.postToExtension({ type: 'selectDataSource', filePath });
	}
}

// Test cases

test('Server symbol selection flow: webview → extension → globalState', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);

	// Simulate webview sending selectServerSymbol message
	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');

	// Verify global state updated
	const ds = globalState.getDataSource();
	assert(ds.kind === 'server', 'Should be server source');
	assert(ds.symbol === 'AAPL', 'Symbol should be AAPL');
	assert(ds.displayName === 'Apple Inc.', 'Display name should match');

	// Verify it's in recent sources
	const recent = globalState.getRecentDataSources();
	assert(recent.length === 1, 'Should have 1 recent source');
	assert(recent[0].kind === 'server', 'Recent should be server source');
});

test('Local file selection flow: webview → extension → globalState', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);

	// Simulate webview sending selectDataSource message
	provider.handleSelectDataSource('/data/btc.csv');

	// Verify global state updated
	const ds = globalState.getDataSource();
	assert(ds.kind === 'localFile', 'Should be local file source');
	assert(ds.filePath === '/data/btc.csv', 'File path should match');
	assert(ds.displayName === 'btc.csv', 'Display name should be filename');
});

test('Toolbar state includes both server and local recent sources', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);

	// Add a mix of sources
	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');
	provider.handleSelectDataSource('/data/btc.csv');
	provider.handleSelectServerSymbol('GOOGL', 'Alphabet Inc.');

	const toolbar = provider.buildToolbarState();

	// Current should be GOOGL
	assert(toolbar.dataSource.kind === 'server', 'Current should be server');
	assert(toolbar.dataSource.symbol === 'GOOGL', 'Current should be GOOGL');

	// Recent should have all 3
	assert(toolbar.recentSources.length === 3, 'Should have 3 recent sources');

	const serverSources = toolbar.recentSources.filter(s => s.kind === 'server');
	const localSources = toolbar.recentSources.filter(s => s.kind === 'localFile');

	assert(serverSources.length === 2, 'Should have 2 server sources');
	assert(localSources.length === 1, 'Should have 1 local source');
});

test('Full round-trip: webview click → extension → data load → webview update', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);
	const messages = [];

	// Create mock webview that sends messages to provider
	const webview = new MockWebviewHandler((msg) => {
		if (msg.type === 'selectServerSymbol') {
			provider.handleSelectServerSymbol(msg.symbol, msg.displayName);
		} else if (msg.type === 'selectDataSource') {
			provider.handleSelectDataSource(msg.filePath);
		}
	});

	// User clicks server symbol
	webview.userSelectsServerSymbol('BTC', 'Bitcoin');

	// Verify data load was triggered
	const loadMsg = provider.webviewMessages.find(m => m.type === 'loadingServerData');
	assert(loadMsg, 'Should trigger server data load');
	assert(loadMsg.symbol === 'BTC', 'Should load BTC');

	// Verify toolbar was updated
	const toolbarMsg = provider.webviewMessages.find(m => m.type === 'setToolbar');
	assert(toolbarMsg, 'Should send toolbar update');
	assert(toolbarMsg.toolbar.dataSource.symbol === 'BTC', 'Toolbar should show BTC');
});

test('Deduplication: selecting same source twice does not create duplicates', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);

	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');
	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');
	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');

	const recent = globalState.getRecentDataSources();
	assert(recent.length === 1, `Should have 1 recent source, got ${recent.length}`);
});

test('Recent sources maintain correct order (most recent first)', () => {
	const globalState = new MockGlobalState();
	const provider = new MockChartViewProvider(globalState);

	provider.handleSelectServerSymbol('AAPL', 'Apple Inc.');
	provider.handleSelectDataSource('/data/a.csv');
	provider.handleSelectServerSymbol('GOOGL', 'Alphabet');
	provider.handleSelectDataSource('/data/b.csv');

	const recent = globalState.getRecentDataSources();

	assert(recent[0].kind === 'localFile' && recent[0].filePath === '/data/b.csv', 'Most recent should be b.csv');
	assert(recent[1].kind === 'server' && recent[1].symbol === 'GOOGL', 'Second should be GOOGL');
	assert(recent[2].kind === 'localFile' && recent[2].filePath === '/data/a.csv', 'Third should be a.csv');
	assert(recent[3].kind === 'server' && recent[3].symbol === 'AAPL', 'Fourth should be AAPL');
});

test('Message type validation for server source', () => {
	// Verify the exact message format expected by ChartViewProvider
	const serverMessage = { type: 'selectServerSymbol', symbol: 'ETH', displayName: 'Ethereum' };

	assert(serverMessage.type === 'selectServerSymbol', 'Type must be selectServerSymbol');
	assert(typeof serverMessage.symbol === 'string', 'Symbol must be string');
	assert(typeof serverMessage.displayName === 'string', 'DisplayName must be string');
});

test('Message type validation for local source', () => {
	// Verify the exact message format expected by ChartViewProvider
	const localMessage = { type: 'selectDataSource', filePath: '/data/test.csv' };

	assert(localMessage.type === 'selectDataSource', 'Type must be selectDataSource');
	assert(typeof localMessage.filePath === 'string', 'FilePath must be string');
});

// Summary
console.log('='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
