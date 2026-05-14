/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { QvizSpec } from '../src/qviz/spec';
import { compileGeneralPlan, CompileGeneralPlanError } from '../src/qviz/render/general';
import { applyGeneralPlan, disposeView } from '../src/qviz/render/general-applier';
import type { VegaEmbedHandle } from '../src/qviz/render/general-applier';
import type {
	ColumnData, QvizTheme, VegaLiteFieldDef, VegaLiteMarkObject
} from '../src/qviz/render/types';

const TEST_THEME: QvizTheme = {
	background: '#101820',
	foreground: '#fff',
	grid: '#333',
	axisText: '#aaa',
	seriesPalette: ['#aabbcc', '#ddeeff', '#112233'],
	upColor: '#26a69a',
	downColor: '#ef5350',
};

function makeSpec(partial: Partial<QvizSpec> & {
	chart: QvizSpec['chart'];
}): QvizSpec {
	return {
		qviz_version: 1 as const,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		provenance: {
			generated_at: '2026-04-30T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...partial,
	};
}

suite('compileGeneralPlan -- mark routing', () => {

	test('scatter compiles to mark.type=circle with opacity', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2, 3], b: [10, 20, 30] };
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const mark = plan.spec.mark as VegaLiteMarkObject;
		assert.strictEqual(mark.type, 'circle');
		assert.strictEqual(mark.opacity, 0.6);
		assert.strictEqual(mark.tooltip, true);
	});

	test('line compiles to mark.type=line', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'line',
				encodings: {
					x: { field: 'a', type: 'temporal' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: [1, 2], b: [3, 4] },
			TEST_THEME
		);
		const mark = plan.spec.mark as VegaLiteMarkObject;
		assert.strictEqual(mark.type, 'line');
	});

	test('bar compiles to mark.type=bar', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: ['x', 'y'], b: [1, 2] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.mark as VegaLiteMarkObject).type, 'bar');
	});

	test('histogram compiles to mark.type=bar with binSpacing=0', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'histogram',
				encodings: {
					x: { field: 'bin', type: 'ordinal' },
					y: { field: 'cnt', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ bin: ['a', 'b', 'c'], cnt: [10, 20, 30] },
			TEST_THEME
		);
		const mark = plan.spec.mark as VegaLiteMarkObject;
		assert.strictEqual(mark.type, 'bar');
		assert.strictEqual(mark.binSpacing, 0);
	});

	test('heatmap compiles to mark.type=rect', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'heatmap',
				encodings: {
					x: { field: 'h', type: 'ordinal' },
					y: { field: 'd', type: 'ordinal' },
					color: { field: 'v', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ h: ['09', '10'], d: ['mon', 'mon'], v: [1, 2] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.mark as VegaLiteMarkObject).type, 'rect');
	});

	test('pie compiles to mark.type=arc', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'pie',
				encodings: {
					color: { field: 'cat', type: 'nominal' },
					y: { field: 'cnt', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ cat: ['a', 'b'], cnt: [3, 7] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.mark as VegaLiteMarkObject).type, 'arc');
	});

});

suite('compileGeneralPlan -- encoding mapping', () => {

	test('maps x and y with title and scale', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'volume', type: 'quantitative', title: 'Volume', scale: 'log' },
					y: { field: 'ret', type: 'quantitative', title: 'Return' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ volume: [1, 2, 3], ret: [0.1, 0.2, 0.3] },
			TEST_THEME
		);
		const x = plan.spec.encoding.x as VegaLiteFieldDef;
		const y = plan.spec.encoding.y as VegaLiteFieldDef;
		assert.strictEqual(x.field, 'volume');
		assert.strictEqual(x.type, 'quantitative');
		assert.strictEqual(x.title, 'Volume');
		assert.strictEqual(x.scale?.type, 'log');
		assert.strictEqual(y.field, 'ret');
		assert.strictEqual(y.title, 'Return');
	});

	test('maps color, size, shape channels', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'nominal' },
					size: { field: 's', type: 'quantitative' },
					shape: { field: 'sh', type: 'nominal' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: [1], b: [2], c: ['x'], s: [5], sh: ['triangle'] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.encoding.color as VegaLiteFieldDef).field, 'c');
		assert.strictEqual((plan.spec.encoding.size as VegaLiteFieldDef).field, 's');
		assert.strictEqual((plan.spec.encoding.shape as VegaLiteFieldDef).field, 'sh');
	});

	test('maps facet_row and facet_col to row/column', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					facet_row: { field: 'r', type: 'nominal' },
					facet_col: { field: 'c', type: 'nominal' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: [1], b: [2], r: ['x'], c: ['y'] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.encoding.row as VegaLiteFieldDef | undefined)?.field, 'r');
		assert.strictEqual((plan.spec.encoding.column as VegaLiteFieldDef | undefined)?.field, 'c');
	});

	test('translates sort: asc/desc to ascending/descending', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal', sort: 'desc' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: ['x', 'y'], b: [1, 2] },
			TEST_THEME
		);
		assert.strictEqual((plan.spec.encoding.x as VegaLiteFieldDef).sort, 'descending');
	});

	test('threads y_axis_zero into y scale.zero', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal' },
					y: { field: 'b', type: 'quantitative' },
				},
				options: { y_axis_zero: true },
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: ['x'], b: [10] },
			TEST_THEME
		);
		const y = plan.spec.encoding.y as VegaLiteFieldDef;
		assert.strictEqual(y.scale?.zero, true);
	});

});

