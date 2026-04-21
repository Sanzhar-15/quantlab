/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerDataCommands } from './commands/dataCommands';
import { registerGlobalStateCommands } from './commands/globalStateCommands';
import { registerHistoryCommands } from './commands/historyCommands';
import { registerPanelCommands } from './commands/panelCommands';
import { registerTradeCommands } from './commands/tradeCommands';
import { registerViewCommands } from './commands/viewCommands';
import { registerDashboardCommands } from './commands/dashboardCommands';
import { GlobalState } from './core/state/GlobalState';
import { HistoryState } from './core/state/HistoryState';
import { TabViewStateManager } from './core/state/TabViewState';
import { SessionManager } from './core/trading/SessionManager';
import { StrategyValidator } from './core/strategy/StrategyValidator';
import { DataPanelProvider } from './panels/data/DataPanelProvider';
import { WatchlistManager } from './panels/data/WatchlistManager';
import { HistoryDropdown } from './panels/history/HistoryDropdown';
import { HistoryPanelProvider } from './panels/history/HistoryPanelProvider';
import { ResourcesWebviewProvider } from './panels/resources/ResourcesWebviewProvider';
import { ResourcesCatalogService } from './panels/resources/ResourcesCatalogService';
import { SettingsPanelProvider } from './panels/settings/SettingsPanelProvider';
import { TradePanelProvider } from './panels/trade/TradePanelProvider';
import { GlobalSelectors } from './ui/GlobalSelectors';
import { updateContextKeys } from './utils/contextKeys';
import { ChartViewProvider } from './views/chart/ChartViewProvider';
import { ActionViewProvider } from './views/action/ActionViewProvider';
import { TradeViewProvider } from './views/trade/TradeViewProvider';
import { StatsViewProvider } from './views/stats/StatsViewProvider';
import { VisualiseViewProvider } from './views/visualise/VisualiseViewProvider';
import { SecureStorage } from './utils/secureStorage';
import { ThemeProvider } from './ui/tokens/ThemeProvider';
import { ReducedMotion } from './ui/accessibility/ReducedMotion';
import { NotificationManager } from './ui/notifications/NotificationManager';
import { BadgeManager } from './ui/notifications/BadgeManager';
import { ErrorRecovery } from './ui/errors/ErrorRecovery';
import { OnboardingManager } from './ui/onboarding/OnboardingManager';
import { EditorDropProvider } from './ui/dragdrop/EditorDropProvider';
import { TooltipGuide } from './ui/onboarding/TooltipGuide';
import { FeatureDiscovery } from './ui/onboarding/FeatureDiscovery';
import { EngineHost } from './core/engine/EngineHost';
import { ParameterExtractor } from './core/strategy/ParameterExtractor';
import { LiveDaemonManager } from './core/trading/LiveDaemonManager';
import { TrustManager } from './core/trust/TrustManager';
import { StatsEngine } from './stats/StatsEngine';
import { PythonBootstrap } from './core/engine/PythonBootstrap';
import { ServerApiClient } from './core/server/ServerApiClient';
import { DeltaPlusAuthProvider, DELTAPLUS_PROVIDER_ID } from './auth/DeltaPlusAuthProvider';
import { QuantLabHome } from './auth/QuantLabHome';
import { DataService } from './core/engine/DataService';
import { ToolExecutionService } from './core/server/ToolExecutionService';
import { ServerSymbolFileSystemProvider } from './core/virtualfs/ServerSymbolFileSystemProvider';
import { ServerDataCache } from './core/engine/ServerDataCache';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	EngineHost.initialize(context.extensionUri);
	const engineRoot = path.resolve(context.extensionUri.fsPath, '..', '..', 'engine');
	void PythonBootstrap.ensureDependencies(engineRoot);
	const validator = StrategyValidator.getInstance();
	const stateManager = TabViewStateManager.initialize();
	const globalState = GlobalState.initialize(context);
	const historyState = HistoryState.initialize(context);
	SecureStorage.initialize(context);
	ServerDataCache.initialize(context);

	// Clear old server data cache on startup
	ServerDataCache.getInstance().clearOldCache();

	// Initialize Delta Plus Server connection (non-blocking)
	const serverClient = ServerApiClient.getInstance();
	serverClient.setSecretStorage(context.secrets);
	// Read server URL from settings (stays in sync with QIC's qic.server.baseUrl)
	const serverUrl = vscode.workspace.getConfiguration('qic').get<string>('server.baseUrl');
	if (serverUrl) {
		const wsUrl = serverUrl.replace(/^http/, 'ws') + '/v1/ws';
		serverClient.configure({ baseUrl: serverUrl, wsUrl });
	}
	// Register Delta Plus authentication provider with VS Code account switcher.
	const authProvider = new DeltaPlusAuthProvider(context, serverClient);
	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(
			DELTAPLUS_PROVIDER_ID,
			'Delta Plus',
			authProvider,
			{ supportsMultipleAccounts: false }
		),
		authProvider
	);

	// Sign-in / sign-out commands.
	// quantlab.signIn bypasses vscode.authentication.getSession() and opens the login
	// panel directly — no intermediate quick-pick step for the user.
	// If the welcome panel is already open it just reveals it rather than opening a second modal.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.signIn', async () => {
			try {
				await authProvider.createSession(['read']);
			} catch (err) {
				// ERR_CANCELLED = user closed the panel — no notification needed.
				if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ERR_CANCELLED') {
					void vscode.window.showErrorMessage(`Sign-in failed: ${err.message}`);
				}
			}
		}),
		vscode.commands.registerCommand('quantlab.signOut', async () => {
			const sessions = await authProvider.getSessions(['read']);
			if (sessions.length > 0) {
				await authProvider.removeSession(sessions[0].id);
			}
		})
	);

	// Reconnect WebSocket when a new session is created (e.g. after sign-in).
	context.subscriptions.push(
		authProvider.onDidChangeSessions(e => {
			if (e.added && e.added.length > 0) {
				void serverClient.connectWebSocket().catch(() => { /* non-critical */ });
			}
		})
	);

	// Status bar account item — one-click access to sign in / sign out.
	// Kept hidden until the startup auth check resolves to avoid a "Sign In" flash
	// on every launch for users who are already signed in.
	const accountStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
	context.subscriptions.push(accountStatusItem);
	let _authStateResolved = false;

	const updateAccountStatus = (): void => {
		const user = serverClient.getUser();
		void vscode.commands.executeCommand('setContext', 'deltaplus.authenticated', !!user);
		if (user) {
			accountStatusItem.text = `$(account) ${user.name || user.email}`;
			accountStatusItem.tooltip = new vscode.MarkdownString(
				`**Delta Plus** · ${user.tier} tier\n\n${user.email}\n\n[Sign Out](command:quantlab.signOut)`,
				true
			);
			accountStatusItem.command = 'quantlab.signOut';
		} else {
			accountStatusItem.text = `$(account) Sign In`;
			accountStatusItem.tooltip = 'Sign in to Delta Plus';
			accountStatusItem.command = 'quantlab.signIn';
		}
		// Only show the item once auth state is known (prevents "Sign In" flash on startup).
		if (_authStateResolved) {
			accountStatusItem.show();
		}
	};

	// Show QuantLab Home dashboard after each active sign-in.
	// Not shown during startup session restore — only when the user actively signs in.
	let _homeShownThisSession = false;
	let _isStartupRestore = true;
	context.subscriptions.push(
		serverClient.onAuthStateChange(() => {
			updateAccountStatus();
			if (_isStartupRestore) { return; } // skip while startup tokens are loading
			const user = serverClient.getUser();
			if (user && !_homeShownThisSession) {
				_homeShownThisSession = true;
				QuantLabHome.show(context, { name: user.name, email: user.email, tier: user.tier });
			}
		})
	);
	updateAccountStatus();

	// Register home command so it can always be re-opened from command palette.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openHome', () => {
			const user = serverClient.getUser();
			if (!user) {
				void vscode.window.showInformationMessage('Sign in to Delta Plus to view your dashboard.');
				return;
			}
			QuantLabHome.show(context, { name: user.name, email: user.email, tier: user.tier });
		})
	);

	void initializeServerConnection(serverClient, authProvider).finally(() => {
		_isStartupRestore = false;
		_authStateResolved = true;
		updateAccountStatus(); // Reveal the status bar with the correct state
	});

	const sessionManager = SessionManager.initialize(context, globalState, historyState);
	const badgeManager = new BadgeManager(sessionManager);
	moduleBadgeManager = badgeManager;
	const watchlistManager = new WatchlistManager(context);
	moduleWatchlistManager = watchlistManager;
	ThemeProvider.initialize(context);
	ReducedMotion.initialize(context);
	NotificationManager.initialize(context, historyState, sessionManager);
	ErrorRecovery.initialize(context);
	const onboardingManager = OnboardingManager.initialize(context);
	const tooltipGuide = new TooltipGuide(onboardingManager);
	const featureDiscovery = FeatureDiscovery.initialize(context, onboardingManager, historyState);
	EditorDropProvider.register(context);

	// Register virtual file system for server symbols
	const serverSymbolFS = new ServerSymbolFileSystemProvider();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('quantlab-server', serverSymbolFS, {
			isCaseSensitive: true,
			isReadonly: false
		})
	);

	GlobalSelectors.initialize(context, globalState, historyState);
	HistoryDropdown.initialize(context, historyState);
	new ChartViewProvider(context, globalState, historyState).register(context);
	new ActionViewProvider(context, globalState, historyState, stateManager).register(context);
	new TradeViewProvider(context).register(context);
	context.subscriptions.push(StatsViewProvider.register(context));
	context.subscriptions.push(VisualiseViewProvider.register(context));

	registerDataCommands(context);
	registerGlobalStateCommands(context);
	registerHistoryCommands(context);
	registerPanelCommands(context);
	registerTradeCommands(context);
	registerViewCommands(context);
	registerDashboardCommands(context);

	new DataPanelProvider(context, globalState, watchlistManager);
	const catalogService = ResourcesCatalogService.initialize(context);
	const resourcesProvider = ResourcesWebviewProvider.initialize(context.extensionUri, catalogService);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ResourcesWebviewProvider.viewType, resourcesProvider)
	);

	// Non-blocking catalog pre-fetch
	void catalogService.getCatalog().catch(() => {
		// Server unavailable — cached data or null will be used on first panel open
	});
	new HistoryPanelProvider(context, historyState);
	new TradePanelProvider(context, badgeManager);
	new SettingsPanelProvider(context);

	const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	moduleValidationTimers = validationTimers;

	const updateActiveContext = async (editor?: vscode.TextEditor): Promise<void> => {
		if (editor) {
			const view = stateManager.getCurrentViewForEditor(editor);
			const validation = validator.getValidationResult(editor.document) ?? validator.validateDocument(editor.document);
			updateContextKeys(view, validation);
			return;
		}

		const resource = getActiveResource();
		if (!resource) {
			updateContextKeys('editor', undefined);
			return;
		}

		const tabInstanceId = stateManager.getTabInstanceIdForResource(resource);
		const view = tabInstanceId ? stateManager.getCurrentView(tabInstanceId) : 'editor';
		const doc = await vscode.workspace.openTextDocument(resource);
		const validation = validator.getValidationResult(doc) ?? validator.validateDocument(doc);
		updateContextKeys(view, validation);
	};

	const validateDocument = (doc: vscode.TextDocument): void => {
		validator.validateDocument(doc);
	};

	const scheduleValidation = (doc: vscode.TextDocument): void => {
		const key = doc.uri.toString();
		const existing = validationTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}

		validationTimers.set(key, setTimeout(() => {
			validationTimers.delete(key);
			validator.validateDocument(doc);
		}, 300));
	};

	const clearValidationTimer = (doc: vscode.TextDocument): void => {
		const key = doc.uri.toString();
		const existing = validationTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			validationTimers.delete(key);
		}
	};

	const strategyWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
	const invalidateStrategy = (uri: vscode.Uri): void => {
		validator.invalidate(uri);
	};

	const syncTabsAndRefresh = async (): Promise<void> => {
		await stateManager.syncTabs();
		void updateActiveContext(vscode.window.activeTextEditor);
	};

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(validateDocument),
		vscode.workspace.onDidSaveTextDocument(validateDocument),
		vscode.workspace.onDidChangeTextDocument(event => {
			scheduleValidation(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument(clearValidationTimer),
		strategyWatcher,
		strategyWatcher.onDidChange(invalidateStrategy),
		strategyWatcher.onDidCreate(invalidateStrategy),
		strategyWatcher.onDidDelete(invalidateStrategy),
		vscode.window.onDidChangeActiveTextEditor(editor => {
			void updateActiveContext(editor);
		}),
		vscode.window.tabGroups.onDidChangeTabs(() => {
			void syncTabsAndRefresh();
		}),
		vscode.window.tabGroups.onDidChangeTabGroups(() => {
			void syncTabsAndRefresh();
		}),
		validator.onDidValidate(({ uri, result }) => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.uri.toString() !== uri.toString()) {
				return;
			}

			const view = stateManager.getCurrentViewForEditor(activeEditor);
			updateContextKeys(view, result);
		}),
		stateManager.onDidChangeView(change => {
			const activeEditor = vscode.window.activeTextEditor;
			if (!activeEditor || activeEditor.document.uri.toString() !== change.uri.toString()) {
				return;
			}

			tooltipGuide.showViewTip(change.view);
			if (change.view === 'trade') {
				featureDiscovery.notifyTradeView();
			}
			const validation = validator.getValidationResult(activeEditor.document) ?? validator.validateDocument(activeEditor.document);
			updateContextKeys(change.view, validation);
		})
	);

	// CODEX-010: Register readDebugFile command for time-travel debugger
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'quantlab.engine.readDebugFile',
			async (filePath: string) => {
				try {
					const content = await fs.promises.readFile(filePath, 'utf-8');
					return JSON.parse(content);
				} catch (error: unknown) {
					const msg = error instanceof Error ? error.message : String(error);
					void vscode.window.showErrorMessage(`Failed to read debug file: ${msg}`);
					return null;
				}
			}
		)
	);

	// NEW-UI-004: Gate VS Code updates during active sessions
	context.subscriptions.push(
		vscode.extensions.onDidChange(async () => {
			const activeSessions = sessionManager.getActiveSessions();
			if (activeSessions.length > 0) {
				const liveSessions = activeSessions.filter(
					(s: { type: string }) => s.type === 'live'
				);
				if (liveSessions.length > 0) {
					void vscode.window.showWarningMessage(
						`${liveSessions.length} live trading session(s) active. ` +
						'Extension update may interrupt trading. Stop sessions before updating.',
						'Stop All Sessions', 'Dismiss'
					).then(action => {
						if (action === 'Stop All Sessions') {
							for (const s of sessionManager.getActiveSessions()) {
								void sessionManager.stopSession(s.id);
							}
						}
					});
				}
			}
		})
	);

	// FIX-CGP-015: Check for orphaned daemon sessions on startup
	await checkOrphanedSessions(context, sessionManager);

	await stateManager.hydrateFromWorkbench();
	await syncTabsAndRefresh();
}

