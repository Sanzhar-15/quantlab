/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistence slice: save-in-flight, last save status, last saved path.
 *
 * Save attribution: `pendingSpecHash` is set by `saveStarted` and cleared
 * by the matching `saveResult`. A `saveResult` whose specHash doesn't
 * match `pendingSpecHash` is silently dropped (Step B megaudit C8: a
 * stale save result must not corrupt persistence state).
 */

import type { Action } from './actions';

export interface PersistenceState {
	readonly saving: boolean;
	readonly pendingSpecHash: string | null;
	readonly lastStatus: 'idle' | 'ok' | 'failed';
	readonly lastFsPath: string | null;
	readonly lastError: string | null;
}

export const INITIAL_PERSISTENCE_STATE: PersistenceState = {
	saving: false,
	pendingSpecHash: null,
	lastStatus: 'idle',
	lastFsPath: null,
	lastError: null,
};

export function reducePersistence(
	state: PersistenceState, action: Action,
): PersistenceState {
	switch (action.type) {
		case 'init':
			if (state === INITIAL_PERSISTENCE_STATE) { return state; }
			return INITIAL_PERSISTENCE_STATE;
		case 'saveStarted':
			return {
				...state,
				saving: true,
				pendingSpecHash: action.specHash,
				lastError: null,
			};
		case 'saveResult': {
			// Drop stale results: only the result that matches the
			// pending save we sent advances state.
			if (state.pendingSpecHash !== action.specHash) {
				return state;
			}
			if (action.status === 'ok') {
				return {
					saving: false,
					pendingSpecHash: null,
					lastStatus: 'ok',
					lastFsPath: action.fsPath,
					lastError: null,
				};
			}
			return {
				saving: false,
				pendingSpecHash: null,
				lastStatus: 'failed',
				lastFsPath: state.lastFsPath,
				lastError: action.error,
			};
		}
		default:
			return state;
	}
}
