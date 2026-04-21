# Phase 6: Polish & Compliance — Detailed Implementation Plan

**Duration**: 2-4 weeks
**Goal**: Complete remaining V8.1 requirements including design tokens, accessibility, error handling, notifications, drag-and-drop, and onboarding
**Prerequisites**: Phase 0, Phase 1, Phase 2, Phase 3, Phase 4, Phase 5 completed

---

## Table of Contents

1. [Overview](#1-overview)
2. [Visual Design Tokens](#2-visual-design-tokens)
3. [Notifications System](#3-notifications-system)
4. [Error States and Recovery](#4-error-states-and-recovery)
5. [Drag-and-Drop System](#5-drag-and-drop-system)
6. [Onboarding Flow](#6-onboarding-flow)
7. [Accessibility Implementation](#7-accessibility-implementation)
8. [Theme Integration](#8-theme-integration)
9. [Performance Optimization](#9-performance-optimization)
10. [Final Polish](#10-final-polish)
11. [Verification Plan](#11-verification-plan)
12. [Exit Gates](#12-exit-gates)

---

## 1. Overview

### 1.1 What We're Building

Phase 6 completes all cross-cutting concerns and polish tasks:

| Component | Purpose | V8.1 Reference |
|-----------|---------|----------------|
| **Design Tokens** | CSS variables for consistent theming | §8 |
| **Notifications** | Toast system + badges + sounds | §11 |
| **Error Handling** | Recovery flows for all views | §10 |
| **Drag-and-Drop** | Symbol, file, and run dragging | §12 |
| **Onboarding** | First launch + feature discovery | §13 |
| **Accessibility** | Keyboard nav + screen reader + motion | §9 |

### 1.2 Key V8.1 Invariants (Must Hold)

- All design tokens use `--ql-` prefix
- Notifications auto-dismiss after 5 seconds (except errors)
- Toast position: bottom-right corner
- Drag sources: Data panel symbols, History runs, Explorer files
- First launch shows welcome modal with 3 options
- All UI is keyboard-navigable
- `prefers-reduced-motion` disables animations

### 1.3 File Structure to Create

```
quantlab-extension/src/
├── ui/
│   ├── tokens/
│   │   ├── tokens.css              # CSS custom properties
│   │   ├── themes.ts               # Theme detection and switching
│   │   └── ThemeProvider.ts        # Theme context for webviews
│   ├── notifications/
│   │   ├── NotificationManager.ts  # Central notification orchestrator
│   │   ├── ToastService.ts         # Toast display logic
│   │   ├── BadgeManager.ts         # Badge updates for buttons/panels
│   │   └── SoundPlayer.ts          # Notification sounds
│   ├── errors/
│   │   ├── ErrorBoundary.ts        # Webview error catching
│   │   ├── ErrorRecovery.ts        # Recovery flow logic
│   │   ├── ErrorModal.ts           # Global error modal
│   │   └── ViewErrorStates.ts      # Per-view error displays
│   ├── dragdrop/
│   │   ├── DragDropManager.ts      # Drag operation orchestration
│   │   ├── SymbolDragSource.ts     # Data panel symbol dragging
│   │   ├── RunDragSource.ts        # History run dragging
│   │   ├── DropTargets.ts          # Drop target registration
│   │   └── DragGhost.ts            # Custom drag preview
│   ├── onboarding/
│   │   ├── OnboardingManager.ts    # State and flow control
│   │   ├── WelcomeModal.ts         # First launch modal
│   │   ├── TooltipGuide.ts         # Contextual tooltips
│   │   └── FeatureDiscovery.ts     # Trigger-based tips
│   └── accessibility/
│       ├── KeyboardManager.ts      # Focus management
│       ├── AriaLabeler.ts          # Dynamic ARIA labels
│       ├── ReducedMotion.ts        # Animation control
│       └── ScreenReaderAnnouncer.ts # Live announcements
├── types/
│   ├── notifications.ts            # Notification types
│   ├── errors.ts                   # Error types
│   └── onboarding.ts               # Onboarding state types
└── assets/
    └── sounds/
        ├── fill.mp3                # Trade fill sound
        ├── alert.mp3               # Risk alert sound
        └── complete.mp3            # Job complete sound
```

---

## 2. Visual Design Tokens

### 2.1 Create `src/ui/tokens/tokens.css`

```css
/**
 * Quantlab Design Tokens
 * V8.1 §8 - Visual Design Tokens
 * 
 * Usage: Import in all webviews and extension stylesheets
 * All tokens use --ql- prefix to avoid conflicts with VS Code tokens
 */

:root {
  /* ===== View Indicators (§8.1) ===== */
  --ql-view-chart: #059669;          /* Darker green for accessibility */
  --ql-view-action: #D97706;         /* Darker orange */
  --ql-view-trade: #DC2626;          /* Darker red */
  --ql-view-stripe-width: 3px;
  
  /* ===== Status Colors (§8.2) ===== */
  /* Run status */
  --ql-status-running: #3B82F6;      /* Blue */
  --ql-status-queued: #6B7280;       /* Gray */
  --ql-status-completed: #10B981;    /* Green */
  --ql-status-failed: #EF4444;       /* Red */
  --ql-status-cancelled: #F59E0B;    /* Amber */
  
  /* Trading P&L */
  --ql-pnl-positive: #10B981;        /* Green */
  --ql-pnl-negative: #EF4444;        /* Red */
  --ql-pnl-neutral: #6B7280;         /* Gray */
  
  /* Complexity indicator (§3.6) */
  --ql-complexity-safe: #10B981;     /* Green - full functionality */
  --ql-complexity-partial: #F59E0B;  /* Amber - limited functionality */
  --ql-complexity-view-only: #EF4444; /* Red - artifacts only */
  
  /* ===== Typography (§8.3) ===== */
  --ql-font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  --ql-font-size-metric: 1.25rem;
  --ql-font-weight-metric: 600;
  --ql-font-size-small: 0.75rem;
  --ql-font-size-base: 0.875rem;
  --ql-font-size-large: 1rem;
  
  /* ===== Spacing ===== */
  --ql-space-xs: 4px;
  --ql-space-sm: 8px;
  --ql-space-md: 12px;
  --ql-space-lg: 16px;
  --ql-space-xl: 24px;
  --ql-space-2xl: 32px;
  
  /* ===== Border Radius ===== */
  --ql-radius-sm: 2px;
  --ql-radius-md: 4px;
  --ql-radius-lg: 8px;
  
  /* ===== Shadows ===== */
  --ql-shadow-toast: 0 4px 12px rgba(0, 0, 0, 0.15);
  --ql-shadow-modal: 0 8px 32px rgba(0, 0, 0, 0.24);
  --ql-shadow-dropdown: 0 2px 8px rgba(0, 0, 0, 0.12);
  
  /* ===== Transitions ===== */
  --ql-transition-fast: 150ms ease;
  --ql-transition-normal: 250ms ease;
  --ql-transition-slow: 350ms ease;
  
  /* ===== Z-Index Layers ===== */
  --ql-z-dropdown: 100;
  --ql-z-tooltip: 200;
  --ql-z-toast: 300;
  --ql-z-modal: 400;
  
  /* ===== Toast Dimensions ===== */
  --ql-toast-width: 360px;
  --ql-toast-max-height: 200px;
  --ql-toast-offset: 16px;
  
  /* ===== Drag and Drop ===== */
  --ql-drag-opacity: 0.8;
  --ql-drop-highlight: rgba(59, 130, 246, 0.2);
  --ql-drop-border: 2px dashed var(--ql-status-running);
}

/* ===== Reduced Motion Support (§9.4) ===== */
@media (prefers-reduced-motion: reduce) {
  :root {
    --ql-transition-fast: 0ms;
    --ql-transition-normal: 0ms;
    --ql-transition-slow: 0ms;
  }
}

/* ===== High Contrast Mode ===== */
@media (prefers-contrast: more) {
  :root {
    --ql-view-chart: #047857;
    --ql-view-action: #B45309;
    --ql-view-trade: #B91C1C;
    --ql-view-stripe-width: 4px;
  }
}
```

### 2.2 Create `src/ui/tokens/themes.ts`

```typescript
import * as vscode from 'vscode';

export type QuantlabTheme = 'light' | 'dark' | 'high-contrast';

/**
 * Detects current VS Code theme and maps to Quantlab theme
 */
export function detectTheme(): QuantlabTheme {
  const kind = vscode.window.activeColorTheme.kind;
  
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.Dark:
      return 'dark';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast';
    default:
      return 'dark';
  }
}

/**
 * Subscribes to theme changes and notifies callback
 */
export function onThemeChange(callback: (theme: QuantlabTheme) => void): vscode.Disposable {
  return vscode.window.onDidChangeActiveColorTheme(() => {
    callback(detectTheme());
  });
}

/**
 * Gets CSS variables for current theme
 * These supplement the base tokens with theme-specific values
 */
export function getThemeVariables(theme: QuantlabTheme): Record<string, string> {
  const common = {
    '--ql-view-chart': '#059669',
    '--ql-view-action': '#D97706',
    '--ql-view-trade': '#DC2626',
  };

  switch (theme) {
    case 'light':
      return {
        ...common,
        '--ql-bg-primary': '#ffffff',
        '--ql-bg-secondary': '#f3f4f6',
        '--ql-text-primary': '#111827',
        '--ql-text-secondary': '#6b7280',
        '--ql-border': '#e5e7eb',
      };
    case 'dark':
      return {
        ...common,
        '--ql-bg-primary': '#1f2937',
        '--ql-bg-secondary': '#111827',
        '--ql-text-primary': '#f9fafb',
        '--ql-text-secondary': '#9ca3af',
        '--ql-border': '#374151',
      };
    case 'high-contrast':
      return {
        ...common,
        '--ql-view-chart': '#047857',
        '--ql-view-action': '#B45309',
        '--ql-view-trade': '#B91C1C',
        '--ql-bg-primary': '#000000',
        '--ql-bg-secondary': '#0a0a0a',
        '--ql-text-primary': '#ffffff',
        '--ql-text-secondary': '#d4d4d4',
        '--ql-border': '#ffffff',
      };
  }
}
```

### 2.3 Create `src/ui/tokens/ThemeProvider.ts`

```typescript
import * as vscode from 'vscode';
import { detectTheme, getThemeVariables, onThemeChange, QuantlabTheme } from './themes';

/**
 * Provides theme tokens to webviews
 */
export class ThemeProvider {
  private currentTheme: QuantlabTheme;
  private webviews: Set<vscode.Webview> = new Set();
  private disposable: vscode.Disposable;

  constructor() {
    this.currentTheme = detectTheme();
    this.disposable = onThemeChange((theme) => {
      this.currentTheme = theme;
      this.notifyWebviews();
    });
  }

  /**
   * Registers a webview to receive theme updates
   */
  registerWebview(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);
    this.sendThemeToWebview(webview);
    
    return {
      dispose: () => this.webviews.delete(webview),
    };
  }

  /**
   * Gets inline CSS style string for current theme
   */
  getInlineStyles(): string {
    const vars = getThemeVariables(this.currentTheme);
    return Object.entries(vars)
      .map(([key, value]) => `${key}: ${value};`)
      .join(' ');
  }

  /**
   * Gets tokens CSS file content
   */
  getTokensCSS(): string {
    // In production, this would load from tokens.css
    // For now, return the inline version
    return `
      :root {
        ${this.getInlineStyles()}
      }
    `;
  }

  private sendThemeToWebview(webview: vscode.Webview): void {
    webview.postMessage({
      type: 'themeChange',
      theme: this.currentTheme,
      variables: getThemeVariables(this.currentTheme),
    });
  }

  private notifyWebviews(): void {
    this.webviews.forEach((webview) => this.sendThemeToWebview(webview));
  }

  dispose(): void {
    this.disposable.dispose();
    this.webviews.clear();
  }
}
```

---

## 3. Notifications System

### 3.1 Create `src/types/notifications.ts`

```typescript
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export type NotificationTrigger =
  | 'jobComplete'
  | 'jobFailed'
  | 'tradeExecuted'
  | 'riskAlert'
  | 'sessionStatus'
  | 'connectionStatus';

export interface NotificationAction {
  id: string;
  label: string;
  command?: string;
  args?: any[];
}

export interface QuantlabNotification {
  id: string;
  type: NotificationType;
  trigger: NotificationTrigger;
  title: string;
  message?: string;
  actions?: NotificationAction[];
  
  // Display options
  duration?: number;           // Auto-dismiss after ms (0 = permanent)
  playSound?: boolean;
  soundType?: 'fill' | 'alert' | 'complete';
  
  // Tracking
  timestamp: Date;
  viewed: boolean;
  strategyPath?: string;
  runId?: string;
}

export interface NotificationSettings {
  // Enable/disable by type
  showJobComplete: boolean;
  showJobFailed: boolean;
  showTradeExecuted: boolean;
  showRiskAlerts: boolean;
  showSessionStatus: boolean;
  
  // Sound settings
  soundEnabled: boolean;
  soundVolume: number;         // 0-1
  playFillSound: boolean;
  playAlertSound: boolean;
  playCompleteSound: boolean;
  
  // Badge settings
  showHistoryBadge: boolean;
  showTradeBadge: boolean;
}

export interface BadgeState {
  historyUnviewed: number;
  openOrders: number;
  activeAlerts: number;
}
```

### 3.2 Create `src/ui/notifications/NotificationManager.ts`

```typescript
import * as vscode from 'vscode';
import {
  QuantlabNotification,
  NotificationSettings,
  NotificationType,
  NotificationTrigger,
  BadgeState,
} from '../../types/notifications';
import { ToastService } from './ToastService';
import { BadgeManager } from './BadgeManager';
import { SoundPlayer } from './SoundPlayer';

/**
 * Central notification orchestrator
 * Coordinates toasts, badges, and sounds based on events
 */
export class NotificationManager {
  private toastService: ToastService;
  private badgeManager: BadgeManager;
  private soundPlayer: SoundPlayer;
  private settings: NotificationSettings;
  private notifications: Map<string, QuantlabNotification> = new Map();
  
  private readonly onNotificationEmitter = new vscode.EventEmitter<QuantlabNotification>();
  public readonly onNotification = this.onNotificationEmitter.event;

  constructor(
    private context: vscode.ExtensionContext
  ) {
    this.toastService = new ToastService();
    this.badgeManager = new BadgeManager();
    this.soundPlayer = new SoundPlayer(context);
    this.settings = this.loadSettings();
    
    // Listen for settings changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quantlab.notifications')) {
        this.settings = this.loadSettings();
      }
    });
  }

  /**
   * Shows a notification based on trigger type
   */
  async notify(
    trigger: NotificationTrigger,
    data: {
      title: string;
      message?: string;
      strategyPath?: string;
      runId?: string;
      metrics?: Record<string, number>;
      error?: string;
    }
  ): Promise<void> {
    // Check if this notification type is enabled
    if (!this.isNotificationEnabled(trigger)) {
      return;
    }

    const notification = this.createNotification(trigger, data);
    this.notifications.set(notification.id, notification);
    
    // Show toast
    await this.toastService.show(notification);
    
    // Play sound
    if (notification.playSound && this.settings.soundEnabled) {
      await this.soundPlayer.play(notification.soundType!);
    }
    
    // Update badges
    this.updateBadges();
    
    // Emit event
    this.onNotificationEmitter.fire(notification);
  }

  /**
   * Job completed notification
   */
  async notifyJobComplete(
    strategyPath: string,
    runId: string,
    metrics: Record<string, number>
  ): Promise<void> {
    const strategyName = this.getStrategyName(strategyPath);
    const sharpeStr = metrics.sharpe ? ` — Sharpe: ${metrics.sharpe.toFixed(2)}` : '';
    
    await this.notify('jobComplete', {
      title: 'Backtest Complete',
      message: `${strategyName}${sharpeStr}`,
      strategyPath,
      runId,
      metrics,
    });
  }

  /**
   * Job failed notification
   */
  async notifyJobFailed(
    strategyPath: string,
    runId: string,
    error: string
  ): Promise<void> {
    const strategyName = this.getStrategyName(strategyPath);
    
    await this.notify('jobFailed', {
      title: 'Backtest Failed',
      message: strategyName,
      strategyPath,
      runId,
      error,
    });
  }

  /**
   * Trade executed notification
   */
  async notifyTradeExecuted(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    price: number
  ): Promise<void> {
    await this.notify('tradeExecuted', {
      title: 'Trade Executed',
      message: `${side.toUpperCase()} ${quantity} ${symbol} @ $${price.toFixed(2)}`,
    });
  }

  /**
   * Risk alert notification
   */
  async notifyRiskAlert(
    alertType: string,
    message: string,
    isCritical: boolean
  ): Promise<void> {
    await this.notify('riskAlert', {
      title: isCritical ? '⚠️ CRITICAL: Risk Alert' : 'Risk Alert',
      message: `${alertType}: ${message}`,
    });
    
    // Critical alerts get a modal
    if (isCritical) {
      await this.showCriticalAlertModal(alertType, message);
    }
  }

  /**
   * Session status notification
   */
  async notifySessionStatus(
    status: 'started' | 'stopped' | 'paused' | 'resumed' | 'error',
    sessionType: 'paper' | 'live',
    strategyPath: string
  ): Promise<void> {
    const strategyName = this.getStrategyName(strategyPath);
    const statusMessages: Record<string, string> = {
      started: `${sessionType === 'live' ? '🔴 Live' : '📝 Paper'} session started`,
      stopped: 'Session stopped',
      paused: 'Session paused',
      resumed: 'Session resumed',
      error: 'Session error',
    };
    
    await this.notify('sessionStatus', {
      title: statusMessages[status],
      message: strategyName,
      strategyPath,
    });
  }

  /**
   * Marks a notification as viewed
   */
  markViewed(notificationId: string): void {
    const notification = this.notifications.get(notificationId);
    if (notification) {
      notification.viewed = true;
      this.updateBadges();
    }
  }

  /**
   * Gets unviewed count for History badge
   */
  getUnviewedCount(): number {
    return Array.from(this.notifications.values())
      .filter(n => !n.viewed && (n.trigger === 'jobComplete' || n.trigger === 'jobFailed'))
      .length;
  }

  /**
   * Clears all notifications
   */
  clearAll(): void {
    this.notifications.clear();
    this.updateBadges();
  }

  private createNotification(
    trigger: NotificationTrigger,
    data: {
      title: string;
      message?: string;
      strategyPath?: string;
      runId?: string;
      error?: string;
    }
  ): QuantlabNotification {
    const config = this.getNotificationConfig(trigger);
    
    return {
      id: `${trigger}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: config.type,
      trigger,
      title: data.title,
      message: data.message,
      actions: this.getActionsForTrigger(trigger, data.runId),
      duration: config.duration,
      playSound: config.playSound,
      soundType: config.soundType,
      timestamp: new Date(),
      viewed: false,
      strategyPath: data.strategyPath,
      runId: data.runId,
    };
  }

  private getNotificationConfig(trigger: NotificationTrigger): {
    type: NotificationType;
    duration: number;
    playSound: boolean;
    soundType?: 'fill' | 'alert' | 'complete';
  } {
    switch (trigger) {
      case 'jobComplete':
        return { type: 'success', duration: 5000, playSound: this.settings.playCompleteSound, soundType: 'complete' };
      case 'jobFailed':
        return { type: 'error', duration: 0, playSound: this.settings.playAlertSound, soundType: 'alert' };
      case 'tradeExecuted':
        return { type: 'info', duration: 5000, playSound: this.settings.playFillSound, soundType: 'fill' };
      case 'riskAlert':
        return { type: 'warning', duration: 0, playSound: this.settings.playAlertSound, soundType: 'alert' };
      case 'sessionStatus':
        return { type: 'info', duration: 5000, playSound: false };
      case 'connectionStatus':
        return { type: 'warning', duration: 5000, playSound: false };
      default:
        return { type: 'info', duration: 5000, playSound: false };
    }
  }

  private getActionsForTrigger(trigger: NotificationTrigger, runId?: string): Array<{ id: string; label: string; command?: string; args?: any[] }> {
    switch (trigger) {
      case 'jobComplete':
        return [
          { id: 'viewResults', label: 'View Results', command: 'quantlab.viewRunResults', args: [runId] },
        ];
      case 'jobFailed':
        return [
          { id: 'viewLogs', label: 'View Logs', command: 'quantlab.viewRunLogs', args: [runId] },
        ];
      case 'riskAlert':
        return [
          { id: 'viewTrade', label: 'View Trade Panel', command: 'quantlab.focusTradePanel' },
        ];
      default:
        return [];
    }
  }

  private isNotificationEnabled(trigger: NotificationTrigger): boolean {
    switch (trigger) {
      case 'jobComplete': return this.settings.showJobComplete;
      case 'jobFailed': return this.settings.showJobFailed;
      case 'tradeExecuted': return this.settings.showTradeExecuted;
      case 'riskAlert': return this.settings.showRiskAlerts;
      case 'sessionStatus': return this.settings.showSessionStatus;
      default: return true;
    }
  }

  private updateBadges(): void {
    const state: BadgeState = {
      historyUnviewed: this.getUnviewedCount(),
      openOrders: 0, // Populated by Trade panel
      activeAlerts: Array.from(this.notifications.values())
        .filter(n => n.trigger === 'riskAlert' && !n.viewed).length,
    };
    
    this.badgeManager.update(state);
  }

  private async showCriticalAlertModal(alertType: string, message: string): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      `⚠️ CRITICAL: ${alertType}\n\n${message}`,
      { modal: true },
      'View Trade Panel',
      'Acknowledge'
    );
    
    if (result === 'View Trade Panel') {
      vscode.commands.executeCommand('quantlab.focusTradePanel');
    }
  }

  private getStrategyName(strategyPath: string): string {
    return strategyPath.split('/').pop() || strategyPath;
  }

  private loadSettings(): NotificationSettings {
    const config = vscode.workspace.getConfiguration('quantlab.notifications');
    return {
      showJobComplete: config.get('showJobComplete', true),
      showJobFailed: config.get('showJobFailed', true),
      showTradeExecuted: config.get('showTradeExecuted', true),
      showRiskAlerts: config.get('showRiskAlerts', true),
      showSessionStatus: config.get('showSessionStatus', true),
      soundEnabled: config.get('soundEnabled', true),
      soundVolume: config.get('soundVolume', 0.5),
      playFillSound: config.get('playFillSound', true),
      playAlertSound: config.get('playAlertSound', true),
      playCompleteSound: config.get('playCompleteSound', false),
      showHistoryBadge: config.get('showHistoryBadge', true),
      showTradeBadge: config.get('showTradeBadge', true),
    };
  }

  dispose(): void {
    this.soundPlayer.dispose();
    this.onNotificationEmitter.dispose();
  }
}
```

### 3.3 Create `src/ui/notifications/ToastService.ts`

```typescript
import * as vscode from 'vscode';
import { QuantlabNotification, NotificationAction } from '../../types/notifications';

/**
 * Displays toast notifications using VS Code's notification API
 * V8.1 §11.2 - Toast Notifications
 */
export class ToastService {
  private activeNotifications: Map<string, { dispose: () => void }> = new Map();

  /**
   * Shows a toast notification
   */
  async show(notification: QuantlabNotification): Promise<void> {
    const message = notification.message
      ? `${notification.title}\n${notification.message}`
      : notification.title;

    const actions = notification.actions?.map(a => a.label) || [];
    
    let result: string | undefined;
    
    switch (notification.type) {
      case 'success':
      case 'info':
        result = await vscode.window.showInformationMessage(message, ...actions);
        break;
      case 'warning':
        result = await vscode.window.showWarningMessage(message, ...actions);
        break;
      case 'error':
        result = await vscode.window.showErrorMessage(message, ...actions);
        break;
    }

    // Handle action clicks
    if (result && notification.actions) {
      const action = notification.actions.find(a => a.label === result);
      if (action?.command) {
        vscode.commands.executeCommand(action.command, ...(action.args || []));
      }
    }
  }

  /**
   * Shows a progress notification (for long-running operations)
   */
  async showProgress<T>(
    title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      task
    );
  }

  /**
   * Dismisses all active notifications
   */
  dismissAll(): void {
    this.activeNotifications.forEach(n => n.dispose());
    this.activeNotifications.clear();
  }
}
```

### 3.4 Create `src/ui/notifications/BadgeManager.ts`

```typescript
import * as vscode from 'vscode';
import { BadgeState } from '../../types/notifications';

/**
 * Manages badge indicators on buttons and panels
 * V8.1 §11.4 - Badge Indicators
 */
export class BadgeManager {
  private historyStatusBarItem: vscode.StatusBarItem;
  private currentState: BadgeState = {
    historyUnviewed: 0,
    openOrders: 0,
    activeAlerts: 0,
  };

  constructor() {
    // History dropdown badge
    this.historyStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.historyStatusBarItem.command = 'quantlab.toggleHistoryDropdown';
    this.updateHistoryBadge();
    this.historyStatusBarItem.show();
  }

  /**
   * Updates all badges with new state
   */
  update(state: BadgeState): void {
    this.currentState = state;
    this.updateHistoryBadge();
    this.updateTreeViewBadges();
  }

  /**
   * Sets history unviewed count
   */
  setHistoryUnviewed(count: number): void {
    this.currentState.historyUnviewed = count;
    this.updateHistoryBadge();
  }

  /**
   * Sets open orders count
   */
  setOpenOrders(count: number): void {
    this.currentState.openOrders = count;
    this.updateTreeViewBadges();
  }

  private updateHistoryBadge(): void {
    const count = this.currentState.historyUnviewed;
    
    if (count > 0) {
      this.historyStatusBarItem.text = `$(history) History (${count})`;
      this.historyStatusBarItem.tooltip = `${count} unviewed completed jobs`;
      this.historyStatusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
    } else {
      this.historyStatusBarItem.text = '$(history) History';
      this.historyStatusBarItem.tooltip = 'View running jobs and history';
      this.historyStatusBarItem.backgroundColor = undefined;
    }
  }

  private updateTreeViewBadges(): void {
    // TreeView badges are set via TreeItem.description or custom API
    // This requires integration with the Trade panel TreeDataProvider
    vscode.commands.executeCommand(
      'quantlab.internal.updateTradePanelBadge',
      this.currentState.openOrders
    );
  }

  dispose(): void {
    this.historyStatusBarItem.dispose();
  }
}
```

### 3.5 Create `src/ui/notifications/SoundPlayer.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';

type SoundType = 'fill' | 'alert' | 'complete';

/**
 * Plays notification sounds
 * V8.1 §11.3 - Sound Notifications
 */
export class SoundPlayer {
  private audioContext: AudioContext | null = null;
  private soundBuffers: Map<SoundType, AudioBuffer> = new Map();
  private enabled: boolean = true;
  private volume: number = 0.5;

  constructor(private context: vscode.ExtensionContext) {
    this.loadSoundSettings();
    
    // Settings listener
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quantlab.notifications')) {
        this.loadSoundSettings();
      }
    });
  }

  /**
   * Plays a notification sound
   */
  async play(type: SoundType): Promise<void> {
    if (!this.enabled) return;
    
    try {
      // Use VS Code's built-in audio API if available
      // Otherwise fall back to terminal bell or no sound
      
      // Note: VS Code doesn't have a native audio API in extensions
      // In practice, we might need to:
      // 1. Use a webview to play audio
      // 2. Or integrate with system notification sounds
      
      // For now, we'll use the statusbar to provide visual feedback
      // and rely on system notification sounds where supported
      
      await this.showSoundIndicator(type);
    } catch (error) {
      console.warn(`Failed to play sound: ${error}`);
    }
  }

  /**
   * Shows visual indicator when sound would play
   * Fallback when actual audio isn't available
   */
  private async showSoundIndicator(type: SoundType): Promise<void> {
    const icons: Record<SoundType, string> = {
      fill: '$(check)',
      alert: '$(warning)',
      complete: '$(pass)',
    };
    
    // Brief visual flash in status bar
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000
    );
    item.text = icons[type];
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    item.show();
    
    setTimeout(() => item.dispose(), 300);
  }

  private loadSoundSettings(): void {
    const config = vscode.workspace.getConfiguration('quantlab.notifications');
    this.enabled = config.get('soundEnabled', true);
    this.volume = config.get('soundVolume', 0.5);
  }

  dispose(): void {
    this.soundBuffers.clear();
  }
}
```

---

## 4. Error States and Recovery

### 4.1 Create `src/types/errors.ts`

```typescript
export type ErrorSeverity = 'recoverable' | 'critical' | 'fatal';

export type ErrorSource = 'chart' | 'action' | 'trade' | 'engine' | 'broker' | 'data';

export interface QuantlabError {
  id: string;
  source: ErrorSource;
  severity: ErrorSeverity;
  code: string;
  message: string;
  details?: string;
  stack?: string;
  timestamp: Date;
  recoveryOptions: RecoveryOption[];
  context?: Record<string, any>;
}

export interface RecoveryOption {
  id: string;
  label: string;
  description?: string;
  command: string;
  args?: any[];
  isPrimary?: boolean;
}

export type ErrorRecoveryResult = 'recovered' | 'failed' | 'dismissed';
```

### 4.2 Create `src/ui/errors/ErrorRecovery.ts`

```typescript
import * as vscode from 'vscode';
import { QuantlabError, RecoveryOption, ErrorRecoveryResult, ErrorSource } from '../../types/errors';

/**
 * Handles error recovery flows
 * V8.1 §10 - Error States and Recovery
 */
export class ErrorRecovery {
  private activeRecoveries: Map<string, QuantlabError> = new Map();

  /**
   * Handles a Chart view error
   * V8.1 §10.1
   */
  async handleChartError(
    errorType: 'noData' | 'visualizationError' | 'chartCrash',
    context: {
      symbol?: string;
      lineNumber?: number;
      errorMessage?: string;
    }
  ): Promise<ErrorRecoveryResult> {
    const error = this.createChartError(errorType, context);
    return this.showErrorWithRecovery(error);
  }

  /**
   * Handles an Action view error
   * V8.1 §10.2
   */
  async handleActionError(
    errorType: 'jobFailed' | 'configInvalid' | 'dataUnavailable',
    context: {
      errorMessage?: string;
      stack?: string;
      invalidFields?: string[];
      dateRange?: { start: string; end: string };
    }
  ): Promise<ErrorRecoveryResult> {
    const error = this.createActionError(errorType, context);
    return this.showErrorWithRecovery(error);
  }

  /**
   * Handles a Trade view error
   * V8.1 §10.3
   */
  async handleTradeError(
    errorType: 'brokerDisconnected' | 'orderRejected' | 'sessionCrashed',
    context: {
      errorMessage?: string;
      rejectionReason?: string;
      orderId?: string;
    }
  ): Promise<ErrorRecoveryResult> {
    const error = this.createTradeError(errorType, context);
    return this.showErrorWithRecovery(error);
  }

  /**
   * Handles a global/engine error
   * V8.1 §10.4
   */
  async handleGlobalError(context: {
    errorMessage: string;
    details?: string;
    autoSaved?: boolean;
    sessionsPaused?: boolean;
  }): Promise<ErrorRecoveryResult> {
    const error: QuantlabError = {
      id: `global-${Date.now()}`,
      source: 'engine',
      severity: 'critical',
      code: 'ENGINE_ERROR',
      message: 'Quantlab Engine Error',
      details: context.details,
      timestamp: new Date(),
      recoveryOptions: [
        {
          id: 'viewDetails',
          label: 'View Details',
          command: 'quantlab.showErrorDetails',
          args: [context.errorMessage, context.details],
        },
        {
          id: 'reportIssue',
          label: 'Report Issue',
          command: 'quantlab.reportIssue',
        },
        {
          id: 'restart',
          label: 'Restart Engine',
          command: 'quantlab.restartEngine',
          isPrimary: true,
        },
      ],
    };

    return this.showGlobalErrorModal(error, context);
  }

  private createChartError(
    errorType: 'noData' | 'visualizationError' | 'chartCrash',
    context: any
  ): QuantlabError {
    const configs: Record<typeof errorType, Partial<QuantlabError>> = {
      noData: {
        code: 'CHART_NO_DATA',
        message: `No data available for ${context.symbol || 'symbol'}`,
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'changeSymbol', label: 'Change Symbol', command: 'quantlab.openSymbolPicker' },
          { id: 'checkDataSource', label: 'Check Data Source', command: 'quantlab.openDataSourceSettings' },
        ],
      },
      visualizationError: {
        code: 'CHART_VIZ_ERROR',
        message: `Visualization code error${context.lineNumber ? ` at line ${context.lineNumber}` : ''}`,
        details: context.errorMessage,
        severity: 'recoverable',
        recoveryOptions: [
          { 
            id: 'editCode', 
            label: 'Edit Visualization Code', 
            command: 'quantlab.editVisualizationCode',
            args: [context.lineNumber],
            isPrimary: true,
          },
          { id: 'disableViz', label: 'Disable Visualization', command: 'quantlab.disableVisualization' },
        ],
      },
      chartCrash: {
        code: 'CHART_CRASH',
        message: 'Chart failed to render',
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'reload', label: 'Reload Chart', command: 'quantlab.reloadChart', isPrimary: true },
          { id: 'viewLogs', label: 'View Logs', command: 'quantlab.showChartLogs' },
        ],
      },
    };

    return {
      id: `chart-${Date.now()}`,
      source: 'chart',
      timestamp: new Date(),
      ...configs[errorType],
    } as QuantlabError;
  }

  private createActionError(
    errorType: 'jobFailed' | 'configInvalid' | 'dataUnavailable',
    context: any
  ): QuantlabError {
    const configs: Record<typeof errorType, Partial<QuantlabError>> = {
      jobFailed: {
        code: 'ACTION_JOB_FAILED',
        message: 'Job failed',
        details: context.errorMessage,
        stack: context.stack,
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'viewLogs', label: 'View Logs', command: 'quantlab.viewJobLogs' },
          { id: 'retry', label: 'Retry', command: 'quantlab.retryJob', isPrimary: true },
        ],
      },
      configInvalid: {
        code: 'ACTION_CONFIG_INVALID',
        message: 'Configuration invalid',
        details: context.invalidFields?.join(', '),
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'fixFields', label: 'Fix Fields', command: 'quantlab.focusConfigField', args: [context.invalidFields?.[0]] },
        ],
      },
      dataUnavailable: {
        code: 'ACTION_DATA_UNAVAILABLE',
        message: `Cannot load data for date range`,
        details: context.dateRange ? `${context.dateRange.start} to ${context.dateRange.end}` : undefined,
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'adjustRange', label: 'Adjust Date Range', command: 'quantlab.adjustDateRange', isPrimary: true },
          { id: 'checkSource', label: 'Check Data Source', command: 'quantlab.openDataSourceSettings' },
        ],
      },
    };

    return {
      id: `action-${Date.now()}`,
      source: 'action',
      timestamp: new Date(),
      ...configs[errorType],
    } as QuantlabError;
  }

  private createTradeError(
    errorType: 'brokerDisconnected' | 'orderRejected' | 'sessionCrashed',
    context: any
  ): QuantlabError {
    const configs: Record<typeof errorType, Partial<QuantlabError>> = {
      brokerDisconnected: {
        code: 'TRADE_BROKER_DISCONNECTED',
        message: 'Broker connection lost',
        severity: 'critical',
        recoveryOptions: [
          { id: 'retry', label: 'Retry Connection', command: 'quantlab.retryBrokerConnection', isPrimary: true },
          { id: 'checkSettings', label: 'Check Connection', command: 'quantlab.openBrokerSettings' },
        ],
      },
      orderRejected: {
        code: 'TRADE_ORDER_REJECTED',
        message: 'Order rejected',
        details: context.rejectionReason,
        severity: 'recoverable',
        recoveryOptions: [
          { id: 'modifyOrder', label: 'Modify Order', command: 'quantlab.modifyOrder', args: [context.orderId] },
          { id: 'dismiss', label: 'Dismiss', command: 'quantlab.dismissError' },
        ],
      },
      sessionCrashed: {
        code: 'TRADE_SESSION_CRASHED',
        message: 'Session ended unexpectedly',
        details: context.errorMessage,
        severity: 'critical',
        recoveryOptions: [
          { id: 'viewLogs', label: 'View Logs', command: 'quantlab.viewSessionLogs' },
          { id: 'restart', label: 'Restart Session', command: 'quantlab.restartSession', isPrimary: true },
        ],
      },
    };

    return {
      id: `trade-${Date.now()}`,
      source: 'trade',
      timestamp: new Date(),
      ...configs[errorType],
    } as QuantlabError;
  }

  private async showErrorWithRecovery(error: QuantlabError): Promise<ErrorRecoveryResult> {
    this.activeRecoveries.set(error.id, error);

    const actions = error.recoveryOptions.map(opt => opt.label);
    let result: string | undefined;

    switch (error.severity) {
      case 'recoverable':
        result = await vscode.window.showWarningMessage(
          `${error.message}${error.details ? `\n\n${error.details}` : ''}`,
          ...actions
        );
        break;
      case 'critical':
      case 'fatal':
        result = await vscode.window.showErrorMessage(
          `${error.message}${error.details ? `\n\n${error.details}` : ''}`,
          { modal: error.severity === 'fatal' },
          ...actions
        );
        break;
    }

    if (result) {
      const option = error.recoveryOptions.find(opt => opt.label === result);
      if (option) {
        await vscode.commands.executeCommand(option.command, ...(option.args || []));
        this.activeRecoveries.delete(error.id);
        return 'recovered';
      }
    }

    this.activeRecoveries.delete(error.id);
    return 'dismissed';
  }

  private async showGlobalErrorModal(
    error: QuantlabError,
    context: {
      errorMessage: string;
      details?: string;
      autoSaved?: boolean;
      sessionsPaused?: boolean;
    }
  ): Promise<ErrorRecoveryResult> {
    let message = `The Quantlab engine encountered an unexpected error.\n\nError: ${context.errorMessage}`;
    
    if (context.autoSaved) {
      message += '\n\nYour work has been auto-saved.';
    }
    if (context.sessionsPaused) {
      message += ' Active trading sessions have been paused.';
    }

    const result = await vscode.window.showErrorMessage(
      message,
      { modal: true },
      'View Details',
      'Report Issue',
      'Restart Engine'
    );

    switch (result) {
      case 'View Details':
        await vscode.commands.executeCommand('quantlab.showErrorDetails', context.errorMessage, context.details);
        return 'dismissed';
      case 'Report Issue':
        await vscode.commands.executeCommand('quantlab.reportIssue');
        return 'dismissed';
      case 'Restart Engine':
        await vscode.commands.executeCommand('quantlab.restartEngine');
        return 'recovered';
      default:
        return 'dismissed';
    }
  }
}
```

### 4.3 Create `src/ui/errors/ViewErrorStates.ts`

```typescript
/**
 * Webview-side error state components
 * These are rendered inside Chart/Action/Trade webviews
 */

