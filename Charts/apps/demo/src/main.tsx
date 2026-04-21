import '@charts-plus/chart-render-canvas2d/worker';
import { createChart, type Chart } from '@charts-plus/chart-render-canvas2d';
import { createDrawingPlugin, type DrawingPluginAPI } from '../../../packages/chart-render-canvas2d/src/drawing-plugin';
import {
    type DataPoint,
    type OhlcDataPoint,
    type PaneId,
    type SeriesRendererMode,
    type TimeMs,
    type HistogramDataPoint,
} from '@charts-plus/chart-core';
import { getThemePreset } from '@charts-plus/chart-core/presets';

// React imports for LHS Toolbar
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// --- Initialization ---

const parseSeriesRenderer = (value: string | null): SeriesRendererMode | undefined => {
    if (!value) return undefined;
    const lower = value.toLowerCase();
    if (lower === 'worker') return 'worker';
    if (lower === 'auto') return 'auto';
    if (lower === 'main') return 'main';
    return undefined;
};

const params = new URLSearchParams(window.location.search);
const seriesRenderer = parseSeriesRenderer(params.get('seriesRenderer')) ?? 'auto';

let chart: Chart;

const formatTime = (time: number) => {
    if (!Number.isFinite(time)) return '';
    const date = new Date(time);

    try {
        const range = chart.getVisibleTimeRange();
        const span = range.to - range.from;
        const dayMs = 24 * 60 * 60 * 1000;

        if (span > dayMs * 2) {
            return date.toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: span > dayMs * 365 ? 'numeric' : undefined,
            });
        }

        return date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: span < 60_000 ? '2-digit' : undefined,
        });
    } catch (e) {
        return date.toLocaleDateString();
    }
};

chart = createChart('chart', {
    autoSize: true,
    seriesRenderer,
    timeZone: 'local',
    timeFormatter: formatTime,
    timeScale: {
        elasticClamp: true,
        elasticMaxRatio: 0.12,
    },
    interaction: {
        pan: {
            freezeAxis: false,
            freezeAxisThreshold: 0.15,
        },
        crosshair: {
            snapToData: true,
        },
    },
    axis: {
        left: {
            autoScalePadding: 0.04,
            visible: false, // Ensure this is strictly respected by engine
            ticksVisible: false, // Explicitly disable ticks
            borderVisible: false, // Explicitly disable border
        },
        right: {
            autoScalePadding: 0.04,
            visible: true,
        },
    },
});

// --- Theme Application ---

// Initial Theme Setup (Forced Dark, Updated to Charcoal/Midnight)
const theme = getThemePreset('atlas-dark');
// Override to match "Midnight" Design System
theme.background = '#0b0e11';          // Main Background
theme.textColor = '#8b919e';           // Muted Text
theme.gridMajor = '#1a1d21';           // Very Subtle Grid
theme.gridMinor = '#1a1d21';           // Very Subtle Grid
theme.crosshair = '#2962ff';           // Functional Blue
theme.tooltipBackground = '#14161a';   // Sidebar/Panel Color
theme.tooltipText = '#e6e8eb';         // Primary Text
theme.tooltipBorder = '#23262b';       // Subtle Border

chart.setTheme(theme);
document.documentElement.style.setProperty('--tooltip-bg', theme.tooltipBackground);
document.documentElement.style.setProperty('--tooltip-text', theme.tooltipText);
document.documentElement.style.setProperty('--tooltip-border', theme.tooltipBorder);

// --- Drawing Plugin ---
const drawingPlugin = createDrawingPlugin();
chart.addPlugin(drawingPlugin);
const drawingApi: DrawingPluginAPI = drawingPlugin.api;

// --- Data Loading & Series Management ---

let btcActivePaneId: PaneId | null = null;
let btcCandleSeries: any = null;
let btcLineSeries: any = null;
let btcAreaSeries: any = null;
let btcVolumeSeries: any = null;
let currentViewType: 'candle' | 'line' | 'area' = 'candle';

