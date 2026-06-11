/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared number formatting for the chart webview's market-data surfaces.
 *
 * ONE source of truth so the market header quote, the OHLC legend, and the
 * chart's right price axis all agree on precision (W4.4): 2 decimals for
 * prices >= 1, 4 decimals for sub-dollar prices.
 */

export function formatPrice(value: number): string {
	if (!Number.isFinite(value)) {
		return '';
	}
	const abs = Math.abs(value);
	const digits = abs >= 1 ? 2 : 4;
	return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact volume: 1234 -> "1.2K", 12_345_678 -> "12.3M", 1.2e9 -> "1.2B". */
export function formatCompactVolume(value: number): string {
	if (!Number.isFinite(value)) {
		return '';
	}
	const abs = Math.abs(value);
	if (abs >= 1e9) {
		return `${(value / 1e9).toFixed(1)}B`;
	}
	if (abs >= 1e6) {
		return `${(value / 1e6).toFixed(1)}M`;
	}
	if (abs >= 1e3) {
		return `${(value / 1e3).toFixed(1)}K`;
	}
	return String(Math.round(value));
}
