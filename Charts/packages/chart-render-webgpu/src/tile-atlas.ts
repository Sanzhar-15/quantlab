/**
 * Tile atlas allocator for WebGPU renderer.
 * Manages texture atlas pages with fixed-grid slot allocation.
 */

import type { TileSlot } from './tile-types';

/**
 * Tile atlas page.
 * A large texture subdivided into fixed-size tile slots.
 */
export class TileAtlasPage {
  public readonly texture: GPUTexture;
  public readonly width: number;
  public readonly height: number;
  public readonly tileSize: number;
  public readonly slotsPerRow: number;
  public readonly slotsPerCol: number;
  public readonly usedBitset: Uint32Array;
  public freeCount: number;
  public readonly id: number;

  private static nextPageId = 1;

  public constructor(
    device: GPUDevice,
    width: number,
    height: number,
    tileSize: number,
  ) {
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.slotsPerRow = Math.floor(width / tileSize);
    this.slotsPerCol = Math.floor(height / tileSize);
    this.id = TileAtlasPage.nextPageId++;

    // Create texture
    this.texture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });

    // Initialize bitset (one bit per slot)
    const totalSlots = this.slotsPerRow * this.slotsPerCol;
    const bitsetSize = Math.ceil(totalSlots / 32);
    this.usedBitset = new Uint32Array(bitsetSize);
    this.freeCount = totalSlots;
  }

  /**
   * Allocate a slot in this page.
   * Returns slot index or -1 if no free slots.
   */
  public allocSlot(): number {
    if (this.freeCount === 0) {
      return -1;
    }

    // Find first free bit
    const totalSlots = this.slotsPerRow * this.slotsPerCol;
    for (let i = 0; i < totalSlots; i++) {
      const wordIndex = Math.floor(i / 32);
      const bitIndex = i % 32;
      const word = this.usedBitset[wordIndex]!;
      const bit = 1 << bitIndex;

      if ((word & bit) === 0) {
        // Free slot found
        this.usedBitset[wordIndex] = word | bit;
        this.freeCount--;
        return i;
      }
    }

    return -1; // Should never reach here if freeCount > 0
  }

  /**
   * Free a slot in this page.
   */
  public freeSlot(slotIndex: number): void {
    const wordIndex = Math.floor(slotIndex / 32);
    const bitIndex = slotIndex % 32;
    const word = this.usedBitset[wordIndex]!;
    const bit = 1 << bitIndex;

    if ((word & bit) !== 0) {
      // Slot was used, free it
      this.usedBitset[wordIndex] = word & ~bit;
      this.freeCount++;
    }
  }

  /**
   * Get slot coordinates from slot index.
   */
  public getSlotCoords(slotIndex: number): { xPx: number; yPx: number } {
    const col = slotIndex % this.slotsPerRow;
    const row = Math.floor(slotIndex / this.slotsPerRow);
    return {
      xPx: col * this.tileSize,
      yPx: row * this.tileSize,
    };
  }

  /**
   * Calculate UV offset and scale for a slot.
   */
  public getSlotUV(slotIndex: number): { uvOffset: [number, number]; uvScale: [number, number] } {
    const coords = this.getSlotCoords(slotIndex);
    return {
      uvOffset: [coords.xPx / this.width, coords.yPx / this.height],
      uvScale: [this.tileSize / this.width, this.tileSize / this.height],
    };
  }

  /**
   * Destroy this page and release GPU resources.
   */
  public destroy(): void {
    this.texture.destroy();
  }

  /**
   * Get memory usage in MB.
   */
  public getMemoryUsageMB(): number {
    return (this.width * this.height * 4) / (1024 * 1024); // RGBA8 = 4 bytes per pixel
  }
}

/**
 * Tile atlas manager.
 * Manages multiple atlas pages with fixed-grid allocation.
 */
export class TileAtlasManager {
  private pages = new Map<number, TileAtlasPage>();
  private pagePools = new Map<number, TileAtlasPage[]>(); // By tileSize
  private memoryBudgetMB: number;
  private currentMemoryMB: number;
  private device: GPUDevice | null = null;

  // Default page size: 2048×2048 (16 MB per page for RGBA8)
  private readonly defaultPageWidth = 2048;
  private readonly defaultPageHeight = 2048;

  public constructor(memoryBudgetMB: number = 192) {
    this.memoryBudgetMB = memoryBudgetMB;
    this.currentMemoryMB = 0;
  }

  /**
   * Initialize with a GPU device.
   */
  public initialize(device: GPUDevice): void {
    this.device = device;
  }

