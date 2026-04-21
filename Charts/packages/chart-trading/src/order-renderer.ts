/**
 * Order line renderer for trading overlay.
 */

import type { Order, OrderLineRenderData, TradingOverlayOptions } from './types';

export interface OrderRenderInput {
  ctx: CanvasRenderingContext2D;
  plotRect: { x: number; y: number; width: number; height: number };
  orders: OrderLineRenderData[];
  options: TradingOverlayOptions;
  dpr: number;
}

/**
 * Render order lines on the chart.
 */
export function renderOrderLines(input: OrderRenderInput): void {
  const { ctx, plotRect, orders, options, dpr } = input;

  ctx.save();

  const buyColor = options.buyColor ?? '#22c55e';
  const sellColor = options.sellColor ?? '#ef4444';
  const lineWidth = 2 * dpr;

  orders.forEach(({ order, y, isDragging }) => {
    const color = order.side === 'buy' ? buyColor : sellColor;
    const alpha = isDragging ? 0.8 : order.status === 'active' ? 1.0 : 0.5;

    // Draw horizontal line
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(order.type === 'limit' ? [] : [5 * dpr, 5 * dpr]);

    ctx.beginPath();
    ctx.moveTo(plotRect.x, y);
    ctx.lineTo(plotRect.x + plotRect.width, y);
    ctx.stroke();

    // Draw label
    const label = `${order.side.toUpperCase()} ${order.quantity} @ ${order.price?.toFixed(2) ?? 'MKT'}`;
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillStyle = color;
    ctx.globalAlpha = 1;
    
    const textMetrics = ctx.measureText(label);
    const textX = plotRect.x + plotRect.width - textMetrics.width - 8 * dpr;
    const textY = y - 4 * dpr;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(
      textX - 4 * dpr,
      textY - 14 * dpr,
      textMetrics.width + 8 * dpr,
      18 * dpr
    );

    // Text
    ctx.fillStyle = color;
    ctx.fillText(label, textX, textY);
  });

  ctx.restore();
}

/**
 * Check if a point is near an order line (for dragging).
 */
export function hitTestOrderLine(
  order: OrderLineRenderData,
  mouseX: number,
  mouseY: number,
  threshold: number = 5
): boolean {
  return Math.abs(mouseY - order.y) <= threshold;
}