suite('compileGeneralPlan -- pie special-casing', () => {

	test('pie with explicit y maps it to theta', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'pie',
				encodings: {
					color: { field: 'cat', type: 'nominal' },
					y: { field: 'amt', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ cat: ['a', 'b'], amt: [10, 20] },
			TEST_THEME
		);
		const theta = plan.spec.encoding.theta as VegaLiteFieldDef | undefined;
		assert.ok(theta, 'expected theta on pie encoding');
		assert.strictEqual(theta?.field, 'amt');
	});

	test('AF21: pie without y throws (no silent count fallback)', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'pie',
				encodings: {
					color: { field: 'cat', type: 'nominal' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(spec, { cat: ['a', 'b', 'a'] }, TEST_THEME),
			(e: Error) =>
				e instanceof CompileGeneralPlanError &&
				/requires encodings\.y/.test(e.message)
		);
	});

	test('AF22: pie with negative y throws (Vega-Lite would distort)', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'pie',
				encodings: {
					color: { field: 'cat', type: 'nominal' },
					y: { field: 'amt', type: 'quantitative' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(
				spec, { cat: ['a', 'b', 'c'], amt: [10, -5, 20] }, TEST_THEME
			),
			(e: Error) =>
				e instanceof CompileGeneralPlanError &&
				/non-negative|negative value/.test(e.message)
		);
	});

	test('pie without color rejects', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'pie',
				encodings: {
					y: { field: 'a', type: 'quantitative' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(spec, { a: [1] }, TEST_THEME),
			(e: Error) => e instanceof CompileGeneralPlanError && /requires encodings\.color/.test(e.message)
		);
	});

});

suite('compileGeneralPlan -- heatmap', () => {

	test('heatmap requires x, y, color', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'heatmap',
				encodings: {
					x: { field: 'a', type: 'ordinal' },
					y: { field: 'b', type: 'ordinal' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(spec, { a: ['1'], b: ['2'] }, TEST_THEME),
			(e: Error) => /encodings\.x.*encodings\.y.*encodings\.color/.test(e.message)
		);
	});

});

suite('compileGeneralPlan -- data and theme', () => {

	test('rows are projected to encoding-referenced columns only', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = {
			a: [1, 2],
			b: [10, 20],
			extra: ['ignored', 'ignored'],
		};
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		const rows = plan.spec.data.values;
		assert.strictEqual(rows.length, 2);
		assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['a', 'b']);
		assert.strictEqual(rows[0].a, 1);
		assert.strictEqual(rows[0].b, 10);
	});

	test('rejects mismatched column lengths', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2, 3], b: [1, 2] };
		assert.throws(
			() => compileGeneralPlan(spec, columns, TEST_THEME),
			(e: Error) => e instanceof CompileGeneralPlanError && /mismatched lengths/.test(e.message)
		);
	});

	test('rejects encoding referencing missing column', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'ghost', type: 'quantitative' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(spec, { a: [1] }, TEST_THEME),
			(e: Error) => /encodings\.y.*ghost/.test(e.message)
		);
	});

	test('emits diagnostic on zero rows', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(spec, { a: [], b: [] }, TEST_THEME);
		assert.ok(plan.diagnostics.some(d => /0 rows/.test(d)));
	});

	test('theme drives config background, axis, title colors', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: [1], b: [2] },
			TEST_THEME
		);
		assert.strictEqual(plan.spec.background, TEST_THEME.background);
		const cfg = plan.spec.config!;
		const axis = cfg.axis as Record<string, unknown>;
		const title = cfg.title as Record<string, unknown>;
		const range = cfg.range as Record<string, unknown>;
		assert.strictEqual(axis.labelColor, TEST_THEME.axisText);
		assert.strictEqual(axis.titleColor, TEST_THEME.foreground);
		assert.strictEqual(title.color, TEST_THEME.foreground);
		assert.deepStrictEqual(range.category, TEST_THEME.seriesPalette);
	});

	test('show_legend=false disables legend in config', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'nominal' },
				},
				options: { show_legend: false },
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: ['x'], b: [1], c: ['k'] },
			TEST_THEME
		);
		const legend = plan.spec.config!.legend as Record<string, unknown>;
		assert.strictEqual(legend.disable, true);
	});

	test('show_grid=false disables axis grid', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
				options: { show_grid: false },
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ a: [1], b: [2] },
			TEST_THEME
		);
		const axis = plan.spec.config!.axis as Record<string, unknown>;
		assert.strictEqual(axis.grid, false);
	});

});

