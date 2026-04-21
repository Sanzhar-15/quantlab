/**
 * Delta Charting Engine: Unified Tick Generator
 * 
 * Generates tick marks with hysteresis to prevent jitter during zoom.
 * This is the single source of truth for grid lines, axis labels, and crosshair snapping.
 */

import type { Tick, HysteresisConfig, TickGeneratorState, TickGeneratorConfig } from './tick-types';
import { DEFAULT_TICK_CONFIG } from './tick-types';
import { niceStep, financialNiceStep, quantizeToTickSize, getMinorCount } from './nice-numbers';

/**
 * Picks the optimal step with hysteresis to prevent jitter.
 * 
 * Hysteresis logic:
 * 1. If previousStep exists, calculate its current pixel spacing
 * 2. If spacing is within [minPx, maxPx] band → keep current step
 * 3. Otherwise, calculate new step using Nice Numbers
 * 4. Adjust step until spacing falls within band
 * 
 * This prevents the "flicker" where grid lines jump between steps
 * during slow zoom (e.g., oscillating between 100 and 200).
 * 
 * @param dataMin - Minimum visible data value
 * @param dataMax - Maximum visible data value
 * @param pxSize - Viewport size in pixels
 * @param config - Hysteresis configuration (targetPx, minPx, maxPx)
 * @param previousStep - Previously used step (null if first time)
 * @param tickSize - Instrument tick size (0 if none)
 * @param useFinancial - Use financial nice numbers (0.25, 2.5, 25, etc.)
 * @returns The optimal step value
 */
export function pickStepWithHysteresis(
  dataMin: number,
  dataMax: number,
  pxSize: number,
  config: HysteresisConfig,
  previousStep: number | null,
  tickSize: number = 0,
  useFinancial: boolean = false,
): number {
  const range = Math.abs(dataMax - dataMin);
  if (range <= 0 || !Number.isFinite(range) || pxSize <= 0) {
    return 1;
  }
  
  const pxPerUnit = pxSize / range;
  
  // ── HYSTERESIS: Check if previous step is still valid ────────────
  if (previousStep !== null && Number.isFinite(previousStep) && previousStep > 0) {
    const currentPxSpacing = previousStep * pxPerUnit;
    
    // If within band, keep current step (hysteresis)
    if (currentPxSpacing >= config.minPx && currentPxSpacing <= config.maxPx) {
      return previousStep;
    }
  }
  
  // ── CALCULATE NEW STEP ───────────────────────────────────────────
  const targetCount = Math.max(2, Math.round(pxSize / config.targetPx));
  const rawStep = range / targetCount;
  
  let step = useFinancial 
    ? financialNiceStep(rawStep) 
    : niceStep(rawStep);
  
  step = quantizeToTickSize(step, tickSize);
  
  // ── ENSURE STEP PRODUCES SPACING WITHIN BAND ─────────────────────
  // If too dense (spacing < minPx), increase step
  // If too sparse (spacing > maxPx), decrease step
  for (let iteration = 0; iteration < 10; iteration++) {
    const spacing = step * pxPerUnit;
    
    if (spacing < config.minPx) {
      // Too dense - need larger step
      step = quantizeToTickSize(step * 2, tickSize);
    } else if (spacing > config.maxPx) {
      // Too sparse - need smaller step
      step = quantizeToTickSize(step / 2, tickSize);
    } else {
      break; // Within band
    }
  }
  
  return step;
}

/**
 * Unified tick generator class.
 * 
 * Maintains state for hysteresis and generates complete Tick[] arrays
 * that are consumed by grid, axis, and crosshair.
 */
export class TickGenerator {
  private config: TickGeneratorConfig;
  private state: TickGeneratorState = { majorStep: null };
  
