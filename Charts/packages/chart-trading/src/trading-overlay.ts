/**
 * Trading overlay plugin for displaying orders, positions, and P&L.
 */

import type {
  Order,
  Position,
  Trade,
  TradingOverlayOptions,
  OrderLineRenderData,
  PositionRenderData,
} from './types';
import { renderOrderLines, hitTestOrderLine } from './order-renderer';
import { renderPositions } from './position-renderer';

// NEW-CH-006: Typed chart interface replacing `any`
interface ChartInstance {
  invalidate(): void;
  getVisibleTimeRange?(): { from: number; to: number };
  subscribeClick?(handler: (event: MouseEvent) => void): void;
  unsubscribeClick?(handler: (event: MouseEvent) => void): void;
}

export class TradingOverlay {
  private orders: Map<string, Order> = new Map();
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private options: TradingOverlayOptions;
  private chart: ChartInstance;
  private draggingOrder: string | null = null;

  constructor(chart: ChartInstance, options: TradingOverlayOptions = {}) {
    this.chart = chart;
    this.options = {
      showOrders: true,
      showPositions: true,
      showPnL: true,
      enableDragging: true,
      ...options,
    };

    this.setupEventListeners();
  }

  /**
   * Add an order to the overlay.
   */
  public addOrder(order: Order): void {
    this.orders.set(order.id, order);
    this.requestRedraw();
  }

  /**
   * Update an existing order.
   */
  public updateOrder(orderId: string, updates: Partial<Order>): void {
    const order = this.orders.get(orderId);
    if (order) {
      Object.assign(order, updates);
      this.requestRedraw();
    }
  }

  /**
   * Remove an order from the overlay.
   */
  public removeOrder(orderId: string): void {
    this.orders.delete(orderId);
    this.requestRedraw();
  }

  /**
   * Add a position to the overlay.
   */
  public addPosition(position: Position): void {
    this.positions.set(position.id, position);
    this.requestRedraw();
  }

  /**
   * Update an existing position.
   */
  public updatePosition(positionId: string, updates: Partial<Position>): void {
    const position = this.positions.get(positionId);
    if (position) {
      Object.assign(position, updates);
      this.requestRedraw();
    }
  }

  /**
   * Remove a position from the overlay.
   */
  public removePosition(positionId: string): void {
    this.positions.delete(positionId);
    this.requestRedraw();
  }

  /**
   * Add a completed trade to history.
   */
  public addTrade(trade: Trade): void {
    this.trades.push(trade);
  }

  /**
   * Get all trades.
   */
  public getTrades(): Trade[] {
    return [...this.trades];
  }

  /**
   * Clear all orders, positions, and trades.
   */
  public clear(): void {
    this.orders.clear();
    this.positions.clear();
    this.trades = [];
    this.requestRedraw();
  }

  /**
   * Render the trading overlay.
   */
  public render(
    ctx: CanvasRenderingContext2D,
    plotRect: { x: number; y: number; width: number; height: number },
    priceToY: (price: number) => number,
    dpr: number
  ): void {
    if (this.options.showOrders && this.orders.size > 0) {
      const orderLines: OrderLineRenderData[] = [];
      this.orders.forEach((order) => {
        if (order.price !== undefined) {
          orderLines.push({
            order,
            y: priceToY(order.price),
            isDragging: this.draggingOrder === order.id,
          });
        }
      });

      renderOrderLines({
        ctx,
        plotRect,
        orders: orderLines,
        options: this.options,
        dpr,
      });
    }

    if (this.options.showPositions && this.positions.size > 0) {
      const positionData: PositionRenderData[] = [];
      this.positions.forEach((position) => {
        positionData.push({
          position,
          entryY: priceToY(position.entryPrice),
          currentY: priceToY(position.currentPrice),
          stopLossY: position.stopLoss ? priceToY(position.stopLoss) : undefined,
          takeProfitY: position.takeProfit ? priceToY(position.takeProfit) : undefined,
        });
      });

      renderPositions({
        ctx,
        plotRect,
        positions: positionData,
        options: this.options,
        dpr,
      });
    }
  }

  /**
   * Set up event listeners for dragging order lines.
   */
  private setupEventListeners(): void {
    if (!this.options.enableDragging) return;

    // Mouse/touch event handlers would be attached to the chart here
    // This is a simplified version - actual implementation would integrate with chart's event system
  }

  /**
   * Request chart redraw.
   */
  private requestRedraw(): void {
    if (this.chart && this.chart.invalidate) {
      this.chart.invalidate();
    }
  }

  /**
   * Destroy the overlay and clean up.
   */
  public destroy(): void {
    this.orders.clear();
    this.positions.clear();
    this.trades = [];
  }
}