/**
 * Check for orphaned daemon sessions from a previous extension instance (FIX-CGP-015).
 */
async function checkOrphanedSessions(
	_context: vscode.ExtensionContext,
	_sessionManager: SessionManager
): Promise<void> {
	const sessionsDir = path.join(os.homedir(), '.quantlab', 'sessions');
	try {
		const files = await fs.promises.readdir(sessionsDir);
		const socketFiles = files.filter(f => f.endsWith('.sock'));

		if (socketFiles.length === 0) {
			return;
		}

		// Check which sockets are still alive by attempting a connection
		const aliveSessions: string[] = [];
		for (const socketFile of socketFiles) {
			const sessionId = socketFile.replace('.sock', '');
			const sockPath = path.join(sessionsDir, socketFile);

			try {
				// Quick liveness probe: check if socket file exists and is a socket
				const stat = await fs.promises.stat(sockPath);
				if (stat.isSocket?.() ?? false) {
					aliveSessions.push(sessionId);
				}
			} catch {
				// Socket file doesn't exist or inaccessible — stale, clean up
				try {
					await fs.promises.unlink(sockPath);
				} catch { /* ignore */ }
			}
		}

		if (aliveSessions.length === 0) {
			return;
		}

		const action = await vscode.window.showWarningMessage(
			`Found ${aliveSessions.length} running daemon session(s) from a previous instance: ${aliveSessions.join(', ')}`,
			'Reconnect', 'Stop All', 'Ignore'
		);

		if (action === 'Reconnect') {
			// Reconnection is not yet implemented — inform the user
			void vscode.window.showInformationMessage(
				`Reconnection to orphaned sessions is not yet supported. Found: ${aliveSessions.join(', ')}`
			);
		} else if (action === 'Stop All') {
			for (const sessionId of aliveSessions) {
				try {
					const sockPath = path.join(sessionsDir, `${sessionId}.sock`);
					await fs.promises.unlink(sockPath);
				} catch { /* best effort */ }
			}
		}
		// 'Ignore' — do nothing
	} catch {
		// Sessions directory doesn't exist — no orphans
	}
}