export interface ErrorStateProps {
  type: string;
  message: string;
  details?: string;
  actions: Array<{
    label: string;
    action: string;
    primary?: boolean;
  }>;
}

/**
 * Renders an error state inside a webview
 */
export function renderErrorState(props: ErrorStateProps): string {
  const actionsHtml = props.actions
    .map(action => `
      <button 
        class="ql-error-action${action.primary ? ' ql-error-action--primary' : ''}"
        data-action="${action.action}"
      >
        ${action.label}
      </button>
    `)
    .join('');

  return `
    <div class="ql-error-state" role="alert">
      <div class="ql-error-icon">
        ${getErrorIcon(props.type)}
      </div>
      <div class="ql-error-content">
        <h3 class="ql-error-message">${escapeHtml(props.message)}</h3>
        ${props.details ? `<p class="ql-error-details">${escapeHtml(props.details)}</p>` : ''}
      </div>
      <div class="ql-error-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
}

function getErrorIcon(type: string): string {
  const icons: Record<string, string> = {
    noData: '<svg>...</svg>',  // Empty state icon
    visualizationError: '<svg>...</svg>',  // Code error icon
    chartCrash: '<svg>...</svg>',  // Crash icon
    jobFailed: '<svg>...</svg>',  // Failed job icon
    brokerDisconnected: '<svg>...</svg>',  // Disconnected icon
  };
  return icons[type] || icons.jobFailed;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Error state CSS
 */
export const errorStateCSS = `
.ql-error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--ql-space-2xl);
  text-align: center;
  min-height: 200px;
}

