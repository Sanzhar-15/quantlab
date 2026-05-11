/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Query slice: in-flight aggregate request, last successful result,
 * last error.
 *
 * Stale-result attribution (Codex audit critique #4): when `dataReceived`
 * arrives, the reducer compares `requestId + specHash` against the
 * `inflight` slot. Mismatched messages are silently dropped (reducer
 * returns state unchanged) -- the UI thus sees only fresh results and
 * stale chart updates can't surprise the user.
 *
 * Errors are spec-attributed too (Step B megaudit B6): `errorReceived`
 * also gates on `requestId + specHash` so a stale error doesn't
 * surface against a newer in-flight request.
 *
 * `requestStarted` clears the prior error so the UI doesn't show
 * "previous error: ..." overlaid on a fresh "loading" state (Step B
 * megaudit E5).
 *
 * `lastSuccessfulSpecHash` lets the UI display "last successful render
 * from previous spec" stripe when the in-flight request is older than
 * the last successful one.
 *
 * Arrow byte safety: `lastData.arrow` stores a defensive copy of the
 * inbound `Uint8Array`. Without the copy, a sender (or the message
 * channel) could mutate the bytes in place after the dispatch (Step B
 * megaudit B12). The renderer reads the slice's `arrow` directly.
 */

import type { Action } from './actions';

export interface QueryState {
	readonly inflight: { readonly requestId: number; readonly specHash: string } | null;
	readonly lastSuccessfulSpecHash: string | null;
	readonly lastErrorRequestId: number | null;
	readonly lastErrorMessage: string | null;
	readonly lastErrorKind:
		| 'compile' | 'security' | 'timeout' | 'memory' | 'internal' | 'protocol' | null;
	readonly lastErrorTransformIndex: number | null;
	/** The most recent successful payload; the renderer reads this. */
	readonly lastData: {
		readonly requestId: number;
		readonly specHash: string;
		readonly arrow: Uint8Array;
		readonly elapsedMs: number;
		readonly cached: boolean;
		readonly diagnostics: readonly string[];
	} | null;
}

export const INITIAL_QUERY_STATE: QueryState = {
	inflight: null,
	lastSuccessfulSpecHash: null,
	lastErrorRequestId: null,
	lastErrorMessage: null,
	lastErrorKind: null,
	lastErrorTransformIndex: null,
	lastData: null,
};

export function reduceQuery(state: QueryState, action: Action): QueryState {
	switch (action.type) {
		case 'init':
			// Re-init resets all query state; previous results no longer
			// attribute to the freshly-loaded spec.
			if (state === INITIAL_QUERY_STATE) { return state; }
			return INITIAL_QUERY_STATE;
		case 'requestStarted':
			return {
				...state,
				inflight: { requestId: action.requestId, specHash: action.specHash },
				// Clear prior error so loading UI is unambiguous.
				lastErrorRequestId: null,
				lastErrorMessage: null,
				lastErrorKind: null,
				lastErrorTransformIndex: null,
			};
		case 'dataReceived': {
			// Stale-attribution gate: drop responses whose specHash doesn't
			// match the latest in-flight slot.
			if (
				state.inflight === null
				|| state.inflight.requestId !== action.requestId
				|| state.inflight.specHash !== action.specHash
			) {
				return state;
			}
			// Defensive copy of the arrow bytes so the renderer's view of
			// state can't be mutated by the sender.
			const arrowCopy = new Uint8Array(action.arrow.length);
			arrowCopy.set(action.arrow);
			const diagnostics = Object.freeze(action.diagnostics.slice()) as readonly string[];
			return {
				...state,
				inflight: null,
				lastSuccessfulSpecHash: action.specHash,
				lastData: Object.freeze({
					requestId: action.requestId,
					specHash: action.specHash,
					arrow: arrowCopy,
					elapsedMs: action.elapsedMs,
					cached: action.cached,
					diagnostics,
				}),
				lastErrorRequestId: null,
				lastErrorMessage: null,
				lastErrorKind: null,
				lastErrorTransformIndex: null,
			};
		}
		case 'errorReceived': {
			// Stale-attribution gate (same as dataReceived): require both
			// requestId AND specHash to match.
			if (
				state.inflight === null
				|| state.inflight.requestId !== action.requestId
				|| state.inflight.specHash !== action.specHash
			) {
				return state;
			}
			return {
				...state,
				inflight: null,
				lastErrorRequestId: action.requestId,
				lastErrorMessage: action.error,
				lastErrorKind: action.errorKind,
				lastErrorTransformIndex: action.transformIndex ?? null,
			};
		}
		case 'localErrorReceived': {
			// Megaudit residual: webview-local errors (extract / render
			// failure that fired AFTER `dataReceived` cleared inflight)
			// don't have an in-flight slot to attribute against. The
			// specHash gate still applies — only attribute when the
			// error matches the LAST SUCCESSFUL render's spec, so a
			// stale post-render error from a superseded spec doesn't
			// clobber diagnostics for the current spec.
			if (
				state.lastSuccessfulSpecHash === null
				|| state.lastSuccessfulSpecHash !== action.specHash
			) {
				return state;
			}
			return {
				...state,
				lastErrorRequestId: state.lastErrorRequestId,  // unchanged
				lastErrorMessage: action.error,
				lastErrorKind: action.errorKind,
				lastErrorTransformIndex: null,
			};
		}
		default:
			return state;
	}
}

/** True when the in-flight requestId predates the last successful one
 *  -- i.e., the chart on screen is "older" than what's currently being
 *  computed. The UI stripe says "still computing latest..." */
export function hasStaleChart(state: QueryState): boolean {
	return state.inflight !== null
		&& state.lastSuccessfulSpecHash !== null
		&& state.lastSuccessfulSpecHash !== state.inflight.specHash;
}
