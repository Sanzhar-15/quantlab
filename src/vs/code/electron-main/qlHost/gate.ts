/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the lazy gate. It stands in for `IWindowsMainService` (registered in `app.ts` `initServices`), so EVERY
// path that would open a `CodeWindow` (second instance / CLI, open-file, protocol URLs, `openEmptyWindow` callers, the
// CodeWindow's own "reopen after a crash") reaches this one place. Until the first use no CodeWindow exists, hence no
// workbench renderer, extension host, shared process or pty host. The first use runs the stock flow of the wrapped
// `WindowsMainService` and adopts the CodeWindow it creates (see `adopt.ts`).

import type { WebPreferences } from 'electron';
import { DeferredPromise } from '../../../base/common/async.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IProcessEnvironment } from '../../../base/common/platform.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IOpenEmptyWindowOptions } from '../../../platform/window/common/window.js';
import { ICodeWindow, WindowMode } from '../../../platform/window/electron-main/window.js';
import { getFocusedWindowIncludingAdopted, IOpenConfiguration, IOpenEmptyConfiguration, IWindowsCountChangedEvent, IWindowsMainService, OpenContext, setQlHostWindowSeam } from '../../../platform/windows/electron-main/windows.js';
import { WindowsMainService } from '../../../platform/windows/electron-main/windowsMainService.js';
import { adoptCodeWindow, IAdoptedWorkbench } from './adopt.js';

export type QlGateState = 'idle' | 'opening' | 'open';

/** What the host does when the gate adopts a workbench, loses it, or completes an open request. */
export interface IQlWorkbenchListener {

	/** Synchronous, inside `onDidOpenWindow`: the CodeWindow has not loaded anything yet. A throw makes the gate discard the window. */
	adopted(workbench: IAdoptedWorkbench): void;

	/** The workbench's CodeWindow closed or was destroyed; the gate is `idle` again. */
	gone(workbench: IAdoptedWorkbench): void;

	/** An open request completed and a workbench exists: the request wants it on screen. */
	surface(cause: string): void;
}

function describeOpenContext(context: OpenContext): string {
	switch (context) {
		case OpenContext.CLI: return 'cli';
		case OpenContext.DOCK: return 'dock';
		case OpenContext.MENU: return 'menu';
		case OpenContext.DIALOG: return 'dialog';
		case OpenContext.DESKTOP: return 'desktop';
		case OpenContext.API: return 'api';
		case OpenContext.LINK: return 'link';
	}
}

export class QlWindowsGate extends Disposable implements IWindowsMainService {

	declare readonly _serviceBrand: undefined;

	readonly onDidChangeWindowsCount: Event<IWindowsCountChangedEvent>;
	readonly onDidOpenWindow: Event<ICodeWindow>;
	readonly onDidSignalReadyWindow: Event<ICodeWindow>;
	readonly onDidMaximizeWindow: Event<ICodeWindow>;
	readonly onDidUnmaximizeWindow: Event<ICodeWindow>;
	readonly onDidChangeFullScreen: Event<{ window: ICodeWindow; fullscreen: boolean }>;
	readonly onDidTriggerSystemContextMenu: Event<{ readonly window: ICodeWindow; readonly x: number; readonly y: number }>;
	readonly onDidDestroyWindow: Event<ICodeWindow>;

	private readonly inner: WindowsMainService;

	private readonly listenerAttached = new DeferredPromise<void>();
	private listener: IQlWorkbenchListener | undefined;

	private state: QlGateState = 'idle';

	/** The first use in flight: concurrent callers await this very promise (it rejects with the first use's error). */
	private opening: Promise<void> | undefined;

	/** Settles (never rejects) when the first use in flight has either succeeded or failed; its error went to its callers and the log. */
	private settled: Promise<void> | undefined;

	private current: IAdoptedWorkbench | undefined;

	/** The webPreferences of the CodeWindows created and not yet seen by `onDidOpenWindow` (always 0 or 1: both happen synchronously). */
	private readonly pendingWebPreferences: WebPreferences[] = [];

	/** CodeWindows that were opened but could not be adopted, with the reason; the request that opened them fails and closes them. */
	private readonly unadopted: { readonly window: ICodeWindow; readonly reason: string }[] = [];

