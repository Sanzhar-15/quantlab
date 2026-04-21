# V6 Implementation Guide: Phase 3 - Trading Overlay

## Overview

The Trading Overlay displays orders and positions directly on the chart - essential for a trading platform.

**New Package:** `packages/chart-trading/`

---

## Package Structure

```
packages/chart-trading/
├── src/
│   ├── index.ts              # Package exports
│   ├── types.ts              # Type definitions
│   ├── trading-overlay.ts    # Main plugin
│   ├── order-renderer.ts     # Order line rendering
│   ├── position-renderer.ts  # Position rendering
│   ├── interaction.ts        # Drag, hover, click handling
│   └── utils.ts              # Helper functions
├── package.json
└── tsconfig.json
```

---

## Task 1: Package Setup

### File: `packages/chart-trading/package.json`

```json
{
  "name": "@charts-plus/chart-trading",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "dev": "tsup src/index.ts --format esm --dts --watch"
  },
  "dependencies": {
    "@charts-plus/chart-core": "workspace:*"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.3.0"
  }
}
```

---

## Task 2: Type Definitions

### File: `packages/chart-trading/src/types.ts`

```typescript
// Order types
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market' | 'stop' | 'stop-limit' | 'trailing-stop';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected';

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: number;
  stopPrice?: number;         // For stop orders
  quantity: number;
  filledQuantity?: number;
  status: OrderStatus;
  createdAt: number;          // Timestamp
  filledAt?: number;          // Timestamp
  expiresAt?: number;         // Timestamp (for GTD orders)
  clientOrderId?: string;
}

// Position types
export type PositionSide = 'long' | 'short';

export interface Position {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  realizedPnL?: number;
  stopLoss?: number;
  takeProfit?: number;
  margin?: number;
  leverage?: number;
}

// Trade/Fill types
export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: number;
  quantity: number;
  timestamp: number;
  fee?: number;
}

// Rendering options
export interface TradingOverlayOptions {
  // Data
  orders?: Order[];
  positions?: Position[];
  trades?: Trade[];
  
  // Display options
  showOrders?: boolean;            // Default: true
  showPositions?: boolean;         // Default: true
  showTrades?: boolean;            // Default: false
  showPnL?: boolean;               // Default: true
  showLabels?: boolean;            // Default: true
  
  // Interaction
  draggableOrders?: boolean;       // Default: true
  clickableOrders?: boolean;       // Default: true
  
  // Callbacks
  onOrderDrag?: (orderId: string, newPrice: number) => void;
  onOrderClick?: (orderId: string) => void;
  onOrderCancel?: (orderId: string) => void;
  onPositionClick?: (positionId: string) => void;
  
  // Styling
  buyColor?: string;               // Default: '#26A69A'
  sellColor?: string;              // Default: '#EF5350'
  profitColor?: string;            // Default: '#26A69A'
  lossColor?: string;              // Default: '#EF5350'
}

// Internal state
export interface TradingOverlayState {
  hoveredOrderId: string | null;
  hoveredPositionId: string | null;
  draggingOrderId: string | null;
  dragStartY: number;
  dragStartPrice: number;
}
```

---

## Task 3: Order Renderer

### File: `packages/chart-trading/src/order-renderer.ts`

