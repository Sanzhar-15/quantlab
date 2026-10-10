/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (review c1 S3): the toggle key's transitions run one at a time, and each chooses its target when its turn
// comes, from the view then on screen. The toggle used to choose its target at the key's receipt, before awaiting the
// workbench's first use: two presses during that wait both chose the workbench, and the second press was lost. Now two
// presses end on the terminal (one workbench construction), three on the workbench.
// No imports, so `build/qlhost/check-toggle-sequencer.mjs` runs it.

export type ToggleView = 'terminal' | 'workbench';

export interface IToggleSequencer {

	/**
	 * Queues one toggle; resolves with the view it switched to once it ran. A failed transition rejects THIS call (its caller
	 * reports it) and the next queued toggle still runs, from the view then on screen.
	 */
	toggle(): Promise<ToggleView>;
}

export function createToggleSequencer(deps: {
	/** The view on screen now. */
	shown(): ToggleView;
	/** Switches to `to`; resolves when it is shown. */
	apply(to: ToggleView): Promise<void>;
	/** Called at a key's receipt while an earlier toggle is still running (the host log line `view-switch queued`). */
	queued(): void;
}): IToggleSequencer {
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;

	return {
		toggle() {
			if (pending > 0) {
				deps.queued();
			}
			pending += 1;

			const run = tail.then(async () => {
				const to: ToggleView = deps.shown() === 'terminal' ? 'workbench' : 'terminal';
				await deps.apply(to);

				return to;
			});

			// The order only: the rejection itself is returned to this call's caller below, never dropped.
			tail = run.then(() => undefined, () => undefined);
			tail.then(() => { pending -= 1; });

			return run;
		}
	};
}
