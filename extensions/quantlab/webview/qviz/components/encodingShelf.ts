/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * encodingShelf -- Phase 5 steps 5.D.3 + 5.F.1 + 5.F.2 + 5.F.3.
 *
 * Renders the encoding-assignment shelves for the current chart type.
 * Drives off `chartChannels.ts` so the UI's available channels always
 * match the validator's per-chart-type requirements (no UI/validator
 * drift).
 *
 * Three behaviors layered on top of Step D's shelves:
 *   - 5.F.1: dynamic shelf set per chart type (x/y/y2/color/size/shape/
 *     facet_row/facet_col). Required shelves are marked with an
 *     asterisk and a "(required)" badge.
 *   - 5.F.2: when chart type is `candlestick`, the regular shelves are
 *     replaced with a single OHLCV cluster shelf (time/open/high/low/
 *     close/volume) that dispatches the `setOhlcv` action.
 *   - 5.F.3: HTML5 drop targets on every shelf. The column panel sets
 *     `dataTransfer` with the column name + classified encoding type;
 *     `drop` here dispatches `setEncoding` (or `setOhlcv` for the
 *     ohlcv cluster).
 *
 * Mount returns a stable handle; the component re-renders its internal
 * structure when chart type changes (e.g., switching to/from
 * candlestick swaps shelf shapes). Subscribers external to this
 * component see no remount.
 */

import type { QvizStore } from '../state/store';
import type { ChartType, OhlcvEncoding, EncodingType } from '../../../src/qviz/spec';
import {
	type RegularChannel,
	CHANNEL_LABELS,
	channelsForChartType,
	isChannelRequired,
} from '../../../src/qviz/chartChannels';

/** Drag payload contract -- must match what columnPanel writes. */
const DRAG_MIME_COLUMN = 'application/qviz-column';

interface DragPayload {
	readonly column: string;
	readonly encodingType: 'temporal' | 'quantitative' | 'nominal' | 'ordinal';
}

export function mountEncodingShelves(root: HTMLElement, store: QvizStore): { dispose(): void } {
	root.classList.add('qviz-encoding-shelves');
	root.setAttribute('aria-label', 'Encoding shelves');

	let renderedChartType: ChartType | null = null;
	let cleanup: (() => void) | null = null;

	const rerender = (): void => {
		const state = store.getState();
		const chartType = state.spec.current?.chart.type ?? null;
		if (chartType === renderedChartType) {
			// Same chart type: shelf set unchanged; let the inner
			// refresh handlers update assignments without remount.
			if (cleanup === null) { return; }
			return;
		}
		// Chart type changed: rebuild the shelf surface from scratch.
		if (cleanup !== null) { cleanup(); cleanup = null; }
		root.innerHTML = '';
		renderedChartType = chartType;
		if (chartType === null) {
			root.innerHTML = '<div class="qviz-shelves-empty">No spec loaded.</div>';
			return;
		}
		if (chartType === 'candlestick') {
			cleanup = mountOhlcvShelf(root, store);
			return;
		}
		cleanup = mountRegularShelves(root, store, chartType);
	};

	const off = store.subscribe(rerender);
	rerender();

	return {
		dispose: () => {
			off();
			if (cleanup !== null) { cleanup(); }
			root.innerHTML = '';
			root.classList.remove('qviz-encoding-shelves');
		},
	};
}

// ---------------------------------------------------------------------------
// Regular shelves (everything except candlestick)
// ---------------------------------------------------------------------------

