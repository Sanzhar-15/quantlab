/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Market header for the chart webview's DATA mode (server-symbol tabs).
 *
 * One chrome row replacing the strategy toolbar: the symbol switcher (the
 * existing data-source dropdown is MOVED into the identity slot), last price,
 * change chip, as-of date, range presets, and the refresh/fullscreen actions
 * (also moved in from the strategy toolbar so there is exactly one set).
 *
 * Range presets anchor to the LAST BAR's timestamp, not wall-clock now -- the
 * server's ingested history can end days/weeks in the past, and a wall-clock
 * "1M" window past the data's right edge would render an empty chart.
 */

import type { OhlcvBar } from './chartApi';

const DAY_MS = 24 * 60 * 60 * 1000;

interface PresetDef {
	id: string;
	label: string;
	/** Span back from the anchor; null = special handling (YTD/All). */
	days: number | null;
}

const PRESETS: PresetDef[] = [
	{ id: '1m', label: '1M', days: 30 },
	{ id: '3m', label: '3M', days: 91 },
	{ id: '6m', label: '6M', days: 182 },
	{ id: 'ytd', label: 'YTD', days: null },
	{ id: '1y', label: '1Y', days: 365 },
	{ id: '5y', label: '5Y', days: 5 * 365 },
	{ id: 'all', label: 'All', days: null },
];

export interface MarketHeader {
	readonly root: HTMLElement;
	/** Slot the data-source dropdown container is moved into for data mode. */
	readonly identitySlot: HTMLElement;
	/** Slot the refresh/fullscreen buttons are moved into for data mode. */
	readonly actionsSlot: HTMLElement;
	setSource(symbol: string | undefined, displayName: string | undefined, assetClass?: string): void;
	setTimeframe(timeframe: string | undefined): void;
	updateFromBars(bars: OhlcvBar[]): void;
}

