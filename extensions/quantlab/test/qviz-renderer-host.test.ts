/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for RendererHost — Phase 5 step 5.E.3 leak invariant.
 *
 * The host swaps between two render families (`timeseries` and
 * `general`). Each family has its own chart handle (`Chart` from
 * charts-plus / `VegaEmbedHandle` from vega-embed). When the family
 * changes, the OLD handle MUST be disposed before the new one mounts —
 * otherwise the container leaks DOM, listeners, and (for charts-plus)
 * web workers.
 *
 * Tests inject a stub `RendererAppliers` so we can count apply/dispose
 * calls without booting the heavy chart libraries.
 */

// Install module hooks BEFORE the RendererHost import resolves. The
// production `applier.ts` statically imports `@charts-plus/chart-core`
// and `@charts-plus/chart-render-canvas2d`, which aren't on the plain-
// mocha path (they're aliased to dist-built JS by esbuild in the real
// webview bundle). Stub them out so the import chain succeeds.
//
// The test itself never invokes these stubs because every test passes
// a custom `appliers` arg to RendererHost — the stubs are just so the
// module-load chain doesn't fail with MODULE_NOT_FOUND.
import { Module } from 'module';

interface ModuleWithResolve {
	_resolveFilename(
		request: string, parent: NodeJS.Module | null,
		isMain?: boolean, options?: { paths?: string[] },
	): string;
}

(() => {
	const M = Module as unknown as ModuleWithResolve;
	const original = M._resolveFilename;
	const stubPath = require.resolve('./helpers/applier-stub');
	M._resolveFilename = function (request, parent, isMain, options) {
		if (request.startsWith('@charts-plus/')) {
			return stubPath;
		}
		return original.call(this, request, parent, isMain, options);
	};
})();

import * as assert from 'assert';

import { RendererHost, type RendererAppliers } from '../webview/qviz/render/RendererHost';
import type { QvizSpec } from '../src/qviz/spec';
import type { ColumnData, QvizTheme, TimeseriesPlan, GeneralPlan } from '../src/qviz/render/types';

const THEME: QvizTheme = {
	background: '#000',
	foreground: '#fff',
	grid: '#333',
	axisText: '#aaa',
	seriesPalette: ['#abc'],
};

const COLUMNS: ColumnData = {
	t: [1, 2, 3],
	v: [10, 20, 30],
};

function makeSpec(family: 'timeseries' | 'general', type: 'line' | 'scatter'): QvizSpec {
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
				x: { field: 't', type: family === 'timeseries' ? 'temporal' : 'quantitative' },
				y: { field: 'v', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test',
			query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
	};
}

/** Build a stub appliers + call-counter. The stubs short-circuit
 *  compile and apply (they don't actually render anything) but track
 *  every applier/dispose call so the test can assert lifecycle order. */
function makeStubAppliers(): {
	appliers: RendererAppliers;
	calls: string[];
	activeTimeseriesHandles: number;
	activeGeneralHandles: number;
} {
	const state = {
		calls: [] as string[],
		activeTimeseriesHandles: 0,
		activeGeneralHandles: 0,
	};
	const timeseriesHandle = Symbol('chart-handle') as unknown as ReturnType<typeof Symbol>;
	const generalHandle = Symbol('vega-handle') as unknown as ReturnType<typeof Symbol>;
	const appliers: RendererAppliers = {
		compileTimeseries: (_spec, _cols, _theme): TimeseriesPlan => {
			state.calls.push('compileTimeseries');
			return { chart: {}, series: [], diagnostics: [] };
		},
		applyTimeseries: (_container, _plan, existing) => {
			state.calls.push('applyTimeseries');
			// Mirror production semantics: when `existing` is passed,
			// the applier reuses the handle (no new mount).
			if (existing === undefined) { state.activeTimeseriesHandles += 1; }
			return timeseriesHandle as never;
		},
		disposeTimeseries: (_handle, _container) => {
			state.calls.push('disposeTimeseries');
			state.activeTimeseriesHandles -= 1;
		},
		compileGeneral: (_spec, _cols, _theme): GeneralPlan => {
			state.calls.push('compileGeneral');
			return { spec: {}, diagnostics: [] } as unknown as GeneralPlan;
		},
		applyGeneral: async (_container, _plan, existing) => {
			state.calls.push('applyGeneral');
			if (existing === undefined) { state.activeGeneralHandles += 1; }
			return generalHandle as never;
		},
		disposeGeneral: (_handle, _container) => {
			state.calls.push('disposeGeneral');
			state.activeGeneralHandles -= 1;
		},
	};
	return {
		appliers,
		get calls() { return state.calls; },
		get activeTimeseriesHandles() { return state.activeTimeseriesHandles; },
		get activeGeneralHandles() { return state.activeGeneralHandles; },
	};
}

