/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime slice: daemon lifecycle status + capabilities snapshot.
 *
 * Consumes the actions emitted by the provider's daemon-lifecycle bridge
 * (`daemonStatus`) and the daemon's own capabilities handshake
 * (`capabilitiesUpdated`, also passed in via `init.capabilities`).
 *
 * Phase 5 step B.2 audit-fix C11: the prior session shipped these
 * actions in the union but had no reducer to consume them, so Step B.3
 * lifecycle events black-holed when dispatched. The new slice anchors
 * them so UI elements (status banner, transform menu) can subscribe
 * to a single source of truth.
 */

import type {
	DaemonCapabilities, DaemonStatusKind, DatasetStatusKind,
} from '../../../src/qviz/messageProtocol';
import type { Action } from './actions';

export interface RuntimeState {
	readonly daemonStatus: DaemonStatusKind;
	readonly daemonRetryInMs: number | null;
	readonly daemonLastError: string | null;
	readonly capabilities: DaemonCapabilities | null;
	/** Step 5.I.3: dataset-availability status, distinct from daemon
	 *  status. `ok` means the spec's dataset path resolves to a
	 *  readable file. */
	readonly datasetStatus: DatasetStatusKind;
	readonly datasetUri: string | null;
	readonly datasetError: string | null;
}

export const INITIAL_RUNTIME_STATE: RuntimeState = {
	daemonStatus: 'idle',
	daemonRetryInMs: null,
	daemonLastError: null,
	capabilities: null,
	datasetStatus: 'ok',
	datasetUri: null,
	datasetError: null,
};

export function reduceRuntime(state: RuntimeState, action: Action): RuntimeState {
	switch (action.type) {
		case 'init': {
			// Megaudit MAJOR-25: the store is per-webview (per panel),
			// not global. On `init` for a new document, daemon and
			// dataset status from the previous document MUST reset to
			// defaults -- the provider re-emits the current values
			// immediately via the post-init message stream.
			//
			// Audit M-25 (2026-05-11): capabilities ALSO reset to the
			// init's payload (or null if absent). The prior code
			// preserved the stale capabilities bag when init lacked
			// one, which left an old inspector capability claim alive
			// after a daemon respawn-without-capability flow. The
			// provider re-fetches caps on first request, so null is
			// the correct interim state.
			const reset: RuntimeState = {
				daemonStatus: 'idle',
				daemonRetryInMs: null,
				daemonLastError: null,
				capabilities: action.capabilities ?? null,
				datasetStatus: 'ok',
				datasetUri: null,
				datasetError: null,
			};
			// Identity-preserve when nothing actually changed.
			if (
				state.daemonStatus === 'idle'
				&& state.daemonRetryInMs === null
				&& state.daemonLastError === null
				&& state.datasetStatus === 'ok'
				&& state.datasetUri === null
				&& state.datasetError === null
				&& sameCapabilities(state.capabilities, reset.capabilities)
			) {
				return state;
			}
			return reset;
		}
		case 'daemonStatus': {
			const retry = action.retryInMs ?? null;
			const err = action.lastError ?? null;
			if (
				state.daemonStatus === action.status
				&& state.daemonRetryInMs === retry
				&& state.daemonLastError === err
			) {
				return state;
			}
			return {
				...state,
				daemonStatus: action.status,
				daemonRetryInMs: retry,
				daemonLastError: err,
			};
		}
		case 'capabilitiesUpdated': {
			if (sameCapabilities(state.capabilities, action.capabilities)) { return state; }
			return { ...state, capabilities: action.capabilities };
		}
		case 'datasetStatus': {
			const error = action.error ?? null;
			if (
				state.datasetStatus === action.status
				&& state.datasetUri === action.datasetUri
				&& state.datasetError === error
			) { return state; }
			return {
				...state,
				datasetStatus: action.status,
				datasetUri: action.datasetUri,
				datasetError: error,
			};
		}
		default:
			return state;
	}
}

function sameCapabilities(
	a: DaemonCapabilities | null, b: DaemonCapabilities | null,
): boolean {
	if (a === b) { return true; }
	if (a === null || b === null) { return false; }
	if (a.daemonVersion !== b.daemonVersion) { return false; }
	if (a.transformKinds.length !== b.transformKinds.length) { return false; }
	for (let i = 0; i < a.transformKinds.length; i++) {
		if (a.transformKinds[i] !== b.transformKinds[i]) { return false; }
	}
	if (a.chartFamilies.length !== b.chartFamilies.length) { return false; }
	for (let i = 0; i < a.chartFamilies.length; i++) {
		if (a.chartFamilies[i] !== b.chartFamilies[i]) { return false; }
	}
	// Audit M-24 (2026-05-11): without this branch, a `capabilitiesUpdated`
	// action whose inspector bag flipped was reduced to a no-op (the
	// other fields stayed equal). That left the webview's inspector
	// capability gate stale after a daemon respawn-with-downgrade.
	const ai = a.inspector;
	const bi = b.inspector;
	if (ai === bi) {
		// Megaudit MEDIUM (Opus + Codex, 2026-05-14): also compare
		// the Front 2 `transformAttributionV1` flag here. A daemon
		// respawn that flips ONLY this bit would otherwise be reduced
		// as a no-op, leaving stale runtime state. Mirrors the
		// inspector-bag pattern; same audit-rationale as M-24 from
		// 2026-05-11.
		if (a.transformAttributionV1 !== b.transformAttributionV1) { return false; }
		return true;
	}
	if (ai === undefined || bi === undefined) { return false; }
	if (ai.previewOffset !== bi.previewOffset) { return false; }
	if (ai.columnStats !== bi.columnStats) { return false; }
	if (ai.aggregateFilters !== bi.aggregateFilters) { return false; }
	// Megaudit MEDIUM (Opus + Codex, 2026-05-14): see above. Same
	// comparison, applied after the inspector-bag branch so neither
	// path can skip it.
	if (a.transformAttributionV1 !== b.transformAttributionV1) { return false; }
	return true;
}