  /**
   * Allocate a slot for a tile.
   * Returns null if allocation fails (over budget or no device).
   */
  public allocateSlot(tileSize: number): TileSlot | null {
    if (!this.device) {
      throw new Error('TileAtlasManager not initialized with device');
    }

    // Get or create page pool for this tile size
    let pool = this.pagePools.get(tileSize);
    if (!pool) {
      pool = [];
      this.pagePools.set(tileSize, pool);
    }

    // Try to find a page with free slots
    let page: TileAtlasPage | null = null;
    for (const p of pool) {
      if (p.freeCount > 0) {
        page = p;
        break;
      }
    }

    // Create new page if needed
    if (!page) {
      page = this.createPage(tileSize);
      if (!page) {
        return null; // Over budget
      }
      pool.push(page);
    }

    // Allocate slot
    const slotIndex = page.allocSlot();
    if (slotIndex === -1) {
      // Page is full, try creating another
      page = this.createPage(tileSize);
      if (!page) {
        return null; // Over budget
      }
      pool.push(page);
      const newSlotIndex = page.allocSlot();
      if (newSlotIndex === -1) {
        return null; // Should never happen
      }
      const coords = page.getSlotCoords(newSlotIndex);
      const uv = page.getSlotUV(newSlotIndex);
      return {
        pageId: page.id,
        slotIndex: newSlotIndex,
        xPx: coords.xPx,
        yPx: coords.yPx,
        uvOffset: uv.uvOffset,
        uvScale: uv.uvScale,
      };
    }

    const coords = page.getSlotCoords(slotIndex);
    const uv = page.getSlotUV(slotIndex);
    return {
      pageId: page.id,
      slotIndex,
      xPx: coords.xPx,
      yPx: coords.yPx,
      uvOffset: uv.uvOffset,
      uvScale: uv.uvScale,
    };
  }

  /**
   * Free a slot.
   */
  public freeSlot(slot: TileSlot): void {
    const page = this.pages.get(slot.pageId);
    if (page) {
      page.freeSlot(slot.slotIndex);
    }
  }

  /**
   * Create a new atlas page.
   * Returns null if over budget.
   */
  private createPage(tileSize: number): TileAtlasPage | null {
    if (!this.device) {
      return null;
    }

    const pageMemoryMB = (this.defaultPageWidth * this.defaultPageHeight * 4) / (1024 * 1024);

    // Check budget
    if (this.currentMemoryMB + pageMemoryMB > this.memoryBudgetMB) {
      return null; // Over budget
    }

    const page = new TileAtlasPage(
      this.device,
      this.defaultPageWidth,
      this.defaultPageHeight,
      tileSize,
    );

    this.pages.set(page.id, page);
    this.currentMemoryMB += pageMemoryMB;

    return page;
  }

  /**
   * Get a page by ID.
   */
  public getPage(pageId: number): TileAtlasPage | null {
    return this.pages.get(pageId) ?? null;
  }

  /**
   * Get current memory usage in MB.
   */
  public getMemoryUsageMB(): number {
    return this.currentMemoryMB;
  }

  /**
   * Get memory budget in MB.
   */
  public getMemoryBudgetMB(): number {
    return this.memoryBudgetMB;
  }

  /**
   * Set memory budget and enforce it.
   */
  public setMemoryBudget(budgetMB: number): void {
    this.memoryBudgetMB = budgetMB;
    this.enforceBudget();
  }

  /**
   * Enforce memory budget by destroying empty pages.
   * This is a simple approach - full eviction is handled by TileCache.
   */
  public enforceBudget(): void {
    // Remove completely empty pages (if any)
    const emptyPages: number[] = [];
    for (const [pageId, page] of this.pages.entries()) {
      if (page.freeCount === page.slotsPerRow * page.slotsPerCol) {
        emptyPages.push(pageId);
      }
    }

    for (const pageId of emptyPages) {
      const page = this.pages.get(pageId);
      if (page) {
        const memoryMB = page.getMemoryUsageMB();
        page.destroy();
        this.pages.delete(pageId);
        this.currentMemoryMB -= memoryMB;

        // Remove from pools
        for (const pool of this.pagePools.values()) {
          const index = pool.indexOf(page);
          if (index >= 0) {
            pool.splice(index, 1);
          }
        }
      }
    }
  }

  /**
   * Destroy all pages and release GPU resources.
   */
  public destroy(): void {
    for (const page of this.pages.values()) {
      page.destroy();
    }
    this.pages.clear();
    this.pagePools.clear();
    this.currentMemoryMB = 0;
  }

  /**
   * Get statistics.
   */
  public getStats(): {
    totalPages: number;
    totalSlots: number;
    usedSlots: number;
    freeSlots: number;
    memoryUsageMB: number;
    memoryBudgetMB: number;
  } {
    let totalSlots = 0;
    let usedSlots = 0;

    for (const page of this.pages.values()) {
      const pageSlots = page.slotsPerRow * page.slotsPerCol;
      totalSlots += pageSlots;
      usedSlots += pageSlots - page.freeCount;
    }

    return {
      totalPages: this.pages.size,
      totalSlots,
      usedSlots,
      freeSlots: totalSlots - usedSlots,
      memoryUsageMB: this.currentMemoryMB,
      memoryBudgetMB: this.memoryBudgetMB,
    };
  }
}