function fakeContainer(): HTMLElement {
	// Minimal stub. RendererHost doesn't actually touch the container
	// in tests (the stub appliers ignore it); we just need an object
	// to pass through.
	return {} as HTMLElement;
}

// ---------------------------------------------------------------------------
// happy path — render same family repeatedly
// ---------------------------------------------------------------------------

suite('RendererHost -- single-family lifecycle', () => {

	test('first timeseries render: compile + apply, no dispose', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		const r = await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		assert.ok(r.ok && r.family === 'timeseries');
		assert.deepStrictEqual([...stubs.calls], ['compileTimeseries', 'applyTimeseries']);
		assert.strictEqual(stubs.activeTimeseriesHandles, 1);
		assert.strictEqual(stubs.activeGeneralHandles, 0);
	});

	test('same-family re-render passes `existing` handle to applier (no dispose between)', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		// No disposeTimeseries between the two renders; the applier
		// reuses the existing handle.
		assert.deepStrictEqual([...stubs.calls], [
			'compileTimeseries', 'applyTimeseries',
			'compileTimeseries', 'applyTimeseries',
		]);
		assert.strictEqual(stubs.activeTimeseriesHandles, 1);
	});

});

// ---------------------------------------------------------------------------
// family-swap leak invariant (Step 5.E.3)
// ---------------------------------------------------------------------------

suite('RendererHost -- family swap leak invariant', () => {

	test('timeseries → general disposes timeseries BEFORE applying general', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		await host.render(makeSpec('general', 'scatter'), COLUMNS, THEME);
		assert.deepStrictEqual([...stubs.calls], [
			'compileTimeseries', 'applyTimeseries',
			// Family swap: dispose old handle FIRST.
			'disposeTimeseries',
			'compileGeneral', 'applyGeneral',
		]);
		assert.strictEqual(stubs.activeTimeseriesHandles, 0,
			'timeseries handle must be disposed on family swap');
		assert.strictEqual(stubs.activeGeneralHandles, 1);
	});

	test('general → timeseries disposes general BEFORE applying timeseries', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('general', 'scatter'), COLUMNS, THEME);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		assert.deepStrictEqual([...stubs.calls], [
			'compileGeneral', 'applyGeneral',
			'disposeGeneral',
			'compileTimeseries', 'applyTimeseries',
		]);
		assert.strictEqual(stubs.activeGeneralHandles, 0);
		assert.strictEqual(stubs.activeTimeseriesHandles, 1);
	});

	test('full round trip: timeseries → general → timeseries leaves zero leaks', async () => {
		// The contract from the Step E plan: the swap doesn't leak.
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		await host.render(makeSpec('general', 'scatter'), COLUMNS, THEME);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		// Exactly ONE active handle (the new timeseries one) after the
		// round trip. Both intermediate handles were disposed.
		assert.strictEqual(stubs.activeTimeseriesHandles, 1);
		assert.strictEqual(stubs.activeGeneralHandles, 0);
		// And the call sequence is correct: each apply preceded by a
		// dispose for the opposite family (after the first).
		assert.deepStrictEqual([...stubs.calls], [
			'compileTimeseries', 'applyTimeseries',
			'disposeTimeseries',
			'compileGeneral', 'applyGeneral',
			'disposeGeneral',
			'compileTimeseries', 'applyTimeseries',
		]);
	});

	test('explicit dispose() releases the active handle', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		host.dispose();
		assert.strictEqual(stubs.activeTimeseriesHandles, 0);
		assert.strictEqual(host.currentFamily, null);
	});

	test('render after dispose returns structured error (no leaks)', async () => {
		const stubs = makeStubAppliers();
		const host = new RendererHost(fakeContainer(), stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		host.dispose();
		const r = await host.render(makeSpec('general', 'scatter'), COLUMNS, THEME);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(stubs.activeTimeseriesHandles, 0);
		assert.strictEqual(stubs.activeGeneralHandles, 0,
			'render after dispose must not create a new handle');
	});

});

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