function mountRegularShelves(
	root: HTMLElement, store: QvizStore, chartType: ChartType,
): () => void {
	const channels = channelsForChartType(chartType);
	const shelves = new Map<RegularChannel, {
		container: HTMLElement;
		fieldEl: HTMLElement;
		clearBtn: HTMLButtonElement;
	}>();

	for (const ch of channels) {
		const required = isChannelRequired(chartType, ch);
		const container = document.createElement('div');
		container.className = 'qviz-shelf';
		container.dataset.channel = ch;
		container.setAttribute('role', 'group');
		container.setAttribute('aria-label', `${CHANNEL_LABELS[ch]}${required ? ' (required)' : ''}`);

		const labelEl = document.createElement('span');
		labelEl.className = 'qviz-shelf-label';
		labelEl.textContent = CHANNEL_LABELS[ch];
		if (required) {
			const star = document.createElement('span');
			star.className = 'qviz-shelf-required';
			star.textContent = '*';
			star.title = 'required';
			labelEl.appendChild(star);
		}

		const fieldEl = document.createElement('span');
		fieldEl.className = 'qviz-shelf-field';
		fieldEl.textContent = '(drop a column or use Assign menu)';

		const clearBtn = document.createElement('button');
		clearBtn.type = 'button';
		clearBtn.className = 'qviz-shelf-clear';
		clearBtn.setAttribute('aria-label', `Clear ${CHANNEL_LABELS[ch]} encoding`);
		clearBtn.textContent = '×';
		clearBtn.hidden = true;
		clearBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			store.dispatch({ type: 'setEncoding', channel: ch, encoding: null });
		});

		container.appendChild(labelEl);
		container.appendChild(fieldEl);
		container.appendChild(clearBtn);

		container.addEventListener('click', (e) => {
			if (e.target !== clearBtn) {
				store.dispatch({ type: 'setActiveShelf', channel: ch });
			}
		});

		// Step 5.F.3: HTML5 drop target.
		attachDropTarget(container, (payload) => {
			store.dispatch({
				type: 'setEncoding',
				channel: ch,
				encoding: { field: payload.column, type: payload.encodingType },
			});
		});

		root.appendChild(container);
		shelves.set(ch, { container, fieldEl, clearBtn });
	}

	const refresh = (): void => {
		const state = store.getState();
		const encodings = state.spec.current?.chart.encodings;
		const active = state.ui.activeShelf;
		for (const [ch, els] of shelves) {
			const enc = encodings?.[ch] ?? null;
			if (enc) {
				els.fieldEl.textContent = enc.field;
				els.fieldEl.setAttribute('data-encoding-type', enc.type);
				els.clearBtn.hidden = false;
				els.container.classList.add('qviz-shelf--assigned');
			} else {
				els.fieldEl.textContent = '(drop a column or use Assign menu)';
				els.fieldEl.removeAttribute('data-encoding-type');
				els.clearBtn.hidden = true;
				els.container.classList.remove('qviz-shelf--assigned');
			}
			els.container.classList.toggle('qviz-shelf--active', active === ch);
			els.container.classList.toggle(
				'qviz-shelf--required-empty',
				isChannelRequired(chartType, ch) && enc === null,
			);
		}
	};
	const off = store.subscribe(refresh);
	refresh();
	return off;
}

// ---------------------------------------------------------------------------
// OHLCV cluster (candlestick) -- Step 5.F.2
// ---------------------------------------------------------------------------

interface OhlcvSlot {
	readonly key: keyof OhlcvEncoding;
	readonly label: string;
	readonly required: boolean;
}

const OHLCV_SLOTS: readonly OhlcvSlot[] = [
	{ key: 'time', label: 'Time', required: true },
	{ key: 'open', label: 'Open', required: true },
	{ key: 'high', label: 'High', required: true },
	{ key: 'low', label: 'Low', required: true },
	{ key: 'close', label: 'Close', required: true },
	{ key: 'volume', label: 'Volume', required: false },
];

function mountOhlcvShelf(root: HTMLElement, store: QvizStore): () => void {
	const cluster = document.createElement('div');
	cluster.className = 'qviz-shelf qviz-shelf--ohlcv';
	cluster.setAttribute('role', 'group');
	cluster.setAttribute('aria-label', 'OHLCV cluster (required for candlestick)');

	const header = document.createElement('div');
	header.className = 'qviz-shelf-ohlcv-header';
	header.textContent = 'OHLCV (candlestick)';
	cluster.appendChild(header);

	const slotElements = new Map<keyof OhlcvEncoding, {
		fieldEl: HTMLElement;
		clearBtn: HTMLButtonElement;
		row: HTMLElement;
	}>();

	for (const slot of OHLCV_SLOTS) {
		const row = document.createElement('div');
		row.className = 'qviz-shelf-ohlcv-row';
		row.dataset.slot = slot.key;
		const labelEl = document.createElement('span');
		labelEl.className = 'qviz-shelf-ohlcv-label';
		labelEl.textContent = slot.label;
		if (slot.required) {
			const star = document.createElement('span');
			star.className = 'qviz-shelf-required';
			star.textContent = '*';
			labelEl.appendChild(star);
		}
		const fieldEl = document.createElement('span');
		fieldEl.className = 'qviz-shelf-field';
		fieldEl.textContent = '(drop a column)';
		const clearBtn = document.createElement('button');
		clearBtn.type = 'button';
		clearBtn.className = 'qviz-shelf-clear';
		clearBtn.textContent = '×';
		clearBtn.hidden = true;
		clearBtn.setAttribute('aria-label', `Clear ${slot.label}`);
		clearBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			applyOhlcvUpdate(store, slot.key, undefined);
		});

		row.appendChild(labelEl);
		row.appendChild(fieldEl);
		row.appendChild(clearBtn);
		cluster.appendChild(row);

		attachDropTarget(row, (payload) => {
			applyOhlcvUpdate(store, slot.key, payload.column);
		});
		slotElements.set(slot.key, { fieldEl, clearBtn, row });
	}

	root.appendChild(cluster);

	const refresh = (): void => {
		const ohlcv = store.getState().spec.current?.chart.encodings.ohlcv;
		for (const slot of OHLCV_SLOTS) {
			const els = slotElements.get(slot.key)!;
			const value = ohlcv?.[slot.key];
			if (typeof value === 'string' && value.length > 0) {
				els.fieldEl.textContent = value;
				els.clearBtn.hidden = false;
				els.row.classList.add('qviz-shelf-ohlcv-row--assigned');
				els.row.classList.remove('qviz-shelf-ohlcv-row--required-empty');
			} else {
				els.fieldEl.textContent = '(drop a column)';
				els.clearBtn.hidden = true;
				els.row.classList.remove('qviz-shelf-ohlcv-row--assigned');
				if (slot.required) {
					els.row.classList.add('qviz-shelf-ohlcv-row--required-empty');
				} else {
					els.row.classList.remove('qviz-shelf-ohlcv-row--required-empty');
				}
			}
		}
	};
	const off = store.subscribe(refresh);
	refresh();
	return off;
}

