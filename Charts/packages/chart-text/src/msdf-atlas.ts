/**
 * MSDF atlas loader and glyph metrics.
 * Handles prebaked atlas and dynamic glyph page allocation.
 */

/**
 * Glyph metrics.
 */
export type GlyphMetrics = {
  advance: number;      // Horizontal advance (pixels)
  bearingX: number;     // Left bearing (pixels)
  bearingY: number;     // Top bearing (pixels)
  width: number;       // Glyph width (pixels)
  height: number;      // Glyph height (pixels)
  uvRect: [number, number, number, number]; // u, v, width, height in atlas (0-1)
};

/**
 * MSDF atlas.
 */
export type MSDFAtlas = {
  texture: GPUTexture;
  width: number;
  height: number;
  glyphs: Map<string, GlyphMetrics>; // Character code -> metrics
  lineHeight: number;
  fontSize: number;
};

/**
 * MSDF atlas loader.
 * Loads prebaked atlas and manages dynamic glyph pages.
 */
export class MSDFAtlasLoader {
  private device: GPUDevice | null = null;
  private prebakedAtlas: MSDFAtlas | null = null;
  private dynamicPages: MSDFAtlas[] = [];
  private glyphInsertionQueue: Array<{ char: string; priority: number }> = [];
  private lastInsertionTime = 0;
  private maxInsertionsPerSecond = 10;

  /**
   * Initialize with GPU device.
   */
  public initialize(device: GPUDevice): void {
    this.device = device;
  }

  /**
   * Load prebaked atlas.
   * For now, creates a placeholder. In production, would load from asset files.
   */
  public async loadPrebakedAtlas(fontSize: number = 16): Promise<MSDFAtlas> {
    if (!this.device) {
      throw new Error('MSDFAtlasLoader not initialized');
    }

    // TODO: Load actual MSDF atlas texture and metrics JSON
    // For now, create a placeholder texture
    const width = 512;
    const height = 512;

    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Create placeholder glyphs for digits and basic Latin
    const glyphs = new Map<string, GlyphMetrics>();
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,:;!?+-*/=()[]{}';

    // Placeholder metrics (would come from actual font metrics)
    const glyphWidth = 8;
    const glyphHeight = 16;
    const cols = Math.floor(width / glyphWidth);
    let index = 0;

    for (const char of chars) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const u = col * glyphWidth / width;
      const v = row * glyphHeight / height;
      const uWidth = glyphWidth / width;
      const vHeight = glyphHeight / height;

      glyphs.set(char, {
        advance: glyphWidth,
        bearingX: 0,
        bearingY: 0,
        width: glyphWidth,
        height: glyphHeight,
        uvRect: [u, v, uWidth, vHeight],
      });

      index++;
    }

    this.prebakedAtlas = {
      texture,
      width,
      height,
      glyphs,
      lineHeight: fontSize * 1.2,
      fontSize,
    };

    return this.prebakedAtlas;
  }

  /**
   * Get glyph metrics for a character.
   * Returns null if glyph not available (will queue for dynamic insertion).
   */
  public getGlyphMetrics(char: string): GlyphMetrics | null {
    // Check prebaked atlas first
    if (this.prebakedAtlas) {
      const metrics = this.prebakedAtlas.glyphs.get(char);
      if (metrics) {
        return metrics;
      }
    }

    // Check dynamic pages
    for (const page of this.dynamicPages) {
      const metrics = page.glyphs.get(char);
      if (metrics) {
        return metrics;
      }
    }

    // Glyph not found, queue for insertion
    this.queueGlyphInsertion(char);
    return null;
  }

  /**
   * Queue a glyph for dynamic insertion.
   */
  private queueGlyphInsertion(char: string, priority: number = 0): void {
    // Check if already queued
    if (this.glyphInsertionQueue.some((item) => item.char === char)) {
      return;
    }

    this.glyphInsertionQueue.push({ char, priority });
    this.glyphInsertionQueue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Process glyph insertion queue.
   * Called periodically (not in hot path).
   */
  public processInsertionQueue(): void {
    if (!this.device || this.glyphInsertionQueue.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLastInsertion = now - this.lastInsertionTime;
    const maxInsertions = Math.floor((timeSinceLastInsertion / 1000) * this.maxInsertionsPerSecond);

    if (maxInsertions <= 0) {
      return;
    }

    // Insert up to maxInsertions glyphs
    for (let i = 0; i < Math.min(maxInsertions, this.glyphInsertionQueue.length); i++) {
      const item = this.glyphInsertionQueue.shift();
      if (item) {
        // TODO: Actually insert glyph into dynamic page
        // For now, just remove from queue
        this.lastInsertionTime = now;
      }
    }
  }

  /**
   * Get prebaked atlas texture.
   */
  public getAtlasTexture(): GPUTexture | null {
    return this.prebakedAtlas?.texture ?? null;
  }

  /**
   * Get line height.
   */
  public getLineHeight(): number {
    return this.prebakedAtlas?.lineHeight ?? 16;
  }

  /**
   * Check if a character is in the prebaked atlas.
   */
  public hasGlyph(char: string): boolean {
    if (this.prebakedAtlas?.glyphs.has(char)) {
      return true;
    }
    for (const page of this.dynamicPages) {
      if (page.glyphs.has(char)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Destroy and clean up resources.
   */
  public destroy(): void {
    if (this.prebakedAtlas) {
      this.prebakedAtlas.texture.destroy();
      this.prebakedAtlas = null;
    }
    for (const page of this.dynamicPages) {
      page.texture.destroy();
    }
    this.dynamicPages = [];
    this.glyphInsertionQueue = [];
  }
}

