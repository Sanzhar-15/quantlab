import type {
  Chart,
  ChartPlugin,
  CrosshairState,
  LayoutResult,
  Rect,
  VisibleTimeRange,
} from '@charts-plus/chart-core';

import { getChartRuntime } from './chart-runtime';

export type SyncGroupOptions = {
  syncTimeRange?: boolean;
  syncCrosshair?: boolean;
};

export type SyncGroup = {
  add: (chart: Chart) => () => void;
  remove: (chart: Chart) => void;
  destroy: () => void;
};

type PendingRange = {
  source: Chart;
  range: VisibleTimeRange;
};

type PendingCrosshair = {
  source: Chart;
  state: CrosshairState | null;
};

type MemberState = {
  chart: Chart;
  active: boolean;
  unsubscribeRange?: () => void;
  plugin?: ChartPlugin;
};

const isSameRange = (a: VisibleTimeRange, b: VisibleTimeRange): boolean =>
  a.from === b.from && a.to === b.to;

const isSameCrosshair = (a: CrosshairState | null, b: CrosshairState | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const paneA = a.paneId ?? null;
  const paneB = b.paneId ?? null;
  const ratioA = typeof a.yRatio === 'number' ? a.yRatio : null;
  const ratioB = typeof b.yRatio === 'number' ? b.yRatio : null;
  return a.time === b.time && paneA === paneB && ratioA === ratioB;
};

const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

const resolvePane = (
  layout: LayoutResult,
  fallback: Rect,
  y: number,
): { paneId?: string; yRatio: number } => {
  if (layout.panes && layout.panes.length > 0) {
    for (const pane of layout.panes) {
      const rect = pane.plotRect;
      if (y >= rect.y && y <= rect.y + rect.height) {
        const ratio = rect.height > 0 ? (y - rect.y) / rect.height : 0.5;
        return { paneId: pane.id, yRatio: clampRatio(ratio) };
      }
    }
  }
  const ratio = fallback.height > 0 ? (y - fallback.y) / fallback.height : 0.5;
  return { yRatio: clampRatio(ratio) };
};

export const createSyncGroup = (options: SyncGroupOptions = {}): SyncGroup => {
  const syncTimeRange = options.syncTimeRange ?? true;
  const syncCrosshair = options.syncCrosshair ?? true;
  const members = new Map<Chart, MemberState>();
  const suppressRange = new Map<Chart, number>();
  const lastSyncedCrosshair = new Map<Chart, CrosshairState | null>();
  let pendingRange: PendingRange | null = null;
  let pendingCrosshair: PendingCrosshair | null = null;
  let scheduled = false;

  const runtime = getChartRuntime();
  const runtimeHandle = runtime.createHandle(null);

  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = true;
    runtimeHandle.requestFrame(flush);
  };

  const flush = () => {
    scheduled = false;
    const range = pendingRange;
    const crosshair = pendingCrosshair;
    pendingRange = null;
    pendingCrosshair = null;
    if (range) {
      members.forEach((member) => {
        if (!member.active || member.chart === range.source) return;
        const current = member.chart.getVisibleTimeRange();
        if (isSameRange(current, range.range)) return;
        const currentSuppress = suppressRange.get(member.chart) ?? 0;
        suppressRange.set(member.chart, currentSuppress + 1);
        member.chart.setVisibleTimeRange(range.range);
        const next = member.chart.getVisibleTimeRange();
        if (isSameRange(current, next)) {
          const remaining = (suppressRange.get(member.chart) ?? 1) - 1;
          if (remaining <= 0) {
            suppressRange.delete(member.chart);
          } else {
            suppressRange.set(member.chart, remaining);
          }
        }
      });
    }
    if (crosshair) {
      members.forEach((member) => {
        if (!member.active || member.chart === crosshair.source) return;
        const lastState = lastSyncedCrosshair.get(member.chart) ?? null;
        if (isSameCrosshair(lastState, crosshair.state)) return;
        lastSyncedCrosshair.set(member.chart, crosshair.state);
        member.chart.setCrosshair(crosshair.state);
      });
    }
  };

  const queueRangeSync = (source: Chart, range: VisibleTimeRange) => {
    pendingRange = { source, range: { from: range.from, to: range.to } };
    scheduleFlush();
  };

  const queueCrosshairSync = (source: Chart, state: CrosshairState | null) => {
    pendingCrosshair = { source, state };
    scheduleFlush();
  };

  const onRangeChange = (chart: Chart, range: VisibleTimeRange) => {
    if (!syncTimeRange) return;
    const member = members.get(chart);
    if (!member || !member.active) return;
    const suppressed = suppressRange.get(chart) ?? 0;
    if (suppressed > 0) {
      const next = suppressed - 1;
      if (next <= 0) {
        suppressRange.delete(chart);
      } else {
        suppressRange.set(chart, next);
      }
      return;
    }
    queueRangeSync(chart, range);
  };

  const createPointerPlugin = (chart: Chart): ChartPlugin => ({
    onPointer: (event, state) => {
      if (!syncCrosshair) return;
      const member = members.get(chart);
      if (!member || !member.active) return;
      if (event.type === 'leave' || (event.type === 'move' && !event.inPlot)) {
        queueCrosshairSync(chart, null);
        return;
      }
      if (!event.inPlot || event.time === null) return;
      if (event.type !== 'move' && event.type !== 'down') return;
      const { paneId, yRatio } = resolvePane(state.layout, state.plotRect, event.y);
      queueCrosshairSync(chart, paneId ? { time: event.time, paneId, yRatio } : { time: event.time, yRatio });
    },
  });

  const add = (chart: Chart): (() => void) => {
    const existing = members.get(chart);
    if (existing) {
      existing.active = true;
      if (syncTimeRange && !existing.unsubscribeRange) {
        existing.unsubscribeRange = chart.onVisibleTimeRangeChange((range) => onRangeChange(chart, range));
      }
      if (syncCrosshair && !existing.plugin) {
        existing.plugin = createPointerPlugin(chart);
        chart.addPlugin(existing.plugin);
      }
      return () => remove(chart);
    }

    const member: MemberState = { chart, active: true };
    if (syncTimeRange) {
      member.unsubscribeRange = chart.onVisibleTimeRangeChange((range) => onRangeChange(chart, range));
    }
    if (syncCrosshair) {
      member.plugin = createPointerPlugin(chart);
      chart.addPlugin(member.plugin);
    }
    members.set(chart, member);

    return () => remove(chart);
  };

  const remove = (chart: Chart) => {
    const member = members.get(chart);
    if (!member) return;
    member.active = false;
    member.unsubscribeRange?.();
    delete member.unsubscribeRange;
    suppressRange.delete(chart);
    lastSyncedCrosshair.delete(chart);
  };

  const destroy = () => {
    members.forEach((member) => {
      member.active = false;
      member.unsubscribeRange?.();
    });
    members.clear();
    suppressRange.clear();
    lastSyncedCrosshair.clear();
    pendingRange = null;
    pendingCrosshair = null;
    runtimeHandle.destroy();
  };

  return { add, remove, destroy };
};
