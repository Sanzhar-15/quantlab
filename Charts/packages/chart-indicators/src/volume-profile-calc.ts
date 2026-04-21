/**
 * Volume Profile Calculation
 * 
 * Core calculation logic for volume profile, independent of rendering.
 * This module provides the calculation functions used by the plugin.
 */

export interface VolumeProfileData {
  priceLevels: Float64Array;   // Price at center of each bucket
  volumes: Float64Array;        // Volume at each level
  buyVolumes: Float64Array;     // Buy volume at each level (optional)
  sellVolumes: Float64Array;    // Sell volume at each level (optional)
  poc: number;                  // Point of Control price
  pocVolume: number;            // Volume at POC
  valueAreaHigh: number;        // Value Area High
  valueAreaLow: number;         // Value Area Low
  totalVolume: number;          // Total volume
  maxVolume: number;            // Max volume at any level
  minPrice: number;             // Minimum price in range
  maxPrice: number;             // Maximum price in range
}

export interface VolumeProfileCalcOptions {
  // Calculation options
  numBuckets?: number;           // Number of price buckets (default: 48)
  valueAreaPercent?: number;     // Value area percentage (default: 0.70)
  
  // Time range
  startTime?: number;            // Start of profile range
  endTime?: number;              // End of profile range
}

/**
 * Calculate volume profile from OHLCV data
 */
