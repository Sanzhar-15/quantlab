/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the workbench adopted as a lazy sibling view of the terminal.
//
// The stock flow (`windowsMainService.open`) creates a `CodeWindow` whose `BrowserWindow` is only a hidden shell here (the
// `windows.ts` seam hides it). `adoptCodeWindow` runs synchronously inside `onDidOpenWindow`, before the CodeWindow loads
// anything: it builds a `WebContentsView` from the very webPreferences the stock window was created with, and re-points the
// CodeWindow at a stand-in whose `webContents` and `loadURL` are the view's, so `load`, `send`, the unload handshake and the
// crash handling all talk to the view's renderer while every other window call lands on the hidden shell.

import { WebContentsView, type BrowserWindow, type WebContents, type WebPreferences } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ICodeWindow } from '../../../platform/window/electron-main/window.js';
import { registerQlAdoptedWindow } from '../../../platform/windows/electron-main/windows.js';
import { CodeWindow } from '../../../platform/windows/electron-main/windowImpl.js';

//#region The one member of CodeWindow (windowImpl.ts) this adoption needs beyond ICodeWindow.

/**
 * `CodeWindow.qlAdoptBrowserWindow` (public, windowImpl.ts): replaces the BrowserWindow every window call of the CodeWindow goes
 * through by the stand-in, then binds the CodeWindow's listeners, which the constructor bound to the shell's own (blank)
 * webContents, to the view's (`did-finish-load` sets the window's config, `render-process-gone` is the crash dialog).
 *
 * Called typed, never by a member's name through a cast: the packaged build's mangler renames every private and protected
 * member (`_win`, `registerListeners`), and only a typed access is renamed with it (build/qlhost/check-mangled-members.mjs).
 * Throws naming the class when the opened window is not a CodeWindow.
 */
function adoptBrowserWindow(codeWindow: ICodeWindow, standIn: BrowserWindow): void {
	if (!(codeWindow instanceof CodeWindow)) {
		throw new Error('QuantLab host (U5): the opened window is not a CodeWindow (windowImpl.ts), so it cannot be adopted');
	}

	codeWindow.qlAdoptBrowserWindow(standIn);
}

//#endregion

/**
 * The BrowserWindow the CodeWindow talks to after adoption: the hidden shell, but `webContents` and `loadURL` are the view's.
 * The shell must never be shown by stock code paths (`show`, `showInactive`, `focus`, `moveTop`, the 10 s "window did not
 * open" fallback that reads `isVisible`): the workbench is on screen in the view, and it is the host that shows it.
 */
