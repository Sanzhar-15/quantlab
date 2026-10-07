/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Validation of the messages the chart webview posts to the host (F-CHARTS-FB2 c1 M2). A message is checked whole
 * BEFORE the provider changes any state; a malformed one is a named error that the provider shows to the user.
 * The host's messages to the webview are validated on the webview side (webview/chart/dataValidation.ts).
 */

import type { ChartInboundMessage } from '../../types/chart';
import type { Timeframe } from '../../types/market';

const TIMEFRAMES: ReadonlySet<string> = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']);

/** A short, safe rendering of an unexpected value for an error message. */
export function describeValue(value: unknown): string {
	// JSON would print NaN and Infinity as null, and cannot print a bigint.
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
		return String(value);
	}
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
}

function malformed(type: string, detail: string): Error {
	return new Error(`quantlab chart: malformed ${type} message (${detail})`);
}

function requireNonEmptyString(type: string, field: string, value: unknown): void {
	if (typeof value !== 'string' || value.length === 0) {
		throw malformed(type, `${field} ${describeValue(value)}`);
	}
}

function isIsoDate(value: unknown): boolean {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Types that carry no payload: any extra field is ignored, none is required. */
const PAYLOADLESS = new Set([
	'ready', 'resetDefaults', 'applyToCode', 'requestFilePicker', 'refresh', 'screenshot', 'openSettings',
	'addVisualization', 'generateVisualization', 'editVisualization', 'toggleFullscreen'
]);

/**
 * The message as a ChartInboundMessage, or a named error: not an object, no known type, or a payload that is
 * not what the webview posts (index.ts, marketHeader.ts, parameterPanel callbacks).
 */
export function parseChartInboundMessage(message: unknown): ChartInboundMessage {
	if (!message || typeof message !== 'object') {
		throw new Error(`quantlab chart: malformed webview message (${describeValue(message)})`);
	}
	const payload = message as Record<string, unknown>;
	const type = payload.type;
	if (typeof type !== 'string') {
		throw new Error(`quantlab chart: unknown webview message type (${String(type)})`);
	}
	if (PAYLOADLESS.has(type)) {
		return message as ChartInboundMessage;
	}
	switch (type) {
		case 'parameterChange':
			requireNonEmptyString(type, 'id', payload.id);
			if (payload.value === undefined) {
				throw malformed(type, 'value undefined');
			}
			break;
		case 'selectDataSource':
		case 'dropFile':
			requireNonEmptyString(type, 'filePath', payload.filePath);
			break;
		case 'selectServerSymbol':
			requireNonEmptyString(type, 'symbol', payload.symbol);
			if (typeof payload.displayName !== 'string') {
				throw malformed(type, `displayName ${describeValue(payload.displayName)}`);
			}
			if (payload.assetClass !== undefined && typeof payload.assetClass !== 'string') {
				throw malformed(type, `assetClass ${describeValue(payload.assetClass)}`);
			}
			break;
		case 'overrideDateRange': {
			// An absent range clears the override; a present one is two ISO dates.
			const range = payload.range;
			if (range !== undefined) {
				if (typeof range !== 'object' || range === null || !isIsoDate((range as Record<string, unknown>).start) || !isIsoDate((range as Record<string, unknown>).end)) {
					throw malformed(type, `range ${describeValue(range)}`);
				}
			}
			break;
		}
		case 'overrideTimeframe':
			if (typeof payload.timeframe !== 'string' || !TIMEFRAMES.has(payload.timeframe)) {
				throw malformed(type, `timeframe ${describeValue(payload.timeframe)}`);
			}
			break;
		case 'toggleParameters':
			if (typeof payload.collapsed !== 'boolean') {
				throw malformed(type, `collapsed ${describeValue(payload.collapsed)}`);
			}
			break;
		case 'dropRun':
			requireNonEmptyString(type, 'runId', payload.runId);
			break;
		case 'selectTool':
			if (payload.tool !== null && typeof payload.tool !== 'string') {
				throw malformed(type, `tool ${describeValue(payload.tool)}`);
			}
			break;
		case 'chartDrawn':
			if (typeof payload.bars !== 'number' || !Number.isInteger(payload.bars) || payload.bars < 0) {
				throw malformed(type, `bars ${describeValue(payload.bars)}`);
			}
			for (const field of ['width', 'height'] as const) {
				const value = payload[field];
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
					throw malformed(type, `${field} ${describeValue(value)}`);
				}
			}
			break;
		default:
			throw new Error(`quantlab chart: unknown webview message type (${type})`);
	}
	return message as ChartInboundMessage;
}