export function createMarketHeader(
	postMessage: (message: unknown) => void
): MarketHeader {
	const root = document.createElement('div');
	root.className = 'market-header';

	const identitySlot = document.createElement('div');
	identitySlot.className = 'mh-identity';

	const ticker = document.createElement('span');
	ticker.className = 'mh-ticker';

	const quote = document.createElement('div');
	quote.className = 'mh-quote';

	const price = document.createElement('span');
	price.className = 'mh-price';

	const change = document.createElement('span');
	change.className = 'mh-change';

	quote.append(price, change);

	const meta = document.createElement('span');
	meta.className = 'mh-meta';

	const spacer = document.createElement('div');
	spacer.className = 'spacer';

	const presetGroup = document.createElement('div');
	presetGroup.className = 'mh-presets';
	presetGroup.setAttribute('role', 'group');
	presetGroup.setAttribute('aria-label', 'Date range');

	const actionsSlot = document.createElement('div');
	actionsSlot.className = 'mh-actions';

	let anchorT: number | undefined;
	// Earliest bar EVER seen for the current symbol -- a narrow preset load
	// (e.g. 1M) must not shrink the known history extent, or the longer
	// presets would wrongly hide after the first preset click.
	let earliestT: number | undefined;
	let timeframe = '1D';
	let currentSymbol: string | undefined;
	const presetButtons = new Map<string, HTMLButtonElement>();

	const setActive = (id: string | null) => {
		for (const [pid, btn] of presetButtons) {
			btn.classList.toggle('active', pid === id);
		}
	};

	const toIsoDate = (t: number): string => new Date(t).toISOString().slice(0, 10);

	const applyPreset = (preset: PresetDef) => {
		if (anchorT === undefined) {
			return; // disabled until bars arrive
		}

		if (preset.id === 'all') {
			// Clear the override -> the host falls back to its widest default window.
			postMessage({ type: 'overrideDateRange', range: undefined });
			setActive('all');
			return;
		}

		// End one day past the anchor so the last bar is inside the window.
		const end = anchorT + DAY_MS;
		let start: number;
		if (preset.id === 'ytd') {
			start = Date.UTC(new Date(anchorT).getUTCFullYear(), 0, 1);
		} else if (preset.days !== null) {
			start = anchorT - preset.days * DAY_MS;
		} else {
			return;
		}

		postMessage({
			type: 'overrideDateRange',
			range: { start: toIsoDate(start), end: toIsoDate(end) }
		});
		setActive(preset.id);
	};

	for (const preset of PRESETS) {
		const btn = document.createElement('button');
		btn.className = 'mh-preset';
		btn.textContent = preset.label;
		btn.disabled = true;
		btn.addEventListener('click', () => applyPreset(preset));
		presetButtons.set(preset.id, btn);
		presetGroup.appendChild(btn);
	}

	root.append(identitySlot, ticker, quote, meta, spacer, presetGroup, actionsSlot);

	const formatPrice = (value: number): string => {
		const abs = Math.abs(value);
		const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
		return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
	};

	const formatAsOf = (t: number): string =>
		new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

	return {
		root,
		identitySlot,
		actionsSlot,
		setSource(symbol, displayName, assetClass) {
			// The moved-in data-source dropdown shows the display name; only
			// repeat the raw ticker when it adds information.
			const tickerVisible = Boolean(symbol) && symbol !== displayName;
			ticker.textContent = tickerVisible ? symbol ?? '' : '';
			ticker.style.display = tickerVisible ? '' : 'none';
			ticker.title = displayName ?? '';
			// The crypto bars endpoint ignores from/to windows (DataService
			// routes crypto to a single no-range fetch) -- presets would be
			// silent no-ops, so hide the control entirely for crypto.
			presetGroup.style.display = assetClass?.toLowerCase() === 'crypto' ? 'none' : '';

			// Toolbar refreshes fire after every data load; only a SYMBOL
			// change resets the quote/extent state (a same-symbol refresh
			// arriving after updateFromBars must not wipe the rendered quote).
			if (symbol === currentSymbol) {
				return;
			}
			currentSymbol = symbol;
			price.textContent = '';
			change.textContent = '';
			change.classList.remove('up', 'down');
			meta.textContent = '';
			anchorT = undefined;
			earliestT = undefined;
			setActive(null);
			for (const btn of presetButtons.values()) {
				btn.disabled = true;
			}
		},
		setTimeframe(tf) {
			if (tf) {
				timeframe = tf;
			}
		},
		updateFromBars(bars) {
			if (!bars.length) {
				return;
			}
			const last = bars[bars.length - 1];
			const prev = bars.length > 1 ? bars[bars.length - 2] : undefined;
			anchorT = anchorT === undefined ? last.t : Math.max(anchorT, last.t);
			earliestT = earliestT === undefined ? bars[0].t : Math.min(earliestT, bars[0].t);

			price.textContent = formatPrice(last.c);

			if (prev && prev.c !== 0) {
				const delta = last.c - prev.c;
				const pct = (delta / prev.c) * 100;
				const sign = delta >= 0 ? '+' : '';
				change.textContent = `${sign}${formatPrice(delta)} (${sign}${pct.toFixed(2)}%)`;
				change.classList.toggle('up', delta >= 0);
				change.classList.toggle('down', delta < 0);
			} else {
				change.textContent = '';
				change.classList.remove('up', 'down');
			}

			meta.textContent = `${timeframe} · as of ${formatAsOf(last.t)}`;

			for (const btn of presetButtons.values()) {
				btn.disabled = false;
			}
			// Hide presets whose span exceeds the available history (they would
			// all render the identical full-history chart).
			if (earliestT !== undefined && anchorT !== undefined) {
				const historyDays = (anchorT - earliestT) / DAY_MS;
				for (const preset of PRESETS) {
					const btn = presetButtons.get(preset.id);
					if (btn && preset.days !== null) {
						btn.classList.toggle('mh-preset-hidden', preset.days > historyDays + 31);
					}
				}
			}
		},
	};
}
