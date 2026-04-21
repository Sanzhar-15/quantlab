# Prompt 18 — Activation Sequence & Full System Wiring

**Phase**: Cross-phase (Integration)
**Prerequisites**: ALL previous prompts (00–17) complete
**Estimated Scope**: ~5 files modified, ~400 lines

---

## Objective

Wire all components together into the QIC activation sequence. This is the "startup code" that initializes all services in the correct order, handles partial failures gracefully, and connects the orchestrator, gateway, context engine, mutation engine, and UI into a working system.

---

## Spec References

- Implementation Plan v3: Phase 0 activation sequence (lines 366–427)

## Audit Fixes Incorporated

- **I-4 (HIGH)**: Activation sequence must handle partial failures gracefully — transition to DEGRADED state instead of crashing. Show meaningful error. Allow retry.
- **IX-CC1 (CRITICAL)**: Changed `Ctrl+Shift+N` keybinding to `Ctrl+Alt+N` to avoid collision with existing `workbench.action.newWindow` and chat editing undo.
- **X-PS1 (CRITICAL)**: Added service identifier creation via `createDecorator` for all 5 QIC services.
- **X-PS4 (HIGH)**: Fixed UIService chicken-and-egg: Step 5 uses VS Code's native `IDialogService` and `INotificationService`, NOT QIC UIService.
- **VIII-PC4 (HIGH)**: Added deactivation handler with reverse-order cleanup.
- **VIII-PC5 (MEDIUM)**: Added directory creation as Step 0 before crash recovery.
- **VIII-PC6 (MEDIUM)**: Registered additional commands: `qic.createCheckpoint`, `qic.restoreCheckpoint`, `qic.showSettings`, `qic.toggleCompletion`, `qic.retryConnection`.
- **XII-AR1 (HIGH)**: Added database recovery to activation — integrity check, backup, fresh DB on corruption.
- **XII-AR4 (HIGH)**: Unified resource cleanup — every component implements `IDisposable`, registered with `DisposableStore`.
- **XII-AR8 (MEDIUM)**: Journal recovery result passed to state recovery step.
- **XI-SV7 (MEDIUM)**: API keys stored via `ISecretStorageService` instead of plain settings.
- **IV-AO3 (HIGH)**: Split activation into Phase A (sync, < 5s) and Phase B (async) with progressive status.

---

## Implementation Instructions

### 1. QIC Activation Sequence

Modify `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` to implement the full activation:

> **AUDIT FIX IV-AO3 (HIGH)**: Split activation into two phases to avoid VS Code's 60-second activation timeout.
> - **Phase A** (synchronous, < 5s): Register services (lazy), register commands, register UI components, set up context keys.
> - **Phase B** (async, no timeout): Crash recovery, database init, security init, gateway init, context engine, background indexing.
> Show progressive status in the status bar: "QIC: Starting..." -> "QIC: Recovering..." -> "QIC: Indexing..." -> "QIC: Ready"

> **AUDIT FIX XII-AR4 (HIGH)**: Every component implements `IDisposable`. Register all with `DisposableStore`.

