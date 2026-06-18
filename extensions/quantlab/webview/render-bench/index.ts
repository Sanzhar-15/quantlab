/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2 BAKEOFF (2026-06-09) -- the `quantbook-render-bench` webview.**
 *
 * The renderer falsifier. It drives the REAL paint path -- the SAME {@link RenderOrchestrator} +
 * {@link CanvasGridRenderer} the live cell grid uses -- against synthetic datasets ({@link datasets})
 * and measures the FE-2 perf gates ({@link metrics}). PASS => Canvas2D locks for v1; a documented
 * MISS => force GPU. The orchestrator is the extraction's Part A; this bench is what makes that
 * extraction load-bearing (the bench could not exist without the DOM-free seam).
 *
 * It is NOT the live grid: there is no host write path, no editor, no selection commit -- the bench
 * synthesizes `queryRange` snapshots + `snapshotDelta`s itself ({@link datasets}) and feeds them
 * through `orchestrator.commitSnapshot` / `orchestrator.scrollRedraw`, the exact methods a real
 * scroll/commit call. So the timings are the renderer's, on the real decision logic.
 *
 * Side-effecting entry (no exports) so the esm bundle loads via a classic `<script>` -- mirrors the
 * sheets webview. DOM/vscode-free imports only (the esbuild `HOST_RUNTIME_FILTER` must not fire);
 * the snapshot type is `import type` (erased before resolution).
 */

import type { QuantbookCellSnapshot } from '../../src/quantbook/types';
import { CanvasGridRenderer, type ActiveCell, type PublishedRange } from '../sheets-webview/canvasGrid';
import { COL_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, totalContentHeight, totalContentWidth, type SelectionRect } from '../sheets-webview/gridLayoutA1';
import { RenderOrchestrator, type RenderHost, type Viewport } from '../sheets-webview/renderOrchestrator';
import { BENCH_DATASETS, queryRange, snapshotDelta, type BenchDataset } from './datasets';
import {
	damageGates,
	heapGate,
	inputGate,
	percentile,
	reduceScenario,
	scrollGates,
	type GateResult,
	type ScenarioMetrics,
} from './metrics';

/** Minimal VS Code webview API surface (the bench posts its results back to the host panel). */
interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VSCodeApi;
type BenchWindow = Window & { __benchVscodeApi?: VSCodeApi };
const vscode: VSCodeApi = (window as BenchWindow).__benchVscodeApi ?? acquireVsCodeApi();
(window as BenchWindow).__benchVscodeApi = vscode;

// --- DOM skeleton (mirrors the sheets webview's scroller/spacer/canvas geometry so the renderer
// paints into the same layout it does live). ---

const root = document.getElementById('bench-root');
if (root === null) {
	throw new Error('render-bench: #bench-root missing from DOM');
}
root.innerHTML =
	'<h2 id="bench-title">Quantbook Render Bench (FE-2 bakeoff)</h2>' +
	'<div class="bench-controls">' +
	'<button id="bench-run" type="button">Run all datasets</button>' +
	'<span id="bench-status" class="bench-status">idle</span>' +
	'</div>' +
	'<div class="bench-viewport" id="bench-viewport" tabindex="0">' +
	'<div id="bench-spacer"></div>' +
	'<canvas id="bench-canvas"></canvas>' +
	'</div>' +
	'<pre id="bench-report" class="bench-report"></pre>';

const runBtn = document.getElementById('bench-run') as HTMLButtonElement;
const statusEl = document.getElementById('bench-status') as HTMLElement;
const viewportEl = document.getElementById('bench-viewport') as HTMLElement;
const spacerEl = document.getElementById('bench-spacer') as HTMLElement;
const canvasEl = document.getElementById('bench-canvas') as HTMLCanvasElement;
const reportEl = document.getElementById('bench-report') as HTMLElement;

const renderer = new CanvasGridRenderer(canvasEl);

// --- the bench's render state (the bench OWNS these, exactly as index.ts owns its module lets) ---

let fullSnapshot: QuantbookCellSnapshot | null = null;
const errorCells = new Map<string, string>();
let active: ActiveCell | null = { row: 0, col: 0 };
const publishedRanges: PublishedRange[] = [];
const fillPreview: SelectionRect | null = null;

function currentViewport(): Viewport {
	return {
		scrollTop: viewportEl.scrollTop,
		scrollLeft: viewportEl.scrollLeft,
		cssW: viewportEl.clientWidth,
		cssH: viewportEl.clientHeight,
	};
}
function applyCanvasTransform(scrollTop: number, scrollLeft: number): void {
	canvasEl.style.transform = 'translate(' + scrollLeft + 'px, ' + scrollTop + 'px)';
}

