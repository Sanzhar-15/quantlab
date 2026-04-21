# Delta Charting Engine V6: Complete Specification

## Executive Summary

**Mission:** Evolve Delta Charting from a high-performance chart renderer into a complete professional trading platform charting solution.

**V5.2 Status:** Foundation complete. Performance targets met. Basic functionality working.

**V6 Goal:** Add the features that make it a *trading platform*, not just a *chart*.

---

## Gap Analysis: V5.2 → V6

### What V5.2 Has (Complete)

| Feature | Status | Notes |
|---------|--------|-------|
| HiDPI rendering | ✅ | devicePixelContentBox |
| Path2D batching | ✅ | <10ms for 10k candles |
| Pan cache | ✅ | 4-6ms savings |
| Direct manipulation | ✅ | 1:1 during drag |
| Friction momentum | ✅ | 0.95 decay |
| Basic indicators | ✅ | SMA, EMA only |
| Drawing tools | ✅ | Trendlines, Fibonacci, etc. |
| Theme system | ✅ | Dark/light presets |
| Plugin system | ✅ | Extensible |
| LOD/decimation | ✅ | Large dataset support |

### What V6 Adds (This Specification)

| Feature | Priority | Why It Matters |
|---------|----------|----------------|
| **Essential Trading Indicators** | P0 | Traders NEED RSI, MACD, Bollinger |
| **Multi-Chart Synchronization** | P0 | Professional workflow |
| **Order/Position Visualization** | P0 | It's a trading platform |
| **Volume Profile** | P1 | Differentiator feature |
| **Analytic Spring Solver** | P2 | 120Hz displays, premium feel |
| **Rubber-Band Overscroll** | P2 | Polish |
| **Accessibility** | P2 | Compliance |

---

## Part 1: Essential Trading Indicators

### 1.1 Overview

V5.2 has SMA and EMA. V6 adds the indicators professional traders actually use.

### 1.2 Indicators to Implement

| Indicator | Type | Display | Pane |
|-----------|------|---------|------|
| RSI | Momentum | Line (0-100) | Separate |
| MACD | Trend | Histogram + Lines | Separate |
| Bollinger Bands | Volatility | 3 Lines (overlay) | Main |
| ATR | Volatility | Line | Separate |
| VWAP | Price | Line (overlay) | Main |
| Stochastic | Momentum | 2 Lines (0-100) | Separate |
| OBV | Volume | Line | Separate |
| Volume | Volume | Histogram | Main (bottom) |

### 1.3 Implementation: RSI (Relative Strength Index)

**File:** `packages/chart-indicators/src/indicators/rsi.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface RSIParams {
  period: number;  // Default: 14
  overbought: number;  // Default: 70
  oversold: number;  // Default: 30
}

interface RSIState extends IndicatorState {
  prevClose: number;
  avgGain: number;
  avgLoss: number;
}

export const rsiComputation: IndicatorComputation<RSIParams, RSIState> = {
  name: 'RSI',
  
  getLookbackBars(params: RSIParams): number {
    return params.period;
  },
  
  compute(
    data: { time: Float64Array; close: Float64Array },
    params: RSIParams,
    startIdx: number,
    endIdx: number,
    state: RSIState | null
  ): { result: IndicatorResult; newState: RSIState } {
    const { period = 14 } = params;
    const { close } = data;
    const result = new Float64Array(endIdx - startIdx);
    
    let avgGain = state?.avgGain ?? 0;
    let avgLoss = state?.avgLoss ?? 0;
    let prevClose = state?.prevClose ?? close[startIdx];
    
    // Initial calculation (first period values)
    if (!state && startIdx >= period) {
      let sumGain = 0;
      let sumLoss = 0;
      
      for (let i = startIdx - period + 1; i <= startIdx; i++) {
        const change = close[i] - close[i - 1];
        if (change > 0) sumGain += change;
        else sumLoss += Math.abs(change);
      }
      
      avgGain = sumGain / period;
      avgLoss = sumLoss / period;
    }
    
    // Calculate RSI for each point
    for (let i = startIdx; i < endIdx; i++) {
      const change = close[i] - prevClose;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      
      // Smoothed averages (Wilder's smoothing)
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      
      // Calculate RSI
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result[i - startIdx] = 100 - (100 / (1 + rs));
      
      prevClose = close[i];
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { rsi: result },
        bounds: { min: 0, max: 100 },
      },
      newState: { prevClose, avgGain, avgLoss },
    };
  },
  
  // Rendering hints
  renderHints: {
    pane: 'separate',
    height: 100,
    lines: [
      { key: 'rsi', color: 'seriesPrimary', width: 1.5 },
    ],
    horizontalLines: [
      { value: 70, color: 'rgba(239, 83, 80, 0.5)', label: 'Overbought' },
      { value: 30, color: 'rgba(38, 166, 154, 0.5)', label: 'Oversold' },
    ],
    fill: [
      { above: 70, color: 'rgba(239, 83, 80, 0.1)' },
      { below: 30, color: 'rgba(38, 166, 154, 0.1)' },
    ],
  },
};
```

### 1.4 Implementation: MACD

**File:** `packages/chart-indicators/src/indicators/macd.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface MACDParams {
  fastPeriod: number;   // Default: 12
  slowPeriod: number;   // Default: 26
  signalPeriod: number; // Default: 9
}

interface MACDState extends IndicatorState {
  fastEMA: number;
  slowEMA: number;
  signalEMA: number;
}

export const macdComputation: IndicatorComputation<MACDParams, MACDState> = {
  name: 'MACD',
  
  getLookbackBars(params: MACDParams): number {
    return params.slowPeriod + params.signalPeriod;
  },
  
  compute(
    data: { time: Float64Array; close: Float64Array },
    params: MACDParams,
    startIdx: number,
    endIdx: number,
    state: MACDState | null
  ): { result: IndicatorResult; newState: MACDState } {
    const { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = params;
    const { close } = data;
    
    const macdLine = new Float64Array(endIdx - startIdx);
    const signalLine = new Float64Array(endIdx - startIdx);
    const histogram = new Float64Array(endIdx - startIdx);
    
    const fastMult = 2 / (fastPeriod + 1);
    const slowMult = 2 / (slowPeriod + 1);
    const signalMult = 2 / (signalPeriod + 1);
    
    let fastEMA = state?.fastEMA ?? close[startIdx];
    let slowEMA = state?.slowEMA ?? close[startIdx];
    let signalEMA = state?.signalEMA ?? 0;
    
    for (let i = startIdx; i < endIdx; i++) {
      const price = close[i];
      
      // Calculate EMAs
      fastEMA = (price - fastEMA) * fastMult + fastEMA;
      slowEMA = (price - slowEMA) * slowMult + slowEMA;
      
      // MACD line
      const macd = fastEMA - slowEMA;
      macdLine[i - startIdx] = macd;
      
      // Signal line
      signalEMA = (macd - signalEMA) * signalMult + signalEMA;
      signalLine[i - startIdx] = signalEMA;
      
      // Histogram
      histogram[i - startIdx] = macd - signalEMA;
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { macd: macdLine, signal: signalLine, histogram },
        bounds: 'auto', // Auto-scale
      },
      newState: { fastEMA, slowEMA, signalEMA },
    };
  },
  
  renderHints: {
    pane: 'separate',
    height: 120,
    lines: [
      { key: 'macd', color: '#2196F3', width: 1.5 },
      { key: 'signal', color: '#FF9800', width: 1.5 },
    ],
    histogram: {
      key: 'histogram',
      positiveColor: 'rgba(38, 166, 154, 0.8)',
      negativeColor: 'rgba(239, 83, 80, 0.8)',
    },
    horizontalLines: [
      { value: 0, color: 'rgba(255, 255, 255, 0.2)' },
    ],
  },
};
```