```typescript
class QicActivation extends Disposable {
    private completedSteps: string[] = [];
    private degradedFeatures: string[] = [];
    private state: 'initializing' | 'ready' | 'degraded' | 'error' = 'initializing';
    private readonly _store = this._register(new DisposableStore());

    async activate(context: IWorkbenchContributionContext): Promise<void> {
        // ============================================================
        // PHASE A (synchronous, < 5s): Register services, commands, UI
        // AUDIT FIX IV-AO3: This phase must complete within 5 seconds.
        // ============================================================
        this.registerServices();
        this.registerCommands();
        this.registerUI();
        this.statusBar.update('QIC: Starting...');

        // ============================================================
        // PHASE B (async): Heavy initialization — no timeout constraint
        // ============================================================
        try {
            // Step 0: Create workspace storage directories
            // AUDIT FIX VIII-PC5: Directories must exist before components can write
            await this.step('directories', async () => {
                const dirs = ['checkpoints', 'checkpoints/quarantine', 'logs',
                              'recordings', 'security-audit'];
                for (const dir of dirs) {
                    await fileService.createFolder(URI.joinPath(workspaceStorage, dir));
                }
            });

            // Step 1: Crash recovery
            let journalRecoveryResult: RecoveryResult;
            await this.step('crash-recovery', async () => {
                this.statusBar.update('QIC: Recovering...');
                journalRecoveryResult = await JournaledAtomicWriter.recoverFromCrash(journalDir, fileService);
                if (journalRecoveryResult.recovered) {
                    this.logRecovery(journalRecoveryResult);
                }
            });

            // Step 2: Database initialization
            // AUDIT FIX XII-AR1: Database recovery on corruption
            await this.step('database', async () => {
                try {
                    this.db = new QicDatabase(dbPath);
                    await this.db.initialize();
                    this._store.add(this.db);
                } catch (error) {
                    // Try integrity check on failure
                    const check = await this.db?.pragma('integrity_check');
                    if (check !== 'ok') {
                        // Backup corrupted DB, create fresh
                        await fs.rename(dbPath, dbPath + '.corrupted.' + Date.now());
                        this.db = new QicDatabase(dbPath);
                        await this.db.initialize();
                        this._store.add(this.db);
                        notificationService.warn('QIC database was corrupted and has been reset.');
                    } else {
                        throw error;
                    }
                }
                // Create all tables: state persistence, BM25, conversation
            });

            // Step 3: State machine recovery
            // AUDIT FIX XII-AR8: Pass journal recovery result to state recovery
            await this.step('state-recovery', async () => {
                const sessions = await statePersistence.getRecoverableSessions();
                for (const session of sessions) {
                    // If journal rolled back files that this session was editing,
                    // reset the session to 'idle' instead of 'waiting_approval'
                    if (journalRecoveryResult?.rolledBackFiles?.some(f =>
                        session.pendingEdits?.includes(f))) {
                        session.state = 'idle';
                    }
                }
            });

            // Step 4: Security initialization
            await this.step('security', async () => {
                this.consentStore = new ConsentStore(storageService);
                this.secretScanner = new OptimizedSecretScanner();
                this.egressEnforcer = new EgressBoundaryEnforcer(this.consentStore, this.secretScanner);
            });

            // Step 5: First-run consent check
            // AUDIT FIX X-PS4: Use VS Code's native IDialogService, NOT QIC UIService
            // (which requires the panel). The QIC webview UIService is for chat
            // interactions only.
            await this.step('first-run', async () => {
                const firstRunManager = new FirstRunManager(
                    this.consentStore,
                    this.dialogService,            // VS Code's native dialog
                    this.notificationService        // VS Code's native notifications
                );
                const result = await firstRunManager.checkAndPrompt();
                if (!result.canProceed) {
                    this.state = 'degraded';
                    return; // Continue in degraded mode
                }
            });

            // Step 6: Gateway initialization (may fail if no API key)
            await this.step('gateway', async () => {
                this.statusBar.update('QIC: Connecting...');
                this.gateway = new Gateway(providers, rateLimiter, circuitBreakers, this.egressEnforcer, this.secretScanner);
            });

            // Step 7: Context engine
            await this.step('context', async () => {
                this.embeddingService = new SecureEmbeddingService(/* ... */);
                this.indexer = new IncrementalIndexer(/* ... */);
                this._store.add(this.indexer);
                this.contextAssembler = new ContextAssembler(/* ... */);
            });

            // Step 8: Agent runtime
            await this.step('runtime', async () => {
                this.toolRouter = new ToolRouter(/* ... */);
                this.orchestrator = new AgentOrchestrator(/* ... */);
                registerAllTools(this.toolRouter, services);
            });

            // Step 9: Completion engine
            await this.step('completion', async () => {
                this.completionEngine = new CompletionEngine(/* ... */);
                this._store.add(this.completionEngine);
                // Register inline completion provider
            });

            // Step 10: Background indexing (non-blocking)
            this.statusBar.update('QIC: Indexing...');
            this.step('indexing', async () => {
                await this.indexer.indexWorkspace(workspacePath);
            }).catch(err => {
                // Indexing failure is non-fatal — log and continue
                this.degradedFeatures.push('code-search');
                notificationService.warn('QIC: Code search unavailable — indexing failed');
            });

            this.state = 'ready';
            this.statusBar.update('QIC: Ready');

        } catch (error) {
            // AUDIT FIX I-4: Graceful degraded start
            this.handleActivationFailure(error);
        }
    }

    /**
     * AUDIT FIX VIII-PC4: Deactivation handler — reverse order of activation.
     * Register with context.subscriptions.
     */
    async deactivate(): Promise<void> {
        // Reverse order of activation
        this.cancellationManager?.cancelAll();          // Cancel in-flight requests
        await this.reproducibilityLogger?.flush();      // Flush buffered logs
        await this.securityAuditLogger?.flush();        // Flush audit entries
        this.pythonBridge?.stop();                      // Stop Python process (if started on demand)
        await this.indexer?.dispose();                  // Stop file watchers
        await this.completionEngine?.dispose();         // Deregister completion provider
        await this.statePersistence?.persistAll();      // Save all state
        await this.database?.close();                   // Close SQLite
        this._store.dispose();                          // Dispose all registered resources
        this.disposed = true;
    }

    /**
     * AUDIT FIX I-4: Handle partial activation failure.
     * Don't crash — transition to degraded mode.
     */
    private handleActivationFailure(error: Error): void {
        console.error('QIC activation failed at step:', this.completedSteps[this.completedSteps.length - 1], error);
        this.state = 'degraded';

        // Determine what features are available based on completed steps
        const availableFeatures = this.determineAvailableFeatures();

        // Show meaningful error to user
        const message = this.buildDegradedMessage(error, availableFeatures);
        // Use VS Code notification since QIC panel might not be ready
        notificationService.warn(message);
        this.statusBar.update('QIC: Degraded');
    }

    private async step(name: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
            this.completedSteps.push(name);
        } catch (error) {
            console.error(`QIC activation step "${name}" failed:`, error);
            throw error;  // Let the outer try/catch handle degraded mode
        }
    }
}

// Register deactivation with VS Code:
// context.subscriptions.push({ dispose: () => activation.deactivate() });
```