const updateBtcSeriesVisibility = () => {
    btcCandleSeries?.setVisible(currentViewType === 'candle');
    btcLineSeries?.setVisible(currentViewType === 'line');
    btcAreaSeries?.setVisible(currentViewType === 'area');

    // Update button text to reflect state
    const btn = document.querySelector('.dropdown-group button:nth-child(2)');
    if (btn) {
        btn.textContent = currentViewType === 'candle' ? 'Candles' :
            currentViewType === 'line' ? 'Line' : 'Area';
    }
};

const loadBitcoinData = async () => {
    try {
        const response = await fetch('/Bitcoin.csv');
        if (!response.ok) throw new Error('Failed to load Bitcoin.csv');
        const text = await response.text();
        const lines = text.split('\n').filter((l) => l.trim().length > 0);

        const ohlcData: OhlcDataPoint[] = [];
        const lineData: DataPoint[] = [];
        const volumeData: HistogramDataPoint[] = [];

        for (let i = 1; i < lines.length; i += 1) {
            const cols = lines[i]!.split(';');
            if (cols.length < 13) continue;
            const timeStr = cols[0]!.replace(/"/g, '');
            const t = new Date(timeStr).getTime() as TimeMs;
            const o = parseFloat(cols[5]!);
            const h = parseFloat(cols[6]!);
            const l = parseFloat(cols[7]!);
            const c = parseFloat(cols[8]!);
            const v = parseFloat(cols[9]!);
            if (isNaN(t) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
            ohlcData.push({ t, o, h, l, c });
            lineData.push({ t, v: c });
            if (!isNaN(v)) {
                // Muted volume colors to fit theme
                volumeData.push({ t, v, color: c >= o ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)' });
            }
        }
        ohlcData.sort((a, b) => a.t - b.t);
        lineData.sort((a, b) => a.t - b.t);
        volumeData.sort((a, b) => a.t - b.t);

        if (ohlcData.length === 0) throw new Error('No valid data found in CSV');

        if (!btcActivePaneId) {
            btcActivePaneId = chart.addPane();
            // Force hide Left Axis on this specific pane to be absolutely sure
            chart.setPaneAxisOptions(btcActivePaneId, 'left', {
                visible: false,
                ticksVisible: false,
                borderVisible: false,
            });
        }

        if (!btcCandleSeries) {
            btcCandleSeries = chart.addCandlestickSeries({
                id: 'BTC Candle',
                paneId: btcActivePaneId,
                upColor: '#089981',
                downColor: '#f23645',
                wickUpColor: '#089981',
                wickDownColor: '#f23645',
                borderVisible: false,
                axis: 'right',
            });
            btcLineSeries = chart.addLineSeries({
                id: 'BTC Line',
                paneId: btcActivePaneId,
                color: '#FF802B', // Brand Orange
                width: 2,
                visible: false,
                axis: 'right',
            });
            btcAreaSeries = chart.addAreaSeries({
                id: 'BTC Area',
                paneId: btcActivePaneId,
                topColor: 'rgba(255, 128, 43, 0.25)',
                bottomColor: 'rgba(255, 128, 43, 0.0)',
                color: '#FF802B',
                width: 2,
                visible: false,
                axis: 'right',
            });
            btcVolumeSeries = chart.addHistogramSeries({
                id: 'BTC Volume',
                paneId: btcActivePaneId,
                isVolume: true,
                color: 'rgba(120, 123, 134, 0.3)',
                axis: 'left', // CRITICAL: Use Left Axis (Hidden) to decouple from Price range
            });
        }

        btcCandleSeries.setData(ohlcData);

        // Set up data accessor for statistical channels (regression, std dev)
        drawingApi.setDataAccessor((from, to) => {
            return ohlcData.filter(d => d.t >= from && d.t <= to);
        });
        btcLineSeries.setData(lineData);
        btcAreaSeries.setData(lineData);
        btcVolumeSeries.setData(volumeData);
        btcVolumeSeries.setVisible(true);

        updateBtcSeriesVisibility();
        chart.setVisibleTimeRange({ from: ohlcData[0]!.t, to: ohlcData[ohlcData.length - 1]!.t });

    } catch (err) {
        console.error(err);
    }
};

// Start by loading data
loadBitcoinData();


// --- UI Event Listeners ---

// 1. Return Button
document.getElementById('btn-return')?.addEventListener('click', () => {
    window.location.href = '/';
});

// 2. View Toggle (Wire the "Candles" button)
const viewBtn = document.querySelector('.dropdown-group button:nth-child(2)');
if (viewBtn) {
    viewBtn.addEventListener('click', () => {
        const types: Array<'candle' | 'line' | 'area'> = ['candle', 'line', 'area'];
        currentViewType = types[(types.indexOf(currentViewType) + 1) % types.length]!;
        updateBtcSeriesVisibility();
    });
}

// 3. Fullscreen
document.getElementById('toggle-fullscreen')?.addEventListener('click', () => {
    const elem = document.documentElement;
    if (!document.fullscreenElement) {
        elem.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
});

// 4. Snapshot
document.getElementById('download-png')?.addEventListener('click', async () => {
    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
    const result = await chart.exportPng({ pixelRatio });
    if (!result) return;

    let url: string;
    let revoke = false;
    if (typeof result === 'string') {
        url = result;
    } else {
        url = URL.createObjectURL(result as Blob);
        revoke = true;
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = `charts-plus-advanced-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 0);
});

// 5. Magnet Toggle (Side Bar)
let magnetActive = false;
const magnetBtn = document.getElementById('toggle-magnet');
if (magnetBtn) {
    magnetBtn.addEventListener('click', () => {
        magnetActive = !magnetActive;
        chart.setCrosshairMode(magnetActive ? 'magnet' : 'nearest');
        magnetBtn.classList.toggle('active', magnetActive);
    });
}

// 6. Sidebar Tool Management

// --- Dropdown Management ---
let openDropdown: HTMLElement | null = null;

const closeAllDropdowns = () => {
    document.querySelectorAll('.tool-dropdown-panel.open').forEach(panel => {
        panel.classList.remove('open');
    });
    openDropdown = null;
};

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.tool-group')) {
        closeAllDropdowns();
    }
});

// Dropdown button click handlers
document.querySelectorAll('.tool-dropdown-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const toolId = (btn as HTMLElement).dataset.for;
        const panel = document.getElementById(`dropdown-${toolId?.replace('tool-', '')}`);

        if (panel) {
            const wasOpen = panel.classList.contains('open');
            closeAllDropdowns();
            if (!wasOpen) {
                panel.classList.add('open');
                openDropdown = panel;
            }
        }
    });
});

// --- Tool Button Management ---
const allToolBtns = document.querySelectorAll('#side-bar .tool-btn');
const cursorBtn = document.getElementById('tool-cursor');
const lineBtn = document.getElementById('tool-line');

// Clear all active states
const clearActiveTools = () => {
    allToolBtns.forEach(btn => btn.classList.remove('active'));
};

// Cursor (Select) Tool
cursorBtn?.addEventListener('click', () => {
    clearActiveTools();
    cursorBtn.classList.add('active');
    drawingApi.setTool('select');
    const chartEl = document.getElementById('chart');
    if (chartEl) chartEl.style.cursor = '';
});

// Line Tool
lineBtn?.addEventListener('click', () => {
    clearActiveTools();
    lineBtn.classList.add('active');
    drawingApi.setTool('line');
    const chartEl = document.getElementById('chart');
    if (chartEl) chartEl.style.cursor = 'crosshair';
});

// Line dropdown items
document.querySelectorAll('#dropdown-line .tool-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
        const toolType = (item as HTMLElement).dataset.tool;
        closeAllDropdowns();
        clearActiveTools();
        lineBtn?.classList.add('active');

        if (toolType === 'line' || toolType === 'horizontal' || toolType === 'vertical') {
            drawingApi.setTool(toolType as any);
        } else {
            drawingApi.setTool('line'); // Default to line for now
        }

        const chartEl = document.getElementById('chart');
        if (chartEl) chartEl.style.cursor = 'crosshair';
    });
});

// Fibonacci Tool
const fibBtn = document.getElementById('tool-fib');
fibBtn?.addEventListener('click', () => {
    clearActiveTools();
    fibBtn.classList.add('active');
    drawingApi.setTool('fib-retracement');
    const chartEl = document.getElementById('chart');
    if (chartEl) chartEl.style.cursor = 'crosshair';
});

// Fib dropdown items
document.querySelectorAll('#dropdown-fib .tool-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
        const text = item.textContent?.toLowerCase() ?? '';
        closeAllDropdowns();
        clearActiveTools();
        fibBtn?.classList.add('active');

        if (text.includes('extension')) {
            drawingApi.setTool('fib-extension');
        } else if (text.includes('channel')) {
            drawingApi.setTool('fib-channel');
        } else {
            drawingApi.setTool('fib-retracement');
        }

        const chartEl = document.getElementById('chart');
        if (chartEl) chartEl.style.cursor = 'crosshair';
    });
});

// Callback when line is completed - sync UI with auto-switch
drawingApi.onLineComplete(() => {
    clearActiveTools();
    cursorBtn?.classList.add('active');
    const chartEl = document.getElementById('chart');
    if (chartEl) chartEl.style.cursor = '';

    // Also update React toolbar
    const actions = (window as any).__reactToolbarActions;
    if (actions) {
        actions.setActiveTool(null);
    }
});

// Callback when fib is completed - sync UI with auto-switch
drawingApi.onFibComplete(() => {
    clearActiveTools();
    cursorBtn?.classList.add('active');
    const chartEl = document.getElementById('chart');
    if (chartEl) chartEl.style.cursor = '';

    // Also update React toolbar
    const actions = (window as any).__reactToolbarActions;
    if (actions) {
        actions.setActiveTool(null);
    }
});

// 6. OHLC Legend Logic
const ohlcLegend = document.getElementById('ohlc-legend');
const ohlcO = document.getElementById('ohlc-o');
const ohlcH = document.getElementById('ohlc-h');
const ohlcL = document.getElementById('ohlc-l');
const ohlcC = document.getElementById('ohlc-c');
const ohlcChange = document.getElementById('ohlc-change');

chart.onCrosshairMove((event) => {
    if (ohlcLegend && btcCandleSeries && event.seriesValues.has(btcCandleSeries.id)) {
        const val = event.seriesValues.get(btcCandleSeries.id)!;
        if (val.ohlc) {
            ohlcLegend.classList.add('visible');
            const { o, h, l, c } = val.ohlc;
            const change = c - o;
            const percent = (change / o) * 100;
            const isUp = c >= o;

            if (ohlcO) ohlcO.textContent = o.toLocaleString(undefined, { minimumFractionDigits: 2 });
            if (ohlcH) ohlcH.textContent = h.toLocaleString(undefined, { minimumFractionDigits: 2 });
            if (ohlcL) ohlcL.textContent = l.toLocaleString(undefined, { minimumFractionDigits: 2 });
            if (ohlcC) ohlcC.textContent = c.toLocaleString(undefined, { minimumFractionDigits: 2 });

            if (ohlcChange) {
                ohlcChange.textContent = `${change >= 0 ? '+' : ''}${change.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${percent.toFixed(2)}%)`;
                ohlcChange.className = `ohlc-value ${isUp ? 'up' : 'down'}`;
            }

            [ohlcO, ohlcH, ohlcL, ohlcC].forEach(el => {
                if (el) el.className = `ohlc-value ${isUp ? 'up' : 'down'}`;
            });
        }
    } else if (ohlcLegend) {
        ohlcLegend.classList.remove('visible');
    }
});

// --- V5.2 Performance Metrics Display ---

const perfMetrics = document.getElementById('perf-metrics');
const perfFps = document.getElementById('perf-fps');
const perfFrame = document.getElementById('perf-frame');
const perfDpr = document.getElementById('perf-dpr');
const perfToggleBtn = document.getElementById('toggle-perf');

let perfVisible = false;
let frameTimes: number[] = [];
let lastFrameTime = performance.now();
let perfUpdateTimer: number | null = null;

// Frame timing collection
const collectFrameTime = () => {
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;

    if (dt > 0 && dt < 100) { // Ignore initial/anomalous frames
        frameTimes.push(dt);
        if (frameTimes.length > 120) {
            frameTimes = frameTimes.slice(-60);
        }
    }

    if (perfVisible) {
        requestAnimationFrame(collectFrameTime);
    }
};

// Update perf display
const updatePerfDisplay = () => {
    if (!perfVisible || frameTimes.length < 5) return;

    // Calculate metrics
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16.67;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 16.67;
    const fps = Math.round(1000 / median);

    // Update display
    if (perfFps) {
        perfFps.textContent = String(fps);
        perfFps.className = 'metric-value' + (fps >= 55 ? '' : fps >= 30 ? ' warn' : ' bad');
    }
    if (perfFrame) {
        perfFrame.textContent = `${p95.toFixed(1)}ms`;
        perfFrame.className = 'metric-value' + (p95 <= 17 ? '' : p95 <= 33 ? ' warn' : ' bad');
    }
    if (perfDpr) {
        perfDpr.textContent = window.devicePixelRatio.toFixed(1);
    }
};

// Toggle perf metrics
perfToggleBtn?.addEventListener('click', () => {
    perfVisible = !perfVisible;
    perfMetrics?.classList.toggle('visible', perfVisible);
    perfToggleBtn.classList.toggle('active', perfVisible);

    if (perfVisible) {
        frameTimes = [];
        lastFrameTime = performance.now();
        requestAnimationFrame(collectFrameTime);
        perfUpdateTimer = window.setInterval(updatePerfDisplay, 500);
    } else {
        if (perfUpdateTimer !== null) {
            window.clearInterval(perfUpdateTimer);
            perfUpdateTimer = null;
        }
    }
});

// --- LHS Toolbar (React) ---
// Create a mount point for the React toolbar
const toolbarRoot = document.createElement('div');
toolbarRoot.id = 'lhs-toolbar-root';
document.body.appendChild(toolbarRoot);

// Handle tool selection from React toolbar
const handleReactToolSelect = (toolId: string) => {
    clearActiveTools();

    // Complete tool mapping from LHS toolbar IDs to drawingApi tools
    const toolMap: Record<string, string> = {
        // === LEVELS (Category 1) ===
        'h_line': 'horizontal',
        'h_ray': 'horizontal',
        'v_line': 'vertical',
        'cross_line': 'cross_line',  // H+V intersection
        'price_label': 'horizontal',  // Horizontal line with price badge

        // === TREND (Category 2) ===
        'trend_line': 'line',
        'ray': 'ray',
        'extended_line': 'extended',
        'info_line': 'line',
        'trend_angle': 'line',
        'arrow_line': 'arrow',

        // === OVERLAYS - Fibonacci (Category 5) ===
        'fib_retracement': 'fib-retracement',
        'fib_extension': 'fib-extension',
        'fib_channel': 'fib-channel',
        'auto_fib': 'fib-retracement',
        'ote_zone': 'fib-retracement',
        'fib_time_zone': 'fib-retracement',
        'fib_time_trend': 'fib-retracement',
        'fib_fan': 'fib-retracement',
        'fib_arcs': 'fib-retracement',
        'fib_circles': 'fib-retracement',
        'fib_spiral': 'fib-retracement',
        'fib_wedge': 'fib-retracement',

        // === OVERLAYS - Gann ===
        'gann_fan': 'gann_fan',
        'gann_box': 'gann_box',
        'gann_square': 'gann_box', // Use gann_box for now

        // === VOLUME (Category 4) ===
        'anchored_vwap': 'anchored_vwap',
        'fixed_range_volume_profile': 'fixed_range_volume_profile',
        'vwap_bands': 'vwap_bands', // VWAP with SD bands
        'session_vwap': 'horizontal', // Placeholder
        'anchored_vp': 'fixed_range_volume_profile', // Map to FRVP for now
        'poc_projection': 'horizontal', // Placeholder
        'value_area': 'rectangle', // Placeholderct',

        // === STRUCTURE (Category 3) - Channel tools ===
        'parallel_channel': 'parallel-channel',           // ✅ 3-point manual parallel
        'regression_trend': 'regression-trend',           // ✅ 2-point statistical regression
        'flat_top_bottom': 'flat-top-bottom',             // ✅ 2-point hybrid (horizontal + sloped)
        'disjoint_channel': 'disjoint-channel',           // ✅ 4-point independent lines
        'std_dev_channel': 'std-dev-channel',             // ✅ 2-point std dev bands
        'pitchfork': 'pitchfork',
        'schiff_pitchfork': 'pitchfork',
        'modified_schiff': 'pitchfork',
        'inside_pitchfork': 'pitchfork',
        'pitchfan': 'pitchfork',
        'pitchfan': 'pitchfork',
        'swing_label': 'swing_high',
        'bos_marker': 'bos',
        'choch_marker': 'choch',
        'invalidation_zone': 'invalidation',
        'liquidity_sweep': 'liquidity',

        // === ZONES (Category 4) - Rectangle-based tools ===
        'rectangle': 'rectangle',
        'rotated_rectangle': 'rectangle',
        'supply_demand_zone': 'supply',
        'order_block': 'order_block',
        'fair_value_gap': 'fvg',
        'breaker_block': 'breaker',
        'session_box': 'session',
        'opening_range': 'or',

        // === PATTERNS (Category 6) ===
        'xabcd_pattern': 'xabcd',
        'abcd_pattern': 'abcd',
        'cypher_pattern': 'xabcd',  // Similar 5-point pattern
        'three_drives': 'abcd',     // 4-point pattern
        'triangle_pattern': 'triangle',
        'head_shoulders': 'head_shoulders',
        'wedge_template': 'triangle',  // 3-point wedge
        'double_top_bottom': 'triangle',  // 3-point
        'elliott_impulse': 'line',
        'elliott_correction': 'line',
        'elliott_triangle': 'line',
        'elliott_double': 'line',
        'elliott_triple': 'line',
        'cyclic_lines': 'vertical',
        'time_cycles': 'vertical',
        'sine_line': 'line',

        // === PLAN (Category 7) ===
        'long_position': 'long_position',
        'short_position': 'short_position',
        'multi_target': 'multi_target',
        'scaled_entry': 'scaled_entry',
        'forecast': 'forecast',
        'projection': 'projection',
        'bars_pattern': 'bars_pattern',
        'ghost_feed': 'ghost_feed',

        // === MEASURE (Category 8) ===
        'quick_measure': 'combined_range',
        'price_range': 'price_range',
        'date_range': 'date_range',
        'combined_range': 'combined_range',
        'box_zoom': 'rectangle',

        // === SHAPES (Category 5) ===
        'rectangle': 'rectangle',
        'circle': 'circle',
        'ellipse': 'ellipse',
        'triangle_shape': 'triangle', // Maps to 3-point Triangle Pattern
        'path': 'path',
        'curve': 'curve',
        'double_curve': 'double_curve',
        'polyline': 'polyline',
        'polygon': 'polygon',  // Multi-point closed shape
        'arc': 'arc',

        // === ANNOTATE (Category 6) ===
        'text': 'text',
        'anchored_text': 'text', // Fallback to text
        'note': 'note',  // Note with icon (to implement)
        'signpost': 'pin', // Maps to Pin marker
        'callout': 'callout',  // Text with arrow (to implement)
        'price_label': 'horizontal', // Use horizontal line for price label
        'arrow_marker': 'arrow_up', // Default arrow marker
        'arrow_mark_left': 'arrow_left',
        'arrow_mark_right': 'arrow_right',
        'arrow_mark_up': 'arrow_up',
        'arrow_mark_down': 'arrow_down',
        'flag_mark': 'flag',
        // === SPECIAL / EMBED (Category 6/9) ===
        'icon': 'marker', // Map to marker
        'emoji': 'text', // Map to text
        'sticker': 'text', // Map to text
        'image': 'text', // Placeholder
        'table': 'rectangle', // Placeholder
        'price_table': 'rectangle', // Placeholder
        'tweet': 'text', // Placeholder
        'idea': 'text', // Placeholder
        'comment': 'text',
    };

    const drawingTool = toolMap[toolId] || 'select';

    console.log(`[LHS Toolbar] Selected: ${toolId} → ${drawingTool}`);

    // Warn user if tool is not yet implemented
    if (drawingTool === 'select' && toolId !== 'cursor' && toolId !== 'select') {
        console.warn(`[LHS Toolbar] Tool "${toolId}" is not yet implemented, using select mode`);
    }

    if (drawingTool === 'select') {
        drawingApi.setTool('select');
        cursorBtn?.classList.add('active');
        const chartEl = document.getElementById('chart');
        if (chartEl) chartEl.style.cursor = '';
    } else {
        drawingApi.setTool(drawingTool as any);
        const chartEl = document.getElementById('chart');
        if (chartEl) chartEl.style.cursor = 'crosshair';
    }
};

// Mount React App
const reactRoot = createRoot(toolbarRoot);

// Track visibility state
let drawingsVisible = true;
let eraserModeEnabled = false;

// Control callbacks to wire toolbar state to drawingApi
const controlCallbacks = {
    onVisibilityChange: (visible: boolean) => {
        drawingsVisible = visible;
        console.log('[Control Dock] Visibility:', visible);
        // Use drawing plugin's setVisible API which handles render internally
        drawingApi.setVisible(visible);
    },
    onEraserModeChange: (enabled: boolean) => {
        eraserModeEnabled = enabled;
        console.log('[Control Dock] Eraser mode:', enabled);
        if (enabled) {
            drawingApi.setTool('select');
            const chartEl = document.getElementById('chart');
            if (chartEl) chartEl.style.cursor = 'not-allowed';
        } else {
            const chartEl = document.getElementById('chart');
            if (chartEl) chartEl.style.cursor = '';
        }
    },
    onSnapChange: (enabled: boolean) => {
        console.log('[Control Dock] Snap:', enabled);
        // TODO: Wire to drawing plugin snap behavior
    },
    onLockChange: (enabled: boolean) => {
        console.log('[Control Dock] Lock:', enabled);
        // TODO: Wire to drawing plugin lock behavior
    },
    onDelete: () => {
        console.log('[Control Dock] Delete selected');
        drawingApi.deleteSelected();
    },
    onClearAll: () => {
        console.log('[Control Dock] Clear all');
        drawingApi.clearAll();
    },
};

reactRoot.render(<App onToolSelect={handleReactToolSelect} controlCallbacks={controlCallbacks} />);

// Export visibility for drawing plugin render check
(window as any).__drawingsVisible = () => drawingsVisible;
(window as any).__eraserMode = () => eraserModeEnabled;
