/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST fixture (QuantLab, P12): the real gate.ts, workbenchHost.ts and toggleSequencer.ts, transpiled with the fork's typescript and
// wired to fakes: a stock WindowsMainService that opens the windows a test asks for, a terminal host with one fake window, a dialog
// service and a log that record what they were asked. Used by check-p12-bare-launch.mjs and check-p12-extra-windows.mjs.
// Their imports are stubbed by specifier; one this fixture does not know is an error, never a silent default.
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const NO_EVENT = () => ({ dispose() { } });

/** The members of `const enum OpenContext` in windows.ts, in source order (a const enum is inlined by tsc, not exported). */
function openContextFrom(vs) {
	const source = readFileSync(join(vs, 'platform/windows/electron-main/windows.ts'), 'utf8');
	const block = /export const enum OpenContext \{([\s\S]*?)\n\}/.exec(source);
	if (!block) {
		throw new Error('p12-host-fixture: windows.ts has no `export const enum OpenContext`');
	}
	const names = block[1].replace(/\/\/.*$/gm, '').split(',').map(name => name.trim()).filter(Boolean);
	return Object.fromEntries(names.map((name, index) => [name, index]));
}

export function loadHostModules(dir) {
	const vs = join(dir, '../../..');
	const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
	const OpenContext = openContextFrom(vs);

	/** The rig the stubs report to; `makeRig` makes a fresh one and points `current` at it. */
	const state = { current: undefined };

	const transpile = (file, stubs) => {
		const { outputText } = ts.transpileModule(readFileSync(join(dir, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, useDefineForClassFields: false } });
		const exported = {};
		new Function('exports', 'require', outputText)(exported, specifier => {
			if (specifier === 'events') {
				return { EventEmitter };
			}
			if (!Object.hasOwn(stubs, specifier)) {
				throw new Error(`p12-host-fixture: ${file} imports ${specifier}, which this fixture does not stub`);
			}
			return stubs[specifier];
		});
		return exported;
	};

	class Disposable {
		constructor() { this.registered = []; }
		_register(item) { this.registered.push(item); return item; }
		dispose() { for (const item of this.registered.splice(0)) { item.dispose(); } }
	}
	class DisposableStore {
		constructor() { this.items = []; }
		add(item) { this.items.push(item); return item; }
		dispose() { for (const item of this.items.splice(0)) { item.dispose(); } }
	}
	class MutableDisposable {
		set value(item) { this.item?.dispose(); this.item = item; }
		dispose() { this.item?.dispose(); }
	}
	class DeferredPromise {
		constructor() { this.p = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
		complete(value) { this.resolve(value); }
		error(reason) { this.reject(reason); }
	}
	const Event = {
		None: NO_EVENT,
		fromNodeEventEmitter: (emitter, name, map = value => value) => listener => {
			const handler = (...args) => listener(map(...args));
			emitter.on(name, handler);
			return { dispose: () => emitter.off(name, handler) };
		}
	};
	const decorator = () => () => undefined;

	const toggleSequencer = transpile('toggleSequencer.ts', {});

	const gateModule = transpile('gate.ts', {
		'../../../base/common/async.js': { DeferredPromise },
		'../../../base/common/event.js': { Event },
		'../../../base/common/lifecycle.js': { Disposable },
		'../../../platform/instantiation/common/instantiation.js': { IInstantiationService: decorator },
		'../../../platform/log/common/log.js': { ILogService: decorator },
		'../../../platform/window/electron-main/window.js': { WindowMode: { Normal: 0 } },
		'../../../platform/windows/electron-main/windows.js': {
			OpenContext,
			getFocusedWindowIncludingAdopted: () => undefined,
			setQlHostWindowSeam: seam => { state.current.seam = seam; }
		},
		'../../../platform/windows/electron-main/windowsMainService.js': { WindowsMainService: class WindowsMainService { } },
		'./adopt.js': { adoptCodeWindow: (codeWindow, webPreferences) => state.current.adopt(codeWindow, webPreferences) }
	});

	const hostModule = transpile('workbenchHost.ts', {
		'../../../base/common/async.js': { DeferredPromise, timeout: ms => new Promise(resolve => setTimeout(resolve, ms)) },
		'../../../base/common/errorMessage.js': { toErrorMessage: error => (error instanceof Error ? error.message : String(error)) },
		'../../../base/common/event.js': { Event },
		'../../../base/common/lifecycle.js': { Disposable, DisposableStore, MutableDisposable },
		'../../../base/common/platform.js': { isMacintosh: true },
		'./gate.js': gateModule,
		'./security.js': { secureWorkbenchContents: () => ({ dispose() { } }) },
		'./toggleSequencer.js': toggleSequencer
	});

	/**
	 * One host + gate. `windowsPerOpen(config)` says how many CodeWindows the stock open creates for a request (each is adopted
	 * when the gate can, refused when it already holds one); `openFails` makes the stock open throw instead.
	 */
	function makeRig({ windowsPerOpen = () => 1, openFails } = {}) {
		const rig = {
			logs: [], dialogs: [], hostLog: [], shown: [], hostWindow: { shows: 0, restores: 0, minimized: false }, closedWindows: [],
			openCalls: [], lifecycle: { quitRequested: false, registerWindow() { } }
		};
		state.current = rig;

		const openListeners = [];
		let windowIds = 0;
		const inner = {
			onDidChangeWindowsCount: NO_EVENT, onDidSignalReadyWindow: NO_EVENT, onDidMaximizeWindow: NO_EVENT, onDidUnmaximizeWindow: NO_EVENT,
			onDidChangeFullScreen: NO_EVENT, onDidTriggerSystemContextMenu: NO_EVENT, onDidDestroyWindow: NO_EVENT,
			onDidOpenWindow: listener => { openListeners.push(listener); return { dispose() { } }; },
			async open(config) {
				rig.openCalls.push(config);
				if (openFails) {
					throw openFails;
				}
				const windows = [];
				for (let i = 0; i < windowsPerOpen(config); i += 1) {
					windowIds += 1;
					const window = { id: windowIds, close: () => rig.closedWindows.push(window.id) };
					rig.seam.onCodeWindowOptions({ webPreferences: { sandbox: true } }, { mode: 1 });
					for (const listener of openListeners) {
						listener(window);
					}
					windows.push(window);
				}
				return windows;
			}
		};
		rig.adopt = (codeWindow, webPreferences) => ({
			codeWindow, webPreferences, shell: new EventEmitter(), standIn: new EventEmitter(), webContents: new EventEmitter(),
			view: { setVisible() { } }, onDidGone: NO_EVENT, whenReady: async () => { }, closeContents() { }, dispose() { }
		});

		const hostWindow = Object.assign(new EventEmitter(), {
			isDestroyed: () => false,
			isMinimized: () => rig.hostWindow.minimized,
			restore: () => { rig.hostWindow.restores += 1; rig.hostWindow.minimized = false; },
			show: () => { rig.hostWindow.shows += 1; },
			focus() { }
		});
		const terminalHost = {
			window: hostWindow,
			host: { log: line => rig.hostLog.push(line) },
			view: name => (name === 'terminal' ? { webContents: new EventEmitter() } : undefined),
			show: name => rig.shown.push(name),
			addView() { }, removeView() { }, setWorkbench() { }, overlayOpen: () => false
		};
		const logService = {
			info: message => rig.logs.push({ level: 'info', message: String(message) }),
			warn: message => rig.logs.push({ level: 'warn', message: String(message) }),
			trace() { },
			error: (message, ...args) => rig.logs.push({ level: 'error', message: message instanceof Error ? message.message : String(message), args })
		};
		const dialogs = {
			setParentResolver() { },
			showMessageBox: options => { rig.dialogs.push(options); return Promise.resolve(); },
			showMessageBoxOnHost: options => { rig.dialogs.push(options); return Promise.resolve(); }
		};

		rig.gate = new gateModule.QlWindowsGate('machine', 'sqm', 'dev', {}, { createInstance: () => inner }, logService);
		rig.host = new hostModule.QlWorkbenchHost({
			gate: rig.gate,
			dialogs,
			lifecycleMainService: rig.lifecycle,
			logService,
			framePolicy: {},
			// the first launch's own request, as app.ts `openFirstWindow` makes it (initialStartup)
			openWorkbench: () => rig.gate.open({ context: OpenContext.DESKTOP, cli: { _: [] }, initialStartup: true }),
			openExternal() { }
		});
		rig.host.attach(terminalHost);

		return rig;
	}

	return { OpenContext, gateModule, hostModule, makeRig };
}

export const flush = async () => { for (let i = 0; i < 20; i += 1) { await new Promise(resolve => setImmediate(resolve)); } };
