/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * columnPanel — Phase 5 step 5.D.1.
 *
 * Renders the data file's column list with a type icon per column.
 * Keyboard-driven for Step D (drag-and-drop arrives in Step F):
 * clicking a column or pressing Enter on a focused row opens a small
 * "Assign to..." menu listing the available encoding channels for the
 * current chart type. Selecting a channel dispatches `setEncoding`.
 *
 * Display:
 *   - Type icon (temporal / quantitative / nominal) — uses small SVG.
 *   - Column name.
 *   - "missing" badge when the field is in `schema.missingFields`.
 *
 * Focus management: `state.ui.focusedColumn` drives which row carries
 * `aria-current="true"`. Clicking dispatches `focusColumn`.
 */

import type { QvizStore } from '../state/store';
import type { SchemaColumn } from '../../../src/qviz/messageProtocol';
import type { OhlcvEncoding } from '../../../src/qviz/spec';
import { classifyColumn, type ClassifiedColumnType } from '../../../src/qviz/defaults';
import {
	type RegularChannel,
	CHANNEL_LABELS,
	channelsForChartType,
	isChannelRequired,
} from '../../../src/qviz/chartChannels';
import { DRAG_COLUMN_MIME, encodeDragPayload } from './encodingShelf';

/** OHLCV slot keys offered when chart type is candlestick. */
const OHLCV_SLOT_KEYS: readonly { key: keyof OhlcvEncoding; label: string }[] = [
	{ key: 'time', label: 'OHLCV: time' },
	{ key: 'open', label: 'OHLCV: open' },
	{ key: 'high', label: 'OHLCV: high' },
	{ key: 'low', label: 'OHLCV: low' },
	{ key: 'close', label: 'OHLCV: close' },
	{ key: 'volume', label: 'OHLCV: volume (optional)' },
];

function typeIcon(t: ClassifiedColumnType): string {
	// Inline SVG; CSS class lets the theme adapter color these.
	switch (t) {
		case 'temporal':
			return '<svg class="qviz-col-icon" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor"/><line x1="5" y1="5" x2="5" y2="2" stroke="currentColor"/><line x1="5" y1="5" x2="7" y2="5" stroke="currentColor"/></svg>';
		case 'quantitative':
			return '<svg class="qviz-col-icon" viewBox="0 0 10 10" aria-hidden="true"><polyline points="1,8 4,4 7,6 9,2" fill="none" stroke="currentColor"/></svg>';
		case 'ordinal':
		case 'nominal':
		default:
			return '<svg class="qviz-col-icon" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor"/></svg>';
	}
}

interface ColumnRow {
	readonly button: HTMLButtonElement;
	readonly column: SchemaColumn;
	readonly type: ClassifiedColumnType;
}