export function calculateVolumeProfile(
  data: {
    time: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    // Optional: buy/sell volume separation
    buyVolume?: Float64Array;
    sellVolume?: Float64Array;
  },
  options: VolumeProfileCalcOptions = {}
): VolumeProfileData | null {
  const {
    numBuckets = 48,
    valueAreaPercent = 0.70,
    startTime,
    endTime,
  } = options;
  
  const { time, high, low, close, volume, buyVolume, sellVolume } = data;
  
  // Validate input
  if (!time || !high || !low || !close || !volume) {
    return null;
  }
  
  const dataLength = Math.min(time.length, high.length, low.length, close.length, volume.length);
  if (dataLength === 0) {
    return null;
  }
  
  // Determine data range
  let startIdx = 0;
  let endIdx = dataLength;
  
  if (startTime !== undefined && startTime > time[0]!) {
    startIdx = binarySearch(time, startTime, dataLength);
  }
  if (endTime !== undefined && endTime < time[dataLength - 1]!) {
    endIdx = Math.min(binarySearch(time, endTime, dataLength) + 1, dataLength);
  }
  
  if (startIdx >= endIdx) {
    return null;
  }
  
  // Find price range
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  
  for (let i = startIdx; i < endIdx; i++) {
    const h = high[i]!;
    const l = low[i]!;
    if (Number.isFinite(h) && h > maxPrice) maxPrice = h;
    if (Number.isFinite(l) && l < minPrice) minPrice = l;
  }
  
  // Handle edge case
  if (minPrice === Infinity || maxPrice === -Infinity || minPrice >= maxPrice) {
    return null;
  }
  
  // Add small padding to avoid edge issues
  const priceRange = maxPrice - minPrice;
  minPrice -= priceRange * 0.001;
  maxPrice += priceRange * 0.001;
  
  const bucketSize = (maxPrice - minPrice) / numBuckets;
  
  // Initialize arrays
  const volumes = new Float64Array(numBuckets);
  const buyVolumes = new Float64Array(numBuckets);
  const sellVolumes = new Float64Array(numBuckets);
  const priceLevels = new Float64Array(numBuckets);
  
  // Set price levels (center of each bucket)
  for (let i = 0; i < numBuckets; i++) {
    priceLevels[i] = minPrice + (i + 0.5) * bucketSize;
  }
  
  // Distribute volume into buckets
  for (let i = startIdx; i < endIdx; i++) {
    const barHigh = high[i]!;
    const barLow = low[i]!;
    const barVolume = volume[i]!;
    
    // Skip invalid bars
    if (!Number.isFinite(barHigh) || !Number.isFinite(barLow) || !Number.isFinite(barVolume)) {
      continue;
    }
    
    // Skip bars with no volume
    if (barVolume <= 0) {
      continue;
    }
    
    const barBuyVolume = buyVolume?.[i] ?? barVolume * 0.5;
    const barSellVolume = sellVolume?.[i] ?? barVolume * 0.5;
    
    // Find bucket range for this bar
    // Both use Math.floor: bucket i contains prices from minPrice + i*bucketSize to minPrice + (i+1)*bucketSize
    // A bar with barHigh should include bucket floor((barHigh - minPrice) / bucketSize)
    const startBucket = Math.max(0, Math.floor((barLow - minPrice) / bucketSize));
    const endBucket = Math.max(startBucket, Math.min(numBuckets - 1, Math.floor((barHigh - minPrice) / bucketSize)));
    const bucketsInBar = endBucket - startBucket + 1;
    
    // Distribute volume evenly across buckets
    const volumePerBucket = barVolume / bucketsInBar;
    const buyVolumePerBucket = barBuyVolume / bucketsInBar;
    const sellVolumePerBucket = barSellVolume / bucketsInBar;
    
    for (let b = startBucket; b <= endBucket && b < numBuckets; b++) {
      if (b >= 0) {
        volumes[b] += volumePerBucket;
        buyVolumes[b] += buyVolumePerBucket;
        sellVolumes[b] += sellVolumePerBucket;
      }
    }
  }
  
  // Find POC (Point of Control)
  let maxVolume = 0;
  let pocIndex = 0;
  let totalVolume = 0;
  
  for (let i = 0; i < numBuckets; i++) {
    totalVolume += volumes[i]!;
    if (volumes[i]! > maxVolume) {
      maxVolume = volumes[i]!;
      pocIndex = i;
    }
  }
  
  if (totalVolume === 0) {
    return null;
  }
  
  // Calculate Value Area (70% of volume around POC)
  const targetVolume = totalVolume * valueAreaPercent;
  let vaVolume = volumes[pocIndex]!;
  let vaHighIndex = pocIndex;
  let vaLowIndex = pocIndex;
  
  // Expand from POC until we have target volume
  while (vaVolume < targetVolume && (vaHighIndex < numBuckets - 1 || vaLowIndex > 0)) {
    const aboveVolume = vaHighIndex < numBuckets - 1 ? volumes[vaHighIndex + 1]! : 0;
    const belowVolume = vaLowIndex > 0 ? volumes[vaLowIndex - 1]! : 0;
    
    // Add the side with more volume (or both if equal)
    if (aboveVolume >= belowVolume && vaHighIndex < numBuckets - 1) {
      vaHighIndex++;
      vaVolume += aboveVolume;
    } else if (vaLowIndex > 0) {
      vaLowIndex--;
      vaVolume += belowVolume;
    } else if (vaHighIndex < numBuckets - 1) {
      vaHighIndex++;
      vaVolume += aboveVolume;
    } else {
      break;
    }
  }
  
  return {
    priceLevels,
    volumes,
    buyVolumes,
    sellVolumes,
    poc: priceLevels[pocIndex]!,
    pocVolume: volumes[pocIndex]!,
    valueAreaHigh: priceLevels[vaHighIndex]! + bucketSize / 2,
    valueAreaLow: priceLevels[vaLowIndex]! - bucketSize / 2,
    totalVolume,
    maxVolume,
    minPrice: minPrice + bucketSize * 0.001, // Remove padding for display
    maxPrice: maxPrice - bucketSize * 0.001,
  };
}

/**
 * Binary search for time array
 */
function binarySearch(arr: Float64Array, target: number, length: number): number {
  let left = 0;
  let right = length - 1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midValue = arr[mid]!;
    
    if (midValue < target) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  
  return Math.max(0, Math.min(left, length - 1));
}