.ql-error-icon {
  width: 64px;
  height: 64px;
  margin-bottom: var(--ql-space-lg);
  color: var(--ql-status-failed);
}

.ql-error-message {
  font-size: var(--ql-font-size-large);
  font-weight: 600;
  margin: 0 0 var(--ql-space-sm);
  color: var(--vscode-foreground);
}

.ql-error-details {
  font-size: var(--ql-font-size-base);
  color: var(--vscode-descriptionForeground);
  margin: 0 0 var(--ql-space-lg);
  max-width: 400px;
}

.ql-error-actions {
  display: flex;
  gap: var(--ql-space-sm);
}

.ql-error-action {
  padding: var(--ql-space-sm) var(--ql-space-lg);
  border-radius: var(--ql-radius-md);
  font-size: var(--ql-font-size-base);
  cursor: pointer;
  border: 1px solid var(--vscode-button-border);
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.ql-error-action:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.ql-error-action--primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.ql-error-action--primary:hover {
  background: var(--vscode-button-hoverBackground);
}
`;
```

---

## 5. Drag-and-Drop System

### 5.1 Create `src/ui/dragdrop/DragDropManager.ts`

```typescript
import * as vscode from 'vscode';

export type DragDataType = 
  | 'quantlab/symbol'
  | 'quantlab/run'
  | 'text/uri-list';

export interface DragData {
  type: DragDataType;
  payload: any;
}

/**
 * Central drag-and-drop orchestration
 * V8.1 §12 - Drag-and-Drop Behaviors
 */
export class DragDropManager {
  private currentDragData: DragData | null = null;

  /**
   * Registers a drag source (Data panel, History panel)
   */
  registerDragSource(
    treeDataProvider: vscode.TreeDataProvider<any>,
    getDragData: (item: any) => DragData
  ): vscode.TreeDragAndDropController<any> {
    const controller: vscode.TreeDragAndDropController<any> = {
      dragMimeTypes: ['quantlab/symbol', 'quantlab/run', 'text/plain'],
      dropMimeTypes: [],
      
      handleDrag: (items, dataTransfer, token) => {
        if (items.length === 0) return;
        
        const data = getDragData(items[0]);
        this.currentDragData = data;
        
        // Set MIME types
        dataTransfer.set(data.type, new vscode.DataTransferItem(JSON.stringify(data.payload)));
        
        // Also set text/plain for cross-app compatibility
        if (data.type === 'quantlab/symbol') {
          dataTransfer.set('text/plain', new vscode.DataTransferItem(data.payload.symbol));
        }
      },
    };
    
    return controller;
  }

  /**
   * Creates drag data for a symbol
   */
  createSymbolDragData(symbol: string, source: string): DragData {
    return {
      type: 'quantlab/symbol',
      payload: { symbol, source },
    };
  }

  /**
   * Creates drag data for a history run
   */
  createRunDragData(runId: string, strategyPath: string): DragData {
    return {
      type: 'quantlab/run',
      payload: { runId, strategyPath },
    };
  }

  /**
   * Gets current drag data (for drop targets to read)
   */
  getCurrentDragData(): DragData | null {
    return this.currentDragData;
  }

  /**
   * Clears drag data (called on drag end)
   */
  clearDragData(): void {
    this.currentDragData = null;
  }
}
```

### 5.2 Create `src/ui/dragdrop/SymbolDragSource.ts`

```typescript
import * as vscode from 'vscode';
import { DragDropManager } from './DragDropManager';

/**
 * Enables dragging symbols from Data panel
 * V8.1 §12.1 - Symbol Drag
 */
export class SymbolDragSource implements vscode.TreeDragAndDropController<SymbolTreeItem> {
  readonly dragMimeTypes = ['quantlab/symbol', 'text/plain'];
  readonly dropMimeTypes = ['quantlab/symbol'];  // For watchlist reordering

  constructor(
    private dragDropManager: DragDropManager
  ) {}

  handleDrag(
    source: readonly SymbolTreeItem[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): void {
    if (source.length === 0) return;
    
    const item = source[0];
    if (item.contextValue !== 'symbol') return;
    
    const dragData = this.dragDropManager.createSymbolDragData(
      item.symbol,
      item.watchlistId || 'search'
    );
    
    dataTransfer.set('quantlab/symbol', new vscode.DataTransferItem(
      JSON.stringify(dragData.payload)
    ));
    
    // Plain text for dragging to editor
    dataTransfer.set('text/plain', new vscode.DataTransferItem(
      `"${item.symbol}"`
    ));
  }

  handleDrop(
    target: SymbolTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Thenable<void> | void {
    // Handle dropping symbol onto different watchlist
    const symbolData = dataTransfer.get('quantlab/symbol');
    if (!symbolData || !target) return;
    
    const data = JSON.parse(symbolData.value);
    
    if (target.contextValue === 'watchlist' && data.symbol) {
      // Add symbol to target watchlist
      vscode.commands.executeCommand(
        'quantlab.addToWatchlist',
        target.watchlistId,
        data.symbol
      );
    }
  }
}

interface SymbolTreeItem extends vscode.TreeItem {
  symbol: string;
  watchlistId?: string;
}
```

### 5.3 Create `src/ui/dragdrop/RunDragSource.ts`

```typescript
import * as vscode from 'vscode';
import { DragDropManager } from './DragDropManager';

/**
 * Enables dragging runs from History panel
 * V8.1 §12.3 - Run Drag
 */
export class RunDragSource implements vscode.TreeDragAndDropController<HistoryTreeItem> {
  readonly dragMimeTypes = ['quantlab/run', 'text/plain'];
  readonly dropMimeTypes = [];

  constructor(
    private dragDropManager: DragDropManager
  ) {}

  handleDrag(
    source: readonly HistoryTreeItem[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): void {
    if (source.length === 0) return;
    
    const item = source[0];
    if (item.contextValue !== 'run') return;
    
    const dragData = this.dragDropManager.createRunDragData(
      item.runId,
      item.strategyPath
    );
    
    dataTransfer.set('quantlab/run', new vscode.DataTransferItem(
      JSON.stringify(dragData.payload)
    ));
    
    // Plain text for dragging to editor (inserts run ID reference)
    dataTransfer.set('text/plain', new vscode.DataTransferItem(
      `# Run: ${item.runId}`
    ));
  }
}

