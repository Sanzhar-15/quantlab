/**
 * Capability tier detection for renderer selection.
 * V6: Canvas2D-only - always returns tier 'D'.
 * 
 * WebGPU/WebGL code paths have been removed to simplify the architecture,
 * reduce bundle size, and focus on Canvas2D performance optimization.
 */

import type { RendererTier } from './renderer-interface';

/**
 * Detect the renderer tier.
 * V6 always returns 'D' (Canvas2D only).
 *
 * @returns A promise that resolves to tier 'D' (Canvas2D).
 */
export async function detectCapabilityTier(): Promise<RendererTier> {
  // V6: Canvas2D only for maximum compatibility and simplicity
  return 'D';
}

// V6: WebGPU/WebGL detection functions removed.
// Canvas2D is the only supported backend.

/**
 * Get a human-readable description of a tier.
 * V6: Only tier 'D' (Canvas2D) is supported.
 */
export function getTierDescription(tier: RendererTier): string {
  switch (tier) {
    case 'A':
    case 'B':
    case 'C':
      return 'Canvas2D (V6: WebGPU/WebGL not supported)';
    case 'D':
      return 'Canvas2D - High performance, universal compatibility';
    default:
      return 'Canvas2D';
  }
}

