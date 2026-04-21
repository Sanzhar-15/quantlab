/**
 * Test for chart dropdown functionality with server and local data sources.
 * Run with: node test/webview-dropdown.test.js
 */

// Mock DOM elements
class MockElement {
	constructor(tag) {
		this.tagName = tag;
		this.className = '';
		this.textContent = '';
		this.title = '';
		this.children = [];
		this.eventListeners = {};
		this.classList = {
			add: (cls) => { this.className += ` ${cls}`; },
			remove: (cls) => { this.className = this.className.replace(cls, '').trim(); },
			toggle: (cls, force) => {
				if (force === undefined) force = !this.className.includes(cls);
				if (force) this.classList.add(cls);
				else this.classList.remove(cls);
				return force;
			},
			contains: (cls) => this.className.includes(cls)
		};
	}
	appendChild(child) { this.children.push(child); return child; }
	addEventListener(event, handler) { this.eventListeners[event] = handler; }
	querySelector(selector) { return null; }
	get innerHTML() { return ''; }
	set innerHTML(val) { this.children = []; }
}

function createElement(tag) {
	return new MockElement(tag);
}

// Type guards (copied from messageHandler.ts)
function isLocalFileSource(source) {
	return source.kind === 'localFile';
}

function isServerSource(source) {
	return source.kind === 'server';
}

// Simulated populateDropdown function (logic from messageHandler.ts)
function populateDropdown(dropdown, sources, postMessage) {
	dropdown.innerHTML = '';
	dropdown.children = [];

	const serverSources = sources.filter(isServerSource);
	const localSources = sources.filter(isLocalFileSource);

	// Add server sources first (if any)
	if (serverSources.length > 0) {
		const serverHeader = createElement('div');
		serverHeader.className = 'data-source-header';
		serverHeader.textContent = 'Server Symbols';
		dropdown.appendChild(serverHeader);

		for (const source of serverSources) {
			const option = createElement('div');
			option.className = 'data-source-option server';

			const nameEl = createElement('div');
			nameEl.textContent = source.displayName;
			option.appendChild(nameEl);

			const symbolEl = createElement('div');
			symbolEl.className = 'symbol-label';
			symbolEl.textContent = source.symbol;
			option.appendChild(symbolEl);

			option.addEventListener('click', () => {
				postMessage({ type: 'selectServerSymbol', symbol: source.symbol, displayName: source.displayName });
			});

			dropdown.appendChild(option);
		}
	}

	// Add local file sources
	if (localSources.length > 0) {
		const localHeader = createElement('div');
		localHeader.className = 'data-source-header';
		localHeader.textContent = 'Local Files';
		dropdown.appendChild(localHeader);

		for (const source of localSources) {
			const option = createElement('div');
			option.className = 'data-source-option local';

			const nameEl = createElement('div');
			nameEl.textContent = source.displayName;
			option.appendChild(nameEl);

			const pathEl = createElement('div');
			pathEl.className = 'file-path';
			pathEl.textContent = source.filePath;
			option.appendChild(pathEl);

			option.addEventListener('click', () => {
				postMessage({ type: 'selectDataSource', filePath: source.filePath });
			});

			dropdown.appendChild(option);
		}
	}

	// Add browse button
	const browse = createElement('div');
	browse.className = 'data-source-option browse';
	browse.textContent = 'Browse Local Files...';
	dropdown.appendChild(browse);

	return dropdown;
}

