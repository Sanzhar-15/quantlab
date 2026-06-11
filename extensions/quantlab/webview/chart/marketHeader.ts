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
import { formatPrice } from './formatters';

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

interface TimeframeDef {
	/** Client Timeframe id as the host expects it ('1H', not '1h'). */
	id: string;
	label: string;
	/** Sub-day bars: the as-of meta includes the bar's time of day. */
	intraday: boolean;
}

/**
 * Bar-interval switcher options (M30). LIVE SERVER TRUTH (conductor-probed
 * 2026-06-11, not derived from the Timeframe union): equities have bars at
 * 1h/1D/1W/1M ONLY -- 4h and every sub-hour interval return zero bars; the
 * crypto endpoint supports tf=1h/1d and maps sub-hour intervals LOSSILY.
 * Offer exactly what the server can serve, nothing else.
 */
const TIMEFRAMES: TimeframeDef[] = [
	{ id: '1H', label: '1H', intraday: true },
	{ id: '1D', label: '1D', intraday: false },
	{ id: '1W', label: '1W', intraday: false },
	{ id: '1M', label: '1M', intraday: false },
];

const CRYPTO_TIMEFRAME_IDS = new Set(['1H', '1D']);

export interface MarketHeader {
	readonly root: HTMLElement;
	/** Slot the data-source dropdown container is moved into for data mode. */
	readonly identitySlot: HTMLElement;
	/** Slot the refresh/fullscreen buttons are moved into for data mode. */
	readonly actionsSlot: HTMLElement;
	setSource(symbol: string | undefined, displayName: string | undefined, assetClass?: string): void;
	setTimeframe(timeframe: string | undefined): void;
	updateFromBars(bars: OhlcvBar[]): void;
	/**
	 * Reflects the tab's CURRENT date-range override so the matching preset
	 * highlights without a click (W4.4): no override = the host's widest
	 * default window = 'All'; a range posted by a preset keeps that preset
	 * active across toolbar refreshes; any other range clears the highlight.
	 */
	setRange(range: { start: string; end: string } | undefined): void;
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

	const tfGroup = document.createElement('div');
	tfGroup.className = 'mh-timeframes';
	tfGroup.setAttribute('role', 'group');
	tfGroup.setAttribute('aria-label', 'Bar interval');

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
	// Timestamp of the newest bar of the LAST data load -- backs the as-of
	// meta so a timeframe echo can re-render it without waiting for bars.
	let lastBarT: number | undefined;
	let currentSymbol: string | undefined;
	// Last range POSTED by a preset click, so setRange() can keep that preset
	// highlighted when the host echoes the override back via setToolbar.
	let lastPosted: { id: string; range: { start: string; end: string } | undefined } | undefined;
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
			lastPosted = { id: 'all', range: undefined };
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

		const range = { start: toIsoDate(start), end: toIsoDate(end) };
		lastPosted = { id: preset.id, range };
		postMessage({ type: 'overrideDateRange', range });
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

	// --- Bar-interval switcher (M30) ---
	const tfButtons = new Map<string, HTMLButtonElement>();

	const setActiveTimeframe = (id: string) => {
		for (const [tid, btn] of tfButtons) {
			btn.classList.toggle('active', tid === id);
		}
	};

	for (const def of TIMEFRAMES) {
		const btn = document.createElement('button');
		// Distinct class from .mh-preset: shared styling comes from the CSS
		// selector lists, while DOM queries for the range presets stay scoped.
		btn.className = 'mh-tf';
		btn.textContent = def.label;
		btn.disabled = true;
		btn.addEventListener('click', () => {
			// The active class IS the latest intent (optimistic click or host
			// echo) -- guarding on it blocks redundant reloads without
			// mis-blocking a quick revert click during the echo round-trip.
			if (btn.classList.contains('active')) {
				return;
			}
			// Optimistic highlight (mirrors the preset pattern); the host
			// stores the per-tab override and echoes it back via setToolbar
			// -> setTimeframe, which re-asserts the active state.
			postMessage({ type: 'overrideTimeframe', timeframe: def.id });
			setActiveTimeframe(def.id);
		});
		tfButtons.set(def.id, btn);
		tfGroup.appendChild(btn);
	}
	setActiveTimeframe(timeframe);

	root.append(identitySlot, ticker, quote, meta, spacer, tfGroup, presetGroup, actionsSlot);

	const formatAsOf = (t: number): string => {
		const date = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
		// Intraday bars: a bare date under-identifies the bar -- show its time.
		if (TIMEFRAMES.find(def => def.id === timeframe)?.intraday) {
			// hourCycle h23 (not hour12:false): en-US's h24 cycle renders
			// midnight as '24:00'.
			const time = new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
			return `${date} ${time} UTC`;
		}
		return date;
	};

	const renderMeta = () => {
		if (lastBarT === undefined) {
			return;
		}
		meta.textContent = `${timeframe} \u00B7 as of ${formatAsOf(lastBarT)}`;
	};

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
			const isCrypto = assetClass?.toLowerCase() === 'crypto';
			presetGroup.style.display = isCrypto ? 'none' : '';

			// M30: the timeframe switcher needs no anchor bar, so it enables as
			// soon as a symbol exists. Crypto only serves 1h/1d -- hide the rest.
			for (const def of TIMEFRAMES) {
				const btn = tfButtons.get(def.id);
				if (btn) {
					btn.classList.toggle('mh-preset-hidden', isCrypto && !CRYPTO_TIMEFRAME_IDS.has(def.id));
					btn.disabled = !symbol;
				}
			}

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
			lastBarT = undefined;
			setActive(null);
			for (const btn of presetButtons.values()) {
				btn.disabled = true;
			}
		},
		setTimeframe(tf) {
			if (!tf) {
				return;
			}
			timeframe = tf;
			// M30: the host echo (setToolbar after the override is stored) is
			// the source of truth for the active interval -- re-assert it and
			// refresh the as-of meta without waiting for the bar reload.
			setActiveTimeframe(tf);
			renderMeta();
		},
		setRange(range) {
			if (!range) {
				// No override = the host's widest default window ('All').
				setActive('all');
				return;
			}
			if (lastPosted?.range && lastPosted.range.start === range.start && lastPosted.range.end === range.end) {
				setActive(lastPosted.id);
				return;
			}
			// A range this header did not post (e.g. restored from a previous
			// session or set via the strategy date inputs) -- no preset matches.
			setActive(null);
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

			lastBarT = last.t;
			renderMeta();

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