// The bench RenderHost: the SAME seam the live grid builds, pointed at the bench's own state. No
// formula bar / selection post / hover title side effects here (the bench is headless of those) --
// they are no-ops, which is exactly correct: they are DOM cosmetics, not part of the paint cost.
const benchHost: RenderHost = {
	renderer,
	errorCells,
	viewport: currentViewport,
	active: () => active,
	selection: () => null,
	publishedRanges: () => publishedRanges,
	fillPreview: () => fillPreview,
	// FE-3 range-pick: the bench never opens an editor, so there is never a point-mode drag preview.
	pointPreview: () => null,
	// FE-3 colored references: the bench never edits a formula, so there are never ref-highlight boxes.
	activeRefHighlights: () => [],
	// W3 frozen panes: the bench never freezes (it measures the scrolling-body blit), so 0/0.
	frozenRowCount: () => 0,
	frozenColCount: () => 0,
	// Wave F window split: the bench never splits (it measures the single-pane blit fast path).
	isSplitActive: () => false,
	// Wave G column sizing: the bench never resizes a column (it measures the uniform-width blit fast path).
	hasColSizingOverrides: () => false,
	applyCanvasTransform,
	onAfterFullRedraw: () => undefined,
	onAfterScroll: () => undefined,
	onAfterDamage: () => undefined,
};
const orchestrator = new RenderOrchestrator(benchHost);

// --- overscan: paint a window slightly larger than the viewport so a fast scroll never reveals
// un-queried cells (the live grid queries the whole sheet; the bench queries the window). ---

const OVERSCAN_ROWS = 30;
const OVERSCAN_COLS = 6;

