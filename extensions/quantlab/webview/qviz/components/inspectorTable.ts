/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * inspectorTable — Phase 6 step 6.C.2.
 *
 * Virtualized data table for the inspector panel.
 *
 * Rendering strategy:
 *
 *   - Outer container has a fixed height (the inspector panel sets it).
 *   - Inner "scroller" is the actual scrollable element; its height is
 *     `rowHeight * total` so the native scrollbar matches the dataset
 *     size, even when only a small window is loaded.
 *   - Visible rows are absolutely positioned at `top = i * rowHeight`.
 *     A small OVERSCAN above and below keeps a buffer so quick scrolls
 *     don't flash a blank gap.
 *   - On scroll, we compute the first visible row index from `scrollTop /
 *     rowHeight` and dispatch `setScrollOffset` only when it differs from
 *     the slice's current scroll offset (avoids dispatch storm at 60 fps).
 *   - When the visible window leaves the loaded data window, the
 *     dispatch layer (in qviz-spec/index.ts) issues a fresh
 *     `requestInspectorData` for the new offset. We just dispatch the
 *     intent — the dispatch layer handles request lifecycle.
 *
 * State binding:
 *
 *   - Subscribes to `state.inspector.window`, `.selection`, `.scrollOffset`.
 *   - Schema column order comes from `state.schema.info.columns`.
 *   - Selection highlight: rows where `row[xField] === selection.x` get
 *     `qviz-inspector-row--selected`. xField comes from
 *     `state.spec.current.chart.encodings.x.field`. With no x encoding
 *     (e.g. histogram-only spec or empty draft) selection sync degrades
 *     to no-op (no rows highlight).
 */

import type { QvizStore } from '../state/store';
import type { ColumnData } from '../../../src/qviz/render/types';
import { extractColumnsFromArrowIpcSafe } from '../../../src/qviz/render/extract-arrow';
import { canonicalizeSelectionX, selectionFieldForSpec } from '../state/inspectorState';
import { mountColumnFilter, type ColumnFiltersHandle } from './columnFilters';

interface VsCodeBridge { postMessage(value: unknown): void; }

/** Fixed pixel height of one row. Matches the CSS rule in qviz-spec.css. */
const ROW_HEIGHT = 24;
/** Overscan: extra rows rendered above and below the visible window so
 *  rapid scrolls don't flash a blank gap. */
const OVERSCAN = 6;
/** Window size requested from the daemon per fetch. The dispatch layer
 *  may request bigger windows for big screens; this is the floor. */
export const DEFAULT_INSPECTOR_WINDOW_N = 200;

export interface InspectorTableHandle {
	dispose(): void;
}

export interface InspectorTableOptions {
	/** Called when the user clicks a row. The dispatcher upstream
	 *  translates this to a `setSelection({x: row[xField]})` action.
	 *  Receives the row index (0-based, relative to the loaded window)
	 *  and the row's record. */
	readonly onRowClick?: (rowIndex: number, row: Record<string, unknown>) => void;
	/** vscode bridge for `postMessage` so the column-filter widgets
	 *  can request stats lazily on first open. Optional in unit tests
	 *  where filter widgets aren't exercised. */
	readonly vscode?: VsCodeBridge;
	/** Audit M-29: register outbound column-stats request ids with the
	 *  dispatch layer for stale-response rejection. */
	readonly registerColumnStatsRequest?: (column: string, requestId: number) => void;
}

