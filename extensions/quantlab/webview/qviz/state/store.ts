/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Root store for the qviz webview.
 *
 * Combines the eight slice reducers and exposes a tiny `getState /
 * dispatch / subscribe` API. Listeners are notified on every dispatch
 * when at least one slice changed (referential inequality on any
 * top-level slice triggers notify).
 *
 * Phase 5 step B.2 (audit-merged plan, post-megaudit-cycle-2).
 *
 * Subscribe-once invariant: listeners never receive an event during
 * their own subscription call (some redux ports do; ours doesn't).
 * Listeners ARE notified during a dispatch, in registration order.
 *
 * Listener errors PROPAGATE. The prior cycle wrapped each listener in a
 * try/catch with `console.error`, which violated CLAUDE.md "no fallbacks"
 * and silently absorbed renderer crashes. Listeners must be defensive
 * about their own bookkeeping; if one throws, the dispatch surfaces it.
 *
 * Reentrant dispatch is rejected with an Error; the listener that
 * triggered the nested call sees the rejection in its call frame.
 */

import type { Action } from './actions';
import {
	type SourceState, INITIAL_SOURCE_STATE, reduceSource,
} from './sourceState';
import {
	type SchemaState, INITIAL_SCHEMA_STATE, reduceSchema,
} from './schemaState';
import {
	type SpecState, INITIAL_SPEC_STATE, reduceSpec,
} from './specState';
import {
	type UiState, INITIAL_UI_STATE, reduceUi,
} from './uiState';
import {
	type QueryState, INITIAL_QUERY_STATE, reduceQuery,
} from './queryState';
import {
	type PersistenceState, INITIAL_PERSISTENCE_STATE, reducePersistence,
} from './persistenceState';
import {
	type RendererState, INITIAL_RENDERER_STATE, reduceRenderer,
} from './rendererState';
import {
	type RuntimeState, INITIAL_RUNTIME_STATE, reduceRuntime,
} from './runtimeState';
import {
	type InspectorState, INITIAL_INSPECTOR_STATE, reduceInspector,
} from './inspectorState';
import {
	type HistoryState, INITIAL_HISTORY_STATE,
	applyInspectorSnapshot, isUndoableUiAction, popRedo, popUndo,
	pushHistoryEntry, snapshotInspector,
} from './history';

export interface RootState {
	readonly source: SourceState;
	readonly schema: SchemaState;
	readonly spec: SpecState;
	readonly ui: UiState;
	readonly query: QueryState;
	readonly persistence: PersistenceState;
	readonly renderer: RendererState;
	readonly runtime: RuntimeState;
	readonly inspector: InspectorState;
	readonly history: HistoryState;
}

export const INITIAL_ROOT_STATE: RootState = {
	source: INITIAL_SOURCE_STATE,
	schema: INITIAL_SCHEMA_STATE,
	spec: INITIAL_SPEC_STATE,
	ui: INITIAL_UI_STATE,
	query: INITIAL_QUERY_STATE,
	persistence: INITIAL_PERSISTENCE_STATE,
	renderer: INITIAL_RENDERER_STATE,
	runtime: INITIAL_RUNTIME_STATE,
	inspector: INITIAL_INSPECTOR_STATE,
	history: INITIAL_HISTORY_STATE,
};

/** Pure root reducer. Each slice sees every action; most return state
 *  unchanged. The result is a fresh top-level object only if at least
 *  one slice changed (cheap dirty-check upstream).
 *
 *  Phase 8 Step B: history slice records PRE-action snapshots of
 *  inspector state on undoable actions (toggleInspector, setSelection,
 *  clearSelection) and handles undoUiHistory / redoUiHistory by
 *  applying recorded snapshots back onto the inspector slice.
 */
export function rootReduce(state: RootState, action: Action): RootState {
	// Phase 8 Step B: handle UI undo/redo by short-circuiting before the
	// per-slice reducers run. The applied snapshot only touches inspector
	// state; other slices stay unchanged.
	if (action.type === 'undoUiHistory') {
		const popped = popUndo(state.history, snapshotInspector(state.inspector));
		if (popped === null) { return state; }
		const inspector = applyInspectorSnapshot(state.inspector, popped.entry);
		if (inspector === state.inspector) {
			return { ...state, history: popped.next };
		}
		return { ...state, inspector, history: popped.next };
	}
	if (action.type === 'redoUiHistory') {
		const popped = popRedo(state.history, snapshotInspector(state.inspector));
		if (popped === null) { return state; }
		const inspector = applyInspectorSnapshot(state.inspector, popped.entry);
		if (inspector === state.inspector) {
			return { ...state, history: popped.next };
		}
		return { ...state, inspector, history: popped.next };
	}

	const source = reduceSource(state.source, action);
	const schema = reduceSchema(state.schema, action);
	const spec = reduceSpec(state.spec, action);
	const ui = reduceUi(state.ui, action);
	const query = reduceQuery(state.query, action);
	const persistence = reducePersistence(state.persistence, action);
	const renderer = reduceRenderer(state.renderer, action);
	const runtime = reduceRuntime(state.runtime, action);
	const inspector = reduceInspector(state.inspector, action);

	// Push a history entry if the action was an undoable UI action AND it
	// actually changed inspector state. Idempotent toggles don't pollute
	// the history stack.
	let history = state.history;
	if (isUndoableUiAction(action.type) && inspector !== state.inspector) {
		history = pushHistoryEntry(state.history, snapshotInspector(state.inspector));
	}

	if (
		source === state.source && schema === state.schema && spec === state.spec
		&& ui === state.ui && query === state.query
		&& persistence === state.persistence && renderer === state.renderer
		&& runtime === state.runtime && inspector === state.inspector
		&& history === state.history
	) {
		return state;
	}
	return {
		source, schema, spec, ui, query, persistence, renderer, runtime,
		inspector, history,
	};
}

export type Listener = (state: RootState) => void;
export type Unsubscribe = () => void;

export interface QvizStore {
	getState(): RootState;
	dispatch(action: Action): void;
	subscribe(listener: Listener): Unsubscribe;
}

/** Construct an in-memory store. */
export function createStore(initial: RootState = INITIAL_ROOT_STATE): QvizStore {
	let state = initial;
	const listeners: Listener[] = [];
	let dispatching = false;

	function getState(): RootState { return state; }

	function dispatch(action: Action): void {
		if (dispatching) {
			throw new Error('QvizStore: nested dispatch is not allowed');
		}
		dispatching = true;
		try {
			const next = rootReduce(state, action);
			if (next === state) { return; }
			state = next;
			// Snapshot the listeners so a listener that subscribes /
			// unsubscribes during notify doesn't see a moving array.
			// Listener exceptions propagate -- there is no try/catch
			// fallback. (CLAUDE.md: errors must be visible.)
			const snapshot = listeners.slice();
			for (const l of snapshot) {
				l(state);
			}
		} finally {
			dispatching = false;
		}
	}

	function subscribe(listener: Listener): Unsubscribe {
		listeners.push(listener);
		let detached = false;
		return () => {
			if (detached) { return; }
			detached = true;
			const idx = listeners.indexOf(listener);
			if (idx >= 0) { listeners.splice(idx, 1); }
		};
	}

	return { getState, dispatch, subscribe };
}