### 1.5 Implementation: Bollinger Bands

**File:** `packages/chart-indicators/src/indicators/bollinger.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface BollingerParams {
  period: number;      // Default: 20
  stdDev: number;      // Default: 2
}

interface BollingerState extends IndicatorState {
  priceWindow: number[];
}

export const bollingerComputation: IndicatorComputation<BollingerParams, BollingerState> = {
  name: 'Bollinger Bands',
  
  getLookbackBars(params: BollingerParams): number {
    return params.period;
  },
  
  compute(
    data: { time: Float64Array; close: Float64Array },
    params: BollingerParams,
    startIdx: number,
    endIdx: number,
    state: BollingerState | null
  ): { result: IndicatorResult; newState: BollingerState } {
    const { period = 20, stdDev = 2 } = params;
    const { close } = data;
    
    const upper = new Float64Array(endIdx - startIdx);
    const middle = new Float64Array(endIdx - startIdx);
    const lower = new Float64Array(endIdx - startIdx);
    
    // Initialize window
    let priceWindow = state?.priceWindow ?? [];
    
    for (let i = startIdx; i < endIdx; i++) {
      priceWindow.push(close[i]);
      if (priceWindow.length > period) {
        priceWindow.shift();
      }
      
      if (priceWindow.length === period) {
        // Calculate SMA
        const sum = priceWindow.reduce((a, b) => a + b, 0);
        const sma = sum / period;
        
        // Calculate standard deviation
        const squaredDiffs = priceWindow.map(p => Math.pow(p - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(variance);
        
        const idx = i - startIdx;
        middle[idx] = sma;
        upper[idx] = sma + stdDev * std;
        lower[idx] = sma - stdDev * std;
      }
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { upper, middle, lower },
        bounds: 'price', // Use price scale
      },
      newState: { priceWindow },
    };
  },
  
  renderHints: {
    pane: 'main', // Overlay on price chart
    lines: [
      { key: 'upper', color: 'rgba(33, 150, 243, 0.7)', width: 1 },
      { key: 'middle', color: 'rgba(33, 150, 243, 1)', width: 1.5 },
      { key: 'lower', color: 'rgba(33, 150, 243, 0.7)', width: 1 },
    ],
    fill: {
      between: ['upper', 'lower'],
      color: 'rgba(33, 150, 243, 0.1)',
    },
  },
};
```

### 1.6 Implementation: ATR (Average True Range)

**File:** `packages/chart-indicators/src/indicators/atr.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface ATRParams {
  period: number;  // Default: 14
}

interface ATRState extends IndicatorState {
  prevClose: number;
  atr: number;
}

export const atrComputation: IndicatorComputation<ATRParams, ATRState> = {
  name: 'ATR',
  
  getLookbackBars(params: ATRParams): number {
    return params.period;
  },
  
  compute(
    data: { time: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array },
    params: ATRParams,
    startIdx: number,
    endIdx: number,
    state: ATRState | null
  ): { result: IndicatorResult; newState: ATRState } {
    const { period = 14 } = params;
    const { high, low, close } = data;
    
    const atrValues = new Float64Array(endIdx - startIdx);
    
    let prevClose = state?.prevClose ?? close[startIdx];
    let atr = state?.atr ?? 0;
    
    // Initialize ATR with first 'period' true ranges
    if (!state && startIdx >= period) {
      let sum = 0;
      for (let i = startIdx - period + 1; i <= startIdx; i++) {
        const tr = Math.max(
          high[i] - low[i],
          Math.abs(high[i] - close[i - 1]),
          Math.abs(low[i] - close[i - 1])
        );
        sum += tr;
      }
      atr = sum / period;
    }
    
    for (let i = startIdx; i < endIdx; i++) {
      // True Range
      const tr = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - prevClose),
        Math.abs(low[i] - prevClose)
      );
      
      // Wilder's smoothing
      atr = (atr * (period - 1) + tr) / period;
      atrValues[i - startIdx] = atr;
      
      prevClose = close[i];
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { atr: atrValues },
        bounds: 'auto',
      },
      newState: { prevClose, atr },
    };
  },
  
  renderHints: {
    pane: 'separate',
    height: 80,
    lines: [
      { key: 'atr', color: '#9C27B0', width: 1.5 },
    ],
  },
};
```

### 1.7 Implementation: VWAP (Volume Weighted Average Price)

