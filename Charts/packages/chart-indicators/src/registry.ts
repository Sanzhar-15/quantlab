/**
 * Indicator registry with definition schema and MVP indicators.
 */

import type {
  IndicatorDefinition,
  ParameterDefinition,
  OutputFieldDefinition,
  IndicatorStyle,
} from './types';

/**
 * Indicator registry.
 */
export class IndicatorRegistry {
  private definitions = new Map<string, IndicatorDefinition>();

  /**
   * Register an indicator definition.
   */
  public register(definition: IndicatorDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Indicator ${definition.id} is already registered`);
    }
    this.definitions.set(definition.id, definition);
  }

  /**
   * Get indicator definition by ID.
   */
  public get(id: string): IndicatorDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * Get all registered indicators.
   */
  public getAll(): IndicatorDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Get indicators by category.
   */
  public getByCategory(category: IndicatorDefinition['category']): IndicatorDefinition[] {
    return Array.from(this.definitions.values()).filter((def) => def.category === category);
  }

  /**
   * Check if indicator is registered.
   */
  public has(id: string): boolean {
    return this.definitions.has(id);
  }

  /**
   * Validate parameters for an indicator.
   */
  public validateParams(id: string, params: Record<string, any>): Record<string, any> {
    const definition = this.get(id);
    if (!definition) {
      throw new Error(`Indicator ${id} not found`);
    }

    const validated: Record<string, any> = {};

    for (const paramDef of definition.params) {
      const value = params[paramDef.key] ?? paramDef.default;

      // Type validation
      if (paramDef.type === 'int') {
        const intValue = Math.round(Number(value));
        if (!Number.isFinite(intValue)) {
          throw new Error(`Parameter ${paramDef.key} must be an integer`);
        }
        if (paramDef.min !== undefined && intValue < paramDef.min) {
          throw new Error(`Parameter ${paramDef.key} must be >= ${paramDef.min}`);
        }
        if (paramDef.max !== undefined && intValue > paramDef.max) {
          throw new Error(`Parameter ${paramDef.key} must be <= ${paramDef.max}`);
        }
        validated[paramDef.key] = intValue;
      } else if (paramDef.type === 'float') {
        const floatValue = Number(value);
        if (!Number.isFinite(floatValue)) {
          throw new Error(`Parameter ${paramDef.key} must be a number`);
        }
        if (paramDef.min !== undefined && floatValue < paramDef.min) {
          throw new Error(`Parameter ${paramDef.key} must be >= ${paramDef.min}`);
        }
        if (paramDef.max !== undefined && floatValue > paramDef.max) {
          throw new Error(`Parameter ${paramDef.key} must be <= ${paramDef.max}`);
        }
        validated[paramDef.key] = floatValue;
      } else if (paramDef.type === 'enum') {
        if (!paramDef.options || !paramDef.options.includes(value)) {
          throw new Error(`Parameter ${paramDef.key} must be one of: ${paramDef.options?.join(', ')}`);
        }
        validated[paramDef.key] = value;
      } else if (paramDef.type === 'color') {
        // Simple color validation (hex or named)
        validated[paramDef.key] = String(value);
      } else {
        validated[paramDef.key] = value;
      }
    }

    return validated;
  }
}

/**
 * Create default indicator registry with MVP indicators.
 */
export function createDefaultRegistry(): IndicatorRegistry {
  const registry = new IndicatorRegistry();

  // Trend Indicators
  registry.register({
    id: 'sma',
    name: 'Simple Moving Average',
    category: 'trend',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
    ],
    defaultParams: { period: 20 },
    inputFields: ['close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#2962ff' }],
    lookbackBars: (params) => params.period,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: true,
    defaultStyle: { color: '#2962ff', lineWidth: 1 },
  });

  registry.register({
    id: 'ema',
    name: 'Exponential Moving Average',
    category: 'trend',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
    ],
    defaultParams: { period: 20 },
    inputFields: ['close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#ff6d00' }],
    lookbackBars: (params) => params.period * 3,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: true,
    defaultStyle: { color: '#ff6d00', lineWidth: 1 },
  });

  registry.register({
    id: 'wma',
    name: 'Weighted Moving Average',
    category: 'trend',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
    ],
    defaultParams: { period: 20 },
    inputFields: ['close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#9c27b0' }],
    lookbackBars: (params) => params.period,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: true,
    defaultStyle: { color: '#9c27b0', lineWidth: 1 },
  });

  registry.register({
    id: 'bollinger',
    name: 'Bollinger Bands',
    category: 'volatility',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
      { key: 'stdDev', type: 'float', min: 0.1, max: 10, default: 2, label: 'Std Dev' },
    ],
    defaultParams: { period: 20, stdDev: 2 },
    inputFields: ['close'],
    outputFields: [
      { key: 'upper', type: 'line', defaultColor: '#2962ff' },
      { key: 'middle', type: 'line', defaultColor: '#757575' },
      { key: 'lower', type: 'line', defaultColor: '#2962ff' },
    ],
    lookbackBars: (params) => params.period,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: true,
    defaultStyle: {
      color: '#2962ff',
      lineWidth: 1,
      fillColor: 'rgba(41, 98, 255, 0.1)',
    },
  });

  // Momentum Indicators
  registry.register({
    id: 'rsi',
    name: 'Relative Strength Index',
    category: 'momentum',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 14, label: 'Period' },
    ],
    defaultParams: { period: 14 },
    inputFields: ['close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#ff6d00' }],
    lookbackBars: (params) => params.period + 1,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#ff6d00', lineWidth: 1 },
  });

  registry.register({
    id: 'macd',
    name: 'MACD',
    category: 'momentum',
    params: [
      { key: 'fast', type: 'int', min: 1, max: 100, default: 12, label: 'Fast Period' },
      { key: 'slow', type: 'int', min: 1, max: 100, default: 26, label: 'Slow Period' },
      { key: 'signal', type: 'int', min: 1, max: 100, default: 9, label: 'Signal Period' },
    ],
    defaultParams: { fast: 12, slow: 26, signal: 9 },
    inputFields: ['close'],
    outputFields: [
      { key: 'macd', type: 'line', defaultColor: '#2962ff' },
      { key: 'signal', type: 'line', defaultColor: '#ff6d00' },
      { key: 'histogram', type: 'histogram', defaultColor: '#26a69a' },
    ],
    lookbackBars: (params) => params.slow + params.signal,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: false,
    defaultStyle: {
      color: '#2962ff',
      lineWidth: 1,
      histogramColors: {
        positive: '#26a69a',
        negative: '#ef5350',
      },
    },
    dependencies: ['ema'],
  });

  registry.register({
    id: 'stochastic',
    name: 'Stochastic Oscillator',
    category: 'momentum',
    params: [
      { key: 'kPeriod', type: 'int', min: 1, max: 100, default: 14, label: '%K Period' },
      { key: 'dPeriod', type: 'int', min: 1, max: 100, default: 3, label: '%D Period' },
    ],
    defaultParams: { kPeriod: 14, dPeriod: 3 },
    inputFields: ['high', 'low', 'close'],
    outputFields: [
      { key: 'k', type: 'line', defaultColor: '#2962ff' },
      { key: 'd', type: 'line', defaultColor: '#ff6d00' },
    ],
    lookbackBars: (params) => params.kPeriod + params.dPeriod,
    hasGPUCompute: false,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#2962ff', lineWidth: 1 },
  });

  // Volume Indicators
  registry.register({
    id: 'volume',
    name: 'Volume',
    category: 'volume',
    params: [],
    defaultParams: {},
    inputFields: ['volume'],
    outputFields: [{ key: 'value', type: 'histogram', defaultColor: '#26a69a' }],
    lookbackBars: 0,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: false,
    defaultStyle: {
      histogramColors: {
        positive: '#26a69a',
        negative: '#ef5350',
      },
    },
  });

  registry.register({
    id: 'obv',
    name: 'On-Balance Volume',
    category: 'volume',
    params: [],
    defaultParams: {},
    inputFields: ['close', 'volume'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#2962ff' }],
    lookbackBars: 1,
    hasGPUCompute: false,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#2962ff', lineWidth: 1 },
  });

  registry.register({
    id: 'volume-ma',
    name: 'Volume Moving Average',
    category: 'volume',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
    ],
    defaultParams: { period: 20 },
    inputFields: ['volume'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#757575' }],
    lookbackBars: (params) => params.period,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#757575', lineWidth: 1 },
    dependencies: ['sma'],
  });

  // Volatility Indicators
  registry.register({
    id: 'atr',
    name: 'Average True Range',
    category: 'volatility',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 14, label: 'Period' },
    ],
    defaultParams: { period: 14 },
    inputFields: ['high', 'low', 'close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#ff6d00' }],
    lookbackBars: (params) => params.period,
    hasGPUCompute: true,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#ff6d00', lineWidth: 1 },
  });

  registry.register({
    id: 'bollinger-width',
    name: 'Bollinger Band Width',
    category: 'volatility',
    params: [
      { key: 'period', type: 'int', min: 1, max: 1000, default: 20, label: 'Period' },
      { key: 'stdDev', type: 'float', min: 0.1, max: 10, default: 2, label: 'Std Dev' },
    ],
    defaultParams: { period: 20, stdDev: 2 },
    inputFields: ['close'],
    outputFields: [{ key: 'value', type: 'line', defaultColor: '#9c27b0' }],
    lookbackBars: (params) => params.period,
    hasGPUCompute: false,
    hasWASM: false,
    overlay: false,
    defaultStyle: { color: '#9c27b0', lineWidth: 1 },
    dependencies: ['bollinger'],
  });

  // Other Indicators
  registry.register({
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
    category: 'other',
    params: [
      { key: 'tenkan', type: 'int', min: 1, max: 100, default: 9, label: 'Tenkan Period' },
      { key: 'kijun', type: 'int', min: 1, max: 100, default: 26, label: 'Kijun Period' },
      { key: 'senkou', type: 'int', min: 1, max: 100, default: 52, label: 'Senkou Period' },
    ],
    defaultParams: { tenkan: 9, kijun: 26, senkou: 52 },
    inputFields: ['high', 'low', 'close'],
    outputFields: [
      { key: 'tenkan', type: 'line', defaultColor: '#2962ff' },
      { key: 'kijun', type: 'line', defaultColor: '#ff6d00' },
      { key: 'senkouA', type: 'line', defaultColor: '#26a69a' },
      { key: 'senkouB', type: 'line', defaultColor: '#26a69a' },
    ],
    lookbackBars: 52,
    hasGPUCompute: false,
    hasWASM: false,
    overlay: true,
    defaultStyle: {
      color: '#2962ff',
      lineWidth: 1,
      fillColor: 'rgba(38, 166, 154, 0.2)',
    },
  });

  registry.register({
    id: 'pivots',
    name: 'Pivot Points',
    category: 'other',
    params: [
      { key: 'type', type: 'enum', options: ['daily', 'weekly', 'monthly'], default: 'daily', label: 'Type' },
    ],
    defaultParams: { type: 'daily' },
    inputFields: ['high', 'low', 'close'],
    outputFields: [
      { key: 'pivot', type: 'line', defaultColor: '#757575' },
      { key: 'r1', type: 'line', defaultColor: '#ef5350' },
      { key: 'r2', type: 'line', defaultColor: '#ef5350' },
      { key: 's1', type: 'line', defaultColor: '#26a69a' },
      { key: 's2', type: 'line', defaultColor: '#26a69a' },
    ],
    lookbackBars: 1,
    hasGPUCompute: false,
    hasWASM: false,
    overlay: true,
    defaultStyle: { color: '#757575', lineWidth: 1 },
  });

  return registry;
}