### 2. Service Identifier Creation & Registration Order

> **AUDIT FIX X-PS1 (CRITICAL)**: Each subsystem prompt should have created its service identifier via `createDecorator`. If they didn't, create them here. Without these identifiers, `registerSingleton()` calls will fail at compile time.

```typescript
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// Service identifiers — create if not already defined by subsystem prompts
export const IQicDatabaseService = createDecorator<IQicDatabaseService>('qicDatabaseService');
export const IQicSecurityService = createDecorator<IQicSecurityService>('qicSecurityService');
export const IQicGatewayService = createDecorator<IQicGatewayService>('qicGatewayService');
export const IQicContextService = createDecorator<IQicContextService>('qicContextService');
export const IQicRuntimeService = createDecorator<IQicRuntimeService>('qicRuntimeService');
```

Ensure all services are registered in the correct dependency order in `qic.contribution.ts`:

```typescript
// Register services (order matters — dependencies first)
registerSingleton(IQicDatabaseService, QicDatabaseService, InstantiationType.Delayed);
registerSingleton(IQicSecurityService, QicSecurityService, InstantiationType.Delayed);
registerSingleton(IQicGatewayService, QicGatewayService, InstantiationType.Delayed);
registerSingleton(IQicContextService, QicContextService, InstantiationType.Delayed);
registerSingleton(IQicRuntimeService, QicRuntimeService, InstantiationType.Delayed);
registerSingleton(IQicService, QicService, InstantiationType.Delayed);
```

### 3. Settings Registration

Register QIC-specific VS Code settings:

> **AUDIT FIX XI-SV7 (MEDIUM)**: Use `ISecretStorageService.get/store` for API keys (`anthropicApiKey` and `openaiApiKey`). Remove them from configuration registration. Settings are stored in plaintext JSON, potentially synced via Settings Sync, and readable by the `read_file` tool.