interface HistoryTreeItem extends vscode.TreeItem {
  runId: string;
  strategyPath: string;
}
```

### 5.4 Create `src/ui/dragdrop/DropTargets.ts`

```typescript
import * as vscode from 'vscode';

/**
 * Registers drop targets for Quantlab drag operations
 * V8.1 §12
 */
export class DropTargets {
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.registerChartViewDropTarget();
    this.registerGlobalSelectorDropTarget();
    this.registerEditorDropTarget();
  }

  /**
   * Chart view accepts symbols and runs
   */
  private registerChartViewDropTarget(): void {
    // Chart view drop handling is done in the webview
    // This sends messages to the webview when drops occur
    
    // Register command to handle drops forwarded from webview
    this.disposables.push(
      vscode.commands.registerCommand('quantlab.handleChartDrop', async (data: any) => {
        if (data.type === 'quantlab/symbol') {
          // Change chart symbol
          await vscode.commands.executeCommand('quantlab.setChartSymbol', data.payload.symbol);
        } else if (data.type === 'quantlab/run') {
          // Load run artifacts into chart
          await vscode.commands.executeCommand('quantlab.loadRunInChart', data.payload.runId);
        }
      })
    );
  }

  /**
   * Global selector accepts symbol drops
   */
  private registerGlobalSelectorDropTarget(): void {
    this.disposables.push(
      vscode.commands.registerCommand('quantlab.handleGlobalSelectorDrop', async (data: any) => {
        if (data.type === 'quantlab/symbol') {
          await vscode.commands.executeCommand('quantlab.setGlobalSymbol', data.payload.symbol);
        }
      })
    );
  }

  /**
   * Editor accepts symbols (inserts text) and runs (inserts reference)
   */
  private registerEditorDropTarget(): void {
    // VS Code handles text/plain drops to editor natively
    // Custom handling for quantlab types via document drop edit provider
    
    this.disposables.push(
      vscode.languages.registerDocumentDropEditProvider(
        { language: 'python' },
        {
          async provideDocumentDropEdits(
            document: vscode.TextDocument,
            position: vscode.Position,
            dataTransfer: vscode.DataTransfer,
            token: vscode.CancellationToken
          ): Promise<vscode.DocumentDropEdit | undefined> {
            // Handle symbol drop
            const symbolData = dataTransfer.get('quantlab/symbol');
            if (symbolData) {
              const data = JSON.parse(await symbolData.asString());
              const edit = new vscode.DocumentDropEdit(`"${data.symbol}"`);
              edit.label = `Insert symbol ${data.symbol}`;
              return edit;
            }
            
            // Handle run drop
            const runData = dataTransfer.get('quantlab/run');
            if (runData) {
              const data = JSON.parse(await runData.asString());
              const edit = new vscode.DocumentDropEdit(`# Run ID: ${data.runId}\n`);
              edit.label = `Insert run reference`;
              return edit;
            }
            
            return undefined;
          }
        }
      )
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

### 5.5 Webview Drop Handling (for Chart View)

```typescript
/**
 * Webview-side drop handling for Chart view
 * Add to chart webview initialization
 */
export function initializeChartDropZone(container: HTMLElement): void {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    container.classList.add('ql-drop-highlight');
  });

  container.addEventListener('dragleave', () => {
    container.classList.remove('ql-drop-highlight');
  });

  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('ql-drop-highlight');

    // Check for Quantlab data types
    const symbolData = e.dataTransfer?.getData('quantlab/symbol');
    const runData = e.dataTransfer?.getData('quantlab/run');
    const plainText = e.dataTransfer?.getData('text/plain');

    if (symbolData) {
      const data = JSON.parse(symbolData);
      // Send to extension
      vscode.postMessage({
        type: 'symbolDrop',
        symbol: data.symbol,
      });
    } else if (runData) {
      const data = JSON.parse(runData);
      // Send to extension
      vscode.postMessage({
        type: 'runDrop',
        runId: data.runId,
      });
    } else if (plainText) {
      // Handle plain text as potential symbol
      const symbol = plainText.replace(/['"]/g, '').trim().toUpperCase();
      if (/^[A-Z]{1,5}$/.test(symbol)) {
        vscode.postMessage({
          type: 'symbolDrop',
          symbol,
        });
      }
    }
  });
}

/**
 * CSS for drop highlighting
 */
export const dropZoneCSS = `
.ql-drop-highlight {
  position: relative;
}

.ql-drop-highlight::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ql-drop-highlight);
  border: var(--ql-drop-border);
  pointer-events: none;
  z-index: 100;
}
`;
```