export function mountColumnPanel(root: HTMLElement, store: QvizStore): { dispose(): void } {
	root.classList.add('qviz-column-panel');
	root.innerHTML = `
		<h2 class="qviz-column-panel-title">Columns</h2>
		<ul class="qviz-column-list" role="listbox" aria-label="Available columns"></ul>
		<div class="qviz-column-empty" hidden>No schema loaded yet.</div>
	`;
	const list = root.querySelector<HTMLUListElement>('.qviz-column-list')!;
	const empty = root.querySelector<HTMLElement>('.qviz-column-empty')!;

	let rows: ColumnRow[] = [];
	let openMenu: HTMLElement | null = null;

	const closeMenu = (): void => {
		if (openMenu !== null) {
			openMenu.remove();
			openMenu = null;
		}
	};

	const openAssignMenu = (row: ColumnRow): void => {
		closeMenu();
		const menu = document.createElement('div');
		menu.className = 'qviz-assign-menu';
		menu.setAttribute('role', 'menu');
		const header = document.createElement('div');
		header.className = 'qviz-assign-menu-header';
		header.textContent = `Assign "${row.column.name}" to…`;
		menu.appendChild(header);

		const chartType = store.getState().spec.current?.chart.type ?? null;
		if (chartType === 'candlestick') {
			// Step 5.F.2: OHLCV slot menu instead of regular channels.
			for (const slot of OHLCV_SLOT_KEYS) {
				const btn = makeMenuItem(slot.label, () => {
					patchOhlcv(store, slot.key, row.column.name);
					closeMenu();
				});
				menu.appendChild(btn);
			}
		} else if (chartType !== null) {
			// Step 5.F.1: chart-type-aware channel menu.
			const channels = channelsForChartType(chartType);
			for (const ch of channels) {
				const required = isChannelRequired(chartType, ch);
				const label = `${CHANNEL_LABELS[ch]}${required ? ' *' : ''}`;
				const btn = makeMenuItem(label, () => {
					const encoding = {
						field: row.column.name,
						type: row.type === 'ordinal' ? 'ordinal' : row.type,
					} as const;
					store.dispatch({ type: 'setEncoding', channel: ch as RegularChannel, encoding });
					closeMenu();
				});
				menu.appendChild(btn);
			}
		} else {
			const note = document.createElement('div');
			note.className = 'qviz-assign-menu-empty';
			note.textContent = 'No chart loaded.';
			menu.appendChild(note);
		}

		const clear = makeMenuItem('Cancel', closeMenu);
		clear.classList.add('qviz-assign-menu-clear');
		menu.appendChild(clear);

		// Position relative to the column button.
		const rect = row.button.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = `${rect.bottom + 4}px`;
		menu.style.left = `${rect.left}px`;
		document.body.appendChild(menu);
		openMenu = menu;
		// Focus first item for keyboard nav.
		menu.querySelector<HTMLButtonElement>('.qviz-assign-menu-item')?.focus();
	};

	function makeMenuItem(label: string, onClick: () => void): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'qviz-assign-menu-item';
		btn.setAttribute('role', 'menuitem');
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		return btn;
	}

	// Close menu on Escape / click-outside.
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') { closeMenu(); }
	};
	const onClickOutside = (e: MouseEvent): void => {
		if (openMenu !== null && !openMenu.contains(e.target as Node)) {
			closeMenu();
		}
	};
	document.addEventListener('keydown', onKey);
	document.addEventListener('click', onClickOutside, true);

	const renderColumns = (): void => {
		const state = store.getState();
		const info = state.schema.info;
		list.innerHTML = '';
		rows = [];
		if (info === null) {
			empty.hidden = false;
			return;
		}
		empty.hidden = true;
		const missing = new Set(state.schema.missingFields);
		for (const col of info.columns) {
			const type = classifyColumn(col);
			const li = document.createElement('li');
			li.setAttribute('role', 'option');
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'qviz-column-row';
			button.dataset.column = col.name;
			const isMissing = missing.has(col.name);
			if (isMissing) {
				button.classList.add('qviz-column-row--missing');
			}
			button.innerHTML = `
				${typeIcon(type)}
				<span class="qviz-column-name">${escapeHtml(col.name)}</span>
				<span class="qviz-column-dtype">${escapeHtml(col.dtype)}</span>
				${isMissing ? '<span class="qviz-column-badge" role="status">missing</span>' : ''}
			`;
			const row: ColumnRow = { button, column: col, type };
			button.addEventListener('click', () => {
				store.dispatch({ type: 'focusColumn', columnName: col.name });
				openAssignMenu(row);
			});
			button.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					openAssignMenu(row);
				}
			});
			// Step 5.F.3: HTML5 drag source.
			button.draggable = true;
			button.addEventListener('dragstart', (e) => {
				if (!e.dataTransfer) { return; }
				const encType = type === 'ordinal' ? 'ordinal' : type;
				e.dataTransfer.setData(
					DRAG_COLUMN_MIME, encodeDragPayload(col.name, encType),
				);
				e.dataTransfer.effectAllowed = 'copy';
				button.classList.add('qviz-column-row--dragging');
			});
			button.addEventListener('dragend', () => {
				button.classList.remove('qviz-column-row--dragging');
			});
			li.appendChild(button);
			list.appendChild(li);
			rows.push(row);
		}
	};

	const renderFocus = (): void => {
		const focused = store.getState().ui.focusedColumn;
		for (const row of rows) {
			const active = row.column.name === focused;
			row.button.setAttribute('aria-current', String(active));
			row.button.classList.toggle('qviz-column-row--focused', active);
		}
	};

	let lastSchemaInfoHash: string | null = null;
	const onStateChange = (): void => {
		const state = store.getState();
		const newHash = state.schema.info?.schema_hash ?? null;
		const newMissingKey = state.schema.missingFields.join(',');
		const composite = `${newHash}|${newMissingKey}`;
		if (composite !== lastSchemaInfoHash) {
			lastSchemaInfoHash = composite;
			renderColumns();
		}
		renderFocus();
	};

	const off = store.subscribe(onStateChange);
	onStateChange();

	return {
		dispose: () => {
			off();
			closeMenu();
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('click', onClickOutside, true);
			root.innerHTML = '';
			root.classList.remove('qviz-column-panel');
		},
	};
}

function escapeHtml(s: string): string {
	const div = document.createElement('div');
	div.textContent = s;
	return div.innerHTML;
}

/** Patch a single OHLCV slot. Mirrors encodingShelf's applyOhlcvUpdate;
 *  duplicated here to avoid a circular component dependency. */
function patchOhlcv(
	store: QvizStore, slot: keyof OhlcvEncoding, value: string,
): void {
	const current = store.getState().spec.current?.chart.encodings.ohlcv;
	const base: { -readonly [K in keyof OhlcvEncoding]?: OhlcvEncoding[K] } = current
		? { ...current }
		: { time: '', open: '', high: '', low: '', close: '' };
	base[slot] = value;
	store.dispatch({ type: 'setOhlcv', ohlcv: base as OhlcvEncoding });
}
