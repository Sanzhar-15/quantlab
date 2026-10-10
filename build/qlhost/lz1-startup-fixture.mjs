/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HOST fixture (QuantLab, F-PERF-LZ1-1 review c1 M1/M2): runs the REAL `CodeApplication.startup()` and `startQlTerminalHost()`
// (their text, cut from app.ts, with the module-level QuantLab helpers between `interface QlStartServices` and
// `export class CodeApplication`) against the REAL `LifecycleMainService` (lifecycleMainService.ts, whole) and its REAL
// `installWillQuitGuard` (willQuitGuard.ts) and the REAL `DeferredPromise` and `Barrier` (async.ts), all transpiled with the
// fork's typescript. Faked: Electron's `app` (by behaviour: `quit()` emits `before-quit`, closes every window, emits `will-quit`
// and exits unless a listener prevented it; closing the last window outside a quit emits `window-all-closed` and, with no
// listener, quits, as Electron does), the client's `startTerminalHost` (steps on timers, a hidden window, the fork's hook awaited
// with the client's bound only, an unwind before its rejection), and the services section's stages (each settles on a timer, or
// is held until the scenario releases it). Every event is time-stamped in one list.
// Used by check-lz1-services-failure.mjs (M1) and check-lz1-quit-before-ready.mjs (M2).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cut(source, file, signature, endMarker) {
	const at = source.indexOf(signature);
	if (at < 0) {
		throw new Error(`lz1-startup-fixture: ${file} holds no \`${signature.trim()}\``);
	}
	const lineStart = source.lastIndexOf('\n', at) + 1;
	const end = source.indexOf(endMarker, at);
	if (end < 0) {
		throw new Error(`lz1-startup-fixture: ${file}: no end of \`${signature.trim()}\``);
	}

	return source.slice(lineStart, end + endMarker.length);
}

/** Loads the sources once; `world(scenario)` builds one run. */
export function loadStartup(vs) {
	const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
	const transpile = (text, module) => ts.transpileModule(text, {
		compilerOptions: { module, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, preserveConstEnums: true, useDefineForClassFields: false }
	}).outputText;

	const appFile = join(vs, 'code/electron-main/app.ts');
	const app = readFileSync(appFile, 'utf8');
	const helpersAt = app.indexOf('interface QlStartServices {');
	const classAt = app.indexOf('export class CodeApplication extends Disposable {');
	if (helpersAt < 0 || classAt < helpersAt) {
		throw new Error('lz1-startup-fixture: app.ts: `interface QlStartServices` before `export class CodeApplication` not found');
	}
	const helpers = app.slice(helpersAt, classAt).replace(/^export /gm, '');
	const startup = cut(app, 'app.ts', '\tasync startup(): Promise<void> {', '\n\t}\n');
	const startHost = cut(app, 'app.ts', '\tprivate async startQlTerminalHost(', '\n\t}\n');

	const asyncFile = join(vs, 'base/common/async.ts');
	const asyncSource = readFileSync(asyncFile, 'utf8');
	const deferred = cut(asyncSource, 'async.ts', 'const enum DeferredOutcome {', '\n}\n') + cut(asyncSource, 'async.ts', 'export class DeferredPromise<T> {', '\n}\n');
	const barrier = cut(asyncSource, 'async.ts', 'export class Barrier {', '\n}\n');

	const sliceSource = `${deferred.replace(/^export /gm, '')}\n${helpers}\nclass CodeApplicationSlice {\n${startup}\n${startHost}\n}\n`;
	const sliceCode = transpile(sliceSource, ts.ModuleKind.None);
	const barrierCode = transpile(barrier.replace(/^export /gm, ''), ts.ModuleKind.None);
	const { Barrier } = new Function(`${barrierCode}\nreturn { Barrier };`)();

	const lifecycleDir = join(vs, 'platform/lifecycle/electron-main');
	const guardExports = {};
	new Function('exports', transpile(readFileSync(join(lifecycleDir, 'willQuitGuard.ts'), 'utf8'), ts.ModuleKind.CommonJS))(guardExports);
	const lifecycleCode = transpile(readFileSync(join(lifecycleDir, 'lifecycleMainService.ts'), 'utf8'), ts.ModuleKind.CommonJS);

	return {
		/** The composed TypeScript the slice is transpiled from (for a reader of a RED row). */
		sliceSource,
		world: scenario => makeWorld({ sliceCode, lifecycleCode, guardExports, Barrier }, scenario)
	};
}

