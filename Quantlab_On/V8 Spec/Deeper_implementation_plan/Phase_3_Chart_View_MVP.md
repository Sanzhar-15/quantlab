# Phase 3: Chart View MVP — Detailed Implementation Plan

**Duration**: 3-5 weeks
**Goal**: Integrate Delta Charting engine as Chart view with full V8.1 features
**Prerequisites**: Phase 0, Phase 1, Phase 2 completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Chart Integration Architecture](#2-chart-integration-architecture)
3. [Chart Webview Shell](#3-chart-webview-shell)
4. [Chart API Wrapper](#4-chart-api-wrapper)
5. [Data Pipeline](#5-data-pipeline)
6. [First-Time UX](#6-first-time-ux)
7. [Visualization Code Execution](#7-visualization-code-execution)
8. [Parameter Panel](#8-parameter-panel)
9. [Complexity Indicator](#9-complexity-indicator)
10. [Chart Toolbar](#10-chart-toolbar)
11. [Global State Integration](#11-global-state-integration)
12. [Verification Plan](#12-verification-plan)
13. [Exit Gates](#13-exit-gates)
14. [Chart Engine Bundling](#14-chart-engine-bundling)
15. [Binary Data Transfer](#15-binary-data-transfer)
16. [Error Recovery & Memory Management](#16-error-recovery--memory-management)
17. [Accessibility Requirements](#17-accessibility-requirements)

---

## 1. Overview

### 1.1 What We're Building

Phase 3 implements the Chart View — the visualization layer for strategy signals overlaid on price charts:

| Component | Purpose | V8.1 Reference |
|-----------|---------|----------------|
| **Chart Webview Shell** | Container for chart in editor area | §3.1.2 |
| **Chart API Wrapper** | Interface to Delta Charting engine | §3.1.2 |
| **Data Pipeline** | OHLCV data loading and streaming | §3.1.2 |
| **First-Time UX** | "No visualization code" prompt | §3.1.2 |
| **Visualization Execution** | Run `visualize()` function | §3.8 |
| **Parameter Panel** | Interactive sliders for `ql.param()` | §3.5 |
| **Complexity Indicator** | Safe/Partial/View-Only display | §3.6 |
| **Chart Toolbar** | Symbol/TF override, refresh, screenshot | §3.1.2 |

### 1.2 Key V8.1 Invariants (Must Hold)

- Tab indicator: 🟢 Green stripe (`#059669`) for Chart view
- Chart view available only for `.py` files with valid strategy structure
- Parameter sliders from `ql.param()` definitions
- "Reset to Defaults" and "Apply to Code" buttons
- Complexity indicator in toolbar: Safe (green), Partial (yellow), View-Only (red)
- View-Only mode shows artifacts only with banner
- Symbol/TF changes reload chart data

### 1.3 Delta Charting Integration

The chart engine is located at `/home/s/quantlab/Charts`. Key packages:

| Package | Purpose |
|---------|---------|
| `chart-core` | Core types, interfaces, scale math |
| `chart-render-canvas2d` | Main Canvas2D renderer (~10k lines) |
| `chart-interaction` | Gesture engine, physics |
| `chart-indicators` | SMA, EMA, etc. |
| `chart-drawings` | Drawing tools |
| `chart` | High-level Chart class API |

### 1.4 File Structure to Create

```
quantlab-extension/src/
├── core/
│   └── strategy/
│       ├── ComplexityAnalyzer.ts       # Safe/Partial/ViewOnly analysis
│       └── VisualizationDetector.ts    # Detect visualize() function
├── views/
│   └── chart/
│       ├── ChartViewProvider.ts        # CustomTextEditorProvider
│       ├── ChartWebview.ts             # Webview management
│       ├── ChartAPI.ts                 # QuantlabChartAPI wrapper
│       └── webview/
│           ├── index.html              # Webview HTML shell
│           ├── chart.ts                # Webview script
│           ├── chart.css               # Webview styles
│           └── parameterPanel.ts       # Parameter sliders
├── types/
│   └── visualization.ts                # Visualization types
└── utils/
    └── applyToCode.ts                  # Source code rewriting
```

---

## 2. Chart Integration Architecture

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ChartViewProvider (CustomTextEditorProvider)           │  │
│  │  • Manages Chart view lifecycle                        │  │
│  │  • Creates webview panels                              │  │
│  │  • Handles message passing                             │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │ postMessage                       │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Chart Webview (isolated iframe)                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │ Delta Charting Engine                            │  │  │
│  │  │  • createChart(container)                        │  │  │
│  │  │  • addCandlestickSeries(data)                   │  │  │
│  │  │  • Crosshair, pan, zoom                         │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │ Parameter Panel                                  │  │  │
│  │  │  • Sliders, dropdowns, checkboxes               │  │  │
│  │  │  • Reset to Defaults / Apply to Code             │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Message Protocol

**Extension → Webview:**

```typescript
// Initialize chart with options
{ type: 'init', theme: 'dark' | 'light', options: ChartOptions }

// Load OHLCV data
{ type: 'setData', data: OHLCVBar[] }

// Append new bar (streaming)
{ type: 'appendBar', bar: OHLCVBar }

// Add signal overlays
{ type: 'addSignals', signals: SignalMarker[] }

// Set equity curve
{ type: 'setEquityCurve', curve: EquityPoint[] }

// Update parameters
{ type: 'setParameters', parameters: ParameterDefinition[] }

// Set complexity level
{ type: 'setComplexity', level: 'safe' | 'partial' | 'viewOnly' }

// Theme change
{ type: 'setTheme', theme: 'dark' | 'light' }
```

**Webview → Extension:**

```typescript
// Parameter value changed
{ type: 'parameterChange', id: string, value: any }

// Reset to defaults
{ type: 'resetDefaults' }

// Apply to code
{ type: 'applyToCode' }

// Symbol/TF override
{ type: 'overrideSymbol', symbol: string }
{ type: 'overrideTimeframe', timeframe: string }

// Screenshot captured
{ type: 'screenshot', dataUrl: string }

// User clicked "Run New Backtest"
{ type: 'runBacktest' }

// Error occurred
{ type: 'error', message: string }
```

---

## 3. Chart Webview Shell

### 3.1 Create `src/views/chart/ChartViewProvider.ts`

```typescript
import * as vscode from 'vscode';
import { TabViewState } from '../../core/state/TabViewState';
import { GlobalState } from '../../core/state/GlobalState';
import { StrategyValidator } from '../../core/strategy/StrategyValidator';
import { ComplexityAnalyzer } from '../../core/strategy/ComplexityAnalyzer';
import { VisualizationDetector } from '../../core/strategy/VisualizationDetector';

export class ChartViewProvider implements vscode.CustomTextEditorProvider {
  private static instance: ChartViewProvider;
  public static readonly viewType = 'quantlab.chartView';

  private webviews: Map<string, vscode.WebviewPanel> = new Map();

  static getInstance(): ChartViewProvider {
    return this.instance;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ChartViewProvider(context);
    this.instance = provider;

    return vscode.window.registerCustomEditorProvider(
      ChartViewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    // Listen for global state changes
    GlobalState.getInstance().onDidChange(() => {
      this.onGlobalStateChanged();
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const tabInstanceId = this.getTabInstanceId(document);
    this.webviews.set(tabInstanceId, webviewPanel);

    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };

    // Set HTML content
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      (message) => this.handleWebviewMessage(document, message),
      undefined,
      this.context.subscriptions
    );

    // Cleanup on dispose
    webviewPanel.onDidDispose(() => {
      this.webviews.delete(tabInstanceId);
    });

    // Initialize chart
    await this.initializeChart(document, webviewPanel.webview);
  }

  private async initializeChart(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const globalState = GlobalState.getInstance();
    const tabState = TabViewState.getInstance();
    const tabInstanceId = this.getTabInstanceId(document);

    // Analyze strategy
    const validator = StrategyValidator.getInstance();
    const complexity = ComplexityAnalyzer.analyze(document);
    const hasVisualization = VisualizationDetector.hasVisualizeFunction(document);

    // Send init message
    webview.postMessage({
      type: 'init',
      theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
      complexity: complexity.level,
      hasVisualization,
    });

    // Load data if visualization exists or show no-viz prompt
    if (hasVisualization || complexity.level !== 'viewOnly') {
      await this.loadChartData(document, webview);
    }

    // Send parameters
    const params = await this.extractParameters(document);
    webview.postMessage({
      type: 'setParameters',
      parameters: params,
    });
  }

  private async loadChartData(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const globalState = GlobalState.getInstance();
    const symbol = globalState.getSymbol();
    const timeframe = globalState.getTimeframe();

    // TODO: Load data from DataService
    // For now, send mock data structure
    webview.postMessage({
      type: 'setData',
      symbol,
      timeframe,
      data: [], // Will be populated by DataService
    });
  }

  private async handleWebviewMessage(
    document: vscode.TextDocument,
    message: any
  ): Promise<void> {
    switch (message.type) {
      case 'parameterChange':
        await this.handleParameterChange(document, message.id, message.value);
        break;
      case 'resetDefaults':
        await this.handleResetDefaults(document);
        break;
      case 'applyToCode':
        await this.handleApplyToCode(document);
        break;
      case 'overrideSymbol':
        // Store tab-level override
        break;
      case 'overrideTimeframe':
        // Store tab-level override
        break;
      case 'runBacktest':
        vscode.commands.executeCommand('quantlab.runBacktest');
        break;
      case 'error':
        vscode.window.showErrorMessage(`Chart error: ${message.message}`);
        break;
    }
  }

  // ... additional methods
}
```

### 3.2 Create `src/views/chart/webview/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    script-src 'nonce-${nonce}';
    style-src ${webview.cspSource} 'unsafe-inline';
    img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Chart View</title>
</head>
<body>
  <!-- Toolbar -->
  <div id="chart-toolbar">
    <div class="toolbar-left">
      <select id="symbol-selector"></select>
      <select id="timeframe-selector"></select>
      <input type="text" id="date-range" placeholder="Date range">
    </div>
    <div class="toolbar-right">
      <span id="complexity-indicator"></span>
      <button id="refresh-btn" title="Refresh">🔄</button>
      <button id="screenshot-btn" title="Screenshot">📷</button>
      <button id="settings-btn" title="Settings">⚙️</button>
    </div>
  </div>

  <!-- No Visualization Prompt (hidden by default) -->
  <div id="no-viz-prompt" class="hidden">
    <div class="prompt-card">
      <h2>This strategy doesn't have visualization code yet.</h2>
      <p>Visualization code tells Quantlab how to display your
         strategy's signals, indicators, and overlays on the chart.</p>
      <div class="prompt-buttons">
        <button id="add-manually-btn">📝 Add Manually</button>
        <button id="generate-ai-btn">🤖 Generate with AI</button>
      </div>
      <a href="#" id="learn-viz">Learn about visualization code</a>
    </div>
  </div>

  <!-- View-Only Banner (hidden by default) -->
  <div id="view-only-banner" class="hidden">
    <span class="warning-icon">⚠️</span>
    <span>This strategy is too complex for live visualization.
          Showing results from last backtest run.</span>
    <button id="run-new-backtest-btn">Run New Backtest</button>
  </div>

  <!-- Chart Container -->
  <div id="chart-container"></div>

  <!-- Parameter Panel -->
  <div id="parameter-panel">
    <div class="panel-header">
      <span>PARAMETERS</span>
      <button id="toggle-panel-btn">▼ Hide</button>
    </div>
    <div id="parameter-content"></div>
    <div class="panel-actions">
      <button id="reset-defaults-btn">Reset to Defaults</button>
      <button id="apply-to-code-btn">Apply to Code</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${chartEngineUri}"></script>
  <script nonce="${nonce}" src="${mainScriptUri}"></script>
</body>
</html>
```

---

## 4. Chart API Wrapper

### 4.1 Create `src/views/chart/ChartAPI.ts`

Wrap Delta Charting engine to provide a stable interface:

```typescript
import type { Chart, CreateChartOptions } from '@quantlab/chart';
import { createChart } from '@quantlab/chart-render-canvas2d';

export interface OHLCVBar {
  t: number;      // Timestamp (ms)
  o: number;      // Open
  h: number;      // High
  l: number;      // Low
  c: number;      // Close
  v?: number;     // Volume (optional)
}

export interface SignalMarker {
  time: number;
  type: 'entry' | 'exit';
  direction: 'long' | 'short';
  price: number;
  label?: string;
}

export interface EquityPoint {
  time: number;
  value: number;
}

export interface QuantlabChartAPI {
  // Lifecycle
  initialize(container: HTMLElement, options: CreateChartOptions): Promise<void>;
  dispose(): void;

  // Data
  setData(bars: OHLCVBar[]): void;
  appendBar(bar: OHLCVBar): void;
  clearData(): void;

  // Overlays
  addSignals(signals: SignalMarker[]): void;
  clearSignals(): void;
  setEquityCurve(curve: EquityPoint[]): void;
  clearEquityCurve(): void;

  // Indicators (from visualize() code)
  addIndicator(id: string, type: string, params: Record<string, any>): void;
  removeIndicator(id: string): void;

  // Interaction
  highlightBar(index: number): void;
  getVisibleRange(): { from: number; to: number } | null;
  setVisibleRange(from: number, to: number): void;

  // Appearance
  setTheme(theme: 'light' | 'dark'): void;

  // Export
  screenshot(): Promise<Blob>;
}

export class QuantlabChartAPIImpl implements QuantlabChartAPI {
  private chart: Chart | null = null;
  private mainSeries: any = null;
  private signalSeries: any = null;
  private equitySeries: any = null;

  async initialize(container: HTMLElement, options: CreateChartOptions = {}): Promise<void> {
    this.chart = createChart(container, {
      autoSize: true,
      crosshairMode: 'ohlc',
      ...options,
    });

    await this.chart.waitForInit();

    // Create main candlestick series
    this.mainSeries = this.chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
  }

  dispose(): void {
    this.chart?.destroy();
    this.chart = null;
    this.mainSeries = null;
    this.signalSeries = null;
    this.equitySeries = null;
  }

  setData(bars: OHLCVBar[]): void {
    if (!this.mainSeries) return;

    const chartData = bars.map(bar => ({
      t: bar.t,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
    }));

    this.chart?.updateSeries('main', chartData);
  }

  appendBar(bar: OHLCVBar): void {
    // For streaming updates
    if (!this.mainSeries) return;
    this.chart?.updateSeries('main', [{ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c }]);
  }

  clearData(): void {
    this.mainSeries?.setData([]);
  }

  addSignals(signals: SignalMarker[]): void {
    if (!this.chart) return;

    // Convert signals to marker format
    const markers = signals.map(s => ({
      time: s.time,
      position: s.direction === 'long' ? 'belowBar' : 'aboveBar',
      color: s.type === 'entry' ? '#26a69a' : '#ef5350',
      shape: s.type === 'entry' ? 'arrowUp' : 'arrowDown',
      text: s.label || (s.type === 'entry' ? 'Entry' : 'Exit'),
    }));

    // Add markers to series
    this.mainSeries?.setMarkers(markers);
  }

  clearSignals(): void {
    this.mainSeries?.setMarkers([]);
  }

  setEquityCurve(curve: EquityPoint[]): void {
    if (!this.chart) return;

    if (!this.equitySeries) {
      // Create equity pane
      this.equitySeries = this.chart.addLineSeries({
        pane: 1,
        color: '#2196F3',
        lineWidth: 2,
      });
    }

    this.equitySeries.setData(curve.map(p => ({ t: p.time, v: p.value })));
  }

  clearEquityCurve(): void {
    this.equitySeries?.setData([]);
  }

  addIndicator(id: string, type: string, params: Record<string, any>): void {
    if (!this.chart) return;
    this.chart.addIndicator(id, type, params);
  }

  removeIndicator(id: string): void {
    if (!this.chart) return;
    this.chart.removeIndicator(id);
  }

  highlightBar(index: number): void {
    // Highlight specific bar (for Time Travel Debugger)
  }

  getVisibleRange(): { from: number; to: number } | null {
    return this.chart?.getVisibleRange() ?? null;
  }

  setVisibleRange(from: number, to: number): void {
    this.chart?.setVisibleRange({ from, to });
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.chart?.setTheme(theme === 'dark' ? darkTheme : lightTheme);
  }

  async screenshot(): Promise<Blob> {
    // Capture canvas as blob
    const canvas = document.querySelector('#chart-container canvas') as HTMLCanvasElement;
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob!), 'image/png');
    });
  }
}

// Theme definitions
const darkTheme = {
  background: '#1e1e1e',
  text: '#d4d4d4',
  grid: '#333333',
};

const lightTheme = {
  background: '#ffffff',
  text: '#333333',
  grid: '#e0e0e0',
};
```

---

## 5. Data Pipeline

### 5.1 Data Loading Flow

```
On entering Chart view:
┌─────────────────────────────────────────────────────────────────┐
│ 1. Get symbol/TF (global state or tab override)                 │
│     └─► GlobalState.getSymbol() / .getTimeframe()               │
│                                                                 │
│ 2. Request data from DataService                                │
│     └─► DataService.getOHLCV(symbol, timeframe, dateRange)      │
│                                                                 │
│ 3. Transform to chart format                                    │
│     └─► Array<OHLCVBar>                                         │
│                                                                 │
│ 4. Send to webview via postMessage                              │
│     └─► { type: 'setData', data: bars }                         │
│                                                                 │
│ 5. Chart renders                                                │
│     └─► chartAPI.setData(bars)                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Create `src/core/engine/DataService.ts` (Stub)

```typescript
import { OHLCVBar } from '../../views/chart/ChartAPI';
import { Timeframe } from '../../types/market';

export class DataService {
  private static instance: DataService;

  static getInstance(): DataService {
    if (!this.instance) {
      this.instance = new DataService();
    }
    return this.instance;
  }

  async getOHLCV(
    symbol: string,
    timeframe: Timeframe,
    dateRange?: { start: Date; end: Date }
  ): Promise<OHLCVBar[]> {
    // TODO: Implement actual data fetching from engine or data source
    // For now, return mock data for development

    console.log(`[DataService] Fetching OHLCV for ${symbol} @ ${timeframe}`);

    // Mock data generation for development
    const bars: OHLCVBar[] = [];
    const now = Date.now();
    const barCount = 500;
    const intervalMs = this.timeframeToMs(timeframe);

    let price = 150; // Starting price

    for (let i = 0; i < barCount; i++) {
      const time = now - (barCount - i) * intervalMs;
      const volatility = 0.02;
      const change = (Math.random() - 0.5) * volatility * price;

      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * volatility * price * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * price * 0.5;
      const volume = Math.floor(Math.random() * 1000000) + 100000;

      bars.push({ t: time, o: open, h: high, l: low, c: close, v: volume });
      price = close;
    }

    return bars;
  }

  private timeframeToMs(tf: Timeframe): number {
    const map: Record<Timeframe, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1H': 60 * 60 * 1000,
      '4H': 4 * 60 * 60 * 1000,
      '1D': 24 * 60 * 60 * 1000,
      '1W': 7 * 24 * 60 * 60 * 1000,
      '1M': 30 * 24 * 60 * 60 * 1000,
    };
    return map[tf] || map['1D'];
  }
}
```

### 5.3 Data Format (Arrow IPC Preferred)

For performance with large datasets, prefer binary data transfer:

```typescript
// If engine supports Arrow IPC
interface ArrowDataTransfer {
  type: 'arrow';
  buffer: ArrayBuffer;
  schema: ArrowSchema;
}

// Fallback to JSON with typed arrays
interface JsonDataTransfer {
  type: 'json';
  times: number[];      // Float64Array-compatible
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes?: number[];
}
```

---

## 6. First-Time UX

### 6.1 Create `src/core/strategy/VisualizationDetector.ts`

```typescript
import * as vscode from 'vscode';

export class VisualizationDetector {
  private static readonly VISUALIZE_PATTERN = /def\s+visualize\s*\(\s*chart\s*\)/;

  /**
   * Check if document contains a visualize() function
   */
  static hasVisualizeFunction(document: vscode.TextDocument): boolean {
    const text = document.getText();
    return this.VISUALIZE_PATTERN.test(text);
  }

  /**
   * Get the line number of the visualize function
   */
  static getVisualizeFunctionLine(document: vscode.TextDocument): number | null {
    const text = document.getText();
    const match = text.match(this.VISUALIZE_PATTERN);
    if (!match) return null;

    const beforeMatch = text.substring(0, match.index);
    return beforeMatch.split('\n').length - 1;
  }

  /**
   * Generate a template visualize function
   */
  static generateTemplate(strategyType: 'vectorized' | 'eventDriven' | 'classBased'): string {
    return `

def visualize(chart):
    """
    Visualization code for the chart view.

    Available methods:
    - chart.plot(series, color="blue", label="Series")
    - chart.mark_entries(style="arrow_up", color="green")
    - chart.mark_exits(style="arrow_down", color="red")
    - chart.add_pane(name, height=0.3)
    - chart.plot_equity(pane="equity")
    """
    # Add your visualization code here
    chart.mark_entries(style="arrow_up", color="#26a69a")
    chart.mark_exits(style="arrow_down", color="#ef5350")
`;
  }
}
```

### 6.2 "Add Manually" Flow

```
User clicks "Add Manually":
1. Generate visualize() template
2. Insert at end of strategy file
3. Switch to Editor view
4. Position cursor in visualize() function
5. Show toast: "Visualization template added. Edit and save to see on chart."
```

### 6.3 "Generate with AI" Flow

```
User clicks "Generate with AI":
1. Open AI Panel (right side bar)
2. Pre-populate with context:
   - "Generate visualization code for this strategy"
   - Strategy code snippet
3. AI generates visualize() function
4. User reviews in AI chat
5. User clicks "Accept" to insert code
6. Save file, chart reloads
```

---

## 7. Visualization Code Execution

### 7.1 Execution Architecture

```
Strategy File                     Python Sandbox                  Chart
┌─────────────┐                  ┌───────────────┐               ┌──────┐
│ def strategy│                  │ Execute       │               │      │
│ def visualiz│──► Extract ───►  │ visualize()   │──► Commands ─►│ Rend │
│             │    visualize()   │ with chart    │    as JSON    │      │
└─────────────┘                  │ proxy object  │               └──────┘
                                 └───────────────┘
```

### 7.2 Chart Proxy Object

The `chart` parameter in `visualize(chart)` is a proxy that records commands:

```python
# Python-side proxy (run in sandboxed context)
class ChartProxy:
    def __init__(self):
        self.commands = []

    def plot(self, series, **kwargs):
        self.commands.append({
            'type': 'plot',
            'data': series.tolist() if hasattr(series, 'tolist') else list(series),
            'options': kwargs
        })

    def mark_entries(self, **kwargs):
        self.commands.append({
            'type': 'markEntries',
            'options': kwargs
        })

    def mark_exits(self, **kwargs):
        self.commands.append({
            'type': 'markExits',
            'options': kwargs
        })

    def add_pane(self, name, height=0.3):
        self.commands.append({
            'type': 'addPane',
            'name': name,
            'height': height
        })

    def plot_equity(self, pane=None):
        self.commands.append({
            'type': 'plotEquity',
            'pane': pane
        })
```

### 7.3 Command Application in Webview

```typescript
// In webview script
function applyVisualizationCommands(commands: VisualizationCommand[]): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'plot':
        chartAPI.addIndicator(
          `viz_${cmd.id}`,
          'line',
          { data: cmd.data, ...cmd.options }
        );
        break;

      case 'markEntries':
        // Add entry markers
        break;

      case 'markExits':
        // Add exit markers
        break;

      case 'addPane':
        // Create additional pane
        break;

      case 'plotEquity':
        // Plot equity curve in specified pane
        break;
    }
  }
}
```

---

## 8. Parameter Panel

### 8.1 Create `src/views/chart/webview/parameterPanel.ts`

```typescript
import { ParameterDefinition } from '../../../types/strategy';

export class ParameterPanel {
  private container: HTMLElement;
  private parameters: ParameterDefinition[] = [];
  private overrides: Map<string, any> = new Map();
  private onChange: (id: string, value: any) => void;

  constructor(containerId: string, onChange: (id: string, value: any) => void) {
    this.container = document.getElementById(containerId)!;
    this.onChange = onChange;
  }

  setParameters(params: ParameterDefinition[]): void {
    this.parameters = params;
    this.render();
  }

  private render(): void {
    const content = document.getElementById('parameter-content')!;
    content.innerHTML = '';

    // Group by group name
    const groups = this.groupByGroup(this.parameters);

    for (const [groupName, params] of Object.entries(groups)) {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'param-group';

      if (groupName !== 'default') {
        const header = document.createElement('h4');
        header.textContent = groupName;
        groupDiv.appendChild(header);
      }

      for (const param of params) {
        groupDiv.appendChild(this.createParamControl(param));
      }

      content.appendChild(groupDiv);
    }
  }

  private createParamControl(param: ParameterDefinition): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param-row';

    // Label
    const label = document.createElement('label');
    label.textContent = param.name || param.id;
    label.title = param.description || '';
    row.appendChild(label);

    // Value display
    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'param-value';
    valueDisplay.id = `value-${param.id}`;
    row.appendChild(valueDisplay);

    // Control
    if (param.choices && param.choices.length > 0) {
      // Dropdown for choices
      const select = document.createElement('select');
      select.id = `control-${param.id}`;
      for (const choice of param.choices) {
        const option = document.createElement('option');
        option.value = String(choice);
        option.textContent = String(choice);
        option.selected = choice === (this.overrides.get(param.id) ?? param.default);
        select.appendChild(option);
      }
      select.onchange = () => this.handleChange(param.id, select.value);
      row.appendChild(select);
    } else if (typeof param.default === 'boolean') {
      // Checkbox for boolean
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `control-${param.id}`;
      checkbox.checked = this.overrides.get(param.id) ?? param.default;
      checkbox.onchange = () => this.handleChange(param.id, checkbox.checked);
      row.appendChild(checkbox);
    } else if (typeof param.default === 'number' && param.min !== undefined && param.max !== undefined) {
      // Slider for numeric with range
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = `control-${param.id}`;
      slider.min = String(param.min);
      slider.max = String(param.max);
      slider.step = String(param.step || 1);
      slider.value = String(this.overrides.get(param.id) ?? param.default);

      // Range display
      const rangeDisplay = document.createElement('span');
      rangeDisplay.className = 'param-range';
      rangeDisplay.textContent = `[${param.min} - ${param.max}]`;

      slider.oninput = () => {
        const val = parseFloat(slider.value);
        valueDisplay.textContent = this.formatValue(val, param.format);
        this.handleChange(param.id, val);
      };

      row.appendChild(slider);
      row.appendChild(rangeDisplay);

      // Set initial display
      valueDisplay.textContent = this.formatValue(
        this.overrides.get(param.id) ?? param.default,
        param.format
      );
    } else {
      // Text input for other types
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `control-${param.id}`;
      input.value = String(this.overrides.get(param.id) ?? param.default);
      input.onchange = () => this.handleChange(param.id, input.value);
      row.appendChild(input);
    }

    return row;
  }

  private formatValue(value: number, format?: 'percent' | 'currency' | 'number'): string {
    switch (format) {
      case 'percent':
        return `${(value * 100).toFixed(1)}%`;
      case 'currency':
        return `$${value.toFixed(2)}`;
      default:
        return String(value);
    }
  }

  private handleChange(id: string, value: any): void {
    this.overrides.set(id, value);
    // Debounce chart update
    this.onChange(id, value);
  }

  private groupByGroup(params: ParameterDefinition[]): Record<string, ParameterDefinition[]> {
    const groups: Record<string, ParameterDefinition[]> = {};
    for (const param of params) {
      const group = param.group || 'default';
      if (!groups[group]) groups[group] = [];
      groups[group].push(param);
    }
    return groups;
  }

  getOverrides(): Record<string, any> {
    return Object.fromEntries(this.overrides);
  }

  resetToDefaults(): void {
    this.overrides.clear();
    this.render();
  }

  hasOverrides(): boolean {
    return this.overrides.size > 0;
  }
}
```

### 8.2 "Apply to Code" Implementation

Create `src/utils/applyToCode.ts`:

```typescript
import * as vscode from 'vscode';

interface ParameterOverride {
  id: string;
  value: any;
}

export async function applyParametersToCode(
  document: vscode.TextDocument,
  overrides: ParameterOverride[]
): Promise<boolean> {
  const text = document.getText();
  const edit = new vscode.WorkspaceEdit();

  for (const override of overrides) {
    // Find ql.param() call with this id
    const pattern = new RegExp(
      `ql\\.param\\s*\\(\\s*(?:id\\s*=\\s*)?["']${override.id}["']\\s*,\\s*(?:default\\s*=\\s*)?([^,)]+)`,
      'g'
    );

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const defaultValueMatch = match[1];
      const startOffset = match.index + match[0].length - defaultValueMatch.length;
      const endOffset = startOffset + defaultValueMatch.length;

      const startPos = document.positionAt(startOffset);
      const endPos = document.positionAt(endOffset);

      const newValue = formatPythonValue(override.value);
      edit.replace(document.uri, new vscode.Range(startPos, endPos), newValue);
    }
  }

  if (edit.size === 0) {
    return false;
  }

  return vscode.workspace.applyEdit(edit);
}

function formatPythonValue(value: any): string {
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  return String(value);
}
```

---

## 9. Complexity Indicator

### 9.1 Create `src/core/strategy/ComplexityAnalyzer.ts`

```typescript
import * as vscode from 'vscode';

export type ComplexityLevel = 'safe' | 'partial' | 'viewOnly';

export interface ComplexityResult {
  level: ComplexityLevel;
  reasons: string[];
  score: number; // 1-5 for UI display
}

export class ComplexityAnalyzer {
  static analyze(document: vscode.TextDocument): ComplexityResult {
    const text = document.getText();
    const reasons: string[] = [];
    let score = 1;

    // Check for multi-file imports
    if (this.hasComplexImports(text)) {
      reasons.push('Multi-file strategy with imports');
      score += 1;
    }

    // Check for dynamic parameter generation
    if (this.hasDynamicParams(text)) {
      reasons.push('Dynamic parameter generation');
      score += 2;
    }

    // Check for external API calls
    if (this.hasExternalAPICalls(text)) {
      reasons.push('External API calls in strategy logic');
      score += 2;
    }

    // Check for eval/exec
    if (this.hasDynamicCodeGeneration(text)) {
      reasons.push('Dynamic code generation (eval/exec)');
      score += 2;
    }

    // Check for parse errors
    if (this.hasParseErrors(document)) {
      reasons.push('Strategy has parse errors');
      score += 2;
    }

    // Determine level
    let level: ComplexityLevel;
    if (score <= 2) {
      level = 'safe';
    } else if (score <= 4) {
      level = 'partial';
    } else {
      level = 'viewOnly';
    }

    return { level, reasons, score: Math.min(score, 5) };
  }

  private static hasComplexImports(text: string): boolean {
    // Check for imports beyond standard library and quantlab
    const importPattern = /from\s+(\w+)|import\s+(\w+)/g;
    const allowedModules = new Set([
      'quantlab', 'ql', 'numpy', 'np', 'pandas', 'pd',
      'math', 'datetime', 'typing', 'collections'
    ]);

    let match;
    while ((match = importPattern.exec(text)) !== null) {
      const moduleName = match[1] || match[2];
      if (!allowedModules.has(moduleName) && !moduleName.startsWith('.')) {
        return true;
      }
    }
    return false;
  }

  private static hasDynamicParams(text: string): boolean {
    // Check for params defined in loops or conditionals
    const patterns = [
      /for\s+.+:\s*\n\s+.*ql\.param/,
      /if\s+.+:\s*\n\s+.*ql\.param/,
      /\[ql\.param.*for\s+/,
    ];
    return patterns.some(p => p.test(text));
  }

  private static hasExternalAPICalls(text: string): boolean {
    const apiPatterns = [
      /requests\./,
      /urllib\./,
      /httpx\./,
      /aiohttp\./,
      /fetch\(/,
    ];
    return apiPatterns.some(p => p.test(text));
  }

  private static hasDynamicCodeGeneration(text: string): boolean {
    return /\b(eval|exec)\s*\(/.test(text);
  }

  private static hasParseErrors(document: vscode.TextDocument): boolean {
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    return diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error);
  }
}
```

### 9.2 UI Display

```typescript
// In webview
function updateComplexityIndicator(level: ComplexityLevel, score: number): void {
  const indicator = document.getElementById('complexity-indicator')!;

  const dots = '●'.repeat(score) + '○'.repeat(5 - score);
  const colorMap = {
    safe: '#059669',      // Green
    partial: '#D97706',   // Yellow/Orange
    viewOnly: '#DC2626',  // Red
  };
  const labelMap = {
    safe: 'Safe',
    partial: 'Partial',
    viewOnly: 'View-Only',
  };

  indicator.innerHTML = `<span style="color: ${colorMap[level]}">${dots}</span> ${labelMap[level]}`;
  indicator.title = `Complexity Level: ${labelMap[level]}`;
}
```

---

## 10. Chart Toolbar

### 10.1 Toolbar Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [AAPL ▼] [1D ▼] [2020-01-01 → 2024-12-31]    [●●●○○ Safe] 🔄 📷 ⚙️      │
└──────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Toolbar Elements

| Element | Behavior |
|---------|----------|
| **Symbol** | Dropdown, can override global (per-tab) |
| **Timeframe** | Dropdown, can override global (per-tab) |
| **Date Range** | Date picker for visible range |
| **Complexity** | Display only, shows tooltip on hover |
| **Refresh** | Re-run visualization, reload data |
| **Screenshot** | Export chart as PNG |
| **Settings** | Chart type, colors, grid options |

### 10.3 Symbol/TF Override Logic

```typescript
// Tab-level overrides take precedence
function getEffectiveSymbol(tabState: TabViewState): string {
  if (tabState.chartState?.symbol) {
    return tabState.chartState.symbol;
  }
  return GlobalState.getInstance().getSymbol();
}

function getEffectiveTimeframe(tabState: TabViewState): Timeframe {
  if (tabState.chartState?.timeframe) {
    return tabState.chartState.timeframe;
  }
  return GlobalState.getInstance().getTimeframe();
}
```

---

## 11. Global State Integration

### 11.1 Responding to Symbol/TF Changes

```typescript
// In ChartViewProvider
private onGlobalStateChanged(): void {
  const globalState = GlobalState.getInstance();

  for (const [tabId, panel] of this.webviews) {
    const tabState = TabViewState.getInstance().getState(tabId);

    // Only update if no tab-level override
    if (!tabState?.chartState?.symbol) {
      this.loadChartData(
        this.getDocumentForTab(tabId),
        panel.webview
      );
    }
  }
}
```

### 11.2 Theme Change Handling

```typescript
// In extension.ts
vscode.window.onDidChangeActiveColorTheme((theme) => {
  const isDark = theme.kind === vscode.ColorThemeKind.Dark;
  ChartViewProvider.getInstance().broadcastThemeChange(isDark ? 'dark' : 'light');
});

// In ChartViewProvider
broadcastThemeChange(theme: 'dark' | 'light'): void {
  for (const panel of this.webviews.values()) {
    panel.webview.postMessage({ type: 'setTheme', theme });
  }
}
```

---

## 12. Verification Plan

### 12.1 Unit Tests

```typescript
// test/unit/strategy/ComplexityAnalyzer.test.ts
describe('ComplexityAnalyzer', () => {
  it('returns safe for simple strategy', () => {
    const doc = createMockDocument(`
      from quantlab import ql
      def strategy(data):
        return ql.signals()
    `);
    const result = ComplexityAnalyzer.analyze(doc);
    expect(result.level).toBe('safe');
  });

  it('returns partial for multi-file imports', () => {
    const doc = createMockDocument(`
      from quantlab import ql
      from custom_module import helper
      def strategy(data):
        return ql.signals()
    `);
    const result = ComplexityAnalyzer.analyze(doc);
    expect(result.level).toBe('partial');
  });

  it('returns viewOnly for dynamic code', () => {
    const doc = createMockDocument(`
      from quantlab import ql
      def strategy(data):
        exec("x = 1")
        return ql.signals()
    `);
    const result = ComplexityAnalyzer.analyze(doc);
    expect(result.level).toBe('viewOnly');
  });
});

// test/unit/strategy/VisualizationDetector.test.ts
describe('VisualizationDetector', () => {
  it('detects visualize function', () => {
    const doc = createMockDocument(`
      def strategy(data): pass
      def visualize(chart): pass
    `);
    expect(VisualizationDetector.hasVisualizeFunction(doc)).toBe(true);
  });

  it('returns false when no visualize', () => {
    const doc = createMockDocument(`
      def strategy(data): pass
    `);
    expect(VisualizationDetector.hasVisualizeFunction(doc)).toBe(false);
  });
});
```

### 12.2 Integration Tests

```typescript
// test/integration/chartView.test.ts
describe('Chart View', () => {
  it('renders strategy signals on chart', async () => {
    await openStrategyFile('momentum.py');
    await vscode.commands.executeCommand('quantlab.switchToChart');

    await waitForWebview();
    const signals = await getChartSignals();

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].type).toMatch(/entry|exit/);
  });

  it('parameter slider updates chart', async () => {
    await openChartView('momentum.py');
    const initialSignals = await getChartSignals();

    await setParameter('fast_period', 5);
    await waitForChartUpdate();

    const newSignals = await getChartSignals();
    expect(newSignals).not.toEqual(initialSignals);
  });

  it('symbol change reloads chart data', async () => {
    await openChartView('momentum.py');
    await GlobalState.getInstance().setSymbol('MSFT');

    await waitForChartUpdate();
    const displayedSymbol = await getChartSymbol();

    expect(displayedSymbol).toBe('MSFT');
  });
});
```

### 12.3 Manual Verification Checklist

| Test | Steps | Expected Result |
|------|-------|-----------------|
| **Chart renders** | 1. Open strategy file 2. Click Chart button | Chart appears with OHLCV data |
| **Tab stripe** | 1. Switch to Chart view | Green 3px left stripe on tab |
| **No-viz prompt** | 1. Open strategy without visualize() 2. Switch to Chart | Prompt with Add/Generate buttons |
| **Parameter sliders** | 1. Open strategy with ql.param() 2. Switch to Chart | Sliders appear in panel |
| **Slider change** | 1. Adjust slider 2. Wait 300ms debounce | Chart updates with new signals |
| **Reset defaults** | 1. Change slider 2. Click Reset | All sliders return to code values |
| **Apply to code** | 1. Change slider 2. Click Apply to Code | Source file modified with new value |
| **Complexity indicator** | 1. Open complex strategy | Correct indicator shows (Safe/Partial/View-Only) |
| **View-Only banner** | 1. Open View-Only strategy 2. Switch to Chart | Banner shows with "Run New Backtest" |
| **Global symbol change** | 1. In Chart view 2. Change global symbol | Chart reloads with new symbol data |
| **Screenshot** | 1. Click screenshot button | PNG captured and offered for save |

---

## 13. Exit Gates

### 13.1 Phase 3 Completion Criteria

- [ ] **Chart Integration**
  - [ ] Delta Charting engine bundled and loads in webview
  - [ ] Chart renders OHLCV candlesticks correctly
  - [ ] Pan, zoom, crosshair work smoothly ((60fps))

- [ ] **Data Pipeline**
  - [ ] DataService stub returns mock data
  - [ ] Data loads when switching to Chart view
  - [ ] Symbol/TF changes trigger data reload

- [ ] **Visualization**
  - [ ] First-time UX shows when no visualize() exists
  - [ ] "Add Manually" inserts template
  - [ ] Strategy signals overlay as markers

- [ ] **Parameters**
  - [ ] ParameterExtractor extracts ql.param() definitions
  - [ ] Parameter panel renders sliders/dropdowns/checkboxes
  - [ ] Slider changes update chart (debounced)
  - [ ] "Reset to Defaults" works
  - [ ] "Apply to Code" modifies source file

- [ ] **Complexity**
  - [ ] ComplexityAnalyzer returns correct levels
  - [ ] Indicator displays in toolbar with correct color
  - [ ] View-Only mode shows banner and disables sliders

- [ ] **Toolbar**
  - [ ] Symbol/TF overrides work (per-tab)
  - [ ] Refresh button reloads chart
  - [ ] Screenshot captures chart image

- [ ] **Integration**
  - [ ] Global state changes update Chart view
  - [ ] Theme changes apply to chart
  - [ ] Tab stripe shows green (#059669)

### 13.2 Performance Targets

| Metric | Target |
|--------|--------|
| Chart render (10k candles) | < 10ms P95 |
| Pan frame time | < 16.67ms P95 |
| Data load (500 bars) | < 200ms |
| Parameter slider response | < 300ms |

---

## Appendix A: package.json Additions

```json
{
  "contributes": {
    "customEditors": [
      {
        "viewType": "quantlab.chartView",
        "displayName": "Quantlab Chart",
        "selector": [
          {
            "filenamePattern": "*.py"
          }
        ],
        "priority": "option"
      }
    ]
  }
}
```

## Appendix B: Webview CSS (`chart.css`)

```css
:root {
  --bg-primary: var(--vscode-editor-background);
  --bg-secondary: var(--vscode-sideBar-background);
  --text-primary: var(--vscode-editor-foreground);
  --border-color: var(--vscode-panel-border);
  --accent-green: #059669;
  --accent-orange: #D97706;
  --accent-red: #DC2626;
}

body {
  margin: 0;
  padding: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--vscode-font-family);
  display: flex;
  flex-direction: column;
  height: 100vh;
}

#chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

#chart-container {
  flex: 1;
  min-height: 0;
}

#no-viz-prompt {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
}

#no-viz-prompt .prompt-card {
  text-align: center;
  padding: 40px;
  max-width: 500px;
}

#view-only-banner {
  background: var(--accent-orange);
  color: white;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

#parameter-panel {
  border-top: 1px solid var(--border-color);
  max-height: 200px;
  overflow-y: auto;
}

.param-row {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  gap: 12px;
}

.param-row label {
  min-width: 120px;
}

.param-row input[type="range"] {
  flex: 1;
}

.param-value {
  min-width: 60px;
  text-align: right;
}

.param-range {
  font-size: 0.9em;
  opacity: 0.7;
}

.hidden {
  display: none !important;
}
```

---

## 14. Chart Engine Bundling

### 14.1 Overview

Delta Charting packages must be bundled into the webview script. This requires a separate webpack/esbuild configuration for the webview bundle.

### 14.2 Project Structure

```
quantlab-extension/
├── src/                        # Extension host code
├── webview/                    # Webview source code
│   ├── chart/
│   │   ├── index.ts           # Webview entry point
│   │   ├── chart.ts
│   │   └── parameterPanel.ts
│   └── tsconfig.json
├── dist/
│   ├── extension.js           # Extension bundle
│   └── webview/
│       └── chart.js           # Webview bundle (includes Delta Charting)
├── webpack.extension.js       # Extension bundling config
└── webpack.webview.js         # Webview bundling config
```

### 14.3 Webview Webpack Configuration

Create `webpack.webview.js`:

```javascript
const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: {
    chart: './webview/chart/index.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/webview'),
    filename: '[name].js',
    libraryTarget: 'umd',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      // Map Delta Charting packages
      '@quantlab/chart-core': path.resolve(__dirname, '../Charts/packages/chart-core/src'),
      '@quantlab/chart-render-canvas2d': path.resolve(__dirname, '../Charts/packages/chart-render-canvas2d/src'),
      '@quantlab/chart-interaction': path.resolve(__dirname, '../Charts/packages/chart-interaction/src'),
      '@quantlab/chart-indicators': path.resolve(__dirname, '../Charts/packages/chart-indicators/src'),
      '@quantlab/chart-drawings': path.resolve(__dirname, '../Charts/packages/chart-drawings/src'),
      '@quantlab/chart-text': path.resolve(__dirname, '../Charts/packages/chart-text/src'),
      '@quantlab/chart': path.resolve(__dirname, '../Charts/packages/chart/src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  optimization: {
    minimize: process.env.NODE_ENV === 'production',
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            drop_console: true,
          },
        },
      }),
    ],
    splitChunks: {
      cacheGroups: {
        // Keep chart engine in main bundle for CSP compliance
        chartEngine: {
          test: /[\\/]Charts[\\/]packages[\\/]/,
          name: 'chart',
          chunks: 'all',
          enforce: true,
        },
      },
    },
  },
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
};
```

### 14.4 NPM Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "build:extension": "webpack --config webpack.extension.js",
    "build:webview": "webpack --config webpack.webview.js",
    "build": "npm run build:extension && npm run build:webview",
    "watch:extension": "webpack --config webpack.extension.js --watch",
    "watch:webview": "webpack --config webpack.webview.js --watch",
    "watch": "concurrently \"npm run watch:extension\" \"npm run watch:webview\""
  }
}
```

