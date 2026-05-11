/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renderer slice: which chart family is currently mounted in the
 * preview area + whether a view handle is live.
 *
 * Owned by the RendererHost (Step 5.E). The reducer here just tracks
 * the host's announcements -- the host is the source of truth for the
 * actual DOM/canvas state.
 *
 * `rendererSwapped` always clears `hasViewHandle`, even when the family
 * is unchanged. The host emits `rendererSwapped` to signal "I'm about
 * to remount"; the next `rendererHandleChanged(true)` confirms the new
 * handle is live. Treating same-family as a no-op (Step B megaudit E2)
 * leaves the slice claiming a live handle while the host is mid-remount.
 */

import type { ChartFamily } from '../../../src/qviz/spec';
import type { Action } from './actions';

export interface RendererState {
	readonly currentFamily: ChartFamily | null;
	readonly hasViewHandle: boolean;
}

export const INITIAL_RENDERER_STATE: RendererState = {
	currentFamily: null,
	hasViewHandle: false,
};

export function reduceRenderer(state: RendererState, action: Action): RendererState {
	switch (action.type) {
		case 'init':
			if (state === INITIAL_RENDERER_STATE) { return state; }
			return INITIAL_RENDERER_STATE;
		case 'rendererSwapped':
			if (
				state.currentFamily === action.family
				&& state.hasViewHandle === false
			) { return state; }
			return { currentFamily: action.family, hasViewHandle: false };
		case 'rendererHandleChanged':
			if (state.hasViewHandle === action.hasViewHandle) { return state; }
			return { ...state, hasViewHandle: action.hasViewHandle };
		default:
			return state;
	}
}
