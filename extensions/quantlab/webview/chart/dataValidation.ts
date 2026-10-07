/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chart webview's payload validation (F-CHARTS-FB2 c1 M2, M3, S5). Every value the host sends, and every option a
 * visualization command carries, is checked here BEFORE any state changes. An absent optional value is omitted; a
 * value that is present but invalid is a named error. Nothing is repaired, clamped, defaulted or dropped.
 */

import type { EquityPoint, OhlcvBar, SignalPoint, VisualizationCommand } from './chartApi';

/** The host's timeframes (src/types/market.ts `Timeframe`); a message carrying any other value is a named error. */
export const CHART_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'] as const;
export type ChartTimeframe = typeof CHART_TIMEFRAMES[number];
export function isChartTimeframe(value: string): value is ChartTimeframe {
	return (CHART_TIMEFRAMES as readonly string[]).includes(value);
}

/** Doubles per bar in the binary transfer (t, o, h, l, c, v); src/utils/binaryTransfer.ts STRIDE. */
export const BINARY_BAR_STRIDE = 6;

/** A short, safe rendering of an unexpected value for an error message. */
export function describeValue(value: unknown): string {
	if (value instanceof ArrayBuffer) {
		return `ArrayBuffer of ${value.byteLength} bytes`;
	}
	// JSON would print NaN and Infinity as null, and cannot print a bigint.
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
		return String(value);
	}
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** A plotted value: a finite number, or NaN, which the visualization runner uses for a gap (an indicator's warm-up bars). */
function isPlottableValue(value: unknown): value is number {
	return typeof value === 'number' && (Number.isFinite(value) || Number.isNaN(value));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** The error of a message whose payload is invalid: names the message type and what is wrong. */
export function malformed(type: string, detail: string): Error {
	return new Error(`chart: malformed ${type} message (${detail})`);
}

/** A request id: a finite integer, 0 or more. */
export function validateRequestId(type: string, requestId: unknown): asserts requestId is number {
	if (typeof requestId !== 'number' || !Number.isInteger(requestId) || requestId < 0) {
		throw malformed(type, `requestId ${describeValue(requestId)}`);
	}
}

function validateArray(type: string, field: string, value: unknown): asserts value is unknown[] {
	if (!Array.isArray(value)) {
		throw malformed(type, `${field} ${describeValue(value)}`);
	}
}

/** Bars at the data boundary: finite time and OHLC, and a finite volume when one is present (an absent volume is legitimate). */
export function validateBars(bars: unknown, type = 'setData'): asserts bars is OhlcvBar[] {
	validateArray(type, 'data', bars);
	for (let i = 0; i < bars.length; i++) {
		const bar: unknown = bars[i];
		if (!isRecord(bar)) {
			throw new Error(`chart: bar ${i} is not an object (${describeValue(bar)})`);
		}
		if (!Number.isFinite(bar.t)) {
			throw new Error(`chart: bar ${i} has no finite time (t = ${String(bar.t)})`);
		}
		for (const field of ['o', 'h', 'l', 'c'] as const) {
			if (!isFiniteNumber(bar[field])) {
				throw new Error(`chart: bar ${i} has no finite ${field} (${field} = ${String(bar[field])})`);
			}
		}
		if (bar.v !== undefined && !isFiniteNumber(bar.v)) {
			throw new Error(`chart: bar ${i} has a non-finite volume (v = ${String(bar.v)})`);
		}
	}
}

/** The binary bars message payload: an ArrayBuffer holding exactly `count` bars. */
export function validateBinaryBars(buffer: unknown, count: unknown): asserts buffer is ArrayBuffer {
	if (!(buffer instanceof ArrayBuffer) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
		throw malformed('setDataBinary', `buffer ${describeValue(buffer)}, count ${String(count)}`);
	}
	const expected = count * BINARY_BAR_STRIDE * Float64Array.BYTES_PER_ELEMENT;
	if (buffer.byteLength !== expected) {
		throw malformed('setDataBinary', `buffer ${describeValue(buffer)} does not hold count ${count} bars (${expected} bytes)`);
	}
}

/** One signal marker: finite time, a known type, an optional string label, an optional finite price. */
export function validateSignal(signal: unknown, type: string, field = 'signal'): asserts signal is SignalPoint {
	if (!isRecord(signal)
		|| !isFiniteNumber(signal.t)
		|| (signal.type !== 'entry' && signal.type !== 'exit')
		|| (signal.label !== undefined && typeof signal.label !== 'string')
		|| (signal.price !== undefined && !isFiniteNumber(signal.price))) {
		throw malformed(type, `${field} ${describeValue(signal)}`);
	}
}

export function validateSignals(signals: unknown, type: string): asserts signals is SignalPoint[] {
	validateArray(type, 'signals', signals);
	signals.forEach((signal, i) => validateSignal(signal, type, `signals[${i}]`));
}

export function validateEquity(equity: unknown, type: string): asserts equity is EquityPoint[] {
	validateArray(type, 'equity', equity);
	equity.forEach((point, i) => {
		if (!isRecord(point) || !isFiniteNumber(point.t) || !isFiniteNumber(point.v)) {
			throw malformed(type, `equity[${i}] ${describeValue(point)}`);
		}
	});
}

const COMPLEXITY_LEVELS = ['safe', 'partial', 'viewOnly'];

export function validateComplexity(complexity: unknown, type: string): void {
	if (!isRecord(complexity)
		|| typeof complexity.level !== 'string' || !COMPLEXITY_LEVELS.includes(complexity.level)
		|| !isFiniteNumber(complexity.score)
		|| !Array.isArray(complexity.reasons)) {
		throw malformed(type, `complexity ${describeValue(complexity)}`);
	}
}

export function validateDataSource(source: unknown, type: string, field = 'dataSource'): void {
	if (!isRecord(source)) {
		throw malformed(type, `${field} ${describeValue(source)}`);
	}
	if (source.kind === 'localFile') {
		if (!isNonEmptyString(source.filePath) || typeof source.displayName !== 'string') {
			throw malformed(type, `${field} ${describeValue(source)}`);
		}
		return;
	}
	if (source.kind === 'server') {
		if (!isNonEmptyString(source.symbol) || typeof source.displayName !== 'string'
			|| (source.assetClass !== undefined && typeof source.assetClass !== 'string')) {
			throw malformed(type, `${field} ${describeValue(source)}`);
		}
		return;
	}
	throw malformed(type, `${field} ${describeValue(source)}`);
}

/** The toolbar the host sends (ChartToolbarState): required fields present and valid, optional fields absent or valid. */
export function validateToolbar(toolbar: unknown, type: string): void {
	if (!isRecord(toolbar)) {
		throw malformed(type, `toolbar ${describeValue(toolbar)}`);
	}
	if (toolbar.mode !== 'data' && toolbar.mode !== 'strategy') {
		throw new Error(`chart: the toolbar has no valid mode (${String(toolbar.mode)})`);
	}
	if (toolbar.dataSource !== undefined) {
		validateDataSource(toolbar.dataSource, type);
	}
	if (toolbar.timeframe !== undefined
		&& (typeof toolbar.timeframe !== 'string' || !isChartTimeframe(toolbar.timeframe.trim()))) {
		throw new Error(`chart: unknown timeframe "${String(toolbar.timeframe)}" (expected one of ${CHART_TIMEFRAMES.join(', ')})`);
	}
	if (toolbar.dateRange !== undefined
		&& (!isRecord(toolbar.dateRange) || typeof toolbar.dateRange.start !== 'string' || typeof toolbar.dateRange.end !== 'string')) {
		throw malformed(type, `dateRange ${describeValue(toolbar.dateRange)}`);
	}
	if (toolbar.recentSources !== undefined) {
		validateArray(type, 'recentSources', toolbar.recentSources);
		toolbar.recentSources.forEach((source, i) => validateDataSource(source, type, `recentSources[${i}]`));
	}
	validateComplexity(toolbar.complexity, type);
	if (typeof toolbar.hasVisualization !== 'boolean') {
		throw malformed(type, `hasVisualization ${describeValue(toolbar.hasVisualization)}`);
	}
	if (typeof toolbar.viewOnly !== 'boolean') {
		throw malformed(type, `viewOnly ${describeValue(toolbar.viewOnly)}`);
	}
}

export function validateParameters(parameters: unknown, type: string): void {
	validateArray(type, 'parameters', parameters);
	parameters.forEach((parameter, i) => {
		if (!isRecord(parameter) || !isNonEmptyString(parameter.id)) {
			throw malformed(type, `parameters[${i}] ${describeValue(parameter)}`);
		}
	});
}

export function validateOverrides(overrides: unknown, type: string): void {
	if (!isRecord(overrides)) {
		throw malformed(type, `overrides ${describeValue(overrides)}`);
	}
}

export function validateTheme(theme: unknown, type: string): void {
	if (theme !== 'light' && theme !== 'dark') {
		throw malformed(type, `theme ${describeValue(theme)}`);
	}
}

const ERROR_ACTIONS = ['selectData', 'editVisualization', 'reload'];

export function validateErrorActions(actions: unknown, type: string): void {
	validateArray(type, 'actions', actions);
	actions.forEach((action, i) => {
		if (typeof action !== 'string' || !ERROR_ACTIONS.includes(action)) {
			throw malformed(type, `actions[${i}] ${describeValue(action)}`);
		}
	});
}

// ---------------------------------------------------------------------------------------------
// Visualization commands (M3): an absent optional option is omitted; a present invalid one is named.
// ---------------------------------------------------------------------------------------------

/** The dash pattern of a lineStyle; undefined means solid, which only 'solid' asks for. An unknown style is named. */
export function resolveDash(style: unknown): number[] | undefined {
	const normalized = typeof style === 'string' ? style.toLowerCase() : style;
	if (normalized === 'dashed') {
		return [6, 4];
	}
	if (normalized === 'dotted') {
		return [2, 4];
	}
	if (normalized === 'solid') {
		return undefined;
	}
	throw new Error(`chart: unknown series lineStyle (${String(style)}; expected solid, dashed or dotted)`);
}

/** A pane height: a finite number above 0 (up to 1 it is a stretch factor, above 1 pixels). */
export function validatePaneHeight(height: unknown, command: string): asserts height is number {
	if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
		throw new Error(`chart: ${command} height must be a finite number above 0 (${describeValue(height)})`);
	}
}

/** The series options of a plotSeries command. `options` itself is absent (undefined) or an object. */
export function validateSeriesOptions(options: unknown): void {
	if (options === undefined) {
		return;
	}
	if (!isRecord(options)) {
		throw new Error(`chart: plotSeries options must be an object (${describeValue(options)})`);
	}
	if (options.paneId !== undefined && !isNonEmptyString(options.paneId)) {
		throw new Error(`chart: series option paneId must be a non-empty string (${describeValue(options.paneId)})`);
	}
	if (options.color !== undefined && !isNonEmptyString(options.color)) {
		throw new Error(`chart: series option color must be a non-empty string (${describeValue(options.color)})`);
	}
	if (options.title !== undefined && typeof options.title !== 'string') {
		throw new Error(`chart: series option title must be a string (${describeValue(options.title)})`);
	}
	if (options.lineWidth !== undefined && !isFiniteNumber(options.lineWidth)) {
		throw new Error(`chart: series option lineWidth must be a finite number (${String(options.lineWidth)})`);
	}
	if (options.width !== undefined && !isFiniteNumber(options.width)) {
		throw new Error(`chart: series option width must be a finite number (${String(options.width)})`);
	}
	if (options.lineStyle !== undefined) {
		resolveDash(options.lineStyle);
	}
	if (options.opacity !== undefined && !isFiniteNumber(options.opacity)) {
		throw new Error(`chart: series option opacity must be a finite number (${String(options.opacity)})`);
	}
	if (options.priceLineVisible !== undefined && typeof options.priceLineVisible !== 'boolean') {
		throw new Error(`chart: series option priceLineVisible must be a boolean (${describeValue(options.priceLineVisible)})`);
	}
}

function validateMarks(marks: unknown, command: string, field: string): void {
	if (!Array.isArray(marks)) {
		throw new Error(`chart: ${command} ${field} must be an array (${describeValue(marks)})`);
	}
	marks.forEach((mark: unknown, i) => {
		if (!isRecord(mark) || !isFiniteNumber(mark.t)
			|| (mark.label !== undefined && typeof mark.label !== 'string')
			|| (mark.price !== undefined && !isFiniteNumber(mark.price))) {
			throw new Error(`chart: ${command} ${field}[${i}] needs a finite t, an optional string label and an optional finite price (${describeValue(mark)})`);
		}
	});
}

const CLEAR_TARGETS = ['signals', 'equity', 'indicators', 'all'];
const SERIES_KINDS = ['line', 'histogram', 'area'];

/** Every command of a setVisualization batch, checked before the chart is touched. */
export function validateVisualizationCommands(commands: unknown): asserts commands is VisualizationCommand[] {
	if (!Array.isArray(commands)) {
		throw new Error(`chart: visualization commands must be an array (${describeValue(commands)})`);
	}
	commands.forEach((command: unknown, i) => {
		if (!isRecord(command) || typeof command.type !== 'string') {
			throw new Error(`chart: visualization command ${i} has no type (${describeValue(command)})`);
		}
		switch (command.type) {
			case 'addPane':
				if (!isNonEmptyString(command.id)) {
					throw new Error(`chart: addPane id must be a non-empty string (${describeValue(command.id)})`);
				}
				if (command.height !== undefined) {
					validatePaneHeight(command.height, 'addPane');
				}
				break;
			case 'plotSeries':
				if (typeof command.series !== 'string' || !SERIES_KINDS.includes(command.series)) {
					throw new Error(`chart: plotSeries series must be line, histogram or area (${describeValue(command.series)})`);
				}
				if (!Array.isArray(command.data)) {
					throw new Error(`chart: plotSeries data must be an array (${describeValue(command.data)})`);
				}
				command.data.forEach((point: unknown, p) => {
					if (!isRecord(point) || !isFiniteNumber(point.t) || !isPlottableValue(point.v)) {
						throw new Error(`chart: plotSeries data[${p}] needs a finite t and a v that is a number, NaN being a gap (${describeValue(point)})`);
					}
				});
				validateSeriesOptions(command.options);
				break;
			case 'markEntries':
				validateMarks(command.entries, 'markEntries', 'entries');
				break;
			case 'markExits':
				validateMarks(command.exits, 'markExits', 'exits');
				break;
			case 'setEquityCurve':
				if (!Array.isArray(command.equity)) {
					throw new Error(`chart: setEquityCurve equity must be an array (${describeValue(command.equity)})`);
				}
				command.equity.forEach((point: unknown, p) => {
					if (!isRecord(point) || !isFiniteNumber(point.t) || !isFiniteNumber(point.v)) {
						throw new Error(`chart: setEquityCurve equity[${p}] needs a finite t and v (${describeValue(point)})`);
					}
				});
				break;
			case 'clear':
				if (typeof command.target !== 'string' || !CLEAR_TARGETS.includes(command.target)) {
					throw new Error(`chart: clear target must be signals, equity, indicators or all (${describeValue(command.target)})`);
				}
				break;
			case 'addIndicator':
			case 'removeIndicator':
				// The chart draws no indicators: a strategy asking for one hears so.
				throw new Error(`chart: the chart draws no indicators (${command.type})`);
			default:
				throw new Error(`chart: unknown visualization command (${command.type})`);
		}
	});
}