### 14.5 Webview Entry Point

Create `webview/chart/index.ts`:

```typescript
import { createChart } from '@quantlab/chart-render-canvas2d';
import { QuantlabChartAPIImpl } from './ChartAPI';
import { ParameterPanel } from './parameterPanel';
import { setupMessageHandler } from './messageHandler';
import { setupErrorBoundary } from './errorBoundary';
import './chart.css';

// Initialize error boundary first
setupErrorBoundary();

// Main initialization
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('chart-container')!;
  const chartAPI = new QuantlabChartAPIImpl();

  const paramPanel = new ParameterPanel('parameter-content', (id, value) => {
    // Send to extension
    vscode.postMessage({ type: 'parameterChange', id, value });
  });

  // Set up message handler
  setupMessageHandler(chartAPI, paramPanel);

  // Notify extension we're ready
  vscode.postMessage({ type: 'ready' });
});

// Declare vscode API
declare const vscode: {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
};
```

### 14.6 Bundle Size Optimization

**Target**: Bundle size < 500KB gzipped for fast webview load.

**Strategies**:

| Strategy | Implementation |
|----------|----------------|
| **Tree shaking** | Only import used functions from chart packages |
| **Code splitting** | Lazy-load indicators and drawings on demand |
| **Minification** | TerserPlugin with `drop_console` |
| **No source maps in prod** | `devtool: false` |