class Emitter {
	constructor() {
		this.listeners = [];
		this.event = listener => {
			this.listeners.push(listener);

			return { dispose: () => { this.listeners = this.listeners.filter(entry => entry !== listener); } };
		};
	}
	fire(value) {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
	dispose() {
		this.listeners = [];
	}
}
const Event = {
	once: event => listener => {
		let fired = false;
		const subscription = event(value => {
			if (fired) {
				return;
			}
			fired = true;
			subscription.dispose();
			listener(value);
		});

		return subscription;
	}
};
class Disposable {
	_register(value) {
		return value;
	}
	dispose() { }
}
class DisposableStore {
	add(value) {
		return value;
	}
	dispose() { }
}

class QuitDuringStart extends Error { }

/**
 * One run. `scenario`:
 *   machineIds, initServices, protocolUrls: a stage `{ at: ms }` (resolves), `{ at, reject: 'message' }`, or `{ hold: true }`
 *     (pending until `release(name)`); createServices: `{ throws: 'message' }` or absent;
 *   client: { waitingWindowMs?: ms (an unmarked start: a waiting window open that long, then closed by the start),
 *             hookAt: ms (the hidden window is created and the fork's hook called), failAt?: ms (refused before the hook),
 *             boundMs: the client's before-show bound };
 *   quitAt?: ms (Electron `app.quit()`, as a TERM or Cmd+Q); releases?: [{ at, name }].
 */
function makeWorld(lib, scenario) {
	const t0 = performance.now();
	const now = () => Math.round(performance.now() - t0);
	const events = [];
	const ev = text => events.push({ at: now(), text });
	const text = args => args.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' ');

