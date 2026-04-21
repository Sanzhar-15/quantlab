/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ParameterExtractor } from '../strategy/ParameterExtractor';
import { EquityPoint, OhlcvBar, SignalMarker } from '../../types/chart';
import { VisualizationCommand, VisualizationResult } from '../../types/visualization';

interface VisualizationInput {
	data: OhlcvBar[];
	overrides: Record<string, unknown>;
	signals?: SignalMarker[];
	equity?: EquityPoint[];
}

type SeriesField = 'open' | 'high' | 'low' | 'close' | 'volume';

type SeriesSource =
	| { kind: 'field'; field: SeriesField }
	| { kind: 'series'; name: string }
	| { kind: 'constant'; value: number };

interface IndicatorDefinition {
	indicator: string;
	source: SeriesSource;
	params: Record<string, number>;
}

interface MacdDefinition {
	component: 'macd' | 'signal' | 'histogram';
	source: SeriesSource;
	params: Record<string, number>;
}

interface CrossDefinition {
	type: 'over' | 'under';
	left: SeriesSource;
	right: SeriesSource;
}

interface ParsedArg {
	raw: string;
	name?: string;
	value: string;
}

interface ParsedCall {
	name: string;
	args: ParsedArg[];
	line: number;
}

export class VisualizationRunner {
	private static instance: VisualizationRunner | undefined;
	private readonly parameterExtractor = ParameterExtractor.getInstance();

	static getInstance(): VisualizationRunner {
		if (!VisualizationRunner.instance) {
			VisualizationRunner.instance = new VisualizationRunner();
		}
		return VisualizationRunner.instance;
	}