```typescript
import type { Order, TradingOverlayOptions } from './types';

export interface OrderRenderContext {
  ctx: CanvasRenderingContext2D;
  plotRect: { x: number; y: number; width: number; height: number };
  priceScale: { priceToY: (price: number) => number };
  options: TradingOverlayOptions;
  hoveredOrderId: string | null;
  draggingOrderId: string | null;
}

export function renderOrders(
  orders: Order[],
  context: OrderRenderContext
): void {
  const { ctx, plotRect, priceScale, options, hoveredOrderId } = context;
  
  const buyColor = options.buyColor ?? '#26A69A';
  const sellColor = options.sellColor ?? '#EF5350';
  
  for (const order of orders) {
    if (order.status !== 'open') continue;
    
    const y = priceScale.priceToY(order.price);
    
    // Skip if outside visible range
    if (y < plotRect.y || y > plotRect.y + plotRect.height) continue;
    
    const isHovered = order.id === hoveredOrderId;
    const isBuy = order.side === 'buy';
    const color = isBuy ? buyColor : sellColor;
    
    renderOrderLine(ctx, {
      y,
      plotRect,
      color,
      isHovered,
      order,
      showLabel: options.showLabels ?? true,
    });
  }
}

interface OrderLineParams {
  y: number;
  plotRect: { x: number; y: number; width: number; height: number };
  color: string;
  isHovered: boolean;
  order: Order;
  showLabel: boolean;
}

function renderOrderLine(
  ctx: CanvasRenderingContext2D,
  params: OrderLineParams
): void {
  const { y, plotRect, color, isHovered, order, showLabel } = params;
  
  ctx.save();
  
  // Order line (dashed)
  ctx.strokeStyle = color;
  ctx.lineWidth = isHovered ? 2 : 1;
  ctx.setLineDash([8, 4]);
  
  ctx.beginPath();
  ctx.moveTo(plotRect.x, Math.round(y) + 0.5);
  ctx.lineTo(plotRect.x + plotRect.width, Math.round(y) + 0.5);
  ctx.stroke();
  
  // Order marker (diamond)
  const markerX = plotRect.x + 16;
  ctx.fillStyle = color;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(markerX, y - 6);
  ctx.lineTo(markerX + 6, y);
  ctx.lineTo(markerX, y + 6);
  ctx.lineTo(markerX - 6, y);
  ctx.closePath();
  ctx.fill();
  
  // Label
  if (showLabel) {
    const labelText = formatOrderLabel(order);
    
    ctx.font = '11px Inter, system-ui, sans-serif';
    const textWidth = ctx.measureText(labelText).width;
    
    // Label background
    const labelX = markerX + 12;
    const labelY = y;
    const padding = 4;
    
    ctx.fillStyle = isHovered 
      ? 'rgba(255, 255, 255, 0.95)' 
      : 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.roundRect(
      labelX - padding,
      labelY - 10,
      textWidth + padding * 2,
      20,
      3
    );
    ctx.fill();
    
    // Label text
    ctx.fillStyle = '#1a1a1a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, labelX, labelY);
  }
  
  // Cancel button (on hover)
  if (isHovered) {
    const cancelX = plotRect.x + plotRect.width - 24;
    
    // Circle background
    ctx.fillStyle = 'rgba(239, 83, 80, 0.9)';
    ctx.beginPath();
    ctx.arc(cancelX, y, 10, 0, Math.PI * 2);
    ctx.fill();
    
    // X icon
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cancelX - 4, y - 4);
    ctx.lineTo(cancelX + 4, y + 4);
    ctx.moveTo(cancelX + 4, y - 4);
    ctx.lineTo(cancelX - 4, y + 4);
    ctx.stroke();
  }
  
  ctx.restore();
}

function formatOrderLabel(order: Order): string {
  const side = order.side.toUpperCase();
  const qty = formatQuantity(order.quantity);
  const price = formatPrice(order.price);
  const type = order.type !== 'limit' ? ` ${order.type.toUpperCase()}` : '';
  
  return `${side} ${qty} @ ${price}${type}`;
}

function formatQuantity(qty: number): string {
  if (qty >= 1) return qty.toFixed(2);
  if (qty >= 0.01) return qty.toFixed(4);
  return qty.toFixed(8);
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(6);
}
```

---

## Task 4: Position Renderer

### File: `packages/chart-trading/src/position-renderer.ts`