	constructor(
		machineId: string,
		sqmId: string,
		devDeviceId: string,
		userEnv: IProcessEnvironment,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.inner = this._register(instantiationService.createInstance(WindowsMainService, machineId, sqmId, devDeviceId, userEnv));

		this.onDidChangeWindowsCount = this.inner.onDidChangeWindowsCount;
		this.onDidOpenWindow = this.inner.onDidOpenWindow;
		this.onDidSignalReadyWindow = this.inner.onDidSignalReadyWindow;
		this.onDidMaximizeWindow = this.inner.onDidMaximizeWindow;
		this.onDidUnmaximizeWindow = this.inner.onDidUnmaximizeWindow;
		this.onDidChangeFullScreen = this.inner.onDidChangeFullScreen;
		this.onDidTriggerSystemContextMenu = this.inner.onDidTriggerSystemContextMenu;
		this.onDidDestroyWindow = this.inner.onDidDestroyWindow;

		// The stock window is only a shell: it never shows (the workbench is shown in the host's view). A saved maximised or
		// fullscreen state would show it in `CodeWindow.applyState`, so the state it is created with is the normal one.
		// The webPreferences it is created with are the ones the view is built from.
		setQlHostWindowSeam({
			onCodeWindowOptions: (options, windowState) => {
				if (!options.webPreferences) {
					throw new Error('QuantLab host (U5): the options of a CodeWindow carry no webPreferences');
				}

				options.show = false;
				windowState.mode = WindowMode.Normal;
				this.pendingWebPreferences.push({ ...options.webPreferences });
			}
		});

		// Subscribed before any other listener of the service (this constructor runs first), so the adoption happens before
		// anything else sees the new window.
		this._register(this.inner.onDidOpenWindow(window => this.onDidOpenCodeWindow(window)));
	}

	//#region host side

	/** Called once by the host, after the terminal host started. Requests that arrived earlier wait for it. */
	attach(listener: IQlWorkbenchListener): void {
		if (this.listener) {
			throw new Error('QuantLab host (U5): the gate already has a listener');
		}

		this.listener = listener;
		this.listenerAttached.complete();
	}

	get workbench(): IAdoptedWorkbench | undefined {
		return this.current;
	}

	get workbenchState(): QlGateState {
		return this.state;
	}

	/** Resolves when no first use is in flight (it does not say whether it succeeded: its callers and the log have that). */
	async whenOpeningSettled(): Promise<void> {
		await this.settled;
	}

	//#endregion

	//#region the one gate

	private async use<T>(cause: string, run: () => Promise<T>): Promise<T> {
		await this.listenerAttached.p;

		if (this.state === 'opening') {
			await this.opening; // rejects with the first use's error: concurrent first uses share one outcome
		}

		if (this.state === 'idle') {
			return this.firstUse(cause, run);
		}

		const { value, extras } = await this.runOpen(run);
		this.listener?.surface(cause);
		if (extras) {
			throw extras;
		}

		return value;
	}

	private firstUse<T>(cause: string, run: () => Promise<T>): Promise<T> {
		this.logService.info(`QuantLab host: workbench first use (cause: ${cause})`);

		this.state = 'opening';

		const opened = this.runOpen(run).then(result => {
			if (!this.current) {
				throw result.extras ?? new Error(`QuantLab host (U5): the ${cause} request returned without opening a workbench window`);
			}

			this.state = 'open';

			return result;
		}).catch((error: unknown) => {
			this.state = 'idle';
			this.opening = undefined;
			this.discardCurrent();

			throw error; // to the caller of the request and to every concurrent first use awaiting `opening`
		});

		this.opening = opened.then(() => undefined);
		this.settled = this.opening.then(() => undefined, () => undefined);

		// The log gets the failure once, here (the callers get the error itself).
		this.opening.catch(error => this.logService.error(`QuantLab host: workbench first use (cause: ${cause}) failed; the gate is idle again`, error));

		return opened.then(({ value, extras }) => {
			this.listener?.surface(cause);
			if (extras) {
				throw extras; // the workbench is open and kept; the request still reports that it asked for more windows than the host holds
			}

			return value;
		});
	}