  constructor(config: Partial<TickGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_TICK_CONFIG, ...config };
  }
  
  /**
   * Generates ticks for the given scale.
   * 
   * Returns a complete Tick[] array with:
   * - Major ticks: Grid lines + axis labels
   * - Minor ticks: Subtle grid subdivisions
   * - Edge ticks: Optional ticks at exact data min/max
   * 
   * @param dataMin - Minimum visible data value
   * @param dataMax - Maximum visible data value
   * @param pxSize - Viewport size in pixels
   * @param dataToPxFn - Function to convert data value to pixel position
   * @param formatFn - Function to format tick label (value, step) => string
   * @returns Array of ticks
   */
  public generate(
    dataMin: number,
    dataMax: number,
    pxSize: number,
    dataToPxFn: (v: number) => number,
    formatFn: (v: number, step: number) => string,
  ): Tick[] {
    const ticks: Tick[] = [];
    const range = Math.abs(dataMax - dataMin);
    
    if (range <= 0 || !Number.isFinite(range) || pxSize <= 0) {
      return ticks;
    }
    
    const pxPerUnit = pxSize / range;
    
    // ── STEP 1: Pick major step with hysteresis ──────────────────────
    const majorStep = this.pickStep(dataMin, dataMax, pxSize, pxPerUnit);
    this.state.majorStep = majorStep;
    
    const epsilon = majorStep * 1e-9; // Float tolerance
    const minVal = Math.min(dataMin, dataMax);
    const maxVal = Math.max(dataMin, dataMax);
    
    // ── STEP 2: Generate major ticks (anchored to 0 for stability) ───
    // Anchor to 0 ensures ticks don't "drift" during pan
    const firstMajor = Math.ceil(minVal / majorStep) * majorStep;
    
    for (let v = firstMajor; v <= maxVal + epsilon; v += majorStep) {
      // Round to avoid float artifacts like 3000.0000000001
      const cleanV = Math.round(v / majorStep) * majorStep;
      
      ticks.push({
        value: cleanV,
        px: dataToPxFn(cleanV),
        kind: 'major',
        label: formatFn(cleanV, majorStep),
      });
    }
    
    // ── STEP 3: Generate minor ticks (if enabled and not too dense) ──
    if (this.config.showMinors) {
      // Check if stepProvider provides a custom minorStep
      let minorStep: number;
      
      if (this.config.stepProvider) {
        const targetCount = Math.max(2, Math.round(pxSize / this.config.targetMajorPx));
        const result = this.config.stepProvider({ min: minVal, max: maxVal }, targetCount);
        minorStep = result.minorStep ?? majorStep / getMinorCount(majorStep);
      } else {
        const minorCount = getMinorCount(majorStep);
        minorStep = majorStep / minorCount;
      }
      
      const minorPxSpacing = minorStep * pxPerUnit;
      
      // Only show minors if they're not too dense
      if (minorPxSpacing >= this.config.minMinorPx) {
        const firstMinor = Math.ceil(minVal / minorStep) * minorStep;
        
        for (let v = firstMinor; v <= maxVal + epsilon; v += minorStep) {
          const cleanV = Math.round(v / minorStep) * minorStep;
          
          // Skip values that coincide with major ticks
          const isMajor = Math.abs((cleanV / majorStep) - Math.round(cleanV / majorStep)) < 1e-9;
          if (isMajor) continue;
          
          ticks.push({
            value: cleanV,
            px: dataToPxFn(cleanV),
            kind: 'minor',
          });
        }
      }
    }
    
    // ── STEP 4: Edge ticks (optional, like TradingView's feature) ────
    if (this.config.showEdgeTicks) {
      const edgeThreshold = majorStep * 0.2; // 20% of step
      
      const nearMin = ticks.some(t => t.kind === 'major' && Math.abs(t.value - minVal) < edgeThreshold);
      const nearMax = ticks.some(t => t.kind === 'major' && Math.abs(t.value - maxVal) < edgeThreshold);
      
      if (!nearMin) {
        ticks.push({
          value: minVal,
          px: dataToPxFn(minVal),
          kind: 'edge',
          label: formatFn(minVal, majorStep),
        });
      }
      
      if (!nearMax) {
        ticks.push({
          value: maxVal,
          px: dataToPxFn(maxVal),
          kind: 'edge',
          label: formatFn(maxVal, majorStep),
        });
      }
    }
    
    return ticks;
  }
  
  /**
   * Internal method to pick step using configuration and hysteresis.
   * 
   * If stepProvider is configured, uses custom step logic.
   * Otherwise, uses default nice numbers algorithm.
   */
  private pickStep(
    dataMin: number,
    dataMax: number,
    pxSize: number,
    pxPerUnit: number,
  ): number {
    const range = Math.abs(dataMax - dataMin);
    const cfg = this.config;
    
    // Hysteresis: keep current step if still valid
    if (this.state.majorStep !== null) {
      const curPx = this.state.majorStep * pxPerUnit;
      if (curPx >= cfg.minMajorPx && curPx <= cfg.maxMajorPx) {
        return this.state.majorStep;
      }
    }
    
    // Use custom step provider if available
    if (cfg.stepProvider) {
      const targetCount = Math.max(2, Math.round(pxSize / cfg.targetMajorPx));
      const minVal = Math.min(dataMin, dataMax);
      const maxVal = Math.max(dataMin, dataMax);
      const result = cfg.stepProvider({ min: minVal, max: maxVal }, targetCount);
      return result.majorStep;
    }
    
    // Calculate new step using nice numbers
    const targetCount = Math.max(2, Math.round(pxSize / cfg.targetMajorPx));
    const rawStep = range / targetCount;
    
    let step = cfg.useFinancialNice
      ? financialNiceStep(rawStep)
      : niceStep(rawStep);
    
    step = quantizeToTickSize(step, cfg.tickSize);
    
    // Ensure within band
    for (let i = 0; i < 10; i++) {
      const px = step * pxPerUnit;
      if (px < cfg.minMajorPx) {
        step = quantizeToTickSize(step * 2, cfg.tickSize);
      } else if (px > cfg.maxMajorPx) {
        step = quantizeToTickSize(step / 2, cfg.tickSize);
      } else {
        break;
      }
    }
    
    return step;
  }
  
  /**
   * Resets hysteresis cache. Call when data changes significantly.
   */
  public reset(): void {
    this.state.majorStep = null;
  }
  
  /**
   * Updates configuration.
   */
  public setConfig(config: Partial<TickGeneratorConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Gets current major step (for debugging/monitoring).
   */
  public getMajorStep(): number | null {
    return this.state.majorStep;
  }
}