```typescript
import type { Position, TradingOverlayOptions } from './types';

export interface PositionRenderContext {
  ctx: CanvasRenderingContext2D;
  plotRect: { x: number; y: number; width: number; height: number };
  priceScale: { priceToY: (price: number) => number };
  options: TradingOverlayOptions;
  hoveredPositionId: string | null;
}

export function renderPositions(
  positions: Position[],
  context: PositionRenderContext
): void {
  const { ctx, plotRect, priceScale, options, hoveredPositionId } = context;
  
  for (const position of positions) {
    renderPosition(ctx, {
      position,
      plotRect,
      priceScale,
      options,
      isHovered: position.id === hoveredPositionId,
    });
  }
}

interface PositionRenderParams {
  position: Position;
  plotRect: { x: number; y: number; width: number; height: number };
  priceScale: { priceToY: (price: number) => number };
  options: TradingOverlayOptions;
  isHovered: boolean;
}

function renderPosition(
  ctx: CanvasRenderingContext2D,
  params: PositionRenderParams
): void {
  const { position, plotRect, priceScale, options, isHovered } = params;
  
  const entryY = priceScale.priceToY(position.entryPrice);
  const currentY = priceScale.priceToY(position.currentPrice);
  
  const isProfit = position.unrealizedPnL >= 0;
  const profitColor = options.profitColor ?? '#26A69A';
  const lossColor = options.lossColor ?? '#EF5350';
  const positionColor = isProfit ? profitColor : lossColor;
  
  ctx.save();
  
  // Entry line
  ctx.strokeStyle = positionColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  
  ctx.beginPath();
  ctx.moveTo(plotRect.x, Math.round(entryY) + 0.5);
  ctx.lineTo(plotRect.x + plotRect.width, Math.round(entryY) + 0.5);
  ctx.stroke();
  
  // P&L zone fill (between entry and current)
  if (options.showPnL !== false) {
    const topY = Math.min(entryY, currentY);
    const bottomY = Math.max(entryY, currentY);
    
    ctx.fillStyle = isProfit 
      ? 'rgba(38, 166, 154, 0.1)' 
      : 'rgba(239, 83, 80, 0.1)';
    ctx.fillRect(plotRect.x, topY, plotRect.width, bottomY - topY);
  }
  
  // P&L label
  if (options.showPnL !== false) {
    const pnlText = formatPnL(position);
    const labelWidth = 80;
    const labelHeight = 24;
    const labelX = plotRect.x + plotRect.width - labelWidth - 60;
    const labelY = entryY - labelHeight / 2;
    
    // Label background
    ctx.fillStyle = isProfit 
      ? 'rgba(38, 166, 154, 0.95)' 
      : 'rgba(239, 83, 80, 0.95)';
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelWidth, labelHeight, 4);
    ctx.fill();
    
    // Label text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pnlText, labelX + labelWidth / 2, entryY);
    
    // Quantity label
    const qtyText = `${position.side === 'long' ? '↑' : '↓'} ${formatQuantity(position.quantity)}`;
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.textAlign = 'left';
    ctx.fillText(qtyText, plotRect.x + 16, entryY);
  }
  
  // Stop Loss line
  if (position.stopLoss) {
    const slY = priceScale.priceToY(position.stopLoss);
    
    ctx.strokeStyle = lossColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    
    ctx.beginPath();
    ctx.moveTo(plotRect.x, Math.round(slY) + 0.5);
    ctx.lineTo(plotRect.x + plotRect.width, Math.round(slY) + 0.5);
    ctx.stroke();
    
    // SL label
    renderLevelLabel(ctx, {
      x: plotRect.x + plotRect.width - 40,
      y: slY,
      text: 'SL',
      color: lossColor,
    });
  }
  
  // Take Profit line
  if (position.takeProfit) {
    const tpY = priceScale.priceToY(position.takeProfit);
    
    ctx.strokeStyle = profitColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    
    ctx.beginPath();
    ctx.moveTo(plotRect.x, Math.round(tpY) + 0.5);
    ctx.lineTo(plotRect.x + plotRect.width, Math.round(tpY) + 0.5);
    ctx.stroke();
    
    // TP label
    renderLevelLabel(ctx, {
      x: plotRect.x + plotRect.width - 40,
      y: tpY,
      text: 'TP',
      color: profitColor,
    });
  }
  
  ctx.restore();
}

function renderLevelLabel(
  ctx: CanvasRenderingContext2D,
  params: { x: number; y: number; text: string; color: string }
): void {
  const { x, y, text, color } = params;
  
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y - 10, 32, 20, 3);
  ctx.fill();
  
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 16, y);
}

function formatPnL(position: Position): string {
  const sign = position.unrealizedPnL >= 0 ? '+' : '';
  const percent = position.unrealizedPnLPercent.toFixed(2);
  return `${sign}${percent}%`;
}

function formatQuantity(qty: number): string {
  if (qty >= 1) return qty.toFixed(2);
  if (qty >= 0.01) return qty.toFixed(4);
  return qty.toFixed(8);
}
```

---

## Task 5: Trading Overlay Plugin

### File: `packages/chart-trading/src/trading-overlay.ts`

