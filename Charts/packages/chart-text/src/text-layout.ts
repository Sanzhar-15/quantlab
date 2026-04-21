/**
 * Text layout engine.
 * Handles baseline snapping, kerning, and label hysteresis to prevent shimmer.
 */

import type { GlyphMetrics } from './msdf-atlas';

/**
 * Text layout options.
 */
export type TextLayoutOptions = {
  fontSize: number;
  baseline: 'top' | 'middle' | 'bottom';
  align: 'left' | 'center' | 'right';
  color: [number, number, number, number];
  snapToPixel: boolean;      // Snap positions to physical pixels
  hysteresis: number;        // Hysteresis threshold (pixels) to prevent relayout
};

/**
 * Glyph vertex data.
 */
export type GlyphVertex = {
  position: [number, number];
  uv: [number, number];
  color: [number, number, number, number];
};

/**
 * Text layout result.
 */
export type TextLayoutResult = {
  vertices: GlyphVertex[];
  width: number;
  height: number;
  baselineY: number;
};

/**
 * Cached layout to prevent unnecessary relayouts.
 */
type CachedLayout = {
  text: string;
  x: number;
  y: number;
  options: TextLayoutOptions;
  result: TextLayoutResult;
};

/**
 * Text layout engine.
 */
export class TextLayoutEngine {
  private layoutCache = new Map<string, CachedLayout>();
  private lastLayoutPositions = new Map<string, { x: number; y: number }>();

  /**
   * Layout text and generate glyph vertices.
   */
  public layoutText(
    text: string,
    x: number,
    y: number,
    glyphMetrics: Map<string, GlyphMetrics>,
    options: TextLayoutOptions,
  ): TextLayoutResult {
    // Check cache with hysteresis
    const cacheKey = this.getCacheKey(text, options);
    const cached = this.layoutCache.get(cacheKey);
    const lastPos = this.lastLayoutPositions.get(cacheKey);

    if (cached && lastPos) {
      const dx = Math.abs(x - lastPos.x);
      const dy = Math.abs(y - lastPos.y);
      
      if (dx < options.hysteresis && dy < options.hysteresis) {
        // Use cached layout with adjusted position
        const result = { ...cached.result };
        this.adjustPositions(result.vertices, x - lastPos.x, y - lastPos.y, options);
        this.lastLayoutPositions.set(cacheKey, { x, y });
        return result;
      }
    }

    // Generate new layout
    const result = this.generateLayout(text, x, y, glyphMetrics, options);

    // Cache result
    this.layoutCache.set(cacheKey, {
      text,
      x,
      y,
      options,
      result,
    });
    this.lastLayoutPositions.set(cacheKey, { x, y });

    return result;
  }

  /**
   * Generate layout for text.
   */
  private generateLayout(
    text: string,
    x: number,
    y: number,
    glyphMetrics: Map<string, GlyphMetrics>,
    options: TextLayoutOptions,
  ): TextLayoutResult {
    const vertices: GlyphVertex[] = [];
    let currentX = x;
    const lineHeight = options.fontSize * 1.2;
    let maxWidth = 0;
    let maxHeight = 0;

    // Calculate baseline Y based on baseline option
    let baselineY = y;
    if (options.baseline === 'middle') {
      baselineY = y + options.fontSize * 0.5;
    } else if (options.baseline === 'top') {
      baselineY = y + options.fontSize;
    }

    // Snap baseline to physical pixels
    if (options.snapToPixel) {
      baselineY = Math.round(baselineY);
    }

    // Layout each character
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      const metrics = glyphMetrics.get(char);

      if (!metrics) {
        // Skip unknown characters (will be handled by fallback)
        continue;
      }

      // Calculate glyph position
      let glyphX = currentX + metrics.bearingX;
      let glyphY = baselineY - metrics.bearingY - metrics.height;

      // Snap to pixels
      if (options.snapToPixel) {
        glyphX = Math.round(glyphX);
        glyphY = Math.round(glyphY);
      }

      // Generate quad vertices for glyph
      const [u, v, uWidth, vHeight] = metrics.uvRect;

      // Top-left
      vertices.push({
        position: [glyphX, glyphY],
        uv: [u, v],
        color: options.color,
      });

      // Top-right
      vertices.push({
        position: [glyphX + metrics.width, glyphY],
        uv: [u + uWidth, v],
        color: options.color,
      });

      // Bottom-left
      vertices.push({
        position: [glyphX, glyphY + metrics.height],
        uv: [u, v + vHeight],
        color: options.color,
      });

      // Bottom-right
      vertices.push({
        position: [glyphX + metrics.width, glyphY + metrics.height],
        uv: [u + uWidth, v + vHeight],
        color: options.color,
      });

      // Advance to next character
      currentX += metrics.advance;
      maxWidth = Math.max(maxWidth, currentX - x);
      maxHeight = Math.max(maxHeight, metrics.height);
    }

    // Adjust for alignment
    if (options.align === 'center') {
      const offsetX = -maxWidth * 0.5;
      for (const vertex of vertices) {
        vertex.position[0] += offsetX;
      }
    } else if (options.align === 'right') {
      const offsetX = -maxWidth;
      for (const vertex of vertices) {
        vertex.position[0] += offsetX;
      }
    }

    return {
      vertices,
      width: maxWidth,
      height: maxHeight,
      baselineY,
    };
  }

  /**
   * Adjust vertex positions (for cached layout reuse).
   */
  private adjustPositions(
    vertices: GlyphVertex[],
    deltaX: number,
    deltaY: number,
    options: TextLayoutOptions,
  ): void {
    for (const vertex of vertices) {
      vertex.position[0] += deltaX;
      vertex.position[1] += deltaY;

      if (options.snapToPixel) {
        vertex.position[0] = Math.round(vertex.position[0]);
        vertex.position[1] = Math.round(vertex.position[1]);
      }
    }
  }

  /**
   * Get cache key for layout.
   */
  private getCacheKey(text: string, options: TextLayoutOptions): string {
    return `${text}|${options.fontSize}|${options.baseline}|${options.align}|${options.color.join(',')}`;
  }

  /**
   * Clear layout cache.
   */
  public clearCache(): void {
    this.layoutCache.clear();
    this.lastLayoutPositions.clear();
  }

  /**
   * Get cache statistics.
   */
  public getCacheStats(): {
    cachedLayouts: number;
  } {
    return {
      cachedLayouts: this.layoutCache.size,
    };
  }
}