**File:** `packages/chart-indicators/src/indicators/vwap.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface VWAPParams {
  sessionReset: boolean;  // Reset at session start (default: true)
}

interface VWAPState extends IndicatorState {
  cumulativeTPV: number;  // Cumulative (Typical Price × Volume)
  cumulativeVolume: number;
  sessionStart: number;
}

export const vwapComputation: IndicatorComputation<VWAPParams, VWAPState> = {
  name: 'VWAP',
  
  getLookbackBars(): number {
    return 0; // Starts from session start
  },
  
  compute(
    data: { 
      time: Float64Array; 
      high: Float64Array; 
      low: Float64Array; 
      close: Float64Array;
      volume: Float64Array;
    },
    params: VWAPParams,
    startIdx: number,
    endIdx: number,
    state: VWAPState | null
  ): { result: IndicatorResult; newState: VWAPState } {
    const { sessionReset = true } = params;
    const { time, high, low, close, volume } = data;
    
    const vwapValues = new Float64Array(endIdx - startIdx);
    
    let cumulativeTPV = state?.cumulativeTPV ?? 0;
    let cumulativeVolume = state?.cumulativeVolume ?? 0;
    let sessionStart = state?.sessionStart ?? getSessionStart(time[startIdx]);
    
    for (let i = startIdx; i < endIdx; i++) {
      // Check for session reset (e.g., new trading day)
      if (sessionReset && isNewSession(time[i], sessionStart)) {
        cumulativeTPV = 0;
        cumulativeVolume = 0;
        sessionStart = getSessionStart(time[i]);
      }
      
      // Typical price = (High + Low + Close) / 3
      const typicalPrice = (high[i] + low[i] + close[i]) / 3;
      
      // Cumulative values
      cumulativeTPV += typicalPrice * volume[i];
      cumulativeVolume += volume[i];
      
      // VWAP
      vwapValues[i - startIdx] = cumulativeVolume > 0 
        ? cumulativeTPV / cumulativeVolume 
        : typicalPrice;
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { vwap: vwapValues },
        bounds: 'price',
      },
      newState: { cumulativeTPV, cumulativeVolume, sessionStart },
    };
  },
  
  renderHints: {
    pane: 'main', // Overlay on price
    lines: [
      { key: 'vwap', color: '#FF9800', width: 2 },
    ],
  },
};

// Helper functions
function getSessionStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isNewSession(timestamp: number, lastSessionStart: number): boolean {
  return getSessionStart(timestamp) !== lastSessionStart;
}
```

### 1.8 Implementation: Stochastic Oscillator

**File:** `packages/chart-indicators/src/indicators/stochastic.ts`

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface StochasticParams {
  kPeriod: number;  // %K period (default: 14)
  dPeriod: number;  // %D period (default: 3)
  smoothK: number;  // %K smoothing (default: 3)
}

interface StochasticState extends IndicatorState {
  kValues: number[];
  highWindow: number[];
  lowWindow: number[];
}

