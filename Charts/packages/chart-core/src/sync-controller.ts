/**
 * Multi-Chart Synchronization Controller
 * 
 * Coordinates pan, zoom, and crosshair events between multiple chart instances.
 * Supports different sync modes: time, price, both, crosshair-only.
 */

export type SyncMode = 'none' | 'time' | 'price' | 'both' | 'crosshair';

export interface SyncGroupConfig {
  id: string;
  mode: SyncMode;
  enabled?: boolean;
}

export interface SyncEvent {
  type: 'pan' | 'zoom' | 'crosshair';
  source: any; // Chart instance
  data: any;
}

interface ChartRegistration {
  chart: any;
  groupId: string;
}

/**
 * SyncController manages synchronization between multiple charts.
 * 
 * Usage:
 * ```ts
 * const syncController = new SyncController();
 * syncController.createGroup({ id: 'main', mode: 'both' });
 * syncController.addChart(chart1, 'main');
 * syncController.addChart(chart2, 'main');
 * ```
 */
export class SyncController {
  private groups: Map<string, SyncGroupConfig> = new Map();
  private charts: Map<any, ChartRegistration> = new Map();
  private eventHandlers: Map<any, Map<string, (event: any) => void>> = new Map();
  private broadcasting = false;

  /**
   * Create a new sync group.
   */
  public createGroup(config: SyncGroupConfig): void {
    this.groups.set(config.id, {
      ...config,
      enabled: config.enabled ?? true,
    });
  }

  /**
   * Remove a sync group and unregister all its charts.
   */
  public removeGroup(groupId: string): void {
    // Unregister all charts in this group
    const chartsToRemove: any[] = [];
    this.charts.forEach((registration, chart) => {
      if (registration.groupId === groupId) {
        chartsToRemove.push(chart);
      }
    });

    chartsToRemove.forEach((chart) => this.removeChart(chart));
    this.groups.delete(groupId);
  }

  /**
   * Update sync group configuration.
   */
  public updateGroup(groupId: string, config: Partial<SyncGroupConfig>): void {
    const existing = this.groups.get(groupId);
    if (!existing) {
      throw new Error(`Sync group '${groupId}' not found`);
    }

    this.groups.set(groupId, {
      ...existing,
      ...config,
    });
  }

  /**
   * Add a chart to a sync group.
   */
  public addChart(chart: any, groupId: string): void {
    if (!this.groups.has(groupId)) {
      throw new Error(`Sync group '${groupId}' not found. Create it first with createGroup().`);
    }

    if (this.charts.has(chart)) {
      throw new Error('Chart is already registered in a sync group');
    }

    this.charts.set(chart, { chart, groupId });

    // Set up event listeners
    const handlers = new Map<string, (event: any) => void>();

    const onPan = (event: any) => this.handleChartEvent(chart, 'pan', event);
    const onZoom = (event: any) => this.handleChartEvent(chart, 'zoom', event);
    const onCrosshair = (event: any) => this.handleChartEvent(chart, 'crosshair', event);

    handlers.set('pan', onPan);
    handlers.set('zoom', onZoom);
    handlers.set('crosshair', onCrosshair);

    this.eventHandlers.set(chart, handlers);

    // Register listeners with chart
    if (chart.on) {
      chart.on('pan', onPan);
      chart.on('zoom', onZoom);
      chart.on('crosshair', onCrosshair);
    }
  }

  /**
   * Remove a chart from its sync group.
   */
  public removeChart(chart: any): void {
    const registration = this.charts.get(chart);
    if (!registration) {
      return;
    }

    // Remove event listeners
    const handlers = this.eventHandlers.get(chart);
    if (handlers && chart.off) {
      handlers.forEach((handler, eventType) => {
        chart.off(eventType, handler);
      });
    }

    this.eventHandlers.delete(chart);
    this.charts.delete(chart);
  }

  /**
   * Get all charts in a sync group.
   */
  public getGroupCharts(groupId: string): any[] {
    const charts: any[] = [];
    this.charts.forEach((registration, chart) => {
      if (registration.groupId === groupId) {
        charts.push(chart);
      }
    });
    return charts;
  }