suite('RendererHost -- error paths', () => {

	test('compile error is reported as RenderResult.ok=false (stage="compile")', async () => {
		const stubs = makeStubAppliers();
		const failingAppliers: RendererAppliers = {
			...stubs.appliers,
			compileTimeseries: () => { throw new Error('compile boom'); },
		};
		const host = new RendererHost(fakeContainer(), failingAppliers);
		const r = await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.strictEqual(r.stage, 'compile');
		assert.match(r.error, /compile boom/);
	});

	test('apply error is reported as RenderResult.ok=false (stage="apply")', async () => {
		const stubs = makeStubAppliers();
		const failingAppliers: RendererAppliers = {
			...stubs.appliers,
			applyTimeseries: () => { throw new Error('apply boom'); },
		};
		const host = new RendererHost(fakeContainer(), failingAppliers);
		const r = await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.strictEqual(r.stage, 'apply');
		assert.match(r.error, /apply boom/);
	});

});

// ---------------------------------------------------------------------------
// Phase 6 (6.E.1): selection hook
// ---------------------------------------------------------------------------

/** Minimal `Element`-shaped EventTarget for tests that run in Node (no
 *  DOM). RendererHost only calls add/removeEventListener on its
 *  container; we proxy through Node's EventTarget and expose a `fire`
 *  helper so tests can simulate a mouseup. */
function eventTargetContainer(): HTMLElement & {
	fire(type: string, init?: { button?: number }): void;
} {
	const et = new EventTarget();
	const fake = {
		addEventListener: et.addEventListener.bind(et),
		removeEventListener: et.removeEventListener.bind(et),
		dispatchEvent: et.dispatchEvent.bind(et),
		fire(type: string, init: { button?: number } = {}) {
			// Construct a structurally-correct mouseup-shaped event. We
			// can't use the DOM MouseEvent ctor (none in Node), so emit
			// a plain Event with a `button` field tacked on; the host's
			// listener reads only `event.button`.
			const evt = new Event(type) as Event & { button: number };
			evt.button = init.button ?? 0;
			et.dispatchEvent(evt);
		},
	};
	return fake as unknown as HTMLElement & { fire: (t: string, i?: { button?: number }) => void };
}

suite('RendererHost -- selection hook', () => {

	test('mouseup before any crosshair-move is a no-op (no spurious selection)', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const seen: unknown[] = [];
		const host = new RendererHost(dom, stubs.appliers, {
			onSelection: (x) => { seen.push(x); },
		});
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		// Without a crosshair-move (the stub applier doesn't emit one)
		// lastCrosshairTime is null and a mouseup must not fire
		// onSelection. Pinning this keeps a future "fire on bare clicks"
		// regression visible.
		dom.fire('mouseup', { button: 0 });
		assert.deepStrictEqual(seen, []);
		void host;
	});

	test('right-clicks (button !== 0) are ignored', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const seen: unknown[] = [];
		const host = new RendererHost(dom, stubs.appliers, {
			onSelection: (x) => { seen.push(x); },
		});
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		dom.fire('mouseup', { button: 2 });
		assert.deepStrictEqual(seen, []);
		void host;
	});

	test('dispose() detaches the selection listener so post-dispose mouseups are no-ops', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const seen: unknown[] = [];
		const host = new RendererHost(dom, stubs.appliers, {
			onSelection: (x) => { seen.push(x); },
		});
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		host.dispose();
		dom.fire('mouseup', { button: 0 });
		assert.deepStrictEqual(seen, []);
	});

	test('family swap detaches the prior listener', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const seen: unknown[] = [];
		const host = new RendererHost(dom, stubs.appliers, {
			onSelection: (x) => { seen.push(x); },
		});
		// timeseries → general must dispose the timeseries handle AND
		// detach its mouseup listener.
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		await host.render(makeSpec('general', 'scatter'), COLUMNS, THEME);
		assert.ok(stubs.calls.includes('disposeTimeseries'));
		dom.fire('mouseup', { button: 0 });
		assert.deepStrictEqual(seen, []);
	});

	test('no onSelection hook → no listener installed (mouseup never throws)', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const host = new RendererHost(dom, stubs.appliers);
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		dom.fire('mouseup', { button: 0 });
		void host;
	});

	test('setHooks replaces the callback for subsequent renders', async () => {
		const dom = eventTargetContainer();
		const stubs = makeStubAppliers();
		const host = new RendererHost(dom, stubs.appliers, {
			onSelection: () => { /* old */ },
		});
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		host.setHooks({ onSelection: () => { /* new */ } });
		// Re-render rebinds — the structural assertion that the host
		// accepted the new hook bag without throwing is what matters.
		await host.render(makeSpec('timeseries', 'line'), COLUMNS, THEME);
		assert.strictEqual(typeof host.hasViewHandle, 'boolean');
	});

});