export function mountInspectorTable(
	root: HTMLElement, store: QvizStore, opts: InspectorTableOptions = {},
): InspectorTableHandle {
	root.classList.add('qviz-inspector-table');
	// Audit M-41 (2026-05-11): grid role so screen readers announce
	// "table" and treat the rows as a grid of cells. Without this, the
	// `role="row"` children were ARIA-invalid.
	root.setAttribute('role', 'grid');
	root.innerHTML = `
		<div class="qviz-inspector-header-row" role="row"></div>
		<div class="qviz-inspector-body" tabindex="0">
			<div class="qviz-inspector-scroller">
				<div class="qviz-inspector-spacer"></div>
				<div class="qviz-inspector-rows"></div>
			</div>
			<div class="qviz-inspector-placeholder" hidden></div>
		</div>
	`;
	const headerRow = root.querySelector<HTMLDivElement>('.qviz-inspector-header-row')!;
	const body = root.querySelector<HTMLDivElement>('.qviz-inspector-body')!;
	const scroller = root.querySelector<HTMLDivElement>('.qviz-inspector-scroller')!;
	const spacer = root.querySelector<HTMLDivElement>('.qviz-inspector-spacer')!;
	const rowsContainer = root.querySelector<HTMLDivElement>('.qviz-inspector-rows')!;
	const placeholder = root.querySelector<HTMLDivElement>('.qviz-inspector-placeholder')!;

	// Cached extracted columns from the most recent window. Recomputed
	// only when `inspector.window` (the Arrow bytes ref) changes.
	let cachedArrowBytes: Uint8Array | null = null;
	let cachedColumns: ColumnData | null = null;
	let cachedColumnNames: string[] = [];
	let cachedRowCount = 0;
	const filterHandles: ColumnFiltersHandle[] = [];

	const setPlaceholder = (text: string | null, opts: { retry?: () => void; kind?: 'info' | 'error' } = {}): void => {
		if (text === null) {
			placeholder.hidden = true;
			scroller.hidden = false;
			return;
		}
		placeholder.innerHTML = '';
		const span = document.createElement('span');
		span.textContent = text;
		placeholder.appendChild(span);
		// Audit M-48 (2026-05-11): error-state placeholder gets a Retry
		// button so the user can re-fetch without scrolling/toggling.
		if (opts.retry) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'qviz-inspector-retry';
			btn.textContent = 'Retry';
			btn.addEventListener('click', opts.retry);
			placeholder.appendChild(btn);
		}
		placeholder.classList.toggle('qviz-inspector-placeholder--error', opts.kind === 'error');
		placeholder.hidden = false;
		scroller.hidden = true;
	};

	const disposeFilterHandles = (): void => {
		for (const h of filterHandles) { h.dispose(); }
		filterHandles.length = 0;
	};

	const renderHeader = (columns: readonly string[]): void => {
		disposeFilterHandles();
		headerRow.innerHTML = '';
		for (const c of columns) {
			const cell = document.createElement('div');
			cell.className = 'qviz-inspector-cell qviz-inspector-cell--header';
			cell.setAttribute('role', 'columnheader');
			cell.title = c;
			const nameSpan = document.createElement('span');
			nameSpan.className = 'qviz-inspector-cell-name';
			nameSpan.textContent = c;
			cell.appendChild(nameSpan);
			if (opts.vscode) {
				filterHandles.push(mountColumnFilter(cell, c, store, {
					vscode: opts.vscode,
					registerColumnStatsRequest: opts.registerColumnStatsRequest,
				}));
			}
			headerRow.appendChild(cell);
		}
	};

	const formatCell = (v: unknown): string => {
		if (v === null || v === undefined) { return ''; }
		if (typeof v === 'number') {
			if (!Number.isFinite(v)) { return String(v); }
			// Compact-ish: long decimals get pinned to 6 significant digits.
			if (Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-3)) {
				return v.toExponential(4);
			}
			if (Number.isInteger(v)) { return String(v); }
			return v.toFixed(4).replace(/\.?0+$/, '');
		}
		if (typeof v === 'bigint') { return v.toString(); }
		if (v instanceof Date) { return v.toISOString(); }
		if (typeof v === 'string') { return v; }
		return JSON.stringify(v);
	};

	const renderVisibleRows = (
		columns: ColumnData, columnNames: string[],
		rowCount: number, windowOffset: number,
		scrollTop: number, viewportHeight: number,
		selection: { x: unknown } | null, xField: string | null,
	): void => {
		// First/last row INDEX (in the dataset coordinate space, not just
		// the loaded window). Clamp to the loaded window so we don't try
		// to render rows we don't have.
		const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
		const lastVisible = Math.min(
			rowCount + windowOffset,
			Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
		);
		// Restrict to the loaded window.
		const renderFrom = Math.max(firstVisible, windowOffset);
		const renderTo = Math.min(lastVisible, windowOffset + rowCount);

		rowsContainer.innerHTML = '';
		const selX = selection?.x;
		const selXIsNaN = typeof selX === 'number' && Number.isNaN(selX);
		const xCol = xField !== null ? columns[xField] : undefined;

		for (let i = renderFrom; i < renderTo; i++) {
			const localIdx = i - windowOffset;
			const row = document.createElement('div');
			row.className = 'qviz-inspector-row';
			row.setAttribute('role', 'row');
			// Audit M-41 (2026-05-11): tabindex + aria-selected so
			// keyboard users can tab into a row and Enter to select.
			// Roving tabindex would be nicer but tabindex=0 on every
			// row is the minimum that lets SR + keyboard users reach
			// the data at all.
			row.tabIndex = 0;
			row.style.top = `${i * ROW_HEIGHT}px`;
			row.dataset.localIdx = String(localIdx);

			let isSelected = false;
			if (xCol !== undefined && selection !== null) {
				const raw = (xCol as ArrayLike<unknown>)[localIdx];
				// Audit M-I (2026-05-11): canonicalize the row's x-value
				// through the same helper the selection reducer uses, so
				// chart-emitted numeric timestamps match against
				// Date/string row values.
				const v = canonicalizeSelectionX(raw);
				const matches = selXIsNaN
					? (typeof v === 'number' && Number.isNaN(v))
					: v === selX;
				if (matches) {
					row.classList.add('qviz-inspector-row--selected');
					isSelected = true;
				}
			}
			row.setAttribute('aria-selected', String(isSelected));

			for (const colName of columnNames) {
				const col = columns[colName];
				const v = col !== undefined ? (col as ArrayLike<unknown>)[localIdx] : undefined;
				const cell = document.createElement('div');
				cell.className = 'qviz-inspector-cell';
				cell.setAttribute('role', 'cell');
				const text = formatCell(v);
				cell.textContent = text;
				// Audit Tier-9 (2026-05-11): cap title length so very
				// long cells don't produce unwieldy 100KB tooltips.
				cell.title = text.length > 4096 ? text.slice(0, 4096) + '… (truncated)' : text;
				cell.setAttribute('role', 'cell');
				row.appendChild(cell);
			}

			rowsContainer.appendChild(row);
		}
	};

	const update = (): void => {
		const state = store.getState();
		const insp = state.inspector;
		const schema = state.schema.info;

		if (schema === null) {
			setPlaceholder('Reading dataset schema…');
			return;
		}
		// Audit M-36/M-37 (2026-05-11): surface dataset and daemon
		// problems explicitly. Without these branches the inspector
		// shows a stale "Loading rows…" forever when the file is
		// missing OR the daemon is unavailable, since no
		// inspectorData/inspectorError will arrive.
		const dStatus = state.runtime.datasetStatus;
		if (dStatus !== 'ok') {
			const why = state.runtime.datasetError ?? dStatus;
			setPlaceholder(`Dataset is unavailable: ${why}`);
			return;
		}
		const daemon = state.runtime.daemonStatus;
		if (daemon === 'crashed' || daemon === 'respawning' || daemon === 'unavailable') {
			const why = state.runtime.daemonLastError ?? daemon;
			setPlaceholder(`Daemon ${daemon}: ${why}`);
			return;
		}
		// Audit M-C/M-D (2026-05-11): surface fetch failures explicitly
		// instead of hiding them behind a generic "Loading…" placeholder
		// that misleads the user into waiting forever.
		if (insp.lastError !== null) {
			// Audit M-48: clearing the error (via clearAllFilters or
			// a new filter dispatch) is the retry pathway. Dispatch a
			// scroll-offset noop that re-runs the request flow.
			setPlaceholder(`Could not load rows: ${insp.lastError}`, {
				kind: 'error',
				retry: () => {
					// Setting scroll offset to the SAME value won't
					// re-fire (reducer identity-preserves); instead we
					// clear the error and reset the cursor so the
					// dispatch layer treats this as a fresh request.
					store.dispatch({ type: 'clearAllFilters' });
				},
			});
			return;
		}
		if (insp.window === null) {
			setPlaceholder('Loading rows…');
			return;
		}

		// Re-extract columns only when the arrow bytes ref changes.
		if (insp.window.arrow !== cachedArrowBytes) {
			cachedArrowBytes = insp.window.arrow;
			let newColumnNames: string[];
			if (insp.window.n === 0 || insp.window.arrow.byteLength === 0) {
				cachedColumns = null;
				newColumnNames = schema.columns.map(c => c.name);
				cachedRowCount = 0;
			} else {
				// Audit M-34 (2026-05-11): inspector-safe extractor —
				// per-column failures fall back to stringified cells
				// instead of failing the whole table.
				cachedColumns = extractColumnsFromArrowIpcSafe(insp.window.arrow);
				newColumnNames = Object.keys(cachedColumns);
				cachedRowCount = insp.window.n;
			}
			// Audit M-31 (2026-05-11): only rebuild the header (and tear
			// down + remount all N filter chips) when the column names
			// actually changed. The prior code remounted on every
			// arrow-window-reference change (i.e., every scroll page),
			// destroying 50+ chip subscriptions and rebuilding them.
			const namesSame = newColumnNames.length === cachedColumnNames.length
				&& newColumnNames.every((n, i) => n === cachedColumnNames[i]);
			cachedColumnNames = newColumnNames;
			if (!namesSame) {
				renderHeader(cachedColumnNames);
			}
		}

		const totalRows = insp.window.total ?? (insp.window.offset + cachedRowCount);
		if (totalRows === 0) {
			setPlaceholder(
				Object.keys(insp.filters).length > 0
					? 'No rows match the current filters.'
					: 'Empty dataset.',
			);
			return;
		}

		setPlaceholder(null);
		spacer.style.height = `${totalRows * ROW_HEIGHT}px`;

		// Audit B-2/B-3 (2026-05-11): candlestick uses ohlcv.time, pie
		// uses color.field. Use the routing helper so selection sync
		// works for all 9 chart types, not just those with an x channel.
		let xField = selectionFieldForSpec(state.spec.current);
		// Audit B-1 (2026-05-11): if the chart's xField is a transform-
		// derived alias (e.g., `day` from `date_trunc('day', ts) AS day`),
		// it won't exist in the raw preview rows. Detect that case by
		// checking the schema's column list and degrade to no-op
		// highlight (rather than silently never matching). xField that
		// IS in the schema continues to work.
		if (xField !== null && schema !== null
			&& !schema.columns.some(c => c.name === xField)) {
			xField = null;
		}
		if (cachedColumns !== null) {
			renderVisibleRows(
				cachedColumns, cachedColumnNames,
				cachedRowCount, insp.window.offset,
				body.scrollTop, body.clientHeight,
				insp.selection, xField,
			);
		}
	};

	const onScroll = (): void => {
		const offset = Math.max(0, Math.floor(body.scrollTop / ROW_HEIGHT));
		const currentOffset = store.getState().inspector.scrollOffset;
		if (offset !== currentOffset) {
			store.dispatch({ type: 'setScrollOffset', offset });
		}
		// Re-render visible rows even if offset didn't change — the
		// scrollbar can move within the same row index when rounding.
		update();
	};

	const onClick = (e: MouseEvent): void => {
		const target = e.target instanceof Element ? e.target : null;
		const rowEl = target?.closest('.qviz-inspector-row') as HTMLDivElement | null;
		if (!rowEl) { return; }
		dispatchRowClick(rowEl);
	};
	const dispatchRowClick = (rowEl: HTMLDivElement): void => {
		const localIdx = Number(rowEl.dataset.localIdx);
		if (!Number.isInteger(localIdx) || cachedColumns === null) { return; }
		const row: Record<string, unknown> = {};
		for (const colName of cachedColumnNames) {
			const col = cachedColumns[colName];
			row[colName] = col !== undefined ? (col as ArrayLike<unknown>)[localIdx] : undefined;
		}
		opts.onRowClick?.(localIdx, row);
	};
	// Audit M-41 (2026-05-11): keyboard activation. Enter/Space on a
	// focused row selects it.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Enter' && e.key !== ' ') { return; }
		const target = e.target instanceof Element ? e.target : null;
		const rowEl = target?.closest('.qviz-inspector-row') as HTMLDivElement | null;
		if (!rowEl) { return; }
		e.preventDefault();
		dispatchRowClick(rowEl);
	};

	body.addEventListener('scroll', onScroll, { passive: true });
	body.addEventListener('click', onClick);
	body.addEventListener('keydown', onKeyDown);

	const unsubscribe = store.subscribe(update);
	update();

	return {
		dispose() {
			body.removeEventListener('scroll', onScroll);
			body.removeEventListener('click', onClick);
			body.removeEventListener('keydown', onKeyDown);
			disposeFilterHandles();
			unsubscribe();
			root.classList.remove('qviz-inspector-table');
			root.innerHTML = '';
		},
	};
}

/** Exposed for unit tests so they can pin the constants. */
export const __TEST_ONLY__ = { ROW_HEIGHT, OVERSCAN };
