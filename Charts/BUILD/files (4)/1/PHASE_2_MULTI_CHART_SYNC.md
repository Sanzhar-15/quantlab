# V6 Implementation Guide: Phase 2 - Multi-Chart Synchronization

## Overview

Multi-chart synchronization allows multiple charts to pan, zoom, and track crosshairs together. Essential for professional trading workflows.

**Location:** `packages/chart-core/src/sync-controller.ts`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   SyncController                         │
│                                                         │
│  Groups: Map<groupId, SyncGroup>                        │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Chart A    │  │  Chart B    │  │  Chart C    │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          ▼                              │
│              ┌───────────────────────┐                 │
│              │   Event Bus           │                 │
│              │   - pan               │                 │
│              │   - zoom              │                 │
│              │   - crosshair         │                 │
│              └───────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

---

## Task 1: SyncController Core

### File: `packages/chart-core/src/sync-controller.ts`

```typescript
import type { Chart } from './api';

// Sync modes
export type SyncMode = 
  | 'none'           // No synchronization
  | 'time'           // Sync time axis only
  | 'price'          // Sync price axis only  
  | 'both'           // Sync both axes
  | 'crosshair';     // Sync crosshair only

// Sync group configuration
export interface SyncGroupConfig {
  id: string;
  mode: SyncMode;
  syncZoom?: boolean;       // Default: true
  syncPan?: boolean;        // Default: true
  syncCrosshair?: boolean;  // Default: true
  alignTo?: 'latest' | 'earliest' | 'center';  // How to align charts
}

// Internal sync group state
interface SyncGroup {
  id: string;
  config: SyncGroupConfig;
  charts: Set<Chart>;
  subscriptions: Map<Chart, () => void>;
}

// Sync events
export type SyncEventType = 'pan' | 'zoom' | 'crosshair' | 'selection';

export interface SyncEvent<T = unknown> {
  type: SyncEventType;
  source: Chart;
  groupId: string;
  payload: T;
  timestamp: number;
}

export interface PanPayload {
  from: number;
  to: number;
  deltaPixels?: number;
}

export interface ZoomPayload {
  centerTime: number;
  factor: number;
  newFrom: number;
  newTo: number;
}

export interface CrosshairPayload {
  time: number | null;
  price?: number | null;
  visible: boolean;
}

// Event listener type
export type SyncEventListener = (event: SyncEvent) => void;

/**
 * SyncController manages synchronization between multiple charts.
 */
export class SyncController {
  private _groups: Map<string, SyncGroup> = new Map();
  private _chartToGroup: Map<Chart, string> = new Map();
  private _broadcasting = false;
  private _listeners: Set<SyncEventListener> = new Set();
  private _enabled = true;
  
  /**
   * Create a new sync group.
   */
  createGroup(config: SyncGroupConfig): void {
    if (this._groups.has(config.id)) {
      console.warn(`Sync group ${config.id} already exists`);
      return;
    }
    
    this._groups.set(config.id, {
      id: config.id,
      config: {
        syncZoom: true,
        syncPan: true,
        syncCrosshair: true,
        alignTo: 'latest',
        ...config,
      },
      charts: new Set(),
      subscriptions: new Map(),
    });
  }
  
  /**
   * Remove a sync group.
   */
  removeGroup(groupId: string): void {
    const group = this._groups.get(groupId);
    if (!group) return;
    
    // Unsubscribe all charts
    for (const chart of group.charts) {
      this._unsubscribeChart(chart, group);
      this._chartToGroup.delete(chart);
    }
    
    this._groups.delete(groupId);
  }
  
  /**
   * Add a chart to a sync group.
   */
  addChart(chart: Chart, groupId: string): void {
    const group = this._groups.get(groupId);
    if (!group) {
      throw new Error(`Sync group ${groupId} not found`);
    }
    
    // Remove from previous group if any
    const prevGroupId = this._chartToGroup.get(chart);
    if (prevGroupId) {
      this.removeChart(chart);
    }
    
    group.charts.add(chart);
    this._chartToGroup.set(chart, groupId);
    
    // Subscribe to chart events
    this._subscribeChart(chart, group);
  }
  
  /**
   * Remove a chart from its sync group.
   */
  removeChart(chart: Chart): void {
    const groupId = this._chartToGroup.get(chart);
    if (!groupId) return;
    
    const group = this._groups.get(groupId);
    if (group) {
      this._unsubscribeChart(chart, group);
      group.charts.delete(chart);
    }
    
    this._chartToGroup.delete(chart);
  }
  
  /**
   * Get the sync group for a chart.
   */
  getChartGroup(chart: Chart): string | null {
    return this._chartToGroup.get(chart) ?? null;
  }
  
  /**
   * Get all charts in a group.
   */
  getGroupCharts(groupId: string): Chart[] {
    const group = this._groups.get(groupId);
    return group ? Array.from(group.charts) : [];
  }
  
  /**
   * Enable/disable synchronization.
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }
  
  /**
   * Check if synchronization is enabled.
   */
  isEnabled(): boolean {
    return this._enabled;
  }
  
  /**
   * Add event listener.
   */
  addEventListener(listener: SyncEventListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
  
  /**
   * Manually broadcast a sync event (for external integrations).
   */
  broadcast(event: Omit<SyncEvent, 'timestamp'>): void {
    this._handleEvent({ ...event, timestamp: performance.now() });
  }
  
  /**
   * Subscribe to a chart's events.
   */
  private _subscribeChart(chart: Chart, group: SyncGroup): void {
    const unsubscribers: (() => void)[] = [];
    
    // Subscribe to viewport changes (pan/zoom)
    if (group.config.syncPan || group.config.syncZoom) {
      const unsub = chart.onVisibleTimeRangeChange((range) => {
        if (!this._enabled || this._broadcasting) return;
        
        this._handleEvent({
          type: 'pan',
          source: chart,
          groupId: group.id,
          payload: { from: range.from, to: range.to } as PanPayload,
          timestamp: performance.now(),
        });
      });
      unsubscribers.push(unsub);
    }
    
    // Subscribe to crosshair changes
    if (group.config.syncCrosshair) {
      const unsub = chart.onCrosshairMove((event) => {
        if (!this._enabled || this._broadcasting) return;
        
        this._handleEvent({
          type: 'crosshair',
          source: chart,
          groupId: group.id,
          payload: { 
            time: event.time, 
            price: event.price,
            visible: event.time !== null,
          } as CrosshairPayload,
          timestamp: performance.now(),
        });
      });
      unsubscribers.push(unsub);
    }
    
    // Store unsubscribers
    group.subscriptions.set(chart, () => {
      unsubscribers.forEach(unsub => unsub());
    });
  }
  
  /**
   * Unsubscribe from a chart's events.
   */
  private _unsubscribeChart(chart: Chart, group: SyncGroup): void {
    const unsub = group.subscriptions.get(chart);
    if (unsub) {
      unsub();
      group.subscriptions.delete(chart);
    }
  }
  
  /**
   * Handle sync event.
   */
  private _handleEvent(event: SyncEvent): void {
    const group = this._groups.get(event.groupId);
    if (!group) return;
    
    // Notify listeners
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Sync event listener error:', e);
      }
    }
    
    // Broadcast to other charts in group
    this._broadcasting = true;
    
    try {
      for (const chart of group.charts) {
        if (chart === event.source) continue;
        
        switch (event.type) {
          case 'pan':
            if (group.config.syncPan || group.config.mode === 'time' || group.config.mode === 'both') {
              this._syncPan(chart, event.payload as PanPayload, group.config);
            }
            break;
            
          case 'zoom':
            if (group.config.syncZoom || group.config.mode === 'time' || group.config.mode === 'both') {
              this._syncZoom(chart, event.payload as ZoomPayload);
            }
            break;
            
          case 'crosshair':
            if (group.config.syncCrosshair || group.config.mode === 'crosshair') {
              this._syncCrosshair(chart, event.payload as CrosshairPayload);
            }
            break;
        }
      }
    } finally {
      this._broadcasting = false;
    }
  }
  
  /**
   * Sync pan to another chart.
   */
  private _syncPan(chart: Chart, payload: PanPayload, config: SyncGroupConfig): void {
    const currentRange = chart.getVisibleTimeRange();
    if (!currentRange) return;
    
    const currentSpan = currentRange.to - currentRange.from;
    
    switch (config.alignTo) {
      case 'latest':
        // Align to same end time, maintain span
        chart.setVisibleTimeRange({
          from: payload.to - currentSpan,
          to: payload.to,
        });
        break;
        
      case 'earliest':
        // Align to same start time, maintain span
        chart.setVisibleTimeRange({
          from: payload.from,
          to: payload.from + currentSpan,
        });
        break;
        
      case 'center':
        // Align to same center time, maintain span
        const sourceCenter = (payload.from + payload.to) / 2;
        chart.setVisibleTimeRange({
          from: sourceCenter - currentSpan / 2,
          to: sourceCenter + currentSpan / 2,
        });
        break;
    }
  }
  
  /**
   * Sync zoom to another chart.
   */
  private _syncZoom(chart: Chart, payload: ZoomPayload): void {
    // Apply same zoom factor centered on same time
    chart.zoomAt(payload.centerTime, payload.factor);
  }
  
  /**
   * Sync crosshair to another chart.
   */
  private _syncCrosshair(chart: Chart, payload: CrosshairPayload): void {
    if (payload.visible && payload.time !== null) {
      chart.setCrosshairTime(payload.time);
    } else {
      chart.clearCrosshair();
    }
  }
  
  /**
   * Destroy the sync controller.
   */
  destroy(): void {
    for (const group of this._groups.values()) {
      for (const chart of group.charts) {
        this._unsubscribeChart(chart, group);
      }
    }
    
    this._groups.clear();
    this._chartToGroup.clear();
    this._listeners.clear();
  }
}

// Global singleton (optional)
let _globalSyncController: SyncController | null = null;

export function getGlobalSyncController(): SyncController {
  if (!_globalSyncController) {
    _globalSyncController = new SyncController();
  }
  return _globalSyncController;
}
```

