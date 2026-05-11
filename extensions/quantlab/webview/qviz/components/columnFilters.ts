/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * columnFilters — Phase 6 step 6.D.
 *
 * Renders a per-column filter widget for the inspector table's header
 * cells. Picks the widget kind based on the daemon-reported column
 * stats:
 *
 *   numeric / temporal  -> range slider (min + max number inputs)
 *   string (high-card)  -> text "contains" input (case-insensitive)
 *   nominal / low-card  -> checkbox list of distinct values
 *
 * Behavior:
 *
 *   - Each header cell renders a small "filter" icon that pops the
 *     widget below the cell on click. Active filters show a filled
 *     icon and a value summary.
 *   - First open of any widget for a column dispatches
 *     `requestColumnStats` if the stats aren't cached. The widget
 *     shows a "loading…" placeholder until `columnStatsReceived`
 *     lands.
 *   - Widget edits dispatch `setColumnFilter(col, filter)` (or
 *     `setColumnFilter(col, null)` to clear). The reducer invalidates
 *     the inspector window + resets scroll; `qviz-spec/index.ts`
 *     re-fetches the table window AND the chart aggregate with the
 *     new filter prefix.
 */

import type { QvizStore } from '../state/store';
import type {
	ColumnStats, InspectorFilter,
} from '../../../src/qviz/messageProtocol';
import { PROTOCOL_VERSION } from '../../../src/qviz/messageProtocol';

/** Acquire-once handle for posting messages back to the provider. */
interface VsCodeBridge {
	postMessage(value: unknown): void;
}

/** Audit M-29 (2026-05-11): the dispatch layer in qviz-spec/index.ts
 *  owns column-stats request-id tracking so out-of-order responses can
 *  be dropped. The column filter widget calls THIS helper to register
 *  the outbound request and obtain the matching id. */
let requestIdCounter = 1000;
function nextRequestId(): number {
	requestIdCounter += 1;
	return requestIdCounter;
}

export interface ColumnFiltersHandle {
	dispose(): void;
}

export interface ColumnFiltersOptions {
	readonly vscode: VsCodeBridge;
	/** Audit M-29 (2026-05-11): the dispatch layer in qviz-spec/index.ts
	 *  registers the outbound request id per column so it can drop
	 *  stale responses. The widget calls this AFTER `nextRequestId` and
	 *  BEFORE posting. */
	readonly registerColumnStatsRequest?: (column: string, requestId: number) => void;
}

/** Mount a filter chip on a given header cell. Returns a per-cell
 *  handle so the inspector table can dispose them when the schema
 *  reorders columns. */
