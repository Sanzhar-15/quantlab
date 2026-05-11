/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Source slice: the editor's document path.
 *
 * `documentFsPath` is whatever the provider opened the editor on:
 *   - VisualiseSpecProvider opens `*.qviz.json` -- this is the spec path.
 *   - VisualiseDataProvider opens `*.csv | *.parquet | *.xlsx` -- this is
 *     the data path.
 *
 * For the spec editor, the actual dataset path lives in
 * `spec.dataset.uri` (resolved by the renderer/host), NOT here. Keeping
 * the slice unambiguous about this avoids the prior trap of treating
 * `fsPath` as "always the data file" when it's "always the document"
 * (Step B megaudit cross-cutting #1).
 *
 * Set by `init`; never changes after open (the editor opens one document
 * for its lifetime).
 */

import type { Action } from './actions';

export interface SourceState {
	readonly documentFsPath: string | null;
}

export const INITIAL_SOURCE_STATE: SourceState = { documentFsPath: null };

export function reduceSource(state: SourceState, action: Action): SourceState {
	switch (action.type) {
		case 'init':
			if (state.documentFsPath === action.fsPath) { return state; }
			return { documentFsPath: action.fsPath };
		default:
			return state;
	}
}