---

## Task 2: Chart API Extensions

### File: `packages/chart-core/src/api.ts` (additions)

Add these methods to the Chart interface:

```typescript
// Add to Chart interface
interface Chart {
  // Existing methods...
  
  // Sync-related methods
  setCrosshairTime(time: number): void;
  clearCrosshair(): void;
  zoomAt(centerTime: number, factor: number): void;
}
```

---

## Task 3: Integration with Canvas2D Renderer

### File: `packages/chart-render-canvas2d/src/index.ts` (additions)

Add these methods to the Chart implementation:

```typescript
// Add to createChart function's returned chart object

/**
 * Set crosshair to specific time (for sync).
 */
setCrosshairTime(time: number): void {
  const x = xScale.timeToX(time);
  if (x >= plotRect.x && x <= plotRect.x + plotRect.width) {
    // Update crosshair position
    crosshairState.time = time;
    crosshairState.x = x;
    crosshairState.visible = true;
    invalidate(InvalidationFlag.Overlay);
  }
}

/**
 * Clear crosshair (for sync).
 */
clearCrosshair(): void {
  crosshairState.visible = false;
  crosshairState.time = null;
  crosshairState.x = null;
  invalidate(InvalidationFlag.Overlay);
}

/**
 * Zoom at specific time with factor (for sync).
 */
zoomAt(centerTime: number, factor: number): void {
  const centerX = xScale.timeToX(centerTime);
  xScale.zoomAtPoint(centerX, factor);
  invalidate(InvalidationFlag.Series | InvalidationFlag.Underlay);
}
```