	/** Runs the stock open. Windows it opened that could not be adopted are closed here and reported as `extras` (the caller throws it). */
	private async runOpen<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly extras: Error | undefined }> {
		const value = await run();

		if (this.unadopted.length === 0) {
			return { value, extras: undefined };
		}

		const failures = this.unadopted.splice(0);
		for (const { window } of failures) {
			window.close();
		}

		return { value, extras: new Error(`QuantLab host (U5): the request opened ${failures.length} window(s) that cannot be shown (the host holds ONE workbench window), so they were closed: ${failures.map(failure => failure.reason).join('; ')}`) };
	}

	private discardCurrent(): void {
		const workbench = this.current;
		if (!workbench) {
			return;
		}

		try {
			workbench.codeWindow.close();
		} catch (error) {
			this.logService.error('QuantLab host: closing the workbench window of a failed first use failed', error);
		}

		// the window is as good as gone: the next use must not find it (its `closed` event comes later and is then ignored)
		this.onWorkbenchGone(workbench);
	}

	private onDidOpenCodeWindow(codeWindow: ICodeWindow): void {
		const captured = this.pendingWebPreferences.splice(0);
		const listener = this.listener;

		let refusal: string | undefined;
		if (!listener) {
			refusal = 'the host is not attached';
		} else if (this.current) {
			refusal = 'a workbench window already exists';
		} else if (captured.length !== 1) {
			refusal = `${captured.length} option sets were recorded for it (expected 1)`;
		}

		if (refusal === undefined && listener) {
			let workbench: IAdoptedWorkbench | undefined;
			try {
				const adopted = adoptCodeWindow(codeWindow, captured[0]);
				workbench = adopted;
				this.current = adopted;
				adopted.onDidGone(() => this.onWorkbenchGone(adopted));
				listener.adopted(adopted);

				return;
			} catch (error) {
				this.logService.error('QuantLab host: adopting the opened window failed', error);
				refusal = `adoption failed: ${error instanceof Error ? error.message : String(error)}`;
				if (workbench) {
					this.current = undefined;
					workbench.closeContents();
					workbench.dispose();
				}
			}
		}

		this.logService.error(`QuantLab host: a window was opened that the host cannot adopt (${refusal})`);
		this.unadopted.push({ window: codeWindow, reason: refusal ?? 'unknown' });
	}

	private onWorkbenchGone(workbench: IAdoptedWorkbench): void {
		if (this.current !== workbench) {
			return;
		}

		this.current = undefined;
		this.state = 'idle';
		this.logService.info('QuantLab host: the workbench window is gone; the next use opens a new one');

		try {
			this.listener?.gone(workbench);
		} finally {
			workbench.dispose();
		}
	}

	//#endregion

	//#region IWindowsMainService

	open(openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {
		return this.use(`open (${describeOpenContext(openConfig.context)})`, () => this.inner.open(openConfig));
	}

	openEmptyWindow(openConfig: IOpenEmptyConfiguration, options?: IOpenEmptyWindowOptions): Promise<ICodeWindow[]> {
		return this.use(`openEmptyWindow (${describeOpenContext(openConfig.context)})`, () => this.inner.openEmptyWindow(openConfig, options));
	}

	openExtensionDevelopmentHostWindow(extensionDevelopmentPath: string[], openConfig: IOpenConfiguration): Promise<ICodeWindow[]> {
		const error = new Error(`QuantLab host (U5): an extension development host window is a second window; the host holds ONE workbench window (${extensionDevelopmentPath.join(', ')})`);
		this.logService.error(error);

		return Promise.reject(error);
	}

	openExistingWindow(window: ICodeWindow, openConfig: IOpenConfiguration): void {
		this.inner.openExistingWindow(window, openConfig);
		this.listener?.surface(`openExistingWindow (${describeOpenContext(openConfig.context)})`);
	}

	sendToFocused(channel: string, ...args: unknown[]): void {
		this.inner.sendToFocused(channel, ...args);
	}

	sendToOpeningWindow(channel: string, ...args: unknown[]): void {
		this.inner.sendToOpeningWindow(channel, ...args);
	}

	sendToAll(channel: string, payload?: unknown, windowIdsToIgnore?: number[]): void {
		this.inner.sendToAll(channel, payload, windowIdsToIgnore);
	}

	getWindows(): ICodeWindow[] {
		return this.inner.getWindows();
	}

	getWindowCount(): number {
		return this.inner.getWindowCount();
	}

	getFocusedWindow(): ICodeWindow | undefined {
		// the stock call asks Electron for the focused BrowserWindow, which is never the adopted workbench (its page has focus
		// inside a view of the host's BaseWindow)
		const focused = getFocusedWindowIncludingAdopted();

		return focused ? this.inner.getWindowById(focused.id) : undefined;
	}

	getLastActiveWindow(): ICodeWindow | undefined {
		return this.inner.getLastActiveWindow();
	}

	getWindowById(windowId: number): ICodeWindow | undefined {
		return this.inner.getWindowById(windowId);
	}

	getWindowByWebContents(webContents: Electron.WebContents): ICodeWindow | undefined {
		// the stock call goes through `BrowserWindow.fromWebContents`, which cannot see a view's contents
		return this.inner.getWindows().find(window => window.matches(webContents));
	}

	//#endregion
}

/** `app.ts` registers the gate as `IWindowsMainService`; the host needs it as itself. */
export function requireQlWindowsGate(service: IWindowsMainService): QlWindowsGate {
	if (!(service instanceof QlWindowsGate)) {
		throw new Error('QuantLab host (U5): IWindowsMainService is not the host gate (app.ts initServices)');
	}

	return service;
}