	async run(doc: vscode.TextDocument, input: VisualizationInput): Promise<VisualizationResult> {
		const text = doc.getText();
		const block = this.extractVisualizeBlock(text);
		const errors: string[] = [];
		const params = this.parameterExtractor.extract(doc);
		const paramValues = this.resolveParamValues(params.parameters, input.overrides);
		const paramVars = this.parseParamAssignments(text);
		const valueByName = new Map<string, unknown>();

		for (const [id, value] of paramValues.entries()) {
			valueByName.set(id, value);
		}
		for (const [varName, paramId] of paramVars.entries()) {
			if (paramValues.has(paramId)) {
				valueByName.set(varName, paramValues.get(paramId));
			}
		}

		const indicatorDefs = this.parseIndicatorAssignments(text, valueByName, errors);
		const macdDefs = this.parseMacdAssignments(text, valueByName, errors);
		const crossDefs = this.parseCrossAssignments(text, indicatorDefs, valueByName, errors);
		const seriesCache = new Map<string, number[]>();

		const resolveSource = (source: SeriesSource): number[] | undefined => {
			if (source.kind === 'field') {
				return input.data.map(bar => this.readField(bar, source.field));
			}
			if (source.kind === 'constant') {
				return new Array(input.data.length).fill(source.value);
			}
			return resolveSeries(source.name);
		};

		const resolveSeries = (name: string): number[] | undefined => {
			if (seriesCache.has(name)) {
				return seriesCache.get(name);
			}

			// Check standard indicators
			const def = indicatorDefs.get(name);
			if (def) {
				const source = resolveSource(def.source);
				if (!source) {
					errors.push(`Unable to resolve indicator input for ${name}.`);
					return undefined;
				}
				const computed = this.computeIndicator(def.indicator, source, def.params, errors);
				if (!computed) {
					return undefined;
				}
				seriesCache.set(name, computed);
				return computed;
			}

			// Check MACD components
			const macdDef = macdDefs.get(name);
			if (macdDef) {
				const source = resolveSource(macdDef.source);
				if (!source) {
					errors.push(`Unable to resolve MACD input for ${name}.`);
					return undefined;
				}
				const computed = this.computeMacdComponent(source, macdDef.params, macdDef.component);
				seriesCache.set(name, computed);
				return computed;
			}

			return undefined;
		};

		const signalVars = this.detectSignalVariables(text);
		const entryFlags = signalVars.entry ? this.computeCrossFlags(crossDefs.get(signalVars.entry), resolveSource, errors) : undefined;
		const exitFlags = signalVars.exit ? this.computeCrossFlags(crossDefs.get(signalVars.exit), resolveSource, errors) : undefined;
		const entrySignals = entryFlags ? this.buildSignals(entryFlags, 'entry', input.data) : undefined;
		const exitSignals = exitFlags ? this.buildSignals(exitFlags, 'exit', input.data) : undefined;

		const chartCalls = block ? this.parseChartCalls(block.body, block.startLine) : [];
		const commands: VisualizationCommand[] = [];
		let usedEntries = false;
		let usedExits = false;
		let usedEquity = false;
		let equityPlotted = false;

		for (const call of chartCalls) {
			switch (call.name) {
				case 'plot': {
					const args = call.args;
					if (!args.length) {
						errors.push(`chart.plot missing series at line ${call.line}.`);
						break;
					}
					const seriesArg = args[0]?.value ?? '';
					const seriesSource = this.parseSeriesSource(seriesArg, indicatorDefs, valueByName);
					if (!seriesSource) {
						errors.push(`Unable to resolve chart.plot series at line ${call.line}.`);
						break;
					}
					const seriesValues = resolveSource(seriesSource);
					if (!seriesValues) {
						errors.push(`Unable to compute chart.plot series at line ${call.line}.`);
						break;
					}
					const options = this.buildOptions(args.slice(1));
					const seriesType = this.extractSeriesType(options);
					const points: Array<{ t: number; v: number }> = [];
					const length = Math.min(seriesValues.length, input.data.length);
					for (let i = 0; i < length; i++) {
						points.push({
							t: input.data[i]?.t ?? 0,
							v: seriesValues[i] ?? NaN
						});
					}
					commands.push({
						type: 'plotSeries',
						series: seriesType,
						data: points,
						options
					});
					break;
				}
				case 'mark_entries':
					usedEntries = true;
					break;
				case 'mark_exits':
					usedExits = true;
					break;
				case 'plot_equity': {
					usedEquity = true;
					if (input.equity && input.equity.length) {
						commands.push({ type: 'setEquityCurve', equity: input.equity });
						equityPlotted = true;
					} else {
						errors.push(`Equity curve unavailable for chart.plot_equity at line ${call.line}.`);
					}
					break;
				}
				case 'add_pane': {
					const nameArg = call.args.find(arg => arg.name === 'id' || arg.name === 'name') ?? call.args[0];
					const nameValue = nameArg ? this.parseValue(nameArg.value) : undefined;
					if (typeof nameValue !== 'string' || !nameValue.trim()) {
						errors.push(`chart.add_pane requires a pane id at line ${call.line}.`);
						break;
					}
					const heightArg = call.args.find(arg => arg.name === 'height') ?? call.args[1];
					let height: number | undefined;
					if (heightArg) {
						const resolved = this.resolveNumericValue(heightArg.value, valueByName);
						if (resolved !== undefined) {
							height = resolved;
						} else {
							errors.push(`Invalid height for chart.add_pane at line ${call.line}.`);
						}
					}
					commands.push({ type: 'addPane', id: nameValue.trim(), height });
					break;
				}
				default:
					break;
			}
		}

		const fallbackEntries = entrySignals ?? this.extractSignalMarkers(input.signals, 'entry');
		const fallbackExits = exitSignals ?? this.extractSignalMarkers(input.signals, 'exit');

		if (!block) {
			if (fallbackEntries.length) {
				commands.push({ type: 'markEntries', entries: fallbackEntries });
			}
			if (fallbackExits.length) {
				commands.push({ type: 'markExits', exits: fallbackExits });
			}
			if (!fallbackEntries.length && !fallbackExits.length) {
				commands.push({ type: 'clear', target: 'signals' });
			}
			commands.push({ type: 'clear', target: 'equity' });
			return { commands, errors: [] };
		}

		const entryMarkers = usedEntries ? fallbackEntries : [];
		const exitMarkers = usedExits ? fallbackExits : [];

		if (usedEntries && !entryMarkers.length) {
			errors.push('No entry signals available for chart.mark_entries.');
		}
		if (usedExits && !exitMarkers.length) {
			errors.push('No exit signals available for chart.mark_exits.');
		}

		if (entryMarkers.length) {
			commands.push({ type: 'markEntries', entries: entryMarkers });
		}
		if (exitMarkers.length) {
			commands.push({ type: 'markExits', exits: exitMarkers });
		}
		if (!entryMarkers.length && !exitMarkers.length) {
			commands.push({ type: 'clear', target: 'signals' });
		}

		if (!usedEquity || !equityPlotted) {
			commands.push({ type: 'clear', target: 'equity' });
		}

		return { commands, errors };
	}

