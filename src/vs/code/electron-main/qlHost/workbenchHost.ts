/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the host's side of the workbench view: what puts it on screen and takes it off, the one toggle key, the
// one fixed command `Ports.openQuantlab` runs, the quit handshake through the fork's lifecycle, and the host window's
// registration with the lifecycle service. The lazy gate and the adoption are `gate.ts` and `adopt.ts`.

import { EventEmitter } from 'events';
import type { BaseWindow, BrowserWindow, Event as ElectronEvent, Input, MessageBoxOptions, WebContents } from 'electron';
import { DeferredPromise, timeout } from '../../../base/common/async.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { ILifecycleMainService } from '../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INativeRunActionInWindowRequest } from '../../../platform/window/common/window.js';
import { ICodeWindow } from '../../../platform/window/electron-main/window.js';
import type { TerminalHost, WorkbenchContents } from '../ql-client/index.js';
import { IAdoptedWorkbench } from './adopt.js';
import { QlDialogMainService } from './dialogs.js';
import { IQlWorkbenchListener, QlWindowsGate } from './gate.js';
import { secureWorkbenchContents } from './security.js';
import { IQlFramePolicy } from './securityPolicy.js';
import type { IQlVisibleTarget } from './standIn.js';
import { createToggleSequencer, type ToggleView } from './toggleSequencer.js';

/** The ONE key that toggles between the terminal and the workbench, while either has focus. Modifiers `CmdOrCtrl`, `Alt`, `Shift`, then one letter. */
export const QL_TOGGLE_ACCELERATOR = 'CmdOrCtrl+Alt+T';

// QuantLab host (U6): the ONE key that opens the overlay when it is closed and closes it when it is open, while the terminal, the
// workbench or the overlay has focus. Same grammar as the toggle key; it is a window-scoped `before-input-event` on each of the
// three views, never a global shortcut (rule 3).
export const QL_OVERLAY_ACCELERATOR = 'CmdOrCtrl+Alt+K';

/** The ONE command `Ports.openQuantlab('new-strategy')` runs in the workbench. */
export const QL_NEW_STRATEGY_COMMAND = 'quantlab.newStrategy';

interface IParsedAccelerator {
	readonly cmdOrCtrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly code: string;
}

function parseAccelerator(accelerator: string): IParsedAccelerator {
	const tokens = accelerator.split('+');
	const key = tokens.pop();

	let cmdOrCtrl = false;
	let alt = false;
	let shift = false;
	for (const token of tokens) {
		switch (token) {
			case 'CmdOrCtrl': cmdOrCtrl = true; break;
			case 'Alt': alt = true; break;
			case 'Shift': shift = true; break;
			default: throw new Error(`QuantLab host (U5): accelerator ${accelerator}: unknown modifier ${token}`);
		}
	}

	if (key === undefined || !/^[A-Z]$/.test(key)) {
		throw new Error(`QuantLab host (U5): accelerator ${accelerator}: the last part must be one capital letter`);
	}

	return { cmdOrCtrl, alt, shift, code: `Key${key}` };
}

const TOGGLE_ACCELERATOR = parseAccelerator(QL_TOGGLE_ACCELERATOR);
const OVERLAY_ACCELERATOR = parseAccelerator(QL_OVERLAY_ACCELERATOR); // QuantLab host (U6)

// PERF-1b's control `perf-delayed-switch`: test builds only (`globalThis.QL_TEST_BUILD` is a constant `false` in a product
// bundle, so esbuild drops the branch), and only when the launch names it. It delays every toggle by 250 ms so that the
// view-switch probe (SW-1) must fail.
const PERF_DELAYED_SWITCH_MUTANT = 'perf-delayed-switch';
const PERF_DELAYED_SWITCH_MS = 250;

function perfDelayedSwitchActive(): boolean {
	return globalThis.QL_TEST_BUILD === true && process.env['DESK_MUTANT'] === PERF_DELAYED_SWITCH_MUTANT;
}

/** By `code` (the physical key), so an Alt-modified character (macOS) does not matter. */
function matchesAccelerator(input: Input, accelerator: IParsedAccelerator): boolean {
	const primary = isMacintosh ? input.meta : input.control;
	const otherPrimary = isMacintosh ? input.control : input.meta;

	return input.type === 'keyDown' && input.code === accelerator.code && primary === accelerator.cmdOrCtrl && input.alt === accelerator.alt && input.shift === accelerator.shift && !otherPrimary;
}