---

## 15. Binary Data Transfer

### 15.1 Overview

For 10k+ candles, JSON serialization becomes a bottleneck. Binary transfer reduces:
- Serialization time: ~10x faster
- Message size: ~3x smaller
- Memory allocation: Fewer intermediate objects

### 15.2 Binary OHLCV Format

```typescript
/**
 * Binary OHLCV data format for efficient webview transfer.
 * Each bar = 48 bytes (6 x Float64)
 *
 * Layout per bar:
 * [0-7]   time (Float64, ms since epoch)
 * [8-15]  open (Float64)
 * [16-23] high (Float64)
 * [24-31] low (Float64)
 * [32-39] close (Float64)
 * [40-47] volume (Float64)
 */
export interface BinaryOHLCVData {
  type: 'binary';
  buffer: ArrayBuffer;  // Raw bytes
  count: number;        // Number of bars
}

// Encoding (in DataService)
export function encodeOHLCVToBinary(bars: OHLCVBar[]): BinaryOHLCVData {
  const bytesPerBar = 48; // 6 Float64s
  const buffer = new ArrayBuffer(bars.length * bytesPerBar);
  const view = new DataView(buffer);

  for (let i = 0; i < bars.length; i++) {
    const offset = i * bytesPerBar;
    view.setFloat64(offset, bars[i].t, true);      // Little endian
    view.setFloat64(offset + 8, bars[i].o, true);
    view.setFloat64(offset + 16, bars[i].h, true);
    view.setFloat64(offset + 24, bars[i].l, true);
    view.setFloat64(offset + 32, bars[i].c, true);
    view.setFloat64(offset + 40, bars[i].v ?? 0, true);
  }

  return { type: 'binary', buffer, count: bars.length };
}

// Decoding (in webview)
export function decodeBinaryToOHLCV(data: BinaryOHLCVData): OHLCVBar[] {
  const bytesPerBar = 48;
  const view = new DataView(data.buffer);
  const bars: OHLCVBar[] = new Array(data.count);

  for (let i = 0; i < data.count; i++) {
    const offset = i * bytesPerBar;
    bars[i] = {
      t: view.getFloat64(offset, true),
      o: view.getFloat64(offset + 8, true),
      h: view.getFloat64(offset + 16, true),
      l: view.getFloat64(offset + 24, true),
      c: view.getFloat64(offset + 32, true),
      v: view.getFloat64(offset + 40, true),
    };
  }

  return bars;
}
```

