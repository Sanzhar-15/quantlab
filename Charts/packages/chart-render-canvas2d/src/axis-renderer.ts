import type { Rect } from '@charts-plus/chart-core';

export type AxisLabel = {
  text: string;
  y: number;
  width: number;
};

export type TimeLabel = {
  text: string;
  x: number;
  width: number;
};

export type AxisRenderOptions = {
  font: string;
  color: string;
  padding: number;
  align: 'left' | 'right';
};

export type TimeAxisRenderOptions = {
  font: string;
  color: string;
  padding: number;
};

export function renderYAxis(
  ctx: CanvasRenderingContext2D,
  axisRect: Rect,
  labels: AxisLabel[],
  options: AxisRenderOptions,
): void {
  ctx.save();
  ctx.font = options.font;
  ctx.fillStyle = options.color;
  ctx.textBaseline = 'middle';

  if (options.align === 'left') {
    ctx.textAlign = 'right';
    const x = axisRect.x + axisRect.width - options.padding;
    labels.forEach((label) => {
      ctx.fillText(label.text, x, label.y);
    });
  } else {
    ctx.textAlign = 'left';
    const x = axisRect.x + options.padding;
    labels.forEach((label) => {
      ctx.fillText(label.text, x, label.y);
    });
  }

  ctx.restore();
}

export function renderXAxis(
  ctx: CanvasRenderingContext2D,
  axisRect: Rect,
  labels: TimeLabel[],
  options: TimeAxisRenderOptions,
): void {
  ctx.save();
  ctx.font = options.font;
  ctx.fillStyle = options.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  const y = axisRect.y + options.padding;
  labels.forEach((label) => {
    ctx.fillText(label.text, label.x, y);
  });

  ctx.restore();
}