export interface IQlWorkbenchHostDeps {
	readonly gate: QlWindowsGate;
	readonly dialogs: QlDialogMainService;
	readonly lifecycleMainService: ILifecycleMainService;
	readonly logService: ILogService;

	/** Runs the stock first-window flow through the gate (`app.ts` `openFirstWindow`): the gate adopts the window it opens. */
	openWorkbench(): Promise<unknown>;

	/** Opens `url` in the system browser. */
	openExternal(url: string): void;

	/** Review c1 M2: the workbench document and webview scheme the adopted contents' navigation decisions use. */
	readonly framePolicy: IQlFramePolicy;
}

export class QlWorkbenchHost extends Disposable implements IQlWorkbenchListener {

	private readonly attached = new DeferredPromise<TerminalHost>();
	private terminalHost: TerminalHost | undefined;

	/** Which of the two views the host last showed (the terminal is shown at start). */
	private shown: 'terminal' | 'workbench' = 'terminal';

	private ensuring: Promise<IAdoptedWorkbench> | undefined;

	/** QuantLab host (U6): the key watch on the overlay view's contents (the overlay is a new view each time it opens). */
	private readonly overlayKeyWatch = this._register(new MutableDisposable<IDisposable>());

	/** The host window's close was asked for and is being settled through the lifecycle. */
	private closing = false;

	/** The settling is over: the next `close` event of the host window is let through. */
	private hostMayClose = false;

	private readonly workbenchDisposables = new Map<IAdoptedWorkbench, DisposableStore>();

	constructor(private readonly deps: IQlWorkbenchHostDeps) {
		super();
	}

	//#region start

	/** Called once, from the terminal host's onBeforeShow (review c1 M7). */
	attach(terminalHost: TerminalHost): void {
		if (this.terminalHost) {
			throw new Error('QuantLab host (U5): the workbench host is already attached');
		}

		const terminalView = terminalHost.view('terminal');
		if (!terminalView) {
			throw new Error('QuantLab host (U5): the started host registered no terminal view');
		}

		this.terminalHost = terminalHost;

		this._register(this.watchKeys(terminalView.webContents)); // QuantLab host (U6): the toggle key and the overlay key
		terminalHost.window.on('close', event => this.onHostWindowClose(event));
		this.registerLifecyclePlaceholder();
		this.deps.dialogs.setParentResolver(window => this.dialogParent(window));
		this.deps.gate.attach(this);
		if (perfDelayedSwitchActive()) {
			terminalHost.host.log(`mutant ${PERF_DELAYED_SWITCH_MUTANT} ACTIVE`);
		}
		// Review c1 M7: called from the start's onBeforeShow, before the window is shown and the terminal's first document loads,
		// so no key and no close of the start reaches the host before these watches.
		terminalHost.host.log('workbench host attached');
		this.attached.complete(terminalHost);
	}

	private requireTerminalHost(): TerminalHost {
		if (!this.terminalHost) {
			throw new Error('QuantLab host (U5): the workbench host is not attached to a started terminal host');
		}

		return this.terminalHost;
	}

	/**
	 * The lifecycle service counts CodeWindows and, off macOS, starts the shutdown when the last one closes. Here the app
	 * lives as long as the host window, not as long as a workbench: closing the workbench (or its crash dialog's "Close") must
	 * not start the shutdown, and a host that never opened one must not see the counter at zero. The host window counts as one
	 * window that never closes; the shutdown then starts from Electron's `will-quit`, which `LifecycleMainService` handles the
	 * same way. Only `onWillLoad`, `win` (an event emitter nobody emits on) and `id` are read from a registered window.
	 */
	private registerLifecyclePlaceholder(): void {
		const placeholder = { id: -1, win: new EventEmitter(), onWillLoad: Event.None };
		const asCodeWindow: unknown = placeholder;
		this.deps.lifecycleMainService.registerWindow(asCodeWindow as ICodeWindow);
	}

	//#endregion

	//#region showing and hiding

	/** Makes sure a workbench exists (the first use runs the stock open flow through the gate), whatever its state. */
	private async ensureWorkbench(cause: string): Promise<IAdoptedWorkbench> {
		await this.attached.p;

		const existing = this.deps.gate.workbench;
		if (existing) {
			return existing;
		}

		if (!this.ensuring) {
			this.deps.logService.info(`QuantLab host: workbench requested (cause: ${cause})`);
			// the host log's line (`shell: first-use workbench cause=…`): its absence proves the workbench was never started
			this.requireTerminalHost().host.log(`first-use workbench cause=${cause}`);

			this.ensuring = this.deps.openWorkbench().then(() => {
				const workbench = this.deps.gate.workbench;
				if (!workbench) {
					throw new Error(`QuantLab host (U5): the ${cause} request ended without a workbench window`);
				}

				return workbench;
			}).finally(() => {
				this.ensuring = undefined;
			});
		}

		return this.ensuring;
	}

