/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <reference lib="dom" />

/**
 * RendererHost -- Phase 5 step 5.D.5.
 *
 * Cross-renderer orchestrator. Hides the choice between the timeseries
 * applier (`@charts-plus`) and the general applier (Vega-Lite) behind
 * a single `render(spec, columns, theme)` call. Owns the current view
 * handle so a family swap (timeseries → general or vice versa) cleanly
 * disposes the previous renderer before mounting the new one.
 *
 * Concerns OWNED by this module:
 *   - Family routing: dispatches to compileTimeseriesPlan/Vega-Lite based
 *     on `spec.chart.family`.
 *   - Lifecycle: tracks the live handle; disposes on family change or
 *     explicit `dispose()`.
 *   - Compile / apply error reporting via structured result.
 *
 * Concerns NOT in this module:
 *   - Data fetching (the preview-area / live-wiring layer owns this).
 *   - State subscription (the wiring at the entry point reads
 *     `query.lastData.arrow`, extracts columns, then calls render).
 *   - Theme construction (the theme adapter feeds in QvizTheme).
 *
 * Async: `render()` is async because the general applier dynamically
 * imports `vega-embed`. Callers must await.
 */

import type { QvizSpec } from '../../../src/qviz/spec';
import type { ColumnData, QvizTheme, TimeseriesPlan, GeneralPlan } from '../../../src/qviz/render/types';
import {
	compileTimeseriesPlan, CompilePlanError,
} from '../../../src/qviz/render/timeseries';
import {
	applyTimeseriesPlan, disposeChart,
} from '../../../src/qviz/render/applier';
import {
	compileGeneralPlan, CompileGeneralPlanError,
} from '../../../src/qviz/render/general';
import {
	applyGeneralPlan, disposeView, type VegaEmbedHandle,
} from '../../../src/qviz/render/general-applier';
// `Chart` instance type comes from charts-plus; we keep a structural
// reference that doesn't pull the heavy dep at compile time.
type ChartHandle = ReturnType<typeof applyTimeseriesPlan>;

type ChartFamily = QvizSpec['chart']['family'];

/** Injectable applier interface. The constructor's `appliers` default
 *  is the real charts-plus + vega-embed wiring; tests can substitute
 *  stubs to verify dispose semantics without the heavy dependencies
 *  (Step 5.E.3 leak test). */
export interface RendererAppliers {
	readonly compileTimeseries: (spec: QvizSpec, cols: ColumnData, theme: QvizTheme) => TimeseriesPlan;
	readonly applyTimeseries: (
		container: HTMLElement, plan: TimeseriesPlan, existing?: ChartHandle,
	) => ChartHandle;
	readonly disposeTimeseries: (chart: ChartHandle, container?: HTMLElement) => void;
	readonly compileGeneral: (spec: QvizSpec, cols: ColumnData, theme: QvizTheme) => GeneralPlan;
	readonly applyGeneral: (
		container: HTMLElement, plan: GeneralPlan, existing?: VegaEmbedHandle,
	) => Promise<VegaEmbedHandle>;
	readonly disposeGeneral: (handle: VegaEmbedHandle, container?: HTMLElement) => void;
}

const DEFAULT_APPLIERS: RendererAppliers = {
	compileTimeseries: compileTimeseriesPlan,
	applyTimeseries: applyTimeseriesPlan,
	disposeTimeseries: disposeChart,
	compileGeneral: compileGeneralPlan,
	applyGeneral: applyGeneralPlan,
	disposeGeneral: disposeView,
};

export type RenderResult =
	| { readonly ok: true; readonly family: ChartFamily }
	| {
		readonly ok: false;
		readonly error: string;
		readonly stage: 'compile' | 'apply';
		/** Megaudit M-9: preserve the error class name so downstream
		 *  consumers can switch on type (e.g., `CompilePlanError` vs.
		 *  `CompileGeneralPlanError` vs. raw runtime errors) without
		 *  parsing the message string. */
		readonly errorName?: string;
	};

