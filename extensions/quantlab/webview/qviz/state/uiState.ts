/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UI slice: ephemeral focus and "which thing is open" state.
 *
 * Cleanly separated from `spec` so reducer-driven UI state doesn't
 * dirty-flag the document just because the user clicked.
 *
 * Transform editor index handling (Step B megaudit E1/E3):
 * `editingTransformIndex` references a position in the spec.transforms
 * array. When the array shifts (delete, move), the index has to shift
 * with it or the editor renders for the wrong/missing transform.
 *   - delete at index N:
 *       - if editingIndex === N → close editor (target gone).
 *       - if editingIndex >  N → editingIndex - 1 (it shifted left).
 *   - move from F to T:
 *       - if editingIndex === F → editingIndex = T (the user is moving
 *         the very transform they're editing).
 *       - else: re-derive by simulating the splice on a sentinel.
 */

import type { Action } from './actions';

export interface UiState {
	readonly focusedColumn: string | null;
	readonly activeShelf:
	| 'x' | 'y' | 'y2' | 'color' | 'size' | 'shape'
	| 'facet_row' | 'facet_col' | null;
	readonly editingTransformIndex: number | null;
	readonly themeTokensVersion: number;
}

export const INITIAL_UI_STATE: UiState = {
	focusedColumn: null,
	activeShelf: null,
	editingTransformIndex: null,
	themeTokensVersion: 0,
};

export function reduceUi(state: UiState, action: Action): UiState {
	switch (action.type) {
		case 'init':
			// Re-init resets ephemeral UI focus. The themeTokens version
			// is preserved so a re-init doesn't trigger a spurious renderer
			// re-theme.
			if (
				state.focusedColumn === null
				&& state.activeShelf === null
				&& state.editingTransformIndex === null
			) {
				return state;
			}
			return {
				...state,
				focusedColumn: null,
				activeShelf: null,
				editingTransformIndex: null,
			};
		case 'focusColumn':
			if (state.focusedColumn === action.columnName) { return state; }
			return { ...state, focusedColumn: action.columnName };
		case 'setActiveShelf':
			if (state.activeShelf === action.channel) { return state; }
			return { ...state, activeShelf: action.channel };
		case 'openTransformEditor':
			if (state.editingTransformIndex === action.index) { return state; }
			return { ...state, editingTransformIndex: action.index };
		case 'themeUpdated':
			return { ...state, themeTokensVersion: state.themeTokensVersion + 1 };
		case 'deleteTransform': {
			if (state.editingTransformIndex === null) { return state; }
			if (state.editingTransformIndex === action.index) {
				return { ...state, editingTransformIndex: null };
			}
			if (state.editingTransformIndex > action.index) {
				return { ...state, editingTransformIndex: state.editingTransformIndex - 1 };
			}
			return state;
		}
		case 'moveTransform': {
			if (state.editingTransformIndex === null) { return state; }
			const editing = state.editingTransformIndex;
			if (editing === action.fromIndex) {
				if (action.toIndex === editing) { return state; }
				return { ...state, editingTransformIndex: action.toIndex };
			}
			// Simulate splice: pull `from`, insert at `to`. We need to
			// know where `editing` ends up afterwards.
			//
			// Working in "post-pull" coordinates: after pulling from F,
			// any index > F shifts left by 1. Then inserting at T (in
			// post-pull coords) shifts indexes >= T right by 1.
			let next = editing > action.fromIndex ? editing - 1 : editing;
			if (next >= action.toIndex) { next += 1; }
			if (next === editing) { return state; }
			return { ...state, editingTransformIndex: next };
		}
		default:
			return state;
	}
}