suite('applyGeneralPlan -- contract surface', () => {

	// We can't actually call applyGeneralPlan in this test environment
	// (no DOM, no vega-embed installed). These assertions verify the
	// export surface so a future refactor can't silently change shape.

	test('exports applyGeneralPlan and disposeView', () => {
		assert.strictEqual(typeof applyGeneralPlan, 'function');
		assert.strictEqual(typeof disposeView, 'function');
	});

	test('disposeView calls finalize on the handle', () => {
		let calls = 0;
		const fake = {
			view: {},
			spec: {},
			vgSpec: {},
			embedOptions: {},
			finalize() { calls++; },
		} as unknown as VegaEmbedHandle;
		disposeView(fake);
		assert.strictEqual(calls, 1);
	});

	test('disposeView clears container children when given one', () => {
		const child = { remove: () => { /* noop */ } };
		const container = {
			firstChild: child as unknown as ChildNode | null,
			removeChild(c: ChildNode): ChildNode {
				if (c !== child) { throw new Error('unexpected child'); }
				(this as { firstChild: ChildNode | null }).firstChild = null;
				return c;
			},
		} as unknown as HTMLElement;
		const fake = {
			view: {},
			spec: {},
			vgSpec: {},
			embedOptions: {},
			finalize() { /* noop */ },
		} as unknown as VegaEmbedHandle;
		disposeView(fake, container);
		assert.strictEqual(container.firstChild, null);
	});

});

suite('compileGeneralPlan -- audit-fix slate (AF23-AF26)', () => {

	test('AF23: empty encoding set throws (no silent empty chart)', () => {
		const spec = makeSpec({
			chart: { family: 'general', type: 'scatter', encodings: {} },
		});
		assert.throws(
			() => compileGeneralPlan(spec, {}, TEST_THEME),
			(e: Error) =>
				e instanceof CompileGeneralPlanError &&
				/no encoding fields/.test(e.message)
		);
	});

	test('AF24: y2 encoding is emitted into Vega-Lite spec', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'line',
				encodings: {
					x: { field: 't', type: 'temporal' },
					y: { field: 'lo', type: 'quantitative' },
					y2: { field: 'hi', type: 'quantitative' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec,
			{ t: [1, 2], lo: [1, 2], hi: [3, 4] },
			TEST_THEME
		);
		const enc = plan.spec.encoding as Record<string, VegaLiteFieldDef | undefined>;
		assert.strictEqual(enc.y2?.field, 'hi');
	});

	test('AF25: scale object is built without undefined fields', () => {
		// y_axis_zero=true, no scale type specified: should emit
		// `scale: { zero: true }`, NOT `scale: { type: undefined, zero: true }`.
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal' },
					y: { field: 'b', type: 'quantitative' },
				},
				options: { y_axis_zero: true },
			},
		});
		const plan = compileGeneralPlan(spec, { a: ['x'], b: [10] }, TEST_THEME);
		const y = plan.spec.encoding.y as VegaLiteFieldDef;
		assert.ok(y.scale, 'expected y.scale to be set');
		assert.strictEqual(y.scale!.zero, true);
		assert.ok(!('type' in (y.scale as Record<string, unknown>)),
			`scale.type must not be present when not requested; got ${JSON.stringify(y.scale)}`);
	});

	test('AF26: ordinal color encoding gets a tableau10 scheme', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'ordinal' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec, { a: [1], b: [2], c: ['mon'] }, TEST_THEME
		);
		const color = plan.spec.encoding.color as VegaLiteFieldDef;
		assert.strictEqual(color.scale?.scheme, 'tableau10');
	});

	test('AF26: temporal color encoding gets a viridis scheme', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'h', type: 'temporal' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec, { a: [1], b: [2], h: [1735689600000] }, TEST_THEME
		);
		const color = plan.spec.encoding.color as VegaLiteFieldDef;
		assert.strictEqual(color.scale?.scheme, 'viridis');
	});

	test('AF26: nominal color does NOT override range.category scheme', () => {
		const spec = makeSpec({
			chart: {
				family: 'general',
				type: 'bar',
				encodings: {
					x: { field: 'a', type: 'nominal' },
					y: { field: 'b', type: 'quantitative' },
					color: { field: 'c', type: 'nominal' },
				},
			},
		});
		const plan = compileGeneralPlan(
			spec, { a: ['x'], b: [1], c: ['k'] }, TEST_THEME
		);
		const color = plan.spec.encoding.color as VegaLiteFieldDef;
		// nominal should NOT have scheme set (theme range.category drives it).
		assert.ok(
			color.scale === undefined || !('scheme' in (color.scale as Record<string, unknown>)),
			`nominal color should not override scheme; got ${JSON.stringify(color.scale)}`
		);
	});

});