/** Patch a single OHLCV slot. Builds the next OhlcvEncoding from the
 *  current spec's value (or empty), updates the slot, and dispatches
 *  setOhlcv. If clearing a required slot leaves the cluster invalid,
 *  the reducer's validate (validateEdit indirectly) will reject; we
 *  rely on that rather than re-implementing the check here. */
function applyOhlcvUpdate(
	store: QvizStore, slot: keyof OhlcvEncoding, value: string | undefined,
): void {
	const current = store.getState().spec.current?.chart.encodings.ohlcv;
	// Use a mutable shape (-readonly) for the patch; cast to
	// OhlcvEncoding (which is fully readonly) at dispatch time.
	const base: { -readonly [K in keyof OhlcvEncoding]?: OhlcvEncoding[K] } = current
		? { ...current }
		: { time: '', open: '', high: '', low: '', close: '' };
	if (value === undefined) {
		if (slot === 'volume') {
			delete base.volume;
		} else {
			// Required slot cleared: keep empty string so the type
			// shape remains valid; the validator will flag at save.
			base[slot] = '';
		}
	} else {
		base[slot] = value;
	}
	store.dispatch({ type: 'setOhlcv', ohlcv: base as OhlcvEncoding });
}

// ---------------------------------------------------------------------------
// Drag-and-drop drop-target helper (Step 5.F.3)
// ---------------------------------------------------------------------------

function attachDropTarget(
	el: HTMLElement, onDrop: (payload: DragPayload) => void,
): void {
	el.addEventListener('dragover', (e) => {
		if (!e.dataTransfer) { return; }
		if (Array.from(e.dataTransfer.types).includes(DRAG_MIME_COLUMN)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
			el.classList.add('qviz-shelf--drop-target');
		}
	});
	el.addEventListener('dragleave', () => {
		el.classList.remove('qviz-shelf--drop-target');
	});
	el.addEventListener('drop', (e) => {
		el.classList.remove('qviz-shelf--drop-target');
		if (!e.dataTransfer) { return; }
		const raw = e.dataTransfer.getData(DRAG_MIME_COLUMN);
		if (raw.length === 0) { return; }
		e.preventDefault();
		try {
			const parsed = JSON.parse(raw) as DragPayload;
			if (typeof parsed.column === 'string' && typeof parsed.encodingType === 'string') {
				onDrop(parsed);
			}
		} catch (err) {
			console.warn('encodingShelf: drop payload was not valid JSON:', err);
		}
	});
}

/** Exported for the column panel to use when constructing the drag
 *  payload. Single source of truth for the mime type and shape. */
export const DRAG_COLUMN_MIME = DRAG_MIME_COLUMN;

/** Encode a drag payload -- column panel calls this to populate
 *  dataTransfer. The type alias here keeps the call site symmetric. */
export function encodeDragPayload(column: string, encodingType: EncodingType): string {
	const payload: DragPayload = { column, encodingType };
	return JSON.stringify(payload);
}
