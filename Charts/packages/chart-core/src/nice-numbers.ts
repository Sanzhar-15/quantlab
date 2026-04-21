/**
 * Delta Charting Engine: Nice Numbers Algorithm
 * 
 * Implements the Heckbert "Nice Numbers" algorithm for selecting
 * aesthetically pleasing tick intervals.
 * 
 * Core principle: Tick intervals should be "round" numbers that
 * humans find natural: 1, 2, 5, 10, 20, 50, 100, 200, 500...
 * NOT: 13, 27, 43, 137...
 */

/**
 * Classic 1-2-5 Nice Numbers algorithm.
 * 
 * Rounds a raw step value to the nearest "nice" value.
 * Nice values are (1 | 2 | 5) × 10^k for any integer k.
 * 
 * Examples:
 * - 17.3 → 20
 * - 137 → 200
 * - 0.037 → 0.05
 * - 345 → 500
 * 
 * @param rawStep - The ideal step based on range/targetCount
 * @returns The nearest nice step
 */
export function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  if (!Number.isFinite(rawStep)) return 1;
  
  // Get the magnitude (power of 10)
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, exponent);
  
  // Get the fraction (1.0 to 9.999...)
  const fraction = rawStep / magnitude;
  
  // Snap to nearest nice fraction
  let niceFraction: number;
  if (fraction <= 1.5) {
    niceFraction = 1;
  } else if (fraction <= 3.5) {
    niceFraction = 2;
  } else if (fraction <= 7.5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  
  return niceFraction * magnitude;
}

/**
 * Financial nice numbers ladder.
 * 
 * Extends the 1-2-5 system with values common in financial markets:
 * - Quarter points: 0.25, 2.5, 25, 250
 * - Half points: 0.5, 5, 50, 500
 * 
 * This ensures grid lines land on prices traders actually see.
 */
const FINANCIAL_NICE_LADDER = [
  // Sub-penny (forex, crypto)
  0.00001,
  0.00002,
  0.00005,
  0.0001,
  0.0002,
  0.0005,
  0.001,
  0.002,
  0.005,
  
  // Cents
  0.01,
  0.02,
  0.025,  // Quarter cent (rare but valid)
  0.05,
  
  // Dimes / Quarters
  0.1,
  0.2,
  0.25,   // Quarter dollar
  0.5,
  
  // Dollars
  1,
  2,
  2.5,    // $2.50
  5,
  10,
  20,
  25,     // $25
  50,
  100,
  200,
  250,    // $250
  500,
  
  // Thousands
  1000,
  2000,
  2500,   // $2,500
  5000,
  10000,
  20000,
  25000,  // $25,000
  50000,
  100000,
  200000,
  250000, // $250,000
  500000,
  1000000,
  2000000,
  2500000,
  5000000,
  10000000,
];

/**
 * Extended nice numbers optimized for financial instruments.
 * 
 * Uses logarithmic distance matching to find the best fit from
 * the financial ladder.
 * 
 * Examples:
 * - 23 → 25
 * - 0.23 → 0.25
 * - 237 → 250
 * - 2370 → 2500
 * 
 * @param rawStep - The ideal step based on range/targetCount
 * @returns The nearest financial nice step
 */
export function financialNiceStep(rawStep: number): number {
  if (rawStep <= 0) return FINANCIAL_NICE_LADDER[0] ?? 1;
  if (!Number.isFinite(rawStep)) return 1;
  
  let best = FINANCIAL_NICE_LADDER[0] ?? 1;
  let bestDist = Infinity;
  
  // Use logarithmic distance for better matching across scales
  const logRaw = Math.log10(rawStep);
  
  for (const candidate of FINANCIAL_NICE_LADDER) {
    const logCandidate = Math.log10(candidate);
    const dist = Math.abs(logCandidate - logRaw);
    
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  
  // If no ladder value is close enough, fall back to classic nice numbers
  if (bestDist > 0.5) {
    return niceStep(rawStep);
  }
  
  return best;
}

/**
 * Quantizes a step to be a multiple of the instrument's tick size.
 * 
 * Critical for financial accuracy: If an instrument has a minimum
 * tick size (e.g., ES futures = 0.25), grid lines MUST land on
 * tradeable prices.
 * 
 * Examples with tickSize = 0.25:
 * - 1.8 → 2.0 (ceil(1.8 / 0.25) * 0.25 = 8 * 0.25 = 2.0)
 * - 0.3 → 0.5 (ceil(0.3 / 0.25) * 0.25 = 2 * 0.25 = 0.5)
 * - 5.0 → 5.0 (already aligned)
 * 
 * @param step - The nice step from niceStep() or financialNiceStep()
 * @param tickSize - Instrument minimum tick (0 if none)
 * @returns Step rounded up to multiple of tickSize
 */
export function quantizeToTickSize(step: number, tickSize: number): number {
  if (tickSize <= 0 || !Number.isFinite(tickSize)) return step;
  if (step <= 0 || !Number.isFinite(step)) return tickSize;
  
  // Round up to ensure we don't go below the nice step
  const multiplier = Math.ceil(step / tickSize);
  return multiplier * tickSize;
}

/**
 * Utility: Calculate the "base digit" of a step.
 * 
 * Used to determine minor grid subdivision count:
 * - Base 1 → 5 minors (0.2 step)
 * - Base 2 → 4 minors (0.5 step)
 * - Base 5 → 5 minors (1.0 step)
 * 
 * @param step - A nice step value
 * @returns The base digit (1, 2, or 5)
 */
export function getStepBase(step: number): 1 | 2 | 5 {
  if (step <= 0 || !Number.isFinite(step)) return 1;
  
  const exponent = Math.floor(Math.log10(step));
  const magnitude = Math.pow(10, exponent);
  const base = Math.round(step / magnitude);
  
  // Snap to nearest valid base
  if (base <= 1) return 1;
  if (base <= 3) return 2;
  return 5;
}

/**
 * Calculate minor subdivision count based on major step.
 * 
 * @param majorStep - The major tick step
 * @returns Number of minor divisions (4 or 5)
 */
export function getMinorCount(majorStep: number): number {
  const base = getStepBase(majorStep);
  return base === 2 ? 4 : 5;
}

/**
 * Calculate minor step from major step.
 * 
 * @param majorStep - The major tick step
 * @returns The minor tick step
 */
export function getMinorStep(majorStep: number): number {
  const minorCount = getMinorCount(majorStep);
  return majorStep / minorCount;
}

