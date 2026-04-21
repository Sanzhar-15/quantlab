# Phase 5: Trade View MVP — Detailed Implementation Plan

**Duration**: 4-7 weeks
**Goal**: Implement paper and live trading management with Kill Switch, safety gating, and real-time monitoring
**Prerequisites**: Phase 0, Phase 1, Phase 2, Phase 3, Phase 4 completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Trade View Architecture](#2-trade-view-architecture)
3. [Trade Panel Implementation](#3-trade-panel-implementation)
4. [Trade View - No Session State](#4-trade-view---no-session-state)
5. [Trade View - Active Session State](#5-trade-view---active-session-state)
6. [Kill Switch System](#6-kill-switch-system)
7. [Safety Gating](#7-safety-gating)
8. [Session Management](#8-session-management)
9. [Broker Integration](#9-broker-integration)
10. [Real-Time Data Flow](#10-real-time-data-flow)
11. [Trade → Chart Integration](#11-trade--chart-integration)
12. [Risk Management](#12-risk-management)
13. [Verification Plan](#13-verification-plan)
14. [Exit Gates](#14-exit-gates)

---

## 1. Overview

### 1.1 What We're Building

Phase 5 implements the Trade View — the live trading management interface:

| Component | Purpose | V8.1 Reference |
|-----------|---------|----------------|
| **Trade Panel** | Session control in Activity Bar | §4.3.4 |
| **No Session State** | Requirements checklist | §3.1.4 State 1 |
| **Active Session State** | Live monitoring UI | §3.1.4 State 2 |
| **Kill Switch** | Emergency policy execution | §3.1.4 |
| **Safety Gating** | Complexity-based trading restrictions | §3.6.4 |
| **Session Manager** | Paper/Live session lifecycle | §4.3.4 |
| **Broker Adapters** | Alpaca (and future brokers) | §4.3.4 |

### 1.2 Key V8.1 Invariants (Must Hold)

- Tab indicator: 🔴 Red stripe (`#DC2626`) for Trade view
- Kill Switch button reflects **configured policy** (Flatten / Cancel Only / Custom)
- Paper trading: Kill Switch executes **immediately**
- Live trading: Kill Switch shows **confirmation dialog**
- Complexity gating: View-Only strategies **blocked** from live trading
- Trade panel auto-expands when entering Trade view
- Real-time position/order updates
- Heartbeat indicator for session health

### 1.3 File Structure to Create

```
quantlab-extension/src/
├── views/
│   └── trade/
│       ├── TradeViewProvider.ts        # CustomTextEditorProvider
│       ├── TradeWebview.ts             # Webview management
│       ├── KillSwitch.ts               # Kill switch logic
│       └── webview/
│           ├── index.html              # Webview HTML shell
│           ├── trade.ts                # Webview entry point
│           ├── trade.css               # Webview styles
│           ├── noSession.ts            # No-session state UI
│           └── activeSession.ts        # Active session UI
├── panels/
│   └── trade/
│       ├── TradePanelProvider.ts       # Activity Bar panel
│       ├── TradeTreeProvider.ts        # Panel tree structure
│       └── SessionManager.ts           # Session lifecycle
├── core/
│   └── broker/
│       ├── BrokerAdapter.ts            # Abstract broker interface
│       ├── AlpacaAdapter.ts            # Alpaca implementation
│       └── MockBrokerAdapter.ts        # For testing
├── types/
│   └── trading.ts                      # Trading types
└── utils/
    └── secureStorage.ts                # Credential storage
```

---

## 2. Trade View Architecture

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      VS Code Extension Host                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ TradeViewProvider + TradePanelProvider                             │  │
│  │  • Session lifecycle management                                    │  │
│  │  • UI state coordination                                           │  │
│  │  • Kill Switch orchestration                                       │  │
│  └───────────────────┬─────────────────────────────────────────────┬─┘  │
│                      │ postMessage                                  │    │
│                      ▼                                              │    │
│  ┌─────────────────────────────────┐  ┌──────────────────────────┐ │    │
│  │ Trade View Webview              │  │ Trade Panel (Activity Bar)│ │    │
│  │  • No Session / Active states   │  │  • Session control        │ │    │
│  │  • Positions, Orders, Log       │  │  • Active sessions list   │ │    │
│  │  • Performance metrics          │  │  • Risk status            │ │    │
│  └─────────────────────────────────┘  └──────────────────────────┘ │    │
│                      │                               │               │    │
│                      └───────────────┬───────────────┘               │    │
│                                      ▼                               │    │
│  ┌─────────────────────────────────────────────────────────────────┐│    │
│  │ SessionManager                                                   ││    │
│  │  • Manages multiple concurrent sessions                          ││    │
│  │  • Heartbeat monitoring                                          ││    │
│  │  • Session state persistence                                     ││    │
│  └───────────────────┬─────────────────────────────────────────────┘│    │
│                      │                                               │    │
│                      ▼                                               │    │
│  ┌─────────────────────────────────────────────────────────────────┐│    │
│  │ BrokerAdapter (Abstract)                                         ││    │
│  │  • connect() / disconnect()                                      ││    │
│  │  • getPositions() / getOrders()                                  ││    │
│  │  • placeOrder() / cancelOrder() / modifyOrder()                  ││    │
│  │  • subscribeToUpdates() / unsubscribe()                          ││    │
│  └───────────────────┬─────────────────────────────────────────────┘│    │
│                      │                                               │    │
│  ┌───────────────────┴─────────────────────────────────────────┐    │    │
│  │ AlpacaAdapter            │   MockBrokerAdapter (testing)     │    │    │
│  │  • REST + WebSocket      │   • Simulated fills               │    │    │
│  │  • Real market data      │   • Configurable latency          │    │    │
│  └──────────────────────────┴───────────────────────────────────┘    │    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Message Protocol

**Extension → Webview:**

```typescript
// Initialize with session info (or null)
{ type: 'init', session: SessionInfo | null, requirements: RequirementsCheck }

// Session started
{ type: 'sessionStarted', session: SessionInfo }

// Session stopped
{ type: 'sessionStopped', reason: string }

// Positions update
{ type: 'positionsUpdate', positions: Position[] }

// Orders update
{ type: 'ordersUpdate', orders: Order[] }

// Fill occurred
{ type: 'fill', fill: Fill }

// Performance update
{ type: 'performanceUpdate', performance: PerformanceMetrics }

// Heartbeat status
{ type: 'heartbeat', status: 'ok' | 'stale' | 'lost', lastSeen: number }

// Risk alert
{ type: 'riskAlert', alert: RiskAlert }

// Activity log entry
{ type: 'activity', entry: ActivityEntry }
```

**Webview → Extension:**

```typescript
// Open Trade panel
{ type: 'openTradePanel' }

// Pause session
{ type: 'pauseSession', sessionId: string }

// Resume session
{ type: 'resumeSession', sessionId: string }

// Stop session
{ type: 'stopSession', sessionId: string }

// Execute Kill Switch
{ type: 'killSwitch', sessionId: string, confirmed?: boolean }

// View in Chart
{ type: 'viewInChart', sessionId: string }

// Modify order
{ type: 'modifyOrder', orderId: string, changes: OrderModification }

// Cancel order
{ type: 'cancelOrder', orderId: string }

// Close position
{ type: 'closePosition', symbol: string }

// Open session settings
{ type: 'openSessionSettings', sessionId: string }
```

---

## 3. Trade Panel Implementation

### 3.1 Create `src/types/trading.ts`

```typescript
export type SessionType = 'paper' | 'live';
export type SessionStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus = 'pending' | 'open' | 'partial' | 'filled' | 'cancelled' | 'rejected';

export interface SessionInfo {
  id: string;
  type: SessionType;
  status: SessionStatus;
  strategyPath: string;
  strategyHash: string;
  accountId: string;
  accountName: string;
  startedAt: Date;
  lastHeartbeat: Date;
  symbol: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  marketValue: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  price?: number;        // For limit orders
  stopPrice?: number;    // For stop orders
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
  rejectionReason?: string;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestamp: Date;
  commission: number;
}

export interface PerformanceMetrics {
  sessionPnL: number;
  todayPnL: number;
  openPnL: number;
  realizedPnL: number;
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
}

export interface RiskAlert {
  id: string;
  level: 'warning' | 'critical';
  type: 'dailyLoss' | 'positionSize' | 'drawdown' | 'custom';
  message: string;
  value: number;
  limit: number;
  timestamp: Date;
}

export interface ActivityEntry {
  id: string;
  timestamp: Date;
  type: 'order' | 'fill' | 'signal' | 'alert' | 'system';
  message: string;
  details?: any;
}

export interface RequirementsCheck {
  validStrategy: boolean;
  complexitySafe: boolean;     // Safe or Partial (not View-Only)
  brokerConfigured: boolean;
  hasBacktest: boolean;
  hasPaperTrading: boolean;    // Recommended, not required
  riskReviewed: boolean;       // Recommended, not required
}

export type KillSwitchPolicy = 'flatten' | 'cancelOnly' | 'custom';

export interface KillSwitchConfig {
  policy: KillSwitchPolicy;
  customActions?: KillSwitchAction[];
}

export interface KillSwitchAction {
  type: 'cancelOrders' | 'flattenPositions' | 'pauseStrategy' | 'custom';
  params?: Record<string, any>;
}

export interface BrokerAccount {
  id: string;
  name: string;
  type: 'paper' | 'live';
  broker: string;
  connected: boolean;
  lastConnected?: Date;
  balance?: number;
  buyingPower?: number;
}
```

### 3.2 Create `src/panels/trade/TradePanelProvider.ts`

```typescript
import * as vscode from 'vscode';
import { SessionManager } from './SessionManager';
import { BrokerAccount, SessionInfo } from '../../types/trading';

export class TradePanelProvider implements vscode.TreeDataProvider<TradePanelItem> {
  private static instance: TradePanelProvider;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TradePanelItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessionManager: SessionManager;
  private accounts: BrokerAccount[] = [];

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new TradePanelProvider(context);
    this.instance = provider;

    const treeView = vscode.window.createTreeView('quantlab.tradePanel', {
      treeDataProvider: provider,
      showCollapseAll: true,
    });

    return [
      treeView,
      vscode.commands.registerCommand('quantlab.startPaperSession', () => provider.startSession('paper')),
      vscode.commands.registerCommand('quantlab.startLiveSession', () => provider.startSession('live')),
      vscode.commands.registerCommand('quantlab.stopSession', (item) => provider.stopSession(item)),
      vscode.commands.registerCommand('quantlab.pauseSession', (item) => provider.pauseSession(item)),
      vscode.commands.registerCommand('quantlab.viewSession', (item) => provider.viewSession(item)),
    ];
  }

  static getInstance(): TradePanelProvider {
    return this.instance;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.sessionManager = SessionManager.getInstance();

    // Listen for session changes
    this.sessionManager.onSessionsChanged(() => this.refresh());

    // Load accounts from settings
    this.loadAccounts();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TradePanelItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TradePanelItem): Promise<TradePanelItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    return this.getChildItems(element);
  }

  private getRootItems(): TradePanelItem[] {
    return [
      new TradePanelItem('Session Control', vscode.TreeItemCollapsibleState.Expanded, 'sessionControl'),
      new TradePanelItem('Active Sessions', vscode.TreeItemCollapsibleState.Expanded, 'activeSessions'),
      new TradePanelItem('Positions (All)', vscode.TreeItemCollapsibleState.Expanded, 'positions'),
      new TradePanelItem('Open Orders', vscode.TreeItemCollapsibleState.Expanded, 'orders'),
      new TradePanelItem('Risk Status', vscode.TreeItemCollapsibleState.Expanded, 'riskStatus'),
      new TradePanelItem('Connections', vscode.TreeItemCollapsibleState.Expanded, 'connections'),
    ];
  }

  private async getChildItems(element: TradePanelItem): Promise<TradePanelItem[]> {
    switch (element.contextValue) {
      case 'sessionControl':
        return this.getSessionControlItems();
      case 'activeSessions':
        return this.getActiveSessionItems();
      case 'positions':
        return this.getPositionItems();
      case 'orders':
        return this.getOrderItems();
      case 'riskStatus':
        return this.getRiskStatusItems();
      case 'connections':
        return this.getConnectionItems();
      default:
        return [];
    }
  }

  private getSessionControlItems(): TradePanelItem[] {
    const editor = vscode.window.activeTextEditor;
    const strategyName = editor ? this.getFileName(editor.document.uri) : 'No strategy selected';

    return [
      new TradePanelItem(`Strategy: ${strategyName}`, vscode.TreeItemCollapsibleState.None, 'strategySelect'),
      new TradePanelItem(`Account: ${this.getSelectedAccount()?.name || 'None'}`, vscode.TreeItemCollapsibleState.None, 'accountSelect'),
      new TradePanelItem('▶ Start Paper', vscode.TreeItemCollapsibleState.None, 'startPaper', {
        command: 'quantlab.startPaperSession',
        title: 'Start Paper Trading',
      }),
      new TradePanelItem('▶ Start Live', vscode.TreeItemCollapsibleState.None, 'startLive', {
        command: 'quantlab.startLiveSession',
        title: 'Start Live Trading',
      }),
    ];
  }

  private getActiveSessionItems(): TradePanelItem[] {
    const sessions = this.sessionManager.getActiveSessions();

    if (sessions.length === 0) {
      return [new TradePanelItem('No active sessions', vscode.TreeItemCollapsibleState.None, 'empty')];
    }

    return sessions.map(session => {
      const duration = this.formatDuration(Date.now() - session.startedAt.getTime());
      const pnl = this.sessionManager.getSessionPnL(session.id);
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

      const item = new TradePanelItem(
        `● ${this.getFileName(vscode.Uri.file(session.strategyPath))} (${session.type === 'paper' ? 'Paper' : 'Live'})`,
        vscode.TreeItemCollapsibleState.None,
        'activeSession',
        {
          command: 'quantlab.viewSession',
          title: 'View Session',
          arguments: [session],
        }
      );
      item.description = `Running ${duration} │ ${pnlStr}`;
      item.tooltip = `Session ID: ${session.id}\nStarted: ${session.startedAt.toLocaleString()}`;
      return item;
    });
  }

  private getPositionItems(): TradePanelItem[] {
    const positions = this.sessionManager.getAllPositions();

    if (positions.length === 0) {
      return [new TradePanelItem('No open positions', vscode.TreeItemCollapsibleState.None, 'empty')];
    }

    return positions.map(pos => {
      const pnlStr = pos.unrealizedPnL >= 0 
        ? `+$${pos.unrealizedPnL.toFixed(2)}` 
        : `-$${Math.abs(pos.unrealizedPnL).toFixed(2)}`;

      const item = new TradePanelItem(
        `${pos.symbol}: ${pos.quantity} (${pnlStr})`,
        vscode.TreeItemCollapsibleState.None,
        'position'
      );
      item.tooltip = `Avg Price: $${pos.avgPrice.toFixed(2)}\nCurrent: $${pos.currentPrice.toFixed(2)}`;
      return item;
    });
  }

  private getOrderItems(): TradePanelItem[] {
    const orders = this.sessionManager.getAllOpenOrders();

    if (orders.length === 0) {
      return [new TradePanelItem('No open orders', vscode.TreeItemCollapsibleState.None, 'empty')];
    }

    return orders.map(order => {
      const priceStr = order.type === 'market' ? 'Market' : `@ $${order.price?.toFixed(2)}`;
      const item = new TradePanelItem(
        `${order.symbol}: ${order.side.toUpperCase()} ${order.quantity} ${priceStr}`,
        vscode.TreeItemCollapsibleState.None,
        'order'
      );
      item.tooltip = `Order ID: ${order.id}\nType: ${order.type}\nStatus: ${order.status}`;
      return item;
    });
  }

  private getRiskStatusItems(): TradePanelItem[] {
    const riskStatus = this.sessionManager.getRiskStatus();

    return [
      new TradePanelItem(
        `Daily Loss: ${riskStatus.dailyLossPercent.toFixed(0)}% of limit`,
        vscode.TreeItemCollapsibleState.None,
        'riskMetric'
      ),
      new TradePanelItem(
        'Risk Settings',
        vscode.TreeItemCollapsibleState.None,
        'riskSettings',
        { command: 'quantlab.openRiskSettings', title: 'Open Risk Settings' }
      ),
    ];
  }

  private getConnectionItems(): TradePanelItem[] {
    return this.accounts.map(account => {
      const status = account.connected ? '●' : '○';
      const item = new TradePanelItem(
        `${status} ${account.name} (${account.broker})`,
        vscode.TreeItemCollapsibleState.None,
        'connection'
      );
      item.description = account.connected ? 'connected' : 'disconnected';
      return item;
    });
  }

  // ... helper methods
  private getFileName(uri: vscode.Uri): string {
    return uri.fsPath.split('/').pop() || '';
  }

  private getSelectedAccount(): BrokerAccount | undefined {
    // Return first connected account or first account
    return this.accounts.find(a => a.connected) || this.accounts[0];
  }

  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private async loadAccounts(): Promise<void> {
    // Load from settings or secure storage
    this.accounts = await this.context.secrets.get('quantlab.brokerAccounts')
      .then(data => data ? JSON.parse(data) : [])
      .catch(() => []);
  }

  async startSession(type: SessionType): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No strategy file open');
      return;
    }

    const account = this.getSelectedAccount();
    if (!account) {
      vscode.window.showErrorMessage('No broker account configured');
      return;
    }

    // Safety checks for live trading
    if (type === 'live') {
      const confirmed = await this.confirmLiveTrading();
      if (!confirmed) return;
    }

    await this.sessionManager.startSession({
      type,
      strategyPath: editor.document.uri.fsPath,
      accountId: account.id,
    });
  }

  private async confirmLiveTrading(): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(
      'You are about to start LIVE trading with real money. Are you sure?',
      { modal: true },
      'Yes, Start Live Trading',
      'Cancel'
    );
    return result === 'Yes, Start Live Trading';
  }

  async stopSession(item: TradePanelItem): Promise<void> {
    // Implementation
  }

  async pauseSession(item: TradePanelItem): Promise<void> {
    // Implementation
  }

  async viewSession(session: SessionInfo): Promise<void> {
    // Switch to Trade view for the strategy
    const doc = await vscode.workspace.openTextDocument(session.strategyPath);
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('quantlab.switchToTrade');
  }
}

class TradePanelItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.command = command;
  }
}
```

---

## 4. Trade View - No Session State

### 4.1 UI Layout (V8.1 §3.1.4 State 1)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   LIVE TRADING — strategy.py                                                │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                                                                     │   │
│   │                    No active trading session                        │   │
│   │                                                                     │   │
│   │         Use the Trade panel in the Activity Bar to start            │   │
│   │         a Paper or Live trading session for this strategy.          │   │
│   │                                                                     │   │
│   │                  [Open Trade Panel]                                 │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   REQUIREMENTS CHECKLIST                                                    │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ✓ Strategy has valid structure                                      │   │
│   │ ✓ Strategy complexity is Safe or Partial (not View-Only)            │   │
│   │ ✓ Broker connection configured (Alpaca)                             │   │
│   │ ✓ At least one successful backtest                                  │   │
│   │ ○ Paper trading session completed (recommended)                     │   │
│   │ ○ Risk parameters reviewed                                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Create `src/views/trade/webview/noSession.ts`

```typescript
import { RequirementsCheck } from '../../../types/trading';

export function renderNoSessionState(container: HTMLElement, requirements: RequirementsCheck): void {
  container.innerHTML = `
    <div class="no-session-state">
      <!-- Header -->
      <header class="trade-header">
        <h1>Live Trading</h1>
      </header>

      <hr class="title-divider" />

      <!-- Empty State Card -->
      <div class="empty-state-card">
        <div class="empty-icon">💹</div>
        <h2>No active trading session</h2>
        <p>Use the Trade panel in the Activity Bar to start a Paper or Live trading session for this strategy.</p>
        <button class="open-panel-button" id="open-panel-btn">Open Trade Panel</button>
      </div>

      <!-- Requirements Checklist -->
      <section class="requirements-section">
        <h2>Requirements Checklist</h2>
        <ul class="requirements-list">
          ${renderRequirement('Strategy has valid structure', requirements.validStrategy, true)}
          ${renderRequirement('Strategy complexity is Safe or Partial', requirements.complexitySafe, true)}
          ${renderRequirement('Broker connection configured', requirements.brokerConfigured, true)}
          ${renderRequirement('At least one successful backtest', requirements.hasBacktest, true)}
          ${renderRequirement('Paper trading session completed', requirements.hasPaperTrading, false)}
          ${renderRequirement('Risk parameters reviewed', requirements.riskReviewed, false)}
        </ul>
      </section>

      ${!requirements.validStrategy || !requirements.complexitySafe || !requirements.brokerConfigured ? `
        <div class="blocking-warning">
          <span class="warning-icon">⚠️</span>
          <span>Some required items are not met. Please resolve before starting a trading session.</span>
        </div>
      ` : ''}
    </div>
  `;

  // Attach event listeners
  document.getElementById('open-panel-btn')?.addEventListener('click', () => {
    postMessage({ type: 'openTradePanel' });
  });
}

function renderRequirement(label: string, met: boolean, required: boolean): string {
  const icon = met ? '✓' : '○';
  const statusClass = met ? 'met' : (required ? 'unmet-required' : 'unmet-optional');
  const requiredBadge = required ? '' : '<span class="recommended-badge">(recommended)</span>';

  return `
    <li class="requirement-item ${statusClass}">
      <span class="requirement-icon">${icon}</span>
      <span class="requirement-label">${label}</span>
      ${requiredBadge}
    </li>
  `;
}
```

---

## 5. Trade View - Active Session State

### 5.1 UI Layout (V8.1 §3.1.4 State 2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   LIVE TRADING — strategy.py                    [🔴 KILL SWITCH: Flatten]  │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Session: Paper Trading          Status: ● RUNNING                   │   │
│   │ Account: Alpaca (paper-abc123)  Started: 10:32 AM (2h 15m ago)      │   │
│   │ Strategy: strategy.py @ abc1234 Heartbeat: ● OK (2s ago)            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   PERFORMANCE                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Session P&L        Today P&L         Open P&L         Realized     │   │
│   │   +$380.00           +$420.00          +$120.00         +$260.00    │   │
│   │   ████████           █████████         ████             ██████      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   POSITIONS                                                    [▼ Expand]  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Symbol │ Qty │ Avg Price │ Current │ P&L      │ Action              │   │
│   │────────┼─────┼───────────┼─────────┼──────────┼─────────────────────│   │
│   │ AAPL   │ 100 │  $180.50  │ $184.30 │ +$380.00 │ [Close]             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   OPEN ORDERS                                                  [▼ Expand]  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ID   │ Symbol │ Side │ Type  │ Qty │ Price  │ Status │ Actions     │   │
│   │──────┼────────┼──────┼───────┼─────┼────────┼────────┼─────────────│   │
│   │ 1234 │ AAPL   │ SELL │ Limit │ 50  │ $185.00│ Open   │ [Mod][Can]  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   RECENT ACTIVITY                                              [▼ Expand]  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ 10:45:32 │ 📈 │ Signal: BUY AAPL @ 180.50                          │   │
│   │ 10:45:33 │ 📋 │ Order placed: BUY 100 AAPL MARKET                  │   │
│   │ 10:45:34 │ ✓  │ Fill: BUY 100 AAPL @ 180.52                        │   │
│   │ 10:48:15 │ 📈 │ Signal: SELL AAPL @ 185.00 (limit)                 │   │
│   │ 10:48:16 │ 📋 │ Order placed: SELL 50 AAPL LIMIT @ 185.00          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                       │
│   │ ⏸ Pause      │ │ 📊 View in   │ │ ⚙️ Session   │                       │
│   │   Session    │ │    Chart     │ │   Settings   │                       │
│   └──────────────┘ └──────────────┘ └──────────────┘                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Create `src/views/trade/webview/activeSession.ts`

```typescript
import { 
  SessionInfo, 
  Position, 
  Order, 
  PerformanceMetrics, 
  ActivityEntry,
  KillSwitchConfig
} from '../../../types/trading';

interface ActiveSessionData {
  session: SessionInfo;
  positions: Position[];
  orders: Order[];
  performance: PerformanceMetrics;
  activities: ActivityEntry[];
  killSwitchConfig: KillSwitchConfig;
  heartbeatStatus: 'ok' | 'stale' | 'lost';
  lastHeartbeat: Date;
}

export function renderActiveSessionState(container: HTMLElement, data: ActiveSessionData): void {
  const killSwitchLabel = getKillSwitchLabel(data.killSwitchConfig);
  const duration = formatDuration(Date.now() - data.session.startedAt.getTime());
  const heartbeatAgo = formatRelativeTime(data.lastHeartbeat);

  container.innerHTML = `
    <div class="active-session-state">
      <!-- Header with Kill Switch -->
      <header class="trade-header">
        <h1>Live Trading — ${getFileName(data.session.strategyPath)}</h1>
        <button class="kill-switch-button" id="kill-switch-btn">
          🔴 KILL SWITCH: ${killSwitchLabel}
        </button>
      </header>

      <hr class="title-divider" />

      <!-- Session Info Card -->
      <div class="session-info-card">
        <div class="info-row">
          <span class="info-label">Session:</span>
          <span class="info-value">${data.session.type === 'paper' ? 'Paper Trading' : 'LIVE Trading'}</span>
          <span class="info-label">Status:</span>
          <span class="info-value status-${data.session.status}">● ${data.session.status.toUpperCase()}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Account:</span>
          <span class="info-value">${data.session.accountName}</span>
          <span class="info-label">Started:</span>
          <span class="info-value">${formatTime(data.session.startedAt)} (${duration} ago)</span>
        </div>
        <div class="info-row">
          <span class="info-label">Strategy:</span>
          <span class="info-value">${getFileName(data.session.strategyPath)} @ ${data.session.strategyHash.slice(0, 7)}</span>
          <span class="info-label">Heartbeat:</span>
          <span class="info-value heartbeat-${data.heartbeatStatus}">● ${data.heartbeatStatus.toUpperCase()} (${heartbeatAgo})</span>
        </div>
      </div>

      <!-- Performance Section -->
      <section class="performance-section">
        <h2>Performance</h2>
        <div class="performance-grid">
          ${renderPnLCard('Session P&L', data.performance.sessionPnL)}
          ${renderPnLCard('Today P&L', data.performance.todayPnL)}
          ${renderPnLCard('Open P&L', data.performance.openPnL)}
          ${renderPnLCard('Realized', data.performance.realizedPnL)}
        </div>
      </section>

      <!-- Positions Section -->
      <section class="positions-section collapsible" data-section="positions">
        <div class="section-header">
          <h2>Positions</h2>
          <button class="collapse-toggle">▼ Expand</button>
        </div>
        <div class="section-content">
          ${renderPositionsTable(data.positions)}
        </div>
      </section>

      <!-- Orders Section -->
      <section class="orders-section collapsible" data-section="orders">
        <div class="section-header">
          <h2>Open Orders</h2>
          <button class="collapse-toggle">▼ Expand</button>
        </div>
        <div class="section-content">
          ${renderOrdersTable(data.orders)}
        </div>
      </section>

      <!-- Activity Section -->
      <section class="activity-section collapsible" data-section="activity">
        <div class="section-header">
          <h2>Recent Activity</h2>
          <button class="collapse-toggle">▼ Expand</button>
        </div>
        <div class="section-content">
          ${renderActivityLog(data.activities)}
        </div>
      </section>

      <!-- Action Buttons -->
      <div class="session-actions">
        <button class="action-button" id="pause-btn">
          ⏸ ${data.session.status === 'paused' ? 'Resume' : 'Pause'} Session
        </button>
        <button class="action-button" id="chart-btn">
          📊 View in Chart
        </button>
        <button class="action-button" id="settings-btn">
          ⚙️ Session Settings
        </button>
      </div>
    </div>
  `;

  attachEventListeners(data);
}

function renderPnLCard(label: string, value: number): string {
  const isPositive = value >= 0;
  const formatted = isPositive ? `+$${value.toFixed(2)}` : `-$${Math.abs(value).toFixed(2)}`;
  const barWidth = Math.min(Math.abs(value) / 1000 * 100, 100); // Scale to max $1000

  return `
    <div class="pnl-card ${isPositive ? 'positive' : 'negative'}">
      <div class="pnl-label">${label}</div>
      <div class="pnl-value">${formatted}</div>
      <div class="pnl-bar">
        <div class="pnl-bar-fill" style="width: ${barWidth}%"></div>
      </div>
    </div>
  `;
}

function renderPositionsTable(positions: Position[]): string {
  if (positions.length === 0) {
    return '<p class="empty-state">No open positions</p>';
  }

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Qty</th>
          <th>Avg Price</th>
          <th>Current</th>
          <th>P&L</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${positions.map(pos => {
          const pnlClass = pos.unrealizedPnL >= 0 ? 'positive' : 'negative';
          const pnlStr = pos.unrealizedPnL >= 0 
            ? `+$${pos.unrealizedPnL.toFixed(2)}` 
            : `-$${Math.abs(pos.unrealizedPnL).toFixed(2)}`;
          return `
            <tr>
              <td class="symbol">${pos.symbol}</td>
              <td>${pos.quantity}</td>
              <td>$${pos.avgPrice.toFixed(2)}</td>
              <td>$${pos.currentPrice.toFixed(2)}</td>
              <td class="${pnlClass}">${pnlStr}</td>
              <td><button class="close-position-btn" data-symbol="${pos.symbol}">Close</button></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderOrdersTable(orders: Order[]): string {
  if (orders.length === 0) {
    return '<p class="empty-state">No open orders</p>';
  }

  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Symbol</th>
          <th>Side</th>
          <th>Type</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map(order => `
          <tr>
            <td class="order-id">${order.id.slice(-4)}</td>
            <td class="symbol">${order.symbol}</td>
            <td class="side-${order.side}">${order.side.toUpperCase()}</td>
            <td>${order.type}</td>
            <td>${order.quantity}</td>
            <td>${order.price ? `$${order.price.toFixed(2)}` : 'MKT'}</td>
            <td class="status-${order.status}">${order.status}</td>
            <td>
              <button class="modify-order-btn" data-order-id="${order.id}">Mod</button>
              <button class="cancel-order-btn" data-order-id="${order.id}">Can</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderActivityLog(activities: ActivityEntry[]): string {
  if (activities.length === 0) {
    return '<p class="empty-state">No recent activity</p>';
  }

  const typeIcons: Record<string, string> = {
    signal: '📈',
    order: '📋',
    fill: '✓',
    alert: '⚠️',
    system: '🔧',
  };

  return `
    <div class="activity-log">
      ${activities.slice(0, 20).map(entry => `
        <div class="activity-entry ${entry.type}">
          <span class="activity-time">${formatTime(entry.timestamp)}</span>
          <span class="activity-icon">${typeIcons[entry.type] || '•'}</span>
          <span class="activity-message">${escapeHtml(entry.message)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function attachEventListeners(data: ActiveSessionData): void {
  // Kill Switch
  document.getElementById('kill-switch-btn')?.addEventListener('click', () => {
    if (data.session.type === 'paper') {
      // Immediate for paper
      postMessage({ type: 'killSwitch', sessionId: data.session.id });
    } else {
      // Show confirmation for live
      showKillSwitchConfirmation(data.session.id, data.killSwitchConfig);
    }
  });

  // Pause/Resume
  document.getElementById('pause-btn')?.addEventListener('click', () => {
    if (data.session.status === 'paused') {
      postMessage({ type: 'resumeSession', sessionId: data.session.id });
    } else {
      postMessage({ type: 'pauseSession', sessionId: data.session.id });
    }
  });

  // View in Chart
  document.getElementById('chart-btn')?.addEventListener('click', () => {
    postMessage({ type: 'viewInChart', sessionId: data.session.id });
  });

  // Session Settings
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    postMessage({ type: 'openSessionSettings', sessionId: data.session.id });
  });

  // Position close buttons
  document.querySelectorAll('.close-position-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const symbol = btn.getAttribute('data-symbol');
      if (confirm(`Close all ${symbol} positions?`)) {
        postMessage({ type: 'closePosition', symbol });
      }
    });
  });

  // Order modify/cancel buttons
  document.querySelectorAll('.modify-order-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const orderId = btn.getAttribute('data-order-id');
      showModifyOrderDialog(orderId!);
    });
  });

  document.querySelectorAll('.cancel-order-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const orderId = btn.getAttribute('data-order-id');
      if (confirm('Cancel this order?')) {
        postMessage({ type: 'cancelOrder', orderId });
      }
    });
  });

  // Collapsible sections
  document.querySelectorAll('.collapse-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.collapsible');
      section?.classList.toggle('collapsed');
      btn.textContent = section?.classList.contains('collapsed') ? '▼ Expand' : '▲ Collapse';
    });
  });
}

function showKillSwitchConfirmation(sessionId: string, config: KillSwitchConfig): void {
  const policyDescription = getKillSwitchDescription(config);

  const dialog = document.createElement('div');
  dialog.className = 'kill-switch-dialog';
  dialog.innerHTML = `
    <div class="dialog-overlay"></div>
    <div class="dialog-content">
      <h2>⚠️ Kill Switch Confirmation</h2>
      <p>You are about to execute the Kill Switch for a <strong>LIVE</strong> trading session.</p>
      <p>This will:</p>
      <ul>
        ${policyDescription.map(d => `<li>${d}</li>`).join('')}
      </ul>
      <p><strong>Are you sure you want to proceed?</strong></p>
      <div class="dialog-actions">
        <button class="cancel-btn">Cancel</button>
        <button class="confirm-btn danger">Execute Kill Switch</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  dialog.querySelector('.cancel-btn')?.addEventListener('click', () => dialog.remove());
  dialog.querySelector('.dialog-overlay')?.addEventListener('click', () => dialog.remove());
  dialog.querySelector('.confirm-btn')?.addEventListener('click', () => {
    postMessage({ type: 'killSwitch', sessionId, confirmed: true });
    dialog.remove();
  });
}

function getKillSwitchLabel(config: KillSwitchConfig): string {
  switch (config.policy) {
    case 'flatten': return 'Flatten';
    case 'cancelOnly': return 'Cancel Only';
    case 'custom': return 'Custom...';
    default: return 'Flatten';
  }
}

function getKillSwitchDescription(config: KillSwitchConfig): string[] {
  switch (config.policy) {
    case 'flatten':
      return ['Cancel all open orders', 'Close all open positions at market'];
    case 'cancelOnly':
      return ['Cancel all open orders', 'Keep existing positions open'];
    case 'custom':
      return config.customActions?.map(a => describeAction(a)) || ['Execute custom actions'];
    default:
      return [];
  }
}

function describeAction(action: KillSwitchAction): string {
  switch (action.type) {
    case 'cancelOrders': return 'Cancel all open orders';
    case 'flattenPositions': return 'Close all positions at market';
    case 'pauseStrategy': return 'Pause strategy execution';
    default: return action.type;
  }
}

// Helper functions
function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showModifyOrderDialog(orderId: string): void {
  // Implementation for order modification dialog
}
```

---

## 6. Kill Switch System

### 6.1 Create `src/views/trade/KillSwitch.ts`

```typescript
import * as vscode from 'vscode';
import { BrokerAdapter } from '../../core/broker/BrokerAdapter';
import { KillSwitchConfig, KillSwitchAction, SessionInfo } from '../../types/trading';

export class KillSwitch {
  private static instance: KillSwitch;

  static getInstance(): KillSwitch {
    if (!this.instance) {
      this.instance = new KillSwitch();
    }
    return this.instance;
  }

  async execute(
    session: SessionInfo,
    broker: BrokerAdapter,
    config: KillSwitchConfig,
    outputChannel: vscode.OutputChannel
  ): Promise<KillSwitchResult> {
    outputChannel.appendLine(`\n=== KILL SWITCH ACTIVATED ===`);
    outputChannel.appendLine(`Session: ${session.id}`);
    outputChannel.appendLine(`Policy: ${config.policy}`);
    outputChannel.appendLine(`Time: ${new Date().toISOString()}`);
    outputChannel.appendLine(`---`);

    const results: KillSwitchActionResult[] = [];

    try {
      switch (config.policy) {
        case 'flatten':
          results.push(await this.cancelAllOrders(broker, outputChannel));
          results.push(await this.flattenAllPositions(broker, outputChannel));
          break;

        case 'cancelOnly':
          results.push(await this.cancelAllOrders(broker, outputChannel));
          break;

        case 'custom':
          for (const action of config.customActions || []) {
            results.push(await this.executeAction(action, broker, outputChannel));
          }
          break;
      }

      const success = results.every(r => r.success);

      outputChannel.appendLine(`---`);
      outputChannel.appendLine(`Kill Switch ${success ? 'COMPLETED' : 'COMPLETED WITH ERRORS'}`);

      return { success, results };

    } catch (error) {
      outputChannel.appendLine(`KILL SWITCH ERROR: ${error}`);
      return { 
        success: false, 
        results,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async cancelAllOrders(
    broker: BrokerAdapter,
    outputChannel: vscode.OutputChannel
  ): Promise<KillSwitchActionResult> {
    outputChannel.appendLine(`Cancelling all orders...`);

    try {
      const orders = await broker.getOpenOrders();
      outputChannel.appendLine(`Found ${orders.length} open orders`);

      let cancelled = 0;
      let failed = 0;

      for (const order of orders) {
        try {
          await broker.cancelOrder(order.id);
          outputChannel.appendLine(`  ✓ Cancelled order ${order.id} (${order.symbol} ${order.side} ${order.quantity})`);
          cancelled++;
        } catch (err) {
          outputChannel.appendLine(`  ✗ Failed to cancel order ${order.id}: ${err}`);
          failed++;
        }
      }

      return {
        action: 'cancelOrders',
        success: failed === 0,
        details: { total: orders.length, cancelled, failed },
      };

    } catch (error) {
      outputChannel.appendLine(`Failed to get orders: ${error}`);
      return {
        action: 'cancelOrders',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async flattenAllPositions(
    broker: BrokerAdapter,
    outputChannel: vscode.OutputChannel
  ): Promise<KillSwitchActionResult> {
    outputChannel.appendLine(`Flattening all positions...`);

    try {
      const positions = await broker.getPositions();
      outputChannel.appendLine(`Found ${positions.length} open positions`);

      let closed = 0;
      let failed = 0;

      for (const position of positions) {
        if (position.quantity === 0) continue;

        try {
          // Submit market order to close
          const side = position.quantity > 0 ? 'sell' : 'buy';
          const qty = Math.abs(position.quantity);

          await broker.placeOrder({
            symbol: position.symbol,
            side,
            type: 'market',
            quantity: qty,
            timeInForce: 'day',
          });

          outputChannel.appendLine(`  ✓ Closing ${position.symbol}: ${side.toUpperCase()} ${qty} at MARKET`);
          closed++;
        } catch (err) {
          outputChannel.appendLine(`  ✗ Failed to close ${position.symbol}: ${err}`);
          failed++;
        }
      }

      return {
        action: 'flattenPositions',
        success: failed === 0,
        details: { total: positions.length, closed, failed },
      };

    } catch (error) {
      outputChannel.appendLine(`Failed to get positions: ${error}`);
      return {
        action: 'flattenPositions',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeAction(
    action: KillSwitchAction,
    broker: BrokerAdapter,
    outputChannel: vscode.OutputChannel
  ): Promise<KillSwitchActionResult> {
    switch (action.type) {
      case 'cancelOrders':
        return this.cancelAllOrders(broker, outputChannel);
      case 'flattenPositions':
        return this.flattenAllPositions(broker, outputChannel);
      case 'pauseStrategy':
        outputChannel.appendLine(`Pausing strategy...`);
        // This would signal the engine to pause
        return { action: 'pauseStrategy', success: true };
      default:
        outputChannel.appendLine(`Unknown action type: ${action.type}`);
        return { action: action.type, success: false, error: 'Unknown action type' };
    }
  }

  getConfig(): KillSwitchConfig {
    // Load from settings
    const settings = vscode.workspace.getConfiguration('quantlab.trading');
    const policy = settings.get<KillSwitchPolicy>('killSwitchPolicy', 'flatten');
    const customActions = settings.get<KillSwitchAction[]>('killSwitchCustomActions', []);

    return { policy, customActions };
  }
}

interface KillSwitchResult {
  success: boolean;
  results: KillSwitchActionResult[];
  error?: string;
}

interface KillSwitchActionResult {
  action: string;
  success: boolean;
  details?: any;
  error?: string;
}
```

---

## 7. Safety Gating

### 7.1 Implementation

```typescript
// In SessionManager.ts
async validateTradingEligibility(
  strategyPath: string,
  sessionType: SessionType
): Promise<{ eligible: boolean; reason?: string }> {
  const doc = await vscode.workspace.openTextDocument(strategyPath);
  
  // Check strategy validity
  const validator = StrategyValidator.getInstance();
  const validation = validator.validateStrategy(doc);
  
  if (!validation.isValid) {
    return { eligible: false, reason: 'Strategy has validation errors' };
  }
  
  // Check complexity for live trading
  if (sessionType === 'live') {
    const complexity = ComplexityAnalyzer.analyze(doc);
    
    if (complexity.level === 'viewOnly') {
      return { 
        eligible: false, 
        reason: 'View-Only complexity strategies cannot trade live. ' +
                'Simplify strategy or run backtests only.' 
      };
    }
    
    if (complexity.level === 'partial') {
      // Show warning but allow
      const proceed = await vscode.window.showWarningMessage(
        'This strategy has Partial complexity. Some features may not work as expected in live trading. Continue?',
        'Continue',
        'Cancel'
      );
      
      if (proceed !== 'Continue') {
        return { eligible: false, reason: 'User cancelled' };
      }
    }
  }
  
  // Check pre-trade requirements from settings
  const settings = vscode.workspace.getConfiguration('quantlab.trading');
  
  if (settings.get<boolean>('requireBacktest', true)) {
    const history = HistoryState.getInstance();
    const hasBacktest = history.getEntriesForStrategy(strategyPath)
      .some(e => e.type === 'backtest' && e.status === 'completed');
    
    if (!hasBacktest) {
      return { 
        eligible: false, 
        reason: 'At least one successful backtest is required before trading' 
      };
    }
  }
  
  if (sessionType === 'live' && settings.get<boolean>('requirePaperTrading', false)) {
    const history = HistoryState.getInstance();
    const sessions = await this.getHistoricalSessions(strategyPath);
    const hasPaper = sessions.some(s => s.type === 'paper');
    
    if (!hasPaper) {
      return { 
        eligible: false, 
        reason: 'Paper trading session required before live trading' 
      };
    }
  }
  
  return { eligible: true };
}
```

---

## 8. Session Management

### 8.1 Create `src/panels/trade/SessionManager.ts`

```typescript
import * as vscode from 'vscode';
import { 
  SessionInfo, 
  SessionType, 
  SessionStatus, 
  Position, 
  Order,
  Fill
} from '../../types/trading';
import { BrokerAdapter } from '../../core/broker/BrokerAdapter';
import { AlpacaAdapter } from '../../core/broker/AlpacaAdapter';
import { KillSwitch } from '../../views/trade/KillSwitch';

export interface StartSessionOptions {
  type: SessionType;
  strategyPath: string;
  accountId: string;
}

export class SessionManager {
  private static instance: SessionManager;
  
  private sessions: Map<string, Session> = new Map();
  private brokers: Map<string, BrokerAdapter> = new Map();
  
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
  readonly onSessionsChanged = this._onSessionsChanged.event;
  
  private readonly _onPositionsUpdate = new vscode.EventEmitter<Position[]>();
  readonly onPositionsUpdate = this._onPositionsUpdate.event;
  
  private readonly _onOrdersUpdate = new vscode.EventEmitter<Order[]>();
  readonly onOrdersUpdate = this._onOrdersUpdate.event;
  
  private readonly _onFill = new vscode.EventEmitter<Fill>();
  readonly onFill = this._onFill.event;

  private outputChannel: vscode.OutputChannel;

  static getInstance(): SessionManager {
    if (!this.instance) {
      this.instance = new SessionManager();
    }
    return this.instance;
  }

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Quantlab Trading');
  }

  async startSession(options: StartSessionOptions): Promise<SessionInfo> {
    // Validate eligibility
    const eligibility = await this.validateTradingEligibility(
      options.strategyPath,
      options.type
    );
    
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason);
    }
    
    // Get or create broker connection
    const broker = await this.getBroker(options.accountId);
    
    // Generate session ID
    const sessionId = this.generateSessionId(options.type);
    
    // Create session info
    const sessionInfo: SessionInfo = {
      id: sessionId,
      type: options.type,
      status: 'starting',
      strategyPath: options.strategyPath,
      strategyHash: await this.computeStrategyHash(options.strategyPath),
      accountId: options.accountId,
      accountName: broker.getAccountName(),
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      symbol: GlobalState.getInstance().getSymbol(),
    };
    
    // Create session object
    const session = new Session(sessionInfo, broker, this.outputChannel);
    this.sessions.set(sessionId, session);
    
    // Start the session
    await session.start();
    
    // Subscribe to updates
    session.onPositionsUpdate((positions) => this._onPositionsUpdate.fire(positions));
    session.onOrdersUpdate((orders) => this._onOrdersUpdate.fire(orders));
    session.onFill((fill) => this._onFill.fire(fill));
    
    this._onSessionsChanged.fire();
    
    this.outputChannel.appendLine(`Session started: ${sessionId} (${options.type})`);
    
    return sessionInfo;
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    await session.stop();
    this.sessions.delete(sessionId);
    
    this._onSessionsChanged.fire();
    
    this.outputChannel.appendLine(`Session stopped: ${sessionId}`);
  }

  async pauseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    await session.pause();
    
    this._onSessionsChanged.fire();
  }

  async resumeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    await session.resume();
    
    this._onSessionsChanged.fire();
  }

  async executeKillSwitch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    const killSwitch = KillSwitch.getInstance();
    const config = killSwitch.getConfig();
    
    await killSwitch.execute(
      session.getInfo(),
      session.getBroker(),
      config,
      this.outputChannel
    );
    
    // Stop the session after kill switch
    await this.stopSession(sessionId);
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .map(s => s.getInfo())
      .filter(s => s.status === 'running' || s.status === 'paused');
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionForStrategy(strategyPath: string): Session | undefined {
    return Array.from(this.sessions.values())
      .find(s => s.getInfo().strategyPath === strategyPath);
  }

  getAllPositions(): Position[] {
    const positions: Position[] = [];
    for (const session of this.sessions.values()) {
      positions.push(...session.getPositions());
    }
    return positions;
  }

  getAllOpenOrders(): Order[] {
    const orders: Order[] = [];
    for (const session of this.sessions.values()) {
      orders.push(...session.getOpenOrders());
    }
    return orders;
  }

  getSessionPnL(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session?.getPerformance().sessionPnL || 0;
  }

  getRiskStatus(): { dailyLossPercent: number } {
    // Calculate aggregate risk across all sessions
    let totalDailyLoss = 0;
    let totalDailyLimit = 0;
    
    for (const session of this.sessions.values()) {
      const perf = session.getPerformance();
      totalDailyLoss += Math.min(0, perf.todayPnL);
      totalDailyLimit += session.getDailyLossLimit();
    }
    
    return {
      dailyLossPercent: totalDailyLimit > 0 
        ? (Math.abs(totalDailyLoss) / totalDailyLimit) * 100 
        : 0,
    };
  }

  private async getBroker(accountId: string): Promise<BrokerAdapter> {
    if (this.brokers.has(accountId)) {
      return this.brokers.get(accountId)!;
    }
    
    // Create new broker connection
    // TODO: Support multiple broker types
    const broker = new AlpacaAdapter(accountId);
    await broker.connect();
    
    this.brokers.set(accountId, broker);
    return broker;
  }

  private generateSessionId(type: SessionType): string {
    const prefix = type === 'paper' ? 'paper' : 'live';
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `${prefix}-${timestamp}-${random}`;
  }

  private async computeStrategyHash(strategyPath: string): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(strategyPath);
    const text = doc.getText();
    
    // Simple hash for now
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private async validateTradingEligibility(
    strategyPath: string,
    sessionType: SessionType
  ): Promise<{ eligible: boolean; reason?: string }> {
    // Implementation as shown in Safety Gating section
    return { eligible: true };
  }
}

class Session {
  private positions: Position[] = [];
  private orders: Order[] = [];
  private activities: ActivityEntry[] = [];
  private performance: PerformanceMetrics;
  private heartbeatInterval?: NodeJS.Timeout;
  
  private readonly _onPositionsUpdate = new vscode.EventEmitter<Position[]>();
  readonly onPositionsUpdate = this._onPositionsUpdate.event;
  
  private readonly _onOrdersUpdate = new vscode.EventEmitter<Order[]>();
  readonly onOrdersUpdate = this._onOrdersUpdate.event;
  
  private readonly _onFill = new vscode.EventEmitter<Fill>();
  readonly onFill = this._onFill.event;

  constructor(
    private info: SessionInfo,
    private broker: BrokerAdapter,
    private outputChannel: vscode.OutputChannel
  ) {
    this.performance = {
      sessionPnL: 0,
      todayPnL: 0,
      openPnL: 0,
      realizedPnL: 0,
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
    };
  }

  async start(): Promise<void> {
    this.info.status = 'running';
    
    // Subscribe to broker updates
    this.broker.subscribeToUpdates({
      onPositionUpdate: (positions) => {
        this.positions = positions;
        this.updatePerformance();
        this._onPositionsUpdate.fire(positions);
      },
      onOrderUpdate: (orders) => {
        this.orders = orders;
        this._onOrdersUpdate.fire(orders);
      },
      onFill: (fill) => {
        this.addActivity('fill', `Fill: ${fill.side.toUpperCase()} ${fill.quantity} ${fill.symbol} @ $${fill.price.toFixed(2)}`);
        this._onFill.fire(fill);
      },
    });
    
    // Start heartbeat monitoring
    this.heartbeatInterval = setInterval(() => this.checkHeartbeat(), 5000);
    
    // Load initial state
    this.positions = await this.broker.getPositions();
    this.orders = await this.broker.getOpenOrders();
    
    this.addActivity('system', `Session started: ${this.info.type.toUpperCase()}`);
  }

  async stop(): Promise<void> {
    this.info.status = 'stopping';
    
    // Unsubscribe from updates
    this.broker.unsubscribeFromUpdates();
    
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.info.status = 'stopped';
    this.addActivity('system', 'Session stopped');
  }

  async pause(): Promise<void> {
    this.info.status = 'paused';
    this.addActivity('system', 'Session paused');
  }

  async resume(): Promise<void> {
    this.info.status = 'running';
    this.addActivity('system', 'Session resumed');
  }

  getInfo(): SessionInfo {
    return { ...this.info };
  }

  getBroker(): BrokerAdapter {
    return this.broker;
  }

  getPositions(): Position[] {
    return [...this.positions];
  }

  getOpenOrders(): Order[] {
    return this.orders.filter(o => o.status === 'open' || o.status === 'partial');
  }

  getPerformance(): PerformanceMetrics {
    return { ...this.performance };
  }

  getActivities(): ActivityEntry[] {
    return [...this.activities];
  }

  getDailyLossLimit(): number {
    // From settings or broker
    return 1000; // Default $1000
  }

  private checkHeartbeat(): void {
    this.info.lastHeartbeat = new Date();
    // Could check engine heartbeat here
  }

  private updatePerformance(): void {
    let openPnL = 0;
    for (const pos of this.positions) {
      openPnL += pos.unrealizedPnL;
    }
    
    this.performance.openPnL = openPnL;
    this.performance.sessionPnL = this.performance.realizedPnL + openPnL;
  }

  private addActivity(type: ActivityEntry['type'], message: string): void {
    this.activities.unshift({
      id: `act-${Date.now()}`,
      timestamp: new Date(),
      type,
      message,
    });
    
    // Keep last 100 activities
    if (this.activities.length > 100) {
      this.activities.pop();
    }
    
    this.outputChannel.appendLine(`[${this.info.id}] ${type.toUpperCase()}: ${message}`);
  }
}
```

---

## 9. Broker Integration

### 9.1 Create `src/core/broker/BrokerAdapter.ts`

```typescript
import { Position, Order, Fill, OrderSide, OrderType } from '../../types/trading';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  timeInForce: 'day' | 'gtc' | 'ioc' | 'fok';
}

export interface BrokerUpdateCallbacks {
  onPositionUpdate: (positions: Position[]) => void;
  onOrderUpdate: (orders: Order[]) => void;
  onFill: (fill: Fill) => void;
}

export abstract class BrokerAdapter {
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;
  
  abstract getAccountName(): string;
  abstract getAccountBalance(): Promise<number>;
  abstract getBuyingPower(): Promise<number>;
  
  abstract getPositions(): Promise<Position[]>;
  abstract getOpenOrders(): Promise<Order[]>;
  abstract getOrderHistory(limit?: number): Promise<Order[]>;
  
  abstract placeOrder(request: OrderRequest): Promise<Order>;
  abstract cancelOrder(orderId: string): Promise<void>;
  abstract modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<Order>;
  
  abstract subscribeToUpdates(callbacks: BrokerUpdateCallbacks): void;
  abstract unsubscribeFromUpdates(): void;
}
```

### 9.2 Create `src/core/broker/AlpacaAdapter.ts`

```typescript
import * as vscode from 'vscode';
import { BrokerAdapter, OrderRequest, BrokerUpdateCallbacks } from './BrokerAdapter';
import { Position, Order, Fill, OrderStatus } from '../../types/trading';

export class AlpacaAdapter extends BrokerAdapter {
  private apiKey: string = '';
  private apiSecret: string = '';
  private baseUrl: string;
  private wsUrl: string;
  private connected: boolean = false;
  private ws: WebSocket | null = null;
  private callbacks: BrokerUpdateCallbacks | null = null;
  private accountInfo: any = null;

  constructor(
    private accountId: string,
    private isPaper: boolean = true
  ) {
    super();
    this.baseUrl = isPaper 
      ? 'https://paper-api.alpaca.markets' 
      : 'https://api.alpaca.markets';
    this.wsUrl = isPaper
      ? 'wss://paper-api.alpaca.markets/stream'
      : 'wss://api.alpaca.markets/stream';
  }

  async connect(): Promise<void> {
    // Load credentials from secure storage
    const context = getExtensionContext();
    const creds = await context.secrets.get(`alpaca.${this.accountId}`);
    
    if (!creds) {
      throw new Error('Alpaca credentials not configured');
    }
    
    const { apiKey, apiSecret } = JSON.parse(creds);
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    // Verify connection
    try {
      const response = await this.request('GET', '/v2/account');
      this.accountInfo = response;
      this.connected = true;
    } catch (error) {
      throw new Error(`Failed to connect to Alpaca: ${error}`);
    }

    // Connect WebSocket for real-time updates
    await this.connectWebSocket();
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAccountName(): string {
    return this.accountInfo?.account_number || this.accountId;
  }

  async getAccountBalance(): Promise<number> {
    const account = await this.request('GET', '/v2/account');
    return parseFloat(account.equity);
  }

  async getBuyingPower(): Promise<number> {
    const account = await this.request('GET', '/v2/account');
    return parseFloat(account.buying_power);
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.request('GET', '/v2/positions');
    return positions.map((p: any) => ({
      symbol: p.symbol,
      quantity: parseInt(p.qty),
      avgPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      unrealizedPnL: parseFloat(p.unrealized_pl),
      realizedPnL: 0, // Alpaca doesn't provide this per-position
      marketValue: parseFloat(p.market_value),
    }));
  }

  async getOpenOrders(): Promise<Order[]> {
    const orders = await this.request('GET', '/v2/orders?status=open');
    return orders.map(this.mapOrder);
  }

  async getOrderHistory(limit: number = 100): Promise<Order[]> {
    const orders = await this.request('GET', `/v2/orders?status=all&limit=${limit}`);
    return orders.map(this.mapOrder);
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    const alpacaOrder = {
      symbol: request.symbol,
      qty: request.quantity,
      side: request.side,
      type: request.type,
      time_in_force: request.timeInForce,
      limit_price: request.price,
      stop_price: request.stopPrice,
    };

    const response = await this.request('POST', '/v2/orders', alpacaOrder);
    return this.mapOrder(response);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request('DELETE', `/v2/orders/${orderId}`);
  }

  async modifyOrder(orderId: string, changes: Partial<OrderRequest>): Promise<Order> {
    const patch: any = {};
    if (changes.quantity) patch.qty = changes.quantity;
    if (changes.price) patch.limit_price = changes.price;
    if (changes.stopPrice) patch.stop_price = changes.stopPrice;

    const response = await this.request('PATCH', `/v2/orders/${orderId}`, patch);
    return this.mapOrder(response);
  }

  subscribeToUpdates(callbacks: BrokerUpdateCallbacks): void {
    this.callbacks = callbacks;
  }

  unsubscribeFromUpdates(): void {
    this.callbacks = null;
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        // Authenticate
        this.ws!.send(JSON.stringify({
          action: 'auth',
          key: this.apiKey,
          secret: this.apiSecret,
        }));
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);

        if (data.stream === 'authorization' && data.data.status === 'authorized') {
          // Subscribe to trade updates
          this.ws!.send(JSON.stringify({
            action: 'listen',
            data: { streams: ['trade_updates'] },
          }));
          resolve();
        }
      };

      this.ws.onerror = (error) => {
        reject(error);
      };
    });
  }

  private handleWebSocketMessage(data: any): void {
    if (data.stream === 'trade_updates') {
      const update = data.data;
      
      switch (update.event) {
        case 'fill':
        case 'partial_fill':
          this.callbacks?.onFill({
            id: `fill-${update.order.id}-${Date.now()}`,
            orderId: update.order.id,
            symbol: update.order.symbol,
            side: update.order.side,
            quantity: parseInt(update.qty),
            price: parseFloat(update.price),
            timestamp: new Date(update.timestamp),
            commission: 0, // Alpaca is commission-free
          });
          
          // Refresh positions and orders
          this.refreshState();
          break;

        case 'new':
        case 'canceled':
        case 'replaced':
        case 'rejected':
          this.refreshState();
          break;
      }
    }
  }

  private async refreshState(): Promise<void> {
    const [positions, orders] = await Promise.all([
      this.getPositions(),
      this.getOpenOrders(),
    ]);
    
    this.callbacks?.onPositionUpdate(positions);
    this.callbacks?.onOrderUpdate(orders);
  }

  private async request(method: string, path: string, body?: any): Promise<any> {
    const url = this.baseUrl + path;
    
    const response = await fetch(url, {
      method,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.apiSecret,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Alpaca API error: ${response.status} ${error}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  private mapOrder(o: any): Order {
    const statusMap: Record<string, OrderStatus> = {
      new: 'open',
      partially_filled: 'partial',
      filled: 'filled',
      done_for_day: 'filled',
      canceled: 'cancelled',
      expired: 'cancelled',
      replaced: 'cancelled',
      pending_cancel: 'open',
      pending_replace: 'open',
      accepted: 'open',
      pending_new: 'pending',
      accepted_for_bidding: 'pending',
      stopped: 'open',
      rejected: 'rejected',
      suspended: 'open',
      calculated: 'open',
    };

    return {
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      quantity: parseInt(o.qty),
      filledQuantity: parseInt(o.filled_qty) || 0,
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
      status: statusMap[o.status] || 'open',
      createdAt: new Date(o.created_at),
      updatedAt: new Date(o.updated_at),
      rejectionReason: o.status === 'rejected' ? 'Order rejected' : undefined,
    };
  }
}
```

---

## 10-14. (Remaining sections follow same detailed pattern...)

Due to length constraints, I'll provide the Exit Gates and key remaining sections:

---

## 13. Verification Plan

### 13.1 Integration Tests

```typescript
describe('Trade View', () => {
  it('blocks live trading for View-Only complexity', async () => {
    await openTradePanel();
    await selectStrategy('complex_strategy.py'); // View-Only
    
    expect(getStartLiveButton().disabled).toBe(true);
  });
  
  it('Kill Switch executes policy for paper trading', async () => {
    await startPaperSession('momentum.py');
    await placeOrder('AAPL', 'buy', 100);
    
    await clickKillSwitch();
    
    expect(getOpenOrders()).toHaveLength(0);
  });

  it('Kill Switch shows confirmation for live trading', async () => {
    await startLiveSession('momentum.py');
    
    await clickKillSwitch();
    
    expect(getConfirmationDialog()).toBeVisible();
  });

  it('positions update in real-time', async () => {
    await startPaperSession('momentum.py');
    
    // Simulate fill from broker
    await simulateFill('AAPL', 'buy', 100, 180.50);
    
    const positions = getPositionsTable();
    expect(positions).toContainText('AAPL');
    expect(positions).toContainText('100');
  });
});
```

---

## 14. Exit Gates

### 14.1 Phase 5 Completion Criteria

- [ ] **Trade Panel**
  - [ ] Session control UI complete
  - [ ] Active sessions display
  - [ ] Positions and orders aggregated
  - [ ] Risk status display

- [ ] **Trade View**
  - [ ] No-session state with requirements checklist
  - [ ] Active session state with all sections
  - [ ] Real-time updates work
  - [ ] Tab stripe shows red (#DC2626)

- [ ] **Kill Switch**
  - [ ] Policy configurable in settings
  - [ ] Button label reflects policy
  - [ ] Paper: executes immediately
  - [ ] Live: shows confirmation dialog
  - [ ] Flatten/Cancel actions work

- [ ] **Safety Gating**
  - [ ] View-Only blocks live trading
  - [ ] Partial shows warning
  - [ ] Backtest requirement enforced
  - [ ] Paper trading requirement (optional) enforced

- [ ] **Session Management**
  - [ ] Start/stop/pause/resume work
  - [ ] Multiple sessions supported
  - [ ] Heartbeat monitoring works
  - [ ] Session state persists

- [ ] **Broker Integration**
  - [ ] Alpaca adapter connects
  - [ ] Positions/orders load
  - [ ] Real-time WebSocket updates
  - [ ] Order placement/cancellation works

- [ ] **Integration**
  - [ ] Trade panel auto-expands on view entry
  - [ ] View in Chart shows live data
  - [ ] Fills recorded in activity log

### 14.2 Performance Targets

| Metric | Target |
|--------|--------|
| Session start | < 2s |
| Position update render | < 50ms |
| Kill Switch execution | < 5s |
| WebSocket latency | < 100ms |

---

*End of Phase 5: Trade View MVP — Detailed Implementation Plan*