export const stochasticComputation: IndicatorComputation<StochasticParams, StochasticState> = {
  name: 'Stochastic',
  
  getLookbackBars(params: StochasticParams): number {
    return params.kPeriod + params.dPeriod;
  },
  
  compute(
    data: { time: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array },
    params: StochasticParams,
    startIdx: number,
    endIdx: number,
    state: StochasticState | null
  ): { result: IndicatorResult; newState: StochasticState } {
    const { kPeriod = 14, dPeriod = 3, smoothK = 3 } = params;
    const { high, low, close } = data;
    
    const kLine = new Float64Array(endIdx - startIdx);
    const dLine = new Float64Array(endIdx - startIdx);
    
    let highWindow = state?.highWindow ?? [];
    let lowWindow = state?.lowWindow ?? [];
    let kValues = state?.kValues ?? [];
    
    for (let i = startIdx; i < endIdx; i++) {
      // Maintain rolling windows
      highWindow.push(high[i]);
      lowWindow.push(low[i]);
      if (highWindow.length > kPeriod) {
        highWindow.shift();
        lowWindow.shift();
      }
      
      if (highWindow.length === kPeriod) {
        const highestHigh = Math.max(...highWindow);
        const lowestLow = Math.min(...lowWindow);
        
        // Raw %K
        const rawK = highestHigh === lowestLow 
          ? 50 
          : ((close[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
        
        // Smooth %K
        kValues.push(rawK);
        if (kValues.length > smoothK) kValues.shift();
        
        const smoothedK = kValues.reduce((a, b) => a + b, 0) / kValues.length;
        kLine[i - startIdx] = smoothedK;
        
        // %D (SMA of %K)
        // We'd need to track more history for proper %D calculation
        // Simplified here for brevity
        dLine[i - startIdx] = smoothedK; // Placeholder - implement proper SMA
      }
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { k: kLine, d: dLine },
        bounds: { min: 0, max: 100 },
      },
      newState: { kValues, highWindow, lowWindow },
    };
  },
  
  renderHints: {
    pane: 'separate',
    height: 100,
    lines: [
      { key: 'k', color: '#2196F3', width: 1.5 },
      { key: 'd', color: '#FF9800', width: 1.5 },
    ],
    horizontalLines: [
      { value: 80, color: 'rgba(239, 83, 80, 0.5)' },
      { value: 20, color: 'rgba(38, 166, 154, 0.5)' },
    ],
    fill: [
      { above: 80, color: 'rgba(239, 83, 80, 0.1)' },
      { below: 20, color: 'rgba(38, 166, 154, 0.1)' },
    ],
  },
};
```

### 1.9 Indicator Registry Update

**File:** `packages/chart-indicators/src/registry.ts`

```typescript
import { rsiComputation } from './indicators/rsi';
import { macdComputation } from './indicators/macd';
import { bollingerComputation } from './indicators/bollinger';
import { atrComputation } from './indicators/atr';
import { vwapComputation } from './indicators/vwap';
import { stochasticComputation } from './indicators/stochastic';
import { smaComputation } from './indicators/sma';
import { emaComputation } from './indicators/ema';

export const INDICATOR_REGISTRY = {
  sma: smaComputation,
  ema: emaComputation,
  rsi: rsiComputation,
  macd: macdComputation,
  bollinger: bollingerComputation,
  atr: atrComputation,
  vwap: vwapComputation,
  stochastic: stochasticComputation,
} as const;

export type IndicatorType = keyof typeof INDICATOR_REGISTRY;
```

---

## Part 2: Multi-Chart Synchronization

### 2.1 Overview

Professional traders need multiple charts that move together:
- Same symbol, different timeframes
- Different symbols, same timeframe
- Crosshair sync (hover one chart, see on all)

### 2.2 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   SyncController                         │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Chart 1    │  │  Chart 2    │  │  Chart 3    │     │
│  │  (1m BTC)   │  │  (5m BTC)   │  │  (1h BTC)   │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          │                              │
│              ┌───────────▼───────────┐                 │
│              │   Sync Events         │                 │
│              │   - viewport.pan      │                 │
│              │   - viewport.zoom     │                 │
│              │   - crosshair.move    │                 │
│              │   - selection.change  │                 │
│              └───────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Implementation: SyncController

**File:** `packages/chart-core/src/sync-controller.ts`

```typescript
export type SyncMode = 
  | 'none'           // No synchronization
  | 'time'           // Sync time axis only
  | 'price'          // Sync price axis only
  | 'both'           // Sync both axes
  | 'crosshair';     // Sync crosshair only

export interface SyncGroup {
  id: string;
  mode: SyncMode;
  charts: Set<Chart>;
}

export interface SyncEvent {
  type: 'pan' | 'zoom' | 'crosshair' | 'selection';
  source: Chart;
  payload: unknown;
}

export class SyncController {
  private _groups: Map<string, SyncGroup> = new Map();
  private _chartToGroup: Map<Chart, string> = new Map();
  private _broadcasting = false; // Prevent infinite loops
  
  /**
   * Create a sync group
   */
  createGroup(id: string, mode: SyncMode = 'time'): SyncGroup {
    const group: SyncGroup = {
      id,
      mode,
      charts: new Set(),
    };
    this._groups.set(id, group);
    return group;
  }
  
  /**
   * Add chart to sync group
   */
  addToGroup(chart: Chart, groupId: string): void {
    const group = this._groups.get(groupId);
    if (!group) throw new Error(`Sync group ${groupId} not found`);
    
    // Remove from previous group if any
    const prevGroupId = this._chartToGroup.get(chart);
    if (prevGroupId) {
      this._groups.get(prevGroupId)?.charts.delete(chart);
    }
    
    group.charts.add(chart);
    this._chartToGroup.set(chart, groupId);
    
    // Subscribe to chart events
    this._subscribeToChart(chart, group);
  }
  
  /**
   * Remove chart from sync group
   */
  removeFromGroup(chart: Chart): void {
    const groupId = this._chartToGroup.get(chart);
    if (groupId) {
      this._groups.get(groupId)?.charts.delete(chart);
      this._chartToGroup.delete(chart);
    }
  }
  
  /**
   * Broadcast sync event to group
   */
  private _broadcast(source: Chart, event: SyncEvent): void {
    if (this._broadcasting) return; // Prevent infinite loops
    
    const groupId = this._chartToGroup.get(source);
    if (!groupId) return;
    
    const group = this._groups.get(groupId);
    if (!group) return;
    
    this._broadcasting = true;
    
    for (const chart of group.charts) {
      if (chart === source) continue;
      
      switch (event.type) {
        case 'pan':
          if (group.mode === 'time' || group.mode === 'both') {
            this._syncPan(chart, event.payload as PanPayload);
          }
          break;
          
        case 'zoom':
          if (group.mode === 'time' || group.mode === 'both') {
            this._syncZoom(chart, event.payload as ZoomPayload);
          }
          break;
          
        case 'crosshair':
          if (group.mode === 'crosshair' || group.mode === 'both') {
            this._syncCrosshair(chart, event.payload as CrosshairPayload);
          }
          break;
      }
    }
    
    this._broadcasting = false;
  }
  
  private _subscribeToChart(chart: Chart, group: SyncGroup): void {
    // Subscribe to viewport changes
    chart.onVisibleTimeRangeChange((range) => {
      this._broadcast(chart, {
        type: 'pan',
        source: chart,
        payload: { from: range.from, to: range.to },
      });
    });
    
    // Subscribe to crosshair changes
    chart.onCrosshairMove((event) => {
      this._broadcast(chart, {
        type: 'crosshair',
        source: chart,
        payload: { time: event.time, y: event.y },
      });
    });
  }
  
  private _syncPan(chart: Chart, payload: PanPayload): void {
    // For same-timeframe charts: direct time sync
    // For different-timeframe charts: sync to same end time
    const currentRange = chart.getVisibleTimeRange();
    if (!currentRange) return;
    
    const currentSpan = currentRange.to - currentRange.from;
    
    // Maintain chart's own timespan but align end time
    chart.setVisibleTimeRange({
      from: payload.to - currentSpan,
      to: payload.to,
    });
  }
  
  private _syncZoom(chart: Chart, payload: ZoomPayload): void {
    // Sync zoom factor, centered on same time
    chart.zoomAt(payload.centerTime, payload.factor);
  }
  
  private _syncCrosshair(chart: Chart, payload: CrosshairPayload): void {
    // Set crosshair to same time on other charts
    chart.setCrosshairTime(payload.time);
  }
}

interface PanPayload {
  from: number;
  to: number;
}

interface ZoomPayload {
  centerTime: number;
  factor: number;
}

interface CrosshairPayload {
  time: number;
  y?: number;
}
```

### 2.4 Usage Example

```typescript
import { createChart, SyncController } from '@charts-plus/chart';

// Create sync controller
const syncController = new SyncController();

// Create sync group
syncController.createGroup('btc-charts', 'time');

// Create charts
const chart1m = createChart('container-1m', { /* options */ });
const chart5m = createChart('container-5m', { /* options */ });
const chart1h = createChart('container-1h', { /* options */ });

// Add to sync group
syncController.addToGroup(chart1m, 'btc-charts');
syncController.addToGroup(chart5m, 'btc-charts');
syncController.addToGroup(chart1h, 'btc-charts');

// Now panning any chart will pan all charts to the same time
```

---

## Part 3: Order/Position Visualization

### 3.1 Overview

For a trading platform, charts MUST display:
- Open orders (limit orders, stop orders, etc.)
- Open positions (entry price, current P&L)
- Filled orders (execution history)
- Order preview (before placing)

### 3.2 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Trading Overlay                        │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                Chart                             │   │
│  │                                                  │   │
│  │   ═══════════════════════════════ $105.00 ─┬─   │   │ ← Take Profit
│  │                                            │ PnL│   │
│  │   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ $102.50 ─┤+5%│   │ ← Entry
│  │                                            │    │   │
│  │   ═══════════════════════════════ $100.00 ─┴─   │   │ ← Stop Loss
│  │                                                  │   │
│  │   ◆──────────────────────────────── $98.00      │   │ ← Limit Buy
│  │                                                  │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Legend:                                                │
│  ═══ Position line (entry/exit)                         │
│  ─ ─ Order line (pending)                               │
│  ◆   Order marker                                       │
│  │PnL│ P&L box                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Implementation: TradingOverlayPlugin

**File:** `packages/chart-trading/src/trading-overlay.ts`

```typescript
import { ChartPlugin, PluginRenderState } from '@charts-plus/chart-core';

export interface Order {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop' | 'stop-limit';
  price: number;
  quantity: number;
  status: 'pending' | 'open' | 'filled' | 'cancelled';
  filledAt?: number;  // Timestamp
}

export interface Position {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface TradingOverlayOptions {
  orders: Order[];
  positions: Position[];
  onOrderDrag?: (orderId: string, newPrice: number) => void;
  onOrderCancel?: (orderId: string) => void;
  showLabels?: boolean;
  showPnL?: boolean;
}

export function createTradingOverlayPlugin(
  options: TradingOverlayOptions
): ChartPlugin<CanvasRenderingContext2D> {
  
  let orders = options.orders;
  let positions = options.positions;
  let hoveredOrder: string | null = null;
  let draggingOrder: string | null = null;
  let dragStartY: number = 0;
  let dragStartPrice: number = 0;
  
  return {
    onRenderOverlay(ctx: CanvasRenderingContext2D, state: PluginRenderState) {
      const { plotRect, priceScale, theme } = state;
      
      // Render positions
      for (const position of positions) {
        renderPosition(ctx, position, plotRect, priceScale, theme);
      }
      
      // Render orders
      for (const order of orders) {
        if (order.status !== 'open') continue;
        renderOrder(ctx, order, plotRect, priceScale, theme, order.id === hoveredOrder);
      }
    },
    
    onPointer(event, state) {
      const { plotRect, priceScale } = state;
      
      if (event.type === 'move') {
        // Check if hovering over an order line
        hoveredOrder = null;
        for (const order of orders) {
          if (order.status !== 'open') continue;
          const y = priceScale.priceToY(order.price);
          if (Math.abs(event.y - y) < 5) {
            hoveredOrder = order.id;
            break;
          }
        }
      }
      
      if (event.type === 'down' && hoveredOrder) {
        // Start dragging
        draggingOrder = hoveredOrder;
        const order = orders.find(o => o.id === draggingOrder);
        if (order) {
          dragStartY = event.y;
          dragStartPrice = order.price;
        }
      }
      
      if (event.type === 'move' && draggingOrder) {
        // Update order price during drag
        const order = orders.find(o => o.id === draggingOrder);
        if (order) {
          const deltaY = event.y - dragStartY;
          const newPrice = priceScale.yToPrice(priceScale.priceToY(dragStartPrice) + deltaY);
          options.onOrderDrag?.(draggingOrder, newPrice);
        }
      }
      
      if (event.type === 'up' && draggingOrder) {
        draggingOrder = null;
      }
    },
  };
}

function renderPosition(
  ctx: CanvasRenderingContext2D,
  position: Position,
  plotRect: Rect,
  priceScale: PriceScale,
  theme: ThemeTokens
): void {
  const entryY = priceScale.priceToY(position.entryPrice);
  const isProfit = position.unrealizedPnL >= 0;
  
  // Entry line
  ctx.save();
  ctx.strokeStyle = isProfit ? '#26A69A' : '#EF5350';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  
  ctx.beginPath();
  ctx.moveTo(plotRect.x, entryY);
  ctx.lineTo(plotRect.x + plotRect.width, entryY);
  ctx.stroke();
  
  // P&L label
  const pnlText = `${isProfit ? '+' : ''}${position.unrealizedPnLPercent.toFixed(2)}%`;
  const labelWidth = ctx.measureText(pnlText).width + 16;
  const labelHeight = 20;
  const labelX = plotRect.x + plotRect.width - labelWidth - 60;
  const labelY = entryY - labelHeight / 2;
  
  // Label background
  ctx.fillStyle = isProfit ? 'rgba(38, 166, 154, 0.9)' : 'rgba(239, 83, 80, 0.9)';
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 4);
  ctx.fill();
  
  // Label text
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '12px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pnlText, labelX + labelWidth / 2, entryY);
  
  // Stop loss line
  if (position.stopLoss) {
    const slY = priceScale.priceToY(position.stopLoss);
    ctx.strokeStyle = '#EF5350';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotRect.x, slY);
    ctx.lineTo(plotRect.x + plotRect.width, slY);
    ctx.stroke();
    
    // SL label
    ctx.fillStyle = 'rgba(239, 83, 80, 0.8)';
    ctx.fillRect(plotRect.x + plotRect.width - 50, slY - 10, 50, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('SL', plotRect.x + plotRect.width - 25, slY);
  }
  
  // Take profit line
  if (position.takeProfit) {
    const tpY = priceScale.priceToY(position.takeProfit);
    ctx.strokeStyle = '#26A69A';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotRect.x, tpY);
    ctx.lineTo(plotRect.x + plotRect.width, tpY);
    ctx.stroke();
    
    // TP label
    ctx.fillStyle = 'rgba(38, 166, 154, 0.8)';
    ctx.fillRect(plotRect.x + plotRect.width - 50, tpY - 10, 50, 20);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('TP', plotRect.x + plotRect.width - 25, tpY);
  }
  
  ctx.restore();
}

function renderOrder(
  ctx: CanvasRenderingContext2D,
  order: Order,
  plotRect: Rect,
  priceScale: PriceScale,
  theme: ThemeTokens,
  isHovered: boolean
): void {
  const y = priceScale.priceToY(order.price);
  const isBuy = order.side === 'buy';
  
  ctx.save();
  
  // Order line
  ctx.strokeStyle = isBuy ? '#26A69A' : '#EF5350';
  ctx.lineWidth = isHovered ? 2 : 1;
  ctx.setLineDash([8, 4]);
  
  ctx.beginPath();
  ctx.moveTo(plotRect.x, y);
  ctx.lineTo(plotRect.x + plotRect.width, y);
  ctx.stroke();
  
  // Order marker (diamond)
  const markerX = plotRect.x + 20;
  ctx.fillStyle = isBuy ? '#26A69A' : '#EF5350';
  ctx.beginPath();
  ctx.moveTo(markerX, y - 6);
  ctx.lineTo(markerX + 6, y);
  ctx.lineTo(markerX, y + 6);
  ctx.lineTo(markerX - 6, y);
  ctx.closePath();
  ctx.fill();
  
  // Order info label
  const labelText = `${order.side.toUpperCase()} ${order.quantity} @ ${order.price.toFixed(2)}`;
  ctx.fillStyle = isHovered ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.8)';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, markerX + 12, y);
  
  // Cancel button (on hover)
  if (isHovered) {
    const cancelX = plotRect.x + plotRect.width - 30;
    ctx.fillStyle = 'rgba(239, 83, 80, 0.8)';
    ctx.beginPath();
    ctx.arc(cancelX, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cancelX - 3, y - 3);
    ctx.lineTo(cancelX + 3, y + 3);
    ctx.moveTo(cancelX + 3, y - 3);
    ctx.lineTo(cancelX - 3, y + 3);
    ctx.stroke();
  }
  
  ctx.restore();
}
```

### 3.4 Usage Example

```typescript
import { createChart } from '@charts-plus/chart-render-canvas2d';
import { createTradingOverlayPlugin } from '@charts-plus/chart-trading';

