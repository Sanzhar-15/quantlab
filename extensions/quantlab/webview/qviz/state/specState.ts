/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spec slice: the QvizSpec being built + dirty tracking.
 *
 * `current` is the working spec (the one the user is editing).
 * `lastSavedHash` is the specHash of whatever's on disk.
 * `pendingSaveHash` is the specHash that was sent for save and is
 * awaiting confirmation; a `saveResult` whose specHash matches advances
 * `lastSavedHash` to that value. A `saveResult` for a different spec
 * is silently dropped (Step B megaudit C8: prevent silent data loss
 * when a stale save lands after a newer edit).
 *
 * Reducer covers the spec-mutation actions: chart-type swap, encoding
 * shelf set/clear, OHLCV cluster, transform CRUD/reorder. Step D's UI
 * dispatches these directly.
 *
 * No-op edits: every mutation reducer returns the previous state if the
 * action would not change anything (helps `dirty` stay accurate without
 * triggering false-positive postMessages).
 */

import { computeSpecHash } from '../../../src/qviz/messageProtocol';
import type {
	ChartType, Encoding, Encodings, OhlcvEncoding, QvizSpec, Transform,
} from '../../../src/qviz/spec';
import { CHART_TYPE_BY_FAMILY } from '../../../src/qviz/validate';
import { structurallyEqual } from '../../../src/qviz/structuralEqual';
import { channelsForChartType } from '../../../src/qviz/chartChannels';
import type { Action } from './actions';

export interface SpecState {
	readonly current: QvizSpec | null;
	readonly currentHash: string | null;
	readonly lastSavedHash: string | null;
	/** specHash of the spec that was sent to the host for save, awaiting
	 *  confirmation. Cleared by saveResult (success advances lastSaved,
	 *  failure leaves lastSaved untouched). */
	readonly pendingSaveHash: string | null;
}

export const INITIAL_SPEC_STATE: SpecState = {
	current: null,
	currentHash: null,
	lastSavedHash: null,
	pendingSaveHash: null,
};