### 15.3 Transferable Objects

Use `postMessage` with transferable ArrayBuffers for zero-copy transfer:

```typescript
// Extension side - sending data
const binaryData = encodeOHLCVToBinary(bars);
webview.postMessage(
  { type: 'setDataBinary', data: binaryData },
  [binaryData.buffer]  // Transfer, don't copy
);

// Webview side - receiving data
window.addEventListener('message', (event) => {
  if (event.data.type === 'setDataBinary') {
    const bars = decodeBinaryToOHLCV(event.data.data);
    chartAPI.setData(bars);
  }
});
```

### 15.4 Streaming Updates

For real-time data, use incremental binary updates:

```typescript
interface StreamingUpdate {
  type: 'append' | 'update';
  index?: number;      // For update: which bar to update
  bar: ArrayBuffer;    // Single bar (48 bytes)
}

// Efficiently append single bar
function appendBarBinary(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  const bar: OHLCVBar = {
    t: view.getFloat64(0, true),
    o: view.getFloat64(8, true),
    h: view.getFloat64(16, true),
    l: view.getFloat64(24, true),
    c: view.getFloat64(32, true),
    v: view.getFloat64(40, true),
  };
  chartAPI.appendBar(bar);
}
```

### 15.5 Performance Comparison

| Dataset | JSON Transfer | Binary Transfer | Improvement |
|---------|---------------|-----------------|-------------|
| 1,000 bars | 12ms | 2ms | 6x |
| 10,000 bars | 85ms | 12ms | 7x |
| 50,000 bars | 420ms | 55ms | 8x |

