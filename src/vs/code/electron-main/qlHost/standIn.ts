/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5, review c1 M4): the BrowserWindow an adopted CodeWindow talks to. Type imports only, so
// build/qlhost/check-stand-in.mjs transpiles and runs this file against fakes.
//
// Three windows are involved: the hidden stock BrowserWindow (the "shell": the CodeWindow's lifecycle carrier, closed and
// destroyed by the stock quit and close paths), the workbench view (a WebContentsView: its renderer is the workbench), and the
// host's visible BaseWindow (the one native window on screen). The stand-in routes each call to the one that owns it:
//  - `webContents` and `loadURL`: the view's;
//  - the visible operations, state queries and visible-state listeners (`QL_VISIBLE_OPERATIONS`, `QL_VISIBLE_EVENTS`): the host window,
//    so a stock maximize, minimize, restore or fullscreen changes what the user sees, and `isMaximized`/`isFullScreen`/`getBounds`
//    describe it (before c1 M4 they reached the hidden shell);
//  - `focus`: the host surfaces the workbench view and focuses its window (before c1 M4 it was dropped);
//  - `show`, `showInactive`, `moveTop`: nothing (the host shows the workbench once it is ready); `isVisible`: true;
//  - everything else (close, destroy, isDestroyed, id, setBounds, the lifecycle events): the shell.
// The stock listeners the CodeWindow bound to the shell itself at construction (`setWin`: maximize, unmaximize, focus,
// enter/leave-full-screen) are fed by `forwardQlVisibleEvents`, which re-emits the host window's events on the shell.

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
	'getBounds', 'getSize', 'getPosition', 'getContentBounds', 'getContentSize', 'getNormalBounds',
	'isFocused'
]);

/** Visible-state events of the host window that the CodeWindow listens for on its window. */
export const QL_VISIBLE_EVENTS: ReadonlyArray<string> = ['maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'];

const LISTENER_METHODS: ReadonlySet<string> = new Set(['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener']);

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

			if (typeof property === 'string' && LISTENER_METHODS.has(property)) {
				// a listener for a visible-state event added through the stand-in is the host window's (and so is its removal)
				return (event: string | symbol, listener: (...args: unknown[]) => void) => {
					const owner = typeof event === 'string' && visibleEvents.has(event) ? host : target;
					Reflect.get(owner, property, owner).call(owner, event, listener);

					return receiver;
				};
			}

			const value = Reflect.get(target, property, target);

			return typeof value === 'function' ? value.bind(target) : value;
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