	// Electron's app, by behaviour
	const listeners = new Map();
	const windows = new Set();
	let quitting = false;
	const exits = [];
	const fakeApp = {
		addListener(name, listener) {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return fakeApp;
		},
		on(name, listener) {
			return fakeApp.addListener(name, listener);
		},
		once(name, listener) {
			const wrapper = (...args) => {
				fakeApp.removeListener(name, wrapper);
				listener(...args);
			};
			return fakeApp.addListener(name, wrapper);
		},
		removeListener(name, listener) {
			listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== listener));
			return fakeApp;
		},
		off(name, listener) {
			return fakeApp.removeListener(name, listener);
		},
		listenerCount: name => (listeners.get(name) ?? []).length,
		emit(name, ...args) {
			for (const listener of [...(listeners.get(name) ?? [])]) {
				listener(...args);
			}
		},
		quit() {
			if (exits.length) {
				ev('app.quit() after the exit: nothing');
				return;
			}
			ev('app.quit()');
			quitting = true;
			const beforeQuit = preventable();
			fakeApp.emit('before-quit', beforeQuit);
			if (beforeQuit.prevented) {
				quitting = false;
				ev('before-quit prevented');
				return;
			}
			for (const window of [...windows]) {
				window.close();
			}
			const willQuit = preventable();
			fakeApp.emit('will-quit', willQuit);
			quitting = false;
			if (willQuit.prevented) {
				ev('will-quit prevented');
				return;
			}
			exit(0, 'quit');
		},
		exit(code) {
			exit(code, 'app.exit');
		},
		getName: () => 'QuantLab',
		isReady: () => true
	};
	function preventable() {
		const event = { prevented: false, preventDefault() { event.prevented = true; } };
		return event;
	}
	function exit(code, how) {
		if (exits.length) {
			ev(`${how}(${code}) after the exit: nothing`);
			return;
		}
		exits.push({ code, how, at: now() });
		ev(`EXIT ${code} (${how})`);
		if (how === 'quit') {
			fakeApp.emit('quit', {}, code);
		}
	}
	function newWindow(name) {
		const window = {
			name,
			destroyed: false,
			shown: false,
			closedListeners: [],
			once(event, listener) {
				if (event !== 'closed') {
					throw new Error(`fake window: unexpected event ${event}`);
				}
				window.closedListeners.push(listener);
			},
			removeListener(event, listener) {
				window.closedListeners = window.closedListeners.filter(entry => entry !== listener);
			},
			isDestroyed: () => window.destroyed,
			show() {
				if (window.destroyed) {
					throw new Error(`fake window ${name}: show() on a destroyed window`);
				}
				window.shown = true;
			},
			close() {
				if (window.destroyed) {
					return;
				}
				window.destroyed = true;
				windows.delete(window);
				ev(`window ${name} closed`);
				for (const listener of window.closedListeners.splice(0)) {
					listener();
				}
				if (!quitting && windows.size === 0) {
					if (fakeApp.listenerCount('window-all-closed') === 0) {
						ev('window-all-closed with no listener: Electron quits (its default)');
						fakeApp.quit();
					} else {
						fakeApp.emit('window-all-closed');
					}
				}
			}
		};
		windows.add(window);
		ev(`window ${name} created`);

		return window;
	}

	// The REAL lifecycle service over the fake app
	const lifecycleExports = {};
	const lifecycleStubs = {
		'electron': { __esModule: true, default: { app: fakeApp } },
		'../../../base/parts/ipc/electron-main/ipcMain.js': { validatedIpcMain: {} },
		'../../../base/common/async.js': {
			Barrier: lib.Barrier,
			Promises: { settled: async promises => { const results = await Promise.allSettled(promises); const failed = results.find(result => result.status === 'rejected'); if (failed) { throw failed.reason; } return results.map(result => result.value); } },
			timeout: ms => sleep(ms)
		},
		'../../../base/common/event.js': { Emitter, Event },
		'../../../base/common/lifecycle.js': { Disposable, DisposableStore },
		'../../../base/common/platform.js': { isMacintosh: true, isWindows: false },
		'../../../base/common/process.js': { cwd: () => process.cwd() },
		'../../../base/common/types.js': { assertReturnsDefined: value => value },
		'../../instantiation/common/instantiation.js': { createDecorator: () => () => undefined },
		'../../log/common/log.js': { ILogService: () => undefined },
		'../../state/node/state.js': { IStateService: () => undefined },
		'../../window/electron-main/window.js': { LoadReason: {}, UnloadReason: {} },
		'../../environment/electron-main/environmentMainService.js': { IEnvironmentMainService: () => undefined },
		'../../windows/electron-main/windows.js': { getAllWindowsExcludingOffscreen: () => [] },
		'./willQuitGuard.js': lib.guardExports
	};
	new Function('exports', 'require', lib.lifecycleCode)(lifecycleExports, specifier => {
		if (!Object.hasOwn(lifecycleStubs, specifier)) {
			throw new Error(`lz1-startup-fixture: lifecycleMainService.ts imports ${specifier}, which the fixture does not stub`);
		}

		return lifecycleStubs[specifier];
	});
	const logs = { error: [], info: [] };
	const logService = {
		trace() { }, debug() { }, warn: (...args) => ev(`log.warn ${text(args)}`),
		info: (...args) => { logs.info.push(text(args)); ev(`log.info ${text(args)}`); },
		error: (...args) => { logs.error.push(text(args)); ev(`log.error ${text(args)}`); }
	};
	const stateService = { getItem: () => undefined, setItem() { }, removeItem() { }, close: async () => ev('state service closed') };
	const environmentMainService = { appRoot: '/app', args: {}, isBuilt: true, userDataPath: '/userData' };
	const lifecycleMainService = new lifecycleExports.LifecycleMainService(logService, stateService, environmentMainService);
	const phaseSetter = Object.getOwnPropertyDescriptor(lifecycleExports.LifecycleMainService.prototype, 'phase');
	Object.defineProperty(lifecycleMainService, 'phase', {
		get: () => phaseSetter.get.call(lifecycleMainService),
		set: value => { ev(`lifecycle phase ${value}`); phaseSetter.set.call(lifecycleMainService, value); }
	});

	// The services section's stages
	const held = new Map();
	const stage = (name, value) => {
		const spec = scenario[name];
		if (!spec) {
			throw new Error(`lz1-startup-fixture: scenario has no stage ${name}`);
		}
		ev(`stage ${name} started`);
		if (spec.hold) {
			return new Promise((resolve, reject) => held.set(name, { resolve: () => { ev(`stage ${name} released`); resolve(value); }, reject }));
		}

		return sleep(spec.at).then(() => {
			if (spec.reject) {
				ev(`stage ${name} rejects`);
				throw new Error(spec.reject);
			}
			ev(`stage ${name} resolved`);

			return value;
		});
	};
	const accessor = { get: () => ({}) };
	const appInstantiationService = { invokeFunction: fn => fn(accessor), createInstance: () => ({}) };

	// The client's start (the PAIRED client's shape: the hook awaited, bounded; the unwind runs before the rejection)
	const client = scenario.client;
	const hookOutcomes = [];
	async function startTerminalHost(ports) {
		ev('client start');
		const unwind = [];
		let shellWindow;
		let step = 'modules';
		try {
			if (client.waitingWindowMs !== undefined) {
				const wait = newWindow('keychain-wait');
				await sleep(client.waitingWindowMs);
				if (wait.isDestroyed()) {
					throw new Error('refuse keychain-wait: the Keychain waiting window was closed');
				}
				wait.close();
			}
			if (client.failAt !== undefined) {
				await sleep(client.failAt);
				step = 'loopback';
				throw new Error('refuse port: 127.0.0.1:47311 (EADDRINUSE)');
			}
			await sleep(client.hookAt);
			step = 'window';
			shellWindow = newWindow('terminal');
			unwind.push(() => (shellWindow.isDestroyed() ? ev('client unwind: the window was closed') : shellWindow.close()));
			const terminalHost = { window: shellWindow, host: { log: line => ev(`host.log ${line}`) } };
			step = 'before-show';
			ev('client hook called');
			let timer;
			const bound = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`the fork's onBeforeShow did not settle within ${client.boundMs} ms`)), client.boundMs); });
			const hook = Promise.resolve(ports.onBeforeShow(terminalHost));
			hook.then(() => hookOutcomes.push({ at: now(), ok: true }), error => hookOutcomes.push({ at: now(), ok: false, error: String(error?.message ?? error) }));
			try {
				await Promise.race([hook, bound]);
			} finally {
				clearTimeout(timer);
			}
			ev('client hook settled');
			step = 'show';
			shellWindow.show();
			ev('client REVEAL');
			ev('client driver-ready');

			return terminalHost;
		} catch (error) {
			const quit = shellWindow?.isDestroyed() === true;
			for (const entry of unwind.reverse()) {
				entry();
			}
			ev(`client unwound (${quit ? 'quit during start' : 'failed'} at step ${step}: ${error.message})`);
			if (quit) {
				throw new QuitDuringStart(`quit during the start at step ${step}: ${error.message}`, { cause: error });
			}
			throw new Error(`host-vscode: start failed at step ${step}: ${error.message}`, { cause: error });
		}
	}

	const qlServices = {
		qlWorkbenchHost: { attach: () => ev('fork ATTACH'), openQuantlab: async () => undefined },
		encryptionMainService: { terminalHostKeychainPhaseSettled: () => ev('fork REPORT keychain phase settled') }
	};
	const injected = {
		mark: () => undefined,
		getMarks: () => [{ name: 'code/timeOrigin', startTime: 0 }],
		isWindows: false,
		isMacintosh: true,
		app: fakeApp,
		systemPreferences: {},
		ElectronIPCServer: class { dispose() { } },
		Event,
		ShutdownReason: lifecycleExports.ShutdownReason,
		LifecycleMainPhase: lifecycleExports.LifecycleMainPhase,
		resolveMachineId: () => stage('machineIds', 'machine-id'),
		resolveSqmId: async () => 'sqm-id',
		resolveDevDeviceId: async () => 'dev-device-id',
		ErrorTelemetry: class { },
		ILogService: {}, ITelemetryService: {}, IProxyAuthService: {},
		UserDataProfilesHandler: class { },
		RunOnceScheduler: class { schedule() { } },
		runWhenGlobalIdle: () => ({ dispose() { } }),
		onBeforeShowAwaited: () => true,
		seedQlChromeSettings: async () => undefined,
		bakedBuildValues: () => ({ backendOrigin: 'https://api.example.test', version: '1.2.3' }),
		BaseWindow: {}, WebContentsView: {}, session: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, dialog: {}, screen: {},
		validatedIpcMain: {},
		startTerminalHost,
		isQuitDuringStart: error => error instanceof QuitDuringStart,
		CancellationError: class extends Error { }
	};
	const names = Object.keys(injected);
	const { CodeApplicationSlice } = new Function(...names, `${lib.sliceCode}\nreturn { CodeApplicationSlice };`)(...names.map(name => injected[name]));
	const instance = Object.create(CodeApplicationSlice.prototype);
	Object.assign(instance, {
		logService, environmentMainService, lifecycleMainService, stateService,
		productService: {},
		configurationService: { getValue: () => undefined },
		userDataProfilesMainService: { defaultProfile: { settingsResource: {} } },
		_register: value => value,
		setupSharedProcess: () => ({ sharedProcessReady: Promise.resolve(), sharedProcessClient: Promise.resolve({}) }),
		initServices: () => stage('initServices', appInstantiationService),
		initChannels: () => undefined,
		setupProtocolUrlHandlers: () => stage('protocolUrls', undefined),
		setupManagedRemoteResourceUrlHandler: () => undefined,
		createQlStartServices: () => {
			ev('createQlStartServices');
			if (scenario.createServices?.throws) {
				throw new Error(scenario.createServices.throws);
			}

			return qlServices;
		},
		finishQlTerminalHost: async () => { ev('finishQlTerminalHost'); return true; },
		afterWindowOpen: () => ev('afterWindowOpen'),
		eventuallyAfterWindowOpen: () => undefined,
		qlTerminalPaths: () => ({ preloadPath: '/preload.cjs', rendererDir: '/renderer' })
	});

	async function run(deadlineMs) {
		const unhandled = [];
		const onUnhandled = reason => { unhandled.push(String(reason?.message ?? reason)); ev(`UNHANDLED REJECTION ${String(reason?.message ?? reason)}`); };
		process.on('unhandledRejection', onUnhandled);
		let startup;
		const startupPromise = Promise.resolve().then(() => instance.startup()).then(
			() => { startup = { at: now(), ok: true }; ev('startup() returned'); },
			error => { startup = { at: now(), ok: false, error: String(error?.message ?? error) }; ev(`startup() rejected: ${error?.message ?? error}`); }
		);
		const timers = [];
		if (scenario.quitAt !== undefined) {
			timers.push(setTimeout(() => fakeApp.quit(), scenario.quitAt));
		}
		for (const release of scenario.releases ?? []) {
			timers.push(setTimeout(() => {
				const entry = held.get(release.name);
				if (!entry) {
					ev(`release ${release.name}: the stage was never started`);
					return;
				}
				entry.resolve();
			}, release.at));
		}
		const until = Date.now() + deadlineMs;
		// a quit scenario ends at the exit (startup() may never settle: a services stage held for ever); any other at startup()'s end
		while (Date.now() < until && !(scenario.quitAt === undefined ? startup : exits.length)) {
			await sleep(5);
		}
		// late events (a rejection with no handler is reported after the microtask queue drains)
		await sleep(scenario.settleMs ?? 100);
		process.off('unhandledRejection', onUnhandled);
		for (const timer of timers) {
			clearTimeout(timer);
		}
		void startupPromise;

		return { events, unhandled, startup, exits, logs, hookOutcomes, quitAt: scenario.quitAt };
	}

	return { run, fakeApp, lifecycleMainService };
}

/** The first event whose text matches, or undefined. */
export function find(result, pattern) {
	return result.events.find(event => pattern.test(event.text));
}

/** The event list, one line each, for a RED row's evidence. */
export function trace(result) {
	return result.events.map(event => `      ${String(event.at).padStart(5)} ms  ${event.text}`).join('\n');
}