	/** Ensures the workbench, waits until it signalled ready, and shows it. Visibility only: nothing is removed or destroyed. */
	async showWorkbench(cause: string): Promise<IAdoptedWorkbench> {
		const workbench = await this.ensureWorkbench(cause);
		await workbench.whenReady();

		if (this.deps.gate.workbench !== workbench) {
			throw new Error(`QuantLab host (U5): the workbench window went away before it could be shown (${cause})`);
		}

		this.requireTerminalHost().show('workbench');
		this.shown = 'workbench';

		return workbench;
	}

	showTerminal(): void {
		this.requireTerminalHost().show('terminal');
		this.shown = 'terminal';
	}

	/**
	 * The toggle key (review c1 S3: one transition at a time, each choosing its target when its turn comes; toggleSequencer.ts).
	 * The host log gets `view-switch start` when the transition starts (at the key's receipt unless an earlier one is running:
	 * then `view-switch queued` at receipt) and `view-switch done` once the target view is shown (PERF-1b SW-1 reads both).
	 */
	async toggle(): Promise<void> {
		await this.toggles.toggle();
	}

	private readonly toggles = createToggleSequencer({
		shown: () => this.shown,
		apply: to => this.applyToggle(to),
		queued: () => this.requireTerminalHost().host.log(`view-switch queued t=${Date.now()}`)
	});

	private async applyToggle(to: ToggleView): Promise<void> {
		const terminalHost = this.requireTerminalHost();
		const host = terminalHost.host;

		host.log(`view-switch start to=${to} t=${Date.now()}`);
		// QuantLab host (U6): a switch closes the overlay first (the client's `show` closes it too, so no path leaves it open)
		if (terminalHost.overlayOpen()) {
			terminalHost.closeOverlay();
		}
		if (perfDelayedSwitchActive()) {
			await timeout(PERF_DELAYED_SWITCH_MS);
		}

		if (to === 'workbench') {
			await this.showWorkbench('key');
		} else {
			this.showTerminal();
		}
		host.log(`view-switch done to=${to} t=${Date.now()}`);
	}

	/** The toggle for a caller with nobody to tell about a failure (the toggle key; a test build's driver request): a failure is reported as the key's is. */
	requestToggle(cause: string): void {
		this.toggle().catch(error => this.reportFailure(cause, error));
	}

	/** A request that wants the workbench on screen and has nobody to tell about a failure (launch arguments, the gate's open requests). */
	requestWorkbench(cause: string): void {
		this.showWorkbench(cause).catch(error => this.reportFailure(cause, error));
	}

	/**
	 * `Ports.openQuantlab('new-strategy')`: ensures the workbench (the first use), shows it, then runs the ONE fixed command
	 * `quantlab.newStrategy` in it by sending `vscode:runAction` (the message the menubar sends for a menu item; the workbench's
	 * `window.ts` runs the command). Resolves when the view is shown and the command was sent; rejects by name otherwise.
	 */
	async openQuantlab(intent: 'new-strategy'): Promise<void> {
		if (intent !== 'new-strategy') {
			throw new Error(`QuantLab host (U5): openQuantlab intent ${JSON.stringify(intent)} is not 'new-strategy'`);
		}

		try {
			const workbench = await this.showWorkbench('openQuantlab');
			if (workbench.webContents.isDestroyed()) {
				throw new Error('QuantLab host (U5): the workbench contents are destroyed');
			}

			const request: INativeRunActionInWindowRequest = { id: QL_NEW_STRATEGY_COMMAND, from: 'menu' };
			workbench.codeWindow.send('vscode:runAction', request);
		} catch (error) {
			this.deps.logService.error(`QuantLab host: openQuantlab(${intent}) failed`, error);

			throw error;
		}
	}

	/** The dock activation (macOS): bring the host window back. It is not a request for a workbench. */
	restoreHostWindow(): void {
		const window = this.requireTerminalHost().window;
		if (window.isMinimized()) {
			window.restore();
		}

		window.show();
	}