const chart = createChart('container', { /* options */ });

// Add trading overlay
const tradingPlugin = createTradingOverlayPlugin({
  orders: [
    { id: '1', symbol: 'BTCUSD', side: 'buy', type: 'limit', price: 42000, quantity: 0.5, status: 'open' },
  ],
  positions: [
    { 
      id: 'p1', 
      symbol: 'BTCUSD', 
      side: 'long', 
      entryPrice: 41500, 
      quantity: 1.0,
      currentPrice: 43000,
      unrealizedPnL: 1500,
      unrealizedPnLPercent: 3.6,
      stopLoss: 40000,
      takeProfit: 45000,
    },
  ],
  onOrderDrag: (orderId, newPrice) => {
    console.log(`Order ${orderId} dragged to ${newPrice}`);
    // Update order via API
  },
  onOrderCancel: (orderId) => {
    console.log(`Cancel order ${orderId}`);
    // Cancel order via API
  },
});

chart.addPlugin(tradingPlugin);
```

---

## Part 4: Volume Profile

### 4.1 Overview

Volume Profile shows the distribution of volume at each price level:
- **POC (Point of Control):** Price with highest volume
- **Value Area:** Price range containing 70% of volume
- **Profile Shape:** Visual distribution of volume

### 4.2 Implementation: Volume Profile

**File:** `packages/chart-indicators/src/volume-profile.ts`

```typescript
export interface VolumeProfileData {
  priceLevels: Float64Array;  // Price at each level
  volumes: Float64Array;       // Volume at each level
  poc: number;                 // Point of Control price
  valueAreaHigh: number;       // Value Area High
  valueAreaLow: number;        // Value Area Low
}