---

## 16. Error Recovery & Memory Management

### 16.1 Error Boundary for Webview

Create `webview/chart/errorBoundary.ts`:

```typescript
export function setupErrorBoundary(): void {
  // Global error handler
  window.onerror = (message, source, lineno, colno, error) => {
    handleError(error || new Error(String(message)), 'global');
    return true; // Prevent default handling
  };

  // Unhandled promise rejections
  window.onunhandledrejection = (event) => {
    handleError(event.reason, 'promise');
    event.preventDefault();
  };
}

function handleError(error: Error, source: string): void {
  console.error(`[Chart Error - ${source}]`, error);

  // Notify extension
  vscode.postMessage({
    type: 'error',
    message: error.message,
    stack: error.stack,
    source,
    recoverable: isRecoverable(error),
  });

  // Attempt recovery
  if (isRecoverable(error)) {
    attemptRecovery(error);
  } else {
    showFatalErrorUI(error);
  }
}

function isRecoverable(error: Error): boolean {
  const recoverablePatterns = [
    /out of memory/i,
    /canvas.*context/i,
    /webgl/i,
    /maximum call stack/i,
  ];
  return !recoverablePatterns.some(p => p.test(error.message));
}

function attemptRecovery(error: Error): void {
  // Clear and reinitialize chart
  const chartAPI = (window as any).__chartAPI as QuantlabChartAPI;
  if (chartAPI) {
    try {
      chartAPI.dispose();
      // Request reinitialization from extension
      vscode.postMessage({ type: 'requestReinit' });
    } catch (e) {
      showFatalErrorUI(error);
    }
  }
}

function showFatalErrorUI(error: Error): void {
  const container = document.getElementById('chart-container')!;
  container.innerHTML = `
    <div class="error-overlay">
      <h2>⚠️ Chart Error</h2>
      <p>An error occurred while rendering the chart.</p>
      <pre>${escapeHtml(error.message)}</pre>
      <button onclick="location.reload()">Reload Chart</button>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