  /**
   * Enable/disable a sync group.
   */
  public setGroupEnabled(groupId: string, enabled: boolean): void {
    const group = this.groups.get(groupId);
    if (group) {
      group.enabled = enabled;
    }
  }

  /**
   * Handle chart event and broadcast to other charts in the same group.
   */
  private handleChartEvent(sourceChart: any, eventType: string, eventData: any): void {
    // Prevent infinite loops
    if (this.broadcasting) {
      return;
    }

    const registration = this.charts.get(sourceChart);
    if (!registration) {
      return;
    }

    const group = this.groups.get(registration.groupId);
    if (!group || !group.enabled) {
      return;
    }

    // Check if this event type should be synced based on mode
    if (!this.shouldSyncEvent(group.mode, eventType)) {
      return;
    }

    // Broadcast to other charts in the same group
    this.broadcasting = true;
    try {
      this.charts.forEach((otherRegistration, otherChart) => {
        if (
          otherChart !== sourceChart &&
          otherRegistration.groupId === registration.groupId
        ) {
          this.applyEventToChart(otherChart, eventType, eventData, group.mode);
        }
      });
    } finally {
      this.broadcasting = false;
    }
  }

  /**
   * Check if an event type should be synced based on the sync mode.
   */
  private shouldSyncEvent(mode: SyncMode, eventType: string): boolean {
    switch (mode) {
      case 'none':
        return false;
      case 'time':
        return eventType === 'pan' || eventType === 'zoom';
      case 'price':
        return eventType === 'pan' || eventType === 'zoom';
      case 'both':
        return eventType === 'pan' || eventType === 'zoom';
      case 'crosshair':
        return eventType === 'crosshair';
      default:
        return false;
    }
  }

  /**
   * Apply synced event to a target chart.
   */
  private applyEventToChart(
    chart: any,
    eventType: string,
    eventData: any,
    mode: SyncMode
  ): void {
    if (!chart) return;

    switch (eventType) {
      case 'pan':
        if (mode === 'time' || mode === 'both') {
          // Sync time axis only
          if (chart.setTimeRange && eventData.timeRange) {
            chart.setTimeRange(eventData.timeRange.start, eventData.timeRange.end);
          }
        }
        if (mode === 'price' || mode === 'both') {
          // Sync price axis only
          if (chart.setPriceRange && eventData.priceRange) {
            chart.setPriceRange(eventData.priceRange.min, eventData.priceRange.max);
          }
        }
        break;

      case 'zoom':
        if (mode === 'time' || mode === 'both') {
          // Sync time zoom
          if (chart.setTimeRange && eventData.timeRange) {
            chart.setTimeRange(eventData.timeRange.start, eventData.timeRange.end);
          }
        }
        if (mode === 'price' || mode === 'both') {
          // Sync price zoom
          if (chart.setPriceRange && eventData.priceRange) {
            chart.setPriceRange(eventData.priceRange.min, eventData.priceRange.max);
          }
        }
        break;

      case 'crosshair':
        if (mode === 'crosshair' || mode === 'both') {
          // Sync crosshair position
          if (chart.setCrosshair && eventData.position) {
            chart.setCrosshair(eventData.position);
          }
        }
        break;
    }
  }

  /**
   * Destroy the sync controller and clean up all registrations.
   */
  public destroy(): void {
    // Remove all charts
    const chartsToRemove = Array.from(this.charts.keys());
    chartsToRemove.forEach((chart) => this.removeChart(chart));

    this.groups.clear();
    this.charts.clear();
    this.eventHandlers.clear();
  }
}

/**
 * Global singleton instance (optional convenience).
 */
let globalSyncController: SyncController | null = null;

export function getGlobalSyncController(): SyncController {
  if (!globalSyncController) {
    globalSyncController = new SyncController();
  }
  return globalSyncController;
}

export function resetGlobalSyncController(): void {
  if (globalSyncController) {
    globalSyncController.destroy();
    globalSyncController = null;
  }
}

