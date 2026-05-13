/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inspector slice (Phase 6, 6.B.2).
 *
 * Holds the side-panel data-inspector's transient state:
 *
 *   - `visible`             -- panel open/closed; toggle action flips it.
 *   - `filters`             -- per-column ephemeral filter (range / text /
 *                             set). NEVER serialized into `.qviz.json`;
 *                             closing the editor clears them.
 *   - `selection`           -- x-value currently highlighted. Both the
 *                             chart and the table read from this; both
 *                             can dispatch `setSelection` to update it.
 *   - `scrollOffset`        -- first visible row index, used by the
 *                             virtualized table to decide when to ask
 *                             the daemon for a new window.
 *   - `window`              -- the most-recently-received Arrow IPC bytes
 *                             of preview rows for the current `(offset,
 *                             filters)` tuple. `null` until the first
 *                             inspectorDataReceived lands or after
 *                             filters/visibility change invalidates it.
 *   - `statsCache`          -- per-column stats memoized by name, with a
 *                             pending flag so the widget can render a
 *                             spinner without dispatching a second
 *                             fetch on rapid re-opens.
 *
 * The slice is RESET on `init` because each document gets its own
 * inspector state -- switching between editors must not carry filters or
 * selection across.
 *
 * Persistence contract (Phase 6 / 6.F):
 *
 *   The inspector slice is webview-only state and MUST NEVER be
 *   serialized into `.qviz.json`. The save path (`specCore.serializeSpec`)
 *   only sees `state.spec.current` (a `QvizSpec`) and has no surface that
 *   could carry inspector keys. Three invariants enforce the boundary:
 *
 *     1. `QvizSpec` (in `src/qviz/spec.ts`) has no `filters`/`selection`/
 *        `scrollOffset`/`window`/`statsCache`/`visible` field -- the
 *        TypeScript type system rejects any leakage at the call site.
 *     2. The `init` action RESETS this slice to defaults; closing and
 *        reopening a document drops every filter and selection.
 *     3. `saveStarted` / `saveResult` actions don't touch this slice;
 *        the persistence slice is the only state that records save
 *        outcomes.
 *
 *   Regression tests in `test/qviz-state-store.test.ts` ("Phase 6 / 6.F")
 *   walk a fully-dirtied inspector slice through `serializeSpec` and
 *   assert no inspector keys appear at any depth of the resulting JSON.
 */

import type {
	ColumnStats, InspectorFilter, InspectorErrorKind,
} from '../../../src/qviz/messageProtocol';
import type { Action } from './actions';

export interface ColumnStatsEntry {
	readonly status: 'pending' | 'ready' | 'error';
	readonly stats?: ColumnStats;
	readonly error?: string;
}

export interface InspectorWindow {
	readonly offset: number;
	/** Arrow IPC bytes for rows [offset, offset + n). Empty Uint8Array
	 *  means "received empty window" (past EOF); `window === null` is
	 *  "not loaded yet". */
	readonly arrow: Uint8Array;
	readonly n: number;
	/** Total rows visible under current filters, if reported. */
	readonly total: number | null;
	/** Snapshot of filters that were active when this window was
	 *  fetched. Used to detect that the window is stale once filters
	 *  change (the inspector clears `window` proactively on filter
	 *  edits, but cross-check guards against races). */
	readonly filtersHashAtFetch: string;
}

export interface InspectorState {
	readonly visible: boolean;
	readonly filters: { readonly [column: string]: InspectorFilter | undefined };
	readonly selection: { readonly x: unknown } | null;
	readonly scrollOffset: number;
	readonly window: InspectorWindow | null;
	readonly statsCache: { readonly [column: string]: ColumnStatsEntry | undefined };
	/** Audit M-C/M-D (2026-05-11): last error from the inspector data
	 *  fetch path, surfaced by the table's placeholder slot. Cleared on
	 *  the next successful `inspectorDataReceived` or on any state
	 *  transition that invalidates the window (filter edit, init). The
	 *  dispatcher in qviz-spec/index.ts ALSO clears the duplicate-request
	 *  cursor when this field is non-null so retries can fire. */
	readonly lastError: string | null;
	/** Megaudit D3 (2026-05-13): structured kind of the most recent
	 *  inspector error. Invariant: `lastError === null` iff
	 *  `lastErrorKind === null`. Drives Retry-button gating (security
	 *  and protocol are terminal; timeout/memory/internal are
	 *  retryable) and screen-reader phrasing in `announcer.ts`. */
	readonly lastErrorKind: InspectorErrorKind | null;
}