function getActiveResource(): vscode.Uri | undefined {
	const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
	if (!tab) {
		return undefined;
	}

	if (tab.input instanceof vscode.TabInputText) {
		return tab.input.uri;
	}

	if (tab.input instanceof vscode.TabInputCustom) {
		return tab.input.uri;
	}

	if (tab.input instanceof vscode.TabInputTextDiff) {
		return tab.input.modified;
	}

	return undefined;
}

// Module-level references for disposal in deactivate()
let moduleWatchlistManager: WatchlistManager | undefined;
let moduleBadgeManager: import('./ui/notifications/BadgeManager').BadgeManager | undefined;
let moduleValidationTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;

// Output channel for server logs
let serverOutputChannel: vscode.OutputChannel | undefined;

function getServerOutputChannel(): vscode.OutputChannel {
	if (!serverOutputChannel) {
		serverOutputChannel = vscode.window.createOutputChannel('QuantLab Server');
	}
	return serverOutputChannel;
}

/**
 * Initialize connection to Delta Plus Server using the persisted session.
 * This runs in the background and doesn't block extension activation.
 */
async function initializeServerConnection(
	client: ServerApiClient,
	authProvider: DeltaPlusAuthProvider
): Promise<void> {
	const output = getServerOutputChannel();
	try {
		// Migrate legacy qic.deltaplus* keys to the new format (no-op if already done).
		await authProvider.runMigration();

		// Load the existing session from SecretStorage and push tokens into the client.
		const loaded = await authProvider.initializeFromStorage();
		if (loaded) {
			// If the stored access token is already expired, try a proactive refresh
			// so the WebSocket connects immediately without waiting for the first API call.
			if (!client.isAuthenticated()) {
				try {
					await client.refreshAccessToken();
					output.appendLine(`[${new Date().toISOString()}] Delta Plus: Session refreshed on startup`);
				} catch {
					output.appendLine(`[${new Date().toISOString()}] Delta Plus: Session expired — sign in again via the account menu`);
				}
			} else {
				output.appendLine(`[${new Date().toISOString()}] Delta Plus: Session restored — user signed in`);
			}
		} else {
			output.appendLine(`[${new Date().toISOString()}] Delta Plus: No saved session — sign in via the account menu`);
		}
	} catch (err) {
		output.appendLine(
			`[${new Date().toISOString()}] Delta Plus: Auth init error — ${err instanceof Error ? err.message : String(err)}`
		);
	} finally {
		// Signal ensureAuthenticated() that startup is done so pending API calls
		// can resolve immediately (either with tokens or with "not signed in" error).
		client.markAuthFlowComplete();
	}

	// Connect WebSocket if we have a valid session.
	if (client.isAuthenticated()) {
		try {
			await client.connectWebSocket();
			output.appendLine(`[${new Date().toISOString()}] Delta Plus: WebSocket connected`);
		} catch {
			output.appendLine(`[${new Date().toISOString()}] Delta Plus: WebSocket unavailable (real-time features disabled)`);
		}
	}
}

