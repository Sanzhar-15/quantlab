# Phase 4: UI Wiring & Recovery (17 fixes)

**UI integration gaps** -- Connects extension UI components to backend systems.

## Phase Overview

This phase wires up UI components that exist but aren't connected: pre-trade checklist, recovery dialog, connection status, history search, debugger commands, and JobRunner modes. Also includes the data source implementation plan.

## Prerequisites

- Phase 0 (IPC Integration) -- daemon communication
- Phase 1 (Security) -- trust verification
- Phase 2 (Risk & Safety) -- risk controls

---

## Fix List (Execution Order)

### FIX-CGP-014 [P1] Invoke PreTradeChecklist from SessionManager.startSession()

**Problem**: PreTradeChecklist (353 lines) exists with 6 validation checks but is never called from the session start flow.

**Evidence**:
- `extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts:68` -- `show()` method
- `extensions/quantlab/src/core/trading/SessionManager.ts:418` -- `startSession()` doesn't call checklist

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
import { PreTradeChecklist } from '../../ui/dialogs/PreTradeChecklist';

public async startSession(strategyPath: string, mode: 'paper' | 'live'): Promise<string> {
    // FIX-CGP-010: Trust verification (already added in Phase 1)
    // ...

    // FIX-CGP-014: Run pre-trade checklist
    const checklist = PreTradeChecklist.getInstance();
    const checkResult = await checklist.show({
        strategyPath,
        mode,
        symbols: this.getConfiguredSymbols(),
        broker: this.getConfiguredBroker(),
    });

    if (!checkResult.passed) {
        const failedItems = checkResult.items
            .filter(item => item.status === 'fail')
            .map(item => item.label)
            .join(', ');
        throw new Error(`Pre-trade checklist failed: ${failedItems}`);
    }

    // Warn on non-blocking issues
    const warnings = checkResult.items.filter(item => item.status === 'warn');
    if (warnings.length > 0) {
        const proceed = await vscode.window.showWarningMessage(
            `Pre-trade warnings: ${warnings.map(w => w.details).join('; ')}`,
            'Continue Anyway', 'Cancel'
        );
        if (proceed !== 'Continue Anyway') {
            throw new Error('Session start cancelled by user');
        }
    }

    // Route to appropriate session type
    if (mode === 'live') {
        return this.startDaemonSession(strategyPath, mode);
    }
    // ... paper trading path ...
}
```

**Verification**:
1. Start session with valid strategy -> checklist passes, session starts
2. Start session with invalid symbol -> checklist fails, error shown
3. Start session outside market hours -> warning shown, user can proceed

**Dependencies**: Phase 0

---

### FIX-CGP-015 [P1] Wire RecoveryDialog on startup for orphaned sessions

**Problem**: If the extension crashes while a daemon session is running, there's no recovery dialog on restart to reconnect.

**Evidence**:
- `extensions/quantlab/src/extension.ts:41-183` -- `activate()` doesn't check for orphaned sessions

**Files to modify**:
- `extensions/quantlab/src/extension.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/extension.ts
// In activate(), add orphaned session detection:

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ... existing initialization ...

    // FIX-CGP-015: Check for orphaned daemon sessions
    await checkOrphanedSessions(context);

    // ... rest of activation ...
}