interface ActiveHandle {
	readonly family: ChartFamily;
	readonly handle: ChartHandle | VegaEmbedHandle;
	/** Phase 6 (6.E.1): detach the selection-click subscription that was
	 *  installed for this handle. Replaced on each render or family swap;
	 *  called from disposeActive() so a stale subscription can't fire
	 *  against a torn-down chart. */
	readonly detachSelectionListener: () => void;
}

/** Phase 6 (6.E.1): callbacks the renderer host can drive from chart
 *  interactions. `onSelection` fires when the user clicks a data point;
 *  the dispatcher upstream translates the x value into a `setSelection`
 *  action that the inspector table then highlights. */
export interface RendererHostHooks {
	readonly onSelection?: (x: unknown) => void;
}

export class RendererHost {

	private active: ActiveHandle | null = null;
	private disposed = false;
	private readonly appliers: RendererAppliers;
	private hooks: RendererHostHooks;

	constructor(
		private readonly container: HTMLElement,
		appliers: RendererAppliers = DEFAULT_APPLIERS,
		hooks: RendererHostHooks = {},
	) {
		this.appliers = appliers;
		this.hooks = hooks;
	}

	/** Replace the hooks bag. Useful for tests + late-binding so the
	 *  dispatcher can wire `onSelection` after the host is constructed. */
	setHooks(hooks: RendererHostHooks): void {
		this.hooks = hooks;
	}

	get currentFamily(): ChartFamily | null {
		return this.active === null ? null : this.active.family;
	}

	get hasViewHandle(): boolean {
		return this.active !== null;
	}

	/**
	 * Render `spec` against `columns` with `theme`. Returns a tagged
	 * result; never throws. Errors at compile or apply are returned as
	 * `{ ok: false }` so the caller (preview area, save flow) can
	 * surface them via the diagnostics readout.
	 *
	 * If the chart family is different from the current handle, the
	 * existing handle is disposed BEFORE the new one is created. This
	 * matches the test from Step E's plan (5.E.3): timeseries→general→
	 * timeseries leaves no leaked Chart or Vega view.
	 */
	async render(
		spec: QvizSpec, columns: ColumnData, theme: QvizTheme,
	): Promise<RenderResult> {
		if (this.disposed) {
			return { ok: false, error: 'RendererHost has been disposed', stage: 'apply' };
		}
		const family = spec.chart.family;

		// Family swap: dispose the prior handle FIRST so the container
		// is clean before the new applier mounts. Megaudit M-8: catch
		// dispose errors AT THE BOUNDARY and surface as a structured
		// RenderResult instead of letting them propagate as raw
		// throws (the contract is "never throws").
		if (this.active !== null && this.active.family !== family) {
			try {
				this.disposeActive();
			} catch (e) {
				return { ok: false, error: `family-swap dispose failed: ${(e as Error).message}`, stage: 'apply' };
			}
		}

		if (family === 'timeseries') {
			let plan;
			try {
				plan = this.appliers.compileTimeseries(spec, columns, theme);
			} catch (e) {
				if (e instanceof CompilePlanError) {
					return { ok: false, error: e.message, stage: 'compile', errorName: (e as Error).name };
				}
				return { ok: false, error: (e as Error).message, stage: 'compile', errorName: (e as Error).name };
			}
			let chart: ChartHandle;
			// Megaudit-2 A5-CRITICAL-4.1: NULL `this.active` BEFORE
			// invoking applyTimeseries so a dispose-throw inside the
			// applier doesn't leave us pointing at a half-disposed
			// handle (which would re-trigger the same throw on every
			// subsequent render → permanent stuck state).
			const existing = this.active?.family === 'timeseries'
				? this.active.handle as ChartHandle : undefined;
			this.active = null;
			try {
				chart = this.appliers.applyTimeseries(this.container, plan, existing);
			} catch (e) {
				return { ok: false, error: (e as Error).message, stage: 'apply', errorName: (e as Error).name };
			}
			const detach = this.installTimeseriesSelectionListener(chart);
			this.active = { family, handle: chart, detachSelectionListener: detach };
			return { ok: true, family };
		}

		// family === 'general'
		let plan;
		try {
			plan = this.appliers.compileGeneral(spec, columns, theme);
		} catch (e) {
			if (e instanceof CompileGeneralPlanError) {
				return { ok: false, error: e.message, stage: 'compile', errorName: (e as Error).name };
			}
			return { ok: false, error: (e as Error).message, stage: 'compile', errorName: (e as Error).name };
		}
		let handle: VegaEmbedHandle;
		// Megaudit-2 A5-CRITICAL-4.1 + A5-MAJOR-4.2: same active=null
		// guard as the timeseries branch, AND consistent errorName on
		// the apply error (was missing).
		const existing = this.active?.family === 'general'
			? this.active.handle as VegaEmbedHandle : undefined;
		this.active = null;
		try {
			handle = await this.appliers.applyGeneral(this.container, plan, existing);
		} catch (e) {
			return { ok: false, error: (e as Error).message, stage: 'apply', errorName: (e as Error).name };
		}
		// Audit B-3 (2026-05-11): pie has no x encoding; route through
		// `color.field` so click-on-slice dispatches the slice category.
		// The rest of the general family (scatter/heatmap/bar/etc.) use x.
		const xField = spec.chart.type === 'pie'
			? (spec.chart.encodings.color?.field ?? null)
			: (spec.chart.encodings.x?.field ?? null);
		const detach = this.installGeneralSelectionListener(handle, xField);
		this.active = { family, handle, detachSelectionListener: detach };
		return { ok: true, family };
	}

