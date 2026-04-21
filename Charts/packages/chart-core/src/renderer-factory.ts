/**
 * Renderer factory for creating Canvas2D renderer.
 * V6: Canvas2D-only - WebGPU/WebGL code paths removed.
 * 
 * This simplifies the architecture, reduces bundle size, and allows
 * focused optimization on Canvas2D performance.
 */

import type { ChartRenderer, RendererOptions, RendererTier } from './renderer-interface';
import { detectCapabilityTier } from './tier-detection';

/**
 * Factory function to create a Canvas2D renderer.
 * V6 always creates a Canvas2D renderer regardless of tier parameter.
 *
 * @param container The container element for the chart.
 * @param options Renderer initialization options.
 * @param forceTier Optional tier parameter (ignored in V6, always uses Canvas2D).
 * @returns A promise that resolves to the Canvas2D renderer.
 */
export async function createRenderer(
  container: HTMLElement,
  options: RendererOptions,
  forceTier?: RendererTier,
): Promise<ChartRenderer> {
  // V6: Always use Canvas2D renderer
  // Tier detection is retained for backward compatibility but always returns 'D'
  const tier = forceTier ?? (await detectCapabilityTier());
  
  // All tiers use Canvas2D in V6
  const canvas2dModule = await import('@charts-plus/chart-render-canvas2d');
  const Canvas2DRenderer = canvas2dModule.Canvas2DRenderer || (canvas2dModule as any).default?.Canvas2DRenderer;
  
  if (!Canvas2DRenderer) {
    throw new Error('Canvas2DRenderer not found in @charts-plus/chart-render-canvas2d');
  }
  
  return new Canvas2DRenderer();
}

/**
 * Create a renderer synchronously (for known tiers).
 * V6: All renderers must be created asynchronously via createRenderer().
 *
 * @param tier The renderer tier (ignored in V6).
 * @returns Throws an error - use createRenderer() instead.
 */
export function createRendererSync(tier: RendererTier): ChartRenderer {
  // V6: Dynamic imports require async, no sync creation available
  throw new Error('Synchronous renderer creation not supported in V6. Use createRenderer() instead.');
}

