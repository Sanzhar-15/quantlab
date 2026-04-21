/**
 * Trading overlay types and interfaces.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop-limit';
export type OrderStatus = 'pending' | 'active' | 'filled' | 'cancelled' | 'rejected';

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: OrderStatus;
  timestamp: number;
  fillPrice?: number;
  fillTimestamp?: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  entryTimestamp: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  realizedPnL: number;
  realizedPnLPercent: number;
  commission?: number;
}

export interface TradingOverlayOptions {
  showOrders?: boolean;
  showPositions?: boolean;
  showPnL?: boolean;
  enableDragging?: boolean;
  orderLineColor?: string;
  positionLineColor?: string;
  stopLossColor?: string;
  takeProfitColor?: string;
  buyColor?: string;
  sellColor?: string;
}

export interface OrderLineRenderData {
  order: Order;
  y: number;
  isDragging: boolean;
}

export interface PositionRenderData {
  position: Position;
  entryY: number;
  currentY: number;
  stopLossY?: number;
  takeProfitY?: number;
}