export interface VolumeProfileOptions {
  numBuckets: number;          // Number of price buckets (default: 50)
  valueAreaPercent: number;    // Value area percentage (default: 0.7)
  displaySide: 'left' | 'right';
  maxWidth: number;            // Max width as percent of chart (default: 0.3)
}

export function calculateVolumeProfile(
  data: { high: Float64Array; low: Float64Array; close: Float64Array; volume: Float64Array },
  options: VolumeProfileOptions
): VolumeProfileData {
  const { numBuckets = 50, valueAreaPercent = 0.7 } = options;
  const { high, low, close, volume } = data;
  
  // Find price range
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (let i = 0; i < high.length; i++) {
    if (high[i] > maxPrice) maxPrice = high[i];
    if (low[i] < minPrice) minPrice = low[i];
  }
  
  const bucketSize = (maxPrice - minPrice) / numBuckets;
  const buckets = new Float64Array(numBuckets);
  const priceLevels = new Float64Array(numBuckets);
  
  // Initialize price levels
  for (let i = 0; i < numBuckets; i++) {
    priceLevels[i] = minPrice + (i + 0.5) * bucketSize;
  }
  
  // Distribute volume into buckets
  for (let i = 0; i < close.length; i++) {
    // Distribute volume across the bar's range
    const barHigh = high[i];
    const barLow = low[i];
    const barVolume = volume[i];
    
    const startBucket = Math.max(0, Math.floor((barLow - minPrice) / bucketSize));
    const endBucket = Math.min(numBuckets - 1, Math.floor((barHigh - minPrice) / bucketSize));
    const numBucketsInBar = endBucket - startBucket + 1;
    const volumePerBucket = barVolume / numBucketsInBar;
    
    for (let b = startBucket; b <= endBucket; b++) {
      buckets[b] += volumePerBucket;
    }
  }
  
  // Find POC
  let maxVolume = 0;
  let pocIndex = 0;
  for (let i = 0; i < numBuckets; i++) {
    if (buckets[i] > maxVolume) {
      maxVolume = buckets[i];
      pocIndex = i;
    }
  }
  
  // Calculate Value Area
  const totalVolume = buckets.reduce((a, b) => a + b, 0);
  const targetVolume = totalVolume * valueAreaPercent;
  
  let vaVolume = buckets[pocIndex];
  let vaHighIndex = pocIndex;
  let vaLowIndex = pocIndex;
  
  while (vaVolume < targetVolume) {
    const aboveVolume = vaHighIndex < numBuckets - 1 ? buckets[vaHighIndex + 1] : 0;
    const belowVolume = vaLowIndex > 0 ? buckets[vaLowIndex - 1] : 0;
    
    if (aboveVolume >= belowVolume && vaHighIndex < numBuckets - 1) {
      vaHighIndex++;
      vaVolume += aboveVolume;
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += belowVolume;
    } else {
      break;
    }
  }
  
  return {
    priceLevels,
    volumes: buckets,
    poc: priceLevels[pocIndex],
    valueAreaHigh: priceLevels[vaHighIndex],
    valueAreaLow: priceLevels[vaLowIndex],
  };
}

export function createVolumeProfilePlugin(
  options: VolumeProfileOptions
): ChartPlugin<CanvasRenderingContext2D> {
  let profileData: VolumeProfileData | null = null;
  
  return {
    onDataUpdate(data) {
      profileData = calculateVolumeProfile(data, options);
    },
    
    onRenderUnderlay(ctx: CanvasRenderingContext2D, state: PluginRenderState) {
      if (!profileData) return;
      
      const { plotRect, priceScale, theme } = state;
      const { priceLevels, volumes, poc, valueAreaHigh, valueAreaLow } = profileData;
      
      const maxVolume = Math.max(...volumes);
      const profileWidth = plotRect.width * (options.maxWidth ?? 0.3);
      const barHeight = plotRect.height / priceLevels.length;
      
      const startX = options.displaySide === 'left' 
        ? plotRect.x 
        : plotRect.x + plotRect.width - profileWidth;
      
      ctx.save();
      
      for (let i = 0; i < priceLevels.length; i++) {
        const price = priceLevels[i];
        const vol = volumes[i];
        const y = priceScale.priceToY(price);
        const width = (vol / maxVolume) * profileWidth;
        
        // Determine color based on Value Area
        const isInValueArea = price >= valueAreaLow && price <= valueAreaHigh;
        const isPOC = Math.abs(price - poc) < (priceLevels[1] - priceLevels[0]) / 2;
        
        if (isPOC) {
          ctx.fillStyle = 'rgba(255, 193, 7, 0.8)';  // Gold for POC
        } else if (isInValueArea) {
          ctx.fillStyle = 'rgba(33, 150, 243, 0.5)';  // Blue for Value Area
        } else {
          ctx.fillStyle = 'rgba(158, 158, 158, 0.3)';  // Gray outside
        }
        
        const barX = options.displaySide === 'left' 
          ? startX 
          : startX + profileWidth - width;
        
        ctx.fillRect(barX, y - barHeight / 2, width, barHeight);
      }
      
      // POC line
      const pocY = priceScale.priceToY(poc);
      ctx.strokeStyle = 'rgba(255, 193, 7, 0.8)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(plotRect.x, pocY);
      ctx.lineTo(plotRect.x + plotRect.width, pocY);
      ctx.stroke();
      
      // Value Area bounds
      ctx.strokeStyle = 'rgba(33, 150, 243, 0.5)';
      ctx.setLineDash([2, 2]);
      
      const vahY = priceScale.priceToY(valueAreaHigh);
      ctx.beginPath();
      ctx.moveTo(plotRect.x, vahY);
      ctx.lineTo(plotRect.x + plotRect.width, vahY);
      ctx.stroke();
      
      const valY = priceScale.priceToY(valueAreaLow);
      ctx.beginPath();
      ctx.moveTo(plotRect.x, valY);
      ctx.lineTo(plotRect.x + plotRect.width, valY);
      ctx.stroke();
      
      ctx.restore();
    },
  };
}
```

---

## Part 5: Polish Features

### 5.1 Analytic Spring Solver (120Hz Support)

**File:** `packages/chart-core/src/spring.ts`

```typescript
/**
 * Analytic Spring Solver
 * 
 * Uses closed-form solution of damped harmonic oscillator.
 * Stable across all frame rates (60Hz, 90Hz, 120Hz, 144Hz).
 */