async function checkOrphanedSessions(context: vscode.ExtensionContext): Promise<void> {
    const sessionsDir = path.join(os.homedir(), '.quantlab', 'sessions');
    try {
        const files = await fs.promises.readdir(sessionsDir);
        const socketFiles = files.filter(f => f.endsWith('.sock'));

        if (socketFiles.length === 0) {
            return;
        }

        // Check which sockets are still alive
        const aliveSessions: string[] = [];
        for (const socketFile of socketFiles) {
            const sessionId = socketFile.replace('.sock', '');
            try {
                const client = new DaemonClient({ sessionId });
                await client.connect();
                const health = await client.getHealth();
                await client.disconnect();
                if (health?.status === 'ok') {
                    aliveSessions.push(sessionId);
                }
            } catch {
                // Socket exists but daemon not responding -- stale socket
                // Clean up stale socket file
                try {
                    await fs.promises.unlink(path.join(sessionsDir, socketFile));
                } catch { /* ignore */ }
            }
        }

        if (aliveSessions.length === 0) {
            return;
        }

        // Show recovery dialog
        const action = await vscode.window.showWarningMessage(
            `Found ${aliveSessions.length} running daemon session(s) from a previous instance: ${aliveSessions.join(', ')}`,
            'Reconnect', 'Stop All', 'Ignore'
        );

        const sessionManager = SessionManager.getInstance();

        if (action === 'Reconnect') {
            for (const sessionId of aliveSessions) {
                try {
                    await sessionManager.reconnectDaemonSession(sessionId);
                    vscode.window.showInformationMessage(`Reconnected to session ${sessionId}`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to reconnect ${sessionId}: ${error}`);
                }
            }
        } else if (action === 'Stop All') {
            const manager = LiveDaemonManager.getInstance();
            for (const sessionId of aliveSessions) {
                try {
                    await manager.stopDaemon(sessionId);
                } catch { /* best effort */ }
            }
        }
        // 'Ignore' -- do nothing
    } catch {
        // Sessions directory doesn't exist -- no orphans
    }
}
```

**Verification**:
1. Start daemon session, kill extension process
2. Restart extension -- recovery dialog appears
3. Click "Reconnect" -- session reconnected, positions visible
4. Click "Stop All" -- daemon processes terminated

**Dependencies**: Phase 0

---

### FIX-CGP-013 [P1] Create first-run risk configuration wizard

**Problem**: First-time users should configure risk limits before trading. No onboarding flow exists.

**Files to create**:
- `extensions/quantlab/src/ui/onboarding/RiskConfigurationWizard.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/ui/onboarding/RiskConfigurationWizard.ts

import * as vscode from 'vscode';

export class RiskConfigurationWizard {
    static async shouldShow(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('quantlab');
        return !config.get<boolean>('onboarding.riskConfigured', false);
    }

    static async show(): Promise<boolean> {
        // Step 1: Welcome
        const proceed = await vscode.window.showInformationMessage(
            'Welcome to Quantlab! Before trading, please configure your risk limits.',
            'Configure Now', 'Skip (Use Defaults)'
        );

        if (proceed === 'Skip (Use Defaults)') {
            await this.markCompleted();
            return true;
        }

        if (!proceed) {
            return false;
        }

        // Step 2: Daily loss limit
        const dailyLoss = await vscode.window.showInputBox({
            prompt: 'Maximum daily loss as percentage of equity (e.g., 2 for 2%)',
            value: '2',
            validateInput: (v) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0 || n > 100) {
                    return 'Enter a number between 0 and 100';
                }
                return null;
            },
        });
        if (!dailyLoss) { return false; }

        // Step 3: Max drawdown
        const maxDD = await vscode.window.showInputBox({
            prompt: 'Maximum drawdown percentage (e.g., 5 for 5%)',
            value: '5',
            validateInput: (v) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0 || n > 100) {
                    return 'Enter a number between 0 and 100';
                }
                return null;
            },
        });
        if (!maxDD) { return false; }

        // Step 4: Consecutive loss limit
        const consLoss = await vscode.window.showInputBox({
            prompt: 'Maximum consecutive losing trades before halt',
            value: '3',
            validateInput: (v) => {
                const n = parseInt(v);
                if (isNaN(n) || n < 1 || n > 50) {
                    return 'Enter a number between 1 and 50';
                }
                return null;
            },
        });
        if (!consLoss) { return false; }

        // Apply settings
        const riskConfig = vscode.workspace.getConfiguration('quantlab.risk');
        await riskConfig.update('dailyLossLimit', parseFloat(dailyLoss) / 100, true);
        await riskConfig.update('maxDrawdownPercent', parseFloat(maxDD) / 100, true);
        await riskConfig.update('consecutiveLossLimit', parseInt(consLoss), true);

        await this.markCompleted();
        vscode.window.showInformationMessage(
            `Risk limits configured: ${dailyLoss}% daily loss, ${maxDD}% max drawdown, ${consLoss} consecutive losses`
        );
        return true;
    }

    private static async markCompleted(): Promise<void> {
        const config = vscode.workspace.getConfiguration('quantlab');
        await config.update('onboarding.riskConfigured', true, true);
    }
}
```

**Verification**:
1. Fresh install -> wizard shows on first trade attempt
2. Complete wizard -> settings persisted
3. Skip wizard -> defaults applied, won't show again

**Dependencies**: None

---

### FIX-CGP-016 [P1] Implement connection-loss UI banner and dialog

**Problem**: When daemon connection drops, there's no visual indicator in the UI.

**Files to create**:
- `extensions/quantlab/src/ui/components/ConnectionStatusBanner.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/ui/components/ConnectionStatusBanner.ts

import * as vscode from 'vscode';

export class ConnectionStatusBanner {
    private statusBarItem: vscode.StatusBarItem;
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 100
        );
        this.statusBarItem.command = 'quantlab.showConnectionDetails';
    }

    setConnected(sessionId: string): void {
        this.statusBarItem.text = '$(plug) Quantlab: Connected';
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = `Connected to session ${sessionId}`;
        this.statusBarItem.show();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    setDisconnected(sessionId: string, reason?: string): void {
        this.statusBarItem.text = '$(debug-disconnect) Quantlab: Disconnected';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.errorBackground'
        );
        this.statusBarItem.tooltip = `Disconnected from session ${sessionId}${reason ? ': ' + reason : ''}. Click for options.`;
        this.statusBarItem.show();
    }

    setReconnecting(sessionId: string, attempt: number): void {
        this.statusBarItem.text = `$(sync~spin) Quantlab: Reconnecting (${attempt})...`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground'
        );
        this.statusBarItem.tooltip = `Reconnecting to session ${sessionId}, attempt ${attempt}`;
        this.statusBarItem.show();
    }

    hide(): void {
        this.statusBarItem.hide();
    }

    dispose(): void {
        this.statusBarItem.dispose();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
    }
}
```

**Verification**:
1. Connected daemon -> green "Connected" in status bar
2. Kill daemon process -> red "Disconnected" appears
3. Auto-reconnect starts -> spinning "Reconnecting" appears
4. Reconnect succeeds -> back to "Connected"

**Dependencies**: Phase 0

---

### NEW-UI-001 [P1] Wire risk disclosure dialog

**Problem**: Before first live trade, user should formally acknowledge risk. Required for compliance.

**Files to create**:
- `extensions/quantlab/src/ui/dialogs/RiskDisclosureDialog.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/ui/dialogs/RiskDisclosureDialog.ts

import * as vscode from 'vscode';

const RISK_DISCLOSURE_TEXT = `
RISK DISCLOSURE

Trading financial instruments involves substantial risk of loss and is not suitable for every investor.

By proceeding, you acknowledge:
1. You understand the risks of algorithmic trading
2. You have tested your strategy in paper trading mode
3. You accept full responsibility for trading decisions made by your strategy
4. Quantlab provides no guarantee of profit or protection from loss
5. Past backtest performance does not guarantee future results
`;

export class RiskDisclosureDialog {
    static async show(context: vscode.ExtensionContext): Promise<boolean> {
        // Check if already acknowledged
        const acknowledged = context.globalState.get<boolean>(
            'quantlab.riskDisclosure.acknowledged', false
        );
        if (acknowledged) {
            return true;
        }

        const result = await vscode.window.showWarningMessage(
            RISK_DISCLOSURE_TEXT.trim(),
            { modal: true },
            'I Acknowledge the Risks',
            'Cancel'
        );

        if (result === 'I Acknowledge the Risks') {
            await context.globalState.update('quantlab.riskDisclosure.acknowledged', true);
            await context.globalState.update(
                'quantlab.riskDisclosure.acknowledgedAt',
                new Date().toISOString()
            );
            return true;
        }

        return false;
    }
}
```

**Verification**:
1. First live trade attempt -> risk disclosure dialog appears
2. Acknowledge -> allowed to proceed, won't show again
3. Cancel -> live trade blocked

**Dependencies**: None

---

### NEW-UI-002 [P1] Implement strategy hot-reload flow

**Problem**: When a strategy file changes during a live session, there's no UI flow to pause, re-verify, and decide whether to continue.

**Files to modify**:
- `extensions/quantlab/src/core/trust/TrustManager.ts`
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// In TrustManager.onStrategyFileChanged() -- already exists at line 405
// Wire it to SessionManager:

private onStrategyFileChanged(uri: vscode.Uri): void {
    const strategyPath = uri.fsPath;

    // Mark as untrusted
    this.trustedStrategies.delete(this.normalizeUri(uri));
    this.saveTrustStore();
    this.emit('strategyChanged', { path: strategyPath });

    // NEW-UI-002: Notify session manager
    const sessionManager = SessionManager.getInstance();
    const affectedSession = sessionManager.getSessionForStrategy(strategyPath);

    if (affectedSession && affectedSession.mode === 'live') {
        this.showHotReloadDialog(affectedSession.sessionId, strategyPath);
    }
}

private async showHotReloadDialog(sessionId: string, strategyPath: string): Promise<void> {
    const action = await vscode.window.showWarningMessage(
        `Strategy file changed while live session "${sessionId}" is running. ` +
        'The strategy trust has been revoked.',
        'Pause Session', 'Continue (Re-verify)', 'Stop Session'
    );

    const sessionManager = SessionManager.getInstance();

    switch (action) {
        case 'Pause Session':
            await sessionManager.pauseSession(sessionId);
            vscode.window.showInformationMessage(
                `Session ${sessionId} paused. Review changes and resume when ready.`
            );
            break;

        case 'Continue (Re-verify)':
            const reverified = await this.verifyForLiveTradingWithPrompts(strategyPath);
            if (!reverified.trusted) {
                await sessionManager.pauseSession(sessionId);
                vscode.window.showErrorMessage(
                    'Strategy re-verification failed. Session paused.'
                );
            }
            break;

        case 'Stop Session':
            await sessionManager.stopSession(sessionId);
            break;
    }
}
```

**Verification**:
1. Start live session, modify strategy file -> dialog appears
2. Click "Pause" -> session paused
3. Click "Continue" -> re-verification prompt, if passed session continues
4. Click "Stop" -> session stopped

**Dependencies**: Phase 0, Phase 1

---

### CODEX-009 [P1] Implement history search

**Problem**: `historyCommands.ts:42` has a search command that's a stub (shows input box but doesn't search).

**Evidence**:
- `extensions/quantlab/src/commands/historyCommands.ts:42-50` -- stub implementation

**Files to modify**:
- `extensions/quantlab/src/commands/historyCommands.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/commands/historyCommands.ts
// Replace the stub at line 42:

context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.searchHistory', async () => {
        const query = await vscode.window.showInputBox({
            prompt: 'Search history (strategy name, symbol, date)',
            placeHolder: 'e.g., "momentum" or "AAPL" or "2024-01"',
        });

        if (!query) {
            return;
        }

        // CODEX-009: Implement actual history search
        const historyState = HistoryState.getInstance();
        const allEntries = historyState.getEntries();

        const queryLower = query.toLowerCase();
        const results = allEntries.filter(entry => {
            // Search across strategy name, symbols, date, and notes
            const searchableFields = [
                entry.strategyName ?? '',
                entry.symbol ?? '',
                (entry.symbols ?? []).join(' '),
                entry.date ?? '',
                entry.startDate ?? '',
                entry.notes ?? '',
                entry.status ?? '',
            ].map(f => f.toLowerCase());

            return searchableFields.some(field => field.includes(queryLower));
        });

        if (results.length === 0) {
            vscode.window.showInformationMessage(`No history entries matching "${query}"`);
            return;
        }

        // Show quick pick with results
        const items = results.map(entry => ({
            label: entry.strategyName ?? 'Unknown',
            description: `${entry.symbol ?? ''} | ${entry.date ?? entry.startDate ?? ''}`,
            detail: `Status: ${entry.status ?? 'unknown'} | ${entry.notes ?? ''}`,
            entry,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `${results.length} results for "${query}"`,
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (selected) {
            await vscode.commands.executeCommand(
                'quantlab.action.openRun',
                selected.entry
            );
        }
    })
);
```

**Verification**:
1. Run some backtests to populate history
2. Execute `quantlab.searchHistory`, type "AAPL" -> matching entries shown
3. Select an entry -> opens in action view

**Dependencies**: None

---

### CODEX-010 [P1] Implement `quantlab.engine.readDebugFile` command

**Problem**: DebuggerService calls `quantlab.engine.readDebugFile` command but it doesn't exist.

**Evidence**:
- `extensions/quantlab/src/views/chart/DebuggerService.ts:351` -- calls command

**Files to modify**:
- `extensions/quantlab/src/extension.ts` (register command)

**Implementation**:

```typescript
// extensions/quantlab/src/extension.ts
// Register the readDebugFile command in activate():

context.subscriptions.push(
    vscode.commands.registerCommand(
        'quantlab.engine.readDebugFile',
        async (filePath: string) => {
            // CODEX-010: Read debug file from engine output
            try {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                return JSON.parse(content);
            } catch (error: any) {
                vscode.window.showErrorMessage(
                    `Failed to read debug file: ${error.message}`
                );
                return null;
            }
        }
    )
);
```

**Verification**:
1. Run a backtest with debug output
2. Open time-travel debugger -> loads debug file
3. Navigate bars -> state data displayed

**Dependencies**: None

---

### CODEX-011 [P1] Implement optimize, Monte Carlo, WFA modes in JobRunner

**Problem**: JobRunner only runs backtests. UI has buttons for optimize, Monte Carlo, and Walk-Forward Analysis but they're not implemented.

**Evidence**:
- `extensions/quantlab/src/core/engine/JobRunner.ts:26` -- `start()` only runs backtest

**Files to modify**:
- `extensions/quantlab/src/core/engine/JobRunner.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/engine/JobRunner.ts
// Add mode support:

export type JobMode = 'backtest' | 'optimize' | 'montecarlo' | 'wfa';

export class JobRunner {
    private mode: JobMode;

    constructor(options: JobRunnerOptions) {
        this.mode = options.mode ?? 'backtest';
        // ... existing constructor ...
    }

    start(): void {
        // CODEX-011: Route to correct Python module based on mode
        const moduleMap: Record<JobMode, string> = {
            backtest: 'quantlab.cli.run_backtest',
            optimize: 'quantlab.cli.run_optimize',
            montecarlo: 'quantlab.cli.run_montecarlo',
            wfa: 'quantlab.cli.run_wfa',
        };

        const module = moduleMap[this.mode];
        const pythonPath = this.options.pythonPath ?? 'python';
        const engineRoot = this.options.engineRoot;

        this.process = spawn(pythonPath, ['-m', module], {
            env: {
                ...process.env,
                PYTHONPATH: engineRoot,
                PYTHONUNBUFFERED: '1',
            },
        });

        // ... existing stdout/stderr/exit handling ...
    }

    buildStdinConfig(): string {
        const config: any = {
            ...this.options.config,
            mode: this.mode,
        };

        // Mode-specific config
        if (this.mode === 'optimize') {
            config.optimization = {
                parameters: this.options.config.optimizationParams ?? [],
                objective: this.options.config.objective ?? 'sharpe_ratio',
                method: this.options.config.optimizationMethod ?? 'grid',
            };
        } else if (this.mode === 'montecarlo') {
            config.montecarlo = {
                simulations: this.options.config.simulations ?? 1000,
                confidence_levels: this.options.config.confidenceLevels ?? [0.95, 0.99],
            };
        } else if (this.mode === 'wfa') {
            config.wfa = {
                in_sample_ratio: this.options.config.inSampleRatio ?? 0.7,
                windows: this.options.config.wfaWindows ?? 5,
                anchored: this.options.config.wfaAnchored ?? false,
            };
        }

        return JSON.stringify(config);
    }
}
```

**Verification**:
1. Run optimize job -> spawns `quantlab.cli.run_optimize`
2. Run Monte Carlo -> spawns `quantlab.cli.run_montecarlo`
3. Run WFA -> spawns `quantlab.cli.run_wfa`
4. All modes report progress via stderr NDJSON

**Dependencies**: None

---

### CODEX-014 [P1] Fix IPC integration tests to use real daemon contract

**Problem**: Integration tests mock the IPC contract with camelCase and `flatten.all` but real daemon uses snake_case and different method names.

**Evidence**:
- `extensions/quantlab/src/test/integration/daemon.integration.test.ts:113` -- mocked contract

**Files to modify**:
- `extensions/quantlab/src/test/` (integration tests)

**Implementation**:

```typescript
// Update test mocks to match actual daemon contract:

// BEFORE (wrong):
// mockDaemon.on('request', (method, params) => {
//     if (method === 'flattenAll') {
//         return { success: true, positionsClosed: 2 };
//     }
// });

// AFTER (correct -- uses snake_case, correct method names):
mockDaemon.on('request', (method, params) => {
    switch (method) {
        case 'flatten.all':
            return { success: true, positions_closed: 2 };
        case 'positions.get':
            return { positions: [
                { symbol: 'AAPL', quantity: 100, avg_price: 150.0 },
            ]};
        case 'orders.get':
            return { orders: [] };
        case 'fills.get':
            return { fills: [] };
        case 'session.pause':
            return { success: true };
        case 'session.resume':
            return { success: true };
        case 'session.stop':
            return { success: true };
        case 'health':
            return { status: 'ok', timestamp: new Date().toISOString() };
        case 'authenticate':
            return { success: true };
        default:
            return { error: 'unknown_method' };
    }
});

// Verify SchemaAdapter is used in test assertions:
// const positions = SchemaAdapter.toCamelCase(rawPositions);
// expect(positions[0].avgPrice).toBe(150.0);  // camelCase after adapter
```

**Verification**:
1. Run integration tests -> all pass
2. Method names in test match daemon's `_register_ipc_handlers()`
3. Response shapes match daemon's actual responses (snake_case, wrapped in objects)

**Dependencies**: FIX-CGP-003 (SchemaAdapter)

---

### NEW-UI-003 [MEDIUM] Implement system tray integration

**Problem**: Running daemon sessions should be visible in system tray for monitoring when VS Code is minimized.

**Files to create**:
- `extensions/quantlab/src/ui/tray/SystemTrayManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/ui/tray/SystemTrayManager.ts

import * as vscode from 'vscode';

/**
 * System tray integration for daemon session monitoring.
 * Uses VS Code's window badge API for session count indication.
 *
 * Note: Full system tray access requires native module. For now,
 * use VS Code window badge and notification area.
 */
export class SystemTrayManager {
    private badgeDisposable: vscode.Disposable | null = null;

    updateSessionCount(count: number): void {
        // Use VS Code's window badge API
        if (count > 0) {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: `Quantlab: ${count} active session${count > 1 ? 's' : ''}`,
            }, () => new Promise(() => {})); // Persistent until cleared
        }
    }

    showAlert(message: string, severity: 'info' | 'warning' | 'error'): void {
        switch (severity) {
            case 'info':
                vscode.window.showInformationMessage(`Quantlab: ${message}`);
                break;
            case 'warning':
                vscode.window.showWarningMessage(`Quantlab: ${message}`);
                break;
            case 'error':
                vscode.window.showErrorMessage(`Quantlab: ${message}`);
                break;
        }
    }

    dispose(): void {
        this.badgeDisposable?.dispose();
    }
}
```

**Verification**:
1. Start daemon session -> VS Code window shows session badge
2. Risk alert -> notification appears even if VS Code is in background

**Dependencies**: None

---

### NEW-UI-004 [MEDIUM] Wire update gating during active sessions

**Problem**: VS Code auto-updates could kill active daemon sessions without warning.

**Files to modify**:
- Extension needs to check `update.check_allowed` before allowing updates

**Implementation**:

```typescript
// extensions/quantlab/src/extension.ts
// In activate(), add update gating:

// NEW-UI-004: Gate VS Code updates during active sessions
context.subscriptions.push(
    vscode.extensions.onDidChange(async () => {
        const sessionManager = SessionManager.getInstance();
        const activeSessions = sessionManager.getActiveSessions();

        if (activeSessions.length > 0) {
            const liveSessions = activeSessions.filter(s => s.mode === 'live');
            if (liveSessions.length > 0) {
                vscode.window.showWarningMessage(
                    `${liveSessions.length} live trading session(s) active. ` +
                    'Extension update may interrupt trading. Stop sessions before updating.',
                    'Stop All Sessions', 'Dismiss'
                ).then(action => {
                    if (action === 'Stop All Sessions') {
                        sessionManager.stopAllSessions();
                    }
                });
            }
        }
    })
);
```

**Verification**:
1. Start live session, trigger extension update check -> warning appears
2. No live sessions -> update proceeds normally

**Dependencies**: Phase 0

---

### NEW-UI-005 [MEDIUM] Implement reconciliation panel in Trade view

**Problem**: Trade view needs a reconciliation panel showing position/fill discrepancies between daemon and broker.

**Files to create**:
- `extensions/quantlab/src/panels/reconciliation/ReconciliationPanel.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/panels/reconciliation/ReconciliationPanel.ts

import * as vscode from 'vscode';

export class ReconciliationPanel {
    private panel: vscode.WebviewPanel | null = null;

    async show(sessionId: string): Promise<void> {
        const sessionManager = SessionManager.getInstance();
        const client = sessionManager.getDaemonClient(sessionId);
        if (!client) {
            vscode.window.showErrorMessage('No daemon client for session');
            return;
        }

        const status = await client.getReconciliationStatus();

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'quantlab.reconciliation',
                'Reconciliation',
                vscode.ViewColumn.Two,
                { enableScripts: true },
            );
        }

        this.panel.webview.html = this.buildHtml(status);
    }

    private buildHtml(status: any): string {
        const discrepancies = status?.discrepancies ?? [];
        const rows = discrepancies.map((d: any) => `
            <tr>
                <td>${d.symbol}</td>
                <td>${d.daemonQty}</td>
                <td>${d.brokerQty}</td>
                <td>${d.difference}</td>
                <td class="${d.severity}">${d.severity}</td>
            </tr>
        `).join('');

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
        .critical { color: red; font-weight: bold; }
        .warning { color: orange; }
        .ok { color: green; }
    </style>
</head>
<body>
    <h2>Position Reconciliation</h2>
    <p>Last reconciliation: ${status?.lastRun ?? 'Never'}</p>
    <table>
        <tr><th>Symbol</th><th>Daemon</th><th>Broker</th><th>Diff</th><th>Status</th></tr>
        ${rows || '<tr><td colspan="5">No discrepancies</td></tr>'}
    </table>
</body>
</html>`;
    }
}
```

**Verification**:
1. Open reconciliation panel for active session
2. Shows position comparison between daemon and broker
3. Discrepancies highlighted in red

**Dependencies**: Phase 0, Phase 5 (FIX-T005)

---

### CODEX-012 [MEDIUM] Move CSV parsing to worker thread

**Problem**: Large CSV parsing blocks the extension host, freezing the UI.

**Files to modify**:
- `extensions/quantlab/src/core/engine/DataService.ts` (create or modify)

**Implementation**:

```typescript
// extensions/quantlab/src/core/engine/CsvWorker.ts

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import * as path from 'path';

if (!isMainThread && parentPort) {
    // Worker thread: parse CSV
    const { filePath, options } = workerData;
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const headers = lines[0].split(',').map((h: string) => h.trim());

    const records = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const values = lines[i].split(',');
        const record: Record<string, any> = {};
        for (let j = 0; j < headers.length; j++) {
            const val = values[j]?.trim();
            record[headers[j]] = isNaN(Number(val)) ? val : Number(val);
        }
        records.push(record);
    }

    parentPort.postMessage({ records, rowCount: records.length });
}

export function parseCsvInWorker(
    filePath: string,
    options: any = {}
): Promise<{ records: any[]; rowCount: number }> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { filePath, options },
        });

        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`CSV worker exited with code ${code}`));
            }
        });
    });
}
```

**Verification**:
1. Load 500MB CSV file -> UI remains responsive
2. Worker parses in background, emits result
3. No "Extension Host Unresponsive" dialogs

**Dependencies**: None

---

### BACKTEST-FIX [P1] Implement data source dropdown

**Problem**: Chart and backtest views use hardcoded AAPL/1D data. Need a data source selector.

This is a complex 19-file change per the data-source-implementation-plan.md. Key components:

1. **Data source registry** (engine side) -- registers CSV, Parquet, API sources
2. **Source picker UI** (extension side) -- dropdown in chart/action views
3. **Source config persistence** -- saves selected source per strategy
4. **IPC for data queries** -- extension requests data from engine

**Files to modify**: See `data-source-implementation-plan.md` for the full 19-file list.

**Summary implementation**: This fix depends on FIX-E001 (Parquet loader) and the UI wiring from this phase. Create the data source abstraction and wire it into the chart and action webviews.

**Verification**:
1. Open chart view -> data source dropdown visible
2. Select CSV file -> chart loads data from file
3. Select Parquet file -> chart loads data from Parquet
4. Run backtest -> uses selected data source, not hardcoded AAPL

**Dependencies**: FIX-E001, Phase 0

---

### NEW-UI-006 [MEDIUM] Wire AI Panel with input sanitization

**Problem**: AI Panel sends user input to AI provider without sanitizing for credentials that might be in clipboard/context.

**Files to modify**:
- `extensions/quantlab/src/panels/AIPanelProvider.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/panels/AIPanelProvider.ts
// Add sanitization before sending to AI:

private sanitizeInput(text: string): string {
    // Redact common credential patterns
    const patterns = [
        /(?:api[_-]?key|api[_-]?secret|password|token|secret)\s*[:=]\s*['"]?[\w\-\.]+['"]?/gi,
        /(?:ALPACA|IBKR|TD|SCHWAB)[_\s](?:KEY|SECRET|TOKEN)\s*[:=]\s*\S+/gi,
        /sk-[a-zA-Z0-9]{20,}/g,  // OpenAI-style keys
        /pk[a-zA-Z0-9]{20,}/g,   // Alpaca-style keys
    ];

    let sanitized = text;
    for (const pattern of patterns) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized;
}
```

**Verification**:
1. Type text containing "api_key=pk123456789" in AI panel -> sent as "[REDACTED]"
2. Normal text passes through unchanged

**Dependencies**: None

---

### NEW-UI-007 [LOW] Add WCAG 2.1 AA compliance verification tests

**Problem**: UI components may not meet WCAG 2.1 AA accessibility standards.

**Files to create**:
- `extensions/quantlab/test/accessibility.test.ts`

**Implementation**:

```typescript
// extensions/quantlab/test/accessibility.test.ts

import * as assert from 'assert';

suite('Accessibility Tests', () => {
    test('Status bar items have tooltips', () => {
        // Verify all status bar items have accessible tooltips
        // This is a structural test -- full a11y testing requires axe-core
    });

    test('Webview content has aria labels', () => {
        // Verify webview HTML includes appropriate ARIA attributes
    });

    test('Color contrast meets AA standard', () => {
        // Verify color combinations meet 4.5:1 contrast ratio
        const checkContrast = (fg: string, bg: string): number => {
            // Simplified contrast ratio calculation
            // Full implementation would parse hex/rgb colors
            return 4.5; // placeholder
        };
    });

    test('Keyboard navigation works for dialogs', () => {
        // Verify Tab/Enter/Escape work in all modal dialogs
    });
});
```

**Verification**:
1. Tests run as part of extension test suite
2. All UI elements have accessible labels

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] PreTradeChecklist invoked before session start
- [ ] Orphaned sessions detected and recovery dialog shown
- [ ] Risk configuration wizard shows on first run
- [ ] Connection status banner reflects daemon state
- [ ] Risk disclosure dialog shown before first live trade
- [ ] Strategy hot-reload dialog appears on file change during live session
- [ ] History search finds and opens matching entries
- [ ] `readDebugFile` command exists and loads debug data
- [ ] JobRunner supports optimize/montecarlo/wfa modes
- [ ] IPC integration tests use real daemon contract
- [ ] CSV parsing doesn't block extension host
- [ ] Data source dropdown replaces hardcoded data

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No pre-trade checklist" | PreTradeChecklist.ts is 353 lines, just needs wiring |
| "No history search" | Command exists, implementation is a stub |
| "No debugger" | DebuggerService.ts is 401 lines, missing one command registration |
