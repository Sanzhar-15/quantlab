/**
 * Position renderer for trading overlay.
 */

import type { Position, PositionRenderData, TradingOverlayOptions } from './types';

export interface PositionRenderInput {
  ctx: CanvasRenderingContext2D;
  plotRect: { x: number; y: number; width: number; height: number };
  positions: PositionRenderData[];
  options: TradingOverlayOptions;
  dpr: number;
}

/**
 * Render position lines and P&L zones on the chart.
 */
export function renderPositions(input: PositionRenderInput): void {
  const { ctx, plotRect, positions, options, dpr } = input;

  ctx.save();

  const buyColor = options.buyColor ?? '#22c55e';
  const sellColor = options.sellColor ?? '#ef4444';
  const stopLossColor = options.stopLossColor ?? '#dc2626';
  const takeProfitColor = options.takeProfitColor ?? '#16a34a';

  positions.forEach(({ position, entryY, currentY, stopLossY, takeProfitY }) => {
    const color = position.side === 'buy' ? buyColor : sellColor;
    const isProfitable = position.unrealizedPnL >= 0;
    const pnlColor = isProfitable ? '#22c55e' : '#ef4444';

    // Draw P&L zone (shaded area between entry and current price)
    ctx.fillStyle = isProfitable
      ? 'rgba(34, 197, 94, 0.1)'
      : 'rgba(239, 68, 68, 0.1)';
    const zoneTop = Math.min(entryY, currentY);
    const zoneHeight = Math.abs(currentY - entryY);
    ctx.fillRect(plotRect.x, zoneTop, plotRect.width, zoneHeight);

    // Draw entry line
    ctx.strokeStyle = color;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(plotRect.x, entryY);
    ctx.lineTo(plotRect.x + plotRect.width, entryY);
    ctx.stroke();

    // Draw stop loss line
    if (stopLossY !== undefined) {
      ctx.strokeStyle = stopLossColor;
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([5 * dpr, 5 * dpr]);

      ctx.beginPath();
      ctx.moveTo(plotRect.x, stopLossY);
      ctx.lineTo(plotRect.x + plotRect.width, stopLossY);
      ctx.stroke();
    }

    // Draw take profit line
    if (takeProfitY !== undefined) {
      ctx.strokeStyle = takeProfitColor;
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([5 * dpr, 5 * dpr]);

      ctx.beginPath();
      ctx.moveTo(plotRect.x, takeProfitY);
      ctx.lineTo(plotRect.x + plotRect.width, takeProfitY);
      ctx.stroke();
    }

    // Draw P&L label
    if (options.showPnL) {
      const pnlText = `${position.unrealizedPnL >= 0 ? '+' : ''}${position.unrealizedPnL.toFixed(2)} (${position.unrealizedPnLPercent.toFixed(2)}%)`;
      ctx.font = `bold ${14 * dpr}px sans-serif`;
      ctx.fillStyle = pnlColor;
      ctx.globalAlpha = 1;

      const textMetrics = ctx.measureText(pnlText);
      const textX = plotRect.x + 8 * dpr;
      const textY = currentY - 4 * dpr;

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(
        textX - 4 * dpr,
        textY - 16 * dpr,
        textMetrics.width + 8 * dpr,
        20 * dpr
      );

      // Text
      ctx.fillStyle = pnlColor;
      ctx.fillText(pnlText, textX, textY);
    }

    // Draw position info label
    const posLabel = `${position.side.toUpperCase()} ${position.quantity} @ ${position.entryPrice.toFixed(2)}`;
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillStyle = color;

    const labelMetrics = ctx.measureText(posLabel);
    const labelX = plotRect.x + plotRect.width - labelMetrics.width - 8 * dpr;
    const labelY = entryY - 4 * dpr;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(
      labelX - 4 * dpr,
      labelY - 14 * dpr,
      labelMetrics.width + 8 * dpr,
      18 * dpr
    );

    // Text
    ctx.fillStyle = color;
    ctx.fillText(posLabel, labelX, labelY);
  });

  ctx.restore();
}

