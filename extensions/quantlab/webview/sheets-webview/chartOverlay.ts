/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave Q2a (2026-06-24) -- chart overlay objects on the sheets grid.**
 *
 * A {@link ChartOverlayManager} owns a set of floating chart DOM containers, one per persistent chart
 * object (engine `ChartObject`, surfaced on each `render` message's `charts[]`). Each container is an
 * absolutely-positioned child of the scroller's CONTENT layer (a sibling of the cell-editor `<input>`),
 * so it tracks scroll naturally; positioning + frozen-pinning + sticky-band clipping are injected by the
 * host webview (mirroring its editor-overlay maths) via {@link ChartOverlayDeps}.
 *
 * Rendering reuses the qviz GENERAL family directly (`compileGeneralPlan` + `applyGeneralPlan` -> lazy
 * Vega-Lite) -- this covers line / bar / scatter and deliberately AVOIDS `@charts-plus` (the timeseries
 * path) so the sheets bundle pulls no Charts-repo coupling. Data is re-pulled from the snapshot on every
 * sync (the live-update: a recalc re-posts `render`, the chart re-reads its source range), with a coarse
 * data-signature memo so an UNRELATED edit elsewhere does not re-embed every chart.
 *
 * No-Fallbacks discipline: a compile/render failure is shown IN the chart box (loud) + logged, never a
 * silent blank; a chart whose source lives on another sheet (not in the active snapshot) shows an explicit
 * note rather than fabricating empty data.
 */

import { compileGeneralPlan, CompileGeneralPlanError } from '../../src/qviz/render/general';
import { applyGeneralPlan, disposeView, type VegaEmbedHandle } from '../../src/qviz/render/general-applier';
import type { QvizTheme } from '../../src/qviz/render/types';
import type { ChartJson, QuantbookCellValue } from '../../src/quantbook/types';
import { buildChartData } from './chartDataLogic';

/** The webview-supplied hooks the manager needs (all the grid-geometry/state it must not reach for itself). */
export interface ChartOverlayDeps {
	/** The scroller's CONTENT layer to mount chart containers into (the same parent as the cell editor). */
	readonly mount: HTMLElement;
	/** Post a message to the extension host (`vscode.postMessage`). */
	readonly post: (msg: unknown) => void;
	/** The anchor cell's CONTENT-coordinate top-left (frozen-pinned), mirroring the editor overlay. */
	readonly anchorPos: (row: number, col: number) => { left: number; top: number };
	/** Clip insets (top,left, px) so a container scrolled under the sticky header/gutter is hidden there. */
	readonly clipInsets: (left: number, top: number, width: number, height: number) => { top: number; left: number };
	/** Read a cell's COMPUTED value on the ACTIVE sheet (the only sheet the current snapshot carries). */
	readonly readCell: (row: number, col: number) => QuantbookCellValue | undefined;
	/** A column's A1 letter label (synthesised series/axis names when there is no header row). */
	readonly columnLabel: (col: number) => string;
	/** The current chart theme (read from the webview's VS Code CSS variables). */
	readonly theme: () => QvizTheme;
}

interface ChartEntry {
	chart: ChartJson;
	readonly root: HTMLElement;
	readonly body: HTMLElement;
	readonly titleEl: HTMLElement;
	handle: VegaEmbedHandle | undefined;
	/** Signature of the last data+type successfully (or attemptedly) embedded -- skip re-embed when unchanged. */
	lastSig: string | undefined;
	/** Serialises async embeds on this container so overlapping renders never race the same DOM node. */
	chain: Promise<void>;
	/** Set by {@link ChartOverlayManager.destroyEntry} so an embed that resolves AFTER teardown disposes its
	 *  late-created Vega view instead of leaking it on a detached DOM node (the use-after-free guard). */
	destroyed: boolean;
}

export class ChartOverlayManager {
	private readonly deps: ChartOverlayDeps;
	private readonly entries = new Map<number, ChartEntry>();
	private activeSheet: number | null = null;

	constructor(deps: ChartOverlayDeps) {
		this.deps = deps;
	}

	/**
	 * Reconcile the overlay set with the workbook's charts for the active sheet, then position + (re)render
	 * each. Charts on OTHER sheets are not shown (their data is not in this snapshot); switching sheets fires a
	 * fresh `render` whose `charts[]` + active sheet drive the swap. `charts` is the trusted host->webview
	 * `listCharts()` payload (same channel as `names[]`/`tables[]`).
	 */
	sync(charts: readonly ChartJson[], activeSheet: number): void {
		this.activeSheet = activeSheet;
		const visible = charts.filter(c => c.sheet === activeSheet);
		const visibleIds = new Set<number>(visible.map(c => c.id));
		for (const [id, entry] of this.entries) {
			if (!visibleIds.has(id)) {
				this.destroyEntry(entry);
				this.entries.delete(id);
			}
		}
		for (const chart of visible) {
			let entry = this.entries.get(chart.id);
			if (entry === undefined) {
				entry = this.createEntry(chart);
				this.entries.set(chart.id, entry);
			} else {
				entry.chart = chart;
			}
			this.positionEntry(entry);
			this.renderEntry(entry);
		}
	}

	/** Re-position (+ re-clip) every visible container. Called on scroll (frozen-pin + clip track the scroll). */
	reposition(): void {
		for (const entry of this.entries.values()) {
			this.positionEntry(entry);
		}
	}

	/** Tear down every container + Vega view (dispose / full reset). */
	clear(): void {
		for (const entry of this.entries.values()) {
			this.destroyEntry(entry);
		}
		this.entries.clear();
	}

	/** Re-embed every visible chart from the CURRENT theme. The data is unchanged on a VS Code theme switch, so
	 *  the {@link renderEntry} signature memo would otherwise skip the re-embed and leave the chart in the old
	 *  palette -- invalidate each signature so the next {@link renderEntry} re-embeds from the fresh `theme()`. */
	retheme(): void {
		for (const entry of this.entries.values()) {
			entry.lastSig = undefined;
			this.renderEntry(entry);
		}
	}

	private createEntry(chart: ChartJson): ChartEntry {
		const root = document.createElement('div');
		root.className = 'qb-chart-overlay';
		root.setAttribute('data-chart-id', String(chart.id));
		const head = document.createElement('div');
		head.className = 'qb-chart-head';
		const titleEl = document.createElement('span');
		titleEl.className = 'qb-chart-title';
		const close = document.createElement('button');
		close.type = 'button';
		close.className = 'qb-chart-close';
		close.title = 'Delete chart';
		close.setAttribute('aria-label', 'Delete chart');
		close.textContent = '×';
		// The host validates the id + surfaces a [chart_not_found] LOUD (No-Fallbacks); the overlay drops on
		// the next render's charts[]. mousedown preventDefault keeps grid focus stable through the click.
		close.addEventListener('mousedown', ev => ev.preventDefault());
		close.addEventListener('click', () => {
			this.deps.post({ type: 'chartDeleted', id: chart.id });
		});
		head.appendChild(titleEl);
		head.appendChild(close);
		const body = document.createElement('div');
		body.className = 'qb-chart-body';
		root.appendChild(head);
		root.appendChild(body);
		this.deps.mount.appendChild(root);
		return { chart, root, body, titleEl, handle: undefined, lastSig: undefined, chain: Promise.resolve(), destroyed: false };
	}

	private destroyEntry(entry: ChartEntry): void {
		// Mark destroyed FIRST so an embed still in flight on this entry's chain disposes its late-created Vega
		// view (see renderEntry) instead of leaking it on the now-detached DOM node.
		entry.destroyed = true;
		if (entry.handle !== undefined) {
			disposeView(entry.handle, entry.body);
			entry.handle = undefined;
		}
		entry.root.remove();
	}

	private positionEntry(entry: ChartEntry): void {
		const c = entry.chart;
		const pos = this.deps.anchorPos(c.anchorRow, c.anchorCol);
		entry.root.style.left = pos.left + 'px';
		entry.root.style.top = pos.top + 'px';
		entry.root.style.width = c.widthPx + 'px';
		entry.root.style.height = c.heightPx + 'px';
		const clip = this.deps.clipInsets(pos.left, pos.top, c.widthPx, c.heightPx);
		entry.root.style.clipPath = 'inset(' + clip.top + 'px 0px 0px ' + clip.left + 'px)';
	}

	private renderEntry(entry: ChartEntry): void {
		const c = entry.chart;
		entry.titleEl.textContent = c.title !== undefined && c.title.length > 0 ? c.title : c.name;
		const built = buildChartData(c, this.activeSheet, this.deps.readCell, this.deps.columnLabel);
		if (!built.ok) {
			entry.lastSig = undefined;
			if (entry.handle !== undefined) {
				disposeView(entry.handle, entry.body);
				entry.handle = undefined;
			}
			entry.body.textContent = built.error;
			entry.body.classList.add('qb-chart-error');
			return;
		}
		if (built.sig === entry.lastSig) {
			// Data + type unchanged since the last embed -> skip the Vega re-embed (a memo, not a fallback: an
			// identical signature means an identical chart). An UNRELATED edit elsewhere thus costs nothing.
			return;
		}
		entry.lastSig = built.sig;
		const theme = this.deps.theme();
		entry.chain = entry.chain.then(async () => {
			// The entry may have been torn down (sheet switch / delete) between scheduling this embed and its
			// turn on the chain -> do not embed into a detached node.
			if (entry.destroyed) {
				return;
			}
			try {
				const plan = compileGeneralPlan(built.spec, built.columns, theme);
				const handle = await applyGeneralPlan(entry.body, plan, entry.handle);
				if (entry.destroyed) {
					// Torn down DURING the await -> dispose the view we just created rather than leak it (the
					// use-after-free / leak guard: destroyEntry already ran and saw handle === the OLD one).
					disposeView(handle, entry.body);
					return;
				}
				entry.handle = handle;
				entry.body.classList.remove('qb-chart-error');
			} catch (err) {
				if (entry.destroyed) {
					return; // torn down mid-embed -> nothing to surface
				}
				const detail = err instanceof CompileGeneralPlanError || err instanceof Error ? err.message : String(err);
				console.error('[sheets-webview] chart render failed (id ' + c.id + '):', err);
				if (entry.handle !== undefined) {
					disposeView(entry.handle, entry.body);
					entry.handle = undefined;
				}
				entry.body.textContent = 'Chart error: ' + detail;
				entry.body.classList.add('qb-chart-error');
				entry.lastSig = undefined; // a later identical-data render should retry rather than skip
			}
		});
	}
}
