/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (review c1 M6): the `will-quit` listener of `LifecycleMainService`, kept here without imports so that
// `build/qlhost/check-will-quit.mjs` can run it against a fake app.
//
// The stock listener was installed with `once`: it was gone as soon as it began waiting for the shutdown joiners, so a
// second quit (the host window's close, Cmd+Q again, a dock quit, an update restart) met no listener and the app exited
// under the pending joiners. This listener stays installed and prevents every quit until the joiners settled, then lets
// exactly one quit through.

/** The part of `electron.app` the guard uses. */
export interface IWillQuitApp {
	addListener(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
	removeListener(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
	quit(): void;
}

export interface IWillQuitGuardDeps {

	/** Starts the shutdown sequence and resolves (or rejects) when its joiners settled. Called once. */
	startShutdown(): Promise<void>;

	/** Runs after the joiners settled, right before the final quit (resolves the pending quit promise, removes listeners). */
	beforeFinalQuit(): void;

	trace(message: string): void;
}

export function installWillQuitGuard(app: IWillQuitApp, deps: IWillQuitGuardDeps): void {
	let state: 'idle' | 'shutting-down' | 'may-quit' = 'idle';

	const listener = (event: { preventDefault(): void }) => {
		if (state === 'may-quit') {
			deps.trace('Lifecycle#app.on(will-quit) - the final quit, after the shutdown joiners settled');
			app.removeListener('will-quit', listener);

			return;
		}

		// Prevent the quit until the shutdown promise was resolved, also for every further quit that arrives meanwhile
		event.preventDefault();

		if (state === 'shutting-down') {
			deps.trace('Lifecycle#app.on(will-quit) - a further quit while the shutdown joiners are pending: prevented');

			return;
		}

		deps.trace('Lifecycle#app.on(will-quit) - begin');
		state = 'shutting-down';

		// Start shutdown sequence; wait until shutdown is signaled to be complete
		deps.startShutdown().finally(() => {
			deps.trace('Lifecycle#app.on(will-quit) - after fireOnWillShutdown');
			deps.beforeFinalQuit();
			state = 'may-quit';

			deps.trace('Lifecycle#app.on(will-quit) - calling app.quit()');
			app.quit();
		});
	};

	app.addListener('will-quit', listener);
}
