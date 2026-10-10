/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5, review c1 M4): the BrowserWindow an adopted CodeWindow talks to. Type imports only, so
// build/qlhost/check-stand-in.mjs transpiles and runs this file against fakes.
//
// Three windows are involved: the hidden stock BrowserWindow (the "shell": the CodeWindow's lifecycle carrier, closed and
// destroyed by the stock quit and close paths), the workbench view (a WebContentsView: its renderer is the workbench), and the
// host's visible BaseWindow (the one native window on screen). The stand-in routes each call to the one that owns it, and
// every function member is in exactly one class (review c2 M4: nothing reaches the shell by default):
//  - `webContents` and `loadURL`: the view's;
//  - the visible operations, state queries and visible-state listeners (`QL_VISIBLE_OPERATIONS`, `QL_VISIBLE_EVENTS`): the host window.
//    A stock maximize, minimize, restore, fullscreen, position, resize or always-on-top changes what the user sees, and every
//    query (`isMaximized`, `getBounds`, `getSize`, `isAlwaysOnTop`, `getTitle`, the native handle) describes it: a read and its
//    write never go to different windows (before c1 M4 all of them reached the hidden shell; before c2 M4 `setBounds`, `setSize`,
//    `setAlwaysOnTop` and `isAlwaysOnTop` still did, beside a `getBounds` that read the host);
//  - `focus`: the host surfaces the workbench view and focuses its window (before c1 M4 it was dropped);
//  - `show`, `showInactive`, `moveTop`: nothing (the host shows the workbench once it is ready); `isVisible`: true;
//  - the stock writes of window chrome (`QL_HOST_CHROME_WRITES`: title, represented file, edited mark, title-bar overlay and
//    buttons, menu bar, touch bar, accent colour, native tabs) and the `autoHideMenuBar` assignment: nothing. The host owns its
//    window's chrome (the chrome policy pins a native title bar); on the hidden shell these writes never had a visible effect;
//  - the lifecycle carrier's members (`QL_SHELL_MEMBERS`: close, destroy, isDestroyed, the emitter's own bookkeeping) and every
//    non-function property (`id`): the shell;
//  - any other function member: a function that throws when called, naming the member. A stock call this file has not
//    classified fails where it is made instead of acting on a window nobody sees (build/qlhost/check-stand-in.mjs row 11
//    holds every member the stock main-process sources call on a window's `win` against these classes).
// The stock listeners the CodeWindow bound to the shell itself at construction (`setWin`: maximize, unmaximize, focus,
// enter/leave-full-screen, always-on-top-changed) are fed by `forwardQlVisibleEvents`, which re-emits the host window's events
// on the shell.

import type { BaseWindow, BrowserWindow, WebContents } from 'electron';

/** What the host provides for the visible side of an adopted workbench. */
export interface IQlVisibleTarget {

	/** The host's visible window. */
	readonly window: BaseWindow;

	/** A stock `focus` of the workbench window: show the workbench view and focus the host window. */
	focusWorkbench(): void;
}

/** BrowserWindow members that act on, or report, the window the user sees. */
export const QL_VISIBLE_OPERATIONS: ReadonlySet<string> = new Set([
	'maximize', 'unmaximize', 'isMaximized',
	'minimize', 'restore', 'isMinimized', 'isNormal',
	'setFullScreen', 'isFullScreen', 'setSimpleFullScreen', 'isSimpleFullScreen',
	'setMinimumSize', 'getMinimumSize',
	'setBounds', 'getBounds', 'setSize', 'getSize', 'setPosition', 'getPosition', 'center',
	'setContentBounds', 'getContentBounds', 'setContentSize', 'getContentSize', 'getNormalBounds',
	'setAlwaysOnTop', 'isAlwaysOnTop', 'flashFrame',
	'isFocused',
	'getNativeWindowHandle', 'getTitle', 'getRepresentedFilename', 'isDocumentEdited'
]);

