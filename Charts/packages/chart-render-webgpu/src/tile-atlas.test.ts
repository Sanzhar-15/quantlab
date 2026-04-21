/**
 * Unit tests for tile atlas allocator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TileAtlasManager } from './tile-atlas';

// Mock GPUDevice for testing
class MockGPUDevice {
  createTexture(_desc: any): any {
    return {
      destroy: () => {},
    };
  }
}

describe('TileAtlasManager', () => {
  let device: any;
  let atlas: TileAtlasManager;

  beforeEach(() => {
    device = new MockGPUDevice();
    atlas = new TileAtlasManager(192); // 192 MB budget
    atlas.initialize(device);
  });

  it('should allocate slots', () => {
    const slot = atlas.allocateSlot(256);
    expect(slot).not.toBeNull();
    expect(slot?.pageId).toBeGreaterThan(0);
    expect(slot?.slotIndex).toBeGreaterThanOrEqual(0);
    expect(slot?.xPx).toBeGreaterThanOrEqual(0);
    expect(slot?.yPx).toBeGreaterThanOrEqual(0);
  });

  it('should free slots', () => {
    const slot = atlas.allocateSlot(256);
    expect(slot).not.toBeNull();
    
    if (slot) {
      atlas.freeSlot(slot);
      // Slot should be reusable
      const slot2 = atlas.allocateSlot(256);
      expect(slot2).not.toBeNull();
    }
  });

  it('should enforce memory budget', () => {
    // Allocate many slots to fill pages
    const slots = [];
    for (let i = 0; i < 100; i++) {
      const slot = atlas.allocateSlot(256);
      if (slot) {
        slots.push(slot);
      } else {
        break; // Over budget
      }
    }

    const stats = atlas.getStats();
    expect(stats.memoryUsageMB).toBeLessThanOrEqual(stats.memoryBudgetMB);
  });

  it('should get page by ID', () => {
    const slot = atlas.allocateSlot(256);
    expect(slot).not.toBeNull();
    
    if (slot) {
      const page = atlas.getPage(slot.pageId);
      expect(page).not.toBeNull();
      expect(page?.id).toBe(slot.pageId);
    }
  });

  it('should provide statistics', () => {
    const stats = atlas.getStats();
    expect(stats.totalPages).toBeGreaterThanOrEqual(0);
    expect(stats.memoryUsageMB).toBeGreaterThanOrEqual(0);
    expect(stats.memoryBudgetMB).toBe(192);
  });
});

