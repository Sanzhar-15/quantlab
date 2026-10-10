/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST check (QuantLab, review c1 M4 + S1). M4: the adopted workbench's stand-in sends visible operations, state queries,
// visible-state listeners and `focus` to the host window, never to the hidden shell (qlHost/standIn.ts, transpiled with the
// fork's typescript and run against fake windows). S1: adoption binds each CodeWindow listener once (the bodies of
// CodeWindow#registerListeners, #registerContentsListeners and #qlAdoptBrowserWindow are taken from windowImpl.ts, transpiled
// and run against a fake window: one construction-time registration, then one adoption).
// Run from the fork root: `node build/qlhost/check-stand-in.mjs src/vs`; rc 0 = GREEN.
// Review c2 M4 (rows 9-13): every function member is classified, so nothing reaches the hidden shell by default. Row 9: each
// visible operation, called through the stand-in, reaches the host window and the shell records nothing. Row 10: the stock
// chrome writes reach neither window. Row 11: every member the stock main-process sources call on (or assign to) a window's
// `win` is in a class. Row 12: an unclassified member throws when called. Row 13: always-on-top-changed is a host event.
// Negatives: (a) a standIn.ts with QL_VISIBLE_OPERATIONS emptied and `focus` a no-op -> rows 1-3 RED; (b) 831a7a9fca5's
// windowImpl.ts (adoption re-runs registerListeners) -> row 8 RED; (c) 831a7a9fca5's adopt.ts -> row 7 RED; (d) fb7d03e838c's
// standIn.ts (setBounds, setSize, setAlwaysOnTop, isAlwaysOnTop fall through to the shell) -> rows 9-13 RED.
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const vs = process.argv[2];
if (!vs) {
	console.error('usage: check-stand-in.mjs <path to src/vs>');
	process.exit(64);
}
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const rows = [];
const problems = [];
const row = (name, ok, observed) => {
	rows.push(`${ok ? 'GREEN' : 'RED'} ${name}: ${observed}`);
	if (!ok) {
		problems.push(`${name}: ${observed}`);
	}
};
const read = rel => readFileSync(join(vs, rel), 'utf8');
const transpile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

// ---- M4: the stand-in against fakes
const standInMod = {};
new Function('exports', 'require', transpile(read('code/electron-main/qlHost/standIn.ts')))(standInMod, id => {
	throw new Error(`standIn.ts requires ${id} at run time (type imports only)`);
});

class FakeWindow extends EventEmitter {
	constructor(name, calls) {
		super();
		this.name = name;
		this.calls = calls;
		for (const op of ['maximize', 'unmaximize', 'minimize', 'restore', 'setFullScreen', 'setSimpleFullScreen', 'setMinimumSize', 'focus', 'show', 'showInactive', 'moveTop', 'close', 'destroy', 'setBackgroundColor']) {
			this[op] = (...args) => { calls.push(`${name}:${op}`); return undefined; };
		}
	}
	isMaximized() { return this.name === 'host'; }
	isMinimized() { return false; }
	isNormal() { return this.name !== 'host'; }
	isFullScreen() { return this.name === 'host'; }
	isSimpleFullScreen() { return false; }
	isFocused() { return this.name === 'host'; }
	isDestroyed() { this.calls.push(`${this.name}:isDestroyed`); return false; }
	getBounds() { return { name: this.name }; }
	getSize() { return [this.name.length, 1]; }
	getPosition() { return [0, 0]; }
	getContentBounds() { return { name: this.name }; }
	getContentSize() { return [this.name.length, 1]; }
	getNormalBounds() { return { name: this.name }; }
	getMinimumSize() { return [this.name.length, 1]; }
}

const calls = [];
const shell = new FakeWindow('shell', calls);
const host = new FakeWindow('host', calls);
const viewContents = { loadURL: url => { calls.push(`view:loadURL ${url}`); } };
let surfaced = 0;
let viewBackground;
const standIn = standInMod.createQlStandIn(shell, viewContents, color => { viewBackground = color; }, { window: host, focusWorkbench: () => { surfaced++; host.focus(); } });

const take = () => calls.splice(0);
standIn.maximize(); standIn.unmaximize(); standIn.minimize(); standIn.restore(); standIn.setFullScreen(true); standIn.setMinimumSize(800, 600);
let got = take();
row('row 1 visible operations (maximize, unmaximize, minimize, restore, setFullScreen, setMinimumSize) reach the host window, none the hidden shell',
	got.filter(c => c.startsWith('host:')).length === 6 && got.filter(c => c.startsWith('shell:')).length === 0, got.join(' ') || 'no calls');