	/** Phase 6 (6.E.1): install a click listener on a freshly-applied
	 *  timeseries chart. Uses charts-plus's `onCrosshairMove` to track the
	 *  current hover x, and a DOM mouseup on the container to capture the
	 *  selection at click time. We don't use a `ChartPlugin.onPointer`
	 *  because the plugin contract is consumed at create-time and
	 *  swapping a new plugin in mid-life is awkward. The DOM listener
	 *  reads the same x via the crosshair cb that the chart itself uses.
	 *
	 *  Returns a detach function that unsubscribes both listeners. */
	private installTimeseriesSelectionListener(
		chart: ChartHandle,
	): () => void {
		if (!this.hooks.onSelection) { return () => { /* nothing to detach */ }; }
		let lastCrosshairTime: number | null = null;
		let mouseDownAt: { x: number; y: number } | null = null;
		// Audit M-5 (2026-05-11): track mouse-down position so the
		// mouseup handler can distinguish a click from a drag-pan and
		// suppress the phantom selection that prior code emitted at the
		// end of every pan gesture.
		const DRAG_THRESHOLD_PX = 4;
		const offCrosshair = (
			chart as unknown as { onCrosshairMove?: (cb: (e: { time: number | null }) => void) => () => void }
		).onCrosshairMove?.((e) => {
			// Audit M-15 (2026-05-11): clear the cached time when the
			// crosshair leaves the plot area (e.time === null). Without
			// this, a later mouseup-without-hover would dispatch the
			// stale time from a prior hover.
			if (typeof e.time === 'number' && Number.isFinite(e.time)) {
				lastCrosshairTime = e.time;
			} else {
				lastCrosshairTime = null;
			}
		});
		const onMouseDown = (e: MouseEvent): void => {
			if (e.button !== 0) { return; }
			mouseDownAt = { x: e.clientX, y: e.clientY };
		};
		const onMouseUp = (e: MouseEvent): void => {
			if (e.button !== 0) { return; }
			const downAt = mouseDownAt;
			mouseDownAt = null;
			// Drag-vs-click discrimination: if the pointer moved more
			// than DRAG_THRESHOLD_PX between down and up, this was a
			// pan gesture and we suppress the selection.
			if (downAt !== null) {
				const dx = Math.abs(e.clientX - downAt.x);
				const dy = Math.abs(e.clientY - downAt.y);
				if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) { return; }
			}
			// Audit M-15: a true click outside any data point leaves
			// lastCrosshairTime === null. Skip dispatch -- the user
			// clicked empty space.
			if (lastCrosshairTime === null) { return; }
			// Audit M-33 (Tier 5): read this.hooks at FIRE time so a
			// late `setHooks` call takes effect for the next click.
			this.hooks.onSelection?.(lastCrosshairTime);
		};
		this.container.addEventListener('mousedown', onMouseDown);
		this.container.addEventListener('mouseup', onMouseUp);
		return () => {
			this.container.removeEventListener('mousedown', onMouseDown);
			this.container.removeEventListener('mouseup', onMouseUp);
			offCrosshair?.();
		};
	}

	/** Phase 6 (6.E.1): install a click listener on a freshly-applied
	 *  Vega view. Subscribes to the view's `click` event (delivered with
	 *  the scenegraph `item` whose datum contains the row); pulls
	 *  `datum[xField]` and forwards. */
	private installGeneralSelectionListener(
		handle: VegaEmbedHandle, xField: string | null,
	): () => void {
		if (!this.hooks.onSelection || xField === null) {
			return () => { /* nothing to detach */ };
		}
		// Defensive: tests substitute a stub handle that doesn't have a
		// real Vega `view`. Skip the install rather than throw -- the
		// caller has no way to wire selection without a real view, but
		// the lifecycle / family-swap tests that don't exercise
		// selection shouldn't fall over here.
		const view = (handle as { view?: { addEventListener?: Function; removeEventListener?: Function } }).view;
		if (!view || typeof view.addEventListener !== 'function') {
			return () => { /* nothing to detach */ };
		}
		// Audit M-6 (2026-05-11): only data marks should fire selection.
		// Without this filter, clicks on legend swatches, axis labels,
		// gridlines, and group/facet headers also dispatch -- sometimes
		// with a `datum` that carries the field but with the WRONG
		// value (e.g., a facet header's row-key vs the actual click
		// target). Whitelist the marks that carry true row data.
		const DATA_MARK_TYPES = new Set([
			'symbol', 'circle', 'square', 'rect', 'bar',
			'line', 'area', 'point', 'arc', 'path',
		]);
		// Audit M-33 (2026-05-11): read this.hooks INSIDE the listener
		// so a late `setHooks` swap takes effect on subsequent events.
		// The prior version pre-bound to the construction-time hooks.
		const listener = (
			_evt: unknown,
			item: { datum?: Record<string, unknown>; mark?: { marktype?: string } } | null | undefined,
		): void => {
			const datum = item?.datum;
			const marktype = item?.mark?.marktype;
			if (!datum || !(xField in datum)) { return; }
			if (marktype && !DATA_MARK_TYPES.has(marktype)) { return; }
			this.hooks.onSelection?.(datum[xField]);
		};
		(view.addEventListener as Function).call(view, 'click', listener);
		return () => {
			(view.removeEventListener as Function | undefined)?.call(view, 'click', listener);
		};
	}

	/**
	 * Tear down the current view handle. Safe to call multiple times;
	 * idempotent. After dispose, further `render()` calls return an
	 * error result.
	 */
	dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		// Megaudit M-8: dispose() is on the public API; if the applier's
		// dispose throws, the caller (webview teardown, panel close)
		// needs to know. Don't swallow here -- propagate so any failure
		// is visible in the developer console / error reporting.
		this.disposeActive();
	}

	private disposeActive(): void {
		if (this.active === null) { return; }
		const a = this.active;
		this.active = null;
		// Phase 6 (6.E.1): detach the selection-click subscription
		// BEFORE the applier disposes the underlying view, so a stale
		// crosshair / Vega event can't fire against a torn-down chart.
		try { a.detachSelectionListener(); } catch { /* nothing useful to do */ }
		// Megaudit M-8: prior code wrapped applier dispose in catch +
		// "best-effort" container.removeChild fallback. CLAUDE.md
		// prohibits "graceful degradation" -- applier disposal errors
		// MUST surface. Let them propagate; the caller's render()
		// boundary catches them and surfaces a structured RenderResult
		// with stage='dispose'. The container is the applier's
		// responsibility (it created the DOM); papering over with a
		// forced clear desyncs whatever the applier still owns.
		if (a.family === 'timeseries') {
			this.appliers.disposeTimeseries(a.handle as ChartHandle, this.container);
		} else {
			this.appliers.disposeGeneral(a.handle as VegaEmbedHandle, this.container);
		}
	}
}