	/**
	 * The window-scoped keys of one view's contents: the toggle key and (U6) the overlay key. Each is swallowed (`preventDefault`)
	 * so the view does not also see it, and an auto-repeat does nothing.
	 */
	private watchKeys(contents: WebContents): IDisposable {
		return Event.fromNodeEventEmitter(contents, 'before-input-event', (event: ElectronEvent, input: Input) => ({ event, input }))(({ event, input }) => {
			if (matchesAccelerator(input, TOGGLE_ACCELERATOR)) {
				event.preventDefault();
				if (input.isAutoRepeat) {
					return;
				}

				this.requestToggle('toggle key');

				return;
			}

			// QuantLab host (U6)
			if (matchesAccelerator(input, OVERLAY_ACCELERATOR)) {
				event.preventDefault();
				if (input.isAutoRepeat) {
					return;
				}

				this.toggleOverlay().catch(error => this.reportOverlayFailure('overlay key', error));
			}
		});
	}

	/**
	 * QuantLab host (U6): the overlay key. Closed: opens the overlay (a view of the terminal's own wiring, over the view on
	 * screen) and watches its keys; open: closes it. `openOverlay` registers the view before it returns its promise, so the key
	 * watch is on the overlay's contents from the moment it exists (a key pressed while its document loads still closes it).
	 */
	async toggleOverlay(): Promise<void> {
		const terminalHost = this.requireTerminalHost();
		if (terminalHost.overlayOpen()) {
			terminalHost.closeOverlay();

			return;
		}

		const opening = terminalHost.openOverlay();
		const view = terminalHost.view('overlay');
		if (view) {
			this.overlayKeyWatch.value = this.watchKeys(view.webContents);
		}

		await opening;
		if (!view) {
			throw new Error('QuantLab host (U6): openOverlay resolved and registered no view named overlay');
		}
	}

	private reportFailure(what: string, error: unknown): void {
		this.showFailure('QuantLab could not show the workbench.', what, error);
	}

	// QuantLab host (U6): the overlay's failures read as the overlay's, not the workbench's
	private reportOverlayFailure(what: string, error: unknown): void {
		this.showFailure('QuantLab could not open the overlay.', what, error);
	}

	private showFailure(headline: string, what: string, error: unknown): void {
		this.deps.logService.error(`QuantLab host: ${what} failed`, error);

		// On the host window when there is one: unparented, the dialog is app-modal on macOS and holds the main thread (no
		// quit, no other event) until it is answered. Before the terminal host is attached there is no window to carry it.
		const options: MessageBoxOptions = { type: 'error', message: headline, detail: `${what}: ${toErrorMessage(error)}` };
		const host = this.terminalHost?.window;
		const shown = host && !host.isDestroyed() ? this.deps.dialogs.showMessageBoxOnHost(options, host) : this.deps.dialogs.showMessageBox(options);
		shown.then(undefined, failure => this.deps.logService.error('QuantLab host: showing the failure dialog failed', failure));
	}

	//#endregion

	//#region IQlWorkbenchListener (called by the gate)

	visibleTarget(): IQlVisibleTarget {
		const terminalHost = this.requireTerminalHost();

		return {
			window: terminalHost.window,
			focusWorkbench: () => {
				terminalHost.window.focus();
				this.surface('focus');
			}
		};
	}

	adopted(workbench: IAdoptedWorkbench): void {
		const terminalHost = this.requireTerminalHost();
		const disposables = new DisposableStore();

		try {
			disposables.add(secureWorkbenchContents(workbench.webContents, { logService: this.deps.logService, policy: this.deps.framePolicy, openExternal: url => this.deps.openExternal(url) }));
			disposables.add(this.watchKeys(workbench.webContents)); // QuantLab host (U6): the toggle key and the overlay key

			// hidden until it signalled ready: the terminal stays on screen meanwhile
			workbench.view.setVisible(false);
			terminalHost.addView('workbench', 'workbench', workbench.view, { ...workbench.webPreferences });
			terminalHost.setWorkbench(this.workbenchContents(workbench, disposables));
		} catch (error) {
			disposables.dispose();
			if (terminalHost.view('workbench') === workbench.view) {
				terminalHost.removeView('workbench');
			}

			throw error;
		}

		this.workbenchDisposables.set(workbench, disposables);
	}