```typescript
import type { ChartPlugin, PluginRenderState, PluginPointerEvent } from '@charts-plus/chart-core';
import type { Order, Position, TradingOverlayOptions, TradingOverlayState } from './types';
import { renderOrders, OrderRenderContext } from './order-renderer';
import { renderPositions, PositionRenderContext } from './position-renderer';

export function createTradingOverlayPlugin(
  options: TradingOverlayOptions = {}
): ChartPlugin<CanvasRenderingContext2D> {
  
  // Mutable state
  const state: TradingOverlayState = {
    hoveredOrderId: null,
    hoveredPositionId: null,
    draggingOrderId: null,
    dragStartY: 0,
    dragStartPrice: 0,
  };
  
  // Data (can be updated)
  let orders: Order[] = options.orders ?? [];
  let positions: Position[] = options.positions ?? [];
  
  return {
    // Render overlay (after series, before crosshair)
    onRenderOverlay(ctx: CanvasRenderingContext2D, renderState: PluginRenderState) {
      const { plotRect, priceScale, theme } = renderState;
      
      // Skip if nothing to render
      if (orders.length === 0 && positions.length === 0) return;
      
      // Render positions first (behind orders)
      if (options.showPositions !== false && positions.length > 0) {
        renderPositions(positions, {
          ctx,
          plotRect,
          priceScale,
          options,
          hoveredPositionId: state.hoveredPositionId,
        });
      }
      
      // Render orders on top
      if (options.showOrders !== false && orders.length > 0) {
        renderOrders(orders, {
          ctx,
          plotRect,
          priceScale,
          options,
          hoveredOrderId: state.hoveredOrderId,
          draggingOrderId: state.draggingOrderId,
        });
      }
    },
    
    // Handle pointer events
    onPointer(event: PluginPointerEvent, renderState: PluginRenderState) {
      const { plotRect, priceScale } = renderState;
      const { x, y, type } = event;
      
      // Check if in plot area
      if (x < plotRect.x || x > plotRect.x + plotRect.width ||
          y < plotRect.y || y > plotRect.y + plotRect.height) {
        state.hoveredOrderId = null;
        state.hoveredPositionId = null;
        return;
      }
      
      switch (type) {
        case 'move':
          handlePointerMove(event, renderState, state, orders, positions, options);
          break;
          
        case 'down':
          handlePointerDown(event, renderState, state, orders, options);
          break;
          
        case 'up':
          handlePointerUp(event, renderState, state, orders, options);
          break;
      }
    },
    
    // API to update data
    updateOrders(newOrders: Order[]) {
      orders = newOrders;
    },
    
    updatePositions(newPositions: Position[]) {
      positions = newPositions;
    },
    
    // Get current state
    getState() {
      return { orders, positions, ...state };
    },
  };
}

function handlePointerMove(
  event: PluginPointerEvent,
  renderState: PluginRenderState,
  state: TradingOverlayState,
  orders: Order[],
  positions: Position[],
  options: TradingOverlayOptions
): void {
  const { y } = event;
  const { priceScale, plotRect } = renderState;
  
  // If dragging, update order price
  if (state.draggingOrderId && options.draggableOrders !== false) {
    const deltaY = y - state.dragStartY;
    const newPrice = priceScale.yToPrice(priceScale.priceToY(state.dragStartPrice) + deltaY);
    
    // Call callback
    options.onOrderDrag?.(state.draggingOrderId, newPrice);
    return;
  }
  
  // Check hover on orders
  state.hoveredOrderId = null;
  for (const order of orders) {
    if (order.status !== 'open') continue;
    
    const orderY = priceScale.priceToY(order.price);
    if (Math.abs(y - orderY) < 8) {
      state.hoveredOrderId = order.id;
      break;
    }
  }
  
  // Check hover on positions (if not hovering order)
  if (!state.hoveredOrderId) {
    state.hoveredPositionId = null;
    for (const position of positions) {
      const entryY = priceScale.priceToY(position.entryPrice);
      if (Math.abs(y - entryY) < 8) {
        state.hoveredPositionId = position.id;
        break;
      }
    }
  }
}

function handlePointerDown(
  event: PluginPointerEvent,
  renderState: PluginRenderState,
  state: TradingOverlayState,
  orders: Order[],
  options: TradingOverlayOptions
): void {
  const { x, y } = event;
  const { priceScale, plotRect } = renderState;
  
  if (state.hoveredOrderId && options.draggableOrders !== false) {
    // Check if clicking cancel button
    const cancelX = plotRect.x + plotRect.width - 24;
    const order = orders.find(o => o.id === state.hoveredOrderId);
    
    if (order) {
      const orderY = priceScale.priceToY(order.price);
      
      if (Math.abs(x - cancelX) < 12 && Math.abs(y - orderY) < 12) {
        // Cancel button clicked
        options.onOrderCancel?.(state.hoveredOrderId);
        return;
      }
      
      // Start dragging
      state.draggingOrderId = state.hoveredOrderId;
      state.dragStartY = y;
      state.dragStartPrice = order.price;
    }
  } else if (state.hoveredOrderId && options.clickableOrders !== false) {
    options.onOrderClick?.(state.hoveredOrderId);
  } else if (state.hoveredPositionId) {
    options.onPositionClick?.(state.hoveredPositionId);
  }
}

function handlePointerUp(
  event: PluginPointerEvent,
  renderState: PluginRenderState,
  state: TradingOverlayState,
  orders: Order[],
  options: TradingOverlayOptions
): void {
  if (state.draggingOrderId) {
    // Drag ended
    state.draggingOrderId = null;
  }
}
```