const answers = { isMaximized: standIn.isMaximized(), isFullScreen: standIn.isFullScreen(), isNormal: standIn.isNormal(), bounds: standIn.getBounds()?.name, size: standIn.getSize()?.[0] };
row('row 2 state queries describe the host window',
	answers.isMaximized === true && answers.isFullScreen === true && answers.isNormal === false && answers.bounds === 'host' && answers.size === 4, JSON.stringify(answers));

standIn.focus(); standIn.show(); standIn.showInactive(); standIn.moveTop();
got = take();
row('row 3 focus surfaces the workbench on the host window; show/showInactive/moveTop do nothing; isVisible true',
	surfaced === 1 && got.join(' ') === 'host:focus' && standIn.isVisible() === true, `surfaced=${surfaced} calls=${got.join(' ') || 'none'} isVisible=${standIn.isVisible()}`);

standIn.loadURL('vscode-file://x'); standIn.close(); standIn.destroy(); standIn.isDestroyed(); standIn.setBackgroundColor('#123');
got = take();
row('row 4 webContents and loadURL are the view\'s; close, destroy and isDestroyed stay on the shell (lifecycle carrier); the background colour goes to both',
	standIn.webContents === viewContents && got.join(' ') === 'view:loadURL vscode-file://x shell:close shell:destroy shell:isDestroyed shell:setBackgroundColor' && viewBackground === '#123', got.join(' '));

const onMax = () => { };
const onClosed = () => { };
const returned = standIn.on('maximize', onMax);
standIn.on('closed', onClosed);
const placed = `host maximize=${host.listenerCount('maximize')} shell maximize=${shell.listenerCount('maximize')} shell closed=${shell.listenerCount('closed')} host closed=${host.listenerCount('closed')}`;
standIn.removeListener('maximize', onMax);
standIn.removeListener('closed', onClosed);
const removed = `after removal host maximize=${host.listenerCount('maximize')} shell closed=${shell.listenerCount('closed')}`;
row('row 5 a visible-state listener added through the stand-in is the host window\'s, a lifecycle one the shell\'s; removal follows; on() returns the stand-in',
	placed === 'host maximize=1 shell maximize=0 shell closed=1 host closed=0' && removed === 'after removal host maximize=0 shell closed=0' && returned === standIn, `${placed}; ${removed}; returns stand-in=${returned === standIn}`);

const seen = [];
for (const event of ['maximize', 'enter-full-screen', 'focus']) {
	shell.on(event, () => seen.push(event));
}
const stop = standInMod.forwardQlVisibleEvents(host, shell);
host.emit('maximize'); host.emit('enter-full-screen'); host.emit('focus');
const forwarded = seen.splice(0).join(',');
stop();
host.emit('maximize');
const afterStop = seen.splice(0).join(',');
row('row 6 the host window\'s visible-state events reach the shell (the CodeWindow\'s construction-time listeners) once each, and stop on removal',
	forwarded === 'maximize,enter-full-screen,focus' && afterStop === '', `forwarded=${forwarded} afterStop=${afterStop || 'none'}`);

