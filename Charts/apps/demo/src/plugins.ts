import type { ChartPlugin, PluginRenderState } from '@charts-plus/chart-core';

export type ThresholdBandOptions = {
  min: number;
  max: number;
  color?: string;
  opacity?: number;
  visible?: boolean;
};

export const createThresholdBandPlugin = (
  options: ThresholdBandOptions,
): ChartPlugin<CanvasRenderingContext2D> & { setVisible: (v: boolean) => void } => {
  let visible = options.visible ?? true;
  return {
    setVisible: (v: boolean) => (visible = v),
    onRenderUnderlay(ctx, state) {
      if (!visible) return;
      const min = Math.min(options.min, options.max);
      const max = Math.max(options.min, options.max);
      const topValue = state.valueToY(max);
      const bottomValue = state.valueToY(min);
      if (!Number.isFinite(topValue) || !Number.isFinite(bottomValue)) return;

      const top = Math.max(state.plotRect.y, Math.min(topValue, bottomValue));
      const bottom = Math.min(
        state.plotRect.y + state.plotRect.height,
        Math.max(topValue, bottomValue),
      );
      const height = bottom - top;
      if (height <= 0) return;

      ctx.save();
      ctx.globalAlpha = options.opacity ?? 1;
      ctx.fillStyle = options.color ?? state.theme.focusBand;
      ctx.fillRect(state.plotRect.x, top, state.plotRect.width, height);
      ctx.restore();
    },
  };
};

export type EventMarker = {
  time: number;
  label: string;
  color?: string;
};

export type EventMarkersOptions = {
  events: EventMarker[];
  lineWidth?: number;
  labelOffset?: number;
  labelPadding?: number;
  hitRadius?: number;
  visible?: boolean;
};

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

export const createEventMarkersPlugin = (
  options: EventMarkersOptions,
): ChartPlugin<CanvasRenderingContext2D> & { setVisible: (v: boolean) => void } => {
  let hoveredIndex: number | null = null;
  let visible = options.visible ?? true;

  const hitTest = (x: number, state: PluginRenderState) => {
    if (!visible) return null;
    const radius = Math.max(4, options.hitRadius ?? 6);
    const minTime = state.visibleRange.from;
    const maxTime = state.visibleRange.to;
    let bestIndex: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    options.events.forEach((event, index) => {
      if (event.time < minTime || event.time > maxTime) return;
      const eventX = state.timeToX(event.time);
      if (!Number.isFinite(eventX)) return;
      const distance = Math.abs(eventX - x);
      if (distance <= radius && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  };

  return {
    setVisible: (v: boolean) => (visible = v),
    onPointer(event, state) {
      if (!visible || event.type === 'leave' || !event.inPlot) {
        hoveredIndex = null;
        return;
      }
      hoveredIndex = hitTest(event.x, state);
    },
    onRenderOverlay(ctx, state) {
      if (!visible || options.events.length === 0) return;
      const { plotRect, theme } = state;
      const fontSize = Math.max(10, Math.round(theme.fontSizePx));
      const font = `${fontSize}px ${theme.fontFamily}`;
      const lineWidth = Math.max(1, Math.round(options.lineWidth ?? 1));
      const labelPadding = Math.max(4, Math.round(options.labelPadding ?? 6));
      const labelOffset = Math.max(4, Math.round(options.labelOffset ?? 10));
      const labelPadY = Math.max(2, Math.round(fontSize * 0.3));
      const labelHeight = fontSize + labelPadY * 2;
      const rowGap = Math.max(2, Math.round(fontSize * 0.25));
      const rowStride = labelHeight + rowGap;
      const minTime = state.visibleRange.from;
      const maxTime = state.visibleRange.to;

      ctx.font = font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const visibleEvents = options.events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.time >= minTime && event.time <= maxTime)
        .map(({ event, index }) => {
          const x = state.timeToX(event.time);
          if (!Number.isFinite(x)) return null;
          if (x < plotRect.x || x > plotRect.x + plotRect.width) return null;
          const snappedX = state.snapX(x);
          const text = event.label;
          const textWidth = ctx.measureText(text).width;
          const labelWidth = textWidth + labelPadding * 2;
          return {
            event,
            index,
            snappedX,
            labelWidth,
            text,
            color: event.color ?? theme.crosshair,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      if (visibleEvents.length === 0) return;

      const hovered = hoveredIndex === null ? null : visibleEvents.find((entry) => entry.index === hoveredIndex);

      visibleEvents.forEach((entry) => {
        const isHovered = entry.index === hoveredIndex;
        ctx.save();
        ctx.strokeStyle = entry.color;
        ctx.globalAlpha = isHovered ? 0.9 : 0.45;
        ctx.lineWidth = isHovered ? lineWidth + 1 : lineWidth;
        ctx.beginPath();
        ctx.moveTo(entry.snappedX, plotRect.y);
        ctx.lineTo(entry.snappedX, plotRect.y + plotRect.height);
        ctx.stroke();
        ctx.restore();
      });

      const maxRows = Math.max(
        1,
        Math.min(3, Math.floor((plotRect.height - labelOffset - labelHeight) / rowStride) + 1),
      );
      const rowEnds = Array.from({ length: maxRows }, () => Number.NEGATIVE_INFINITY);

      const placed = visibleEvents
        .filter((entry) => entry.index !== hoveredIndex)
        .sort((a, b) => a.snappedX - b.snappedX)
        .map((entry) => {
          const minX = plotRect.x + 2;
          const maxX = plotRect.x + plotRect.width - entry.labelWidth - 2;
          const labelX = Math.max(minX, Math.min(entry.snappedX - entry.labelWidth * 0.5, maxX));
          let row = -1;
          for (let i = 0; i < maxRows; i += 1) {
            if (labelX >= rowEnds[i]! + rowGap) {
              row = i;
              rowEnds[i] = labelX + entry.labelWidth;
              break;
            }
          }
          return row >= 0 ? { entry, labelX, row } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      placed.forEach(({ entry, labelX, row }) => {
        const labelY = plotRect.y + labelOffset + row * rowStride;
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = theme.background;
        drawRoundedRect(ctx, labelX, labelY, entry.labelWidth, labelHeight, labelHeight * 0.5);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.axisText;
        ctx.fillText(entry.text, labelX + labelPadding, labelY + labelHeight * 0.5);
        ctx.restore();
      });

      if (hovered) {
        const minX = plotRect.x + 2;
        const maxX = plotRect.x + plotRect.width - hovered.labelWidth - 2;
        const labelX = Math.max(minX, Math.min(hovered.snappedX - hovered.labelWidth * 0.5, maxX));
        const labelY = plotRect.y + labelOffset;
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = theme.focusBand;
        drawRoundedRect(ctx, labelX, labelY, hovered.labelWidth, labelHeight, labelHeight * 0.5);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.fillStyle = hovered.color;
        ctx.fillText(hovered.text, labelX + labelPadding, labelY + labelHeight * 0.5);
        ctx.restore();
      }
    },
  };
};
