/**
 * @charts-plus/chart-trading
 * 
 * Trading overlay plugin for displaying orders, positions, and P&L on charts.
 */

export { TradingOverlay } from './trading-overlay';
export { renderOrderLines, hitTestOrderLine } from './order-renderer';
export { renderPositions } from './position-renderer';

export type {
  Order,
  Position,
  Trade,
  OrderSide,
  OrderType,
  OrderStatus,
  TradingOverlayOptions,
  OrderLineRenderData,
  PositionRenderData,
} from './types';