function createStandIn(shell: BrowserWindow, view: WebContentsView): BrowserWindow {
	const webContents = view.webContents;

	return new Proxy(shell, {
		get(target, property) {
			switch (property) {
				case 'webContents':
					return webContents;
				case 'loadURL':
					return (...args: Parameters<WebContents['loadURL']>) => webContents.loadURL(...args);
				case 'show':
				case 'showInactive':
				case 'focus':
				case 'moveTop':
					return () => undefined;
				case 'isVisible':
					return () => true;
				case 'setBackgroundColor':
					// the theme's splash colour is the shell's, but the visible surface is the view
					return (color: string) => {
						target.setBackgroundColor(color);
						view.setBackgroundColor(color);
					};
			}

			const value = Reflect.get(target, property, target);

			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

export interface IAdoptedWorkbench {

	readonly codeWindow: ICodeWindow;

	/** The hidden stock BrowserWindow. */
	readonly shell: BrowserWindow;

	/** What `codeWindow.win` returns after adoption. */
	readonly standIn: BrowserWindow;

	readonly view: WebContentsView;
	readonly webContents: WebContents;

	/** A copy of the webPreferences the view was built from: the fork's own for a workbench window. */
	readonly webPreferences: WebPreferences;

	/** Fires once, when the CodeWindow closed or was destroyed (a crash the user answered). */
	readonly onDidGone: Event<void>;

	/** Resolves when the workbench signalled ready; rejects, by name, when the window or its renderer is lost before. */
	whenReady(): Promise<void>;

	/** Closes the view's webContents (not its window: the view is the host's to remove). */
	closeContents(): void;

	dispose(): void;
}

class AdoptedWorkbench extends Disposable implements IAdoptedWorkbench {

	private readonly _onDidGone = this._register(new Emitter<void>());
	readonly onDidGone = this._onDidGone.event;

	private gone = false;
	private firingGone = false;
	private disposeAfterGone = false;

	constructor(
		readonly codeWindow: ICodeWindow,
		readonly shell: BrowserWindow,
		readonly standIn: BrowserWindow,
		readonly view: WebContentsView,
		readonly webPreferences: WebPreferences
	) {
		super();

		this._register(registerQlAdoptedWindow(shell, standIn));

		// the CodeWindow listens for these on its window (the shell), but they are raised by the view's contents
		this._register(Event.fromNodeEventEmitter(this.webContents, 'unresponsive')(() => shell.emit('unresponsive')));
		this._register(Event.fromNodeEventEmitter(this.webContents, 'responsive')(() => shell.emit('responsive')));

		this._register(codeWindow.onDidClose(() => this.markGone()));
		this._register(codeWindow.onDidDestroy(() => this.markGone()));
	}

	get webContents(): WebContents {
		return this.view.webContents;
	}

	private markGone(): void {
		if (this.gone) {
			return;
		}

		this.gone = true;

		// A listener may dispose this object (the gate does, and it listens first). Disposing the emitter inside its own delivery
		// drops every listener after that one (`Emitter#dispose` resets the delivery queue): the quit handshake and `whenReady`
		// would never hear that the window is gone. So a disposal asked for during the delivery happens when the delivery ended.
		this.firingGone = true;
		try {
			this._onDidGone.fire();
		} finally {
			this.firingGone = false;
			if (this.disposeAfterGone) {
				super.dispose();
			}
		}
	}

	override dispose(): void {
		if (this.firingGone) {
			this.disposeAfterGone = true;

			return;
		}

		super.dispose();
	}

	whenReady(): Promise<void> {
		if (this.codeWindow.isReady) {
			return Promise.resolve();
		}
		if (this.gone) {
			return Promise.reject(new Error('QuantLab host (U5): the workbench window is gone'));
		}

		return new Promise<void>((resolve, reject) => {
			const disposables = new DisposableStore();
			const settle = (error?: Error) => {
				disposables.dispose();
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};

			disposables.add(this.codeWindow.onDidSignalReady(() => settle()));
			disposables.add(this.onDidGone(() => settle(new Error('QuantLab host (U5): the workbench window went away before it was ready'))));
			disposables.add(Event.fromNodeEventEmitter(this.webContents, 'render-process-gone', (_event: unknown, details: { reason: string }) => details)(details => settle(new Error(`QuantLab host (U5): the workbench renderer was lost before it was ready (${details.reason})`))));
			disposables.add(Event.fromNodeEventEmitter(this.webContents, 'did-fail-load', (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => ({ code, description, url, isMainFrame }))(failure => {
				const ERR_ABORTED = -3; // a load superseded by another navigation
				if (failure.isMainFrame && failure.code !== ERR_ABORTED) {
					settle(new Error(`QuantLab host (U5): the workbench document failed to load (${failure.code} ${failure.description}, ${failure.url})`));
				}
			}));
		});
	}

	closeContents(): void {
		if (!this.webContents.isDestroyed()) {
			this.webContents.close({ waitForBeforeUnload: false });
		}
	}
}

/**
 * Adopts `codeWindow`, which must have just been created (inside `onDidOpenWindow`, before its load). `webPreferences` are the
 * ones the stock window was created with, as the `windows.ts` seam recorded them; the view gets exactly those (nothing added,
 * nothing removed). Throws when the CodeWindow cannot be adopted; the caller owns the cleanup.
 */
export function adoptCodeWindow(codeWindow: ICodeWindow, webPreferences: WebPreferences): IAdoptedWorkbench {
	// PLANT (negative build host/neg-adopt-throws, never merged): every adoption fails, so the host's failure dialog shows
	if (Date.now() > 0) {
		throw new Error('QuantLab host PLANT: adopt throws (negative build, never for integ/ql)');
	}

	const shell = codeWindow.win;
	if (!shell) {
		throw new Error('QuantLab host (U5): the opened CodeWindow has no BrowserWindow');
	}

	const recorded = { ...webPreferences };
	const view = new WebContentsView({ webPreferences: recorded });
	const standIn = createStandIn(shell, view);

	try {
		adoptBrowserWindow(codeWindow, standIn);
	} catch (error) {
		if (!view.webContents.isDestroyed()) {
			view.webContents.close({ waitForBeforeUnload: false });
		}
		throw error;
	}

	return new AdoptedWorkbench(codeWindow, shell, standIn, view, { ...webPreferences });
}