export function reduceSpec(state: SpecState, action: Action): SpecState {
	switch (action.type) {
		case 'init': {
			// Deep clone + freeze so external mutation of the inbound
			// payload can't corrupt our state. JSON.parse(JSON.stringify())
			// is the canonical clone for QvizSpec (JSON-shaped by construction).
			const cloned = JSON.parse(JSON.stringify(action.spec)) as QvizSpec;
			deepFreeze(cloned);
			const hash = computeSpecHash(cloned);
			// Step 5.H.2: lastSavedHash from the action when provided
			// (correct for undo-echo where the in-memory spec differs
			// from what's on disk). Defaults to currentHash for tests
			// and fresh-open paths that omit the field.
			const lastSavedHash = action.lastSavedHash ?? hash;
			return {
				current: cloned,
				currentHash: hash,
				lastSavedHash,
				pendingSaveHash: null,
			};
		}
		case 'saveStarted': {
			if (state.current === null) { return state; }
			if (state.pendingSaveHash === action.specHash) { return state; }
			return { ...state, pendingSaveHash: action.specHash };
		}
		case 'saveResult': {
			if (action.status !== 'ok') {
				// Failed save: clear pending only if it matches; leave
				// lastSavedHash untouched.
				if (state.pendingSaveHash === action.specHash) {
					return { ...state, pendingSaveHash: null };
				}
				return state;
			}
			// Successful save: advance lastSavedHash ONLY if the result
			// attributes to a save we sent. A stale saveResult for a
			// previously-edited spec must NOT mark the doc clean.
			if (state.pendingSaveHash !== action.specHash) {
				return state;
			}
			return {
				...state,
				lastSavedHash: action.specHash,
				pendingSaveHash: null,
			};
		}
		case 'setChartType': {
			if (state.current === null) { return state; }
			// Validate family/type whitelist so the reducer can't produce
			// a spec the validator would reject (e.g. timeseries+pie).
			const allowedTypes = CHART_TYPE_BY_FAMILY[action.family];
			if (!allowedTypes || !allowedTypes.includes(action.chartType)) {
				throw new Error(
					`setChartType: chartType '${action.chartType}' not allowed in family '${action.family}'; `
					+ `allowed: ${(allowedTypes ?? []).join(', ')}`,
				);
			}
			if (
				state.current.chart.family === action.family
				&& state.current.chart.type === action.chartType
			) {
				return state;
			}
			// Megaudit MAJOR-31: drop encodings that don't belong to
			// the new chart type. Switching scatter→pie used to keep
			// `x`/`y` encodings; the validator then rejected the
			// resulting spec at parse/edit time. Now we filter to the
			// channels the new type actually offers, plus preserve
			// the OHLCV cluster only for candlestick.
			const oldEnc = state.current.chart.encodings;
			const allowedChannels = action.chartType === 'candlestick'
				? new Set<string>()
				: new Set<string>(channelsForChartType(action.chartType));
			const filteredEnc: typeof oldEnc = {};
			for (const [ch, val] of Object.entries(oldEnc)) {
				if (ch === 'ohlcv') {
					if (action.chartType === 'candlestick') {
						(filteredEnc as Record<string, unknown>)[ch] = val;
					}
					continue;
				}
				if (allowedChannels.has(ch)) {
					(filteredEnc as Record<string, unknown>)[ch] = val;
				}
			}
			return advance(state, {
				...state.current,
				chart: {
					...state.current.chart,
					family: action.family,
					type: action.chartType,
					encodings: filteredEnc,
				},
			});
		}
		case 'setEncoding': {
			if (state.current === null) { return state; }
			// Deep clone the inbound encoding so callers can't mutate state
			// by holding a reference to the action payload.
			const enc = action.encoding === null
				? null : (deepCloneFreeze(action.encoding) as Encoding);
			const encodings = mutateChannel(state.current.chart.encodings, action.channel, enc);
			if (encodings === state.current.chart.encodings) { return state; }
			return advance(state, {
				...state.current,
				chart: { ...state.current.chart, encodings },
			});
		}
		case 'setOhlcv': {
			if (state.current === null) { return state; }
			const ohlcv = action.ohlcv === null
				? null : (deepCloneFreeze(action.ohlcv) as OhlcvEncoding);
			const encodings = mutateOhlcv(state.current.chart.encodings, ohlcv);
			if (encodings === state.current.chart.encodings) { return state; }
			return advance(state, {
				...state.current,
				chart: { ...state.current.chart, encodings },
			});
		}
		case 'upsertTransform': {
			if (state.current === null) { return state; }
			const transform = deepCloneFreeze(action.transform) as Transform;
			const transforms = upsertAt(state.current.transforms, action.index, transform);
			if (transforms === state.current.transforms) { return state; }
			return advance(state, { ...state.current, transforms });
		}
		case 'deleteTransform': {
			if (state.current === null) { return state; }
			if (action.index < 0 || action.index >= state.current.transforms.length) {
				throw new Error(
					`deleteTransform: index ${action.index} out of range [0, ${state.current.transforms.length})`,
				);
			}
			const transforms = state.current.transforms.filter((_, i) => i !== action.index);
			return advance(state, { ...state.current, transforms });
		}
		case 'moveTransform': {
			if (state.current === null) { return state; }
			const moved = move(state.current.transforms, action.fromIndex, action.toIndex);
			if (moved === state.current.transforms) { return state; }
			return advance(state, { ...state.current, transforms: moved });
		}
		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build the next spec state, computing a fresh specHash. The result is
 *  deep-frozen so consumers can't mutate it. */
function advance(state: SpecState, next: QvizSpec): SpecState {
	deepFreeze(next);
	return {
		current: next,
		currentHash: computeSpecHash(next),
		lastSavedHash: state.lastSavedHash,
		pendingSaveHash: state.pendingSaveHash,
	};
}

function mutateChannel(
	encodings: Encodings,
	channel: 'x' | 'y' | 'y2' | 'color' | 'size' | 'shape' | 'facet_row' | 'facet_col',
	encoding: Encoding | null,
): Encodings {
	const current = (encodings as { [k in typeof channel]?: Encoding | undefined })[channel];
	if (encoding === null) {
		if (current === undefined) { return encodings; }
		const next = { ...encodings };
		delete (next as { [k in typeof channel]?: Encoding | undefined })[channel];
		return next;
	}
	if (current && structurallyEqual(current, encoding)) { return encodings; }
	return { ...encodings, [channel]: encoding };
}

function mutateOhlcv(encodings: Encodings, ohlcv: OhlcvEncoding | null): Encodings {
	if (ohlcv === null) {
		if (encodings.ohlcv === undefined) { return encodings; }
		const next = { ...encodings };
		delete (next as { ohlcv?: OhlcvEncoding }).ohlcv;
		return next;
	}
	if (encodings.ohlcv && structurallyEqual(encodings.ohlcv, ohlcv)) { return encodings; }
	return { ...encodings, ohlcv };
}

function upsertAt(arr: readonly Transform[], index: number, t: Transform): readonly Transform[] {
	// Reject out-of-range indexes consistently with deleteTransform/moveTransform.
	// Append is permitted (index === arr.length) -- that's the only valid
	// "extend" operation in CRUD.
	if (index < 0 || index > arr.length) {
		throw new Error(
			`upsertTransform: index ${index} out of range [0, ${arr.length}]`,
		);
	}
	if (index === arr.length) {
		return [...arr, t];
	}
	if (structurallyEqual(arr[index], t)) { return arr; }
	const next = arr.slice();
	next[index] = t;
	return next;
}

function move<T>(arr: readonly T[], from: number, to: number): readonly T[] {
	if (from < 0 || from >= arr.length) {
		throw new Error(`moveTransform: fromIndex ${from} out of range [0, ${arr.length})`);
	}
	if (to < 0 || to >= arr.length) {
		throw new Error(`moveTransform: toIndex ${to} out of range [0, ${arr.length})`);
	}
	if (from === to) { return arr; }
	const next = arr.slice();
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}

/** Deep-freeze a JSON-shaped value in place. */
function deepFreeze<T>(obj: T): T {
	if (obj === null || typeof obj !== 'object') { return obj; }
	Object.freeze(obj);
	for (const key of Object.keys(obj)) {
		const v = (obj as Record<string, unknown>)[key];
		if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
			deepFreeze(v);
		}
	}
	return obj;
}

/** Deep clone (via JSON round-trip) and deep-freeze. Used to insulate
 *  reducer state from external mutations of action payloads. */
function deepCloneFreeze<T>(obj: T): T {
	const cloned = JSON.parse(JSON.stringify(obj)) as T;
	deepFreeze(cloned);
	return cloned;
}

/**
 * Computed: is the spec dirty (in-memory differs from on-disk)?
 *
 * Returns `true` when there is a current spec AND its hash doesn't match
 * the last-saved hash. Used by the save bar UI and by save flow gating.
 */
export function isDirty(state: SpecState): boolean {
	return state.currentHash !== null
		&& state.currentHash !== state.lastSavedHash;
}

/** Suppress unused-import noise for ChartType (referenced via Action).
 *  Keeps the import live so tsc tracks it. */
export type _UsesChartType = ChartType;