export const INITIAL_INSPECTOR_STATE: InspectorState = {
	visible: false,
	filters: {},
	selection: null,
	scrollOffset: 0,
	window: null,
	statsCache: {},
	lastError: null,
	lastErrorKind: null,
};

/** Stable string fingerprint of the active filters, used to detect stale
 *  inspector-data responses (a window fetched under filters F1 must be
 *  discarded if filters changed to F2 while the response was in flight).
 *
 *  Audit Tier-9 (2026-05-11): JSON.stringify uses insertion order for
 *  object keys, so two equivalent filters with different field-order
 *  would mis-fingerprint. Recursive-stable-stringify defends. */
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== 'object') { return JSON.stringify(v); }
	if (Array.isArray(v)) {
		return '[' + v.map(stableStringify).join(',') + ']';
	}
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
export function hashFilters(filters: InspectorState['filters']): string {
	const keys = Object.keys(filters).sort();
	const parts: string[] = [];
	for (const k of keys) {
		const f = filters[k];
		if (f === undefined) { continue; }
		parts.push(`${k}:${stableStringify(f)}`);
	}
	return parts.length === 0 ? '' : parts.join('|');
}

/** Phase 6 audit B-2/B-3 (2026-05-11): pick the row-side field that
 *  selection sync should compare against, by chart type. Most charts
 *  use `encodings.x.field`, but two special cases:
 *
 *    - candlestick: `encodings.x` is absent; the time axis is
 *      `encodings.ohlcv.time` (the cluster slot for the timestamp).
 *      Without this fallback, row clicks on a candlestick chart silently
 *      no-op and chart clicks land on empty rows.
 *    - pie: `encodings.x` is absent; the slice category is
 *      `encodings.color.field`. Pie selection compares against the
 *      categorical column.
 *
 *  Returns null when the spec has no usable selection field (e.g., a
 *  draft spec with no encodings yet, or pre-init state). */
export function selectionFieldForSpec(spec: {
	readonly chart: {
		readonly type: string;
		readonly encodings: {
			readonly x?: { readonly field?: string };
			readonly color?: { readonly field?: string };
			readonly ohlcv?: { readonly time?: string };
		};
	};
} | null | undefined): string | null {
	if (!spec) { return null; }
	const enc = spec.chart.encodings;
	if (spec.chart.type === 'candlestick' && enc.ohlcv?.time) {
		return enc.ohlcv.time;
	}
	if (spec.chart.type === 'pie' && enc.color?.field) {
		return enc.color.field;
	}
	return enc.x?.field ?? null;
}

/** Phase 6 audit M-I (2026-05-11): canonicalize a selection x-value into
 *  a form that compares cleanly across the chart and table sources.
 *
 *  charts-plus crosshair emits time as a number-of-milliseconds. Vega
 *  click handlers emit raw `datum[xField]` which can be a `Date`, an
 *  ISO string, a `bigint` (parquet nanosecond timestamps), or a number.
 *  Inspector Arrow temporal columns surface as `Date` or as numeric
 *  timestamps. Strict equality across these representations fails.
 *
 *  Canonical form: a number of milliseconds since the epoch for any
 *  temporal-looking value; the original value unchanged for everything
 *  else. The reducer + the table's highlight pass both run incoming
 *  values through this so a chart click and a row click on the same
 *  point end up with selections that compare equal.
 *
 *  Heuristics intentionally conservative -- only well-known temporal
 *  shapes get coerced. Strings that aren't ISO-parsable stay as-is. */
export function canonicalizeSelectionX(x: unknown): unknown {
	if (x instanceof Date) {
		return x.getTime();
	}
	if (typeof x === 'bigint') {
		// Audit M-12 (2026-05-11): only convert when the bigint's
		// magnitude looks like a plausible nanosecond-since-epoch
		// timestamp. Treating every bigint as ns corrupts integer ID
		// columns (e.g., 64-bit row IDs, transaction IDs).
		// Plausible range: 1970..2300 in nanoseconds is roughly
		// [0, 1.04e19]. We pick a conservative window [1.2e18, 1e19]
		// (i.e., ~year 2008 through ~year 2286) to bias toward
		// real-world parquet timestamp columns. Outside that window,
		// return as Number (lossy past 2^53, but that's the same
		// behavior the chart compiler uses).
		const v = x as bigint;
		if (v >= 1_200_000_000_000_000_000n && v <= 10_000_000_000_000_000_000n) {
			return Number(v / 1_000_000n);
		}
		return Number(v);
	}
	if (typeof x === 'string') {
		// ISO-8601 detection: starts with 4-digit year + dash + month.
		// We don't try to parse every string -- only the timestamp-shaped
		// ones. Parse-failure leaves the string untouched.
		if (/^\d{4}-\d{2}/.test(x)) {
			const ms = Date.parse(x);
			if (Number.isFinite(ms)) { return ms; }
		}
		return x;
	}
	return x;
}

