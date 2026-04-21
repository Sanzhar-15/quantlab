/**
 * Indicator system type definitions.
 */

/**
 * Indicator category.
 */
export type IndicatorCategory = 'trend' | 'momentum' | 'volume' | 'volatility' | 'other';

/**
 * Parameter definition.
 */
export interface ParameterDefinition {
  key: string;
  type: 'int' | 'float' | 'enum' | 'color';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default: any;
  label?: string;
  description?: string;
}

/**
 * Output field definition.
 */
export interface OutputFieldDefinition {
  key: string;                         // "value", "upper", "lower", "histogram", etc.
  type: 'line' | 'histogram' | 'fill' | 'marker';
  defaultColor: string;
  label?: string;
}

/**
 * Indicator style.
 */
export interface IndicatorStyle {
  color?: string;
  lineWidth?: number;
  dash?: number[];
  opacity?: number;
  fillColor?: string;
  histogramColors?: {
    positive?: string;
    negative?: string;
  };
}

/**
 * Indicator definition.
 */
export interface IndicatorDefinition {
  id: string;                          // "ema", "rsi", "macd"
  name: string;                         // Display name
  category: IndicatorCategory;
  params: ParameterDefinition[];
  defaultParams: Record<string, any>;
  inputFields: ('close' | 'open' | 'high' | 'low' | 'volume')[];
  outputFields: OutputFieldDefinition[];
  lookbackBars: number | ((params: any) => number);
  hasGPUCompute: boolean;
  hasWASM: boolean;
  overlay: boolean;                     // Overlay on price or separate pane
  defaultStyle: IndicatorStyle;
  dependencies?: string[];              // IDs of indicators this depends on
}

/**
 * Indicator instance.
 */
export interface IndicatorInstance {
  instanceId: string;
  indicatorId: string;
  seriesId: string;
  params: Record<string, any>;
  style?: IndicatorStyle;
}

/**
 * Indicator computation result.
 */
export interface IndicatorResult {
  instanceId: string;
  seriesId: string;
  startIdx: number;
  length: number;
  outputs: {
    [fieldKey: string]: Float32Array;
  };
  validFrom: number;                    // First valid index (after lookback)
  revision: number;
}

/**
 * Indicator state for incremental computation.
 */
export interface IndicatorState {
  instanceId: string;
  lastComputedIdx: number;
  intermediateState: ArrayBuffer;        // Opaque, indicator-defined
  outputs: Map<string, Float32Array>;
}

/**
 * Compute tier.
 */
export type ComputeTier = 'CPU-JS' | 'CPU-WASM' | 'GPU-Compute';

/**
 * Indicator job for computation queue.
 */
export interface IndicatorJob {
  indicatorId: string;
  instanceId: string;
  seriesId: string;
  priority: number;
  computeRange: {
    startIdx: number;
    endIdx: number;
  };
  reason: 'initial' | 'param_change' | 'data_append' | 'data_replace';
  computeTier: ComputeTier;
}