function visibleWindow(ds: BenchDataset, v: Viewport): { r0: number; r1: number; c0: number; c1: number } {
	const r0 = Math.max(0, Math.floor(v.scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
	const r1 = Math.ceil((v.scrollTop + v.cssH) / ROW_HEIGHT) + OVERSCAN_ROWS;
	const c0 = Math.max(0, Math.floor(v.scrollLeft / COL_WIDTH) - OVERSCAN_COLS);
	const c1 = Math.ceil((v.scrollLeft + v.cssW) / COL_WIDTH) + OVERSCAN_COLS;
	return { r0, r1: Math.min(ds.rows, r1), c0, c1: Math.min(ds.cols, c1) };
}

/** Re-query the synthetic snapshot for the current window + apply it (a full redraw). Models the
 * live grid receiving a fresh `render` for a new window. */
function applyWindow(ds: BenchDataset): void {
	const v = currentViewport();
	const w = visibleWindow(ds, v);
	fullSnapshot = queryRange(ds, w.r0, w.r1, w.c0, w.c1);
	renderer.setSnapshot(fullSnapshot);
	orchestrator.redraw();
}

/** Size the spacer to the dataset's full logical extent (drives the native scrollbars). */
function sizeSpacer(ds: BenchDataset): void {
	// Cap the logical extent to the A1 max the layout helpers assume (the blank-extent dataset is the
	// full 1,048,576 x 16,384; totalContentHeight/Width already clamp to MAX_ROWS/MAX_COLS).
	spacerEl.style.height = Math.min(totalContentHeight(), ds.rows * ROW_HEIGHT + HEADER_HEIGHT) + 'px';
	spacerEl.style.width = Math.min(totalContentWidth(renderer.gutterWidthPx), ds.cols * COL_WIDTH + renderer.gutterWidthPx) + 'px';
}

// --- timing helpers ---

function nextFrame(): Promise<number> {
	return new Promise(resolve => requestAnimationFrame(t => resolve(t)));
}
function heapMb(): number {
	const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
	if (mem === undefined || typeof mem.usedJSHeapSize !== 'number') {
		return NaN;
	}
	return mem.usedJSHeapSize / (1024 * 1024);
}

// --- the scenarios ---

/** SCROLL: drive a vertical (then horizontal) auto-scroll for `frames` frames, re-querying the window
 * + painting through the orchestrator each frame, timing each frame's paint. Returns per-frame ms. */
async function scrollScenario(ds: BenchDataset, frames: number): Promise<number[]> {
	const frameMs: number[] = [];
	const maxScrollTop = Math.max(0, viewportEl.scrollHeight - viewportEl.clientHeight);
	const maxScrollLeft = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
	// Codex MED: the per-frame step MUST stay inside `computeScrollBlitA1`'s reusable-region precondition
	// (a move that exposes the whole body has NO reusable pixels -> the blit declines -> a full draw, which
	// would make this scenario silently measure the FULL path instead of the scroll fast path it claims).
	// A naive `maxScrollTop / frames` is ~10k+ px/frame on the 50k-row sheet -> always declines. So bound
	// the step to a SMALL whole-cell multiple that leaves most of the body reusable. Fail LOUD (No-Fallbacks)
	// if the viewport is too small to exercise the blit path at all (a tiny pane would measure only full draws).
	const bodyH = viewportEl.clientHeight - HEADER_HEIGHT;
	const bodyW = viewportEl.clientWidth - renderer.gutterWidthPx;
	if (bodyH <= 96 || bodyW <= 96) {
		throw new Error('render-bench: viewport too small (' + viewportEl.clientWidth + 'x' + viewportEl.clientHeight +
			') to exercise the scroll blit path -- enlarge the bench panel and re-run.');
	}
	// Step a few rows / one column per frame: small enough that the blit keeps a large reusable region (so
	// the fast path is what we time), large enough to be a real multi-cell delta (not a 1px nudge that the
	// pure math would also decline as sub-cell). Clamp below the body extent so a reusable region survives.
	const vStep = Math.min(ROW_HEIGHT * 3, bodyH - 96);
	const hStep = Math.min(COL_WIDTH, bodyW - 96);
	for (let i = 0; i < frames; i += 1) {
		if (i < frames / 2) {
			viewportEl.scrollTop = Math.min(maxScrollTop, viewportEl.scrollTop + vStep);
		} else {
			viewportEl.scrollLeft = Math.min(maxScrollLeft, viewportEl.scrollLeft + hStep);
		}
		const t0 = performance.now();
		// Re-query the window for this scroll (a real fast scroll reveals new cells), then paint via the
		// orchestrator's scroll fast path (blit + exposed-strip, the path under test).
		const w = visibleWindow(ds, currentViewport());
		fullSnapshot = queryRange(ds, w.r0, w.r1, w.c0, w.c1);
		renderer.setSnapshot(fullSnapshot);
		orchestrator.scrollRedraw();
		frameMs.push(performance.now() - t0);
		await nextFrame();
	}
	return frameMs;
}

/** DAMAGE: mutate `cellsPerFrame` visible cells per frame + commit via the orchestrator's damage path,
 * timing each commit. Returns per-frame ms. Used for both the 1-cell and 1k-cell gates. */
async function damageScenario(ds: BenchDataset, frames: number, cellsPerFrame: number): Promise<number[]> {
	applyWindow(ds); // establish a painted frame at the current (top) scroll
	const frameMs: number[] = [];
	const w = visibleWindow(ds, currentViewport());
	const rowSpan = Math.max(1, w.r1 - w.r0);
	const colSpan = Math.max(1, w.c1 - w.c0);
	for (let i = 0; i < frames; i += 1) {
		const prev = fullSnapshot as QuantbookCellSnapshot;
		const changes = [];
		for (let k = 0; k < cellsPerFrame; k += 1) {
			const row = w.r0 + ((i * 7 + k) % rowSpan);
			const col = w.c0 + ((i * 3 + k) % colSpan);
			changes.push({ row, col, value: { kind: 'number' as const, value: i * 1000 + k } });
		}
		const next = snapshotDelta(prev, changes);
		const t0 = performance.now();
		fullSnapshot = next;
		renderer.setSnapshot(next);
		orchestrator.commitSnapshot(prev, next, false);
		frameMs.push(performance.now() - t0);
		await nextFrame();
	}
	return frameMs;
}

/** INPUT-TO-PAINT: move the active cell + full-redraw, timing the paint (models a keyboard nav /
 * type causing a full repaint -- the worst-case input path). Returns per-frame ms. */
async function inputScenario(ds: BenchDataset, frames: number): Promise<number[]> {
	applyWindow(ds);
	const frameMs: number[] = [];
	const w = visibleWindow(ds, currentViewport());
	const rowSpan = Math.max(1, w.r1 - w.r0);
	const colSpan = Math.max(1, w.c1 - w.c0);
	for (let i = 0; i < frames; i += 1) {
		active = { row: w.r0 + (i % rowSpan), col: w.c0 + (i % colSpan) };
		const t0 = performance.now();
		orchestrator.redraw();
		frameMs.push(performance.now() - t0);
		await nextFrame();
	}
	return frameMs;
}

// --- the run loop ---

const SCROLL_FRAMES = 120;
const DAMAGE_FRAMES = 60;
const INPUT_FRAMES = 60;

interface DatasetReport {
	readonly dataset: string;
	readonly label: string;
	readonly scroll: ScenarioMetrics;
	readonly inputP95Ms: number;
	readonly damageOneCellP95Ms: number;
	readonly damageThousandP95Ms: number;
	readonly gates: GateResult[];
}

async function runDataset(ds: BenchDataset): Promise<DatasetReport> {
	statusEl.textContent = 'running: ' + ds.label;
	// Reset to the top + size the spacer + paint the first window.
	viewportEl.scrollTop = 0;
	viewportEl.scrollLeft = 0;
	sizeSpacer(ds);
	applyWindow(ds);
	await nextFrame();

	const scrollMs = await scrollScenario(ds, SCROLL_FRAMES);
	const peakHeap = heapMb();
	const scroll = reduceScenario('scroll', ds.id, scrollMs, peakHeap,
		Number.isNaN(peakHeap) ? 'performance.memory unavailable; heap not measured' : undefined);

	// Reset to top for the damage/input scenarios.
	viewportEl.scrollTop = 0;
	viewportEl.scrollLeft = 0;
	const damageOne = await damageScenario(ds, DAMAGE_FRAMES, 1);
	const damageThousand = await damageScenario(ds, DAMAGE_FRAMES, 1000);
	const inputMs = await inputScenario(ds, INPUT_FRAMES);

	const inputP95Ms = percentile(inputMs, 95);
	const damageOneCellP95Ms = percentile(damageOne, 95);
	const damageThousandP95Ms = percentile(damageThousand, 95);

	const gates: GateResult[] = [
		...scrollGates(scroll),
		inputGate(inputP95Ms),
		...damageGates(damageOneCellP95Ms, damageThousandP95Ms),
		heapGate(scroll.heapMb),
	];
	return { dataset: ds.id, label: ds.label, scroll, inputP95Ms, damageOneCellP95Ms, damageThousandP95Ms, gates };
}

function fmt(n: number): string {
	if (Number.isNaN(n)) {
		return 'n/a';
	}
	return n.toFixed(1);
}

function renderReport(reports: DatasetReport[]): string {
	const lines: string[] = [];
	lines.push('FE-2 BAKEOFF -- render bench results (Canvas2D, the REAL orchestrator path)');
	lines.push('dpr=' + renderer.backingScale + '  viewport=' + viewportEl.clientWidth + 'x' + viewportEl.clientHeight);
	lines.push('');
	for (const r of reports) {
		lines.push('### ' + r.label);
		lines.push('  scroll: p50=' + fmt(r.scroll.p50Fps) + 'fps  p95-frame=' + fmt(r.scroll.p95FrameMs) +
			'ms  worst-1s=' + fmt(r.scroll.worst1sFps) + 'fps  (samples=' + r.scroll.samples + ')');
		lines.push('  input-to-paint p95=' + fmt(r.inputP95Ms) + 'ms');
		lines.push('  damage p95: 1-cell=' + fmt(r.damageOneCellP95Ms) + 'ms  1k-cell=' + fmt(r.damageThousandP95Ms) + 'ms');
		lines.push('  heap=' + fmt(r.scroll.heapMb) + 'MB' + (r.scroll.note ? ' (' + r.scroll.note + ')' : ''));
		for (const g of r.gates) {
			lines.push('    [' + (g.pass ? 'PASS' : 'FAIL') + '] ' + g.name + ' = ' + fmt(g.value) + g.unit +
				' (need ' + g.comparator + ' ' + g.threshold + g.unit + ')');
		}
		lines.push('');
	}
	const allPass = reports.every(r => r.gates.every(g => g.pass));
	lines.push(allPass
		? 'VERDICT: ALL GATES PASS -> Canvas2D locks for v1.'
		: 'VERDICT: GATE MISS(ES) -> review the FAIL rows; a documented miss forces GPU.');
	return lines.join('\n');
}

async function runAll(): Promise<void> {
	runBtn.disabled = true;
	reportEl.textContent = '';
	const reports: DatasetReport[] = [];
	try {
		for (const ds of BENCH_DATASETS) {
			reports.push(await runDataset(ds));
		}
		const text = renderReport(reports);
		reportEl.textContent = text;
		statusEl.textContent = 'done';
		// Post the structured results to the host so the operator/CI can persist them.
		vscode.postMessage({ type: 'benchResults', text, reports });
	} catch (err) {
		// Codex MED / No-Fallbacks: a thrown bench error (e.g. the too-small-viewport guard, a renderer
		// failure) must be VISIBLE -- surface it in the panel AND post it to the host, never leave a blank
		// webview with no explanation. The button is re-enabled in `finally` so the operator can retry.
		const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
		statusEl.textContent = 'failed';
		reportEl.textContent = 'BENCH FAILED\n\n' + text;
		vscode.postMessage({ type: 'benchError', text });
	} finally {
		runBtn.disabled = false;
	}
}

runBtn.addEventListener('click', () => {
	void runAll();
});

// Announce readiness (mirrors the sheets webview handshake) so the host knows the bundle loaded.
vscode.postMessage({ type: 'benchReady' });