export interface SpringConfig {
  response: number;      // Time to reach ~63% of target (seconds)
  dampingRatio: number;  // ζ: <1 = bounce, 1 = critical, >1 = overdamped
}

export const SPRING_PRESETS = {
  viewport: { response: 0.4, dampingRatio: 1.0 },   // Critically damped
  rubberBand: { response: 0.5, dampingRatio: 0.8 }, // Slight bounce
  crosshair: { response: 0.1, dampingRatio: 1.2 },  // Fast, overdamped
} as const;

export class SpringAnimation {
  private config: SpringConfig;
  private x0: number;
  private v0: number = 0;
  private target: number;
  private startTime: number = 0;
  private currentPosition: number;
  private currentVelocity: number = 0;
  private omega0: number;
  private zeta: number;
  
  constructor(initialValue: number, config: SpringConfig = SPRING_PRESETS.viewport) {
    this.config = config;
    this.x0 = this.target = this.currentPosition = initialValue;
    this.omega0 = (2 * Math.PI) / config.response;
    this.zeta = config.dampingRatio;
  }
  
  setTarget(target: number, initialVelocity: number = 0): void {
    this.x0 = this.currentPosition;
    this.v0 = initialVelocity || this.currentVelocity;
    this.target = target;
    this.startTime = performance.now();
  }
  
  update(currentTime: number): number {
    const t = Math.max(0, (currentTime - this.startTime) / 1000);
    const { position, velocity } = this.computeState(t);
    this.currentPosition = position;
    this.currentVelocity = velocity;
    return position;
  }
  
  private computeState(t: number): { position: number; velocity: number } {
    const d = this.x0 - this.target;
    const { omega0, zeta, v0 } = this;
    
    if (Math.abs(zeta - 1) < 0.001) {
      // Critically damped
      const e = Math.exp(-omega0 * t);
      const A = d;
      const B = v0 + omega0 * d;
      return {
        position: this.target + (A + B * t) * e,
        velocity: (B - omega0 * (A + B * t)) * e,
      };
    } else if (zeta > 1) {
      // Overdamped
      const s = Math.sqrt(zeta * zeta - 1);
      const r1 = -omega0 * (zeta - s);
      const r2 = -omega0 * (zeta + s);
      const A = (v0 - r2 * d) / (r1 - r2);
      const B = d - A;
      return {
        position: this.target + A * Math.exp(r1 * t) + B * Math.exp(r2 * t),
        velocity: A * r1 * Math.exp(r1 * t) + B * r2 * Math.exp(r2 * t),
      };
    } else {
      // Underdamped
      const wd = omega0 * Math.sqrt(1 - zeta * zeta);
      const e = Math.exp(-omega0 * zeta * t);
      const A = d;
      const B = (v0 + omega0 * zeta * d) / wd;
      return {
        position: this.target + e * (A * Math.cos(wd * t) + B * Math.sin(wd * t)),
        velocity: e * ((B * wd - A * omega0 * zeta) * Math.cos(wd * t) -
                       (A * wd + B * omega0 * zeta) * Math.sin(wd * t)),
      };
    }
  }
  
  isAtRest(): boolean {
    const displacement = Math.abs(this.currentPosition - this.target);
    const velocity = Math.abs(this.currentVelocity);
    return displacement < 0.01 && velocity < 0.01;
  }
  
  getValue(): number {
    return this.currentPosition;
  }
}
```

### 5.2 Rubber-Band Overscroll

**File:** `packages/chart-core/src/rubber-band.ts`

```typescript
import { SpringAnimation, SPRING_PRESETS } from './spring';

export class RubberBandController {
  private overscroll: number = 0;
  private spring: SpringAnimation;
  private readonly RESISTANCE = 0.4;
  private readonly MAX_OVERSCROLL = 120;
  
  constructor() {
    this.spring = new SpringAnimation(0, SPRING_PRESETS.rubberBand);
  }
  
  /**
   * Apply resistance during drag past boundary.
   */
  applyResistance(delta: number, atBoundary: boolean): number {
    if (!atBoundary) {
      this.overscroll = 0;
      return delta;
    }
    
    // Asymptotic resistance
    const resistance = this.RESISTANCE * 
      (1 - Math.abs(this.overscroll) / this.MAX_OVERSCROLL);
    
    const resistedDelta = delta * Math.max(0.1, resistance);
    
    this.overscroll = Math.max(
      -this.MAX_OVERSCROLL,
      Math.min(this.MAX_OVERSCROLL, this.overscroll + resistedDelta)
    );
    
    return resistedDelta;
  }
  
  /**
   * Start snap-back animation on release.
   */
  release(currentVelocity: number = 0): void {
    this.spring = new SpringAnimation(this.overscroll, SPRING_PRESETS.rubberBand);
    this.spring.setTarget(0, currentVelocity);
  }
  
  /**
   * Step the snap-back animation.
   */
  step(currentTime: number): number {
    if (this.spring.isAtRest()) {
      this.overscroll = 0;
      return 0;
    }
    
    this.overscroll = this.spring.update(currentTime);
    return this.overscroll;
  }
  
  getOverscroll(): number {
    return this.overscroll;
  }
  