```typescript
// QIC settings — NOTE: API keys use SecretStorage, NOT settings (audit fix XI-SV7)
configurationRegistry.registerConfiguration({
    id: 'qic',
    title: 'QIC',
    properties: {
        'qic.provider.default': { type: 'string', default: 'anthropic', enum: ['anthropic', 'openai', 'ollama'] },
        // REMOVED: 'qic.provider.anthropicApiKey' — use ISecretStorageService instead
        // REMOVED: 'qic.provider.openaiApiKey' — use ISecretStorageService instead
        'qic.provider.ollamaUrl': { type: 'string', default: 'http://localhost:11434' },
        'qic.completion.enabled': { type: 'boolean', default: true },
        'qic.completion.debounceMs': { type: 'number', default: 300 },
        'qic.pythonPath': { type: 'string', default: 'python3' },
        'qic.telemetry.enabled': { type: 'boolean', default: false },
    }
});

// API keys via SecretStorage (audit fix XI-SV7)
// Read: const apiKey = await secretStorageService.get('qic.anthropicApiKey');
// Store via command (see QICSetApiKeyAction below)
```

### 4. Command Registration

Register all QIC commands:

> **AUDIT FIX IX-CC1 (CRITICAL)**: Changed `Ctrl+Shift+N` to `Ctrl+Alt+N` for QICNewChatAction. `Ctrl+Shift+N` is already bound to `workbench.action.newWindow` and chat editing undo in `chatEditingEditorActions.ts`.

> **AUDIT FIX VIII-PC6 (MEDIUM)**: Register 5 additional commands beyond the core 4.

```typescript
// Core commands
registerAction2(ToggleQICAction);              // Ctrl+Shift+I
registerAction2(QICNewChatAction);              // Ctrl+Alt+N in QIC context (AUDIT FIX IX-CC1)
registerAction2(QICCancelAction);               // Escape in QIC context
registerAction2(QICFocusInputAction);           // Ctrl+L when QIC visible

// Additional commands (AUDIT FIX VIII-PC6)
registerAction2(QICCreateCheckpointAction);     // qic.createCheckpoint
registerAction2(QICRestoreCheckpointAction);    // qic.restoreCheckpoint
registerAction2(QICShowSettingsAction);         // qic.showSettings
registerAction2(QICToggleCompletionAction);     // qic.toggleCompletion
registerAction2(QICRetryConnectionAction);      // qic.retryConnection — for degradation recovery

// API key management via SecretStorage (AUDIT FIX XI-SV7)
registerAction2(class QICSetApiKeyAction extends Action2 {
    constructor() {
        super({ id: 'qic.setApiKey', title: 'QIC: Set API Key' });
    }
    async run(accessor: ServicesAccessor) {
        const provider = await accessor.get(IQuickInputService).pick(
            [{ label: 'Anthropic' }, { label: 'OpenAI' }],
            { placeHolder: 'Select provider' }
        );
        if (!provider) return;
        const key = await accessor.get(IQuickInputService).input(
            { prompt: `Enter ${provider.label} API Key`, password: true }
        );
        if (key) {
            const storageKey = provider.label === 'Anthropic' ? 'qic.anthropicApiKey' : 'qic.openaiApiKey';
            await accessor.get(ISecretStorageService).store(storageKey, key);
        }
    }
});

// Keybindings
KeybindingsRegistry.registerKeybindingRule({
    id: TOGGLE_QIC_COMMAND_ID,
    weight: KeybindingWeight.WorkbenchContrib,
    primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
});

// AUDIT FIX IX-CC1: Use Ctrl+Alt+N instead of Ctrl+Shift+N
KeybindingsRegistry.registerKeybindingRule({
    id: NEW_QIC_CHAT_COMMAND_ID,
    weight: KeybindingWeight.WorkbenchContrib,
    primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyN,
    when: QIC_PANEL_VISIBLE_CONTEXT,
});
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` | Full activation sequence |
| `src/vs/workbench/contrib/qic/common/qicService.ts` | Complete service implementation |
| `src/vs/workbench/contrib/qic/browser/qicPanel.ts` | Wire orchestrator to panel |
| `src/vs/workbench/contrib/qic/common/constants.ts` | Add settings keys |