---

## 6. Onboarding Flow

### 6.1 Create `src/types/onboarding.ts`

```typescript
export interface OnboardingState {
  completed: boolean;
  completedAt?: Date;
  skipped: boolean;
  viewedTooltips: string[];
  dismissedTips: string[];
}

export type OnboardingStep = 'welcome' | 'viewDiscovery' | 'complete';

export interface FeatureDiscoveryTrigger {
  id: string;
  trigger: string;               // Event that triggers this tip
  tooltip: string;
  targetSelector?: string;       // CSS selector for anchor
  showOnce: boolean;
  prerequisite?: string;         // Another tip ID that must be dismissed first
}
```

### 6.2 Create `src/ui/onboarding/OnboardingManager.ts`

```typescript
import * as vscode from 'vscode';
import { OnboardingState, OnboardingStep, FeatureDiscoveryTrigger } from '../../types/onboarding';
import { WelcomeModal } from './WelcomeModal';
import { TooltipGuide } from './TooltipGuide';
import { FeatureDiscovery } from './FeatureDiscovery';

/**
 * Manages onboarding flow and feature discovery
 * V8.1 §13 - Onboarding Flow
 */
export class OnboardingManager {
  private state: OnboardingState;
  private welcomeModal: WelcomeModal;
  private tooltipGuide: TooltipGuide;
  private featureDiscovery: FeatureDiscovery;

  constructor(private context: vscode.ExtensionContext) {
    this.state = this.loadState();
    this.welcomeModal = new WelcomeModal();
    this.tooltipGuide = new TooltipGuide(context);
    this.featureDiscovery = new FeatureDiscovery(context, this.state);
  }

  /**
   * Called on extension activation
   * Shows welcome modal if first launch
   */
  async onActivate(): Promise<void> {
    if (!this.state.completed && !this.state.skipped) {
      await this.showWelcome();
    }
    
    // Register feature discovery triggers
    this.featureDiscovery.registerTriggers();
  }

  /**
   * Shows the welcome modal (first launch)
   * V8.1 §13.1
   */
  private async showWelcome(): Promise<void> {
    const result = await this.welcomeModal.show();
    
    switch (result) {
      case 'template':
        await vscode.commands.executeCommand('quantlab.newFromTemplate');
        this.completeStep('welcome');
        break;
      case 'existing':
        await vscode.commands.executeCommand('workbench.action.files.openFile');
        this.completeStep('welcome');
        break;
      case 'skip':
        this.state.skipped = true;
        this.saveState();
        break;
    }
  }

  /**
   * Shows view discovery tooltip on first view switch
   * V8.1 §13.2
   */
  async showViewDiscovery(): Promise<void> {
    if (this.state.viewedTooltips.includes('viewDiscovery')) {
      return;
    }

    await this.tooltipGuide.show({
      id: 'viewDiscovery',
      title: '💡 View Buttons',
      content: `
        These buttons change how you see your strategy file.
        
        • **Editor**: Write code
        • **Chart**: See signals on price chart
        • **Action**: Run tests and backtests
        • **Trade**: Monitor live trading
        
        Right-click a tab to open multiple views side-by-side.
      `,
      targetCommand: 'quantlab.viewButtons',
      position: 'below',
    });

    this.markTooltipViewed('viewDiscovery');
  }

  /**
   * Records a completed step
   */
  private completeStep(step: OnboardingStep): void {
    if (step === 'complete') {
      this.state.completed = true;
      this.state.completedAt = new Date();
    }
    this.saveState();
  }

  /**
   * Marks a tooltip as viewed
   */
  private markTooltipViewed(id: string): void {
    if (!this.state.viewedTooltips.includes(id)) {
      this.state.viewedTooltips.push(id);
      this.saveState();
    }
  }

  /**
   * Checks if a tooltip has been viewed
   */
  hasViewedTooltip(id: string): boolean {
    return this.state.viewedTooltips.includes(id);
  }

  private loadState(): OnboardingState {
    return this.context.globalState.get<OnboardingState>('quantlab.onboarding', {
      completed: false,
      skipped: false,
      viewedTooltips: [],
      dismissedTips: [],
    });
  }

  private saveState(): void {
    this.context.globalState.update('quantlab.onboarding', this.state);
  }
}
```

