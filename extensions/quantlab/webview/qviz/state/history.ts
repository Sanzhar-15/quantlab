/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * History slice — Phase 8 Step B.
 *
 * Records snapshots of UI-state (inspector toggle, selection) so Ctrl+Z
 * / Ctrl+Y can reverse those changes. The slice is updated by
 * `rootReduce` BEFORE it propagates the action to other reducers, so
 * `past` records the PRE-action snapshot of the inspector slice.
 *
 * Spec edits remain on VS Code's native CustomDocument undo stack; the
 * webview's Ctrl+Z handler checks `state.history.past.length === 0` and
 * lets the keystroke bubble to VS Code in that case, so spec undo Just
 * Works through the existing EditEvent → onDidChangeCustomDocument
 * machinery.
 *
 * Cap: 100 past entries, 100 future entries. Pushing past the cap
 * drops the oldest entry. Redo stack clears on every fresh undoable
 * action (standard undo/redo semantics).
 */

import type { InspectorState } from './inspectorState';

/** Snapshot of the subset of UiState/InspectorState that participates
 *  in undo/redo. Kept narrow: a full root-state snapshot would be
 *  expensive and would conflict with spec edits VS Code already owns.
 */
export interface UiHistoryEntry {
	readonly inspectorVisible: boolean;
	readonly inspectorSelection: InspectorState['selection'];
}

export interface HistoryState {
	readonly past: readonly UiHistoryEntry[];
	readonly future: readonly UiHistoryEntry[];
}

export const INITIAL_HISTORY_STATE: HistoryState = {
	past: [],
	future: [],
};

/** Hard cap on each stack so a long session can't grow memory. */
export const HISTORY_CAP = 100;

/** Build a snapshot from the inspector slice. */
export function snapshotInspector(inspector: InspectorState): UiHistoryEntry {
	return {
		inspectorVisible: inspector.visible,
		inspectorSelection: inspector.selection,
	};
}

/** Apply a snapshot back onto an InspectorState, preserving everything
 *  else (filters, scroll, schemaHash, etc). */
export function applyInspectorSnapshot(
	inspector: InspectorState, snapshot: UiHistoryEntry,
): InspectorState {
	if (
		inspector.visible === snapshot.inspectorVisible
		&& inspector.selection === snapshot.inspectorSelection
	) {
		return inspector;
	}
	return {
		...inspector,
		visible: snapshot.inspectorVisible,
		selection: snapshot.inspectorSelection,
	};
}

/** Which action types are undoable via the UI history stack. Other
 *  actions (spec edits, transform changes, etc.) ride VS Code's native
 *  undo stack instead. */
export function isUndoableUiAction(actionType: string): boolean {
	return actionType === 'toggleInspector'
		|| actionType === 'setSelection'
		|| actionType === 'clearSelection';
}

/** Push a fresh PRE-action snapshot onto the past stack, capping at
 *  HISTORY_CAP, and clear the future stack (new edit invalidates redo). */
export function pushHistoryEntry(
	state: HistoryState, entry: UiHistoryEntry,
): HistoryState {
	const past = state.past.length >= HISTORY_CAP
		? [...state.past.slice(1), entry]
		: [...state.past, entry];
	return { past, future: [] };
}

/** Pop the most recent past entry, push the CURRENT snapshot to the
 *  future stack, and return both the popped entry (caller applies it
 *  to inspector slice) and the new history state. Returns null when
 *  past is empty. */
export function popUndo(
	state: HistoryState, currentSnapshot: UiHistoryEntry,
): { entry: UiHistoryEntry; next: HistoryState } | null {
	if (state.past.length === 0) { return null; }
	const entry = state.past[state.past.length - 1];
	const past = state.past.slice(0, -1);
	const future = state.future.length >= HISTORY_CAP
		? [currentSnapshot, ...state.future.slice(0, HISTORY_CAP - 1)]
		: [currentSnapshot, ...state.future];
	return { entry, next: { past, future } };
}

/** Pop the most recent future entry, push the CURRENT snapshot to the
 *  past stack, and return both. Returns null when future is empty. */
export function popRedo(
	state: HistoryState, currentSnapshot: UiHistoryEntry,
): { entry: UiHistoryEntry; next: HistoryState } | null {
	if (state.future.length === 0) { return null; }
	const entry = state.future[0];
	const future = state.future.slice(1);
	const past = state.past.length >= HISTORY_CAP
		? [...state.past.slice(1), currentSnapshot]
		: [...state.past, currentSnapshot];
	return { entry, next: { past, future } };
}