  isActive(): boolean {
    return Math.abs(this.overscroll) > 0.1 || !this.spring.isAtRest();
  }
}
```

### 5.3 Accessibility (prefers-reduced-motion)

**File:** `packages/chart-core/src/accessibility.ts`

```typescript
export class MotionPreferences {
  private prefersReducedMotion: boolean;
  private listeners: Set<() => void> = new Set();
  
  constructor() {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.prefersReducedMotion = mediaQuery.matches;
    
    mediaQuery.addEventListener('change', (e) => {
      this.prefersReducedMotion = e.matches;
      this.notifyListeners();
    });
  }
  
  shouldReduceMotion(): boolean {
    return this.prefersReducedMotion;
  }
  
  /**
   * Get appropriate momentum friction.
   * Higher friction = faster stop for reduced motion.
   */
  getMomentumFriction(): number {
    return this.prefersReducedMotion ? 0.8 : 0.95;
  }
  
  /**
   * Get appropriate spring config.
   * Reduced motion = fast, critically damped.
   */
  getSpringConfig(): SpringConfig {
    if (this.prefersReducedMotion) {
      return { response: 0.1, dampingRatio: 1.5 };
    }
    return SPRING_PRESETS.viewport;
  }
  
  /**
   * Check if crosshair smoothing should be used.
   */
  shouldSmoothCrosshair(): boolean {
    return !this.prefersReducedMotion;
  }
  
  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// Global singleton
export const motionPreferences = new MotionPreferences();
```

---

## Part 6: Implementation Roadmap

### Phase 1: Indicators (Week 1-2)

| Day | Task | Files |
|-----|------|-------|
| 1 | RSI implementation | `indicators/rsi.ts` |
| 2 | MACD implementation | `indicators/macd.ts` |
| 3 | Bollinger Bands | `indicators/bollinger.ts` |
| 4 | ATR implementation | `indicators/atr.ts` |
| 5 | VWAP implementation | `indicators/vwap.ts` |
| 6 | Stochastic Oscillator | `indicators/stochastic.ts` |
| 7 | Indicator pane renderer | `indicator-pane-renderer.ts` |
| 8 | Integration testing | Tests |
| 9-10 | Bug fixes, polish | Various |

### Phase 2: Multi-Chart Sync (Week 3)

| Day | Task | Files |
|-----|------|-------|
| 11 | SyncController base | `sync-controller.ts` |
| 12 | Time sync implementation | - |
| 13 | Crosshair sync | - |
| 14 | Integration with Chart API | `chart.ts` |
| 15 | Testing, edge cases | Tests |

### Phase 3: Trading Overlay (Week 4)

| Day | Task | Files |
|-----|------|-------|
| 16 | Order rendering | `trading-overlay.ts` |
| 17 | Position rendering | - |
| 18 | Order dragging interaction | - |
| 19 | P&L display | - |
| 20 | Integration testing | Tests |

### Phase 4: Volume Profile (Week 5)

| Day | Task | Files |
|-----|------|-------|
| 21 | Volume profile calculation | `volume-profile.ts` |
| 22 | Profile rendering | - |
| 23 | POC, Value Area display | - |
| 24 | Session-based profiles | - |
| 25 | Testing, optimization | Tests |

### Phase 5: Polish (Week 6)

| Day | Task | Files |
|-----|------|-------|
| 26 | Analytic spring solver | `spring.ts` |
| 27 | Rubber-band overscroll | `rubber-band.ts` |
| 28 | Accessibility | `accessibility.ts` |
| 29 | Integration, testing | Various |
| 30 | Documentation | Docs |

---

## Part 7: File Structure (V6)

```
packages/
├── chart-core/
│   ├── src/
│   │   ├── ... (existing)
│   │   ├── sync-controller.ts      # NEW: Multi-chart sync
│   │   ├── spring.ts               # NEW: Analytic spring
│   │   ├── rubber-band.ts          # NEW: Rubber-band
│   │   └── accessibility.ts        # NEW: Motion preferences
│
├── chart-indicators/
│   ├── src/
│   │   ├── indicators/
│   │   │   ├── sma.ts             # Existing
│   │   │   ├── ema.ts             # Existing
│   │   │   ├── rsi.ts             # NEW
│   │   │   ├── macd.ts            # NEW
│   │   │   ├── bollinger.ts       # NEW
│   │   │   ├── atr.ts             # NEW
│   │   │   ├── vwap.ts            # NEW
│   │   │   └── stochastic.ts      # NEW
│   │   ├── volume-profile.ts      # NEW
│   │   └── registry.ts            # Updated
│
├── chart-trading/                  # NEW PACKAGE
│   ├── src/
│   │   ├── trading-overlay.ts
│   │   ├── order-renderer.ts
│   │   ├── position-renderer.ts
│   │   └── index.ts
│   └── package.json
│
└── chart/
    ├── src/
    │   └── chart.ts               # Updated with sync support
```

---

## Part 8: Success Criteria

### Functional Requirements

| Feature | Requirement | Verification |
|---------|-------------|--------------|
| RSI | Matches reference (TradingView) | Visual comparison |
| MACD | Histogram + lines correct | Calculation check |
| Bollinger | Overlay renders correctly | Visual check |
| Multi-chart sync | <16ms sync latency | Performance test |
| Order visualization | Draggable orders | Interaction test |
| Volume profile | POC matches reference | Calculation check |

### Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| Indicator calculation (10k bars) | <5ms | Benchmark |
| Sync event propagation | <2ms | Timing |
| Trading overlay render | <1ms | Frame timing |
| Volume profile render | <3ms | Frame timing |
| Spring animation (120Hz) | Smooth | Visual inspection |

### Quality Requirements

| Aspect | Requirement |
|--------|-------------|
| Accessibility | prefers-reduced-motion respected |
| Memory | No leaks after 1hr use |
| Edge cases | Handles empty data, single points |
| Documentation | All new APIs documented |

---

## Appendix: Quick Reference

### Indicator Parameters

| Indicator | Default Params |
|-----------|----------------|
| RSI | period: 14 |
| MACD | fast: 12, slow: 26, signal: 9 |
| Bollinger | period: 20, stdDev: 2 |
| ATR | period: 14 |
| VWAP | sessionReset: true |
| Stochastic | k: 14, d: 3, smooth: 3 |

### Spring Presets

| Preset | Response | Damping | Use Case |
|--------|----------|---------|----------|
| viewport | 0.4s | 1.0 | Pan settle |
| rubberBand | 0.5s | 0.8 | Overscroll |
| crosshair | 0.1s | 1.2 | Fast snap |

---

*V6 transforms Delta Charting from a chart renderer into a complete professional trading platform charting solution.*