/** True iff `a` and `b` describe the same selection (NaN-safe). */
function sameSelection(
	a: InspectorState['selection'], b: InspectorState['selection'],
): boolean {
	if (a === b) { return true; }
	if (a === null || b === null) { return false; }
	// NaN === NaN is false but inspector selection on NaN should be
	// treated as the same selection so we don't churn the highlight.
	if (typeof a.x === 'number' && typeof b.x === 'number'
		&& Number.isNaN(a.x) && Number.isNaN(b.x)) {
		return true;
	}
	return a.x === b.x;
}

/** Megaudit D3 audit (2026-05-13): the invariant
 *  `lastError === null iff lastErrorKind === null` is reducer-only.
 *  Wrap the inner reducer so every transition is checked once. If
 *  it ever fails, throw — this is a programmer error and silently
 *  papering over it would let the inspector UI desync (per the
 *  audit's analysis of the previous "kind === null retryable"
 *  fallback). */
function assertInspectorErrorInvariant(s: InspectorState, label: string): void {
	if ((s.lastError === null) !== (s.lastErrorKind === null)) {
		throw new Error(
			`inspector invariant broken at ${label}: lastError=`
			+ `${JSON.stringify(s.lastError)} but lastErrorKind=`
			+ `${JSON.stringify(s.lastErrorKind)}`,
		);
	}
}

export function reduceInspector(state: InspectorState, action: Action): InspectorState {
	const next = reduceInspectorInner(state, action);
	if (next !== state) {
		assertInspectorErrorInvariant(next, action.type);
	}
	return next;
}