suite('compileGeneralPlan -- emitted spec validates against vega-lite (AF32)', () => {

	// Audit-fix AF32: tests previously asserted shape only. A spec that's
	// shape-correct but Vega-Lite-rejected would pass without surface. By
	// running the emitted spec through vega-lite.compile() we get a real
	// "is this renderable" check.
	//
	// vega-lite's transitive deps (vega-canvas) use top-level await, so
	// tsx's CJS resolution can't load it as a static import. We use a
	// dynamic import lazily on first call. The whole suite skips if the
	// load fails (e.g. node-version or pnpm resolution issue).

	let vegaLiteCompile: ((spec: unknown) => unknown) | null = null;
	let loadError: string | null = null;

	suiteSetup(async function () {
		// Megaudit Wave 11.6: TypeScript compiles `await import(...)`
		// to `require(...)` under module=commonjs, which breaks for
		// vega-lite (its dep vega-canvas has top-level await). The
		// `new Function(...)` indirection prevents tsc from
		// transforming the import — Node's runtime then performs a
		// real dynamic ESM import.
		try {
			const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
			const mod = await dynImport('vega-lite');
			vegaLiteCompile = (mod as { compile: (spec: unknown) => unknown }).compile;
		} catch (e) {
			loadError = (e as Error).message ?? String(e);
		}
	});

	function expectVegaLiteCompiles(spec: QvizSpec, columns: ColumnData): void {
		if (!vegaLiteCompile) {
			// Surface the load error so the skip is loud.
			throw new Error(
				`vega-lite could not be loaded for AF32 validation: ${loadError ?? 'unknown'}`
			);
		}
		const plan = compileGeneralPlan(spec, columns, TEST_THEME);
		assert.doesNotThrow(
			() => vegaLiteCompile!(plan.spec),
			`emitted Vega-Lite spec failed to compile: ${JSON.stringify(plan.spec).slice(0, 500)}`
		);
	}

	test('scatter spec compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'scatter',
					encodings: {
						x: { field: 'a', type: 'quantitative', title: 'A', scale: 'log' },
						y: { field: 'b', type: 'quantitative' },
						color: { field: 'c', type: 'ordinal' },
					},
				},
			}),
			{ a: [1, 2], b: [3, 4], c: ['m', 'n'] }
		);
	});

	test('bar with y_axis_zero compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'bar',
					encodings: {
						x: { field: 'a', type: 'nominal' },
						y: { field: 'b', type: 'quantitative' },
					},
					options: { y_axis_zero: true, show_grid: false, show_legend: false },
				},
			}),
			{ a: ['x', 'y'], b: [1, 2] }
		);
	});

	test('heatmap compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'heatmap',
					encodings: {
						x: { field: 'h', type: 'ordinal' },
						y: { field: 'd', type: 'ordinal' },
						color: { field: 'v', type: 'quantitative' },
					},
				},
			}),
			{ h: ['09', '10'], d: ['mon', 'tue'], v: [1, 2] }
		);
	});

	test('pie compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'pie',
					encodings: {
						color: { field: 'cat', type: 'nominal' },
						y: { field: 'amt', type: 'quantitative' },
					},
				},
			}),
			{ cat: ['a', 'b'], amt: [10, 20] }
		);
	});

	test('histogram compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'histogram',
					encodings: {
						x: { field: 'bin', type: 'ordinal' },
						y: { field: 'cnt', type: 'quantitative' },
					},
				},
			}),
			{ bin: ['a', 'b'], cnt: [10, 20] }
		);
	});

	test('line with facets compiles', () => {
		expectVegaLiteCompiles(
			makeSpec({
				chart: {
					family: 'general', type: 'line',
					encodings: {
						x: { field: 't', type: 'temporal' },
						y: { field: 'v', type: 'quantitative' },
						facet_col: { field: 'g', type: 'nominal' },
					},
				},
			}),
			{ t: [1, 2], v: [3, 4], g: ['x', 'y'] }
		);
	});

});

