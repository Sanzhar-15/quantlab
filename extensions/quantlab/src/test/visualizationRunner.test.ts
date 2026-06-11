/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { VisualizationRunner } from '../core/engine/VisualizationRunner';
import { getVisualizationTemplate } from '../utils/visualizationTemplate';
import { OhlcvBar } from '../types/chart';
import { VisualizationCommand } from '../types/visualization';

suite('VisualizationRunner', () => {
	const runner = VisualizationRunner.getInstance();

	function createDocument(text: string, fileName = 'strategy.py'): vscode.TextDocument {
		return {
			languageId: 'python',
			fileName,
			uri: vscode.Uri.parse(`file:///${fileName}`),
			getText: () => text,
			isUntitled: false,
			version: 1
		} as vscode.TextDocument;
	}

	/** A V-shaped close series: strong decline, strong rise, small final dip. */
	function makeBars(): OhlcvBar[] {
		const closes: number[] = [];
		let value = 100;
		for (let i = 0; i < 12; i++) { value -= 2.5; closes.push(value); }
		for (let i = 0; i < 12; i++) { value += 5; closes.push(value); }
		for (let i = 0; i < 6; i++) { value -= 1.5; closes.push(value); }
		return closes.map((c, i) => ({ t: 1700000000 + i * 86400, o: c, h: c + 1, l: c - 1, c, v: 1000 }));
	}

	function plots(commands: VisualizationCommand[]): Array<Extract<VisualizationCommand, { type: 'plotSeries' }>> {
		return commands.filter((cmd): cmd is Extract<VisualizationCommand, { type: 'plotSeries' }> => cmd.type === 'plotSeries');
	}

	function panes(commands: VisualizationCommand[]): Array<Extract<VisualizationCommand, { type: 'addPane' }>> {
		return commands.filter((cmd): cmd is Extract<VisualizationCommand, { type: 'addPane' }> => cmd.type === 'addPane');
	}

	// ---- The hand-written showcase shape (StrategyTest/rsi_strategy.py) ----

	const RSI_STRATEGY = [
		'from quantlab import ql',
		'',
		'rsi = None',
		'',
		'def strategy(data):',
		'    rsi_period = ql.param(id="rsi_period", default=5, min=2, max=50, step=1)',
		'    oversold = ql.param(id="rsi_oversold", default=28, min=5, max=45, step=1)',
		'    overbought = ql.param(id="rsi_overbought", default=84, min=55, max=95, step=1)',
		'    rsi = ql.rsi(data.close, rsi_period)',
		'    entry = ql.cross_over(rsi, oversold)',
		'    exit = ql.cross_under(rsi, overbought)',
		'    return ql.signals(entry=entry, exit=exit)',
		'',
		'def visualize(chart):',
		'    chart.add_pane("rsi", height=0.3)',
		'    chart.plot(rsi, color="orange", label="RSI", pane="rsi")',
		'    chart.mark_entries(style="arrow_up", color="green")',
		'    chart.mark_exits(style="arrow_down", color="red")',
		''
	].join('\n');

	test('hand-written 1-arg visualize stays fully working (regression pin)', async () => {
		const result = await runner.run(createDocument(RSI_STRATEGY), { data: makeBars(), overrides: {} });

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(panes(result.commands).length, 1);
		assert.strictEqual(panes(result.commands)[0].id, 'rsi');
		const plotted = plots(result.commands);
		assert.strictEqual(plotted.length, 1);
		assert.ok(plotted[0].data.some(p => Number.isFinite(p.v)), 'RSI series should contain finite points');
		assert.ok(result.commands.some(c => c.type === 'markEntries'), 'expected entry markers from cross_over');
		assert.ok(result.commands.some(c => c.type === 'markExits'), 'expected exit markers from cross_under');
	});

	// ---- The AI-generated MACD shape (StrategyTest/macd_strategy.py) ----

	const MACD_STRATEGY = [
		'import quantlab as ql',
		'',
		'fast_period = ql.param("fast", default=10, min=8, max=20)',
		'slow_period = ql.param("slow", default=26, min=20, max=40)',
		'signal_period = ql.param("signal", default=9, min=5, max=15)',
		'',
		'def strategy(data):',
		'    macd_line, signal_line, histogram = ql.macd(data.close, fast=fast_period, slow=slow_period, signal=signal_period)',
		'    signals = ql.Signals()',
		'    buy_condition = ql.cross_over(macd_line, signal_line)',
		'    signals.buy(buy_condition)',
		'    sell_condition = ql.cross_under(macd_line, signal_line)',
		'    signals.sell(sell_condition)',
		'    return signals',
		'',
		'def visualize(chart, data, params):',
		'    fast_p = params.get("fast", 12)',
		'    slow_p = params.get("slow", 26)',
		'    signal_p = params.get("signal", 9)',
		'    macd_line, signal_line, histogram = ql.macd(data.close, fast=fast_p, slow=slow_p, signal=signal_p)',
		'    chart.mark_entries(timestamps=[], prices=[], side="long")',
		'    chart.mark_exits(timestamps=[], prices=[], side="long")',
		'    chart.add_pane("macd", height=0.3)',
		'    chart.plot(macd_line, name="MACD", pane="macd", color="blue")',
		'    chart.plot(signal_line, name="Signal", pane="macd", color="orange")',
		'    chart.plot(histogram, name="Histogram", pane="macd", color="gray", style="histogram")',
		'    chart.add_line(0.0, pane="macd", color="black", style="dashed", label="Zero")',
		''
	].join('\n');

	test('AI-generated 3-arg visualize with params.get renders MACD panes and plots', async () => {
		const result = await runner.run(createDocument(MACD_STRATEGY), { data: makeBars(), overrides: {} });

		assert.ok(!result.errors.some(e => e.includes('could not be parsed')), `signature must be tolerated, got: ${result.errors.join(' | ')}`);
		assert.ok(!result.errors.some(e => e.includes('Unable to resolve chart.plot series')), `MACD components must resolve, got: ${result.errors.join(' | ')}`);
		assert.strictEqual(panes(result.commands).length, 1);
		const plotted = plots(result.commands);
		assert.strictEqual(plotted.length, 3, 'macd, signal and histogram should all plot');
		assert.strictEqual(plotted[2]?.series, 'histogram', 'style="histogram" should map to the histogram series type');
		assert.ok(plotted.every(p => p.data.some(pt => Number.isFinite(pt.v))), 'all MACD series should contain finite points');
		assert.ok(plotted[0]?.options?.title === 'MACD', 'name= should map to the series title');
		assert.ok(result.errors.some(e => e.includes('Unsupported chart.add_line')), 'unsupported calls must be loud, not silent');
	});

	test('signals.buy/sell object style maps to entry/exit markers', async () => {
		const result = await runner.run(createDocument(MACD_STRATEGY), { data: makeBars(), overrides: {} });
		assert.ok(result.commands.some(c => c.type === 'markEntries') || result.commands.some(c => c.type === 'markExits'),
			'cross-based buy/sell conditions should produce at least one marker set on a V-shaped series');
	});

	// ---- The AI-generated Bollinger shape (StrategyTest/bollinger_bands_strategy.py) ----

	const BBANDS_STRATEGY = [
		'import quantlab as ql',
		'',
		'period = ql.param("period", default=20, min=10, max=50)',
		'std_dev = ql.param("std_dev", default=2.0, min=1.0, max=3.0)',
		'rsi_period = ql.param("rsi_period", default=14, min=5, max=30)',
		'',
		'def strategy(data):',
		'    upper_band, middle_band, lower_band = ql.bbands(data.close, period=period, std=std_dev)',
		'    rsi = ql.rsi(data.close, period=rsi_period)',
		'    return ql.signals(entry=None, exit=None)',
		'',
		'def visualize(chart, data, params):',
		'    bb_period = params.get("period", 20)',
		'    bb_std = params.get("std_dev", 2.0)',
		'    rsi_p = params.get("rsi_period", 14)',
		'    upper_band, middle_band, lower_band = ql.bbands(data.close, period=bb_period, std=bb_std)',
		'    rsi = ql.rsi(data.close, period=rsi_p)',
		'    chart.plot(upper_band, name="BB Upper", color="red", style="dashed")',
		'    chart.plot(middle_band, name="BB Middle", color="blue")',
		'    chart.plot(lower_band, name="BB Lower", color="green", style="dashed")',
		'    chart.fill_between(upper_band, lower_band, alpha=0.1, color="gray")',
		'    chart.add_pane("rsi", height=0.3)',
		'    chart.plot(rsi, name="RSI", pane="rsi", color="purple")',
		'    chart.add_line(70.0, pane="rsi", color="red", style="dashed", label="Overbought")',
		''
	].join('\n');

	test('AI-generated Bollinger strategy plots bands + RSI with loud unsupported-call errors', async () => {
		const result = await runner.run(createDocument(BBANDS_STRATEGY), { data: makeBars(), overrides: {} });

		assert.ok(!result.errors.some(e => e.includes('could not be parsed')), `signature must be tolerated, got: ${result.errors.join(' | ')}`);
		assert.ok(!result.errors.some(e => e.includes('Unable to resolve chart.plot series')), `bbands components must resolve, got: ${result.errors.join(' | ')}`);
		const plotted = plots(result.commands);
		assert.strictEqual(plotted.length, 4, 'upper, middle, lower and RSI should all plot');
		assert.ok(plotted[0]?.options?.lineStyle === 'dashed', 'style="dashed" should map to lineStyle');
		assert.ok(result.errors.some(e => e.includes('Unsupported chart.fill_between')), 'fill_between must be reported');
		assert.ok(result.errors.some(e => e.includes('Unsupported chart.add_line')), 'add_line must be reported');
	});

	test('bbands math: constant series collapses all three bands to the value', async () => {
		const text = [
			'import quantlab as ql',
			'def strategy(data):',
			'    u, m, l = ql.bbands(data.close, period=3, std=2)',
			'    return ql.signals(entry=None, exit=None)',
			'def visualize(chart):',
			'    chart.plot(u, label="U")',
			'    chart.plot(m, label="M")',
			'    chart.plot(l, label="L")',
			''
		].join('\n');
		const bars: OhlcvBar[] = Array.from({ length: 8 }, (_, i) => ({ t: i, o: 5, h: 5, l: 5, c: 5, v: 1 }));
		const result = await runner.run(createDocument(text), { data: bars, overrides: {} });

		const plotted = plots(result.commands);
		assert.strictEqual(plotted.length, 3);
		for (const p of plotted) {
			const finite = p.data.filter(pt => Number.isFinite(pt.v));
			assert.ok(finite.length >= 5, 'bands should be defined after the warmup window');
			assert.ok(finite.every(pt => Math.abs(pt.v - 5) < 1e-9), 'constant input must collapse the bands to the value');
		}
	});

	// ---- Honesty + hygiene of the parsing itself ----

	test('a visualize() whose first parameter is not chart errors loudly instead of silently no-opping', async () => {
		const text = [
			'def strategy(data):',
			'    return None',
			'def visualize(c):',
			'    c.plot(1)',
			''
		].join('\n');
		const result = await runner.run(createDocument(text), { data: makeBars(), overrides: {} });
		assert.ok(result.errors.some(e => e.includes('could not be parsed')), 'signature mismatch must surface as an error');
	});

	test('commented-out chart calls in the template produce no commands and no errors', async () => {
		const text = `def strategy(data):\n    return None\n\n${getVisualizationTemplate()}`;
		const result = await runner.run(createDocument(text), { data: makeBars(), overrides: {} });

		assert.deepStrictEqual(result.errors, []);
		assert.strictEqual(plots(result.commands).length, 0);
		assert.strictEqual(panes(result.commands).length, 0);
	});

	test('a color string containing # is not treated as a comment', async () => {
		const text = [
			'import quantlab as ql',
			'def strategy(data):',
			'    fast = ql.sma(data.close, 3)',
			'    return ql.signals(entry=None, exit=None)',
			'def visualize(chart):',
			'    chart.plot(fast, color="#FF7331", label="Fast")',
			''
		].join('\n');
		const result = await runner.run(createDocument(text), { data: makeBars(), overrides: {} });

		assert.deepStrictEqual(result.errors, []);
		const plotted = plots(result.commands);
		assert.strictEqual(plotted.length, 1);
		assert.strictEqual(plotted[0]?.options?.color, '#FF7331');
	});
});
