/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema slice: column list + drift state.
 *
 * - `info` is the schema reported by the daemon (columns, types, hash).
 *   Populated by `init` when available, refreshed by `schemaChanged`.
 * - `drift` records whether the on-disk schema diverges from what the
 *   spec was last saved against (Step 5.C handles the three branches).
 * - `missingFields` is the list of fields the spec references but the
 *   file no longer has (only set when `drift === 'fields-missing'`).
 *
 * Reset semantics: `init` is the canonical "open" action that re-seeds
 * `info` from the spec file's accompanying schema. An `init` without
 * `schema` clears the slice (no schema known yet; provider will send
 * a follow-up `schemaChanged` once detection completes).
 *
 * `schemaChanged` ALWAYS updates `info` from the message's `newSchema`.
 * This is the canonical "deliver the live schema" event — the webview
 * keeps the user's in-memory spec edits while reflecting the on-disk
 * columns. The protocol validator's cross-field invariant guarantees
 * `newSchema.schema_hash === newHash`, so `info` is consistent with
 * `drift` after the reducer runs.
 *
 * Defensive cloning (Step C megaudit C10): the protocol's freezeResult
 * deep-freezes validated messages, but to be insulated even from a
 * future change in that policy, the reducer takes its OWN deep clone
 * of `newSchema` before storing. Inconsistent insulation across slices
 * (spec slice deep-clones, schema slice doesn't) was the gap the audit
 * caught.
 */

import type { SchemaInfo, SchemaDriftKind } from '../../../src/qviz/messageProtocol';
import type { Action } from './actions';

export interface SchemaState {
	readonly info: SchemaInfo | null;
	readonly drift: SchemaDriftKind | null;
	readonly missingFields: readonly string[];
}

export const INITIAL_SCHEMA_STATE: SchemaState = {
	info: null,
	drift: null,
	missingFields: [],
};

export function reduceSchema(state: SchemaState, action: Action): SchemaState {
	switch (action.type) {
		case 'init':
			if (action.schema === undefined) {
				// Re-init without schema: clear stale schema state.
				if (state === INITIAL_SCHEMA_STATE) { return state; }
				return INITIAL_SCHEMA_STATE;
			}
			return {
				info: deepCloneFreeze(action.schema),
				drift: 'same-hash',
				missingFields: [],
			};
		case 'schemaChanged':
			// Always update `info` from the message's newSchema. The
			// webview keeps the user's in-memory spec edits but reflects
			// the on-disk columns in the column panel.
			return {
				info: deepCloneFreeze(action.newSchema),
				drift: action.drift,
				missingFields: action.missingFields !== undefined
					? Object.freeze([...action.missingFields])
					: [],
			};
		default:
			return state;
	}
}

/** JSON deep-clone + deep-freeze. Both: clone insulates state from
 *  external mutations of the action payload; freeze prevents accidental
 *  mutation of the slice's own copy. SchemaInfo is JSON-shaped by
 *  construction (the validator gates the message). */
function deepCloneFreeze<T>(value: T): T {
	const cloned = JSON.parse(JSON.stringify(value)) as T;
	deepFreeze(cloned);
	return cloned;
}

function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== 'object') { return; }
	if (Object.isFrozen(value)) { return; }
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) { deepFreeze(item); }
		return;
	}
	for (const key of Object.keys(value)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
}
