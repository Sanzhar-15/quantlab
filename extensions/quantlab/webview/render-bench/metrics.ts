/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **FE-2 BAKEOFF (2026-06-09) -- frame-timing statistics + the FE-2 perf gates.**
 *
 * Pure (no DOM, no vscode). The bench collects per-frame durations (ms) + per-scenario heap
 * readings, then this module reduces them to the metrics the brief's FE-2 gates are stated in
 * (p50/p95 fps, p95 frame ms, worst-1s fps, input-to-paint p95, damage p95) and evaluates PASS/FAIL.
 *
 * **No silent caps (brief):** the raw sample count + any dropped/sampled note is carried in
 * {@link ScenarioMetrics.samples} / `note`, so the report always shows what was measured, never a
 * silently-truncated window.
 */

/** A single FE-2 gate evaluation. */
export interface GateResult {
	readonly name: string;
	/** The measured value (the units are in `unit`). */
	readonly value: number;
	readonly unit: string;
	/** The threshold the brief states. */
	readonly threshold: number;
	/** '>=' (a floor, e.g. fps) or '<=' (a ceiling, e.g. frame ms). */
	readonly comparator: '>=' | '<=';
	readonly pass: boolean;
}

/** Percentile (linear interpolation) of a sample set. p in [0,100]. Empty -> NaN. */
export function percentile(samples: readonly number[], p: number): number {
	if (samples.length === 0) {
		return NaN;
	}
	const sorted = [...samples].sort((a, b) => a - b);
	if (sorted.length === 1) {
		return sorted[0];
	}
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) {
		return sorted[lo];
	}
	const frac = rank - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** ms-per-frame -> frames-per-second. A zero/negative frame time clamps to a large fps (a sub-ms
 * frame should not divide-by-zero). */
export function msToFps(ms: number): number {
	if (!(ms > 0)) {
		return Number.POSITIVE_INFINITY;
	}
	return 1000 / ms;
}

/**
 * The worst (lowest) fps sustained over any 1-second sliding window of consecutive frames -- the
 * brief's "worst-1s >= 50fps" gate. We slide a window whose frame-time sum first reaches >= 1000ms
 * and take its frame-count*1000/sum as that window's fps, returning the MIN across all windows.
 * Fewer than 1s of frames -> the whole run's fps (documented: a short run cannot have a 1s worst).
 */
export function worstOneSecondFps(frameMs: readonly number[]): number {
	if (frameMs.length === 0) {
		return NaN;
	}
	const total = frameMs.reduce((a, b) => a + b, 0);
	if (total <= 1000) {
		return msToFps(total / frameMs.length);
	}
	let worst = Number.POSITIVE_INFINITY;
	let lo = 0;
	let windowSum = 0;
	for (let hi = 0; hi < frameMs.length; hi += 1) {
		windowSum += frameMs[hi];
		while (windowSum >= 1000 && lo <= hi) {
			const count = hi - lo + 1;
			const fps = (count * 1000) / windowSum;
			if (fps < worst) {
				worst = fps;
			}
			windowSum -= frameMs[lo];
			lo += 1;
		}
	}
	return worst === Number.POSITIVE_INFINITY ? msToFps(total / frameMs.length) : worst;
}

/** Reduced metrics for one bench scenario on one dataset. */
export interface ScenarioMetrics {
	readonly scenario: string;
	readonly dataset: string;
	/** Number of frame samples collected (no silent cap -- this is the real count). */
	readonly samples: number;
	readonly p50Fps: number;
	readonly p95FrameMs: number;
	readonly worst1sFps: number;
	/** Peak JS heap (MB) observed during the scenario, or NaN if performance.memory is unavailable. */
	readonly heapMb: number;
	/** Optional free-form note (e.g. "performance.memory unavailable; heap not measured"). */
	readonly note?: string;
}

/** Reduce raw frame durations (ms) + an optional heap reading into a {@link ScenarioMetrics}. */
export function reduceScenario(
	scenario: string,
	dataset: string,
	frameMs: readonly number[],
	heapMb: number,
	note?: string,
): ScenarioMetrics {
	return {
		scenario,
		dataset,
		samples: frameMs.length,
		p50Fps: msToFps(percentile(frameMs, 50)),
		p95FrameMs: percentile(frameMs, 95),
		worst1sFps: worstOneSecondFps(frameMs),
		heapMb,
		note,
	};
}

/** The FE-2 scroll gates (brief): p50 >= 58fps, p95 frame <= 24ms, worst-1s >= 50fps. */
export function scrollGates(m: ScenarioMetrics): GateResult[] {
	return [
		{ name: 'scroll p50 fps', value: m.p50Fps, unit: 'fps', threshold: 58, comparator: '>=', pass: m.p50Fps >= 58 },
		{ name: 'scroll p95 frame', value: m.p95FrameMs, unit: 'ms', threshold: 24, comparator: '<=', pass: m.p95FrameMs <= 24 },
		{ name: 'scroll worst-1s fps', value: m.worst1sFps, unit: 'fps', threshold: 50, comparator: '>=', pass: m.worst1sFps >= 50 },
	];
}

/** The input-to-paint gate (brief): p95 <= 32ms. */
export function inputGate(p95Ms: number): GateResult {
	return { name: 'input-to-paint p95', value: p95Ms, unit: 'ms', threshold: 32, comparator: '<=', pass: p95Ms <= 32 };
}

/** The visible-damage gates (brief): p95 <= 16ms for a 1-cell damage, <= 50ms for a 1k-cell damage. */
export function damageGates(p95OneCellMs: number, p95ThousandMs: number): GateResult[] {
	return [
		{ name: 'damage p95 (1 cell)', value: p95OneCellMs, unit: 'ms', threshold: 16, comparator: '<=', pass: p95OneCellMs <= 16 },
		{ name: 'damage p95 (1k cells)', value: p95ThousandMs, unit: 'ms', threshold: 50, comparator: '<=', pass: p95ThousandMs <= 50 },
	];
}

/** The heap gate (brief): <= 350MB plain. NaN (unmeasurable) -> reported, not a pass. */
export function heapGate(heapMb: number): GateResult {
	return { name: 'heap (plain)', value: heapMb, unit: 'MB', threshold: 350, comparator: '<=', pass: heapMb <= 350 };
}
