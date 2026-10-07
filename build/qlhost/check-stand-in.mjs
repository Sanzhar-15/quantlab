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
// Negatives: (a) a standIn.ts with QL_VISIBLE_OPERATIONS emptied and `focus` a no-op -> rows 1-3 RED; (b) 831a7a9fca5's
// windowImpl.ts (adoption re-runs registerListeners) -> row 8 RED; (c) 831a7a9fca5's adopt.ts -> row 7 RED.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
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

for (const line of rows) {
	console.log(line);
}
if (problems.length > 0) {
	console.error(`check-stand-in: RED (${problems.length}):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('check-stand-in: GREEN: visible operations, queries, listeners and focus reach the host window; each CodeWindow listener is bound once');