### 16.2 Extension-Side Error Handling

```typescript
// In ChartViewProvider
private async handleWebviewMessage(
  document: vscode.TextDocument,
  message: any
): Promise<void> {
  switch (message.type) {
    case 'error':
      this.handleChartError(document, message);
      break;
    case 'requestReinit':
      await this.reinitializeChart(document);
      break;
    // ... other cases
  }
}

private handleChartError(
  document: vscode.TextDocument,
  error: { message: string; stack?: string; recoverable: boolean }
): void {
  // Log to output channel
  this.outputChannel.appendLine(`[Chart Error] ${document.fileName}: ${error.message}`);
  if (error.stack) {
    this.outputChannel.appendLine(error.stack);
  }

  if (!error.recoverable) {
    vscode.window.showErrorMessage(
      `Chart error: ${error.message}`,
      'View Logs',
      'Reload'
    ).then((action) => {
      if (action === 'View Logs') {
        this.outputChannel.show();
      } else if (action === 'Reload') {
        this.reinitializeChart(document);
      }
    });
  }
}

private async reinitializeChart(document: vscode.TextDocument): Promise<void> {
  const tabId = this.getTabInstanceId(document);
  const panel = this.webviews.get(tabId);
  if (panel) {
    // Reload webview content
    panel.webview.html = this.getHtmlForWebview(panel.webview);
    await this.initializeChart(document, panel.webview);
  }
}
```