	gone(workbench: IAdoptedWorkbench): void {
		const terminalHost = this.requireTerminalHost();

		this.workbenchDisposables.get(workbench)?.dispose();
		this.workbenchDisposables.delete(workbench);

		try {
			terminalHost.setWorkbench(undefined);
		} finally {
			const windowGone = terminalHost.window.isDestroyed();
			if (!windowGone && terminalHost.view('workbench') === workbench.view) {
				terminalHost.removeView('workbench');
			}

			workbench.closeContents();

			// the terminal comes back unless the host window itself is going away (no flash of the terminal at quit)
			if (!windowGone && !this.closing && !this.deps.lifecycleMainService.quitRequested) {
				terminalHost.show('terminal');
			}
			this.shown = 'terminal';
		}
	}

	surface(cause: string): void {

		// logged only: the request that opened the window gets its own failure from the gate, and the host's own triggers
		// (`toggle`, `openQuantlab`, `requestWorkbench`) report theirs
		this.showWorkbench(cause).catch(error => this.deps.logService.error(`QuantLab host: showing the workbench for the ${cause} request failed`, error));
	}

	private workbenchContents(workbench: IAdoptedWorkbench, disposables: DisposableStore): WorkbenchContents {
		const contents = workbench.webContents;

		return {
			id: contents.id,
			isMainFrame: frame => frame === contents.mainFrame,
			send: (channel, payload) => contents.send(channel, payload),
			onMainFrameGone: listener => {
				disposables.add(Event.fromNodeEventEmitter(contents, 'did-start-navigation', (details: { isMainFrame: boolean; isSameDocument: boolean }) => details)(details => {
					if (details.isMainFrame && !details.isSameDocument) {
						listener();
					}
				}));
				disposables.add(Event.fromNodeEventEmitter(contents, 'render-process-gone')(() => listener()));
				disposables.add(workbench.onDidGone(() => listener()));
			}
		};
	}

	/** A dialog the stock code parents to the adopted workbench's window belongs to the host window. */
	private dialogParent(window: BrowserWindow): BaseWindow | undefined {
		const workbench = this.deps.gate.workbench;
		if (workbench && (window === workbench.standIn || window === workbench.shell)) {
			return this.terminalHost?.window;
		}

		return undefined;
	}

	//#endregion

	//#region quit, window close and update-restart

	// The host window is a BaseWindow the lifecycle service does not know, while the adopted workbench is a CodeWindow it does:
	// its unload handshake (the workbench renderer's save prompts and hot exit) runs when the CodeWindow's own BrowserWindow
	// is asked to close, which happens inside `app.quit()`. So the host window is never closed before that handshake ended:
	// every `close` of it (the user's, or Electron's own while quitting, or an update restart: all end in `app.quit()`) is
	// held, the quit is run through `lifecycleMainService.quit()`, and the host window is closed once the CodeWindow is
	// closed. A veto (the user cancelled a save prompt) leaves everything open and shows the workbench. With no workbench
	// there is nothing to settle and the window closes at once (`window-all-closed` then quits, `app.ts`).

	private onHostWindowClose(event: ElectronEvent): void {
		if (this.hostMayClose) {
			return;
		}

		event.preventDefault();
		if (this.closing) {
			return;
		}

		this.closing = true;
		this.settleThenCloseHostWindow().catch(error => {
			this.closing = false;
			this.reportFailure('closing the window', error);
		});
	}

	private async settleThenCloseHostWindow(): Promise<void> {
		await this.deps.gate.whenOpeningSettled();

		const workbench = this.deps.gate.workbench;
		if (workbench && await this.runQuitHandshake(workbench) === 'veto') {
			this.closing = false;
			this.deps.logService.info('QuantLab host: the quit was vetoed; the workbench is shown');
			await this.showWorkbench('vetoed quit');

			return;
		}

		this.hostMayClose = true;
		this.requireTerminalHost().window.close();
	}

	/** Runs the fork's quit; resolves `closed` when the workbench's CodeWindow closed, `veto` when a window vetoed the quit. */
	private runQuitHandshake(workbench: IAdoptedWorkbench): Promise<'closed' | 'veto'> {
		return new Promise((resolve, reject) => {
			if (this.deps.gate.workbench !== workbench) {
				resolve('closed');

				return;
			}

			const disposables = new DisposableStore();
			disposables.add(workbench.onDidGone(() => {
				disposables.dispose();
				resolve('closed');
			}));

			this.deps.lifecycleMainService.quit().then(veto => {
				disposables.dispose();
				resolve(veto ? 'veto' : 'closed');
			}, error => {
				disposables.dispose();
				reject(error);
			});
		});
	}

	//#endregion
}