// ---- M4 wiring
const adopt = read('code/electron-main/qlHost/adopt.ts');
const gate = read('code/electron-main/qlHost/gate.ts');
const workbenchHost = read('code/electron-main/qlHost/workbenchHost.ts');
const wiring = {
	noLocalStandIn: !/function createStandIn\(/.test(adopt),
	standIn: /createQlStandIn\(shell, view\.webContents, color => view\.setBackgroundColor\(color\), visible\)/.test(adopt),
	forwarded: /forwardQlVisibleEvents\(visible\.window, shell\)/.test(adopt),
	gate: /adoptCodeWindow\(codeWindow, captured\[0\], listener\.visibleTarget\(\)\)/.test(gate),
	host: /visibleTarget\(\): IQlVisibleTarget \{[\s\S]{0,200}window: terminalHost\.window,[\s\S]{0,120}this\.surface\('focus'\)/.test(workbenchHost)
};
row('row 7 wiring: adopt.ts builds the stand-in from standIn.ts with the host target and forwards its events; the gate passes the listener\'s target; the host\'s target is its window and focus surfaces the workbench',
	Object.values(wiring).every(Boolean), JSON.stringify(wiring));

// ---- S1: CodeWindow listener registration, construction then adoption
const windowImplPath = join(vs, 'platform/windows/electron-main/windowImpl.ts');
const source = ts.createSourceFile(windowImplPath, readFileSync(windowImplPath, 'utf8'), ts.ScriptTarget.ES2022, true);
let codeWindowClass;
source.forEachChild(node => {
	if (ts.isClassDeclaration(node) && node.name?.text === 'CodeWindow') {
		codeWindowClass = node;
	}
});
const method = name => {
	const member = codeWindowClass?.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === name);
	if (!member) {
		return undefined;
	}
	const params = member.parameters.map(p => p.name.getText(source)).join(', ');
	const js = transpile(`function m(${params}) ${member.body.getText(source)}`);
	return new Function('Event', 'WindowError', 'CancellationToken', 'URI', 'DisposableStore', `${js}; return m;`)(FakeEvent, { UNRESPONSIVE: 'unresponsive', RESPONSIVE: 'responsive', PROCESS_GONE: 'gone', LOAD: 'load' }, { None: {} }, { parse: () => ({}) }, FakeStore);
};
const FakeEvent = {
	fromNodeEventEmitter: (emitter, name, map = (...a) => a[0]) => listener => {
		const handler = (...args) => listener(map(...args));
		emitter.on(name, handler);
		return { dispose: () => emitter.removeListener(name, handler) };
	}
};
class FakeStore {
	constructor() { this.items = []; }
	add(d) { this.items.push(d); return d; }
	dispose() { this.items.splice(0).forEach(d => d.dispose()); }
}
const subscriptions = { maximize: 0, unmaximize: 0, enterFull: 0, leaveFull: 0, configuration: 0, workspace: 0 };
const fakeEvent = key => () => { subscriptions[key]++; return { dispose() { } }; };
const shellWin = new EventEmitter();
shellWin.webContents = Object.assign(new EventEmitter(), { session: { webRequest: { onBeforeSendHeaders() { } } } });
const viewWin = Object.create(shellWin); // what the stand-in is to this code: the shell's events, the view's webContents
viewWin.webContents = Object.assign(new EventEmitter(), { session: { webRequest: { onBeforeSendHeaders() { } } } });
const errors = [];
let contentsValue;
const self = {
	_win: shellWin,
	_register: d => d,
	contentsListeners: { set value(v) { contentsValue?.dispose(); contentsValue = v; }, get value() { return contentsValue; } },
	onWindowError: e => errors.push(e),
	onDidMaximize: fakeEvent('maximize'), onDidUnmaximize: fakeEvent('unmaximize'),
	onDidEnterFullScreen: fakeEvent('enterFull'), onDidLeaveFullScreen: fakeEvent('leaveFull'),
	configurationService: { onDidChangeConfiguration: fakeEvent('configuration') },
	workspacesManagementMainService: { onDidDeleteUntitledWorkspace: fakeEvent('workspace') },
	productService: {},
	getMarketplaceHeaders: async () => ({}),
	sendWhenReady() { }
};
let s1;
try {
	for (const name of ['registerListeners', 'registerContentsListeners', 'qlAdoptBrowserWindow']) {
		const fn = method(name);
		if (fn) {
			self[name] = fn;
		}
	}
	if (typeof self.registerListeners !== 'function' || typeof self.qlAdoptBrowserWindow !== 'function') {
		throw new Error('CodeWindow#registerListeners or #qlAdoptBrowserWindow not found in windowImpl.ts');
	}
	self.registerListeners();
	self.qlAdoptBrowserWindow(viewWin);
	shellWin.emit('unresponsive');
	s1 = {
		unresponsiveListeners: shellWin.listenerCount('unresponsive'),
		onWindowErrorPerUnresponsive: errors.filter(e => e === 'unresponsive').length,
		...subscriptions,
		viewContents: ['render-process-gone', 'did-fail-load', 'will-prevent-unload', 'did-finish-load'].map(e => viewWin.webContents.listenerCount(e)).join(''),
		shellContents: ['render-process-gone', 'did-fail-load', 'will-prevent-unload', 'did-finish-load'].map(e => shellWin.webContents.listenerCount(e)).join('')
	};
} catch (error) {
	s1 = { error: String(error && error.message || error) };
}
const once = s1.unresponsiveListeners === 1 && s1.onWindowErrorPerUnresponsive === 1 && ['maximize', 'unmaximize', 'enterFull', 'leaveFull', 'configuration', 'workspace'].every(k => s1[k] === 1);
row('row 8 S1: after construction and adoption each window listener is bound once (one unresponsive -> one onWindowError), and the webContents listeners moved from the shell\'s to the view\'s',
	once && s1.viewContents === '1111' && s1.shellContents === '0000', JSON.stringify(s1));

// ---- c2 M4: complete classification
const setOf = name => {
	const value = standInMod[name];
	return value instanceof Set ? value : undefined;
};
// a window that has every member under test and records every call made on it
const recording = (name, log, members, properties) => {
	const win = new EventEmitter();
	for (const op of members.filter(op => !(op in EventEmitter.prototype))) {
		win[op] = () => { log.push(`${name}:${op}`); return `${name}:${op}`; };
	}
	for (const property of properties) {
		win[property] = `${name}:initial`;
	}
	return win;
};
const named = ['setBounds', 'setSize', 'setAlwaysOnTop', 'isAlwaysOnTop', 'setPosition', 'flashFrame'];
const listedOps = setOf('QL_VISIBLE_OPERATIONS');
const visibleOps = [...new Set([...(listedOps ? listedOps : []), ...named])];
{
	const log = [];
	const shell9 = recording('shell', log, visibleOps, []);
	const host9 = recording('host', log, visibleOps, []);
	const standIn9 = standInMod.createQlStandIn(shell9, viewContents, () => { }, { window: host9, focusWorkbench: () => { } });
	const answered = visibleOps.map(op => {
		try {
			return standIn9[op]();
		} catch (error) {
			return `threw ${error.message}`;
		}
	});
	const onHost = visibleOps.filter((op, i) => answered[i] === `host:${op}` && log.includes(`host:${op}`));
	const onShell = log.filter(c => c.startsWith('shell:'));
	row('row 9 zero hidden-shell visible operations: every visible operation (setBounds, setSize, setAlwaysOnTop, isAlwaysOnTop, setPosition, flashFrame among them) reaches the host window and is answered by it',
		listedOps !== undefined && onHost.length === visibleOps.length && onShell.length === 0 && named.every(op => listedOps.has(op)),
		`${onHost.length}/${visibleOps.length} on the host; on the shell: ${onShell.join(' ') || 'none'}; not listed: ${named.filter(op => !listedOps?.has(op)).join(' ') || 'none'}`);
}

const classes = Object.fromEntries(['QL_VISIBLE_OPERATIONS', 'QL_HOST_CHROME_WRITES', 'QL_HOST_CHROME_PROPERTIES', 'QL_SHELL_MEMBERS', 'QL_STAND_IN_MEMBERS', 'QL_LISTENER_METHODS'].map(name => [name, setOf(name)]));
const missingClasses = Object.entries(classes).filter(([, value]) => !value).map(([name]) => name);
if (missingClasses.length > 0) {
	for (const name of ['row 10', 'row 11', 'row 12', 'row 13']) {
		row(`${name} c2 M4`, false, `standIn.ts does not export the set(s) ${missingClasses.join(', ')}`);
	}
} else {
	const chromeWrites = [...classes.QL_HOST_CHROME_WRITES];
	const chromeProperties = [...classes.QL_HOST_CHROME_PROPERTIES];
	const unclassified = ['setOpacity', 'hide', 'blur', 'setIgnoreMouseEvents'];
	const log = [];
	const members = [...visibleOps, ...chromeWrites, ...unclassified, ...classes.QL_SHELL_MEMBERS];
	const shell2 = recording('shell', log, members, chromeProperties);
	const host2 = recording('host', log, members, chromeProperties);
	const standIn2 = standInMod.createQlStandIn(shell2, viewContents, () => { }, { window: host2, focusWorkbench: () => { } });

	log.splice(0);
	chromeWrites.forEach(op => standIn2[op]('x'));
	let assigned = 'assigned';
	try {
		chromeProperties.forEach(property => { standIn2[property] = true; });
	} catch (error) {
		assigned = `threw ${error.message}`;
	}
	const untouched = chromeProperties.every(property => shell2[property] === 'shell:initial' && host2[property] === 'host:initial');
	row('row 10 the stock chrome writes (title, represented file, edited mark, title-bar overlay and buttons, menu bar, touch bar, accent colour, tabs) and the autoHideMenuBar assignment reach neither window',
		log.length === 0 && assigned === 'assigned' && untouched && ['setTitle', 'setMenuBarVisibility', 'setWindowButtonPosition', 'setTouchBar'].every(op => chromeWrites.includes(op)),
		`${chromeWrites.length} writes; calls: ${log.join(' ') || 'none'}; assignment: ${assigned}; properties untouched=${untouched}`);

	// row 11: the stock sources. A member called on a window's `win` (`._win.x(`, `.win.x(`, `.win?.x(`, a local `win.x(`), or
	// assigned on it, in any main-process source outside qlHost and tests.
	const sources = [];
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test' && entry.name !== 'qlHost' && entry.name !== 'node_modules') {
					walk(path);
				}
			} else if (entry.name.endsWith('.ts') && path.includes('/electron-main/')) {
				sources.push(path);
			}
		}
	};
	walk(vs);
	const isClassified = member => classes.QL_VISIBLE_OPERATIONS.has(member) || classes.QL_HOST_CHROME_WRITES.has(member) || classes.QL_SHELL_MEMBERS.has(member) || classes.QL_STAND_IN_MEMBERS.has(member) || classes.QL_LISTENER_METHODS.has(member);
	const called = new Map();
	const assignedTo = new Map();
	for (const path of sources) {
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(/(?:\b_win|\.win|(?<![.\w])win)\??\.([A-Za-z]+)\(/g)) {
			called.set(match[1], path.slice(vs.length + 1));
		}
		for (const match of text.matchAll(/(?:\b_win|\.win|(?<![.\w])win)\??\.([A-Za-z]+) = /g)) {
			assignedTo.set(match[1], path.slice(vs.length + 1));
		}
	}
	const unclassifiedCalls = [...called].filter(([member]) => !isClassified(member)).map(([member, path]) => `${member}() ${path}`);
	const unclassifiedAssignments = [...assignedTo].filter(([member]) => !classes.QL_HOST_CHROME_PROPERTIES.has(member)).map(([member, path]) => `${member}= ${path}`);
	const mustSee = ['setBounds', 'setSize', 'setAlwaysOnTop', 'isAlwaysOnTop', 'setMinimumSize', 'maximize', 'close', 'setTitle'];
	const blind = mustSee.filter(member => !called.has(member)).concat(assignedTo.has('autoHideMenuBar') ? [] : ['autoHideMenuBar=']);
	row('row 11 every member the stock main-process sources call on, or assign to, a window\'s win is classified (the scan sees the stock positioning, minimum-size and always-on-top callers)',
		unclassifiedCalls.length === 0 && unclassifiedAssignments.length === 0 && blind.length === 0,
		`${sources.length} sources, ${called.size} members called, ${assignedTo.size} assigned; unclassified: ${[...unclassifiedCalls, ...unclassifiedAssignments].join('; ') || 'none'}; not seen by the scan: ${blind.join(' ') || 'none'}`);

	log.splice(0);
	const thrown = unclassified.map(op => {
		const member = standIn2[op]; // reading is allowed
		try {
			member();
			return `${op}: no throw`;
		} catch (error) {
			return error.message.includes(`BrowserWindow.${op}()`) ? 'named' : `${op}: ${error.message}`;
		}
	});
	let strayAssignment;
	try {
		standIn2.title = 'x';
		strayAssignment = 'no throw';
	} catch (error) {
		strayAssignment = error.message.includes('BrowserWindow.title') ? 'named' : error.message;
	}
	row('row 12 an unclassified function member throws when called, naming the member, and an unclassified assignment throws; neither reaches a window',
		thrown.every(t => t === 'named') && strayAssignment === 'named' && log.length === 0 && shell2.title === undefined,
		`calls: ${thrown.join(', ')}; assignment: ${strayAssignment}; window calls: ${log.join(' ') || 'none'}`);

	const onTop = () => { };
	standIn2.on('always-on-top-changed', onTop);
	const onTopPlaced = `host=${host2.listenerCount('always-on-top-changed')} shell=${shell2.listenerCount('always-on-top-changed')}`;
	standIn2.removeListener('always-on-top-changed', onTop);
	const onTopSeen = [];
	shell2.on('always-on-top-changed', (_event, value) => onTopSeen.push(value));
	const stopOnTop = standInMod.forwardQlVisibleEvents(host2, shell2);
	host2.emit('always-on-top-changed', {}, true);
	stopOnTop();
	row('row 13 always-on-top-changed is a host-window event: a listener added through the stand-in is the host\'s, and the event is re-emitted on the shell for the CodeWindow\'s construction-time listener',
		onTopPlaced === 'host=1 shell=0' && onTopSeen.join(',') === 'true', `${onTopPlaced}; forwarded=${onTopSeen.join(',') || 'none'}`);
}

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-stand-in: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-stand-in: GREEN: visible operations, queries, listeners and focus reach the host window, no member reaches the hidden shell unclassified; each CodeWindow listener is bound once');