	private extractVisualizeBlock(text: string): { body: string; startLine: number } | null {
		const lines = text.split(/\r\n|\r|\n/);
		const defPattern = /def\s+visualize\s*\(\s*chart\s*\)\s*:/;
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (defPattern.test(lines[i])) {
				start = i;
				break;
			}
		}
		if (start === -1) {
			return null;
		}

		const baseIndent = this.countIndent(lines[start]);
		const bodyLines: string[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim().length === 0) {
				bodyLines.push(line);
				continue;
			}
			const indent = this.countIndent(line);
			if (indent <= baseIndent) {
				break;
			}
			bodyLines.push(line);
		}

		return { body: bodyLines.join('\n'), startLine: start + 2 };
	}

	private parseChartCalls(body: string, startLine: number): ParsedCall[] {
		const calls: ParsedCall[] = [];
		const needle = 'chart.';
		let index = 0;
		while (index < body.length) {
			const start = body.indexOf(needle, index);
			if (start === -1) {
				break;
			}

			const nameStart = start + needle.length;
			const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(nameStart));
			if (!nameMatch) {
				index = nameStart + 1;
				continue;
			}
			const name = nameMatch[0];
			const openParen = body.indexOf('(', nameStart + name.length);
			if (openParen === -1) {
				index = nameStart + name.length;
				continue;
			}
			const closeParen = this.findMatchingParen(body, openParen);
			if (closeParen === -1) {
				index = openParen + 1;
				continue;
			}
			const argsText = body.slice(openParen + 1, closeParen);
			const args = this.parseArgs(argsText);
			const line = startLine + this.countNewlines(body.slice(0, start));
			calls.push({ name, args, line });
			index = closeParen + 1;
		}
		return calls;
	}

	private resolveParamValues(defs: Array<{ id: string; default: unknown }>, overrides: Record<string, unknown>): Map<string, unknown> {
		const values = new Map<string, unknown>();
		for (const def of defs) {
			const override = overrides[def.id];
			values.set(def.id, override !== undefined ? override : def.default);
		}
		return values;
	}

	private parseParamAssignments(text: string): Map<string, string> {
		const assignments = new Map<string, string>();
		const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*ql\.param\s*\(/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			const varName = match[1];
			const openParen = match.index + match[0].length - 1;
			const closeParen = this.findMatchingParen(text, openParen);
			if (closeParen === -1) {
				continue;
			}
			const args = this.parseArgs(text.slice(openParen + 1, closeParen));
			const idArg = args.find(arg => arg.name === 'id') ?? args[0];
			const idValue = idArg ? this.parseValue(idArg.value) : undefined;
			if (typeof idValue === 'string') {
				assignments.set(varName, idValue);
			}
			pattern.lastIndex = closeParen + 1;
		}
		return assignments;
	}

	private parseIndicatorAssignments(text: string, valueByName: Map<string, unknown>, errors: string[]): Map<string, IndicatorDefinition> {
		const indicators = new Map<string, IndicatorDefinition>();
		const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*ql\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(text)) !== null) {
			const varName = match[1];
			const indicator = match[2];
			if (!this.isSupportedIndicator(indicator)) {
				continue;
			}

			const openParen = match.index + match[0].length - 1;
			const closeParen = this.findMatchingParen(text, openParen);
			if (closeParen === -1) {
				errors.push(`Unclosed indicator call for ${indicator}.`);
				continue;
			}

			const args = this.parseArgs(text.slice(openParen + 1, closeParen));
			const sourceArg = args[0]?.value ?? '';
			const source = this.parseSeriesSource(sourceArg, indicators, valueByName);
			if (!source) {
				errors.push(`Unable to resolve ${indicator} source for ${varName}.`);
				continue;
			}

			const params = this.extractIndicatorParams(indicator, args.slice(1), valueByName, errors);
			if (!params) {
				continue;
			}

			indicators.set(varName, { indicator, source, params });
			pattern.lastIndex = closeParen + 1;
		}

		return indicators;
	}

	private parseMacdAssignments(text: string, valueByName: Map<string, unknown>, errors: string[]): Map<string, MacdDefinition> {
		const macds = new Map<string, MacdDefinition>();
		// Pattern: macd_line, signal_line, histogram = ql.macd(...)
		// Captures 3 variable names and function call
		const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*ql\.macd\s*\(/g;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(text)) !== null) {
			const macdVar = match[1];      // First variable (macd line)
			const signalVar = match[2];    // Second variable (signal line)
			const histogramVar = match[3]; // Third variable (histogram)

			const openParen = match.index + match[0].length - 1;
			const closeParen = this.findMatchingParen(text, openParen);
			if (closeParen === -1) {
				errors.push(`Unclosed macd call for ${macdVar}.`);
				continue;
			}

			const args = this.parseArgs(text.slice(openParen + 1, closeParen));
			const sourceArg = args[0]?.value ?? '';
			const source = this.parseSeriesSource(sourceArg, new Map(), valueByName);
			if (!source) {
				errors.push(`Unable to resolve macd source for ${macdVar}.`);
				continue;
			}

			const params = this.extractMacdParams(args.slice(1), valueByName, errors);

			// Store all 3 components with same source/params but different component types
			macds.set(macdVar, { component: 'macd', source, params });
			macds.set(signalVar, { component: 'signal', source, params });
			macds.set(histogramVar, { component: 'histogram', source, params });

			pattern.lastIndex = closeParen + 1;
		}

		return macds;
	}

	private parseCrossAssignments(
		text: string,
		indicators: Map<string, IndicatorDefinition>,
		valueByName: Map<string, unknown>,
		errors: string[]
	): Map<string, CrossDefinition> {
		const crosses = new Map<string, CrossDefinition>();
		const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*ql\.cross_(over|under)\s*\(/g;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(text)) !== null) {
			const varName = match[1];
			const type = match[2] === 'over' ? 'over' : 'under';
			const openParen = match.index + match[0].length - 1;
			const closeParen = this.findMatchingParen(text, openParen);
			if (closeParen === -1) {
				continue;
			}

			const args = this.parseArgs(text.slice(openParen + 1, closeParen));
			const left = this.parseSeriesSource(args[0]?.value ?? '', indicators, valueByName);
			const right = this.parseSeriesSource(args[1]?.value ?? '', indicators, valueByName);
			if (!left || !right) {
				errors.push(`Unable to resolve cross_${type} inputs for ${varName}.`);
				continue;
			}

			crosses.set(varName, { type, left, right });
			pattern.lastIndex = closeParen + 1;
		}

		return crosses;
	}

	private detectSignalVariables(text: string): { entry?: string; exit?: string } {
		const callIndex = text.indexOf('ql.signals');
		if (callIndex === -1) {
			return { entry: 'entry', exit: 'exit' };
		}

		const openParen = text.indexOf('(', callIndex);
		if (openParen === -1) {
			return { entry: 'entry', exit: 'exit' };
		}
		const closeParen = this.findMatchingParen(text, openParen);
		if (closeParen === -1) {
			return { entry: 'entry', exit: 'exit' };
		}

		const args = this.parseArgs(text.slice(openParen + 1, closeParen));
		const entryArg = args.find(arg => arg.name === 'entry') ?? args[0];
		const exitArg = args.find(arg => arg.name === 'exit') ?? args[1];
		return {
			entry: entryArg?.value?.trim() || 'entry',
			exit: exitArg?.value?.trim() || 'exit'
		};
	}

	private computeCrossFlags(
		def: CrossDefinition | undefined,
		resolveSource: (source: SeriesSource) => number[] | undefined,
		errors: string[]
	): boolean[] | undefined {
		if (!def) {
			return undefined;
		}
		const left = resolveSource(def.left);
		const right = resolveSource(def.right);
		if (!left || !right) {
			errors.push('Unable to compute cross signals.');
			return undefined;
		}

		const length = Math.min(left.length, right.length);
		const flags = new Array(length).fill(false);
		for (let i = 1; i < length; i++) {
			const prevLeft = left[i - 1];
			const prevRight = right[i - 1];
			const currLeft = left[i];
			const currRight = right[i];
			if (!Number.isFinite(prevLeft) || !Number.isFinite(prevRight) || !Number.isFinite(currLeft) || !Number.isFinite(currRight)) {
				continue;
			}
			if (def.type === 'over') {
				flags[i] = prevLeft <= prevRight && currLeft > currRight;
			} else {
				flags[i] = prevLeft >= prevRight && currLeft < currRight;
			}
		}
		return flags;
	}

	private buildSignals(flags: boolean[], type: SignalMarker['type'], data: OhlcvBar[]): Array<{ t: number; label?: string; price?: number }> {
		const signals: Array<{ t: number; label?: string; price?: number }> = [];
		const length = Math.min(flags.length, data.length);
		for (let i = 0; i < length; i++) {
			if (!flags[i]) {
				continue;
			}
			const bar = data[i];
			if (!bar) {
				continue;
			}
			signals.push({
				t: bar.t,
				label: type === 'entry' ? 'Entry' : 'Exit',
				price: bar.c
			});
		}
		return signals;
	}

	private extractSignalMarkers(signals: SignalMarker[] | undefined, type: SignalMarker['type']): Array<{ t: number; label?: string; price?: number }> {
		if (!signals) {
			return [];
		}
		return signals
			.filter(signal => signal.type === type)
			.map(signal => ({
				t: signal.t,
				label: signal.label,
				price: signal.price
			}));
	}

	private parseSeriesSource(
		value: string,
		indicators: Map<string, IndicatorDefinition>,
		valueByName: Map<string, unknown>
	): SeriesSource | undefined {
		const trimmed = value.trim();
		const dataMatch = /^data\.(open|high|low|close|volume)$/.exec(trimmed);
		if (dataMatch) {
			return { kind: 'field', field: dataMatch[1] as SeriesField };
		}
		const dataBracket = /^data\[['"]?(open|high|low|close|volume)['"]?\]$/.exec(trimmed);
		if (dataBracket) {
			return { kind: 'field', field: dataBracket[1] as SeriesField };
		}
		if (indicators.has(trimmed)) {
			return { kind: 'series', name: trimmed };
		}
		const paramValue = valueByName.get(trimmed);
		if (typeof paramValue === 'number' && Number.isFinite(paramValue)) {
			return { kind: 'constant', value: paramValue };
		}
		const numeric = this.parseNumber(trimmed);
		if (numeric !== undefined) {
			return { kind: 'constant', value: numeric };
		}
		return undefined;
	}

	private extractIndicatorParams(
		indicator: string,
		args: ParsedArg[],
		valueByName: Map<string, unknown>,
		errors: string[]
	): Record<string, number> | undefined {
		const named = new Map<string, string>();
		const positional: string[] = [];
		for (const arg of args) {
			if (arg.name) {
				named.set(arg.name, arg.value);
			} else if (arg.value.trim()) {
				positional.push(arg.value);
			}
		}

		const params: Record<string, number> = {};
		const periodValue = named.get('period') ?? positional[0];
		if (periodValue) {
			const period = this.resolveNumericValue(periodValue, valueByName);
			if (period !== undefined) {
				params.period = period;
			} else {
				errors.push(`Invalid period for ${indicator}.`);
			}
		}

		if (indicator === 'rsi' || indicator === 'sma' || indicator === 'ema' || indicator === 'wma') {
			if (!params.period) {
				errors.push(`Missing period for ${indicator}.`);
				return undefined;
			}
		}

		return params;
	}

	private extractMacdParams(
		args: ParsedArg[],
		valueByName: Map<string, unknown>,
		_errors: string[]
	): Record<string, number> {
		const named = new Map<string, string>();
		const positional: string[] = [];

		for (const arg of args) {
			if (arg.name) {
				named.set(arg.name, arg.value);
			} else if (arg.value.trim()) {
				positional.push(arg.value);
			}
		}

		const params: Record<string, number> = {};

		// Fast period (default: 12)
		const fastValue = named.get('fast') ?? positional[0];
		if (fastValue) {
			const fast = this.resolveNumericValue(fastValue, valueByName);
			if (fast !== undefined) {
				params.fast = fast;
			}
		}
		if (!params.fast) {
			params.fast = 12;
		}

		// Slow period (default: 26)
		const slowValue = named.get('slow') ?? positional[1];
		if (slowValue) {
			const slow = this.resolveNumericValue(slowValue, valueByName);
			if (slow !== undefined) {
				params.slow = slow;
			}
		}
		if (!params.slow) {
			params.slow = 26;
		}

		// Signal period (default: 9)
		const signalValue = named.get('signal') ?? positional[2];
		if (signalValue) {
			const signal = this.resolveNumericValue(signalValue, valueByName);
			if (signal !== undefined) {
				params.signal = signal;
			}
		}
		if (!params.signal) {
			params.signal = 9;
		}

		return params;
	}

	private computeIndicator(
		indicator: string,
		source: number[],
		params: Record<string, number>,
		errors: string[]
	): number[] | undefined {
		const period = Math.max(1, Math.round(params.period ?? 0));
		if (!Number.isFinite(period) || period < 1) {
			errors.push(`Invalid period for ${indicator}.`);
			return undefined;
		}

		switch (indicator) {
			case 'sma':
				return this.computeSma(source, period);
			case 'ema':
				return this.computeEma(source, period);
			case 'wma':
				return this.computeWma(source, period);
			case 'rsi':
				return this.computeRsi(source, period);
			default:
				errors.push(`Unsupported indicator ${indicator}.`);
				return undefined;
		}
	}

	private computeSma(source: number[], period: number): number[] {
		const result = new Array(source.length).fill(NaN);
		let sum = 0;
		for (let i = 0; i < source.length; i++) {
			sum += source[i];
			if (i >= period) {
				sum -= source[i - period];
			}
			if (i >= period - 1) {
				result[i] = sum / period;
			}
		}
		return result;
	}

	private computeEma(source: number[], period: number): number[] {
		const result = new Array(source.length).fill(NaN);
		if (!source.length) {
			return result;
		}
		const alpha = 2 / (period + 1);
		let prev = source[0];
		result[0] = prev;
		for (let i = 1; i < source.length; i++) {
			const value = source[i];
			prev = alpha * value + (1 - alpha) * prev;
			result[i] = prev;
		}
		return result;
	}

	private computeWma(source: number[], period: number): number[] {
		const result = new Array(source.length).fill(NaN);
		const weightSum = (period * (period + 1)) / 2;
		for (let i = period - 1; i < source.length; i++) {
			let acc = 0;
			for (let j = 0; j < period; j++) {
				acc += source[i - j] * (period - j);
			}
			result[i] = acc / weightSum;
		}
		return result;
	}

	private computeRsi(source: number[], period: number): number[] {
		const result = new Array(source.length).fill(NaN);
		if (source.length <= period) {
			return result;
		}
		let gains = 0;
		let losses = 0;
		for (let i = 1; i <= period; i++) {
			const diff = source[i] - source[i - 1];
			if (diff >= 0) {
				gains += diff;
			} else {
				losses -= diff;
			}
		}
		let avgGain = gains / period;
		let avgLoss = losses / period;
		result[period] = this.computeRsiValue(avgGain, avgLoss);

		for (let i = period + 1; i < source.length; i++) {
			const diff = source[i] - source[i - 1];
			const gain = diff > 0 ? diff : 0;
			const loss = diff < 0 ? -diff : 0;
			avgGain = (avgGain * (period - 1) + gain) / period;
			avgLoss = (avgLoss * (period - 1) + loss) / period;
			result[i] = this.computeRsiValue(avgGain, avgLoss);
		}
		return result;
	}

	private computeRsiValue(avgGain: number, avgLoss: number): number {
		if (avgLoss === 0) {
			return 100;
		}
		const rs = avgGain / avgLoss;
		return 100 - 100 / (1 + rs);
	}

	private computeMacdComponent(
		source: number[],
		params: Record<string, number>,
		component: 'macd' | 'signal' | 'histogram'
	): number[] {
		const fast = Math.max(1, Math.round(params.fast ?? 12));
		const slow = Math.max(1, Math.round(params.slow ?? 26));
		const signal = Math.max(1, Math.round(params.signal ?? 9));

		// Calculate fast and slow EMAs
		const emaFast = this.computeEma(source, fast);
		const emaSlow = this.computeEma(source, slow);

		// MACD line = fast EMA - slow EMA
		const macdLine = new Array(source.length);
		for (let i = 0; i < source.length; i++) {
			macdLine[i] = emaFast[i] - emaSlow[i];
		}

		if (component === 'macd') {
			return macdLine;
		}

		// Signal line = EMA of MACD line
		const signalLine = this.computeEma(macdLine, signal);

		if (component === 'signal') {
			return signalLine;
		}

		// Histogram = MACD line - signal line
		const histogram = new Array(source.length);
		for (let i = 0; i < source.length; i++) {
			histogram[i] = macdLine[i] - signalLine[i];
		}

		return histogram;
	}

	private buildOptions(args: ParsedArg[]): Record<string, unknown> {
		const options: Record<string, unknown> = {};
		for (const arg of args) {
			if (!arg.name) {
				continue;
			}
			options[arg.name] = this.parseValue(arg.value);
		}
		if (typeof options.label === 'string' && options.title === undefined) {
			options.title = options.label;
		}
		if (options.pane && !options.paneId) {
			options.paneId = options.pane;
		}
		if (options.line_style && !options.lineStyle) {
			options.lineStyle = options.line_style;
		}
		if (options.linewidth && !options.lineWidth) {
			options.lineWidth = options.linewidth;
		}
		return options;
	}

	private extractSeriesType(options: Record<string, unknown>): 'line' | 'histogram' | 'area' {
		const raw = options.series ?? options.type;
		if (typeof raw === 'string') {
			const lowered = raw.toLowerCase();
			if (lowered === 'histogram' || lowered === 'area' || lowered === 'line') {
				delete options.series;
				delete options.type;
				return lowered;
			}
		}
		return 'line';
	}

	private isSupportedIndicator(indicator: string): boolean {
		return indicator === 'sma' || indicator === 'ema' || indicator === 'wma' || indicator === 'rsi' || indicator === 'macd';
	}

	private parseNumber(value: string): number | undefined {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private resolveNumericValue(value: string, valueByName: Map<string, unknown>): number | undefined {
		const trimmed = value.trim();
		const mapped = valueByName.get(trimmed);
		if (typeof mapped === 'number' && Number.isFinite(mapped)) {
			return mapped;
		}
		return this.parseNumber(trimmed);
	}

	private readField(bar: OhlcvBar, field: SeriesField): number {
		switch (field) {
			case 'open':
				return bar.o;
			case 'high':
				return bar.h;
			case 'low':
				return bar.l;
			case 'volume':
				return bar.v ?? NaN;
			case 'close':
			default:
				return bar.c;
		}
	}

	private parseArgs(argsText: string): ParsedArg[] {
		const parts = this.splitArgs(argsText);
		return parts.map(raw => {
			const trimmed = raw.trim();
			if (!trimmed) {
				return { raw, value: '' };
			}

			const equalsIndex = this.findTopLevelEquals(trimmed);
			if (equalsIndex === -1) {
				return { raw, value: trimmed };
			}

			const name = trimmed.slice(0, equalsIndex).trim();
			const value = trimmed.slice(equalsIndex + 1).trim();
			return { raw, name, value };
		});
	}

	private splitArgs(argsText: string): string[] {
		const args: string[] = [];
		let current = '';
		let depth = 0;
		let inString = false;
		let stringChar = '';

		for (let i = 0; i < argsText.length; i++) {
			const char = argsText[i];

			if (inString) {
				current += char;
				if (char === '\\') {
					if (i + 1 < argsText.length) {
						current += argsText[i + 1];
						i++;
					}
					continue;
				}
				if (char === stringChar) {
					inString = false;
					stringChar = '';
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = true;
				stringChar = char;
				current += char;
				continue;
			}

			if (char === '(' || char === '[' || char === '{') {
				depth += 1;
				current += char;
				continue;
			}

			if (char === ')' || char === ']' || char === '}') {
				depth = Math.max(0, depth - 1);
				current += char;
				continue;
			}

			if (char === ',' && depth === 0) {
				args.push(current);
				current = '';
				continue;
			}

			current += char;
		}

		if (current.trim()) {
			args.push(current);
		}

		return args;
	}

	private parseValue(value: string): unknown {
		const trimmed = value.trim();
		if (!trimmed) {
			return undefined;
		}

		if (trimmed === 'True') {
			return true;
		}
		if (trimmed === 'False') {
			return false;
		}
		if (trimmed === 'None' || trimmed === 'null') {
			return null;
		}

		const numeric = Number(trimmed);
		if (!Number.isNaN(numeric) && /^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
			return numeric;
		}

		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
			return this.unquote(trimmed);
		}

		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			const inner = trimmed.slice(1, -1);
			const parts = this.splitArgs(inner);
			return parts.map(part => this.parseValue(part));
		}

		return trimmed;
	}

	private unquote(value: string): string {
		const quote = value[0];
		const inner = value.slice(1, -1);
		return inner.replace(new RegExp(`\\\\${quote}`, 'g'), quote).replace(/\\\\/g, '\\');
	}

	private findTopLevelEquals(text: string): number {
		let depth = 0;
		let inString = false;
		let stringChar = '';

		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			if (inString) {
				if (char === '\\') {
					i += 1;
					continue;
				}
				if (char === stringChar) {
					inString = false;
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = true;
				stringChar = char;
				continue;
			}

			if (char === '(' || char === '[' || char === '{') {
				depth += 1;
				continue;
			}

			if (char === ')' || char === ']' || char === '}') {
				depth = Math.max(0, depth - 1);
				continue;
			}

			if (char === '=' && depth === 0) {
				return i;
			}
		}

		return -1;
	}

	private findMatchingParen(text: string, openIndex: number): number {
		let depth = 0;
		let inString = false;
		let stringChar = '';

		for (let i = openIndex; i < text.length; i++) {
			const char = text[i];

			if (inString) {
				if (char === '\\') {
					i += 1;
					continue;
				}
				if (char === stringChar) {
					inString = false;
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = true;
				stringChar = char;
				continue;
			}

			if (char === '(') {
				depth += 1;
			} else if (char === ')') {
				depth -= 1;
				if (depth === 0) {
					return i;
				}
			}
		}

		return -1;
	}

	private countIndent(line: string): number {
		let count = 0;
		for (const char of line) {
			if (char === ' ') {
				count += 1;
			} else if (char === '\t') {
				count += 4;
			} else {
				break;
			}
		}
		return count;
	}

	private countNewlines(text: string): number {
		let count = 0;
		for (const char of text) {
			if (char === '\n') {
				count += 1;
			}
		}
		return count;
	}
}