// Test data
const testSources = [
	{ kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.' },
	{ kind: 'server', symbol: 'GOOGL', displayName: 'Alphabet Inc.' },
	{ kind: 'server', symbol: 'BTC', displayName: 'Bitcoin' },
	{ kind: 'localFile', filePath: '/data/btc_daily.csv', displayName: 'btc_daily.csv' },
	{ kind: 'localFile', filePath: '/data/eth_1h.parquet', displayName: 'eth_1h.parquet' },
];

// Run tests
console.log('='.repeat(60));
console.log('Chart Dropdown Test Suite');
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

// Test 1: Type guards work correctly
test('isServerSource identifies server sources', () => {
	assert(isServerSource({ kind: 'server', symbol: 'AAPL', displayName: 'Apple' }), 'Should identify server source');
	assert(!isServerSource({ kind: 'localFile', filePath: '/x.csv', displayName: 'x.csv' }), 'Should reject local file');
});

test('isLocalFileSource identifies local file sources', () => {
	assert(isLocalFileSource({ kind: 'localFile', filePath: '/x.csv', displayName: 'x.csv' }), 'Should identify local file');
	assert(!isLocalFileSource({ kind: 'server', symbol: 'AAPL', displayName: 'Apple' }), 'Should reject server source');
});

// Test 2: Dropdown populates with correct structure
test('populateDropdown creates server header when server sources exist', () => {
	const dropdown = new MockElement('div');
	const messages = [];
	populateDropdown(dropdown, testSources, (msg) => messages.push(msg));

	const serverHeader = dropdown.children.find(c => c.textContent === 'Server Symbols');
	assert(serverHeader, 'Should have Server Symbols header');
	assert(serverHeader.className.includes('data-source-header'), 'Header should have correct class');
});

test('populateDropdown creates local files header when local sources exist', () => {
	const dropdown = new MockElement('div');
	populateDropdown(dropdown, testSources, () => {});

	const localHeader = dropdown.children.find(c => c.textContent === 'Local Files');
	assert(localHeader, 'Should have Local Files header');
});

test('populateDropdown creates correct number of options', () => {
	const dropdown = new MockElement('div');
	populateDropdown(dropdown, testSources, () => {});

	// 2 headers + 3 server + 2 local + 1 browse = 8
	assert(dropdown.children.length === 8, `Expected 8 children, got ${dropdown.children.length}`);
});

test('Server options have symbol label', () => {
	const dropdown = new MockElement('div');
	populateDropdown(dropdown, testSources, () => {});

	const serverOptions = dropdown.children.filter(c => c.className.includes('server'));
	assert(serverOptions.length === 3, 'Should have 3 server options');

	for (const opt of serverOptions) {
		const symbolLabel = opt.children.find(c => c.className.includes('symbol-label'));
		assert(symbolLabel, 'Server option should have symbol label');
	}
});

test('Local options have file path', () => {
	const dropdown = new MockElement('div');
	populateDropdown(dropdown, testSources, () => {});

	const localOptions = dropdown.children.filter(c => c.className.includes('local'));
	assert(localOptions.length === 2, 'Should have 2 local options');

	for (const opt of localOptions) {
		const pathEl = opt.children.find(c => c.className.includes('file-path'));
		assert(pathEl, 'Local option should have file path');
	}
});

// Test 3: Click handlers send correct messages
test('Clicking server option sends selectServerSymbol message', () => {
	const dropdown = new MockElement('div');
	const messages = [];
	populateDropdown(dropdown, testSources, (msg) => messages.push(msg));

	const serverOption = dropdown.children.find(c => c.className.includes('server'));
	assert(serverOption.eventListeners.click, 'Should have click handler');

	serverOption.eventListeners.click();

	assert(messages.length === 1, 'Should send one message');
	assert(messages[0].type === 'selectServerSymbol', `Expected selectServerSymbol, got ${messages[0].type}`);
	assert(messages[0].symbol === 'AAPL', 'Should include symbol');
	assert(messages[0].displayName === 'Apple Inc.', 'Should include displayName');
});

test('Clicking local option sends selectDataSource message', () => {
	const dropdown = new MockElement('div');
	const messages = [];
	populateDropdown(dropdown, testSources, (msg) => messages.push(msg));

	const localOption = dropdown.children.find(c => c.className.includes('local'));
	assert(localOption.eventListeners.click, 'Should have click handler');

	localOption.eventListeners.click();

	assert(messages.length === 1, 'Should send one message');
	assert(messages[0].type === 'selectDataSource', `Expected selectDataSource, got ${messages[0].type}`);
	assert(messages[0].filePath === '/data/btc_daily.csv', 'Should include filePath');
});

// Test 4: Edge cases
test('Handles empty sources array', () => {
	const dropdown = new MockElement('div');
	populateDropdown(dropdown, [], () => {});

	// Should only have browse button
	assert(dropdown.children.length === 1, 'Should only have browse button');
	assert(dropdown.children[0].className.includes('browse'), 'Should be browse button');
});

test('Handles server-only sources', () => {
	const dropdown = new MockElement('div');
	const serverOnly = testSources.filter(isServerSource);
	populateDropdown(dropdown, serverOnly, () => {});

	const localHeader = dropdown.children.find(c => c.textContent === 'Local Files');
	assert(!localHeader, 'Should not have Local Files header');

	const serverHeader = dropdown.children.find(c => c.textContent === 'Server Symbols');
	assert(serverHeader, 'Should have Server Symbols header');
});

test('Handles local-only sources', () => {
	const dropdown = new MockElement('div');
	const localOnly = testSources.filter(isLocalFileSource);
	populateDropdown(dropdown, localOnly, () => {});

	const serverHeader = dropdown.children.find(c => c.textContent === 'Server Symbols');
	assert(!serverHeader, 'Should not have Server Symbols header');

	const localHeader = dropdown.children.find(c => c.textContent === 'Local Files');
	assert(localHeader, 'Should have Local Files header');
});

// Test 5: updateToolbar tooltip logic
test('Tooltip shows server info for server source', () => {
	const serverSource = { kind: 'server', symbol: 'AAPL', displayName: 'Apple Inc.' };
	let tooltip = 'Select a data source';

	if (serverSource) {
		if (isServerSource(serverSource)) {
			tooltip = `Server: ${serverSource.symbol}`;
		} else if (isLocalFileSource(serverSource)) {
			tooltip = serverSource.filePath;
		}
	}

	assert(tooltip === 'Server: AAPL', `Expected 'Server: AAPL', got '${tooltip}'`);
});

test('Tooltip shows file path for local source', () => {
	const localSource = { kind: 'localFile', filePath: '/data/test.csv', displayName: 'test.csv' };
	let tooltip = 'Select a data source';

	if (localSource) {
		if (isServerSource(localSource)) {
			tooltip = `Server: ${localSource.symbol}`;
		} else if (isLocalFileSource(localSource)) {
			tooltip = localSource.filePath;
		}
	}

	assert(tooltip === '/data/test.csv', `Expected '/data/test.csv', got '${tooltip}'`);
});

// Summary
console.log('='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