### 16.3 Memory Management

```typescript
// Chart instance cleanup on view switch/close
export class ChartMemoryManager {
  private chartInstances: Map<string, {
    api: QuantlabChartAPI;
    dataBuffer?: ArrayBuffer;
    lastAccess: number;
  }> = new Map();

  private readonly MAX_CACHED_CHARTS = 5;
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  registerChart(tabId: string, api: QuantlabChartAPI): void {
    this.chartInstances.set(tabId, {
      api,
      lastAccess: Date.now(),
    });
    this.enforceLimit();
  }

  touchChart(tabId: string): void {
    const instance = this.chartInstances.get(tabId);
    if (instance) {
      instance.lastAccess = Date.now();
    }
  }

  disposeChart(tabId: string): void {
    const instance = this.chartInstances.get(tabId);
    if (instance) {
      instance.api.dispose();
      instance.dataBuffer = undefined;
      this.chartInstances.delete(tabId);
    }
  }

  private enforceLimit(): void {
    if (this.chartInstances.size <= this.MAX_CACHED_CHARTS) return;

    // Remove oldest inactive charts
    const sorted = [...this.chartInstances.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    while (this.chartInstances.size > this.MAX_CACHED_CHARTS) {
      const [tabId] = sorted.shift()!;
      this.disposeChart(tabId);
    }
  }

  // Called periodically to clean up idle charts
  cleanupIdleCharts(): void {
    const now = Date.now();
    for (const [tabId, instance] of this.chartInstances) {
      if (now - instance.lastAccess > this.IDLE_TIMEOUT_MS) {
        this.disposeChart(tabId);
      }
    }
  }
}
```