### 6.3 Create `src/ui/onboarding/WelcomeModal.ts`

```typescript
import * as vscode from 'vscode';

export type WelcomeResult = 'template' | 'existing' | 'skip';

/**
 * First launch welcome modal
 * V8.1 §13.1
 */
export class WelcomeModal {
  /**
   * Shows the welcome modal and returns user choice
   */
  async show(): Promise<WelcomeResult> {
    const result = await vscode.window.showInformationMessage(
      'Welcome to Quantlab\n\n' +
      'Quantlab is a quantitative trading IDE built on VS Code.\n\n' +
      '📝 Editor — Write strategies\n' +
      '📈 Chart — Visualize signals\n' +
      '⚡ Action — Test & analyze\n\n' +
      'Each strategy file can be viewed in different ways using the view buttons in the tab bar.',
      { modal: true },
      'Start with a Template',
      'Open Existing',
      'Skip Tour'
    );

    switch (result) {
      case 'Start with a Template':
        return 'template';
      case 'Open Existing':
        return 'existing';
      default:
        return 'skip';
    }
  }

  /**
   * Shows welcome as a webview panel (richer UI option)
   */
  async showWebview(context: vscode.ExtensionContext): Promise<WelcomeResult> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'quantlabWelcome',
        'Welcome to Quantlab',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
        }
      );

      panel.webview.html = this.getWelcomeHtml();

      panel.webview.onDidReceiveMessage((message) => {
        panel.dispose();
        resolve(message.action as WelcomeResult);
      });
    });
  }

  private getWelcomeHtml(): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Quantlab</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 32px;
          }
          h1 {
            font-size: 28px;
            font-weight: 600;
            margin: 0;
          }
          .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 16px;
          }
          .views {
            display: flex;
            gap: 24px;
            justify-content: center;
          }
          .view-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 24px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            width: 140px;
          }
          .view-icon {
            font-size: 32px;
            margin-bottom: 12px;
          }
          .view-name {
            font-weight: 600;
            margin-bottom: 4px;
          }
          .view-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
          }
          .actions {
            display: flex;
            gap: 12px;
          }
          button {
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
          }
          .primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
          }
          .secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
          }
        </style>
      </head>
      <body>
        <h1>Welcome to Quantlab</h1>
        <p class="subtitle">Quantlab is a quantitative trading IDE built on VS Code.</p>
        
        <div class="views">
          <div class="view-card">
            <span class="view-icon">📝</span>
            <span class="view-name">Editor</span>
            <span class="view-desc">Write strategies</span>
          </div>
          <div class="view-card">
            <span class="view-icon">📈</span>
            <span class="view-name">Chart</span>
            <span class="view-desc">Visualize signals</span>
          </div>
          <div class="view-card">
            <span class="view-icon">⚡</span>
            <span class="view-name">Action</span>
            <span class="view-desc">Test & analyze</span>
          </div>
        </div>
        
        <p class="subtitle">Each strategy file can be viewed in different ways using the view buttons in the tab bar.</p>
        
        <div class="actions">
          <button class="primary" onclick="send('template')">Start with a Template</button>
          <button class="secondary" onclick="send('existing')">Open Existing</button>
          <button class="secondary" onclick="send('skip')">Skip Tour</button>
        </div>
        
        <script>
          const vscode = acquireVsCodeApi();
          function send(action) {
            vscode.postMessage({ action });
          }
        </script>
      </body>
      </html>
    `;
  }
}
```

### 6.4 Create `src/ui/onboarding/FeatureDiscovery.ts`

```typescript
import * as vscode from 'vscode';
import { OnboardingState, FeatureDiscoveryTrigger } from '../../types/onboarding';

/**
 * Trigger-based feature discovery tips
 * V8.1 §13.3
 */
export class FeatureDiscovery {
  private triggers: Map<string, FeatureDiscoveryTrigger> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private state: OnboardingState
  ) {
    this.initializeTriggers();
  }

  private initializeTriggers(): void {
    // Define all feature discovery triggers per V8.1 §13.3
    const triggers: FeatureDiscoveryTrigger[] = [
      {
        id: 'firstBacktestComplete',
        trigger: 'quantlab.jobComplete',
        tooltip: 'View results in Chart',
        showOnce: true,
      },
      {
        id: 'firstParamEdit',
        trigger: 'quantlab.parameterEdited',
        tooltip: 'Apply to Code to save permanently',
        showOnce: true,
      },
      {
        id: 'firstTradeView',
        trigger: 'quantlab.viewChanged:trade',
        tooltip: 'Complete checklist before live trading',
        showOnce: true,
      },
      {
        id: 'manyRuns',
        trigger: 'quantlab.historyCountReached:10',
        tooltip: 'Pin important runs in History',
        showOnce: true,
      },
    ];

    triggers.forEach(t => this.triggers.set(t.id, t));
  }

  /**
   * Registers event listeners for all triggers
   */
  registerTriggers(): void {
    // First backtest complete
    this.disposables.push(
      vscode.commands.registerCommand('quantlab.internal.triggerDiscovery', (triggerId: string) => {
        this.checkTrigger(triggerId);
      })
    );
  }

  /**
   * Called when a trigger event occurs
   */
  private async checkTrigger(triggerId: string): Promise<void> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger) return;

    // Skip if already shown
    if (trigger.showOnce && this.state.dismissedTips.includes(triggerId)) {
      return;
    }

    // Check prerequisite
    if (trigger.prerequisite && !this.state.dismissedTips.includes(trigger.prerequisite)) {
      return;
    }

    await this.showTip(trigger);
  }

  private async showTip(trigger: FeatureDiscoveryTrigger): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `💡 ${trigger.tooltip}`,
      'Got it',
      "Don't show again"
    );

    if (action === "Don't show again") {
      this.state.dismissedTips.push(trigger.id);
      this.context.globalState.update('quantlab.onboarding', this.state);
    } else if (action === 'Got it') {
      this.state.dismissedTips.push(trigger.id);
      this.context.globalState.update('quantlab.onboarding', this.state);
    }
  }

  /**
   * Manually trigger a tip (for testing or manual invocation)
   */
  async triggerTip(triggerId: string): Promise<void> {
    await this.checkTrigger(triggerId);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

---

## 7. Accessibility Implementation

### 7.1 Create `src/ui/accessibility/KeyboardManager.ts`

```typescript
import * as vscode from 'vscode';

/**
 * Manages keyboard navigation and focus
 * V8.1 §9.1 - Keyboard Navigation
 */
export class KeyboardManager {
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.registerFocusCommands();
  }

  private registerFocusCommands(): void {
    // Focus view buttons
    this.disposables.push(
      vscode.commands.registerCommand('quantlab.focusViewButtons', () => {
        // View buttons are in the tab bar - focus handled by VS Code
        vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      })
    );

    // Focus History dropdown
    this.disposables.push(
      vscode.commands.registerCommand('quantlab.focusHistoryDropdown', () => {
        vscode.commands.executeCommand('quantlab.toggleHistoryDropdown');
      })
    );

    // Focus panels (Ctrl+Q 1-4)
    const panels = ['data', 'resources', 'history', 'trade'];
    panels.forEach((panel, index) => {
      this.disposables.push(
        vscode.commands.registerCommand(`quantlab.focusPanel${index + 1}`, () => {
          vscode.commands.executeCommand(`quantlab.${panel}Panel.focus`);
        })
      );
    });
  }

  /**
   * Sends focus to a specific webview element
   */
  async focusWebviewElement(webview: vscode.Webview, elementId: string): Promise<void> {
    await webview.postMessage({
      type: 'focus',
      elementId,
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

### 7.2 Create `src/ui/accessibility/AriaLabeler.ts`

```typescript
/**
 * Generates ARIA labels for UI elements
 * V8.1 §9.2 - Screen Reader Support
 */
export class AriaLabeler {
  /**
   * Generates label for view button
   */
  static viewButton(viewType: string, enabled: boolean): string {
    const labels: Record<string, string> = {
      editor: 'Editor view button',
      chart: 'Chart view button',
      action: 'Action view button',
      trade: 'Trade view button',
    };
    
    const label = labels[viewType] || `${viewType} view button`;
    return enabled ? label : `${label}, disabled`;
  }

  /**
   * Generates label for tab with view stripe
   */
  static tabWithView(filename: string, viewType: string): string {
    if (viewType === 'editor') {
      return filename;
    }
    const viewNames: Record<string, string> = {
      chart: 'Chart view',
      action: 'Action view',
      trade: 'Trade view',
    };
    return `${filename}, ${viewNames[viewType] || viewType}`;
  }

  /**
   * Generates label for history entry
   */
  static historyEntry(entry: {
    type: string;
    id: string;
    strategyName: string;
    status: string;
    metrics?: Record<string, number>;
  }): string {
    const parts = [
      entry.type,
      entry.id,
      entry.strategyName,
      entry.status,
    ];
    
    if (entry.metrics?.sharpe) {
      parts.push(`Sharpe ${entry.metrics.sharpe.toFixed(2)}`);
    }
    
    return parts.join(', ');
  }

  /**
   * Generates label for progress
   */
  static progress(type: string, percent: number): string {
    return `${type} ${percent}% complete`;
  }

  /**
   * Generates label for position row
   */
  static positionRow(position: {
    symbol: string;
    quantity: number;
    pnl: number;
  }): string {
    const pnlDesc = position.pnl >= 0 
      ? `up ${position.pnl.toFixed(2)}` 
      : `down ${Math.abs(position.pnl).toFixed(2)}`;
    
    return `${position.symbol}, ${position.quantity} shares, ${pnlDesc}`;
  }

  /**
   * Generates label for complexity indicator
   */
  static complexity(level: 'safe' | 'partial' | 'viewOnly'): string {
    const labels: Record<string, string> = {
      safe: 'Strategy complexity: Safe. Full functionality available.',
      partial: 'Strategy complexity: Partial. Some features limited.',
      viewOnly: 'Strategy complexity: View Only. Trading disabled.',
    };
    return labels[level];
  }
}
```

### 7.3 Create `src/ui/accessibility/ReducedMotion.ts`

```typescript
import * as vscode from 'vscode';

/**
 * Handles reduced motion preferences
 * V8.1 §9.4 - Reduced Motion
 */
export class ReducedMotion {
  private static prefersReducedMotion: boolean = false;
  private static listeners: Set<(reduced: boolean) => void> = new Set();

  /**
   * Initializes reduced motion detection
   */
  static initialize(): void {
    // VS Code doesn't directly expose prefers-reduced-motion
    // We check via settings or system preference detection
    this.prefersReducedMotion = this.detectReducedMotion();
    
    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quantlab.accessibility.reducedMotion')) {
        this.prefersReducedMotion = this.detectReducedMotion();
        this.notifyListeners();
      }
    });
  }

  /**
   * Checks if reduced motion is preferred
   */
  static isReducedMotionPreferred(): boolean {
    return this.prefersReducedMotion;
  }

  /**
   * Subscribes to reduced motion changes
   */
  static onChange(callback: (reduced: boolean) => void): vscode.Disposable {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  }

  /**
   * Gets animation duration based on preference
   */
  static getAnimationDuration(normalMs: number): number {
    return this.prefersReducedMotion ? 0 : normalMs;
  }

  /**
   * Gets CSS for transitions
   */
  static getTransitionCSS(): string {
    if (this.prefersReducedMotion) {
      return `
        * {
          transition-duration: 0ms !important;
          animation-duration: 0ms !important;
        }
      `;
    }
    return '';
  }

  private static detectReducedMotion(): boolean {
    const config = vscode.workspace.getConfiguration('quantlab.accessibility');
    const setting = config.get<'auto' | 'always' | 'never'>('reducedMotion', 'auto');
    
    switch (setting) {
      case 'always':
        return true;
      case 'never':
        return false;
      case 'auto':
      default:
        // In VS Code, we default to false as we can't detect system preference
        return false;
    }
  }

  private static notifyListeners(): void {
    this.listeners.forEach(cb => cb(this.prefersReducedMotion));
  }
}
```

### 7.4 Create `src/ui/accessibility/ScreenReaderAnnouncer.ts`

```typescript
import * as vscode from 'vscode';