suite('compileGeneralPlan -- error gates', () => {

	test('rejects timeseries family', () => {
		const spec = makeSpec({
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'a', type: 'temporal' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
		});
		assert.throws(
			() => compileGeneralPlan(spec, { a: [1], b: [2] }, TEST_THEME),
			(e: Error) => e instanceof CompileGeneralPlanError && /family='general'/.test(e.message)
		);
	});

	test('rejects unsupported chart type for general family', () => {
		// candlestick is timeseries-only, but defensively the compiler rejects.
		const spec = {
			...makeSpec({
				chart: {
					family: 'general' as const,
					type: 'scatter' as const,
					encodings: {
						x: { field: 't', type: 'temporal' as const },
						y: { field: 'v', type: 'quantitative' as const },
					},
				},
			}),
			chart: {
				family: 'general' as const,
				type: 'candlestick' as const,
				encodings: {
					ohlcv: { time: 't', open: 'o', high: 'h', low: 'l', close: 'c' },
				},
			},
		};
		assert.throws(
			() => compileGeneralPlan(spec as unknown as QvizSpec, { t: [1], o: [1], h: [1], l: [1], c: [1] }, TEST_THEME),
			(e: Error) => /not supported by general renderer/.test(e.message)
		);
	});

});

suite('compileGeneralPlan -- Front 2 attribution enrichment', () => {

	test('attribution-enriched error when aggregate dropped the column', () => {
		const spec = makeSpec({
			chart: {
				family: 'general' as const,
				type: 'scatter' as const,
				encodings: {
					x: { field: 'date', type: 'temporal' as const },
					// y references 'close' but the aggregate dropped it.
					y: { field: 'close', type: 'quantitative' as const },
				},
			},
		});
		const columns: ColumnData = { date: [1, 2], mean_close: [100, 200] };
		const attribution = [
			{ index: 0, kind: 'groupby', produces: [], drops: [],
				availableAfter: ['date', 'close'] },
			{ index: 1, kind: 'aggregate',
				produces: ['mean_close'], drops: ['close'],
				availableAfter: ['date', 'mean_close'] },
		];
		assert.throws(
			() => compileGeneralPlan(spec, columns, TEST_THEME, attribution),
			(e: Error) => {
				assert.match(e.message,
					/encodings\.y\.field='close' not in column data -- dropped by transform #1 \(aggregate\)/);
				return true;
			},
		);
	});

	test('back-compat: missing column with no attribution preserves the old message', () => {
		const spec = makeSpec({
			chart: {
				family: 'general' as const,
				type: 'scatter' as const,
				encodings: {
					x: { field: 'a', type: 'quantitative' as const },
					y: { field: 'missing', type: 'quantitative' as const },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2] };
		assert.throws(
			() => compileGeneralPlan(spec, columns, TEST_THEME),
			(e: Error) => {
				assert.strictEqual(e.message,
					"encodings.y.field='missing' not in column data");
				return true;
			},
		);
	});

	test('null attribution behaves like absent', () => {
		const spec = makeSpec({
			chart: {
				family: 'general' as const,
				type: 'scatter' as const,
				encodings: {
					x: { field: 'a', type: 'quantitative' as const },
					y: { field: 'missing', type: 'quantitative' as const },
				},
			},
		});
		const columns: ColumnData = { a: [1, 2] };
		assert.throws(
			() => compileGeneralPlan(spec, columns, TEST_THEME, null),
			(e: Error) => {
				assert.strictEqual(e.message,
					"encodings.y.field='missing' not in column data");
				return true;
			},
		);
	});

});