---

## Task 4: Usage Example

### File: `apps/demo/src/multi-chart-demo.ts`

```typescript
import { createChart, SyncController } from '@charts-plus/chart-render-canvas2d';

// Create sync controller
const syncController = new SyncController();

// Create sync group for BTC timeframes
syncController.createGroup({
  id: 'btc-timeframes',
  mode: 'time',
  syncPan: true,
  syncZoom: true,
  syncCrosshair: true,
  alignTo: 'latest',
});

// Create charts
const chart1m = createChart('container-1m', { /* options */ });
const chart5m = createChart('container-5m', { /* options */ });
const chart1h = createChart('container-1h', { /* options */ });

// Add to sync group
syncController.addChart(chart1m, 'btc-timeframes');
syncController.addChart(chart5m, 'btc-timeframes');
syncController.addChart(chart1h, 'btc-timeframes');

// Listen to sync events
syncController.addEventListener((event) => {
  console.log('Sync event:', event.type, event.payload);
});

// Later: remove chart from sync
// syncController.removeChart(chart1m);

// Cleanup
// syncController.destroy();
```

---

## Task 5: Tests

### File: `packages/chart-core/src/__tests__/sync-controller.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncController } from '../sync-controller';

describe('SyncController', () => {
  let syncController: SyncController;
  let mockChart1: any;
  let mockChart2: any;
  
  beforeEach(() => {
    syncController = new SyncController();
    
    mockChart1 = {
      onVisibleTimeRangeChange: vi.fn(() => () => {}),
      onCrosshairMove: vi.fn(() => () => {}),
      getVisibleTimeRange: vi.fn(() => ({ from: 0, to: 1000 })),
      setVisibleTimeRange: vi.fn(),
      setCrosshairTime: vi.fn(),
      clearCrosshair: vi.fn(),
      zoomAt: vi.fn(),
    };
    
    mockChart2 = {
      onVisibleTimeRangeChange: vi.fn(() => () => {}),
      onCrosshairMove: vi.fn(() => () => {}),
      getVisibleTimeRange: vi.fn(() => ({ from: 0, to: 2000 })),
      setVisibleTimeRange: vi.fn(),
      setCrosshairTime: vi.fn(),
      clearCrosshair: vi.fn(),
      zoomAt: vi.fn(),
    };
  });
  
  it('should create sync group', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    expect(syncController.getGroupCharts('test')).toEqual([]);
  });
  
  it('should add charts to group', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    syncController.addChart(mockChart1, 'test');
    syncController.addChart(mockChart2, 'test');
    
    expect(syncController.getGroupCharts('test')).toHaveLength(2);
  });
  
  it('should subscribe to chart events', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    syncController.addChart(mockChart1, 'test');
    
    expect(mockChart1.onVisibleTimeRangeChange).toHaveBeenCalled();
    expect(mockChart1.onCrosshairMove).toHaveBeenCalled();
  });
  
  it('should remove chart from group', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    syncController.addChart(mockChart1, 'test');
    syncController.removeChart(mockChart1);
    
    expect(syncController.getGroupCharts('test')).toHaveLength(0);
    expect(syncController.getChartGroup(mockChart1)).toBeNull();
  });
  
  it('should broadcast pan events', () => {
    syncController.createGroup({ 
      id: 'test', 
      mode: 'time',
      alignTo: 'latest',
    });
    syncController.addChart(mockChart1, 'test');
    syncController.addChart(mockChart2, 'test');
    
    // Simulate pan event from chart1
    syncController.broadcast({
      type: 'pan',
      source: mockChart1,
      groupId: 'test',
      payload: { from: 100, to: 1100 },
    });
    
    // Chart2 should receive synced pan
    expect(mockChart2.setVisibleTimeRange).toHaveBeenCalled();
  });
  
  it('should not broadcast when disabled', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    syncController.addChart(mockChart1, 'test');
    syncController.addChart(mockChart2, 'test');
    
    syncController.setEnabled(false);
    
    syncController.broadcast({
      type: 'pan',
      source: mockChart1,
      groupId: 'test',
      payload: { from: 100, to: 1100 },
    });
    
    expect(mockChart2.setVisibleTimeRange).not.toHaveBeenCalled();
  });
  
  it('should sync crosshair', () => {
    syncController.createGroup({ 
      id: 'test', 
      mode: 'crosshair',
      syncCrosshair: true,
    });
    syncController.addChart(mockChart1, 'test');
    syncController.addChart(mockChart2, 'test');
    
    syncController.broadcast({
      type: 'crosshair',
      source: mockChart1,
      groupId: 'test',
      payload: { time: 500, visible: true },
    });
    
    expect(mockChart2.setCrosshairTime).toHaveBeenCalledWith(500);
  });
  
  it('should clean up on destroy', () => {
    syncController.createGroup({ id: 'test', mode: 'time' });
    syncController.addChart(mockChart1, 'test');
    syncController.destroy();
    
    expect(syncController.getGroupCharts('test')).toHaveLength(0);
  });
});
```

---

## Verification Checklist

- [ ] Pan chart A → Charts B, C pan to same time
- [ ] Zoom chart A → Charts B, C maintain relative zoom
- [ ] Crosshair on A → Crosshair appears at same time on B, C
- [ ] Different timeframes align correctly (1m, 5m, 1h)
- [ ] Sync latency < 16ms
- [ ] No infinite loops when syncing
- [ ] Can disable/enable sync
- [ ] Can remove charts from sync
- [ ] Memory cleaned up on destroy

---

## Performance Considerations

1. **Debounce sync events** - During rapid panning, batch events
2. **Use requestAnimationFrame** - Don't sync faster than display refresh
3. **Avoid allocations** - Reuse event objects where possible
4. **Track broadcasting state** - Prevent infinite loops

---

## Next Steps

After completing Phase 2:
1. Test with real multi-chart layouts
2. Profile sync performance
3. Proceed to Phase 3: Trading Overlay
