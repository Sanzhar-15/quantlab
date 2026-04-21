# Phase 4: Action View MVP — Detailed Implementation Plan

**Duration**: 3-5 weeks
**Goal**: Implement the Action View as the complete test runner and results surface with 4-state machine
**Prerequisites**: Phase 0, Phase 1, Phase 2, Phase 3 completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Action View Architecture](#2-action-view-architecture)
3. [State Machine Implementation](#3-state-machine-implementation)
4. [Selection State](#4-selection-state)
5. [Configuration State](#5-configuration-state)
6. [Running State](#6-running-state)
7. [Results State](#7-results-state)
8. [Quick Actions System](#8-quick-actions-system)
9. [Resources Integration](#9-resources-integration)
10. [History Integration](#10-history-integration)
11. [View in Chart Flow](#11-view-in-chart-flow)
12. [Engine Communication](#12-engine-communication)
13. [Verification Plan](#13-verification-plan)
14. [Exit Gates](#14-exit-gates)

---

## 1. Overview

### 1.1 What We're Building

Phase 4 implements the Action View — the test execution and results interface:

| Component | Purpose | V8.1 Reference |
|-----------|---------|----------------|
| **Action Webview** | 4-state UI container | §3.1.3 |
| **Selection State** | Quick Actions + Recent runs | §3.1.3 State 1 |
| **Configuration State** | Test setup form | §3.1.3 State 2 |
| **Running State** | Progress + live log | §3.1.3 State 3 |
| **Results State** | Metrics + actions | §3.1.3 State 4 |
| **Quick Actions** | One-click test execution | §3.1.3 |
| **Resources Integration** | Catalog → Action flow | §4.3.2 |
| **History Integration** | Run tracking + artifacts | §5 |

### 1.2 Key V8.1 Invariants (Must Hold)

- Tab indicator: 🟠 Orange stripe (`#D97706`) for Action view
- 4-state machine: Selection → Configuration → Running → Results
- Quick Actions: Backtest, Optimize, Monte Carlo, WFA with defaults
- Resources panel auto-expands when entering Action view
- "View in Chart" loads run artifacts into Chart view
- All runs recorded in History system

### 1.3 File Structure to Create

```
quantlab-extension/src/
├── views/
│   └── action/
│       ├── ActionViewProvider.ts       # CustomTextEditorProvider
│       ├── ActionWebview.ts            # Webview management
│       ├── ActionStateMachine.ts       # State management
│       ├── QuickActions.ts             # Default configurations
│       ├── ResultsExporter.ts          # Export functionality
│       └── webview/
│           ├── index.html              # Webview HTML shell
│           ├── action.ts               # Webview entry point
│           ├── action.css              # Webview styles
│           ├── states/
│           │   ├── selection.ts        # Selection state UI
│           │   ├── configuration.ts    # Configuration state UI
│           │   ├── running.ts          # Running state UI
│           │   └── results.ts          # Results state UI
│           └── components/
│               ├── quickActionCard.ts  # Quick action button
│               ├── configForm.ts       # Dynamic form builder
│               ├── progressBar.ts      # Animated progress
│               ├── liveLog.ts          # Scrolling log viewer
│               └── metricsCard.ts      # Metric display
├── types/
│   ├── action.ts                       # Action state types
│   └── engine.ts                       # Engine message types
└── core/
    └── engine/
        ├── EngineHost.ts               # IPC management
        ├── JobQueue.ts                 # Job tracking
        └── JobRunner.ts                # Job execution
```

---

## 2. Action View Architecture

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ActionViewProvider (CustomTextEditorProvider)              │  │
│  │  • Manages Action view lifecycle                           │  │
│  │  • Creates webview panels                                  │  │
│  │  • Routes messages to state machine                        │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │ postMessage                           │
│                          ▼                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Action Webview (isolated iframe)                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ ActionStateMachine                                   │  │  │
│  │  │  • Selection → Configuration → Running → Results     │  │  │
│  │  │  • State transitions and validation                  │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │ State-Specific UI Components                         │  │  │
│  │  │  • Dynamic rendering based on current state          │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                          │                                       │
│                          ▼                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Engine Host (Separate Process)                             │  │
│  │  • Executes backtests, optimizations, etc.                 │  │
│  │  • Streams progress events                                 │  │
│  │  • Returns results and artifacts                           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Message Protocol

**Extension → Webview:**

```typescript
// Initialize with strategy info
{ type: 'init', strategy: StrategyInfo, recentRuns: HistoryEntry[] }

// State transitions
{ type: 'setState', state: ActionState }

// Update running progress
{ type: 'progress', jobId: string, progress: number, message: string, eta?: string }

// Append log line
{ type: 'log', jobId: string, timestamp: string, message: string }

// Job complete
{ type: 'complete', jobId: string, result: JobResult }

// Job failed
{ type: 'failed', jobId: string, error: string, stack?: string }
```

**Webview → Extension:**

```typescript
// Quick action clicked
{ type: 'quickAction', action: 'backtest' | 'optimize' | 'monteCarlo' | 'wfa' }

// Resource selected
{ type: 'selectResource', resourceId: string }

// Recent run selected
{ type: 'selectRun', runId: string }

// Configuration submitted
{ type: 'runAction', actionType: string, config: ActionConfig }

// Cancel job
{ type: 'cancelJob', jobId: string }

// View results in chart
{ type: 'viewInChart', runId: string }

// Export results
{ type: 'exportResults', runId: string, format: 'json' | 'csv' | 'html' }

// Pin run
{ type: 'pinRun', runId: string }

// Navigate back
{ type: 'back' }

// Re-run with same config
{ type: 'rerun', runId: string }
```

---

## 3. State Machine Implementation

### 3.1 Create `src/types/action.ts`

```typescript
export type ActionStateType = 'selection' | 'configuration' | 'running' | 'results';

export type QuickActionType = 'backtest' | 'optimize' | 'monteCarlo' | 'wfa';

export interface ActionState {
  type: ActionStateType;
  data: SelectionStateData | ConfigurationStateData | RunningStateData | ResultsStateData;
}

export interface SelectionStateData {
  recentRuns: HistoryEntry[];
  quickActionsEnabled: boolean;
}

export interface ConfigurationStateData {
  actionType: string;
  actionName: string;
  schema: ConfigSchema;
  defaults: Record<string, any>;
  values: Record<string, any>;
  validation: ValidationResult;
}

export interface RunningStateData {
  jobId: string;
  actionType: string;
  actionName: string;
  startTime: Date;
  progress: number;
  message: string;
  eta?: string;
  logs: LogEntry[];
}

export interface ResultsStateData {
  runId: string;
  actionType: string;
  actionName: string;
  passed: boolean;
  duration: number;
  completedAt: Date;
  metrics: MetricValue[];
  details: ResultDetail[];
  warnings: string[];
  artifactPath: string;
}

export interface ConfigSchema {
  sections: ConfigSection[];
}

export interface ConfigSection {
  id: string;
  title: string;
  fields: ConfigField[];
}

export interface ConfigField {
  id: string;
  label: string;
  type: 'number' | 'select' | 'date' | 'dateRange' | 'checkbox' | 'radio';
  default: any;
  options?: { value: any; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  helpText?: string;
}

export interface MetricValue {
  id: string;
  label: string;
  value: number | string;
  format?: 'number' | 'percent' | 'currency' | 'ratio';
  visualBar?: number; // 0-1 for progress-style display
  status?: 'good' | 'warning' | 'bad';
}

export interface ResultDetail {
  id: string;
  title: string;
  type: 'table' | 'chart' | 'text';
  data: any;
  collapsed?: boolean;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  level?: 'info' | 'warn' | 'error';
}

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}
```

### 3.2 Create `src/views/action/ActionStateMachine.ts`

```typescript
import * as vscode from 'vscode';
import { 
  ActionState, 
  ActionStateType, 
  SelectionStateData,
  ConfigurationStateData,
  RunningStateData,
  ResultsStateData 
} from '../../types/action';

export class ActionStateMachine {
  private currentState: ActionState;
  private stateHistory: ActionState[] = [];

  private readonly _onStateChange = new vscode.EventEmitter<ActionState>();
  readonly onStateChange = this._onStateChange.event;

  constructor() {
    this.currentState = this.createInitialState();
  }

  getState(): ActionState {
    return this.currentState;
  }

  // Transition to Selection state
  toSelection(recentRuns: HistoryEntry[]): void {
    this.pushState();
    this.currentState = {
      type: 'selection',
      data: {
        recentRuns,
        quickActionsEnabled: true,
      } as SelectionStateData
    };
    this.emitChange();
  }

  // Transition to Configuration state
  toConfiguration(actionType: string, schema: ConfigSchema, defaults: Record<string, any>): void {
    this.pushState();
    this.currentState = {
      type: 'configuration',
      data: {
        actionType,
        actionName: this.getActionName(actionType),
        schema,
        defaults,
        values: { ...defaults },
        validation: { valid: true, errors: {} },
      } as ConfigurationStateData
    };
    this.emitChange();
  }

  // Update configuration values
  updateConfiguration(values: Record<string, any>): void {
    if (this.currentState.type !== 'configuration') return;
    
    const data = this.currentState.data as ConfigurationStateData;
    data.values = { ...data.values, ...values };
    data.validation = this.validateConfiguration(data.schema, data.values);
    this.emitChange();
  }

  // Transition to Running state
  toRunning(jobId: string, actionType: string): void {
    this.pushState();
    this.currentState = {
      type: 'running',
      data: {
        jobId,
        actionType,
        actionName: this.getActionName(actionType),
        startTime: new Date(),
        progress: 0,
        message: 'Starting...',
        logs: [],
      } as RunningStateData
    };
    this.emitChange();
  }

  // Update running progress
  updateProgress(progress: number, message: string, eta?: string): void {
    if (this.currentState.type !== 'running') return;
    
    const data = this.currentState.data as RunningStateData;
    data.progress = progress;
    data.message = message;
    if (eta) data.eta = eta;
    this.emitChange();
  }

  // Append log entry
  appendLog(timestamp: string, message: string, level?: 'info' | 'warn' | 'error'): void {
    if (this.currentState.type !== 'running') return;
    
    const data = this.currentState.data as RunningStateData;
    data.logs.push({ timestamp, message, level });
    this.emitChange();
  }

  // Transition to Results state
  toResults(result: ResultsStateData): void {
    this.pushState();
    this.currentState = {
      type: 'results',
      data: result
    };
    this.emitChange();
  }

  // Go back to previous state
  back(): boolean {
    if (this.stateHistory.length === 0) return false;
    
    this.currentState = this.stateHistory.pop()!;
    this.emitChange();
    return true;
  }

  // Check if can go back
  canGoBack(): boolean {
    return this.stateHistory.length > 0;
  }

  private createInitialState(): ActionState {
    return {
      type: 'selection',
      data: {
        recentRuns: [],
        quickActionsEnabled: true,
      } as SelectionStateData
    };
  }

  private pushState(): void {
    // Don't push running state to history (can't go back to running)
    if (this.currentState.type !== 'running') {
      this.stateHistory.push({ ...this.currentState });
    }
    // Limit history depth
    if (this.stateHistory.length > 10) {
      this.stateHistory.shift();
    }
  }

  private emitChange(): void {
    this._onStateChange.fire(this.currentState);
  }

  private getActionName(actionType: string): string {
    const names: Record<string, string> = {
      backtest: 'Backtest',
      optimize: 'Optimization',
      monteCarlo: 'Monte Carlo Simulation',
      wfa: 'Walk-Forward Analysis',
      gridSearch: 'Grid Search',
      bayesian: 'Bayesian Optimization',
      genetic: 'Genetic Algorithm',
      cpcv: 'Combinatorially Purged CV',
      pbo: 'Probability of Overfitting',
      deflatedSharpe: 'Deflated Sharpe Ratio',
    };
    return names[actionType] ?? actionType;
  }

  private validateConfiguration(schema: ConfigSchema, values: Record<string, any>): ValidationResult {
    const errors: Record<string, string> = {};
    
    for (const section of schema.sections) {
      for (const field of section.fields) {
        const value = values[field.id];
        
        if (field.required && (value === undefined || value === null || value === '')) {
          errors[field.id] = `${field.label} is required`;
          continue;
        }
        
        if (field.type === 'number' && value !== undefined) {
          if (field.min !== undefined && value < field.min) {
            errors[field.id] = `${field.label} must be at least ${field.min}`;
          }
          if (field.max !== undefined && value > field.max) {
            errors[field.id] = `${field.label} must be at most ${field.max}`;
          }
        }
      }
    }
    
    return { valid: Object.keys(errors).length === 0, errors };
  }
}
```

---

## 4. Selection State

### 4.1 UI Layout (V8.1 §3.1.3 State 1)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   QUICK ACTIONS                                                             │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│   │     ▶      │  │     ⚡     │  │     🎲     │  │     📈     │           │
│   │  Backtest  │  │  Optimize  │  │   Monte    │  │    WFA     │           │
│   │            │  │            │  │   Carlo    │  │            │           │
│   └────────────┘  └────────────┘  └────────────┘  └────────────┘           │
│                                                                             │
│   Quick Actions run with default settings using the global symbol/TF.      │
│   For advanced configuration, select from Resources panel.                  │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   MORE FROM RESOURCES                                                       │
│   Select a test or analysis from the Resources panel (auto-expanded).       │
│                                                                             │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                             │
│   RECENT FOR THIS STRATEGY                                                  │
│   ├── ✓ Backtest #52 — 2 hours ago — Sharpe: 1.24        [View] [Re-run]   │
│   ├── ✓ WFA #8 — Yesterday — Stability: 0.72             [View] [Re-run]   │
│   └── ✗ Backtest #51 — 2 days ago — Error                [View Logs]       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Create `src/views/action/webview/states/selection.ts`

```typescript
import { SelectionStateData, QuickActionType } from '../../../../types/action';
import { HistoryEntry } from '../../../../types/history';

const QUICK_ACTIONS: { type: QuickActionType; icon: string; label: string; description: string }[] = [
  { type: 'backtest', icon: '▶', label: 'Backtest', description: 'Run strategy on historical data' },
  { type: 'optimize', icon: '⚡', label: 'Optimize', description: 'Find optimal parameters' },
  { type: 'monteCarlo', icon: '🎲', label: 'Monte Carlo', description: 'Simulate random variations' },
  { type: 'wfa', icon: '📈', label: 'WFA', description: 'Walk-forward validation' },
];

export function renderSelectionState(container: HTMLElement, data: SelectionStateData): void {
  container.innerHTML = `
    <div class="selection-state">
      <!-- Quick Actions -->
      <section class="quick-actions-section">
        <h2>Quick Actions</h2>
        <div class="quick-actions-grid">
          ${QUICK_ACTIONS.map(action => `
            <button class="quick-action-card" data-action="${action.type}" 
                    ${data.quickActionsEnabled ? '' : 'disabled'}>
              <span class="quick-action-icon">${action.icon}</span>
              <span class="quick-action-label">${action.label}</span>
            </button>
          `).join('')}
        </div>
        <p class="quick-actions-hint">
          Quick Actions run with default settings using the global symbol/TF.
          For advanced configuration, select from Resources panel.
        </p>
      </section>

      <hr class="divider" />

      <!-- Resources prompt -->
      <section class="resources-section">
        <h2>More from Resources</h2>
        <p>Select a test or analysis from the Resources panel (auto-expanded).</p>
      </section>

      <hr class="divider" />

      <!-- Recent runs -->
      <section class="recent-section">
        <h2>Recent for This Strategy</h2>
        ${data.recentRuns.length === 0 
          ? '<p class="empty-state">No recent runs for this strategy.</p>'
          : renderRecentRuns(data.recentRuns)}
      </section>
    </div>
  `;

  // Attach event listeners
  container.querySelectorAll('.quick-action-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action') as QuickActionType;
      postMessage({ type: 'quickAction', action });
    });
  });

  container.querySelectorAll('.recent-run-view').forEach(btn => {
    btn.addEventListener('click', () => {
      const runId = btn.getAttribute('data-run-id')!;
      postMessage({ type: 'selectRun', runId });
    });
  });

  container.querySelectorAll('.recent-run-rerun').forEach(btn => {
    btn.addEventListener('click', () => {
      const runId = btn.getAttribute('data-run-id')!;
      postMessage({ type: 'rerun', runId });
    });
  });
}

function renderRecentRuns(runs: HistoryEntry[]): string {
  return `
    <ul class="recent-runs-list">
      ${runs.slice(0, 5).map(run => `
        <li class="recent-run-item ${run.status === 'failed' ? 'failed' : ''}">
          <span class="run-status">${run.status === 'completed' ? '✓' : '✗'}</span>
          <span class="run-info">
            <span class="run-name">${run.type} #${run.id.split('-').pop()}</span>
            <span class="run-time">${formatRelativeTime(run.completedAt!)}</span>
            ${run.status === 'completed' && run.metrics?.sharpe 
              ? `<span class="run-metric">Sharpe: ${run.metrics.sharpe.toFixed(2)}</span>` 
              : ''}
            ${run.status === 'failed' 
              ? `<span class="run-error">Error</span>` 
              : ''}
          </span>
          <span class="run-actions">
            <button class="recent-run-view" data-run-id="${run.id}">
              ${run.status === 'failed' ? 'View Logs' : 'View'}
            </button>
            ${run.status === 'completed' 
              ? `<button class="recent-run-rerun" data-run-id="${run.id}">Re-run</button>` 
              : ''}
          </span>
        </li>
      `).join('')}
    </ul>
  `;
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}
```

---

## 5. Configuration State

### 5.1 UI Layout (V8.1 §3.1.3 State 2)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS                                          [← Back]  │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   CONFIGURATION                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Number of splits        [5        ▼]                                │   │
│   │ Training ratio          [0.7      ▼]    (70% train, 30% test)       │   │
│   │ Optimization metric     [Sharpe Ratio ▼]                            │   │
│   │ Min trades per split    [10         ]                               │   │
│   │ Stability threshold     [0.5      ▼]    (minimum to pass)           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   DATA                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Symbol                  [AAPL      ▼]    (from global)              │   │
│   │ Timeframe               [1D        ▼]    (from global)              │   │
│   │ Date range              [2020-01-01] to [2024-12-31]                │   │
│   │ Data source             [Alpaca    ▼]                               │   │
│   │ ☑ Pin data revision (for reproducibility)                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   STRATEGY PARAMETERS                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ○ Use code defaults                                                 │   │
│   │ ○ Use current Chart view overrides                                  │   │
│   │ ● Specify for this run:                                             │   │
│   │   fast_period           [10       ]                                 │   │
│   │   slow_period           [20       ]                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│                                                    [▶ Run Walk-Forward]     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Create `src/views/action/webview/states/configuration.ts`

```typescript
import { ConfigurationStateData, ConfigSchema, ConfigSection, ConfigField } from '../../../../types/action';

export function renderConfigurationState(container: HTMLElement, data: ConfigurationStateData): void {
  container.innerHTML = `
    <div class="configuration-state">
      <!-- Header -->
      <header class="config-header">
        <h1>${data.actionName}</h1>
        <button class="back-button" id="back-btn">← Back</button>
      </header>

      <hr class="title-divider" />

      <!-- Form -->
      <form id="config-form" class="config-form">
        ${data.schema.sections.map(section => renderSection(section, data)).join('')}

        <!-- Submit -->
        <div class="form-actions">
          <button type="submit" class="run-button" 
                  ${data.validation.valid ? '' : 'disabled'}>
            ▶ Run ${data.actionName}
          </button>
        </div>
      </form>
    </div>
  `;

  // Attach event listeners
  document.getElementById('back-btn')?.addEventListener('click', () => {
    postMessage({ type: 'back' });
  });

  document.getElementById('config-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const formData = collectFormData(data.schema);
    postMessage({ type: 'runAction', actionType: data.actionType, config: formData });
  });

  // Live validation on change
  container.querySelectorAll('input, select').forEach(input => {
    input.addEventListener('change', () => {
      const formData = collectFormData(data.schema);
      postMessage({ type: 'updateConfig', values: formData });
    });
  });
}

function renderSection(section: ConfigSection, data: ConfigurationStateData): string {
  return `
    <section class="config-section">
      <h2>${section.title}</h2>
      <div class="section-fields">
        ${section.fields.map(field => renderField(field, data)).join('')}
      </div>
    </section>
  `;
}

function renderField(field: ConfigField, data: ConfigurationStateData): string {
  const value = data.values[field.id] ?? field.default;
  const error = data.validation.errors[field.id];
  const errorClass = error ? 'has-error' : '';

  let input = '';

  switch (field.type) {
    case 'number':
      input = `
        <input type="number" id="${field.id}" name="${field.id}" 
               value="${value}" 
               ${field.min !== undefined ? `min="${field.min}"` : ''} 
               ${field.max !== undefined ? `max="${field.max}"` : ''} 
               ${field.step !== undefined ? `step="${field.step}"` : ''} 
               ${field.required ? 'required' : ''} />
      `;
      break;

    case 'select':
      input = `
        <select id="${field.id}" name="${field.id}" ${field.required ? 'required' : ''}>
          ${field.options?.map(opt => `
            <option value="${opt.value}" ${opt.value === value ? 'selected' : ''}>
              ${opt.label}
            </option>
          `).join('')}
        </select>
      `;
      break;

    case 'checkbox':
      input = `
        <input type="checkbox" id="${field.id}" name="${field.id}" 
               ${value ? 'checked' : ''} />
      `;
      break;

    case 'date':
      input = `
        <input type="date" id="${field.id}" name="${field.id}" 
               value="${value}" ${field.required ? 'required' : ''} />
      `;
      break;

    case 'dateRange':
      input = `
        <div class="date-range">
          <input type="date" id="${field.id}_start" name="${field.id}_start" 
                 value="${value?.start || ''}" />
          <span>to</span>
          <input type="date" id="${field.id}_end" name="${field.id}_end" 
                 value="${value?.end || ''}" />
        </div>
      `;
      break;

    case 'radio':
      input = `
        <div class="radio-group">
          ${field.options?.map(opt => `
            <label class="radio-option">
              <input type="radio" name="${field.id}" value="${opt.value}" 
                     ${opt.value === value ? 'checked' : ''} />
              ${opt.label}
            </label>
          `).join('')}
        </div>
      `;
      break;
  }

  return `
    <div class="form-field ${errorClass}">
      <label for="${field.id}">${field.label}</label>
      ${input}
      ${field.helpText ? `<span class="help-text">${field.helpText}</span>` : ''}
      ${error ? `<span class="error-text">${error}</span>` : ''}
    </div>
  `;
}

function collectFormData(schema: ConfigSchema): Record<string, any> {
  const data: Record<string, any> = {};
  
  for (const section of schema.sections) {
    for (const field of section.fields) {
      const element = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement;
      
      if (field.type === 'checkbox') {
        data[field.id] = (element as HTMLInputElement).checked;
      } else if (field.type === 'dateRange') {
        const startEl = document.getElementById(`${field.id}_start`) as HTMLInputElement;
        const endEl = document.getElementById(`${field.id}_end`) as HTMLInputElement;
        data[field.id] = { start: startEl.value, end: endEl.value };
      } else if (field.type === 'number') {
        data[field.id] = parseFloat(element.value);
      } else {
        data[field.id] = element.value;
      }
    }
  }
  
  return data;
}
```

---

## 6. Running State

### 6.1 UI Layout (V8.1 §3.1.3 State 3)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS                                 [Cancel] [← Back]   │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   Status: ● RUNNING                         Run ID: wfa-2026011942          │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  45%      │   │
│   │                                                                     │   │
│   │ Processing split 3 of 5...                                          │   │
│   │ Elapsed: 1m 23s │ Estimated remaining: 1m 45s                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   LIVE LOG                                                      [▼ Expand] │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ [10:45:32] Starting Walk-Forward Analysis                           │   │
│   │ [10:45:33] Split 1: Training 2020-01 → 2021-02                      │   │
│   │ [10:45:45] Split 1: Optimization complete, best Sharpe: 1.45        │   │
│   │ [10:45:46] Split 1: Testing 2021-02 → 2021-06                       │   │
│   │ [10:45:52] Split 1: OOS Sharpe: 1.12                                │   │
│   │ [10:45:53] Split 2: Training 2021-02 → 2022-03                      │   │
│   │ ...                                                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Create `src/views/action/webview/states/running.ts`

```typescript
import { RunningStateData, LogEntry } from '../../../../types/action';

let logExpanded = true;

export function renderRunningState(container: HTMLElement, data: RunningStateData): void {
  const elapsed = formatDuration(Date.now() - new Date(data.startTime).getTime());

  container.innerHTML = `
    <div class="running-state">
      <!-- Header -->
      <header class="running-header">
        <h1>${data.actionName}</h1>
        <div class="header-actions">
          <button class="cancel-button" id="cancel-btn">Cancel</button>
        </div>
      </header>

      <hr class="title-divider" />

      <!-- Status -->
      <div class="status-bar">
        <span class="status-indicator running">● RUNNING</span>
        <span class="run-id">Run ID: ${data.jobId}</span>
      </div>

      <!-- Progress -->
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${data.progress}%"></div>
        </div>
        <div class="progress-text">${data.progress}%</div>
      </div>

      <div class="progress-details">
        <span class="progress-message">${data.message}</span>
        <span class="progress-timing">
          Elapsed: ${elapsed}
          ${data.eta ? ` │ Estimated remaining: ${data.eta}` : ''}
        </span>
      </div>

      <!-- Live Log -->
      <div class="log-section">
        <div class="log-header">
          <h2>Live Log</h2>
          <button class="log-toggle" id="log-toggle">
            ${logExpanded ? '▲ Collapse' : '▼ Expand'}
          </button>
        </div>
        <div class="log-container ${logExpanded ? 'expanded' : 'collapsed'}" id="log-container">
          ${data.logs.map(renderLogEntry).join('')}
        </div>
      </div>
    </div>
  `;

  // Attach event listeners
  document.getElementById('cancel-btn')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to cancel this job?')) {
      postMessage({ type: 'cancelJob', jobId: data.jobId });
    }
  });

  document.getElementById('log-toggle')?.addEventListener('click', () => {
    logExpanded = !logExpanded;
    const container = document.getElementById('log-container');
    if (container) {
      container.classList.toggle('expanded', logExpanded);
      container.classList.toggle('collapsed', !logExpanded);
    }
    const toggle = document.getElementById('log-toggle');
    if (toggle) {
      toggle.textContent = logExpanded ? '▲ Collapse' : '▼ Expand';
    }
  });

  // Auto-scroll log to bottom
  const logContainer = document.getElementById('log-container');
  if (logContainer) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

function renderLogEntry(entry: LogEntry): string {
  const levelClass = entry.level || 'info';
  return `
    <div class="log-entry ${levelClass}">
      <span class="log-timestamp">[${entry.timestamp}]</span>
      <span class="log-message">${escapeHtml(entry.message)}</span>
    </div>
  `;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

---

## 7. Results State

### 7.1 UI Layout (V8.1 §3.1.3 State 4)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   WALK-FORWARD ANALYSIS — RESULTS              [↻ Re-run] [← New Analysis] │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  ✓ PASSED                                    Completed: 2 min ago   │   │
│   │  Run ID: wfa-2026011942                      Duration: 3m 08s       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   SUMMARY METRICS                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Avg Out-of-Sample Sharpe     1.24        ████████████░░░░          │   │
│   │ Stability Score              0.72        ██████████░░░░░░          │   │
│   │ Degradation Ratio            0.85        ███████████░░░░░          │   │
│   │ Total Trades                 142                                    │   │
│   │ Avg Trades per Split         28.4                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   SPLIT DETAILS                                                 [▼ Expand] │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ Split │ Train Period       │ Test Period        │IS Sharpe│OOS Sharpe│ │
│   │───────┼────────────────────┼────────────────────┼─────────┼──────────│ │
│   │   1   │ 2020-01 → 2021-02  │ 2021-02 → 2021-06  │  1.45   │   1.12   │ │
│   │   2   │ 2021-02 → 2022-03  │ 2022-03 → 2022-07  │  1.38   │   1.28   │ │
│   │  ...                                                                │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   WARNINGS                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ⚠ Split 4 has 18 trades (below recommended minimum of 20)          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
│   │ 📈 View in   │ │ 💾 Export    │ │ 📌 Pin Run   │ │ 🔗 Compare   │      │
│   │    Chart     │ │    Results   │ │              │ │              │      │
│   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Create `src/views/action/webview/states/results.ts`

```typescript
import { ResultsStateData, MetricValue, ResultDetail } from '../../../../types/action';

export function renderResultsState(container: HTMLElement, data: ResultsStateData): void {
  container.innerHTML = `
    <div class="results-state">
      <!-- Header -->
      <header class="results-header">
        <h1>${data.actionName} — Results</h1>
        <div class="header-actions">
          <button class="rerun-button" id="rerun-btn">↻ Re-run</button>
          <button class="new-analysis-button" id="new-btn">← New Analysis</button>
        </div>
      </header>

      <hr class="title-divider" />

      <!-- Status Card -->
      <div class="status-card ${data.passed ? 'passed' : 'failed'}">
        <div class="status-main">
          <span class="status-icon">${data.passed ? '✓' : '✗'}</span>
          <span class="status-text">${data.passed ? 'PASSED' : 'FAILED'}</span>
        </div>
        <div class="status-details">
          <div>Run ID: ${data.runId}</div>
          <div>Completed: ${formatRelativeTime(data.completedAt)}</div>
          <div>Duration: ${formatDuration(data.duration)}</div>
        </div>
      </div>

      <!-- Summary Metrics -->
      <section class="metrics-section">
        <h2>Summary Metrics</h2>
        <div class="metrics-grid">
          ${data.metrics.map(renderMetric).join('')}
        </div>
      </section>

      <!-- Details -->
      ${data.details.map(renderDetail).join('')}

      <!-- Warnings -->
      ${data.warnings.length > 0 ? `
        <section class="warnings-section">
          <h2>Warnings</h2>
          <ul class="warnings-list">
            ${data.warnings.map(w => `<li class="warning-item">⚠ ${escapeHtml(w)}</li>`).join('')}
          </ul>
        </section>
      ` : ''}

      <!-- Action Buttons -->
      <div class="result-actions">
        <button class="action-button primary" id="view-chart-btn">
          📈 View in Chart
        </button>
        <button class="action-button" id="export-btn">
          💾 Export Results
        </button>
        <button class="action-button" id="pin-btn">
          📌 Pin Run
        </button>
        <button class="action-button" id="compare-btn">
          🔗 Compare
        </button>
      </div>
    </div>
  `;

  // Attach event listeners
  document.getElementById('rerun-btn')?.addEventListener('click', () => {
    postMessage({ type: 'rerun', runId: data.runId });
  });

  document.getElementById('new-btn')?.addEventListener('click', () => {
    postMessage({ type: 'back' });
  });

  document.getElementById('view-chart-btn')?.addEventListener('click', () => {
    postMessage({ type: 'viewInChart', runId: data.runId });
  });

  document.getElementById('export-btn')?.addEventListener('click', () => {
    showExportMenu(data.runId);
  });

  document.getElementById('pin-btn')?.addEventListener('click', () => {
    postMessage({ type: 'pinRun', runId: data.runId });
  });

  document.getElementById('compare-btn')?.addEventListener('click', () => {
    postMessage({ type: 'addToCompare', runId: data.runId });
  });

  // Collapsible details
  container.querySelectorAll('.detail-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const section = (e.target as HTMLElement).closest('.detail-section');
      section?.classList.toggle('collapsed');
    });
  });
}

function renderMetric(metric: MetricValue): string {
  const formattedValue = formatMetricValue(metric);
  const statusClass = metric.status || '';

  return `
    <div class="metric-card ${statusClass}">
      <div class="metric-label">${metric.label}</div>
      <div class="metric-value">${formattedValue}</div>
      ${metric.visualBar !== undefined ? `
        <div class="metric-bar">
          <div class="metric-bar-fill" style="width: ${metric.visualBar * 100}%"></div>
        </div>
      ` : ''}
    </div>
  `;
}

function formatMetricValue(metric: MetricValue): string {
  if (typeof metric.value === 'string') return metric.value;

  switch (metric.format) {
    case 'percent':
      return `${(metric.value * 100).toFixed(1)}%`;
    case 'currency':
      return `$${metric.value.toLocaleString()}`;
    case 'ratio':
      return metric.value.toFixed(2);
    default:
      return typeof metric.value === 'number' ? metric.value.toFixed(2) : String(metric.value);
  }
}

function renderDetail(detail: ResultDetail): string {
  const collapsedClass = detail.collapsed ? 'collapsed' : '';

  return `
    <section class="detail-section ${collapsedClass}">
      <div class="detail-header">
        <h2>${detail.title}</h2>
        <button class="detail-toggle">${detail.collapsed ? '▼ Expand' : '▲ Collapse'}</button>
      </div>
      <div class="detail-content">
        ${renderDetailContent(detail)}
      </div>
    </section>
  `;
}

function renderDetailContent(detail: ResultDetail): string {
  switch (detail.type) {
    case 'table':
      return renderTable(detail.data);
    case 'chart':
      return `<div class="embedded-chart" data-chart-config='${JSON.stringify(detail.data)}'></div>`;
    case 'text':
      return `<pre class="text-detail">${escapeHtml(detail.data)}</pre>`;
    default:
      return '';
  }
}

function renderTable(data: { headers: string[]; rows: any[][] }): string {
  return `
    <table class="detail-table">
      <thead>
        <tr>${data.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${data.rows.map(row => `
          <tr>${row.map(cell => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function showExportMenu(runId: string): void {
  // Simple dropdown menu
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.innerHTML = `
    <button data-format="json">Export as JSON</button>
    <button data-format="csv">Export as CSV</button>
    <button data-format="html">Export as HTML Report</button>
  `;

  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-format') as 'json' | 'csv' | 'html';
      postMessage({ type: 'exportResults', runId, format });
      menu.remove();
    });
  });

  document.body.appendChild(menu);
  
  // Position near export button
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    const rect = exportBtn.getBoundingClientRect();
    menu.style.position = 'absolute';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
  }

  // Close on click outside
  document.addEventListener('click', function handler(e) {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener('click', handler);
    }
  });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return `${diffHours} hours ago`;
  return new Date(date).toLocaleDateString();
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

---

## 8. Quick Actions System

### 8.1 Create `src/views/action/QuickActions.ts`

```typescript
import { ConfigSchema, ConfigSection } from '../../types/action';
import { GlobalState } from '../../core/state/GlobalState';

export interface QuickActionConfig {
  type: string;
  name: string;
  icon: string;
  description: string;
  defaultConfig: Record<string, any>;
  schema: ConfigSchema;
}

export const QUICK_ACTIONS: QuickActionConfig[] = [
  {
    type: 'backtest',
    name: 'Backtest',
    icon: '▶',
    description: 'Run strategy on historical data',
    defaultConfig: {
      parameterSource: 'code',
      symbol: 'global',
      timeframe: 'global',
      dateRange: 'max',
      pinDataRevision: false,
    },
    schema: {
      sections: [
        {
          id: 'data',
          title: 'Data',
          fields: [
            {
              id: 'symbol',
              label: 'Symbol',
              type: 'select',
              default: 'global',
              options: [
                { value: 'global', label: 'Use global symbol' },
                // Dynamic options added at runtime
              ],
            },
            {
              id: 'timeframe',
              label: 'Timeframe',
              type: 'select',
              default: 'global',
              options: [
                { value: 'global', label: 'Use global timeframe' },
                { value: '1m', label: '1 Minute' },
                { value: '5m', label: '5 Minutes' },
                { value: '15m', label: '15 Minutes' },
                { value: '1H', label: '1 Hour' },
                { value: '4H', label: '4 Hours' },
                { value: '1D', label: '1 Day' },
              ],
            },
            {
              id: 'dateRange',
              label: 'Date Range',
              type: 'dateRange',
              default: { start: '2020-01-01', end: '2024-12-31' },
            },
            {
              id: 'pinDataRevision',
              label: 'Pin data revision (for reproducibility)',
              type: 'checkbox',
              default: false,
            },
          ],
        },
        {
          id: 'parameters',
          title: 'Strategy Parameters',
          fields: [
            {
              id: 'parameterSource',
              label: 'Parameter Source',
              type: 'radio',
              default: 'code',
              options: [
                { value: 'code', label: 'Use code defaults' },
                { value: 'chart', label: 'Use current Chart view overrides' },
                { value: 'specify', label: 'Specify for this run' },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    type: 'optimize',
    name: 'Optimization',
    icon: '⚡',
    description: 'Find optimal parameters via grid search',
    defaultConfig: {
      method: 'grid',
      metric: 'sharpe',
      useParamRanges: true,
    },
    schema: {
      sections: [
        {
          id: 'optimization',
          title: 'Optimization Settings',
          fields: [
            {
              id: 'method',
              label: 'Method',
              type: 'select',
              default: 'grid',
              options: [
                { value: 'grid', label: 'Grid Search' },
                { value: 'bayesian', label: 'Bayesian Optimization' },
                { value: 'genetic', label: 'Genetic Algorithm' },
              ],
            },
            {
              id: 'metric',
              label: 'Optimize For',
              type: 'select',
              default: 'sharpe',
              options: [
                { value: 'sharpe', label: 'Sharpe Ratio' },
                { value: 'sortino', label: 'Sortino Ratio' },
                { value: 'calmar', label: 'Calmar Ratio' },
                { value: 'profit', label: 'Total Profit' },
                { value: 'winRate', label: 'Win Rate' },
              ],
            },
            {
              id: 'useParamRanges',
              label: 'Use parameter ranges from ql.param()',
              type: 'checkbox',
              default: true,
            },
          ],
        },
        // Data section reused
      ],
    },
  },
  {
    type: 'monteCarlo',
    name: 'Monte Carlo Simulation',
    icon: '🎲',
    description: 'Simulate random variations of trade sequence',
    defaultConfig: {
      simulations: 1000,
      method: 'shuffleTrades',
      confidenceInterval: 0.95,
    },
    schema: {
      sections: [
        {
          id: 'monteCarlo',
          title: 'Monte Carlo Settings',
          fields: [
            {
              id: 'simulations',
              label: 'Number of Simulations',
              type: 'number',
              default: 1000,
              min: 100,
              max: 100000,
              step: 100,
            },
            {
              id: 'method',
              label: 'Simulation Method',
              type: 'select',
              default: 'shuffleTrades',
              options: [
                { value: 'shuffleTrades', label: 'Shuffle Trade Order' },
                { value: 'resample', label: 'Resample with Replacement' },
                { value: 'bootstrap', label: 'Block Bootstrap' },
              ],
            },
            {
              id: 'confidenceInterval',
              label: 'Confidence Interval',
              type: 'select',
              default: 0.95,
              options: [
                { value: 0.90, label: '90%' },
                { value: 0.95, label: '95%' },
                { value: 0.99, label: '99%' },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    type: 'wfa',
    name: 'Walk-Forward Analysis',
    icon: '📈',
    description: 'Validate strategy with rolling out-of-sample testing',
    defaultConfig: {
      splits: 5,
      trainRatio: 0.7,
      metric: 'sharpe',
      minTradesPerSplit: 10,
      stabilityThreshold: 0.5,
    },
    schema: {
      sections: [
        {
          id: 'wfa',
          title: 'Walk-Forward Settings',
          fields: [
            {
              id: 'splits',
              label: 'Number of Splits',
              type: 'select',
              default: 5,
              options: [
                { value: 3, label: '3' },
                { value: 5, label: '5' },
                { value: 7, label: '7' },
                { value: 10, label: '10' },
              ],
            },
            {
              id: 'trainRatio',
              label: 'Training Ratio',
              type: 'select',
              default: 0.7,
              options: [
                { value: 0.6, label: '60% train / 40% test' },
                { value: 0.7, label: '70% train / 30% test' },
                { value: 0.8, label: '80% train / 20% test' },
              ],
            },
            {
              id: 'metric',
              label: 'Optimization Metric',
              type: 'select',
              default: 'sharpe',
              options: [
                { value: 'sharpe', label: 'Sharpe Ratio' },
                { value: 'sortino', label: 'Sortino Ratio' },
                { value: 'profit', label: 'Total Profit' },
              ],
            },
            {
              id: 'minTradesPerSplit',
              label: 'Min Trades per Split',
              type: 'number',
              default: 10,
              min: 1,
              max: 100,
            },
            {
              id: 'stabilityThreshold',
              label: 'Stability Threshold',
              type: 'select',
              default: 0.5,
              options: [
                { value: 0.3, label: '0.3 (Lenient)' },
                { value: 0.5, label: '0.5 (Moderate)' },
                { value: 0.7, label: '0.7 (Strict)' },
              ],
              helpText: 'Minimum stability score to pass',
            },
          ],
        },
      ],
    },
  },
];

export function getQuickAction(type: string): QuickActionConfig | undefined {
  return QUICK_ACTIONS.find(a => a.type === type);
}

export function resolveQuickActionConfig(type: string): Record<string, any> {
  const action = getQuickAction(type);
  if (!action) return {};

  const config = { ...action.defaultConfig };
  const globalState = GlobalState.getInstance();

  // Resolve 'global' values
  if (config.symbol === 'global') {
    config.symbol = globalState.getSymbol();
  }
  if (config.timeframe === 'global') {
    config.timeframe = globalState.getTimeframe();
  }

  return config;
}
```

---

## 9. Resources Integration

### 9.1 Resources → Action Flow

When user double-clicks a test in Resources panel:

```typescript
// In ResourcesTreeProvider.ts (Phase 2)
onItemSelected(resourceId: string): void {
  // Emit event that ActionViewProvider listens to
  this._onResourceSelected.fire(resourceId);
}

// In ActionViewProvider.ts
constructor(context: vscode.ExtensionContext) {
  // Listen for Resources panel selections
  ResourcesTreeProvider.getInstance().onResourceSelected((resourceId) => {
    this.handleResourceSelection(resourceId);
  });
}

async handleResourceSelection(resourceId: string): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return;

  // Switch to Action view if not already
  const viewManager = ViewManager.getInstance();
  const currentView = viewManager.getCurrentView(activeEditor);
  
  if (currentView !== 'action') {
    await viewManager.switchView(activeEditor, 'action');
  }

  // Load the resource configuration
  const resource = ResourcesCatalog.getResource(resourceId);
  if (resource) {
    this.stateMachine.toConfiguration(
      resource.type,
      resource.schema,
      resource.defaults
    );
  }
}
```

### 9.2 Auto-Expand Resources Panel

When entering Action view, expand Resources panel:

```typescript
// In ViewManager.ts
async switchView(editor: vscode.TextEditor, view: ViewType): Promise<void> {
  // ... existing logic ...

  // Auto-expand panel based on view
  if (view === 'action') {
    await vscode.commands.executeCommand('quantlab.resourcesPanel.focus');
  } else if (view === 'trade') {
    await vscode.commands.executeCommand('quantlab.tradePanel.focus');
  }
}
```

---

## 10. History Integration

### 10.1 Recording Runs

```typescript
// In ActionViewProvider.ts
async runAction(actionType: string, config: Record<string, any>): Promise<void> {
  const document = this.getActiveDocument();
  if (!document) return;

  // Create history entry
  const runId = this.generateRunId(actionType);
  const historyEntry: HistoryEntry = {
    id: runId,
    type: actionType as RunType,
    status: 'running',
    strategyPath: document.uri.fsPath,
    strategyHash: this.computeHash(document.getText()),
    config,
    startedAt: new Date(),
    progress: 0,
    pinned: false,
    tags: [],
  };

  // Add to history
  HistoryState.getInstance().addEntry(historyEntry);

  // Transition to running state
  this.stateMachine.toRunning(runId, actionType);

  // Start job via engine
  this.engineHost.runJob({
    id: runId,
    type: actionType,
    strategyPath: document.uri.fsPath,
    config,
  });
}

// Handle engine progress events
onJobProgress(event: JobProgressEvent): void {
  // Update state machine
  this.stateMachine.updateProgress(event.progress, event.message, event.eta);

  // Update history entry
  HistoryState.getInstance().updateEntry(event.jobId, {
    progress: event.progress,
  });
}

// Handle engine completion
onJobComplete(event: JobCompleteEvent): void {
  // Update history entry
  HistoryState.getInstance().updateEntry(event.jobId, {
    status: 'completed',
    completedAt: new Date(),
    metrics: event.result.metrics,
    artifactPath: event.result.artifactPath,
    passed: event.result.passed,
  });

  // Transition to results state
  this.stateMachine.toResults({
    runId: event.jobId,
    actionType: event.type,
    actionName: this.getActionName(event.type),
    passed: event.result.passed,
    duration: Date.now() - event.startTime,
    completedAt: new Date(),
    metrics: event.result.metrics,
    details: event.result.details,
    warnings: event.result.warnings,
    artifactPath: event.result.artifactPath,
  });

  // Show notification
  vscode.window.showInformationMessage(
    `${this.getActionName(event.type)} completed`,
    'View Results'
  ).then(selection => {
    if (selection === 'View Results') {
      // Focus the Action view
    }
  });
}

// Handle engine failure
onJobFailed(event: JobFailedEvent): void {
  // Update history entry
  HistoryState.getInstance().updateEntry(event.jobId, {
    status: 'failed',
    completedAt: new Date(),
    errorMessage: event.error,
  });

  // Show error in results state
  this.stateMachine.toResults({
    runId: event.jobId,
    actionType: event.type,
    actionName: this.getActionName(event.type),
    passed: false,
    duration: Date.now() - event.startTime,
    completedAt: new Date(),
    metrics: [],
    details: [{
      id: 'error',
      title: 'Error Details',
      type: 'text',
      data: event.error + (event.stack ? '\n\n' + event.stack : ''),
    }],
    warnings: [],
    artifactPath: '',
  });
}
```

---

## 11. View in Chart Flow

### 11.1 Implementation

When user clicks "View in Chart" in Results state:

```typescript
// In ActionViewProvider.ts
async viewInChart(runId: string): Promise<void> {
  const entry = HistoryState.getInstance().getEntry(runId);
  if (!entry || !entry.artifactPath) {
    vscode.window.showErrorMessage('No artifacts available for this run');
    return;
  }

  // Load artifacts
  const artifacts = await this.loadArtifacts(entry.artifactPath);

  // Get the active editor (should be the strategy file)
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  // Switch to Chart view
  const viewManager = ViewManager.getInstance();
  await viewManager.switchView(editor, 'chart');

  // Send artifacts to Chart view
  ChartViewProvider.getInstance().loadRunArtifacts(
    editor.document.uri,
    artifacts,
    {
      runId,
      runName: `${entry.type} #${runId.split('-').pop()}`,
      completedAt: entry.completedAt!,
    }
  );
}

async loadArtifacts(artifactPath: string): Promise<RunArtifacts> {
  // Load from artifact storage
  const fs = vscode.workspace.fs;
  const uri = vscode.Uri.file(artifactPath);
  
  const signalsData = await fs.readFile(vscode.Uri.joinPath(uri, 'signals.json'));
  const equityData = await fs.readFile(vscode.Uri.joinPath(uri, 'equity.json'));
  
  return {
    signals: JSON.parse(Buffer.from(signalsData).toString()),
    equityCurve: JSON.parse(Buffer.from(equityData).toString()),
  };
}
```

### 11.2 Chart View Integration

```typescript
// In ChartViewProvider.ts
loadRunArtifacts(
  documentUri: vscode.Uri,
  artifacts: RunArtifacts,
  runInfo: { runId: string; runName: string; completedAt: Date }
): void {
  const panel = this.getWebviewForDocument(documentUri);
  if (!panel) return;

  // Send to webview
  panel.webview.postMessage({
    type: 'loadArtifacts',
    signals: artifacts.signals,
    equityCurve: artifacts.equityCurve,
    banner: {
      text: `Showing results from ${runInfo.runName}`,
      timestamp: runInfo.completedAt,
    },
  });
}
```

---

## 12. Engine Communication

### 12.1 Create `src/core/engine/EngineHost.ts`

```typescript
import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

export interface JobRequest {
  id: string;
  type: string;
  strategyPath: string;
  config: Record<string, any>;
}

export interface JobProgressEvent {
  jobId: string;
  progress: number;
  message: string;
  eta?: string;
}

export interface JobCompleteEvent {
  jobId: string;
  type: string;
  startTime: number;
  result: {
    passed: boolean;
    metrics: MetricValue[];
    details: ResultDetail[];
    warnings: string[];
    artifactPath: string;
  };
}

export interface JobFailedEvent {
  jobId: string;
  type: string;
  startTime: number;
  error: string;
  stack?: string;
}

export class EngineHost {
  private static instance: EngineHost;
  private process: ChildProcess | null = null;
  private pendingJobs: Map<string, JobRequest> = new Map();

  // Events
  private readonly _onProgress = new vscode.EventEmitter<JobProgressEvent>();
  readonly onProgress = this._onProgress.event;

  private readonly _onComplete = new vscode.EventEmitter<JobCompleteEvent>();
  readonly onComplete = this._onComplete.event;

  private readonly _onFailed = new vscode.EventEmitter<JobFailedEvent>();
  readonly onFailed = this._onFailed.event;

  static getInstance(): EngineHost {
    if (!this.instance) {
      this.instance = new EngineHost();
    }
    return this.instance;
  }

  async start(): Promise<void> {
    if (this.process) return;

    // Spawn Python engine process
    this.process = spawn('python', ['-m', 'quantlab.engine'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      this.handleEngineMessage(data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      console.error('Engine error:', data.toString());
    });

    this.process.on('exit', (code) => {
      console.log('Engine exited with code:', code);
      this.process = null;
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  runJob(request: JobRequest): void {
    if (!this.process) {
      this._onFailed.fire({
        jobId: request.id,
        type: request.type,
        startTime: Date.now(),
        error: 'Engine not running',
      });
      return;
    }

    this.pendingJobs.set(request.id, request);

    // Send to engine
    this.sendToEngine({
      type: 'runJob',
      ...request,
    });
  }

  cancelJob(jobId: string): void {
    this.sendToEngine({
      type: 'cancelJob',
      jobId,
    });
  }

  private sendToEngine(message: any): void {
    if (this.process?.stdin) {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  private handleEngineMessage(data: string): void {
    // Parse newline-delimited JSON messages
    const lines = data.trim().split('\n');
    
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        this.routeMessage(message);
      } catch (e) {
        console.error('Failed to parse engine message:', line);
      }
    }
  }

  private routeMessage(message: any): void {
    switch (message.type) {
      case 'progress':
        this._onProgress.fire({
          jobId: message.jobId,
          progress: message.progress,
          message: message.message,
          eta: message.eta,
        });
        break;

      case 'complete':
        const request = this.pendingJobs.get(message.jobId);
        this.pendingJobs.delete(message.jobId);
        
        this._onComplete.fire({
          jobId: message.jobId,
          type: request?.type || 'unknown',
          startTime: message.startTime,
          result: message.result,
        });
        break;

      case 'failed':
        const failedRequest = this.pendingJobs.get(message.jobId);
        this.pendingJobs.delete(message.jobId);
        
        this._onFailed.fire({
          jobId: message.jobId,
          type: failedRequest?.type || 'unknown',
          startTime: message.startTime,
          error: message.error,
          stack: message.stack,
        });
        break;

      case 'log':
        // Route to appropriate webview
        break;
    }
  }
}
```

---

## 13. Verification Plan

### 13.1 Unit Tests

```typescript
// test/unit/action/ActionStateMachine.test.ts
describe('ActionStateMachine', () => {
  it('starts in selection state', () => {
    const sm = new ActionStateMachine();
    expect(sm.getState().type).toBe('selection');
  });

  it('transitions to configuration', () => {
    const sm = new ActionStateMachine();
    sm.toConfiguration('backtest', mockSchema, mockDefaults);
    expect(sm.getState().type).toBe('configuration');
  });

  it('validates configuration', () => {
    const sm = new ActionStateMachine();
    sm.toConfiguration('backtest', schemaWithRequired, {});
    const state = sm.getState().data as ConfigurationStateData;
    expect(state.validation.valid).toBe(false);
  });

  it('transitions to running', () => {
    const sm = new ActionStateMachine();
    sm.toConfiguration('backtest', mockSchema, mockDefaults);
    sm.toRunning('job-123', 'backtest');
    expect(sm.getState().type).toBe('running');
  });

  it('updates progress', () => {
    const sm = new ActionStateMachine();
    sm.toRunning('job-123', 'backtest');
    sm.updateProgress(50, 'Halfway done', '1m 30s');
    const state = sm.getState().data as RunningStateData;
    expect(state.progress).toBe(50);
  });

  it('transitions to results', () => {
    const sm = new ActionStateMachine();
    sm.toRunning('job-123', 'backtest');
    sm.toResults(mockResults);
    expect(sm.getState().type).toBe('results');
  });

  it('supports back navigation', () => {
    const sm = new ActionStateMachine();
    sm.toConfiguration('backtest', mockSchema, mockDefaults);
    sm.back();
    expect(sm.getState().type).toBe('selection');
  });

  it('does not allow back from running', () => {
    const sm = new ActionStateMachine();
    sm.toConfiguration('backtest', mockSchema, mockDefaults);
    sm.toRunning('job-123', 'backtest');
    sm.back(); // Should not go back to configuration
    expect(sm.getState().type).toBe('selection');
  });
});

// test/unit/action/QuickActions.test.ts
describe('QuickActions', () => {
  it('resolves global symbol', () => {
    GlobalState.getInstance().setSymbol('MSFT');
    const config = resolveQuickActionConfig('backtest');
    expect(config.symbol).toBe('MSFT');
  });

  it('resolves global timeframe', () => {
    GlobalState.getInstance().setTimeframe('1H');
    const config = resolveQuickActionConfig('backtest');
    expect(config.timeframe).toBe('1H');
  });
});
```

### 13.2 Integration Tests

```typescript
// test/integration/actionView.test.ts
describe('Action View', () => {
  it('quick backtest runs end-to-end', async () => {
    await openStrategyFile('momentum.py');
    await vscode.commands.executeCommand('quantlab.switchToAction');

    // Click quick backtest
    await clickQuickAction('backtest');

    // Wait for job to complete (mock engine)
    await waitForJobComplete();

    // Verify results shown
    const state = getActionViewState();
    expect(state.type).toBe('results');
    expect(state.data.metrics).toBeDefined();
  });

  it('configuration validates required fields', async () => {
    await openActionView('momentum.py');
    await selectResource('wfa');

    // Clear a required field
    await clearField('splits');

    // Verify validation error
    const state = getActionViewState();
    expect(state.data.validation.valid).toBe(false);
    expect(state.data.validation.errors.splits).toBeDefined();
  });

  it('View in Chart loads run artifacts', async () => {
    await runBacktest('momentum.py');
    await clickResultsAction('viewInChart');

    expect(getCurrentView()).toBe('chart');
    expect(getChartBanner()).toContain('Showing results from');
    expect(getChartSignals().length).toBeGreaterThan(0);
  });

  it('Resources panel selection opens configuration', async () => {
    await openStrategyFile('momentum.py');
    
    // Double-click WFA in Resources panel
    await doubleClickResource('wfa');

    expect(getCurrentView()).toBe('action');
    const state = getActionViewState();
    expect(state.type).toBe('configuration');
    expect(state.data.actionType).toBe('wfa');
  });

  it('run recorded in History', async () => {
    await runBacktest('momentum.py');
    
    const history = HistoryState.getInstance().getRecentEntries();
    expect(history[0].type).toBe('backtest');
    expect(history[0].status).toBe('completed');
  });
});
```

### 13.3 Manual Verification Checklist

| Test | Steps | Expected Result |
|------|-------|-----------------|
| **Quick Actions display** | 1. Open strategy 2. Switch to Action | 4 Quick Action cards visible |
| **Quick Backtest** | 1. Click Backtest card | Transitions to Running → Results |
| **Configuration form** | 1. Click Optimize card 2. Review form | All fields render correctly |
| **Validation** | 1. Clear required field 2. Check button | Run button disabled, error shown |
| **Running progress** | 1. Start WFA | Progress bar animates, log updates |
| **Cancel job** | 1. Start job 2. Click Cancel | Job cancelled, returns to Selection |
| **Results display** | 1. Complete backtest | Metrics, details, warnings shown |
| **View in Chart** | 1. Complete backtest 2. Click View in Chart | Chart shows signals, banner visible |
| **Export** | 1. Complete backtest 2. Export as JSON | File saved with results |
| **Pin run** | 1. Complete backtest 2. Click Pin | Run appears in History pinned section |
| **Re-run** | 1. Complete backtest 2. Click Re-run | Same config, new job starts |
| **Back navigation** | 1. Configuration 2. Click Back | Returns to Selection |
| **Resources integration** | 1. Double-click Monte Carlo in Resources | Action view shows Monte Carlo config |
| **Recent runs** | 1. Run 3 backtests 2. Check Recent section | All 3 runs listed |
| **History dropdown** | 1. Run backtest 2. Check History dropdown | Run appears in dropdown |

---

## 14. Exit Gates

### 14.1 Phase 4 Completion Criteria

- [ ] **State Machine**
  - [ ] All 4 states render correctly
  - [ ] Transitions work (Selection → Config → Running → Results)
  - [ ] Back navigation works (except from Running)
  - [ ] State persists in TabViewState

- [ ] **Quick Actions**
  - [ ] All 4 cards display and are clickable
  - [ ] Global symbol/TF resolved correctly
  - [ ] Quick action with defaults runs immediately

- [ ] **Configuration**
  - [ ] Dynamic form renders from schema
  - [ ] Validation displays errors inline
  - [ ] Parameter source options work (code/chart/specify)
  - [ ] Run button disabled when invalid

- [ ] **Running**
  - [ ] Progress bar updates smoothly
  - [ ] ETA displays correctly
  - [ ] Live log scrolls to bottom
  - [ ] Cancel works with confirmation

- [ ] **Results**
  - [ ] Metrics display with visual bars
  - [ ] Details tables render
  - [ ] Warnings display
  - [ ] All action buttons work

- [ ] **Integration**
  - [ ] Resources panel double-click opens Action config
  - [ ] Resources panel auto-expands on Action view entry
  - [ ] View in Chart loads artifacts correctly
  - [ ] History records all runs
  - [ ] Tab stripe shows orange (#D97706)

### 14.2 Performance Targets

| Metric | Target |
|--------|--------|
| Action view load | < 200ms |
| State transition | < 50ms |
| Form validation | < 100ms |
| Progress update render | < 16.67ms |
| Log append | < 10ms |

---

## Appendix A: Action View CSS (`action.css`)

```css
:root {
  --bg-primary: var(--vscode-editor-background);
  --bg-secondary: var(--vscode-sideBar-background);
  --text-primary: var(--vscode-editor-foreground);
  --text-secondary: var(--vscode-descriptionForeground);
  --border-color: var(--vscode-panel-border);
  --accent-orange: #D97706;
  --status-success: #10B981;
  --status-error: #EF4444;
  --status-warning: #F59E0B;
}

body {
  margin: 0;
  padding: 16px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--vscode-font-family);
}

/* Quick Actions Grid */
.quick-actions-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.quick-action-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.quick-action-card:hover {
  border-color: var(--accent-orange);
  background: rgba(217, 119, 6, 0.1);
}

.quick-action-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.quick-action-label {
  font-weight: 500;
}

/* Progress Bar */
.progress-bar {
  height: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-orange);
  transition: width 0.3s ease;
}

/* Status Card */
.status-card {
  display: flex;
  justify-content: space-between;
  padding: 16px 24px;
  border-radius: 8px;
  margin-bottom: 24px;
}

.status-card.passed {
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid var(--status-success);
}

.status-card.failed {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--status-error);
}

.status-icon {
  font-size: 24px;
  margin-right: 8px;
}

/* Metrics Grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.metric-card {
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.metric-label {
  font-size: 0.9em;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.metric-value {
  font-size: 1.5em;
  font-weight: 600;
}

.metric-bar {
  height: 4px;
  background: var(--border-color);
  border-radius: 2px;
  margin-top: 8px;
}

.metric-bar-fill {
  height: 100%;
  background: var(--accent-orange);
}

/* Log Container */
.log-container {
  max-height: 300px;
  overflow-y: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  background: var(--bg-secondary);
  padding: 12px;
  border-radius: 4px;
}

.log-container.collapsed {
  max-height: 100px;
}

.log-entry {
  margin-bottom: 4px;
}

.log-timestamp {
  color: var(--text-secondary);
}

.log-entry.warn {
  color: var(--status-warning);
}

.log-entry.error {
  color: var(--status-error);
}

/* Action Buttons */
.result-actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.action-button {
  padding: 10px 20px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-button:hover {
  border-color: var(--accent-orange);
}

.action-button.primary {
  background: var(--accent-orange);
  border-color: var(--accent-orange);
  color: white;
}

.action-button.primary:hover {
  background: #b45309;
}
```

---

## Appendix B: Dependency Order

Build components in this order:

1. **Types** (`action.ts`) — No dependencies
2. **ActionStateMachine** — Depends on types
3. **QuickActions** — Depends on types, GlobalState
4. **EngineHost** — Independent (or stubbed)
5. **Webview states** (selection, configuration, running, results)
6. **ActionViewProvider** — Integrates all above
7. **Resources integration** — Connect to Phase 2 Resources panel
8. **History integration** — Connect to Phase 2 History system

---

*End of Phase 4: Action View MVP — Detailed Implementation Plan*
