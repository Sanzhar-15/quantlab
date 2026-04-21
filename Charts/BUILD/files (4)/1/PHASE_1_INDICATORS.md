# V6 Implementation Guide: Phase 1 - Trading Indicators

## Overview

This document provides step-by-step instructions for implementing essential trading indicators in Delta Charting V6.

**Location:** `packages/chart-indicators/src/indicators/`

**Existing Pattern:** Follow the structure of `sma.ts` and `ema.ts`

---

## Task 1: RSI (Relative Strength Index)

### File: `packages/chart-indicators/src/indicators/rsi.ts`

### Requirements
- Period parameter (default: 14)
- Overbought/oversold levels (70/30)
- Wilder's smoothing method
- Renders in separate pane (0-100 scale)

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface RSIParams {
  period: number;
  overbought?: number;
  oversold?: number;
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
    let prevClose = state?.prevClose ?? close[Math.max(0, startIdx - 1)];
    
    // Initialize with first period if no state
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
    
    for (let i = startIdx; i < endIdx; i++) {
      const change = close[i] - prevClose;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      
      // Wilder's smoothing
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      
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
  
  renderHints: {
    pane: 'separate',
    height: 100,
    lines: [{ key: 'rsi', color: 'seriesPrimary', width: 1.5 }],
    horizontalLines: [
      { value: 70, color: 'rgba(239, 83, 80, 0.5)', style: 'dashed' },
      { value: 30, color: 'rgba(38, 166, 154, 0.5)', style: 'dashed' },
    ],
  },
};
```

### Test Cases
1. RSI(14) on BTCUSD should match TradingView values
2. RSI should oscillate between 0-100
3. Overbought (>70) should highlight correctly
4. Incremental update should produce same result as full calculation

---

## Task 2: MACD

### File: `packages/chart-indicators/src/indicators/macd.ts`

### Requirements
- Fast/slow/signal periods (12/26/9)
- MACD line, signal line, histogram
- Histogram colored by sign
- Renders in separate pane

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface MACDParams {
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
}

interface MACDState extends IndicatorState {
  fastEMA: number;
  slowEMA: number;
  signalEMA: number;
}

export const macdComputation: IndicatorComputation<MACDParams, MACDState> = {
  name: 'MACD',
  
  getLookbackBars(params: MACDParams): number {
    const { slowPeriod = 26, signalPeriod = 9 } = params;
    return slowPeriod + signalPeriod;
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
      
      fastEMA = (price - fastEMA) * fastMult + fastEMA;
      slowEMA = (price - slowEMA) * slowMult + slowEMA;
      
      const macd = fastEMA - slowEMA;
      signalEMA = (macd - signalEMA) * signalMult + signalEMA;
      
      const idx = i - startIdx;
      macdLine[idx] = macd;
      signalLine[idx] = signalEMA;
      histogram[idx] = macd - signalEMA;
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { macd: macdLine, signal: signalLine, histogram },
        bounds: 'auto',
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
    horizontalLines: [{ value: 0, color: 'rgba(255, 255, 255, 0.2)' }],
  },
};
```

---

## Task 3: Bollinger Bands

### File: `packages/chart-indicators/src/indicators/bollinger.ts`

### Requirements
- Period and standard deviation parameters (20, 2)
- Upper, middle, lower bands
- Fill between bands
- Renders as overlay on main chart

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface BollingerParams {
  period?: number;
  stdDev?: number;
}

interface BollingerState extends IndicatorState {
  priceWindow: number[];
}

export const bollingerComputation: IndicatorComputation<BollingerParams, BollingerState> = {
  name: 'Bollinger Bands',
  
  getLookbackBars(params: BollingerParams): number {
    return params.period ?? 20;
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
    
    let priceWindow = state?.priceWindow?.slice() ?? [];
    
    for (let i = startIdx; i < endIdx; i++) {
      priceWindow.push(close[i]);
      if (priceWindow.length > period) priceWindow.shift();
      
      const idx = i - startIdx;
      
      if (priceWindow.length === period) {
        const sum = priceWindow.reduce((a, b) => a + b, 0);
        const sma = sum / period;
        
        const squaredDiffs = priceWindow.map(p => Math.pow(p - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const std = Math.sqrt(variance);
        
        middle[idx] = sma;
        upper[idx] = sma + stdDev * std;
        lower[idx] = sma - stdDev * std;
      } else {
        middle[idx] = close[i];
        upper[idx] = close[i];
        lower[idx] = close[i];
      }
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { upper, middle, lower },
        bounds: 'price',
      },
      newState: { priceWindow },
    };
  },
  
  renderHints: {
    pane: 'main',
    lines: [
      { key: 'upper', color: 'rgba(33, 150, 243, 0.7)', width: 1 },
      { key: 'middle', color: 'rgba(33, 150, 243, 1)', width: 1.5 },
      { key: 'lower', color: 'rgba(33, 150, 243, 0.7)', width: 1 },
    ],
    fill: { between: ['upper', 'lower'], color: 'rgba(33, 150, 243, 0.1)' },
  },
};
```

---

## Task 4: ATR (Average True Range)

### File: `packages/chart-indicators/src/indicators/atr.ts`

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface ATRParams {
  period?: number;
}

interface ATRState extends IndicatorState {
  prevClose: number;
  atr: number;
}

export const atrComputation: IndicatorComputation<ATRParams, ATRState> = {
  name: 'ATR',
  
  getLookbackBars(params: ATRParams): number {
    return params.period ?? 14;
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
    
    let prevClose = state?.prevClose ?? close[Math.max(0, startIdx - 1)];
    let atr = state?.atr ?? 0;
    
    // Initialize ATR
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
      const tr = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - prevClose),
        Math.abs(low[i] - prevClose)
      );
      
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
    lines: [{ key: 'atr', color: '#9C27B0', width: 1.5 }],
  },
};
```

---

## Task 5: VWAP

### File: `packages/chart-indicators/src/indicators/vwap.ts`

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface VWAPParams {
  sessionReset?: boolean;
}

interface VWAPState extends IndicatorState {
  cumulativeTPV: number;
  cumulativeVolume: number;
  sessionStart: number;
}

export const vwapComputation: IndicatorComputation<VWAPParams, VWAPState> = {
  name: 'VWAP',
  
  getLookbackBars(): number {
    return 0;
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
      if (sessionReset && isNewSession(time[i], sessionStart)) {
        cumulativeTPV = 0;
        cumulativeVolume = 0;
        sessionStart = getSessionStart(time[i]);
      }
      
      const typicalPrice = (high[i] + low[i] + close[i]) / 3;
      cumulativeTPV += typicalPrice * volume[i];
      cumulativeVolume += volume[i];
      
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
    pane: 'main',
    lines: [{ key: 'vwap', color: '#FF9800', width: 2 }],
  },
};

function getSessionStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

function isNewSession(timestamp: number, lastSessionStart: number): boolean {
  return getSessionStart(timestamp) !== lastSessionStart;
}
```

---

## Task 6: Stochastic Oscillator

### File: `packages/chart-indicators/src/indicators/stochastic.ts`

### Implementation

```typescript
import { IndicatorComputation, IndicatorResult, IndicatorState } from '../base';

interface StochasticParams {
  kPeriod?: number;
  dPeriod?: number;
  smoothK?: number;
}

interface StochasticState extends IndicatorState {
  highWindow: number[];
  lowWindow: number[];
  kValues: number[];
  dValues: number[];
}

export const stochasticComputation: IndicatorComputation<StochasticParams, StochasticState> = {
  name: 'Stochastic',
  
  getLookbackBars(params: StochasticParams): number {
    const { kPeriod = 14, dPeriod = 3 } = params;
    return kPeriod + dPeriod;
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
    
    let highWindow = state?.highWindow?.slice() ?? [];
    let lowWindow = state?.lowWindow?.slice() ?? [];
    let kValues = state?.kValues?.slice() ?? [];
    let dValues = state?.dValues?.slice() ?? [];
    
    for (let i = startIdx; i < endIdx; i++) {
      highWindow.push(high[i]);
      lowWindow.push(low[i]);
      if (highWindow.length > kPeriod) {
        highWindow.shift();
        lowWindow.shift();
      }
      
      const idx = i - startIdx;
      
      if (highWindow.length === kPeriod) {
        const highestHigh = Math.max(...highWindow);
        const lowestLow = Math.min(...lowWindow);
        
        const rawK = highestHigh === lowestLow 
          ? 50 
          : ((close[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
        
        kValues.push(rawK);
        if (kValues.length > smoothK) kValues.shift();
        
        const k = kValues.reduce((a, b) => a + b, 0) / kValues.length;
        
        dValues.push(k);
        if (dValues.length > dPeriod) dValues.shift();
        
        const d = dValues.reduce((a, b) => a + b, 0) / dValues.length;
        
        kLine[idx] = k;
        dLine[idx] = d;
      }
    }
    
    return {
      result: {
        time: data.time.slice(startIdx, endIdx),
        values: { k: kLine, d: dLine },
        bounds: { min: 0, max: 100 },
      },
      newState: { highWindow, lowWindow, kValues, dValues },
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
      { value: 80, color: 'rgba(239, 83, 80, 0.5)', style: 'dashed' },
      { value: 20, color: 'rgba(38, 166, 154, 0.5)', style: 'dashed' },
    ],
  },
};
```

---

## Task 7: Update Registry

### File: `packages/chart-indicators/src/registry.ts`

```typescript
import { smaComputation } from './indicators/sma';
import { emaComputation } from './indicators/ema';
import { rsiComputation } from './indicators/rsi';
import { macdComputation } from './indicators/macd';
import { bollingerComputation } from './indicators/bollinger';
import { atrComputation } from './indicators/atr';
import { vwapComputation } from './indicators/vwap';
import { stochasticComputation } from './indicators/stochastic';

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

export function getIndicator(type: IndicatorType) {
  return INDICATOR_REGISTRY[type];
}
```

---

## Verification Checklist

For each indicator, verify:

- [ ] Calculation matches TradingView/reference
- [ ] Incremental updates work correctly
- [ ] Empty data handled gracefully
- [ ] Renders in correct pane (main vs separate)
- [ ] Colors/styling match theme
- [ ] Performance: <5ms for 10k bars
- [ ] TypeScript types are correct
- [ ] Export from package index

---

## Next Steps After Phase 1

After completing all indicators:
1. Run performance benchmarks
2. Visual comparison with TradingView
3. Integration tests
4. Proceed to Phase 2: Multi-Chart Sync
