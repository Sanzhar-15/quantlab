/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (F-HOST-NODEBUG-1, MF1 of review c1; owner R-228 / R-225 (A)): a PRODUCT build opens no DevTools. DevTools in a
// signed-in renderer read its tokens and page state as a debugger does, so they are the same class as the startup debugger
// routes refused in qlHost/node/debuggerPolicy.ts.
//   - Every window the fork creates through defaultBrowserWindowOptions (CodeWindows, their child windows, auxiliary windows)
//     is created with `webPreferences.devTools` = devToolsAllowed(); an adopted workbench view is built from those same recorded
//     webPreferences (qlHost/adopt.ts), so it inherits the value.
//   - Each route that would open them is refused by name where it is taken: the `--open-devtools` startup option (windowImpl.ts),
//     the `vscode:openDevTools` / `vscode:toggleDevTools` IPC (app.ts), and the native host's openDevTools / toggleDevTools /
//     openDevToolsWindow (nativeHostMainService.ts), which the workbench's Toggle Developer Tools action calls, and the two
//     extension-host debug requests that would open the renderer CDP bridge (extensionHostDebugIpc.ts; review c2).
// A TEST build (QL_TEST_BUILD=1) and an un-bundled source run keep DevTools: the test instruments and development use them.

/** A route by which a renderer's DevTools are opened. */
export type DevToolsRoute =
	| '--open-devtools (command line)'
	| 'vscode:openDevTools (IPC)'
	| 'vscode:toggleDevTools (IPC)'
	| 'openDevTools (native host)'
	| 'toggleDevTools (native host: the Toggle Developer Tools action)'
	| 'openDevToolsWindow (native host)'
	| 'attachToCurrentWindowRenderer (extension host debug IPC)'
	| 'openExtensionDevelopmentHostWindow debugRenderer (extension host debug IPC)';

/**
 * False in a PRODUCT bundle, where the esbuild define (build/lib/optimize.ts) makes `globalThis.QL_TEST_BUILD` the constant
 * `false`; true in a TEST bundle and in an un-bundled source run (undefined).
 */
export function devToolsAllowed(): boolean {
	return globalThis.QL_TEST_BUILD !== false;
}

/** The line a refused route writes to stderr. */
export function devToolsRefusalLine(route: DevToolsRoute): string {
	return `QuantLab: refused DevTools via ${route}: a product build opens no DevTools (F-HOST-NODEBUG-1)`;
}

/**
 * Returns true when `route` may open DevTools. In a PRODUCT bundle it writes the route's refusal line and returns false; the
 * caller then does nothing (the app continues).
 */
export function allowDevToolsRoute(route: DevToolsRoute, write: (line: string) => void): boolean {
	if (devToolsAllowed()) {
		return true;
	}
	write(devToolsRefusalLine(route));
	return false;
}
