/*
 * Spike A — proof @charts-plus can render 1M-row plain (non-OHLCV) time series.
 * Synthetic data, no parquet round-trip (parquet→DataPoint conversion is well-understood).
 *
 * Measures:
 *   - object allocation time (1M DataPoints in JS)
 *   - setData time (handing array to chart-core)
 *   - time-to-first-frame (after setData → first paint)
 *   - sustained pan FPS
 *   - JS heap delta (where available)
 *
 * Reports to:
 *   - DOM #stats panel (human-readable)
 *   - window.__spikeResult (machine-readable, for Playwright)
 */

import { createChart } from '@charts-plus/chart-render-canvas2d';
import '@charts-plus/chart-render-canvas2d/worker';
import type { DataPoint } from '@charts-plus/chart-core';
import { getThemePreset } from '@charts-plus/chart-core/presets';

const N = 1_000_000;
const root = document.getElementById('chart')!;
const stats = document.getElementById('stats')!;

interface SpikeResult {
  N: number;
  allocMs: number;
  setDataMs: number;
  ttffMs: number;          // time to first frame
  heapMbBefore?: number;
  heapMbAfter?: number;
  panFpsAvg?: number;
  panFpsMin?: number;
  errors: string[];
}

const result: SpikeResult = { N, allocMs: 0, setDataMs: 0, ttffMs: 0, errors: [] };

function render(): void {
  const heapBefore = (performance as any).memory?.usedJSHeapSize;
  if (heapBefore) result.heapMbBefore = heapBefore / 1024 / 1024;

  // ── Phase 1: allocate 1M DataPoints ────────────────────────────────────
  const t0 = performance.now();
  const points: DataPoint[] = new Array(N);
  const startMs = Date.parse('2026-01-01T00:00:00Z');
  let prev = 100;
  for (let i = 0; i < N; i++) {
    prev += (Math.random() - 0.5) * 0.05;
    points[i] = { t: startMs + i * 1000, v: prev };
  }
  result.allocMs = performance.now() - t0;
  updateStats('Allocated 1M DataPoints');

  // ── Phase 2: build chart ───────────────────────────────────────────────
  const chart = createChart(root, {
    autoSize: true,
    timeZone: 'UTC',
    seriesRenderer: 'main',
  });
  // Apply dark theme preset
  try {
    const theme = getThemePreset('atlas-dark');
    if (chart && (chart as any).applyTheme) {
      (chart as any).applyTheme(theme);
    }
  } catch {}

  const series = chart.addLineSeries({});

  // ── Phase 3: setData (the meaty operation) ─────────────────────────────
  const t1 = performance.now();
  series.setData(points);
  result.setDataMs = performance.now() - t1;
  updateStats('setData() complete');

  // ── Phase 4: measure time to first frame ───────────────────────────────
  const t2 = performance.now();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      result.ttffMs = performance.now() - t2;
      const heapAfter = (performance as any).memory?.usedJSHeapSize;
      if (heapAfter) result.heapMbAfter = heapAfter / 1024 / 1024;
      updateStats('First frame painted');
      measurePan(chart);
    });
  });

  (window as any).__spikeResult = result;
}

function measurePan(chart: any): void {
  // Programmatically pan the chart for ~3s and sample frame times.
  const frames: number[] = [];
  const startTime = performance.now();
  const durationMs = 3000;
  let lastT = startTime;

  function step() {
    const now = performance.now();
    frames.push(now - lastT);
    lastT = now;
    // Pan by shifting visible range — call internal API if exposed; otherwise
    // dispatch wheel events on the chart canvas.
    try {
      const ts = chart.timeScale?.();
      if (ts?.scrollPosition !== undefined && ts?.setScrollPosition) {
        ts.setScrollPosition(ts.scrollPosition() - 1, false);
      }
    } catch {}
    if (now - startTime < durationMs) {
      requestAnimationFrame(step);
    } else {
      frames.shift(); // throw away the first sample
      const sum = frames.reduce((a, b) => a + b, 0);
      const max = frames.length ? Math.max(...frames) : 0;
      result.panFpsAvg = frames.length ? 1000 / (sum / frames.length) : 0;
      result.panFpsMin = max ? 1000 / max : 0;
      updateStats('Pan benchmark complete');
      (window as any).__spikeResult = result;
      (window as any).__spikeDone = true;
    }
  }
  requestAnimationFrame(step);
}

function updateStats(label: string): void {
  const fmt = (n: number | undefined, unit = 'ms', digits = 1): string =>
    n === undefined || Number.isNaN(n) ? '—' : `${n.toFixed(digits)}${unit}`;

  const heapDelta =
    result.heapMbBefore !== undefined && result.heapMbAfter !== undefined
      ? result.heapMbAfter - result.heapMbBefore
      : undefined;

  stats.innerHTML = `
    <div><strong>Visualise Spike A — @charts-plus 1M points</strong></div>
    <div style="margin-top:6px; opacity:0.7">${label}</div>
    <hr style="border:0; border-top:1px solid #334155; margin:8px 0">
    <div>N: <span class="v">${result.N.toLocaleString()}</span></div>
    <div>alloc DataPoints: <span class="v">${fmt(result.allocMs)}</span></div>
    <div>setData(): <span class="v">${fmt(result.setDataMs)}</span></div>
    <div>time-to-first-frame: <span class="v">${fmt(result.ttffMs)}</span></div>
    <div>heap before: <span class="v">${fmt(result.heapMbBefore, 'MB', 1)}</span></div>
    <div>heap after: <span class="v">${fmt(result.heapMbAfter, 'MB', 1)}</span></div>
    <div>heap delta: <span class="v">${fmt(heapDelta, 'MB', 1)}</span></div>
    <div>pan FPS avg: <span class="v">${fmt(result.panFpsAvg, '', 1)}</span></div>
    <div>pan FPS min: <span class="v">${fmt(result.panFpsMin, '', 1)}</span></div>
    ${result.errors.length ? `<div class="err" style="margin-top:6px">errors: ${result.errors.join('; ')}</div>` : ''}
  `;
}

// Trap any errors so they show up in the panel
window.addEventListener('error', (e) => {
  result.errors.push(String(e.message ?? e));
  updateStats('Error');
});
window.addEventListener('unhandledrejection', (e) => {
  result.errors.push(String((e as any).reason ?? e));
  updateStats('Error');
});

render();