/**
 * Makes announcements for screen readers
 * Uses VS Code's built-in announcement mechanisms
 */
export class ScreenReaderAnnouncer {
  /**
   * Announces a message to screen readers
   */
  static announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
    // VS Code doesn't have a direct screen reader API
    // We use status bar items and notifications as proxies
    
    if (priority === 'assertive') {
      // Critical announcements use notifications
      vscode.window.showInformationMessage(message);
    } else {
      // Polite announcements use a temporary status bar item
      const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        -1000  // Low priority, won't interfere with other items
      );
      item.text = message;
      item.accessibilityInformation = {
        label: message,
        role: 'alert'
      };
      item.show();
      
      // Remove after screen reader has time to read
      setTimeout(() => item.dispose(), 3000);
    }
  }

  /**
   * Announces progress at intervals (25%, 50%, 75%, 100%)
   */
  static announceProgress(type: string, percent: number): void {
    const milestones = [25, 50, 75, 100];
    
    for (const milestone of milestones) {
      if (percent >= milestone && percent < milestone + 1) {
        this.announce(`${type} ${milestone}% complete`, 'polite');
        break;
      }
    }
  }

  /**
   * Announces view change
   */
  static announceViewChange(viewType: string, filename: string): void {
    const viewNames: Record<string, string> = {
      editor: 'Editor',
      chart: 'Chart',
      action: 'Action',
      trade: 'Trade',
    };
    
    this.announce(
      `Switched to ${viewNames[viewType] || viewType} view for ${filename}`,
      'polite'
    );
  }

  /**
   * Announces job completion
   */
  static announceJobComplete(type: string, success: boolean, details?: string): void {
    const message = success
      ? `${type} completed successfully${details ? `. ${details}` : ''}`
      : `${type} failed${details ? `. ${details}` : ''}`;
    
    this.announce(message, 'assertive');
  }
}
```

---

## 8. Theme Integration

### 8.1 Register Theme Contributions in package.json

```json
{
  "contributes": {
    "colors": [
      {
        "id": "quantlab.viewChart",
        "description": "Chart view indicator color",
        "defaults": {
          "dark": "#059669",
          "light": "#059669",
          "highContrast": "#047857"
        }
      },
      {
        "id": "quantlab.viewAction",
        "description": "Action view indicator color",
        "defaults": {
          "dark": "#D97706",
          "light": "#D97706",
          "highContrast": "#B45309"
        }
      },
      {
        "id": "quantlab.viewTrade",
        "description": "Trade view indicator color",
        "defaults": {
          "dark": "#DC2626",
          "light": "#DC2626",
          "highContrast": "#B91C1C"
        }
      },
      {
        "id": "quantlab.statusRunning",
        "description": "Running job status color",
        "defaults": {
          "dark": "#3B82F6",
          "light": "#3B82F6",
          "highContrast": "#2563EB"
        }
      },
      {
        "id": "quantlab.statusCompleted",
        "description": "Completed job status color",
        "defaults": {
          "dark": "#10B981",
          "light": "#10B981",
          "highContrast": "#059669"
        }
      },
      {
        "id": "quantlab.statusFailed",
        "description": "Failed job status color",
        "defaults": {
          "dark": "#EF4444",
          "light": "#EF4444",
          "highContrast": "#DC2626"
        }
      },
      {
        "id": "quantlab.pnlPositive",
        "description": "Positive P&L color",
        "defaults": {
          "dark": "#10B981",
          "light": "#059669",
          "highContrast": "#047857"
        }
      },
      {
        "id": "quantlab.pnlNegative",
        "description": "Negative P&L color",
        "defaults": {
          "dark": "#EF4444",
          "light": "#DC2626",
          "highContrast": "#B91C1C"
        }
      }
    ],
    "configuration": {
      "title": "Quantlab",
      "properties": {
        "quantlab.notifications.showJobComplete": {
          "type": "boolean",
          "default": true,
          "description": "Show notification when jobs complete"
        },
        "quantlab.notifications.showJobFailed": {
          "type": "boolean",
          "default": true,
          "description": "Show notification when jobs fail"
        },
        "quantlab.notifications.showTradeExecuted": {
          "type": "boolean",
          "default": true,
          "description": "Show notification when trades execute"
        },
        "quantlab.notifications.showRiskAlerts": {
          "type": "boolean",
          "default": true,
          "description": "Show risk alert notifications"
        },
        "quantlab.notifications.soundEnabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable notification sounds"
        },
        "quantlab.notifications.soundVolume": {
          "type": "number",
          "default": 0.5,
          "minimum": 0,
          "maximum": 1,
          "description": "Notification sound volume (0-1)"
        },
        "quantlab.accessibility.reducedMotion": {
          "type": "string",
          "enum": ["auto", "always", "never"],
          "default": "auto",
          "description": "Reduced motion preference"
        }
      }
    }
  }
}
```

---

## 9. Performance Optimization

### 9.1 Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Extension activation | < 500ms | `performance.now()` at activate end |
| View switch | < 100ms | Time from button click to render |
| Toast display | < 50ms | Time from trigger to visible |
| Drag start | < 16ms | Must not drop frames |
| Accessibility announcement | < 100ms | Time to screen reader |

### 9.2 Create `src/utils/PerformanceMonitor.ts`

```typescript
import * as vscode from 'vscode';

interface PerformanceMark {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

/**
 * Monitors and reports performance metrics
 */
export class PerformanceMonitor {
  private static marks: Map<string, PerformanceMark> = new Map();
  private static telemetry: vscode.TelemetryLogger | null = null;

  /**
   * Starts a performance measurement
   */
  static start(name: string): void {
    this.marks.set(name, {
      name,
      startTime: performance.now(),
    });
  }

  /**
   * Ends a performance measurement and logs result
   */
  static end(name: string): number {
    const mark = this.marks.get(name);
    if (!mark) {
      console.warn(`Performance mark "${name}" not found`);
      return -1;
    }

    mark.endTime = performance.now();
    mark.duration = mark.endTime - mark.startTime;

    // Log to output channel in development
    console.log(`[Performance] ${name}: ${mark.duration.toFixed(2)}ms`);

    // Check against targets
    this.checkTarget(name, mark.duration);

    this.marks.delete(name);
    return mark.duration;
  }

  /**
   * Wraps an async function with timing
   */
  static async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.start(name);
    try {
      return await fn();
    } finally {
      this.end(name);
    }
  }

  private static checkTarget(name: string, duration: number): void {
    const targets: Record<string, number> = {
      'extension.activate': 500,
      'view.switch': 100,
      'toast.display': 50,
      'drag.start': 16,
    };

    const target = targets[name];
    if (target && duration > target) {
      console.warn(
        `[Performance] ${name} exceeded target: ${duration.toFixed(2)}ms > ${target}ms`
      );
    }
  }
}
```

---

## 10. Final Polish

### 10.1 Polish Checklist

```
□ UI Text Review
  □ All buttons have consistent casing
  □ Error messages are actionable
  □ Tooltips are concise and helpful
  □ No placeholder text remains

□ Icon Verification
  □ All icons render in light theme
  □ All icons render in dark theme
  □ All icons render in high contrast theme
  □ No missing or broken icons

□ Theme Testing
  □ Light theme: All colors visible and contrast sufficient
  □ Dark theme: All colors visible and contrast sufficient
  □ High Contrast: All indicators clearly visible
  □ Custom themes: No hardcoded colors breaking appearance

□ Memory Leak Check
  □ Extension activation/deactivation cycle
  □ View switching 100x
  □ Notification spam (100 notifications)
  □ Long-running session (8 hours)