---

## Acceptance Criteria

```
□ QIC activates on Quantlab startup without errors
□ Phase A (sync) completes in < 5s — audit fix IV-AO3
□ All services initialize in correct dependency order
□ All 5 service identifiers created via createDecorator — audit fix X-PS1
□ Workspace storage directories created before any writes — audit fix VIII-PC5
□ JournaledAtomicWriter.recoverFromCrash() runs on activation
□ Journal recovery result passed to state recovery step — audit fix XII-AR8
□ Corrupted database detected, backed up, and recreated — audit fix XII-AR1
□ First-run consent uses IDialogService (not QIC UIService) — audit fix X-PS4
□ If API key missing, QIC enters degraded mode (not crash) — audit fix I-4
□ If provider unreachable, QIC shows meaningful error and continues
□ Background indexing starts without blocking activation
□ Ctrl+Shift+I toggles the QIC panel
□ Ctrl+Alt+N creates new chat (NOT Ctrl+Shift+N) — audit fix IX-CC1
□ All 9 commands registered — audit fix VIII-PC6
□ API keys stored via SecretStorage, not in settings.json — audit fix XI-SV7
□ Settings are available in VS Code settings UI
□ Deactivation cleans up in reverse order — audit fix VIII-PC4
□ All components implement IDisposable, registered with DisposableStore — audit fix XII-AR4
□ Status bar shows progressive status during activation — audit fix IV-AO3
□ Full chat flow works: type message → see streaming response → tool calls execute
□ Inline completions appear in the editor
□ TypeScript compiles with no errors
```

---

## Audit Fixes Applied

The following fixes from the deep audit (QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md) have been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **IX-CC1** | CRITICAL | Changed `Ctrl+Shift+N` keybinding to `KeyMod.CtrlCmd \| KeyMod.Alt \| KeyCode.KeyN` (`Ctrl+Alt+N`). `Ctrl+Shift+N` is already bound to `workbench.action.newWindow` and chat editing undo. |
| **X-PS1** | CRITICAL | Added service identifier creation via `createDecorator` for all 5 QIC services (`IQicDatabaseService`, `IQicSecurityService`, `IQicGatewayService`, `IQicContextService`, `IQicRuntimeService`). |
| **X-PS4** | HIGH | Fixed UIService chicken-and-egg: Step 5 (first-run consent) uses VS Code's native `IDialogService` and `INotificationService`, NOT the QIC UIService (which requires the panel). |
| **VIII-PC4** | HIGH | Added deactivation handler: reverse order of activation — cancel in-flight requests, flush loggers, stop Python bridge, stop indexer, deregister completion provider, persist state, close database. Registered with `context.subscriptions`. |
| **VIII-PC5** | MEDIUM | Added directory creation as Step 0: create `checkpoints/`, `checkpoints/quarantine/`, `logs/`, `recordings/`, `security-audit/`. |
| **VIII-PC6** | MEDIUM | Registered additional commands: `qic.createCheckpoint`, `qic.restoreCheckpoint`, `qic.showSettings`, `qic.toggleCompletion`, `qic.retryConnection`. |
| **XII-AR1** | HIGH | Added database recovery to activation: try `integrity_check` on failure, backup corrupted DB, create fresh, notify user. |
| **XII-AR4** | HIGH | Unified resource cleanup — every component implements `IDisposable`. Register all with `DisposableStore`. Added to activation code. |
| **XII-AR8** | MEDIUM | Pass journal recovery result to state recovery step: if journal rolled back files that a session was editing, reset session to 'idle'. |
| **XI-SV7** | MEDIUM | Use `ISecretStorageService.get/store` for `anthropicApiKey` and `openaiApiKey`. Removed from configuration registration. |
| **IV-AO3** | HIGH | Split activation into two phases: Phase A (sync, < 5s) registers services, commands, UI. Phase B (async) handles crash recovery, DB init, security, gateway, context engine, indexing. Progressive status in status bar. |
