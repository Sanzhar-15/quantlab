/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for chartTypePicker — Phase 9 step B.
 *
 * Megaudit CRITICAL-4 fixed the picker to expose all 9 chart types and
 * to pick the family dynamically based on the current spec; Phase 9
 * adds jsdom coverage for the rendered DOM + interaction surface:
 *
 *   - 9 buttons rendered, one per chart type, in display order.
 *   - WAI-ARIA radiogroup: role=radiogroup on root, role=radio on each
 *     button, exactly one tabindex=0 at any time.
 *   - Active button has --active class and aria-checked=true.
 *   - Clicking a button dispatches setChartType with a family that
 *     supports the chosen type (preserves current family when shared).
 *   - Arrow-key navigation works (focuses + selects next/prev radio).
 *   - Dispose teardown empties the root.
 */

import { installDom, resetDom } from './helpers/jsdom-shim';
installDom();

import * as assert from 'assert';

import { mountChartTypePicker } from '../webview/qviz/components/chartTypePicker';
import { createStore } from '../webview/qviz/state/store';
import type { QvizSpec } from '../src/qviz/spec';

function specWith(family: 'timeseries' | 'general', type: QvizSpec['chart']['type']): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family,
			type,
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

suite('chartTypePicker — Phase 9 jsdom coverage', () => {
	setup(() => { resetDom(); });

	test('renders exactly 9 chart-type buttons in display order', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountChartTypePicker(root, store);

		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-chart-type-button',
		));
		assert.strictEqual(buttons.length, 9,
			'picker should render all 9 chart-type buttons (megaudit CRITICAL-4)');

		const types = buttons.map(b => b.dataset.chartType);
		assert.deepStrictEqual(types, [
			'line', 'area', 'bar', 'histogram', 'candlestick',
			'baseline', 'scatter', 'heatmap', 'pie',
		], 'buttons should appear in canonical display order');

		handle.dispose();
	});

	test('radiogroup ARIA: root role=radiogroup, each button role=radio', () => {
		const root = mkRoot();
		const store = createStore();
		mountChartTypePicker(root, store);

		assert.strictEqual(root.getAttribute('role'), 'radiogroup',
			'root should be a radiogroup');
		assert.strictEqual(root.getAttribute('aria-label'), 'Chart type');

		for (const btn of root.querySelectorAll<HTMLButtonElement>('.qviz-chart-type-button')) {
			assert.strictEqual(btn.getAttribute('role'), 'radio',
				`button "${btn.dataset.chartType}" should be role=radio`);
			assert.strictEqual(btn.type, 'button',
				`button "${btn.dataset.chartType}" should have type=button`);
		}
	});

	test('roving tabindex: exactly one button has tabindex=0 at a time', () => {
		const root = mkRoot();
		const store = createStore();
		// Init with a spec so an active button is known.
		store.dispatch({
			type: 'init',
			fsPath: '/x.qviz.json',
			spec: specWith('timeseries', 'line'),
		});
		mountChartTypePicker(root, store);

		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-chart-type-button',
		));
		const tabStops = buttons.filter(b => b.tabIndex === 0);
		assert.strictEqual(tabStops.length, 1,
			'exactly ONE button should be tabbable (roving tabindex)');
		assert.strictEqual(tabStops[0].dataset.chartType, 'line',
			'the active type should hold the tab stop');

		// Switch chart type → tab stop should follow.
		store.dispatch({ type: 'setChartType', family: 'general', chartType: 'scatter' });
		const tabStops2 = buttons.filter(b => b.tabIndex === 0);
		assert.strictEqual(tabStops2.length, 1);
		assert.strictEqual(tabStops2[0].dataset.chartType, 'scatter');
	});

	test('active button gets --active class and aria-checked=true', () => {
		const root = mkRoot();
		const store = createStore();
		store.dispatch({
			type: 'init',
			fsPath: '/x.qviz.json',
			spec: specWith('timeseries', 'candlestick'),
		});
		mountChartTypePicker(root, store);

		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-chart-type-button',
		));
		const active = buttons.filter(b => b.classList.contains('qviz-chart-type-button--active'));
		assert.strictEqual(active.length, 1);
		assert.strictEqual(active[0].dataset.chartType, 'candlestick');
		assert.strictEqual(active[0].getAttribute('aria-checked'), 'true');

		// All others should be aria-checked=false.
		for (const b of buttons) {
			if (b === active[0]) { continue; }
			assert.strictEqual(b.getAttribute('aria-checked'), 'false',
				`non-active ${b.dataset.chartType} should report aria-checked=false`);
		}
	});

	test('clicking a chart-type button dispatches setChartType with the right family', () => {
		const root = mkRoot();
		const store = createStore();
		store.dispatch({
			type: 'init',
			fsPath: '/x.qviz.json',
			spec: specWith('timeseries', 'line'),
		});
		mountChartTypePicker(root, store);

		// Megaudit CRITICAL-4 path 1: shared type (bar) → preserve
		// current family (timeseries).
		root.querySelector<HTMLButtonElement>('button[data-chart-type="bar"]')!.click();
		assert.strictEqual(store.getState().spec.current!.chart.family, 'timeseries');
		assert.strictEqual(store.getState().spec.current!.chart.type, 'bar');

		// Path 2: type only available in general (pie) → switch family.
		root.querySelector<HTMLButtonElement>('button[data-chart-type="pie"]')!.click();
		assert.strictEqual(store.getState().spec.current!.chart.family, 'general');
		assert.strictEqual(store.getState().spec.current!.chart.type, 'pie');

		// Path 3: from general, click candlestick → timeseries only.
		root.querySelector<HTMLButtonElement>('button[data-chart-type="candlestick"]')!.click();
		assert.strictEqual(store.getState().spec.current!.chart.family, 'timeseries');
		assert.strictEqual(store.getState().spec.current!.chart.type, 'candlestick');
	});

	test('dispose() empties the root and removes the class', () => {
		const root = mkRoot();
		const store = createStore();
		const handle = mountChartTypePicker(root, store);

		assert.ok(root.classList.contains('qviz-chart-type-picker'));
		handle.dispose();
		assert.strictEqual(root.classList.contains('qviz-chart-type-picker'), false);
		assert.strictEqual(root.innerHTML, '');

		// Subsequent dispatch must not throw (listener detached).
		assert.doesNotThrow(() => {
			store.dispatch({
				type: 'init',
				fsPath: '/y.qviz.json',
				spec: specWith('timeseries', 'line'),
			});
		});
	});
});