export function mountColumnFilter(
	cellRoot: HTMLElement,
	column: string,
	store: QvizStore,
	opts: ColumnFiltersOptions,
): ColumnFiltersHandle {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'qviz-col-filter-btn';
	button.setAttribute('aria-label', `Filter column ${column}`);
	button.setAttribute('aria-haspopup', 'true');
	button.textContent = '⏷';
	cellRoot.appendChild(button);

	let popup: HTMLElement | null = null;

	const requestStatsIfNeeded = (): void => {
		const state = store.getState();
		const entry = state.inspector.statsCache[column];
		if (entry?.status === 'ready' || entry?.status === 'pending') { return; }
		// Audit Minor (2026-05-11): dispatch a `columnStatsRequested`
		// action so the cache slot is marked pending immediately. The
		// widget renders the spinner from that slot, and a duplicate
		// open of the same column doesn't re-fire requestColumnStats.
		store.dispatch({ type: 'columnStatsRequested', column });
		const requestId = nextRequestId();
		// Audit M-29 (2026-05-11): register the outbound request so the
		// dispatch layer can drop out-of-order responses.
		opts.registerColumnStatsRequest?.(column, requestId);
		opts.vscode.postMessage({
			type: 'requestColumnStats',
			protocolVersion: PROTOCOL_VERSION,
			requestId,
			column,
		});
	};

	const closePopup = (): void => {
		if (popup === null) { return; }
		// Audit M-K (2026-05-11): always run the popup's cleanup before
		// removing it. Without this, the store subscription + the
		// document mousedown listener installed in openPopup leaked on
		// every open→close cycle (close path used by both the button
		// toggle AND the click-outside handler).
		const popupEl = popup as HTMLElement & { _qvizCleanup?: () => void };
		try { popupEl._qvizCleanup?.(); } catch { /* cleanup must not block teardown */ }
		popupEl._qvizCleanup = undefined;
		popup.remove();
		popup = null;
		button.setAttribute('aria-expanded', 'false');
	};

	const renderPopupBody = (
		popupEl: HTMLElement, stats: ColumnStats, current: InspectorFilter | undefined,
	): void => {
		popupEl.innerHTML = '';
		const dispatchFilter = (f: InspectorFilter | null): void => {
			store.dispatch({ type: 'setColumnFilter', column, filter: f });
		};

		// --- numeric / temporal: range slider ---
		if (stats.kind === 'numeric' || stats.kind === 'temporal') {
			const wrap = document.createElement('div');
			wrap.className = 'qviz-col-filter-range';
			const isNumeric = stats.kind === 'numeric';
			const rawMin = stats.min;
			const rawMax = stats.max;
			if (rawMin === undefined || rawMax === undefined) {
				wrap.textContent = 'No data range available.';
				popupEl.appendChild(wrap);
				return;
			}

			const currentMin = current?.kind === 'range' ? current.min : null;
			const currentMax = current?.kind === 'range' ? current.max : null;

			const minInput = document.createElement('input');
			minInput.type = isNumeric ? 'number' : 'text';
			minInput.className = 'qviz-form-input';
			minInput.value = String(currentMin ?? rawMin);
			minInput.placeholder = `min: ${String(rawMin)}`;

			const maxInput = document.createElement('input');
			maxInput.type = isNumeric ? 'number' : 'text';
			maxInput.className = 'qviz-form-input';
			maxInput.value = String(currentMax ?? rawMax);
			maxInput.placeholder = `max: ${String(rawMax)}`;

			const apply = (): void => {
				const mn = isNumeric ? Number(minInput.value) : minInput.value;
				const mx = isNumeric ? Number(maxInput.value) : maxInput.value;
				const minValid = isNumeric
					? (Number.isFinite(mn) ? mn : null)
					: (typeof mn === 'string' && mn.length > 0 ? mn : null);
				const maxValid = isNumeric
					? (Number.isFinite(mx) ? mx : null)
					: (typeof mx === 'string' && mx.length > 0 ? mx : null);
				if (minValid === null && maxValid === null) {
					dispatchFilter(null);
					return;
				}
				dispatchFilter({
					kind: 'range', column,
					min: minValid as number | string | null,
					max: maxValid as number | string | null,
				});
			};

			minInput.addEventListener('change', apply);
			maxInput.addEventListener('change', apply);

			const fieldRow = (label: string, input: HTMLInputElement): HTMLElement => {
				const row = document.createElement('div');
				row.className = 'qviz-form-row';
				const lab = document.createElement('label');
				lab.className = 'qviz-form-label';
				lab.textContent = label;
				row.append(lab, input);
				return row;
			};

			wrap.append(fieldRow('Min', minInput), fieldRow('Max', maxInput));
			if (current !== undefined) {
				const clear = document.createElement('button');
				clear.type = 'button';
				clear.className = 'qviz-form-remove';
				clear.textContent = 'Clear';
				clear.addEventListener('click', () => dispatchFilter(null));
				wrap.appendChild(clear);
			}
			popupEl.appendChild(wrap);
			return;
		}

		// --- string (high-cardinality) and bool fallthrough: text contains ---
		if (stats.kind === 'string' && !stats.cardinalityIsExact) {
			const wrap = document.createElement('div');
			wrap.className = 'qviz-col-filter-text';
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'qviz-form-input';
			input.placeholder = 'contains…';
			input.value = current?.kind === 'text' ? current.contains : '';
			let debounce: ReturnType<typeof setTimeout> | null = null;
			input.addEventListener('input', () => {
				if (debounce !== null) { clearTimeout(debounce); }
				debounce = setTimeout(() => {
					const v = input.value;
					if (v.length === 0) {
						dispatchFilter(null);
					} else {
						dispatchFilter({ kind: 'text', column, contains: v });
					}
				}, 300);
			});
			wrap.appendChild(input);
			popupEl.appendChild(wrap);
			return;
		}

		// --- low-cardinality nominal / bool / string with <= CAP distinct: checkbox set ---
		const wrap = document.createElement('div');
		wrap.className = 'qviz-col-filter-set';
		const distinct = stats.distinct ?? [];
		const currentSet = new Set<string | number | boolean>(
			current?.kind === 'set' ? current.includes : distinct as (string | number | boolean)[],
		);
		const startWithAllChecked = current?.kind !== 'set';
		if (startWithAllChecked) {
			currentSet.clear();
			for (const v of distinct) {
				if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
					currentSet.add(v);
				}
			}
		}
		const updateFilter = (): void => {
			const arr = Array.from(currentSet);
			if (arr.length === distinct.length) {
				// All checked == no filter; clear.
				dispatchFilter(null);
			} else {
				dispatchFilter({ kind: 'set', column, includes: arr });
			}
		};
		for (const v of distinct) {
			const id = `qviz-filter-${column}-${String(v)}`;
			const row = document.createElement('label');
			row.className = 'qviz-col-filter-set-row';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.id = id;
			const scalar = (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? v : String(v);
			cb.checked = currentSet.has(scalar);
			cb.addEventListener('change', () => {
				if (cb.checked) { currentSet.add(scalar); } else { currentSet.delete(scalar); }
				updateFilter();
			});
			const labelText = document.createElement('span');
			labelText.textContent = v === null ? '(null)' : String(v);
			row.append(cb, labelText);
			wrap.appendChild(row);
		}
		popupEl.appendChild(wrap);
	};

	const openPopup = (): void => {
		closePopup();
		requestStatsIfNeeded();
		const popupEl = document.createElement('div');
		popupEl.className = 'qviz-col-filter-popup';
		// Audit Codex MINOR (2026-05-11): the popup isn't modal —
		// background interaction stays live, no focus trap. `role="dialog"
		// aria-modal=false` is misleading (SR announces "dialog" but the
		// dialog contract is broken). `role="group"` accurately describes
		// the popup as a labelled container with related form controls.
		popupEl.setAttribute('role', 'group');
		popupEl.setAttribute('aria-label', `Filter ${column}`);
		popupEl.style.position = 'fixed';
		document.body.appendChild(popupEl);
		popup = popupEl;
		// Audit M-39 (2026-05-11): Esc inside the popup closes it +
		// restores focus to the chip; otherwise Esc bubbles up to the
		// global Esc handler which clears the inspector selection.
		const onPopupKey = (e: KeyboardEvent): void => {
			if (e.key !== 'Escape') { return; }
			e.stopPropagation();
			e.preventDefault();
			closePopup();
			button.focus();
		};
		popupEl.addEventListener('keydown', onPopupKey);
		// Audit Minor (2026-05-11): clamp the popup position so it
		// doesn't render past the viewport edges on narrow screens or
		// for columns near the right edge of the inspector. We measure
		// the popup AFTER appending so layout has run, then nudge
		// top/left to keep it on-screen with an 8px margin.
		const rect = button.getBoundingClientRect();
		const popupRect = popupEl.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const MARGIN = 8;
		let top = rect.bottom + 2;
		let left = rect.left;
		// Bias to the LEFT of the button when the right edge would clip.
		if (left + popupRect.width + MARGIN > vw) {
			left = Math.max(MARGIN, rect.right - popupRect.width);
		}
		// Flip ABOVE the button when the bottom would clip.
		if (top + popupRect.height + MARGIN > vh) {
			const above = rect.top - popupRect.height - 2;
			top = above >= MARGIN ? above : Math.max(MARGIN, vh - popupRect.height - MARGIN);
		}
		popupEl.style.top = `${Math.round(top)}px`;
		popupEl.style.left = `${Math.round(left)}px`;
		button.setAttribute('aria-expanded', 'true');

		const render = (): void => {
			const state = store.getState();
			const entry = state.inspector.statsCache[column];
			if (!entry || entry.status === 'pending') {
				popupEl.innerHTML = '<div class="qviz-col-filter-loading">Loading column stats…</div>';
				return;
			}
			if (entry.status === 'error') {
				popupEl.innerHTML = '';
				const div = document.createElement('div');
				div.className = 'qviz-col-filter-error';
				div.textContent = `Could not load stats: ${entry.error ?? 'unknown error'}`;
				popupEl.appendChild(div);
				return;
			}
			const stats = entry.stats!;
			const current = state.inspector.filters[column];
			renderPopupBody(popupEl, stats, current);
		};
		render();
		// Audit M-39: focus the first interactive element AFTER render
		// so SR users + keyboard users land inside the popup. We poll
		// once on next paint to wait for the lazy stats fetch.
		queueMicrotask(() => {
			popupEl.querySelector<HTMLInputElement>('input')?.focus();
		});
		const off = store.subscribe(render);
		const onDocClick = (e: MouseEvent): void => {
			if (popup === null) { return; }
			const target = e.target instanceof Node ? e.target : null;
			if (target && (popup.contains(target) || button.contains(target))) { return; }
			// closePopup runs the cleanup; we don't manually `off()` /
			// removeEventListener here.
			closePopup();
		};
		document.addEventListener('mousedown', onDocClick, true);
		// Stash the cleanup on the popup element so closePopup picks it
		// up regardless of who called it (button toggle, outside click,
		// dispose).
		(popupEl as HTMLElement & { _qvizCleanup?: () => void })._qvizCleanup = () => {
			off();
			document.removeEventListener('mousedown', onDocClick, true);
			popupEl.removeEventListener('keydown', onPopupKey);
		};
	};

	const onClick = (e: MouseEvent): void => {
		e.stopPropagation();
		if (popup !== null) {
			closePopup();
			return;
		}
		openPopup();
	};
	button.addEventListener('click', onClick);

	// Refresh the button's active-state visual whenever filters change.
	const buttonRefresh = (): void => {
		const f = store.getState().inspector.filters[column];
		const active = f !== undefined;
		button.classList.toggle('qviz-col-filter-btn--active', active);
		// Audit M-43/Codex-minor (2026-05-11): non-color cue (glyph
		// changes from `⏷` to `⏷•`) AND aria-pressed for SR users.
		button.textContent = active ? '⏷•' : '⏷';
		button.setAttribute('aria-pressed', String(active));
		button.setAttribute('aria-label',
			active ? `Filter column ${column} (active)` : `Filter column ${column}`);
	};
	const unsubscribeBtn = store.subscribe(buttonRefresh);
	buttonRefresh();

	return {
		dispose() {
			button.removeEventListener('click', onClick);
			closePopup();
			unsubscribeBtn();
			button.remove();
		},
	};
}