/**
 * Deactivates the Quantlab extension.
 */
export async function deactivate(): Promise<void> {
	// Cleanup server connection with proper disposal
	try {
		const client = ServerApiClient.getInstance();
		client.dispose();
	} catch {
		// Ignore cleanup errors
	}

	// Cleanup catalog service
	try {
		ResourcesCatalogService.getInstance().dispose();
	} catch {
		// Ignore cleanup errors
	}

	// Cleanup tool execution service
	try {
		ToolExecutionService.resetInstance();
	} catch {
		// Ignore cleanup errors
	}

	// Cleanup data service caches
	try {
		DataService.resetInstance();
	} catch {
		// Ignore cleanup errors
	}

	// Cleanup BadgeManager
	if (moduleBadgeManager) {
		moduleBadgeManager.dispose();
		moduleBadgeManager = undefined;
	}

	// Cleanup WatchlistManager
	if (moduleWatchlistManager) {
		moduleWatchlistManager.dispose();
		moduleWatchlistManager = undefined;
	}

	// Cleanup singleton state managers and services
	try { SessionManager.resetInstance(); } catch { /* ignore */ }
	await LiveDaemonManager.resetInstance().catch(() => { /* ignore */ });
	try { TrustManager.resetInstance(); } catch { /* ignore */ }
	try { EngineHost.resetInstance(); } catch { /* ignore */ }
	try { ParameterExtractor.resetInstance(); } catch { /* ignore */ }
	try { StatsEngine.resetInstance(); } catch { /* ignore */ }
	try { ReducedMotion.resetInstance(); } catch { /* ignore */ }
	try { ServerDataCache.resetInstance(); } catch { /* ignore */ }
	try { await HistoryState.getInstance().persistNow(); } catch { /* ignore */ }
	try { HistoryState.resetInstance(); } catch { /* ignore */ }
	try { TabViewStateManager.resetInstance(); } catch { /* ignore */ }
	// Clear validation timers BEFORE resetting StrategyValidator to prevent
	// inflight debounce timers from firing _onValidate on a disposed emitter
	if (moduleValidationTimers) {
		for (const timer of moduleValidationTimers.values()) {
			clearTimeout(timer);
		}
		moduleValidationTimers.clear();
		moduleValidationTimers = undefined;
	}
	try { StrategyValidator.resetInstance(); } catch { /* ignore */ }
	try { GlobalState.resetInstance(); } catch { /* ignore */ }
	try { OnboardingManager.resetInstance(); } catch { /* ignore */ }
	try { FeatureDiscovery.resetInstance(); } catch { /* ignore */ }

	// Dispose output channel
	if (serverOutputChannel) {
		serverOutputChannel.dispose();
		serverOutputChannel = undefined;
	}
}