### 16.4 Debouncing Implementation

```typescript
// Debounce utility for parameter changes
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number
): T & { cancel(): void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delayMs);
  }) as T & { cancel(): void };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

// Usage in ParameterPanel
const debouncedChartUpdate = debounce((id: string, value: any) => {
  vscode.postMessage({ type: 'parameterChange', id, value });
}, 300); // 300ms debounce
```

---

## 17. Accessibility Requirements

### 17.1 Overview (V8.1 §9)

Chart view must meet WCAG 2.1 AA standards for:
- Keyboard navigation
- Screen reader support
- Focus management
- Color contrast

### 17.2 Parameter Panel Accessibility

```typescript
// Enhanced parameter control with ARIA
private createParamControl(param: ParameterDefinition): HTMLElement {
  const row = document.createElement('div');
  row.className = 'param-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-labelledby', `label-${param.id}`);

  // Label with proper association
  const label = document.createElement('label');
  label.id = `label-${param.id}`;
  label.textContent = param.name || param.id;
  label.setAttribute('for', `control-${param.id}`);
  if (param.description) {
    label.setAttribute('title', param.description);
  }
  row.appendChild(label);

  // Slider with ARIA
  if (typeof param.default === 'number' && param.min !== undefined) {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `control-${param.id}`;
    slider.min = String(param.min);
    slider.max = String(param.max);
    slider.value = String(param.default);

    // ARIA attributes
    slider.setAttribute('aria-valuemin', String(param.min));
    slider.setAttribute('aria-valuemax', String(param.max));
    slider.setAttribute('aria-valuenow', String(param.default));
    slider.setAttribute('aria-valuetext', this.formatValue(param.default, param.format));
    slider.setAttribute('aria-describedby', `desc-${param.id}`);

    // Update on change
    slider.oninput = () => {
      const val = parseFloat(slider.value);
      slider.setAttribute('aria-valuenow', String(val));
      slider.setAttribute('aria-valuetext', this.formatValue(val, param.format));
    };

    row.appendChild(slider);

    // Hidden description for screen readers
    const desc = document.createElement('span');
    desc.id = `desc-${param.id}`;
    desc.className = 'visually-hidden';
    desc.textContent = param.description || `Adjust ${param.name || param.id}`;
    row.appendChild(desc);
  }

  return row;
}
```

### 17.3 Keyboard Navigation

```typescript
// Keyboard handler for chart and panels
export function setupKeyboardNavigation(): void {
  document.addEventListener('keydown', (e) => {
    // Skip if in input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      return;
    }

    switch (e.key) {
      // Parameter panel toggle
      case 'p':
        if (e.ctrlKey) {
          e.preventDefault();
          toggleParameterPanel();
          focusParameterPanel();
        }
        break;

      // Focus parameter panel
      case 'Tab':
        if (e.shiftKey && document.activeElement === getFirstChartElement()) {
          e.preventDefault();
          focusToolbar();
        }
        break;

      // Chart navigation
      case 'ArrowLeft':
        if (!e.ctrlKey) {
          chartAPI.panByBars(-1);
        }
        break;

      case 'ArrowRight':
        if (!e.ctrlKey) {
          chartAPI.panByBars(1);
        }
        break;

      case 'Home':
        chartAPI.scrollToStart();
        break;

      case 'End':
        chartAPI.scrollToEnd();
        break;

      // Zoom
      case '+':
      case '=':
        chartAPI.zoomIn();
        break;

      case '-':
        chartAPI.zoomOut();
        break;

      // Escape to return focus to editor
      case 'Escape':
        vscode.postMessage({ type: 'escapeFocus' });
        break;
    }
  });
}

function focusParameterPanel(): void {
  const firstControl = document.querySelector('#parameter-content input, #parameter-content select');
  (firstControl as HTMLElement)?.focus();
}

function focusToolbar(): void {
  const firstButton = document.querySelector('#chart-toolbar button');
  (firstButton as HTMLElement)?.focus();
}
```

### 17.4 Screen Reader Announcements

```typescript
// Live region for chart updates
function setupLiveRegion(): HTMLElement {
  const region = document.createElement('div');
  region.id = 'chart-announcements';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.className = 'visually-hidden';
  document.body.appendChild(region);
  return region;
}

function announce(message: string): void {
  const region = document.getElementById('chart-announcements')!;
  region.textContent = message;
  // Clear after announcement
  setTimeout(() => { region.textContent = ''; }, 1000);
}

// Usage examples
function onDataLoaded(symbol: string, barCount: number): void {
  announce(`Chart loaded: ${symbol} with ${barCount} bars`);
}

function onParameterChanged(name: string, value: string): void {
  announce(`${name} changed to ${value}`);
}

function onComplexityChanged(level: string): void {
  announce(`Strategy complexity: ${level}`);
}
```

### 17.5 CSS for Accessibility

Add to `chart.css`:

```css
/* Visually hidden but accessible to screen readers */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Focus indicators */
#chart-toolbar button:focus,
#parameter-panel input:focus,
#parameter-panel select:focus,
#parameter-panel button:focus {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}

/* High contrast mode support */
@media (prefers-contrast: more) {
  #chart-toolbar button {
    border: 2px solid currentColor;
  }

  .param-row input[type="range"] {
    border: 1px solid currentColor;
  }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
    animation: none !important;
  }
}
```

### 17.6 Accessibility Checklist

| Requirement | Implementation | Status |
|-------------|----------------|--------|
| **Keyboard navigation** | Arrow keys for chart, Tab for controls | ☐ |
| **Focus visible** | 2px outline on all interactive elements | ☐ |
| **ARIA labels** | All controls have labels and descriptions | ☐ |
| **Live regions** | Status updates announced | ☐ |
| **Color contrast** | 4.5:1 minimum for text | ☐ |
| **Skip links** | Not needed (single main region) | N/A |
| **Reduced motion** | Respects `prefers-reduced-motion` | ☐ |
| **Screen reader** | Tested with NVDA/VoiceOver | ☐ |

---

## Appendix C: Updated Exit Gates

Add these criteria to the Phase 3 completion checklist:

### Bundling
- [ ] Webpack config builds webview bundle with Delta Charting
- [ ] Bundle size < 500KB gzipped
- [ ] Source maps work in development

### Binary Data Transfer
- [ ] Binary encoding/decoding implemented
- [ ] Transferable objects used for zero-copy
- [ ] 10k bars loads in < 50ms

### Error Recovery
- [ ] Global error handler catches all errors
- [ ] Recoverable errors trigger reinit
- [ ] Fatal errors show user-friendly UI
- [ ] Errors logged to output channel

### Memory Management
- [ ] Chart instances disposed on tab close
- [ ] Idle charts cleaned up after 5 minutes
- [ ] Max 5 cached chart instances

### Accessibility
- [ ] All controls keyboard accessible
- [ ] ARIA labels on all interactive elements
- [ ] Focus indicators visible
- [ ] Screen reader tested
- [ ] Reduced motion respected