---

## Task 6: Package Index

### File: `packages/chart-trading/src/index.ts`

```typescript
export * from './types';
export { createTradingOverlayPlugin } from './trading-overlay';
export { renderOrders, OrderRenderContext } from './order-renderer';
export { renderPositions, PositionRenderContext } from './position-renderer';
```

---

## Task 7: Usage Example

### File: `apps/demo/src/trading-demo.ts`

```typescript
import { createChart } from '@charts-plus/chart-render-canvas2d';
import { createTradingOverlayPlugin, Order, Position } from '@charts-plus/chart-trading';

const chart = createChart('container', {
  // chart options
});

// Sample orders
const orders: Order[] = [
  {
    id: 'order-1',
    symbol: 'BTCUSD',
    side: 'buy',
    type: 'limit',
    price: 42000,
    quantity: 0.5,
    status: 'open',
    createdAt: Date.now(),
  },
  {
    id: 'order-2',
    symbol: 'BTCUSD',
    side: 'sell',
    type: 'stop',
    price: 45000,
    quantity: 0.5,
    status: 'open',
    createdAt: Date.now(),
  },
];

// Sample position
const positions: Position[] = [
  {
    id: 'pos-1',
    symbol: 'BTCUSD',
    side: 'long',
    entryPrice: 41500,
    quantity: 1.0,
    currentPrice: 43000,
    unrealizedPnL: 1500,
    unrealizedPnLPercent: 3.6,
    stopLoss: 40000,
    takeProfit: 46000,
  },
];

// Create plugin
const tradingPlugin = createTradingOverlayPlugin({
  orders,
  positions,
  showPnL: true,
  showLabels: true,
  draggableOrders: true,
  
  onOrderDrag: (orderId, newPrice) => {
    console.log(`Order ${orderId} dragged to ${newPrice}`);
    // TODO: Update order via API
    const order = orders.find(o => o.id === orderId);
    if (order) {
      order.price = newPrice;
      tradingPlugin.updateOrders([...orders]);
    }
  },
  
  onOrderCancel: (orderId) => {
    console.log(`Cancel order ${orderId}`);
    // TODO: Cancel order via API
    const index = orders.findIndex(o => o.id === orderId);
    if (index !== -1) {
      orders.splice(index, 1);
      tradingPlugin.updateOrders([...orders]);
    }
  },
  
  onOrderClick: (orderId) => {
    console.log(`Order clicked: ${orderId}`);
  },
  
  onPositionClick: (positionId) => {
    console.log(`Position clicked: ${positionId}`);
  },
});

// Add plugin to chart
chart.addPlugin(tradingPlugin);

// Update data in real-time
function updatePositionPnL(newPrice: number) {
  positions[0].currentPrice = newPrice;
  positions[0].unrealizedPnL = (newPrice - positions[0].entryPrice) * positions[0].quantity;
  positions[0].unrealizedPnLPercent = (positions[0].unrealizedPnL / (positions[0].entryPrice * positions[0].quantity)) * 100;
  tradingPlugin.updatePositions([...positions]);
}
```

---

## Verification Checklist

- [ ] Orders render with correct colors (buy=green, sell=red)
- [ ] Order lines are dashed
- [ ] Order markers (diamonds) display correctly
- [ ] Order labels show side, quantity, price
- [ ] Cancel button appears on hover
- [ ] Orders can be dragged to new price
- [ ] Positions render with entry line
- [ ] P&L zone fills between entry and current
- [ ] P&L label shows correct percentage
- [ ] Stop loss and take profit lines render
- [ ] SL/TP labels render correctly
- [ ] Callbacks fire on drag, click, cancel
- [ ] Real-time updates work

---

## Next Steps

After completing Phase 3:
1. Test with real trading scenarios
2. Add keyboard shortcuts (ESC to cancel drag)
3. Proceed to Phase 4: Volume Profile
