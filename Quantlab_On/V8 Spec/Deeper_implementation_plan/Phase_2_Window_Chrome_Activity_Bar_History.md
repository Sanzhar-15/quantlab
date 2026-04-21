# Phase 2: Window Chrome + Activity Bar + History — Detailed Implementation Plan

**Duration**: 2-3 weeks
**Goal**: Implement navigation surfaces, global state management, and the History system
**Prerequisites**: Phase 0 Feasibility Spike completed, Phase 1 Core View System completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Global State Manager](#2-global-state-manager)
3. [Global Selectors UI](#3-global-selectors-ui)
4. [History State Manager](#4-history-state-manager)
5. [History Dropdown](#5-history-dropdown)
6. [Activity Bar Panels](#6-activity-bar-panels)
7. [Drag-and-Drop Infrastructure](#7-drag-and-drop-infrastructure)
8. [Verification Plan](#8-verification-plan)
9. [Exit Gates](#9-exit-gates)

---

## 1. Overview

### 1.1 What We're Building

Phase 2 establishes the navigation and state management infrastructure for Quantlab:

| Component | Purpose | V8.1 Reference |
|-----------|---------|----------------|
| **Global State Manager** | Symbol/Timeframe state across views | §2.7 |
| **Global Selectors UI** | Symbol/TF dropdowns in window chrome | §2.2.2, §2.2.3 |
| **History State Manager** | Run history storage and queries | §5.1, §5.3 |
| **History Dropdown** | Quick access to running/recent jobs | §5.2 |
| **5 Activity Bar Panels** | Data, Resources, History, Trade, Settings | §4.1-4.3 |
| **Drag-and-Drop** | Symbol/run dragging to views | §12 |

### 1.2 Key V8.1 Invariants (Must Hold)

- Global Symbol/TF selectors in window chrome (center-right)
- History button in window chrome (right)
- Both persist per-workspace
- Activity Bar = navigation only
- Quantlab panels: Data, Resources, History, Trade, Settings
- NO Visualiser or Tester icons in Activity Bar

### 1.3 File Structure to Create

```
quantlab-extension/src/
├── core/
│   └── state/
│       ├── GlobalState.ts          # Symbol/TF + events
│       └── HistoryState.ts         # Run history + persistence
├── ui/
│   └── GlobalSelectors.ts          # Symbol/TF in chrome
├── panels/
│   ├── data/
│   │   ├── DataPanelProvider.ts
│   │   ├── SymbolTreeProvider.ts
│   │   └── WatchlistManager.ts
│   ├── resources/
│   │   ├── ResourcesPanelProvider.ts
│   │   ├── ResourcesTreeProvider.ts
│   │   └── resourcesCatalog.json
│   ├── history/
│   │   ├── HistoryPanelProvider.ts
│   │   ├── HistoryTreeProvider.ts
│   │   └── HistoryDropdown.ts
│   ├── trade/
│   │   ├── TradePanelProvider.ts
│   │   └── TradeTreeProvider.ts
│   └── settings/
│       ├── SettingsPanelProvider.ts
│       └── SettingsTreeProvider.ts
└── types/
    ├── history.ts                  # HistoryEntry, RunType, RunStatus
    └── market.ts                   # Symbol, Timeframe types
```

---

## 2. Global State Manager

### 2.1 Requirement (V8.1 §2.7)

Manage global market context that affects multiple views:
- Symbol (e.g., "AAPL")
- Timeframe (e.g., "1D", "1H", "5m")
- Optional: Date range

**Scope**: Per-workspace
**Persistence**: Saved in workspace state, restored on reopen

### 2.2 Create `src/types/market.ts`

```typescript
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | '1D' | '1W' | '1M';

export interface Symbol {
  ticker: string;           // "AAPL"
  name?: string;            // "Apple Inc."
  exchange?: string;        // "NASDAQ"
  type?: string;            // "Equity"
  currency?: string;        // "USD"
}

export interface GlobalMarketState {
  symbol: string;           // Ticker string for simplicity
  timeframe: Timeframe;
  dateRange?: {
    start: Date;
    end: Date;
  };
}
```

### 2.3 Create `src/core/state/GlobalState.ts`

```typescript
import * as vscode from 'vscode';
import { GlobalMarketState, Timeframe } from '../../types/market';

const DEFAULT_STATE: GlobalMarketState = {
  symbol: 'AAPL',
  timeframe: '1D',
};

export class GlobalState {
  private static instance: GlobalState;
  private state: GlobalMarketState;
  private context: vscode.ExtensionContext;

  // Events
  private readonly _onDidChangeSymbol = new vscode.EventEmitter<string>();
  readonly onDidChangeSymbol = this._onDidChangeSymbol.event;

  private readonly _onDidChangeTimeframe = new vscode.EventEmitter<Timeframe>();
  readonly onDidChangeTimeframe = this._onDidChangeTimeframe.event;

  private readonly _onDidChange = new vscode.EventEmitter<GlobalMarketState>();
  readonly onDidChange = this._onDidChange.event;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.state = this.restore();
  }

  static initialize(context: vscode.ExtensionContext): GlobalState {
    if (!this.instance) {
      this.instance = new GlobalState(context);
    }
    return this.instance;
  }

  static getInstance(): GlobalState {
    if (!this.instance) {
      throw new Error('GlobalState not initialized. Call initialize() first.');
    }
    return this.instance;
  }

  // Symbol
  getSymbol(): string {
    return this.state.symbol;
  }

  setSymbol(symbol: string): void {
    if (this.state.symbol !== symbol) {
      this.state.symbol = symbol;
      this.persist();
      this._onDidChangeSymbol.fire(symbol);
      this._onDidChange.fire(this.state);
    }
  }

  // Timeframe
  getTimeframe(): Timeframe {
    return this.state.timeframe;
  }

  setTimeframe(timeframe: Timeframe): void {
    if (this.state.timeframe !== timeframe) {
      this.state.timeframe = timeframe;
      this.persist();
      this._onDidChangeTimeframe.fire(timeframe);
      this._onDidChange.fire(this.state);
    }
  }

  // Date Range
  getDateRange(): { start: Date; end: Date } | undefined {
    return this.state.dateRange;
  }

  setDateRange(range: { start: Date; end: Date } | undefined): void {
    this.state.dateRange = range;
    this.persist();
    this._onDidChange.fire(this.state);
  }

  // Full state access
  getState(): Readonly<GlobalMarketState> {
    return { ...this.state };
  }

  // Persistence
  private persist(): void {
    this.context.workspaceState.update('quantlab.globalMarketState', {
      ...this.state,
      dateRange: this.state.dateRange
        ? {
            start: this.state.dateRange.start.toISOString(),
            end: this.state.dateRange.end.toISOString(),
          }
        : undefined,
    });
  }

  private restore(): GlobalMarketState {
    const saved = this.context.workspaceState.get<any>('quantlab.globalMarketState');
    if (!saved) {
      return { ...DEFAULT_STATE };
    }
    return {
      symbol: saved.symbol ?? DEFAULT_STATE.symbol,
      timeframe: saved.timeframe ?? DEFAULT_STATE.timeframe,
      dateRange: saved.dateRange
        ? {
            start: new Date(saved.dateRange.start),
            end: new Date(saved.dateRange.end),
          }
        : undefined,
    };
  }
}
```

### 2.4 Integration Points

**Consumers of Global State:**

| View/Component | On Symbol Change | On Timeframe Change |
|----------------|------------------|---------------------|
| Chart view | Reloads chart data | Reloads chart data |
| Action view | Pre-fills data config | Pre-fills data config |
| Trade view | **Does NOT change** active sessions | — |
| Data panel | Highlights active symbol | — |

**Register listeners in extension.ts:**

```typescript
const globalState = GlobalState.initialize(context);

globalState.onDidChangeSymbol((symbol) => {
  // Notify Chart view to reload if active
  ChartViewProvider.getInstance()?.onSymbolChanged(symbol);
});

globalState.onDidChangeTimeframe((tf) => {
  // Notify Chart view to reload if active
  ChartViewProvider.getInstance()?.onTimeframeChanged(tf);
});
```

---

## 3. Global Selectors UI

### 3.1 Requirement (V8.1 §2.2.2, §2.2.3)

Window chrome must contain:
- **Symbol/Timeframe selectors** (center-right): `[AAPL ▼][1D ▼]`
- **History button** (right): `[⏱ History ▼]`

### 3.2 Create `src/ui/GlobalSelectors.ts`

**Implementation**: StatusBarItem fallback (based on Phase 0 findings)

```typescript
import * as vscode from 'vscode';
import { GlobalState } from '../core/state/GlobalState';
import { Timeframe } from '../types/market';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];

export class GlobalSelectors {
  private symbolItem: vscode.StatusBarItem;
  private timeframeItem: vscode.StatusBarItem;
  private historyItem: vscode.StatusBarItem;
  private recentSymbols: string[] = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];

  constructor(private context: vscode.ExtensionContext) {
    // Symbol selector (priority 100 = rightish in status bar)
    this.symbolItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.symbolItem.command = 'quantlab.selectSymbol';
    this.symbolItem.tooltip = 'Click to change symbol';

    // Timeframe selector
    this.timeframeItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.timeframeItem.command = 'quantlab.selectTimeframe';
    this.timeframeItem.tooltip = 'Click to change timeframe';

    // History button
    this.historyItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98
    );
    this.historyItem.command = 'quantlab.toggleHistoryDropdown';
    this.historyItem.text = '$(history) History';
    this.historyItem.tooltip = 'View run history';

    this.registerCommands();
    this.updateDisplay();
    this.show();

    // Listen for global state changes
    GlobalState.getInstance().onDidChange(() => this.updateDisplay());
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('quantlab.selectSymbol', () => this.showSymbolPicker()),
      vscode.commands.registerCommand('quantlab.selectTimeframe', () => this.showTimeframePicker())
    );
  }

  private updateDisplay(): void {
    const globalState = GlobalState.getInstance();
    this.symbolItem.text = `$(graph) ${globalState.getSymbol()}`;
    this.timeframeItem.text = globalState.getTimeframe();
  }

  private async showSymbolPicker(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      { label: '$(search) Search...', description: 'Search for a symbol', alwaysShow: true },
      { kind: vscode.QuickPickItemKind.Separator, label: 'Recent' },
      ...this.recentSymbols.map(s => ({ label: s })),
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select or search for a symbol',
    });

    if (!selected) return;

    if (selected.label.includes('Search')) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter symbol ticker',
        placeHolder: 'e.g., AAPL, MSFT, BTC/USD',
      });
      if (input) {
        this.setSymbol(input.toUpperCase());
      }
    } else {
      this.setSymbol(selected.label);
    }
  }

  private setSymbol(symbol: string): void {
    GlobalState.getInstance().setSymbol(symbol);

    // Update recent symbols
    this.recentSymbols = [symbol, ...this.recentSymbols.filter(s => s !== symbol)].slice(0, 10);
    this.context.workspaceState.update('quantlab.recentSymbols', this.recentSymbols);
  }

  private async showTimeframePicker(): Promise<void> {
    const currentTf = GlobalState.getInstance().getTimeframe();

    const items: vscode.QuickPickItem[] = TIMEFRAMES.map(tf => ({
      label: tf,
      description: tf === currentTf ? '(current)' : undefined,
      picked: tf === currentTf,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select timeframe',
    });

    if (selected) {
      GlobalState.getInstance().setTimeframe(selected.label as Timeframe);
    }
  }

  public updateHistoryBadge(count: number): void {
    if (count > 0) {
      this.historyItem.text = `$(history) History (${count})`;
    } else {
      this.historyItem.text = '$(history) History';
    }
  }

  private show(): void {
    this.symbolItem.show();
    this.timeframeItem.show();
    this.historyItem.show();
  }

  dispose(): void {
    this.symbolItem.dispose();
    this.timeframeItem.dispose();
    this.historyItem.dispose();
  }
}
```

---

## 4. History State Manager

### 4.1 Requirement (V8.1 §5.3)

Track all backtest/optimization runs with:
- Unique ID generation
- Status tracking (running, queued, completed, failed, cancelled)
- Strategy association
- Metrics storage
- Artifact paths
- Pinning and tagging

**Storage**: globalState (user-level, not per-workspace)
**Max entries**: 1000 (FIFO eviction, keep pinned)

### 4.2 Create `src/types/history.ts`

```typescript
export type RunType =
  | 'backtest'
  | 'streaming_backtest'
  | 'grid_search'
  | 'bayesian_optimization'
  | 'wfa'
  | 'monte_carlo'
  | 'cpcv'
  | 'pbo'
  | 'deflated_sharpe';

export type RunStatus = 'running' | 'queued' | 'completed' | 'failed' | 'cancelled';

export interface HistoryEntry {
  id: string;                    // "backtest-20260119-abc123"
  type: RunType;
  status: RunStatus;
  strategyPath: string;          // Absolute path to strategy file
  strategyHash: string;          // Git commit hash or content hash
  config: Record<string, any>;   // Run configuration
  startedAt: string;             // ISO date string
  completedAt?: string;          // ISO date string
  progress?: number;             // 0-100
  progressMessage?: string;      // "Processing split 3 of 5..."

  // Results (populated on completion)
  passed?: boolean;
  metrics?: Record<string, number>;
  warnings?: string[];
  errorMessage?: string;

  // Artifacts
  artifactPath?: string;         // Path to result artifacts

  // User state
  pinned: boolean;
  tags: string[];
  viewed: boolean;               // Has user seen this result?
}

export interface HistoryQuery {
  strategyPath?: string;
  type?: RunType;
  status?: RunStatus;
  limit?: number;
  offset?: number;
  pinnedOnly?: boolean;
}
```

### 4.3 Create `src/core/state/HistoryState.ts`

```typescript
import * as vscode from 'vscode';
import { HistoryEntry, HistoryQuery, RunStatus, RunType } from '../../types/history';
import { v4 as uuidv4 } from 'uuid';

const MAX_ENTRIES = 1000;

export class HistoryState {
  private static instance: HistoryState;
  private entries: Map<string, HistoryEntry> = new Map();
  private context: vscode.ExtensionContext;

  // Events
  private readonly _onDidAdd = new vscode.EventEmitter<HistoryEntry>();
  readonly onDidAdd = this._onDidAdd.event;

  private readonly _onDidUpdate = new vscode.EventEmitter<HistoryEntry>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private readonly _onDidDelete = new vscode.EventEmitter<string>();
  readonly onDidDelete = this._onDidDelete.event;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.restore();
  }

  static initialize(context: vscode.ExtensionContext): HistoryState {
    if (!this.instance) {
      this.instance = new HistoryState(context);
    }
    return this.instance;
  }

  static getInstance(): HistoryState {
    if (!this.instance) {
      throw new Error('HistoryState not initialized');
    }
    return this.instance;
  }

  // Generate unique ID
  private generateId(type: RunType): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const short = uuidv4().slice(0, 8);
    return `${type}-${date}-${short}`;
  }

  // Create new entry
  createEntry(params: {
    type: RunType;
    strategyPath: string;
    config: Record<string, any>;
    strategyHash?: string;
  }): HistoryEntry {
    const entry: HistoryEntry = {
      id: this.generateId(params.type),
      type: params.type,
      status: 'queued',
      strategyPath: params.strategyPath,
      strategyHash: params.strategyHash ?? '',
      config: params.config,
      startedAt: new Date().toISOString(),
      pinned: false,
      tags: [],
      viewed: false,
    };

    this.entries.set(entry.id, entry);
    this.enforceMaxEntries();
    this.persist();
    this._onDidAdd.fire(entry);
    this._onDidChange.fire();

    return entry;
  }

  // Get entry by ID
  getEntry(id: string): HistoryEntry | undefined {
    return this.entries.get(id);
  }

  // Update entry
  updateEntry(id: string, updates: Partial<HistoryEntry>): HistoryEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    Object.assign(entry, updates);
    this.persist();
    this._onDidUpdate.fire(entry);
    this._onDidChange.fire();

    return entry;
  }

  // Delete entry
  deleteEntry(id: string): boolean {
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.persist();
      this._onDidDelete.fire(id);
      this._onDidChange.fire();
    }
    return deleted;
  }

  // Query entries
  query(q: HistoryQuery = {}): HistoryEntry[] {
    let results = Array.from(this.entries.values());

    // Apply filters
    if (q.strategyPath) {
      results = results.filter(e => e.strategyPath === q.strategyPath);
    }
    if (q.type) {
      results = results.filter(e => e.type === q.type);
    }
    if (q.status) {
      results = results.filter(e => e.status === q.status);
    }
    if (q.pinnedOnly) {
      results = results.filter(e => e.pinned);
    }

    // Sort by startedAt descending (most recent first)
    results.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );

    // Apply pagination
    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  // Get running jobs
  getRunningJobs(): HistoryEntry[] {
    return this.query({ status: 'running' });
  }

  // Get recent (limit 20)
  getRecent(limit: number = 20): HistoryEntry[] {
    return this.query({ limit });
  }

  // Get by strategy
  getByStrategy(strategyPath: string): HistoryEntry[] {
    return this.query({ strategyPath });
  }

  // Count unviewed completed
  getUnviewedCount(): number {
    return Array.from(this.entries.values())
      .filter(e => e.status === 'completed' && !e.viewed)
      .length;
  }

  // Mark as viewed
  markAsViewed(id: string): void {
    this.updateEntry(id, { viewed: true });
  }

  // Pin/unpin
  togglePin(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.updateEntry(id, { pinned: !entry.pinned });
    }
  }

  // Enforce max entries (FIFO, keep pinned)
  private enforceMaxEntries(): void {
    if (this.entries.size <= MAX_ENTRIES) return;

    const sorted = this.query();
    const unpinned = sorted.filter(e => !e.pinned);

    while (this.entries.size > MAX_ENTRIES && unpinned.length > 0) {
      const oldest = unpinned.pop();
      if (oldest) {
        this.entries.delete(oldest.id);
      }
    }
  }

  // Persistence
  private persist(): void {
    const serialized = Object.fromEntries(this.entries);
    this.context.globalState.update('quantlab.historyEntries', serialized);
  }

  private restore(): void {
    const saved = this.context.globalState.get<Record<string, HistoryEntry>>('quantlab.historyEntries');
    if (saved) {
      this.entries = new Map(Object.entries(saved));
    }
  }
}
```

---

## 5. History Dropdown

### 5.1 Requirement (V8.1 §5.2)

QuickPick-based dropdown showing:
- Running jobs with progress
- Recent completed/failed jobs
- Filter by type
- Actions: Cancel, View, Prioritize

### 5.2 Create `src/panels/history/HistoryDropdown.ts`

```typescript
import * as vscode from 'vscode';
import { HistoryState } from '../../core/state/HistoryState';
import { HistoryEntry, RunStatus } from '../../types/history';

const STATUS_ICONS: Record<RunStatus, string> = {
  running: '$(sync~spin)',
  queued: '$(clock)',
  completed: '$(check)',
  failed: '$(error)',
  cancelled: '$(circle-slash)',
};

export class HistoryDropdown {
  constructor(private context: vscode.ExtensionContext) {
    this.registerCommands();
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('quantlab.toggleHistoryDropdown', () => this.show())
    );
  }

  async show(): Promise<void> {
    const historyState = HistoryState.getInstance();

    const running = historyState.getRunningJobs();
    const recent = historyState.getRecent(15);

    const items: vscode.QuickPickItem[] = [];

    // Running section
    if (running.length > 0) {
      items.push({ label: 'RUNNING', kind: vscode.QuickPickItemKind.Separator });

      for (const entry of running) {
        const progress = entry.progress ?? 0;
        const progressBar = this.renderProgressBar(progress);
        items.push({
          label: `${STATUS_ICONS[entry.status]} ${this.formatType(entry.type)}: ${this.basename(entry.strategyPath)}`,
          description: `${progressBar} ${progress}%`,
          detail: entry.progressMessage,
          buttons: [{ iconPath: new vscode.ThemeIcon('close'), tooltip: 'Cancel' }],
        } as any);
      }
    }

    // Separator
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Group recent by day
    const today = this.getDayString(new Date());
    const yesterday = this.getDayString(new Date(Date.now() - 86400000));

    const todayItems = recent.filter(e => this.getDayString(new Date(e.startedAt)) === today);
    const yesterdayItems = recent.filter(e => this.getDayString(new Date(e.startedAt)) === yesterday);
    const olderItems = recent.filter(e => {
      const day = this.getDayString(new Date(e.startedAt));
      return day !== today && day !== yesterday;
    });

    if (todayItems.length > 0) {
      items.push({ label: 'TODAY', kind: vscode.QuickPickItemKind.Separator });
      items.push(...todayItems.map(e => this.entryToQuickPickItem(e)));
    }

    if (yesterdayItems.length > 0) {
      items.push({ label: 'YESTERDAY', kind: vscode.QuickPickItemKind.Separator });
      items.push(...yesterdayItems.map(e => this.entryToQuickPickItem(e)));
    }

    if (olderItems.length > 0) {
      items.push({ label: 'EARLIER', kind: vscode.QuickPickItemKind.Separator });
      items.push(...olderItems.map(e => this.entryToQuickPickItem(e)));
    }

    // Footer
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '$(list-unordered) Open History Panel',
      alwaysShow: true,
    });

    const quickPick = vscode.window.createQuickPick();
    quickPick.items = items;
    quickPick.placeholder = 'Select a run to view details';
    quickPick.matchOnDescription = true;

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        if (selected.label.includes('Open History Panel')) {
          vscode.commands.executeCommand('quantlab.historyPanel.focus');
        } else {
          const entry = this.findEntryByLabel(selected.label, [...running, ...recent]);
          if (entry) {
            historyState.markAsViewed(entry.id);
            vscode.commands.executeCommand('quantlab.openHistoryEntry', entry.id);
          }
        }
      }
      quickPick.dispose();
    });

    quickPick.show();
  }

  private entryToQuickPickItem(entry: HistoryEntry): vscode.QuickPickItem {
    const icon = STATUS_ICONS[entry.status];
    const metricsStr = entry.metrics
      ? Object.entries(entry.metrics)
          .slice(0, 2)
          .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
          .join(' · ')
      : '';
    const timeAgo = this.formatTimeAgo(new Date(entry.startedAt));

    return {
      label: `${icon} ${this.formatType(entry.type)} #${this.getRunNumber(entry)} — ${this.basename(entry.strategyPath)}`,
      description: metricsStr || (entry.errorMessage ? 'Error' : ''),
      detail: entry.errorMessage || timeAgo,
    };
  }

  private renderProgressBar(progress: number): string {
    const filled = Math.floor(progress / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  private formatType(type: string): string {
    return type.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  private basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  private getDayString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private getRunNumber(entry: HistoryEntry): string {
    return entry.id.split('-').pop()?.slice(0, 4) ?? '0000';
  }

  private formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  private findEntryByLabel(label: string, entries: HistoryEntry[]): HistoryEntry | undefined {
    // Extract run number from label and find matching entry
    const match = label.match(/#([a-f0-9]+)/i);
    if (match) {
      return entries.find(e => e.id.endsWith(match[1]));
    }
    return undefined;
  }
}
```

---

## 6. Activity Bar Panels

### 6.1 Panel Registration in `package.json`

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "quantlab-explorer",
          "title": "Quantlab",
          "icon": "media/icons/quantlab.svg"
        }
      ]
    },
    "views": {
      "quantlab-explorer": [
        {
          "id": "quantlab.dataPanel",
          "name": "Data",
          "icon": "$(graph)"
        },
        {
          "id": "quantlab.resourcesPanel",
          "name": "Resources",
          "icon": "$(library)"
        },
        {
          "id": "quantlab.historyPanel",
          "name": "History",
          "icon": "$(history)"
        },
        {
          "id": "quantlab.tradePanel",
          "name": "Trade",
          "icon": "$(pulse)"
        },
        {
          "id": "quantlab.settingsPanel",
          "name": "Settings",
          "icon": "$(gear)"
        }
      ]
    }
  }
}
```

### 6.2 Data Panel — `src/panels/data/DataPanelProvider.ts`

**Tree Structure:**
```
├── 🔍 Symbol Search
├── ⭐ Watchlists
│   ├── Tech Giants (5)
│   └── [+ New Watchlist]
├── 📋 Universes
│   ├── S&P 500
│   └── NASDAQ 100
└── 🔌 Data Sources
    ├── ● Alpaca (connected)
    └── [+ Add Source]
```

```typescript
import * as vscode from 'vscode';

type DataTreeItem = {
  type: 'section' | 'watchlist' | 'symbol' | 'universe' | 'source' | 'action';
  label: string;
  children?: DataTreeItem[];
  symbol?: string;
  connected?: boolean;
};

export class DataTreeProvider implements vscode.TreeDataProvider<DataTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DataTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private watchlists: Map<string, string[]> = new Map([
    ['Tech Giants', ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META']],
    ['My Portfolio', ['TSLA', 'NVDA']],
  ]);

  getTreeItem(element: DataTreeItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    switch (element.type) {
      case 'section':
        item.iconPath = this.getSectionIcon(element.label);
        break;
      case 'symbol':
        item.command = {
          command: 'quantlab.setGlobalSymbol',
          title: 'Set Symbol',
          arguments: [element.symbol],
        };
        item.contextValue = 'symbol';
        break;
      case 'action':
        item.iconPath = new vscode.ThemeIcon('add');
        break;
    }

    return item;
  }

  getChildren(element?: DataTreeItem): DataTreeItem[] {
    if (!element) {
      return [
        { type: 'section', label: 'Watchlists', children: this.getWatchlistChildren() },
        { type: 'section', label: 'Universes', children: this.getUniverseChildren() },
        { type: 'section', label: 'Data Sources', children: this.getSourceChildren() },
      ];
    }
    return element.children ?? [];
  }

  private getWatchlistChildren(): DataTreeItem[] {
    const items: DataTreeItem[] = [];
    for (const [name, symbols] of this.watchlists) {
      items.push({
        type: 'watchlist',
        label: `${name} (${symbols.length})`,
        children: symbols.map(s => ({ type: 'symbol' as const, label: s, symbol: s })),
      });
    }
    items.push({ type: 'action', label: '+ New Watchlist' });
    return items;
  }

  private getUniverseChildren(): DataTreeItem[] {
    return [
      { type: 'universe', label: 'S&P 500' },
      { type: 'universe', label: 'NASDAQ 100' },
    ];
  }

  private getSourceChildren(): DataTreeItem[] {
    return [
      { type: 'source', label: '● Alpaca (connected)', connected: true },
      { type: 'action', label: '+ Add Source' },
    ];
  }

  private getSectionIcon(label: string): vscode.ThemeIcon {
    switch (label) {
      case 'Watchlists': return new vscode.ThemeIcon('star');
      case 'Universes': return new vscode.ThemeIcon('list-unordered');
      case 'Data Sources': return new vscode.ThemeIcon('plug');
      default: return new vscode.ThemeIcon('folder');
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}
```

### 6.3 Resources Panel — `src/panels/resources/ResourcesTreeProvider.ts`

**Static catalog from JSON:**

```typescript
import * as vscode from 'vscode';

interface ResourceItem {
  id: string;
  label: string;
  type: 'category' | 'test' | 'template' | 'guide';
  description?: string;
  children?: ResourceItem[];
}

const RESOURCES_CATALOG: ResourceItem[] = [
  {
    id: 'backtesting',
    label: 'Backtesting',
    type: 'category',
    children: [
      { id: 'standard_backtest', label: 'Standard Backtest', type: 'test', description: 'Run strategy on historical data' },
      { id: 'streaming_backtest', label: 'Streaming Backtest', type: 'test', description: 'Simulate real-time execution' },
    ],
  },
  {
    id: 'optimization',
    label: 'Optimization',
    type: 'category',
    children: [
      { id: 'grid_search', label: 'Grid Search', type: 'test' },
      { id: 'bayesian_optimization', label: 'Bayesian Optimization', type: 'test' },
    ],
  },
  {
    id: 'overfitting_tests',
    label: 'Overfitting Tests',
    type: 'category',
    children: [
      { id: 'wfa', label: 'Walk-Forward Analysis', type: 'test' },
      { id: 'monte_carlo', label: 'Monte Carlo Simulation', type: 'test' },
      { id: 'cpcv', label: 'Combinatorially Purged CV', type: 'test' },
      { id: 'pbo', label: 'Probability of Overfitting', type: 'test' },
      { id: 'deflated_sharpe', label: 'Deflated Sharpe Ratio', type: 'test' },
    ],
  },
  {
    id: 'templates',
    label: 'Templates',
    type: 'category',
    children: [
      { id: 'momentum_sma', label: 'Momentum (SMA Crossover)', type: 'template' },
      { id: 'mean_reversion', label: 'Mean Reversion (RSI + BB)', type: 'template' },
      { id: 'breakout_atr', label: 'Breakout (ATR-based)', type: 'template' },
    ],
  },
  {
    id: 'guides',
    label: 'Guides',
    type: 'category',
    children: [
      { id: 'getting_started', label: 'Getting Started', type: 'guide' },
      { id: 'writing_strategies', label: 'Writing Strategies', type: 'guide' },
      { id: 'avoiding_overfitting', label: 'Avoiding Overfitting', type: 'guide' },
    ],
  },
];

export class ResourcesTreeProvider implements vscode.TreeDataProvider<ResourceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ResourceItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: ResourceItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.description = element.description;
    item.contextValue = element.type;

    if (element.type !== 'category') {
      item.command = {
        command: 'quantlab.openResource',
        title: 'Open Resource',
        arguments: [element],
      };
    }

    item.iconPath = this.getIcon(element.type);

    return item;
  }

  getChildren(element?: ResourceItem): ResourceItem[] {
    if (!element) {
      return RESOURCES_CATALOG;
    }
    return element.children ?? [];
  }

  private getIcon(type: string): vscode.ThemeIcon {
    switch (type) {
      case 'test': return new vscode.ThemeIcon('beaker');
      case 'template': return new vscode.ThemeIcon('file-code');
      case 'guide': return new vscode.ThemeIcon('book');
      default: return new vscode.ThemeIcon('folder');
    }
  }
}
```

### 6.4 History Panel — `src/panels/history/HistoryTreeProvider.ts`

```typescript
import * as vscode from 'vscode';
import { HistoryState } from '../../core/state/HistoryState';
import { HistoryEntry } from '../../types/history';

type HistoryTreeItem =
  | { type: 'section'; label: string; contextValue?: string }
  | { type: 'entry'; entry: HistoryEntry };

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HistoryTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {
    HistoryState.getInstance().onDidChange(() => this.refresh());
  }

  getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    if (element.type === 'section') {
      return new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
    }

    const entry = element.entry;
    const item = new vscode.TreeItem(
      `${this.getStatusIcon(entry.status)} ${entry.type} — ${this.basename(entry.strategyPath)}`,
      vscode.TreeItemCollapsibleState.None
    );

    item.description = this.formatTimeAgo(new Date(entry.startedAt));
    item.contextValue = 'historyEntry';
    item.command = {
      command: 'quantlab.openHistoryEntry',
      title: 'View Results',
      arguments: [entry.id],
    };

    return item;
  }

  getChildren(element?: HistoryTreeItem): HistoryTreeItem[] {
    const historyState = HistoryState.getInstance();

    if (!element) {
      const sections: HistoryTreeItem[] = [];

      const pinned = historyState.query({ pinnedOnly: true });
      if (pinned.length > 0) {
        sections.push({ type: 'section', label: '📌 Pinned' });
      }

      sections.push({ type: 'section', label: '📅 Recent' });
      return sections;
    }

    if (element.type === 'section') {
      if (element.label.includes('Pinned')) {
        return historyState.query({ pinnedOnly: true }).map(e => ({ type: 'entry', entry: e }));
      }
      if (element.label.includes('Recent')) {
        return historyState.getRecent(50).map(e => ({ type: 'entry', entry: e }));
      }
    }

    return [];
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'failed': return '✗';
      case 'running': return '▶';
      case 'queued': return '⏸';
      case 'cancelled': return '⊘';
      default: return '•';
    }
  }

  private basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  private formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}
```

### 6.5 Trade Panel — `src/panels/trade/TradeTreeProvider.ts`

See structure in V8.1 §4.3.4. Similar pattern to above panels.

### 6.6 Settings Panel — `src/panels/settings/SettingsTreeProvider.ts`

See structure in V8.1 §4.3.5. Links to VS Code settings UI.

---

## 7. Drag-and-Drop Infrastructure

### 7.1 Create Symbol Drag Source

In `DataTreeProvider`, implement `TreeDragAndDropController`:

```typescript
class DataTreeDragDropController implements vscode.TreeDragAndDropController<DataTreeItem> {
  readonly dropMimeTypes: string[] = [];
  readonly dragMimeTypes: string[] = ['text/plain', 'application/quantlab-symbol'];

  async handleDrag(
    source: readonly DataTreeItem[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const symbols = source
      .filter(item => item.type === 'symbol' && item.symbol)
      .map(item => item.symbol!);

    if (symbols.length > 0) {
      dataTransfer.set('text/plain', new vscode.DataTransferItem(symbols.join(',')));
      dataTransfer.set(
        'application/quantlab-symbol',
        new vscode.DataTransferItem(JSON.stringify(symbols))
      );
    }
  }
}
```

### 7.2 Create History Run Drag Source

Similar pattern for history entries:

```typescript
dataTransfer.set(
  'application/quantlab-run',
  new vscode.DataTransferItem(entry.id)
);
```

---

## 8. Verification Plan

### 8.1 Unit Tests

**File**: `test/unit/core/GlobalState.test.ts`

```typescript
describe('GlobalState', () => {
  it('persists symbol across reload', async () => {
    GlobalState.getInstance().setSymbol('MSFT');
    // Simulate reload
    const restored = GlobalState.getInstance().getSymbol();
    expect(restored).toBe('MSFT');
  });

  it('fires onDidChangeSymbol event', () => {
    const spy = jest.fn();
    GlobalState.getInstance().onDidChangeSymbol(spy);
    GlobalState.getInstance().setSymbol('GOOGL');
    expect(spy).toHaveBeenCalledWith('GOOGL');
  });
});
```

**File**: `test/unit/core/HistoryState.test.ts`

```typescript
describe('HistoryState', () => {
  it('creates entry with unique ID', () => {
    const entry = HistoryState.getInstance().createEntry({
      type: 'backtest',
      strategyPath: '/path/to/strategy.py',
      config: {},
    });
    expect(entry.id).toMatch(/^backtest-\d{8}-[a-f0-9]{8}$/);
  });

  it('enforces max entries with FIFO', () => {
    // Create over 1000 entries, verify old unpinned are removed
  });
});
```

**Run Command**: `npm test -- --grep "GlobalState|HistoryState"`

### 8.2 Integration Tests

**File**: `test/integration/globalState.test.ts`

```typescript
describe('Global State Integration', () => {
  it('symbol change updates Chart view', async () => {
    await openChartView('momentum.py');
    await vscode.commands.executeCommand('quantlab.setGlobalSymbol', 'MSFT');
    // Verify chart reloaded with new symbol
    expect(getChartSymbol()).toBe('MSFT');
  });
});
```

**File**: `test/integration/historyDropdown.test.ts`

```typescript
describe('History Dropdown', () => {
  it('shows running jobs with progress', async () => {
    const entry = HistoryState.getInstance().createEntry({
      type: 'backtest',
      strategyPath: '/test.py',
      config: {},
    });
    HistoryState.getInstance().updateEntry(entry.id, {
      status: 'running',
      progress: 50,
    });

    await vscode.commands.executeCommand('quantlab.toggleHistoryDropdown');
    // Verify QuickPick shows running job
  });
});
```

**Run Command**: `npm run test:integration`

### 8.3 Manual Verification Checklist

```
□ Symbol Selector:
  □ Click shows QuickPick with recent symbols
  □ Search option works
  □ Selection updates status bar
  □ Selection persists after reload

□ Timeframe Selector:
  □ Click shows all timeframe options
  □ Selection updates display
  □ Selection persists after reload

□ History Dropdown:
  □ Shows running jobs with progress bars
  □ Shows recent completed/failed jobs
  □ Click on item opens Action view (when implemented)
  □ Cancel button works

□ Activity Bar Panels:
  □ Data panel shows watchlists and symbols
  □ Double-click symbol sets global symbol
  □ Resources panel shows catalog
  □ History panel shows pinned and recent
  □ Trade panel shows session control
  □ Settings panel links to settings

□ Drag-and-Drop:
  □ Drag symbol from Data panel
  □ Drop works when Chart view is ready
```

---

## 9. Exit Gates

### Phase 2 Complete When:

- [ ] Global Symbol/TF selectors work and persist
- [ ] History dropdown shows running/recent, actions work
- [ ] All 5 Activity Bar panels render correctly
- [ ] Basic panel interactions work (double-click, expand/collapse)
- [ ] Drag-and-drop symbols from Data panel works
- [ ] Unit tests pass for GlobalState and HistoryState
- [ ] Integration tests pass for global state changes
- [ ] No regressions in Phase 1 functionality

### Integration Points Ready For Phase 3:

- [ ] GlobalState events ready for Chart view to consume
- [ ] HistoryState ready to receive engine job events
- [ ] Resources panel ready to trigger Action view selection
- [ ] Trade panel ready for session management

---

## Appendix: Extension Activation

Update `src/extension.ts` to initialize Phase 2 components:

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // Phase 1 initialization...

  // Phase 2 initialization
  const globalState = GlobalState.initialize(context);
  const historyState = HistoryState.initialize(context);

  // UI Components
  const globalSelectors = new GlobalSelectors(context);
  const historyDropdown = new HistoryDropdown(context);

  // Activity Bar Panels
  const dataTreeProvider = new DataTreeProvider();
  vscode.window.registerTreeDataProvider('quantlab.dataPanel', dataTreeProvider);

  const resourcesTreeProvider = new ResourcesTreeProvider();
  vscode.window.registerTreeDataProvider('quantlab.resourcesPanel', resourcesTreeProvider);

  const historyTreeProvider = new HistoryTreeProvider();
  vscode.window.registerTreeDataProvider('quantlab.historyPanel', historyTreeProvider);

  // Register symbol command
  context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.setGlobalSymbol', (symbol: string) => {
      globalState.setSymbol(symbol);
    })
  );

  // Update history badge on changes
  historyState.onDidChange(() => {
    globalSelectors.updateHistoryBadge(historyState.getUnviewedCount());
  });

  context.subscriptions.push(globalSelectors);
}
```