function reduceInspectorInner(state: InspectorState, action: Action): InspectorState {
	switch (action.type) {
		case 'init':
			// Reset per-document. Identity-preserve when already at the
			// default state to avoid spurious top-level RootState change
			// when nothing actually shifted.
			// D3 audit: also check lastErrorKind so a state with
			// {lastError:null, lastErrorKind:'security'} (invariant
			// violation) is not silently identity-preserved.
			if (
				state.visible === INITIAL_INSPECTOR_STATE.visible
				&& Object.keys(state.filters).length === 0
				&& state.selection === null
				&& state.scrollOffset === 0
				&& state.window === null
				&& Object.keys(state.statsCache).length === 0
				&& state.lastError === null
				&& state.lastErrorKind === null
			) {
				return state;
			}
			return INITIAL_INSPECTOR_STATE;

		case 'setChartType':
		case 'applyChartTypeWithFit': {
			// Audit M-9 (2026-05-11): chart-type swaps that drop the
			// selection field (e.g., line → pie, scatter → candlestick)
			// leave a ghost selection -- its x-value no longer maps to
			// any row in the new chart's coordinate space. Clear
			// selection on any chart-type transition; the user can
			// re-click as needed. This is more aggressive than strictly
			// necessary, but the alternative ("only clear when the
			// selection-field name changes") requires reading the prior
			// spec which the reducer doesn't carry.
			//
			// Cycle 2 audit HIGH-1 (Opus, 2026-05-14): Front 1's
			// `applyChartTypeWithFit` action MUST share this arm.
			// Previously only `setChartType` was here; the new picker
			// path silently regressed M-9 for every chart-type click.
			if (state.selection === null) { return state; }
			return { ...state, selection: null };
		}

		case 'setEncoding': {
			// Audit M-9 (2026-05-11): a setEncoding on `x` / `color` /
			// `y` can change the selection-relevant field. Clear
			// selection conservatively when those channels are touched.
			if (action.channel !== 'x' && action.channel !== 'color') {
				return state;
			}
			if (state.selection === null) { return state; }
			return { ...state, selection: null };
		}

		case 'setOhlcv': {
			// Audit M-9 (2026-05-11): same rationale for candlestick.
			if (state.selection === null) { return state; }
			return { ...state, selection: null };
		}

		case 'schemaChanged': {
			// Audit B-4 (2026-05-11): when the dataset's schema changes
			// mid-session, the inspector's per-column state (filters,
			// statsCache) MUST be reconciled -- otherwise the user keeps
			// filters on columns that no longer exist (the daemon
			// rejects those requests with cryptic errors) and stats are
			// stale for columns whose dtype changed. We don't fully
			// reset (the inspector toggle / window load shouldn't churn
			// on a benign drift); we prune to columns still in the new
			// schema.
			const keep = new Set(action.newSchema.columns.map(c => c.name));
			const filters: { [column: string]: InspectorFilter | undefined } = {};
			let filtersChanged = false;
			for (const col of Object.keys(state.filters)) {
				if (keep.has(col)) {
					filters[col] = state.filters[col];
				} else {
					filtersChanged = true;
				}
			}
			// Safest: invalidate every stats entry on schemaChanged and
			// lazily refetch on next widget open (we don't have dtype
			// metadata on the slice to do a finer-grained invalidation).
			const statsCache: typeof state.statsCache = {};
			const statsChanged = Object.keys(state.statsCache).length > 0;
			if (!filtersChanged && !statsChanged && state.window === null) {
				return state;
			}
			// Megaudit Theme D (D5, 2026-05-13): preserve scrollOffset on
			// fields-preserved drifts (no column removed). The window is
			// invalidated regardless (because the LOADED rows may carry
			// stale dtypes), but the user's scroll position is not
			// invalidated by a benign schema-hash change. The "no
			// columns removed" check is the same condition that
			// preserves filters.
			return {
				...state,
				filters: filtersChanged ? filters : state.filters,
				statsCache: statsChanged ? statsCache : state.statsCache,
				// Drop the loaded window; it was fetched under old
				// schema and the column-set may not match.
				window: null,
				// Drop selection if its column was removed -- we don't
				// have selection.column, only selection.x; conservative
				// choice: clear selection on any field drop. Keep when
				// nothing was filtered out (drop-by-default is too
				// aggressive for fields-preserved drifts).
				selection: filtersChanged ? null : state.selection,
				// D5: only reset scrollOffset when columns actually
				// changed. Otherwise the user's scroll position is
				// preserved across same-hash drifts.
				scrollOffset: filtersChanged ? 0 : state.scrollOffset,
				lastError: null,
				lastErrorKind: null,
			};
		}

		case 'toggleInspector': {
			const next = action.visible ?? !state.visible;
			if (next === state.visible) { return state; }
			return { ...state, visible: next };
		}

		case 'capabilitiesUpdated': {
			// Front 7 (2026-05-13 post-smoke): when the daemon
			// respawns / downgrades, the new capabilities may no
			// longer support the inspector. Auto-close inline in
			// the reducer to avoid the previous subscriber-side
			// `store.dispatch({type:'toggleInspector'})` which
			// triggered the store re-entrancy guard
			// ("QvizStore: nested dispatch is not allowed"). This
			// is the correctness-spine fix — the subscriber at
			// `webview/qviz-spec/index.ts:553` now reads UI state
			// only and never dispatches.
			if (!state.visible) { return state; }
			const i = action.capabilities.inspector;
			const supported = i !== undefined
				&& i.previewOffset && i.columnStats && i.aggregateFilters;
			if (supported) { return state; }
			return { ...state, visible: false };
		}

		case 'setColumnFilter': {
			const current = state.filters[action.column];
			if (action.filter === null) {
				if (current === undefined) { return state; }
				const { [action.column]: _drop, ...rest } = state.filters;
				return {
					...state,
					filters: rest,
					// Filter change invalidates any pending window.
					window: null,
					scrollOffset: 0,
					// Filter edit is a fresh start -- drop any prior error
					// so the next fetch can repopulate cleanly.
					lastError: null,
					lastErrorKind: null,
					// Audit M-10 (2026-05-11): a filter change can drop
					// the row whose x-value is the current selection; the
					// ghost highlight after refetch is confusing. Clear.
					selection: null,
				};
			}
			// Identity-preserve when the same filter is re-set.
			if (current && JSON.stringify(current) === JSON.stringify(action.filter)) {
				return state;
			}
			return {
				...state,
				filters: { ...state.filters, [action.column]: action.filter },
				window: null,
				scrollOffset: 0,
				lastError: null,
				lastErrorKind: null,
				selection: null,
			};
		}

		case 'clearAllFilters': {
			// Audit M-63 (2026-05-11): also reset lastError so an
			// "all-clear" really clears every transient state.
			if (Object.keys(state.filters).length === 0 && state.lastError === null) {
				return state;
			}
			return {
				...state,
				filters: {},
				window: null,
				scrollOffset: 0,
				lastError: null,
				lastErrorKind: null,
				// Same rationale as setColumnFilter: filter removal
				// invalidates the current selection's row context.
				selection: null,
			};
		}

		case 'retryInspectorFetch': {
			// Megaudit Theme D (D4, 2026-05-13): null lastError and
			// reset window so the next fetch cycle re-fires from the
			// current cursor. Filters are PRESERVED (the bug that
			// motivated this action: the prior "Retry" path dispatched
			// clearAllFilters as a side effect, wiping user state).
			if (state.lastError === null && state.window === null) {
				return state;
			}
			return {
				...state,
				lastError: null,
				lastErrorKind: null,
				window: null,
				// Keep scrollOffset, filters, selection.
			};
		}

		case 'setSelection': {
			// Audit M-J (2026-05-11): `null` and `undefined` are
			// legitimate x-values when a column has NULL rows; collapsing
			// them to "no selection" prevents the user from ever
			// highlighting null rows. Use `clearSelection` (a separate
			// action) for the "no selection" intent. `setSelection` now
			// always sets a selection, even when x is null/undefined.
			//
			// Audit M-I (2026-05-11): canonicalize the x-value at
			// dispatch time so chart-emitted ms-numbers, Date objects
			// from row reads, and ISO strings all collapse to the same
			// representation for equality. The table's row-match pass
			// runs row[xField] through the same canonicalizer.
			const next: InspectorState['selection'] = { x: canonicalizeSelectionX(action.x) };
			if (sameSelection(state.selection, next)) { return state; }
			return { ...state, selection: next };
		}

		case 'clearSelection': {
			if (state.selection === null) { return state; }
			return { ...state, selection: null };
		}

		case 'setScrollOffset': {
			if (!Number.isSafeInteger(action.offset) || action.offset < 0) {
				throw new Error(
					`setScrollOffset: offset must be a non-negative safe integer, got ${action.offset}`,
				);
			}
			if (state.scrollOffset === action.offset) { return state; }
			return { ...state, scrollOffset: action.offset };
		}

		case 'inspectorDataReceived': {
			const currentHash = hashFilters(state.filters);
			return {
				...state,
				window: {
					offset: action.offset,
					arrow: action.arrow,
					n: action.n,
					total: action.total ?? null,
					filtersHashAtFetch: currentHash,
				},
				// Successful data fetch clears any prior error so the
				// table's placeholder slot stops showing the stale error.
				lastError: null,
				lastErrorKind: null,
			};
		}

		case 'inspectorError': {
			// Audit M-C/M-D (2026-05-11): the prior version only nulled
			// the window, which routed the table to a generic "Loading…"
			// state and gave the user no signal that the fetch failed.
			// We now stash the error string so the table can render an
			// explicit failure placeholder, AND the dispatcher in
			// qviz-spec/index.ts watches this field to clear its
			// duplicate-request cursor -- without that clear, the same
			// (offset, filters) retry was suppressed forever.
			// Megaudit D3 (2026-05-13): also stash the structured kind
			// so the table can gate Retry button visibility (security
			// and protocol are terminal; the others are retryable) and
			// the announcer can vary phrasing by kind.
			return {
				...state,
				window: null,
				lastError: action.error,
				lastErrorKind: action.errorKind,
			};
		}

		case 'columnStatsRequested': {
			// Audit Minor (2026-05-11): mark the column's stats entry as
			// `pending` so rapid reopens of the same filter widget don't
			// re-fire `requestColumnStats`. The widget reads the
			// statsCache entry's status and renders a spinner without
			// dispatching a second request.
			const existing = state.statsCache[action.column];
			if (existing && existing.status === 'pending') { return state; }
			return {
				...state,
				statsCache: {
					...state.statsCache,
					[action.column]: { status: 'pending' },
				},
			};
		}

		case 'columnStatsReceived': {
			const existing = state.statsCache[action.column];
			if (existing && existing.status === 'ready'
				&& JSON.stringify(existing.stats) === JSON.stringify(action.stats)) {
				return state;
			}
			return {
				...state,
				statsCache: {
					...state.statsCache,
					[action.column]: { status: 'ready', stats: action.stats },
				},
			};
		}

		case 'columnStatsError': {
			return {
				...state,
				statsCache: {
					...state.statsCache,
					[action.column]: { status: 'error', error: action.error },
				},
			};
		}

		default:
			return state;
	}
}