□ Documentation Review
  □ All keyboard shortcuts documented
  □ All settings documented
  □ CHANGELOG updated
  □ README reflects current features
```

### 10.2 Register All Phase 6 Components

```typescript
// src/extension.ts additions for Phase 6

import { ThemeProvider } from './ui/tokens/ThemeProvider';
import { NotificationManager } from './ui/notifications/NotificationManager';
import { ErrorRecovery } from './ui/errors/ErrorRecovery';
import { DragDropManager } from './ui/dragdrop/DragDropManager';
import { DropTargets } from './ui/dragdrop/DropTargets';
import { OnboardingManager } from './ui/onboarding/OnboardingManager';
import { KeyboardManager } from './ui/accessibility/KeyboardManager';
import { ReducedMotion } from './ui/accessibility/ReducedMotion';
import { PerformanceMonitor } from './utils/PerformanceMonitor';

export async function activate(context: vscode.ExtensionContext) {
  PerformanceMonitor.start('extension.activate');

  // Phase 6: Polish & Compliance
  
  // Theme system
  const themeProvider = new ThemeProvider();
  context.subscriptions.push(themeProvider);

  // Notifications
  const notificationManager = new NotificationManager(context);
  context.subscriptions.push(notificationManager);

  // Error recovery
  const errorRecovery = new ErrorRecovery();

  // Drag and drop
  const dragDropManager = new DragDropManager();
  const dropTargets = new DropTargets();
  context.subscriptions.push(dropTargets);

  // Onboarding
  const onboardingManager = new OnboardingManager(context);
  await onboardingManager.onActivate();

  // Accessibility
  const keyboardManager = new KeyboardManager();
  context.subscriptions.push(keyboardManager);
  ReducedMotion.initialize();

  // ... rest of activation

  PerformanceMonitor.end('extension.activate');
}
```

---

## 11. Verification Plan

### 11.1 Unit Tests

```typescript
describe('Design Tokens', () => {
  it('all CSS variables are defined', () => {
    const css = getTokensCSS();
    expect(css).toContain('--ql-view-chart');
    expect(css).toContain('--ql-view-action');
    expect(css).toContain('--ql-view-trade');
    expect(css).toContain('--ql-status-running');
    expect(css).toContain('--ql-complexity-safe');
  });

  it('theme detection works', () => {
    expect(detectTheme()).toMatch(/^(light|dark|high-contrast)$/);
  });
});

describe('Notifications', () => {
  it('job complete notification shows toast', async () => {
    const manager = new NotificationManager(mockContext);
    
    await manager.notifyJobComplete('strategy.py', 'run-123', { sharpe: 1.24 });
    
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Backtest Complete'),
      expect.anything()
    );
  });

  it('critical risk alert shows modal', async () => {
    const manager = new NotificationManager(mockContext);
    
    await manager.notifyRiskAlert('Daily Loss', '90% of limit', true);
    
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('CRITICAL'),
      { modal: true },
      expect.anything()
    );
  });
});

describe('Error Recovery', () => {
  it('chart error shows recovery options', async () => {
    const recovery = new ErrorRecovery();
    
    await recovery.handleChartError('noData', { symbol: 'INVALID' });
    
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No data'),
      'Change Symbol',
      'Check Data Source'
    );
  });
});

describe('Drag and Drop', () => {
  it('symbol drag creates correct data transfer', () => {
    const manager = new DragDropManager();
    const data = manager.createSymbolDragData('AAPL', 'watchlist-1');
    
    expect(data.type).toBe('quantlab/symbol');
    expect(data.payload.symbol).toBe('AAPL');
  });
});

describe('Onboarding', () => {
  it('shows welcome on first launch', async () => {
    const manager = new OnboardingManager(mockContext);
    mockContext.globalState.get.mockReturnValue({ completed: false, skipped: false });
    
    await manager.onActivate();
    
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Welcome to Quantlab'),
      expect.anything()
    );
  });

  it('skips welcome if completed', async () => {
    const manager = new OnboardingManager(mockContext);
    mockContext.globalState.get.mockReturnValue({ completed: true });
    
    await manager.onActivate();
    
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });
});

describe('Accessibility', () => {
  it('generates correct ARIA labels', () => {
    expect(AriaLabeler.viewButton('chart', true)).toBe('Chart view button');
    expect(AriaLabeler.viewButton('chart', false)).toBe('Chart view button, disabled');
    expect(AriaLabeler.tabWithView('strategy.py', 'chart')).toBe('strategy.py, Chart view');
  });

  it('reduced motion returns 0 duration when enabled', () => {
    ReducedMotion['prefersReducedMotion'] = true;
    expect(ReducedMotion.getAnimationDuration(250)).toBe(0);
  });
});
```

### 11.2 Integration Tests

```typescript
describe('Notification Integration', () => {
  it('full notification flow from job to badge', async () => {
    // Start a job
    await vscode.commands.executeCommand('quantlab.runBacktest');
    
    // Wait for completion
    await waitForJobComplete();
    
    // Verify toast appeared
    expect(getLastNotification().title).toContain('Backtest Complete');
    
    // Verify badge updated
    expect(getHistoryBadgeCount()).toBeGreaterThan(0);
    
    // View results
    await clickNotificationAction('View Results');
    
    // Verify Action view opened
    expect(getCurrentView()).toBe('action');
  });
});

describe('Drag-Drop Integration', () => {
  it('symbol drag to chart changes symbol', async () => {
    await openChartView('strategy.py');
    
    // Simulate drag from Data panel
    await simulateDragDrop({
      source: 'dataPanel:MSFT',
      target: 'chartView',
    });
    
    // Verify chart symbol changed
    expect(getChartSymbol()).toBe('MSFT');
  });

  it('run drag to chart loads artifacts', async () => {
    await openChartView('strategy.py');
    
    // Simulate drag from History panel
    await simulateDragDrop({
      source: 'historyPanel:run-123',
      target: 'chartView',
    });
    
    // Verify artifacts loaded
    expect(getChartArtifactRunId()).toBe('run-123');
    expect(getChartBanner()).toContain('Showing: Backtest #123');
  });
});

describe('Onboarding Integration', () => {
  it('first view switch shows discovery tooltip', async () => {
    // Reset onboarding state
    await resetOnboardingState();
    
    // Open strategy and switch to Chart
    await vscode.commands.executeCommand('quantlab.switchToChart');
    
    // Verify tooltip shown
    expect(getLastNotification().text).toContain('View Buttons');
    
    // Second switch should not show tooltip
    await vscode.commands.executeCommand('quantlab.switchToAction');
    expect(getLastNotification().text).not.toContain('View Buttons');
  });
});
```

### 11.3 E2E Tests

```typescript
describe('Complete Polish Flow', () => {
  it('new user complete journey', async () => {
    // Fresh install simulation
    await resetAllState();
    await activateExtension();
    
    // 1. Welcome modal appears
    expect(getCurrentModal()).toContain('Welcome to Quantlab');
    
    // 2. Choose template
    await clickModalButton('Start with a Template');
    
    // 3. Template picker opens
    expect(getQuickPickItems()).toContain('Momentum Strategy');
    
    // 4. Select template
    await selectQuickPickItem('Momentum Strategy');
    
    // 5. File opens in Editor view
    expect(getCurrentView()).toBe('editor');
    expect(getActiveFileName()).toContain('momentum');
    
    // 6. Switch to Chart - discovery tooltip shows
    await vscode.commands.executeCommand('quantlab.switchToChart');
    expect(getLastNotification()).toContain('View Buttons');
    
    // 7. Run backtest
    await vscode.commands.executeCommand('quantlab.runBacktest');
    await waitForJobComplete();
    
    // 8. Complete notification shows
    expect(getLastNotification().title).toContain('Backtest Complete');
    
    // 9. Discovery tip for "View in Chart"
    expect(getLastNotification()).toContain('View results in Chart');
  });
});
```

---

## 12. Exit Gates

### 12.1 Phase 6 Completion Criteria

- [ ] **Design Tokens**
  - [ ] All CSS variables defined in tokens.css
  - [ ] Theme detection and switching works
  - [ ] High contrast mode supported
  - [ ] Theme changes propagate to webviews

- [ ] **Notifications System**
  - [ ] Toast notifications display correctly
  - [ ] Job complete/failed notifications work
  - [ ] Trade executed notifications work
  - [ ] Risk alerts show correctly (modal for critical)
  - [ ] Badge indicators update (History, Trade panel)
  - [ ] Sound settings respected
  - [ ] Settings UI for all notification preferences

- [ ] **Error Handling**
  - [ ] Chart view errors show recovery options
  - [ ] Action view errors show recovery options
  - [ ] Trade view errors show recovery options
  - [ ] Global engine error modal works
  - [ ] Auto-save mentioned in critical errors
  - [ ] Report Issue button opens issue form

- [ ] **Drag-and-Drop**
  - [ ] Symbol drag from Data panel to Chart
  - [ ] Symbol drag to Global selector
  - [ ] Symbol drag to Editor (inserts text)
  - [ ] Symbol drag between watchlists
  - [ ] Run drag from History to Chart (loads artifacts)
  - [ ] Run drag to Editor (inserts reference)
  - [ ] Visual drop highlight feedback

- [ ] **Onboarding**
  - [ ] Welcome modal on first launch
  - [ ] Three options: Template, Existing, Skip
  - [ ] View discovery tooltip on first switch
  - [ ] Feature discovery triggers:
    - [ ] First backtest complete → "View in Chart"
    - [ ] First param edit → "Apply to Code"
    - [ ] First Trade view → "Complete checklist"
    - [ ] 10+ runs → "Pin important runs"
  - [ ] Tips dismissible and don't repeat

- [ ] **Accessibility**
  - [ ] All view buttons Tab-focusable
  - [ ] Enter/Space activates buttons
  - [ ] Arrow keys navigate panels
  - [ ] Screen reader labels for all elements
  - [ ] Progress announced at 25% intervals
  - [ ] Reduced motion disables animations
  - [ ] All colors meet WCAG AA contrast

- [ ] **Polish**
  - [ ] All UI text reviewed
  - [ ] Icons work in all themes
  - [ ] Light/Dark/High Contrast tested
  - [ ] No memory leaks detected
  - [ ] Performance targets met

### 12.2 Performance Targets

| Metric | Target |
|--------|--------|
| Extension activation | < 500ms |
| View switch | < 100ms |
| Toast display | < 50ms |
| Drag start feedback | < 16ms (60fps) |
| Notification sound play | < 100ms |

### 12.3 Documentation Deliverables

- [ ] CHANGELOG.md updated with Phase 6 features
- [ ] README.md includes accessibility section
- [ ] Settings reference documented
- [ ] Keyboard shortcuts reference updated
- [ ] Onboarding flow documented for support

---

*End of Phase 6: Polish & Compliance — Detailed Implementation Plan*
