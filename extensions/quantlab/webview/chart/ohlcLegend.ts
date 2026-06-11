/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Floating OHLC legend (data mode) -- W4.1 of the symbol-chart redesign.
 *
 * A top-left overlay inside #chart-container that tracks the chart's
 * crosshair: ticker + O/H/L/C + change% + volume for the hovered bar,
 * colored green/red by bar direction (close >= open). When no bar is
 * hovered it falls back to the LAST bar, so the legend always shows a
 * live readout once data arrives. Visibility is gated to data mode by
 * CSS (html[data-chart-mode="data"]).
 */

import type { OhlcvBar } from './chartApi';
import { formatCompactVolume, formatPrice } from './formatters';

export interface OhlcLegend {
	readonly root: HTMLElement;
	/** Ticker shown at the head of the legend; undefined hides the legend. */
	setSymbol(symbol: string | undefined): void;
	/** Full bar history backing hover lookups and the last-bar fallback. */
	setBars(bars: OhlcvBar[]): void;
	/** Crosshair bar index, or null to fall back to the last bar. */
	showBar(index: number | null): void;
}

export function createOhlcLegend(): OhlcLegend {
	const root = document.createElement('div');
	root.className = 'ohlc-legend';

	const symbolEl = document.createElement('span');
	symbolEl.className = 'ol-symbol';

	const makeField = (label: string): { field: HTMLElement; value: HTMLElement } => {
		const field = document.createElement('span');
		field.className = 'ol-field';
		const labelEl = document.createElement('span');
		labelEl.className = 'ol-label';
		labelEl.textContent = label;
		const value = document.createElement('span');
		value.className = 'ol-value';
		field.append(labelEl, value);
		return { field, value };
	};

	const open = makeField('O');
	const high = makeField('H');
	const low = makeField('L');
	const close = makeField('C');

	const changeEl = document.createElement('span');
	changeEl.className = 'ol-change';

	const volume = makeField('Vol');

	root.append(symbolEl, open.field, high.field, low.field, close.field, changeEl, volume.field);

	let symbol: string | undefined;
	let bars: OhlcvBar[] = [];

	const render = (index: number | null): void => {
		if (!symbol || !bars.length) {
			root.classList.remove('show');
			return;
		}

		const clamped = index === null
			? bars.length - 1
			: Math.max(0, Math.min(index, bars.length - 1));
		const bar = bars[clamped];
		const prev = clamped > 0 ? bars[clamped - 1] : undefined;

		symbolEl.textContent = symbol;
		open.value.textContent = formatPrice(bar.o);
		high.value.textContent = formatPrice(bar.h);
		low.value.textContent = formatPrice(bar.l);
		close.value.textContent = formatPrice(bar.c);
		volume.field.style.display = typeof bar.v === 'number' ? '' : 'none';
		volume.value.textContent = typeof bar.v === 'number' ? formatCompactVolume(bar.v) : '';

		// Change vs the previous bar's close (the convention TradingView uses).
		if (prev && prev.c !== 0) {
			const delta = bar.c - prev.c;
			const pct = (delta / prev.c) * 100;
			const sign = delta >= 0 ? '+' : '';
			changeEl.textContent = `${sign}${formatPrice(delta)} (${sign}${pct.toFixed(2)}%)`;
			changeEl.style.display = '';
		} else {
			changeEl.textContent = '';
			changeEl.style.display = 'none';
		}

		const up = bar.c >= bar.o;
		root.classList.toggle('up', up);
		root.classList.toggle('down', !up);
		root.classList.add('show');
	};

	return {
		root,
		setSymbol(next) {
			symbol = next;
			if (!next) {
				root.classList.remove('show');
				return;
			}
			render(null);
		},
		setBars(next) {
			bars = next;
			render(null);
		},
		showBar(index) {
			render(index);
		},
	};
}