/** Visible-state events of the host window that the CodeWindow listens for on its window. */
export const QL_VISIBLE_EVENTS: ReadonlyArray<string> = ['maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'always-on-top-changed'];

/** Stock writes of window chrome. The host owns its window's chrome: these do nothing (they never reach the hidden shell either). */
export const QL_HOST_CHROME_WRITES: ReadonlySet<string> = new Set([
	'setTitle', 'setRepresentedFilename', 'setDocumentEdited',
	'setSheetOffset', 'setTitleBarOverlay', 'setWindowButtonPosition', 'setWindowButtonVisibility',
	'setMenuBarVisibility', 'setAutoHideMenuBar', 'setMenu', 'removeMenu',
	'setTouchBar', 'setAccentColor', 'addTabbedWindow'
]);

/** Chrome properties the stock code assigns (`win.autoHideMenuBar = ...`): the assignment does nothing, for the same reason. */
export const QL_HOST_CHROME_PROPERTIES: ReadonlySet<string> = new Set(['autoHideMenuBar']);

/** Function members that stay on the hidden shell: it is the CodeWindow's lifecycle carrier and an event emitter. */
export const QL_SHELL_MEMBERS: ReadonlySet<string> = new Set([
	'close', 'destroy', 'isDestroyed',
	'emit', 'listeners', 'listenerCount', 'eventNames'
]);

/** Members the stand-in answers itself (the `switch` in `createQlStandIn`). */
export const QL_STAND_IN_MEMBERS: ReadonlySet<string> = new Set(['loadURL', 'focus', 'show', 'showInactive', 'moveTop', 'isVisible', 'setBackgroundColor']);

/** Emitter methods taking (event, listener): routed by the event's owner. */
export const QL_LISTENER_METHODS: ReadonlySet<string> = new Set(['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener']);

export function createQlStandIn(shell: BrowserWindow, webContents: WebContents, setViewBackground: (color: string) => void, visible: IQlVisibleTarget): BrowserWindow {
	const host = visible.window;
	const visibleEvents = new Set(QL_VISIBLE_EVENTS);

	return new Proxy(shell, {
		get(target, property, receiver) {
			switch (property) {
				case 'webContents':
					return webContents;
				case 'loadURL':
					return (...args: Parameters<WebContents['loadURL']>) => webContents.loadURL(...args);
				case 'focus':
					return () => visible.focusWorkbench();
				case 'show':
				case 'showInactive':
				case 'moveTop':
					return () => undefined;
				case 'isVisible':
					return () => true;
				case 'setBackgroundColor':
					// the theme's splash colour is the shell's, but the visible surface is the view
					return (color: string) => {
						target.setBackgroundColor(color);
						setViewBackground(color);
					};
			}

			if (typeof property === 'string' && QL_VISIBLE_OPERATIONS.has(property)) {
				const operation = Reflect.get(host, property, host);
				if (typeof operation !== 'function') {
					throw new Error(`QuantLab host (c1 M4): the host window has no ${property}()`);
				}

				return operation.bind(host);
			}

			if (typeof property === 'string' && QL_LISTENER_METHODS.has(property)) {
				// a listener for a visible-state event added through the stand-in is the host window's (and so is its removal)
				return (event: string | symbol, listener: (...args: unknown[]) => void) => {
					const owner = typeof event === 'string' && visibleEvents.has(event) ? host : target;
					Reflect.get(owner, property, owner).call(owner, event, listener);

					return receiver;
				};
			}

			if (typeof property === 'string' && QL_HOST_CHROME_WRITES.has(property)) {
				return () => undefined;
			}

			const value = Reflect.get(target, property, target);
			if (typeof value !== 'function' || typeof property !== 'string' || property === 'constructor') {
				return value;
			}

			if (QL_SHELL_MEMBERS.has(property)) {
				return value.bind(target);
			}

			// not classified: it must not act on the hidden shell unnoticed (c2 M4). Reading the member is harmless; calling it throws.
			return () => {
				throw new Error(`QuantLab host (c2 M4): BrowserWindow.${property}() is not classified for the adopted workbench window (qlHost/standIn.ts): it would act on the hidden shell`);
			};
		},
		set(_target, property) {
			if (typeof property === 'string' && QL_HOST_CHROME_PROPERTIES.has(property)) {
				return true;
			}

			throw new Error(`QuantLab host (c2 M4): assigning BrowserWindow.${String(property)} is not classified for the adopted workbench window (qlHost/standIn.ts): it would act on the hidden shell`);
		}
	});
}

/**
 * Re-emits the host window's visible-state events on the shell, where the CodeWindow bound its own listeners at construction.
 * The shell never raises them itself after adoption: every visible operation goes to the host window. Returns the removal.
 */
export function forwardQlVisibleEvents(host: BaseWindow, shell: BrowserWindow): () => void {
	const removals = QL_VISIBLE_EVENTS.map(event => {
		const forward = (...args: unknown[]) => shell.emit(event, ...args);
		host.on(event as 'maximize', forward);

		return () => host.removeListener(event as 'maximize', forward);
	});

	return () => removals.forEach(remove => remove());
}
